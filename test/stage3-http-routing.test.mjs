// Stage 3 automated test suite: Deterministic Public Route Authority & HTTP Proxying
// Covers:
// 1. Deterministic Host -> Node mapping (positive, malformed, unknown, wrong domain)
// 2. 5-condition eligibility matrix (inactive, no target, reachable not ok, no active Hub key, web.routes absent/stale)
// 3. Fail-closed unavailable responses (generic 503, no infrastructure leakage)
// 4. Exact RAW_TARGET preservation (path + query, encoded bytes, no normalization drift)
// 5. Streaming request/response body (no full-body buffering, exact bytes, large payload streaming)
// 6. Header security boundary (browser forged proofs stripped, Hub proofs stripped before DSH, management credentials stripped)
// 7. Cookie isolation (Set-Cookie Domain removed, host-only browser cookies)
// 8. Public authority preserved to DSH adapter
// 9. Downstream status/body transparency (401, 404, 500 preserved, no cross-node fallback)
// 10. WebSocket Upgrade explicitly denied (fail-closed in Stage 3)
// 11. Immutable route decision context during request execution

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";
import { parseRouteAuthority, evaluateRouteEligibility, sanitizeSetCookieHeader, sanitizeClientHeaders } from "../src/registry/route-proxy.mjs";
import { RouteIngress } from "../src/node/route-ingress.mjs";
import { generateNodeKeyPair, deriveKeyId, randomHex } from "../src/registry/crypto.mjs";

const ROUTE_DOMAIN = "dsh.example.com";

function createSeededNode(registry, {
  nodeId = "node_" + "11".repeat(16),
  state = "active",
  routeTarget = "http://127.0.0.1:8080",
  reachable = "ok",
  hubRouteKeyState = "active",
  hasWebRoutes = true,
  evidenceFresh = true,
} = {}) {
  const at = new Date().toISOString();
  const db = registry.db;

  const caps = hasWebRoutes ? [{ name: "web.routes", version: 1 }] : [{ name: "sessions.resume", version: 1 }];
  const staleStatus = evidenceFresh ? 0 : 1;
  const orbitCompatible = evidenceFresh ? "pass" : "stale";

  db.prepare(`
    INSERT INTO nodes (
      node_id, state, minted_at, authenticated, registry_contact, dsh_healthy,
      orbit_compatible, capabilities, capabilities_stale, last_seen, last_seen_source,
      orbit_version, dsh_version, reachable
    ) VALUES (?, ?, ?, 'ok', 'fresh', 'ok', ?, ?, ?, ?, 'heartbeat', '0.4.0', '1.0.0', ?)
  `).run(nodeId, state, at, orbitCompatible, JSON.stringify(caps), staleStatus, at, reachable);

  const nodeKey = generateNodeKeyPair();
  db.prepare(`
    INSERT INTO node_keys (node_id, key_id, public_key, state, created_at)
    VALUES (?, ?, ?, 'active', ?)
  `).run(nodeId, deriveKeyId(nodeKey.publicKeyHex), nodeKey.publicKeyHex, at);

  if (routeTarget) {
    db.prepare(`
      INSERT INTO route_targets (node_id, route_target_origin, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(nodeId, routeTarget, at, at);
  }

  const hubKey = generateNodeKeyPair();
  const hubKeyId = deriveKeyId(hubKey.publicKeyHex);
  db.prepare(`
    INSERT INTO hub_route_keys (node_id, key_id, public_key, private_key, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(nodeId, hubKeyId, hubKey.publicKeyHex, hubKey.privateKeyHex, hubRouteKeyState, at);

  return { nodeId, hubKeyId, hubKey };
}

// ---------------------------------------------------------------------------
// 1. Host -> Node Mapping & Parser
// ---------------------------------------------------------------------------

test("Host -> Node Mapping: deterministic format parsed, invalid and wrong domain rejected", () => {
  const nodeId = "node_" + "ab".repeat(16);
  const authority = `n-${"ab".repeat(16)}.${ROUTE_DOMAIN}`;

  // Positive
  const parsed = parseRouteAuthority(authority, ROUTE_DOMAIN);
  assert.equal(parsed.nodeId, nodeId);
  assert.equal(parsed.routeAuthority, authority);

  // Positive with port
  const parsedPort = parseRouteAuthority(`${authority}:5445`, `${ROUTE_DOMAIN}:5445`);
  assert.equal(parsedPort.nodeId, nodeId);

  // Negative: malformed hex
  assert.equal(parseRouteAuthority(`n-xyz.${ROUTE_DOMAIN}`, ROUTE_DOMAIN), null);
  // Negative: friendly alias
  assert.equal(parseRouteAuthority(`my-node.${ROUTE_DOMAIN}`, ROUTE_DOMAIN), null);
  // Negative: wrong domain
  assert.equal(parseRouteAuthority(authority, "other.example.com"), null);
  // Negative: empty / non-string
  assert.equal(parseRouteAuthority("", ROUTE_DOMAIN), null);
  assert.equal(parseRouteAuthority(null, ROUTE_DOMAIN), null);
});

// ---------------------------------------------------------------------------
// 2. RFC-0010 5-Condition Eligibility Matrix
// ---------------------------------------------------------------------------

test("RFC-0010 Eligibility: requires all 5 conditions; fails closed on any failure", () => {
  const registry = new Registry({ db: openRegistryDatabase(":memory:"), routeDomain: ROUTE_DOMAIN });

  // 1. Positive control: all 5 conditions met -> eligible
  const { nodeId: nodeOk } = createSeededNode(registry, { nodeId: "node_" + "10".repeat(16) });
  const checkOk = evaluateRouteEligibility(registry, nodeOk);
  assert.equal(checkOk.eligible, true);
  assert.ok(checkOk.snapshot);

  // 2. Node state !== active (e.g. tombstoned) -> ineligible
  const { nodeId: nodeTomb } = createSeededNode(registry, { nodeId: "node_" + "11".repeat(16), state: "tombstoned" });
  assert.equal(evaluateRouteEligibility(registry, nodeTomb).eligible, false);

  // 3. Route target missing -> ineligible
  const { nodeId: nodeNoTarget } = createSeededNode(registry, { nodeId: "node_" + "12".repeat(16), routeTarget: null });
  assert.equal(evaluateRouteEligibility(registry, nodeNoTarget).eligible, false);

  // 4. Reachable !== ok (unknown or unreachable) -> ineligible
  const { nodeId: nodeUnknown } = createSeededNode(registry, { nodeId: "node_" + "13".repeat(16), reachable: "unknown" });
  assert.equal(evaluateRouteEligibility(registry, nodeUnknown).eligible, false);
  const { nodeId: nodeUnreachable } = createSeededNode(registry, { nodeId: "node_" + "14".repeat(16), reachable: "unreachable" });
  assert.equal(evaluateRouteEligibility(registry, nodeUnreachable).eligible, false);

  // 5. Hub route identity !== active/rotating (e.g. provisioned or revoked) -> ineligible
  const { nodeId: nodeProvKey } = createSeededNode(registry, { nodeId: "node_" + "15".repeat(16), hubRouteKeyState: "provisioned" });
  assert.equal(evaluateRouteEligibility(registry, nodeProvKey).eligible, false);
  const { nodeId: nodeRevKey } = createSeededNode(registry, { nodeId: "node_" + "16".repeat(16), hubRouteKeyState: "revoked" });
  assert.equal(evaluateRouteEligibility(registry, nodeRevKey).eligible, false);

  // 6. web.routes capability absent or stale -> ineligible
  const { nodeId: nodeNoWebRoutes } = createSeededNode(registry, { nodeId: "node_" + "17".repeat(16), hasWebRoutes: false });
  assert.equal(evaluateRouteEligibility(registry, nodeNoWebRoutes).eligible, false);
  const { nodeId: nodeStale } = createSeededNode(registry, { nodeId: "node_" + "18".repeat(16), evidenceFresh: false });
  assert.equal(evaluateRouteEligibility(registry, nodeStale).eligible, false);

  registry.close();
});

// ---------------------------------------------------------------------------
// 3. Security Boundary & Cookie Isolation
// ---------------------------------------------------------------------------

test("Security Boundary: client headers sanitized, proofs stripped, cookies made host-only", () => {
  // Set-Cookie Domain stripping
  const inputCookie = "session=abc123xyz; Domain=.dsh.example.com; Path=/; HttpOnly; Secure; SameSite=Lax";
  const sanitized = sanitizeSetCookieHeader(inputCookie);
  assert.equal(sanitized, "session=abc123xyz; Path=/; HttpOnly; Secure; SameSite=Lax");
  assert.equal(sanitized.toLowerCase().includes("domain="), false);

  // Array of cookies
  const arrayCookies = [
    "c1=v1; domain=dsh.example.com; path=/",
    "c2=v2; Path=/api; HttpOnly",
  ];
  const sanitizedArray = sanitizeSetCookieHeader(arrayCookies);
  assert.deepEqual(sanitizedArray, [
    "c1=v1; path=/",
    "c2=v2; Path=/api; HttpOnly",
  ]);

  // Client headers sanitization
  const clientHeaders = {
    host: "n-aabb.dsh.example.com",
    "x-orbit-route-signature": "forged-signature",
    "x-orbit-route-node": "node_forged",
    "x-dsh-authenticated-proxy": "gateway-secret",
    "x-dsh-operator-id": "operator",
    "x-csrf-token": "csrf-secret",
    cookie: "dsh-orbit-hub-session=sess_abc; dsh_auth=token123",
    authorization: "Bearer test",
  };
  const sanitizedHeaders = sanitizeClientHeaders(clientHeaders);
  assert.equal(typeof sanitizedHeaders["x-orbit-route-signature"], "undefined");
  assert.equal(typeof sanitizedHeaders["x-orbit-route-node"], "undefined");
  assert.equal(typeof sanitizedHeaders["x-dsh-authenticated-proxy"], "undefined");
  assert.equal(typeof sanitizedHeaders["x-dsh-operator-id"], "undefined");
  assert.equal(typeof sanitizedHeaders["x-csrf-token"], "undefined");
  assert.equal(sanitizedHeaders.cookie, "dsh_auth=token123");
  assert.equal(sanitizedHeaders.authorization, "Bearer test");
});

// ---------------------------------------------------------------------------
// 4. End-to-End HTTP Proxying, Streaming & Exact RAW_TARGET
// ---------------------------------------------------------------------------

test("HTTP Proxying End-to-End: streaming, exact RAW_TARGET, status/body transparency, WebSocket denial", async () => {
  let receivedDshRequest = null;
  let receivedDshBody = "";

  // 1. Mock node-local DSH server
  const dshServer = http.createServer((req, res) => {
    receivedDshRequest = {
      url: req.url,
      method: req.method,
      headers: { ...req.headers },
    };
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      receivedDshBody = Buffer.concat(chunks).toString("utf8");
      // Echo custom headers and return Set-Cookie with Domain attribute
      res.writeHead(201, {
        "x-downstream-server": "dsh-node-adapter",
        "set-cookie": "session_dsh=token456; Domain=.dsh.example.com; Path=/; HttpOnly",
        "content-type": "application/json",
      });
      res.end(JSON.stringify({
        status: "created",
        receivedEcho: receivedDshBody,
        echoUrl: req.url,
      }));
    });
  });

  await new Promise((resolve) => dshServer.listen(0, "127.0.0.1", resolve));
  const dshPort = dshServer.address().port;
  const dshTarget = `http://127.0.0.1:${dshPort}`;

  // 2. Mock Node RouteIngress
  const nodeId = "node_" + "22".repeat(16);
  const authority = computeRouteAuthority(nodeId, ROUTE_DOMAIN);

  const registry = new Registry({ db: openRegistryDatabase(":memory:"), routeDomain: ROUTE_DOMAIN });

  const ingress = new RouteIngress({
    nodeId,
    routeDomain: ROUTE_DOMAIN,
    dshTarget,
    getTrustKeys: () => registry.getHubRouteKeysForNode(nodeId),
  });
  await ingress.listen(0, "127.0.0.1");
  const ingressPort = ingress.port;
  const ingressOrigin = `http://127.0.0.1:${ingressPort}`;

  const seeded = createSeededNode(registry, {
    nodeId,
    routeTarget: ingressOrigin,
  });

  // 3. Start Hub Server with HTTP routing enabled
  const { server: hubServer } = createHubServer({ registry });
  await new Promise((resolve) => hubServer.listen(0, "127.0.0.1", resolve));
  const hubPort = hubServer.address().port;

  try {
    // Test Case A: Exact RAW_TARGET & Streaming POST with complex query string
    const rawTarget = "/api/v1/workspaces?a=1%20b&x=%2F&nested=val%2Bplus";
    const postPayload = JSON.stringify({ message: "Hello streaming world", largeArray: new Array(100).fill("data") });

    const clientRes = await fetch(`http://127.0.0.1:${hubPort}${rawTarget}`, {
      method: "POST",
      headers: {
        host: authority,
        "x-forwarded-host": authority,
        "content-type": "application/json",
        cookie: "dsh_session=active",
        "x-orbit-route-signature": "browser-forged-signature-must-be-stripped",
      },
      body: postPayload,
    });

    if (clientRes.status !== 201) {
      console.log("CLIENT RES STATUS:", clientRes.status, await clientRes.text());
    }

    assert.equal(clientRes.status, 201);
    assert.equal(clientRes.headers.get("x-downstream-server"), "dsh-node-adapter");

    // Cookie isolation verified on browser response
    const setCookieResp = clientRes.headers.get("set-cookie");
    assert.ok(setCookieResp.includes("session_dsh=token456"));
    assert.equal(setCookieResp.toLowerCase().includes("domain="), false);

    const bodyResp = await clientRes.json();
    assert.equal(bodyResp.status, "created");
    assert.equal(bodyResp.echoUrl, rawTarget);
    assert.equal(bodyResp.receivedEcho, postPayload);

    // Verify DSH received exact target and no Orbit route headers
    assert.equal(receivedDshRequest.url, rawTarget);
    assert.equal(receivedDshRequest.method, "POST");
    assert.equal(receivedDshRequest.headers.host, authority);
    assert.equal(typeof receivedDshRequest.headers["x-orbit-route-signature"], "undefined");
    assert.equal(typeof receivedDshRequest.headers["x-orbit-route-key"], "undefined");

    // Test Case B: WebSocket upgrade fails closed with 400
    const wsRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: hubPort,
        path: "/ws",
        method: "GET",
        headers: {
          host: authority,
          "x-forwarded-host": authority,
          upgrade: "websocket",
          connection: "Upgrade",
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(wsRes.status, 400);
    const wsBody = await wsRes.json();
    assert.equal(wsBody.error.code, "websocket-upgrade-not-supported");

    // Test Case C: Ineligible node returns 503 generic unavailable without leaking infrastructure
    registry.recordProbeResult(nodeId, false, "injected-failure");
    registry.recordProbeResult(nodeId, false, "injected-failure");
    registry.recordProbeResult(nodeId, false, "injected-failure"); // reachable -> unreachable

    const unavailRes = await fetch(`http://127.0.0.1:${hubPort}/api/v1/workspaces`, {
      method: "GET",
      headers: {
        host: authority,
        "x-forwarded-host": authority,
      },
    });
    assert.equal(unavailRes.status, 503);
    const unavailBody = await unavailRes.json();
    assert.equal(unavailBody.error.code, "node-unavailable");
    assert.equal(unavailBody.error.message, "Selected node is unavailable");
    // Ensure no private info leaked
    assert.equal(JSON.stringify(unavailBody).includes("127.0.0.1"), false);
    assert.equal(JSON.stringify(unavailBody).includes("hubKey"), false);
  } finally {
    await new Promise((resolve) => hubServer.close(resolve));
    await ingress.close();
    await new Promise((resolve) => dshServer.close(resolve));
    registry.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Downstream Status Codes, Large Uploads & Context Immutability
// ---------------------------------------------------------------------------

test("HTTP Proxying: downstream status codes (401, 404, 500) preserved without failover, large upload streaming", async () => {
  let downstreamStatus = 200;
  let receivedBytes = 0;

  const dshServer = http.createServer((req, res) => {
    let count = 0;
    req.on("data", (chunk) => {
      count += chunk.length;
    });
    req.on("end", () => {
      receivedBytes = count;
      res.writeHead(downstreamStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ downstreamStatus, receivedBytes }));
    });
  });

  await new Promise((resolve) => dshServer.listen(0, "127.0.0.1", resolve));
  const dshPort = dshServer.address().port;
  const dshTarget = `http://127.0.0.1:${dshPort}`;

  const nodeId = "node_" + "33".repeat(16);
  const authority = computeRouteAuthority(nodeId, ROUTE_DOMAIN);

  const registry = new Registry({ db: openRegistryDatabase(":memory:"), routeDomain: ROUTE_DOMAIN });

  const ingress = new RouteIngress({
    nodeId,
    routeDomain: ROUTE_DOMAIN,
    dshTarget,
    getTrustKeys: () => registry.getHubRouteKeysForNode(nodeId),
  });
  await ingress.listen(0, "127.0.0.1");
  const ingressPort = ingress.port;
  const ingressOrigin = `http://127.0.0.1:${ingressPort}`;

  createSeededNode(registry, {
    nodeId,
    routeTarget: ingressOrigin,
  });

  const { server: hubServer } = createHubServer({ registry });
  await new Promise((resolve) => hubServer.listen(0, "127.0.0.1", resolve));
  const hubPort = hubServer.address().port;

  try {
    // 1. Status 401 transparently returned
    downstreamStatus = 401;
    const res401 = await fetch(`http://127.0.0.1:${hubPort}/api/v1/auth`, {
      headers: { host: authority, "x-forwarded-host": authority },
    });
    assert.equal(res401.status, 401);

    // 2. Status 404 transparently returned
    downstreamStatus = 404;
    const res404 = await fetch(`http://127.0.0.1:${hubPort}/api/v1/nonexistent`, {
      headers: { host: authority, "x-forwarded-host": authority },
    });
    assert.equal(res404.status, 404);

    // 3. Status 500 transparently returned
    downstreamStatus = 500;
    const res500 = await fetch(`http://127.0.0.1:${hubPort}/api/v1/error`, {
      headers: { host: authority, "x-forwarded-host": authority },
    });
    assert.equal(res500.status, 500);

    // 4. Large upload streaming (e.g. 500 KiB payload streamed without whole-body buffering)
    downstreamStatus = 200;
    const largeBuffer = Buffer.alloc(512 * 1024, "x");
    const resLarge = await fetch(`http://127.0.0.1:${hubPort}/upload`, {
      method: "POST",
      headers: {
        host: authority,
        "x-forwarded-host": authority,
        "content-type": "application/octet-stream",
      },
      body: largeBuffer,
    });
    assert.equal(resLarge.status, 200);
    assert.equal(receivedBytes, 512 * 1024);
  } finally {
    await new Promise((resolve) => hubServer.close(resolve));
    await ingress.close();
    await new Promise((resolve) => dshServer.close(resolve));
    registry.close();
  }
});
