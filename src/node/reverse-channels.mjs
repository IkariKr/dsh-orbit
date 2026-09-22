// v0.5 reverse channel pool (Node side; RFC-0012 D5/D6/D7).
//
// The pool maintains a bounded set of outbound authenticated WebSocket
// data channels to the Hub, bound to the current ready reverse session
// (X-Orbit-Reverse-Session). Every channel carries at most one browser
// flow at a time. When the Hub assigns a flow it sends an OPEN message
// carrying the existing ORBIT-ROUTE-V1 proof; the proof is verified with
// the node's RFC-0008 public-key set and the SHARED process-level nonce
// cache (the same cache the direct route ingress uses — RFC-0012 D6.1)
// BEFORE anything touches the local DSH runtime.
//
// Outbound write bounds mirror D7: frames at most 64 KiB, a 512 KiB soft
// mark (source paused above it, resumed below 256 KiB), a 2 MiB hard cap
// and a 30s no-progress stall abort exactly that flow and close the
// channel. Desyncs fail closed; nothing is retried transparently.

import tls from "node:tls";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { signSigningString, sha256Hex } from "../registry/crypto.mjs";
import { buildSigningString, MACHINE_V1_LABEL, computeRouteAuthority } from "../registry/protocol.mjs";
import { verifyRouteRequest, RouteNonceCache } from "../registry/route-auth.mjs";
import { sanitizeSetCookieHeader } from "../registry/route-proxy.mjs";
import { computeSecWebSocketAccept, createFrameParser, encodeFrame, randomSecWebSocketKey } from "../registry/reverse-ws.mjs";
import { REVERSE_CHANNEL_PATH, REVERSE_PROTOCOL } from "../registry/reverse-session.mjs";

const DSH_PROBE_TIMEOUT_MS = 3000;

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

const CHANNEL_FRAME_MAX_BYTES = 64 * 1024;
const CHANNEL_SOFT_MARK_BYTES = 512 * 1024;
const CHANNEL_RESUME_BELOW_BYTES = 256 * 1024;
const CHANNEL_HARD_CAP_BYTES = 2 * 1024 * 1024;
const CHANNEL_STALL_TIMEOUT_MS = 30_000;

function isMachineManagementHeader(name) {
  const lower = String(name).toLowerCase();
  return lower.startsWith("x-orbit-") || [
    "x-dsh-authenticated-proxy",
    "x-dsh-operator-id",
    "x-csrf-token",
    "x-gateway-auth",
    "x-gateway-secret",
  ].includes(lower);
}

function serializeResponseHeaders(headers) {
  const result = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === undefined) continue;
      const serialized = String(item);
      result.push([
        name,
        name.toLowerCase() === "set-cookie" ? String(sanitizeSetCookieHeader(serialized)) : serialized,
      ]);
    }
  }
  return result;
}

function sendBinaryChunks(channel, bytes, onBackpressure) {
  for (let offset = 0; offset < bytes.length; offset += CHANNEL_FRAME_MAX_BYTES) {
    const frame = bytes.subarray(offset, offset + CHANNEL_FRAME_MAX_BYTES);
    const accepted = channel.send(encodeFrame({ opcode: 0x2, payload: frame, mask: true }));
    // Socket.write(false) means the frame was accepted but the writable queue
    // crossed its high-water mark; it is not a failed write. The caller pauses
    // the source below the soft mark and aborts only at the hard cap.
    if (!accepted && channel.socket.destroyed) return false;
    onBackpressure?.();
  }
  return !channel.socket.destroyed;
}

export class ReverseChannelPool {
  constructor({
    hubBaseUrl,
    getCredentials,
    caCertificates = null,
    getSessionId,
    routeDomain = "localhost",
    dshTarget = "http://127.0.0.1:3080",
    getTrustKeys = () => [],
    nonceCache = new RouteNonceCache(),
    now = () => Date.now(),
    onEvent = () => {},
  }) {
    this.hubBaseUrl = hubBaseUrl?.replace(/\/$/, "");
    this.getCredentials = getCredentials;
    this.caCertificates = caCertificates;
    this.getSessionId = getSessionId;
    this.routeDomain = routeDomain;
    this.dshTarget = dshTarget;
    this.getTrustKeys = getTrustKeys;
    // D6.1: one shared process-level ORBIT-ROUTE-V1 nonce/replay cache so
    // a fresh proof accepted on the direct ingress cannot be replayed on
    // the reverse transport (or vice versa) within the same node process.
    this.nonceCache = nonceCache;
    this.now = now;
    this.onEvent = onEvent;
    this.channels = new Set();
    this.stopped = true;
    this.replenishTimer = null;
  }

  recordEvent(event, detail = {}) {
    this.onEvent(event, detail);
  }

  setSession(sessionId, idleTarget, maxChannels) {
    this.sessionId = sessionId;
    this.idleTarget = idleTarget;
    this.maxChannels = maxChannels;
    this.stopped = false;
    this.replenish();
  }

  clearSession() {
    this.sessionId = null;
    this.stopped = true;
    if (this.replenishTimer) {
      clearTimeout(this.replenishTimer);
      this.replenishTimer = null;
    }
    for (const channel of [...this.channels]) {
      channel.destroy();
    }
    this.channels.clear();
  }

  idleCount() {
    return [...this.channels].filter((channel) => channel.state === "idle").length;
  }

  replenish() {
    if (this.stopped || !this.sessionId) return;
    const total = this.channels.size;
    const idle = this.idleCount();
    const connecting = [...this.channels].filter((channel) => channel.state === "connecting").length;
    const missing = Math.min(this.idleTarget - idle - connecting, this.maxChannels - total);
    for (let i = 0; i < missing; i += 1) {
      this.openChannel();
    }
    // A refused/failed upgrade leaves the pool short; retry shortly.
    if (idle + connecting < this.idleTarget && !this.replenishTimer) {
      this.replenishTimer = setTimeout(() => {
        this.replenishTimer = null;
        this.replenish();
      }, 1000);
      this.replenishTimer.unref?.();
    }
  }

  openChannel() {
    if (this.stopped || !this.sessionId) return;
    const credentials = this.getCredentials();
    if (!credentials?.nodeId || !credentials?.privateKeyHex) return;
    const url = new URL(`${this.hubBaseUrl}${REVERSE_CHANNEL_PATH}`);
    const isTls = url.protocol === "https:" || url.protocol === "wss:";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const connectOptions = { host, port: Number(url.port || (isTls ? 443 : 80)) };
    if (isTls) {
      if (net.isIP(host) === 0) connectOptions.servername = host;
      if (this.caCertificates) connectOptions.ca = this.caCertificates;
    }
    const mod = isTls ? tls : net;
    const socket = mod.connect(connectOptions, () => {
      const key = randomSecWebSocketKey();
      const expectedAccept = computeSecWebSocketAccept(key);
      const timestamp = String(Math.trunc(Number(this.now()) / 1000));
      const nonce = randomBytes(16).toString("hex");
      const bodyHash = sha256Hex("");
      const signing = buildSigningString({
        label: MACHINE_V1_LABEL,
        method: "GET",
        path: REVERSE_CHANNEL_PATH,
        timestamp,
        nonce,
        bodyHash,
        nodeId: credentials.nodeId,
      });
      const request = [
        `GET ${REVERSE_CHANNEL_PATH} HTTP/1.1`,
        `host: ${url.host}`,
        "upgrade: websocket",
        "connection: upgrade",
        `sec-websocket-key: ${key}`,
        "sec-websocket-version: 13",
        `x-orbit-reverse-session: ${this.sessionId}`,
        "x-orbit-node: " + credentials.nodeId,
        "x-orbit-key: " + credentials.keyId,
        `x-orbit-timestamp: ${timestamp}`,
        `x-orbit-nonce: ${nonce}`,
        `x-orbit-signature: ${signSigningString(credentials.privateKeyHex, signing)}`,
        "\r\n",
      ].join("\r\n");
      socket.write(request);
      channel.expectedAccept = expectedAccept;
    });
    socket.setNoDelay(true);
    const channel = {
      socket,
      state: "connecting",
      flow: null,
      expectedAccept: null,
      destroy: () => {
        try {
          socket.destroy();
        } catch {}
      },
      send: (buffer) => {
        if (socket.destroyed) return false;
        try {
          return socket.write(buffer);
        } catch {
          return false;
        }
      },
      sendJson: (message) => channel.send(encodeFrame({ opcode: 0x1, payload: Buffer.from(JSON.stringify(message), "utf8"), mask: true })),
      sendClose: (code, reason) => {
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason, "utf8"));
        payload.writeUInt16BE(code, 0);
        payload.write(reason, 2, "utf8");
        channel.send(encodeFrame({ opcode: 0x8, payload, mask: true }));
      },
    };
    this.channels.add(channel);

    let handshakeBuffer = Buffer.alloc(0);
    let parser = null;
    socket.on("data", (chunk) => {
      if (!parser) {
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const boundary = handshakeBuffer.indexOf("\r\n\r\n");
        if (boundary === -1) return;
        const head = handshakeBuffer.subarray(0, boundary).toString("latin1");
        const rest = handshakeBuffer.subarray(boundary + 4);
        const statusLine = head.split("\r\n")[0] ?? "";
        const status = Number(statusLine.split(" ")[1] ?? 0);
        if (status !== 101 || head.toLowerCase().indexOf("sec-websocket-accept:") === -1) {
          this.recordEvent("channel-upgrade-denied", { status });
          this.channels.delete(channel);
          socket.destroy();
          this.replenish();
          return;
        }
        const acceptMatch = head.match(/sec-websocket-accept:\s*([^\r\n]+)/i);
        if (!acceptMatch || acceptMatch[1].trim() !== channel.expectedAccept) {
          this.recordEvent("channel-upgrade-denied", { status: 101, code: "accept-mismatch" });
          this.channels.delete(channel);
          socket.destroy();
          this.replenish();
          return;
        }
        parser = createFrameParser({
          isClient: true,
          maxMessageBytes: 64 * 1024,
          onMessage: (message) => {
            if (typeof message === "string") this.onChannelText(channel, message);
            else this.onChannelBinary(channel, message);
          },
          onPing: (payload) => channel.send(encodeFrame({ opcode: 0xa, payload, mask: true })),
          onClose: () => this.closeChannel(channel, "hub-close"),
          onError: () => this.closeChannel(channel, "protocol-error"),
        });
        channel.state = "idle";
        this.recordEvent("channel-open");
        if (rest && rest.length > 0) parser(rest);
        this.replenish();
        return;
      }
      parser(chunk);
    });
    socket.on("error", () => {
      this.closeChannel(channel, "socket-error");
    });
    socket.on("close", () => {
      this.closeChannel(channel, "socket-close");
    });
  }

  closeChannel(channel, reason) {
    if (!this.channels.has(channel)) return;
    this.channels.delete(channel);
    const flow = channel.flow;
    channel.flow = null;
    channel.onRequestBody = null;
    channel.onRequestEnd = null;
    try {
      channel.socket.destroy();
    } catch {}
    this.recordEvent("channel-closed", { reason, state: channel.state });
    if (flow) {
      try {
        flow.request?.destroy?.();
      } catch {}
      try {
        flow.upstreamSocket?.destroy?.();
      } catch {}
      if (flow.stallTimer) clearTimeout(flow.stallTimer);
      if (flow.handshakeTimer) clearTimeout(flow.handshakeTimer);
    }
    this.replenish();
  }

  // The Hub assigned a browser flow to this idle channel.
  async onChannelOpen(channel, open) {
    this.recordEvent("flow-open", { mode: open.mode, requestId: typeof open.requestId === "string" ? open.requestId : null });
    if (
      typeof open.requestId !== "string" ||
      !Array.isArray(open.headers) ||
      open.headers.some((entry) => !Array.isArray(entry) || entry.length !== 2)
    ) {
      this.recordEvent("flow-proof-denied", { code: "malformed-open" });
      channel.sendJson({ type: "abort", requestId: open.requestId, code: "malformed-open" });
      channel.sendClose(1008, "malformed-open");
      this.closeChannel(channel, "malformed-open");
      return;
    }
    if (open.mode !== "http" && open.mode !== "websocket") {
      this.recordEvent("flow-proof-denied", { code: "invalid-mode" });
      channel.sendJson({ type: "abort", requestId: open.requestId, code: "invalid-mode" });
      channel.sendClose(1008, "invalid-mode");
      this.closeChannel(channel, "invalid-mode");
      return;
    }
    if (channel.state !== "idle") {
      channel.sendClose(1008, "channel-busy");
      this.closeChannel(channel, "open-on-busy");
      return;
    }
    const credentials = this.getCredentials();
    // D6.1: verify the ORBIT-ROUTE-V1 proof with the RFC-0008 key set and
    // the shared nonce cache BEFORE touching DSH. A wrong node, wrong
    // authority, stale or replayed proof aborts the flow fail-closed.
    const routeAuthority = typeof open.routeAuthority === "string" ? open.routeAuthority : "";
    const expectedAuthority = computeRouteAuthority(credentials.nodeId, this.routeDomain);
    if (routeAuthority.toLowerCase() !== expectedAuthority.toLowerCase()) {
      // The flow must target this node's own deterministic authority.
      this.recordEvent("flow-proof-denied", { code: "authority-mismatch" });
      channel.sendJson({ type: "abort", requestId: open.requestId, code: "authority-mismatch" });
      channel.sendClose(1008, "proof-denied");
      this.closeChannel(channel, "proof-denied");
      return;
    }
    const trustKeys = typeof this.getTrustKeys === "function" ? this.getTrustKeys() : [];
    const proofHeaders = {
      "x-orbit-route-node": open.routeProof?.nodeId ?? "",
      "x-orbit-route-key": open.routeProof?.keyId ?? "",
      "x-orbit-route-timestamp": open.routeProof?.timestamp !== undefined ? String(open.routeProof.timestamp) : "",
      "x-orbit-route-nonce": open.routeProof?.nonce ?? "",
      "x-orbit-route-signature": open.routeProof?.signature ?? "",
    };
    const authResult = verifyRouteRequest({
      headers: proofHeaders,
      method: open.method,
      rawTarget: open.rawTarget,
      expectedNodeId: credentials.nodeId,
      expectedRouteAuthority: routeAuthority,
      getPublicKey: (keyId) => trustKeys.find((key) => key.keyId === keyId) || null,
      nonceCache: this.nonceCache,
      nowMs: Number(this.now()),
    });
    if (!authResult.ok) {
      this.recordEvent("flow-proof-denied", { code: authResult.code });
      channel.sendJson({ type: "abort", requestId: open.requestId, code: authResult.code });
      channel.sendClose(1008, "proof-denied");
      this.closeChannel(channel, "proof-denied");
      return;
    }

    channel.state = "busy";
    channel.flow = null;
    await this.executeFlow(channel, open);
  }

  async executeFlow(channel, open) {
    const requestId = open.requestId;
    const mode = open.mode;
    const isWebSocket = mode === "websocket";
    const headers = {};
    for (const entry of open.headers ?? []) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [name, value] = entry;
      const key = String(name).toLowerCase();
      const existing = headers[key];
      if (existing === undefined) headers[key] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else headers[key] = [existing, value];
    }
    // RFC-0010 management headers are never forwarded to DSH. In particular,
    // do not treat ordinary browser Cookie/Authorization or WebSocket
    // upgrade headers as management metadata: the DSH handshake needs them.
    const sanitizedHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (isMachineManagementHeader(name)) continue;
      // Existing HTTP flows keep the old hop-by-hop behavior. A websocket
      // OPEN must retain Connection/Upgrade and the Sec-WebSocket fields.
      if (!isWebSocket && lower === "connection") continue;
      sanitizedHeaders[name] = value;
    }
    // D6.1: the public authority is represented by routeAuthority — never
    // by an untrusted node-supplied or client-supplied Host value.
    sanitizedHeaders.host = open.routeAuthority;
    let target;
    try {
      target = new URL(this.dshTarget);
    } catch {
      channel.sendJson({ type: "abort", requestId, code: "dsh-target-invalid" });
      this.closeChannel(channel, "dsh-target-invalid");
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      channel.sendJson({ type: "abort", requestId, code: "dsh-target-invalid" });
      this.closeChannel(channel, "dsh-target-invalid");
      return;
    }
    const mod = target.protocol === "https:" ? https : http;
    let request;
    try {
      request = mod.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        method: typeof open.method === "string" ? open.method : "GET",
        path: open.rawTarget,
        headers: sanitizedHeaders,
      });
    } catch {
      channel.sendJson({ type: "abort", requestId, code: "dsh-request-failed" });
      this.closeChannel(channel, "dsh-request-failed");
      return;
    }

    const flow = {
      request,
      mode,
      requestEnded: false,
      upgraded: false,
      upstreamSocket: null,
      pendingBrowserBytes: [],
      pendingBrowserBytesTotal: 0,
      pendingRequestBytes: [],
      pendingRequestBytesTotal: 0,
      requestPumpWaiting: false,
      requestEndPending: false,
      requestEndedSent: false,
      tearingDown: false,
      handshakeTimer: null,
      d7Timer: null,
      d7LastChannelQueued: 0,
      d7LastUpstreamQueued: 0,
      d7LastChannelProgressAt: Date.now(),
      d7LastUpstreamProgressAt: Date.now(),
    };
    channel.flow = flow;
    const safeSendJson = (message) => {
      if (channel.flow === flow && !channel.socket.destroyed) channel.sendJson(message);
    };

    const finishHttpFlow = () => {
      if (flow.tearingDown) return;
      flow.tearingDown = true;
      if (flow.handshakeTimer) clearTimeout(flow.handshakeTimer);
      if (flow.d7Timer) clearInterval(flow.d7Timer);
      safeSendJson({ type: "response-end", requestId });
      channel.flow = null;
      channel.onRequestBody = null;
      channel.onRequestEnd = null;
      channel.state = "idle";
      channel.sendJson({ type: "idle" });
      this.replenish();
    };

    const abortFlow = (code, reason) => {
      if (flow.tearingDown) return;
      flow.tearingDown = true;
      if (flow.handshakeTimer) clearTimeout(flow.handshakeTimer);
      if (flow.d7Timer) clearInterval(flow.d7Timer);
      safeSendJson({ type: "abort", requestId, code });
      this.closeChannel(channel, reason);
    };

    const startD7Timer = () => {
      if (flow.d7Timer) return;
      flow.d7Timer = setInterval(() => {
        if (flow.tearingDown) return;
        const channelQueued = channel.socket.writableLength;
        const upstreamQueued = flow.upstreamSocket
          ? flow.upstreamSocket.writableLength
          : flow.request
            ? flow.request.writableLength + flow.pendingRequestBytesTotal
            : 0;
        if (channelQueued > CHANNEL_HARD_CAP_BYTES || upstreamQueued > CHANNEL_HARD_CAP_BYTES) {
          abortFlow("flow-overrun", "D7 queue exceeded the hard cap");
          return;
        }
        if (channelQueued < flow.d7LastChannelQueued) markChannelProgress();
        if (upstreamQueued < flow.d7LastUpstreamQueued) markUpstreamProgress();
        if (channelQueued >= CHANNEL_SOFT_MARK_BYTES && Date.now() - flow.d7LastChannelProgressAt >= CHANNEL_STALL_TIMEOUT_MS) {
          abortFlow("flow-stall", "no channel queue progress above the soft mark");
          return;
        }
        if (upstreamQueued >= CHANNEL_SOFT_MARK_BYTES && Date.now() - flow.d7LastUpstreamProgressAt >= CHANNEL_STALL_TIMEOUT_MS) {
          abortFlow("flow-stall", "no upstream queue progress above the soft mark");
          return;
        }
        flow.d7LastChannelQueued = channelQueued;
        flow.d7LastUpstreamQueued = upstreamQueued;
      }, 250);
      flow.d7Timer.unref?.();
    };

    const touchHandshake = () => {
      if (!flow.upgraded) {
        flow.handshakeTimer?.refresh();
      }
    };

    const abortRequestQueue = () => {
      if (flow.requestPumpWaiting) return;
      flow.requestPumpWaiting = true;
      const pump = () => {
        if (flow.tearingDown || channel.flow !== flow) {
          flow.requestPumpWaiting = false;
          return;
        }
        while (flow.pendingRequestBytes.length > 0) {
          if (request.writableLength >= CHANNEL_SOFT_MARK_BYTES) {
            flow.d7LastUpstreamQueued = request.writableLength;
            startD7Timer();
            request.once("drain", pump);
            return;
          }
          const bytes = flow.pendingRequestBytes.shift();
          flow.pendingRequestBytesTotal -= bytes.length;
          try {
            request.write(bytes);
          } catch {
            abortFlow("dsh-unreachable", "dsh-request-write-error");
            return;
          }
          if (request.writableLength > CHANNEL_HARD_CAP_BYTES) {
            abortFlow("flow-overrun", "DSH request queue exceeded the hard cap");
            return;
          }
        }
        flow.requestPumpWaiting = false;
        flow.d7LastUpstreamQueued = request.writableLength;
        markUpstreamProgress();
        startD7Timer();
        if (flow.requestEndPending && !flow.requestEndedSent) {
          flow.requestEndedSent = true;
          try { request.end(); } catch { abortFlow("dsh-request-failed", "dsh-request-end-error"); }
        }
      };
      pump();
    };

    const markChannelProgress = () => {
      flow.d7LastChannelProgressAt = Date.now();
    };

    const markUpstreamProgress = () => {
      flow.d7LastUpstreamProgressAt = Date.now();
    };

    const sendUpstreamBytes = (bytes, source) => {
      if (!bytes || bytes.length === 0) return true;
      if (channel.socket.writableLength > CHANNEL_HARD_CAP_BYTES) {
        try { source?.destroy?.(); } catch {}
        abortFlow("flow-overrun", "flow-overrun");
        return false;
      }
      const sent = sendBinaryChunks(channel, bytes, () => {
        if (channel.socket.writableLength > CHANNEL_HARD_CAP_BYTES) {
          try { source?.destroy?.(); } catch {}
          abortFlow("flow-overrun", "flow-overrun");
        }
      });
      if (!sent) return false;
      if (channel.socket.writableLength > CHANNEL_SOFT_MARK_BYTES && !source?.isPaused?.()) {
        source?.pause?.();
        channel.socket.once("drain", () => {
          if (channel.flow === flow && channel.socket.writableLength < CHANNEL_RESUME_BELOW_BYTES) {
            source?.resume?.();
            markChannelProgress();
          }
        });
      }
      flow.d7LastChannelQueued = channel.socket.writableLength;
      markChannelProgress();
      startD7Timer();


      return channel.flow === flow;
    };

    const forwardBrowserBytes = (bytes) => {
      if (flow.tearingDown) return;
      if (!flow.upgraded || !flow.upstreamSocket || flow.upstreamSocket.destroyed) {
        flow.pendingBrowserBytesTotal += bytes.length;
        if (flow.pendingBrowserBytesTotal > CHANNEL_HARD_CAP_BYTES) {
          abortFlow("flow-overrun", "flow-overrun");
          return;
        }
        flow.pendingBrowserBytes.push(Buffer.from(bytes));
        return;
      }
      if (flow.upstreamSocket.writableLength > CHANNEL_HARD_CAP_BYTES) {
        abortFlow("flow-overrun", "flow-overrun");
        return;
      }
      try {
          flow.upstreamSocket.write(bytes);
        flow.d7LastUpstreamQueued = flow.upstreamSocket.writableLength;
        markUpstreamProgress();
        startD7Timer();
      } catch {
        abortFlow("dsh-unreachable", "dsh-websocket-write-error");
        return;
      }
      if (flow.upstreamSocket.writableLength > CHANNEL_SOFT_MARK_BYTES && !channel.socket.isPaused?.()) {
        channel.socket.pause();
        flow.upstreamSocket.once("drain", () => {
          if (channel.flow === flow && flow.upstreamSocket?.writableLength < CHANNEL_RESUME_BELOW_BYTES) channel.socket.resume();
        });
      }
    };

    const teardownUpgraded = (reason = "dsh-websocket-close") => {
      if (flow.tearingDown) return;
      flow.tearingDown = true;
      if (flow.handshakeTimer) clearTimeout(flow.handshakeTimer);
      if (channel.socket.isPaused?.()) channel.socket.resume();
      const complete = () => {
        if (flow.completed) return;
        flow.completed = true;
        if (flow.d7Timer) clearInterval(flow.d7Timer);
        safeSendJson({ type: "response-end", requestId });
        channel.flow = null;
        channel.onRequestBody = null;
        channel.onRequestEnd = null;
        channel.state = "idle";
        channel.sendJson({ type: "idle" });
        this.replenish();
        this.recordEvent("reverse-websocket-closed", { reason });
      };
      const upstreamSocket = flow.upstreamSocket;
      if (!upstreamSocket || upstreamSocket.destroyed) {
        complete();
        return;
      }
      upstreamSocket.once("close", complete);
      try { upstreamSocket.destroy(); } catch { complete(); }
    };

    const onUpstreamClose = () => {
      if (flow.upgraded) teardownUpgraded("dsh-websocket-close");
      else if (!flow.tearingDown) abortFlow("dsh-unreachable", "dsh-websocket-close-before-upgrade");
    };

    const onChannelSocketClose = () => {
      if (flow.upgraded && !flow.tearingDown) {
        flow.tearingDown = true;
        try { flow.upstreamSocket?.destroy?.(); } catch {}
      }
    };
    channel.socket.once("close", onChannelSocketClose);

    flow.handshakeTimer = setTimeout(() => {
      try { request.destroy(); } catch {}
      abortFlow("dsh-timeout", "flow-stall");
    }, CHANNEL_STALL_TIMEOUT_MS);
    flow.handshakeTimer.unref?.();

    request.on("error", () => {
      if (flow.tearingDown) return;
      if (flow.upgraded) {
        teardownUpgraded("dsh-websocket-error");
        return;
      }
      abortFlow("dsh-unreachable", "dsh-error");
    });

    request.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      this.recordEvent("flow-upgrade", { requestId });
      if (flow.tearingDown) {
        try { upstreamSocket.destroy(); } catch {}
        return;
      }
      flow.upgraded = true;
      flow.upstreamSocket = upstreamSocket;
      if (flow.handshakeTimer) clearTimeout(flow.handshakeTimer);
      upstreamSocket.setTimeout?.(0);
      startD7Timer();
      upstreamSocket.setNoDelay?.(true);
      upstreamSocket.on("data", (chunk) => {
        this.recordEvent("flow-upstream-data", { requestId, bytes: chunk.length });
        if (!sendUpstreamBytes(chunk, upstreamSocket)) return;
      });
      upstreamSocket.on("error", () => onUpstreamClose());
      upstreamSocket.on("end", () => {
        try { upstreamSocket.destroy(); } catch {}
      });
      upstreamSocket.on("close", onUpstreamClose);

      this.recordEvent("flow-response", { requestId, status: response.statusCode ?? 101 });
      safeSendJson({
        type: "response",
        requestId,
        status: response.statusCode ?? 101,
        headers: serializeResponseHeaders(response.headers),
      });
      if (upstreamHead && upstreamHead.length > 0) sendUpstreamBytes(upstreamHead, upstreamSocket);
      for (const bytes of flow.pendingBrowserBytes) {
        if (flow.tearingDown) break;
        forwardBrowserBytes(bytes);
      }
      flow.pendingBrowserBytes = [];
      flow.pendingBrowserBytesTotal = 0;
    });

    request.on("response", (response) => {
      const responseHeaders = [];
      for (const [name, value] of Object.entries(response.headers)) {
        if (["transfer-encoding", "content-length", "connection", "keep-alive"].includes(name.toLowerCase())) continue;
        responseHeaders.push(...serializeResponseHeaders({ [name]: value }));
      }
      safeSendJson({ type: "response", requestId, status: response.statusCode ?? 502, headers: responseHeaders });
      response.on("data", (chunk) => {
        touchHandshake();
        // D7: split to at most 64 KiB frames; TCP carries the backpressure —
        // above the soft mark the response stream pauses and resumes on
        // drain; the hard cap aborts the flow fail-closed.
        if (!sendUpstreamBytes(chunk, response)) return;
        if (channel.socket.writableLength > CHANNEL_SOFT_MARK_BYTES && !response.isPaused()) {
          response.pause();
          channel.socket.once("drain", () => {
            if (!response.destroyed && channel.flow === flow && channel.socket.writableLength < CHANNEL_RESUME_BELOW_BYTES) response.resume();
          });
        }
      });
      response.on("end", finishHttpFlow);
      response.on("error", () => abortFlow("dsh-response-error", "dsh-response-error"));
    });

    // Request body from the Hub arrives as binary frames. In websocket mode,
    // bytes received before the 101 are queued as the browser's upgrade head;
    // after 101 they are forwarded opaquely to the upgraded DSH socket.
    channel.onRequestBody = (bytes) => {
      touchHandshake();
      if (isWebSocket) {
        forwardBrowserBytes(bytes);
        return;
      }
      flow.pendingRequestBytesTotal += bytes.length;
      if (flow.pendingRequestBytesTotal > CHANNEL_HARD_CAP_BYTES) {
        abortFlow("flow-overrun", "DSH request queue exceeded the hard cap");
        return;
      }
      flow.pendingRequestBytes.push(Buffer.from(bytes));
      abortRequestQueue();
    };
    channel.onRequestEnd = () => {
      if (flow.requestEnded) return;
      flow.requestEnded = true;
      if (isWebSocket) {
        // OPEN itself is the complete HTTP upgrade request. Keep accepting
        // binary head bytes while the local upgrade is being negotiated.
        try { request.end(); } catch { abortFlow("dsh-request-failed", "dsh-request-end-error"); }
        return;
      }
      if (flow.handshakeTimer) clearTimeout(flow.handshakeTimer);
      if (flow.pendingRequestBytes.length > 0 || flow.requestPumpWaiting) {
        flow.requestEndPending = true;
        abortRequestQueue();
        return;
      }
      if (!flow.requestEndedSent) {
        flow.requestEndedSent = true;
        try { request.end(); } catch { abortFlow("dsh-request-failed", "dsh-request-end-error"); }
      }
    };

    if (isWebSocket) {
      // A Hub-side executeReverseWebSocket may omit request-end because the
      // upgrade has no HTTP body; start the local upgrade immediately.
      channel.onRequestEnd();
    }
  }

  onChannelText(channel, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.closeChannel(channel, "bad-json");
      return;
    }
    if (message === null || typeof message !== "object" || typeof message.type !== "string") {
      this.closeChannel(channel, "bad-hub-message");
      return;
    }
    if (message.type === "open") {
      void this.onChannelOpen(channel, message).catch(() => {
        this.closeChannel(channel, "open-handler-error");
      });
      return;
    }
    if (message.type === "request-end") {
      channel.onRequestEnd?.();
      return;
    }
    if (message.type === "abort") {
      // A browser-side WebSocket close is a flow teardown, not a pooled
      // channel failure. Close only the local upgraded socket, then report
      // response-end/idle after both sides have detached. HTTP aborts remain
      // fail-closed and replace the data channel.
      const flow = channel.flow;
      if (!flow || message.requestId !== flow.requestId) return;
      if (flow.mode === "websocket" && flow.upgraded) {
        flow.tearingDown = true;
        channel.onRequestBody = null;
        channel.onRequestEnd = null;
        const complete = () => {
          if (flow.completed) return;
          flow.completed = true;
          channel.flow = null;
          channel.state = "idle";
          channel.sendJson({ type: "response-end", requestId: message.requestId });
          channel.sendJson({ type: "idle" });
          this.replenish();
        };
        const upstreamSocket = flow.upstreamSocket;
        if (!upstreamSocket || upstreamSocket.destroyed) {
          complete();
        } else {
          upstreamSocket.once("close", complete);
          try { upstreamSocket.destroy(); } catch { complete(); }
        }
        return;
      }
      channel.onRequestBody = null;
      this.closeChannel(channel, "hub-abort");
      return;
    }
    this.closeChannel(channel, "unexpected-hub-message");
  }

  onChannelBinary(channel, bytes) {
    this.recordEvent("flow-browser-data", { bytes: bytes.length, hasBodyHandler: Boolean(channel.onRequestBody) });
    if (channel.onRequestBody) {
      channel.onRequestBody(bytes);
      return;
    }
    this.closeChannel(channel, "unexpected-binary");
  }
}
