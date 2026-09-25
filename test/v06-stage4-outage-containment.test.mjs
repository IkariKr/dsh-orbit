import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { createFrameParser, encodeFrame, computeSecWebSocketAccept, randomSecWebSocketKey } from "../src/registry/reverse-ws.mjs";
import { generateNodeKeyPair, randomHex, sha256Hex } from "../src/registry/crypto.mjs";
import { computeRouteAuthority, ROUTE_V1_LABEL } from "../src/registry/protocol.mjs";
import { RouteNonceCache, signRouteRequest, verifyRouteRequest } from "../src/registry/route-auth.mjs";
import { createTestRegistry, createTestServer } from "./helpers/registry-fixture.mjs";
import { ReverseClient } from "../src/node/reverse-client.mjs";
import { ReverseChannelPool } from "../src/node/reverse-channels.mjs";
import { RouteIngress } from "../src/node/route-ingress.mjs";

const ROUTE_DOMAIN = "v06-security.example";

function waitFor(predicate, { timeoutMs = 10_000, stepMs = 25, label = "condition" } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = async () => {
      try {
        if (await predicate()) return resolve();
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started >= timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(check, stepMs);
    };
    check();
  });
}

function requestHttp({ port, host, path, method = "GET", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy(new Error(`timed out waiting for HTTP response: ${host}${path}`));
      reject(new Error(`timed out waiting for HTTP response: ${host}${path}`));
    }, 10_000);

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { host, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
      },
    );

    req.setTimeout(10_000, () => {
      req.destroy(new Error(`timed out waiting for HTTP response: ${host}${path}`));
    });

    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function startMockDsh({ label = "mock" } = {}) {
  const recorded = [];
  const activeSockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const fullBody = Buffer.concat(chunks);
      recorded.push({ method: req.method, url: req.url, headers: req.headers, body: fullBody });
      const pathname = (req.url ?? "").split("?")[0];

      if (pathname === "/cookie-test") {
        res.writeHead(200, {
          "content-type": "text/plain",
          "x-node-fixture": label,
          "set-cookie": [
            `session_${label}=secret_${label}; Domain=.${ROUTE_DOMAIN}; Path=/; HttpOnly; Secure`,
            `pref_${label}=dark; Domain=.${ROUTE_DOMAIN}; Path=/`,
          ],
        });
        res.end(`cookie-set-${label}`);
        return;
      }

      if (pathname === "/inspect-cookies") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-node-fixture": label,
        });
        res.end(JSON.stringify({
          fixture: label,
          cookieHeader: req.headers.cookie ?? null,
        }));
        return;
      }

      if (pathname === "/http") {
        res.writeHead(200, {
          "content-type": "text/plain",
          "x-node-fixture": label,
        });
        res.end(`${label}-http-ok`);
        return;
      }

      res.writeHead(200, { "content-type": "text/plain", "x-node-fixture": label });
      res.end(`${label}-root-ok`);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
    recorded.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.alloc(0) });

    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "upgrade: websocket",
      "connection: Upgrade",
      `sec-websocket-accept: ${computeSecWebSocketAccept(req.headers["sec-websocket-key"])}`,
      `sec-websocket-protocol: ${req.headers["sec-websocket-protocol"] ?? "orbit-test"}`,
      `x-node-fixture: ${label}`,
      "",
      "",
    ].join("\r\n"));

    const parser = createFrameParser({
      isClient: false,
      maxMessageBytes: 2 * 1024 * 1024,
      onMessage: (message) => {
        if (typeof message === "string") {
          socket.write(encodeFrame({ opcode: 0x1, payload: Buffer.from(`echo:${label}:${message}`), mask: false }));
        } else {
          socket.write(encodeFrame({ opcode: 0x2, payload: message, mask: false }));
        }
      },
      onPing: (payload) => {
        socket.write(encodeFrame({ opcode: 0xa, payload, mask: false }));
      },
      onClose: () => socket.destroy(),
      onError: () => socket.destroy(),
    });

    socket.on("data", (chunk) => parser(chunk));
    if (head?.length) parser(head);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    recorded,
    port: server.address().port,
    target: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      for (const socket of activeSockets) socket.destroy();
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

function openWebSocket({ port, host, path, headers = {} }) {
  const key = randomSecWebSocketKey();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`timed out waiting for WebSocket handshake: ${path}`));
    }, 10_000);
    timer.unref?.();

    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      headers: {
        host,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": key,
        ...headers,
      },
    });

    req.once("upgrade", (res, socket, head) => {
      clearTimeout(timer);
      resolve({ kind: "upgrade", response: res, socket, head });
    });

    req.once("response", (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ kind: "response", response: res, body: Buffer.concat(chunks) });
      });
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.end();
  });
}

function nextMessage(socket, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let parser;
    const timer = setTimeout(() => {
      socket.removeListener("data", parser);
      reject(new Error("timed out waiting for WebSocket message"));
    }, timeoutMs);
    parser = createFrameParser({
      isClient: true,
      maxMessageBytes: 2 * 1024 * 1024,
      onMessage: (message) => {
        clearTimeout(timer);
        socket.removeListener("data", parser);
        resolve(message);
      },
      onPong: (payload) => {
        clearTimeout(timer);
        socket.removeListener("data", parser);
        resolve({ pong: payload });
      },
      onClose: () => {
        clearTimeout(timer);
        socket.removeListener("data", parser);
        resolve({ close: true });
      },
      onError: (err) => {
        clearTimeout(timer);
        socket.removeListener("data", parser);
        reject(err);
      },
    });
    socket.on("data", parser);
  });
}

async function setupDualTopology() {
  const registry = createTestRegistry({ routeDomain: ROUTE_DOMAIN });
  const hub = await createTestServer(registry);

  const dshA = await startMockDsh({ label: "direct-a" });
  const dshB = await startMockDsh({ label: "reverse-b" });

  const machineKeyA = generateNodeKeyPair();
  const machineKeyB = generateNodeKeyPair();
  const tokenA = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const tokenB = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });

  const enrolledA = registry.enroll({
    token: tokenA.token,
    enrollmentRequestId: randomHex(16),
    publicKey: machineKeyA.publicKeyHex,
  });
  const enrolledB = registry.enroll({
    token: tokenB.token,
    enrollmentRequestId: randomHex(16),
    publicKey: machineKeyB.publicKeyHex,
  });

  const nodeIdA = enrolledA.nodeId;
  const nodeIdB = enrolledB.nodeId;

  const activateRouteKey = (nodeId) => {
    registry.ensureHubRouteKey(nodeId);
    registry.db.prepare("UPDATE hub_route_keys SET state = 'active', activated_at = ? WHERE node_id = ?")
      .run(new Date().toISOString(), nodeId);
  };
  activateRouteKey(nodeIdA);
  activateRouteKey(nodeIdB);

  // Configure Node A as Direct routeMode
  const ingressA = new RouteIngress({
    nodeId: nodeIdA,
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dshA.target,
    getTrustKeys: () => registry.getHubRouteKeysForNode(nodeIdA),
  });
  await ingressA.listen(0, "127.0.0.1");
  const directTargetA = `http://127.0.0.1:${ingressA.port}`;

  registry.setRouteTarget({ actor: "operator", nodeId: nodeIdA, routeTarget: directTargetA });
  registry.db.prepare("UPDATE nodes SET route_mode = 'direct', orbit_compatible = 'pass', capabilities = ?, capabilities_stale = 0, reachable = 'ok' WHERE node_id = ?")
    .run(JSON.stringify([{ name: "web.routes", version: 1 }]), nodeIdA);

  // Configure Node B as Reverse routeMode
  registry.db.prepare("UPDATE nodes SET route_mode = 'reverse', orbit_compatible = 'pass', capabilities = ?, capabilities_stale = 0, reachable = 'unreachable' WHERE node_id = ?")
    .run(JSON.stringify([{ name: "web.routes", version: 1 }]), nodeIdB);

  const nonceCacheB = new RouteNonceCache();
  const credentialsB = () => ({
    nodeId: nodeIdB,
    keyId: enrolledB.keyId,
    privateKeyHex: machineKeyB.privateKeyHex,
  });
  const poolB = new ReverseChannelPool({
    hubBaseUrl: hub.baseUrl,
    getCredentials: credentialsB,
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dshB.target,
    nonceCache: nonceCacheB,
    getTrustKeys: () => registry.getHubRouteKeysForNode(nodeIdB),
    onEvent: () => {},
  });
  const clientB = new ReverseClient({
    hubBaseUrl: hub.baseUrl,
    getCredentials: credentialsB,
    dshTarget: dshB.target,
    channelPool: poolB,
    livenessPollMs: 50,
    onEvent: () => {},
  });
  clientB.start();

  await waitFor(() => hub.reverseSessions.getSessionInfo(nodeIdB)?.routeReady === true, { label: "Node B reverse route readiness" });
  await waitFor(() => hub.reverseChannels.idleChannels(nodeIdB).length >= 1, { label: "Node B reverse idle channel" });

  const hubPort = Number(new URL(hub.baseUrl).port);
  const authA = computeRouteAuthority(nodeIdA, ROUTE_DOMAIN);
  const authB = computeRouteAuthority(nodeIdB, ROUTE_DOMAIN);

  return {
    registry,
    hub,
    hubPort,
    nodeIdA,
    nodeIdB,
    authA,
    authB,
    dshA,
    dshB,
    ingressA,
    poolB,
    clientB,
    close: async () => {
      clientB.stop();
      poolB.clearSession();
      await ingressA.close();
      await dshA.close();
      await dshB.close();
      await hub.close();
      registry.close();
    },
  };
}

test("Stage 4: Cross-node route proof replay denial (RFC-0010 / RFC-0013 D1)", async () => {
  const env = await setupDualTopology();
  try {
    const keyA = env.registry.getActiveHubRouteKey(env.nodeIdA);
    const keyB = env.registry.getActiveHubRouteKey(env.nodeIdB);

    assert.ok(keyA);
    assert.ok(keyB);

    // 1. Generate valid route proof for Node A
    const proofA = signRouteRequest({
      privateKeyHex: keyA.private_key,
      keyId: keyA.key_id,
      nodeId: env.nodeIdA,
      routeAuthority: env.authA,
      method: "GET",
      rawTarget: "/http",
      nonce: randomHex(16),
      nowMs: Date.now(),
    });

    // Case 1a: Attempt to verify Node A's proof against Node B's expected identity -> fails closed with node-mismatch
    const verifyNodeMismatch = verifyRouteRequest({
      headers: proofA.headers,
      method: "GET",
      rawTarget: "/http",
      expectedNodeId: env.nodeIdB, // Expecting Node B, but proof is signed for Node A
      expectedRouteAuthority: env.authB,
      getPublicKey: () => ({ publicKey: keyA.public_key, state: "active" }),
      nonceCache: new RouteNonceCache(),
    });
    assert.equal(verifyNodeMismatch.ok, false);
    assert.equal(verifyNodeMismatch.code, "node-mismatch");
    assert.equal(verifyNodeMismatch.status, 401);

    // Case 1b: Tamper with x-orbit-route-node to match Node B while keeping Node A signature -> fails with signature-invalid
    const tamperedHeaders = {
      ...proofA.headers,
      "x-orbit-route-node": env.nodeIdB,
    };
    const verifyTamperedSignature = verifyRouteRequest({
      headers: tamperedHeaders,
      method: "GET",
      rawTarget: "/http",
      expectedNodeId: env.nodeIdB,
      expectedRouteAuthority: env.authB,
      getPublicKey: () => ({ publicKey: keyA.public_key, state: "active" }),
      nonceCache: new RouteNonceCache(),
    });
    assert.equal(verifyTamperedSignature.ok, false);
    assert.equal(verifyTamperedSignature.code, "signature-invalid");
    assert.equal(verifyTamperedSignature.status, 401);

    // Case 1c: Sign for Node B using Node A's private key -> fails because Node B does not trust Node A's keys
    const proofCrossSigned = signRouteRequest({
      privateKeyHex: keyA.private_key, // Wrong private key
      keyId: keyA.key_id,
      nodeId: env.nodeIdB,
      routeAuthority: env.authB,
      method: "GET",
      rawTarget: "/http",
      nonce: randomHex(16),
      nowMs: Date.now(),
    });
    const verifyUntrustedKey = verifyRouteRequest({
      headers: proofCrossSigned.headers,
      method: "GET",
      rawTarget: "/http",
      expectedNodeId: env.nodeIdB,
      expectedRouteAuthority: env.authB,
      getPublicKey: (keyId) => {
        // Node B only trusts keys in its own hub_route_keys table
        const trusted = env.registry.getHubRouteKeysForNode(env.nodeIdB);
        return trusted.find((k) => k.keyId === keyId) ?? null;
      },
      nonceCache: new RouteNonceCache(),
    });
    assert.equal(verifyUntrustedKey.ok, false);
    assert.equal(verifyUntrustedKey.code, "unknown-key");
    assert.equal(verifyUntrustedKey.status, 401);

    // Case 1d: Present tampered request directly to Node A RouteIngress over HTTP
    const ingressRes = await requestHttp({
      port: env.ingressA.port,
      host: env.authA,
      path: "/http",
      headers: tamperedHeaders,
    });
    assert.equal(ingressRes.status, 401);
  } finally {
    await env.close();
  }
});

test("Stage 4: Cookie jar and origin isolation under concurrent multi-node browser access", async () => {
  const env = await setupDualTopology();
  try {
    // 1. Fetch cookie-test endpoint on Node A (direct)
    const resA = await requestHttp({
      port: env.hubPort,
      host: env.authA,
      path: "/cookie-test",
    });
    assert.equal(resA.status, 200);

    // Verify Set-Cookie headers have Domain attribute completely stripped
    const setCookiesA = Array.isArray(resA.headers["set-cookie"])
      ? resA.headers["set-cookie"]
      : [resA.headers["set-cookie"]];

    for (const sc of setCookiesA) {
      assert.equal(sc.toLowerCase().includes("domain="), false, "Set-Cookie domain attribute must be stripped");
    }

    // 2. Fetch cookie-test endpoint on Node B (reverse)
    const resB = await requestHttp({
      port: env.hubPort,
      host: env.authB,
      path: "/cookie-test",
    });
    assert.equal(resB.status, 200);

    const setCookiesB = Array.isArray(resB.headers["set-cookie"])
      ? resB.headers["set-cookie"]
      : [resB.headers["set-cookie"]];

    for (const sc of setCookiesB) {
      assert.equal(sc.toLowerCase().includes("domain="), false, "Set-Cookie domain attribute must be stripped");
    }

    // 3. Verify browser origin cookie isolation:
    // A compliant browser stores cookies per exact host authority (Host-Only).
    // Send request to Node A with Node A's cookies
    const inspectA = await requestHttp({
      port: env.hubPort,
      host: env.authA,
      path: "/inspect-cookies",
      headers: { cookie: "session_direct-a=secret_direct-a; pref_direct-a=dark" },
    });
    assert.equal(inspectA.status, 200);
    const dataA = JSON.parse(inspectA.body.toString());
    assert.equal(dataA.fixture, "direct-a");
    assert.match(dataA.cookieHeader, /session_direct-a=secret_direct-a/);
    assert.doesNotMatch(dataA.cookieHeader, /session_reverse-b/);

    // Send request to Node B with Node B's cookies
    const inspectB = await requestHttp({
      port: env.hubPort,
      host: env.authB,
      path: "/inspect-cookies",
      headers: { cookie: "session_reverse-b=secret_reverse-b; pref_reverse-b=dark" },
    });
    assert.equal(inspectB.status, 200);
    const dataB = JSON.parse(inspectB.body.toString());
    assert.equal(dataB.fixture, "reverse-b");
    assert.match(dataB.cookieHeader, /session_reverse-b=secret_reverse-b/);
    assert.doesNotMatch(dataB.cookieHeader, /session_direct-a/);
  } finally {
    await env.close();
  }
});

test("Stage 4: Node A outage and restart while Node B is actively streaming WebSocket frames", async () => {
  const env = await setupDualTopology();
  let freshIngressA = null;
  let freshDshA = null;
  try {
    // 1. Establish persistent WebSocket stream to Node B (reverse node)
    const wsB = await openWebSocket({ port: env.hubPort, host: env.authB, path: "/ws" });
    assert.equal(wsB.kind, "upgrade");
    assert.equal(wsB.response.statusCode, 101);

    // Stream initial batch of frames on Node B
    for (let i = 1; i <= 5; i++) {
      wsB.socket.write(encodeFrame({ opcode: 0x1, payload: Buffer.from(`stream-b-${i}`), mask: true }));
      const echo = await nextMessage(wsB.socket);
      assert.equal(echo.toString(), `echo:reverse-b:stream-b-${i}`);
    }

    // 2. Abruptly crash Node A's DSH backend
    await env.dshA.close();

    // Requests to Node A fail closed with 502/503
    const failedA = await requestHttp({ port: env.hubPort, host: env.authA, path: "/http" });
    assert.ok(failedA.status === 502 || failedA.status === 503);

    // 3. Concurrently, Node B's WebSocket continues streaming smoothly without dropped frames
    for (let i = 6; i <= 15; i++) {
      wsB.socket.write(encodeFrame({ opcode: 0x1, payload: Buffer.from(`stream-b-${i}`), mask: true }));
      const echo = await nextMessage(wsB.socket);
      assert.equal(echo.toString(), `echo:reverse-b:stream-b-${i}`);
    }

    // Also send Ping frames to Node B during Node A's downtime
    const pingPayload = Buffer.from("mid-outage-ping-to-b");
    wsB.socket.write(encodeFrame({ opcode: 0x9, payload: pingPayload, mask: true }));
    const pong = await nextMessage(wsB.socket);
    assert.deepEqual(pong.pong, pingPayload);

    // 4. Restart Node A with fresh responsive service
    freshDshA = await startMockDsh({ label: "direct-a-fresh" });
    freshIngressA = new RouteIngress({
      nodeId: env.nodeIdA,
      routeDomain: ROUTE_DOMAIN,
      dshTarget: freshDshA.target,
      getTrustKeys: () => env.registry.getHubRouteKeysForNode(env.nodeIdA),
    });
    await freshIngressA.listen(0, "127.0.0.1");
    const freshTargetA = `http://127.0.0.1:${freshIngressA.port}`;
    env.registry.setRouteTarget({ actor: "operator", nodeId: env.nodeIdA, routeTarget: freshTargetA });
    env.registry.db.prepare("UPDATE nodes SET reachable = 'ok' WHERE node_id = ?").run(env.nodeIdA);

    // Verify Node A is recovered
    const recoveredA = await requestHttp({ port: env.hubPort, host: env.authA, path: "/http" });
    assert.equal(recoveredA.status, 200);
    assert.equal(recoveredA.body.toString(), "direct-a-fresh-http-ok");

    // 5. Node B WebSocket completes its final stream batch
    for (let i = 16; i <= 20; i++) {
      wsB.socket.write(encodeFrame({ opcode: 0x1, payload: Buffer.from(`stream-b-${i}`), mask: true }));
      const echo = await nextMessage(wsB.socket);
      assert.equal(echo.toString(), `echo:reverse-b:stream-b-${i}`);
    }

    // Clean close
    wsB.socket.destroy();
    await waitFor(() => env.hub.flowTracker.getTotalActiveFlowCount() === 0, { label: "flowTracker idle" });
  } finally {
    if (freshIngressA) await freshIngressA.close();
    if (freshDshA) await freshDshA.close();
    await env.close();
  }
});

test("Stage 4: Node B reverse disconnect while Node A is actively serving concurrent HTTP flows", async () => {
  const env = await setupDualTopology();
  try {
    // 1. Fire continuous concurrent HTTP requests to Node A (direct node)
    const reqsA1 = Array.from({ length: 8 }, (_, i) =>
      requestHttp({ port: env.hubPort, host: env.authA, path: `/http?seq=${i}` })
    );

    // 2. Mid-transit, abruptly kill Node B's reverse client and channel pool
    env.clientB.stop();
    env.poolB.clearSession();

    // 3. Simultaneously fire more requests to Node A
    const reqsA2 = Array.from({ length: 8 }, (_, i) =>
      requestHttp({ port: env.hubPort, host: env.authA, path: `/http?seq=${i + 10}` })
    );

    const [resultsA1, resultsA2] = await Promise.all([
      Promise.all(reqsA1),
      Promise.all(reqsA2),
    ]);

    // All 16 requests to Node A must have succeeded with 200 OK
    for (const res of [...resultsA1, ...resultsA2]) {
      assert.equal(res.status, 200);
      assert.equal(res.headers["x-node-fixture"], "direct-a");
      assert.equal(res.body.toString(), "direct-a-http-ok");
    }

    // 4. Any subsequent requests to Node B fail closed with 503
    const failedB = await requestHttp({ port: env.hubPort, host: env.authB, path: "/http" });
    assert.equal(failedB.status, 503);
    const parsedErr = JSON.parse(failedB.body.toString());
    assert.equal(parsedErr.error.code, "node-unavailable");
  } finally {
    await env.close();
  }
});

test("Stage 4: Bounded memory and zero resource leaks across repeated multi-node outages", async () => {
  const env = await setupDualTopology();
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      // 1. Concurrently send requests
      const [resA, resB] = await Promise.all([
        requestHttp({ port: env.hubPort, host: env.authA, path: "/http" }),
        requestHttp({ port: env.hubPort, host: env.authB, path: "/http" }),
      ]);
      assert.equal(resA.status, 200);
      assert.equal(resB.status, 200);

      // 2. Check flow counts return to 0 after every cycle
      await waitFor(() => env.hub.flowTracker.getTotalActiveFlowCount() === 0, { label: "cycle idle" });
      assert.equal(env.hub.flowTracker.getActiveFlowCount(env.nodeIdA), 0);
      assert.equal(env.hub.flowTracker.getActiveFlowCount(env.nodeIdB), 0);
    }

    // Verify reverse channel pool remains bounded
    const nodeBChannels = env.hub.reverseChannels.channels.get(env.nodeIdB);
    assert.ok(nodeBChannels.size <= 32);
  } finally {
    await env.close();
  }
});
