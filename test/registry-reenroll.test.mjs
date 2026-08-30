import assert from "node:assert/strict";
import test from "node:test";
import { generateNodeKeyPair, randomHex } from "../src/registry/crypto.mjs";
import { createTestRegistry, createTestServer, defaultRuntimeIdentity, deleteNode, enrollNode, signedMachineRequest, signedReenrollRequest } from "./helpers/registry-fixture.mjs";

async function withTombstonedNode(t) {
  const registry = createTestRegistry();
  const server = await createTestServer(registry, {});
  t.after(async () => {
    await server.close();
    registry.close();
  });
  const node = await enrollNode(server.baseUrl, registry);
  deleteNode(registry, node.nodeId);
  return { registry, server, node };
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
  assert.equal(body.keyId, body.keyId);

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
  assert.deepEqual(auditActions, ["node.enrolled", "node.reenrolled"]);

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