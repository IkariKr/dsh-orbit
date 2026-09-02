import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  backupRegistryDatabase,
  inspectRegistryDatabase,
  restoreRegistryDatabase,
  RegistryBackupError,
} from "../src/registry/backup.mjs";
import { openRegistryDatabase, SCHEMA_VERSION } from "../src/registry/sqlite.mjs";

async function fixtureDir(t, prefix = "orbit-registry-backup-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function insertMeaningfulState(db, suffix = "a") {
  db.prepare(
    "INSERT INTO nodes (node_id, state, minted_at, authenticated, registry_contact, dsh_healthy, orbit_compatible, capabilities, capabilities_stale, last_seen, last_seen_source, orbit_version, orbit_revision, dsh_version, compatibility_profile) VALUES (?, 'active', ?, 'ok', 'fresh', 'ok', 'pass', ?, 0, ?, 'heartbeat', '0.3.0', 'stage7', '0.1.1-rc.2', 'dsh-0.1.1-rc.2')",
  ).run(
    `node_${suffix.repeat(32)}`,
    "2026-08-31T00:00:00.000Z",
    JSON.stringify([{ name: "sessions.resume", source: "report" }]),
    "2026-08-31T00:00:00.000Z",
  );
  db.prepare(
    "INSERT INTO node_keys (node_id, key_id, public_key, state, created_at) VALUES (?, ?, ?, 'active', ?)",
  ).run(
    `node_${suffix.repeat(32)}`,
    `${suffix.repeat(32)}`,
    `${suffix.repeat(64)}`,
    "2026-08-31T00:00:00.000Z",
  );
  db.prepare(
    "INSERT INTO reports (node_id, uploaded_at, orbit_version, orbit_revision, dsh_version, compatibility_profile, compatibility, identity_json, checks_json, report_json) VALUES (?, ?, '0.3.0', 'stage7', '0.1.1-rc.2', 'dsh-0.1.1-rc.2', 'pass', '{}', '{}', '{}')",
  ).run(`node_${suffix.repeat(32)}`, "2026-08-31T00:00:00.000Z");
  db.prepare(
    "INSERT INTO events (node_id, at, dimension, from_value, to_value, source) VALUES (?, ?, 'registry_contact', 'unknown', 'fresh', 'heartbeat')",
  ).run(`node_${suffix.repeat(32)}`, "2026-08-31T00:00:00.000Z");
  db.prepare(
    "INSERT INTO audit (at, actor, action, detail_json) VALUES (?, 'operator', 'stage7.seed', '{}')",
  ).run("2026-08-31T00:00:00.000Z");
}

test("SQLite backup uses a consistent standalone image and preserves WAL state", async (t) => {
  const dir = await fixtureDir(t);
  const sourcePath = join(dir, "registry.db");
  const backupPath = join(dir, "backups", "registry.db");
  const db = openRegistryDatabase(sourcePath);
  insertMeaningfulState(db);
  const before = inspectRegistryDatabase(sourcePath);
  const result = await backupRegistryDatabase({ db, sourcePath, destinationPath: backupPath });
  assert.equal(result.method, "sqlite-vacuum-into");
  assert.equal(result.source.stateDigest, before.stateDigest);
  assert.equal(result.backup.stateDigest, before.stateDigest);
  assert.equal(result.backup.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.source.journalMode, "wal");
  assert.equal(result.backup.journalMode, "delete");
  assert.equal(result.backupWalPresent, false);
  assert.equal(result.backupShmPresent, false);
  const backupDb = new DatabaseSync(backupPath);
  assert.equal(backupDb.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  backupDb.close();
  db.close();
});

test("restore refuses to run while Registry writers may still be active", async (t) => {
  const dir = await fixtureDir(t, "orbit-registry-restore-quiescence-");
  const sourcePath = join(dir, "registry.db");
  const backupPath = join(dir, "registry-backup.db");
  const db = openRegistryDatabase(sourcePath);
  insertMeaningfulState(db);
  await backupRegistryDatabase({ db, sourcePath, destinationPath: backupPath });
  db.close();
  await assert.rejects(
    () => restoreRegistryDatabase({ backupPath, targetPath: sourcePath }),
    (error) => error instanceof RegistryBackupError && error.code === "writers-active",
  );
});

test("backup rejects overwrite and restores after mutations with WAL sidecars quarantined", async (t) => {
  const dir = await fixtureDir(t);
  const sourcePath = join(dir, "registry.db");
  const backupPath = join(dir, "registry-backup.db");
  const db = openRegistryDatabase(sourcePath);
  insertMeaningfulState(db);
  await backupRegistryDatabase({ db, sourcePath, destinationPath: backupPath });
  await assert.rejects(
    () => backupRegistryDatabase({ db, sourcePath, destinationPath: backupPath }),
    (error) => error instanceof RegistryBackupError && error.code === "destination-exists",
  );

  db.prepare("UPDATE nodes SET registry_contact = 'lost', alert_flags = '[\"contact-lost\"]'").run();
  db.prepare("INSERT INTO audit (at, actor, action, detail_json) VALUES ('2026-08-31T01:00:00.000Z', 'operator', 'stage7.mutation', '{}')").run();
  db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
  const mutated = inspectRegistryDatabase(sourcePath);
  assert.notEqual(mutated.stateDigest, inspectRegistryDatabase(backupPath).stateDigest);

  // Simulate a live database's sidecars. Restore is an offline operation, but
  // stale sidecars must be quarantined rather than paired with the backup.
  db.close();
  await writeFile(`${sourcePath}-wal`, "stale-wal");
  await writeFile(`${sourcePath}-shm`, "stale-shm");

  const restored = await restoreRegistryDatabase({ backupPath, targetPath: sourcePath, writersQuiesced: true });
  assert.equal(restored.method, "sqlite-standalone-atomic-restore");
  assert.equal(restored.backup.stateDigest, restored.restored.stateDigest);
  assert.equal(restored.quarantinedSidecars, 2);
  assert.equal(inspectRegistryDatabase(sourcePath).stateDigest, inspectRegistryDatabase(backupPath).stateDigest);
  assert.equal(inspectRegistryDatabase(sourcePath).rowCounts.nodes, 1);
  const quarantineStat = await stat(restored.quarantinePath);
  assert.equal(quarantineStat.isDirectory(), true);
  assert.equal(await stat(join(restored.quarantinePath, "registry.db")).then((entry) => entry.isFile()), true);
  assert.equal(await stat(join(restored.quarantinePath, "registry.db-wal")).then((entry) => entry.isFile()), true);
  assert.equal(await stat(join(restored.quarantinePath, "registry.db-shm")).then((entry) => entry.isFile()), true);

  const reopened = openRegistryDatabase(sourcePath);
  assert.equal(inspectRegistryDatabase(sourcePath).stateDigest, inspectRegistryDatabase(backupPath).stateDigest);
  reopened.close();
});

test("fresh, backup, and restored Registry images are explicitly private on POSIX", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits are not applicable on Windows");
    return;
  }
  const dir = await fixtureDir(t, "orbit-registry-permissions-");
  const sourcePath = join(dir, "registry.db");
  const backupPath = join(dir, "backup", "registry.db");
  const db = openRegistryDatabase(sourcePath);
  assert.equal((await stat(sourcePath)).mode & 0o777, 0o600);
  await backupRegistryDatabase({ db, sourcePath, destinationPath: backupPath });
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  db.close();
  await restoreRegistryDatabase({ backupPath, targetPath: sourcePath, writersQuiesced: true });
  assert.equal((await stat(sourcePath)).mode & 0o777, 0o600);
});

test("future, malformed, and corrupt databases fail closed without rebuilding the source", async (t) => {
  const dir = await fixtureDir(t);
  const futurePath = join(dir, "future.db");
  const future = openRegistryDatabase(futurePath);
  insertMeaningfulState(future);
  future.exec("PRAGMA user_version = 99");
  future.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  future.close();
  const futureBytes = await readFile(futurePath);
  assert.throws(
    () => openRegistryDatabase(futurePath),
    (error) => error.code === "unsupported-schema" && /newer than supported/.test(error.message),
  );
  assert.deepEqual(await readFile(futurePath), futureBytes);
  assert.throws(
    () => inspectRegistryDatabase(futurePath),
    (error) => error instanceof RegistryBackupError && error.code === "schema-mismatch",
  );
  assert.throws(
    () => inspectRegistryDatabase(join(dir, "missing.db")),
    (error) => error instanceof RegistryBackupError && error.code === "missing-database",
  );

  const malformedPath = join(dir, "malformed.db");
  const malformed = openRegistryDatabase(malformedPath);
  malformed.exec("DROP INDEX idx_audit_at");
  malformed.exec("CREATE INDEX idx_audit_at ON audit (actor)");
  malformed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  malformed.close();
  const malformedBytes = await readFile(malformedPath);
  assert.throws(
    () => openRegistryDatabase(malformedPath),
    (error) => error.code === "malformed-schema" && /indexes do not match/.test(error.message),
  );
  assert.deepEqual(await readFile(malformedPath), malformedBytes);

  const corruptPath = join(dir, "corrupt.db");
  const corruptBytes = Buffer.from("this is not sqlite\n", "utf8");
  await writeFile(corruptPath, corruptBytes);
  assert.throws(
    () => openRegistryDatabase(corruptPath),
    (error) => error.code === "corrupt-database" || error.code === "database-open-failed",
  );
  assert.deepEqual(await readFile(corruptPath), corruptBytes);
});
