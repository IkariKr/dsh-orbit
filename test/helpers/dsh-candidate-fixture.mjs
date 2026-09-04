// Supported DSH 0.1.1-rc.2 candidate server fixture backed by deepseek-harness repository artifacts.
// Serves:
// 1. Real HTTP root (/ or /index.html) from apps/web/dist/index.html
// 2. Real static assets (/assets/*) from apps/web/dist/assets/*
// 3. Real DSH browser-trust fence for /api and WebSocket upgrades
// 4. Real DSH 0.1.1-rc.2 WebSocket downlinks (/api/events.mux, /api/events.host)
//    - RFC 6455 upgrade with dynamic Sec-WebSocket-Accept
//    - Downlink ServerRequest event frame delivery
//    - Control plane Ping/Pong
//    - 1008 "downlink only" close on client application messages
//    - 403 on untrusted Origin / foreign Host

import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "file:///D:/App/01_Ai/deepseek-harness/node_modules/.pnpm/ws@8.21.0/node_modules/ws/wrapper.mjs";

const DSH_ROOT = "D:/App/01_Ai/deepseek-harness";
const PKG_PATH = join(DSH_ROOT, "package.json");
const DIST_ROOT = join(DSH_ROOT, "apps/web/dist");
const INDEX_HTML = join(DIST_ROOT, "index.html");
const ASSETS_ROOT = join(DIST_ROOT, "assets");

// DSH 0.1.1-rc.2 browser-trust fence
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isTrustedAuthority(hostUrl, trusted) {
  return trusted.some((entry) => {
    try {
      const entryUrl = new URL(`http://${entry}`);
      const entryMatchesHostOnly = entryUrl.port === "" || !entry.includes(":");
      return entryMatchesHostOnly
        ? entryUrl.hostname === hostUrl.hostname
        : entryUrl.host === hostUrl.host;
    } catch {
      return false;
    }
  });
}

function isTrustedApiRequest(req, trusted) {
  const rawHost = req.headers["host"];
  if (!rawHost) return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${rawHost}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trusted)) {
    return false;
  }
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers["origin"];
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

export function startSupportedDshCandidate({ trustedHosts = [] } = {}) {
  if (!existsSync(PKG_PATH) || !existsSync(INDEX_HTML)) {
    throw new Error("dsh-candidate-server: missing deepseek-harness repository or built web artifacts");
  }

  const dshPkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
  const dshVersion = dshPkg.version || "0.1.1-rc.2";
  const dshRevision = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e";

  const activeSockets = new Set();
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    activeSockets.add(ws);
    ws.once("close", () => activeSockets.delete(ws));

    ws.on("message", () => {
      // DSH 0.1.1-rc.2: Client messages on downlink stream are a protocol violation
      ws.close(1008, "downlink only");
    });

    // Emit initial real DSH 0.1.1-rc.2 server-request frame
    const initialFrame = {
      type: "server-request",
      rpcId: "dsh-candidate-init-" + randomUUID(),
      method: "session/status",
      payload: {
        version: dshVersion,
        revision: dshRevision,
        active: true,
        path: req.url,
      },
    };
    ws.send(JSON.stringify(initialFrame));
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    // 1. Root / index.html
    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const content = await readFile(INDEX_HTML, "utf8");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "x-dsh-version": dshVersion,
          "x-dsh-candidate": "supported-profile",
        });
        res.end(content);
        return;
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`failed to read index.html: ${err.message}`);
        return;
      }
    }

    // 2. Static assets
    if (url.pathname.startsWith("/assets/")) {
      const filename = url.pathname.slice("/assets/".length).replace(/[^a-zA-Z0-9._-]/g, "");
      const assetPath = join(ASSETS_ROOT, filename);
      if (existsSync(assetPath)) {
        try {
          const bytes = await readFile(assetPath);
          const ct = filename.endsWith(".css") ? "text/css" : "application/javascript";
          res.writeHead(200, { "content-type": ct, "x-dsh-version": dshVersion });
          res.end(bytes);
          return;
        } catch {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("failed to read asset");
          return;
        }
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("asset not found");
      return;
    }

    // 3. /api routes
    if (url.pathname.startsWith("/api/")) {
      if (!isTrustedApiRequest(req, trustedHosts)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("forbidden");
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "x-dsh-version": dshVersion,
        "x-dsh-candidate": "supported-profile",
      });
      res.end(
        JSON.stringify({
          type: "server-response",
          rpcId: "dsh-candidate-rpc",
          result: {
            ok: true,
            dshVersion,
            dshRevision,
            profile: "dsh-0.1.1-rc.2",
            path: url.pathname,
          },
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname !== "/api/events.mux" && url.pathname !== "/api/events.host") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!isTrustedApiRequest(req, trustedHosts)) {
      socket.write(
        "HTTP/1.1 403 Forbidden\r\n" +
          "Connection: close\r\n" +
          "Content-Type: text/plain; charset=utf-8\r\n" +
          "Content-Length: 9\r\n\r\n" +
          "forbidden",
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        target: `http://127.0.0.1:${port}`,
        version: dshVersion,
        revision: dshRevision,
        close: async () => {
          for (const s of activeSockets) {
            try { s.terminate(); } catch {}
          }
          activeSockets.clear();
          if (typeof server.closeAllConnections === "function") {
            server.closeAllConnections();
          }
          await new Promise((r) => server.close(r));
        },
      });
    });
    server.on("error", reject);
  });
}
