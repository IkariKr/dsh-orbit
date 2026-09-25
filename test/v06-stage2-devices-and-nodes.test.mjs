import assert from "node:assert/strict";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { createRegistryUi } from "../ui/app.mjs";
import { mapNodeRow, mapNodeList, mapOverview } from "../ui/view-model.mjs";

const NODE_A = "node_0123456789abcdef0123456789abcdef";
const NODE_B = "node_fedcba9876543210fedcba9876543210";

class FakeElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.dataset = {};
    this.listeners = {};
    this.opened = false;
    this.style = {};
    this.classList = {
      names: new Set(),
      add: (name) => this.classList.names.add(name),
      remove: (name) => this.classList.names.delete(name),
    };
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  showModal() {
    this.opened = true;
  }
  close() {
    this.opened = false;
  }
  closest() {
    return null;
  }
}

function createFakeDocument() {
  const ids = [
    "session-status",
    "nav-nodes",
    "nav-tokens",
    "nav-logout",
    "state-banner",
    "nodes-list",
    "reenroll-result",
    "node-detail-view",
    "tokens-view",
    "nodes-view",
    "mint-token",
    "mint-result",
    "mint-pair-token",
    "pair-mint-result",
    "token-table-body",
    "confirm-dialog",
    "confirm-dialog-message",
    "confirm-reason",
    "confirm-cancel",
    "confirm-ok",
    "route-target-input",
    "route-target-error",
    "route-mode-input",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  return {
    getElementById: (id) => elements.get(id) ?? null,
  };
}

function enrollNode(registry, { nodeId, publicKeyHex, endpoint = "https://127.0.0.1:3080", routeMode = "direct" }) {
  const at = new Date().toISOString();
  registry.db.prepare(`
    INSERT INTO nodes (
      node_id, state, minted_at, authenticated, registry_contact, dsh_healthy,
      orbit_compatible, capabilities, capabilities_stale, last_seen, last_seen_source,
      orbit_version, dsh_version, reachable, route_mode
    ) VALUES (?, 'active', ?, 'ok', 'fresh', 'ok', 'pass', '[]', 0, ?, 'heartbeat', '0.6.0', '1.0.0', 'ok', ?)
  `).run(nodeId, at, at, routeMode);

  registry.db.prepare(`
    INSERT INTO node_keys (node_id, key_id, public_key, state, created_at)
    VALUES (?, ?, ?, 'active', ?)
  `).run(nodeId, publicKeyHex.slice(0, 32), publicKeyHex, at);
}

test("view-model: mapNodeRow maps activeFlows and targetScope", () => {
  const sample = {
    nodeId: NODE_A,
    state: "active",
    routeMode: "direct",
    activeFlows: 3,
    health: { reachable: "ok" },
  };

  const row = mapNodeRow(sample);
  assert.equal(row.nodeId, NODE_A);
  assert.equal(row.activeFlows, 3);
  assert.deepEqual(row.targetScope, {
    targetNodeId: NODE_A,
    label: `target: ${NODE_A.slice(0, 13)}…`,
  });

  // Default activeFlows is 0 when absent
  const defaultRow = mapNodeRow({ nodeId: NODE_B });
  assert.equal(defaultRow.activeFlows, 0);
});

test("view-model: mapNodeList and mapOverview map activeSessions summary", () => {
  const nodes = [{ nodeId: NODE_A, activeFlows: 2 }, { nodeId: NODE_B, activeFlows: 1 }];
  const activeSessions = { totalFlows: 3, distinctNodes: 2 };

  const list = mapNodeList(nodes, activeSessions);
  assert.equal(list.kind, "nodes");
  assert.equal(list.rows.length, 2);
  assert.deepEqual(list.activeSessions, { totalFlows: 3, distinctNodes: 2 });

  const overview = mapOverview({ nodes, activeSessions });
  assert.equal(overview.kind, "overview");
  assert.equal(overview.nodes.length, 2);
  assert.deepEqual(overview.activeSessions, { totalFlows: 3, distinctNodes: 2 });
});

test("app-level: renderNodes displays Devices & Nodes summary, target scope tag, activeFlows, and scoped action buttons", async () => {
  const doc = createFakeDocument();
  let fakeFetch = async (url, options = {}) => {
    if (url === "/hub/session") {
      return { ok: true, status: 200, json: async () => ({ principal: "admin@test", csrfToken: "csrf123" }) };
    }
    if (url === "/hub/nodes") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          nodes: [
            {
              nodeId: NODE_A,
              state: "active",
              routeMode: "direct",
              activeFlows: 2,
              health: { reachable: "ok", capabilities: [], alertFlags: [] },
              runtimeIdentity: { dshVersion: "0.1.1-rc.2", orbitRevision: "revA" },
            },
            {
              nodeId: NODE_B,
              state: "active",
              routeMode: "reverse",
              activeFlows: 1,
              reversePresence: "online",
              reverseRouteReady: true,
              health: { reachable: "ok", capabilities: [], alertFlags: [] },
              runtimeIdentity: { dshVersion: "0.1.1-rc.2", orbitRevision: "revB" },
            },
          ],
          activeSessions: { totalFlows: 3, distinctNodes: 2 },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const ui = createRegistryUi({ document: doc, fetchImpl: fakeFetch });
  await ui.start();

  const nodesListHtml = doc.getElementById("nodes-list").innerHTML;

  // 1. Overview summary banner rendered
  assert.match(nodesListHtml, /Devices &amp; Nodes:/);
  assert.match(nodesListHtml, /2 enrolled/);
  assert.match(nodesListHtml, /Active Sessions:.*3 flows across 2 active nodes/);

  // 2. Explicit target scope chips rendered
  assert.match(nodesListHtml, new RegExp(`target-scope-chip.*target: ${NODE_A.slice(0, 13)}`));
  assert.match(nodesListHtml, new RegExp(`target-scope-chip.*target: ${NODE_B.slice(0, 13)}`));

  // 3. activeFlows rendered in route-observability metadata
  assert.match(nodesListHtml, /activeFlows 2/);
  assert.match(nodesListHtml, /activeFlows 1/);

  // 4. Scoped action buttons rendered
  assert.match(nodesListHtml, new RegExp(`data-scoped-open-id="${NODE_A}"`));
  assert.match(nodesListHtml, new RegExp(`data-scoped-refresh-id="${NODE_A}"`));
  assert.match(nodesListHtml, new RegExp(`data-scoped-open-id="${NODE_B}"`));
  assert.match(nodesListHtml, new RegExp(`data-scoped-refresh-id="${NODE_B}"`));
});

test("app-level: scoped open and refresh actions dispatch to /hub/actions/node and update view without full reload", async () => {
  const doc = createFakeDocument();
  const actionDispatches = [];

  let fakeFetch = async (url, options = {}) => {
    if (url === "/hub/session") {
      return { ok: true, status: 200, json: async () => ({ principal: "admin@test", csrfToken: "csrf123" }) };
    }
    if (url === "/hub/nodes") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          nodes: [
            {
              nodeId: NODE_A,
              state: "active",
              routeMode: "direct",
              activeFlows: 0,
              health: { reachable: "ok", capabilities: [], alertFlags: [] },
              runtimeIdentity: { dshVersion: "0.1.1-rc.2" },
            },
          ],
          activeSessions: { totalFlows: 0, distinctNodes: 0 },
        }),
      };
    }
    if (url === "/hub/actions/node") {
      const payload = JSON.parse(options.body);
      actionDispatches.push({ payload, headers: options.headers });
      if (payload.action === "open") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            targetNodeId: payload.targetNodeId,
            routeAuthority: `n-${payload.targetNodeId.slice(5)}.dsh.example.com`,
            url: `https://n-${payload.targetNodeId.slice(5)}.dsh.example.com/`,
          }),
        };
      }
      if (payload.action === "refresh") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            targetNodeId: payload.targetNodeId,
            node: { nodeId: payload.targetNodeId, activeFlows: 0 },
          }),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const ui = createRegistryUi({ document: doc, fetchImpl: fakeFetch });
  await ui.start();

  const clickHandler = doc.getElementById("nodes-list").listeners["click"];
  assert.ok(typeof clickHandler === "function");

  // 1. Simulate click on "open" scoped button
  await clickHandler({
    target: { dataset: { scopedOpenId: NODE_A } },
  });

  assert.equal(actionDispatches.length, 1);
  assert.deepEqual(actionDispatches[0].payload, {
    targetNodeId: NODE_A,
    action: "open",
  });
  assert.equal(actionDispatches[0].headers["x-csrf-token"], "csrf123");

  // 2. Simulate click on "refresh" scoped button
  await clickHandler({
    target: { dataset: { scopedRefreshId: NODE_A } },
  });

  assert.equal(actionDispatches.length, 2);
  assert.deepEqual(actionDispatches[1].payload, {
    targetNodeId: NODE_A,
    action: "refresh",
  });
});

test("Hub Server integration: real-time multi-node read model and /hub/overview live query", async () => {
  const registry = new Registry({ db: openRegistryDatabase(":memory:"), routeDomain: "dsh.example.com" });
  enrollNode(registry, { nodeId: NODE_A, publicKeyHex: "aa".repeat(32), routeMode: "direct" });
  enrollNode(registry, { nodeId: NODE_B, publicKeyHex: "bb".repeat(32), routeMode: "reverse" });

  const hub = createHubServer({
    registry,
    options: {
      operatorPrincipal: { mode: "single", principal: "admin@test" },
      lanBoundaryOnly: true,
    },
  });
  const server = hub.server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Authenticate management session
    const sessionRes = await fetch(`${baseUrl}/hub/session`, {
      method: "POST",
      headers: { host: "127.0.0.1" },
    });
    assert.equal(sessionRes.status, 200);
    const cookie = sessionRes.headers.get("set-cookie")?.split(";")[0] ?? "";

    // 2. Simulate active flows on Node A (2 flows) and Node B (1 flow)
    const endA1 = hub.flowTracker.trackFlow(NODE_A);
    const endA2 = hub.flowTracker.trackFlow(NODE_A);
    const endB1 = hub.flowTracker.trackFlow(NODE_B);

    // 3. GET /hub/overview returns real-time multi-node active session counts
    const overviewRes = await fetch(`${baseUrl}/hub/overview`, {
      headers: { cookie, host: "127.0.0.1" },
    });
    assert.equal(overviewRes.status, 200);
    const overviewData = await overviewRes.json();
    assert.equal(overviewData.nodes.length, 2);
    assert.equal(overviewData.activeSessions.totalFlows, 3);
    assert.equal(overviewData.activeSessions.distinctNodes, 2);

    const nodeAOverview = overviewData.nodes.find((n) => n.nodeId === NODE_A);
    const nodeBOverview = overviewData.nodes.find((n) => n.nodeId === NODE_B);
    assert.equal(nodeAOverview.activeFlows, 2);
    assert.equal(nodeBOverview.activeFlows, 1);

    // 4. Verify GET /hub/nodes is identical in structure and activeFlows values
    const nodesRes = await fetch(`${baseUrl}/hub/nodes`, {
      headers: { cookie, host: "127.0.0.1" },
    });
    assert.equal(nodesRes.status, 200);
    const nodesData = await nodesRes.json();
    assert.deepEqual(nodesData.activeSessions, overviewData.activeSessions);

    // 5. Release flows
    endA1();
    endA2();
    endB1();

    const idleOverviewRes = await fetch(`${baseUrl}/hub/overview`, {
      headers: { cookie, host: "127.0.0.1" },
    });
    const idleOverviewData = await idleOverviewRes.json();
    assert.equal(idleOverviewData.activeSessions.totalFlows, 0);
    assert.equal(idleOverviewData.activeSessions.distinctNodes, 0);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
