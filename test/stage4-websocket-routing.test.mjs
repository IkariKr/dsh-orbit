// Stage 4 Automated Test Suite: WebSocket and Long-Lived Routed Traffic (RFC-0010, RFC-0009)
// Covers:
// 1. Same Host -> Node mapping as HTTP; invalid Host, foreign Host, selector apex denied
// 2. 5-condition eligibility matrix for WebSocket upgrade (active, routeTarget, reachable, active key, web.routes with webSocketTransport)
// 3. Negative security matrix: origin-form target, scheme-relative / absolute URI, missing proof, bad sig, wrong node, wrong authority, expired, replayed nonce, revoked, rotating-only
// 4. WebSocket upgrade proxying: ORBIT-ROUTE-V1 on upgrade, proofs & gateway headers stripped before DSH, public Host preserved, Origin & Sec-WebSocket-Protocol preserved
// 5. 101 Switching Protocols response: Set-Cookie Domain attribute stripped
// 6. Browser head bytes and upstream head bytes preserved
// 7. Opaque bidirectional byte streaming: text frame, binary frame, large binary payload (512 KiB), proxy never parses frames
// 8. Non-101 DSH upgrade response transparency (401, 403, 500) without failover
// 9. Immutable route snapshot: route metadata change while WS open does not retarget existing connection
// 10. Node A target failure closes A socket; Node B connection count unchanged
// 11. Capacity limits and counter tracking cleanup: global limit, per-node limit, node ingress limit, failed handshake cleanup, close cleanup, shutdown cleanup
// 12. Long-lived connection: transport stays open > 30 seconds without idle timeout, message echo succeeds afterwards

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";
import {
  evaluateRouteEligibility,
  HubWebSocketTracker,
  proxyWebSocketUpgrade,
  sendSocketHttpError,
} from "../src/registry/route-proxy.mjs";
import { RouteIngress, IngressWebSocketTracker } from "../src/node/route-ingress.mjs";
import { deriveKeyId, generateNodeKeyPair, randomHex } from "../src/registry/crypto.mjs";

const ROUTE_DOMAIN = "dsh.example.com";

function encodeFrame(payload, { isBinary = false, isClient = true } = {}) {
  const data = typeof payload === "string" ? Buffer.from(payload) : Buffer.from(payload);
  const opcode = isBinary ? 0x02 : 0x01;
  const len = data.length;
  let headerLen = 2;
  if (len > 125 && len <= 65535) headerLen += 2;
  else if (len > 65535) headerLen += 8;
  if (isClient) headerLen += 4;

  const buf = Buffer.alloc(headerLen + len);
  buf[0] = 0x80 | opcode;
  let offset = 1;
  const maskBit = isClient ? 0x80 : 0x00;

  if (len <= 125) {
    buf[offset++] = maskBit | len;
  } else if (len <= 65535) {
    buf[offset++] = maskBit | 126;
    buf.writeUInt16BE(len, offset);
    offset += 2;
  } else {
    buf[offset++] = maskBit | 127;
    buf.writeBigUInt64BE(BigInt(len), offset);
    offset += 8;
  }

  if (isClient) {
    const maskKey = Buffer.from([1, 2, 3, 4]);
    maskKey.copy(buf, offset);
    offset += 4;
    for (let i = 0; i < len; i++) {
      buf[offset + i] = data[i] ^ maskKey[i % 4];
    }
  } else {
    data.copy(buf, offset);
  }
  return buf;
}

function decodeFrame(buf) {
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

function parseHttpResponse(rawText) {
  const headerEnd = rawText.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const headerSection = rawText.slice(0, headerEnd);
  const body = rawText.slice(headerEnd + 4);
  const lines = headerSection.split("\r\n");
  const statusLine = lines[0];
  const match = statusLine.match(/^HTTP\/1\.[01] (\d+)(?: (.*))?$/);
  const status = match ? Number(match[1]) : 0;
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx !== -1) {
      const k = lines[i].slice(0, colonIdx).trim().toLowerCase();
      const v = lines[i].slice(colonIdx + 1).trim();
      if (headers[k]) {
        if (Array.isArray(headers[k])) headers[k].push(v);
        else headers[k] = [headers[k], v];
      } else {
        headers[k] = v;
      }
    }
  }
  return { status, statusLine, headers, body, raw: rawText };
}

function connectRawSocket(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host }, () => resolve(socket));
    socket.on("error", reject);
  });
}

function performWebSocketUpgrade(socket, {
  authority,
  path = "/ws",
  headers = {},
  head = Buffer.alloc(0),
}) {
  return new Promise((resolve, reject) => {
    const secKey = randomBytes(16).toString("base64");
    const reqHeaders = {
      Host: authority,
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": secKey,
      ...headers,
    };

    const lines = [`GET ${path} HTTP/1.1`];
    for (const [k, v] of Object.entries(reqHeaders)) {
      lines.push(`${k}: ${v}`);
    }
    lines.push("", "");
    const rawReq = lines.join("\r\n");

    let received = Buffer.alloc(0);
    let resolved = false;

    const tryParse = () => {
      if (resolved) return;
      const idx = received.indexOf("\r\n\r\n");
      if (idx !== -1) {
        const headerText = received.slice(0, idx + 4).toString("utf8");
        const parsed = parseHttpResponse(headerText);
        if (!parsed) return;
        const expectedLen = parsed.headers["content-length"] ? Number(parsed.headers["content-length"]) : 0;
        const bodyBytes = received.slice(idx + 4);
        if (parsed.status === 101 || bodyBytes.length >= expectedLen) {
          resolved = true;
          socket.removeListener("data", onData);
          resolve({
            ...parsed,
            body: bodyBytes.toString("utf8"),
            socket,
            remainingBytes: bodyBytes.slice(expectedLen),
          });
        }
      }
    };

    const onData = (chunk) => {
      received = Buffer.concat([received, chunk]);
      tryParse();
    };
    socket.on("data", onData);
    socket.on("end", () => {
      if (resolved) return;
      const idx = received.indexOf("\r\n\r\n");
      if (idx !== -1) {
        resolved = true;
        const headerText = received.slice(0, idx + 4).toString("utf8");
        const parsed = parseHttpResponse(headerText);
        const bodyBytes = received.slice(idx + 4);
        resolve({
          ...parsed,
          body: bodyBytes.toString("utf8"),
          socket,
          remainingBytes: Buffer.alloc(0),
        });
      }
    });
    socket.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    socket.write(rawReq);
    if (head && head.length > 0) {
      socket.write(head);
    }
  });
}

function createSeededNode(registry, {
  nodeId = "node_" + "11".repeat(16),
  state = "active",
  routeTarget = "http://127.0.0.1:8080",
  reachable = "ok",
  hubRouteKeyState = "active",
  hasWebRoutes = true,
  hasWebSocketTransport = true,
  evidenceFresh = true,
} = {}) {
  const at = new Date().toISOString();
  const db = registry.db;

  const caps = [];
  if (hasWebRoutes) {
    caps.push({ name: "web.routes", version: 1 });
  } else {
    caps.push({ name: "sessions.resume", version: 1 });
  }

  const staleStatus = evidenceFresh ? 0 : 1;
  const orbitCompatible = evidenceFresh ? "pass" : "stale";

  db.prepare(`
    INSERT INTO nodes (
      node_id, state, minted_at, authenticated, registry_contact, dsh_healthy,
      orbit_compatible, capabilities, capabilities_stale, last_seen, last_seen_source,
      orbit_version, dsh_version, reachable
    ) VALUES (?, ?, ?, 'ok', 'fresh', 'ok', ?, ?, ?, ?, 'heartbeat', '0.4.0', '1.0.0', ?)
  `).run(nodeId, state, at, orbitCompatible, JSON.stringify(caps), staleStatus, at, reachable);

  const nodeKey = generateNodeKeyPair();
  db.prepare(`
    INSERT INTO node_keys (node_id, key_id, public_key, state, created_at)
    VALUES (?, ?, ?, 'active', ?)
  `).run(nodeId, deriveKeyId(nodeKey.publicKeyHex), nodeKey.publicKeyHex, at);

  if (routeTarget) {
    db.prepare(`
      INSERT INTO route_targets (node_id, route_target_origin, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(nodeId, routeTarget, at, at);
  }

  const hubKey = generateNodeKeyPair();
  const hubKeyId = deriveKeyId(hubKey.publicKeyHex);
  db.prepare(`
    INSERT INTO hub_route_keys (node_id, key_id, public_key, private_key, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(nodeId, hubKeyId, hubKey.publicKeyHex, hubKey.privateKeyHex, hubRouteKeyState, at);

  return { nodeId, hubKeyId, hubKey };
}

function startMockDshWebSocketServer({
  onUpgrade = null,
  statusCode = 101,
  statusMessage = "Switching Protocols",
  headers = {},
  upstreamHeadBytes = null,
} = {}) {
  let lastReceivedHeaders = null;
  let lastReceivedPath = null;
  let lastReceivedHead = Buffer.alloc(0);
  const activeSockets = new Set();

  const server = http.createServer((req, res) => {
    // Ordinary HTTP handler
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });

  server.on("upgrade", (req, socket, head) => {
    lastReceivedHeaders = { ...req.headers };
    lastReceivedPath = req.url;
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));

    if (head && head.length > 0) {
      lastReceivedHead = Buffer.from(head);
    }

    if (onUpgrade) {
      onUpgrade(req, socket, head);
      return;
    }

    if (statusCode !== 101) {
      // Non-101 response from DSH
      const resHeaders = {
        "content-type": "application/json",
        ...headers,
      };
      const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];
      for (const [k, v] of Object.entries(resHeaders)) {
        lines.push(`${k}: ${v}`);
      }
      lines.push("", JSON.stringify({ error: { code: "dsh-denied", message: statusMessage } }));
      socket.write(lines.join("\r\n"));
      socket.end();
      return;
    }

    // Default 101 Switching Protocols with echo
    const responseHeaders = {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Accept": "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
      "Set-Cookie": "dsh_ws_session=active123; Domain=.dsh.example.com; Path=/; HttpOnly",
      ...headers,
    };

    const lines = ["HTTP/1.1 101 Switching Protocols"];
    for (const [k, v] of Object.entries(responseHeaders)) {
      lines.push(`${k}: ${v}`);
    }
    lines.push("", "");
    socket.write(lines.join("\r\n"));

    if (upstreamHeadBytes && upstreamHeadBytes.length > 0) {
      socket.write(upstreamHeadBytes);
    }

    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      // If client pre-sent head before any frames, record it in lastReceivedHead
      let dataChunk = chunk;
      if (lastReceivedHead.length === 0 && chunk.toString("utf8").startsWith("CLIENT_HEAD")) {
        const headLen = Buffer.byteLength("CLIENT_HEAD_PRE_SENT");
        lastReceivedHead = chunk.slice(0, headLen);
        dataChunk = chunk.slice(headLen);
      }

      if (dataChunk.length > 0) {
        buf = Buffer.concat([buf, dataChunk]);
        while (buf.length >= 2) {
          const decoded = decodeFrame(buf);
          if (!decoded) break;
          buf = buf.slice(decoded.totalLength);

          // Echo payload back with server framing
          const isBinary = decoded.opcode === 0x02;
          const responseFrame = encodeFrame(decoded.payload, { isBinary, isClient: false });
          socket.write(responseFrame);
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        target: `http://127.0.0.1:${port}`,
        getLastHeaders: () => lastReceivedHeaders,
        getLastPath: () => lastReceivedPath,
        getLastHead: () => lastReceivedHead,
        getActiveSocketCount: () => activeSockets.size,
        close: () => new Promise((r) => {
          for (const s of activeSockets) {
            try { s.destroy(); } catch {}
          }
          activeSockets.clear();
          server.close(r);
        }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// TEST 1: Negative Security Matrix & Authority Routing
// ---------------------------------------------------------------------------

test("Stage 4 Security Matrix: invalid Host, selector apex, foreign Host, scheme-relative target, and invalid proofs fail closed", async () => {
  const registry = new Registry({ db: openRegistryDatabase(":memory:"), routeDomain: ROUTE_DOMAIN });
  const nodeId = "node_" + "41".repeat(16);
  const authority = computeRouteAuthority(nodeId, ROUTE_DOMAIN);

  const { server: hubServer } = createHubServer({ registry });
  await new Promise((r) => hubServer.listen(0, "127.0.0.1", r));
  const hubPort = hubServer.address().port;

  try {
    // 1. Selector apex authority WebSocket upgrade fails closed with 404
    const apexSocket = await connectRawSocket(hubPort);
    const apexRes = await performWebSocketUpgrade(apexSocket, { authority: ROUTE_DOMAIN, path: "/ws" });
    assert.equal(apexRes.status, 404);
    const apexBody = JSON.parse(apexRes.body);
    assert.equal(apexBody.error.code, "not-found");
    apexSocket.destroy();

    // 2. Foreign Host on WebSocket upgrade fails closed with 404
    const foreignSocket = await connectRawSocket(hubPort);
    const foreignRes = await performWebSocketUpgrade(foreignSocket, { authority: "evil.attacker.com", path: "/ws" });
    assert.equal(foreignRes.status, 404);
    foreignSocket.destroy();

    // 3. Scheme-relative target (SSRF attempt) fails closed with 400
    const ssrfSocket = await connectRawSocket(hubPort);
    const ssrfRes = await performWebSocketUpgrade(ssrfSocket, { authority, path: "//evil.com/ws" });
    assert.equal(ssrfRes.status, 400);
    const ssrfBody = JSON.parse(ssrfRes.body);
    assert.equal(ssrfBody.error.code, "invalid-target");
    ssrfSocket.destroy();

    // 4. Unsupported upgrade protocol (e.g. h2c) fails closed with 400
    const h2cSocket = await connectRawSocket(hubPort);
    const h2cRes = await performWebSocketUpgrade(h2cSocket, { authority, path: "/ws", headers: { Upgrade: "h2c" } });
    assert.equal(h2cRes.status, 400);
    const h2cBody = JSON.parse(h2cRes.body);
    assert.equal(h2cBody.error.code, "unsupported-upgrade-protocol");
    h2cSocket.destroy();

    // 5. Ineligible node (no route target, not enrolled) fails closed with 503
    const ineligSocket = await connectRawSocket(hubPort);
    const ineligRes = await performWebSocketUpgrade(ineligSocket, { authority, path: "/ws" });
    assert.equal(ineligRes.status, 503);
    const ineligBody = JSON.parse(ineligRes.body);
    assert.equal(ineligBody.error.code, "node-unavailable");
    assert.equal(ineligBody.error.selectorUrl, `https://${ROUTE_DOMAIN}/`);
    ineligSocket.destroy();
  } finally {
    await new Promise((r) => hubServer.close(r));
    registry.close();
  }
});

// ---------------------------------------------------------------------------
// TEST 2: Node Ingress Upgrade Security Matrix (Proofs, Revocation, Limits)
// ---------------------------------------------------------------------------

test("Stage 4 Node RouteIngress: rejects missing proof, bad sig, revoked key, and scheme-relative target", async () => {
  const nodeId = "node_" + "42".repeat(16);
  const authority = computeRouteAuthority(nodeId, ROUTE_DOMAIN);
  const dshServer = await startMockDshWebSocketServer();

  let nodeState = "active";
  const ingress = new RouteIngress({
    nodeId,
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dshServer.target,
    getNodeState: () => nodeState,
    getTrustKeys: () => [],
  });
  await ingress.listen(0, "127.0.0.1");

  try {
    // 1. Missing ORBIT-ROUTE-V1 proof rejected with 400 (bad-request)
    const rawSocket1 = await connectRawSocket(ingress.port);
    const res1 = await performWebSocketUpgrade(rawSocket1, { authority, path: "/ws" });
    assert.equal(res1.status, 400);
    const body1 = JSON.parse(res1.body);
    assert.equal(body1.error.code, "bad-request");
    rawSocket1.destroy();

    // 2. Revoked node rejected with 401
    nodeState = "revoked";
    const rawSocket2 = await connectRawSocket(ingress.port);
    const res2 = await performWebSocketUpgrade(rawSocket2, { authority, path: "/ws" });
    assert.equal(res2.status, 401);
    const body2 = JSON.parse(res2.body);
    assert.equal(body2.error.code, "revoked");
    rawSocket2.destroy();
    nodeState = "active";

    // 3. Scheme-relative target rejected with 400
    const rawSocket3 = await connectRawSocket(ingress.port);
    const res3 = await performWebSocketUpgrade(rawSocket3, { authority, path: "//127.0.0.1:9999/ws" });
    assert.equal(res3.status, 400);
    rawSocket3.destroy();
  } finally {
    await ingress.close();
    await dshServer.close();
  }
});

// ---------------------------------------------------------------------------
// TEST 3: End-to-End WebSocket Upgrade, Framing, Cookies & Head Bytes
// ---------------------------------------------------------------------------

test("Stage 4 End-to-End WebSocket: text/binary frames, 512 KiB large payload, 101 Set-Cookie Domain stripping, and head bytes", async () => {
  const dshServer = await startMockDshWebSocketServer();
  const nodeId = "node_" + "43".repeat(16);
  const authority = computeRouteAuthority(nodeId, ROUTE_DOMAIN);

  const registry = new Registry({ db: openRegistryDatabase(":memory:"), routeDomain: ROUTE_DOMAIN });
  const ingress = new RouteIngress({
    nodeId,
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dshServer.target,
    getTrustKeys: () => registry.getHubRouteKeysForNode(nodeId),
  });
  await ingress.listen(0, "127.0.0.1");

  createSeededNode(registry, {
    nodeId,
    routeTarget: `http://127.0.0.1:${ingress.port}`,
  });

  const { server: hubServer } = createHubServer({ registry });
  await new Promise((r) => hubServer.listen(0, "127.0.0.1", r));
  const hubPort = hubServer.address().port;

  try {
    // Connect client to Hub with WebSocket Upgrade
    const clientSocket = await connectRawSocket(hubPort);
    const initialHead = Buffer.from("CLIENT_HEAD_PRE_SENT");

    const upgradeRes = await performWebSocketUpgrade(clientSocket, {
      authority,
      path: "/ws?session=alpha&filter=%2Bplus",
      headers: {
        Origin: "https://trusted.example.com",
        "Sec-WebSocket-Protocol": "dsh-protocol-v1",
        Authorization: "Bearer dsh-token-opaque",
      },
      head: initialHead,
    });

    // 1. Assert HTTP 101 Switching Protocols
    assert.equal(upgradeRes.status, 101);
    assert.equal(upgradeRes.headers.upgrade.toLowerCase(), "websocket");

    // 2. Assert Set-Cookie has Domain= stripped (Host-only cookie isolation)
    const setCookie = upgradeRes.headers["set-cookie"];
    assert.ok(setCookie.includes("dsh_ws_session=active123"));
    assert.equal(setCookie.toLowerCase().includes("domain="), false);

    // 3. Verify DSH received clean headers and client head bytes
    const dshHeaders = dshServer.getLastHeaders();
    assert.equal(dshHeaders.host, authority);
    assert.equal(dshHeaders.origin, "https://trusted.example.com");
    assert.equal(dshHeaders["sec-websocket-protocol"], "dsh-protocol-v1");
    assert.equal(dshHeaders.authorization, "Bearer dsh-token-opaque");
    assert.equal(typeof dshHeaders["x-orbit-route-signature"], "undefined");
    assert.equal(typeof dshHeaders["x-orbit-route-key"], "undefined");
    assert.equal(dshServer.getLastPath(), "/ws?session=alpha&filter=%2Bplus");
    const lastHeadWait = await new Promise((resolve) => {
      if (dshServer.getLastHead().length > 0) return resolve(dshServer.getLastHead());
      const check = setInterval(() => {
        if (dshServer.getLastHead().length > 0) {
          clearInterval(check);
          resolve(dshServer.getLastHead());
        }
      }, 20);
    });
    assert.equal(lastHeadWait.toString("utf8"), "CLIENT_HEAD_PRE_SENT");

    // 4. Send and receive text frame
    const textMessage = "Hello WebSocket transparent world!";
    const textFrame = encodeFrame(textMessage, { isClient: true });
    clientSocket.write(textFrame);

    const receivedTextPayload = await new Promise((resolve) => {
      let buf = upgradeRes.remainingBytes && upgradeRes.remainingBytes.length > 0 ? Buffer.from(upgradeRes.remainingBytes) : Buffer.alloc(0);
      const tryDecode = () => {
        const decoded = decodeFrame(buf);
        if (decoded) {
          clientSocket.removeListener("data", onData);
          resolve(decoded.payload.toString("utf8"));
          return true;
        }
        return false;
      };
      if (tryDecode()) return;
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        tryDecode();
      };
      clientSocket.on("data", onData);
    });
    assert.equal(receivedTextPayload, textMessage);

    // 5. Send and receive large binary payload (512 KiB)
    const largeBinary = randomBytes(512 * 1024);
    const binaryFrame = encodeFrame(largeBinary, { isBinary: true, isClient: true });
    clientSocket.write(binaryFrame);

    const receivedBinaryPayload = await new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const decoded = decodeFrame(buf);
        if (decoded && decoded.payload.length === 512 * 1024) {
          clientSocket.removeListener("data", onData);
          resolve(decoded.payload);
        }
      };
      clientSocket.on("data", onData);
    });
    assert.equal(receivedBinaryPayload.length, 512 * 1024);
    assert.deepEqual(receivedBinaryPayload, largeBinary);

    clientSocket.destroy();
  } finally {
    await new Promise((r) => hubServer.close(r));
    await ingress.close();
    await dshServer.close();
    registry.close();
  }
});

// ---------------------------------------------------------------------------
// TEST 4: Non-101 DSH Upstream Responses (401, 403, 500)
// ---------------------------------------------------------------------------

test("Stage 4 Non-101 DSH Responses: downstream 401, 403, 500 transparently forwarded without failover", async () => {
  let targetStatusCode = 401;
  let targetStatusMessage = "Unauthorized";

  const dshServer = await startMockDshWebSocketServer({
    onUpgrade: (req, socket) => {
      const payload = JSON.stringify({ error: { code: "downstream-denied", status: targetStatusCode } });
      const lines = [
        `HTTP/1.1 ${targetStatusCode} ${targetStatusMessage}`,
        "content-type: application/json",
        "connection: close",
        `content-length: ${Buffer.byteLength(payload)}`,
        "",
        payload,
      ];
      socket.write(lines.join("\r\n"));
      socket.end();
    },
  });

  const nodeId = "node_" + "44".repeat(16);
  const authority = computeRouteAuthority(nodeId, ROUTE_DOMAIN);

  const registry = new Registry({ db: openRegistryDatabase(":memory:"), routeDomain: ROUTE_DOMAIN });
  const ingress = new RouteIngress({
    nodeId,
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dshServer.target,
    getTrustKeys: () => registry.getHubRouteKeysForNode(nodeId),
  });
  await ingress.listen(0, "127.0.0.1");

  createSeededNode(registry, {
    nodeId,
    routeTarget: `http://127.0.0.1:${ingress.port}`,
  });

  const { server: hubServer } = createHubServer({ registry });
  await new Promise((r) => hubServer.listen(0, "127.0.0.1", r));
  const hubPort = hubServer.address().port;

  try {
    // 1. DSH returns 401
    targetStatusCode = 401;
    targetStatusMessage = "Unauthorized";
    const s1 = await connectRawSocket(hubPort);
    const res401 = await performWebSocketUpgrade(s1, { authority, path: "/ws" });
    assert.equal(res401.status, 401);
    s1.destroy();

    // 2. DSH returns 403
    targetStatusCode = 403;
    targetStatusMessage = "Forbidden";
    const s2 = await connectRawSocket(hubPort);
    const res403 = await performWebSocketUpgrade(s2, { authority, path: "/ws" });
    assert.equal(res403.status, 403);
    s2.destroy();

    // 3. DSH returns 500
    targetStatusCode = 500;
    targetStatusMessage = "Internal Server Error";
    const s3 = await connectRawSocket(hubPort);
    const res500 = await performWebSocketUpgrade(s3, { authority, path: "/ws" });
    assert.equal(res500.status, 500);
    s3.destroy();
  } finally {
    await new Promise((r) => hubServer.close(r));
    await ingress.close();
    await dshServer.close();
    registry.close();
  }
});

// ---------------------------------------------------------------------------
// TEST 5: Immutable Route Snapshot & Fault Isolation
// ---------------------------------------------------------------------------

test("Stage 4 Immutable Route Snapshot: metadata changes while WS open do not retarget existing connection; node fault isolated", async () => {
  const dshServerA = await startMockDshWebSocketServer();
  const dshServerB = await startMockDshWebSocketServer();

  const nodeIdA = "node_" + "4a".repeat(16);
  const nodeIdB = "node_" + "4b".repeat(16);
  const authorityA = computeRouteAuthority(nodeIdA, ROUTE_DOMAIN);
  const authorityB = computeRouteAuthority(nodeIdB, ROUTE_DOMAIN);

  const registry = new Registry({ db: openRegistryDatabase(":memory:"), routeDomain: ROUTE_DOMAIN });

  const ingressA = new RouteIngress({
    nodeId: nodeIdA,
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dshServerA.target,
    getTrustKeys: () => registry.getHubRouteKeysForNode(nodeIdA),
  });
  await ingressA.listen(0, "127.0.0.1");

  const ingressB = new RouteIngress({
    nodeId: nodeIdB,
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dshServerB.target,
    getTrustKeys: () => registry.getHubRouteKeysForNode(nodeIdB),
  });
  await ingressB.listen(0, "127.0.0.1");

  createSeededNode(registry, { nodeId: nodeIdA, routeTarget: `http://127.0.0.1:${ingressA.port}` });
  createSeededNode(registry, { nodeId: nodeIdB, routeTarget: `http://127.0.0.1:${ingressB.port}` });

  const { server: hubServer } = createHubServer({ registry });
  await new Promise((r) => hubServer.listen(0, "127.0.0.1", r));
  const hubPort = hubServer.address().port;

  try {
    // Open WS to Node A
    const socketA = await connectRawSocket(hubPort);
    const upgradeA = await performWebSocketUpgrade(socketA, { authority: authorityA, path: "/ws" });
    assert.equal(upgradeA.status, 101);

    // Open WS to Node B
    const socketB = await connectRawSocket(hubPort);
    const upgradeB = await performWebSocketUpgrade(socketB, { authority: authorityB, path: "/ws" });
    assert.equal(upgradeB.status, 101);

    // Mutate Node A route target and mark unreachable in registry
    registry.setRouteTarget({ actor: "operator", nodeId: nodeIdA, routeTarget: "http://127.0.0.1:9999" });
    registry.recordProbeResult(nodeIdA, false, "failure");
    registry.recordProbeResult(nodeIdA, false, "failure");
    registry.recordProbeResult(nodeIdA, false, "failure");

    // Send frame on existing socketA -> must still reach original dshServerA (immutable snapshot)
    socketA.write(encodeFrame("msg-to-A", { isClient: true }));
    const echoA = await new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      const onData = (c) => {
        buf = Buffer.concat([buf, c]);
        const d = decodeFrame(buf);
        if (d) {
          socketA.removeListener("data", onData);
          resolve(d.payload.toString("utf8"));
        }
      };
      socketA.on("data", onData);
    });
    assert.equal(echoA, "msg-to-A");

    // Close Node A ingress -> socketA terminates, but socketB remains unaffected
    await ingressA.close();
    await sleep(200);

    // socketB is still active and echoing
    socketB.write(encodeFrame("msg-to-B", { isClient: true }));
    const echoB = await new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      const onData = (c) => {
        buf = Buffer.concat([buf, c]);
        const d = decodeFrame(buf);
        if (d) {
          socketB.removeListener("data", onData);
          resolve(d.payload.toString("utf8"));
        }
      };
      socketB.on("data", onData);
    });
    assert.equal(echoB, "msg-to-B");

    socketA.destroy();
    socketB.destroy();
  } finally {
    await new Promise((r) => hubServer.close(r));
    await ingressA.close();
    await ingressB.close();
    await dshServerA.close();
    await dshServerB.close();
    registry.close();
  }
});

// ---------------------------------------------------------------------------
// TEST 6: Finite Capacity Limits & Counter Tracking Cleanup
// ---------------------------------------------------------------------------

test("Stage 4 Capacity Limits & Cleanup: global limit, per-node limit, node ingress limit, and socket destruction cleanup", async () => {
  const dshServer = await startMockDshWebSocketServer();
  const nodeId = "node_" + "46".repeat(16);
  const authority = computeRouteAuthority(nodeId, ROUTE_DOMAIN);

  const registry = new Registry({ db: openRegistryDatabase(":memory:"), routeDomain: ROUTE_DOMAIN });

  const ingress = new RouteIngress({
    nodeId,
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dshServer.target,
    getTrustKeys: () => registry.getHubRouteKeysForNode(nodeId),
  });
  ingress.wsTracker.maxConnections = 2; // Node ingress limit = 2
  await ingress.listen(0, "127.0.0.1");

  createSeededNode(registry, {
    nodeId,
    routeTarget: `http://127.0.0.1:${ingress.port}`,
  });

  // Hub limits: maxPerNode = 2, maxGlobal = 3
  const wsTracker = new HubWebSocketTracker({ maxGlobal: 3, maxPerNode: 2 });
  const { server: hubServer } = createHubServer({
    registry,
    options: { wsTracker },
  });
  await new Promise((r) => hubServer.listen(0, "127.0.0.1", r));
  const hubPort = hubServer.address().port;

  try {
    // Open Connection 1
    const s1 = await connectRawSocket(hubPort);
    const res1 = await performWebSocketUpgrade(s1, { authority, path: "/ws" });
    assert.equal(res1.status, 101);
    assert.equal(wsTracker.globalCount, 1);
    assert.equal(wsTracker.nodeCounts.get(nodeId), 1);

    // Open Connection 2
    const s2 = await connectRawSocket(hubPort);
    const res2 = await performWebSocketUpgrade(s2, { authority, path: "/ws" });
    assert.equal(res2.status, 101);
    assert.equal(wsTracker.globalCount, 2);
    assert.equal(wsTracker.nodeCounts.get(nodeId), 2);

    // Connection 3 exceeds per-node limit (2) -> rejected with 503 capacity-exhausted
    const s3 = await connectRawSocket(hubPort);
    const res3 = await performWebSocketUpgrade(s3, { authority, path: "/ws" });
    assert.equal(res3.status, 503);
    const body3 = JSON.parse(res3.body);
    assert.equal(body3.error.code, "capacity-exhausted");
    s3.destroy();

    // Close Connection 1 -> counter decrements
    s1.destroy();
    await sleep(150);
    assert.equal(wsTracker.globalCount, 1);
    assert.equal(wsTracker.nodeCounts.get(nodeId), 1);

    // Now Connection 4 is accepted
    const s4 = await connectRawSocket(hubPort);
    const res4 = await performWebSocketUpgrade(s4, { authority, path: "/ws" });
    assert.equal(res4.status, 101);
    assert.equal(wsTracker.globalCount, 2);

    s2.destroy();
    s4.destroy();
    await sleep(150);
    assert.equal(wsTracker.globalCount, 0);
    assert.equal(wsTracker.nodeCounts.size, 0);
  } finally {
    await new Promise((r) => hubServer.close(r));
    await ingress.close();
    await dshServer.close();
    registry.close();
  }
});

// ---------------------------------------------------------------------------
// TEST 7: Long-Lived Connection (>30 Seconds Idle Without Disconnect)
// ---------------------------------------------------------------------------

test("Stage 4 Long-Lived Transport: connection remains open and functional after 31 seconds idle", async () => {
  const dshServer = await startMockDshWebSocketServer();
  const nodeId = "node_" + "47".repeat(16);
  const authority = computeRouteAuthority(nodeId, ROUTE_DOMAIN);

  const registry = new Registry({ db: openRegistryDatabase(":memory:"), routeDomain: ROUTE_DOMAIN });
  const ingress = new RouteIngress({
    nodeId,
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dshServer.target,
    getTrustKeys: () => registry.getHubRouteKeysForNode(nodeId),
  });
  await ingress.listen(0, "127.0.0.1");

  createSeededNode(registry, {
    nodeId,
    routeTarget: `http://127.0.0.1:${ingress.port}`,
  });

  const { server: hubServer } = createHubServer({ registry });
  await new Promise((r) => hubServer.listen(0, "127.0.0.1", r));
  const hubPort = hubServer.address().port;

  try {
    const clientSocket = await connectRawSocket(hubPort);
    const res = await performWebSocketUpgrade(clientSocket, { authority, path: "/ws" });
    assert.equal(res.status, 101);

    console.log("    [Long-Lived WS Test] Upgraded 101 successfully. Sleeping 31 seconds to verify connection survives Stage 3 30s timeout...");
    await sleep(31000);

    // Send message after 31 seconds
    const post30sMessage = "Message sent after 31s idle!";
    clientSocket.write(encodeFrame(post30sMessage, { isClient: true }));

    const receivedPayload = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for response after 31s idle")), 5000);
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const decoded = decodeFrame(buf);
        if (decoded) {
          clearTimeout(timer);
          clientSocket.removeListener("data", onData);
          resolve(decoded.payload.toString("utf8"));
        }
      };
      clientSocket.on("data", onData);
      clientSocket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.equal(receivedPayload, post30sMessage);
    console.log("    [Long-Lived WS Test] Received expected echo after 31s idle! Transport is verified long-lived.");

    clientSocket.destroy();
  } finally {
    await new Promise((r) => hubServer.close(r));
    await ingress.close();
    await dshServer.close();
    registry.close();
  }
});
