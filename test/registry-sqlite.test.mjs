import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SCHEMA_VERSION, openRegistryDatabase, withTransaction } from "../src/registry/sqlite.mjs";

test("in-memory registry has the fixed v0.3 table set", () => {
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
    const db = openRegistryDatabase(path);
    // Simulate a v1 database: drop the v2/v3 columns and rewind.
    db.exec("ALTER TABLE nodes DROP COLUMN alert_flags");
    db.exec("ALTER TABLE nodes DROP COLUMN last_heartbeat_at");
    db.exec("ALTER TABLE browser_sessions DROP COLUMN expiry_audited_at");
    db.exec("PRAGMA user_version = 1");
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    db.close();

    const upgraded = openRegistryDatabase(path);
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    const nodeColumns = upgraded.prepare("PRAGMA table_info(nodes)").all().map((row) => row.name);
    assert.equal(nodeColumns.includes("alert_flags"), true);
    assert.equal(nodeColumns.includes("last_heartbeat_at"), true);
    const sessionColumns = upgraded.prepare("PRAGMA table_info(browser_sessions)").all().map((row) => row.name);
    assert.equal(sessionColumns.includes("expiry_audited_at"), true);
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

test("a v2 database migrates in place to the current schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-registry-v2-"));
  try {
    const path = join(dir, "registry.db");
    const db = openRegistryDatabase(path);
    db.exec("ALTER TABLE nodes DROP COLUMN last_heartbeat_at");
    db.exec("ALTER TABLE browser_sessions DROP COLUMN expiry_audited_at");
    db.exec("PRAGMA user_version = 2");
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    db.close();

    const upgraded = openRegistryDatabase(path);
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    const nodeColumns = upgraded.prepare("PRAGMA table_info(nodes)").all().map((row) => row.name);
    assert.equal(nodeColumns.includes("last_heartbeat_at"), true);
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
    const db = openRegistryDatabase(path);
    // Craft a REAL v2 database with the old (pre-v3) contact semantics:
    // both nodes claim fresh, one via heartbeat traffic, one via report
    // uploads only.
    db.exec("ALTER TABLE nodes DROP COLUMN last_heartbeat_at");
    db.exec("ALTER TABLE browser_sessions DROP COLUMN expiry_audited_at");
    db.exec("PRAGMA user_version = 2");
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