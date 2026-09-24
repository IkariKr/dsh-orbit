// v0.5 reverse Node client (RFC-0012 D4, D8): the outbound authenticated
// control connection for NAT-restricted nodes.
//
// The connection is a WebSocket upgrade over TLS whose verification uses
// the existing node trust configuration (system/private CA, normal
// hostname/SAN validation, no skipVerify). The control vocabulary is
// deliberately tiny: receive `session`, answer `ready` (with generic local
// DSH transport readiness), send `status` when that readiness changes, and
// answer server pings. No browser payload and no commands travel here
// (RFC-0012 D4.1).
//
// Reconnect policy (D4.3): exponential backoff 1s..30s with ±20% jitter;
// a successful ready session resets it. Live session state is never
// persisted.

import tls from "node:tls";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { buildSigningString, MACHINE_V1_LABEL } from "../registry/protocol.mjs";
import { signSigningString, sha256Hex } from "../registry/crypto.mjs";
import { computeSecWebSocketAccept, createFrameParser, encodeFrame, randomSecWebSocketKey } from "../registry/reverse-ws.mjs";
import { REVERSE_PROTOCOL, REVERSE_CONTROL_PATH } from "../registry/reverse-session.mjs";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30_000;
const DSH_LIVENESS_POLL_MS = 10_000;
const DSH_PROBE_TIMEOUT_MS = 3000;

// Generic local DSH transport readiness (RFC-0012 D8): any HTTP response,
// including BrowserAuth 401 or an application 5xx, proves the configured
// DSH endpoint is responsive; refusal and timeout do not.
export function probeDshTransport(dshTarget, { timeoutMs = DSH_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(dshTarget);
    } catch {
      resolve(false);
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      resolve(false);
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    const request = mod.request(
      { protocol: url.protocol, hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname || "/", timeout: timeoutMs },
      (response) => {
        response.resume();
        resolve(true);
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
    request.end();
  });
}

export class ReverseClient {
  constructor({
    hubBaseUrl,
    getCredentials,
    dshTarget = "http://127.0.0.1:3080",
    readinessTarget = dshTarget,
    now = () => new Date(),
    onEvent = () => {},
    caCertificates = null,
    livenessPollMs = DSH_LIVENESS_POLL_MS,
    channelPool = null,
  }) {
    if (typeof getCredentials !== "function") {
      throw new Error("reverse client requires a getCredentials callback");
    }
    this.hubBaseUrl = hubBaseUrl?.replace(/\/$/, "");
    this.getCredentials = getCredentials;
    this.dshTarget = dshTarget;
    this.readinessTarget = readinessTarget ?? dshTarget;
    this.now = now;
    this.onEvent = onEvent;
    this.caCertificates = caCertificates;
    this.livenessPollMs = livenessPollMs;
    this.channelPool = channelPool;
    this.socket = null;
    this.parse = null;
    this.expectedAccept = null;
    this.sessionId = null;
    this.currentRouteReady = false;
    this.lastReportedRouteReady = null;
    this.stopped = true;
    this.backoffAttempt = 0;
    this.reconnectTimer = null;
    this.livenessTimer = null;
    this.routeReadyTimer = null;
  }

  recordEvent(event, detail = {}) {
    this.onEvent(event, detail);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attemptConnect();
  }

  stop() {
    this.stopped = true;
    this.channelPool?.clearSession();
    this.clearTimers();
    if (this.socket) {
      this.sendClose(1000, "node-stop");
      this.destroySocket();
    }
    this.sessionId = null;
    this.recordEvent("reverse-stopped");
  }

  clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    if (this.routeReadyTimer) {
      clearTimeout(this.routeReadyTimer);
      this.routeReadyTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    // D4.3: 1s, 2s, 4s … capped at 30s with ±20% jitter; reset on ready.
    const base = Math.min(RECONNECT_BASE_MS * 2 ** this.backoffAttempt, RECONNECT_CAP_MS);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.max(250, Math.round(base + jitter));
    this.backoffAttempt += 1;
    this.recordEvent("reverse-reconnect-scheduled", { delayMs: delay, attempt: this.backoffAttempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptConnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  destroySocket() {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    }
  }

  attemptConnect() {
    if (this.stopped || this.socket) return;
    const credentials = this.getCredentials();
    if (!credentials?.nodeId || !credentials?.keyId || !credentials?.privateKeyHex) {
      this.scheduleReconnect();
      return;
    }
    const url = new URL(`${this.hubBaseUrl}${REVERSE_CONTROL_PATH}`);
    if (url.protocol !== "https:" && url.protocol !== "wss:") {
      // The public reverse ingress is HTTPS/WSS only; plaintext is allowed
      // only for loopback test topologies, mirroring the Hub binding rules.
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
      if (!loopback) {
        this.recordEvent("reverse-connect-denied", { reason: "insecure-transport" });
        return;
      }
    }

    const isTls = url.protocol === "https:" || url.protocol === "wss:";
    const connectOptions = {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || (isTls ? 443 : 80)),
    };
    if (isTls) {
      // SNI must carry a hostname; for IP targets node verifies the leaf's
      // IP SANs against the connect host directly.
      if (net.isIP(connectOptions.host) === 0) {
        connectOptions.servername = connectOptions.host;
      }
      if (this.caCertificates) connectOptions.ca = this.caCertificates;
    }
    const mod = isTls ? tls : net;
    const socket = mod.connect(connectOptions, () => this.sendUpgradeRequest(socket, url, credentials));
    socket.setNoDelay(true);
    this.socket = socket;
    this.parse = null;
    this.expectedAccept = null;

    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (!this.parse) {
        buffered = Buffer.concat([buffered, chunk]);
        const boundary = buffered.indexOf("\r\n\r\n");
        if (boundary === -1) return;
        const head = buffered.subarray(0, boundary).toString("latin1");
        const rest = buffered.subarray(boundary + 4);
        this.onHandshakeResponse(head, rest);
        return;
      }
      this.parse(chunk);
    });
    socket.on("error", (error) => {
      this.recordEvent("reverse-connect-error", { message: error.message });
      this.onConnectionLost();
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.onConnectionLost();
      }
    });
  }

  sendUpgradeRequest(socket, url, credentials) {
    const key = randomSecWebSocketKey();
    this.expectedAccept = computeSecWebSocketAccept(key);
    const timestamp = String(Math.trunc(this.now().getTime() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const bodyHash = sha256Hex("");
    const signing = buildSigningString({
      label: MACHINE_V1_LABEL,
      method: "GET",
      path: REVERSE_CONTROL_PATH,
      timestamp,
      nonce,
      bodyHash,
      nodeId: credentials.nodeId,
    });
    const signature = signSigningString(credentials.privateKeyHex, signing);
    const request = [
      `GET ${REVERSE_CONTROL_PATH} HTTP/1.1`,
      `host: ${url.host}`,
      "upgrade: websocket",
      "connection: upgrade",
      `sec-websocket-key: ${key}`,
      "sec-websocket-version: 13",
      "x-orbit-node: " + credentials.nodeId,
      "x-orbit-key: " + credentials.keyId,
      `x-orbit-timestamp: ${timestamp}`,
      `x-orbit-nonce: ${nonce}`,
      `x-orbit-signature: ${signature}`,
      "\r\n",
    ].join("\r\n");
    socket.write(request);
  }

  onHandshakeResponse(head, rest) {
    const statusLine = head.split("\r\n")[0] ?? "";
    const statusCode = Number(statusLine.split(" ")[1] ?? 0);
    if (statusCode !== 101) {
      let code = "reverse-upgrade-denied";
      try {
        const bodyText = head.slice(head.indexOf("\r\n\r\n") + 4);
        code = JSON.parse(bodyText)?.error?.code ?? code;
      } catch {
        // Status-only rejection.
      }
      this.recordEvent("reverse-upgrade-denied", { status: statusCode, code });
      this.destroySocket();
      this.scheduleReconnect();
      return;
    }
    const acceptMatch = head.match(/sec-websocket-accept:\s*([^\r\n]+)/i);
    if (!acceptMatch || acceptMatch[1].trim() !== this.expectedAccept) {
      this.recordEvent("reverse-upgrade-denied", { status: 101, code: "accept-mismatch" });
      this.destroySocket();
      this.scheduleReconnect();
      return;
    }
    this.parse = createFrameParser({
      isClient: true,
      maxMessageBytes: 4096,
      onMessage: (text) => this.onControlMessage(text),
      onPing: (payload) => this.sendFrame(encodeFrame({ opcode: 0xa, payload, mask: true })),
      onClose: () => this.onConnectionLost(),
      onError: () => this.onConnectionLost(),
    });
    this.recordEvent("reverse-connected");
    if (rest && rest.length > 0) this.parse(rest);
  }

  sendFrame(buffer) {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    try {
      socket.write(buffer);
    } catch {
      // The error/close handlers own reconnection.
    }
  }

  sendJson(message) {
    this.sendFrame(encodeFrame({ opcode: 0x1, payload: Buffer.from(JSON.stringify(message), "utf8"), mask: true }));
  }

  sendClose(code, reason) {
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason, "utf8"));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, "utf8");
    this.sendFrame(encodeFrame({ opcode: 0x8, payload, mask: true }));
  }

  async onControlMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.onConnectionLost();
      return;
    }
    if (message === null || typeof message !== "object") {
      this.onConnectionLost();
      return;
    }
    if (message.type === "session") {
      if (message.protocol !== REVERSE_PROTOCOL) {
        // Invalid protocol/version fails closed.
        this.recordEvent("reverse-protocol-mismatch", { received: message.protocol ?? null });
        this.sendClose(1008, "protocol-mismatch");
        this.onConnectionLost();
        return;
      }
      this.sessionId = typeof message.reverseSessionId === "string" ? message.reverseSessionId : null;
      this.currentRouteReady = await probeDshTransport(this.readinessTarget);
      this.lastReportedRouteReady = this.currentRouteReady;
      this.sendJson({ type: "ready", protocol: REVERSE_PROTOCOL, routeReady: this.currentRouteReady });
      // A successful ready session resets the reconnect backoff (D4.3).
      this.backoffAttempt = 0;
      // The data-channel pool hangs off the current ready session (D5).
      this.channelPool?.setSession(this.sessionId, message.idleTarget, message.maxChannels);
      // D8: report status only when the local route readiness changes.
      this.routeReadyTimer = setInterval(async () => {
        const ready = await probeDshTransport(this.readinessTarget);
        if (ready !== this.lastReportedRouteReady && this.socket) {
          this.lastReportedRouteReady = ready;
          this.currentRouteReady = ready;
          this.sendJson({ type: "status", protocol: REVERSE_PROTOCOL, routeReady: ready });
          this.recordEvent("reverse-status-reported", { routeReady: ready });
        }
      }, this.livenessPollMs);
      this.routeReadyTimer.unref?.();
      return;
    }
    // Unknown control types fail closed: the node never executes
    // commands, RPCs, or shell requests from the control channel.
      this.recordEvent("reverse-unknown-control", { type: message.type ?? null });
      this.sendClose(1008, "unknown-control-type");
      this.onConnectionLost();
    }
  onConnectionLost() {
    const hadSession = this.sessionId !== null;
    this.channelPool?.clearSession();
    this.sessionId = null;
    this.parse = null;
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    if (this.routeReadyTimer) {
      clearInterval(this.routeReadyTimer);
      this.routeReadyTimer = null;
    }
    this.lastReportedRouteReady = null;
    this.currentRouteReady = false;
    this.destroySocket();
    if (hadSession) this.recordEvent("reverse-lost");
    this.scheduleReconnect();
  }
}
