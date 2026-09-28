import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { validateHubConfig } from "../src/registry/config.mjs";
import {
  emptyM17Matrix,
  M17_MATRIX_FIELDS,
  assertM17MatrixShape,
} from "../scripts/v10-landing-acceptance-matrix.mjs";

// RFC-0017 Stage 1: mechanical coverage for matrix fields A1-A13 on a real
// createHubServer instance. Host overrides use node:http directly so the
// selector-apex and node-route authority branches are exercised for real.

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

function createManagementHub({ qrPairingBaseUrl = null } = {}) {
  const db = openRegistryDatabase(":memory:");
  const registry = new Registry({ db });
  const options = {
    gatewayAssertionSecret: "mock-gate",
    operatorPrincipal: { mode: "inject" },
    trustedExternalScheme: "https",
  };
  if (qrPairingBaseUrl !== null) options.qrPairingBaseUrl = qrPairingBaseUrl;
  const hub = createHubServer({ registry, options });
  return { db, registry, hub, options };
}

async function listen(hub) {
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  return hub.server.address().port;
}

const APEX_HOST = "dsh.ikarikore.top";

test("A1/A2: /auth landing served on the management authority with no-store and no-referrer", async () => {
  const { hub } = createManagementHub();
  const port = await listen(hub);
  try {
    const noQuery = await rawRequest({ port, path: "/auth" });
    assert.equal(noQuery.status, 200);
    assert.match(noQuery.headers["content-type"], /text\/html/);
    assert.equal(noQuery.headers["cache-control"], "no-store");
    assert.equal(noQuery.headers["referrer-policy"], "no-referrer");
    assert.match(noQuery.body, /Device pairing/);

    const withToken = await rawRequest({ port, path: "/auth?token=123456" });
    assert.equal(withToken.status, 200);
    assert.equal(withToken.headers["cache-control"], "no-store");
    assert.equal(withToken.headers["referrer-policy"], "no-referrer");
    // The token is never echoed back by the server (A2/A12).
    assert.ok(!withToken.body.includes("123456"));
  } finally {
    await closeHub(hub);
  }
});

test("A3/A4: fence exception is a raw-query total grammar — parameter and encoding variants all rejected", async () => {
  const { hub } = createManagementHub();
  const port = await listen(hub);
  const rejected = [
    "/auth?token=123456&x=1",
    "/auth?token=123456&",
    "/auth?&token=123456",
    "/auth?token=123456&&",
    "/auth?token=12345",
    "/auth?token=1234567",
    "/auth?token=abcdef",
    "/auth?code=123456",
    "/auth?token=" + "%31".repeat(6),
    "/auth?token=",
  ];
  try {
    for (const path of rejected) {
      const res = await rawRequest({ port, path });
      assert.equal(res.status, 400, `expected 400 for ${path}`);
      const body = JSON.parse(res.body);
      assert.equal(body.error.code, "query-not-allowed", `expected query-not-allowed for ${path}`);
    }
  } finally {
    await closeHub(hub);
  }
});

test("A5: the query fence is unchanged on every non-/auth route", async () => {
  const { hub } = createManagementHub();
  const port = await listen(hub);
  try {
    for (const path of ["/styles.css?v=1", "/?token=123456", "/hub/session?token=123456"]) {
      const res = await rawRequest({ port, path });
      assert.equal(res.status, 400, `expected 400 for ${path}`);
      assert.equal(JSON.parse(res.body).error.code, "query-not-allowed");
    }
  } finally {
    await closeHub(hub);
  }
});

test("A6: method discipline — POST/HEAD/OPTIONS and the /auth/ path variant stay fail-closed", async () => {
  const { hub } = createManagementHub();
  const port = await listen(hub);
  try {
    const postNoQuery = await rawRequest({ port, method: "POST", path: "/auth" });
    assert.equal(postNoQuery.status, 404);

    const postWithQuery = await rawRequest({ port, method: "POST", path: "/auth?token=123456" });
    assert.equal(postWithQuery.status, 400);
    assert.equal(JSON.parse(postWithQuery.body).error.code, "query-not-allowed");

    for (const method of ["HEAD", "OPTIONS"]) {
      const res = await rawRequest({ port, method, path: "/auth?token=123456" });
      assert.equal(res.status, 400, `expected 400 for ${method} /auth (exception is GET-only)`);
    }

    const trailingSlash = await rawRequest({ port, path: "/auth/" });
    assert.equal(trailingSlash.status, 404);
  } finally {
    await closeHub(hub);
  }
});

test("A7/A13: on the selector apex the landing is served and verify is dispatched to the pairing handler", async () => {
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
    const landing = await rawRequest({ port, path: "/auth?token=123456", host: APEX_HOST });
    assert.equal(landing.status, 200);
    assert.match(landing.body, /selector-authority" content="dsh\.ikarikore\.top"/);
    assert.ok(!landing.body.includes("123456"));

    // A13: the apex verify tuple reaches handlePairingVerify directly — an
    // unknown code yields the pairing contract's 401 code-not-found, NOT the
    // selector-surface 404 and NOT gateway-denied.
    for (const path of ["/hub/pairing/verify", "/hub/pairing/verify/"]) {
      const res = await rawRequest({
        port,
        method: "POST",
        path,
        host: APEX_HOST,
        headers: {
          "content-type": "application/json",
          origin: `https://${APEX_HOST}`,
          "sec-fetch-site": "same-origin",
        },
        body: { token: "000000" },
      });
      assert.equal(res.status, 401, `expected pairing-contract 401 for ${path}`);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.error.code, "code-not-found", `expected code-not-found for ${path}`);
    }

    // A7 second clause: the node list stays session/gateway-gated on the apex.
    const nodesGated = await rawRequest({
      port,
      path: "/hub/selector/nodes",
      host: APEX_HOST,
    });
    assert.equal(nodesGated.status, 401);
    assert.equal(JSON.parse(nodesGated.body).error.code, "gateway-denied");

    // Minting stays management-only: generate-code on the apex is still 404.
    const mint = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/generate-code",
      host: APEX_HOST,
      headers: {
        "content-type": "application/json",
        origin: `https://${APEX_HOST}`,
      },
      body: {},
    });
    assert.equal(mint.status, 404);
    assert.equal(JSON.parse(mint.body).error.message, "selector authority exposes only selector surface");
  } finally {
    await closeHub(hub);
  }
});

test("A8: node-route authorities remain pure proxies — /auth with a query is not intercepted", async () => {
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
    for (const path of ["/auth?token=123456", "/auth"]) {
      const res = await rawRequest({ port, path, host: `n-${nodeHex}.${APEX_HOST}` });
      // The request must have entered the node-route proxy path (node not
      // present ⇒ node-unavailable), never the registry's own /auth surface.
      assert.equal(res.status, 503, `expected node-route proxy 503 for ${path}`);
      assert.equal(JSON.parse(res.body).error.code, "node-unavailable");
    }
  } finally {
    await closeHub(hub);
  }
});

test("A9: mint base override wins for generate-code and pairing status", async () => {
  const { hub } = createManagementHub({ qrPairingBaseUrl: "https://pair.example.org" });
  const port = await listen(hub);
  try {
    const sessionRes = await rawRequest({
      port,
      method: "POST",
      path: "/hub/session",
      headers: { ...GATEWAY_HEADERS },
      body: {},
    });
    assert.equal(sessionRes.status, 200);
    const cookie = sessionRes.headers["set-cookie"][0].split(";")[0];
    const { csrfToken } = JSON.parse(sessionRes.body);

    const genRes = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/generate-code",
      headers: {
        ...GATEWAY_HEADERS,
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
        origin: `https://127.0.0.1:${port}`,
      },
      body: {},
    });
    assert.equal(genRes.status, 201);
    const gen = JSON.parse(genRes.body);
    assert.equal(gen.url, `https://pair.example.org/auth?token=${gen.code}`);
    assert.match(gen.code, /^[0-9]{6}$/);

    const statusRes = await rawRequest({
      port,
      path: "/hub/pairing/status",
      headers: { ...GATEWAY_HEADERS, cookie },
    });
    assert.equal(statusRes.status, 200);
    assert.equal(JSON.parse(statusRes.body).hubBaseUrl, "https://pair.example.org");
  } finally {
    await closeHub(hub);
  }
});

test("A10: without the override the mint base is the request-Host-derived origin (v0.9 behavior)", async () => {
  const { hub } = createManagementHub();
  const port = await listen(hub);
  const connectHost = `127.0.0.1:${port}`;
  try {
    const sessionRes = await rawRequest({
      port,
      method: "POST",
      path: "/hub/session",
      headers: { ...GATEWAY_HEADERS },
      body: {},
    });
    const cookie = sessionRes.headers["set-cookie"][0].split(";")[0];
    const { csrfToken } = JSON.parse(sessionRes.body);

    const genRes = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/generate-code",
      headers: {
        ...GATEWAY_HEADERS,
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
        origin: `https://${connectHost}`,
      },
      body: {},
    });
    assert.equal(genRes.status, 201);
    const gen = JSON.parse(genRes.body);
    assert.equal(gen.url, `https://${connectHost}/auth?token=${gen.code}`);

    const statusRes = await rawRequest({
      port,
      path: "/hub/pairing/status",
      headers: { ...GATEWAY_HEADERS, cookie },
    });
    assert.equal(statusRes.status, 200);
    assert.equal(JSON.parse(statusRes.body).hubBaseUrl, `https://${connectHost}`);
  } finally {
    await closeHub(hub);
  }
});

test("A11: invalid mint override fails closed — collected config error and constructor throw", () => {
  const invalid = [
    "http://pair.example.org",
    "https://user:pass@pair.example.org",
    "https://pair.example.org/?a=1",
    "https://pair.example.org/#frag",
    "https://pair.example.org/hub",
    "not-a-url",
  ];
  for (const value of invalid) {
    const errors = validateHubConfig({ listen: "127.0.0.1", trustedExternalScheme: "https", qrPairingBaseUrl: value });
    assert.equal(errors.length, 1, `expected exactly one config error for ${value}`);
    assert.match(errors[0], /DSH_ORBIT_HUB_QR_PAIRING_BASE_URL/);
  }
  // Empty string means unset (repo-wide env convention) — clean config, no error.
  assert.deepEqual(
    validateHubConfig({ listen: "127.0.0.1", trustedExternalScheme: "https", qrPairingBaseUrl: "" }),
    [],
  );
  for (const value of ["https://pair.example.org", "https://pair.example.org:8443"]) {
    const errors = validateHubConfig({ listen: "127.0.0.1", trustedExternalScheme: "https", qrPairingBaseUrl: value });
    assert.deepEqual(errors, [], `expected no config error for ${value}`);
  }
  assert.throws(
    () => createManagementHub({ qrPairingBaseUrl: "http://pair.example.org" }),
    /qrPairingBaseUrl must be an origin-only https URL/,
  );
  assert.throws(
    () => createManagementHub({ qrPairingBaseUrl: "https://pair.example.org/hub" }),
    /qrPairingBaseUrl must be an origin-only https URL/,
  );
});

test("A12: a full mint-verify round leaks no token= into audit or responses; session cookie attributes are unchanged", async () => {
  const { db, hub } = createManagementHub();
  const port = await listen(hub);
  const connectHost = `127.0.0.1:${port}`;
  try {
    const sessionRes = await rawRequest({
      port,
      method: "POST",
      path: "/hub/session",
      headers: { ...GATEWAY_HEADERS },
      body: {},
    });
    const cookie = sessionRes.headers["set-cookie"][0].split(";")[0];
    const { csrfToken } = JSON.parse(sessionRes.body);

    const genRes = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/generate-code",
      headers: {
        ...GATEWAY_HEADERS,
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
        origin: `https://${connectHost}`,
      },
      body: {},
    });
    const gen = JSON.parse(genRes.body);

    // Land on /auth with the minted code, then verify it.
    const landing = await rawRequest({ port, path: `/auth?token=${gen.code}` });
    assert.equal(landing.status, 200);
    assert.ok(!landing.body.includes(gen.code));

    const verifyRes = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/verify",
      headers: {
        "content-type": "application/json",
        origin: `https://${connectHost}`,
        "sec-fetch-site": "same-origin",
      },
      body: { token: gen.code },
    });
    assert.equal(verifyRes.status, 200);
    const verifyBody = JSON.parse(verifyRes.body);
    assert.equal(verifyBody.ok, true);
    assert.ok(!verifyRes.body.includes(gen.code));

    // Session cookie attributes are the v0.9 contract, unchanged.
    const setCookie = verifyRes.headers["set-cookie"][0];
    assert.match(setCookie, /^dsh-orbit-hub-session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\/hub/i);

    // Audit store: no record carries the code in token= (URL) form. The
    // generation audit keeps the operator-visible `code` field by design.
    const auditRes = await rawRequest({
      port,
      path: "/hub/audit",
      headers: { ...GATEWAY_HEADERS, cookie, "x-csrf-token": csrfToken },
    });
    assert.equal(auditRes.status, 200);
    const auditBody = JSON.parse(auditRes.body);
    const auditText = JSON.stringify(auditBody);
    assert.ok(!auditText.includes(`token=${gen.code}`));

    // M17 bookkeeping: assert the shape contract so a drift fails loudly.
    const matrix = emptyM17Matrix();
    for (const field of M17_MATRIX_FIELDS) matrix[field] = "PASS";
    assertM17MatrixShape(matrix, { scope: "mounted", requirePass: true });
  } finally {
    await closeHub(hub);
    db.close?.();
  }
});
