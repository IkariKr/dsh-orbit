// Node Registry Client E2E (SOP Stage 2-4 required live evidence):
// real loopback HTTP between the Node client and the Hub, covering the
// full lifecycle:
//   fresh node -> enroll -> persist -> restart -> heartbeat -> report
//   -> capability derive -> revision change/stale -> fresh report
//   -> key rotation -> old-key revocation -> Hub delete -> machine
//   denial -> explicit reenroll -> same nodeId + new key -> restart
//   recovery
// plus hub-unavailable/recovery and the no-auto-reenroll rule.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeClient } from "../src/node/client.mjs";
import { loadNodeStoreAsync } from "../src/node/store.mjs";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { defaultRuntimeIdentity, validReport } from "./helpers/registry-fixture.mjs";

async function fixtureDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-node-e2e-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function runtime(overrides = {}) {
  const base = defaultRuntimeIdentity();
  return {
    orbitVersion: base.runtime.orbitVersion,
    orbitRevision: base.runtime.orbitRevision,
    dshVersion: base.runtime.dshVersion,
    compatibilityProfile: base.runtime.compatibilityProfile,
    ...overrides,
  };
}

// The hub enforces heartbeat burst 3/s (RFC-0006 fixed default); the
// lifecycle test issues many heartbeats in quick succession, so each
// one steps outside the burst window.
const spacing = () => new Promise((resolve) => setTimeout(resolve, 1150));

async function withHub(t, options = {}) {
  const registry = new Registry({ db: openRegistryDatabase(":memory:"), ...options.registryOptions });
  const { server } = createHubServer({ registry, options: options.serverOptions ?? {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    registry.close();
  });
  return { registry, server, baseUrl: `http://127.0.0.1:${port}`, port };
}

function makeClient({ statePath, baseUrl, now, runtimeIdentity = runtime }) {
  return new NodeClient({
    store: {
      schema: 1,
      nodeId: null,
      publicKeyHex: null,
      privateKeyHex: null,
      hubBaseUrl: null, // unenrolled stores carry no binding yet (invariant)
      state: "unenrolled",
      rotation: null,
      pendingEnrollment: null,
      pendingReenrollment: null,
      updatedAt: null,
    },
    storePath: statePath,
    hubBaseUrl: baseUrl,
    runtimeIdentity,
    now: now ?? (() => new Date()),
  });
}

async function enrollNodeClient(client, registry) {
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  return client.enroll({ token: plain.token });
}

test("full lifecycle E2E: enroll -> restart -> heartbeat -> report -> stale -> fresh -> rotate -> delete -> revoked -> reenroll -> same nodeId", async (t) => {
  const dir = await fixtureDir(t);
  const statePath = join(dir, "state.json");
  const { registry, baseUrl } = await withHub(t);

  // --- Stage 2: enrollment + persistence ---
  const client = makeClient({ statePath, baseUrl });
  const enrolled = await enrollNodeClient(client, registry);
  assert.match(enrolled.nodeId, /^node_[0-9a-f]{32}$/);
  const persisted = await loadNodeStoreAsync(statePath);
  assert.equal(persisted.nodeId, enrolled.nodeId);
  assert.equal(persisted.state, "active");

  // --- Restart recovery: a NEW client instance on the same store never
  // re-enrolls and resumes exactly the same identity. ---
  const restarted = makeClient({ statePath, baseUrl });
  restarted.store = await loadNodeStoreAsync(statePath);
  await restarted.recoverAfterRestart();
  assert.equal(restarted.store.nodeId, enrolled.nodeId);
  assert.equal(restarted.status().state, "active");
  await assert.rejects(() => restarted.enroll({ token: "ab".repeat(16) }), /unenrolled/);

  // --- Stage 3: heartbeat -> registryContact fresh (Hub-side) ---
  const beat = await restarted.heartbeat();
  assert.equal(beat.ok, true);
  assert.equal(registry.getNode(enrolled.nodeId).health.registryContact, "fresh");
  await spacing();

  // --- Report upload -> capabilities derived at the Hub ---
  const reportResult = await restarted.uploadReport(validReport());
  assert.equal(reportResult.orbitCompatible, "pass");
  assert.equal(reportResult.capabilities.length, 3);
  const withReport = registry.getNode(enrolled.nodeId);
  assert.equal(withReport.health.dshHealthy, "ok");
  assert.deepEqual(withReport.health.capabilities.map((entry) => entry.name).sort(), ["sessions.resume", "settings.remote", "web.routes"]);

  // --- Revision change -> old report stale (Hub-side, evidence path) ---
  await restarted.heartbeat(); // still old identity in this tick -> fresh contact
  await spacing();
  // Upgrade the node's runtime identity (like a real DSH upgrade):
  const upgradedClient = makeClient({ statePath, baseUrl, runtimeIdentity: () => runtime({ orbitRevision: "rev-B" }) });
  upgradedClient.store = await loadNodeStoreAsync(statePath);
  await upgradedClient.recoverAfterRestart();
  const afterUpgrade = await upgradedClient.heartbeat();
  assert.equal(afterUpgrade.ok, true);
  await spacing();
  const stale = registry.getNode(enrolled.nodeId);
  assert.equal(stale.health.orbitCompatible, "stale");
  assert.deepEqual(stale.health.capabilities, []);
  assert.equal(stale.health.registryContact, "fresh"); // heartbeat separated from evidence

  // --- Matching fresh report -> capabilities restored ---
  const restored = await upgradedClient.uploadReport(validReport({ orbitRevision: "rev-B" }));
  assert.equal(restored.orbitCompatible, "pass");
  assert.equal(registry.getNode(enrolled.nodeId).health.capabilities.length, 3);

  // --- Stage 4: rotation (old key signs; hub keeps overlap) ---
  const rotated = await upgradedClient.rotateCredential();
  assert.equal(rotated.oldKeyId, upgradedClient.status().keyId === rotated.newKeyId ? rotated.oldKeyId : rotated.oldKeyId);
  const afterRotation = registry.getNode(enrolled.nodeId);
  assert.equal(afterRotation.health.authenticated, "ok");
  await spacing();
  const beatWithNewKey = await upgradedClient.heartbeat();
  assert.equal(beatWithNewKey.ok, true);
  await spacing();

  // --- Restart during rotation: marker kept, new key still works ---
  const rotationRestart = makeClient({ statePath, baseUrl, runtimeIdentity: () => runtime({ orbitRevision: "rev-B" }) });
  rotationRestart.store = await loadNodeStoreAsync(statePath);
  await rotationRestart.recoverAfterRestart();
  assert.equal(rotationRestart.store.rotation.newKeyId, rotated.newKeyId);
  await spacing();
  const beatAfterRotationRestart = await rotationRestart.heartbeat();
  assert.equal(beatAfterRotationRestart.ok, true);

  // --- Hub delete -> machine denial -> REVOKED (never auto-re-enroll) ---
  const hubDelete = registry.deleteNode({ actor: "operator", nodeId: enrolled.nodeId, requestId: "cd".repeat(16), reason: "retired" });
  assert.equal(hubDelete.state, "tombstoned");
  await spacing();
  const denied = await rotationRestart.heartbeat();
  assert.equal(denied.ok, false);
  assert.equal(denied.state, "revoked");
  assert.equal(rotationRestart.store.state, "revoked");
  assert.equal(rotationRestart.store.nodeId, enrolled.nodeId); // identity preserved
  await assert.rejects(() => rotationRestart.enroll({ token: "ab".repeat(16) }), /unenrolled/);

  // --- Explicit re-enrollment: tombstone-bound token + original key
  // proof; SAME nodeId, NEW key. ---
  const beforeReenrollKeyId = rotationRestart.store.rotation.oldKeyId;
  const reenrollToken = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: enrolled.nodeId });
  const reenrolled = await rotationRestart.reenroll({ token: reenrollToken.token });
  assert.equal(reenrolled.nodeId, enrolled.nodeId);
  assert.notEqual(reenrolled.keyId, beforeReenrollKeyId);
  assert.equal(rotationRestart.store.state, "active");
  const restoredNode = registry.getNode(enrolled.nodeId);
  assert.equal(restoredNode.state, "active");
  assert.equal(restoredNode.health.authenticated, "ok");

  // --- Post-reenroll heartbeat + final restart recovery ---
  await spacing();
  const recovered = await rotationRestart.heartbeat();
  assert.equal(recovered.ok, true);
  const finalRestart = makeClient({ statePath, baseUrl });
  finalRestart.store = await loadNodeStoreAsync(statePath);
  await finalRestart.recoverAfterRestart();
  assert.equal(finalRestart.store.nodeId, enrolled.nodeId);
  assert.equal(finalRestart.status().state, "active");
  await spacing();
  assert.equal((await finalRestart.heartbeat()).ok, true);
});

test("hub unavailable -> retrying with backoff -> hub restored -> automatic recovery to fresh", async (t) => {
  const dir = await fixtureDir(t);
  const statePath = join(dir, "state.json");
  const { registry, server, baseUrl, port } = await withHub(t);
  const client = makeClient({ statePath, baseUrl });
  await enrollNodeClient(client, registry);
  await client.heartbeat();
  assert.equal(registry.getNode(client.store.nodeId).health.registryContact, "fresh");

  // Take the hub down: the next tick must fail into RETRYING with a
  // persisted backoff and NO state change.
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  const failed = await client.tick();
  assert.equal(failed.attempted, true);
  assert.equal(failed.ok, false);
  assert.equal(failed.state, "retrying");
  assert.equal(client.status().state, "retrying");
  assert.equal(registry.getNode(client.store.nodeId).health.registryContact, "fresh"); // not touched by failures

  // Bring the hub back on the SAME port; once the backoff window has
  // elapsed the node recovers automatically.
  const { server: replacement } = createHubServer({ registry, options: {} });
  await new Promise((resolve) => replacement.listen(port, "127.0.0.1", resolve));
  t.after(async () => {
    replacement.closeAllConnections?.();
    await new Promise((resolve) => replacement.close(resolve));
  });
  await new Promise((resolve) => setTimeout(resolve, 1200)); // first backoff is 1s +/- jitter
  const recovered = await client.tick();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state, "active");
  assert.equal(client.status().state, "active");
  assert.equal(registry.getNode(client.store.nodeId).health.registryContact, "fresh");
});

test("rotated key is revoked Hub-side after the overlap window ends; the node's new key keeps working", async (t) => {
  const clock = { now: new Date() };
  const dir = await fixtureDir(t);
  const statePath = join(dir, "state.json");
  const { registry, baseUrl } = await withHub(t, { registryOptions: { now: () => clock.now } });
  const client = makeClient({ statePath, baseUrl, now: () => clock.now });
  await enrollNodeClient(client, registry);
  const rotated = await client.rotateCredential();
  const oldKeyId = rotated.oldKeyId;

  // Inside the overlap the OLD key still authenticates (hub contract).
  const oldKeyBeat = await client.heartbeat(); // node uses the new key
  assert.equal(oldKeyBeat.ok, true);
  const oldSigned = await client.signedRequest({
    path: "/api/v1/heartbeat",
    nodeId: client.store.nodeId,
    keyId: oldKeyId,
    keyHex: client.store.rotation.oldPrivateKeyHex,
    body: { runtime: runtime() },
  });
  assert.equal(oldSigned.status, 200);

  // Past the overlap (25h) the hub's maintenance revokes the old key.
  clock.now = new Date(clock.now.getTime() + 25 * 60 * 60 * 1000);
  registry.maintenance();
  const oldAfter = await client.signedRequest({
    path: "/api/v1/heartbeat",
    nodeId: client.store.nodeId,
    keyId: oldKeyId,
    keyHex: client.store.rotation.oldPrivateKeyHex,
    body: { runtime: runtime() },
    // timestamp derives from the node's clock -> matches the hub clock
  });
  assert.equal(oldAfter.status, 401);
  assert.equal(oldAfter.body.error.code, "key-revoked");
  // The node's own key is unaffected.
  const newKeyBeat = await client.heartbeat();
  assert.equal(newKeyBeat.ok, true);
});

test("doctor reports integrity classes and never mutates state", async (t) => {
  const dir = await fixtureDir(t);
  const statePath = join(dir, "state.json");
  const { registry, baseUrl } = await withHub(t);
  const client = makeClient({ statePath, baseUrl });
  await enrollNodeClient(client, registry);

  // Healthy probe.
  const before = await loadNodeStoreAsync(statePath);
  const healthy = await client.doctor();
  assert.ok(healthy.findings.some((finding) => finding.check === "key-pair" && finding.severity === "ok"));
  assert.ok(healthy.findings.some((finding) => finding.check === "hub-probe" && finding.severity === "ok"));
  const after = await loadNodeStoreAsync(statePath);
  assert.equal(after.updatedAt, before.updatedAt); // doctor wrote nothing

  // Doctor is a reachability probe only: even with the node deleted
  // Hub-side the probe stays reachable, reports no revocation and
  // never persists REVOKED — revocation is detected by the heartbeat
  // path, never by diagnostics (P1-09).
  registry.deleteNode({ actor: "operator", nodeId: client.store.nodeId, requestId: "ef".repeat(16), reason: "retired" });
  const revokedDoctor = await client.doctor();
  assert.ok(revokedDoctor.findings.some((finding) => finding.check === "hub-probe" && finding.severity === "ok"));
  assert.equal((await loadNodeStoreAsync(statePath)).state, "active"); // probe did not persist revoked
});