// v0.5 Stage 1: registry migration, route mode, and pairing core
// (docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md Stage 1;
// RFC-0012 D1/D3/D11). Persistence/bootstrap semantics only — no public
// reverse gateway admission, no WebSocket control/data channel, no route
// proxy changes, no selector Open changes.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveKeyId, generateNodeKeyPair, randomHex, sha256Hex } from "../src/registry/crypto.mjs";
import { DeniedError } from "../src/registry/registry.mjs";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { backupRegistryDatabase, restoreRegistryDatabase } from "../src/registry/backup.mjs";
import { createTestRegistry, deleteNode } from "./helpers/registry-fixture.mjs";

const PAIRING_HUB_BASE_URL = "https://hub.example.com/";

function pairRegistry(options = {}) {
  return createTestRegistry({ pairingHubBaseUrl: PAIRING_HUB_BASE_URL, ...options });
}

function mintPairToken(registry) {
  return registry.mintEnrollmentToken({ actor: "operator", purpose: "pair" });
}

function expectDenied(fn, status, code) {
  assert.throws(
    fn,
    (error) => error instanceof DeniedError && error.status === status && error.code === code,
    `expected ${status} ${code}`,
  );
}

function enrollDirectNode(registry) {
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const keys = generateNodeKeyPair();
  const result = registry.enroll({
    token: minted.token,
    enrollmentRequestId: randomHex(16),
    publicKey: keys.publicKeyHex,
  });
  return { ...result, privateKeyHex: keys.privateKeyHex, publicKeyHex: keys.publicKeyHex };
}

function nodeRow(registry, nodeId) {
  return registry.db.prepare("SELECT * FROM nodes WHERE node_id = ?").get(nodeId);
}

test("pair token is digest-only at rest; plaintext exists exactly once in the mint response", () => {
  const registry = pairRegistry();
  const minted = mintPairToken(registry);
  assert.match(minted.token, /^[0-9a-f]{32}$/);
  assert.equal(minted.purpose, "pair");
  assert.equal(minted.boundNodeId, null);
  const row = registry.db
    .prepare("SELECT token_digest, purpose, bound_node_id FROM enrollment_tokens WHERE token_id = ?")
    .get(minted.tokenId);
  assert.equal(row.token_digest, sha256Hex(minted.token));
  assert.notEqual(row.token_digest, minted.token);
  assert.equal(row.purpose, "pair");
  assert.equal(row.bound_node_id, null);
  // plaintext-once: the mint response is the only place the plaintext exists
  const dump = JSON.stringify(registry.db.prepare("SELECT * FROM enrollment_tokens").all());
  assert.ok(!dump.includes(minted.token), "plaintext pair token must not persist");
  registry.close();
});

test("pair-purpose tokens reject boundNodeId and listTokens never exposes plaintext or digest", () => {
  const registry = pairRegistry();
  expectDenied(
    () => registry.mintEnrollmentToken({ actor: "operator", purpose: "pair", boundNodeId: "node_" + randomHex(16) }),
    400,
    "bad-request",
  );
  mintPairToken(registry);
  const listed = registry.listTokens();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].purpose, "pair");
  assert.deepEqual(Object.keys(listed[0]).sort(), [
    "boundNodeId",
    "consumedAt",
    "createdAt",
    "expiresAt",
    "purpose",
    "status",
    "tokenId",
  ]);
  registry.close();
});

test("pairing with unknown, wrong-purpose, or expired token is denied and consumes nothing", () => {
  const registry = pairRegistry();
  const keys = generateNodeKeyPair();
  expectDenied(() => registry.pair({ token: randomHex(16), pairingRequestId: randomHex(16), publicKey: keys.publicKeyHex }), 401, "unknown-token");

  const enrollToken = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  expectDenied(
    () => registry.pair({ token: enrollToken.token, pairingRequestId: randomHex(16), publicKey: keys.publicKeyHex }),
    400,
    "purpose-mismatch",
  );
  const consumed = registry.db.prepare("SELECT consumed_at FROM enrollment_tokens WHERE token_id = ?").get(enrollToken.tokenId);
  assert.equal(consumed.consumed_at, null, "a wrong-purpose pair attempt must not consume the token");

  const pairToken = mintPairToken(registry);
  registry.now = () => new Date(Date.now() + 11 * 60 * 1000);
  expectDenied(
    () => registry.pair({ token: pairToken.token, pairingRequestId: randomHex(16), publicKey: keys.publicKeyHex }),
    401,
    "token-expired",
  );
  assert.equal(registry.db.prepare("SELECT consumed_at FROM enrollment_tokens WHERE token_id = ?").get(pairToken.tokenId).consumed_at, null);
  registry.close();
});

test("fresh pair creates a new node with reverse route mode, an active node key, and a provisioned Hub route identity", () => {
  const registry = pairRegistry();
  const minted = mintPairToken(registry);
  const keys = generateNodeKeyPair();
  const result = registry.pair({ token: minted.token, pairingRequestId: randomHex(16), publicKey: keys.publicKeyHex });
  assert.match(result.nodeId, /^node_[0-9a-f]{32}$/);
  assert.equal(result.keyId, deriveKeyId(keys.publicKeyHex));
  assert.equal(result.routeMode, "reverse");
  assert.equal(result.hubBaseUrl, PAIRING_HUB_BASE_URL);
  assert.equal(result.reverseProtocol, "orbit-reverse-v1");
  assert.equal(typeof result.heartbeatCadenceSeconds, "number");

  const node = nodeRow(registry, result.nodeId);
  assert.equal(node.state, "active");
  assert.equal(node.route_mode, "reverse");
  const key = registry.db.prepare("SELECT state FROM node_keys WHERE node_id = ? AND key_id = ?").get(result.nodeId, result.keyId);
  assert.equal(key.state, "active");
  const hubRouteKeys = registry.db.prepare("SELECT key_id, state FROM hub_route_keys WHERE node_id = ?").all(result.nodeId);
  assert.equal(hubRouteKeys.length, 1);
  assert.equal(hubRouteKeys[0].state, "provisioned");
  const audit = registry.db.prepare("SELECT detail_json FROM audit WHERE action = 'node.paired'").all();
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].detail_json), { nodeId: result.nodeId, keyId: result.keyId, tokenId: minted.tokenId, routeMode: "reverse" });
  registry.close();
});

test("exact pairing replay returns the exact recorded result within the idempotency retention", () => {
  const registry = pairRegistry();
  const minted = mintPairToken(registry);
  const keys = generateNodeKeyPair();
  const requestId = randomHex(16);
  const first = registry.pair({ token: minted.token, pairingRequestId: requestId, publicKey: keys.publicKeyHex });
  const replay = registry.pair({ token: minted.token, pairingRequestId: requestId, publicKey: keys.publicKeyHex });
  assert.deepEqual(replay, first);
  // Even past expiry an exact replay is served (TTL governs first-time use).
  registry.now = () => new Date(Date.now() + 11 * 60 * 1000);
  const lateReplay = registry.pair({ token: minted.token, pairingRequestId: requestId, publicKey: keys.publicKeyHex });
  assert.deepEqual(lateReplay, first);
  const results = registry.db.prepare("SELECT kind, node_id FROM enrollment_results WHERE kind = 'pair'").all();
  assert.equal(results.length, 1);
  registry.close();
});

test("reusing the pair token or request id with different content is denied", () => {
  const registry = pairRegistry();
  const minted = mintPairToken(registry);
  const keysA = generateNodeKeyPair();
  const keysB = generateNodeKeyPair();
  const requestId = randomHex(16);
  registry.pair({ token: minted.token, pairingRequestId: requestId, publicKey: keysA.publicKeyHex });
  // Different public key, same token+request id
  expectDenied(
    () => registry.pair({ token: minted.token, pairingRequestId: requestId, publicKey: keysB.publicKeyHex }),
    401,
    "token-consumed",
  );
  // Different request id, same token+public key
  expectDenied(
    () => registry.pair({ token: minted.token, pairingRequestId: randomHex(16), publicKey: keysA.publicKeyHex }),
    401,
    "token-consumed",
  );
  registry.close();
});

test("a failed pairing transaction consumes nothing", () => {
  const registry = pairRegistry();
  const minted = mintPairToken(registry);
  const keys = generateNodeKeyPair();
  const originalEnsureHubRouteKey = registry.ensureHubRouteKey.bind(registry);
  registry.ensureHubRouteKey = () => {
    throw new Error("simulated provisioning failure");
  };
  assert.throws(() => registry.pair({ token: minted.token, pairingRequestId: randomHex(16), publicKey: keys.publicKeyHex }), /simulated provisioning failure/);
  registry.ensureHubRouteKey = originalEnsureHubRouteKey;
  assert.equal(registry.db.prepare("SELECT consumed_at FROM enrollment_tokens WHERE token_id = ?").get(minted.tokenId).consumed_at, null);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS c FROM nodes").get().c, 0);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS c FROM node_keys").get().c, 0);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS c FROM enrollment_results WHERE kind = 'pair'").get().c, 0);
  // The token still works after the failed attempt.
  const result = registry.pair({ token: minted.token, pairingRequestId: randomHex(16), publicKey: keys.publicKeyHex });
  assert.equal(result.routeMode, "reverse");
  registry.close();
});

test("pairing an installation that already holds a durable active node identity is rejected with a reconcile error", () => {
  const registry = pairRegistry();
  const existing = enrollDirectNode(registry);
  assert.equal(nodeRow(registry, existing.nodeId).route_mode, "direct");
  const minted = mintPairToken(registry);
  expectDenied(
    () => registry.pair({ token: minted.token, pairingRequestId: randomHex(16), publicKey: existing.publicKeyHex }),
    409,
    "reconcile-required",
  );
  assert.equal(registry.db.prepare("SELECT consumed_at FROM enrollment_tokens WHERE token_id = ?").get(minted.tokenId).consumed_at, null);
  registry.close();
});

test("a pair token can never restore a tombstoned node ID; lost keys pair into a different node ID", () => {
  const registry = pairRegistry();
  const existing = enrollDirectNode(registry);
  deleteNode(registry, existing.nodeId);
  assert.equal(nodeRow(registry, existing.nodeId).state, "tombstoned");

  // Same key material (the old, now-revoked identity) still cannot bring the
  // old node ID back: pairing only ever mints a fresh node.
  const sameKeyToken = mintPairToken(registry);
  const sameKeyResult = registry.pair({
    token: sameKeyToken.token,
    pairingRequestId: randomHex(16),
    publicKey: existing.publicKeyHex,
  });
  assert.notEqual(sameKeyResult.nodeId, existing.nodeId);
  assert.equal(sameKeyResult.routeMode, "reverse");
  assert.equal(nodeRow(registry, existing.nodeId).state, "tombstoned");

  // Lost local private key -> fresh pair -> fresh node ID.
  const lostKeyToken = mintPairToken(registry);
  const lostKeyResult = registry.pair({
    token: lostKeyToken.token,
    pairingRequestId: randomHex(16),
    publicKey: generateNodeKeyPair().publicKeyHex,
  });
  assert.notEqual(lostKeyResult.nodeId, existing.nodeId);
  assert.notEqual(lostKeyResult.nodeId, sameKeyResult.nodeId);
  registry.close();
});

test("pairing node A never mutates node B", () => {
  const registry = pairRegistry();
  const nodeB = enrollDirectNode(registry);
  const minted = mintPairToken(registry);
  const snapshot = {
    node: nodeRow(registry, nodeB.nodeId),
    keys: registry.db.prepare("SELECT * FROM node_keys WHERE node_id = ?").all(nodeB.nodeId),
    results: registry.db.prepare("SELECT * FROM enrollment_results WHERE node_id = ?").all(nodeB.nodeId),
    tokens: registry.db.prepare("SELECT * FROM enrollment_tokens").all(),
  };
  const nodeA = registry.pair({ token: minted.token, pairingRequestId: randomHex(16), publicKey: generateNodeKeyPair().publicKeyHex });
  assert.notEqual(nodeA.nodeId, nodeB.nodeId);
  assert.deepEqual(nodeRow(registry, nodeB.nodeId), snapshot.node);
  assert.deepEqual(registry.db.prepare("SELECT * FROM node_keys WHERE node_id = ?").all(nodeB.nodeId), snapshot.keys);
  assert.deepEqual(registry.db.prepare("SELECT * FROM enrollment_results WHERE node_id = ?").all(nodeB.nodeId), snapshot.results);
  // Only the consumed pair token row changed; enrollment token rows of B are untouched.
  const tokensNow = registry.db.prepare("SELECT * FROM enrollment_tokens").all();
  assert.equal(tokensNow.length, snapshot.tokens.length);
  for (const before of snapshot.tokens) {
    const after = tokensNow.find((row) => row.token_id === before.token_id);
    if (before.token_id !== minted.tokenId) {
      assert.deepEqual(after, before);
    }
  }
  registry.close();
});

test("pairing fails closed when the pairing hub base URL is unconfigured or invalid", () => {
  const registry = createTestRegistry();
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "pair" });
  expectDenied(
    () => registry.pair({ token: minted.token, pairingRequestId: randomHex(16), publicKey: generateNodeKeyPair().publicKeyHex }),
    503,
    "pairing-unconfigured",
  );
  assert.equal(registry.db.prepare("SELECT consumed_at FROM enrollment_tokens WHERE token_id = ?").get(minted.tokenId).consumed_at, null);
  registry.close();

  assert.throws(() => pairRegistry({ pairingHubBaseUrl: "ftp://hub.example.com" }), /protocol must be http\(s\)/);
  assert.throws(() => pairRegistry({ pairingHubBaseUrl: "https://hub.example.com/orbit/" }), /must carry no path/);
  assert.throws(() => pairRegistry({ pairingHubBaseUrl: "http://hub.example.com" }), /plaintext http only on loopback/);
  const loopback = pairRegistry({ pairingHubBaseUrl: "http://127.0.0.1:5445" });
  assert.equal(loopback.pairingHubBaseUrl, "http://127.0.0.1:5445/");
  loopback.close();
  const canonicalized = pairRegistry({ pairingHubBaseUrl: "HTTPS://HUB.Example.com:443" });
  assert.equal(canonicalized.pairingHubBaseUrl, "https://hub.example.com/");
  canonicalized.close();
});

test("fresh-install migration semantics: new databases start empty on schema v6 with route_mode direct default", () => {
  const registry = pairRegistry();
  const version = registry.db.prepare("PRAGMA user_version").get().user_version;
  assert.equal(version, 6);
  // The nodes table default keeps every non-pairing creation path direct.
  registry.db.prepare("INSERT INTO nodes (node_id, state, minted_at, authenticated) VALUES ('node_" + "b".repeat(32) + "', 'active', 't', 'ok')").run();
  assert.equal(nodeRow(registry, "node_" + "b".repeat(32)).route_mode, "direct");
  registry.close();
});

test("migration rerun is idempotent on a file-backed registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-v05-stage1-migration-"));
  try {
    const path = join(dir, "registry.db");
    const first = openRegistryDatabase(path);
    first.close();
    const second = openRegistryDatabase(path);
    assert.equal(second.prepare("PRAGMA user_version").get().user_version, 6);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backup/restore preserves route mode and pair-purpose state; no live reverse session state exists to preserve", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-v05-stage1-backup-"));
  try {
    const sourcePath = join(dir, "registry.db");
    // Reopen file-backed through the Registry so pair state is durable.
    const fileDb = openRegistryDatabase(sourcePath);
    const fileRegistry = pairRegistry({ db: fileDb });
    const minted = mintPairToken(fileRegistry);
    const paired = fileRegistry.pair({ token: minted.token, pairingRequestId: randomHex(16), publicKey: generateNodeKeyPair().publicKeyHex });
    // Registry.close() closes the underlying file-backed handle.
    fileRegistry.close();

    const backupPath = join(dir, "backup.db");
    const backupDb = openRegistryDatabase(sourcePath);
    await backupRegistryDatabase({ db: backupDb, sourcePath, destinationPath: backupPath });
    backupDb.close();

    const targetPath = join(dir, "restored.db");
    await restoreRegistryDatabase({ backupPath, targetPath, writersQuiesced: true });
    const restored = openRegistryDatabase(targetPath);
    const restoredNode = restored.prepare("SELECT route_mode, state FROM nodes WHERE node_id = ?").get(paired.nodeId);
    assert.equal(restoredNode.state, "active");
    assert.equal(restoredNode.route_mode, "reverse");
    assert.equal(restored.prepare("SELECT purpose, bound_node_id, consumed_at FROM enrollment_tokens WHERE token_id = ?").get(minted.tokenId).purpose, "pair");
    assert.equal(restored.prepare("SELECT kind FROM enrollment_results WHERE kind = 'pair'").all().length, 1);
    assert.ok(restored.prepare("SELECT 1 FROM audit WHERE action = 'node.paired'").get());
    // Live reverse sessions are process memory only: no reverse session,
    // channel, or presence table exists anywhere in the restored schema.
    const tables = restored.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    assert.equal(tables.some((name) => /^reverse|session_|presence/.test(name) && name !== "browser_sessions"), false);
    restored.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
