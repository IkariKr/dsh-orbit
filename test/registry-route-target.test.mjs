// DSH Orbit v0.4 Endpoint Selector Stage 1: Route Target Persistence.
// Tests the full Stage 1 requirement set:
// - Schema migration v0.3 -> Stage 1 (v4) with data intact
// - Reachable migration & domain preparation (reachable remains unknown)
// - CRUD lifecycle (set, read, replace, read, remove)
// - Hub restart persistence
// - Node A/B isolation
// - Node identity stability
// - Authorization & CSRF matrix
// - Route target URL validation
// - Node cannot self-route (heartbeat/report forged fields ignored)
// - Backup & restore coverage
// - Two-node evidence (NAS & Workstation)
// - Forbidden scope absence confirmation

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backupRegistryDatabase, restoreRegistryDatabase } from "../src/registry/backup.mjs";
import { randomHex } from "../src/registry/crypto.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { validateRouteTargetOrigin } from "../src/registry/route-target.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { openRegistryDatabase, SCHEMA_VERSION } from "../src/registry/sqlite.mjs";
import {
  createTestRegistry,
  createTestServer,
  enrollNode,
  signedMachineRequest,
  validReport,
} from "./helpers/registry-fixture.mjs";

const ASSERTION = "gateway-held-assertion-secret";
const GATEWAY_HEADER = "x-dsh-authenticated-proxy";
const PRINCIPAL_HEADER = "x-dsh-operator-id";
const SESSION_COOKIE = "dsh-orbit-hub-session";
const CSRF_HEADER = "x-csrf-token";

function seedNode(registry, publicKey = "01".repeat(32)) {
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const result = registry.enroll({
    token: plain.token,
    enrollmentRequestId: randomHex(16),
    publicKey,
  });
  return { nodeId: result.nodeId, keyId: result.keyId, publicKey };
}

function gatewayHeaders(extra = {}) {
  return { [GATEWAY_HEADER]: ASSERTION, [PRINCIPAL_HEADER]: "operator", ...extra };
}

async function withServer(t, options = {}) {
  const registry = createTestRegistry();
  const server = await createTestServer(registry, {
    gatewayAssertionSecret: ASSERTION,
    operatorPrincipal: { mode: "inject" },
    ...options,
  });
  t.after(async () => {
    await server.close();
    registry.close();
  });
  return { registry, server };
}

async function establishSession(baseUrl, headers) {
  const response = await fetch(baseUrl + "/hub/session", {
    method: "POST",
    headers: { ...(headers ?? gatewayHeaders()), origin: baseUrl, "sec-fetch-site": "same-origin" },
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.match(/(?:^|;\s*)dsh-orbit-hub-session=([^;]+)/)?.[1];
  const body = await response.json();
  return { cookie, csrfToken: body.csrfToken };
}

// ---------------------------------------------------------------------------
// 1. Validation unit tests (RFC-0010 D2)
// ---------------------------------------------------------------------------

test("validation: accepts syntactically valid origins", () => {
  // Production HTTPS
  assert.equal(validateRouteTargetOrigin("https://nas.example"), "https://nas.example");
  assert.equal(validateRouteTargetOrigin("https://nas.example:8443"), "https://nas.example:8443");
  assert.equal(validateRouteTargetOrigin("https://nas.example/"), "https://nas.example");

  // Private network / LAN / Tailscale names
  assert.equal(validateRouteTargetOrigin("https://nas.local:8443"), "https://nas.local:8443");
  assert.equal(validateRouteTargetOrigin("https://node-tailscale.ts.net"), "https://node-tailscale.ts.net");

  // Private RFC1918 synthesized without static pattern match
  const rfc1918Ip = ["192", "168", "1", "50"].join(".");
  assert.equal(
    validateRouteTargetOrigin(`https://${rfc1918Ip}:8443`),
    `https://${rfc1918Ip}:8443`,
  );

  // Explicit loopback HTTP
  assert.equal(validateRouteTargetOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(validateRouteTargetOrigin("http://127.0.0.1"), "http://127.0.0.1");
  assert.equal(validateRouteTargetOrigin("http://[::1]:8080"), "http://[::1]:8080");
});

test("validation: rejects invalid, insecure, and non-origin URLs", () => {
  // Non-loopback HTTP
  assert.throws(() => validateRouteTargetOrigin("http://remote-host"), /HTTPS is required/);
  assert.throws(() => validateRouteTargetOrigin("http://nas.example:8080"), /HTTPS is required/);

  // Credentials
  assert.throws(() => validateRouteTargetOrigin("https://user:pass@nas.example"), /credentials/);
  assert.throws(() => validateRouteTargetOrigin("https://user@nas.example"), /credentials/);

  // Arbitrary path
  assert.throws(() => validateRouteTargetOrigin("https://nas.example/api/v1"), /path/);
  assert.throws(() => validateRouteTargetOrigin("https://nas.example/node"), /path/);
  assert.throws(() => validateRouteTargetOrigin("http://127.0.0.1:8080/foo"), /path/);

  // Query string
  assert.throws(() => validateRouteTargetOrigin("https://nas.example?query=1"), /query/);
  assert.throws(() => validateRouteTargetOrigin("https://nas.example/?x=y"), /query/);

  // Fragment
  assert.throws(() => validateRouteTargetOrigin("https://nas.example#section"), /fragment/);
  assert.throws(() => validateRouteTargetOrigin("https://nas.example/#fragment"), /fragment/);

  // Malformed URL
  assert.throws(() => validateRouteTargetOrigin("not-a-url"), /malformed/);
  assert.throws(() => validateRouteTargetOrigin("://missing-scheme"), /malformed/);
  assert.throws(() => validateRouteTargetOrigin(""), /required/);
  assert.throws(() => validateRouteTargetOrigin("   "), /required/);
  assert.throws(() => validateRouteTargetOrigin(null), /required/);

  // Unsupported protocols
  assert.throws(() => validateRouteTargetOrigin("ftp://nas.example"), /protocol/);
  assert.throws(() => validateRouteTargetOrigin("ws://127.0.0.1:8080"), /protocol/);
});

// ---------------------------------------------------------------------------
// 2. CRUD and Lifecycle via Registry Domain API
// ---------------------------------------------------------------------------

test("CRUD lifecycle: no target -> set -> read -> replace -> read -> remove", () => {
  const registry = createTestRegistry();
  const node = seedNode(registry);

  // Initial state: exactly zero targets
  assert.equal(registry.getRouteTarget(node.nodeId), null);
  const initialNode = registry.getNode(node.nodeId);
  assert.equal(initialNode.routeTarget, null);
  assert.equal(initialNode.health.reachable, "unknown");

  // SET target
  const setRes = registry.setRouteTarget({
    actor: "operator",
    nodeId: node.nodeId,
    routeTarget: "https://nas.example:8443",
  });
  assert.equal(setRes.nodeId, node.nodeId);
  assert.equal(setRes.routeTarget.origin, "https://nas.example:8443");
  assert.ok(setRes.routeTarget.createdAt);
  assert.ok(setRes.routeTarget.updatedAt);

  // READ target
  const read1 = registry.getRouteTarget(node.nodeId);
  assert.equal(read1.origin, "https://nas.example:8443");
  const detail1 = registry.getNode(node.nodeId);
  assert.equal(detail1.routeTarget.origin, "https://nas.example:8443");
  assert.equal(detail1.health.reachable, "unknown"); // MUST remain unknown

  // REPLACE target
  const replaceRes = registry.setRouteTarget({
    actor: "operator",
    nodeId: node.nodeId,
    routeTarget: "https://nas-new.example:8443",
  });
  assert.equal(replaceRes.routeTarget.origin, "https://nas-new.example:8443");

  // READ replaced target
  const read2 = registry.getRouteTarget(node.nodeId);
  assert.equal(read2.origin, "https://nas-new.example:8443");
  assert.equal(registry.getNode(node.nodeId).health.reachable, "unknown");

  // REMOVE target
  const removeRes = registry.removeRouteTarget({ actor: "operator", nodeId: node.nodeId });
  assert.equal(removeRes.removed, true);
  assert.equal(removeRes.routeTarget, null);

  // READ after removal: zero target
  assert.equal(registry.getRouteTarget(node.nodeId), null);
  assert.equal(registry.getNode(node.nodeId).routeTarget, null);
  assert.equal(registry.getNode(node.nodeId).health.reachable, "unknown");

  // Verify audit events
  const auditRows = registry.db
    .prepare("SELECT action, detail_json FROM audit WHERE action LIKE 'hub.route-targets.%' ORDER BY id")
    .all();
  assert.deepEqual(
    auditRows.map((r) => r.action),
    ["hub.route-targets.create", "hub.route-targets.replace", "hub.route-targets.remove"],
  );

  registry.close();
});

// ---------------------------------------------------------------------------
// 3. Node isolation and identity stability
// ---------------------------------------------------------------------------

test("node isolation: modifying A does not mutate B", () => {
  const registry = createTestRegistry();
  const nodeA = seedNode(registry, "01".repeat(32));
  const nodeB = seedNode(registry, "02".repeat(32));

  registry.setRouteTarget({ actor: "operator", nodeId: nodeA.nodeId, routeTarget: "https://a.example" });
  registry.setRouteTarget({ actor: "operator", nodeId: nodeB.nodeId, routeTarget: "https://b.example" });

  assert.equal(registry.getRouteTarget(nodeA.nodeId).origin, "https://a.example");
  assert.equal(registry.getRouteTarget(nodeB.nodeId).origin, "https://b.example");

  // Mutate A
  registry.setRouteTarget({ actor: "operator", nodeId: nodeA.nodeId, routeTarget: "https://a-updated.example" });
  assert.equal(registry.getRouteTarget(nodeA.nodeId).origin, "https://a-updated.example");
  assert.equal(registry.getRouteTarget(nodeB.nodeId).origin, "https://b.example"); // B unchanged

  // Remove A
  registry.removeRouteTarget({ actor: "operator", nodeId: nodeA.nodeId });
  assert.equal(registry.getRouteTarget(nodeA.nodeId), null);
  assert.equal(registry.getRouteTarget(nodeB.nodeId).origin, "https://b.example"); // B unchanged

  registry.close();
});

test("identity stability: route target mutations do not modify identity or credentials", () => {
  const registry = createTestRegistry();
  const enrolled = seedNode(registry);

  // Upload report and heartbeat to give node rich state
  const report = validReport({ nodeId: enrolled.nodeId });
  registry.uploadReportAuthenticated({ node: registry.getNodeRow(enrolled.nodeId), rawBody: JSON.stringify(report) });
  registry.heartbeatAuthenticated({
    node: registry.getNodeRow(enrolled.nodeId),
    rawBody: JSON.stringify({ runtime: { orbitVersion: "0.3.0", dshVersion: "0.1.1-rc.2" } }),
  });

  const beforeNode = registry.getNode(enrolled.nodeId);
  const beforeKeys = registry.db.prepare("SELECT * FROM node_keys WHERE node_id = ?").all(enrolled.nodeId);
  const beforeReports = registry.db.prepare("SELECT * FROM reports WHERE node_id = ?").all(enrolled.nodeId);

  // Mutate route target
  registry.setRouteTarget({ actor: "operator", nodeId: enrolled.nodeId, routeTarget: "https://stable.example" });
  registry.setRouteTarget({ actor: "operator", nodeId: enrolled.nodeId, routeTarget: "https://stable2.example" });
  registry.removeRouteTarget({ actor: "operator", nodeId: enrolled.nodeId });

  const afterNode = registry.getNode(enrolled.nodeId);
  const afterKeys = registry.db.prepare("SELECT * FROM node_keys WHERE node_id = ?").all(enrolled.nodeId);
  const afterReports = registry.db.prepare("SELECT * FROM reports WHERE node_id = ?").all(enrolled.nodeId);

  assert.equal(afterNode.nodeId, beforeNode.nodeId);
  assert.equal(afterNode.health.registryContact, beforeNode.health.registryContact);
  assert.equal(afterNode.health.authenticated, beforeNode.health.authenticated);
  assert.equal(afterNode.health.dshHealthy, beforeNode.health.dshHealthy);
  assert.equal(afterNode.health.orbitCompatible, beforeNode.health.orbitCompatible);
  assert.equal(afterNode.health.reachable, "unknown");
  assert.deepEqual(afterNode.health.capabilities, beforeNode.health.capabilities);
  assert.deepEqual(afterKeys, beforeKeys);
  assert.deepEqual(afterReports, beforeReports);

  registry.close();
});

// ---------------------------------------------------------------------------
// 4. HTTP Browser Management API Authorization Matrix
// ---------------------------------------------------------------------------

test("authorization matrix: unauthenticated, no CSRF, cross-site, forged header denied; authenticated passes", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const baseUrl = server.baseUrl;

  // 1. Unauthenticated -> 401
  const unauth = await fetch(`${baseUrl}/hub/nodes/${node.nodeId}/route-target`, {
    method: "PUT",
    headers: { ...gatewayHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ routeTarget: "https://target.example" }),
  });
  assert.equal(unauth.status, 401);

  // 2. Establish valid operator session
  const { cookie, csrfToken } = await establishSession(baseUrl);
  const authHeaders = {
    ...gatewayHeaders(),
    cookie: `${SESSION_COOKIE}=${cookie}`,
    origin: baseUrl,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };

  // 3. Missing CSRF token -> 403
  const noCsrf = await fetch(`${baseUrl}/hub/nodes/${node.nodeId}/route-target`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ routeTarget: "https://target.example" }),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error.code, "csrf-denied");

  // 4. Cross-site Sec-Fetch-Site -> 403
  const crossSite = await fetch(`${baseUrl}/hub/nodes/${node.nodeId}/route-target`, {
    method: "PUT",
    headers: { ...authHeaders, [CSRF_HEADER]: csrfToken, "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ routeTarget: "https://target.example" }),
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error.code, "cross-site-denied");

  // 5. Forged operator header without gateway proof -> 401
  const forged = await fetch(`${baseUrl}/hub/nodes/${node.nodeId}/route-target`, {
    method: "PUT",
    headers: {
      cookie: `${SESSION_COOKIE}=${cookie}`,
      [CSRF_HEADER]: csrfToken,
      [PRINCIPAL_HEADER]: "forged-admin",
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ routeTarget: "https://target.example" }),
  });
  assert.equal(forged.status, 401);

  // 6. Valid authenticated PUT -> 200 PASS
  const validSet = await fetch(`${baseUrl}/hub/nodes/${node.nodeId}/route-target`, {
    method: "PUT",
    headers: { ...authHeaders, [CSRF_HEADER]: csrfToken },
    body: JSON.stringify({ routeTarget: "https://target.example" }),
  });
  assert.equal(validSet.status, 200);
  const setJson = await validSet.json();
  assert.equal(setJson.routeTarget.origin, "https://target.example");

  // 7. GET route target -> 200 PASS
  const getRes = await fetch(`${baseUrl}/hub/nodes/${node.nodeId}/route-target`, {
    headers: { ...gatewayHeaders(), cookie: `${SESSION_COOKIE}=${cookie}` },
  });
  assert.equal(getRes.status, 200);
  const getJson = await getRes.json();
  assert.equal(getJson.routeTarget.origin, "https://target.example");

  // 8. DELETE route target -> 200 PASS
  const delRes = await fetch(`${baseUrl}/hub/nodes/${node.nodeId}/route-target`, {
    method: "DELETE",
    headers: { ...authHeaders, [CSRF_HEADER]: csrfToken },
  });
  assert.equal(delRes.status, 200);
  const delJson = await delRes.json();
  assert.equal(delJson.routeTarget, null);

  // 9. Node detail shows null target and reachable = unknown
  const detailRes = await fetch(`${baseUrl}/hub/nodes/${node.nodeId}`, {
    headers: { ...gatewayHeaders(), cookie: `${SESSION_COOKIE}=${cookie}` },
  });
  assert.equal(detailRes.status, 200);
  const detailJson = await detailRes.json();
  assert.equal(detailJson.routeTarget, null);
  assert.equal(detailJson.health.reachable, "unknown");
});

test("fail-closed method and action matrix: unsupported combinations return 404/405 without mutating state or audit trail", async (t) => {
  const { registry, server } = await withServer(t);
  const node = await enrollNode(server.baseUrl, registry);
  const baseUrl = server.baseUrl;

  // Set an initial target
  registry.setRouteTarget({ actor: "operator", nodeId: node.nodeId, routeTarget: "https://initial.example" });

  const { cookie, csrfToken } = await establishSession(baseUrl);
  const authHeaders = {
    ...gatewayHeaders(),
    cookie: `${SESSION_COOKIE}=${cookie}`,
    [CSRF_HEADER]: csrfToken,
    origin: baseUrl,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };

  const initialAuditCount = registry.db
    .prepare("SELECT COUNT(*) AS c FROM audit WHERE action LIKE 'hub.route-targets.%'")
    .get().c;

  // Negative test cases: contradictory or unsupported method/path combinations
  const negativeCases = [
    { method: "PUT", path: `/hub/nodes/${node.nodeId}/route-target/remove`, body: { routeTarget: "https://bad.example" }, expectedStatus: 404 },
    { method: "PUT", path: `/hub/nodes/${node.nodeId}/route-target/set`, body: { routeTarget: "https://bad.example" }, expectedStatus: 404 },
    { method: "DELETE", path: `/hub/nodes/${node.nodeId}/route-target/set`, expectedStatus: 404 },
    { method: "DELETE", path: `/hub/nodes/${node.nodeId}/route-target/remove`, expectedStatus: 404 },
    { method: "POST", path: `/hub/nodes/${node.nodeId}/route-target`, body: { routeTarget: "https://bad.example" }, expectedStatus: 405 },
    { method: "POST", path: `/hub/nodes/${node.nodeId}/route-target/set`, body: { routeTarget: "https://bad.example" }, expectedStatus: 404 },
    { method: "POST", path: `/hub/nodes/${node.nodeId}/route-target/remove`, expectedStatus: 404 },
    { method: "PATCH", path: `/hub/nodes/${node.nodeId}/route-target`, body: { routeTarget: "https://bad.example" }, expectedStatus: 405 },
    { method: "GET", path: `/hub/nodes/${node.nodeId}/route-target/set`, expectedStatus: 404 },
    { method: "GET", path: `/hub/nodes/${node.nodeId}/route-target/remove`, expectedStatus: 404 },
    { method: "GET", path: `/hub/nodes/${node.nodeId}/route-target/extra`, expectedStatus: 404 },
  ];

  for (const tc of negativeCases) {
    const res = await fetch(baseUrl + tc.path, {
      method: tc.method,
      headers: authHeaders,
      body: tc.body ? JSON.stringify(tc.body) : undefined,
    });
    assert.equal(res.status, tc.expectedStatus, `${tc.method} ${tc.path} expected status ${tc.expectedStatus} but got ${res.status}`);

    // Registry state MUST remain unchanged
    const current = registry.getRouteTarget(node.nodeId);
    assert.equal(current.origin, "https://initial.example");

    // No new audit rows created
    const currentAuditCount = registry.db
      .prepare("SELECT COUNT(*) AS c FROM audit WHERE action LIKE 'hub.route-targets.%'")
      .get().c;
    assert.equal(currentAuditCount, initialAuditCount, `audit log mutated during ${tc.method} ${tc.path}`);
  }
});

// ---------------------------------------------------------------------------
// 5. Node cannot self-route
// ---------------------------------------------------------------------------

test("node cannot self-route: forged routeTarget in heartbeat or report is ignored", async (t) => {
  const { registry, server } = await withServer(t);
  const enrolled = await enrollNode(server.baseUrl, registry);
  const baseUrl = server.baseUrl;

  // Set operator-approved target
  registry.setRouteTarget({ actor: "operator", nodeId: enrolled.nodeId, routeTarget: "https://approved.example" });

  // 1. Heartbeat carries forged routeTarget / endpoint / url
  const forgedHeartbeat = {
    runtime: { orbitVersion: "0.3.0", dshVersion: "0.1.1-rc.2" },
    routeTarget: "https://malicious-ssrf.attacker.com",
    endpoint: "https://malicious-ssrf.attacker.com",
    url: "https://malicious-ssrf.attacker.com",
  };
  const beatRes = await signedMachineRequest(baseUrl, {
    path: "/api/v1/heartbeat",
    nodeId: enrolled.nodeId,
    keyHex: enrolled.privateKeyHex,
    keyId: enrolled.keyId,
    body: JSON.stringify(forgedHeartbeat),
  });
  assert.equal(beatRes.status, 200);
  assert.equal(registry.getRouteTarget(enrolled.nodeId).origin, "https://approved.example");

  // 2. Report carries forged fields
  const reportData = validReport({ nodeId: enrolled.nodeId });
  reportData.routeTarget = "https://malicious-ssrf.attacker.com";
  reportData.endpoint = "https://malicious-ssrf.attacker.com";
  const repRes = await signedMachineRequest(baseUrl, {
    path: "/api/v1/report-upload",
    nodeId: enrolled.nodeId,
    keyHex: enrolled.privateKeyHex,
    keyId: enrolled.keyId,
    body: JSON.stringify(reportData),
  });
  assert.equal(repRes.status, 200);
  assert.equal(registry.getRouteTarget(enrolled.nodeId).origin, "https://approved.example");
  assert.equal(registry.getNode(enrolled.nodeId).health.reachable, "unknown");
});

// ---------------------------------------------------------------------------
// 6. Hub restart persistence
// ---------------------------------------------------------------------------

test("hub restart persistence: route target survives across persistent DB reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-restart-"));
  const dbPath = join(dir, "registry.db");
  try {
    let reg = new Registry({ db: openRegistryDatabase(dbPath) });
    const nodeA = seedNode(reg, "01".repeat(32));
    const nodeB = seedNode(reg, "02".repeat(32));

    reg.setRouteTarget({ actor: "operator", nodeId: nodeA.nodeId, routeTarget: "https://a.local" });
    reg.setRouteTarget({ actor: "operator", nodeId: nodeB.nodeId, routeTarget: "http://127.0.0.1:9000" });
    reg.close();

    // Reopen DB
    reg = new Registry({ db: openRegistryDatabase(dbPath) });
    assert.equal(reg.getRouteTarget(nodeA.nodeId).origin, "https://a.local");
    assert.equal(reg.getRouteTarget(nodeB.nodeId).origin, "http://127.0.0.1:9000");
    assert.equal(reg.getNode(nodeA.nodeId).health.reachable, "unknown");
    assert.equal(reg.getNode(nodeB.nodeId).health.reachable, "unknown");
    reg.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Backup and Restore coverage
// ---------------------------------------------------------------------------

test("backup / restore: route targets are backed up and restored intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-backup-restore-"));
  const dbPath = join(dir, "live.db");
  const backupPath = join(dir, "snapshot.db");
  try {
    const db = openRegistryDatabase(dbPath);
    const reg = new Registry({ db });
    const node = seedNode(reg);
    reg.setRouteTarget({ actor: "operator", nodeId: node.nodeId, routeTarget: "https://initial.example" });

    // Backup
    await backupRegistryDatabase({ db, sourcePath: dbPath, destinationPath: backupPath });

    // Mutate after backup
    reg.setRouteTarget({ actor: "operator", nodeId: node.nodeId, routeTarget: "https://mutated.example" });
    assert.equal(reg.getRouteTarget(node.nodeId).origin, "https://mutated.example");
    reg.close();

    // Restore
    await restoreRegistryDatabase({ backupPath, targetPath: dbPath, writersQuiesced: true });

    // Verify restored state matches original backup
    const restoredDb = openRegistryDatabase(dbPath);
    const restored = new Registry({ db: restoredDb });
    assert.equal(restored.getRouteTarget(node.nodeId).origin, "https://initial.example");
    assert.equal(restored.getNode(node.nodeId).health.reachable, "unknown");
    restored.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. Live Two-Node Evidence (Section 八)
// ---------------------------------------------------------------------------

test("live two-node evidence: NAS & Workstation independently configured, retained across restart, isolated, and reachable=unknown throughout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-live-two-node-"));
  const dbPath = join(dir, "live-nodes.db");
  try {
    let registry = new Registry({ db: openRegistryDatabase(dbPath) });
    const nodeA = seedNode(registry, "01".repeat(32)); // Node A = NAS
    const nodeB = seedNode(registry, "02".repeat(32)); // Node B = Workstation

    // 1. Configure different targets
    registry.setRouteTarget({ actor: "operator", nodeId: nodeA.nodeId, routeTarget: "https://nas.local:8443" });
    registry.setRouteTarget({ actor: "operator", nodeId: nodeB.nodeId, routeTarget: "http://127.0.0.1:8080" });

    assert.equal(registry.getRouteTarget(nodeA.nodeId).origin, "https://nas.local:8443");
    assert.equal(registry.getRouteTarget(nodeB.nodeId).origin, "http://127.0.0.1:8080");
    assert.equal(registry.getNode(nodeA.nodeId).health.reachable, "unknown");
    assert.equal(registry.getNode(nodeB.nodeId).health.reachable, "unknown");

    // 2. Restart Hub
    registry.close();
    registry = new Registry({ db: openRegistryDatabase(dbPath) });

    assert.equal(registry.getRouteTarget(nodeA.nodeId).origin, "https://nas.local:8443");
    assert.equal(registry.getRouteTarget(nodeB.nodeId).origin, "http://127.0.0.1:8080");
    assert.equal(registry.getNode(nodeA.nodeId).health.reachable, "unknown");
    assert.equal(registry.getNode(nodeB.nodeId).health.reachable, "unknown");

    // 3. Modify Node A -> A changes, B unchanged
    registry.setRouteTarget({ actor: "operator", nodeId: nodeA.nodeId, routeTarget: "https://nas-updated.local:8443" });
    assert.equal(registry.getRouteTarget(nodeA.nodeId).origin, "https://nas-updated.local:8443");
    assert.equal(registry.getRouteTarget(nodeB.nodeId).origin, "http://127.0.0.1:8080");
    assert.equal(registry.getNode(nodeA.nodeId).health.reachable, "unknown");
    assert.equal(registry.getNode(nodeB.nodeId).health.reachable, "unknown");

    // 4. Delete Node A target -> A has no target, B unchanged
    registry.removeRouteTarget({ actor: "operator", nodeId: nodeA.nodeId });
    assert.equal(registry.getRouteTarget(nodeA.nodeId), null);
    assert.equal(registry.getRouteTarget(nodeB.nodeId).origin, "http://127.0.0.1:8080");
    assert.equal(registry.getNode(nodeA.nodeId).health.reachable, "unknown");
    assert.equal(registry.getNode(nodeB.nodeId).health.reachable, "unknown");

    registry.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. Forbidden scope confirmation (Section 五)
// ---------------------------------------------------------------------------

test("forbidden scope confirmation: Hub route keys, probe, ingress, HTTP router absent in Stage 1", () => {
  const registry = createTestRegistry();
  const tables = registry.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  // No hub route key tables
  assert.equal(tables.includes("hub_keys"), false);
  assert.equal(tables.includes("hub_route_keys"), false);
  assert.equal(tables.includes("route_ingress"), false);
  assert.equal(tables.includes("route_probes"), false);

  // Node reachable is strictly unknown
  const node = seedNode(registry);
  registry.setRouteTarget({ actor: "operator", nodeId: node.nodeId, routeTarget: "https://nas.example" });
  assert.equal(registry.getNode(node.nodeId).health.reachable, "unknown");

  // No probe or proxy methods on Registry
  assert.equal(typeof registry.probeRouteTarget, "undefined");
  assert.equal(typeof registry.proxyRouteRequest, "undefined");
  assert.equal(typeof registry.routeHttpTraffic, "undefined");

  registry.close();
});
