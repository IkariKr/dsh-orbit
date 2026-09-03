import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, openRegistryDatabase, withTransaction } from "../src/registry/sqlite.mjs";

test("in-memory registry has the fixed v0.4 table set", () => {
  const db = openRegistryDatabase(":memory:");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, [
    "audit",
    "browser_sessions",
    "enrollment_results",
    "enrollment_tokens",
    "events",
    "node_keys",
    "nodes",
    "reports",
    "route_targets",
    "seen_nonces",
  ]);
  const { user_version: version } = db.prepare("PRAGMA user_version").get();
  assert.equal(version, SCHEMA_VERSION);
  db.close();
});

test("a file-backed registry is WAL with durable schema version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-registry-"));
  try {
    const path = join(dir, "registry.db");
    const db = openRegistryDatabase(path);
    const { journal_mode: journal } = db.prepare("PRAGMA journal_mode").get();
    assert.equal(journal, "wal");
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    db.close();
    // Reopening is idempotent (migration no-ops on the current version).
    const again = openRegistryDatabase(path);
    assert.equal(again.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    again.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    again.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("node_keys foreign key rejects orphan rows", () => {
  const db = openRegistryDatabase(":memory:");
  assert.throws(() => db.prepare("INSERT INTO node_keys (node_id, key_id, public_key, state, created_at) VALUES (?, ?, ?, 'active', ?)").run("node_missing", "k1", "a".repeat(64), "now"));
  db.close();
});

test("route_targets foreign key rejects orphan rows", () => {
  const db = openRegistryDatabase(":memory:");
  assert.throws(() => db.prepare("INSERT INTO route_targets (node_id, route_target_origin, created_at, updated_at) VALUES (?, ?, ?, ?)").run("node_missing", "https://nas.example", "t", "t"));
  db.close();
});

async function makeLegacyPath(path, version) {
  const db = openRegistryDatabase(path);
  const nodeId = "node_" + "a".repeat(32);
  db.prepare("INSERT INTO nodes (node_id, state, minted_at, authenticated) VALUES (?, 'active', 't', 'ok')").run(nodeId);
  db.prepare("INSERT INTO reports (node_id, uploaded_at, orbit_version, dsh_version, compatibility, identity_json, checks_json, report_json) VALUES (?, 't', '0.3.0', 'd', 'pass', '{}', '{}', '{}')").run(nodeId);
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
  db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  db.close();
  return { nodeId };
}

async function corruptReportsLeafPage(path) {
  const db = new DatabaseSync(path);
  const pageSize = Number(db.prepare("PRAGMA page_size").get().page_size);
  const rootPage = Number(db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'reports'").get().rootpage);
  db.close();
  const bytes = await readFile(path);
  const pageOffset = (rootPage - 1) * pageSize;
  assert.equal(bytes[pageOffset], 0x0d, "reports root must be a table leaf page");
  assert.ok(bytes.readUInt16BE(pageOffset + 3) > 0, "reports leaf must contain a cell");
  bytes[pageOffset + 8] = 0;
  bytes[pageOffset + 9] = 1;
  await writeFile(path, bytes);
}

test("startup rejects valid-header business-page corruption before migration and preserves bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-registry-page-corrupt-"));
  try {
    const path = join(dir, "registry.db");
    await makeLegacyPath(path, 1);
    await corruptReportsLeafPage(path);
    const before = await readFile(path);
    assert.throws(() => openRegistryDatabase(path), (error) => error.code === "integrity-failed" && /pre-migration integrity_check/.test(error.message));
    assert.deepEqual(await readFile(path), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup rejects an existing foreign-key violation before migration and preserves bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-registry-fk-corrupt-"));
  try {
    const path = join(dir, "registry.db");
    const { nodeId } = await makeLegacyPath(path, 1);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO node_keys (node_id, key_id, public_key, state, created_at) VALUES (?, 'orphan', ?, 'active', 't')").run("node_missing", "a".repeat(64));
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    db.close();
    const before = await readFile(path);
    assert.equal(nodeId.length, 37);
    assert.throws(() => openRegistryDatabase(path), (error) => error.code === "integrity-failed" && /foreign_key_check/.test(error.message));
    assert.deepEqual(await readFile(path), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withTransaction rolls back on failure and keeps the committed work", () => {
  const db = openRegistryDatabase(":memory:");
  withTransaction(db, () => {
    db.prepare("INSERT INTO nodes (node_id, state, minted_at, authenticated) VALUES ('node_a', 'active', 't', 'ok')").run();
  });
  assert.throws(() =>
    withTransaction(db, () => {
      db.prepare("INSERT INTO nodes (node_id, state, minted_at, authenticated) VALUES ('node_b', 'active', 't', 'ok')").run();
      throw new Error("boom");
    }),
  );
  const rows = db.prepare("SELECT node_id FROM nodes ORDER BY node_id").all();
  assert.deepEqual(rows.map((row) => row.node_id), ["node_a"]);
  db.close();
});

test("uniqueness constraints are transactional", () => {
  const db = openRegistryDatabase(":memory:");
  db.prepare("INSERT INTO seen_nonces (node_id, nonce, created_at) VALUES ('node_a', 'n1', 't')").run();
  assert.throws(() => db.prepare("INSERT INTO seen_nonces (node_id, nonce, created_at) VALUES ('node_a', 'n1', 't')").run());
  db.close();
});

test("a v1 database migrates in place to the current schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-registry-v1-"));
  try {
    const path = join(dir, "registry.db");
    await makeLegacyPath(path, 1);

    const upgraded = openRegistryDatabase(path);
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    const nodeColumns = upgraded.prepare("PRAGMA table_info(nodes)").all().map((row) => row.name);
    assert.equal(nodeColumns.includes("alert_flags"), true);
    assert.equal(nodeColumns.includes("last_heartbeat_at"), true);
    const sessionColumns = upgraded.prepare("PRAGMA table_info(browser_sessions)").all().map((row) => row.name);
    assert.equal(sessionColumns.includes("expiry_audited_at"), true);
    const tables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    assert.equal(tables.includes("route_targets"), true);
    upgraded
      .prepare("INSERT INTO nodes (node_id, state, minted_at, authenticated) VALUES ('node_v1', 'active', 't', 'ok')")
      .run();
    assert.deepEqual(JSON.parse(upgraded.prepare("SELECT alert_flags FROM nodes WHERE node_id = 'node_v1'").get().alert_flags), []);
    upgraded.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    upgraded.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed legacy schema fails closed before migration mutates the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-registry-malformed-v1-"));
  try {
    const path = join(dir, "registry.db");
    await makeLegacyPath(path, 1);
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE reports");
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    db.close();
    const before = await readFile(path);
    assert.throws(() => openRegistryDatabase(path), (error) => error.code === "malformed-schema");
    const after = await readFile(path);
    assert.deepEqual(after, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a v2 database migrates in place to the current schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-registry-v2-"));
  try {
    const path = join(dir, "registry.db");
    await makeLegacyPath(path, 2);

    const upgraded = openRegistryDatabase(path);
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    const nodeColumns = upgraded.prepare("PRAGMA table_info(nodes)").all().map((row) => row.name);
    assert.equal(nodeColumns.includes("last_heartbeat_at"), true);
    const tables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    assert.equal(tables.includes("route_targets"), true);
    upgraded.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    upgraded.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("v2->v3 state migration: heartbeat-sourced contact backfills, other old claims fail closed to unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-registry-v2state-"));
  try {
    const path = join(dir, "registry.db");
    await makeLegacyPath(path, 2);
    const db = new DatabaseSync(path);
    // Craft a REAL v2 database with the old (pre-v3) contact semantics:
    // both nodes claim fresh, one via heartbeat traffic, one via report
    // uploads only.
    db.prepare(
      "INSERT INTO nodes (node_id, state, minted_at, authenticated, registry_contact, last_seen, last_seen_source) VALUES ('node_beat', 'active', 't', 'ok', 'fresh', ?, 'heartbeat')",
    ).run("2026-08-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO nodes (node_id, state, minted_at, authenticated, registry_contact, last_seen, last_seen_source) VALUES ('node_report', 'active', 't', 'ok', 'fresh', ?, 'report-upload')",
    ).run("2026-08-30T00:00:00.000Z");
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    db.close();

    const upgraded = openRegistryDatabase(path);
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    const beat = upgraded.prepare("SELECT last_heartbeat_at, registry_contact FROM nodes WHERE node_id = 'node_beat'").get();
    assert.equal(beat.last_heartbeat_at, "2026-08-01T00:00:00.000Z");
    assert.equal(beat.registry_contact, "fresh");
    const report = upgraded.prepare("SELECT last_heartbeat_at, registry_contact FROM nodes WHERE node_id = 'node_report'").get();
    assert.equal(report.last_heartbeat_at, null);
    assert.equal(report.registry_contact, "unknown");

    // Startup-style immediate maintenance on 2026-08-31: the backfilled
    // heartbeat node ages to lost; the fail-closed node stays unknown.
    const { Registry } = await import("../src/registry/registry.mjs");
    const clock = { now: new Date("2026-08-31T00:00:00.000Z") };
    const registry = new Registry({ db: upgraded, now: () => clock.now });
    registry.maintenance();
    const aged = registry.getNode("node_beat");
    assert.equal(aged.health.registryContact, "lost");
    assert.deepEqual(aged.health.alertFlags, ["contact-lost"]);
    assert.equal(aged.health.reachable, "unknown");
    assert.equal(registry.getNode("node_report").health.registryContact, "unknown");
    registry.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a v3 database migrates in place to the current schema with route_targets and reachable domain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-registry-v3-"));
  try {
    const path = join(dir, "registry.db");
    const { nodeId } = await makeLegacyPath(path, 3);

    const upgraded = openRegistryDatabase(path);
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    const tables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    assert.equal(tables.includes("route_targets"), true);
    // Migrated nodes keep reachable = 'unknown'
    const row = upgraded.prepare("SELECT reachable FROM nodes WHERE node_id = ?").get(nodeId);
    assert.equal(row.reachable, "unknown");
    // Verify reachable domain accepts ok and unreachable in v4
    upgraded.prepare("UPDATE nodes SET reachable = 'ok' WHERE node_id = ?").run(nodeId);
    assert.equal(upgraded.prepare("SELECT reachable FROM nodes WHERE node_id = ?").get(nodeId).reachable, "ok");
    upgraded.prepare("UPDATE nodes SET reachable = 'unreachable' WHERE node_id = ?").run(nodeId);
    assert.equal(upgraded.prepare("SELECT reachable FROM nodes WHERE node_id = ?").get(nodeId).reachable, "unreachable");
    // Invalid reachable value fails constraint
    assert.throws(() => upgraded.prepare("UPDATE nodes SET reachable = 'invalid' WHERE node_id = ?").run(nodeId));
    upgraded.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    upgraded.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});