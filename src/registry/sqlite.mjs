// SQLite/WAL registry persistence for the v0.3 registry (RFC-0005 D7).
// Single writer connection with BEGIN IMMEDIATE; readers use the WAL
// snapshot. The table set is exactly the fixed contract: nodes,
// node_keys, enrollment_tokens, enrollment_results, seen_nonces,
// reports, events, audit, browser_sessions.

import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 3;

export class RegistryDatabaseError extends Error {
  constructor(code, message, { cause = null } = {}) {
    super(message, { cause });
    this.name = "RegistryDatabaseError";
    this.code = code;
  }
}

const EXPECTED_TABLE_COLUMNS = {
  nodes: [
    "node_id",
    "state",
    "minted_at",
    "tombstoned_at",
    "tombstone_reason",
    "registry_contact",
    "authenticated",
    "dsh_healthy",
    "orbit_compatible",
    "reachable",
    "alert_flags",
    "last_heartbeat_at",
    "capabilities",
    "capabilities_stale",
    "last_seen",
    "last_seen_source",
    "orbit_version",
    "orbit_revision",
    "dsh_version",
    "compatibility_profile",
  ],
  node_keys: [
    "node_id",
    "key_id",
    "public_key",
    "state",
    "created_at",
    "revoke_after",
    "revoked_at",
    "revocation_reason",
  ],
  enrollment_tokens: [
    "token_id",
    "token_digest",
    "purpose",
    "bound_node_id",
    "created_at",
    "expires_at",
    "consumed_at",
    "consumed_by",
  ],
  enrollment_results: [
    "idempotency_key",
    "token_digest",
    "request_id",
    "kind",
    "node_id",
    "result_json",
    "created_at",
  ],
  seen_nonces: ["node_id", "nonce", "created_at"],
  reports: [
    "id",
    "node_id",
    "uploaded_at",
    "orbit_version",
    "orbit_revision",
    "dsh_version",
    "compatibility_profile",
    "compatibility",
    "identity_json",
    "checks_json",
    "report_json",
  ],
  events: ["id", "node_id", "at", "dimension", "from_value", "to_value", "source"],
  audit: ["id", "at", "actor", "action", "detail_json"],
  browser_sessions: [
    "session_id",
    "operator_principal",
    "csrf_token",
    "created_at",
    "expires_at",
    "idle_until",
    "revoked_at",
    "expiry_audited_at",
  ],
};

const EXPECTED_INDEXES = [
  "idx_seen_nonces_created_at",
  "idx_reports_node_uploaded",
  "idx_events_node_at",
  "idx_audit_at",
];

function databaseErrorCode(error) {
  const message = String(error?.message ?? error);
  if (/not a database|file is encrypted|malformed/i.test(message)) return "corrupt-database";
  if (/no such table|no such column|already exists|syntax error|constraint failed/i.test(message)) return "malformed-schema";
  if (/permission denied|readonly|read-only|unable to open|disk|i\/o/i.test(message)) return "database-io";
  return "database-open-failed";
}

function readUserVersion(db) {
  const row = db.prepare("PRAGMA user_version").get();
  const version = Number(row?.user_version);
  if (!Number.isInteger(version) || version < 0) {
    throw new RegistryDatabaseError("malformed-schema", "registry database has an invalid schema version");
  }
  return version;
}

function tableColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

export function registrySchemaShape(db) {
  const tables = {};
  for (const table of Object.keys(EXPECTED_TABLE_COLUMNS)) {
    tables[table] = tableColumns(db, table).sort();
  }
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name)
    .sort();
  return { tables, indexes };
}

export function validateRegistrySchema(db) {
  const expectedTables = Object.keys(EXPECTED_TABLE_COLUMNS).sort();
  const actualTables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw new RegistryDatabaseError(
      "malformed-schema",
      `registry database tables do not match the supported schema (expected ${expectedTables.join(",")})`,
    );
  }
  for (const [table, expectedColumns] of Object.entries(EXPECTED_TABLE_COLUMNS)) {
    const actualColumns = tableColumns(db, table);
    if (JSON.stringify([...actualColumns].sort()) !== JSON.stringify([...expectedColumns].sort())) {
      throw new RegistryDatabaseError(
        "malformed-schema",
        `registry database table ${table} does not match the supported schema`,
      );
    }
  }
  const actualIndexes = registrySchemaShape(db).indexes;
  const expectedIndexes = [...EXPECTED_INDEXES].sort();
  if (JSON.stringify(actualIndexes) !== JSON.stringify(expectedIndexes)) {
    throw new RegistryDatabaseError(
      "malformed-schema",
      `registry database indexes do not match the supported schema (expected ${expectedIndexes.join(",")})`,
    );
  }
  return true;
}

function wrapDatabaseError(error, path, phase) {
  if (error instanceof RegistryDatabaseError) return error;
  return new RegistryDatabaseError(
    phase === "migration" ? "migration-failed" : databaseErrorCode(error),
    `registry database ${path} ${phase} failed: ${error.message}`,
    { cause: error },
  );
}

// v1 -> v2: nodes gains the operator alert-flag column (RFC-0009
// "lost + operator alert flag").
// v2 -> v3: nodes gains last_heartbeat_at and browser_sessions gains
// expiry_audited_at. State migration (P1): contact times that the old
// schema can prove came from heartbeats are backfilled so startup
// maintenance can age them correctly; every other old contact claim
// (old report uploads wrongly refreshed registryContact) fails closed
// to registryContact = unknown.
const upgradeSteps = {
  1: ["ALTER TABLE nodes ADD COLUMN alert_flags TEXT NOT NULL DEFAULT '[]'"],
  2: [
    "ALTER TABLE nodes ADD COLUMN last_heartbeat_at TEXT",
    "ALTER TABLE browser_sessions ADD COLUMN expiry_audited_at TEXT",
    "UPDATE nodes SET last_heartbeat_at = last_seen WHERE last_seen_source = 'heartbeat' AND last_seen IS NOT NULL",
    "UPDATE nodes SET registry_contact = 'unknown' WHERE last_seen IS NULL OR last_seen_source IS NULL OR last_seen_source <> 'heartbeat'",
  ],
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
    last_heartbeat_at TEXT,
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
    revoked_at TEXT,
    expiry_audited_at TEXT
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
  let db = null;
  try {
    db = new DatabaseSync(path);
    const version = readUserVersion(db);
    // A future database must be rejected before any PRAGMA, migration, or
    // journal mutation touches the file. Operators must use a compatible
    // binary rather than allowing an older Hub to rewrite newer data.
    if (version > SCHEMA_VERSION) {
      throw new RegistryDatabaseError(
        "unsupported-schema",
        `registry database schema ${version} is newer than supported ${SCHEMA_VERSION}`,
      );
    }
    if (version === SCHEMA_VERSION) validateRegistrySchema(db);
    if (version === 0) {
      const existingTables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all();
      if (existingTables.length > 0) {
        throw new RegistryDatabaseError(
          "malformed-schema",
          "registry database has user tables but no supported schema version",
        );
      }
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    migrate(db);
    validateRegistrySchema(db);
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the original startup failure; a partially opened handle is
      // not a usable recovery path.
    }
    throw wrapDatabaseError(error, path, "open");
  }
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