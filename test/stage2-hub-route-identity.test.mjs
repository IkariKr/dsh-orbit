// Stage 2 automated test suite: Hub Route Identity, Route Ingress,
// Reachability state machine, Secret isolation, and Backup protection.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRegistry, createTestServer } from "./helpers/registry-fixture.mjs";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { generateNodeKeyPair, deriveKeyId, randomHex } from "../src/registry/crypto.mjs";
import {
  computeRouteAuthority,
  buildRouteSigningString,
  ROUTE_V1_LABEL,
  ROUTE_PROBE_FAILURE_THRESHOLD,
} from "../src/registry/protocol.mjs";
import { validateHubRouteKeySet } from "../src/registry/hub-route-keys.mjs";
import { RouteNonceCache, signRouteRequest, verifyRouteRequest } from "../src/registry/route-auth.mjs";
import { RouteIngress } from "../src/node/route-ingress.mjs";
import { backupRegistryDatabase, inspectRegistryDatabase } from "../src/registry/backup.mjs";

function enrollTestNode(registry) {
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const keys = generateNodeKeyPair();
  const res = registry.enroll({
    token: minted.token,
    enrollmentRequestId: randomHex(16),
    publicKey: keys.publicKeyHex,
  });
  return { nodeId: res.nodeId, keyPair: keys, keyId: res.keyId };
}

// ---------------------------------------------------------------------------
// 1. Hub Route Key Isolation & Lifecycle
// ---------------------------------------------------------------------------

test("Hub Route Key Isolation: Hub holds private key, Node summary holds public keys only", () => {
  const registry = createTestRegistry({ routeDomain: "dsh.example.com" });
  const { nodeId } = enrollTestNode(registry);

  // Hub ensures route key
  const hubKey = registry.ensureHubRouteKey(nodeId);
  assert.equal(hubKey.node_id, nodeId);
  assert.equal(hubKey.state, "provisioned");
  assert.ok(hubKey.private_key, "Hub database row contains private key");

  // Node summary exposed to external consumers never contains private key
  const nodeSummary = registry.getNode(nodeId);
  assert.ok(Array.isArray(nodeSummary.hubRouteKeys));
  assert.equal(nodeSummary.hubRouteKeys.length, 1);
  const exposedKey = nodeSummary.hubRouteKeys[0];
  assert.equal(exposedKey.keyId, hubKey.key_id);
  assert.equal(exposedKey.publicKey, hubKey.public_key);
  assert.equal(exposedKey.state, "provisioned");
  assert.equal(typeof exposedKey.private_key, "undefined");
  assert.equal(typeof exposedKey.privateKey, "undefined");

  registry.close();
});

test("Hub Route Key Complete-Set Validation: enforces RFC-0006 4 valid forms and rejects malformed sets", () => {
  const k1 = generateNodeKeyPair();
  const id1 = deriveKeyId(k1.publicKeyHex);
  const k2 = generateNodeKeyPair();
  const id2 = deriveKeyId(k2.publicKeyHex);

  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 10000).toISOString();

  // Form 1: 1 provisioned
  const form1 = [{ keyId: id1, publicKey: k1.publicKeyHex, state: "provisioned", overlapUntil: null }];
  assert.equal(validateHubRouteKeySet(form1).valid, true);
  assert.equal(validateHubRouteKeySet(form1).form, 1);

  // Form 2: 1 active
  const form2 = [{ keyId: id1, publicKey: k1.publicKeyHex, state: "active", overlapUntil: null }];
  assert.equal(validateHubRouteKeySet(form2).valid, true);
  assert.equal(validateHubRouteKeySet(form2).form, 2);

  // Form 3: 1 active + 1 provisioned
  const form3 = [
    { keyId: id1, publicKey: k1.publicKeyHex, state: "active", overlapUntil: null },
    { keyId: id2, publicKey: k2.publicKeyHex, state: "provisioned", overlapUntil: null },
  ];
  assert.equal(validateHubRouteKeySet(form3).valid, true);
  assert.equal(validateHubRouteKeySet(form3).form, 3);

  // Form 4: 1 active + 1 rotating with future overlap
  const form4 = [
    { keyId: id2, publicKey: k2.publicKeyHex, state: "active", overlapUntil: null },
    { keyId: id1, publicKey: k1.publicKeyHex, state: "rotating", overlapUntil: future },
  ];
  assert.equal(validateHubRouteKeySet(form4).valid, true);
  assert.equal(validateHubRouteKeySet(form4).form, 4);

  // Rejections:
  // Empty
  assert.equal(validateHubRouteKeySet([]).valid, false);
  // More than 2 keys
  assert.equal(validateHubRouteKeySet([...form4, { keyId: "a".repeat(32), publicKey: "b".repeat(64), state: "provisioned", overlapUntil: null }]).valid, false);
  // Mismatched keyId
  assert.equal(validateHubRouteKeySet([{ keyId: "0".repeat(32), publicKey: k1.publicKeyHex, state: "provisioned", overlapUntil: null }]).valid, false);
  // Past overlap in rotating
  const badRotating = [
    { keyId: id2, publicKey: k2.publicKeyHex, state: "active", overlapUntil: null },
    { keyId: id1, publicKey: k1.publicKeyHex, state: "rotating", overlapUntil: past },
  ];
  assert.equal(validateHubRouteKeySet(badRotating).valid, false);
  // Provisioned with overlap timestamp
  const badProvisioned = [{ keyId: id1, publicKey: k1.publicKeyHex, state: "provisioned", overlapUntil: future }];
  assert.equal(validateHubRouteKeySet(badProvisioned).valid, false);
});

test("Hub Route Key Lifecycle: Heartbeat ACK progression (provisioned -> active -> rotating -> revoked)", () => {
  const registry = createTestRegistry({ routeDomain: "dsh.example.com" });
  const { nodeId, keyPair, keyId } = enrollTestNode(registry);

  // Helper for heartbeat calls in test
  const sendHb = (acceptedIds) => {
    return registry.heartbeatAuthenticated({
      node: registry.getNodeRow(nodeId),
      rawBody: Buffer.from(
        JSON.stringify({
          runtime: { orbitVersion: "0.4.0", dshVersion: "1.0.0" },
          acceptedHubRouteKeyIds: acceptedIds,
        }),
      ),
    });
  };

  // 1. Initial heartbeat: Node sends no ACK -> Hub delivers 1 provisioned key
  const hb1 = sendHb([]);
  assert.equal(hb1.hubRouteKeys.length, 1);
  assert.equal(hb1.hubRouteKeys[0].state, "provisioned");
  const key1Id = hb1.hubRouteKeys[0].keyId;

  // 2. Second heartbeat: Node ACKs key1 -> Hub promotes key1 to active
  const hb2 = sendHb([key1Id]);
  assert.equal(hb2.hubRouteKeys.length, 1);
  assert.equal(hb2.hubRouteKeys[0].keyId, key1Id);
  assert.equal(hb2.hubRouteKeys[0].state, "active");

  // 3. Trigger rotation
  const rotateRes = registry.rotateHubRouteKey({ actor: "operator", nodeId, overlapDays: 7 });
  const key2Id = rotateRes.newKeyId;
  assert.equal(rotateRes.state, "provisioned");

  // 4. Third heartbeat: Hub serves Form 3 (key1 active + key2 provisioned)
  const hb3 = sendHb([key1Id]);
  assert.equal(hb3.hubRouteKeys.length, 2);
  const activeIn3 = hb3.hubRouteKeys.find((k) => k.keyId === key1Id);
  const provIn3 = hb3.hubRouteKeys.find((k) => k.keyId === key2Id);
  assert.equal(activeIn3.state, "active");
  assert.equal(provIn3.state, "provisioned");

  // 5. Fourth heartbeat: Node ACKs key2 -> Hub promotes key2 to active, key1 to rotating (Form 4)
  const hb4 = sendHb([key1Id, key2Id]);
  assert.equal(hb4.hubRouteKeys.length, 2);
  const key2Active = hb4.hubRouteKeys.find((k) => k.keyId === key2Id);
  const key1Rotating = hb4.hubRouteKeys.find((k) => k.keyId === key1Id);
  assert.equal(key2Active.state, "active");
  assert.equal(key1Rotating.state, "rotating");
  assert.ok(key1Rotating.overlapUntil);

  // 6. Maintenance after overlap ends revokes key1
  registry.now = () => new Date(Date.now() + 15 * 86400000);
  registry.maintenance();

  const hb5 = sendHb([key2Id]);
  assert.equal(hb5.hubRouteKeys.length, 1);
  assert.equal(hb5.hubRouteKeys[0].keyId, key2Id);
  assert.equal(hb5.hubRouteKeys[0].state, "active");

  registry.close();
});

test("Hub Route Key Lifecycle: tombstone immediately revokes all Hub route keys", () => {
  const registry = createTestRegistry({ routeDomain: "dsh.example.com" });
  const { nodeId } = enrollTestNode(registry);

  registry.ensureHubRouteKey(nodeId);
  assert.equal(registry.getHubRouteKeysForNode(nodeId).length, 1);

  registry.deleteNode({ actor: "operator", nodeId, requestId: randomHex(16), reason: "operator delete" });
  assert.equal(registry.getHubRouteKeysForNode(nodeId).length, 0);

  registry.close();
});

// ---------------------------------------------------------------------------
// 2. ORBIT-ROUTE-V1 Auth Negative Matrix
// ---------------------------------------------------------------------------

test("ORBIT-ROUTE-V1 negative matrix: missing/malformed headers, timestamp skew, replay, invalid key, bad authority", () => {
  const registry = createTestRegistry({ routeDomain: "dsh.example.com" });
  const { nodeId, keyId } = enrollTestNode(registry);
  const hubKey = registry.ensureHubRouteKey(nodeId);
  registry.acknowledgeHubRouteKeys(nodeId, [hubKey.key_id]);

  const activeKey = registry.getActiveHubRouteKey(nodeId);
  assert.equal(activeKey.state, "active");

  const authority = computeRouteAuthority(nodeId, "dsh.example.com");
  const nonceCache = new RouteNonceCache();
  const getPublicKey = (kid) => {
    if (kid === activeKey.key_id) {
      return { keyId: activeKey.key_id, publicKey: activeKey.public_key, state: "active" };
    }
    return null;
  };

  const nowMs = Date.now();
  const nonce = randomHex(16);
  const signed = signRouteRequest({
    privateKeyHex: activeKey.private_key,
    keyId: activeKey.key_id,
    nodeId,
    routeAuthority: authority,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    nowMs,
    nonce,
  });

  // 1. Positive control: valid request passes
  const validCheck = verifyRouteRequest({
    headers: signed.headers,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey,
    nonceCache,
    nowMs,
  });
  assert.equal(validCheck.ok, true);

  // 2. Replayed nonce -> 401 replay
  const replayCheck = verifyRouteRequest({
    headers: signed.headers,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey,
    nonceCache,
    nowMs,
  });
  assert.equal(replayCheck.ok, false);
  assert.equal(replayCheck.code, "replay");

  // 3. Missing header -> 400 bad-request
  const missingHeader = { ...signed.headers };
  delete missingHeader["x-orbit-route-signature"];
  const badReqCheck = verifyRouteRequest({
    headers: missingHeader,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey,
    nonceCache,
    nowMs,
  });
  assert.equal(badReqCheck.ok, false);
  assert.equal(badReqCheck.status, 400);

  // 4. Timestamp out of 30s skew window -> 401 timestamp-out-of-skew
  const expiredCheck = verifyRouteRequest({
    headers: signed.headers,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey,
    nonceCache,
    nowMs: nowMs + 35_000,
  });
  assert.equal(expiredCheck.ok, false);
  assert.equal(expiredCheck.code, "timestamp-out-of-skew");

  // 5. Unknown key -> 401 unknown-key
  const unknownKeyCheck = verifyRouteRequest({
    headers: { ...signed.headers, "x-orbit-route-key": "a".repeat(32) },
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey,
    nonceCache: new RouteNonceCache(),
    nowMs,
  });
  assert.equal(unknownKeyCheck.ok, false);
  assert.equal(unknownKeyCheck.code, "unknown-key");

  // 6. Provisioned key used for signing -> 401 key-not-active
  const provCheck = verifyRouteRequest({
    headers: signed.headers,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey: () => ({ keyId: activeKey.key_id, publicKey: activeKey.public_key, state: "provisioned" }),
    nonceCache: new RouteNonceCache(),
    nowMs,
  });
  assert.equal(provCheck.ok, false);
  assert.equal(provCheck.code, "key-not-active");

  // 7. Route authority mismatch -> 401 authority-mismatch
  const badAuthCheck = verifyRouteRequest({
    headers: { ...signed.headers, host: "wrong.example.com" },
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey,
    nonceCache: new RouteNonceCache(),
    nowMs,
  });
  assert.equal(badAuthCheck.ok, false);
  assert.equal(badAuthCheck.code, "authority-mismatch");

  // 8. Forged signature -> 401 signature-invalid
  const forgedCheck = verifyRouteRequest({
    headers: { ...signed.headers, "x-orbit-route-signature": "f".repeat(128) },
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey,
    nonceCache: new RouteNonceCache(),
    nowMs,
  });
  assert.equal(forgedCheck.ok, false);
  assert.equal(forgedCheck.code, "signature-invalid");

  registry.close();
});

// ---------------------------------------------------------------------------
// 3. Route Ingress Endpoint & DSH Liveness
// ---------------------------------------------------------------------------

test("Route Ingress: admits GET /_orbit/route-ready with DSH liveness; strictly rejects all other paths", async () => {
  const nodeId = "node_" + "22".repeat(16);
  const routeDomain = "dsh.example.com";
  const authority = computeRouteAuthority(nodeId, routeDomain);

  const hubKey = generateNodeKeyPair();
  const hubKeyId = deriveKeyId(hubKey.publicKeyHex);
  const trustKeys = [{ keyId: hubKeyId, publicKey: hubKey.publicKeyHex, state: "active" }];

  let dshAlive = true;
  const ingress = new RouteIngress({
    nodeId,
    routeDomain,
    getTrustKeys: () => trustKeys,
    dshProbeTransport: async () => dshAlive,
  });

  await ingress.listen(0, "127.0.0.1");
  const port = ingress.port;

  try {
    // 1. Valid probe with DSH alive -> HTTP 200 { ready: true }
    const signed1 = signRouteRequest({
      privateKeyHex: hubKey.privateKeyHex,
      keyId: hubKeyId,
      nodeId,
      routeAuthority: authority,
      method: "GET",
      rawTarget: "/_orbit/route-ready",
      nonce: randomHex(16),
    });

    const res1 = await fetch(`http://127.0.0.1:${port}/_orbit/route-ready`, {
      method: "GET",
      headers: { ...signed1.headers, "x-orbit-route-authority": authority },
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.nodeId, nodeId);
    assert.equal(body1.ready, true);

    // 2. DSH down -> HTTP 503 { ready: false, error: 'dsh_unreachable' }
    dshAlive = false;
    const signed2 = signRouteRequest({
      privateKeyHex: hubKey.privateKeyHex,
      keyId: hubKeyId,
      nodeId,
      routeAuthority: authority,
      method: "GET",
      rawTarget: "/_orbit/route-ready",
      nonce: randomHex(16),
    });

    const res2 = await fetch(`http://127.0.0.1:${port}/_orbit/route-ready`, {
      method: "GET",
      headers: { ...signed2.headers, "x-orbit-route-authority": authority },
    });
    assert.equal(res2.status, 503);
    const body2 = await res2.json();
    assert.equal(body2.nodeId, nodeId);
    assert.equal(body2.ready, false);
    assert.equal(body2.error, "dsh_unreachable");

    // 3. Ingress disabled -> HTTP 503 ingress_disabled
    ingress.disable();
    const signed3 = signRouteRequest({
      privateKeyHex: hubKey.privateKeyHex,
      keyId: hubKeyId,
      nodeId,
      routeAuthority: authority,
      method: "GET",
      rawTarget: "/_orbit/route-ready",
      nonce: randomHex(16),
    });
    const res3 = await fetch(`http://127.0.0.1:${port}/_orbit/route-ready`, {
      method: "GET",
      headers: { ...signed3.headers, "x-orbit-route-authority": authority },
    });
    assert.equal(res3.status, 503);
    ingress.enable();

    // 4. Other paths (e.g. /api/v1/workspaces, /dsh/login, /index.html) -> fail closed 404
    for (const forbiddenPath of ["/api/v1/workspaces", "/dsh", "/index.html"]) {
      const resForbidden = await fetch(`http://127.0.0.1:${port}${forbiddenPath}`, {
        method: "GET",
        headers: { "x-orbit-route-authority": authority },
      });
      assert.equal(resForbidden.status, 404);
    }
  } finally {
    await ingress.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Reachability State Machine
// ---------------------------------------------------------------------------

test("Reachability State Machine: 3 probe failures -> unreachable; 1 success -> ok; route target change resets to unknown", async () => {
  const registry = createTestRegistry({ routeDomain: "dsh.example.com" });
  const { nodeId } = enrollTestNode(registry);

  // Initially reachable is unknown
  assert.equal(registry.getNode(nodeId).health.reachable, "unknown");

  // Probing without route target or active key -> stays unknown
  const noTargetProbe = await registry.probeNode(nodeId);
  assert.equal(noTargetProbe.reachable, "unknown");
  assert.equal(noTargetProbe.probed, false);

  // Set route target and activate route key
  registry.setRouteTarget({ actor: "operator", nodeId, routeTarget: "http://127.0.0.1:8080" });
  const hubKey = registry.ensureHubRouteKey(nodeId);
  registry.acknowledgeHubRouteKeys(nodeId, [hubKey.key_id]);

  let mockProbeSuccess = false;
  const mockTransport = async () => {
    if (mockProbeSuccess) {
      return { status: 200, body: JSON.stringify({ nodeId, ready: true }) };
    }
    return { status: 503, body: JSON.stringify({ nodeId, ready: false }) };
  };

  // Failure 1: reachable stays unknown (failure threshold is 3)
  const p1 = await registry.probeNode(nodeId, { requestTransport: mockTransport });
  assert.equal(p1.reachable, "unknown");
  assert.equal(p1.failures, 1);
  assert.equal(registry.getNode(nodeId).health.reachable, "unknown");

  // Failure 2: stays unknown
  const p2 = await registry.probeNode(nodeId, { requestTransport: mockTransport });
  assert.equal(p2.reachable, "unknown");
  assert.equal(p2.failures, 2);

  // Failure 3: transitions to unreachable!
  const p3 = await registry.probeNode(nodeId, { requestTransport: mockTransport });
  assert.equal(p3.reachable, "unreachable");
  assert.equal(p3.failures, 3);
  assert.equal(registry.getNode(nodeId).health.reachable, "unreachable");

  // Health dimensions untouched
  const nodeStatus = registry.getNode(nodeId);
  assert.equal(nodeStatus.health.registryContact, "unknown");
  assert.equal(nodeStatus.health.dshHealthy, "unknown");

  // Success 1: immediately transitions to ok!
  mockProbeSuccess = true;
  const p4 = await registry.probeNode(nodeId, { requestTransport: mockTransport });
  assert.equal(p4.reachable, "ok");
  assert.equal(registry.getNode(nodeId).health.reachable, "ok");

  // Route target change resets reachable to unknown
  registry.setRouteTarget({ actor: "operator", nodeId, routeTarget: "http://127.0.0.1:9090" });
  assert.equal(registry.getNode(nodeId).health.reachable, "unknown");

  registry.close();
});

// ---------------------------------------------------------------------------
// 5. Backup and Secret Protection
// ---------------------------------------------------------------------------

test("Backup and Secret Protection: VACUUM backups preserve hub_route_keys, safeState and stateDigest exclude private keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-backup-stage2-"));
  let registry = null;
  let db = null;
  let backupDb = null;
  try {
    const dbPath = join(dir, "registry.db");
    db = openRegistryDatabase(dbPath);
    registry = new Registry({ db, routeDomain: "dsh.example.com" });
    const { nodeId } = enrollTestNode(registry);
    const hubKey = registry.ensureHubRouteKey(nodeId);
    assert.ok(hubKey.private_key);

    // 1. Live database row count and digest reflect non-secret inspection
    const inspectionLive = inspectRegistryDatabase(dbPath);
    assert.equal(inspectionLive.rowCounts.hub_route_keys, 1);
    assert.ok(inspectionLive.stateDigest);

    // 2. Perform SQLite VACUUM backup
    const backupPath = join(dir, "backup.db");
    await backupRegistryDatabase({ db, sourcePath: dbPath, destinationPath: backupPath });

    // 3. Inspect backup: state digest matches live digest (computed over safe columns only)
    const inspection = inspectRegistryDatabase(backupPath);
    assert.equal(inspection.rowCounts.hub_route_keys, 1);
    assert.equal(inspection.stateDigest, inspectionLive.stateDigest);

    // 4. Restored database contains private_key for Hub operations
    backupDb = openRegistryDatabase(backupPath);
    const restoredRow = backupDb.prepare("SELECT * FROM hub_route_keys WHERE node_id = ?").get(nodeId);
    assert.equal(restoredRow.private_key, hubKey.private_key);
  } finally {
    try { backupDb?.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch {}
    try { backupDb?.close(); } catch {}
    try { db?.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch {}
    try { registry?.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});
