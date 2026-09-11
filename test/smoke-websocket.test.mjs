import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/smoke-websocket.mjs", import.meta.url));
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function computeAccept(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function encodeServerControlFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  const buf = Buffer.alloc(2 + len);
  buf[0] = 0x80 | (opcode & 0x0f);
  buf[1] = len & 0x7f;
  payload.copy(buf, 2);
  return buf;
}

async function withServer(upgradeHandler, run) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    upgradeHandler(req, socket, head);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    for (const socket of sockets) {
      try { socket.destroy(); } catch {}
    }
    sockets.clear();
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    server.close();
    await once(server, "close");
  }
}

async function runSmoke(baseUrl, { extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    DSH_SMOKE_URL: baseUrl,
    DSH_SMOKE_TIMEOUT_MS: "500",
    ...extraEnv,
  };
  const child = spawn(process.execPath, [SCRIPT], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

test("smoke regression: real paths 404 + /ws works fails closed", async () => {
  await withServer(
    (req, socket) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/ws") {
        // Trap /ws: returns 101 and Pong, but real DSH paths (/api/events.mux, /api/events.host) are 404!
        const secKey = req.headers["sec-websocket-key"] || "";
        const accept = computeAccept(secKey);
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.on("data", () => {
          socket.write(encodeServerControlFrame(0x0a, Buffer.from("orbit-dsh-transport-ping")));
        });
        return;
      }
      // Real paths are refused with 404
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.end();
    },
    async (baseUrl) => {
      const { code, stderr, stdout } = await runSmoke(baseUrl);
      assert.notEqual(code, 0, "smoke must fail when real paths 404 even if /ws works");
      assert.match(stderr, /webSocketTransport: fail/);
      assert.match(stderr, /HTTP 404/);
      assert.doesNotMatch(stdout, /webSocketTransport: pass/);
    },
  );
});

test("smoke regression: 101 + immediate Close fails closed", async () => {
  await withServer(
    (req, socket) => {
      const secKey = req.headers["sec-websocket-key"] || "";
      const accept = computeAccept(secKey);
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      // Immediately send standard Close frame (opcode 0x08, code 1000)
      const closePayload = Buffer.from([0x03, 0xe8]); // 1000
      socket.write(encodeServerControlFrame(0x08, closePayload));
      socket.end();
    },
    async (baseUrl) => {
      const { code, stderr, stdout } = await runSmoke(baseUrl);
      assert.notEqual(code, 0, "immediate Close frame must be rejected as non-functional transport");
      assert.match(stderr, /closed connection immediately/);
      assert.doesNotMatch(stdout, /webSocketTransport: pass/);
    },
  );
});

test("smoke regression: invalid Sec-WebSocket-Accept fails closed", async () => {
  await withServer(
    (req, socket) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Accept: bogus-invalid-accept=\r\n\r\n`,
      );
      socket.on("data", () => {
        socket.write(encodeServerControlFrame(0x0a, Buffer.from("orbit-dsh-transport-ping")));
      });
    },
    async (baseUrl) => {
      const { code, stderr, stdout } = await runSmoke(baseUrl);
      assert.notEqual(code, 0, "bogus accept hash must fail");
      assert.match(stderr, /Sec-WebSocket-Accept mismatch/);
      assert.doesNotMatch(stdout, /webSocketTransport: pass/);
    },
  );
});

test("smoke regression: valid 101 + matching Pong passes", async () => {
  await withServer(
    (req, socket) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/api/events.mux") {
        const secKey = req.headers["sec-websocket-key"] || "";
        const accept = computeAccept(secKey);
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.on("data", () => {
          // Respond with Pong matching client payload
          socket.write(encodeServerControlFrame(0x0a, Buffer.from("orbit-dsh-transport-ping")));
        });
        return;
      }
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.end();
    },
    async (baseUrl) => {
      const { code, stdout } = await runSmoke(baseUrl);
      assert.equal(code, 0, "valid 101 + matching Pong must pass");
      assert.match(stdout, /webSocketTransport: pass/);
      assert.match(stdout, /matching Pong frame received/);
    },
  );
});
