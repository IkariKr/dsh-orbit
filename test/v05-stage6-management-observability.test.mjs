import assert from "node:assert/strict";
import test from "node:test";
import { createTestRegistry, createTestServer, enrollNode } from "./helpers/registry-fixture.mjs";

const ASSERTION = "gateway-held-assertion-secret";
const GATEWAY_HEADER = "x-dsh-authenticated-proxy";
const PRINCIPAL_HEADER = "x-dsh-operator-id";
const SESSION_COOKIE = "dsh-orbit-hub-session";
const CSRF_HEADER = "x-csrf-token";

function gatewayHeaders(extra = {}) {
  return { [GATEWAY_HEADER]: ASSERTION, [PRINCIPAL_HEADER]: "operator", ...extra };
}

async function establishSession(baseUrl) {
  const response = await fetch(baseUrl + "/hub/session", {
    method: "POST",
    headers: gatewayHeaders(),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const cookie = response.headers.get("set-cookie")?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
  assert.ok(cookie);
  return { cookie, csrfToken: body.csrfToken };
}

async function managementDetail(baseUrl, nodeId, cookie) {
  const response = await fetch(`${baseUrl}/hub/nodes/${nodeId}`, {
    headers: { ...gatewayHeaders(), cookie: `${SESSION_COOKIE}=${cookie}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("management read model exposes explicit reverse offline state without deriving it in the browser", async (t) => {
  const registry = createTestRegistry();
  const server = await createTestServer(registry, {
    gatewayAssertionSecret: ASSERTION,
    operatorPrincipal: { mode: "inject" },
  });
  t.after(async () => {
    await server.close();
    registry.close();
  });

  const node = await enrollNode(server.baseUrl, registry);
  const session = await establishSession(server.baseUrl);

  const direct = await managementDetail(server.baseUrl, node.nodeId, session.cookie);
  assert.equal(direct.routeMode, "direct");
  assert.equal(direct.reversePresence, "unknown");
  assert.equal(direct.reverseRouteReady, null);
  assert.equal(direct.reverseReason, null);
  assert.equal(direct.lastReverseTransition, null);

  const switched = await fetch(`${server.baseUrl}/hub/nodes/${node.nodeId}/route-mode`, {
    method: "PUT",
    headers: {
      ...gatewayHeaders(),
      cookie: `${SESSION_COOKIE}=${session.cookie}`,
      [CSRF_HEADER]: session.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ routeMode: "reverse" }),
  });
  assert.equal(switched.status, 200);

  const reverse = await managementDetail(server.baseUrl, node.nodeId, session.cookie);
  assert.equal(reverse.routeMode, "reverse");
  assert.equal(reverse.reversePresence, "offline");
  assert.equal(reverse.reverseRouteReady, false);
  assert.equal(reverse.reverseReason, "reverse-session-offline");
  assert.equal(JSON.stringify(reverse).includes("reverseSessionId"), false);

  const restoredDirect = await fetch(`${server.baseUrl}/hub/nodes/${node.nodeId}/route-mode`, {
    method: "PUT",
    headers: {
      ...gatewayHeaders(),
      cookie: `${SESSION_COOKIE}=${session.cookie}`,
      [CSRF_HEADER]: session.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ routeMode: "direct" }),
  });
  assert.equal(restoredDirect.status, 200);
  const directAgain = await managementDetail(server.baseUrl, node.nodeId, session.cookie);
  assert.equal(directAgain.routeMode, "direct");
  assert.equal(directAgain.reversePresence, "unknown");
  assert.equal(directAgain.reverseRouteReady, null);
  assert.equal(directAgain.reverseReason, null);
});

test("management read model projects live reverse readiness while keeping the session identity private", async (t) => {
  const reverseSessionId = "session-secret-must-not-leak";
  const reverseSessions = {
    getSessionInfo: () => ({ reverseSessionId, routeReady: true }),
    getPresence: () => "online",
    closeAll: () => {},
    closeSessionsForNode: () => {},
    closeSessionsForCredential: () => [],
  };
  const reverseChannels = {
    idleTarget: 8,
    maxChannels: 32,
    hasChannelForSession: () => true,
    closeChannelsForSession: () => [],
    closeChannelsForNode: () => [],
    closeChannelsForCredential: () => [],
  };
  const registry = createTestRegistry();
  const server = await createTestServer(registry, {
    gatewayAssertionSecret: ASSERTION,
    operatorPrincipal: { mode: "inject" },
    reverseSessions,
    reverseChannels,
  });
  t.after(async () => {
    await server.close();
    registry.close();
  });

  const node = await enrollNode(server.baseUrl, registry);
  registry.setRouteMode({ actor: "operator", nodeId: node.nodeId, routeMode: "reverse" });
  const session = await establishSession(server.baseUrl);
  const detail = await managementDetail(server.baseUrl, node.nodeId, session.cookie);

  assert.equal(detail.routeMode, "reverse");
  assert.equal(detail.reversePresence, "online");
  assert.equal(detail.reverseRouteReady, true);
  assert.equal(detail.reverseReason, "no-active-hub-route-key");
  assert.equal(JSON.stringify(detail).includes(reverseSessionId), false);
});
