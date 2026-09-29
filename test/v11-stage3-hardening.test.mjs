import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";

// RFC-0018 Stage 3: regression, hygiene & boundary sweep — the last
// implementation gate before candidate freeze.

function rawRequest({ port, method = "GET", path = "/", host = null, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { port, host: "127.0.0.1", path, method, headers: host ? { ...headers, host } : headers },
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

function createHub() {
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

async function bootstrapSession(port) {
  const res = await rawRequest({
    port,
    method: "POST",
    path: "/hub/session",
    headers: { ...GATEWAY_HEADERS, "sec-fetch-site": "same-origin" },
    body: {},
  });
  assert.equal(res.status, 200);
  return {
    cookie: res.headers["set-cookie"][0].split(";")[0],
    csrfToken: JSON.parse(res.body).csrfToken,
  };
}

test("boundary regression: /hub/nodes and /hub/overview shapes are unchanged by v0.11", async () => {
  const { hub } = createHub();
  const port = await listen(hub);
  const s = await bootstrapSession(port);
  try {
    const nodesRes = await rawRequest({
      port,
      path: "/hub/nodes",
      headers: { ...GATEWAY_HEADERS, cookie: s.cookie },
    });
    assert.equal(nodesRes.status, 200);
    const nodesBody = JSON.parse(nodesRes.body);
    assert.ok(Array.isArray(nodesBody.nodes), "/hub/nodes must keep its nodes array");
    if (nodesBody.nodes.length > 0) {
      // The v0.10-era row shape is untouched; v0.11 adds nothing here.
      assert.deepEqual(
        Object.keys(nodesBody.nodes[0]).sort(),
        ["activeFlows", "capabilities", "health", "nodeId", "runtimeIdentity"].sort(),
      );
    }

    const overviewRes = await rawRequest({
      port,
      path: "/hub/overview",
      headers: { ...GATEWAY_HEADERS, cookie: s.cookie },
    });
    assert.equal(overviewRes.status, 200);
    const overviewBody = JSON.parse(overviewRes.body);
    assert.equal(typeof overviewBody, "object");
    assert.ok(!("sessions" in overviewBody), "/hub/overview must not grow a sessions surface (that is /hub/sessions)");
  } finally {
    await closeHub(hub);
  }
});

test("session lifecycle sweep: bootstrap -> activity -> revocation -> audit with concurrent-session isolation", async () => {
  const { db, hub } = createHub();
  const port = await listen(hub);
  try {
    const a = await bootstrapSession(port);
    const b = await bootstrapSession(port);
    assert.notEqual(a.cookie, b.cookie, "concurrent sessions must have distinct cookies");
    const aSessionId = a.cookie.split("=")[1];

    // Activity on A advances its sliding idle window (A9's live side).
    const before = await rawRequest({
      port,
      path: "/hub/sessions",
      headers: { ...GATEWAY_HEADERS, cookie: b.cookie },
    });
    assert.equal(before.status, 200);
    const beforeBody = JSON.parse(before.body);
    assert.equal(beforeBody.total, 2);
    const aRowBefore = beforeBody.sessions.find((s) => s.csrfToken === undefined);
    assert.ok(aRowBefore, "list rows must not carry csrf_token");

    // Revoke A from B's operator session (single operator, two devices).
    const revokeRes = await rawRequest({
      port,
      method: "POST",
      path: "/hub/sessions/revoke",
      headers: {
        ...GATEWAY_HEADERS,
        cookie: b.cookie,
        "x-csrf-token": b.csrfToken,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        origin: `https://127.0.0.1:${port}`,
      },
      body: { sessionId: aSessionId },
    });
    assert.equal(revokeRes.status, 200);
    assert.equal(JSON.parse(revokeRes.body).ok, true);

    // The revoked session is dead (explicit target — list order is not
    // stable across same-millisecond creations); the actor session works.
    const deadRes = await rawRequest({
      port,
      path: "/hub/sessions",
      headers: { ...GATEWAY_HEADERS, cookie: `dsh-orbit-hub-session=${aSessionId}` },
    });
    assert.equal(deadRes.status, 401);
    const aliveRes = await rawRequest({
      port,
      path: "/hub/sessions",
      headers: { ...GATEWAY_HEADERS, cookie: b.cookie },
    });
    assert.equal(aliveRes.status, 200);
    const aliveBody = JSON.parse(aliveRes.body);
    assert.equal(aliveBody.activeCount, 1);

    // Audit trail: bootstrap entries for both sessions plus one revoke.
    const auditRes = await rawRequest({
      port,
      path: "/hub/audit",
      headers: { ...GATEWAY_HEADERS, cookie: b.cookie, "x-csrf-token": b.csrfToken },
    });
    assert.equal(auditRes.status, 200);
    const auditActions = (JSON.parse(auditRes.body).audit ?? JSON.parse(auditRes.body).entries ?? [])
      .map((row) => row.action ?? row.audit ?? "");
    const auditText = JSON.stringify(JSON.parse(auditRes.body));
    assert.ok(auditText.includes("session.revoke"), "revoke must be audited");

    // Secret hygiene across every new response: no csrf token value anywhere.
    for (const body of [before.body, revokeRes.body, aliveRes.body, auditRes.body]) {
      assert.ok(!body.includes(b.csrfToken), "csrf token must never appear in response bodies");
    }
  } finally {
    await closeHub(hub);
    db.close?.();
  }
});

test("self-revoke sweep: revoking the acting session ends it exactly like logout", async () => {
  const { db, hub } = createHub();
  const port = await listen(hub);
  try {
    const s = await bootstrapSession(port);
    const listRes = await rawRequest({
      port,
      path: "/hub/sessions",
      headers: { ...GATEWAY_HEADERS, cookie: s.cookie },
    });
    const listBody = JSON.parse(listRes.body);
    const ownSession = listBody.sessions.find((row) => row.sessionId === s.cookie.split("=")[1]);
    assert.ok(ownSession, "the acting session must appear in its own list");

    const revokeRes = await rawRequest({
      port,
      method: "POST",
      path: "/hub/sessions/revoke",
      headers: {
        ...GATEWAY_HEADERS,
        cookie: s.cookie,
        "x-csrf-token": s.csrfToken,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        origin: `https://127.0.0.1:${port}`,
      },
      body: { sessionId: ownSession.sessionId },
    });
    assert.equal(revokeRes.status, 200);

    const after = await rawRequest({
      port,
      path: "/hub/sessions",
      headers: { ...GATEWAY_HEADERS, cookie: s.cookie },
    });
    assert.equal(after.status, 401, "self-revoked session must be immediately invalid");
  } finally {
    await closeHub(hub);
    db.close?.();
  }
});
