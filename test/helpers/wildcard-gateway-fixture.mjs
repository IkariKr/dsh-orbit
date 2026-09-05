// Reusable TLS Wildcard Gateway Fixture (*.<routeDomain>)
// Validates host, enforces gateway authentication, strips outer gateway credentials,
// and securely proxies HTTP and WebSocket upgrades to the Hub.

import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";

export function startWildcardGateway({
  keyPath,
  certPath,
  hubPort,
  routeDomain,
  gatewayToken,
  gatewaySecret = "test-gateway-secret",
  operatorId = "operator",
  protocol = "https",
  port = 0,
}) {
  const cleanRouteDomain = routeDomain.toLowerCase().split(":")[0].replace(/\.$/, "");
  const registrationAuthority = `register.${cleanRouteDomain}`;

  return new Promise(async (resolve, reject) => {
    try {
      let key = null;
      let cert = null;
      if (protocol === "https") {
        key = await readFile(keyPath);
        cert = await readFile(certPath);
      }

      function checkHost(incomingHost) {
        const hostWithoutPort = incomingHost.toLowerCase().split(":")[0].replace(/\.$/, "");
        const isRehearsalHost =
          hostWithoutPort === cleanRouteDomain ||
          hostWithoutPort === registrationAuthority ||
          hostWithoutPort.endsWith(`.${cleanRouteDomain}`);
        return { hostWithoutPort, isRehearsalHost };
      }

      function sanitizeGatewayForwardHeaders(incomingHeaders, originalHost) {
        const forwardHeaders = { ...incomingHeaders };
        forwardHeaders.host = originalHost;
        delete forwardHeaders["x-gateway-auth"];
        delete forwardHeaders["x-gateway-secret"];
        if (forwardHeaders.cookie) {
          forwardHeaders.cookie = forwardHeaders.cookie
            .split(";")
            .map((c) => c.trim())
            .filter((c) => !c.startsWith("gateway-auth="))
            .join("; ");
          if (!forwardHeaders.cookie) delete forwardHeaders.cookie;
        }
        forwardHeaders["x-dsh-authenticated-proxy"] = gatewaySecret;
        forwardHeaders["x-dsh-operator-id"] = operatorId;
        return forwardHeaders;
      }

      function forwardHttpToHub(req, res, targetPort, originalHost) {
        const forwardHeaders = sanitizeGatewayForwardHeaders(req.headers, originalHost);

        const upstream = http.request(
          {
            hostname: "127.0.0.1",
            port: targetPort,
            path: req.url,
            method: req.method,
            headers: forwardHeaders,
          },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
            upstreamRes.pipe(res);
          },
        );

        upstream.on("error", (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { code: "gateway-upstream-error", message: err.message } }));
          }
        });

        req.pipe(upstream);
      }

      function forwardWsToHub(req, clientSocket, head, targetPort, originalHost) {
        const forwardHeaders = sanitizeGatewayForwardHeaders(req.headers, originalHost);

        const upstreamReq = http.request({
          hostname: "127.0.0.1",
          port: targetPort,
          path: req.url,
          method: req.method || "GET",
          headers: forwardHeaders,
        });

        upstreamReq.on("error", (err) => {
          const selectorUrl = `https://${routeDomain}/`;
          const body = JSON.stringify({ error: { code: "bad-gateway", message: err.message, selectorUrl } });
          const lines = [
            "HTTP/1.1 502 Bad Gateway",
            "Content-Type: application/json",
            `Content-Length: ${Buffer.byteLength(body)}`,
            "Connection: close",
            "",
            body,
          ];
          try {
            clientSocket.write(lines.join("\r\n"));
            clientSocket.end();
          } catch {}
        });

        upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
          upstreamReq.setTimeout(0);
          upstreamSocket.setTimeout(0);
          clientSocket.setTimeout(0);

          const responseLines = ["HTTP/1.1 101 Switching Protocols"];
          for (const [k, v] of Object.entries(upstreamRes.headers)) {
            if (Array.isArray(v)) {
              for (const item of v) responseLines.push(`${k}: ${item}`);
            } else {
              responseLines.push(`${k}: ${v}`);
            }
          }
          responseLines.push("", "");
          clientSocket.write(responseLines.join("\r\n"));

          if (upstreamHead && upstreamHead.length > 0) {
            clientSocket.write(upstreamHead);
          }
          if (head && head.length > 0) {
            upstreamSocket.write(head);
          }
          upstreamSocket.pipe(clientSocket);
          clientSocket.pipe(upstreamSocket);

          const cleanup = () => {
            try { clientSocket.destroy(); } catch {}
            try { upstreamSocket.destroy(); } catch {}
          };
          clientSocket.on("error", cleanup);
          upstreamSocket.on("error", cleanup);
          clientSocket.on("close", cleanup);
          upstreamSocket.on("close", cleanup);
        });

        // Upstream Hub responded with non-101 (e.g. 502 with selectorUrl)
        upstreamReq.on("response", (upstreamRes) => {
          const responseHeaders = { ...upstreamRes.headers };
          delete responseHeaders["transfer-encoding"];
          responseHeaders["connection"] = "close";

          const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage || "Error"}`];
          for (const [k, v] of Object.entries(responseHeaders)) {
            if (Array.isArray(v)) {
              for (const item of v) lines.push(`${k}: ${item}`);
            } else {
              lines.push(`${k}: ${v}`);
            }
          }
          lines.push("", "");
          clientSocket.write(lines.join("\r\n"));
          upstreamRes.pipe(clientSocket);
        });

        clientSocket.on("error", () => {
          try { upstreamReq.destroy(); } catch {}
        });

        upstreamReq.end();
      }

      const requestHandler = (req, res) => {
        const incomingHost = req.headers.host || "";
        const { hostWithoutPort, isRehearsalHost } = checkHost(incomingHost);

        if (!isRehearsalHost) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "unrelated-host-denied", message: "gateway does not route foreign host" } }));
          return;
        }

        if (hostWithoutPort === registrationAuthority) {
          if (req.url.startsWith("/api/v1/")) {
            res.writeHead(403, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { code: "machine-ingress-denied", message: "private machine surface" } }));
            return;
          }
          forwardHttpToHub(req, res, hubPort, incomingHost);
          return;
        }

        // Gateway login helper to set edge auth cookie for browser navigation
        if (req.url.startsWith("/gateway-login")) {
          const urlObj = new URL(req.url, "http://localhost");
          const tokenParam = urlObj.searchParams.get("token");
          if (tokenParam === gatewayToken) {
            res.writeHead(302, {
              "set-cookie": `gateway-auth=${gatewayToken}; Domain=.${cleanRouteDomain}; Path=/; SameSite=Lax`,
              location: urlObj.searchParams.get("return") || "/",
            });
            res.end();
            return;
          }
        }

        // Enforce outer gateway authentication for selector authority (routeDomain)
        // and routed node authorities (*.routeDomain).
        const cookieHeader = req.headers.cookie || "";
        const cookieAuth = cookieHeader.match(/(?:^|;\s*)gateway-auth=([^;]+)/)?.[1];
        const providedGatewayAuth = req.headers["x-gateway-auth"] || cookieAuth;
        if (!providedGatewayAuth || providedGatewayAuth !== gatewayToken) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "gateway-auth-required", message: "valid outer gateway authentication required" } }));
          return;
        }

        forwardHttpToHub(req, res, hubPort, incomingHost);
      };

      const server = protocol === "https"
        ? https.createServer({ key, cert }, requestHandler)
        : http.createServer(requestHandler);

      server.on("upgrade", (req, clientSocket, head) => {
        clientSocket.on("error", () => {});
        const incomingHost = req.headers.host || "";
        const { hostWithoutPort, isRehearsalHost } = checkHost(incomingHost);

        const sendSocketError = (status, code, message) => {
          const body = JSON.stringify({ error: { code, message } });
          const lines = [
            `HTTP/1.1 ${status} Error`,
            "Content-Type: application/json",
            `Content-Length: ${Buffer.byteLength(body)}`,
            "Connection: close",
            "",
            body,
          ];
          try {
            clientSocket.write(lines.join("\r\n"));
            clientSocket.destroy();
          } catch {}
        };

        if (!isRehearsalHost) {
          sendSocketError(400, "unrelated-host-denied", "gateway does not route foreign host");
          return;
        }

        if (hostWithoutPort === registrationAuthority) {
          sendSocketError(403, "machine-ingress-denied", "WebSocket upgrades not allowed on registration authority");
          return;
        }

        // Enforce outer gateway authentication for WebSocket upgrades across
        // both selector apex authority (cleanRouteDomain) and routed node authorities (*.cleanRouteDomain)
        const cookieHeader = req.headers.cookie || "";
        const cookieAuth = cookieHeader.match(/(?:^|;\s*)gateway-auth=([^;]+)/)?.[1];
        const providedGatewayAuth = req.headers["x-gateway-auth"] || cookieAuth;
        if (!providedGatewayAuth || providedGatewayAuth !== gatewayToken) {
          sendSocketError(401, "gateway-auth-required", "valid outer gateway authentication required");
          return;
        }

        forwardWsToHub(req, clientSocket, head, hubPort, incomingHost);
      });

      server.listen(port, "127.0.0.1", () => {
        resolve({
          server,
          port: server.address().port,
          close: () => new Promise((r) => server.close(r)),
        });
      });
      server.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}
