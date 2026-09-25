import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { createFrameParser, encodeFrame, computeSecWebSocketAccept, randomSecWebSocketKey } from "../src/registry/reverse-ws.mjs";
import { generateNodeKeyPair, randomHex, sha256Hex } from "../src/registry/crypto.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";
import { RouteNonceCache } from "../src/registry/route-auth.mjs";
import { createTestRegistry, createTestServer } from "./helpers/registry-fixture.mjs";
import { ReverseClient } from "../src/node/reverse-client.mjs";
import { ReverseChannelPool } from "../src/node/reverse-channels.mjs";
import { RouteIngress } from "../src/node/route-ingress.mjs";

const ROUTE_DOMAIN = "v06-concurrent.example";

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
      if (pathname === "/http") {
        res.writeHead(200, {
          "content-type": "text/plain",
          "x-node-fixture": label,
        });
        res.end(`${label}-http-ok`);
        return;
      }

      if (pathname === "/http-delay") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain", "x-node-fixture": label });
          res.end(`${label}-delayed-ok`);
        }, 600).unref?.();
        return;
      }

      if (pathname === "/echo-hash") {
        const digest = sha256Hex(fullBody);
        res.writeHead(200, {
          "content-type": "application/json",
          "x-node-fixture": label,
        });
        res.end(JSON.stringify({ fixture: label, bytes: fullBody.length, sha256: digest }));
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
    const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), timeoutMs);
    const parser = createFrameParser({
      isClient: true,
      maxMessageBytes: 2 * 1024 * 1024,
      onMessage: (message) => { clearTimeout(timer); resolve(message); },
      onPong: (payload) => { clearTimeout(timer); resolve({ pong: payload }); },
      onClose: () => { clearTimeout(timer); resolve({ close: true }); },
      onError: (err) => { clearTimeout(timer); reject(err); },
    });
    socket.on("data", parser);
  });
}

async function setupDualTopology({ channelWaitMs = 1500, idleTarget = 4, maxChannels = 16 } = {}) {
  const registry = createTestRegistry({ routeDomain: ROUTE_DOMAIN });
  const hub = await createTestServer(registry, {
    reverseChannels: {
      capacityWaitMs: channelWaitMs,
      idleTarget,
      maxChannels,
    },
  });

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

test("Stage 3: Concurrent HTTP requests across direct Node A and reverse Node B route without crosstalk", async () => {
  const env = await setupDualTopology();
  try {
    const totalRequests = 10;
    const reqsA = Array.from({ length: totalRequests }, (_, i) =>
      requestHttp({
        port: env.hubPort,
        host: env.authA,
        path: `/http?seq=${i}`,
      })
    );
    const reqsB = Array.from({ length: totalRequests }, (_, i) =>
      requestHttp({
        port: env.hubPort,
        host: env.authB,
        path: `/http?seq=${i}`,
      })
    );

    const [resultsA, resultsB] = await Promise.all([
      Promise.all(reqsA),
      Promise.all(reqsB),
    ]);

    // Verify all Node A responses
    for (const res of resultsA) {
      assert.equal(res.status, 200);
      assert.equal(res.headers["x-node-fixture"], "direct-a");
      assert.equal(res.body.toString(), "direct-a-http-ok");
    }

    // Verify all Node B responses
    for (const res of resultsB) {
      assert.equal(res.status, 200);
      assert.equal(res.headers["x-node-fixture"], "reverse-b");
      assert.equal(res.body.toString(), "reverse-b-http-ok");
    }

    // Verify flow counts returned to 0
    assert.equal(env.hub.flowTracker.getActiveFlowCount(env.nodeIdA), 0);
    assert.equal(env.hub.flowTracker.getActiveFlowCount(env.nodeIdB), 0);
    assert.equal(env.hub.flowTracker.getTotalActiveFlowCount(), 0);
  } finally {
    await env.close();
  }
});

test("Stage 3: Concurrent WebSocket upgrades and bidirectional streaming across nodes maintain frame isolation", async () => {
  const env = await setupDualTopology();
  try {
    const [wsA, wsB] = await Promise.all([
      openWebSocket({ port: env.hubPort, host: env.authA, path: "/ws" }),
      openWebSocket({ port: env.hubPort, host: env.authB, path: "/ws" }),
    ]);

    assert.equal(wsA.kind, "upgrade");
    assert.equal(wsA.response.statusCode, 101);

    assert.equal(wsB.kind, "upgrade");
    assert.equal(wsB.response.statusCode, 101);

    // Verify active flow counts while WebSockets are connected
    assert.equal(env.hub.flowTracker.getActiveFlowCount(env.nodeIdA), 1);
    assert.equal(env.hub.flowTracker.getActiveFlowCount(env.nodeIdB), 1);
    assert.equal(env.hub.flowTracker.getTotalActiveFlowCount(), 2);

    // Concurrently send distinct text messages
    wsA.socket.write(encodeFrame({ opcode: 0x1, payload: Buffer.from("msg-node-a-unique-991"), mask: true }));
    wsB.socket.write(encodeFrame({ opcode: 0x1, payload: Buffer.from("msg-node-b-unique-882"), mask: true }));

    const [echoA, echoB] = await Promise.all([
      nextMessage(wsA.socket),
      nextMessage(wsB.socket),
    ]);

    assert.equal(echoA.toString(), "echo:direct-a:msg-node-a-unique-991");
    assert.equal(echoB.toString(), "echo:reverse-b:msg-node-b-unique-882");

    // Concurrently send Ping frames
    const pingA = Buffer.from("ping-direct-a");
    const pingB = Buffer.from("ping-reverse-b");
    wsA.socket.write(encodeFrame({ opcode: 0x9, payload: pingA, mask: true }));
    wsB.socket.write(encodeFrame({ opcode: 0x9, payload: pingB, mask: true }));

    const [pongA, pongB] = await Promise.all([
      nextMessage(wsA.socket),
      nextMessage(wsB.socket),
    ]);

    assert.deepEqual(pongA.pong, pingA);
    assert.deepEqual(pongB.pong, pingB);

    // Clean teardown
    wsA.socket.destroy();
    wsB.socket.destroy();
    await waitFor(() => env.hub.flowTracker.getTotalActiveFlowCount() === 0, { label: "flowTracker idle", timeoutMs: 5000 });

    assert.equal(env.hub.flowTracker.getActiveFlowCount(env.nodeIdA), 0);
    assert.equal(env.hub.flowTracker.getActiveFlowCount(env.nodeIdB), 0);
    assert.equal(env.hub.flowTracker.getTotalActiveFlowCount(), 0);
  } finally {
    await env.close();
  }
});

test("Stage 3: Reverse channel pool saturation on Node B fails closed without starving direct Node A (RFC-0013 D4)", async () => {
  // Constrain Node B pool to a small size (4 channels) and short capacityWaitMs (300ms)
  const env = await setupDualTopology({ channelWaitMs: 300, idleTarget: 4, maxChannels: 4 });
  try {
    // Hold all 4 idle reverse channels on Node B busy with delayed requests
    const busyRequests = [
      requestHttp({ port: env.hubPort, host: env.authB, path: "/http-delay" }),
      requestHttp({ port: env.hubPort, host: env.authB, path: "/http-delay" }),
      requestHttp({ port: env.hubPort, host: env.authB, path: "/http-delay" }),
      requestHttp({ port: env.hubPort, host: env.authB, path: "/http-delay" }),
    ];

    // Wait until all 4 flows are acquired and busy
    await waitFor(() => env.hub.reverseChannels.busyCount(env.nodeIdB) >= 4, { label: "Node B channels busy" });

    // Additional request to Node B should fail closed with 503 capacity-exhausted or reverse-capacity
    const saturatedB = await requestHttp({ port: env.hubPort, host: env.authB, path: "/http" });
    assert.equal(saturatedB.status, 503);
    const parsedErr = JSON.parse(saturatedB.body.toString());
    assert.ok(parsedErr?.error?.code === "reverse-capacity" || parsedErr?.error?.code === "capacity-exhausted");

    // Concurrently, Node A direct requests MUST succeed immediately with 200 OK without delay or starvation
    const startA = Date.now();
    const resA = await requestHttp({ port: env.hubPort, host: env.authA, path: "/http" });
    const elapsedA = Date.now() - startA;

    assert.equal(resA.status, 200);
    assert.equal(resA.headers["x-node-fixture"], "direct-a");
    assert.equal(resA.body.toString(), "direct-a-http-ok");
    assert.ok(elapsedA < 1500, `Node A request should not be delayed by Node B saturation (took ${elapsedA}ms)`);

    // Cleanly await completion of held flows
    await Promise.all(busyRequests);
  } finally {
    await env.close();
  }
});

test("Stage 3: Concurrent streaming data transfer preserves byte-exact data integrity", async () => {
  const env = await setupDualTopology();
  try {
    // Generate distinct 64 KiB buffers for Node A and Node B
    const payloadA = Buffer.alloc(64 * 1024, "A");
    const payloadB = Buffer.alloc(64 * 1024, "B");
    const expectedShaA = sha256Hex(payloadA);
    const expectedShaB = sha256Hex(payloadB);

    const [resA, resB] = await Promise.all([
      requestHttp({
        port: env.hubPort,
        host: env.authA,
        path: "/echo-hash",
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: payloadA,
      }),
      requestHttp({
        port: env.hubPort,
        host: env.authB,
        path: "/echo-hash",
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: payloadB,
      }),
    ]);

    assert.equal(resA.status, 200);
    const dataA = JSON.parse(resA.body.toString());
    assert.equal(dataA.fixture, "direct-a");
    assert.equal(dataA.bytes, payloadA.length);
    assert.equal(dataA.sha256, expectedShaA);

    assert.equal(resB.status, 200);
    const dataB = JSON.parse(resB.body.toString());
    assert.equal(dataB.fixture, "reverse-b");
    assert.equal(dataB.bytes, payloadB.length);
    assert.equal(dataB.sha256, expectedShaB);
  } finally {
    await env.close();
  }
});

test("Stage 3: Failure independence (RFC-0013 D5) - Node A outage has zero impact on Node B and vice versa", async () => {
  const env = await setupDualTopology();
  let newDshA = null;
  let newIngressA = null;
  try {
    // Phase 1: Simulate sudden Node A direct backend failure
    await env.dshA.close();

    // Node A request fails closed (502 or 503)
    const failedA = await requestHttp({ port: env.hubPort, host: env.authA, path: "/http" });
    assert.ok(failedA.status === 502 || failedA.status === 503, `expected 502/503 for failed Node A, got ${failedA.status}`);

    // Concurrently, Node B reverse route remains 100% healthy and responsive
    const okB = await requestHttp({ port: env.hubPort, host: env.authB, path: "/http" });
    assert.equal(okB.status, 200);
    assert.equal(okB.headers["x-node-fixture"], "reverse-b");
    assert.equal(okB.body.toString(), "reverse-b-http-ok");

    // Phase 2: Disconnect Node B's reverse client
    env.clientB.stop();
    env.poolB.clearSession();
    await sleep(60);

    // Node B requests fail closed with 503 (node unavailable or reverse capacity)
    const failedB = await requestHttp({ port: env.hubPort, host: env.authB, path: "/http" });
    assert.equal(failedB.status, 503);

    // Update Node A with fresh responsive ingress and target
    newDshA = await startMockDsh({ label: "direct-a-recovered" });
    newIngressA = new RouteIngress({
      nodeId: env.nodeIdA,
      routeDomain: ROUTE_DOMAIN,
      dshTarget: newDshA.target,
      getTrustKeys: () => env.registry.getHubRouteKeysForNode(env.nodeIdA),
    });
    await newIngressA.listen(0, "127.0.0.1");
    const directTargetA = `http://127.0.0.1:${newIngressA.port}`;
    env.registry.setRouteTarget({ actor: "operator", nodeId: env.nodeIdA, routeTarget: directTargetA });
    env.registry.db.prepare("UPDATE nodes SET reachable = 'ok' WHERE node_id = ?").run(env.nodeIdA);

    // Node A recovers independently while Node B remains offline
    const recoveredA = await requestHttp({ port: env.hubPort, host: env.authA, path: "/http" });
    assert.equal(recoveredA.status, 200);
    assert.equal(recoveredA.headers["x-node-fixture"], "direct-a-recovered");
    assert.equal(recoveredA.body.toString(), "direct-a-recovered-http-ok");
  } finally {
    if (newIngressA) await newIngressA.close();
    if (newDshA) await newDshA.close();
    await env.close();
  }
});

test("Stage 3: createHubServer handles null, undefined, config objects, and mock instances for reverseChannels safely", async () => {
  const reg1 = createTestRegistry();
  const hubNull = await createTestServer(reg1, { reverseChannels: null });
  assert.ok(hubNull.reverseChannels);
  assert.equal(typeof hubNull.reverseChannels.hasChannelForSession, "function");
  await hubNull.close();
  reg1.close();

  const reg2 = createTestRegistry();
  const hubUndef = await createTestServer(reg2, { reverseChannels: undefined });
  assert.ok(hubUndef.reverseChannels);
  assert.equal(typeof hubUndef.reverseChannels.hasChannelForSession, "function");
  await hubUndef.close();
  reg2.close();

  const reg3 = createTestRegistry();
  const hubConfig = await createTestServer(reg3, {
    reverseChannels: { idleTarget: 6, maxChannels: 12, capacityWaitMs: 500 },
  });
  assert.equal(hubConfig.reverseChannels.idleTarget, 6);
  assert.equal(hubConfig.reverseChannels.maxChannels, 12);
  assert.equal(hubConfig.reverseChannels.capacityWaitMs, 500);
  await hubConfig.close();
  reg3.close();

  const mockInstance = {
    hasChannelForSession: () => true,
    idleTarget: 8,
    maxChannels: 32,
    closeChannelsForSession: () => [],
    closeChannelsForNode: () => [],
  };
  const reg4 = createTestRegistry();
  const hubMock = await createTestServer(reg4, { reverseChannels: mockInstance });
  assert.equal(hubMock.reverseChannels, mockInstance);
  await hubMock.close();
  reg4.close();
});
