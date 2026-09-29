import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import {
  M22_AUTOMATED_FIELDS,
  M22_MATRIX_FIELDS,
  M22_MOUNTED_REQUIRED_FIELDS,
  emptyM22Matrix,
} from "../scripts/v11-devices-nodes-acceptance-matrix.mjs";

// RFC-0018 Stage 1: mechanical coverage for the D2 session surface on a real
// createHubServer instance. Host overrides use node:http directly so the
// selector-apex and node-route authority branches are exercised for real
// (v0.10 Stage 1 test convention).

function rawRequest({ port, method = "GET", path = "/", host = null, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port,
        host: "127.0.0.1",
        path,
        method,
        headers: host ? { ...headers, host } : headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (body !== null) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function closeHub(hub) {
  return new Promise((resolve) => {
    hub.server.closeAllConnections?.();
    hub.server.close(() => resolve());
  });
}

const GATEWAY_HEADERS = {
  "x-dsh-authenticated-proxy": "mock-gate",
  "x-dsh-operator-id": "admin",
};

const APEX_HOST = "dsh.ikarikore.top";

function createManagementHub() {
  const db = openRegistryDatabase(":memory:");
  const registry = new Registry({ db });
  const hub = createHubServer({
    registry,
    options: {
      gatewayAssertionSecret: "mock-gate",
      operatorPrincipal: { mode: "inject" },
      trustedExternalScheme: "https",
    },
  });
  return { db, registry, hub };
}

async function listen(hub) {
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  return hub.server.address().port;
}

async function bootstrapSession(port, { principalHeader = "admin" } = {}) {
  const res = await rawRequest({
    port,
    method: "POST",
    path: "/hub/session",
    headers: { "x-dsh-authenticated-proxy": "mock-gate", "x-dsh-operator-id": principalHeader },
    body: {},
  });
  assert.equal(res.status, 200);
  const cookie = res.headers["set-cookie"][0].split(";")[0];
  return { cookie, sessionId: cookie.split("=")[1], ...JSON.parse(res.body) };
}

test("M22 bookkeeping: every automated field of this file is covered and mounted fields stay NOT_EXECUTED", () => {
  // Fields exercised by this file (the remaining automated fields are
  // covered by v11-stage1-selector-flows and v11-stage1-ui-devices).
  const coveredHere = [
    "sessionListRequiresValidSession",
    "apexAllowlistByteIdentical",
    "sessionListShapeAndHygiene",
    "sessionRevokeRequiresCsrf",
    "sessionRevokeTargetValidation",
    "sessionRevokeEffectAndIsolation",
    "sessionSelfRevokeEqualsLogout",
    "sessionListMatchesStore",
    "pairingStatusCountConsistency",
    "nodeRoutesStayPureProxies",
    "cookieAttributesUnchanged",
  ];
  for (const field of coveredHere) {
    assert.ok(M22_AUTOMATED_FIELDS.includes(field), `${field} must be an automated field`);
  }
  // Mounted fields are executed live, never by harness tests: the empty
  // matrix carries NOT_EXECUTED everywhere and mounted validation fails.
  const matrix = emptyM22Matrix();
  for (const field of M22_MOUNTED_REQUIRED_FIELDS) {
    assert.equal(matrix[field], "NOT_EXECUTED");
  }
  assert.equal(M22_MATRIX_FIELDS.length, 22);
});

test("A1: GET /hub/sessions requires a valid session — gateway denial without admission, no-session without a cookie", async () => {
  const { hub } = createManagementHub();
  const port = await listen(hub);
  try {
    const anon = await rawRequest({ port, path: "/hub/sessions" });
    assert.equal(anon.status, 401);
    assert.equal(JSON.parse(anon.body).error.code, "gateway-denied");

    const gatewayAdmitted = await rawRequest({ port, path: "/hub/sessions", headers: { ...GATEWAY_HEADERS } });
    assert.equal(gatewayAdmitted.status, 401);
    assert.equal(JSON.parse(gatewayAdmitted.body).error.code, "no-session");

    const session = await bootstrapSession(port);
    const ok = await rawRequest({ port, path: "/hub/sessions", headers: { ...GATEWAY_HEADERS, cookie: session.cookie } });
    assert.equal(ok.status, 200);

    for (const path of ["/hub/sessions", "/hub/sessions/"]) {
      const trailing = await rawRequest({ port, path, headers: { ...GATEWAY_HEADERS, cookie: session.cookie } });
      assert.equal(trailing.status, 200, `expected 200 for ${path}`);
    }
  } finally {
    await closeHub(hub);
  }
});

test("A4: the session list shape is exact and carries no csrf_token for any session", async () => {
  const { db, hub } = createManagementHub();
  const port = await listen(hub);
  try {
    const first = await bootstrapSession(port);
    const second = await bootstrapSession(port, { principalHeader: "mobile-operator" });

    const res = await rawRequest({ port, path: "/hub/sessions", headers: { ...GATEWAY_HEADERS, cookie: first.cookie } });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(typeof body.activeCount, "number");
    assert.equal(typeof body.total, "number");
    assert.equal(body.total, 2);
    assert.equal(Array.isArray(body.sessions), true);
    assert.equal(body.sessions.length, 2);

    const expectedKeys = ["createdAt", "expiresAt", "idleUntil", "operatorPrincipal", "revokedAt", "sessionId", "sessionIdHint"].sort().join(",");
    for (const row of body.sessions) {
      assert.equal(Object.keys(row).sort().join(","), expectedKeys, "session rows expose exactly the RFC-0018 D2 projection");
      assert.match(row.sessionId, /^sess_[0-9a-f]{48}$/);
      assert.equal(row.sessionIdHint, row.sessionId.slice(0, 13));
      assert.equal(typeof row.operatorPrincipal, "string");
      assert.equal(row.revokedAt, null);
    }
    // Newest first (D2 retention decision: bounded, newest-first list); the
    // order equals the store's own newest-first projection, so same-
    // millisecond bootstraps tie-break exactly as the store orders them.
    const storeOrder = db
      .prepare("SELECT session_id FROM browser_sessions ORDER BY created_at DESC, session_id DESC")
      .all()
      .map((row) => row.session_id);
    assert.deepEqual(body.sessions.map((row) => row.sessionId), storeOrder);

    // Secret hygiene: neither csrf token value appears anywhere in the body.
    assert.equal(res.body.includes(first.csrfToken), false);
    assert.equal(res.body.includes(second.csrfToken), false);
    assert.equal(res.body.includes("csrf"), false);
  } finally {
    await closeHub(hub);
  }
});

test("A5: POST /hub/sessions/revoke is CSRF-gated and origin-checked", async () => {
  const { hub } = createManagementHub();
  const port = await listen(hub);
  try {
    const caller = await bootstrapSession(port);
    const target = await bootstrapSession(port);
    const path = "/hub/sessions/revoke";

    const noToken = await rawRequest({
      port,
      method: "POST",
      path,
      headers: { ...GATEWAY_HEADERS, cookie: caller.cookie, "content-type": "application/json" },
      body: { sessionId: target.sessionId },
    });
    assert.equal(noToken.status, 403);
    assert.equal(JSON.parse(noToken.body).error.code, "csrf-denied");

    const wrongToken = await rawRequest({
      port,
      method: "POST",
      path,
      headers: { ...GATEWAY_HEADERS, cookie: caller.cookie, "x-csrf-token": "0".repeat(48), "content-type": "application/json" },
      body: { sessionId: target.sessionId },
    });
    assert.equal(wrongToken.status, 403);
    assert.equal(JSON.parse(wrongToken.body).error.code, "csrf-denied");

    const crossSite = await rawRequest({
      port,
      method: "POST",
      path,
      headers: {
        ...GATEWAY_HEADERS,
        cookie: caller.cookie,
        "x-csrf-token": caller.csrfToken,
        "content-type": "application/json",
        origin: "https://evil.example",
        "sec-fetch-site": "same-origin",
      },
      body: { sessionId: target.sessionId },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(JSON.parse(crossSite.body).error.code, "origin-denied");

    const crossSiteFetch = await rawRequest({
      port,
      method: "POST",
      path,
      headers: {
        ...GATEWAY_HEADERS,
        cookie: caller.cookie,
        "x-csrf-token": caller.csrfToken,
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: { sessionId: target.sessionId },
    });
    assert.equal(crossSiteFetch.status, 403);
    assert.equal(JSON.parse(crossSiteFetch.body).error.code, "cross-site-denied");

    // The target session survived every rejection.
    const targetAlive = await rawRequest({ port, path: "/hub/session", headers: { ...GATEWAY_HEADERS, cookie: target.cookie } });
    assert.equal(targetAlive.status, 200);
  } finally {
    await closeHub(hub);
  }
});

test("A6: single-target validation — wildcards, arrays, multi-ids and malformed ids are invalid-target-scope; unknown/revoked are not-found", async () => {
  const { hub } = createManagementHub();
  const port = await listen(hub);
  try {
    const caller = await bootstrapSession(port);
    const headers = {
      ...GATEWAY_HEADERS,
      cookie: caller.cookie,
      "x-csrf-token": caller.csrfToken,
      "content-type": "application/json",
    };

    const badHex = "z".repeat(48);
    const rejected = [
      {},
      { sessionId: "" },
      { sessionId: "   " },
      { sessionId: null },
      { sessionId: 42 },
      { sessionId: ["sess_" + "a".repeat(48)] },
      { sessionId: { sessionId: "sess_" + "a".repeat(48) } },
      { sessionId: "all" },
      { sessionId: "*" },
      { sessionId: "ANY" },
      { sessionId: "broadcast" },
      { sessionId: "cluster" },
      { sessionId: `sess_${"a".repeat(48)},sess_${"b".repeat(48)}` },
      { sessionId: `sess_${"a".repeat(48)} sess_${"b".repeat(48)}` },
      { sessionId: "node_" + "a".repeat(32) },
      { sessionId: badHex },
      { sessionId: "sess_" + "a".repeat(47) },
      { sessionId: "sess_" + "a".repeat(49) },
      { sessionId: `SESS_${"a".repeat(48)}` },
    ];
    for (const body of rejected) {
      const res = await rawRequest({ port, method: "POST", path: "/hub/sessions/revoke", headers, body });
      assert.equal(res.status, 400, `expected 400 for body ${JSON.stringify(body)}`);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.error.code, "invalid-target-scope", `expected invalid-target-scope for ${JSON.stringify(body)}`);
    }

    const unknown = await rawRequest({
      port,
      method: "POST",
      path: "/hub/sessions/revoke",
      headers,
      body: { sessionId: "sess_" + "f".repeat(48) },
    });
    assert.equal(unknown.status, 404);
    assert.equal(JSON.parse(unknown.body).error.code, "not-found");

    // A second revocation of an already-revoked session is fail-closed too.
    const target = await bootstrapSession(port);
    const first = await rawRequest({
      port,
      method: "POST",
      path: "/hub/sessions/revoke",
      headers,
      body: { sessionId: target.sessionId },
    });
    assert.equal(first.status, 200);
    const second = await rawRequest({
      port,
      method: "POST",
      path: "/hub/sessions/revoke",
      headers,
      body: { sessionId: target.sessionId },
    });
    assert.equal(second.status, 404);
    assert.equal(JSON.parse(second.body).error.code, "not-found");
  } finally {
    await closeHub(hub);
  }
});

test("A7: revocation takes effect for the target, is audited, and isolates every other session", async () => {
  const { db, registry, hub } = createManagementHub();
  const port = await listen(hub);
  try {
    const caller = await bootstrapSession(port);
    const target = await bootstrapSession(port, { principalHeader: "mobile-operator" });
    const bystander = await bootstrapSession(port, { principalHeader: "admin" });

    const res = await rawRequest({
      port,
      method: "POST",
      path: "/hub/sessions/revoke",
      headers: { ...GATEWAY_HEADERS, cookie: caller.cookie, "x-csrf-token": caller.csrfToken, "content-type": "application/json" },
      body: { sessionId: target.sessionId },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });

    // The revoked session is dead on its very next request.
    const revokedSession = await rawRequest({ port, path: "/hub/session", headers: { ...GATEWAY_HEADERS, cookie: target.cookie } });
    assert.equal(revokedSession.status, 401);
    assert.equal(JSON.parse(revokedSession.body).error.code, "no-session");

    // The caller and the bystander are untouched.
    const callerAlive = await rawRequest({ port, path: "/hub/session", headers: { ...GATEWAY_HEADERS, cookie: caller.cookie } });
    assert.equal(callerAlive.status, 200);
    const bystanderAlive = await rawRequest({ port, path: "/hub/session", headers: { ...GATEWAY_HEADERS, cookie: bystander.cookie } });
    assert.equal(bystanderAlive.status, 200);

    // Audit row session.revoke with the RFC-0018 D2 detail shape (never the
    // csrf token). The raw audit store carries the ids; the queryAudit read
    // model redacts session* keys exactly as it does for session.bootstrap.
    const revokeRows = db.prepare("SELECT at, actor, action, detail_json FROM audit WHERE action = 'session.revoke' ORDER BY id DESC").all();
    assert.equal(revokeRows.length, 1);
    const detail = JSON.parse(revokeRows[0].detail_json);
    assert.equal(detail.sessionId, target.sessionId);
    assert.equal(detail.targetSessionId, target.sessionId);
    assert.equal(revokeRows[0].actor, "admin");
    assert.equal(JSON.stringify(detail).includes(caller.csrfToken), false);
    const readBack = registry.queryAudit({ action: "session.revoke" });
    assert.equal(readBack[0].detail.sessionId, "[REDACTED]");
    assert.equal(readBack[0].detail.targetSessionId, "[REDACTED]");

    // The store itself carries the revoked marker.
    const row = db.prepare("SELECT revoked_at FROM browser_sessions WHERE session_id = ?").get(target.sessionId);
    assert.ok(row.revoked_at !== null);
    // ...and exactly one session was touched.
    const revokedCount = db.prepare("SELECT count(*) as count FROM browser_sessions WHERE revoked_at IS NOT NULL").get();
    assert.equal(Number(revokedCount.count), 1);
  } finally {
    await closeHub(hub);
    db.close?.();
  }
});

test("A8: revoking the caller's own session equals logout — 200 now, 401 after, audited", async () => {
  const { db, registry, hub } = createManagementHub();
  const port = await listen(hub);
  try {
    const caller = await bootstrapSession(port);
    const other = await bootstrapSession(port);

    const selfRevoke = await rawRequest({
      port,
      method: "POST",
      path: "/hub/sessions/revoke",
      headers: { ...GATEWAY_HEADERS, cookie: caller.cookie, "x-csrf-token": caller.csrfToken, "content-type": "application/json" },
      body: { sessionId: caller.sessionId },
    });
    assert.equal(selfRevoke.status, 200);
    assert.deepEqual(JSON.parse(selfRevoke.body), { ok: true });

    const after = await rawRequest({ port, path: "/hub/session", headers: { ...GATEWAY_HEADERS, cookie: caller.cookie } });
    assert.equal(after.status, 401);
    assert.equal(JSON.parse(after.body).error.code, "no-session");

    // Behavior is indistinguishable from POST /hub/session/logout: both end
    // in revoked_at + a session.* audit row for the same session id.
    const revokeRows = db.prepare("SELECT at, actor, action, detail_json FROM audit WHERE action = 'session.revoke' ORDER BY id DESC").all();
    assert.equal(revokeRows.length, 1);
    assert.equal(JSON.parse(revokeRows[0].detail_json).sessionId, caller.sessionId);

    // The other session was never touched.
    const otherAlive = await rawRequest({ port, path: "/hub/session", headers: { ...GATEWAY_HEADERS, cookie: other.cookie } });
    assert.equal(otherAlive.status, 200);
  } finally {
    await closeHub(hub);
  }
});

test("A9: the list equals the store projection, activeCount uses the liveness predicate, and idleUntil advances on activity", async () => {
  const { db, registry, hub } = createManagementHub();
  const port = await listen(hub);
  try {
    const first = await bootstrapSession(port);
    const second = await bootstrapSession(port);

    // Advance the sliding window on the first session only (a small settle
    // delay guarantees the rewrite is strictly later than the bootstrap).
    await new Promise((resolve) => setTimeout(resolve, 5));
    const touch = await rawRequest({ port, path: "/hub/session", headers: { ...GATEWAY_HEADERS, cookie: first.cookie } });
    assert.equal(touch.status, 200);

    const res = await rawRequest({ port, path: "/hub/sessions", headers: { ...GATEWAY_HEADERS, cookie: first.cookie } });
    const body = JSON.parse(res.body);

    const storeRows = db.prepare("SELECT session_id, operator_principal, created_at, expires_at, idle_until, revoked_at FROM browser_sessions ORDER BY created_at DESC, session_id DESC").all();
    assert.equal(body.total, storeRows.length);
    assert.equal(body.sessions.length, storeRows.length);
    for (let i = 0; i < storeRows.length; i += 1) {
      const row = body.sessions[i];
      const store = storeRows[i];
      assert.equal(row.sessionId, store.session_id);
      assert.equal(row.operatorPrincipal, store.operator_principal);
      assert.equal(row.createdAt, store.created_at);
      assert.equal(row.expiresAt, store.expires_at);
      assert.equal(row.idleUntil, store.idle_until);
      assert.equal(row.revokedAt, store.revoked_at ?? null);
    }
    assert.equal(body.activeCount, registry.countActiveSessions());

    // Sliding window: the touched session's idle_until moved past the
    // untouched session's (validateSession rewrote it on the GET above).
    const firstRow = body.sessions.find((row) => row.sessionId === first.sessionId);
    const secondRow = body.sessions.find((row) => row.sessionId === second.sessionId);
    assert.ok(Date.parse(firstRow.idleUntil) > Date.parse(secondRow.idleUntil), "activity must advance idle_until (derived last activity)");
  } finally {
    await closeHub(hub);
    db.close?.();
  }
});

test("A10: GET /hub/pairing/status activeSessions equals the devices list activeCount for the same instant", async () => {
  const { hub } = createManagementHub();
  const port = await listen(hub);
  try {
    const first = await bootstrapSession(port);
    await bootstrapSession(port);

    const statusRes = await rawRequest({ port, path: "/hub/pairing/status", headers: { ...GATEWAY_HEADERS, cookie: first.cookie } });
    assert.equal(statusRes.status, 200);
    const status = JSON.parse(statusRes.body);

    const listRes = await rawRequest({ port, path: "/hub/sessions", headers: { ...GATEWAY_HEADERS, cookie: first.cookie } });
    const list = JSON.parse(listRes.body);

    assert.equal(status.activeSessions, list.activeCount);
    assert.equal(status.activeSessions, 2);

    // After revoking one, both counters move together.
    const revoke = await rawRequest({
      port,
      method: "POST",
      path: "/hub/sessions/revoke",
      headers: { ...GATEWAY_HEADERS, cookie: first.cookie, "x-csrf-token": first.csrfToken, "content-type": "application/json" },
      body: { sessionId: list.sessions.find((row) => row.sessionId !== first.sessionId).sessionId },
    });
    assert.equal(revoke.status, 200);

    const statusAfter = JSON.parse((await rawRequest({ port, path: "/hub/pairing/status", headers: { ...GATEWAY_HEADERS, cookie: first.cookie } })).body);
    const listAfter = JSON.parse((await rawRequest({ port, path: "/hub/sessions", headers: { ...GATEWAY_HEADERS, cookie: first.cookie } })).body);
    assert.equal(statusAfter.activeSessions, listAfter.activeCount);
    assert.equal(statusAfter.activeSessions, 1);
    assert.equal(listAfter.total, 2, "revoked rows stay visible in the list history");
  } finally {
    await closeHub(hub);
  }
});

test("A3: the selector-apex allowlist is byte-identical — the new session paths are NOT on it", async () => {
  const db = openRegistryDatabase(":memory:");
  const registry = new Registry({ db, routeDomain: APEX_HOST });
  const hub = createHubServer({
    registry,
    options: {
      gatewayAssertionSecret: "mock-gate",
      operatorPrincipal: { mode: "inject" },
      trustedExternalScheme: "https",
    },
  });
  const port = await listen(hub);
  try {
    // The two new management paths are 404 on the apex — the allowlist was
    // not widened by a single tuple.
    for (const [method, path] of [["GET", "/hub/sessions"], ["GET", "/hub/sessions/"], ["POST", "/hub/sessions/revoke"], ["POST", "/hub/sessions/revoke/"]]) {
      const res = await rawRequest({ port, method, path, host: APEX_HOST });
      assert.equal(res.status, 404, `expected 404 for ${method} ${path} on the apex`);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.error.code, "not-found");
      assert.equal(parsed.error.message, "selector authority exposes only selector surface");
    }

    // The six allowlisted tuples behave exactly as today: each still
    // dispatches into handleBrowserRequest (401 gateway-denied without
    // admission), never the 404 fallthrough.
    const tuples = [
      ["POST", "/hub/session"],
      ["GET", "/hub/session"],
      ["POST", "/hub/session/logout"],
      ["GET", "/hub/selector/nodes"],
    ];
    for (const [method, path] of tuples) {
      const res = await rawRequest({ port, method, path, host: APEX_HOST });
      assert.equal(res.status, 401, `expected the allowlisted ${method} ${path} to stay dispatching (401)`);
      assert.equal(JSON.parse(res.body).error.code, "gateway-denied");
    }

    // GET /auth on the apex still serves the landing page…
    const landing = await rawRequest({ port, path: "/auth", host: APEX_HOST });
    assert.equal(landing.status, 200);
    assert.match(landing.body, /Device pairing/);
    // …and POST /hub/pairing/verify still dispatches to the pairing contract.
    const verify = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/verify",
      host: APEX_HOST,
      headers: { "content-type": "application/json", origin: `https://${APEX_HOST}`, "sec-fetch-site": "same-origin" },
      body: { token: "000000" },
    });
    assert.equal(verify.status, 401);
    assert.equal(JSON.parse(verify.body).error.code, "code-not-found");

    // An unauthenticated GET /hub/selector/nodes on the apex is still 401
    // gateway-denied (edge/session gate unchanged by the enrichment).
    const nodesGated = await rawRequest({ port, path: "/hub/selector/nodes", host: APEX_HOST });
    assert.equal(nodesGated.status, 401);
    assert.equal(JSON.parse(nodesGated.body).error.code, "gateway-denied");
  } finally {
    await closeHub(hub);
    db.close?.();
  }
});

test("A14: node-route authorities stay pure proxies — the new session paths are never intercepted there", async () => {
  const db = openRegistryDatabase(":memory:");
  const registry = new Registry({ db, routeDomain: APEX_HOST });
  const hub = createHubServer({
    registry,
    options: {
      gatewayAssertionSecret: "mock-gate",
      operatorPrincipal: { mode: "inject" },
      trustedExternalScheme: "https",
    },
  });
  const port = await listen(hub);
  const nodeHex = "a".repeat(32);
  try {
    const nodeHost = `n-${nodeHex}.${APEX_HOST}`;
    const getRes = await rawRequest({ port, path: "/hub/sessions", host: nodeHost, headers: { accept: "application/json" } });
    assert.equal(getRes.status, 503, "the request must have entered the node-route proxy path, not a registry surface");
    const getBody = JSON.parse(getRes.body);
    assert.equal(getBody.error.code, "node-unavailable");
    assert.match(getBody.error.selectorUrl, /^https:\/\//);

    const postRes = await rawRequest({
      port,
      method: "POST",
      path: "/hub/sessions/revoke",
      host: nodeHost,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: { sessionId: "sess_" + "a".repeat(48) },
    });
    assert.equal(postRes.status, 503);
    assert.equal(JSON.parse(postRes.body).error.code, "node-unavailable");
  } finally {
    await closeHub(hub);
    db.close?.();
  }
});

test("A16: every session-issuing path emits the byte-identical host-only cookie", async () => {
  const { hub } = createManagementHub();
  const port = await listen(hub);
  const connectHost = `127.0.0.1:${port}`;
  try {
    const expectedAttributes = (value) => `${value}; HttpOnly; Secure; SameSite=Strict; Path=/hub; Max-Age=43200`;

    const bootstrap = await rawRequest({ port, method: "POST", path: "/hub/session", headers: { ...GATEWAY_HEADERS }, body: {} });
    assert.equal(bootstrap.status, 200);
    const bootValue = bootstrap.headers["set-cookie"][0].split(";")[0];
    assert.equal(bootstrap.headers["set-cookie"][0], expectedAttributes(bootValue));

    // The pairing-verify issuing path: mint a code as an operator, then
    // verify it like the phone does.
    const boot = JSON.parse(bootstrap.body);
    const gen = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/generate-code",
      headers: {
        ...GATEWAY_HEADERS,
        cookie: bootValue,
        "x-csrf-token": boot.csrfToken,
        "content-type": "application/json",
        origin: `https://${connectHost}`,
      },
      body: {},
    });
    assert.equal(gen.status, 201);
    const { code } = JSON.parse(gen.body);

    const verify = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/verify",
      headers: { "content-type": "application/json", origin: `https://${connectHost}`, "sec-fetch-site": "same-origin" },
      body: { token: code },
    });
    assert.equal(verify.status, 200);
    const verifyValue = verify.headers["set-cookie"][0].split(";")[0];
    assert.equal(verify.headers["set-cookie"][0], expectedAttributes(verifyValue));
    assert.match(verifyValue, /^dsh-orbit-hub-session=sess_[0-9a-f]{48}$/);
  } finally {
    await closeHub(hub);
  }
});
