// Real WebSocket transport compatibility smoke for DSH (RFC-0009, Stage 4).
// Tests HTTP Upgrade -> 101 Switching Protocols -> Sec-WebSocket-Accept verification
// -> bidirectional RFC 6455 control/data frame verification (Ping/Pong / downlink frame).
//
// The transport semantics follow the declared connection generation:
//   connection-v1               — downlink-only streams on /api/events.mux and
//                                 /api/events.host; a physical Ping/Pong plus an
//                                 observed server downlink frame is the proof.
//   connection-browser-auth-v1  — one bidirectional /api/remote.mux; the proof is
//                                 a physical Ping/Pong plus a real logical stream:
//                                 open $events -> item with value.type "ready".

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import process from "node:process";
import { streamPaths, wireContractForGeneration } from "../src/dsh-wire-contract.mjs";

const baseUrl = process.env.DSH_SMOKE_URL;
const timeoutMs = Number(process.env.DSH_SMOKE_TIMEOUT_MS || 5000);

if (!baseUrl) {
  console.error("DSH_SMOKE_URL is required, for example https://dsh.example.com");
  process.exit(2);
}

// The transport vocabulary follows the declared generation — never a version
// comparison, which would let an unreviewed release inherit a transport that
// was never validated for it.
const generation = process.env.DSH_SMOKE_CONNECTION_PATCH;
if (!generation) {
  console.error(
    "DSH_SMOKE_CONNECTION_PATCH is required: set it to the candidate's reviewed connection patch generation " +
      "(connection-v1 or connection-browser-auth-v1)",
  );
  process.exit(2);
}
let contract;
try {
  contract = wireContractForGeneration(generation);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

let candidatePaths;
try {
  candidatePaths = streamPaths(contract, process.env.DSH_SMOKE_WS_PATH);
} catch (error) {
  console.error(error.message);
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

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PING_PAYLOAD = "orbit-dsh-transport-ping";

function computeAccept(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function encodeClientControlFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  const buf = Buffer.alloc(2 + 4 + len);
  buf[0] = 0x80 | (opcode & 0x0f);
  buf[1] = 0x80 | (len & 0x7f);
  const mask = randomBytes(4);
  mask.copy(buf, 2);
  for (let i = 0; i < len; i++) {
    buf[6 + i] = payload[i] ^ mask[i % 4];
  }
  return buf;
}

function parseFrameHeader(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const hasMask = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  let maskKey = null;
  if (hasMask) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    payload[i] = hasMask ? buf[offset + i] ^ maskKey[i % 4] : buf[offset + i];
  }
  return { fin, opcode, payload, totalLength: offset + len };
}

function probePath(targetPath) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(targetPath, baseUrl);
    } catch (err) {
      return reject(new Error(`invalid target URL: ${err.message}`));
    }

    const transport = target.protocol === "https:" ? https : http;
    const secKey = randomBytes(16).toString("base64");
    const expectedAccept = computeAccept(secKey);

    const origin = process.env.DSH_SMOKE_ORIGIN || target.origin;

    const headers = {
      host: target.host,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": secKey,
      origin,
      "sec-fetch-site": "same-origin",
    };
    if (authHeader) {
      headers.authorization = authHeader;
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
          resolve({ ok: false, statusCode: res.statusCode, detail: `HTTP ${res.statusCode} ${body}` });
        });
      },
    );

    let completed = false;
    const done = (result) => {
      if (completed) return;
      completed = true;
      resolve(result);
    };

    req.on("upgrade", (res, socket, head) => {
      const actualAccept = res.headers["sec-websocket-accept"];
      if (!actualAccept || actualAccept !== expectedAccept) {
        try { socket.destroy(); } catch {}
        return done({
          ok: false,
          statusCode: 101,
          detail: `Sec-WebSocket-Accept mismatch: expected ${expectedAccept}, got ${actualAccept ?? "missing"}`,
        });
      }

      // Test data plane: send Ping frame and await Pong (or downlink stream frame)
      const pingFrame = encodeClientControlFrame(0x09, Buffer.from(PING_PAYLOAD));

      let buf = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        try { socket.destroy(); } catch {}
      };

      const cleanClose = () => {
        if (cleaned) return;
        cleaned = true;
        try {
          // Send normal close frame
          const closeFrame = encodeClientControlFrame(0x08, Buffer.from([0x03, 0xe8]));
          socket.write(closeFrame);
        } catch {}
        try { socket.destroy(); } catch {}
      };

      const timer = setTimeout(() => {
        cleanup();
        done({
          ok: false,
          statusCode: 101,
          detail: `transport data plane verification timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      let observedDownlinkFrame = null;

      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const frame = parseFrameHeader(buf);
          if (!frame) break; // Wait for complete frame
          buf = buf.slice(frame.totalLength);

          // 1. If server sent Close frame (opcode 0x08), it closed before functional transport was verified!
          if (frame.opcode === 0x08) {
            clearTimeout(timer);
            socket.removeListener("data", onData);
            cleanup();
            const closeCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
            return done({
              ok: false,
              statusCode: 101,
              detail: `WebSocket server closed connection immediately (opcode 0x08 Close frame received, code ${closeCode})`,
            });
          }

          // 2. Application data frame (opcode 0x01 text or 0x02 binary downlink):
          // Record transport activity (server -> browser confirmed), but keep waiting for matching Pong (browser -> server -> browser confirmed)!
          if (frame.opcode === 0x01 || frame.opcode === 0x02) {
            observedDownlinkFrame = `downlink frame (opcode 0x${frame.opcode.toString(16)}, ${frame.payload.length} bytes)`;
            continue;
          }

          // 3. Pong frame (opcode 0x0A): strictly require matching client Ping payload!
          if (frame.opcode === 0x0a) {
            clearTimeout(timer);
            socket.removeListener("data", onData);
            const pongPayload = frame.payload.toString("utf8");
            cleanClose();
            if (pongPayload !== PING_PAYLOAD) {
              return done({
                ok: false,
                statusCode: 101,
                detail: `WebSocket Pong payload mismatch (expected '${PING_PAYLOAD}', got '${pongPayload}')`,
              });
            }
            const activityNote = observedDownlinkFrame ? `${observedDownlinkFrame} + matching Pong frame received` : "matching Pong frame received";
            return done({
              ok: true,
              statusCode: 101,
              detail: `WebSocket 101 upgrade on ${targetPath} verified: valid accept, ${activityNote}`,
            });
          }

          // 4. Unexpected control or reserved frame
          clearTimeout(timer);
          socket.removeListener("data", onData);
          cleanup();
          return done({
            ok: false,
            statusCode: 101,
            detail: `Unexpected WebSocket frame opcode: 0x${frame.opcode.toString(16)}`,
          });
        }
      };

      socket.on("data", onData);
      socket.on("error", (err) => {
        clearTimeout(timer);
        cleanup();
        done({ ok: false, statusCode: 101, detail: `socket error after upgrade: ${err.message}` });
      });
      socket.on("end", () => {
        clearTimeout(timer);
        cleanup();
        done({ ok: false, statusCode: 101, detail: "socket closed prematurely by server before transport verification" });
      });

      // Write Ping frame to server
      socket.write(pingFrame);

      // If bytes were already received in upgrade head, process immediately
      if (buf.length > 0) {
        onData(Buffer.alloc(0));
      }
    });

    req.on("error", (err) => {
      done({ ok: false, detail: `request error: ${err.message}` });
    });

    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, detail: `timed out after ${timeoutMs}ms` });
    });

    req.end();
  });
}

// The BrowserAuth generation serves one bidirectional multiplex. Beyond the
// physical Ping/Pong, the proof is a real logical stream: open the well-known
// $events stream and require the mux to deliver an item for the same streamId
// whose value is the ready frame — the measured application-level handshake.
function probeMux(targetPath) {
  const TEXT = 0x1;
  const PONG = 0xa;
  const CLOSE = 0x8;
  const streamId = "orbit-smoke-events";

  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(targetPath, baseUrl);
    } catch (err) {
      return reject(new Error(`invalid target URL: ${err.message}`));
    }

    const transport = target.protocol === "https:" ? https : http;
    const secKey = randomBytes(16).toString("base64");
    const expectedAccept = computeAccept(secKey);
    const origin = process.env.DSH_SMOKE_ORIGIN || target.origin;

    const headers = {
      host: target.host,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": secKey,
      origin,
      "sec-fetch-site": "same-origin",
    };
    if (authHeader) headers.authorization = authHeader;

    const req = transport.request(target, { method: "GET", headers, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ ok: false, statusCode: res.statusCode, detail: `HTTP ${res.statusCode} ${body}` }));
    });

    let completed = false;
    const done = (result) => {
      if (completed) return;
      completed = true;
      resolve(result);
    };

    req.on("upgrade", (res, socket, head) => {
      const actualAccept = res.headers["sec-websocket-accept"];
      if (!actualAccept || actualAccept !== expectedAccept) {
        try { socket.destroy(); } catch {}
        return done({
          ok: false,
          statusCode: 101,
          detail: `Sec-WebSocket-Accept mismatch: expected ${expectedAccept}, got ${actualAccept ?? "missing"}`,
        });
      }

      let buf = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        try { socket.destroy(); } catch {}
      };
      const cleanClose = () => {
        if (cleaned) return;
        cleaned = true;
        try {
          socket.write(encodeClientControlFrame(0x08, Buffer.from([0x03, 0xe8])));
        } catch {}
        try { socket.destroy(); } catch {}
      };
      const fail = (detail) => {
        clearTimeout(timer);
        cleanup();
        done({ ok: false, statusCode: 101, detail });
      };

      const timer = setTimeout(() => {
        fail(`remote.mux data plane verification timed out after ${timeoutMs}ms`);
      }, timeoutMs);

      let sawPong = false;
      let sawDownlink = null;
      let opened = false;

      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const frame = parseFrameHeader(buf);
          if (!frame) break;
          buf = buf.slice(frame.totalLength);

          if (frame.opcode === CLOSE) {
            const closeCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
            return fail(`remote.mux server closed the connection before verification completed (close code ${closeCode})`);
          }

          if (frame.opcode === PONG) {
            if (frame.payload.toString("utf8") !== PING_PAYLOAD) {
              return fail(`remote.mux Pong payload mismatch (expected '${PING_PAYLOAD}', got '${frame.payload.toString("utf8")}')`);
            }
            sawPong = true;
            if (!opened) {
              opened = true;
              socket.write(
                encodeClientControlFrame(
                  TEXT,
                  Buffer.from(JSON.stringify({ type: "open", streamId, endpoint: "$events", payload: { args: {} } })),
                ),
              );
            }
          } else if (frame.opcode === TEXT) {
            if (!sawPong || !opened) {
              // Downlink activity before the physical check completed: record it.
              sawDownlink = `downlink text frame (${frame.payload.length} bytes)`;
              continue;
            }
            let message = null;
            try {
              message = JSON.parse(frame.payload.toString("utf8"));
            } catch {
              continue; // Keep waiting for a decodable mux message.
            }
            if (message?.type === "item" && message.streamId === streamId) {
              const value = message.value;
              if (value?.type !== "ready") continue; // Not-yet-ready items keep the stream open.
              clearTimeout(timer);
              socket.removeListener("data", onData);
              cleanClose();
              const physical = sawDownlink ? `${sawDownlink} + matching Pong` : "matching Pong";
              return done({
                ok: true,
                statusCode: 101,
                detail:
                  `remote.mux 101 upgrade on ${targetPath} verified: valid accept, ${physical}, ` +
                  `$events open -> item ready (clientId ${value.clientId ? "bound" : "missing"})`,
              });
            }
          } else {
            return fail(`Unexpected WebSocket frame opcode: 0x${frame.opcode.toString(16)}`);
          }
        }
      };

      socket.on("data", onData);
      socket.on("error", (err) => fail(`socket error after upgrade: ${err.message}`));
      socket.on("end", () => fail("socket closed prematurely by server before transport verification"));

      socket.write(encodeClientControlFrame(0x09, Buffer.from(PING_PAYLOAD)));
      if (buf.length > 0) onData(Buffer.alloc(0));
    });

    req.on("error", (err) => done({ ok: false, detail: `request error: ${err.message}` }));
    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, detail: `timed out after ${timeoutMs}ms` });
    });

    req.end();
  });
}

async function runSmoke() {
  const probe = generation === "connection-browser-auth-v1" ? probeMux : probePath;
  const attempts = [];
  for (const path of candidatePaths) {
    const res = await probe(path);
    if (res.ok) {
      console.log(`webSocketTransport: pass (${res.detail})`);
      process.exit(0);
    }
    attempts.push(`${path} -> ${res.detail}`);
    // If not 404 (e.g. auth failed 401 or invalid accept on a real endpoint), don't blindly fall through
    if (res.statusCode && res.statusCode !== 404 && res.statusCode !== 426) {
      console.error(`webSocketTransport: fail (${res.detail})`);
      process.exit(1);
    }
  }

  console.error(`webSocketTransport: fail (${attempts.join("; ")})`);
  process.exit(1);
}

runSmoke().catch((err) => {
  console.error(`webSocketTransport error: ${err.message}`);
  process.exit(1);
});
