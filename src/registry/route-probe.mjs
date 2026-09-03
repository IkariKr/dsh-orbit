// Route probe transport and reachability engine (RFC-0009, RFC-0010 D3).
// Probes GET /_orbit/route-ready over verified TLS or loopback HTTP.

import http from "node:http";
import https from "node:https";
import { extendDefaultCaCertificates } from "../tls-trust.mjs";

export function defaultRouteTransport(urlStr, { method = "GET", headers = {}, caCertificates = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;
    const reqOptions = {
      method,
      headers,
      timeout: timeoutMs,
    };
    if (isHttps && caCertificates) {
      reqOptions.ca = extendDefaultCaCertificates(caCertificates);
    }
    const req = client.request(url, reqOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy(new Error("route probe timeout"));
    });
    req.end();
  });
}
