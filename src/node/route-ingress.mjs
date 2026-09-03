// Node Route Ingress component (RFC-0008 rev. 5, SOP Stage 2).
// Dedicated listener exposing ONLY GET /_orbit/route-ready with ORBIT-ROUTE-V1.
// Rejects all other paths fail-closed without forwarding to upstream DSH.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { URL } from "node:url";
import { RouteNonceCache, verifyRouteRequest } from "../registry/route-auth.mjs";
import { computeRouteAuthority, validateRouteDomain } from "../registry/protocol.mjs";

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

    const requestListener = (req, res) => this.handleRequest(req, res);
    this.server = this.tls
      ? https.createServer(this.tls, requestListener)
      : http.createServer(requestListener);
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

    if (this.getNodeState && this.getNodeState() === "revoked") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "revoked", message: "node is revoked" } }));
      return;
    }

    // Explicit Stage 3 invariant: WebSocket upgrades MUST fail closed
    const upgradeHeader = req.headers.upgrade;
    const connectionHeader = req.headers.connection;
    if (
      (typeof upgradeHeader === "string" && upgradeHeader.toLowerCase() === "websocket") ||
      (typeof connectionHeader === "string" && connectionHeader.toLowerCase().includes("upgrade"))
    ) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "websocket-upgrade-not-supported", message: "WebSocket proxying is not supported in Stage 3" } }));
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
    let dshUrl;
    try {
      dshUrl = new URL(req.url, this.dshTarget);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "bad-request", message: "invalid target URL" } }));
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

    const isHttps = dshUrl.protocol === "https:";
    const clientMod = isHttps ? https : http;

    const reqOptions = {
      protocol: dshUrl.protocol,
      hostname: dshUrl.hostname,
      port: dshUrl.port || (isHttps ? 443 : 80),
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
    return new Promise((resolve) => {
      if (!this.server || !this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }
}
