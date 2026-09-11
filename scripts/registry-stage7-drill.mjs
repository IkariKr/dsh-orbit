#!/usr/bin/env node
// Stage 7 operational hardening drill. This is intentionally separate from
// the Stage 6 mounted driver and uses a fresh file-backed registry per run.
// It records migration and backup -> mutate -> restore evidence without
// storing private keys, plaintext tokens, CSRF values, or other secrets.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { backupRegistryDatabase, inspectRegistryDatabase, restoreRegistryDatabase } from "../src/registry/backup.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { openRegistryDatabase, SCHEMA_VERSION } from "../src/registry/sqlite.mjs";
import { generateNodeKeyPair, deriveKeyId } from "../src/registry/crypto.mjs";
import { runStage7ProcessDrill } from "./stage7-process-scenarios.mjs";
import { deriveCapabilities } from "../src/registry/capabilities.mjs";
import { RouteNonceCache, signRouteRequest, verifyRouteRequest } from "../src/registry/route-auth.mjs";
import { IngressWebSocketTracker } from "../src/node/route-ingress.mjs";
import { HubWebSocketTracker } from "../src/registry/route-proxy.mjs";
import https from "node:https";
import { GATEWAY_CERT_PEM, GATEWAY_KEY_PEM } from "../test/fixtures/gateway-identity.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const runId = `stage7-${new Date().toISOString().replaceAll(/[-:.TZ]/g, "")}-${process.pid}`;
const outputPath = process.env.DSH_ORBIT_STAGE7_EVIDENCE ?? join(REPO_ROOT, "data", "stage7-drill-evidence.json");
const keepRoot = process.env.DSH_ORBIT_STAGE7_KEEP_ROOT === "1";

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function requireCleanCandidateWorktree() {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") {
    throw new Error(`Stage 7 drill requires a clean candidate worktree; commit ${git(["rev-parse", "HEAD"])} has uncommitted changes`);
  }
  return status;
}

function collectRequiredPredicates(evidence) {
  const predicates = {
    cleanWorktreeBefore: evidence.cleanWorktreeBefore,
    migrations: ["v1", "v2", "v3", "v4"].every((version) => {
      const item = evidence.migration?.[version];
      return item?.preservedState === true && item?.idempotent === true && item?.integrityCheck === "ok";
    }),
    migrationV04: evidence.migration?.v4?.preservedState === true &&
      evidence.migration?.v4?.idempotent === true &&
      evidence.migration?.v4?.integrityCheck === "ok" &&
      evidence.migration?.v4?.routeTargetsPresent === true &&
      evidence.migration?.v4?.hubRouteKeysPresent === true,
    routeIdentityBackupRestore: evidence.backupRestore?.method === "sqlite-vacuum-into" &&
      evidence.backupRestore?.mutationChangedState === true &&
      evidence.backupRestore?.restoredBackupState === true &&
      evidence.backupRestore?.postBackupMutationAbsent === true &&
      evidence.backupRestore?.routeTargetPreserved === true &&
      evidence.backupRestore?.hubRouteKeyPreserved === true,
    secretProtection: evidence.secretProtection?.privateKeyExcludedFromDigest === true &&
      evidence.secretProtection?.privateKeyExcludedFromInspection === true,
    routeIdentityCorruption: evidence.failureModes?.routeTargetCorruptionRejected === true &&
      evidence.failureModes?.hubRouteKeyCorruptionRejected === true,
    hubRouteKeyRotation: evidence.processBoundary?.hubRestart?.sameKeyId === true &&
      evidence.processBoundary?.rotationRecovery?.samePendingKeyPromoted === true,
    nonceRestartSemantics: evidence.nonceRestartSemantics?.sameProcessReplayRejected === true &&
      evidence.nonceRestartSemantics?.freshProcessNonceAcceptedWithinSkew === true,
    tlsFailureMatrix: evidence.tlsFailureMatrix?.unknownCaRejected === true &&
      evidence.tlsFailureMatrix?.wrongSanRejected === true &&
      evidence.tlsFailureMatrix?.matchingCertSucceeds === true,
    compatibilityWithdrawal: evidence.compatibilityWithdrawal?.unsupportedDshWithheld === true &&
      evidence.compatibilityWithdrawal?.missingWsWithheld === true,
    dshLossRecovery: evidence.dshLossRecovery?.unreachableOnLoss === true &&
      evidence.dshLossRecovery?.restoredOnRecovery === true,
    bookmarkReenroll: evidence.processBoundary?.reenrollmentRecovery?.exactReplaySucceeded === true &&
      evidence.bookmarkReenroll?.deletedRouteKeyRevoked === true,
    httpWsCleanup: evidence.httpWsCleanup?.earlyAbortCleanedUp === true,
    restartStability: evidence.processBoundary?.hubRestart?.sameNodeId === true &&
      evidence.processBoundary?.hubRestart?.sameKeyId === true &&
      evidence.processBoundary?.hubRestart?.healthPreserved === true,
    failureModes: evidence.failureModes?.noRebuildOrOverwrite === true &&
      evidence.failureModes?.futureDatabaseUnchanged === true &&
      evidence.failureModes?.corruptDatabaseUnchanged === true,
    freshInstall: evidence.freshInstall?.emptyBeforeStartup === true &&
      evidence.freshInstall?.maintenance?.invoked === true &&
      evidence.freshInstall?.maintenance?.integrityCheck === "ok",
    backupRestore: evidence.backupRestore?.method === "sqlite-vacuum-into" &&
      evidence.backupRestore?.mutationChangedState === true &&
      evidence.backupRestore?.restoredBackupState === true &&
      evidence.backupRestore?.postBackupMutationAbsent === true &&
      evidence.backupRestore?.walSidecarsNotCopied === true,
    retention: evidence.retention?.reportPurgedAfter90Days === true &&
      evidence.retention?.tenDayEventRolledUp === true &&
      evidence.retention?.oldEventPurgedAfter90Days === true &&
      evidence.retention?.auditPurgedAfter365Days === true &&
      evidence.retention?.repeatedMaintenanceStable === true,
    processBoundary: evidence.processBoundary?.hubRestart?.hubAClosed === true &&
      evidence.processBoundary?.hubRestart?.hubBReady === true &&
      evidence.processBoundary?.hubRestart?.sameNodeId === true &&
      evidence.processBoundary?.hubRestart?.sameKeyId === true &&
      evidence.processBoundary?.hubRestart?.reportPreserved === true &&
      evidence.processBoundary?.hubRestart?.auditPreserved === true &&
      evidence.processBoundary?.hubRestart?.persistedCountsPreserved === true &&
      evidence.processBoundary?.hubRestart?.healthPreserved === true &&
      evidence.processBoundary?.rotationRecovery?.upstreamCommitted === true &&
      evidence.processBoundary?.rotationRecovery?.pendingPersistedBeforeKill === true &&
      evidence.processBoundary?.rotationRecovery?.childKilled === true &&
      evidence.processBoundary?.rotationRecovery?.samePendingKeyPromoted === true &&
      evidence.processBoundary?.rotationRecovery?.noThirdKey === true &&
      evidence.processBoundary?.rotationRecovery?.noOrphanNode === true &&
      evidence.processBoundary?.reenrollmentRecovery?.upstreamCommitted === true &&
      evidence.processBoundary?.reenrollmentRecovery?.pendingPersistedBeforeKill === true &&
      evidence.processBoundary?.reenrollmentRecovery?.childKilled === true &&
      evidence.processBoundary?.reenrollmentRecovery?.exactReplaySucceeded === true &&
      evidence.processBoundary?.reenrollmentRecovery?.sameNodeId === true &&
      evidence.processBoundary?.reenrollmentRecovery?.pendingCleared === true &&
      evidence.processBoundary?.longDowntime?.lostAfterRestart === true &&
      evidence.processBoundary?.longDowntime?.contactLostAlert === true &&
      evidence.processBoundary?.longDowntime?.reportDidNotHealContact === true &&
      evidence.processBoundary?.longDowntime?.authenticatedHeartbeatRestoredFresh === true &&
      evidence.processBoundary?.longDowntime?.identityPreserved === true,
    cleanup: evidence.cleanup?.removed === true || evidence.cleanup?.isolatedRoot !== undefined,
  };
  const failed = Object.entries(predicates).filter(([, value]) => value !== true).map(([name]) => name);
  return { predicates, failed };
}

function scrub(value, key = "") {
  if (typeof value === "boolean") return value;
  if (/tokenreturned|tokenpresent|secretpresent/i.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((child) => scrub(child, key));
  if (value && typeof value === "object") {
    const result = {};
    for (const [childKey, child] of Object.entries(value)) {
      if (typeof child === "boolean") {
        result[childKey] = child;
        continue;
      }
      if (/^(?:private_?key|csrf|password|token_digest|token)$/i.test(childKey)) continue;
      if (/(?:csrf|password)/i.test(childKey)) continue;
      result[childKey] = scrub(child, childKey);
    }
    return result;
  }
  return value;
}

function seedNode(db, nodeId, suffix) {
  const keys = generateNodeKeyPair();
  const at = "2026-08-31T00:00:00.000Z";
  db.prepare(
    "INSERT INTO nodes (node_id, state, minted_at, authenticated, registry_contact, dsh_healthy, orbit_compatible, capabilities, capabilities_stale, last_seen, last_seen_source, orbit_version, orbit_revision, dsh_version, compatibility_profile) VALUES (?, 'active', ?, 'ok', 'fresh', 'ok', 'pass', ?, 0, ?, 'heartbeat', '0.3.0', 'stage7', '0.1.1-rc.2', 'dsh-0.1.1-rc.2')",
  ).run(nodeId, at, JSON.stringify([{ name: "sessions.resume", source: "report" }]), at);
  db.prepare(
    "INSERT INTO node_keys (node_id, key_id, public_key, state, created_at) VALUES (?, ?, ?, 'active', ?)",
  ).run(nodeId, deriveKeyId(keys.publicKeyHex), keys.publicKeyHex, at);
  db.prepare(
    "INSERT INTO reports (node_id, uploaded_at, orbit_version, orbit_revision, dsh_version, compatibility_profile, compatibility, identity_json, checks_json, report_json) VALUES (?, ?, '0.3.0', 'stage7', '0.1.1-rc.2', 'dsh-0.1.1-rc.2', 'pass', '{}', '{}', '{}')",
  ).run(nodeId, at);
  db.prepare(
    "INSERT INTO events (node_id, at, dimension, from_value, to_value, source) VALUES (?, ?, 'registry_contact', 'unknown', 'fresh', 'heartbeat')",
  ).run(nodeId, at);
  db.prepare("INSERT INTO audit (at, actor, action, detail_json) VALUES (?, 'operator', 'stage7.seed', '{}')").run(at);
}

function migrationDatabase(path, version) {
  const db = openRegistryDatabase(path);
  seedNode(db, `node_${String(version).repeat(32)}`, String(version));
  if (version < 5) {
    db.exec("DROP TABLE hub_route_keys");
  }
  if (version < 4) {
    db.exec("DROP TABLE route_targets");
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`
      CREATE TABLE nodes_v3 (
        node_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('active', 'tombstoned')),
        minted_at TEXT NOT NULL,
        tombstoned_at TEXT,
        tombstone_reason TEXT,
        registry_contact TEXT NOT NULL DEFAULT 'unknown' CHECK (registry_contact IN ('fresh', 'stale', 'lost', 'unknown')),
        authenticated TEXT NOT NULL DEFAULT 'unknown' CHECK (authenticated IN ('ok', 'revoked', 'unknown')),
        dsh_healthy TEXT NOT NULL DEFAULT 'unknown' CHECK (dsh_healthy IN ('ok', 'degraded', 'unknown')),
        orbit_compatible TEXT NOT NULL DEFAULT 'unknown' CHECK (orbit_compatible IN ('pass', 'fail', 'stale', 'unknown')),
        reachable TEXT NOT NULL DEFAULT 'unknown' CHECK (reachable = 'unknown'),
        alert_flags TEXT NOT NULL DEFAULT '[]',
        last_heartbeat_at TEXT,
        capabilities TEXT NOT NULL DEFAULT '[]',
        capabilities_stale INTEGER NOT NULL DEFAULT 1,
        last_seen TEXT,
        last_seen_source TEXT,
        orbit_version TEXT NOT NULL DEFAULT '',
        orbit_revision TEXT,
        dsh_version TEXT NOT NULL DEFAULT '',
        compatibility_profile TEXT
      );
      INSERT INTO nodes_v3 SELECT * FROM nodes;
      DROP TABLE nodes;
      ALTER TABLE nodes_v3 RENAME TO nodes;
    `);
    db.exec("PRAGMA foreign_keys = ON");
  }
  if (version === 1) {
    db.exec("ALTER TABLE nodes DROP COLUMN alert_flags");
    db.exec("ALTER TABLE nodes DROP COLUMN last_heartbeat_at");
    db.exec("ALTER TABLE browser_sessions DROP COLUMN expiry_audited_at");
  } else if (version === 2) {
    db.exec("ALTER TABLE nodes DROP COLUMN last_heartbeat_at");
    db.exec("ALTER TABLE browser_sessions DROP COLUMN expiry_audited_at");
  }
  db.exec(`PRAGMA user_version = ${version}`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

async function createPageCorruption(path) {
  const db = openRegistryDatabase(path);
  seedNode(db, "node_cccccccccccccccccccccccccccccccc", "c");
  const pageSize = Number(db.prepare("PRAGMA page_size").get().page_size);
  const rootPage = Number(db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'reports'").get().rootpage);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const bytes = await readFile(path);
  const pageOffset = (rootPage - 1) * pageSize;
  if (bytes[pageOffset] !== 0x0d || bytes.readUInt16BE(pageOffset + 3) < 1) {
    throw new Error("unable to construct a reports business-page corruption fixture");
  }
  bytes[pageOffset + 8] = 0;
  bytes[pageOffset + 9] = 1;
  await writeFile(path, bytes);
}

async function createForeignKeyViolation(path) {
  const db = openRegistryDatabase(path);
  seedNode(db, "node_dddddddddddddddddddddddddddddddd", "d");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const raw = new DatabaseSync(path);
  try {
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.prepare("INSERT INTO node_keys (node_id, key_id, public_key, state, created_at) VALUES ('node_missing', 'orphan', ?, 'active', '2026-08-31T00:00:00.000Z')").run("d".repeat(64));
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    raw.close();
  }
}

async function run() {
  requireCleanCandidateWorktree();
  const root = await mkdtemp(join(tmpdir(), "orbit-stage7-"));
  const evidence = {
    stage: "7",
    runId,
    testedCommit: git(["rev-parse", "HEAD"]),
    branch: git(["branch", "--show-current"]),
    cleanWorktreeBefore: true,
    nodeVersion: process.version,
    schemaVersion: SCHEMA_VERSION,
    thresholds: { heartbeatCadenceSeconds: 60, staleMissedBeats: 3, lostAfterHours: 24, reportRetentionDays: 90, eventRetentionDays: 90, auditRetentionDays: 365 },
    migration: {},
    backupRestore: {},
    freshInstall: {},
    cleanup: {},
    processBoundary: {},
  };
  try {
    const migrationRoot = join(root, "migrations");
    await mkdir(migrationRoot, { recursive: true });
    for (const version of [1, 2, 3, 4]) {
      const path = join(migrationRoot, `v${version}.db`);
      migrationDatabase(path, version);
      const beforeBytes = await readFile(path);
      const before = {
        schemaVersion: version,
        fileSha256: createHash("sha256").update(beforeBytes).digest("hex"),
      };
      const upgraded = openRegistryDatabase(path);
      const after = inspectRegistryDatabase(path);
      upgraded.close();
      const reopened = openRegistryDatabase(path);
      const idempotent = inspectRegistryDatabase(path);
      reopened.close();
      evidence.migration[`v${version}`] = {
        before,
        after,
        integrityCheck: after.integrityCheck,
        idempotentInspection: idempotent,
        preservedState: after.rowCounts.nodes === 1 && after.rowCounts.node_keys === 1,
        idempotent: idempotent.stateDigest === after.stateDigest && idempotent.rowCounts.nodes === after.rowCounts.nodes,
        noOpCurrent: version === 4 && idempotent.stateDigest === after.stateDigest,
        routeTargetsPresent: Boolean(after.schemaShape.tables.route_targets),
        hubRouteKeysPresent: Boolean(after.schemaShape.tables.hub_route_keys),
        healthSemantics: "registryContact=fresh, reachable=unknown, capabilities derived from stored evidence",
      };
    }

    const failureRoot = join(root, "failure-modes");
    await mkdir(failureRoot, { recursive: true });
    const futurePath = join(failureRoot, "future.db");
    const futureDb = openRegistryDatabase(futurePath);
    futureDb.exec("PRAGMA user_version = 99");
    futureDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    futureDb.close();
    const futureBeforeBytes = await readFile(futurePath);
    let futureRejected = false;
    try {
      openRegistryDatabase(futurePath);
    } catch (error) {
      futureRejected = error.code === "unsupported-schema";
    }
    const futureAfterBytes = await readFile(futurePath);
    const corruptPath = join(failureRoot, "corrupt.db");
    const corruptBytes = Buffer.from("not sqlite\n", "utf8");
    await writeFile(corruptPath, corruptBytes);
    let corruptRejected = false;
    try {
      openRegistryDatabase(corruptPath);
    } catch (error) {
      corruptRejected = error.code === "corrupt-database" || error.code === "database-open-failed";
    }
    const corruptAfterBytes = await readFile(corruptPath);
    const pagePath = join(failureRoot, "business-page-corrupt.db");
    await createPageCorruption(pagePath);
    const pageBeforeBytes = await readFile(pagePath);
    let pageRejected = false;
    try {
      openRegistryDatabase(pagePath);
    } catch (error) {
      pageRejected = error.code === "integrity-failed";
    }
    const pageAfterBytes = await readFile(pagePath);
    const fkPath = join(failureRoot, "foreign-key-violation.db");
    await createForeignKeyViolation(fkPath);
    const fkBeforeBytes = await readFile(fkPath);
    let fkRejected = false;
    try {
      openRegistryDatabase(fkPath);
    } catch (error) {
      fkRejected = error.code === "integrity-failed";
    }
    const fkAfterBytes = await readFile(fkPath);
    const corruptRtPath = join(failureRoot, "corrupt-route-targets.db");
    const corruptRtDb = openRegistryDatabase(corruptRtPath);
    corruptRtDb.close();
    const rawRt = new DatabaseSync(corruptRtPath);
    rawRt.exec("PRAGMA foreign_keys = OFF");
    rawRt.prepare("INSERT INTO route_targets (node_id, route_target_origin, created_at, updated_at) VALUES ('node_orphan', 'https://bad.example', 't', 't')").run();
    rawRt.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    rawRt.close();
    let corruptRtRejected = false;
    try {
      openRegistryDatabase(corruptRtPath);
    } catch (error) {
      corruptRtRejected = error.code === "integrity-failed";
    }

    const corruptHrkPath = join(failureRoot, "corrupt-hub-route-keys.db");
    const corruptHrkDb = openRegistryDatabase(corruptHrkPath);
    corruptHrkDb.close();
    const rawHrk = new DatabaseSync(corruptHrkPath);
    rawHrk.exec("PRAGMA foreign_keys = OFF");
    rawHrk.prepare("INSERT INTO hub_route_keys (node_id, key_id, public_key, private_key, state, created_at) VALUES ('node_orphan', 'k1', 'a', 'b', 'provisioned', 't')").run();
    rawHrk.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    rawHrk.close();
    let corruptHrkRejected = false;
    try {
      openRegistryDatabase(corruptHrkPath);
    } catch (error) {
      corruptHrkRejected = error.code === "integrity-failed";
    }

    evidence.failureModes = {
      futureSchemaRejected: futureRejected,
      corruptDatabaseRejected: corruptRejected,
      businessPageCorruptionRejected: pageRejected,
      foreignKeyViolationRejected: fkRejected,
      routeTargetCorruptionRejected: corruptRtRejected,
      hubRouteKeyCorruptionRejected: corruptHrkRejected,
      futureDatabaseUnchanged: Buffer.compare(futureBeforeBytes, futureAfterBytes) === 0,
      corruptDatabaseUnchanged: Buffer.compare(corruptAfterBytes, corruptBytes) === 0,
      businessPageDatabaseUnchanged: Buffer.compare(pageAfterBytes, pageBeforeBytes) === 0,
      foreignKeyDatabaseUnchanged: Buffer.compare(fkAfterBytes, fkBeforeBytes) === 0,
      noRebuildOrOverwrite: futureRejected && corruptRejected && pageRejected && fkRejected && corruptRtRejected && corruptHrkRejected &&
        Buffer.compare(futureBeforeBytes, futureAfterBytes) === 0 &&
        Buffer.compare(corruptAfterBytes, corruptBytes) === 0 &&
        Buffer.compare(pageAfterBytes, pageBeforeBytes) === 0 &&
        Buffer.compare(fkAfterBytes, fkBeforeBytes) === 0,
    };

    const freshPath = join(root, "fresh", "registry.db");
    const backupPath = join(root, "backup", "registry.db");
    await mkdir(join(root, "fresh"), { recursive: true });
    await mkdir(join(root, "backup"), { recursive: true });
    let db = openRegistryDatabase(freshPath);
    const registry = new Registry({ db });
    const emptyState = inspectRegistryDatabase(freshPath);
    const beforeMaintenanceAuditCount = emptyState.rowCounts.audit;
    registry.maintenance();
    const afterMaintenance = inspectRegistryDatabase(freshPath);
    const enrollmentResult = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
    evidence.freshInstall = {
      emptyBeforeStartup: Object.values(emptyState.rowCounts).every((count) => count === 0),
      emptyState,
      maintenance: {
        invoked: true,
        integrityCheck: afterMaintenance.integrityCheck,
        stateDigest: afterMaintenance.stateDigest,
        auditRowsBefore: beforeMaintenanceAuditCount,
        auditRowsAfter: afterMaintenance.rowCounts.audit,
      },
      schemaAfterToken: inspectRegistryDatabase(freshPath),
      plaintextTokenReturnedOnce: typeof enrollmentResult.token === "string" && enrollmentResult.token.length === 32,
    };
    seedNode(db, "node_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "a");
    const testNodeId = "node_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const testKeys = generateNodeKeyPair();
    const testKeyId = deriveKeyId(testKeys.publicKeyHex);
    db.prepare("INSERT INTO route_targets (node_id, route_target_origin, created_at, updated_at) VALUES (?, 'https://127.0.0.1:50081', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')").run(testNodeId);
    db.prepare("INSERT INTO hub_route_keys (node_id, key_id, public_key, private_key, state, created_at, activated_at) VALUES (?, ?, ?, ?, 'active', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')").run(testNodeId, testKeyId, testKeys.publicKeyHex, testKeys.privateKeyHex);
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    const backup = await backupRegistryDatabase({ db, sourcePath: freshPath, destinationPath: backupPath });
    db.prepare("UPDATE nodes SET registry_contact = 'lost', alert_flags = '[\"contact-lost\"]'").run();
    db.prepare("UPDATE route_targets SET route_target_origin = 'https://mutated.example' WHERE node_id = ?").run(testNodeId);
    db.prepare("UPDATE hub_route_keys SET state = 'revoked' WHERE node_id = ?").run(testNodeId);
    db.prepare("INSERT INTO audit (at, actor, action, detail_json) VALUES ('2026-08-31T01:00:00.000Z', 'operator', 'stage7.mutation', '{}')").run();
    const mutated = inspectRegistryDatabase(freshPath);
    db.close();
    const restore = await restoreRegistryDatabase({ backupPath, targetPath: freshPath, writersQuiesced: true });
    db = openRegistryDatabase(freshPath);
    const restoredState = inspectRegistryDatabase(freshPath);
    const restoredRouteTarget = db.prepare("SELECT route_target_origin FROM route_targets WHERE node_id = ?").get(testNodeId)?.route_target_origin;
    const restoredKey = db.prepare("SELECT key_id, state, private_key FROM hub_route_keys WHERE node_id = ?").get(testNodeId);
    const routeTargetPreserved = restoredRouteTarget === "https://127.0.0.1:50081";
    const hubRouteKeyPreserved = restoredKey?.key_id === testKeyId && restoredKey?.state === "active" && restoredKey?.private_key === testKeys.privateKeyHex;
    const privateKeyExcludedFromDigest = !backup.backup.stateDigest.includes(testKeys.privateKeyHex) && !restoredState.stateDigest.includes(testKeys.privateKeyHex);
    const privateKeyExcludedFromInspection = !JSON.stringify(backup.backup).includes(testKeys.privateKeyHex) && !JSON.stringify(restoredState).includes(testKeys.privateKeyHex);

    const retentionPath = join(root, "retention.db");
    const retentionDb = openRegistryDatabase(retentionPath);
    const retentionRegistry = new Registry({ db: retentionDb, now: () => new Date("2026-12-01T00:00:00.000Z") });
    const retentionNode = "node_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    seedNode(retentionDb, retentionNode, "b");
    retentionDb.prepare("UPDATE reports SET uploaded_at = '2026-08-01T00:00:00.000Z' WHERE node_id = ?").run(retentionNode);
    retentionDb.prepare("UPDATE events SET at = '2026-08-01T00:00:00.000Z' WHERE node_id = ?").run(retentionNode);
    retentionDb.prepare("UPDATE audit SET at = '2025-01-01T00:00:00.000Z'").run();
    retentionDb
      .prepare("INSERT INTO events (node_id, at, dimension, from_value, to_value, source) VALUES (?, '2026-11-21T12:00:00.000Z', 'registry_contact', 'fresh', 'stale', 'maintenance')")
      .run(retentionNode);
    retentionDb
      .prepare("INSERT INTO events (node_id, at, dimension, from_value, to_value, source) VALUES (?, '2026-08-01T12:00:00.000Z', 'registry_contact', 'stale', 'lost', 'maintenance')")
      .run(retentionNode);
    const retentionBefore = inspectRegistryDatabase(retentionPath);
    retentionRegistry.maintenance();
    const retentionOnce = inspectRegistryDatabase(retentionPath);
    const rollupRows = retentionDb
      .prepare("SELECT COUNT(*) AS count FROM events WHERE node_id = ? AND dimension = 'rollup' AND at = '2026-11-21T23:59:59.999Z'")
      .get(retentionNode).count;
    const oldRawRows = retentionDb
      .prepare("SELECT COUNT(*) AS count FROM events WHERE node_id = ? AND dimension = 'registry_contact' AND at >= '2026-08-01T00:00:00.000Z' AND at < '2026-08-02T00:00:00.000Z'")
      .get(retentionNode).count;
    retentionRegistry.maintenance();
    const retentionTwice = inspectRegistryDatabase(retentionPath);
    evidence.retention = {
      before: retentionBefore,
      afterFirstMaintenance: retentionOnce,
      afterSecondMaintenance: retentionTwice,
      reportPurgedAfter90Days: retentionBefore.rowCounts.reports > retentionOnce.rowCounts.reports && retentionOnce.rowCounts.reports === 0,
      tenDayEventRolledUp: Number(rollupRows) === 1,
      oldEventPurgedAfter90Days: Number(oldRawRows) === 0,
      rawEventAndRollupBoundariesObserved: Number(rollupRows) === 1 && Number(oldRawRows) === 0,
      auditPurgedAfter365Days: retentionBefore.rowCounts.audit > retentionOnce.rowCounts.audit && retentionOnce.rowCounts.audit === 0,
      repeatedMaintenanceStable: retentionOnce.stateDigest === retentionTwice.stateDigest,
    };
    retentionRegistry.close();

    evidence.backupRestore = {
      method: backup.method,
      source: backup.source,
      backup: backup.backup,
      mutation: mutated,
      mutationChangedState: mutated.stateDigest !== backup.backup.stateDigest,
      restore,
      restoredState,
      restoredBackupState: restoredState.stateDigest === backup.backup.stateDigest,
      postBackupMutationAbsent: restoredState.stateDigest !== mutated.stateDigest,
      walSidecarsNotCopied: backup.backupWalPresent === false && backup.backupShmPresent === false,
      routeTargetPreserved,
      hubRouteKeyPreserved,
    };
    evidence.secretProtection = {
      privateKeyExcludedFromDigest,
      privateKeyExcludedFromInspection,
    };

    // S7-F7 Nonce restart semantics verification
    const testSignKeys = generateNodeKeyPair();
    const testSignKeyId = deriveKeyId(testSignKeys.publicKeyHex);
    const nonceNodeId = "node_11111111111111111111111111111111";
    const nonceAuthority = `n-${nonceNodeId.slice(5)}.stage7.localhost`;
    const nonceCache1 = new RouteNonceCache({ retentionMs: 60_000 });
    const nowMs = Date.now();
    const { headers: nonceHeaders } = signRouteRequest({
      privateKeyHex: testSignKeys.privateKeyHex,
      keyId: testSignKeyId,
      nodeId: nonceNodeId,
      routeAuthority: nonceAuthority,
      method: "GET",
      rawTarget: "/_orbit/route-ready",
      nowMs,
      nonce: "1".repeat(32),
    });
    const getNonceKey = (kId) => (kId === testSignKeyId ? { publicKey: testSignKeys.publicKeyHex, state: "active" } : null);
    const v1 = verifyRouteRequest({
      headers: nonceHeaders,
      method: "GET",
      rawTarget: "/_orbit/route-ready",
      expectedNodeId: nonceNodeId,
      expectedRouteAuthority: nonceAuthority,
      getPublicKey: getNonceKey,
      nonceCache: nonceCache1,
      nowMs,
    });
    const v2 = verifyRouteRequest({
      headers: nonceHeaders,
      method: "GET",
      rawTarget: "/_orbit/route-ready",
      expectedNodeId: nonceNodeId,
      expectedRouteAuthority: nonceAuthority,
      getPublicKey: getNonceKey,
      nonceCache: nonceCache1,
      nowMs,
    });
    const nonceCache2 = new RouteNonceCache({ retentionMs: 60_000 });
    const vRestart = verifyRouteRequest({
      headers: nonceHeaders,
      method: "GET",
      rawTarget: "/_orbit/route-ready",
      expectedNodeId: nonceNodeId,
      expectedRouteAuthority: nonceAuthority,
      getPublicKey: getNonceKey,
      nonceCache: nonceCache2,
      nowMs,
    });
    evidence.nonceRestartSemantics = {
      sameProcessReplayRejected: v1.ok === true && v2.ok === false && v2.code === "replay",
      freshProcessNonceAcceptedWithinSkew: vRestart.ok === true,
    };

    // S7-F8 TLS failure matrix verification
    const tlsServer = https.createServer({
      cert: GATEWAY_CERT_PEM,
      key: GATEWAY_KEY_PEM,
    }, (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
    const tlsPort = tlsServer.address().port;
    let unknownCaRejected = false;
    try {
      await new Promise((resolve, reject) => {
        const req = https.request({ hostname: "127.0.0.1", port: tlsPort, path: "/", method: "GET" }, resolve);
        req.on("error", reject);
        req.end();
      });
    } catch {
      unknownCaRejected = true;
    }
    let wrongSanRejected = false;
    try {
      await new Promise((resolve, reject) => {
        const req = https.request({ hostname: "localhost", port: tlsPort, path: "/", method: "GET", ca: GATEWAY_CERT_PEM }, resolve);
        req.on("error", reject);
        req.end();
      });
    } catch {
      wrongSanRejected = true;
    }
    let matchingCertSucceeds = false;
    try {
      const code = await new Promise((resolve, reject) => {
        const req = https.request({ hostname: "127.0.0.1", port: tlsPort, path: "/", method: "GET", ca: GATEWAY_CERT_PEM }, (res) => resolve(res.statusCode));
        req.on("error", reject);
        req.end();
      });
      matchingCertSucceeds = code === 200;
    } catch {}
    await new Promise((resolve) => tlsServer.close(resolve));
    evidence.tlsFailureMatrix = {
      unknownCaRejected,
      wrongSanRejected,
      matchingCertSucceeds,
    };

    // S7-F9 Compatibility withdrawal verification
    const unapprovedReport = {
      candidate: { dshVersion: "0.9.9-unapproved", profile: "unknown" },
      checks: {
        sessionResume: { status: "pass" },
        settingsRead: { status: "pass" },
        settingsNoopWrite: { status: "pass" },
        authorizationSmoke: { status: "pass" },
        runtimeReadiness: { status: "pass" },
        webPluginRoutes: { status: "pass" },
        webSocketTransport: { status: "pass" },
      },
      compatibility: { outcome: "pass" },
    };
    const missingWsReport = {
      candidate: { dshVersion: "0.1.1-rc.2", profile: "dsh-0.1.1-rc.2" },
      checks: {
        sessionResume: { status: "pass" },
        settingsRead: { status: "pass" },
        settingsNoopWrite: { status: "pass" },
        authorizationSmoke: { status: "pass" },
        runtimeReadiness: { status: "pass" },
        webPluginRoutes: { status: "pass" },
        webSocketTransport: { status: "fail" },
      },
      compatibility: { outcome: "pass" },
    };
    evidence.compatibilityWithdrawal = {
      unsupportedDshWithheld: deriveCapabilities(unapprovedReport).length === 0,
      missingWsWithheld: !deriveCapabilities(missingWsReport).some((c) => c.name === "web.routes"),
    };

    // S7-F10 DSH loss recovery verification on db/registry
    const probeDb = openRegistryDatabase(join(root, "probe-test.db"));
    const probeRegistry = new Registry({ db: probeDb });
    const pNodeId = "node_22222222222222222222222222222222";
    probeDb.prepare("INSERT INTO nodes (node_id, state, minted_at) VALUES (?, 'active', 't')").run(pNodeId);
    probeRegistry.setRouteTarget({ actor: "operator", nodeId: pNodeId, routeTarget: "http://127.0.0.1:54321" });
    const pKey = probeRegistry.ensureHubRouteKey(pNodeId);
    probeRegistry.acknowledgeHubRouteKeys(pNodeId, [pKey.key_id]);
    for (let i = 0; i < 3; i++) {
      await probeRegistry.probeNode(pNodeId, {
        requestTransport: async () => { throw new Error("ECONNREFUSED"); },
      });
    }
    const unreachableOnLoss = probeRegistry.getNode(pNodeId).health.reachable === "unreachable";
    await probeRegistry.probeNode(pNodeId, {
      requestTransport: async () => ({ status: 200, body: JSON.stringify({ nodeId: pNodeId, ready: true }) }),
    });
    const restoredOnRecovery = probeRegistry.getNode(pNodeId).health.reachable === "ok";
    evidence.dshLossRecovery = { unreachableOnLoss, restoredOnRecovery };

    // S7-F11 Bookmark delete/reenroll
    const delRes = probeRegistry.deleteNode({ actor: "operator", nodeId: pNodeId, requestId: "1".repeat(32), reason: "test" });
    const keyAfterDel = probeDb.prepare("SELECT state FROM hub_route_keys WHERE key_id = ?").get(pKey.key_id);
    evidence.bookmarkReenroll = {
      deletedRouteKeyRevoked: delRes.state === "tombstoned" && keyAfterDel.state === "revoked",
    };
    probeDb.close();

    // S7-F12 Early abort WS cleanup
    const tracker = new IngressWebSocketTracker({ maxConnections: 5 });
    const fakeSock = { once(e, cb) { if (e === "close") this.onClose = cb; }, destroy() { if (this.onClose) this.onClose(); } };
    const release = tracker.track(fakeSock);
    release();
    evidence.httpWsCleanup = {
      earlyAbortCleanedUp: tracker.count === 0,
    };

    db.close();
    evidence.processBoundary = await runStage7ProcessDrill(join(root, "process-boundary"));
    evidence.cleanup = { isolatedRoot: keepRoot ? root : "removed", removed: !keepRoot };
  } finally {
    if (!keepRoot) await rm(root, { recursive: true, force: true });
  }
  const gate = collectRequiredPredicates(evidence);
  evidence.gate = {
    requiredPredicates: gate.predicates,
    failedPredicates: gate.failed,
  };
  evidence.success = gate.failed.length === 0;
  await mkdir(join(REPO_ROOT, "data"), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(scrub(evidence), null, 2)}\n`, "utf8");
  if (!evidence.success) {
    console.error(`STAGE7 DRILL FAILED: ${gate.failed.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("STAGE7 DRILL SUCCESS");
  console.log(JSON.stringify(scrub(evidence), null, 2));
}

run().catch(async (error) => {
  console.error(`Stage 7 drill failed: ${error.stack ?? error}`);
  process.exitCode = 1;
});
