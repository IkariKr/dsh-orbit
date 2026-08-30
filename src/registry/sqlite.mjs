// SQLite/WAL registry persistence for the v0.3 registry (RFC-0005 D7).
// Single writer connection with BEGIN IMMEDIATE; readers use the WAL
// snapshot. The table set is exactly the fixed contract: nodes,
// node_keys, enrollment_tokens, enrollment_results, seen_nonces,
// reports, events, audit, browser_sessions.

import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 2;

// v1 -> v2: nodes gains the operator alert-flag column (RFC-0009
// "lost + operator alert flag", P1-02 of the phase-1 implementation
// review). Fresh databases create the full v2 shape; existing v1
// databases are upgraded in place.
const upgradeSteps = {
  1: ["ALTER TABLE nodes ADD COLUMN alert_flags TEXT NOT NULL DEFAULT '[]'"],
};

const schemaStatements = [
  `
  CREATE TABLE nodes (
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
    capabilities TEXT NOT NULL DEFAULT '[]',
    capabilities_stale INTEGER NOT NULL DEFAULT 1,
    last_seen TEXT,
    last_seen_source TEXT,
    orbit_version TEXT NOT NULL DEFAULT '',
    orbit_revision TEXT,
    dsh_version TEXT NOT NULL DEFAULT '',
    compatibility_profile TEXT
  )`,
  `
  CREATE TABLE node_keys (
    node_id TEXT NOT NULL REFERENCES nodes(node_id),
    key_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    created_at TEXT NOT NULL,
    revoke_after TEXT,
    revoked_at TEXT,
    revocation_reason TEXT,
    PRIMARY KEY (node_id, key_id)
  )`,
  `
  CREATE TABLE enrollment_tokens (
    token_id TEXT PRIMARY KEY,
    token_digest TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL CHECK (purpose IN ('enroll', 'reenroll')),
    bound_node_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    consumed_by TEXT
  )`,
  `
  CREATE TABLE enrollment_results (
    idempotency_key TEXT PRIMARY KEY,
    token_digest TEXT NOT NULL,
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('enroll', 'reenroll')),
    node_id TEXT,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `
  CREATE TABLE seen_nonces (
    node_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (node_id, nonce)
  )`,
  `
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL REFERENCES nodes(node_id),
    uploaded_at TEXT NOT NULL,
    orbit_version TEXT NOT NULL,
    orbit_revision TEXT,
    dsh_version TEXT NOT NULL,
    compatibility_profile TEXT,
    compatibility TEXT NOT NULL,
    identity_json TEXT NOT NULL,
    checks_json TEXT NOT NULL,
    report_json TEXT NOT NULL
  )`,
  `
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    at TEXT NOT NULL,
    dimension TEXT NOT NULL,
    from_value TEXT NOT NULL,
    to_value TEXT NOT NULL,
    source TEXT NOT NULL
  )`,
  `
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL
  )`,
  `
  CREATE TABLE browser_sessions (
    session_id TEXT PRIMARY KEY,
    operator_principal TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    idle_until TEXT NOT NULL,
    revoked_at TEXT
  )`,
  `
  CREATE INDEX idx_seen_nonces_created_at ON seen_nonces (created_at)`,
  `
  CREATE INDEX idx_reports_node_uploaded ON reports (node_id, uploaded_at DESC)`,
  `
  CREATE INDEX idx_events_node_at ON events (node_id, at)`,
  `
  CREATE INDEX idx_audit_at ON audit (at)`,
];

export function openRegistryDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db) {
  const { user_version: version } = db.prepare("PRAGMA user_version").get();
  if (version > SCHEMA_VERSION) {
    throw new Error(`registry database schema ${version} is newer than supported ${SCHEMA_VERSION}`);
  }
  if (version < SCHEMA_VERSION) {
    if (version === 0) {
      withTransaction(db, () => {
        for (const statement of schemaStatements) {
          db.exec(statement);
        }
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
      return;
    }
    for (let current = version; current < SCHEMA_VERSION; current += 1) {
      const steps = upgradeSteps[current];
      if (!steps) {
        throw new Error(`registry database schema ${current}: no upgrade path to ${SCHEMA_VERSION}`);
      }
      withTransaction(db, () => {
        for (const statement of steps) {
          db.exec(statement);
        }
        db.exec(`PRAGMA user_version = ${current + 1}`);
      });
    }
  }
}

export function withTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The connection is unusable; the caller's error is the real signal.
    }
    throw error;
  }
}

export function nowIso(now = new Date()) {
  return now.toISOString();
}