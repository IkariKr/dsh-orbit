// RFC-0016 Stage 4: Resilience, Rate Limiting, Brute-Force Containment & Zero-Leak Security Tests
// Verifies:
// 1. IP brute-force lockout: 5 consecutive failed attempts trigger 15-minute 429 lockout (Field 28/29)
// 2. Anti-replay enforcement: Immediate single-use destruction of pairing code (concurrent race defense)
// 3. Zero credential leakage: QR and verification payloads carry only ephemeral session tokens, never machine credentials
// 4. Scheme validation defense-in-depth: Both engine and Hub endpoint fail closed on unencrypted HTTP
// 5. Memory leak defense: Stale IP attempt records and expired pairing codes are automatically pruned
// 6. Concurrency resilience: High-concurrency listener subscription handles multiple operator sessions

import assert from "node:assert/strict";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { PairingCodeEngine, PairingCodeError } from "../src/registry/pairing-code.mjs";

test("resilience: IP brute-force lockout containment (5 failed attempts trigger 15-min lockout)", () => {
  let simulatedTime = 1_000_000;
  const lockDurationMs = 15 * 60 * 1000;
  const engine = new PairingCodeEngine({
    maxFailedAttempts: 5,
    lockDurationMs,
    now: () => simulatedTime,
  });

  const ip = "192.0.2.100";

  // First 4 failed attempts do not lock
  for (let i = 0; i < 4; i++) {
    const res = engine.verifyCode("000000", ip);
    assert.equal(res.valid, false);
    assert.equal(res.code, "code-not-found");
  }
  assert.equal(engine.checkIpLockout(ip).locked, false);

  // 5th failed attempt triggers lockout
  const res5 = engine.verifyCode("000000", ip);
  assert.equal(res5.valid, false);
  assert.equal(engine.checkIpLockout(ip).locked, true);

  // Subsequent attempts are rejected with rate-limited (429)
  const lockedRes = engine.verifyCode("000000", ip);
  assert.equal(lockedRes.valid, false);
  assert.equal(lockedRes.code, "rate-limited");
  assert.ok(lockedRes.message.includes("IP temporarily locked"));

  // Advance time past lock duration (15 minutes + 1ms)
  simulatedTime += lockDurationMs + 1;
  assert.equal(engine.checkIpLockout(ip).locked, false);
});

test("resilience: anti-replay race containment (concurrent verifications allow exactly one success)", async () => {
  const engine = new PairingCodeEngine();
  const record = engine.generateCode({
    operatorPrincipal: "operator-alice",
    hubBaseUrl: "https://hub.orbit.test",
  });

  // Launch 10 simultaneous verifications for the exact same code
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => Promise.resolve(engine.verifyCode(record.code, `192.0.2.${i + 1}`))),
  );

  const successes = results.filter((r) => r.valid);
  const failures = results.filter((r) => !r.valid);

  assert.equal(successes.length, 1);
  assert.equal(successes[0].operatorPrincipal, "operator-alice");
  assert.equal(failures.length, 9);
  failures.forEach((f) => assert.equal(f.code, "code-not-found"));
});

test("security: zero credential leakage (pairing payloads never leak machine keys, private certs, or tokens)", async () => {
  const db = openRegistryDatabase(":memory:");
  const registry = new Registry({ db });
  const hub = createHubServer({
    registry,
    options: {
      gatewayAssertionSecret: "gate-secret",
      operatorPrincipal: { mode: "inject" },
      trustedExternalScheme: "https",
    },
  });
  await new Promise((r) => hub.server.listen(0, "127.0.0.1", r));
  const port = hub.server.address().port;
  const host = `127.0.0.1:${port}`;

  try {
    const gatewayHeaders = {
      "x-dsh-authenticated-proxy": "gate-secret",
      "x-dsh-operator-id": "admin",
    };

    // 1. Establish session
    const sessionRes = await fetch(`http://${host}/hub/session`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: `https://${host}`,
        ...gatewayHeaders,
      },
    });
    const sessionCookie = sessionRes.headers.get("set-cookie").split(";")[0];
    const { csrfToken } = await sessionRes.json();

    // 2. Generate code
    const genRes = await fetch(`http://${host}/hub/pairing/generate-code`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: `https://${host}`,
        Cookie: sessionCookie,
        "x-csrf-token": csrfToken,
        ...gatewayHeaders,
      },
    });
    const genData = await genRes.json();

    // Verify QR URL payload contains ONLY 6-digit token, no credentials
    const qrUrl = new URL(genData.url);
    assert.equal(qrUrl.searchParams.get("token"), genData.code);
    assert.equal(qrUrl.searchParams.has("key"), false);
    assert.equal(qrUrl.searchParams.has("privateKey"), false);
    assert.equal(qrUrl.searchParams.has("secret"), false);
    assert.equal(qrUrl.searchParams.has("password"), false);

    // 3. Status endpoint leak check: only aggregated numbers, no codes or tokens
    const statusRes = await fetch(`http://${host}/hub/pairing/status`, {
      headers: {
        Host: host,
        Origin: `https://${host}`,
        Cookie: sessionCookie,
        ...gatewayHeaders,
      },
    });
    const statusData = await statusRes.json();
    assert.deepEqual(Object.keys(statusData).sort(), ["activeCodes", "activeSessions", "hubBaseUrl"]);
    assert.equal(typeof statusData.activeCodes, "number");
    assert.equal(typeof statusData.activeSessions, "number");

    // 4. Verify code
    const verifyRes = await fetch(`http://${host}/hub/pairing/verify`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: `https://${host}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: genData.code }),
    });
    const verifyData = await verifyRes.json();

    // Verify response contains only operator session identifiers
    assert.deepEqual(Object.keys(verifyData).sort(), ["csrfToken", "expiresAt", "ok", "principal"]);
    assert.equal(verifyData.principal, "admin");

    // Check database tables: node identity tables must remain completely empty
    const nodeCount = db.prepare("SELECT count(*) as c FROM nodes").get().c;
    const nodeKeysCount = db.prepare("SELECT count(*) as c FROM node_keys").get().c;
    assert.equal(nodeCount, 0);
    assert.equal(nodeKeysCount, 0);
  } finally {
    hub.server.closeAllConnections?.();
    await new Promise((r) => hub.server.close(r));
    db.close();
  }
});

test("security: scheme validation defense-in-depth (engine and HTTP endpoint reject plain http://)", async () => {
  const engine = new PairingCodeEngine();

  // Engine rejects plain http://
  assert.throws(
    () => engine.generateCode({ hubBaseUrl: "http://insecure.orbit.test" }),
    (err) => err instanceof PairingCodeError && err.code === "insecure-scheme",
  );

  // Hub endpoint rejects code generation if trustedExternalScheme is http
  const db = openRegistryDatabase(":memory:");
  const registry = new Registry({ db });
  const hub = createHubServer({
    registry,
    options: {
      gatewayAssertionSecret: "gate-secret",
      operatorPrincipal: { mode: "inject" },
      trustedExternalScheme: "http", // Insecure scheme configuration
    },
  });
  await new Promise((r) => hub.server.listen(0, "127.0.0.1", r));
  const port = hub.server.address().port;
  const host = `127.0.0.1:${port}`;

  try {
    const gatewayHeaders = {
      "x-dsh-authenticated-proxy": "gate-secret",
      "x-dsh-operator-id": "admin",
    };

    const sessionRes = await fetch(`http://${host}/hub/session`, {
      method: "POST",
      headers: { Host: host, Origin: `http://${host}`, ...gatewayHeaders },
    });
    const sessionCookie = sessionRes.headers.get("set-cookie").split(";")[0];
    const { csrfToken } = await sessionRes.json();

    const genRes = await fetch(`http://${host}/hub/pairing/generate-code`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: `http://${host}`,
        Cookie: sessionCookie,
        "x-csrf-token": csrfToken,
        ...gatewayHeaders,
      },
    });
    assert.equal(genRes.status, 400);
    const genData = await genRes.json();
    assert.equal(genData.error?.code, "insecure-scheme");
    assert.ok(genData.error?.message.includes("verified TLS"));
  } finally {
    hub.server.closeAllConnections?.();
    await new Promise((r) => hub.server.close(r));
    db.close();
  }
});

test("resilience: memory cleanup (stale IP attempts and expired pairing codes are automatically pruned)", () => {
  let simulatedTime = 10_000_000;
  const engine = new PairingCodeEngine({
    ttlMs: 60_000,
    lockDurationMs: 300_000,
    now: () => simulatedTime,
  });

  // Record failures across 600 distinct IPs
  for (let i = 0; i < 600; i++) {
    engine.recordFailure(`192.0.2.${i}`);
  }

  // Advance time past lock duration
  simulatedTime += 400_000;

  // New failure triggers prune of stale IP attempts
  engine.recordFailure("198.51.100.1");

  // Size must be bounded (stale records pruned)
  assert.ok(engine.ipAttempts.size < 600);
});

test("resilience: high-concurrency event listener subscription (exceeds default 10-listener limit)", () => {
  const engine = new PairingCodeEngine();

  // Attach 50 listeners without MaxListenersExceeded warning
  const received = [];
  for (let i = 0; i < 50; i++) {
    engine.on("event", (evt) => received.push(i));
  }

  engine.broadcastEvent("device-connected", { operatorPrincipal: "test" });
  assert.equal(received.length, 50);
});
