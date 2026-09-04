import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { buildSelectorReadModel, mapEligibilityReason } from "../src/registry/selector-view.mjs";
import { validReport } from "./helpers/registry-fixture.mjs";
import { createCompatibilityReport } from "../src/compatibility-report.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";

const ROUTE_DOMAIN = "stage5-test.example";
const GATEWAY_SECRET = "test-gateway-secret";
const OPERATOR_ID = "test-operator";

function makeHttpRequest({ hostname = "127.0.0.1", port, path = "/", method = "GET", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname,
      port,
      path,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const rawBody = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: async () => rawBody.toString("utf8"),
          json: async () => JSON.parse(rawBody.toString("utf8")),
        });
      });
    });
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

test("Stage 5 Selector API & Read Model Security: privacy, allowlist, and server-authoritative eligibility", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-stage5-server-"));
  const dbPath = join(dir, "hub.db");

  let db = null;
  let registry = null;
  let server = null;

  try {
    db = openRegistryDatabase(dbPath);
    registry = new Registry({
      db,
      routeDomain: ROUTE_DOMAIN,
    });

    const hubInstance = createHubServer({
      registry,
      options: {
        gatewayAssertionSecret: GATEWAY_SECRET,
        operatorPrincipal: { mode: "single", principal: OPERATOR_ID },
        trustedExternalScheme: "https",
      },
    });
    server = hubInstance.server;

    const port = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    const nowIso = new Date().toISOString();
    const nodeA = "node_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const nodeB = "node_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // 1. Seed Node A: fully eligible (active, route target, reachable=ok, activeKey, fresh web.routes)
    db.prepare(`
      INSERT INTO nodes (
        node_id, state, minted_at, registry_contact, authenticated, dsh_healthy,
        orbit_compatible, reachable, alert_flags, last_heartbeat_at,
        capabilities, capabilities_stale, last_seen, last_seen_source,
        orbit_version, orbit_revision, dsh_version, compatibility_profile
      ) VALUES (
        ?, 'active', ?, 'fresh', 'ok', 'ok',
        'pass', 'ok', '[]', ?,
        ?, 0, ?, 'heartbeat',
        '0.4.0', 'abc123', '0.1.1-rc.2', 'dsh-0.1.1-rc.2'
      )
    `).run(
      nodeA,
      nowIso,
      nowIso,
      JSON.stringify([{ name: "web.routes", version: 1 }]),
      nowIso,
    );
    db.prepare("INSERT INTO node_keys (node_id, key_id, public_key, state, created_at) VALUES (?, 'ka', ?, 'active', ?)").run(nodeA, "a".repeat(64), nowIso);
    db.prepare("INSERT INTO hub_route_keys (node_id, key_id, public_key, private_key, state, created_at, activated_at) VALUES (?, 'hrka', ?, ?, 'active', ?, ?)").run(nodeA, "b".repeat(64), "c".repeat(96), nowIso, nowIso);
    db.prepare("INSERT INTO route_targets (node_id, route_target_origin, created_at, updated_at) VALUES (?, 'http://127.0.0.1:4001', ?, ?)").run(nodeA, nowIso, nowIso);

    // 2. Seed Node B: ineligible due to reachable = unreachable
    db.prepare(`
      INSERT INTO nodes (
        node_id, state, minted_at, registry_contact, authenticated, dsh_healthy,
        orbit_compatible, reachable, alert_flags, last_heartbeat_at,
        capabilities, capabilities_stale, last_seen, last_seen_source,
        orbit_version, orbit_revision, dsh_version, compatibility_profile
      ) VALUES (
        ?, 'active', ?, 'fresh', 'ok', 'ok',
        'pass', 'unreachable', '[]', ?,
        ?, 0, ?, 'heartbeat',
        '0.4.0', 'abc123', '0.1.1-rc.2', 'dsh-0.1.1-rc.2'
      )
    `).run(
      nodeB,
      nowIso,
      nowIso,
      JSON.stringify([{ name: "web.routes", version: 1 }]),
      nowIso,
    );
    db.prepare("INSERT INTO node_keys (node_id, key_id, public_key, state, created_at) VALUES (?, 'kb', ?, 'active', ?)").run(nodeB, "d".repeat(64), nowIso);
    db.prepare("INSERT INTO hub_route_keys (node_id, key_id, public_key, private_key, state, created_at, activated_at) VALUES (?, 'hrkb', ?, ?, 'active', ?, ?)").run(nodeB, "e".repeat(64), "f".repeat(96), nowIso, nowIso);
    db.prepare("INSERT INTO route_targets (node_id, route_target_origin, created_at, updated_at) VALUES (?, 'http://127.0.0.1:4002', ?, ?)").run(nodeB, nowIso, nowIso);

    // Test 1: Selector Read Model unit inspection
    const model = buildSelectorReadModel(registry, { routeDomain: ROUTE_DOMAIN, trustedScheme: "https" });
    assert.equal(model.nodes.length, 2);

    const rowA = model.nodes.find((n) => n.nodeId === nodeA);
    assert.equal(rowA.route.eligible, true);
    assert.equal(rowA.route.reasonCode, null);
    assert.equal(rowA.route.openUrl, `https://${computeRouteAuthority(nodeA, ROUTE_DOMAIN)}/`);

    const rowB = model.nodes.find((n) => n.nodeId === nodeB);
    assert.equal(rowB.route.eligible, false);
    assert.equal(rowB.route.reasonCode, "route-unreachable");
    assert.equal(rowB.route.openUrl, null);

    // Test 2: Privacy assertions - Read model NEVER contains private/internal properties
    const modelJson = JSON.stringify(model);
    assert.equal(modelJson.includes("4001"), false, "Must not leak Node A internal port");
    assert.equal(modelJson.includes("4002"), false, "Must not leak Node B internal port");
    assert.equal(modelJson.includes("routeTargetOrigin"), false, "Must not leak routeTargetOrigin");
    assert.equal(modelJson.includes("private_key"), false, "Must not leak private_key");
    assert.equal(modelJson.includes("hrka"), false, "Must not leak Hub route keyId");
    assert.equal(modelJson.includes("hrkb"), false, "Must not leak Hub route keyId");

    // Test 3: Static Selector UI Assets on Selector Authority (Host: stage5-test.example)
    const assetHeaders = {
      host: ROUTE_DOMAIN,
    };
    const htmlRes = await makeHttpRequest({ port, path: "/", headers: assetHeaders });
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers["content-type"], "text/html; charset=utf-8");
    const htmlBody = await htmlRes.text();
    assert.ok(htmlBody.includes("DSH Orbit Endpoint Selector"));

    const jsRes = await makeHttpRequest({ port, path: "/app.mjs", headers: assetHeaders });
    assert.equal(jsRes.status, 200);
    assert.ok(jsRes.headers["content-type"].includes("javascript"));

    const cssRes = await makeHttpRequest({ port, path: "/styles.css", headers: assetHeaders });
    assert.equal(cssRes.status, 200);
    assert.ok(cssRes.headers["content-type"].includes("css"));

    // Test 4: Management UI assets are NOT served on selector authority
    // /view-model.mjs is served from ui/selector/view-model.mjs on selector authority
    const selectorVmRes = await makeHttpRequest({ port, path: "/view-model.mjs", headers: assetHeaders });
    assert.equal(selectorVmRes.status, 200);

    // Test 5: Session bootstrap on Selector Authority requires gateway admission
    const noAuthSessRes = await makeHttpRequest({
      port,
      path: "/hub/session",
      method: "POST",
      headers: { host: ROUTE_DOMAIN },
    });
    assert.equal(noAuthSessRes.status, 401, "Missing gateway auth must fail session bootstrap");

    // Test 6: Authenticated Session Bootstrap on Selector Authority
    const gwHeaders = {
      host: ROUTE_DOMAIN,
      origin: `https://${ROUTE_DOMAIN}`,
      "sec-fetch-site": "same-origin",
      "x-dsh-authenticated-proxy": GATEWAY_SECRET,
      "x-dsh-operator-id": OPERATOR_ID,
    };
    const authSessRes = await makeHttpRequest({
      port,
      path: "/hub/session",
      method: "POST",
      headers: gwHeaders,
    });
    assert.equal(authSessRes.status, 200);
    const sessionCookie = authSessRes.headers["set-cookie"]?.[0]?.match(/dsh-orbit-hub-session=([^;]+)/)?.[1]
      || (typeof authSessRes.headers["set-cookie"] === "string" ? authSessRes.headers["set-cookie"].match(/dsh-orbit-hub-session=([^;]+)/)?.[1] : null);
    assert.ok(sessionCookie, "Must set session cookie");

    // Test 7: GET /hub/selector/nodes on Selector Authority with valid session
    const apiHeaders = {
      host: ROUTE_DOMAIN,
      cookie: `dsh-orbit-hub-session=${sessionCookie}`,
      "sec-fetch-site": "same-origin",
      "x-dsh-authenticated-proxy": GATEWAY_SECRET,
      "x-dsh-operator-id": OPERATOR_ID,
    };
    const nodesRes = await makeHttpRequest({ port, path: "/hub/selector/nodes", headers: apiHeaders });
    assert.equal(nodesRes.status, 200);
    const nodesData = await nodesRes.json();
    assert.equal(nodesData.nodes.length, 2);
    const nA = nodesData.nodes.find((n) => n.nodeId === nodeA);
    const nB = nodesData.nodes.find((n) => n.nodeId === nodeB);
    assert.equal(nA.route.eligible, true);
    assert.equal(nA.route.openUrl, `https://${computeRouteAuthority(nodeA, ROUTE_DOMAIN)}/`);
    assert.equal(nB.route.eligible, false);
    assert.equal(nB.route.reasonCode, "route-unreachable");

    // Test 8: Strict Allowlist - Forbidden management routes on Selector Authority MUST return 404
    const forbiddenPaths = [
      ["GET", "/hub/nodes"],
      ["GET", "/hub/tokens"],
      ["POST", "/hub/tokens"],
      ["GET", `/hub/nodes/${nodeA}`],
      ["GET", `/hub/nodes/${nodeA}/route-target`],
      ["PUT", `/hub/nodes/${nodeA}/route-target`],
      ["POST", `/hub/nodes/${nodeA}/delete`],
      ["POST", `/hub/nodes/${nodeA}/reenroll`],
      ["POST", "/api/v1/heartbeat"],
      ["POST", "/api/v1/enroll"],
    ];

    for (const [method, path] of forbiddenPaths) {
      const res = await makeHttpRequest({
        port,
        path,
        method,
        headers: apiHeaders,
      });
      assert.equal(
        res.status,
        404,
        `Expected 404 for forbidden path on selector authority: ${method} ${path}, got ${res.status}`,
      );
    }

    // Test 9: Node Unavailable HTML Surface on Accept: text/html
    const nodeAuthorityB = computeRouteAuthority(nodeB, ROUTE_DOMAIN);
    const unavailHtmlRes = await makeHttpRequest({
      port,
      path: "/some-path",
      headers: {
        host: nodeAuthorityB,
        accept: "text/html,application/xhtml+xml",
      },
    });
    assert.equal(unavailHtmlRes.status, 503);
    assert.equal(unavailHtmlRes.headers["content-type"], "text/html; charset=utf-8");
    const unavailHtml = await unavailHtmlRes.text();
    assert.ok(unavailHtml.includes("Selected Endpoint Unavailable"));
    assert.ok(unavailHtml.includes("Route ingress or downstream DSH is unreachable"));
    assert.ok(unavailHtml.includes(`href="https://${ROUTE_DOMAIN}/"`));
    assert.equal(unavailHtml.includes("4002"), false, "Must not leak internal port in HTML 503");

    // Test 10: Node Unavailable JSON Surface on Accept: application/json
    const unavailJsonRes = await makeHttpRequest({
      port,
      path: "/some-path",
      headers: {
        host: nodeAuthorityB,
        accept: "application/json",
      },
    });
    assert.equal(unavailJsonRes.status, 503);
    assert.equal(unavailJsonRes.headers["content-type"], "application/json");
    const unavailJson = await unavailJsonRes.json();
    assert.equal(unavailJson.error.code, "node-unavailable");
    assert.equal(unavailJson.error.selectorUrl, `https://${ROUTE_DOMAIN}/`);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    if (db) db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
