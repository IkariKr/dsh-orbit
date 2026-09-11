// SQLite/WAL registry persistence for the v0.4 registry (RFC-0005 D7, RFC-0010 D2).
// Single writer connection with BEGIN IMMEDIATE; readers use the WAL
// snapshot. The table set is exactly the fixed contract: nodes,
// node_keys, enrollment_tokens, enrollment_results, seen_nonces,
// reports, events, audit, browser_sessions, route_targets.

import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 5;

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
  route_targets: [
    "node_id",
    "route_target_origin",
    "created_at",
    "updated_at",
  ],
  hub_route_keys: [
    "node_id",
    "key_id",
    "public_key",
    "private_key",
    "state",
    "created_at",
    "activated_at",
    "revoke_after",
    "revoked_at",
    "revocation_reason",
  ],
};

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

export function checkRegistryIntegrity(db, phase = "startup") {
  const integrityCheck = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
  if (integrityCheck !== "ok") {
    throw new RegistryDatabaseError(
      "integrity-failed",
      `registry database ${phase} integrity_check returned ${JSON.stringify(integrityCheck)}`,
    );
  }
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) {
    throw new RegistryDatabaseError(
      "integrity-failed",
      `registry database ${phase} foreign_key_check returned ${foreignKeyViolations.length} violation(s)`,
    );
  }
  return { integrityCheck, foreignKeyViolations: 0 };
}

function enforceRegistryFileMode(path) {
  if (process.platform === "win32" || path === ":memory:") return;
  for (const filePath of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(filePath)) chmodSync(filePath, 0o600);
  }
}

function normalizeSql(sql) {
  return String(sql ?? "").replace(/\s+/g, " ").trim();
}

function pragmaIdentifier(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function tableInfo(db, table) {
  return db
    .prepare(`PRAGMA table_info(${pragmaIdentifier(table)})`)
    .all()
    .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function foreignKeys(db, table) {
  return db
    .prepare(`PRAGMA foreign_key_list(${pragmaIdentifier(table)})`)
    .all()
    .map(({ id, seq, table: target, from, to, on_update, on_delete, match }) => ({
      id,
      seq,
      table: target,
      from,
      to,
      on_update,
      on_delete,
      match,
    }))
    .sort((a, b) => `${a.id}:${a.seq}`.localeCompare(`${b.id}:${b.seq}`));
}

function extractChecks(sql) {
  const source = String(sql ?? "");
  const checks = [];
  let cursor = 0;
  while (true) {
    const match = /\bcheck\s*\(/gi.exec(source.slice(cursor));
    if (!match) break;
    const start = cursor + match.index + match[0].length - 1;
    let depth = 0;
    let end = start;
    for (; end < source.length; end += 1) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break;
    checks.push(normalizeSql(source.slice(start + 1, end)));
    cursor = end + 1;
  }
  return checks.sort();
}

const EXPECTED_INDEX_DEFINITIONS = {
  idx_seen_nonces_created_at: { table: "seen_nonces", unique: 0, partial: 0, columns: [{ name: "created_at", desc: 0 }] },
  idx_reports_node_uploaded: {
    table: "reports",
    unique: 0,
    partial: 0,
    columns: [{ name: "node_id", desc: 0 }, { name: "uploaded_at", desc: 1 }],
  },
  idx_events_node_at: { table: "events", unique: 0, partial: 0, columns: [{ name: "node_id", desc: 0 }, { name: "at", desc: 0 }] },
  idx_audit_at: { table: "audit", unique: 0, partial: 0, columns: [{ name: "at", desc: 0 }] },
};

function indexDefinitions(db) {
  const definitions = {};
  const indexes = db
    .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  for (const { name, tbl_name: table } of indexes) {
    const list = db.prepare(`PRAGMA index_list(${pragmaIdentifier(table)})`).all().find((row) => row.name === name);
    const columns = db
      .prepare(`PRAGMA index_xinfo(${pragmaIdentifier(name)})`)
      .all()
      .filter((row) => row.key === 1)
      .sort((a, b) => a.seqno - b.seqno)
      .map(({ name: columnName, desc }) => ({ name: columnName, desc }));
    definitions[name] = {
      table: table ?? null,
      unique: Number(list?.unique ?? -1),
      partial: Number(list?.partial ?? -1),
      columns,
    };
  }
  return definitions;
}

function expectedTableNamesFor(version = SCHEMA_VERSION) {
  if (version < 4) {
    return [
      "audit",
      "browser_sessions",
      "enrollment_results",
      "enrollment_tokens",
      "events",
      "node_keys",
      "nodes",
      "reports",
      "seen_nonces",
    ];
  }
  if (version === 4) {
    return [
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
    ];
  }
  return Object.keys(EXPECTED_TABLE_COLUMNS).sort();
}

function schemaMetadata(db, version = SCHEMA_VERSION) {
  const tables = {};
  for (const table of expectedTableNamesFor(version)) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql;
    tables[table] = {
      columns: tableInfo(db, table),
      foreignKeys: foreignKeys(db, table),
      checks: extractChecks(sql),
    };
  }
  return { tables, indexes: indexDefinitions(db) };
}

export function registrySchemaShape(db) {
  const metadata = schemaMetadata(db);
  const tables = {};
  for (const [table, shape] of Object.entries(metadata.tables)) {
    tables[table] = shape.columns.map((column) => column.name);
  }
  return { tables, indexes: Object.keys(metadata.indexes).sort() };
}

function canonicalSchemaMetadata(version = SCHEMA_VERSION) {
  const canonical = new DatabaseSync(":memory:");
  try {
    for (const statement of schemaStatements) canonical.exec(statement);
    if (version < 5) {
      canonical.exec("DROP TABLE hub_route_keys");
    }
    if (version < 4) {
      canonical.exec("DROP TABLE route_targets");
      canonical.exec("PRAGMA foreign_keys = OFF");
      canonical.exec(`
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
      canonical.exec("PRAGMA foreign_keys = ON");
    }
    if (version === 1) {
      canonical.exec("ALTER TABLE nodes DROP COLUMN alert_flags");
      canonical.exec("ALTER TABLE nodes DROP COLUMN last_heartbeat_at");
      canonical.exec("ALTER TABLE browser_sessions DROP COLUMN expiry_audited_at");
    } else if (version === 2) {
      canonical.exec("ALTER TABLE nodes DROP COLUMN last_heartbeat_at");
      canonical.exec("ALTER TABLE browser_sessions DROP COLUMN expiry_audited_at");
    } else if (version !== 3 && version !== 4 && version !== SCHEMA_VERSION) {
      throw new RegistryDatabaseError("malformed-schema", `no canonical schema is defined for version ${version}`);
    }
    return schemaMetadata(canonical, version);
  } finally {
    canonical.close();
  }
}

function validateSchemaVersion(db, version) {
  const expectedTables = expectedTableNamesFor(version);
  const actualTables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw new RegistryDatabaseError(
      "malformed-schema",
      `registry database tables do not match the supported schema for version ${version}`,
    );
  }
  const expected = canonicalSchemaMetadata(version);
  const actual = schemaMetadata(db, version);
  for (const table of expectedTables) {
    if (JSON.stringify(actual.tables[table]) !== JSON.stringify(expected.tables[table])) {
      throw new RegistryDatabaseError(
        "malformed-schema",
        `registry database table ${table} does not match the supported column, constraint, or foreign-key definition for version ${version}`,
      );
    }
  }
  const expectedIndexes = Object.fromEntries(
    Object.entries(EXPECTED_INDEX_DEFINITIONS).sort(([a], [b]) => a.localeCompare(b)),
  );
  if (JSON.stringify(actual.indexes) !== JSON.stringify(expectedIndexes)) {
    throw new RegistryDatabaseError(
      "malformed-schema",
      `registry database indexes do not match the supported definitions for version ${version}`,
    );
  }
  return true;
}

export function validateRegistrySchema(db) {
  return validateSchemaVersion(db, SCHEMA_VERSION);
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
// v3 -> v4: reachable CHECK relaxed to unknown|ok|unreachable domain;
// route_targets table added for v0.4 Endpoint Selector (RFC-0010 D2).
const upgradeSteps = {
  1: ["ALTER TABLE nodes ADD COLUMN alert_flags TEXT NOT NULL DEFAULT '[]'"],
  2: [
    "ALTER TABLE nodes ADD COLUMN last_heartbeat_at TEXT",
    "ALTER TABLE browser_sessions ADD COLUMN expiry_audited_at TEXT",
    "UPDATE nodes SET last_heartbeat_at = last_seen WHERE last_seen_source = 'heartbeat' AND last_seen IS NOT NULL",
    "UPDATE nodes SET registry_contact = 'unknown' WHERE last_seen IS NULL OR last_seen_source IS NULL OR last_seen_source <> 'heartbeat'",
  ],
  3: [
    `CREATE TABLE nodes_v4 (
      node_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('active', 'tombstoned')),
      minted_at TEXT NOT NULL,
      tombstoned_at TEXT,
      tombstone_reason TEXT,
      registry_contact TEXT NOT NULL DEFAULT 'unknown' CHECK (registry_contact IN ('fresh', 'stale', 'lost', 'unknown')),
      authenticated TEXT NOT NULL DEFAULT 'unknown' CHECK (authenticated IN ('ok', 'revoked', 'unknown')),
      dsh_healthy TEXT NOT NULL DEFAULT 'unknown' CHECK (dsh_healthy IN ('ok', 'degraded', 'unknown')),
      orbit_compatible TEXT NOT NULL DEFAULT 'unknown' CHECK (orbit_compatible IN ('pass', 'fail', 'stale', 'unknown')),
      reachable TEXT NOT NULL DEFAULT 'unknown' CHECK (reachable IN ('unknown', 'ok', 'unreachable')),
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
    `INSERT INTO nodes_v4 (
      node_id,
      state,
      minted_at,
      tombstoned_at,
      tombstone_reason,
      registry_contact,
      authenticated,
      dsh_healthy,
      orbit_compatible,
      reachable,
      alert_flags,
      last_heartbeat_at,
      capabilities,
      capabilities_stale,
      last_seen,
      last_seen_source,
      orbit_version,
      orbit_revision,
      dsh_version,
      compatibility_profile
    ) SELECT
      node_id,
      state,
      minted_at,
      tombstoned_at,
      tombstone_reason,
      registry_contact,
      authenticated,
      dsh_healthy,
      orbit_compatible,
      reachable,
      alert_flags,
      last_heartbeat_at,
      capabilities,
      capabilities_stale,
      last_seen,
      last_seen_source,
      orbit_version,
      orbit_revision,
      dsh_version,
      compatibility_profile
    FROM nodes`,
    "DROP TABLE nodes",
    "ALTER TABLE nodes_v4 RENAME TO nodes",
    `CREATE TABLE route_targets (
      node_id TEXT PRIMARY KEY REFERENCES nodes(node_id),
      route_target_origin TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ],
  4: [
    `CREATE TABLE hub_route_keys (
      node_id TEXT NOT NULL REFERENCES nodes(node_id),
      key_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('provisioned', 'active', 'rotating', 'revoked')),
      created_at TEXT NOT NULL,
      activated_at TEXT,
      revoke_after TEXT,
      revoked_at TEXT,
      revocation_reason TEXT,
      PRIMARY KEY (node_id, key_id)
    )`,
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
    reachable TEXT NOT NULL DEFAULT 'unknown' CHECK (reachable IN ('unknown', 'ok', 'unreachable')),
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
  CREATE TABLE route_targets (
    node_id TEXT PRIMARY KEY REFERENCES nodes(node_id),
    route_target_origin TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `
  CREATE TABLE hub_route_keys (
    node_id TEXT NOT NULL REFERENCES nodes(node_id),
    key_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('provisioned', 'active', 'rotating', 'revoked')),
    created_at TEXT NOT NULL,
    activated_at TEXT,
    revoke_after TEXT,
    revoked_at TEXT,
    revocation_reason TEXT,
    PRIMARY KEY (node_id, key_id)
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
    if (version >= 1 && version < SCHEMA_VERSION) validateSchemaVersion(db, version);
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
    checkRegistryIntegrity(db, "pre-migration");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    migrate(db);
    validateRegistrySchema(db);
    checkRegistryIntegrity(db, "post-migration");
    enforceRegistryFileMode(path);
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
    db.exec("PRAGMA foreign_keys = OFF");
    try {
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
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
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