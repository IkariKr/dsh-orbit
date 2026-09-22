import assert from "node:assert/strict";
import test from "node:test";
import { deriveKeyId, generateNodeKeyPair, randomHex } from "../src/registry/crypto.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";
import { RouteNonceCache, signRouteRequest, verifyRouteRequest } from "../src/registry/route-auth.mjs";
import { createTestRegistry, createTestServer, defaultRuntimeIdentity, deleteNode, enrollNode, signedMachineRequest, signedReenrollRequest } from "./helpers/registry-fixture.mjs";

async function withTombstonedNode(t, { provisionHubRouteKey = false } = {}) {
  const registry = createTestRegistry();
  const server = await createTestServer(registry, {});
  t.after(async () => {
    await server.close();
    registry.close();
  });
  const node = await enrollNode(server.baseUrl, registry);
  const hubRouteKey = provisionHubRouteKey ? registry.ensureHubRouteKey(node.nodeId) : null;
  deleteNode(registry, node.nodeId);
  return { registry, server, node, hubRouteKey };
}

test("kept node identity: reenroll restores the nodeId with a new key and keeps the historical key revoked", async (t) => {
  const { registry, server, node } = await withTombstonedNode(t);
  const newKeys = generateNodeKeyPair();
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: node.nodeId });
  const { status, body } = await signedReenrollRequest(server.baseUrl, {
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { reenrollmentToken: minted.token, reenrollmentRequestId: randomHex(16), newPublicKey: newKeys.publicKeyHex },
  });
  assert.equal(status, 200);
  assert.equal(body.nodeId, node.nodeId);
  assert.equal(body.keyId, deriveKeyId(newKeys.publicKeyHex));
  assert.deepEqual(Object.keys(body).sort(), ["keyId", "nodeId", "registryContact", "tokenId"]);
  assert.equal(Object.hasOwn(body, "hubRouteKeys"), false);

  const summary = registry.getNode(node.nodeId);
  assert.equal(summary.state, "active");
  assert.equal(summary.health.authenticated, "ok");
  assert.equal(summary.health.reachable, "unknown");
  assert.equal(summary.health.capabilitiesStale, true);
  const keyRows = registry.db.prepare("SELECT key_id, state, revocation_reason FROM node_keys WHERE node_id = ? ORDER BY created_at").all(node.nodeId);
  assert.equal(keyRows[0].state, "revoked");
  assert.equal(keyRows[0].revocation_reason, "reenroll-possession");
  assert.equal(keyRows[1].state, "active");
  const auditActions = registry.db.prepare("SELECT action FROM audit WHERE actor = ? ORDER BY at").all(`system:${node.nodeId}`).map((row) => row.action);
  assert.deepEqual(auditActions, ["node.enrolled", "hub.route-keys.provision", "node.reenrolled"]);

  // The restored node authenticates with its new key and the
  // ORBIT-MACHINE-V1 routes work again.
  const beat = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: body.keyId,
    keyHex: newKeys.privateKeyHex,
    body: defaultRuntimeIdentity(),
  });
  assert.equal(beat.status, 200);
});

test("reenroll provisions a fresh Hub route identity, delivers it on heartbeat, and retains route mode", async (t) => {
  const { registry, server, node, hubRouteKey: oldHubKey } = await withTombstonedNode(t, { provisionHubRouteKey: true });
  registry.db.prepare("UPDATE nodes SET route_mode = 'reverse' WHERE node_id = ?").run(node.nodeId);
  const oldHubKeyId = oldHubKey.key_id;
  const oldHubKeyPrivate = oldHubKey.private_key;
  const oldHubKeyPublic = oldHubKey.public_key;
  const reenrollKeys = generateNodeKeyPair();
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: node.nodeId });
  const requestId = randomHex(16);
  const first = await signedReenrollRequest(server.baseUrl, {
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { reenrollmentToken: minted.token, reenrollmentRequestId: requestId, newPublicKey: reenrollKeys.publicKeyHex },
  });
  assert.equal(first.status, 200);
  assert.equal(registry.getNode(node.nodeId).routeMode, "reverse");

  const routeRows = registry.db.prepare("SELECT key_id, public_key, private_key, state, revocation_reason FROM hub_route_keys WHERE node_id = ? ORDER BY created_at").all(node.nodeId);
  assert.equal(routeRows.length, 2);
  assert.equal(routeRows[0].key_id, oldHubKeyId);
  assert.equal(routeRows[0].public_key, oldHubKeyPublic);
  assert.equal(routeRows[0].private_key, oldHubKeyPrivate);
  assert.equal(routeRows[0].state, "revoked");
  assert.equal(routeRows[0].revocation_reason, "node-delete");
  assert.notEqual(routeRows[1].key_id, oldHubKeyId);
  assert.equal(routeRows[1].state, "provisioned");

  const routeAuthority = computeRouteAuthority(node.nodeId, registry.routeDomain);
  const oldProof = signRouteRequest({
    privateKeyHex: oldHubKeyPrivate,
    keyId: oldHubKeyId,
    nodeId: node.nodeId,
    routeAuthority,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    nonce: randomHex(16),
  });
  const oldCheck = verifyRouteRequest({
    headers: oldProof.headers,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: node.nodeId,
    expectedRouteAuthority: routeAuthority,
    getPublicKey: (keyId) => registry.getHubRouteKeysForNode(node.nodeId).find((key) => key.keyId === keyId) ?? null,
    nonceCache: new RouteNonceCache(),
  });
  assert.equal(oldCheck.ok, false);
  assert.equal(oldCheck.code, "unknown-key");

  const heartbeat = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: first.body.keyId,
    keyHex: reenrollKeys.privateKeyHex,
    body: { ...defaultRuntimeIdentity(), acceptedHubRouteKeyIds: [] },
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.routeMode, "reverse");
  assert.equal(heartbeat.body.hubRouteKeys.length, 1);
  assert.equal(heartbeat.body.hubRouteKeys[0].keyId, routeRows[1].key_id);
  assert.equal(heartbeat.body.hubRouteKeys[0].publicKey, routeRows[1].public_key);
  assert.equal(Object.hasOwn(heartbeat.body.hubRouteKeys[0], "privateKey"), false);

  const acknowledgement = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: first.body.keyId,
    keyHex: reenrollKeys.privateKeyHex,
    body: { ...defaultRuntimeIdentity(), acceptedHubRouteKeyIds: [routeRows[1].key_id] },
  });
  assert.equal(acknowledgement.status, 200);
  assert.equal(acknowledgement.body.routeMode, "reverse");
  assert.equal(acknowledgement.body.hubRouteKeys[0].keyId, routeRows[1].key_id);
  assert.equal(acknowledgement.body.hubRouteKeys[0].state, "active");

  const newProof = signRouteRequest({
    privateKeyHex: routeRows[1].private_key,
    keyId: routeRows[1].key_id,
    nodeId: node.nodeId,
    routeAuthority,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    nonce: randomHex(16),
  });
  const newCheck = verifyRouteRequest({
    headers: newProof.headers,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: node.nodeId,
    expectedRouteAuthority: routeAuthority,
    getPublicKey: (keyId) => acknowledgement.body.hubRouteKeys.find((key) => key.keyId === keyId) ?? null,
    nonceCache: new RouteNonceCache(),
  });
  assert.equal(newCheck.ok, true);

  const replay = await signedReenrollRequest(server.baseUrl, {
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { reenrollmentToken: minted.token, reenrollmentRequestId: requestId, newPublicKey: reenrollKeys.publicKeyHex },
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS count FROM hub_route_keys WHERE node_id = ?").get(node.nodeId).count, 2);
});


test("the revoked historical key authorizes nothing except the reenroll possession proof", async (t) => {
  const { registry, server, node } = await withTombstonedNode(t);
  // While tombstoned, the historical key gets 'revoked' on any machine route.
  const denied = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(),
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, "revoked");

  // After reenroll the node is active again, but the historical key is
  // still revoked: heartbeat with it is denied 'key-revoked'.
  const newKeys = generateNodeKeyPair();
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: node.nodeId });
  const reenrolled = await signedReenrollRequest(server.baseUrl, {
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { reenrollmentToken: minted.token, reenrollmentRequestId: randomHex(16), newPublicKey: newKeys.publicKeyHex },
  });
  assert.equal(reenrolled.status, 200);
  const stillRevoked = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(),
  });
  assert.equal(stillRevoked.status, 401);
  assert.equal(stillRevoked.body.error.code, "key-revoked");
});

test("a failed possession proof consumes nothing: the same token still completes afterwards", async (t) => {
  const { registry, server, node } = await withTombstonedNode(t);
  const newKeys = generateNodeKeyPair();
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: node.nodeId });
  const requestId = randomHex(16);

  // Proof signed with the NEW key (or any other key) fails.
  const wrongKey = await signedReenrollRequest(server.baseUrl, {
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: newKeys.privateKeyHex,
    body: { reenrollmentToken: minted.token, reenrollmentRequestId: requestId, newPublicKey: newKeys.publicKeyHex },
  });
  assert.equal(wrongKey.status, 401);
  assert.equal(wrongKey.body.error.code, "possession-proof-failed");

  // The token was not consumed and the correct proof still succeeds.
  const correct = await signedReenrollRequest(server.baseUrl, {
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { reenrollmentToken: minted.token, reenrollmentRequestId: requestId, newPublicKey: newKeys.publicKeyHex },
  });
  assert.equal(correct.status, 200);
});

test("consumed-token replays: identical content returns the same result; different content is denied", async (t) => {
  const { registry, server, node } = await withTombstonedNode(t);
  const newKeys = generateNodeKeyPair();
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: node.nodeId });
  const requestId = randomHex(16);
  const payload = { reenrollmentToken: minted.token, reenrollmentRequestId: requestId, newPublicKey: newKeys.publicKeyHex };
  const first = await signedReenrollRequest(server.baseUrl, { nodeId: node.nodeId, keyId: node.keyId, keyHex: node.privateKeyHex, body: payload });
  assert.equal(first.status, 200);
  const replay = await signedReenrollRequest(server.baseUrl, { nodeId: node.nodeId, keyId: node.keyId, keyHex: node.privateKeyHex, body: payload });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);

  const different = await signedReenrollRequest(server.baseUrl, {
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { ...payload, newPublicKey: generateNodeKeyPair().publicKeyHex },
  });
  assert.equal(different.status, 401);
  assert.equal(different.body.error.code, "token-consumed");
});

test("purpose and binding checks: enroll-purpose token and mismatched node are denied", async (t) => {
  const { registry, server, node } = await withTombstonedNode(t);
  const newKeys = generateNodeKeyPair();
  const enrollToken = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const mismatched = await signedReenrollRequest(server.baseUrl, {
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { reenrollmentToken: enrollToken.token, reenrollmentRequestId: randomHex(16), newPublicKey: newKeys.publicKeyHex },
  });
  assert.equal(mismatched.status, 400);
  assert.equal(mismatched.body.error.code, "purpose-mismatch");

  // A token bound to a different tombstone is denied even with a valid proof.
  const other = await enrollNode(server.baseUrl, registry);
  deleteNode(registry, other.nodeId);
  const boundElsewhere = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: other.nodeId });
  const mismatch = await signedReenrollRequest(server.baseUrl, {
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { reenrollmentToken: boundElsewhere.token, reenrollmentRequestId: randomHex(16), newPublicKey: newKeys.publicKeyHex },
  });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.body.error.code, "token-node-mismatch");
});

test("reenroll targeting a node that is no longer tombstoned is denied", async (t) => {
  const { registry, server, node } = await withTombstonedNode(t);
  const newKeys = generateNodeKeyPair();
  const requestId = randomHex(16);
  // Restore the nodeId first with one token...
  const firstToken = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: node.nodeId });
  const restored = await signedReenrollRequest(server.baseUrl, {
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { reenrollmentToken: firstToken.token, reenrollmentRequestId: requestId, newPublicKey: newKeys.publicKeyHex },
  });
  assert.equal(restored.status, 200);

  // A second token cannot be minted anymore (mint-time guard), so
  // manufacture one directly: the completion-time guard must still
  // reject it because the nodeId is active, not tombstoned.
  const secondToken = randomHex(16);
  registry.db
    .prepare(
      "INSERT INTO enrollment_tokens (token_id, token_digest, purpose, bound_node_id, created_at, expires_at) VALUES (?, ?, 'reenroll', ?, ?, ?)",
    )
    .run(`etok_${randomHex(8)}`, (await import("../src/registry/crypto.mjs")).sha256Hex(secondToken), node.nodeId, new Date().toISOString(), new Date(Date.now() + 600_000).toISOString());
  assert.throws(
    () => registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: node.nodeId }),
    (error) => error.code === "not-tombstoned",
  );
  const response = await signedReenrollRequest(server.baseUrl, {
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { reenrollmentToken: secondToken, reenrollmentRequestId: randomHex(16), newPublicKey: generateNodeKeyPair().publicKeyHex },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "not-tombstoned");
});

test("expired re-enrollment tokens are denied on first use", async (t) => {
  const clock = { now: new Date() };
  const registry = createTestRegistry({ now: () => clock.now });
  const server = await createTestServer(registry, {});
  t.after(async () => {
    await server.close();
    registry.close();
  });
  const node = await enrollNode(server.baseUrl, registry);
  deleteNode(registry, node.nodeId);
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: node.nodeId, ttlSeconds: 60 });
  clock.now = new Date(clock.now.getTime() + 61 * 1000);
  const ts = Math.trunc(clock.now.getTime() / 1000);
  const response = await signedReenrollRequest(server.baseUrl, {
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { reenrollmentToken: minted.token, reenrollmentRequestId: randomHex(16), newPublicKey: generateNodeKeyPair().publicKeyHex },
    timestamp: ts,
  });
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "token-expired");
});

test("an exact replay of a consumed reenroll is served before the nonce is consulted", async (t) => {
  const { registry, server, node } = await withTombstonedNode(t);
  const newKeys = generateNodeKeyPair();
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: node.nodeId });
  const nonce = randomHex(16);
  const payload = { reenrollmentToken: minted.token, reenrollmentRequestId: randomHex(16), newPublicKey: newKeys.publicKeyHex };
  const first = await signedReenrollRequest(server.baseUrl, { nodeId: node.nodeId, keyId: node.keyId, keyHex: node.privateKeyHex, body: payload, nonce });
  assert.equal(first.status, 200);
  // The token was consumed by the identical request, so the second
  // request with the same nonce is an idempotent replay, not a nonce race.
  const second = await signedReenrollRequest(server.baseUrl, { nodeId: node.nodeId, keyId: node.keyId, keyHex: node.privateKeyHex, body: payload, nonce });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
});