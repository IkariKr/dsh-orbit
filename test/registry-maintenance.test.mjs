// Batch A acceptance: registry.maintenance() is the time-based state
// machine for everything that no request pushes forward — contact
// aging, report staleness, retention, rollups, rotation expiry.

import assert from "node:assert/strict";
import test from "node:test";
import { randomHex } from "../src/registry/crypto.mjs";
import { createTestRegistry, createTestServer, defaultRuntimeIdentity, enrollNode, signedMachineRequest, signedReenrollRequest, validReport } from "./helpers/registry-fixture.mjs";

const CADENCE_MS = 60 * 1000;
const LOST_MS = 24 * 60 * 60 * 1000;

async function withClockServer(t, opts = {}) {
  const clock = { now: new Date() };
  const registry = createTestRegistry({ now: () => clock.now, ...opts });
  const server = await createTestServer(registry, {});
  t.after(async () => {
    await server.close();
    registry.close();
  });
  return { registry, server, clock };
}

test("maintenance runs without throwing and is idempotent on a fresh registry", async (t) => {
  const { registry, server } = await withClockServer(t);
  await enrollNode(server.baseUrl, registry);
  registry.maintenance();
  registry.maintenance();
  assert.equal(registry.listNodes().length, 1);
});

test("registryContact ages: fresh at 179s, stale at 181s, lost past 24h, reachable stays unknown", async (t) => {
  const { registry, server, clock } = await withClockServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const beat = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(),
  });
  assert.equal(beat.status, 200);
  assert.equal(registry.getNode(node.nodeId).health.registryContact, "fresh");

  clock.now = new Date(clock.now.getTime() + 179 * 1000);
  registry.maintenance();
  assert.equal(registry.getNode(node.nodeId).health.registryContact, "fresh");

  clock.now = new Date(clock.now.getTime() + 2 * 1000);
  registry.maintenance();
  const stale = registry.getNode(node.nodeId);
  assert.equal(stale.health.registryContact, "stale");
  assert.equal(stale.health.reachable, "unknown");
  // Transition events exist, and running again writes no duplicate event.
  const staleEvents = registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND dimension = 'registry_contact' AND to_value = 'stale'").get(node.nodeId).n;
  assert.equal(staleEvents, 1);
  registry.maintenance();
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND dimension = 'registry_contact' AND to_value = 'stale'").get(node.nodeId).n, 1);

  clock.now = new Date(clock.now.getTime() + LOST_MS);
  registry.maintenance();
  const lost = registry.getNode(node.nodeId);
  assert.equal(lost.health.registryContact, "lost");
  assert.deepEqual(lost.health.alertFlags, ["contact-lost"]);
  assert.equal(lost.health.reachable, "unknown");
});

test("a heartbeat after contact loss restores fresh and clears the alert flag", async (t) => {
  const { registry, server, clock } = await withClockServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(),
  });
  clock.now = new Date(clock.now.getTime() + LOST_MS + CADENCE_MS);
  registry.maintenance();
  assert.equal(registry.getNode(node.nodeId).health.registryContact, "lost");
  const beat = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(),
    timestamp: Math.trunc(clock.now.getTime() / 1000),
  });
  assert.equal(beat.status, 200);
  const recovered = registry.getNode(node.nodeId);
  assert.equal(recovered.health.registryContact, "fresh");
  assert.deepEqual(recovered.health.alertFlags, []);
});

test("report evidence ages: fresh at 6d23h, stale past 7 days with capabilities withheld", async (t) => {
  const { registry, server, clock } = await withClockServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const upload = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: validReport(),
  });
  assert.equal(upload.status, 200);
  assert.equal(upload.body.orbitCompatible, "pass");

  clock.now = new Date(clock.now.getTime() + (6 * 24 * 60 * 60 + 23 * 60 * 60) * 1000);
  registry.maintenance();
  let summary = registry.getNode(node.nodeId);
  assert.equal(summary.health.orbitCompatible, "pass");
  assert.equal(summary.health.capabilitiesStale, false);
  assert.equal(summary.health.capabilities.length, 3);

  clock.now = new Date(clock.now.getTime() + 2 * 60 * 60 * 1000);
  registry.maintenance();
  summary = registry.getNode(node.nodeId);
  assert.equal(summary.health.orbitCompatible, "stale");
  assert.equal(summary.health.capabilitiesStale, true);
  assert.deepEqual(summary.health.capabilities, []);
  assert.equal(summary.health.dshHealthy, "unknown");
  assert.equal(summary.health.reachable, "unknown");

  // A fresh report restores the state deterministically.
  const restored = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: validReport(),
    timestamp: Math.trunc(clock.now.getTime() / 1000),
  });
  assert.equal(restored.status, 200);
  summary = registry.getNode(node.nodeId);
  assert.equal(summary.health.orbitCompatible, "pass");
  assert.equal(summary.health.capabilitiesStale, false);
  assert.equal(summary.health.capabilities.length, 3);
  assert.equal(summary.health.dshHealthy, "ok");
});

test("a failed report stays failed by age; it never launders into stale-fresh", async (t) => {
  const { registry, server, clock } = await withClockServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const report = validReport();
  report.checks.globalPatch.status = "fail";
  await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: report,
  });
  clock.now = new Date(clock.now.getTime() + 8 * 24 * 60 * 60 * 1000);
  registry.maintenance();
  const summary = registry.getNode(node.nodeId);
  assert.equal(summary.health.orbitCompatible, "fail");
  assert.equal(summary.health.capabilitiesStale, true);
  assert.equal(summary.health.dshHealthy, "unknown");
});

test("retention classes purge and rotation keys revoke through maintenance", async (t) => {
  const { registry, server, clock } = await withClockServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const beat = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(),
  });
  assert.equal(beat.status, 200);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM seen_nonces WHERE node_id = ?").get(node.nodeId).n, 1);

  clock.now = new Date(clock.now.getTime() + 31 * 24 * 60 * 60 * 1000);
  registry.maintenance();
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM seen_nonces WHERE node_id = ?").get(node.nodeId).n, 0);
  // The heartbeat-sourced transition events from T0 were rolled up into
  // per-day summaries (this run's own contact-aging event stays raw).
  assert.equal(
    registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND dimension = 'registry_contact' AND source = 'heartbeat'").get(node.nodeId).n,
    0,
  );
  assert.ok(registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND dimension = 'rollup'").get(node.nodeId).n >= 1);

  // Past the 90-day retention everything, including summaries and the
  // aging events written along the way, is purged.
  clock.now = new Date(clock.now.getTime() + 91 * 24 * 60 * 60 * 1000);
  registry.maintenance();
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ?").get(node.nodeId).n, 0);
});

test("rotation overlap keys are revoked by maintenance at overlap end", async (t) => {
  const { registry, server, clock } = await withClockServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const { generateNodeKeyPair } = await import("../src/registry/crypto.mjs");
  const newKeys = generateNodeKeyPair();
  const rotated = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/credential-rotate",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { newPublicKey: newKeys.publicKeyHex },
  });
  assert.equal(rotated.status, 200);
  const oldRow = registry.db.prepare("SELECT state, revoked_at FROM node_keys WHERE node_id = ? AND key_id = ?").get(node.nodeId, node.keyId);
  assert.equal(oldRow.state, "active");

  clock.now = new Date(clock.now.getTime() + 25 * 60 * 60 * 1000);
  registry.maintenance();
  const after = registry.db.prepare("SELECT state, revoked_at, revocation_reason FROM node_keys WHERE node_id = ? AND key_id = ?").get(node.nodeId, node.keyId);
  assert.equal(after.state, "revoked");
  assert.equal(after.revocation_reason, "rotation-overlap-ended");
  assert.notEqual(after.revoked_at, null);
});

test("daily event rollups: events older than 7 days collapse into per-day summaries", async (t) => {
  const { registry, server, clock } = await withClockServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  // Fabricate raw events across two old days for one dimension.
  for (const day of ["2026-08-01", "2026-08-02"]) {
    for (const hour of [0, 6, 12]) {
      registry.db
        .prepare("INSERT INTO events (node_id, at, dimension, from_value, to_value, source) VALUES (?, ?, 'registry_contact', 'fresh', 'stale', 'maintenance')")
        .run(node.nodeId, `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`);
    }
  }
  clock.now = new Date("2026-08-30T00:00:00.000Z");
  registry.maintenance();
  const raw = registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND dimension = 'registry_contact'").get(node.nodeId).n;
  assert.equal(raw, 0);
  const summaries = registry.db.prepare("SELECT * FROM events WHERE node_id = ? AND dimension = 'rollup' ORDER BY at").all(node.nodeId);
  assert.equal(summaries.length, 2);
  assert.equal(JSON.parse(summaries[0].to_value).count, 3);
  assert.equal(JSON.parse(summaries[0].to_value).final, "stale");
  assert.equal(summaries[0].source, "retention-rollup");
  // Under 7 days events stay raw.
  clock.now = new Date();
  const recent = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(),
  });
  assert.equal(recent.status, 200);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND dimension = 'registry_contact'").get(node.nodeId).n, 1);
});

test("audit and enrollment_results retention purge through maintenance", async (t) => {
  const { registry, server, clock } = await withClockServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const results = registry.db.prepare("SELECT COUNT(*) AS n FROM enrollment_results").get().n;
  const audits = registry.db.prepare("SELECT COUNT(*) AS n FROM audit").get().n;
  assert.equal(results, 1);
  assert.ok(audits >= 2);
  clock.now = new Date(clock.now.getTime() + 366 * 24 * 60 * 60 * 1000);
  registry.maintenance();
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM enrollment_results").get().n, 0);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM audit").get().n, 0);
});

test("reenroll tokens obey the same retention maintenance as enrollment", async (t) => {
  const { registry, server, clock } = await withClockServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  deleteNode(registry, node.nodeId);
  const newKeys = await import("../src/registry/crypto.mjs").then((mod) => mod.generateNodeKeyPair());
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: node.nodeId });
  const completed = await signedReenrollRequest(server.baseUrl, {
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: { reenrollmentToken: minted.token, reenrollmentRequestId: randomHex(16), newPublicKey: newKeys.publicKeyHex },
  });
  assert.equal(completed.status, 200);
  clock.now = new Date(clock.now.getTime() + 91 * 24 * 60 * 60 * 1000);
  registry.maintenance();
  const results = registry.db.prepare("SELECT COUNT(*) AS n FROM enrollment_results WHERE kind = 'reenroll'").get().n;
  assert.equal(results, 0);
});

async function deleteNode(registry, nodeId) {
  const { deleteNode: fixtureDelete } = await import("./helpers/registry-fixture.mjs");
  return fixtureDelete(registry, nodeId);
}

void CADENCE_MS;