// Node Route Ingress component (RFC-0008 rev. 5, SOP Stage 2).
// Dedicated listener exposing ONLY GET /_orbit/route-ready with ORBIT-ROUTE-V1.
// Rejects all other paths fail-closed without forwarding to upstream DSH.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";
import { RouteNonceCache, verifyRouteRequest } from "../registry/route-auth.mjs";
import { computeRouteAuthority, isValidOriginFormTarget, validateRouteDomain } from "../registry/protocol.mjs";
import { formatHttpResponse, sanitizeSetCookieHeader, sendSocketHttpError } from "../registry/route-proxy.mjs";

export class IngressWebSocketTracker {
  constructor({ maxConnections = 50 } = {}) {
    this.maxConnections = maxConnections;
    this.count = 0;
    this.activeSockets = new Set();
  }

  canAccept() {
    return this.count < this.maxConnections;
  }

  track(clientSocket, upstreamSocket = null) {
    this.count++;
    this.activeSockets.add(clientSocket);
    if (upstreamSocket) {
      this.activeSockets.add(upstreamSocket);
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.count = Math.max(0, this.count - 1);
      this.activeSockets.delete(clientSocket);
      if (upstreamSocket) {
        this.activeSockets.delete(upstreamSocket);
      }
    };

    clientSocket.once("close", release);
    clientSocket.once("error", release);
    if (upstreamSocket) {
      upstreamSocket.once("close", release);
      upstreamSocket.once("error", release);
    }
    return release;
  }

  destroyAll() {
    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {}
    }
    this.activeSockets.clear();
    this.count = 0;
  }
}

export class RouteIngress {
  constructor({
    nodeId,
    routeDomain = "localhost",
    getTrustKeys = () => [],
    getNodeState = () => "active",
    dshTarget = "http://127.0.0.1:3080",
    tls = null,
    nonceCache = new RouteNonceCache(),
    now = () => Date.now(),
    dshProbeTransport = null,
    forwardHttpEnabled = true,
  }) {
    if (!nodeId) throw new Error("nodeId is required for RouteIngress");
    this.nodeId = nodeId;
    this.routeDomain = validateRouteDomain(routeDomain);
    this.getTrustKeys = getTrustKeys;
    this.getNodeState = getNodeState;
    this.dshTarget = dshTarget;
    this.tls = tls;
    this.nonceCache = nonceCache;
    this.now = now;
    this.dshProbeTransport = dshProbeTransport;
    this.forwardHttpEnabled = forwardHttpEnabled;
    this.enabled = true;
    this.port = null;
    this.host = null;

    // Stage 4: Ingress WebSocket Connection Tracker
    const maxWs = process.env.DSH_ORBIT_NODE_WS_LIMIT ? Number(process.env.DSH_ORBIT_NODE_WS_LIMIT) : 50;
    this.wsTracker = new IngressWebSocketTracker({ maxConnections: maxWs });

    const requestListener = (req, res) => this.handleRequest(req, res);
    this.server = this.tls
      ? https.createServer(this.tls, requestListener)
      : http.createServer(requestListener);

    this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  disable() {
    this.enabled = false;
  }

  enable() {
    this.enabled = true;
  }

  async checkDshLiveness() {
    if (this.dshProbeTransport) {
      return Boolean(await this.dshProbeTransport());
    }
    if (typeof this.dshTarget === "string" && (this.dshTarget.startsWith("http://") || this.dshTarget.startsWith("https://"))) {
      try {
        const u = new URL(this.dshTarget);
        return await new Promise((resolve) => {
          const mod = u.protocol === "https:" ? https : http;
          const req = mod.request(
            {
              protocol: u.protocol,
              hostname: u.hostname,
              port: u.port || (u.protocol === "https:" ? 443 : 80),
              path: u.pathname || "/",
              method: "GET",
              timeout: 2000,
            },
            (res) => {
              res.resume();
              resolve(res.statusCode >= 200 && res.statusCode < 500);
            },
          );
          req.on("error", () => resolve(false));
          req.on("timeout", () => {
            req.destroy();
            resolve(false);
          });
          req.end();
        });
      } catch {
        return false;
      }
    }

    return new Promise((resolve) => {
      let host = "127.0.0.1";
      let port = 3080;
      if (typeof this.dshTarget === "string") {
        const parts = this.dshTarget.split(":");
        if (parts.length === 2) {
          host = parts[0];
          port = Number(parts[1]);
        }
      }
      const socket = net.createConnection({ host, port, timeout: 2000 }, () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  async handleRequest(req, res) {
    if (!this.enabled) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: false, error: "ingress_disabled" }));
      return;
    }

    if (!isValidOriginFormTarget(req.url)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "invalid-target", message: "only origin-form request-target is supported" } }));
      return;
    }

    if (this.getNodeState && this.getNodeState() === "revoked") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "revoked", message: "node is revoked" } }));
      return;
    }

    const activeNodeId = typeof this.nodeId === "function" ? this.nodeId() : this.nodeId;
    if (!activeNodeId) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: false, error: "node_not_enrolled" }));
      return;
    }

    const expectedRouteAuthority = computeRouteAuthority(activeNodeId, this.routeDomain);
    const trustKeys = typeof this.getTrustKeys === "function" ? this.getTrustKeys() : [];
    const getPublicKey = (keyId) => trustKeys.find((k) => k.keyId === keyId) || null;

    const nowVal = typeof this.now === "function" ? this.now() : Date.now();
    const nowMs = nowVal instanceof Date ? nowVal.getTime() : Number(nowVal);

    if (!this.forwardHttpEnabled && req.url !== "/_orbit/route-ready") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not-found", message: "only exact /_orbit/route-ready is allowed" } }));
      return;
    }

    // Every incoming request (both readiness and general HTTP) must verify ORBIT-ROUTE-V1
    const authResult = verifyRouteRequest({
      headers: req.headers,
      method: req.method,
      rawTarget: req.url,
      expectedNodeId: activeNodeId,
      expectedRouteAuthority,
      getPublicKey,
      nonceCache: this.nonceCache,
      nowMs,
    });

    if (!authResult.ok) {
      res.writeHead(authResult.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: authResult.code, message: authResult.message } }));
      return;
    }

    // Branch A: Orbit readiness contract (exact /_orbit/route-ready path)
    if (req.url === "/_orbit/route-ready") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json", allow: "GET" });
        res.end(JSON.stringify({ error: { code: "method-not-allowed", message: "only GET is supported" } }));
        return;
      }
      try {
        const isAlive = await this.checkDshLiveness();
        if (isAlive) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ nodeId: activeNodeId, ready: true }));
        } else {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ nodeId: activeNodeId, ready: false, error: "dsh_unreachable" }));
        }
      } catch {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ nodeId: activeNodeId, ready: false, error: "dsh_unreachable" }));
      }
      return;
    }

    // Branch B: General HTTP traffic forwarded to node-local DSH adapter
    if (!this.forwardHttpEnabled) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not-found", message: "only exact /_orbit/route-ready is allowed" } }));
      return;
    }
    this.forwardToDsh(req, res, expectedRouteAuthority);
  }

  forwardToDsh(req, res, routeAuthority) {
    let dshOrigin;
    try {
      const base = typeof this.dshTarget === "string" && (this.dshTarget.startsWith("http://") || this.dshTarget.startsWith("https://"))
        ? this.dshTarget
        : `http://${this.dshTarget}`;
      dshOrigin = new URL(base);
    } catch {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "config-error", message: "invalid dshTarget configuration" } }));
      return;
    }

    // Strip Orbit route authentication proofs before reaching downstream DSH
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (lower.startsWith("x-orbit-route-")) continue;
      // Strip management session and gateway assertion headers defensively
      if (lower === "x-dsh-authenticated-proxy" || lower === "x-dsh-operator-id" || lower === "x-csrf-token") continue;
      forwardHeaders[k] = v;
    }

    // Public authority presented to DSH adapter stays as deterministic route authority
    forwardHeaders.host = routeAuthority;

    const isHttps = dshOrigin.protocol === "https:";
    const clientMod = isHttps ? https : http;

    const reqOptions = {
      protocol: dshOrigin.protocol,
      hostname: dshOrigin.hostname,
      port: dshOrigin.port || (isHttps ? 443 : 80),
      path: req.url,
      method: req.method,
      headers: forwardHeaders,
      timeout: 30000,
    };

    const upstreamReq = clientMod.request(reqOptions, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    upstreamReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "bad-gateway", message: "downstream DSH unavailable" } }));
      }
    });

    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error("DSH connection timeout"));
    });

    // Stream request body without buffering
    req.pipe(upstreamReq);
  }

  handleUpgrade(req, socket, head) {
    if (!this.enabled) {
      sendSocketHttpError(socket, 503, "Service Unavailable", {}, {
        error: { code: "ingress-disabled", message: "route ingress is disabled" },
      });
      return;
    }

    const upgradeHeader = req.headers.upgrade;
    if (typeof upgradeHeader !== "string" || upgradeHeader.toLowerCase() !== "websocket") {
      sendSocketHttpError(socket, 400, "Bad Request", {}, {
        error: { code: "unsupported-upgrade-protocol", message: "only WebSocket upgrade is supported" },
      });
      return;
    }

    if (this.getNodeState && this.getNodeState() === "revoked") {
      sendSocketHttpError(socket, 401, "Unauthorized", {}, {
        error: { code: "revoked", message: "node is revoked" },
      });
      return;
    }

    if (!this.forwardHttpEnabled) {
      sendSocketHttpError(socket, 404, "Not Found", {}, {
        error: { code: "not-found", message: "proxying is disabled on this ingress" },
      });
      return;
    }

    if (!this.wsTracker.canAccept()) {
      sendSocketHttpError(socket, 503, "Service Unavailable", {}, {
        error: { code: "capacity-exhausted", message: "Node ingress WebSocket connection limit reached" },
      });
      return;
    }

    if (!isValidOriginFormTarget(req.url)) {
      sendSocketHttpError(socket, 400, "Bad Request", {}, {
        error: { code: "invalid-target", message: "only origin-form request-target is supported" },
      });
      return;
    }

    const activeNodeId = typeof this.nodeId === "function" ? this.nodeId() : this.nodeId;
    if (!activeNodeId) {
      sendSocketHttpError(socket, 503, "Service Unavailable", {}, {
        error: { code: "not-enrolled", message: "node is not enrolled" },
      });
      return;
    }

    const expectedRouteAuthority = computeRouteAuthority(activeNodeId, this.routeDomain);
    const trustKeys = typeof this.getTrustKeys === "function" ? this.getTrustKeys() : [];
    const getPublicKey = (keyId) => trustKeys.find((k) => k.keyId === keyId) || null;

    const nowVal = typeof this.now === "function" ? this.now() : Date.now();
    const nowMs = nowVal instanceof Date ? nowVal.getTime() : Number(nowVal);

    const authResult = verifyRouteRequest({
      headers: req.headers,
      method: req.method || "GET",
      rawTarget: req.url,
      expectedNodeId: activeNodeId,
      expectedRouteAuthority,
      getPublicKey,
      nonceCache: this.nonceCache,
      nowMs,
    });

    if (!authResult.ok) {
      sendSocketHttpError(socket, authResult.status, "Unauthorized", {}, {
        error: { code: authResult.code, message: authResult.message },
      });
      return;
    }

    // Track ingress socket
    this.wsTracker.track(socket);

    let dshOrigin;
    try {
      const base = typeof this.dshTarget === "string" && (this.dshTarget.startsWith("http://") || this.dshTarget.startsWith("https://"))
        ? this.dshTarget
        : `http://${this.dshTarget}`;
      dshOrigin = new URL(base);
    } catch {
      sendSocketHttpError(socket, 500, "Internal Server Error", {}, {
        error: { code: "config-error", message: "invalid dshTarget configuration" },
      });
      return;
    }

    // Strip Orbit route authentication proofs and gateway assertions before reaching downstream DSH
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (lower.startsWith("x-orbit-route-")) continue;
      if (lower === "x-dsh-authenticated-proxy" || lower === "x-dsh-operator-id" || lower === "x-csrf-token") continue;
      forwardHeaders[k] = v;
    }

    // Public authority presented to DSH adapter stays as deterministic route authority
    forwardHeaders.host = expectedRouteAuthority;

    const isHttps = dshOrigin.protocol === "https:";
    const clientMod = isHttps ? https : http;

    const reqOptions = {
      protocol: dshOrigin.protocol,
      hostname: dshOrigin.hostname,
      port: dshOrigin.port || (isHttps ? 443 : 80),
      path: req.url,
      method: req.method || "GET",
      headers: forwardHeaders,
      timeout: 10000,
    };

    const upstreamReq = clientMod.request(reqOptions);

    const onClientEarlyAbort = () => {
      try { upstreamReq.destroy(); } catch {}
    };
    socket.once("close", onClientEarlyAbort);
    socket.once("error", onClientEarlyAbort);

    upstreamReq.on("error", (err) => {
      socket.removeListener("close", onClientEarlyAbort);
      socket.removeListener("error", onClientEarlyAbort);
      sendSocketHttpError(socket, 502, "Bad Gateway", {}, {
        error: { code: "bad-gateway", message: `downstream DSH unavailable: ${err.message}` },
      });
    });

    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error("DSH handshake timeout"));
    });

    upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      socket.removeListener("close", onClientEarlyAbort);
      socket.removeListener("error", onClientEarlyAbort);
      upstreamReq.setTimeout(0);
      upstreamSocket.setTimeout(0);
      socket.setTimeout(0);

      this.wsTracker.activeSockets.add(upstreamSocket);
      upstreamSocket.once("close", () => this.wsTracker.activeSockets.delete(upstreamSocket));
      upstreamSocket.once("error", () => this.wsTracker.activeSockets.delete(upstreamSocket));

      // Sanitize Set-Cookie headers: remove Domain=
      const responseHeaders = { ...upstreamRes.headers };
      if (responseHeaders["set-cookie"]) {
        responseHeaders["set-cookie"] = sanitizeSetCookieHeader(responseHeaders["set-cookie"]);
      }

      const responseLineAndHeaders = formatHttpResponse(101, "Switching Protocols", responseHeaders);
      socket.write(responseLineAndHeaders);

      if (upstreamHead && upstreamHead.length > 0) {
        socket.write(upstreamHead);
      }
      if (head && head.length > 0) {
        upstreamSocket.write(head);
      }

      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);

      const cleanup = () => {
        try {
          socket.destroy();
        } catch {}
        try {
          upstreamSocket.destroy();
        } catch {}
      };

      socket.on("error", cleanup);
      upstreamSocket.on("error", cleanup);
      socket.on("close", cleanup);
      upstreamSocket.on("close", cleanup);
      socket.on("end", () => {
        socket.destroy();
        upstreamSocket.destroy();
      });
      upstreamSocket.on("end", () => {
        socket.destroy();
        upstreamSocket.destroy();
      });
    });

    upstreamReq.on("response", (upstreamRes) => {
      socket.removeListener("close", onClientEarlyAbort);
      socket.removeListener("error", onClientEarlyAbort);
      upstreamReq.setTimeout(0);
      const responseHeaders = { ...upstreamRes.headers };
      delete responseHeaders["transfer-encoding"];
      responseHeaders["connection"] = "close";
      if (responseHeaders["set-cookie"]) {
        responseHeaders["set-cookie"] = sanitizeSetCookieHeader(responseHeaders["set-cookie"]);
      }
      const responseLineAndHeaders = formatHttpResponse(
        upstreamRes.statusCode,
        upstreamRes.statusMessage || "Error",
        responseHeaders,
      );
      socket.write(responseLineAndHeaders);
      upstreamRes.pipe(socket);
    });

    upstreamReq.end();
  }

  listen(port, host = "127.0.0.1") {
    return new Promise((resolve, reject) => {
      this.server.on("error", reject);
      this.server.listen(port, host, () => {
        const addr = this.server.address();
        this.port = typeof addr === "object" && addr ? addr.port : port;
        this.host = host;
        resolve({ port: this.port, host: this.host });
      });
    });
  }

  close() {
    this.wsTracker.destroyAll();
    return new Promise((resolve) => {
      if (!this.server || !this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }
}
