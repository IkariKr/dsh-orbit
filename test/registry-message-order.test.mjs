// Batch B acceptance: the heartbeat owns the current runtime identity;
// a delayed report can enter history but never overwrites it, never
// rewinds compatibility, and never revives capabilities.

import assert from "node:assert/strict";
import test from "node:test";
import { createTestRegistry, createTestServer, defaultRuntimeIdentity, enrollNode, signedMachineRequest, validReport } from "./helpers/registry-fixture.mjs";

async function withServer(t) {
  const registry = createTestRegistry();
  const server = await createTestServer(registry, {});
  t.after(async () => {
    await server.close();
    registry.close();
  });
  return { registry, server };
}

test("heartbeat rev-B then delayed report rev-A: runtime stays rev-B, report is history only, compatibility withheld", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);

  // 1. Node reports current runtime rev-B.
  const beat = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity({ orbitRevision: "rev-B" }),
  });
  assert.equal(beat.status, 200);
  assert.equal(registry.getNode(node.nodeId).runtimeIdentity.orbitRevision, "rev-B");

  // 2. A stale rev-A report arrives late (no ordering enforcement at the
  //    transport; the authority model must reject the downgrade).
  const oldReport = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: validReport({ orbitRevision: "rev-A" }),
  });
  assert.equal(oldReport.status, 200);
  assert.equal(oldReport.body.orbitCompatible, "stale");
  assert.deepEqual(oldReport.body.capabilities, []);

  const after = registry.getNode(node.nodeId);
  // Runtime identity is heartbeat-driven: the report did not overwrite it.
  assert.equal(after.runtimeIdentity.orbitRevision, "rev-B");
  assert.equal(after.runtimeIdentity.dshVersion, "0.1.1-rc.2");
  // The report entered history and is the latest report...
  assert.equal(after.latestReport.orbit.revision, "rev-A");
  // ...but the node is not "compatible": evidence is withheld.
  assert.equal(after.health.orbitCompatible, "stale");
  assert.equal(after.health.capabilitiesStale, true);
  assert.deepEqual(after.health.capabilities, []);
  assert.equal(after.health.dshHealthy, "unknown");
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE node_id = ?").get(node.nodeId).n, 1);
});

test("a fresh rev-B report afterwards restores pass and capabilities deterministically", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity({ orbitRevision: "rev-B" }),
  });
  await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: validReport({ orbitRevision: "rev-A" }),
  });
  const fresh = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: validReport({ orbitRevision: "rev-B" }),
  });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.orbitCompatible, "pass");
  assert.equal(fresh.body.capabilities.length, 3);

  const after = registry.getNode(node.nodeId);
  assert.equal(after.health.orbitCompatible, "pass");
  assert.equal(after.health.capabilitiesStale, false);
  assert.equal(after.health.capabilities.length, 3);
  assert.equal(after.health.dshHealthy, "ok");
  assert.equal(after.runtimeIdentity.orbitRevision, "rev-B");
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE node_id = ?").get(node.nodeId).n, 2);
});

test("the first report initializes the runtime identity when no heartbeat has ever arrived", async (t) => {
  // Documented authority-model rule (P1-05): enrollment -> first report
  // may initialize current runtime identity; heartbeats take over from
  // then on.
  const { registry, server } = await withServer(t);
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
  const after = registry.getNode(node.nodeId);
  assert.equal(after.runtimeIdentity.orbitRevision, "abc123");
  assert.equal(after.health.orbitCompatible, "pass");
});

test("a heartbeat after the first report takes over the runtime identity authority", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: validReport(), // identity rev abc123
  });
  const beat = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity({ orbitRevision: "def456" }),
  });
  assert.equal(beat.status, 200);
  const after = registry.getNode(node.nodeId);
  assert.equal(after.runtimeIdentity.orbitRevision, "def456");
  // The report (rev abc123) no longer matches the heartbeat runtime:
  // evidence is withheld until a matching report arrives.
  assert.equal(after.health.orbitCompatible, "stale");
  assert.deepEqual(after.health.capabilities, []);
});

test("registryContact is heartbeat-only: a report upload on a lost node keeps it lost", async (t) => {
  // Report uploads update the generic lastSeen, but they are NOT
  // registry contact: registryContact and the contact-lost alert flag
  // move only on heartbeat traffic (round-2 P1).
  const clock = { now: new Date() };
  const registry = createTestRegistry({ now: () => clock.now });
  const server = await createTestServer(registry, {});
  t.after(async () => {
    await server.close();
    registry.close();
  });
  const node = await enrollNode(server.baseUrl, registry);
  const beat = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: defaultRuntimeIdentity(), // identity abc123, matching the report below
  });
  assert.equal(beat.status, 200);

  // The node goes quiet for 25h: maintenance marks it lost.
  clock.now = new Date(clock.now.getTime() + 25 * 60 * 60 * 1000);
  registry.maintenance();
  let summary = registry.getNode(node.nodeId);
  assert.equal(summary.health.registryContact, "lost");
  assert.deepEqual(summary.health.alertFlags, ["contact-lost"]);

  // A report upload arrives while lost: lastSeen moves, registryContact
  // does not, and the alert flag is not cleared.
  const upload = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: validReport(),
    timestamp: Math.trunc(clock.now.getTime() / 1000),
  });
  assert.equal(upload.status, 200);
  summary = registry.getNode(node.nodeId);
  assert.equal(summary.health.registryContact, "lost");
  assert.deepEqual(summary.health.alertFlags, ["contact-lost"]);
  assert.equal(summary.health.lastSeenSource, "report-upload");
  assert.equal(summary.health.orbitCompatible, "pass");
});