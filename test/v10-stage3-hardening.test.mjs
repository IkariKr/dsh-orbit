import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";

// RFC-0017 Stage 3: resilience, leakage and regression hardening. Completes
// matrix field A12 (audit store + responses AND logs across a full round,
// including failed attempts and lockout) and pins the apex verify defense
// behaviors that Gate A's exposure-delta decision relies on.

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
const APEX_HOST = "dsh.ikarikore.top";

function createHub({ routeDomain = null } = {}) {
  const db = openRegistryDatabase(":memory:");
  const registry = new Registry(routeDomain ? { db, routeDomain } : { db });
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

async function mintCode(port, connectHost) {
  const sessionRes = await rawRequest({
    port,
    method: "POST",
    path: "/hub/session",
    headers: { ...GATEWAY_HEADERS },
    body: {},
  });
  // Session bootstrap cookie carries the exact v0.9 attributes including
  // the 12h Max-Age (regression pin on the /hub/session branch).
  const sessionSetCookie = sessionRes.headers["set-cookie"][0];
  assert.match(sessionSetCookie, /Max-Age=43200(?:[^0-9]|$)/);
  assert.match(sessionSetCookie, /SameSite=Strict/i);
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
  return { cookie, csrfToken, gen: JSON.parse(genRes.body) };
}

test("A12 completion: a full round with failures and lockout leaks no token= into audit, responses, or logs", async () => {
  const { db, hub } = createHub();
  const port = await listen(hub);
  const connectHost = `127.0.0.1:${port}`;

  const logLines = [];
  const capture = (...args) => logLines.push(args.map(String).join(" "));
  const originals = {};
  for (const channel of ["error", "warn", "log", "info", "debug", "trace", "dir"]) {
    originals[channel] = console[channel];
    console[channel] = capture;
  }
  // Raw process.stdout/stderr writes are NOT captured: in-process, the
  // node:test runner owns those streams (its NDJSON events contain this
  // test's own title), and src/ logs exclusively through the console
  // channels above — all of which are captured.

  try {
    const { cookie, csrfToken, gen } = await mintCode(port, connectHost);

    // Landing with the code, failed attempts, a successful verify, and a replay.
    const landing = await rawRequest({ port, path: `/auth?token=${gen.code}` });
    assert.equal(landing.status, 200);

    for (const wrong of ["000000", "111111", "222222", "333333"]) {
      const failRes = await rawRequest({
        port,
        method: "POST",
        path: "/hub/pairing/verify",
        headers: { "content-type": "application/json", origin: `https://${connectHost}` },
        body: { token: wrong },
      });
      assert.equal(failRes.status, 401);
      // The failed-attempt body must not echo the submitted value (RFC D6).
      assert.ok(!failRes.body.includes(wrong), `failure body echoed the submitted value for ${wrong}`);
    }
    const successRes = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/verify",
      headers: { "content-type": "application/json", origin: `https://${connectHost}` },
      body: { token: gen.code },
    });
    assert.equal(successRes.status, 200);
    const replayRes = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/verify",
      headers: { "content-type": "application/json", origin: `https://${connectHost}` },
      body: { token: gen.code },
    });
    assert.equal(replayRes.status, 401);
    assert.equal(JSON.parse(replayRes.body).error.code, "code-not-found");

    // The audit store (read through the management API) contains no token=
    // URL form of the code. The generation audit's operator-visible `code`
    // field is by design (RFC-0017 D6) and is not a landing-path leak.
    const auditRes = await rawRequest({
      port,
      path: "/hub/audit",
      headers: { ...GATEWAY_HEADERS, cookie, "x-csrf-token": csrfToken },
    });
    assert.equal(auditRes.status, 200);
    assert.ok(!auditRes.body.includes(`token=${gen.code}`));

    // No response in the round echoed the code except the mint output itself.
    assert.ok(!landing.body.includes(gen.code));
    assert.ok(!successRes.body.includes(gen.code));
    assert.ok(!replayRes.body.includes(gen.code));

    // No log line from the whole round contains the code or any token= form.
    for (const line of logLines) {
      assert.ok(!line.includes(gen.code), `log line leaked the code: ${line}`);
      assert.ok(!line.includes("token="), `log line leaked a token= form: ${line}`);
    }
  } finally {
    for (const [channel, original] of Object.entries(originals)) {
      console[channel] = original;
    }
    await closeHub(hub);
    db.close?.();
  }
});

test("lockout interplay: 5 failures from one IP lock the endpoint (429, no Retry-After), even for a live code", async () => {
  const { db, hub } = createHub();
  const port = await listen(hub);
  const connectHost = `127.0.0.1:${port}`;
  try {
    const { gen } = await mintCode(port, connectHost);

    for (const wrong of ["000000", "111111", "222222", "333333", "444444"]) {
      const failRes = await rawRequest({
        port,
        method: "POST",
        path: "/hub/pairing/verify",
        headers: { "content-type": "application/json", origin: `https://${connectHost}` },
        body: { token: wrong },
      });
      assert.equal(failRes.status, 401);
    }

    // The live code now fails closed with 429 rate-limited, and the 429
    // carries no Retry-After header (RFC-0017: none exists, none is added).
    const lockedRes = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/verify",
      headers: { "content-type": "application/json", origin: `https://${connectHost}` },
      body: { token: gen.code },
    });
    assert.equal(lockedRes.status, 429);
    assert.equal(JSON.parse(lockedRes.body).error.code, "rate-limited");
    assert.equal(lockedRes.headers["retry-after"], undefined);
  } finally {
    await closeHub(hub);
    db.close?.();
  }
});

test("pairing verify defenses: origin mismatch, malformed origin, cross-site, bad-json, and body limit all fail closed", async () => {
  const { db, hub } = createHub({ routeDomain: APEX_HOST });
  const port = await listen(hub);
  try {
    const crossOrigin = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/verify",
      host: APEX_HOST,
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: { token: "123456" },
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(JSON.parse(crossOrigin.body).error.code, "origin-denied");

    const malformedOrigin = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/verify",
      host: APEX_HOST,
      headers: {
        "content-type": "application/json",
        origin: "not-a-url",
      },
      body: { token: "123456" },
    });
    assert.equal(malformedOrigin.status, 403);
    assert.equal(JSON.parse(malformedOrigin.body).error.code, "origin-denied");

    const emptyBody = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/verify",
      host: APEX_HOST,
      headers: {
        "content-type": "application/json",
        origin: `https://${APEX_HOST}`,
      },
    });
    assert.equal(emptyBody.status, 400);
    assert.equal(JSON.parse(emptyBody.body).error.code, "bad-json");

    const crossSite = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/verify",
      host: APEX_HOST,
      headers: {
        "content-type": "application/json",
        origin: `https://${APEX_HOST}`,
        "sec-fetch-site": "cross-site",
      },
      body: { token: "123456" },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(JSON.parse(crossSite.body).error.code, "cross-site-denied");

    const oversized = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/verify",
      host: APEX_HOST,
      headers: { "content-type": "application/json", origin: `https://${APEX_HOST}` },
      body: JSON.stringify({ token: "123456", pad: "x".repeat(70 * 1024) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await closeHub(hub);
    db.close?.();
  }
});

test("cross-authority redemption: a code minted on management verifies on the apex exactly once", async () => {
  const { db, hub } = createHub({ routeDomain: APEX_HOST });
  const port = await listen(hub);
  const connectHost = `127.0.0.1:${port}`;
  try {
    const { gen } = await mintCode(port, connectHost);

    const first = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/verify",
      host: APEX_HOST,
      headers: {
        "content-type": "application/json",
        origin: `https://${APEX_HOST}`,
        "sec-fetch-site": "same-origin",
      },
      body: { token: gen.code },
    });
    assert.equal(first.status, 200);
    assert.equal(JSON.parse(first.body).ok, true);
    // The operator session issued on the apex carries the exact v0.9
    // attributes, including the 12h lifetime.
    const setCookie = first.headers["set-cookie"][0];
    assert.match(setCookie, /^dsh-orbit-hub-session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\/hub/i);
    assert.match(setCookie, /Max-Age=43200(?:[^0-9]|$)/);

    const replay = await rawRequest({
      port,
      method: "POST",
      path: "/hub/pairing/verify",
      host: APEX_HOST,
      headers: {
        "content-type": "application/json",
        origin: `https://${APEX_HOST}`,
        "sec-fetch-site": "same-origin",
      },
      body: { token: gen.code },
    });
    assert.equal(replay.status, 401);
    assert.equal(JSON.parse(replay.body).error.code, "code-not-found");
  } finally {
    await closeHub(hub);
    db.close?.();
  }
});
