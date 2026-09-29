import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { buildSelectorReadModel, buildSelectorNodeRow, renderUnavailableHtml } from "../src/registry/selector-view.mjs";
import { MultiNodeFlowTracker } from "../src/registry/flow-tracker.mjs";

// RFC-0018 Stage 1: mechanical coverage for the D3 selector read-model
// enrichment (route.activeFlows) and the D4 failure-surface regression pins
// (matrix A2 and A13). The apex allowlist itself is untouched — the
// enrichment rides the already-allowed GET /hub/selector/nodes tuple.

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

const ROUTE_DOMAIN = "dsh.ikarikore.top";
const NODE_HEX = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

function createRouteHub() {
  const db = openRegistryDatabase(":memory:");
  const registry = new Registry({ db, routeDomain: ROUTE_DOMAIN });
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

function enrollNode(registry) {
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const result = registry.enroll({
    token: minted.token,
    enrollmentRequestId: "ab".repeat(16),
    publicKey: "01".repeat(32),
  });
  assert.match(result.nodeId, /^node_[0-9a-f]{32}$/);
  return result.nodeId;
}

test("A2: the selector read model carries integer route.activeFlows consistent with the flow tracker", async () => {
  const { registry, hub } = createRouteHub();
  const port = await listen(hub);
  try {
    const nodeId = enrollNode(registry);

    // The hub's own tracker counts real proxy flows; the read model must
    // agree with it through the same reference the server holds.
    assert.equal(hub.flowTracker.getActiveFlowCount(nodeId), 0);

    const session = await rawRequest({ port, method: "POST", path: "/hub/session", headers: { ...GATEWAY_HEADERS }, body: {} });
    const cookie = session.headers["set-cookie"][0].split(";")[0];
    const headers = { ...GATEWAY_HEADERS, cookie };

    const before = JSON.parse((await rawRequest({ port, path: "/hub/selector/nodes", headers })).body);
    assert.equal(before.nodes.length, 1);
    assert.equal(before.nodes[0].nodeId, nodeId);
    assert.equal(before.nodes[0].route.activeFlows, 0);

    // Track two flows exactly as the node-route proxy branch would.
    const endFlow1 = hub.flowTracker.trackFlow(nodeId);
    const endFlow2 = hub.flowTracker.trackFlow(nodeId);
    assert.equal(hub.flowTracker.getActiveFlowCount(nodeId), 2);

    const during = JSON.parse((await rawRequest({ port, path: "/hub/selector/nodes", headers })).body);
    assert.equal(during.nodes[0].route.activeFlows, 2);
    assert.equal(during.nodes[0].route.activeFlows, hub.flowTracker.getActiveFlowCount(nodeId));

    // Ending a flow returns the count to the tracker's value (M4's
    // mechanical backbone; the live assertion is mounted).
    endFlow1();
    const afterOne = JSON.parse((await rawRequest({ port, path: "/hub/selector/nodes", headers })).body);
    assert.equal(afterOne.nodes[0].route.activeFlows, 1);
    endFlow2();
    const afterBoth = JSON.parse((await rawRequest({ port, path: "/hub/selector/nodes", headers })).body);
    assert.equal(afterBoth.nodes[0].route.activeFlows, 0);

    // Flows on OTHER nodes never bleed into this row.
    const otherNodeId = `node_${"f".repeat(32)}`;
    const endOther = hub.flowTracker.trackFlow(otherNodeId);
    const isolated = JSON.parse((await rawRequest({ port, path: "/hub/selector/nodes", headers })).body);
    assert.equal(isolated.nodes[0].route.activeFlows, 0);
    endOther();
  } finally {
    await closeHub(hub);
  }
});

test("A2: the enriched row keeps the exact v0.10 sanitized shape — nothing but the integer count moves", async () => {
  const { registry } = createRouteHub();
  const nodeId = enrollNode(registry);

  const readModel = buildSelectorReadModel(registry, {
    routeDomain: ROUTE_DOMAIN,
    trustedScheme: "https",
    flowTracker: new MultiNodeFlowTracker(),
  });
  assert.equal(readModel.nodes.length, 1);
  const row = readModel.nodes[0];
  assert.equal(row.nodeId, nodeId);

  // Exact key sets: the route object gains exactly one field (activeFlows).
  assert.deepEqual(
    Object.keys(row).sort(),
    ["health", "nodeId", "route", "runtimeIdentity", "state"],
  );
  assert.deepEqual(Object.keys(row.route).sort(), [
    "activeFlows",
    "eligible",
    "openUrl",
    "reason",
    "reasonCode",
    "reversePresence",
    "routeMode",
  ]);
  assert.deepEqual(Object.keys(row.health).sort(), [
    "capabilities",
    "capabilitiesStale",
    "lastSeen",
    "lastSeenSource",
    "orbitCompatible",
    "reachable",
    "registryContact",
  ]);
  assert.equal(Number.isInteger(row.route.activeFlows), true);
  assert.equal(row.route.activeFlows >= 0, true);

  // Sanitization: no credential, internal target, or raw report material
  // anywhere in the serialized model.
  const serialized = JSON.stringify(readModel);
  for (const forbidden of ["csrf", "csrfToken", "privateKey", "private_key", "signature", "routeTarget", "route_target", "latestReport", "reports", "secret", "token"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, `selector model must not contain ${forbidden}`);
  }

  // Without a tracker the field is still a well-formed non-negative integer.
  const noTracker = buildSelectorNodeRow(registry, registry.getNodeRow(nodeId), { routeDomain: ROUTE_DOMAIN, trustedScheme: "https" });
  assert.equal(Number.isInteger(noTracker.route.activeFlows), true);
  assert.equal(noTracker.route.activeFlows >= 0, true);
});

test("A13: the failure surface stays target-preserving — authority + selector return link, 503 node-unavailable with selectorUrl", async () => {
  const { registry, hub } = createRouteHub();
  const port = await listen(hub);
  const nodeHost = `n-${NODE_HEX}.${ROUTE_DOMAIN}`;
  try {
    // A node that is enrolled but NOT route-eligible (no route target, no
    // probe evidence) fails route policy; an HTML-negotiating browser gets
    // the unavailable page carrying the FAILED route authority and a
    // selector return link — never another node's surface.
    enrollNode(registry);
    const html = await rawRequest({ port, path: "/", host: nodeHost, headers: { accept: "text/html,application/xhtml+xml" } });
    assert.equal(html.status, 503);
    assert.match(html.headers["content-type"], /text\/html/);
    assert.match(html.body, /Selected Endpoint Unavailable/);
    assert.match(html.body, new RegExp(nodeHost.replace(/\./g, "\\.")));
    assert.match(html.body, /Return to Endpoint Selector/);

    // The JSON contract keeps the code + selectorUrl (RFC-0011 D5 shape).
    const json = await rawRequest({ port, path: "/", host: nodeHost, headers: { accept: "application/json" } });
    assert.equal(json.status, 503);
    const parsed = JSON.parse(json.body);
    assert.equal(parsed.error.code, "node-unavailable");
    assert.equal(typeof parsed.error.selectorUrl, "string");
    assert.match(parsed.error.selectorUrl, /^https:\/\//);

    // renderUnavailableHtml regression: the rendered authority and return
    // link are byte-honest for the failing route only.
    const rendered = renderUnavailableHtml({
      reasonMessage: "Route reachability is not verified yet",
      routeAuthority: nodeHost,
      selectorUrl: "https://selector.example/",
    });
    assert.match(rendered, /Route reachability is not verified yet/);
    assert.match(rendered, new RegExp(nodeHost.replace(/\./g, "\\.")));
    assert.match(rendered, /href="https:\/\/selector\.example\/"/);
  } finally {
    await closeHub(hub);
  }
});
