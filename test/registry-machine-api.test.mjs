import assert from "node:assert/strict";
import test from "node:test";
import { generateNodeKeyPair, randomHex, sha256Hex, signSigningString } from "../src/registry/crypto.mjs";
import { buildSigningString, MACHINE_V1_LABEL } from "../src/registry/protocol.mjs";
import { createTestRegistry, createTestServer, defaultRuntimeIdentity, deleteNode, enrollNode, signedMachineRequest, validReport } from "./helpers/registry-fixture.mjs";

async function withServer(t, options = {}) {
  const registry = createTestRegistry(options.registryOptions);
  const server = await createTestServer(registry, options.serverOptions);
  t.after(async () => {
    await server.close();
    registry.close();
  });
  return { registry, server };
}

test("machine route with a query string is denied before anything else", async (t) => {
  const { server } = await withServer(t);
  const response = await fetch(server.baseUrl + "/api/v1/heartbeat?x=1", { method: "POST" });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "query-not-allowed");
});

test("unknown machine routes are 404 and wrong methods are 405", async (t) => {
  const { server } = await withServer(t);
  const missing = await fetch(server.baseUrl + "/api/v1/update-capabilities", { method: "POST", body: "{}" });
  assert.equal(missing.status, 404);
  const wrongMethod = await fetch(server.baseUrl + "/api/v1/heartbeat", { method: "GET" });
  assert.equal(wrongMethod.status, 405);
});

test("missing machine headers are 400", async (t) => {
  const { registry, server } = await withServer(t);
  await enrollNode(server.baseUrl, registry);
  const response = await fetch(server.baseUrl + "/api/v1/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(defaultRuntimeIdentity()),
  });
  assert.equal(response.status, 400);
});

test("timestamp outside the 30s skew window is denied", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const { status, body } = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(),
    timestamp: Math.trunc(Date.now() / 1000) - 60,
  });
  assert.equal(status, 401);
  assert.equal(body.error.code, "timestamp-out-of-skew");
});

test("a body modified after signing fails the body-hash check", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const rawA = Buffer.from(JSON.stringify(defaultRuntimeIdentity({ dshVersion: "0.1.1-rc.2" })));
  const rawB = Buffer.from(JSON.stringify(defaultRuntimeIdentity({ dshVersion: "0.9.9" })));
  const ts = String(Math.trunc(Date.now() / 1000));
  const nonce = randomHex(16);
  const signing = buildSigningString({
    label: MACHINE_V1_LABEL,
    method: "POST",
    path: "/api/v1/heartbeat",
    timestamp: ts,
    nonce,
    bodyHash: sha256Hex(rawA),
    nodeId: node.nodeId,
  });
  const signature = signSigningString(node.privateKeyHex, signing);
  const response = await fetch(server.baseUrl + "/api/v1/heartbeat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-orbit-node": node.nodeId,
      "x-orbit-timestamp": ts,
      "x-orbit-nonce": nonce,
      "x-orbit-key": node.keyId,
      "x-orbit-signature": signature,
    },
    body: rawB,
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "signature-invalid");
});

test("replayed nonce is denied (transactional reservation)", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const nonce = randomHex(16);
  const first = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(),
    nonce,
  });
  assert.equal(first.status, 200);
  const replay = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(),
    nonce,
  });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, "replay");
});

test("unknown and revoked keys are denied", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const other = generateNodeKeyPair();
  const unknownKey = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: randomHex(16),
    keyHex: other.privateKeyHex,
    body: defaultRuntimeIdentity(),
  });
  assert.equal(unknownKey.status, 401);
  assert.equal(unknownKey.body.error.code, "unknown-key");

  deleteNode(registry, node.nodeId);
  const revokedNode = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(),
  });
  assert.equal(revokedNode.status, 401);
  assert.equal(revokedNode.body.error.code, "revoked");
});

test("heartbeat moves registryContact only; reachable stays unknown; never touches capabilities", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const { status, body } = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(),
  });
  assert.equal(status, 200);
  assert.equal(body.registryContact, "fresh");
  const summary = registry.getNode(node.nodeId);
  assert.equal(summary.health.registryContact, "fresh");
  assert.equal(summary.health.reachable, "unknown");
  assert.equal(summary.health.capabilitiesStale, true);
  assert.equal(summary.health.capabilities.length, 0);
});

test("runtime identity mismatch flags the latest report stale (capabilities withheld until a fresh report)", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const uploaded = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: validReport(),
  });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.capabilities.length, 3);
  assert.equal(registry.getNode(node.nodeId).health.capabilitiesStale, false);

  // Node upgrades: heartbeat carries the new revision; the report is stale.
  const heartbeat = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity({ orbitRevision: "def456" }),
  });
  assert.equal(heartbeat.status, 200);
  const stale = registry.getNode(node.nodeId);
  assert.equal(stale.health.orbitCompatible, "stale");
  assert.equal(stale.health.capabilitiesStale, true);
  // Withheld semantics (P1-04): the ACTIVE capability set is empty; the
  // stored derived set is evidence only, never an active claim.
  assert.deepEqual(stale.health.capabilities, []);
  assert.equal(stale.health.capabilityEvidence.length, 3);
  assert.equal(stale.health.dshHealthy, "unknown");
  assert.equal(stale.health.reachable, "unknown");

  // A fresh report clears the staleness and recomputes capabilities.
  const refreshed = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: validReport({ orbitRevision: "def456" }),
  });
  assert.equal(refreshed.status, 200);
  const cleared = registry.getNode(node.nodeId);
  assert.equal(cleared.health.orbitCompatible, "pass");
  assert.equal(cleared.health.capabilitiesStale, false);
  assert.deepEqual(cleared.health.capabilities.map((entry) => entry.name).sort(), ["sessions.resume", "settings.remote", "web.routes"]);
  assert.equal(cleared.health.dshHealthy, "ok");
});

test("report upload with a failing check derives fail/degraded and withholds capabilities", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const report = validReport();
  report.checks.authorizationSmoke.status = "fail";
  const { status, body } = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: report,
  });
  assert.equal(status, 200);
  assert.equal(body.orbitCompatible, "fail");
  assert.equal(body.capabilities.some((entry) => entry.name === "settings.remote"), false);
  const summary = registry.getNode(node.nodeId);
  assert.equal(summary.health.orbitCompatible, "fail");
});

test("an invalid report is rejected without side effects", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const { status, body } = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { schemaVersion: 2, checks: { madeUpCheck: { status: "pass" } } },
  });
  assert.equal(status, 400);
  assert.match(body.error.message, /compatibility report:/);
  assert.equal(registry.getNode(node.nodeId).health.capabilitiesStale, true);
});

test("rotation: both keys authenticate inside the overlap; the old key dies at overlap end", async (t) => {
  const clock = { now: new Date() };
  const registry = createTestRegistry({ now: () => clock.now });
  const server = await createTestServer(registry, {});
  t.after(async () => {
    await server.close();
    registry.close();
  });
  const node = await enrollNode(server.baseUrl, registry);
  const newKeys = generateNodeKeyPair();
  const rotated = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/credential-rotate",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { newPublicKey: newKeys.publicKeyHex },
  });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.oldKeyId, node.keyId);

  // Inside the overlap both keys authenticate heartbeats.
  const oldKeyBeat = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(),
  });
  assert.equal(oldKeyBeat.status, 200);
  const newKeyBeat = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: rotated.body.newKeyId,
    keyHex: newKeys.privateKeyHex,
    body: defaultRuntimeIdentity(),
  });
  assert.equal(newKeyBeat.status, 200);

  // Advance past the 24h overlap; the old key is now outside its window.
  // (Pause so the route-level heartbeat burst bucket has reset; rate
  // limiting runs before authentication.)
  await new Promise((resolve) => setTimeout(resolve, 1100));
  clock.now = new Date(clock.now.getTime() + 25 * 60 * 60 * 1000);
  const ts = Math.trunc(clock.now.getTime() / 1000);
  const oldKeyAfter = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(),
    timestamp: ts,
  });
  assert.equal(oldKeyAfter.status, 401);
  assert.equal(oldKeyAfter.body.error.code, "key-revoked");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const newKeyAfter = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: rotated.body.newKeyId,
    keyHex: newKeys.privateKeyHex,
    body: defaultRuntimeIdentity(),
    timestamp: ts,
  });
  assert.equal(newKeyAfter.status, 200);
});

test("heartbeat burst limit trips (1/s average, burst 3)", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const results = [];
  for (let index = 0; index < 4; index += 1) {
    results.push(
      await signedMachineRequest(server.baseUrl, {
        path: "/api/v1/heartbeat",
        nodeId: node.nodeId,
        keyId: node.keyId,
        keyHex: node.privateKeyHex,
        body: defaultRuntimeIdentity(),
      }),
    );
  }
  assert.equal(results[0].status, 200);
  assert.equal(results[1].status, 200);
  assert.equal(results[2].status, 200);
  assert.equal(results[3].status, 429);
});

test("an authenticated 429 still consumes the nonce; the same signed request then replays as 401", async (t) => {
  // Protocol-level rate limiting runs AFTER authentication and the
  // nonce reservation (P1-06): a legitimately signed request that trips
  // the limit has consumed its nonce, so the identical signed request
  // can never be replayed.
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  // Three quick beats fill the burst...
  for (let index = 0; index < 3; index += 1) {
    const beat = await signedMachineRequest(server.baseUrl, {
      path: "/api/v1/heartbeat",
      nodeId: node.nodeId,
      keyId: node.keyId,
      keyHex: node.privateKeyHex,
      body: defaultRuntimeIdentity(),
    });
    assert.equal(beat.status, 200);
  }
  // ...and the fourth is rate-limited after authentication.
  const rawBody = Buffer.from(JSON.stringify(defaultRuntimeIdentity()));
  const ts = String(Math.trunc(Date.now() / 1000));
  const nonce = randomHex(16);
  const signing = buildSigningString({
    label: MACHINE_V1_LABEL,
    method: "POST",
    path: "/api/v1/heartbeat",
    timestamp: ts,
    nonce,
    bodyHash: sha256Hex(rawBody),
    nodeId: node.nodeId,
  });
  const signature = signSigningString(node.privateKeyHex, signing);
  const headers = {
    "content-type": "application/json",
    "x-orbit-node": node.nodeId,
    "x-orbit-timestamp": ts,
    "x-orbit-nonce": nonce,
    "x-orbit-key": node.keyId,
    "x-orbit-signature": signature,
  };
  const limited = await fetch(server.baseUrl + "/api/v1/heartbeat", { method: "POST", headers, body: rawBody });
  assert.equal(limited.status, 429);
  // The 429'd request has a persisted nonce reservation.
  const reserved = registry.db.prepare("SELECT COUNT(*) AS n FROM seen_nonces WHERE node_id = ?").get(node.nodeId).n;
  assert.equal(reserved, 4);
  // Replaying that exact signed request is a replay denial, not a
  // fresh acceptance.
  const replayed = await fetch(server.baseUrl + "/api/v1/heartbeat", { method: "POST", headers, body: rawBody });
  assert.equal(replayed.status, 401);
  assert.equal((await replayed.json()).error.code, "replay");
});

test("oversized bodies are 413 (heartbeat limit is 64 KiB)", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const big = { runtime: { orbitVersion: "x".repeat(70 * 1024), orbitRevision: null, dshVersion: "y", compatibilityProfile: null } };
  const { status, body } = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: big,
  });
  assert.equal(status, 413);
  assert.equal(body.error.code, "body-too-large");
});

test("identical enroll replays return the same result, and the per-token attempt cap stops the flood", async (t) => {
  const { registry, server } = await withServer(t);
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const keys = generateNodeKeyPair();
  const requestId = randomHex(16);
  const attempts = [];
  for (let index = 0; index < 11; index += 1) {
    const response = await fetch(server.baseUrl + "/api/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: plain.token, enrollmentRequestId: requestId, publicKey: keys.publicKeyHex }),
    });
    attempts.push(response.status);
  }
  // First succeeds; identical replays return the same result; the cap
  // stops the flood at the configured per-token limit (429 on #11).
  assert.equal(attempts[0], 200);
  assert.equal(attempts.filter((status) => status === 200).length, 10);
  assert.equal(attempts[10], 429);
});

test("a reenroll-purpose token is rejected on the enroll route", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  deleteNode(registry, node.nodeId);
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: node.nodeId });
  const response = await fetch(server.baseUrl + "/api/v1/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: minted.token, enrollmentRequestId: randomHex(16), publicKey: generateNodeKeyPair().publicKeyHex }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "purpose-mismatch");
});

test("no path canonicalization: a signature over a different path fails", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const ts = String(Math.trunc(Date.now() / 1000));
  const nonce = randomHex(16);
  const rawBody = Buffer.from(JSON.stringify(defaultRuntimeIdentity()));
  const signing = buildSigningString({
    label: MACHINE_V1_LABEL,
    method: "POST",
    path: "/api/v1/heartbeat/",
    timestamp: ts,
    nonce,
    bodyHash: sha256Hex(rawBody),
    nodeId: node.nodeId,
  });
  const signature = signSigningString(node.privateKeyHex, signing);
  const response = await fetch(server.baseUrl + "/api/v1/heartbeat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-orbit-node": node.nodeId,
      "x-orbit-timestamp": ts,
      "x-orbit-nonce": nonce,
      "x-orbit-key": node.keyId,
      "x-orbit-signature": signature,
    },
    body: rawBody,
  });
  assert.equal(response.status, 401);
});
test("latest report ordering is deterministic under a fixed clock (same-millisecond uploads)", async (t) => {
  // Round-2 P1: getLatestReport orders by (uploaded_at DESC, id DESC),
  // so same-millisecond uploads resolve by insertion order — never by
  // clock ambiguity.
  const frozen = new Date();
  const registry = createTestRegistry({ now: () => frozen });
  const server = await createTestServer(registry, {});
  t.after(async () => {
    await server.close();
    registry.close();
  });
  const node = await enrollNode(server.baseUrl, registry);
  const first = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: validReport({ orbitRevision: "rev-A" }),
  });
  assert.equal(first.status, 200);
  const second = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: validReport({ orbitRevision: "rev-B" }),
  });
  assert.equal(second.status, 200);
  const uploaded = registry.db.prepare("SELECT uploaded_at FROM reports WHERE node_id = ? ORDER BY id").all(node.nodeId);
  assert.equal(uploaded[0].uploaded_at, uploaded[1].uploaded_at);
  const detail = registry.getNode(node.nodeId);
  assert.equal(detail.latestReport.orbit.revision, "rev-B");
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE node_id = ?").get(node.nodeId).n, 2);
});

test("every report upload is an event, including identical re-uploads", async (t) => {
  // RFC-0009 "every report upload is an event" (round-2 P2): two
  // identical uploads produce two independent report events.
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const payload = validReport();
  for (let index = 0; index < 2; index += 1) {
    const response = await signedMachineRequest(server.baseUrl, {
      path: "/api/v1/report-upload",
      nodeId: node.nodeId,
      keyId: node.keyId,
      keyHex: node.privateKeyHex,
      body: payload,
    });
    assert.equal(response.status, 200);
  }
  const reportEvents = registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND dimension = 'report'").get(node.nodeId).n;
  assert.equal(reportEvents, 2);
});
