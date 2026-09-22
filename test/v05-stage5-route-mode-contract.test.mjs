import assert from "node:assert/strict";
import test from "node:test";
import { buildSelectorNodeRow } from "../src/registry/selector-view.mjs";
import { evaluateRouteEligibility } from "../src/registry/route-proxy.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";

const NODE_ID = "node_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROUTE_DOMAIN = "stage5-mode.example";

function makeRegistry({ routeMode = "direct", routeTarget = null, reachable = "ok" } = {}) {
  const row = {
    node_id: NODE_ID,
    state: "active",
    route_mode: routeMode,
    reachable,
    capabilities_stale: 0,
    orbit_compatible: "pass",
    capabilities: JSON.stringify([{ name: "web.routes", version: 1 }]),
    registry_contact: "fresh",
    orbit_version: "0.4.0",
    orbit_revision: "test",
    dsh_version: "0.1.1",
    compatibility_profile: "test",
    last_seen: new Date().toISOString(),
    last_seen_source: "heartbeat",
  };
  const activeKey = {
    key_id: "hub-key",
    private_key: "a".repeat(96),
    state: "active",
  };
  return {
    getNodeRow: () => row,
    getRouteTarget: () => routeTarget ? { origin: routeTarget } : null,
    getActiveHubRouteKey: () => activeKey,
  };
}

function makeReverseRuntime({ online = true, reachable = true, channels = 1, idle = channels } = {}) {
  return {
    getPresence: (_nodeId, mode) => mode === "reverse" && online ? "online" : mode === "reverse" ? "offline" : "unknown",
    isReverseReachable: () => reachable,
    getSessionInfo: () => online ? { reverseSessionId: "session-1", routeReady: reachable } : null,
    hasChannelForSession: (_nodeId, sessionId) => online && sessionId === "session-1" && channels > 0,
    idleChannels: () => Array.from({ length: idle }, () => ({ state: "idle" })),
  };
}

test("reverse eligibility ignores stored direct target and preserves deterministic selector authority", () => {
  const registry = makeRegistry({ routeMode: "reverse", routeTarget: "http://127.0.0.1:4999", reachable: "unreachable" });
  const reverseSessions = makeReverseRuntime();
  const reverseChannels = makeReverseRuntime();
  const eligibility = evaluateRouteEligibility(registry, NODE_ID, { reverseSessions, reverseChannels });
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.routeMode, "reverse");
  assert.equal(eligibility.snapshot.routeMode, "reverse");
  assert.equal("routeTargetOrigin" in eligibility.snapshot, false);
  assert.equal(eligibility.snapshot.reverseSessionId, "session-1");

  const row = buildSelectorNodeRow(registry, registry.getNodeRow(), {
    routeDomain: ROUTE_DOMAIN,
    trustedScheme: "https",
    reverseSessions,
    reverseChannels,
  });
  assert.equal(row.route.eligible, true);
  assert.equal(row.route.routeMode, "reverse");
  assert.equal(row.route.reversePresence, "online");
  assert.equal(row.route.openUrl, `https://${computeRouteAuthority(NODE_ID, ROUTE_DOMAIN)}/`);
  assert.equal(row.health.reachable, "ok");
  assert.equal(row.health.registryContact, "fresh");
});

test("reverse eligibility waits for concrete assignment while offline remains fail-closed", () => {
  const registry = makeRegistry({ routeMode: "reverse", routeTarget: "http://127.0.0.1:4999" });
  const offline = makeReverseRuntime({ online: false });
  assert.equal(evaluateRouteEligibility(registry, NODE_ID, { reverseSessions: offline, reverseChannels: offline }).reason, "reverse-session-offline");

  const noIdleChannel = makeReverseRuntime({ channels: 1, idle: 0 });
  const eligible = evaluateRouteEligibility(registry, NODE_ID, { reverseSessions: noIdleChannel, reverseChannels: noIdleChannel });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.snapshot.reverseSessionId, "session-1");
  const row = buildSelectorNodeRow(registry, registry.getNodeRow(), {
    routeDomain: ROUTE_DOMAIN,
    trustedScheme: "https",
    reverseSessions: noIdleChannel,
    reverseChannels: noIdleChannel,
  });
  assert.equal(row.route.eligible, true);
  assert.equal(row.health.reachable, "ok");

  const noRegisteredChannel = makeReverseRuntime({ channels: 0, idle: 0 });
  const unavailable = evaluateRouteEligibility(registry, NODE_ID, {
    reverseSessions: noRegisteredChannel,
    reverseChannels: noRegisteredChannel,
  });
  assert.equal(unavailable.eligible, false);
  assert.equal(unavailable.reason, "reverse-capacity");
});

test("reverse selector health follows live route readiness while registry contact stays independent", () => {
  const registry = makeRegistry({ routeMode: "reverse", reachable: "unreachable" });
  const notReady = makeReverseRuntime({ online: true, reachable: false });
  const row = buildSelectorNodeRow(registry, registry.getNodeRow(), {
    routeDomain: ROUTE_DOMAIN,
    trustedScheme: "https",
    reverseSessions: notReady,
    reverseChannels: notReady,
  });
  assert.equal(row.route.eligible, false);
  assert.equal(row.route.reasonCode, "reverse-unreachable");
  assert.equal(row.health.reachable, "unreachable");
  assert.equal(row.health.registryContact, "fresh");
});

test("direct eligibility remains direct-only even with an online reverse session", () => {
  const registry = makeRegistry({ routeMode: "direct", routeTarget: "http://127.0.0.1:4001", reachable: "ok" });
  const reverse = makeReverseRuntime();
  const eligibility = evaluateRouteEligibility(registry, NODE_ID, { reverseSessions: reverse, reverseChannels: reverse });
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.routeMode, "direct");
  assert.equal(eligibility.snapshot.routeTargetOrigin, "http://127.0.0.1:4001");
  assert.equal("reverseSessionId" in eligibility.snapshot, false);
});
