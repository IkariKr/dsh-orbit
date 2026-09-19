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

import { createFrameParser, encodeFrame } from "./reverse-ws.mjs";
import { computeSecWebSocketAccept } from "./reverse-ws.mjs";

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

let channelSequence = 0;

class Flow {
  constructor({ channel, requestId }) {
    this.channel = channel;
    this.requestId = requestId;
    this.aborted = false;
    this.abortCode = null;
    this.responseResolve = null;
    this.responseReject = null;
    this.bodyQueue = [];
    this.bodyWaiters = [];
    this.bodyEnded = false;
    this.idleResolve = null;
  }

  fail(code, message) {
    if (this.aborted) return;
    this.aborted = true;
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
    if (this.bodyWaiters.length > 0) {
      const waiter = this.bodyWaiters.shift();
      waiter.resolve(bytes);
      return;
    }
    this.bodyQueue.push(bytes);
  }

  endBody() {
    if (this.bodyEnded) return;
    this.bodyEnded = true;
    for (const waiter of this.bodyWaiters) waiter.resolve(null);
    this.bodyWaiters = [];
    this.idleResolve?.();
  }

  async nextBodyChunk() {
    if (this.bodyQueue.length > 0) return this.bodyQueue.shift();
    if (this.bodyEnded) return null;
    return new Promise((resolve, reject) => {
      this.bodyWaiters.push({ resolve, reject });
    });
  }

  waitForIdle(timeoutMs) {
    if (this.bodyEnded) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleResolve = resolve;
      setTimeout(resolve, timeoutMs).unref?.();
    });
  }
}

export class ReverseChannel {
  constructor({ manager, nodeId, sessionId, socket, secWebSocketKey }) {
    this.manager = manager;
    this.nodeId = nodeId;
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
      this.socket.write(buffer);
      return true;
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
      if (parsed.type === "idle") {
        if (this.flow) {
          // Idle mid-flow is a desync: fail closed.
          this.flow.fail("channel-desync", "idle reported mid-flow");
          this.close("channel-desync");
          return;
        }
        this.state = "idle";
        this.manager.onChannelIdle(this);
        return;
      }
      if (this.flow === null) {
        this.close("message-without-flow");
        return;
      }
      if (parsed.type === "response") {
        if (typeof parsed.status !== "number" || !Array.isArray(parsed.headers)) {
          this.flow.fail("bad-response", "response message lacks status/headers");
          this.close("bad-node-message");
          return;
        }
        this.flow.onResponse(parsed);
        return;
      }
      if (parsed.type === "response-end") {
        this.flow.endBody();
        return;
      }
      if (parsed.type === "abort") {
        console.error(`DBG hub got node abort code=${parsed.code}`);
        this.flow.fail(parsed.code ?? "node-abort", "node aborted the flow");
        // Fail closed on node-initiated abort: close the channel; the node
        // replenishes its pool with a fresh one.
        this.close("node-abort");
        return;
      }
      this.close("unexpected-node-message");
      return;
    }
    // Binary: response body bytes for the current flow.
    if (this.flow && !this.flow.aborted && !this.flow.bodyEnded) {
      this.flow.pushBody(message);
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
    if (this.flow) {
      this.flow.fail("channel-closed", `channel closed: ${reason}`);
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

  idleChannels(nodeId) {
    const set = this.channels.get(nodeId);
    if (!set) return [];
    return [...set].filter((channel) => !channel.closed && channel.state === "idle");
  }

  busyCount(nodeId) {
    const set = this.channels.get(nodeId);
    if (!set) return 0;
    return [...set].filter((channel) => !channel.closed && channel.state === "busy").length;
  }

  // Entry point after ORBIT-MACHINE-V1 auth and the session binding check.
  registerChannel({ nodeId, sessionId, socket, secWebSocketKey }) {
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
    const channel = new ReverseChannel({ manager: this, nodeId, sessionId, socket, secWebSocketKey });
    set.add(channel);
    this.resolveIdleWaiters(nodeId);
    return channel;
  }

  resolveIdleWaiters(nodeId) {
    const waiters = this.idleWaiters.get(nodeId);
    if (!waiters || waiters.size === 0) return;
    if (this.idleChannels(nodeId).length === 0) return;
    const waiter = waiters.values().next().value;
    waiters.delete(waiter);
    if (waiters.size === 0) this.idleWaiters.delete(nodeId);
    waiter.resolve();
  }

  onChannelIdle(channel) {
    this.resolveIdleWaiters(channel.nodeId);
  }

  onChannelClosed(channel, reason) {
    void reason;
    const set = this.channels.get(channel.nodeId);
    if (set) {
      set.delete(channel);
      if (set.size === 0) this.channels.delete(channel.nodeId);
    }
  }

  // One flow = one idle channel, marked busy. If none is idle, wait up to
  // capacityWaitMs for the node to replenish its pool; then 503.
  async acquireChannel(nodeId) {
    const idle = this.idleChannels(nodeId);
    if (idle.length > 0) {
      return idle[0];
    }
    const startedAt = this.now();
    while (this.now() - startedAt < this.capacityWaitMs) {
      await new Promise((resolve) => {
        let waiters = this.idleWaiters.get(nodeId);
        if (!waiters) {
          waiters = new Set();
          this.idleWaiters.set(nodeId, waiters);
        }
        const waiter = { resolve };
        waiters.add(waiter);
        setTimeout(resolve, Math.max(10, this.capacityWaitMs - (this.now() - startedAt))).unref?.();
      });
      const channel = this.idleChannels(nodeId)[0];
      if (channel) return channel;
    }
    throw new ReverseCapacityError();
  }

  closeChannelsForNode(nodeId, reason = "session-closed") {
    const set = this.channels.get(nodeId);
    if (!set) return;
    for (const channel of [...set]) {
      channel.close(reason);
    }
    this.channels.delete(nodeId);
    const waiters = this.idleWaiters.get(nodeId);
    if (waiters) {
      for (const waiter of waiters) waiter.resolve();
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
  }

  closeAll(reason = "hub-shutdown") {
    for (const nodeId of [...this.channels.keys()]) {
      this.closeChannelsForNode(nodeId, reason);
    }
  }

  // Execute one browser HTTP flow over this node's channels. Returns
  // { status, headers, body } where body is an async iterable of Buffers.
  // The caller MUST consume the body; abandoning it aborts the flow.
  async executeReverseHttp(nodeId, { method, rawTarget, routeAuthority, routeProof, headers, body }) {
    const channel = await this.acquireChannel(nodeId);
    const requestId = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
    const flow = new Flow({ channel, requestId });
    channel.markBusy(flow);

    const finish = async () => {
      // Wait (bounded) for the node to tear the flow down and report idle.
      await flow.waitForIdle(this.limits.stallTimeoutMs);
      if (!channel.closed && !flow.aborted) {
        channel.markIdle();
      }
    };

    try {
      channel.sendJson({
        type: "open",
        requestId,
        mode: "http",
        method,
        rawTarget,
        routeAuthority,
        headers: headers ?? [],
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
            // Bounded consumption: a stalled consumer stalls the node's
            // own socket writes, and the node's 2 MiB hard cap / 30s stall
            // closes the channel — fail closed, never buffer unbounded.
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
        finish,
      };
    } catch (error) {
      flow.fail(error.code ?? "flow-failed", error.message);
      channel.close("flow-error");
      throw error;
    }
  }
}
