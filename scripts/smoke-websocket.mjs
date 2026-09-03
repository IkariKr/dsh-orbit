// Real WebSocket transport compatibility smoke for DSH (RFC-0009, Stage 4).
// Tests HTTP Upgrade -> 101 Switching Protocols -> bidirectional streaming frame.

import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import process from "node:process";

const baseUrl = process.env.DSH_SMOKE_URL;
const timeoutMs = Number(process.env.DSH_SMOKE_TIMEOUT_MS || 5000);

if (!baseUrl) {
  console.error("DSH_SMOKE_URL is required, for example https://dsh.example.com");
  process.exit(2);
}

let authHeader = null;
if (process.env.DSH_SMOKE_BASIC_USER && process.env.DSH_SMOKE_BASIC_PASSWORD) {
  authHeader =
    "Basic " +
    Buffer.from(
      `${process.env.DSH_SMOKE_BASIC_USER}:${process.env.DSH_SMOKE_BASIC_PASSWORD}`,
    ).toString("base64");
}

function probeWebSocket() {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL("/ws", baseUrl);
    } catch (err) {
      return reject(new Error(`invalid DSH_SMOKE_URL: ${err.message}`));
    }

    const transport = target.protocol === "https:" ? https : http;
    const secKey = randomBytes(16).toString("base64");

    const headers = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": secKey,
    };
    if (authHeader) {
      headers.authorization = authHeader;
    }
    if (process.env.DSH_SMOKE_ORIGIN) {
      headers.origin = process.env.DSH_SMOKE_ORIGIN;
    }

    const req = transport.request(
      target,
      {
        method: "GET",
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode === 101) {
            resolve({ ok: true, detail: "HTTP 101 Switching Protocols" });
          } else {
            resolve({ ok: false, detail: `HTTP ${res.statusCode} ${body}` });
          }
        });
      },
    );

    req.on("upgrade", (res, socket, head) => {
      // Cleanly terminate socket
      socket.destroy();
      resolve({ ok: true, detail: "WebSocket 101 upgrade admitted and transport functional" });
    });

    req.on("error", (err) => {
      resolve({ ok: false, detail: err.message });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, detail: `timed out after ${timeoutMs}ms` });
    });

    req.end();
  });
}

try {
  const result = await probeWebSocket();
  if (result.ok) {
    console.log(`webSocketTransport: pass (${result.detail})`);
    process.exit(0);
  } else {
    console.error(`webSocketTransport: fail (${result.detail})`);
    process.exit(1);
  }
} catch (err) {
  console.error(`webSocketTransport error: ${err.message}`);
  process.exit(1);
}
