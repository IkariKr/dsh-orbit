// Node Route Ingress component (RFC-0008 rev. 5, SOP Stage 2).
// Dedicated listener exposing ONLY GET /_orbit/route-ready with ORBIT-ROUTE-V1.
// Rejects all other paths fail-closed without forwarding to upstream DSH.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { URL } from "node:url";
import { RouteNonceCache, verifyRouteRequest } from "../registry/route-auth.mjs";
import { computeRouteAuthority } from "../registry/protocol.mjs";

export class RouteIngress {
  constructor({
    nodeId,
    routeDomain = "localhost",
    getTrustKeys = () => [],
    getNodeState = () => "active",
    dshTarget = "http://127.0.0.1:5000",
    tls = null,
    nonceCache = new RouteNonceCache(),
    now = () => Date.now(),
    dshProbeTransport = null,
  }) {
    if (!nodeId) throw new Error("nodeId is required for RouteIngress");
    this.nodeId = nodeId;
    this.routeDomain = routeDomain;
    this.getTrustKeys = getTrustKeys;
    this.getNodeState = getNodeState;
    this.dshTarget = dshTarget;
    this.tls = tls;
    this.nonceCache = nonceCache;
    this.now = now;
    this.dshProbeTransport = dshProbeTransport;
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
              resolve(true);
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
      let port = 5000;
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
      res.end(JSON.stringify({ nodeId: this.nodeId, ready: false, error: "ingress_disabled" }));
      return;
    }

    if (this.getNodeState && this.getNodeState() === "revoked") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "revoked", message: "node is revoked" } }));
      return;
    }

    const fullUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // Strict path gating: ONLY /_orbit/route-ready in Stage 2
    if (fullUrl.pathname !== "/_orbit/route-ready") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not-found", message: "route not allowed in stage 2" } }));
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json", allow: "GET" });
      res.end(JSON.stringify({ error: { code: "method-not-allowed", message: "only GET is supported" } }));
      return;
    }

    const expectedRouteAuthority = computeRouteAuthority(this.nodeId, this.routeDomain);
    const trustKeys = typeof this.getTrustKeys === "function" ? this.getTrustKeys() : [];
    const getPublicKey = (keyId) => trustKeys.find((k) => k.keyId === keyId) || null;

    const nowVal = typeof this.now === "function" ? this.now() : Date.now();
    const nowMs = nowVal instanceof Date ? nowVal.getTime() : Number(nowVal);

    const authResult = verifyRouteRequest({
      headers: req.headers,
      method: req.method,
      rawTarget: "/_orbit/route-ready",
      expectedNodeId: this.nodeId,
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

    try {
      const isAlive = await this.checkDshLiveness();
      if (isAlive) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ nodeId: this.nodeId, ready: true }));
      } else {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ nodeId: this.nodeId, ready: false, error: "dsh_unreachable" }));
      }
    } catch {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ nodeId: this.nodeId, ready: false, error: "dsh_unreachable" }));
    }
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
