#!/usr/bin/env node
// Stage 7 operational hardening drill. This is intentionally separate from
// the Stage 6 mounted driver and uses a fresh file-backed registry per run.
// It records migration and backup -> mutate -> restore evidence without
// storing private keys, plaintext tokens, CSRF values, or other secrets.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { backupRegistryDatabase, inspectRegistryDatabase, restoreRegistryDatabase } from "../src/registry/backup.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { openRegistryDatabase, SCHEMA_VERSION } from "../src/registry/sqlite.mjs";
import { generateNodeKeyPair, deriveKeyId } from "../src/registry/crypto.mjs";

const REPO_ROOT = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const runId = `stage7-${new Date().toISOString().replaceAll(/[-:.TZ]/g, "")}-${process.pid}`;
const outputPath = process.env.DSH_ORBIT_STAGE7_EVIDENCE ?? join(REPO_ROOT, "data", "stage7-drill-evidence.json");
const keepRoot = process.env.DSH_ORBIT_STAGE7_KEEP_ROOT === "1";

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function scrub(value, key = "") {
  if (/plaintext|tokenreturned|tokenpresent|secretpresent/i.test(key)) return typeof value === "boolean" ? value : "[redacted]";
  if (Array.isArray(value)) return value.map((child) => scrub(child, key));
  if (value && typeof value === "object") {
    const result = {};
    for (const [childKey, child] of Object.entries(value)) {
      if (/digest|csrf|private|password/i.test(childKey)) continue;
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

async function run() {
  const root = await mkdtemp(join(tmpdir(), "orbit-stage7-") );
  const evidence = {
    stage: "7",
    runId,
    testedCommit: git(["rev-parse", "HEAD"]),
    branch: git(["branch", "--show-current"]),
    cleanWorktreeBefore: git(["status", "--porcelain"]) === "",
    nodeVersion: process.version,
    schemaVersion: SCHEMA_VERSION,
    thresholds: { heartbeatCadenceSeconds: 60, staleMissedBeats: 3, lostAfterHours: 24, reportRetentionDays: 90, eventRetentionDays: 90, auditRetentionDays: 365 },
    migration: {},
    backupRestore: {},
    freshInstall: {},
    cleanup: {},
  };
  try {
    const migrationRoot = join(root, "migrations");
    await mkdir(migrationRoot, { recursive: true });
    for (const version of [1, 2, 3]) {
      const path = join(migrationRoot, `v${version}.db`);
      if (version === 3) {
        const db = openRegistryDatabase(path);
        seedNode(db, "node_33333333333333333333333333333333", "3");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close();
      } else {
        migrationDatabase(path, version);
      }
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
        idempotent,
        preservedState: after.rowCounts.nodes === 1 && after.rowCounts.node_keys === 1,
        noOpCurrent: version === 3,
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
    evidence.failureModes = {
      futureSchemaRejected: futureRejected,
      corruptDatabaseRejected: corruptRejected,
      futureDatabaseUnchanged: Buffer.compare(futureBeforeBytes, futureAfterBytes) === 0,
      corruptDatabaseUnchanged: Buffer.compare(corruptAfterBytes, corruptBytes) === 0,
      noRebuildOrOverwrite: futureRejected && corruptRejected && Buffer.compare(corruptAfterBytes, corruptBytes) === 0,
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
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    const backup = await backupRegistryDatabase({ db, sourcePath: freshPath, destinationPath: backupPath });
    db.prepare("UPDATE nodes SET registry_contact = 'lost', alert_flags = '[\"contact-lost\"]'").run();
    db.prepare("INSERT INTO audit (at, actor, action, detail_json) VALUES ('2026-08-31T01:00:00.000Z', 'operator', 'stage7.mutation', '{}')").run();
    const mutated = inspectRegistryDatabase(freshPath);
    db.close();
    const restore = await restoreRegistryDatabase({ backupPath, targetPath: freshPath, writersQuiesced: true });
    db = openRegistryDatabase(freshPath);
    const restoredState = inspectRegistryDatabase(freshPath);
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
    };
    db.close();
    evidence.cleanup = { isolatedRoot: keepRoot ? root : "removed", removed: !keepRoot };
  } finally {
    if (!keepRoot) await rm(root, { recursive: true, force: true });
  }
  await mkdir(join(REPO_ROOT, "data"), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(scrub(evidence), null, 2)}\n`, "utf8");
  console.log(JSON.stringify(scrub(evidence), null, 2));
}

run().catch((error) => {
  console.error(`Stage 7 drill failed: ${error.stack ?? error}`);
  process.exitCode = 1;
});
