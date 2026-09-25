import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  MultiNodeFlowTracker,
  validateTargetScope,
  assertValidTargetScope,
  validateScopedAction,
  ALLOWED_SCOPED_ACTIONS,
} from "../src/registry/flow-tracker.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";
import { generateNodeKeyPair, deriveKeyId } from "../src/registry/crypto.mjs";
import { createTestRegistry, createTestServer } from "./helpers/registry-fixture.mjs";

const NODE_A = "node_0123456789abcdef0123456789abcdef";
const NODE_B = "node_fedcba9876543210fedcba9876543210";
const RAW_HEX_A = "0123456789abcdef0123456789abcdef";

test("validateTargetScope accepts valid single node IDs", () => {
  const resultA = validateTargetScope(NODE_A);
  assert.equal(resultA.valid, true);
  assert.equal(resultA.nodeId, NODE_A);

  // Raw 32-hex string is normalized with node_ prefix
  const resultRaw = validateTargetScope(RAW_HEX_A);
  assert.equal(resultRaw.valid, true);
  assert.equal(resultRaw.nodeId, NODE_A);

  assert.equal(assertValidTargetScope(NODE_A), NODE_A);
  assert.equal(assertValidTargetScope(RAW_HEX_A), NODE_A);
});

test("validateTargetScope rejects empty, null, and non-string inputs", () => {
  for (const invalid of [null, undefined, "", "   ", 123, true, {}, []]) {
    const result = validateTargetScope(invalid);
    assert.equal(result.valid, false);
    assert.equal(result.code, "invalid-target-scope");
    assert.throws(() => assertValidTargetScope(invalid), (err) => err.code === "invalid-target-scope" && err.statusCode === 400);
  }
});

test("validateTargetScope rejects wildcards, broadcasts, and multi-targets", () => {
  const wildcards = ["*", "all", "ALL", "any", "ANY", "broadcast", "cluster", `${NODE_A},${NODE_B}`, `${NODE_A} ${NODE_B}`];
  for (const wildcard of wildcards) {
    const result = validateTargetScope(wildcard);
    assert.equal(result.valid, false);
    assert.equal(result.code, "invalid-target-scope");
    assert.match(result.message, /wildcard or broadcast target scope is denied/i);
    assert.throws(() => assertValidTargetScope(wildcard), (err) => err.code === "invalid-target-scope" && err.statusCode === 400);
  }
});

test("validateTargetScope rejects malformed hex or invalid length identifiers", () => {
  const malformed = [
    "node_too_short",
    "node_0123456789abcdef0123456789abcdef00", // 34 hex
    "node_0123456789abcdef0123456789abcdeg",   // non-hex 'g'
    "notanodeid",
  ];
  for (const badId of malformed) {
    const result = validateTargetScope(badId);
    assert.equal(result.valid, false);
    assert.equal(result.code, "invalid-target-scope");
    assert.match(result.message, /valid 32-hex lowercase node ID/i);
    assert.throws(() => assertValidTargetScope(badId), (err) => err.code === "invalid-target-scope" && err.statusCode === 400);
  }
});

test("validateScopedAction accepts allowed actions on valid target nodes", () => {
  for (const action of ALLOWED_SCOPED_ACTIONS) {
    const result = validateScopedAction({ targetNodeId: NODE_A, action });
    assert.equal(result.valid, true);
    assert.equal(result.nodeId, NODE_A);
    assert.equal(result.action, action);
  }
});

test("validateScopedAction rejects invalid payloads, missing targets, or unknown actions", () => {
  // Non-object payload
  assert.equal(validateScopedAction(null).code, "bad-request");
  assert.equal(validateScopedAction("not an object").code, "bad-request");
  assert.equal(validateScopedAction([]).code, "bad-request");

  // Missing or wildcard target
  assert.equal(validateScopedAction({ action: "status" }).code, "invalid-target-scope");
  assert.equal(validateScopedAction({ targetNodeId: "*", action: "status" }).code, "invalid-target-scope");
  assert.equal(validateScopedAction({ targetNodeId: "all", action: "status" }).code, "invalid-target-scope");

  // Missing or unknown action
  assert.equal(validateScopedAction({ targetNodeId: NODE_A }).code, "invalid-action");
  assert.equal(validateScopedAction({ targetNodeId: NODE_A, action: "" }).code, "invalid-action");
  assert.equal(validateScopedAction({ targetNodeId: NODE_A, action: "restart-all" }).code, "invalid-action");
  assert.equal(validateScopedAction({ targetNodeId: NODE_A, action: "broadcast-exec" }).code, "invalid-action");
});

test("MultiNodeFlowTracker accurately tracks concurrent flows across multiple nodes", () => {
  const tracker = new MultiNodeFlowTracker();

  assert.equal(tracker.getTotalActiveFlowCount(), 0);
  assert.equal(tracker.getActiveNodeCount(), 0);
  assert.equal(tracker.getActiveFlowCount(NODE_A), 0);
  assert.equal(tracker.getActiveFlowCount(NODE_B), 0);

  // Start flows on Node A
  const endFlowA1 = tracker.trackFlow(NODE_A, "flow_a_1");
  const endFlowA2 = tracker.trackFlow(NODE_A, "flow_a_2");

  assert.equal(tracker.getActiveFlowCount(NODE_A), 2);
  assert.equal(tracker.getActiveFlowCount(NODE_B), 0);
  assert.equal(tracker.getTotalActiveFlowCount(), 2);
  assert.equal(tracker.getActiveNodeCount(), 1);
  assert.deepEqual(tracker.getActiveNodeIds(), [NODE_A]);

  // Start flow on Node B
  const endFlowB1 = tracker.trackFlow(NODE_B, "flow_b_1");

  assert.equal(tracker.getActiveFlowCount(NODE_A), 2);
  assert.equal(tracker.getActiveFlowCount(NODE_B), 1);
  assert.equal(tracker.getTotalActiveFlowCount(), 3);
  assert.equal(tracker.getActiveNodeCount(), 2);
  assert.deepEqual(tracker.getActiveNodeIds().sort(), [NODE_A, NODE_B].sort());

  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.totalFlows, 3);
  assert.equal(snapshot.distinctNodes, 2);
  assert.equal(snapshot.nodes[NODE_A], 2);
  assert.equal(snapshot.nodes[NODE_B], 1);

  // End one flow on Node A
  endFlowA1();
  assert.equal(tracker.getActiveFlowCount(NODE_A), 1);
  assert.equal(tracker.getActiveFlowCount(NODE_B), 1);
  assert.equal(tracker.getTotalActiveFlowCount(), 2);
  assert.equal(tracker.getActiveNodeCount(), 2);

  // Idempotent endFlow callback: multiple calls do not double-decrement
  endFlowA1();
  endFlowA1();
  assert.equal(tracker.getActiveFlowCount(NODE_A), 1);
  assert.equal(tracker.getTotalActiveFlowCount(), 2);

  // End second flow on Node A -> Node A drops to 0 active flows and is removed from active nodes
  endFlowA2();
  assert.equal(tracker.getActiveFlowCount(NODE_A), 0);
  assert.equal(tracker.getActiveFlowCount(NODE_B), 1);
  assert.equal(tracker.getTotalActiveFlowCount(), 1);
  assert.equal(tracker.getActiveNodeCount(), 1);
  assert.deepEqual(tracker.getActiveNodeIds(), [NODE_B]);

  // End Node B flow -> all empty
  endFlowB1();
  assert.equal(tracker.getActiveFlowCount(NODE_B), 0);
  assert.equal(tracker.getTotalActiveFlowCount(), 0);
  assert.equal(tracker.getActiveNodeCount(), 0);
  assert.deepEqual(tracker.getActiveNodeIds(), []);
});

test("MultiNodeFlowTracker enforces capacity bounds when configured", () => {
  const tracker = new MultiNodeFlowTracker({ maxFlowsPerNode: 2, maxTotalFlows: 3 });

  tracker.trackFlow(NODE_A, "a1");
  tracker.trackFlow(NODE_A, "a2");

  // Exceeds per-node capacity
  assert.throws(
    () => tracker.trackFlow(NODE_A, "a3"),
    (err) => err.code === "node-flow-capacity-exceeded" && err.statusCode === 503,
  );

  // Node B can still accept 1 flow
  const endB1 = tracker.trackFlow(NODE_B, "b1");
  assert.equal(tracker.getTotalActiveFlowCount(), 3);

  // Total capacity reached
  assert.throws(
    () => tracker.trackFlow(NODE_B, "b2"),
    (err) => err.code === "flow-capacity-exceeded" && err.statusCode === 503,
  );

  endB1();
  assert.equal(tracker.getTotalActiveFlowCount(), 2);
});

test("Hub Server integration: management read model exposes active flow counts and overview", async () => {
  const registry = createTestRegistry();
  const operatorPrincipal = { mode: "single", principal: "admin@test" };

  // Enroll Node A and Node B
  const tokenA = registry.mintEnrollmentToken({ actor: "admin@test", purpose: "enroll" });
  const enrolledA = registry.enroll({
    token: tokenA.token,
    enrollmentRequestId: "01".repeat(16),
    publicKey: "00".repeat(32),
  });
  const nodeAId = enrolledA.nodeId;

  const tokenB = registry.mintEnrollmentToken({ actor: "admin@test", purpose: "enroll" });
  const enrolledB = registry.enroll({
    token: tokenB.token,
    enrollmentRequestId: "02".repeat(16),
    publicKey: "11".repeat(32),
  });
  const nodeBId = enrolledB.nodeId;

  const testServer = await createTestServer(registry, {
    operatorPrincipal,
    lanBoundaryOnly: true,
  });

  try {
    // 1. Authenticate management session
    const sessionRes = await fetch(`${testServer.baseUrl}/hub/session`, {
      method: "POST",
      headers: { host: "127.0.0.1" },
    });
    assert.equal(sessionRes.status, 200);
    const cookie = sessionRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    const sessionData = await sessionRes.json();
    const csrfToken = sessionData.csrfToken;

    // 2. Query /hub/nodes initially: activeFlows = 0
    const initialNodesRes = await fetch(`${testServer.baseUrl}/hub/nodes`, {
      headers: { cookie, host: "127.0.0.1" },
    });
    assert.equal(initialNodesRes.status, 200);
    const initialNodesData = await initialNodesRes.json();
    assert.equal(initialNodesData.nodes.length, 2);
    assert.equal(initialNodesData.activeSessions.totalFlows, 0);
    assert.equal(initialNodesData.activeSessions.distinctNodes, 0);
    for (const node of initialNodesData.nodes) {
      assert.equal(node.activeFlows, 0);
    }

    // 3. Query /hub/overview: provides identical real-time summary
    const overviewRes = await fetch(`${testServer.baseUrl}/hub/overview`, {
      headers: { cookie, host: "127.0.0.1" },
    });
    assert.equal(overviewRes.status, 200);
    const overviewData = await overviewRes.json();
    assert.equal(overviewData.nodes.length, 2);
    assert.equal(overviewData.activeSessions.totalFlows, 0);

    // 4. Simulate active concurrent flows on Node A and Node B via flowTracker
    const tracker = testServer.flowTracker ?? registry.server?.flowTracker;
    const endA1 = tracker.trackFlow(nodeAId);
    const endA2 = tracker.trackFlow(nodeAId);
    const endB1 = tracker.trackFlow(nodeBId);

    const activeNodesRes = await fetch(`${testServer.baseUrl}/hub/nodes`, {
      headers: { cookie, host: "127.0.0.1" },
    });
    assert.equal(activeNodesRes.status, 200);
    const activeNodesData = await activeNodesRes.json();
    assert.equal(activeNodesData.activeSessions.totalFlows, 3);
    assert.equal(activeNodesData.activeSessions.distinctNodes, 2);

    const nodeASummary = activeNodesData.nodes.find((n) => n.nodeId === nodeAId);
    const nodeBSummary = activeNodesData.nodes.find((n) => n.nodeId === nodeBId);
    assert.equal(nodeASummary.activeFlows, 2);
    assert.equal(nodeBSummary.activeFlows, 1);

    // 5. Scoped node action: POST /hub/actions/node with valid target
    const actionStatusRes = await fetch(`${testServer.baseUrl}/hub/actions/node`, {
      method: "POST",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
        host: "127.0.0.1",
      },
      body: JSON.stringify({ targetNodeId: nodeAId, action: "status" }),
    });
    assert.equal(actionStatusRes.status, 200);
    const actionStatusData = await actionStatusRes.json();
    assert.equal(actionStatusData.ok, true);
    assert.equal(actionStatusData.node.nodeId, nodeAId);
    assert.equal(actionStatusData.node.activeFlows, 2);

    const actionOpenRes = await fetch(`${testServer.baseUrl}/hub/actions/node`, {
      method: "POST",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
        host: "127.0.0.1",
      },
      body: JSON.stringify({ targetNodeId: nodeBId, action: "open" }),
    });
    assert.equal(actionOpenRes.status, 200);
    const actionOpenData = await actionOpenRes.json();
    assert.equal(actionOpenData.ok, true);
    assert.equal(actionOpenData.targetNodeId, nodeBId);
    assert.match(actionOpenData.routeAuthority, new RegExp(`^n-${nodeBId.slice(5)}\\.`));

    // 6. Target scoping negatives: wildcards and missing targetNodeId are rejected with 400
    for (const badTarget of ["*", "all", "ALL", "broadcast", ""]) {
      const badTargetRes = await fetch(`${testServer.baseUrl}/hub/actions/node`, {
        method: "POST",
        headers: {
          cookie,
          "x-csrf-token": csrfToken,
          "content-type": "application/json",
          host: "127.0.0.1",
        },
        body: JSON.stringify({ targetNodeId: badTarget, action: "status" }),
      });
      assert.equal(badTargetRes.status, 400);
      const errData = await badTargetRes.json();
      assert.equal(errData.error.code, "invalid-target-scope");
    }

    // Multi-target array rejected with 400
    const arrayTargetRes = await fetch(`${testServer.baseUrl}/hub/actions/node`, {
      method: "POST",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
        host: "127.0.0.1",
      },
      body: JSON.stringify({ targetNodeId: [nodeAId, nodeBId], action: "status" }),
    });
    assert.equal(arrayTargetRes.status, 400);
    assert.equal((await arrayTargetRes.json()).error.code, "invalid-target-scope");

    // Unknown action rejected with 400
    const badActionRes = await fetch(`${testServer.baseUrl}/hub/actions/node`, {
      method: "POST",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
        host: "127.0.0.1",
      },
      body: JSON.stringify({ targetNodeId: nodeAId, action: "broadcast-reboot" }),
    });
    assert.equal(badActionRes.status, 400);
    assert.equal((await badActionRes.json()).error.code, "invalid-action");

    // Path-based node management with wildcard target e.g. /hub/nodes/all/delete fails closed with 400
    const wildcardDeleteRes = await fetch(`${testServer.baseUrl}/hub/nodes/all/delete`, {
      method: "POST",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
        host: "127.0.0.1",
      },
      body: JSON.stringify({ requestId: "00".repeat(16) }),
    });
    assert.equal(wildcardDeleteRes.status, 400);
    assert.equal((await wildcardDeleteRes.json()).error.code, "invalid-target-scope");

    // Clean up flows
    endA1();
    endA2();
    endB1();

    const finalRes = await fetch(`${testServer.baseUrl}/hub/nodes`, {
      headers: { cookie, host: "127.0.0.1" },
    });
    const finalData = await finalRes.json();
    assert.equal(finalData.activeSessions.totalFlows, 0);
    assert.equal(finalData.activeSessions.distinctNodes, 0);
  } finally {
    await testServer.close();
  }
});

function createSeededNode(registry, {
  nodeId = NODE_A,
  state = "active",
  routeTarget = "http://127.0.0.1:8080",
  reachable = "ok",
} = {}) {
  const at = new Date().toISOString();
  const db = registry.db;
  const caps = [{ name: "web.routes", version: 1 }];

  db.prepare(`
    INSERT INTO nodes (
      node_id, state, minted_at, authenticated, registry_contact, dsh_healthy,
      orbit_compatible, capabilities, capabilities_stale, last_seen, last_seen_source,
      orbit_version, dsh_version, reachable
    ) VALUES (?, ?, ?, 'ok', 'fresh', 'ok', 'pass', ?, 0, ?, 'heartbeat', '0.6.0', '1.0.0', ?)
  `).run(nodeId, state, at, JSON.stringify(caps), at, reachable);

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
  `).run(nodeId, hubKeyId, hubKey.publicKeyHex, hubKey.privateKeyHex, "active", at);

  return { nodeId, hubKeyId, hubKey };
}

test("Route proxy tracks active flows during HTTP request transit and decrements on close", async () => {
  let releaseResponse;
  const backendServer = http.createServer((req, res) => {
    new Promise((resolve) => {
      releaseResponse = resolve;
    }).then(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok from backend");
    });
  });
  await new Promise((resolve) => backendServer.listen(0, "127.0.0.1", resolve));
  const backendPort = backendServer.address().port;

  const registry = createTestRegistry();
  registry.routeDomain = "dsh.example.com";
  const { nodeId: nodeAId } = createSeededNode(registry, {
    nodeId: NODE_A,
    routeTarget: `http://127.0.0.1:${backendPort}`,
  });

  const testServer = await createTestServer(registry, {
    lanBoundaryOnly: true,
  });

  try {
    const routeAuthority = computeRouteAuthority(nodeAId, "dsh.example.com");
    assert.equal(testServer.flowTracker.getActiveFlowCount(nodeAId), 0);
    assert.equal(testServer.flowTracker.getTotalActiveFlowCount(), 0);

    const serverPort = Number(new URL(testServer.baseUrl).port);

    // Send request targeting nodeA's route authority via direct IP connect
    const reqPromise = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: serverPort,
        path: "/test-endpoint",
        headers: { host: routeAuthority },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") });
        });
      });
      req.on("error", reject);
      req.end();
    });

    // Wait for request to arrive at backend
    while (!releaseResponse) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // While in flight: active flows on Node A must be 1, total 1
    assert.equal(testServer.flowTracker.getActiveFlowCount(nodeAId), 1);
    assert.equal(testServer.flowTracker.getTotalActiveFlowCount(), 1);
    assert.equal(testServer.flowTracker.getActiveNodeCount(), 1);

    // Release response
    releaseResponse();
    const res = await reqPromise;
    assert.equal(res.status, 200);
    assert.equal(res.text, "ok from backend");

    // After response finished: active flows decremented back to 0
    assert.equal(testServer.flowTracker.getActiveFlowCount(nodeAId), 0);
    assert.equal(testServer.flowTracker.getTotalActiveFlowCount(), 0);
    assert.equal(testServer.flowTracker.getActiveNodeCount(), 0);
  } finally {
    await testServer.close();
    await new Promise((resolve) => backendServer.close(resolve));
  }
});

test("MultiNodeFlowTracker zero/negative limit does not leak phantom nodes, and rejects duplicate flow IDs", () => {
  const trackerZero = new MultiNodeFlowTracker({ maxFlowsPerNode: 0 });
  assert.throws(
    () => trackerZero.trackFlow(NODE_A),
    (err) => err.code === "node-flow-capacity-exceeded" && err.statusCode === 503,
  );
  assert.equal(trackerZero.getTotalActiveFlowCount(), 0);
  assert.equal(trackerZero.getActiveNodeCount(), 0);
  assert.deepEqual(trackerZero.getActiveNodeIds(), []);
  assert.deepEqual(trackerZero.getSnapshot().nodes, {});

  const tracker = new MultiNodeFlowTracker();
  tracker.trackFlow(NODE_A, "unique_flow_1");
  assert.throws(
    () => tracker.trackFlow(NODE_B, "unique_flow_1"),
    (err) => err.code === "duplicate-flow-id" && err.statusCode === 409,
  );
});

test("Hub server returns 503 capacity-exhausted when flowTracker limits are reached, without server crash", async () => {
  const registry = createTestRegistry();
  registry.routeDomain = "dsh.example.com";

  // Create backend server
  const backendServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("backend ok");
  });
  await new Promise((resolve) => backendServer.listen(0, "127.0.0.1", resolve));
  const backendPort = backendServer.address().port;

  const { nodeId: nodeAId } = createSeededNode(registry, {
    nodeId: NODE_A,
    routeTarget: `http://127.0.0.1:${backendPort}`,
  });

  // Inject a flow tracker with capacity 0 to trigger capacity exhaustion on first request
  const limitedTracker = new MultiNodeFlowTracker({ maxTotalFlows: 0 });

  const testServer = await createTestServer(registry, {
    flowTracker: limitedTracker,
    lanBoundaryOnly: true,
  });

  try {
    const routeAuthority = computeRouteAuthority(nodeAId, "dsh.example.com");
    const serverPort = Number(new URL(testServer.baseUrl).port);

    // 1. HTTP request returns 503 JSON without crashing
    const httpRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: serverPort,
        path: "/test-endpoint",
        headers: { host: routeAuthority },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        });
      });
      req.on("error", reject);
      req.end();
    });

    assert.equal(httpRes.status, 503);
    assert.equal(httpRes.body.error.code, "capacity-exhausted");
    assert.equal(httpRes.body.error.subcode, "flow-capacity-exceeded");

    // 2. WebSocket upgrade returns 503 without crashing
    const wsRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: serverPort,
        path: "/test-ws",
        headers: {
          host: routeAuthority,
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
        },
      });
      req.on("response", (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        });
      });
      req.on("error", reject);
      req.end();
    });

    assert.equal(wsRes.status, 503);
    assert.equal(wsRes.body.error.code, "capacity-exhausted");
    assert.equal(wsRes.body.error.subcode, "flow-capacity-exceeded");
  } finally {
    await testServer.close();
    await new Promise((resolve) => backendServer.close(resolve));
  }
});
