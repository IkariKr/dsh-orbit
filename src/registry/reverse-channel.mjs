// v0.5 reverse data-channel pool and per-flow HTTP execution (Hub side;
// RFC-0012 D5/D6/D7). Bounded by design:
//   - idle target 8 (configurable 1-16), max 32 (configurable 4-64),
//     idle target <= max — the pool never grows past max;
//   - one browser flow per channel at a time (no multiplexing);
//   - when no idle channel exists the assignment waits up to 2 seconds
//     for the same node to replenish its pool, then fails 503
//     reverse-capacity — never another node, never a direct target;
//   - binary frames carry at most 64 KiB; larger source chunks are split;
//   - per direction/channel: 512 KiB soft queued-byte mark pauses the
//     source, it resumes below 256 KiB, and a 2 MiB hard cap or a 30s
//     no-progress stall aborts exactly that flow and closes the channel;
//   - an aborted flow is never transparently retried.
// Channels are bound to the current ready reverse session; a takeover or
// session close closes every channel of the old generation. Backpressure
// rides the TCP socket itself (writableLength / drain) — no extra wire
// vocabulary beyond RFC-0012 D6.

import { STATUS_CODES } from "node:http";
import { randomBytes } from "node:crypto";
import { createFrameParser, encodeFrame, computeSecWebSocketAccept } from "./reverse-ws.mjs";
import { sanitizeSetCookieHeader } from "./route-proxy.mjs";

export const CHANNEL_FRAME_MAX_BYTES = 64 * 1024;
export const CHANNEL_SOFT_MARK_BYTES = 512 * 1024;
export const CHANNEL_RESUME_BELOW_BYTES = 256 * 1024;
export const CHANNEL_HARD_CAP_BYTES = 2 * 1024 * 1024;
export const CHANNEL_STALL_TIMEOUT_MS = 30_000;
export const CHANNEL_CAPACITY_WAIT_MS = 2_000;

export function validateReversePoolBounds({ idleTarget, maxChannels }) {
  if (!Number.isInteger(idleTarget) || idleTarget < 1 || idleTarget > 16) {
    return `reverse idle target must be an integer 1-16 (got ${JSON.stringify(idleTarget)})`;
  }
  if (!Number.isInteger(maxChannels) || maxChannels < 4 || maxChannels > 64) {
    return `reverse max channels must be an integer 4-64 (got ${JSON.stringify(maxChannels)})`;
  }
  if (idleTarget > maxChannels) {
    return "reverse idle target must be <= max channels";
  }
  return null;
}

export class ReverseCapacityError extends Error {
  constructor(message = "no reverse data channel available for this node") {
    super(message);
    this.name = "ReverseCapacityError";
    this.code = "reverse-capacity";
  }
}

export class ReverseFlowAbortedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReverseFlowAbortedError";
    this.code = code;
  }
}

export class ReverseSessionStaleError extends Error {
  constructor(message = "reverse session generation is no longer current") {
    super(message);
    this.name = "ReverseSessionStaleError";
    this.code = "reverse-session-stale";
  }
}

let channelSequence = 0;

function sanitizeWebSocketOpenHeaders(headers) {
  return (headers ?? []).flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) return [];
    const lower = String(entry[0]).toLowerCase();
    if (lower.startsWith("x-orbit-")) return [];
    if (
      lower === "x-dsh-authenticated-proxy" ||
      lower === "x-dsh-operator-id" ||
      lower === "x-csrf-token" ||
      lower === "x-gateway-auth" ||
      lower === "x-gateway-secret"
    ) return [];
    if (lower === "proxy-authorization" || lower === "proxy-connection") return [];
    if (lower === "cookie" && typeof entry[1] === "string") {
      const value = entry[1]
        .split(";")
        .map((part) => part.trim())
        .filter((part) => !part.toLowerCase().startsWith("dsh-orbit-hub-session="))
        .join("; ");
      return value.length > 0 ? [[entry[0], value]] : [];
    }
    return [[entry[0], entry[1]]];
  });
}

function sanitizeFlowHeaders(headers) {
  return sanitizeWebSocketOpenHeaders(headers).filter(([name]) => {
    const lower = String(name).toLowerCase();
    return lower !== "connection" && lower !== "proxy-connection";
  });
}

function responsePairs(headers) {
  return (headers ?? []).filter((entry) => Array.isArray(entry) && entry.length === 2)
    .flatMap(([name, value]) => {
      if (String(name).toLowerCase() !== "set-cookie") return [[String(name), String(value)]];
      const sanitized = sanitizeSetCookieHeader(String(value));
      return [[String(name), String(sanitized)]];
    });
}

function rawHttpResponse(status, headers) {
  const statusCode = Number(status) || 502;
  const statusText = STATUS_CODES[statusCode] ?? "Error";
  const lines = [`HTTP/1.1 ${statusCode} ${statusText}`];
  for (const [name, value] of responsePairs(headers)) {
    if (String(name).toLowerCase() === "transfer-encoding") continue;
    lines.push(`${name}: ${value}`);
  }
  lines.push("", "");
  return lines.join("\r\n");
}

function sendBinaryFrames(channel, bytes, maxBytes = CHANNEL_FRAME_MAX_BYTES, onWrite = null) {
  for (let offset = 0; offset < bytes.length; offset += maxBytes) {
    const accepted = channel.sendFrame(encodeFrame({ opcode: 0x2, payload: bytes.subarray(offset, offset + maxBytes) }));
    // Writable backpressure is not a failed write. The channel is failed only
    // when the socket is no longer usable after the write attempt.
    if (!accepted && (channel.closed || channel.socket.destroyed || !channel.socket.writable)) return false;
    const decision = onWrite?.();
    if (decision === false) return false;
    if (decision === "pause") return true;
  }
  return !channel.closed && !channel.socket.destroyed;
}

class Flow {
  constructor({ channel, requestId, limits }) {
    this.channel = channel;
    this.requestId = requestId;
    this.limits = limits;
    this.aborted = false;
    this.abortCode = null;
    this.responseResolve = null;
    this.responseReject = null;
    this.bodyQueue = [];
    this.bodyWaiters = [];
    this.bodyEnded = false;
    this.idleResolve = null;
    // WebSocket flows use the same one-flow channel but switch their binary
    // consumer from the HTTP response queue to the browser socket after 101.
    this.websocket = false;
    this.upgraded = false;
    this.idleReceived = false;
    this.teardownComplete = false;
    this.responseEnded = false;
    this.onOpaqueBytes = null;
    this.onResponseEnd = null;
    this.onChannelClosed = null;
    this.browserClosed = false;
    this.idleReceived = false;
    this.maybeIdle = null;
    this.tearingDown = false;
    this.finished = false;
    this.browserReady = false;
    this.pendingOpaque = [];
    this.pendingOpaqueBytes = 0;
    this.pendingBrowserToNode = [];
    this.pendingBrowserToNodeBytes = 0;
    this.browserPumpWaiting = false;
    // D7 receive-side accounting (node -> hub response direction): the hub
    // consumes eagerly, so TCP backpressure alone cannot bound the queue —
    // enforce soft/hard/stall on the queued bytes and pause the socket.
    this.queuedBytes = 0;
    this.lastConsumedAt = Date.now();
    this.stallTimer = setInterval(() => {
      if (this.aborted || this.bodyEnded || this.websocket) return;
      if (this.queuedBytes >= this.limits.softMarkBytes && Date.now() - this.lastConsumedAt >= this.limits.stallTimeoutMs) {
        this.fail("flow-stall", "no response consumption progress while at or above the soft mark");
        this.channel.close("flow-stall");
      }
    }, Math.min(1000, this.limits.stallTimeoutMs));
    this.stallTimer.unref?.();
    this.d7States = new Map();
    this.d7Abort = null;
    this.d7Timer = null;
  }

  startD7(abort) {
    this.d7Abort = abort;
    if (this.d7Timer) return;
    this.d7Timer = setInterval(() => this.checkD7(), Math.min(250, this.limits.stallTimeoutMs));
    this.d7Timer.unref?.();
  }

  trackD7(name, { queueSocket, sourceSocket, getQueuedBytes }) {
    const existing = this.d7States.get(name);
    if (existing) {
      existing.queueSocket = queueSocket;
      existing.sourceSocket = sourceSocket;
      existing.getQueuedBytes = getQueuedBytes;
      return existing;
    }
    const state = {
      queueSocket,
      sourceSocket,
      getQueuedBytes,
      paused: false,
      lastQueuedBytes: Math.max(0, Number(getQueuedBytes()) || 0),
      lastProgressAt: Date.now(),
    };
    this.d7States.set(name, state);
    return state;
  }

  updateD7(name) {
    const state = this.d7States.get(name);
    if (!state) return;
    const queued = Math.max(0, Number(state.getQueuedBytes()) || 0);
    if (queued < state.lastQueuedBytes) state.lastProgressAt = Date.now();
    state.lastQueuedBytes = queued;
  }

  checkD7() {
    if (this.aborted) return;
    for (const state of this.d7States.values()) {
      const queued = Math.max(0, Number(state.getQueuedBytes()) || 0);
      if (queued > this.limits.hardCapBytes) {
        this.d7Abort?.("flow-overrun", "D7 queue exceeded the hard cap");
        return;
      }
      if (queued < state.lastQueuedBytes) state.lastProgressAt = Date.now();
      if (queued >= this.limits.softMarkBytes) {
        if (!state.paused) {
          state.sourceSocket?.pause?.();
          state.paused = true;
          state.lastProgressAt = Date.now();
        } else if (Date.now() - state.lastProgressAt >= this.limits.stallTimeoutMs) {
          this.d7Abort?.("flow-stall", "no D7 queue progress above the soft mark");
          return;
        }
      } else if (state.paused && queued < this.limits.resumeBelowBytes) {
        state.sourceSocket?.resume?.();
        state.paused = false;
        state.lastProgressAt = Date.now();
      }
      state.lastQueuedBytes = queued;
    }
  }

  stopD7() {
    if (this.d7Timer) clearInterval(this.d7Timer);
    this.d7Timer = null;
    for (const state of this.d7States.values()) {
      if (state.paused) state.sourceSocket?.resume?.();
    }
    this.d7States.clear();
    this.d7Abort = null;
  }

  fail(code, message) {
      if (this.aborted) return;
      this.aborted = true;
      this.finished = true;

    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stopD7();
    if (this.channel.socket.isPaused?.()) this.channel.socket.resume?.();
    this.abortCode = code;
    this.responseReject?.(new ReverseFlowAbortedError(code, message));
    for (const waiter of this.bodyWaiters) waiter.reject(new ReverseFlowAbortedError(code, message));
    this.bodyWaiters = [];
    this.bodyEnded = true;
    this.idleResolve?.();
  }

  onResponse(message) {
    if (this.aborted) return;
    const resolve = this.responseResolve;
    this.responseResolve = null;
    this.responseReject = null;
    resolve?.(message);
  }

  pushBody(bytes) {
    if (this.aborted || this.bodyEnded) return;
    if (this.websocket && this.onOpaqueBytes) {
      this.onOpaqueBytes(bytes);
      return;
    }
    this.queuedBytes += bytes.length;
    this.lastConsumedAt = Date.now();
    if (this.queuedBytes > this.limits.hardCapBytes) {
      this.fail("flow-overrun", "response queue exceeded the hard cap");
      this.channel.close("flow-overrun");
      return;
    }
    if (this.bodyWaiters.length > 0) {
      const waiter = this.bodyWaiters.shift();
      waiter.resolve(bytes);
      return;
    }
    this.bodyQueue.push(bytes);
    // D7 soft mark: pause the channel socket; resume below the resume mark.
    if (this.queuedBytes >= this.limits.softMarkBytes && !this.channel.socket.isPaused?.()) {
      this.channel.socket.pause?.();
    }
  }

  consume(count) {
    this.lastConsumedAt = Date.now();
    this.queuedBytes = Math.max(0, this.queuedBytes - count);
    if (this.queuedBytes < this.limits.resumeBelowBytes && this.channel.socket.isPaused?.()) {
      this.channel.socket.resume?.();
    }
  }

  endBody() {
    if (this.bodyEnded) return;
    this.bodyEnded = true;
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stopD7();
    if (this.channel.socket.isPaused?.()) this.channel.socket.resume?.();
    for (const waiter of this.bodyWaiters) waiter.resolve(null);
    this.bodyWaiters = [];
    // Channel reuse is released only by the peer's explicit idle message;
    // response EOF alone is not complete transport teardown.
  }

  async nextBodyChunk() {
    if (this.aborted) throw new ReverseFlowAbortedError(this.abortCode ?? "flow-aborted", "flow aborted");
    if (this.bodyQueue.length > 0) return this.bodyQueue.shift();
    if (this.bodyEnded) return null;
    return new Promise((resolve, reject) => {
      this.bodyWaiters.push({ resolve, reject });
    });
  }

  waitForIdle(timeoutMs) {
    if (this.idleReceived || this.aborted || this.channel.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.idleResolve = () => resolve(true);
      const timer = setTimeout(() => {
        this.idleResolve = null;
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
    });
  }
}

export class ReverseChannel {
  constructor({ manager, nodeId, keyId, sessionId, socket, secWebSocketKey }) {
    this.manager = manager;
    this.nodeId = nodeId;
    this.keyId = keyId;
    this.sessionId = sessionId;
    this.id = `chan_${(++channelSequence).toString(16)}_${Math.random().toString(16).slice(2, 10)}`;
    this.socket = socket;
    this.state = "idle"; // idle -> busy -> idle | closed
    this.flow = null;
    this.closed = false;

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "upgrade: websocket\r\n" +
        "connection: upgrade\r\n" +
        `sec-websocket-accept: ${computeSecWebSocketAccept(secWebSocketKey ?? "")}\r\n\r\n`,
    );

    this.parse = createFrameParser({
      isClient: false, // the Hub is the server; node frames arrive masked
      maxMessageBytes: CHANNEL_FRAME_MAX_BYTES,
      onMessage: (message) => this.onNodeMessage(message),
      onPing: (payload) => this.sendFrame(encodeFrame({ opcode: 0xa, payload })),
      onClose: () => this.close("node-close"),
      onError: () => this.close("protocol-error"),
    });
    socket.on("data", (chunk) => this.parse(chunk));
    // HTTP server sockets are half-open: 'end' must terminate the channel.
    socket.on("end", () => this.close("socket-end"));
    socket.on("close", () => this.close("socket-close"));
    socket.on("error", () => this.close("socket-error"));
  }

  sendFrame(buffer) {
    if (this.closed || this.socket.destroyed || !this.socket.writable) return false;
    try {
      return this.socket.write(buffer);
    } catch {
      this.close("socket-write-error");
      return false;
    }
  }

  sendJson(message) {
    return this.sendFrame(encodeFrame({ opcode: 0x1, payload: Buffer.from(JSON.stringify(message), "utf8") }));
  }

  onNodeMessage(message) {
    if (this.closed) return;
    if (typeof message === "string") {
      let parsed;
      try {
        parsed = JSON.parse(message);
      } catch {
        this.close("bad-json");
        return;
      }
      if (parsed === null || typeof parsed !== "object" || typeof parsed.type !== "string") {
        this.close("bad-node-message");
        return;
      }
      const flow = this.flow;
      if (parsed.type === "idle") {
        if (!flow) {
          this.close("idle-without-flow");
          return;
        }
        flow.idleReceived = true;
        if (flow.websocket) {
          flow.idleReceived = true;
          flow.stopD7();
          flow.maybeIdle?.();
          return;
        }

        if (!flow.bodyEnded) {
          flow.fail("channel-desync", "idle reported mid-flow");
          this.close("channel-desync");
          return;
        }
        this.flow = null;
        this.state = "idle";
        flow.idleResolve?.();
        this.manager.onChannelIdle(this);
        return;
      }
      if (!flow) {
        this.close("message-without-flow");
        return;
      }
      if (parsed.type === "response") {
        if (typeof parsed.status !== "number" || !Array.isArray(parsed.headers)) {
          flow.fail("bad-response", "response message lacks status/headers");
          this.close("bad-node-message");
          return;
        }
        if (parsed.requestId !== flow.requestId) {
          flow.fail("request-mismatch", "response requestId does not match flow");
          this.close("bad-node-message");
          return;
        }
        flow.responseEnded = false;
        flow.onResponse(parsed);
        if (flow.websocket && parsed.status === 101) {
          flow.upgraded = true;
        }
        return;
      }
      if (parsed.type === "response-end") {
        if (parsed.requestId !== flow.requestId) {
          flow.fail("request-mismatch", "response-end requestId does not match flow");
          this.close("bad-node-message");
          return;
        }
        flow.responseEnded = true;
        flow.tearingDown = true;
        flow.onResponseEnd?.();
        flow.endBody();
        if (flow.websocket && !flow.upgraded) {
          flow.browserClosed = true;
          flow.teardownComplete = true;
          flow.maybeIdle?.();
        }
        return;
      }
      if (parsed.type === "abort") {
        if (parsed.requestId && parsed.requestId !== flow.requestId) {
          this.close("request-mismatch");
          return;
        }
        flow.fail(parsed.code ?? "node-abort", "node aborted the flow");
        flow.onChannelClosed?.(parsed.code ?? "node-abort");
        this.close("node-abort");
        return;
      }
      this.close("unexpected-node-message");
      return;
    }
    const flow = this.flow;
    if (flow && !flow.aborted && (!flow.bodyEnded || flow.websocket)) {
      flow.pushBody(message);
      return;
    }
    this.close("unexpected-binary");
  }

  markBusy(flow) {
    this.state = "busy";
    this.flow = flow;
  }

  markIdle() {
    this.flow = null;
    this.state = "idle";
    this.manager.onChannelIdle(this);
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    const flow = this.flow;
    if (flow) {
      flow.tearingDown = true;
      flow.onChannelClosed?.(reason);
      flow.fail("channel-closed", `channel closed: ${reason}`);
    }
    this.flow = null;
    this.state = "closed";
    this.manager.onChannelClosed(this, reason);
    try {
      this.socket.destroy();
    } catch {
      // Already gone.
    }
  }
}

export class ReverseChannelManager {
  constructor({
    limits = {},
    idleTarget = 8,
    maxChannels = 32,
    capacityWaitMs = CHANNEL_CAPACITY_WAIT_MS,
    now = () => Date.now(),
  } = {}) {
    const boundsError = validateReversePoolBounds({ idleTarget, maxChannels });
    if (boundsError) throw new Error(boundsError);
    this.idleTarget = idleTarget;
    this.maxChannels = maxChannels;
    this.capacityWaitMs = capacityWaitMs;
    this.now = now;
    this.limits = {
      frameMaxBytes: CHANNEL_FRAME_MAX_BYTES,
      softMarkBytes: CHANNEL_SOFT_MARK_BYTES,
      resumeBelowBytes: CHANNEL_RESUME_BELOW_BYTES,
      hardCapBytes: CHANNEL_HARD_CAP_BYTES,
      stallTimeoutMs: CHANNEL_STALL_TIMEOUT_MS,
      ...limits,
    };
    this.channels = new Map(); // nodeId -> Set(ReverseChannel)
    this.idleWaiters = new Map(); // nodeId -> Set({resolve})
  }

  idleChannels(nodeId, sessionId = null) {
    const set = this.channels.get(nodeId);
    if (!set) return [];
    return [...set].filter((channel) =>
      !channel.closed &&
      channel.state === "idle" &&
      (sessionId === null || channel.sessionId === sessionId),
    );
  }

  hasChannelForSession(nodeId, sessionId) {
    if (!sessionId) return false;
    const set = this.channels.get(nodeId);
    if (!set) return false;
    return [...set].some((channel) => !channel.closed && channel.sessionId === sessionId);
  }

  busyCount(nodeId) {
    const set = this.channels.get(nodeId);
    if (!set) return 0;
    return [...set].filter((channel) => !channel.closed && channel.state === "busy").length;
  }

  // Entry point after ORBIT-MACHINE-V1 auth and the session binding check.
  registerChannel({ nodeId, keyId, sessionId, socket, secWebSocketKey }) {
    const set = this.channels.get(nodeId) ?? new Set();
    this.channels.set(nodeId, set);
    if (set.size >= this.maxChannels) {
      // The pool is at its hard cap; fail the upgrade closed (the node
      // treats the refused upgrade as a signal to stop replenishing).
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-type: application/json\r\n\r\n" +
          JSON.stringify({ error: { code: "reverse-capacity", message: "channel pool at max" } }),
      );
      setTimeout(() => socket.destroy(), 50).unref?.();
      return null;
    }
    const channel = new ReverseChannel({ manager: this, nodeId, keyId, sessionId, socket, secWebSocketKey });
    set.add(channel);
    this.resolveIdleWaiters(nodeId, sessionId);
    return channel;
  }

  resolveIdleWaiters(nodeId, sessionId = null) {
    const waiters = this.idleWaiters.get(nodeId);
    if (!waiters || waiters.size === 0) return;
    const waiter = [...waiters].find((candidate) => candidate.sessionId === null || candidate.sessionId === sessionId);
    if (!waiter) return;
    waiter.resolve();
  }

  onChannelIdle(channel) {
    this.resolveIdleWaiters(channel.nodeId, channel.sessionId);
  }

  onChannelClosed(channel, reason) {
    void reason;
    const set = this.channels.get(channel.nodeId);
    if (set) {
      set.delete(channel);
      if (set.size === 0) this.channels.delete(channel.nodeId);
    }
  }

  // One flow = one idle channel, claimed atomically (state flips to busy
  // inside the synchronous claim path — concurrent callers can never be
  // handed the same channel). If none is idle, wait up to capacityWaitMs
  // for the node to replenish its pool; then 503 reverse-capacity.
  claimIdleChannel(nodeId, sessionId = null) {
    const idle = this.idleChannels(nodeId).filter((channel) => sessionId === null || channel.sessionId === sessionId);
    if (idle.length > 0) {
      idle[0].state = "busy";
      return idle[0];
    }
    return null;
  }

  async acquireChannel(nodeId, { abortPromise = null, sessionId = null } = {}) {
    const abortError = new ReverseFlowAbortedError("browser-abort", "browser abandoned the reverse flow");
    const claimed = this.claimIdleChannel(nodeId, sessionId);
    if (claimed) {
      // Return immediately after the synchronous claim. The caller creates its
      // Flow next, where the abort promise owns cleanup; awaiting here creates
      // a race that can strand this channel busy without a Flow.
      return claimed;
    }
    const startedAt = this.now();
    while (this.now() - startedAt < this.capacityWaitMs) {
      await new Promise((resolve, reject) => {
        let waiters = this.idleWaiters.get(nodeId);
        if (!waiters) {
          waiters = new Set();
          this.idleWaiters.set(nodeId, waiters);
        }
        const waiter = { resolve: null, settled: false, sessionId };
        const cleanup = () => {
          waiters.delete(waiter);
          if (waiters.size === 0 && this.idleWaiters.get(nodeId) === waiters) this.idleWaiters.delete(nodeId);
        };
        const settle = () => {
          if (waiter.settled) return;
          waiter.settled = true;
          cleanup();
          resolve();
        };
        const cancel = (error = abortError) => {
          if (waiter.settled) return;
          waiter.settled = true;
          cleanup();
          reject(error);
        };
        waiter.resolve = settle;
        waiter.cancel = cancel;
        waiters.add(waiter);
        const timer = setTimeout(settle, Math.max(10, this.capacityWaitMs - (this.now() - startedAt)));
        timer.unref?.();
        if (abortPromise) Promise.resolve(abortPromise).then(cancel, cancel);
      });
      const claimedNow = this.claimIdleChannel(nodeId, sessionId);
      if (claimedNow) return claimedNow;
    }
    throw new ReverseCapacityError();
  }

  closeChannelsForNode(nodeId, reason = "session-closed") {
    const set = this.channels.get(nodeId);
    if (set) {
      for (const channel of [...set]) {
        channel.close(reason);
      }
      this.channels.delete(nodeId);
    }
    const waiters = this.idleWaiters.get(nodeId);
    if (waiters) {
      for (const waiter of [...waiters]) waiter.resolve();
      this.idleWaiters.delete(nodeId);
    }
  }

  // A control-session takeover/close invalidates the old generation's
  // channels (RFC-0012 D4.2 step 3).
  closeChannelsForSession(sessionId, reason = "session-closed") {
    for (const set of this.channels.values()) {
      for (const channel of [...set]) {
        if (channel.sessionId === sessionId) {
          channel.close(reason);
        }
      }
    }
    for (const [nodeId, waiters] of this.idleWaiters) {
      for (const waiter of [...waiters]) {
        if (waiter.sessionId === sessionId) waiter.cancel?.(new ReverseSessionStaleError(reason));
      }
      if (waiters.size === 0) this.idleWaiters.delete(nodeId);
    }
  }

  // Credential revocation is connection-scoped, not generation-scoped:
  // D10 permits control and data upgrades to use independently accepted keys.
  // Close only channels authenticated with this exact node key, preserving
  // channels from the same node authenticated with another still-valid key.
  closeChannelsForCredential(nodeId, keyId, reason = "credential-revoked") {
    const set = this.channels.get(nodeId);
    if (!set) return [];
    const matching = [...set].filter((channel) => channel.keyId === keyId);
    for (const channel of matching) channel.close(reason);
    return matching.map((channel) => channel.id);
  }

  closeAll(reason = "hub-shutdown") {
    for (const nodeId of [...this.channels.keys()]) {
      this.closeChannelsForNode(nodeId, reason);
    }
  }

  // Execute one browser WebSocket flow over this node's channels. The outer
  // reverse WebSocket frames carry opaque browser/DSH bytes after a 101;
  // application WebSocket frames are never parsed by Orbit.
  async executeReverseWebSocket(nodeId, {
    sessionId = null,
    socket,
    head = Buffer.alloc(0),
    method = "GET",
    rawTarget,
    routeAuthority,
    routeProof,
    headers,
  }) {
    const channel = await this.acquireChannel(nodeId, { sessionId });
    if (sessionId !== null && channel.sessionId !== sessionId) {
      channel.close("reverse-session-stale");
      throw new ReverseSessionStaleError();
    }
    const requestId = randomBytes(16).toString("hex");
    const flow = new Flow({ channel, requestId, limits: this.limits });
    flow.websocket = true;
    flow.non101Finished = false;
    channel.markBusy(flow);
    let finishNon101 = null;

    const fail = (code, message = code) => {
      if (flow.aborted || flow.tearingDown) return;
      flow.tearingDown = true;
      flow.fail(code, message);
      try { channel.sendJson({ type: "abort", requestId, code }); } catch {}
      channel.close(code);
    };

    let resolveNon101;
    const non101Complete = new Promise((resolve) => { resolveNon101 = resolve; });
    finishNon101 = () => {
      if (flow.upgraded || !flow.browserReady || !flow.responseEnded || flow.non101Finished) return;
      flow.non101Finished = true;
      if (socket.destroyed || socket.writableEnded) {
        flow.browserClosed = true;
        flow.maybeIdle?.();
        resolveNon101?.();
        return;
      }
      socket.end(() => {
        flow.browserClosed = true;
        flow.maybeIdle?.();
        resolveNon101?.();
      });
    };

    const responseMessage = await new Promise((resolve, reject) => {
      flow.responseResolve = resolve;
      flow.responseReject = reject;
      flow.maybeIdle = () => {
        if (!flow.idleReceived || !flow.browserClosed || !flow.teardownComplete) return;
        // A non-101 response is still being delivered on the public socket
        // when the node's response-end/idle pair arrives. Do not reuse the
        // channel until its status line and buffered body have been written.
        if (flow.websocket && !flow.upgraded && !flow.browserReady) return;
        if (channel.closed) return;
        channel.markIdle();
      };
      const trackBrowserResponse = () => {
        flow.trackD7("browser-response", {
          queueSocket: socket,
          sourceSocket: flow.channel.socket,
          getQueuedBytes: () => flow.pendingOpaqueBytes + socket.writableLength,
        });
        flow.startD7((code, message) => fail(code, message));
      };
      flow.onOpaqueBytes = (bytes) => {
        if (socket.destroyed || socket.writableEnded) return;
        trackBrowserResponse();
        if (!flow.browserReady) {
          flow.pendingOpaqueBytes += bytes.length;
          if (flow.pendingOpaqueBytes > this.limits.hardCapBytes) {
            fail("flow-overrun", "browser response queue exceeded the hard cap");
            return;
          }
          flow.pendingOpaque.push(Buffer.from(bytes));
          flow.checkD7();
          return;
        }
        if (socket.writableLength > this.limits.hardCapBytes) {
          fail("flow-overrun", "browser response queue exceeded the hard cap");
          return;
        }
        try {
          const accepted = socket.write(bytes);
          flow.checkD7();
          if (!accepted && socket.writableLength > this.limits.hardCapBytes) {
            fail("flow-overrun", "browser response queue exceeded the hard cap");
          }
        } catch {
          fail("browser-write-error", "browser socket write failed");
        }
      };
      flow.onResponseEnd = () => {
        flow.responseEnded = true;
        flow.teardownComplete = true;
        if (!flow.upgraded) {
          // Non-101 responses use ordinary HTTP semantics. The response
          // body may arrive after response-end is observed by the parser;
          // finishNon101 waits until all bytes are written before close.
          flow.pendingResponseEnd = true;
          finishNon101?.();
          return;
        }
        try {
          if (!socket.destroyed) socket.destroy();
        } catch {}
        flow.maybeIdle?.();
      };
      flow.onChannelClosed = () => {
        flow.teardownComplete = true;
        try {
          if (!socket.destroyed) socket.destroy();
        } catch {}
        flow.maybeIdle?.();
      };

      const trackBrowserRequest = () => {
        flow.trackD7("browser-request", {
          queueSocket: channel.socket,
          sourceSocket: socket,
          getQueuedBytes: () => channel.socket.writableLength + flow.pendingBrowserToNodeBytes,
        });
        flow.startD7((code, message) => fail(code, message));
      };
      const pumpBrowserToNode = () => {
        if (flow.browserPumpWaiting || flow.aborted || channel.closed) return;
        flow.browserPumpWaiting = true;
        const resume = () => {
          flow.browserPumpWaiting = false;
          channel.socket.removeListener("drain", resume);
          if (!flow.aborted) pumpBrowserToNode();
        };
        while (flow.pendingBrowserToNode.length > 0 && !flow.aborted && !channel.closed) {
          if (channel.socket.writableLength >= this.limits.softMarkBytes) {
            flow.checkD7();
            channel.socket.once("drain", resume);
            return;
          }
          const bytes = flow.pendingBrowserToNode[0];
          const frame = bytes.subarray(0, this.limits.frameMaxBytes);
          const sent = channel.sendFrame(encodeFrame({ opcode: 0x2, payload: frame }));
          if (!sent && (channel.closed || channel.socket.destroyed || !channel.socket.writable)) {
            fail("channel-closed", "reverse channel write failed");
            return;
          }
          flow.pendingBrowserToNodeBytes -= frame.length;
          if (frame.length === bytes.length) flow.pendingBrowserToNode.shift();
          else flow.pendingBrowserToNode[0] = bytes.subarray(frame.length);
          if (channel.socket.writableLength > this.limits.hardCapBytes) {
            fail("flow-overrun", "reverse channel write exceeded the hard cap");
            return;
          }
          if (channel.socket.writableLength >= this.limits.softMarkBytes) {
            flow.checkD7();
            channel.socket.once("drain", resume);
            return;
          }
        }
        flow.browserPumpWaiting = false;
        flow.checkD7();
      };
      const onBrowserData = (bytes) => {
        if (flow.aborted || channel.closed) return;
        trackBrowserRequest();
        flow.pendingBrowserToNodeBytes += bytes.length;
        if (flow.pendingBrowserToNodeBytes > this.limits.hardCapBytes) {
          fail("flow-overrun", "browser request queue exceeded the hard cap");
          return;
        }
        flow.pendingBrowserToNode.push(Buffer.from(bytes));
        pumpBrowserToNode();
      };
      const onBrowserClose = () => {
        if (flow.browserClosed) return;
        flow.browserClosed = true;
        if (!flow.tearingDown) {
          flow.tearingDown = true;
          try { channel.sendJson({ type: "abort", requestId, code: "browser-close" }); } catch {}
        }
        try {
          if (!socket.destroyed) socket.destroy();
        } catch {}
        flow.maybeIdle?.();
      };
      socket.on("data", onBrowserData);
      socket.once("end", onBrowserClose);
      socket.once("close", onBrowserClose);
      socket.once("error", onBrowserClose);

      const sanitizedHeaders = sanitizeWebSocketOpenHeaders(headers);
      if (!channel.sendJson({
        type: "open",
        requestId,
        mode: "websocket",
        method,
        rawTarget,
        routeAuthority,
        headers: sanitizedHeaders,
        routeProof,
      })) {
        fail("channel-closed", "reverse channel is closed");
        reject(new ReverseFlowAbortedError("channel-closed", "reverse channel is closed"));
        return;
      }
      trackBrowserRequest();
      if (head && head.length > 0) {
        flow.pendingBrowserToNodeBytes += head.length;
        if (flow.pendingBrowserToNodeBytes > this.limits.hardCapBytes) {
          fail("flow-overrun", "initial websocket head exceeded the hard cap");
          reject(new ReverseFlowAbortedError("flow-overrun", "initial websocket head exceeded the hard cap"));
          return;
        }
        flow.pendingBrowserToNode.push(Buffer.from(head));
        pumpBrowserToNode();
      }
      if (!channel.sendJson({ type: "request-end", requestId })) {
        fail("channel-closed", "reverse channel is closed");
        reject(new ReverseFlowAbortedError("channel-closed", "reverse channel is closed"));
        return;
      }
      const timer = setTimeout(() => {
        fail("flow-stall", "reverse websocket handshake timed out");
        reject(new ReverseFlowAbortedError("flow-stall", "reverse websocket handshake timed out"));
      }, this.limits.stallTimeoutMs);
      timer.unref?.();
      const originalResolve = flow.responseResolve;
      flow.responseResolve = (message) => {
        clearTimeout(timer);
        originalResolve?.(message);
      };
      const originalReject = flow.responseReject;
      flow.responseReject = (error) => {
        clearTimeout(timer);
        originalReject?.(error);
      };
    });

    const status = Number(responseMessage.status);
    const response = rawHttpResponse(status, responseMessage.headers);
    try {
      socket.write(response);
    } catch {
      fail("browser-write-error", "browser handshake write failed");
      throw new ReverseFlowAbortedError("browser-write-error", "browser handshake write failed");
    }
    flow.browserReady = true;
    const pendingOpaque = flow.pendingOpaque;
    flow.pendingOpaque = [];
    flow.pendingOpaqueBytes = 0;
    for (const bytes of pendingOpaque) {
      if (socket.destroyed || socket.writableEnded || flow.aborted) break;
      flow.onOpaqueBytes?.(bytes);
    }
    if (status === 101) {
      flow.upgraded = true;
    } else {
      // Keep the public socket open until response-end has arrived and every
      // response body frame has been written. This preserves ordinary HTTP
      // non-101 body semantics across split reverse-channel messages.
      finishNon101?.();
      await non101Complete;
    }
    return { status, headers: responseMessage.headers, channel, flow };
  }

  // Execute one browser HTTP flow over this node's channels. Returns
  // { status, headers, body } where body is an async iterable of Buffers.
  // The caller MUST consume the body; abandoning it aborts the flow.
  async executeReverseHttp(nodeId, { sessionId = null, method, rawTarget, routeAuthority, routeProof, headers, body, abortPromise = null }) {
    const channel = await this.acquireChannel(nodeId, { abortPromise, sessionId });
    if (abortPromise) {
      Promise.resolve(abortPromise).then(() => {
        if (channel.flow === null && channel.state === "busy") channel.markIdle();
      }, () => {
        if (channel.flow === null && channel.state === "busy") channel.markIdle();
      });
    }
    if (sessionId !== null && channel.sessionId !== sessionId) {
      channel.close("reverse-session-stale");
      throw new ReverseSessionStaleError();
    }
    const requestId = randomBytes(16).toString("hex");
    const flow = new Flow({ channel, requestId, limits: this.limits });
    channel.markBusy(flow);

    const abort = (code = "browser-abort") => {
      if (flow.aborted || channel.closed) return;
      flow.fail(code, "browser abandoned the reverse response");
      try { channel.sendJson({ type: "abort", requestId, code }); } catch {}
      channel.close(code);
    };
    if (abortPromise) {
      Promise.resolve(abortPromise).then(() => abort("browser-abort")).catch(() => abort("browser-abort"));
    }
    const finish = async () => {
      // Wait for the node's explicit idle after complete flow teardown.
      const idle = await flow.waitForIdle(this.limits.stallTimeoutMs);
      if (!idle && !channel.closed && !flow.aborted) {
        flow.fail("channel-desync", "node did not report idle after response teardown");
        channel.close("channel-desync");
      }
    };

    try {
      // D6.1: the Hub applies RFC-0010 header sanitation before OPEN —
      // client X-Orbit-*, gateway assertion, management credentials, and
      // browser cookies never travel to the node or its DSH runtime.
      const sanitizedHeaders = sanitizeFlowHeaders(headers ?? []);
      channel.sendJson({
        type: "open",
        requestId,
        mode: "http",
        method,
        rawTarget,
        routeAuthority,
        headers: sanitizedHeaders,
        routeProof,
      });

      // Stream the request body with bounded backpressure: the soft mark
      // is the TCP writable queue of the channel socket. Above it the
      // source pauses until a drain or, on a 30s no-progress stall, the
      // flow and channel fail closed (D7).
      const socket = channel.socket;
      const waitDrain = (before) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), this.limits.stallTimeoutMs);
          timer.unref?.();
          socket.once("drain", () => {
            clearTimeout(timer);
            resolve(true);
          });
          void before;
        });

      const writeBytes = async (bytes) => {
        while (bytes.length > 0) {
          if (flow.aborted || channel.closed) {
            throw new ReverseFlowAbortedError(flow.abortCode ?? "channel-closed", "flow aborted while writing request body");
          }
          if (socket.writableLength > this.limits.hardCapBytes) {
            flow.fail("flow-overrun", "request queue exceeded the hard cap");
            channel.close("flow-overrun");
            throw new ReverseFlowAbortedError("flow-overrun", "request queue exceeded the hard cap");
          }
          const frame = bytes.subarray(0, this.limits.frameMaxBytes);
          socket.write(encodeFrame({ opcode: 0x2, payload: frame }));
          bytes = bytes.subarray(frame.length);
          if (socket.writableLength > this.limits.softMarkBytes) {
            const before = socket.writableLength;
            const drained = await waitDrain(before);
            if (!drained && socket.writableLength >= before) {
              flow.fail("flow-stall", "no progress while above the soft mark");
              channel.close("flow-stall");
              throw new ReverseFlowAbortedError("flow-stall", "no progress while above the soft mark");
            }
          }
        }
      };

      if (body) {
        for await (const chunk of body) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (buffer.length === 0) continue;
          await writeBytes(buffer);
        }
      }
      channel.sendJson({ type: "request-end", requestId });

      // Wait for the node's response head.
      const responseMessage = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new ReverseFlowAbortedError("flow-stall", "response timeout")), 30000);
        timer.unref?.();
        flow.responseResolve = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
        flow.responseReject = (error) => {
          clearTimeout(timer);
          reject(error);
        };
      });

      const responseBody = async function* () {
        try {
          while (true) {
            const chunk = await flow.nextBodyChunk();
            if (chunk === null) return;
            yield chunk;
            flow.consume(chunk.length);
          }
        } finally {
          flow.endBody();
        }
      };

      return {
        status: responseMessage.status,
        headers: responseMessage.headers,
        body: responseBody(),
        channel,
        abort,
        finish,
      };
    } catch (error) {
      flow.fail(error.code ?? "flow-failed", error.message);
      channel.close("flow-error");
      throw error;
    }
  }
}
