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

test("controlled contact aging is isolated from wall-clock auth, reports, and another node", async (t) => {
  const wall = { now: new Date("2026-08-31T00:00:00.000Z") };
  const contactClocks = new Map();
  const registry = createTestRegistry({
    now: () => wall.now,
    registryContactNow: (node) => contactClocks.get(node.node_id) ?? wall.now,
  });
  const server = await createTestServer(registry, {});
  t.after(async () => {
    await server.close();
    registry.close();
  });

  const a = await enrollNode(server.baseUrl, registry);
  const b = await enrollNode(server.baseUrl, registry);
  const timestamp = () => Math.trunc(wall.now.getTime() / 1000);
  for (const node of [a, b]) {
    const heartbeat = await signedMachineRequest(server.baseUrl, {
      path: "/api/v1/heartbeat",
      nodeId: node.nodeId,
      keyId: node.keyId,
      keyHex: node.privateKeyHex,
      body: defaultRuntimeIdentity(),
      timestamp: timestamp(),
    });
    assert.equal(heartbeat.status, 200);
    const report = await signedMachineRequest(server.baseUrl, {
      path: "/api/v1/report-upload",
      nodeId: node.nodeId,
      keyId: node.keyId,
      keyHex: node.privateKeyHex,
      body: validReport(),
      timestamp: timestamp(),
    });
    assert.equal(report.status, 200);
  }
  contactClocks.set(a.nodeId, wall.now);
  contactClocks.set(b.nodeId, wall.now);
  registry.maintenance();

  // Only A's private contact-aging clock advances. Production constants are
  // still the fixed 60s cadence, 3 missed beats, and 24h lost threshold.
  const aLastHeartbeat = Date.parse(registry.getNode(a.nodeId).health.lastHeartbeatAt);
  contactClocks.set(a.nodeId, new Date(aLastHeartbeat + 181 * 1000));
  registry.maintenance();
  assert.equal(registry.getNode(a.nodeId).health.registryContact, "stale");
  assert.equal(registry.getNode(b.nodeId).health.registryContact, "fresh");
  assert.deepEqual(registry.getNode(b.nodeId).health.capabilities.map((entry) => entry.name).sort(), ["sessions.resume", "settings.remote", "web.routes"]);

  contactClocks.set(a.nodeId, new Date(aLastHeartbeat + LOST_MS + 1));
  registry.maintenance();
  assert.equal(registry.getNode(a.nodeId).health.registryContact, "lost");
  assert.deepEqual(registry.getNode(a.nodeId).health.alertFlags, ["contact-lost"]);
  assert.equal(registry.getNode(b.nodeId).health.registryContact, "fresh");

  // The accelerated clock is not used for machine timestamp validation or
  // report timestamps: both requests carry the current wall-clock time and
  // are accepted while A remains contact-lost.
  const reportWhileLost = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: a.nodeId,
    keyId: a.keyId,
    keyHex: a.privateKeyHex,
    body: validReport(),
    timestamp: timestamp(),
  });
  assert.equal(reportWhileLost.status, 200);
  assert.equal(registry.getNode(a.nodeId).health.registryContact, "lost");
  assert.equal(registry.getNode(a.nodeId).health.capabilities.length, 3);

  // Reset the drill-only clock before reconnect. Maintenance is aging-only:
  // moving the contact clock backwards must NOT heal a stale/lost node.
  // Only the subsequent authenticated heartbeat may restore fresh.
  contactClocks.set(a.nodeId, wall.now);
  registry.maintenance();
  assert.equal(registry.getNode(a.nodeId).health.registryContact, "lost");
  assert.deepEqual(registry.getNode(a.nodeId).health.alertFlags, ["contact-lost"]);
  assert.equal(registry.getNode(b.nodeId).health.registryContact, "fresh");

  const reconnect = await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: a.nodeId,
    keyId: a.keyId,
    keyHex: a.privateKeyHex,
    body: defaultRuntimeIdentity(),
    timestamp: timestamp(),
  });
  assert.equal(reconnect.status, 200);
  assert.equal(registry.getNode(a.nodeId).health.registryContact, "fresh");
  assert.deepEqual(registry.getNode(a.nodeId).health.alertFlags, []);
  assert.equal(registry.getNode(b.nodeId).health.registryContact, "fresh");
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

test("an aged report ages ANY outcome to stale; the last failure detail stays in latestReport", async (t) => {
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
  // Frozen RFC semantics (round-2 P2): the aged failure is stale, and
  // the last failure verdict remains visible on the latest report.
  assert.equal(summary.health.orbitCompatible, "stale");
  assert.equal(summary.latestReport.compatibility, "fail");
  assert.equal(summary.health.capabilitiesStale, true);
  assert.deepEqual(summary.health.capabilities, []);
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
test("report retention: kept at 89d, purged at 91d, derived state returns to unknown", async (t) => {
  const { registry, server, clock } = await withClockServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  await signedMachineRequest(server.baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: node.nodeId,
    keyId: node.keyId,
    keyHex: node.privateKeyHex,
    body: validReport(),
  });
  assert.equal(registry.getNode(node.nodeId).health.orbitCompatible, "pass");

  // 89 days: the report is retained (but 7-day staleness already aged it).
  clock.now = new Date(clock.now.getTime() + 89 * 24 * 60 * 60 * 1000);
  registry.maintenance();
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE node_id = ?").get(node.nodeId).n, 1);

  // 91 days: the last report is purged; derived health/capability state
  // returns to explicit unknown (no evidence, no claims).
  clock.now = new Date(clock.now.getTime() + 2 * 24 * 60 * 60 * 1000);
  registry.maintenance();
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE node_id = ?").get(node.nodeId).n, 0);
  const summary = registry.getNode(node.nodeId);
  assert.equal(summary.health.orbitCompatible, "unknown");
  assert.equal(summary.health.dshHealthy, "unknown");
  assert.equal(summary.health.capabilitiesStale, true);
  assert.deepEqual(summary.health.capabilities, []);
  assert.equal(summary.latestReport, null);
  assert.equal(summary.health.reachable, "unknown");
});

test("rollup is strictly idempotent across repeated maintenance runs and dimensions", async (t) => {
  const { registry, server, clock } = await withClockServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  // Fabricate raw events for two dimensions across two old days.
  const dimensions = ["registry_contact", "dsh_healthy"];
  for (const day of ["2026-08-01", "2026-08-02"]) {
    for (const dimension of dimensions) {
      registry.db
        .prepare("INSERT INTO events (node_id, at, dimension, from_value, to_value, source) VALUES (?, ?, ?, 'x', 'y', 'maintenance')")
        .run(node.nodeId, `${day}T12:00:00.000Z`, dimension);
    }
  }
  clock.now = new Date("2026-08-30T00:00:00.000Z");

  const snapshot = () => {
    const raw = registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND dimension != 'rollup'").get(node.nodeId).n;
    const summaries = registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND dimension = 'rollup'").get(node.nodeId).n;
    return { raw, summaries };
  };

  registry.maintenance();
  const first = snapshot();
  assert.equal(first.raw, 0);
  assert.equal(first.summaries, 4); // 2 days x 2 dimensions

  // Second and third runs must not nest summaries or add anything.
  registry.maintenance();
  assert.deepEqual(snapshot(), first);
  registry.maintenance();
  assert.deepEqual(snapshot(), first);
  // No rollup-of-rollup ever exists.
  const nested = registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND dimension = 'rollup' AND from_value = 'rollup'").get(node.nodeId).n;
  assert.equal(nested, 0);
});

test("session expiry is audited exactly once, in the maintenance transaction", async (t) => {
  const { registry, server, clock } = await withClockServer(t);
  const session = registry.bootstrapSession({ principal: "operator" });
  // The request path never audits expiry.
  clock.now = new Date(clock.now.getTime() + 13 * 60 * 60 * 1000);
  assert.equal(registry.validateSession(session.sessionId), null);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'session.expired'").get().n, 0);

  registry.maintenance();
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'session.expired'").get().n, 1);
  assert.notEqual(registry.db.prepare("SELECT expiry_audited_at FROM browser_sessions WHERE session_id = ?").get(session.sessionId).expiry_audited_at, null);

  // Repeated maintenance does not re-audit.
  registry.maintenance();
  registry.maintenance();
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'session.expired'").get().n, 1);

  // Idle expiry is audited once as well.
  registry.bootstrapSession({ principal: "operator" });
  clock.now = new Date(clock.now.getTime() + 31 * 60 * 1000);
  registry.maintenance();
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'session.expired'").get().n, 2);
});

test("rollup final is the last event by (at DESC, id DESC), never a string-max of values", async (t) => {
  const { registry, server, clock } = await withClockServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const insert = (at, dimension, fromValue, toValue, source = "maintenance") =>
    registry.db
      .prepare("INSERT INTO events (node_id, at, dimension, from_value, to_value, source) VALUES (?, ?, ?, ?, ?, ?)")
      .run(node.nodeId, at, dimension, fromValue, toValue, source);

  // Day 1: fresh -> stale at 10:00, then stale -> fresh at 20:00. The
  // day's END state is fresh; a string-max would wrongly report "stale".
  insert("2026-08-01T10:00:00.000Z", "registry_contact", "fresh", "stale");
  insert("2026-08-01T20:00:00.000Z", "registry_contact", "stale", "fresh");

  // Day 2: report events with numeric-id values "9" then "10" — the
  // lexical max is "9", the last event by (at DESC, id DESC) is "10".
  insert("2026-08-02T10:00:00.000Z", "report", "uploaded", "9", "report-upload");
  insert("2026-08-02T10:00:00.000Z", "report", "uploaded", "10", "report-upload");

  clock.now = new Date("2026-08-30T00:00:00.000Z");
  registry.maintenance();

  const contactSummary = registry.db
    .prepare("SELECT from_value, to_value FROM events WHERE node_id = ? AND dimension = 'rollup' AND from_value = 'registry_contact'")
    .get(node.nodeId);
  assert.equal(JSON.parse(contactSummary.to_value).final, "fresh");
  assert.equal(JSON.parse(contactSummary.to_value).count, 2);
  const reportSummary = registry.db
    .prepare("SELECT from_value, to_value FROM events WHERE node_id = ? AND dimension = 'rollup' AND from_value = 'report'")
    .get(node.nodeId);
  assert.equal(JSON.parse(reportSummary.to_value).final, "10");
  assert.equal(JSON.parse(reportSummary.to_value).count, 2);

  // Idempotency is preserved with the corrected final.
  registry.maintenance();
  const again = registry.db
    .prepare("SELECT to_value FROM events WHERE node_id = ? AND dimension = 'rollup' AND from_value = 'registry_contact'")
    .get(node.nodeId);
  assert.deepEqual(JSON.parse(again.to_value), JSON.parse(contactSummary.to_value));
});

test("rollup only processes complete natural days: a midday cutoff never deletes partial-day raw events", async (t) => {
  const { registry, server, clock } = await withClockServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const insert = (at, dimension, fromValue, toValue, source = "maintenance") =>
    registry.db
      .prepare("INSERT INTO events (node_id, at, dimension, from_value, to_value, source) VALUES (?, ?, ?, ?, ?, ?)")
      .run(node.nodeId, at, dimension, fromValue, toValue, source);

  // Day 2026-08-22: fully past the cutoff. Day 2026-08-23 is the cutoff
  // day: one event at 02:00 (older than 7 days) and one at 20:00 (not
  // yet 7 days old).
  insert("2026-08-22T12:00:00.000Z", "registry_contact", "fresh", "stale");
  insert("2026-08-23T02:00:00.000Z", "registry_contact", "fresh", "stale");
  insert("2026-08-23T20:00:00.000Z", "registry_contact", "stale", "fresh");

  // Cutoff = now - 7d lands exactly at 2026-08-23T12:00:00.000Z.
  clock.now = new Date("2026-08-30T12:00:00.000Z");
  registry.maintenance();

  // Day 22 rolled up completely (raw events gone; the day keeps only
  // its summary row)...
  assert.equal(
    registry.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND at >= '2026-08-22T00:00:00.000Z' AND at < '2026-08-23T00:00:00.000Z' AND dimension != 'rollup'",
      )
      .get(node.nodeId).n,
    0,
  );
  const day22Summary = registry.db
    .prepare("SELECT to_value FROM events WHERE node_id = ? AND dimension = 'rollup' AND from_value = 'registry_contact' AND at = '2026-08-22T23:59:59.999Z'")
    .get(node.nodeId);
  assert.equal(JSON.parse(day22Summary.to_value).count, 1);

  // ...but the cutoff day is NOT rolled up at all: BOTH raw events
  // remain (the 02:00 event is preserved even though it is technically
  // older than 7 days, because the natural day is incomplete).
  assert.equal(
    registry.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND at >= '2026-08-23T00:00:00.000Z' AND at < '2026-08-24T00:00:00.000Z' AND dimension != 'rollup'",
      )
      .get(node.nodeId).n,
    2,
  );
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND dimension = 'rollup' AND from_value = 'registry_contact' AND at = '2026-08-23T23:59:59.999Z'").get(node.nodeId).n, 0);

  // Next day the full natural day becomes eligible: count covers BOTH
  // events and the final is the day's last event.
  clock.now = new Date("2026-08-31T00:00:00.000Z");
  registry.maintenance();
  assert.equal(
    registry.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND at >= '2026-08-23T00:00:00.000Z' AND at < '2026-08-24T00:00:00.000Z' AND dimension != 'rollup'",
      )
      .get(node.nodeId).n,
    0,
  );
  const day23Summary = registry.db
    .prepare("SELECT to_value FROM events WHERE node_id = ? AND dimension = 'rollup' AND from_value = 'registry_contact' AND at = '2026-08-23T23:59:59.999Z'")
    .get(node.nodeId);
  const parsed = JSON.parse(day23Summary.to_value);
  assert.equal(parsed.count, 2);
  assert.equal(parsed.final, "fresh");

  // Repeated maintenance stays identical.
  const snapshot = () => registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ?").get(node.nodeId).n;
  const before = snapshot();
  registry.maintenance();
  registry.maintenance();
  assert.equal(snapshot(), before);
});
