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
import { computeSecWebSocketAccept, createFrameParser, encodeFrame, randomSecWebSocketKey } from "../registry/reverse-ws.mjs";
import { REVERSE_CHANNEL_PATH, REVERSE_PROTOCOL } from "../registry/reverse-session.mjs";

const DSH_PROBE_TIMEOUT_MS = 3000;

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
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
    try {
      channel.socket.destroy();
    } catch {}
    this.recordEvent("channel-closed", { reason, state: channel.state });
    if (channel.flow) {
      const flow = channel.flow;
      channel.flow = null;
      try {
        flow.request.destroy();
      } catch {}
    }
    this.replenish();
  }

  // The Hub assigned a browser flow to this idle channel.
  async onChannelOpen(channel, open) {
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
    const headers = Object.fromEntries((open.headers ?? []).filter((entry) => Array.isArray(entry) && entry.length === 2));
    // RFC-0010 header sanitation already ran hub-side; the node never adds
    // credentials and never forwards route/machine headers to DSH.
    const sanitizedHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (lower.startsWith("x-orbit-") || lower === "connection") continue;
      sanitizedHeaders[name] = value;
    }
    // D6.1: the public authority is represented by routeAuthority — never
    // by an untrusted node-supplied or client-supplied Host value.
    sanitizedHeaders["host"] = open.routeAuthority;
    let target;
    try {
      target = new URL(this.dshTarget);
    } catch {
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
    channel.flow = request;
    const safeSendJson = (message) => {
      if (channel.flow === request && !channel.socket.destroyed) channel.sendJson(message);
    };

    const stalled = setTimeout(() => {
      // D7: no-progress stall aborts exactly this flow and the channel.
      try {
        request.destroy();
      } catch {}
      this.closeChannel(channel, "flow-stall");
    }, 30000);
    stalled.unref?.();
    const touch = () => {
      stalled.refresh();
    };

    request.on("error", () => {
      clearTimeout(stalled);
      safeSendJson({ type: "abort", requestId, code: "dsh-unreachable" });
      this.closeChannel(channel, "dsh-error");
    });
    request.on("response", (response) => {
      const responseHeaders = Object.entries(response.headers)
        .filter(([name]) => !["transfer-encoding", "content-length", "connection", "keep-alive"].includes(name.toLowerCase()))
        .map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : String(value)]);
      safeSendJson({ type: "response", requestId, status: response.statusCode ?? 502, headers: responseHeaders });
      response.on("data", (chunk) => {
        touch();
        // D7: split to at most 64 KiB frames; TCP carries the backpressure —
        // above the soft mark the response stream pauses and resumes on
        // drain; the hard cap aborts the flow fail-closed.
        let offset = 0;
        while (offset < chunk.length) {
          const frame = chunk.subarray(offset, offset + 65536);
          offset += frame.length;
          if (!channel.send(encodeFrame({ opcode: 0x2, payload: frame, mask: true }))) return;
        }
        if (channel.socket.writableLength > 2 * 1024 * 1024) {
          try {
            response.destroy();
          } catch {}
          this.closeChannel(channel, "flow-overrun");
          return;
        }
        if (channel.socket.writableLength > 512 * 1024 && !response.isPaused()) {
          response.pause();
          channel.socket.once("drain", () => {
            if (!response.destroyed && channel.flow === request) response.resume();
          });
        }
      });
      response.on("end", () => {
        clearTimeout(stalled);
        safeSendJson({ type: "response-end", requestId });
        channel.flow = null;
        channel.state = "idle";
        channel.sendJson({ type: "idle" });
        this.replenish();
      });
      response.on("error", () => {
        clearTimeout(stalled);
        this.closeChannel(channel, "dsh-response-error");
      });
    });
    // Request body from the Hub arrives as binary frames via
    // onChannelBinary → request.write; "request-end" finalizes it.
    channel.onRequestBody = (bytes) => {
      touch();
      request.write(bytes);
    };
    channel.onRequestEnd = () => {
      clearTimeout(stalled);
      request.end();
    };
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
      this.onChannelOpen(channel, message);
      return;
    }
    if (message.type === "request-end") {
      channel.onRequestEnd?.();
      return;
    }
    if (message.type === "abort") {
      // The hub aborted the flow: tear the channel down fail-closed.
      channel.onRequestBody = null;
      this.closeChannel(channel, "hub-abort");
      return;
    }
    this.closeChannel(channel, "unexpected-hub-message");
  }

  onChannelBinary(channel, bytes) {
    if (channel.onRequestBody) {
      channel.onRequestBody(bytes);
      return;
    }
    this.closeChannel(channel, "unexpected-binary");
  }
}
