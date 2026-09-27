// RFC-0016 Stage 2: QR Pairing Protocol, Ephemeral Secret & Hub Endpoints Tests
// Verifies:
// 1. PairingCodeEngine: 6-digit cryptographically random code generation with <= 300s TTL
// 2. Hub POST /hub/pairing/generate-code endpoint (auth & CSRF protected)
// 3. Hub POST /hub/pairing/verify endpoint (single-use anti-replay destruction & session bootstrap)
// 4. Hub GET /hub/pairing/status endpoint
// 5. Hub GET /hub/pairing/events SSE event stream with live notification
// 6. Audit logging of pairing operations

import assert from "node:assert/strict";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { PairingCodeEngine, DEFAULT_PAIRING_TTL_MS } from "../src/registry/pairing-code.mjs";

test("pairing code engine: generates 6-digit random codes with 300s TTL and single-use destruction", () => {
  let simulatedTime = 1_000_000;
  const engine = new PairingCodeEngine({
    ttlMs: 300_000,
    now: () => simulatedTime,
  });

  const record = engine.generateCode({
    operatorPrincipal: "admin@example.com",
    hubBaseUrl: "https://hub.orbit.test:8443",
  });

  assert.match(record.code, /^\d{6}$/);
  assert.ok(record.pairingToken);
  assert.equal(record.expiresAt, new Date(1_300_000).toISOString());
  assert.equal(record.url, `https://hub.orbit.test:8443/auth?token=${record.code}`);

  // Verification succeeds on first attempt
  const verify1 = engine.verifyCode(record.code);
  assert.equal(verify1.valid, true);
  assert.equal(verify1.operatorPrincipal, "admin@example.com");

  // Replay attempt fails immediately (anti-replay single-use destruction)
  const verify2 = engine.verifyCode(record.code);
  assert.equal(verify2.valid, false);
  assert.equal(verify2.code, "code-not-found");
});

test("pairing code engine: rejects expired code and enforces IP brute-force lockout", () => {
  let simulatedTime = 1_000_000;
  const engine = new PairingCodeEngine({
    ttlMs: 300_000,
    maxFailedAttempts: 3,
    lockDurationMs: 60_000,
    now: () => simulatedTime,
  });

  const record = engine.generateCode({
    operatorPrincipal: "operator",
    hubBaseUrl: "https://hub.orbit.test",
  });

  // Advance time past TTL
  simulatedTime = 1_300_001;
  const expired = engine.verifyCode(record.code, "192.0.2.1");
  assert.equal(expired.valid, false);
  assert.equal(expired.code, "code-expired");

  // Fail 2 more times to trigger IP lockout
  engine.verifyCode("000000", "192.0.2.1");
  engine.verifyCode("111111", "192.0.2.1");

  // Fourth attempt is blocked with rate-limited
  const locked = engine.verifyCode("222222", "192.0.2.1");
  assert.equal(locked.valid, false);
  assert.equal(locked.code, "rate-limited");
});

test("hub pairing endpoints: full lifecycle (generate -> status -> verify -> audit & SSE event)", async () => {
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
  await new Promise((r) => hub.server.listen(0, "127.0.0.1", r));
  const port = hub.server.address().port;
  const host = `127.0.0.1:${port}`;

  const gatewayHeaders = {
    "x-dsh-authenticated-proxy": "mock-gate",
    "x-dsh-operator-id": "admin",
  };

  try {
    // 1. Bootstrap operator session
    const sessionRes = await fetch(`http://${host}/hub/session`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: `https://${host}`,
        ...gatewayHeaders,
      },
    });
    assert.equal(sessionRes.status, 200);
    const sessionCookie = sessionRes.headers.get("set-cookie").split(";")[0];
    const sessionData = await sessionRes.json();
    const csrfToken = sessionData.csrfToken;

    // 2. Generate pairing code (POST /hub/pairing/generate-code)
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
    assert.equal(genRes.status, 201);
    const genData = await genRes.json();
    assert.ok(genData.ok);
    assert.match(genData.code, /^\d{6}$/);
    assert.ok(genData.expiresAt);
    assert.equal(genData.url, `https://${host}/auth?token=${genData.code}`);

    // 3. Query status (GET /hub/pairing/status)
    const statusRes = await fetch(`http://${host}/hub/pairing/status`, {
      headers: {
        Host: host,
        Origin: `https://${host}`,
        Cookie: sessionCookie,
        ...gatewayHeaders,
      },
    });
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.activeCodes, 1);
    assert.equal(statusData.hubBaseUrl, `https://${host}`);

    // 4. Verify SSE stream subscription
    const sseRes = await fetch(`http://${host}/hub/pairing/events`, {
      headers: {
        Host: host,
        Origin: `https://${host}`,
        Cookie: sessionCookie,
        ...gatewayHeaders,
      },
    });
    assert.equal(sseRes.status, 200);
    assert.equal(sseRes.headers.get("content-type"), "text/event-stream");

    const reader = sseRes.body.getReader();
    const firstChunk = await reader.read();
    const firstText = new TextDecoder().decode(firstChunk.value);
    assert.ok(firstText.includes(": connected"));

    // 5. Verify pairing code from mobile/browser client (POST /hub/pairing/verify)
    const verifyRes = await fetch(`http://${host}/hub/pairing/verify`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: `https://${host}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: genData.code }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyData = await verifyRes.json();
    assert.ok(verifyData.ok);
    assert.equal(verifyData.principal, "admin");
    assert.ok(verifyData.csrfToken);
    const newSessionCookie = verifyRes.headers.get("set-cookie");
    assert.ok(newSessionCookie.includes("dsh-orbit-hub-session="));

    // 6. Read SSE event triggered by verification
    const sseEventChunk = await reader.read();
    const sseText = new TextDecoder().decode(sseEventChunk.value);
    assert.ok(sseText.includes("device-connected"));
    reader.cancel();

    // 7. Verify audit logging
    const auditRes = await fetch(`http://${host}/hub/audit`, {
      headers: {
        Host: host,
        Origin: `https://${host}`,
        Cookie: sessionCookie,
        ...gatewayHeaders,
      },
    });
    assert.equal(auditRes.status, 200);
    const auditData = await auditRes.json();
    const actions = auditData.audit.map((a) => a.action);
    assert.ok(actions.includes("pairing.code.generate"));
    assert.ok(actions.includes("pairing.verify.success"));

    // 8. Replay of consumed code fails with 401
    const replayRes = await fetch(`http://${host}/hub/pairing/verify`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: `https://${host}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: genData.code }),
    });
    assert.equal(replayRes.status, 401);
  } finally {
    hub.server.closeAllConnections?.();
    await new Promise((r) => hub.server.close(r));
    db.close();
  }
});
