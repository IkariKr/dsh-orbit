import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { evaluateRouteEligibility } from "../src/registry/route-proxy.mjs";
import { validReport } from "./helpers/registry-fixture.mjs";
import { createCompatibilityReport } from "../src/compatibility-report.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";

test("Stage 4 Capability Reconciliation: Stage 3 DB with materialized web.routes is revoked on startup until webSocketTransport is provided", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-stage4-reconcile-"));
  const dbPath = join(dir, "hub.db");
  const ROUTE_DOMAIN = "stage4-migration.example";

  let rawDb = null;
  let upgradedDb = null;
  let registry = null;

  try {
    rawDb = openRegistryDatabase(dbPath);
    const nodeId = "node_11112222333344445555666677778888";
    const keyId = "key_11112222333344445555666677778888";
    const nowIso = new Date().toISOString();

    // 1. Seed a node that previously received Stage 3 web.routes
    // Stage 3 report had only runtimeReadiness=pass and webPluginRoutes=pass
    const stage3Report = validReport();
    stage3Report.checks.webSocketTransport = { status: "not_run", detail: "stage3 legacy report" };
    const wrappedStage3 = createCompatibilityReport(stage3Report);

    rawDb.prepare(`
      INSERT INTO nodes (
        node_id, state, minted_at, registry_contact, authenticated, dsh_healthy,
        orbit_compatible, reachable, alert_flags, last_heartbeat_at,
        capabilities, capabilities_stale, last_seen, last_seen_source,
        orbit_version, orbit_revision, dsh_version, compatibility_profile
      ) VALUES (
        ?, 'active', ?, 'fresh', 'ok', 'ok',
        'pass', 'ok', '[]', ?,
        ?, 0, ?, 'heartbeat',
        '0.3.0', 'abc123', '0.1.1-rc.2', 'dsh-0.1.1-rc.2'
      )
    `).run(
      nodeId,
      nowIso,
      nowIso,
      // In Stage 3, web.routes was persisted into capabilities
      JSON.stringify([
        { name: "sessions.resume", version: 1 },
        { name: "settings.remote", version: 1 },
        { name: "web.routes", version: 1 },
      ]),
      nowIso,
    );

    rawDb.prepare(`
      INSERT INTO node_keys (node_id, key_id, public_key, state, created_at)
      VALUES (?, ?, ?, 'active', ?)
    `).run(nodeId, "nk_1111", "a".repeat(64), nowIso);

    rawDb.prepare(`
      INSERT INTO hub_route_keys (node_id, key_id, public_key, private_key, state, created_at, activated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(nodeId, keyId, "b".repeat(64), "c".repeat(96), nowIso, nowIso);

    rawDb.prepare(`
      INSERT INTO route_targets (node_id, route_target_origin, created_at, updated_at)
      VALUES (?, 'http://127.0.0.1:4099', ?, ?)
    `).run(nodeId, nowIso, nowIso);

    rawDb.prepare(`
      INSERT INTO reports (
        node_id, uploaded_at, orbit_version, orbit_revision, dsh_version,
        compatibility_profile, compatibility, identity_json, checks_json, report_json
      ) VALUES (?, ?, '0.3.0', 'abc123', '0.1.1-rc.2', 'dsh-0.1.1-rc.2', 'pass', ?, ?, ?)
    `).run(
      nodeId,
      nowIso,
      JSON.stringify({
        orbitVersion: "0.3.0",
        orbitRevision: "abc123",
        dshVersion: "0.1.1-rc.2",
        compatibilityProfile: "dsh-0.1.1-rc.2",
      }),
      JSON.stringify(wrappedStage3.checks),
      JSON.stringify(wrappedStage3),
    );

    // Checkpoint and close to simulate cold Stage 4 startup
    rawDb.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    rawDb.close();
    rawDb = null;

    // 2. Open the Stage 3 database with Stage 4 Registry
    upgradedDb = openRegistryDatabase(dbPath);
    registry = new Registry({ db: upgradedDb, routeDomain: ROUTE_DOMAIN });

    // Step 2.1: Verify web.routes was revoked on startup reconciliation
    const nodeAfterStart = registry.getNode(nodeId);
    const capsAfterStart = nodeAfterStart.health.capabilities.map((c) => c.name);
    assert.equal(capsAfterStart.includes("web.routes"), false, "Stage 3 web.routes must be revoked on Stage 4 startup");
    assert.deepEqual(capsAfterStart.sort(), ["sessions.resume", "settings.remote"]);

    // Step 2.2: Verify WebSocket route eligibility fails closed
    const initialEligibility = evaluateRouteEligibility(registry, nodeId);
    assert.equal(initialEligibility.eligible, false);
    assert.equal(initialEligibility.reason, "web-routes-capability-missing");

    // 3. Upload a new Stage 4 compatibility report with webSocketTransport = pass
    const stage4Report = validReport({
      orbitVersion: "0.4.0",
      orbitRevision: "abc123",
      dshVersion: "0.1.1-rc.2",
      profile: "dsh-0.1.1-rc.2",
    });
    stage4Report.checks.webSocketTransport = { status: "pass", detail: "matching pong received" };
    const wrappedStage4 = createCompatibilityReport(stage4Report);

    // Match node runtime identity to new report
    upgradedDb.prepare("UPDATE nodes SET orbit_version = '0.4.0' WHERE node_id = ?").run(nodeId);

    const uploadRes = registry.uploadReportAuthenticated({
      node: registry.getNodeRow(nodeId),
      rawBody: JSON.stringify(wrappedStage4),
    });
    assert.equal(uploadRes.ok, true);

    // Step 3.1: Verify web.routes is restored
    const nodeAfterUpload = registry.getNode(nodeId);
    const capsAfterUpload = nodeAfterUpload.health.capabilities.map((c) => c.name);
    assert.equal(capsAfterUpload.includes("web.routes"), true, "web.routes must be restored after webSocketTransport passes");

    // Step 3.2: Verify WebSocket routing is now eligible
    const eligibilityAfterUpload = evaluateRouteEligibility(registry, nodeId);
    assert.equal(eligibilityAfterUpload.eligible, true);
    assert.equal(eligibilityAfterUpload.snapshot.nodeId, nodeId);
    assert.equal(eligibilityAfterUpload.snapshot.routeTargetOrigin, "http://127.0.0.1:4099");

    upgradedDb.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    registry.close();
    registry = null;
    upgradedDb = null;
  } finally {
    try {
      rawDb?.close();
    } catch {}
    try {
      registry?.close();
    } catch {}
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Stage 4 Capability Reconciliation: Nodes with no report or mismatched runtime identity fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-stage4-reconcile-mismatch-"));
  const dbPath = join(dir, "hub.db");
  const ROUTE_DOMAIN = "stage4-migration.example";

  let rawDb = null;
  let upgradedDb = null;
  let registry = null;

  try {
    rawDb = openRegistryDatabase(dbPath);
    const nodeNoReport = "node_00000000000000000000000000000001";
    const nodeMismatch = "node_00000000000000000000000000000002";
    const nowIso = new Date().toISOString();

    // 1. Node with fake persisted capabilities but no report
    rawDb.prepare(`
      INSERT INTO nodes (
        node_id, state, minted_at, registry_contact, authenticated, dsh_healthy,
        orbit_compatible, reachable, alert_flags, last_heartbeat_at,
        capabilities, capabilities_stale, last_seen, last_seen_source,
        orbit_version, orbit_revision, dsh_version, compatibility_profile
      ) VALUES (
        ?, 'active', ?, 'fresh', 'ok', 'ok',
        'pass', 'ok', '[]', ?,
        ?, 0, ?, 'heartbeat',
        '0.4.0', 'abc123', '0.1.1-rc.2', 'dsh-0.1.1-rc.2'
      )
    `).run(
      nodeNoReport,
      nowIso,
      nowIso,
      JSON.stringify([{ name: "web.routes", version: 1 }]),
      nowIso,
    );

    // 2. Node whose latest report has matching webSocketTransport pass, but node heartbeat changed runtime identity
    const passReport = validReport();
    passReport.checks.webSocketTransport = { status: "pass", detail: "ok" };
    const wrappedPass = createCompatibilityReport(passReport);

    rawDb.prepare(`
      INSERT INTO nodes (
        node_id, state, minted_at, registry_contact, authenticated, dsh_healthy,
        orbit_compatible, reachable, alert_flags, last_heartbeat_at,
        capabilities, capabilities_stale, last_seen, last_seen_source,
        orbit_version, orbit_revision, dsh_version, compatibility_profile
      ) VALUES (
        ?, 'active', ?, 'fresh', 'ok', 'ok',
        'pass', 'ok', '[]', ?,
        ?, 0, ?, 'heartbeat',
        '0.4.1-mismatched', 'new-rev', '0.1.1-rc.2', 'dsh-0.1.1-rc.2'
      )
    `).run(
      nodeMismatch,
      nowIso,
      nowIso,
      JSON.stringify([{ name: "web.routes", version: 1 }]),
      nowIso,
    );

    rawDb.prepare(`
      INSERT INTO reports (
        node_id, uploaded_at, orbit_version, orbit_revision, dsh_version,
        compatibility_profile, compatibility, identity_json, checks_json, report_json
      ) VALUES (?, ?, '0.3.0', 'abc123', '0.1.1-rc.2', 'dsh-0.1.1-rc.2', 'pass', ?, ?, ?)
    `).run(
      nodeMismatch,
      nowIso,
      JSON.stringify({
        orbitVersion: "0.3.0",
        orbitRevision: "abc123",
        dshVersion: "0.1.1-rc.2",
        compatibilityProfile: "dsh-0.1.1-rc.2",
      }),
      JSON.stringify(wrappedPass.checks),
      JSON.stringify(wrappedPass),
    );

    rawDb.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    rawDb.close();
    rawDb = null;

    // Open with Stage 4 Registry
    upgradedDb = openRegistryDatabase(dbPath);
    registry = new Registry({ db: upgradedDb, routeDomain: ROUTE_DOMAIN });

    // Node 1 without report: capabilities stripped to [] and stale=1
    const n1 = registry.getNode(nodeNoReport);
    assert.deepEqual(n1.health.capabilities, []);
    assert.equal(n1.health.capabilitiesStale, true);

    // Node 2 with mismatched identity: capabilities_stale=1 and orbit_compatible=stale
    const n2 = registry.getNode(nodeMismatch);
    assert.equal(n2.health.capabilitiesStale, true);
    assert.equal(n2.health.orbitCompatible, "stale");

    // Reconciliation health changes must be recorded as RFC-0009 transition events.
    const noReportEvents = upgradedDb
      .prepare(
        "SELECT dimension, from_value, to_value, source FROM events WHERE node_id = ? ORDER BY id",
      )
      .all(nodeNoReport)
      .map((row) => ({ ...row }));
    assert.deepEqual(noReportEvents, [
      {
        dimension: "orbit_compatible",
        from_value: "pass",
        to_value: "unknown",
        source: "capability-reconciliation",
      },
      {
        dimension: "dsh_healthy",
        from_value: "ok",
        to_value: "unknown",
        source: "capability-reconciliation",
      },
    ]);

    const mismatchEvents = upgradedDb
      .prepare(
        "SELECT dimension, from_value, to_value, source FROM events WHERE node_id = ? ORDER BY id",
      )
      .all(nodeMismatch)
      .map((row) => ({ ...row }));
    assert.deepEqual(mismatchEvents, [
      {
        dimension: "orbit_compatible",
        from_value: "pass",
        to_value: "stale",
        source: "capability-reconciliation",
      },
      {
        dimension: "dsh_healthy",
        from_value: "ok",
        to_value: "unknown",
        source: "capability-reconciliation",
      },
    ]);

    // Both must fail route eligibility
    assert.equal(evaluateRouteEligibility(registry, nodeNoReport).eligible, false);
    assert.equal(evaluateRouteEligibility(registry, nodeMismatch).eligible, false);

    // Reconciliation state, transition events, and audit must be atomic.
    upgradedDb
      .prepare(
        "UPDATE nodes SET orbit_compatible = 'pass', dsh_healthy = 'ok', capabilities_stale = 0 WHERE node_id = ?",
      )
      .run(nodeMismatch);
    const eventCountBeforeFailedReconcile = upgradedDb
      .prepare("SELECT COUNT(*) AS count FROM events WHERE node_id = ?")
      .get(nodeMismatch).count;
    const originalRecordAudit = registry.recordAudit;
    registry.recordAudit = () => {
      throw new Error("forced-reconciliation-audit-failure");
    };
    assert.throws(
      () => registry.reconcileCapabilities(),
      /forced-reconciliation-audit-failure/,
    );
    registry.recordAudit = originalRecordAudit;

    const afterFailedReconcile = registry.getNodeRow(nodeMismatch);
    assert.equal(afterFailedReconcile.orbit_compatible, "pass");
    assert.equal(afterFailedReconcile.dsh_healthy, "ok");
    assert.equal(afterFailedReconcile.capabilities_stale, 0);
    const eventCountAfterFailedReconcile = upgradedDb
      .prepare("SELECT COUNT(*) AS count FROM events WHERE node_id = ?")
      .get(nodeMismatch).count;
    assert.equal(eventCountAfterFailedReconcile, eventCountBeforeFailedReconcile);

    // A normal retry commits all three together.
    registry.reconcileCapabilities();
    const afterSuccessfulRetry = registry.getNodeRow(nodeMismatch);
    assert.equal(afterSuccessfulRetry.orbit_compatible, "stale");
    assert.equal(afterSuccessfulRetry.dsh_healthy, "unknown");
    assert.equal(afterSuccessfulRetry.capabilities_stale, 1);

    upgradedDb.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    registry.close();
    registry = null;
    upgradedDb = null;
  } finally {
    try {
      rawDb?.close();
    } catch {}
    try {
      registry?.close();
    } catch {}
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
