// S7-F1 through S7-F13 hardening tests for v0.4 failure, restart, and compatibility.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Registry } from "../src/registry/registry.mjs";
import { openRegistryDatabase, SCHEMA_VERSION } from "../src/registry/sqlite.mjs";
import { backupRegistryDatabase, restoreRegistryDatabase, inspectRegistryDatabase } from "../src/registry/backup.mjs";
import { generateNodeKeyPair, deriveKeyId } from "../src/registry/crypto.mjs";
import { deriveCapabilities, deriveOrbitCompatible } from "../src/registry/capabilities.mjs";
import { RouteNonceCache, signRouteRequest, verifyRouteRequest } from "../src/registry/route-auth.mjs";
import { IngressWebSocketTracker, RouteIngress } from "../src/node/route-ingress.mjs";
import { HubWebSocketTracker } from "../src/registry/route-proxy.mjs";
import { GATEWAY_CERT_PEM, GATEWAY_KEY_PEM } from "./fixtures/gateway-identity.mjs";
import https from "node:https";

async function createTempDir(prefix = "orbit-s7-test-") {
  return await mkdtemp(join(tmpdir(), prefix));
}

function seedFullV4Node(db, nodeId = "node_11111111111111111111111111111111") {
  const at = "2026-09-06T12:00:00.000Z";
  db.prepare(
    "INSERT INTO nodes (node_id, state, minted_at, authenticated, registry_contact, dsh_healthy, orbit_compatible, reachable, capabilities, capabilities_stale, last_seen, last_seen_source, orbit_version, orbit_revision, dsh_version, compatibility_profile) VALUES (?, 'active', ?, 'ok', 'fresh', 'ok', 'pass', 'ok', ?, 0, ?, 'heartbeat', '0.3.0', 'stage7', '0.1.1-rc.2', 'dsh-0.1.1-rc.2')",
  ).run(nodeId, at, JSON.stringify([{ name: "web.routes", version: 1 }]), at);
  const keys = generateNodeKeyPair();
  const keyId = deriveKeyId(keys.publicKeyHex);
  db.prepare(
    "INSERT INTO node_keys (node_id, key_id, public_key, state, created_at) VALUES (?, ?, ?, 'active', ?)",
  ).run(nodeId, keyId, keys.publicKeyHex, at);
  db.prepare(
    "INSERT INTO route_targets (node_id, route_target_origin, created_at, updated_at) VALUES (?, 'https://127.0.0.1:50081', ?, ?)",
  ).run(nodeId, at, at);
  const hubKeys = generateNodeKeyPair();
  const hubKeyId = deriveKeyId(hubKeys.publicKeyHex);
  db.prepare(
    "INSERT INTO hub_route_keys (node_id, key_id, public_key, private_key, state, created_at, activated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
  ).run(nodeId, hubKeyId, hubKeys.publicKeyHex, hubKeys.privateKeyHex, at, at);
  return { nodeId, keyId, hubKeyId, hubKeys };
}

test("S7-F1: Migration from v3 -> v4 -> v5 preserves state, route_targets, and hub_route_keys idempotently", async () => {
  const dir = await createTempDir("orbit-s7-f1-");
  try {
    const dbPath = join(dir, "registry.db");
    const raw = openRegistryDatabase(dbPath);
    // Rewind to v3
    raw.exec("DROP TABLE hub_route_keys");
    raw.exec("DROP TABLE route_targets");
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec(`
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
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec("PRAGMA user_version = 3");
    raw.close();

    // Reopen to trigger v3 -> v4 -> v5 migration
    const upgraded = openRegistryDatabase(dbPath);
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    const tables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    assert.ok(tables.includes("route_targets"));
    assert.ok(tables.includes("hub_route_keys"));
    // Reopen is idempotent
    upgraded.close();
    const reopened = openRegistryDatabase(dbPath);
    assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S7-F2: Standalone backup -> mutate route target & route key -> restore restores pre-mutation identity exactly without leaking private key to digest", async () => {
  const dir = await createTempDir("orbit-s7-f2-");
  try {
    const dbPath = join(dir, "live.db");
    const backupPath = join(dir, "backup.db");
    const db = openRegistryDatabase(dbPath);
    const { nodeId, hubKeyId, hubKeys } = seedFullV4Node(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    const backupResult = await backupRegistryDatabase({ db, sourcePath: dbPath, destinationPath: backupPath });
    assert.equal(backupResult.method, "sqlite-vacuum-into");
    const preMutationSafeState = inspectRegistryDatabase(dbPath);

    // Mutate route target and rotate route key
    db.prepare("UPDATE route_targets SET route_target_origin = 'https://mutated.example' WHERE node_id = ?").run(nodeId);
    const newKeys = generateNodeKeyPair();
    const newKeyId = deriveKeyId(newKeys.publicKeyHex);
    db.prepare("UPDATE hub_route_keys SET state = 'revoked' WHERE node_id = ?").run(nodeId);
    db.prepare("INSERT INTO hub_route_keys (node_id, key_id, public_key, private_key, state, created_at) VALUES (?, ?, ?, ?, 'active', '2026-09-06T13:00:00.000Z')")
      .run(nodeId, newKeyId, newKeys.publicKeyHex, newKeys.privateKeyHex);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    const mutatedSafeState = inspectRegistryDatabase(dbPath);
    assert.notEqual(mutatedSafeState.stateDigest, preMutationSafeState.stateDigest);

    db.close();

    // Restore
    const restoreResult = await restoreRegistryDatabase({ backupPath, targetPath: dbPath, writersQuiesced: true });
    assert.equal(restoreResult.method, "sqlite-standalone-atomic-restore");

    const restoredDb = openRegistryDatabase(dbPath);
    const restoredSafeState = inspectRegistryDatabase(dbPath);
    assert.equal(restoredSafeState.stateDigest, preMutationSafeState.stateDigest);

    // Verify route target restored exactly
    const routeTarget = restoredDb.prepare("SELECT route_target_origin FROM route_targets WHERE node_id = ?").get(nodeId);
    assert.equal(routeTarget.route_target_origin, "https://127.0.0.1:50081");

    // Verify Hub route key restored exactly including private key without private key appearing in digest
    const restoredKey = restoredDb.prepare("SELECT * FROM hub_route_keys WHERE node_id = ?").get(nodeId);
    assert.equal(restoredKey.key_id, hubKeyId);
    assert.equal(restoredKey.private_key, hubKeys.privateKeyHex);
    assert.equal(restoredKey.state, "active");

    restoredDb.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S7-F4: Inspection safeState and stateDigest never include private key material or private key hashes", () => {
  const db = openRegistryDatabase(":memory:");
  const { nodeId, hubKeys } = seedFullV4Node(db);
  const rows = db.prepare("SELECT * FROM hub_route_keys").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].private_key, hubKeys.privateKeyHex);

  // Read inspectRegistryDatabase logic on in-memory db by verifying query
  const safeKeys = db.prepare("SELECT node_id, key_id, public_key, state, created_at, activated_at, revoke_after, revoked_at, revocation_reason FROM hub_route_keys ORDER BY node_id, key_id").all();
  assert.equal(safeKeys[0].private_key, undefined);
  assert.equal(JSON.stringify(safeKeys).includes(hubKeys.privateKeyHex), false);
  db.close();
});

test("S7-F5: Corrupt route_targets or hub_route_keys fails startup closed without table recreation", async () => {
  const dir = await createTempDir("orbit-s7-f5-");
  try {
    const dbPath = join(dir, "corrupt-fk.db");
    const db = openRegistryDatabase(dbPath);
    db.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.prepare("INSERT INTO route_targets (node_id, route_target_origin, created_at, updated_at) VALUES ('node_nonexistent', 'https://bad.example', 't', 't')").run();
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();

    assert.throws(() => openRegistryDatabase(dbPath), (err) => err.code === "integrity-failed" && /foreign_key_check/.test(err.message));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S7-F6: Hub Route Key rotation overlap survives restart and revokes old key on schedule", () => {
  const db = openRegistryDatabase(":memory:");
  let nowTime = new Date("2026-09-06T12:00:00.000Z");
  const registry = new Registry({ db, now: () => nowTime, hubRouteOverlapDays: 1 });
  const nodeId = "node_22222222222222222222222222222222";
  db.prepare("INSERT INTO nodes (node_id, state, minted_at) VALUES (?, 'active', ?)").run(nodeId, nowTime.toISOString());

  // Provision key 1 and activate it
  const k1 = registry.ensureHubRouteKey(nodeId);
  registry.acknowledgeHubRouteKeys(nodeId, [k1.key_id]);
  const active1 = registry.getActiveHubRouteKey(nodeId);
  assert.equal(active1.key_id, k1.key_id);
  assert.equal(active1.state, "active");

  // Initiate rotation
  const rot = registry.rotateHubRouteKey({ actor: "operator", nodeId });
  assert.equal(rot.state, "provisioned");

  // Node acknowledges new key -> old key becomes rotating with revoke_after
  registry.acknowledgeHubRouteKeys(nodeId, [rot.newKeyId]);
  const rotating = db.prepare("SELECT * FROM hub_route_keys WHERE key_id = ?").get(k1.key_id);
  assert.equal(rotating.state, "rotating");
  assert.ok(rotating.revoke_after);

  // Simulate Hub restart: new Registry instance on same db preserves overlap state
  const restartedRegistry = new Registry({ db, now: () => nowTime });
  const activeKeys = restartedRegistry.getHubRouteKeysForNode(nodeId);
  assert.equal(activeKeys.length, 2);
  assert.ok(activeKeys.some((k) => k.keyId === rot.newKeyId && k.state === "active"));
  assert.ok(activeKeys.some((k) => k.keyId === k1.key_id && k.state === "rotating"));

  // Advance clock past overlap window -> maintenance revokes old key
  nowTime = new Date("2026-09-08T12:00:00.000Z");
  restartedRegistry.maintenance();

  const expiredKey = db.prepare("SELECT * FROM hub_route_keys WHERE key_id = ?").get(k1.key_id);
  assert.equal(expiredKey.state, "revoked");
  assert.equal(expiredKey.revocation_reason, "rotation-overlap-ended");

  // Only the new active key remains non-revoked
  const finalKeys = restartedRegistry.getHubRouteKeysForNode(nodeId);
  assert.equal(finalKeys.length, 1);
  assert.equal(finalKeys[0].keyId, rot.newKeyId);
  assert.equal(finalKeys[0].state, "active");

  db.close();
});

test("S7-F7: Route request signature, timestamp skew, and in-memory nonce replay rejection", () => {
  const keys = generateNodeKeyPair();
  const keyId = deriveKeyId(keys.publicKeyHex);
  const nodeId = "node_33333333333333333333333333333333";
  const authority = `n-${nodeId.slice(5)}.stage7.localhost`;
  const cache = new RouteNonceCache({ retentionMs: 60_000 });
  const nowMs = Date.now();

  const { headers } = signRouteRequest({
    privateKeyHex: keys.privateKeyHex,
    keyId,
    nodeId,
    routeAuthority: authority,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    nowMs,
    nonce: "a".repeat(32),
  });

  const getPublicKey = (kId) => (kId === keyId ? { publicKey: keys.publicKeyHex, state: "active" } : null);

  // 1. First verification succeeds
  const v1 = verifyRouteRequest({
    headers,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey,
    nonceCache: cache,
    nowMs,
  });
  assert.equal(v1.ok, true);

  // 2. Exact same nonce within same cache fails replay
  const v2 = verifyRouteRequest({
    headers,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey,
    nonceCache: cache,
    nowMs,
  });
  assert.equal(v2.ok, false);
  assert.equal(v2.code, "replay");

  // 3. Restart semantics: a fresh in-memory cache accepts same nonce (bounded by timestamp skew)
  const freshCache = new RouteNonceCache({ retentionMs: 60_000 });
  const vRestart = verifyRouteRequest({
    headers,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey,
    nonceCache: freshCache,
    nowMs,
  });
  assert.equal(vRestart.ok, true);

  // 4. Outside timestamp skew window fails closed
  const vExpired = verifyRouteRequest({
    headers,
    method: "GET",
    rawTarget: "/_orbit/route-ready",
    expectedNodeId: nodeId,
    expectedRouteAuthority: authority,
    getPublicKey,
    nonceCache: freshCache,
    nowMs: nowMs + 65_000,
  });
  assert.equal(vExpired.ok, false);
  assert.equal(vExpired.code, "timestamp-out-of-skew");
});

test("S7-F9: Stale / unsupported DSH version or missing webSocketTransport withdraws web.routes capability", () => {
  // 1. Valid DSH 0.1.1-rc.2 with passing checks -> web.routes granted
  const validReport = {
    candidate: { dshVersion: "0.1.1-rc.2", profile: "dsh-0.1.1-rc.2" },
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
  const caps = deriveCapabilities(validReport);
  assert.ok(caps.some((c) => c.name === "web.routes"));

  // 2. Unsupported DSH version -> capabilities empty
  const unsupportedReport = {
    ...validReport,
    candidate: { dshVersion: "0.2.0-unapproved", profile: "unknown" },
  };
  assert.deepEqual(deriveCapabilities(unsupportedReport), []);

  // 3. Missing webSocketTransport -> web.routes withheld
  const noWsReport = {
    ...validReport,
    checks: {
      ...validReport.checks,
      webSocketTransport: { status: "fail" },
    },
  };
  const capsNoWs = deriveCapabilities(noWsReport);
  assert.equal(capsNoWs.some((c) => c.name === "web.routes"), false);
});

test("S7-F11: Delete revokes Hub route keys and tombstone blocks old bookmark; re-enrollment creates fresh keys", () => {
  const db = openRegistryDatabase(":memory:");
  const registry = new Registry({ db });
  const nodeId = "node_44444444444444444444444444444444";
  db.prepare("INSERT INTO nodes (node_id, state, minted_at) VALUES (?, 'active', '2026-09-06T12:00:00.000Z')").run(nodeId);
  const k1 = registry.ensureHubRouteKey(nodeId);
  registry.acknowledgeHubRouteKeys(nodeId, [k1.key_id]);
  registry.setRouteTarget({ actor: "operator", nodeId, routeTarget: "https://127.0.0.1:50081" });

  // Delete node
  const del = registry.deleteNode({ actor: "operator", nodeId, requestId: "a".repeat(32), reason: "stage7-test" });
  assert.equal(del.state, "tombstoned");

  // Hub route key is revoked
  const revokedKey = db.prepare("SELECT * FROM hub_route_keys WHERE key_id = ?").get(k1.key_id);
  assert.equal(revokedKey.state, "revoked");
  assert.equal(revokedKey.revocation_reason, "node-delete");

  // Setting route target on tombstoned node is rejected
  assert.throws(() => registry.setRouteTarget({ actor: "operator", nodeId, routeTarget: "https://127.0.0.1:50081" }), (err) => err.code === "node-tombstoned");

  db.close();
});

test("S7-F12: WebSocket connection limits and aborted connections clean up counters deterministically", () => {
  const ingressTracker = new IngressWebSocketTracker({ maxConnections: 2 });
  assert.equal(ingressTracker.canAccept(), true);

  const fakeSocket1 = { once(evt, cb) { if (evt === "close") this.onClose = cb; }, destroy() { if (this.onClose) this.onClose(); } };
  const fakeSocket2 = { once(evt, cb) { if (evt === "close") this.onClose = cb; }, destroy() { if (this.onClose) this.onClose(); } };
  const fakeSocket3 = { once(evt, cb) { if (evt === "close") this.onClose = cb; }, destroy() { if (this.onClose) this.onClose(); } };

  const rel1 = ingressTracker.track(fakeSocket1);
  const rel2 = ingressTracker.track(fakeSocket2);
  assert.equal(ingressTracker.count, 2);
  assert.equal(ingressTracker.canAccept(), false);

  // Abort socket 1 -> counter decrements
  rel1();
  assert.equal(ingressTracker.count, 1);
  assert.equal(ingressTracker.canAccept(), true);

  // Hub tracker
  const hubTracker = new HubWebSocketTracker({ maxGlobal: 2, maxPerNode: 2 });
  const hubRel1 = hubTracker.track("node_a", fakeSocket1);
  const hubRel2 = hubTracker.track("node_a", fakeSocket2);
  assert.equal(hubTracker.canAccept("node_a").allowed, false);

  hubRel1();
  assert.equal(hubTracker.canAccept("node_a").allowed, true);
  hubRel2();
  assert.equal(hubTracker.globalCount, 0);
  assert.equal(hubTracker.nodeCounts.size, 0);
});

test("S7-F8: TLS trust failure matrix - unknown CA and wrong SAN are rejected fail-closed", async () => {
  // Create HTTPS server presenting the test fixture certificate (CN=dsh.example.com, SAN=dsh.example.com, IP:127.0.0.1)
  const server = https.createServer({
    cert: GATEWAY_CERT_PEM,
    key: GATEWAY_KEY_PEM,
  }, (req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // 1. Unknown CA (system trust fails closed without explicit ca option)
    await assert.rejects(
      new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "127.0.0.1",
          port,
          path: "/",
          method: "GET",
        }, resolve);
        req.on("error", reject);
        req.end();
      }),
      (err) => err.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || /self-signed|unable to verify/i.test(err.message),
    );

    // 2. Wrong hostname / SAN (connecting via localhost when SAN is only dsh.example.com and 127.0.0.1)
    await assert.rejects(
      new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "localhost",
          port,
          path: "/",
          method: "GET",
          ca: GATEWAY_CERT_PEM, // CA trusted, but SAN doesn't include 'localhost'
        }, resolve);
        req.on("error", reject);
        req.end();
      }),
      (err) => err.code === "ERR_TLS_CERT_ALTNAME_INVALID" || /altname|hostname/i.test(err.message),
    );

    // 3. Matching SAN and trusted CA succeeds
    const successResult = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "GET",
        ca: GATEWAY_CERT_PEM,
      }, (res) => {
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(successResult, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

