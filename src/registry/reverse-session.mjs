// v0.5 reverse control session manager (RFC-0012 D4, D8, D13).
//
// One authenticated reverse control connection per node carries a small
// control vocabulary (session / ready / status / ping-pong / close) and
// NEVER browser payload. Live sessions are process memory only (RFC-0012
// D11): they are never persisted, never restored, and a Hub restart leaves
// every reverse node offline until it reconnects.
//
// Generation rules (D4.2):
//   - a new authenticated connection is PENDING and cannot evict the
//     current ready session;
//   - only a valid `ready` atomically promotes the new generation: the
//     old current session is closed and every late event from it is
//     ignored;
//   - pending connections are bounded per node (a new one closes the
//     node's prior pending) and must reach ready within 30s.

import { randomBytes } from "node:crypto";
import { computeSecWebSocketAccept, createFrameParser, encodeFrame } from "./reverse-ws.mjs";

export const REVERSE_PROTOCOL = "orbit-reverse-v1";
export const REVERSE_CONTROL_PATH = "/api/v1/reverse/control";
export const REVERSE_CHANNEL_PATH = "/api/v1/reverse/channel";
export const REVERSE_IDLE_TARGET_DEFAULT = 8;
export const REVERSE_MAX_CHANNELS_DEFAULT = 32;

const READY_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;
const CONTROL_MESSAGE_MAX_BYTES = 4096;

const CLOSE_NORMAL = 1000;
const CLOSE_POLICY = 1008;
const CLOSE_PROTOCOL = 1002;
const CLOSE_AWAY = 1001;

export class ReverseSession {
  constructor({ manager, nodeId, keyId, socket, secWebSocketKey }) {
    this.manager = manager;
    this.nodeId = nodeId;
    this.keyId = keyId;
    this.socket = socket;
    this.reverseSessionId = randomBytes(16).toString("hex");
    this.state = "pending"; // pending -> ready -> closed
    this.routeReady = false;
    this.superseded = false;
    this.closed = false;
    this.lastPongAt = manager.now().getTime();
    this.pingTimer = null;
    this.pongTimer = null;
    this.awaitingPong = false;

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "upgrade: websocket\r\n" +
        "connection: upgrade\r\n" +
        `sec-websocket-accept: ${computeSecWebSocketAccept(secWebSocketKey ?? "")}\r\n\r\n`,
    );

    this.sendJson({
      type: "session",
      protocol: REVERSE_PROTOCOL,
      reverseSessionId: this.reverseSessionId,
      idleTarget: this.manager.idleTarget,
      maxChannels: this.manager.maxChannels,
    });

    this.parse = createFrameParser({
      isClient: false, // the Hub is the server: client frames arrive masked
      maxMessageBytes: CONTROL_MESSAGE_MAX_BYTES,
      onMessage: (text) => this.onControlMessage(text),
      onPing: (payload) => this.sendFrame(encodeFrame({ opcode: 0xa, payload })),
      onPong: () => {
        this.lastPongAt = this.manager.now().getTime();
        this.awaitingPong = false;
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
      },
      onClose: () => this.close(CLOSE_NORMAL, "node-close", { fromPeer: true }),
      onError: () => this.close(CLOSE_PROTOCOL, "protocol-error"),
    });
    socket.on("data", (chunk) => this.parse(chunk));
    socket.on("error", () => this.close(CLOSE_AWAY, "socket-error", { fromPeer: true }));
    // HTTP server sockets are half-open (allowHalfOpen): a client that
    // half-closes never emits 'close' until we end our side, so 'end'
    // must also terminate the session.
    socket.on("end", () => this.close(CLOSE_AWAY, "socket-close", { fromPeer: true }));
    socket.on("close", () => this.close(CLOSE_AWAY, "socket-close", { fromPeer: true }));

    // D4.2 (Gate A P2-3): a pending connection must reach ready or die.
    this.readyTimer = setTimeout(() => {
      this.close(CLOSE_POLICY, "ready-timeout");
    }, this.manager.readyTimeoutMs);
    this.readyTimer.unref?.();

    // D4.3: hub pings every 20s; a missing pong closes the session after
    // exactly pongTimeoutMs (per-ping one-shot deadline).
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      this.awaitingPong = true;
      this.sendFrame(encodeFrame({ opcode: 0x9 }));
      this.pongTimer = setTimeout(() => {
        if (this.awaitingPong && !this.closed) {
          this.close(CLOSE_AWAY, "pong-timeout");
        }
      }, this.manager.pongTimeoutMs);
      this.pongTimer.unref?.();
    }, this.manager.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  sendFrame(buffer) {
    if (this.closed || this.socket.destroyed || !this.socket.writable) return;
    try {
      this.socket.write(buffer);
    } catch {
      this.close(CLOSE_AWAY, "socket-write-error", { fromPeer: true });
    }
  }

  sendJson(message) {
    this.sendFrame(encodeFrame({ opcode: 0x1, payload: Buffer.from(JSON.stringify(message), "utf8") }));
  }

  onControlMessage(text) {
    if (this.closed || this.superseded) return; // late old-generation events are ignored
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.close(CLOSE_PROTOCOL, "bad-json");
      return;
    }
    if (message === null || typeof message !== "object" || typeof message.type !== "string") {
      this.close(CLOSE_PROTOCOL, "bad-control-message");
      return;
    }
    if (message.type === "ready") {
      if (this.state === "ready") {
        this.close(CLOSE_PROTOCOL, "duplicate-ready");
        return;
      }
      if (message.protocol !== REVERSE_PROTOCOL) {
        // Invalid protocol/version fails closed (RFC-0012 D4.1).
        this.close(CLOSE_POLICY, "protocol-mismatch");
        return;
      }
      this.routeReady = message.routeReady === true;
      this.manager.promote(this);
      return;
    }
    if (message.type === "status") {
      if (this.state !== "ready") {
        this.close(CLOSE_PROTOCOL, "status-before-ready");
        return;
      }
      if (typeof message.routeReady !== "boolean") {
        this.close(CLOSE_PROTOCOL, "bad-status");
        return;
      }
      const previousReady = this.routeReady;
      this.routeReady = message.routeReady;
      if (previousReady !== this.routeReady) {
        this.manager.onRouteReadyChange?.(this.nodeId, this.routeReady);
      }
      return;
    }
    // The control vocabulary is deliberately closed: anything else —
    // commands, RPCs, shell requests — is a protocol violation.
    this.close(CLOSE_POLICY, "unknown-control-type");
  }

  // D4.2: atomic promotion. The previous ready generation is closed and
  // superseded; its late disconnects cannot clear the new session.
  promote() {
    if (this.closed || this.superseded) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.state = "ready";
    const previous = this.manager.current.get(this.nodeId);
    this.manager.current.set(this.nodeId, this);
    this.manager.pending.get(this.nodeId)?.delete(this);
    if (previous && previous !== this) {
      previous.markSuperseded();
      previous.close(CLOSE_AWAY, "superseded");
    }
    this.manager.onPromoted?.(this.nodeId, this.routeReady);
  }

  markSuperseded() {
    this.superseded = true;
  }

  close(code = CLOSE_NORMAL, reason = "hub-close", { fromPeer = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.state = "closed";
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    const current = this.manager.current.get(this.nodeId);
    if (current === this) {
      this.manager.current.delete(this.nodeId);
    }
    const pendingSet = this.manager.pending.get(this.nodeId);
    if (pendingSet) {
      pendingSet.delete(this);
      if (pendingSet.size === 0) this.manager.pending.delete(this.nodeId);
    }
    this.manager.onSessionClosed?.(this, reason);
    if (!fromPeer && !this.socket.destroyed) {
      try {
        const payload = Buffer.alloc(2 + Math.min(reason.length, 123));
        payload.writeUInt16BE(code, 0);
        payload.write(reason, 2, "utf8");
        this.sendFrame(encodeFrame({ opcode: 0x8, payload }));
      } catch {
        // The socket is gone; the close bookkeeping above already ran.
      }
    }
    try {
      this.socket.destroy();
    } catch {
      // Already destroyed.
    }
  }
}

export class ReverseSessionManager {
  constructor({ now = () => new Date(), onSessionClosed = null, onPromoted = null, onRouteReadyChange = null, readyTimeoutMs = READY_TIMEOUT_MS, pingIntervalMs = PING_INTERVAL_MS, pongTimeoutMs = PONG_TIMEOUT_MS, idleTarget = REVERSE_IDLE_TARGET_DEFAULT, maxChannels = REVERSE_MAX_CHANNELS_DEFAULT } = {}) {
    this.now = now;
    this.current = new Map(); // nodeId -> ready session
    this.pending = new Map(); // nodeId -> Set(pending sessions)
    this.onSessionClosed = onSessionClosed;
    this.onPromoted = onPromoted;
    this.onRouteReadyChange = onRouteReadyChange;
    this.readyTimeoutMs = readyTimeoutMs;
    this.pingIntervalMs = pingIntervalMs;
    this.pongTimeoutMs = pongTimeoutMs;
    this.idleTarget = idleTarget;
    this.maxChannels = maxChannels;
  }

  // Entry point after ORBIT-MACHINE-V1 authentication succeeded. The raw
  // socket completes the WebSocket handshake (the parsed upgrade request
  // supplies Sec-WebSocket-Key).
  registerUpgrade({ nodeId, keyId, socket, secWebSocketKey, head }) {
    // D4.2 (Gate A P2-3): bounded pending set — a new authenticated
    // connection closes the node's prior pending connections. It can
    // never evict the current ready session.
    const existing = this.pending.get(nodeId);
    if (existing) {
      for (const session of existing) {
        session.close(CLOSE_AWAY, "superseded-pending");
      }
    }
    const session = new ReverseSession({ manager: this, nodeId, keyId, socket, secWebSocketKey });
    if (head && head.length > 0) {
      session.parse(head);
      if (session.closed) return session;
    }
    let set = this.pending.get(nodeId);
    if (!set) {
      set = new Set();
      this.pending.set(nodeId, set);
    }
    set.add(session);
    return session;
  }

  promote(session) {
    // Deferred to the session's own promote() to keep one atomic path.
    session.promote();
  }

  getSessionInfo(nodeId) {
    const current = this.current.get(nodeId);
    if (!current || current.state !== "ready") return null;
    return {
      reverseSessionId: current.reverseSessionId,
      keyId: current.keyId,
      routeReady: current.routeReady,
    };
  }

  // RFC-0012 D8: deterministic presence. `routeMode` is the operator-owned
  // routing fact; a ready session on a direct node may display online but
  // stays ineligible for routing, and its death falls back to unknown.
  getPresence(nodeId, routeMode) {
    const current = this.current.get(nodeId);
    if (current && current.state === "ready") return "online";
    if (routeMode === "reverse") return "offline";
    return "unknown";
  }

  // RFC-0012 D8: reverse-mode route reachability = current ready session
  // AND current local route readiness. Direct-mode reachability keeps its
  // existing RFC-0010 probe behavior and never consults this manager.
  isReverseReachable(nodeId, routeMode) {
    if (routeMode !== "reverse") return null;
    const current = this.current.get(nodeId);
    return Boolean(current && current.state === "ready" && current.routeReady);
  }

  // Stage 6 wires lifecycle actions (delete/rotate) to this hook.
  closeSessionsForNode(nodeId, reason = "hub-close") {
    const current = this.current.get(nodeId);
    if (current) current.close(CLOSE_AWAY, reason);
    const pendingSet = this.pending.get(nodeId);
    if (pendingSet) {
      for (const session of [...pendingSet]) {
        session.close(CLOSE_AWAY, reason);
      }
    }
  }

  // Credential revocation is narrower than node deletion: only the reverse
  // generations authenticated with the revoked node key are invalidated.
  // Return their session IDs so callers with an injected channel manager can
  // close the matching data channels even without an onSessionClosed hook.
  closeSessionsForCredential(nodeId, keyId, reason = "credential-revoked") {
    const matching = [];
    const current = this.current.get(nodeId);
    if (current?.keyId === keyId) matching.push(current);
    const pendingSet = this.pending.get(nodeId);
    if (pendingSet) {
      for (const session of pendingSet) {
        if (session.keyId === keyId && !matching.includes(session)) matching.push(session);
      }
    }
    for (const session of matching) session.close(CLOSE_AWAY, reason);
    return matching.map((session) => session.reverseSessionId);
  }

  closeAll(reason = "hub-shutdown") {
    for (const nodeId of [...this.current.keys()]) {
      this.closeSessionsForNode(nodeId, reason);
    }
    for (const set of [...this.pending.values()]) {
      for (const session of [...set]) {
        session.close(CLOSE_AWAY, reason);
      }
    }
  }
}
