// Registry-specific SQLite operational backup and restore. This module is
// deliberately separate from the storage-agnostic upgrade snapshot contract.
// A live registry is snapshotted with SQLite's VACUUM INTO, never by copying
// the database file while its WAL may contain committed state.

import { copyFile, mkdir, rename, rm, access } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "./crypto.mjs";
import { SCHEMA_VERSION, registrySchemaShape, validateRegistrySchema } from "./sqlite.mjs";

export class RegistryBackupError extends Error {
  constructor(code, message, { cause = null } = {}) {
    super(message, { cause });
    this.name = "RegistryBackupError";
    this.code = code;
  }
}

const STATE_TABLES = [
  ["nodes", "SELECT * FROM nodes ORDER BY node_id"],
  ["node_keys", "SELECT * FROM node_keys ORDER BY node_id, key_id"],
  [
    "enrollment_tokens",
    "SELECT token_id, purpose, bound_node_id, created_at, expires_at, consumed_at, consumed_by FROM enrollment_tokens ORDER BY token_id",
  ],
  ["enrollment_results", "SELECT * FROM enrollment_results ORDER BY idempotency_key"],
  ["seen_nonces", "SELECT * FROM seen_nonces ORDER BY node_id, nonce"],
  ["reports", "SELECT * FROM reports ORDER BY id"],
  ["events", "SELECT * FROM events ORDER BY id"],
  ["audit", "SELECT * FROM audit ORDER BY id"],
  [
    "browser_sessions",
    "SELECT session_id, operator_principal, created_at, expires_at, idle_until, revoked_at, expiry_audited_at FROM browser_sessions ORDER BY session_id",
  ],
];

function requirePath(path, label) {
  if (typeof path !== "string" || path === "" || path === ":memory:") {
    throw new RegistryBackupError("invalid-path", `${label} must be a file-backed SQLite path`);
  }
  return resolve(path);
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function classify(error, fallback = "backup-failed") {
  if (error instanceof RegistryBackupError) return error;
  const message = String(error?.message ?? error);
  if (/not a database|file is encrypted|malformed/i.test(message)) {
    return new RegistryBackupError("corrupt-database", message, { cause: error });
  }
  if (/integrity|foreign key|schema|no such table|no such column/i.test(message)) {
    return new RegistryBackupError("invalid-backup", message, { cause: error });
  }
  return new RegistryBackupError(fallback, message, { cause: error });
}

function safeRows(db, sql) {
  return db.prepare(sql).all();
}

function safeState(db) {
  const state = {};
  for (const [name, sql] of STATE_TABLES) state[name] = safeRows(db, sql);
  return state;
}

function countRows(db) {
  const counts = {};
  for (const [name] of STATE_TABLES) {
    counts[name] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count);
  }
  return counts;
}

function integrity(db) {
  const result = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
  if (result !== "ok") {
    throw new RegistryBackupError("integrity-failed", `registry database integrity_check returned ${JSON.stringify(result)}`);
  }
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) {
    throw new RegistryBackupError("integrity-failed", "registry database foreign_key_check returned violations");
  }
  return { integrityCheck: result, foreignKeyViolations: 0 };
}

// Inspection does not run migrations or write application data. A normal
// SQLite handle is used so WAL-backed sources report their actual journal
// mode; the helper never changes that mode or copies its sidecars. The digest
// deliberately omits token digests and CSRF secrets while preserving all
// operationally meaningful business state.
export function inspectRegistryDatabase(path) {
  const filePath = requirePath(path, "database path");
  let db;
  try {
    if (!existsSync(filePath)) {
      throw new RegistryBackupError("missing-database", `registry database ${filePath} does not exist`);
    }
    db = new DatabaseSync(filePath);
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== SCHEMA_VERSION) {
      throw new RegistryBackupError(
        "schema-mismatch",
        `registry database schema ${version} does not match supported ${SCHEMA_VERSION}`,
      );
    }
    validateRegistrySchema(db);
    const journalMode = String(db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "").toLowerCase();
    const integrityResult = integrity(db);
    const counts = countRows(db);
    const state = safeState(db);
    const stateDigest = sha256Hex(JSON.stringify(state));
    return {
      schemaVersion: version,
      schemaShape: registrySchemaShape(db),
      journalMode,
      ...integrityResult,
      rowCounts: counts,
      stateDigest,
    };
  } catch (error) {
    throw classify(error, "inspect-failed");
  } finally {
    try {
      db?.close();
    } catch {
      // Preserve the inspection error.
    }
  }
}

function sidecars(path) {
  return [`${path}-wal`, `${path}-shm`];
}

async function ensureAbsent(path, label) {
  if (await exists(path)) {
    throw new RegistryBackupError("destination-exists", `${label} already exists; refusing to overwrite it`);
  }
}

export async function backupRegistryDatabase({ db, sourcePath, destinationPath }) {
  if (!db || typeof db.prepare !== "function") {
    throw new RegistryBackupError("invalid-source", "backup requires an open Registry SQLite connection");
  }
  const source = requirePath(sourcePath, "source database path");
  const destination = requirePath(destinationPath, "backup destination path");
  if (source === destination) {
    throw new RegistryBackupError("invalid-path", "backup destination must differ from the source database");
  }
  await mkdir(dirname(destination), { recursive: true });
  await ensureAbsent(destination, "backup destination");
  const sourceInspection = inspectRegistryDatabase(source);
  const temporary = `${destination}.partial-${process.pid}-${Date.now()}`;
  try {
    // VACUUM INTO creates a standalone consistent image including committed
    // WAL state. It must run outside an application transaction.
    db.prepare("VACUUM INTO ?").run(temporary);
    const backupInspection = inspectRegistryDatabase(temporary);
    if (backupInspection.stateDigest !== sourceInspection.stateDigest) {
      throw new RegistryBackupError("backup-mismatch", "SQLite backup state digest differs from the live source");
    }
    await rename(temporary, destination);
    return {
      method: "sqlite-vacuum-into",
      sourcePath: source,
      backupPath: destination,
      source: sourceInspection,
      backup: inspectRegistryDatabase(destination),
      sourceWalPresent: await exists(`${source}-wal`),
      sourceShmPresent: await exists(`${source}-shm`),
      backupWalPresent: await exists(`${destination}-wal`),
      backupShmPresent: await exists(`${destination}-shm`),
    };
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch {
      // Preserve the original backup failure.
    }
    throw classify(error);
  }
}

export async function restoreRegistryDatabase({ backupPath, targetPath }) {
  const backup = requirePath(backupPath, "backup path");
  const target = requirePath(targetPath, "restore target path");
  if (backup === target) {
    throw new RegistryBackupError("invalid-path", "restore backup and target must differ");
  }
  const backupInspection = inspectRegistryDatabase(backup);
  await mkdir(dirname(target), { recursive: true });
  const stage = `${target}.restore-stage-${process.pid}-${Date.now()}`;
  const quarantine = `${target}.pre-restore-${process.pid}-${Date.now()}`;
  const targetSidecars = sidecars(target);
  const quarantined = [];
  let staged = false;
  try {
    await ensureAbsent(stage, "restore staging path");
    await copyFile(backup, stage);
    staged = true;
    const stagedInspection = inspectRegistryDatabase(stage);
    if (stagedInspection.stateDigest !== backupInspection.stateDigest) {
      throw new RegistryBackupError("restore-mismatch", "restore staging digest differs from the validated backup");
    }

    const targetExists = await exists(target);
    const sidecarExists = [];
    for (const sidecar of targetSidecars) sidecarExists.push([sidecar, await exists(sidecar)]);
    if (targetExists || sidecarExists.some(([, present]) => present)) await mkdir(quarantine);
    if (targetExists) {
      const quarantinedDb = join(quarantine, "registry.db");
      await rename(target, quarantinedDb);
      quarantined.push([quarantinedDb, target]);
    }
    for (const [sidecar, present] of sidecarExists) {
      if (!present) continue;
      const quarantinedSidecar = join(quarantine, sidecar.endsWith("-wal") ? "registry.db-wal" : "registry.db-shm");
      await rename(sidecar, quarantinedSidecar);
      quarantined.push([quarantinedSidecar, sidecar]);
    }
    await rename(stage, target);
    staged = false;
    const restored = inspectRegistryDatabase(target);
    if (restored.stateDigest !== backupInspection.stateDigest) {
      throw new RegistryBackupError("restore-mismatch", "restored database digest differs from the validated backup");
    }
    return {
      method: "sqlite-standalone-atomic-restore",
      backupPath: backup,
      targetPath: target,
      quarantinePath: quarantined.length > 0 ? quarantine : null,
      backup: backupInspection,
      restored,
      quarantinedSidecars: quarantined.filter(([from]) => /-(?:wal|shm)$/.test(from)).length,
    };
  } catch (error) {
    if (staged) {
      try {
        await rm(stage, { force: true });
      } catch {}
    }
    // If publishing the staged image failed after quarantine, put the old
    // database and sidecars back before surfacing the failure.
    if (!(await exists(target))) {
      for (const [from, to] of [...quarantined].reverse()) {
        try {
          if (await exists(from)) await rename(from, to);
        } catch {
          // The original error remains the primary signal; quarantine is kept.
        }
      }
    }
    throw classify(error, "restore-failed");
  }
}
