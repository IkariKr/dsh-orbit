// Stage 2 automated test suite: Hub Route Identity, Route Ingress,
// Reachability state machine, Secret isolation, and Backup protection.

import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
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
import { NodeClient, isTrustedTransport } from "../src/node/client.mjs";
import { loadNodeStoreAsync, writeNodeStore } from "../src/node/store.mjs";
import { defaultRouteTransport } from "../src/registry/route-probe.mjs";
import { extendDefaultCaCertificates } from "../src/tls-trust.mjs";
import { GATEWAY_CERT_PEM, GATEWAY_KEY_PEM } from "./fixtures/gateway-identity.mjs";

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

test("Hub Route Key Lifecycle: Heartbeat ACK progression honors configured overlap and revokes on schedule", () => {
  const start = new Date("2026-09-03T00:00:00.000Z");
  const registry = createTestRegistry({
    routeDomain: "dsh.example.com",
    hubRouteOverlapDays: 7,
    now: () => start,
  });
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
  const rotateRes = registry.rotateHubRouteKey({ actor: "operator", nodeId });
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
  assert.equal(key1Rotating.overlapUntil, "2026-09-10T00:00:00.000Z");
  assert.equal(registry.getActiveHubRouteKey(nodeId).key_id, key2Id, "the new active key must be preferred over the rotating old key");

  // 6. Maintenance after overlap ends revokes key1
  registry.now = () => new Date("2026-09-11T00:00:00.000Z");
  registry.maintenance();

  const hb5 = sendHb([key2Id]);
  assert.equal(hb5.hubRouteKeys.length, 1);
  assert.equal(hb5.hubRouteKeys[0].keyId, key2Id);
  assert.equal(hb5.hubRouteKeys[0].state, "active");

  registry.close();
});

test("Hub route-key overlap configuration is integer-only and bounded to 1-30 days", () => {
  for (const value of [0, 31, 1.5, Number.NaN]) {
    assert.throws(
      () => createTestRegistry({ routeDomain: "dsh.example.com", hubRouteOverlapDays: value }),
      /hub route overlap must be an integer within 1-30 days/,
    );
  }
  const min = createTestRegistry({ routeDomain: "dsh.example.com", hubRouteOverlapDays: 1 });
  min.close();
  const max = createTestRegistry({ routeDomain: "dsh.example.com", hubRouteOverlapDays: 30 });
  max.close();
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

  // 8. A proof signed/bound for Node A cannot authenticate to Node B.
  const nodeB = "node_" + "ab".repeat(16);
  const crossNodeCheck = verifyRouteRequest({
    headers: signed.headers,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeB,
    expectedRouteAuthority: computeRouteAuthority(nodeB, "dsh.example.com"),
    getPublicKey: () => null,
    nonceCache: new RouteNonceCache(),
    nowMs,
  });
  assert.equal(crossNodeCheck.ok, false);
  assert.equal(crossNodeCheck.code, "node-mismatch");

  // 9. Forged signature -> 401 signature-invalid
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

  // 10. Invalid signatures must not reserve nonce-cache entries. The same
  // nonce remains usable by the first valid authenticated request, then
  // becomes a replay only after that success.
  const cacheAfterAuth = new RouteNonceCache();
  const authNonce = randomHex(16);
  const signedAfterAuth = signRouteRequest({
    privateKeyHex: activeKey.private_key,
    keyId: activeKey.key_id,
    nodeId,
    routeAuthority: authority,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    nowMs,
    nonce: authNonce,
  });
  const invalidFirst = verifyRouteRequest({
    headers: { ...signedAfterAuth.headers, "x-orbit-route-signature": "f".repeat(128) },
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey,
    nonceCache: cacheAfterAuth,
    nowMs,
  });
  assert.equal(invalidFirst.code, "signature-invalid");
  const firstValid = verifyRouteRequest({
    headers: signedAfterAuth.headers,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey,
    nonceCache: cacheAfterAuth,
    nowMs,
  });
  assert.equal(firstValid.ok, true);
  const replayAfterValid = verifyRouteRequest({
    headers: signedAfterAuth.headers,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey,
    nonceCache: cacheAfterAuth,
    nowMs,
  });
  assert.equal(replayAfterValid.code, "replay");

  // 11. During route-key rotation overlap both new active and old rotating
  // keys authenticate; once overlap expires, only the new active key does.
  const nextKey = generateNodeKeyPair();
  const nextKeyId = deriveKeyId(nextKey.publicKeyHex);
  const overlapUntil = new Date(nowMs + 1_000).toISOString();
  const rotatingTrust = (kid) => {
    if (kid === activeKey.key_id) {
      return { keyId: activeKey.key_id, publicKey: activeKey.public_key, state: "rotating", overlapUntil };
    }
    if (kid === nextKeyId) {
      return { keyId: nextKeyId, publicKey: nextKey.publicKeyHex, state: "active", overlapUntil: null };
    }
    return null;
  };
  const oldDuringOverlap = signRouteRequest({
    privateKeyHex: activeKey.private_key,
    keyId: activeKey.key_id,
    nodeId,
    routeAuthority: authority,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    nowMs,
    nonce: randomHex(16),
  });
  const newDuringOverlap = signRouteRequest({
    privateKeyHex: nextKey.privateKeyHex,
    keyId: nextKeyId,
    nodeId,
    routeAuthority: authority,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    nowMs,
    nonce: randomHex(16),
  });
  assert.equal(
    verifyRouteRequest({
      headers: oldDuringOverlap.headers,
      method: "GET",
      rawTarget: "/_orbit/route-ready",
      expectedNodeId: nodeId,
      expectedRouteAuthority: authority,
      getPublicKey: rotatingTrust,
      nonceCache: new RouteNonceCache(),
      nowMs,
    }).ok,
    true,
  );
  assert.equal(
    verifyRouteRequest({
      headers: newDuringOverlap.headers,
      method: "GET",
      rawTarget: "/_orbit/route-ready",
      expectedNodeId: nodeId,
      expectedRouteAuthority: authority,
      getPublicKey: rotatingTrust,
      nonceCache: new RouteNonceCache(),
      nowMs,
    }).ok,
    true,
  );
  const oldAfterOverlap = verifyRouteRequest({
    headers: oldDuringOverlap.headers,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey: rotatingTrust,
    nonceCache: new RouteNonceCache(),
    nowMs: nowMs + 2_000,
  });
  assert.equal(oldAfterOverlap.ok, false);
  assert.equal(oldAfterOverlap.code, "key-revoked");

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
    forwardHttpEnabled: false,
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

    // 5. P2-1: Route ingress strictly rejects request with query string
    const resQuery = await fetch(`http://127.0.0.1:${port}/_orbit/route-ready?unsigned=1`, {
      method: "GET",
      headers: { ...signed1.headers, "x-orbit-route-authority": authority },
    });
    assert.equal(resQuery.status, 404);
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

test("Reachability ignores an in-flight probe result after route target or route identity changes", async () => {
  const registry = createTestRegistry({ routeDomain: "dsh.example.com" });
  const { nodeId } = enrollTestNode(registry);
  registry.setRouteTarget({ actor: "operator", nodeId, routeTarget: "http://127.0.0.1:8080" });
  const firstHubKey = registry.ensureHubRouteKey(nodeId);
  registry.acknowledgeHubRouteKeys(nodeId, [firstHubKey.key_id]);

  let releaseProbe;
  const deferredTransport = async () =>
    new Promise((resolve) => {
      releaseProbe = () => resolve({ status: 200, body: JSON.stringify({ nodeId, ready: true }) });
    });

  const oldProbe = registry.probeNode(nodeId, { requestTransport: deferredTransport });
  while (!releaseProbe) await new Promise((resolve) => setTimeout(resolve, 1));

  registry.setRouteTarget({ actor: "operator", nodeId, routeTarget: "http://127.0.0.1:8081" });
  assert.equal(registry.getNode(nodeId).health.reachable, "unknown");

  releaseProbe();
  const oldResult = await oldProbe;
  assert.equal(oldResult.ignored, true);
  assert.equal(oldResult.reason, "probe-context-changed");
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

// ---------------------------------------------------------------------------
// 6. Remediation Security & Contract Tests (Review Report Findings)
// ---------------------------------------------------------------------------

test("P1-2 & P3-1: Heartbeat redirect fails closed and loopback trust is consistent", async () => {
  // Loopback trust consistency
  assert.equal(isTrustedTransport("http://127.0.0.1:5445"), true);
  assert.equal(isTrustedTransport("http://[::1]:5445"), true);
  assert.equal(isTrustedTransport("http://localhost:5445"), false);
  assert.equal(isTrustedTransport("http://nas.example.com:5445"), false);
  assert.equal(isTrustedTransport("https://nas.example.com:5445"), true);

  // Redirect test
  const dir = await mkdtemp(join(tmpdir(), "orbit-redirect-test-"));
  try {
    const statePath = join(dir, "node.json");
    const kA = generateNodeKeyPair();
    const fakeStore = {
      schema: 1,
      nodeId: "node_" + "33".repeat(16),
      publicKeyHex: kA.publicKeyHex,
      privateKeyHex: kA.privateKeyHex,
      hubBaseUrl: "http://127.0.0.1:5445/",
      hubRouteKeys: null,
      state: "active",
      rotation: null,
      pendingEnrollment: null,
      pendingReenrollment: null,
      updatedAt: new Date().toISOString(),
    };
    await writeNodeStore(statePath, fakeStore);

    const kB = generateNodeKeyPair();
    const idB = deriveKeyId(kB.publicKeyHex);

    const redirectFetch = async () => {
      return {
        status: 302,
        headers: { location: "http://127.0.0.1:9999/api/v1/heartbeat" },
        url: "http://127.0.0.1:9999/api/v1/heartbeat",
        json: async () => ({
          registryContact: "fresh",
          hubRouteKeys: [{ keyId: idB, publicKey: kB.publicKeyHex, state: "provisioned", overlapUntil: null }],
        }),
      };
    };

    const client = new NodeClient({
      store: fakeStore,
      storePath: statePath,
      hubBaseUrl: "http://127.0.0.1:5445/",
      fetchImpl: redirectFetch,
      runtimeIdentity: () => ({ orbitVersion: "0.4.0", dshVersion: "1.0.0" }),
    });

    const result = await client.heartbeat();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "redirect-denied");
    assert.equal(client.getHubRouteKeys().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("P1-2: production machine transport refuses real redirects and accepts a private-CA HTTPS Hub only with the configured CA", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-machine-transport-test-"));
  let redirectServer = null;
  let redirectedServer = null;
  let httpsServer = null;
  try {
    const nodeKeys = generateNodeKeyPair();
    const hubRouteKey = generateNodeKeyPair();
    const hubRouteKeyId = deriveKeyId(hubRouteKey.publicKeyHex);
    const makeStore = (hubBaseUrl, suffix) => ({
      schema: 1,
      nodeId: `node_${suffix.repeat(32)}`,
      publicKeyHex: nodeKeys.publicKeyHex,
      privateKeyHex: nodeKeys.privateKeyHex,
      hubBaseUrl,
      hubRouteKeys: null,
      state: "active",
      rotation: null,
      pendingEnrollment: null,
      pendingReenrollment: null,
      updatedAt: new Date().toISOString(),
    });
    const heartbeatBody = JSON.stringify({
      registryContact: "fresh",
      hubRouteKeys: [
        { keyId: hubRouteKeyId, publicKey: hubRouteKey.publicKeyHex, state: "provisioned", overlapUntil: null },
      ],
    });

    // Real redirect path: the default production transport must not follow it.
    let redirectedHit = false;
    redirectedServer = http.createServer((req, res) => {
      redirectedHit = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(heartbeatBody);
    });
    await new Promise((resolve) => redirectedServer.listen(0, "127.0.0.1", resolve));
    const redirectedPort = redirectedServer.address().port;

    redirectServer = http.createServer((req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${redirectedPort}/api/v1/heartbeat` });
      res.end();
    });
    await new Promise((resolve) => redirectServer.listen(0, "127.0.0.1", resolve));
    const redirectPort = redirectServer.address().port;
    const redirectBaseUrl = `http://127.0.0.1:${redirectPort}/`;
    const redirectStatePath = join(dir, "redirect-node.json");
    const redirectStore = makeStore(redirectBaseUrl, "5");
    await writeNodeStore(redirectStatePath, redirectStore);
    const redirectClient = new NodeClient({
      store: redirectStore,
      storePath: redirectStatePath,
      hubBaseUrl: redirectBaseUrl,
      runtimeIdentity: () => ({ orbitVersion: "0.4.0", dshVersion: "1.0.0" }),
    });
    const redirectResult = await redirectClient.heartbeat();
    assert.equal(redirectResult.ok, false);
    assert.equal(redirectResult.error.code, "redirect-denied");
    assert.equal(redirectedHit, false, "production machine transport must not follow a Hub redirect");
    assert.deepEqual(redirectClient.getHubRouteKeys(), []);

    // Real HTTPS path with a self-signed private CA leaf. The same connection
    // must fail without the configured CA and succeed with it; hostname/SAN
    // verification remains enabled by Node TLS.
    httpsServer = https.createServer({ key: GATEWAY_KEY_PEM, cert: GATEWAY_CERT_PEM }, (req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(heartbeatBody);
    });
    await new Promise((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
    const httpsPort = httpsServer.address().port;
    const httpsBaseUrl = `https://127.0.0.1:${httpsPort}/`;

    const noCaStatePath = join(dir, "https-no-ca.json");
    const noCaStore = makeStore(httpsBaseUrl, "6");
    await writeNodeStore(noCaStatePath, noCaStore);
    const noCaClient = new NodeClient({
      store: noCaStore,
      storePath: noCaStatePath,
      hubBaseUrl: httpsBaseUrl,
      runtimeIdentity: () => ({ orbitVersion: "0.4.0", dshVersion: "1.0.0" }),
    });
    const noCaResult = await noCaClient.heartbeat();
    assert.equal(noCaResult.ok, false);
    assert.equal(noCaResult.error.code, "network");
    assert.deepEqual(noCaClient.getHubRouteKeys(), []);

    const caStatePath = join(dir, "https-with-ca.json");
    const caStore = makeStore(httpsBaseUrl, "7");
    await writeNodeStore(caStatePath, caStore);
    const caClient = new NodeClient({
      store: caStore,
      storePath: caStatePath,
      hubBaseUrl: httpsBaseUrl,
      caCertificates: [GATEWAY_CERT_PEM],
      runtimeIdentity: () => ({ orbitVersion: "0.4.0", dshVersion: "1.0.0" }),
    });
    const caResult = await caClient.heartbeat();
    assert.equal(caResult.ok, true);
    assert.equal(caClient.getHubRouteKeys()[0].keyId, hubRouteKeyId);

    // The same trusted certificate must still fail if the configured Hub
    // hostname is not present in its SAN set.
    const wrongSanBaseUrl = `https://localhost:${httpsPort}/`;
    const wrongSanStatePath = join(dir, "https-wrong-san.json");
    const wrongSanStore = makeStore(wrongSanBaseUrl, "8");
    await writeNodeStore(wrongSanStatePath, wrongSanStore);
    const wrongSanClient = new NodeClient({
      store: wrongSanStore,
      storePath: wrongSanStatePath,
      hubBaseUrl: wrongSanBaseUrl,
      caCertificates: [GATEWAY_CERT_PEM],
      runtimeIdentity: () => ({ orbitVersion: "0.4.0", dshVersion: "1.0.0" }),
    });
    const wrongSanResult = await wrongSanClient.heartbeat();
    assert.equal(wrongSanResult.ok, false);
    assert.equal(wrongSanResult.error.code, "network");
    assert.deepEqual(wrongSanClient.getHubRouteKeys(), []);
  } finally {
    if (redirectServer) await new Promise((resolve) => redirectServer.close(resolve));
    if (redirectedServer) await new Promise((resolve) => redirectedServer.close(resolve));
    if (httpsServer) await new Promise((resolve) => httpsServer.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("P1-3: Reenrollment atomically clears deleted-era Hub route keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-reenroll-test-"));
  try {
    const statePath = join(dir, "node.json");
    const k1 = generateNodeKeyPair();
    const hubKey1 = generateNodeKeyPair();
    const hubKey1Id = deriveKeyId(hubKey1.publicKeyHex);

    const revokedStore = {
      schema: 1,
      nodeId: "node_" + "44".repeat(16),
      publicKeyHex: k1.publicKeyHex,
      privateKeyHex: k1.privateKeyHex,
      hubBaseUrl: "http://127.0.0.1:5445/",
      hubRouteKeys: [{ keyId: hubKey1Id, publicKey: hubKey1.publicKeyHex, state: "active", overlapUntil: null }],
      state: "revoked",
      rotation: null,
      pendingEnrollment: null,
      pendingReenrollment: null,
      updatedAt: new Date().toISOString(),
    };
    await writeNodeStore(statePath, revokedStore);

    const client = new NodeClient({
      store: revokedStore,
      storePath: statePath,
      hubBaseUrl: "http://127.0.0.1:5445/",
      fetchImpl: async (url, opts) => {
        const parsed = JSON.parse(opts.body.toString());
        return {
          status: 200,
          json: async () => ({
            nodeId: revokedStore.nodeId,
            keyId: deriveKeyId(parsed.newPublicKey),
          }),
        };
      },
      runtimeIdentity: () => ({ orbitVersion: "0.4.0", dshVersion: "1.0.0" }),
    });

    const ingress = new RouteIngress({
      nodeId: () => client.store.nodeId,
      getTrustKeys: () => client.getHubRouteKeys(),
      getNodeState: () => client.store.state,
    });
    client.routeIngress = ingress;

    // Before reenroll: revoked, trust keys contains hubKey1
    assert.equal(client.getHubRouteKeys().length, 1);

    // Reenroll
    await client.reenroll({ token: "a".repeat(32) });
    assert.equal(client.store.state, "active");

    // Immediately after reenroll: deleted-era hubRouteKeys must be EMPTY!
    assert.deepEqual(client.getHubRouteKeys(), []);
    assert.equal(client.store.hubRouteKeys, null);

    // Old hubKey1 must NOT be accepted by route ingress!
    const authority = computeRouteAuthority(revokedStore.nodeId, "localhost");
    const oldSigned = signRouteRequest({
      privateKeyHex: hubKey1.privateKeyHex,
      keyId: hubKey1Id,
      nodeId: revokedStore.nodeId,
      routeAuthority: authority,
      method: "GET",
      rawTarget: "/_orbit/route-ready",
      nonce: randomHex(16),
    });
    const checkOld = verifyRouteRequest({
      headers: oldSigned.headers,
      method: "GET",
      rawTarget: "/_orbit/route-ready",
      expectedNodeId: revokedStore.nodeId,
      expectedRouteAuthority: authority,
      getPublicKey: (kid) => client.getHubRouteKeys().find((k) => k.keyId === kid) || null,
      nonceCache: new RouteNonceCache(),
    });
    assert.equal(checkOld.ok, false);
    assert.equal(checkOld.code, "unknown-key");

    // A crash/restart before the first post-reenrollment heartbeat must not
    // revive deleted-era Hub trust from disk.
    const reloaded = await loadNodeStoreAsync(statePath);
    assert.equal(reloaded.state, "active");
    assert.equal(reloaded.hubRouteKeys, null);
    const restarted = new NodeClient({
      store: reloaded,
      storePath: statePath,
      hubBaseUrl: reloaded.hubBaseUrl,
      fetchImpl: async () => ({ status: 503, json: async () => ({}) }),
      runtimeIdentity: () => ({ orbitVersion: "0.4.0", dshVersion: "1.0.0" }),
    });
    assert.deepEqual(restarted.getHubRouteKeys(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("P3-2: Node tombstoning resets reachable to unknown", () => {
  const registry = createTestRegistry({ routeDomain: "dsh.example.com" });
  const { nodeId } = enrollTestNode(registry);
  registry.setRouteTarget({ actor: "operator", nodeId, routeTarget: "http://127.0.0.1:8080" });
  registry.recordProbeResult(nodeId, true);
  assert.equal(registry.getNode(nodeId).health.reachable, "ok");

  registry.deleteNode({ actor: "operator", nodeId, requestId: randomHex(16), reason: "operator delete" });
  assert.equal(registry.getNode(nodeId).health.reachable, "unknown");

  registry.close();
});

test("P2-3: configured private CAs extend, rather than replace, the runtime default trust set", () => {
  const defaults = typeof tls.getCACertificates === "function" ? tls.getCACertificates("default") : tls.rootCertificates;
  const effective = extendDefaultCaCertificates([GATEWAY_CERT_PEM]);
  assert.ok(Array.isArray(effective));
  assert.equal(effective.length, defaults.length + 1);
  assert.deepEqual(effective.slice(0, defaults.length), defaults);
  assert.equal(effective.at(-1), GATEWAY_CERT_PEM);
  assert.equal(extendDefaultCaCertificates(null), undefined);
});
