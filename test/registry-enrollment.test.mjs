import assert from "node:assert/strict";
import test from "node:test";
import { generateNodeKeyPair, randomHex, sha256Hex } from "../src/registry/crypto.mjs";
import { DeniedError } from "../src/registry/registry.mjs";
import { createTestRegistry } from "./helpers/registry-fixture.mjs";


test("mint stores a digest only; the plaintext exists exactly once in the response", () => {
  const registry = createTestRegistry();
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  assert.match(minted.tokenId, /^etok_[0-9a-f]{16}$/);
  assert.match(minted.token, /^[0-9a-f]{32}$/);
  const row = registry.db.prepare("SELECT token_digest, purpose, bound_node_id FROM enrollment_tokens WHERE token_id = ?").get(minted.tokenId);
  assert.equal(row.token_digest, sha256Hex(minted.token));
  assert.notEqual(row.token_digest, minted.token);
  assert.equal(row.purpose, "enroll");
  assert.equal(row.bound_node_id, null);
  registry.close();
});

test("reenroll-purpose tokens require a tombstoned boundNodeId", () => {
  const registry = createTestRegistry();
  assert.throws(
    () => registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: "node_" + randomHex(16) }),
    (error) => error instanceof DeniedError && error.code === "not-tombstoned",
  );
  assert.throws(
    () => registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll", boundNodeId: "node_" + randomHex(16) }),
    (error) => error instanceof DeniedError && error.code === "bad-request",
  );
  registry.close();
});

test("enrollment succeeds once and persists an active node with an active key", () => {
  const registry = createTestRegistry();
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const keys = generateNodeKeyPair();
  const result = registry.enroll({ token: minted.token, enrollmentRequestId: randomHex(16), publicKey: keys.publicKeyHex });
  assert.match(result.nodeId, /^node_[0-9a-f]{32}$/);
  assert.equal(result.keyId, sha256Hex(Buffer.from(keys.publicKeyHex, "hex")).slice(0, 32));

  const node = registry.getNodeRow(result.nodeId);
  assert.equal(node.state, "active");
  assert.equal(node.authenticated, "ok");
  assert.equal(node.reachable, "unknown");
  assert.equal(node.capabilities_stale, 1);
  const key = registry.db.prepare("SELECT * FROM node_keys WHERE node_id = ? AND key_id = ?").get(result.nodeId, result.keyId);
  assert.equal(key.state, "active");
  const row = registry.db.prepare("SELECT consumed_at FROM enrollment_tokens WHERE token_id = ?").get(minted.tokenId);
  assert.notEqual(row.consumed_at, null);
  registry.close();
});

test("identical enroll replay returns the same result; different content is denied", () => {
  const registry = createTestRegistry();
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const keys = generateNodeKeyPair();
  const requestId = randomHex(16);
  const first = registry.enroll({ token: minted.token, enrollmentRequestId: requestId, publicKey: keys.publicKeyHex });
  const replay = registry.enroll({ token: minted.token, enrollmentRequestId: requestId, publicKey: keys.publicKeyHex });
  assert.deepEqual(replay, first);
  assert.throws(
    () => registry.enroll({ token: minted.token, enrollmentRequestId: requestId, publicKey: generateNodeKeyPair().publicKeyHex }),
    (error) => error instanceof DeniedError && error.code === "token-consumed",
  );
  registry.close();
});

test("expired tokens are denied and consume nothing", () => {
  let now = new Date("2026-08-30T00:00:00Z");
  const registry = createTestRegistry({ now: () => now });
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll", ttlSeconds: 600 });
  now = new Date(now.getTime() + 601 * 1000);
  assert.throws(
    () => registry.enroll({ token: minted.token, enrollmentRequestId: randomHex(16), publicKey: generateNodeKeyPair().publicKeyHex }),
    (error) => error instanceof DeniedError && error.code === "token-expired",
  );
  const row = registry.db.prepare("SELECT consumed_at FROM enrollment_tokens WHERE token_id = ?").get(minted.tokenId);
  assert.equal(row.consumed_at, null);
  registry.close();
});

test("unknown tokens and purpose mismatches are denied", () => {
  const registry = createTestRegistry();
  const enrollToken = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  // A real reenroll-purpose token bound to a real tombstone.
  const keys = generateNodeKeyPair();
  const nodeId = registry.enroll({ token: enrollToken.token, enrollmentRequestId: randomHex(16), publicKey: keys.publicKeyHex }).nodeId;
  registry.deleteNode({ actor: "operator", nodeId, reason: "test" });
  const reenrollToken = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: nodeId });
  assert.throws(
    () => registry.enroll({ token: randomHex(16), enrollmentRequestId: randomHex(16), publicKey: generateNodeKeyPair().publicKeyHex }),
    (error) => error instanceof DeniedError && error.code === "unknown-token",
  );
  assert.throws(
    () => registry.enroll({ token: reenrollToken.token, enrollmentRequestId: randomHex(16), publicKey: generateNodeKeyPair().publicKeyHex }),
    (error) => error instanceof DeniedError && error.code === "purpose-mismatch",
  );
  assert.throws(
    () => registry.enroll({ token: enrollToken.token, enrollmentRequestId: "zz", publicKey: generateNodeKeyPair().publicKeyHex }),
    (error) => error instanceof DeniedError && error.code === "bad-request",
  );
  registry.close();
});

test("exact replays keep working after token expiry (retention-based, RFC-0005 D2)", () => {
  let now = new Date("2026-08-30T00:00:00Z");
  const registry = createTestRegistry({ now: () => now });
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll", ttlSeconds: 60 });
  const keys = generateNodeKeyPair();
  const requestId = randomHex(16);
  const first = registry.enroll({ token: minted.token, enrollmentRequestId: requestId, publicKey: keys.publicKeyHex });
  now = new Date(now.getTime() + 2 * 60 * 1000);
  const replay = registry.enroll({ token: minted.token, enrollmentRequestId: requestId, publicKey: keys.publicKeyHex });
  assert.deepEqual(replay, first);
  registry.close();
});