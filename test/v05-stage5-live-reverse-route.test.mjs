import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { createFrameParser, encodeFrame, computeSecWebSocketAccept, randomSecWebSocketKey } from "../src/registry/reverse-ws.mjs";
import { generateNodeKeyPair, randomHex, sha256Hex, signSigningString } from "../src/registry/crypto.mjs";
import { buildSigningString, MACHINE_V1_LABEL } from "../src/registry/protocol.mjs";
import { RouteNonceCache } from "../src/registry/route-auth.mjs";
import { createTestRegistry, createTestServer } from "./helpers/registry-fixture.mjs";
import { ReverseClient } from "../src/node/reverse-client.mjs";
import { ReverseChannelPool } from "../src/node/reverse-channels.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";
import { HubWebSocketTracker } from "../src/registry/route-proxy.mjs";
import { RouteIngress } from "../src/node/route-ingress.mjs";
import { buildSelectorNodeRow } from "../src/registry/selector-view.mjs";

const ROUTE_DOMAIN = "stage5-live.example";

function waitFor(predicate, { timeoutMs = 10_000, stepMs = 20, label = "condition" } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = async () => {
      try {
        if (await predicate()) return resolve();
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started >= timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(check, stepMs);
    };
    check();
  });
}

function requestHttp({ port, host, path, headers = {} }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy(new Error(`timed out waiting for HTTP response: ${host}${path}`));
      reject(new Error(`timed out waiting for HTTP response: ${host}${path}`));
    }, 5000);
    const request = http.request({ hostname: "127.0.0.1", port, path, headers: { host, ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
      });
    });
    request.setTimeout(5000, () => {
      request.destroy(new Error(`timed out waiting for HTTP response: ${host}${path}`));
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

async function startMockDsh({ label = "reverse" } = {}) {
  const recorded = [];
  const activeSockets = new Set();
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      recorded.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
      if (request.url === "/http") {
        response.writeHead(200, {
          "content-type": "text/plain",
          "x-node-fixture": label,
          "set-cookie": ["one=1; Domain=.internal.example; Path=/", "two=2; Domain=.internal.example; Path=/"],
        });
        response.end("reverse-http-ok");
        return;
      }
      if (request.url === "/http-delay") {
        setTimeout(() => {
          response.writeHead(200, { "content-type": "text/plain", "x-node-fixture": label });
          response.end("delayed");
        }, 500).unref?.();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain", "x-node-fixture": label });
      response.end("ordinary-ok");
    });
  });
  server.on("upgrade", (request, socket, head) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
    recorded.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.alloc(0) });
    const status = request.url === "/ws-401" || request.url === "/ws-split-401" ? 401 : request.url === "/ws-403" ? 403 : request.url === "/ws-500" ? 500 : 101;
    if (status !== 101) {
      const body = Buffer.from(`status-${status}`);
      const responseHead = [
        `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Internal Server Error"}`,
        "content-type: text/plain",
        `content-length: ${body.length}`,
        "connection: close",
        "",
        "",
      ].join("\r\n");
      socket.write(responseHead);
      if (request.url === "/ws-split-401") {
        setTimeout(() => socket.end(body), 40).unref?.();
      } else {
        socket.end(body);
      }
      return;
    }
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "upgrade: websocket",
      "connection: Upgrade",
      `sec-websocket-accept: ${computeSecWebSocketAccept(request.headers["sec-websocket-key"])}`,
      `sec-websocket-protocol: ${request.headers["sec-websocket-protocol"] ?? "orbit-test"}`,
      `x-node-fixture: ${label}`,
      "set-cookie: dsh=1; Domain=.internal.example; Path=/",
      "",
      "",
    ].join("\r\n"));
    const parser = createFrameParser({
      isClient: false,
      maxMessageBytes: 2 * 1024 * 1024,
      onMessage: (message) => {
        if (typeof message === "string") socket.write(encodeFrame({ opcode: 0x1, payload: Buffer.from(message), mask: false }));
        else socket.write(encodeFrame({ opcode: 0x2, payload: message, mask: false }));
      },
      onPing: (payload) => socket.write(encodeFrame({ opcode: 0xa, payload, mask: false })),
      onClose: () => socket.destroy(),
      onError: () => socket.destroy(),
    });
    socket.on("data", (chunk) => parser(chunk));
    if (head?.length) parser(head);
    if (request.url === "/ws-close") {
      setTimeout(() => socket.destroy(), 30).unref?.();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    recorded,
    target: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      for (const socket of activeSockets) socket.destroy();
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

function openWebSocket({ port, host, path, headers = {} }) {
  const key = randomSecWebSocketKey();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error(`timed out waiting for WebSocket handshake: ${path}`));
    }, 5000);
    timer.unref?.();
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      headers: {
        host,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": key,
        ...headers,
      },
    });
    request.once("upgrade", (response, socket, head) => {
      clearTimeout(timer);
      resolve({ kind: "upgrade", response, socket, head });
    });
    request.once("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        clearTimeout(timer);
        resolve({ kind: "response", response, body: Buffer.concat(chunks) });
      });
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

function nextMessage(socket, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), timeoutMs);
    const parser = createFrameParser({
      isClient: true,
      maxMessageBytes: 2 * 1024 * 1024,
      onMessage: (message) => { clearTimeout(timer); resolve(message); },
      onPong: (payload) => { clearTimeout(timer); resolve({ pong: payload }); },
      onClose: () => { clearTimeout(timer); resolve({ close: true }); },
      onError: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.on("data", parser);
  });
}

function waitForSocketClose(socket) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", resolve));
}

async function setupTopology({ wsTracker = null } = {}) {
  const registry = createTestRegistry({ routeDomain: ROUTE_DOMAIN });
  const hub = await createTestServer(registry, {
    reverseChannels: undefined,
    ...(wsTracker ? { wsTracker } : {}),
  });
  const dsh = await startMockDsh();
  const keys = generateNodeKeyPair();
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const enrolled = registry.enroll({ token: minted.token, enrollmentRequestId: randomHex(16), publicKey: keys.publicKeyHex });
  const nodeId = enrolled.nodeId;
  registry.db.prepare("UPDATE nodes SET route_mode = 'reverse', orbit_compatible = 'pass', capabilities = ?, capabilities_stale = 0, reachable = 'unreachable' WHERE node_id = ?")
    .run(JSON.stringify([{ name: "web.routes", version: 1 }]), nodeId);
  registry.ensureHubRouteKey(nodeId);
  registry.db.prepare("UPDATE hub_route_keys SET state = 'active', activated_at = ? WHERE node_id = ?")
    .run(new Date().toISOString(), nodeId);
  const nonceCache = new RouteNonceCache();
  const credentialState = { keyId: enrolled.keyId, privateKeyHex: keys.privateKeyHex };
  const events = [];
  const credentials = () => ({ nodeId, keyId: credentialState.keyId, privateKeyHex: credentialState.privateKeyHex });
  const pool = new ReverseChannelPool({
    hubBaseUrl: hub.baseUrl,
    getCredentials: credentials,
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dsh.target,
    nonceCache,
    getTrustKeys: () => registry.db.prepare("SELECT key_id AS keyId, public_key AS publicKey, state FROM hub_route_keys WHERE node_id = ? AND state != 'revoked'").all(nodeId),
    onEvent: () => {},
  });
  const client = new ReverseClient({ hubBaseUrl: hub.baseUrl, getCredentials: credentials, dshTarget: dsh.target, channelPool: pool, livenessPollMs: 50, onEvent: (event) => events.push(event) });
  client.start();
  await waitFor(() => hub.reverseSessions.getSessionInfo(nodeId)?.routeReady === true, { label: "reverse session route readiness" });
  await waitFor(() => hub.reverseChannels.idleChannels(nodeId).length >= 1, { label: "reverse channel" });
  return {
    registry,
    hub,
    dsh,
    client,
    credentialState,
    events,
    node: enrolled,
    nodePrivateKeyHex: keys.privateKeyHex,
    nodeId,
    routeAuthority: computeRouteAuthority(nodeId, ROUTE_DOMAIN),
    cleanup: async () => {
      client.stop();
      await dsh.close();
      await hub.close();
      registry.close();
    },
  };
}

async function setupMixedTopology({ wsTracker = null } = {}) {
  const registry = createTestRegistry({ routeDomain: ROUTE_DOMAIN });
  const hub = await createTestServer(registry, wsTracker ? { wsTracker } : {});
  const dshA = await startMockDsh({ label: "direct" });
  const dshAReverse = await startMockDsh({ label: "direct-reverse-alternate" });
  const dshB = await startMockDsh({ label: "reverse" });

  const machineKeyA = generateNodeKeyPair();
  const machineKeyB = generateNodeKeyPair();
  const tokenA = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const tokenB = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const enrolledA = registry.enroll({
    token: tokenA.token,
    enrollmentRequestId: randomHex(16),
    publicKey: machineKeyA.publicKeyHex,
  });
  const enrolledB = registry.enroll({
    token: tokenB.token,
    enrollmentRequestId: randomHex(16),
    publicKey: machineKeyB.publicKeyHex,
  });
  const nodeIdA = enrolledA.nodeId;
  const nodeIdB = enrolledB.nodeId;

  const activateRouteKey = (nodeId) => {
    registry.ensureHubRouteKey(nodeId);
    registry.db.prepare("UPDATE hub_route_keys SET state = 'active', activated_at = ? WHERE node_id = ?")
      .run(new Date().toISOString(), nodeId);
  };
  activateRouteKey(nodeIdA);
  activateRouteKey(nodeIdB);

  const ingressA = new RouteIngress({
    nodeId: nodeIdA,
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dshA.target,
    getTrustKeys: () => registry.getHubRouteKeysForNode(nodeIdA),
  });
  await ingressA.listen(0, "127.0.0.1");
  const directTargetA = `http://127.0.0.1:${ingressA.port}`;

  registry.setRouteTarget({ actor: "operator", nodeId: nodeIdA, routeTarget: directTargetA });
  registry.setRouteTarget({ actor: "operator", nodeId: nodeIdB, routeTarget: dshA.target });
  registry.db.prepare("UPDATE nodes SET route_mode = 'direct', orbit_compatible = 'pass', capabilities = ?, capabilities_stale = 0, reachable = 'ok' WHERE node_id = ?")
    .run(JSON.stringify([{ name: "web.routes", version: 1 }]), nodeIdA);
  registry.db.prepare("UPDATE nodes SET route_mode = 'reverse', orbit_compatible = 'pass', capabilities = ?, capabilities_stale = 0, reachable = 'unreachable' WHERE node_id = ?")
    .run(JSON.stringify([{ name: "web.routes", version: 1 }]), nodeIdB);

  const nonceCacheA = new RouteNonceCache();
  const credentialsA = () => ({
    nodeId: nodeIdA,
    keyId: enrolledA.keyId,
    privateKeyHex: machineKeyA.privateKeyHex,
  });
  const poolA = new ReverseChannelPool({
    hubBaseUrl: hub.baseUrl,
    getCredentials: credentialsA,
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dshAReverse.target,
    nonceCache: nonceCacheA,
    getTrustKeys: () => registry.getHubRouteKeysForNode(nodeIdA),
    onEvent: () => {},
  });
  const clientA = new ReverseClient({
    hubBaseUrl: hub.baseUrl,
    getCredentials: credentialsA,
    dshTarget: dshAReverse.target,
    channelPool: poolA,
    livenessPollMs: 50,
    onEvent: () => {},
  });
  clientA.start();

  const nonceCacheB = new RouteNonceCache();
  const credentialsB = () => ({
    nodeId: nodeIdB,
    keyId: enrolledB.keyId,
    privateKeyHex: machineKeyB.privateKeyHex,
  });
  const poolB = new ReverseChannelPool({
    hubBaseUrl: hub.baseUrl,
    getCredentials: credentialsB,
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dshB.target,
    nonceCache: nonceCacheB,
    getTrustKeys: () => registry.getHubRouteKeysForNode(nodeIdB),
    onEvent: () => {},
  });
  const clientB = new ReverseClient({
    hubBaseUrl: hub.baseUrl,
    getCredentials: credentialsB,
    dshTarget: dshB.target,
    channelPool: poolB,
    livenessPollMs: 50,
    onEvent: () => {},
  });
  clientB.start();
  await waitFor(() => hub.reverseSessions.getSessionInfo(nodeIdA)?.routeReady === true, { label: "mixed direct-mode reverse session route readiness" });
  await waitFor(() => hub.reverseSessions.getSessionInfo(nodeIdB)?.routeReady === true, { label: "mixed reverse session route readiness" });
  await waitFor(() => hub.reverseChannels.idleChannels(nodeIdA).length >= 1, { label: "mixed direct-mode reverse channel" });
  await waitFor(() => hub.reverseChannels.idleChannels(nodeIdB).length >= 1, { label: "mixed reverse channel" });

  return {
    registry,
    hub,
    dshA,
    dshAReverse,
    dshB,
    ingressA,
    clientA,
    clientB,
    nodeIdA,
    nodeIdB,
    routeAuthorityA: computeRouteAuthority(nodeIdA, ROUTE_DOMAIN),
    routeAuthorityB: computeRouteAuthority(nodeIdB, ROUTE_DOMAIN),
    cleanup: async () => {
      clientA.stop();
      clientB.stop();
      await ingressA.close();
      await dshA.close();
      await dshAReverse.close();
      await dshB.close();
      await hub.close();
      registry.close();
    },
  };
}

test("Stage 5 live mixed topology: direct and reverse transports stay isolated and never fall back", async (t) => {
  const topology = await setupMixedTopology();
  t.after(topology.cleanup);
  const {
    registry,
    hub,
    dshA,
    dshAReverse,
    dshB,
    ingressA,
    clientB,
    nodeIdA,
    nodeIdB,
    routeAuthorityA,
    routeAuthorityB,
  } = topology;
  const port = Number(new URL(hub.baseUrl).port);

  const selectorA = buildSelectorNodeRow(registry, registry.getNodeRow(nodeIdA), {
    routeDomain: ROUTE_DOMAIN,
    trustedScheme: "http",
    reverseSessions: hub.reverseSessions,
    reverseChannels: hub.reverseChannels,
  });
  const selectorB = buildSelectorNodeRow(registry, registry.getNodeRow(nodeIdB), {
    routeDomain: ROUTE_DOMAIN,
    trustedScheme: "http",
    reverseSessions: hub.reverseSessions,
    reverseChannels: hub.reverseChannels,
  });
  assert.equal(selectorA.route.eligible, true);
  assert.equal(selectorA.route.routeMode, "direct");
  assert.equal(selectorA.route.openUrl, `http://${routeAuthorityA}/`);
  assert.equal(selectorB.route.eligible, true);
  assert.equal(selectorB.route.routeMode, "reverse");
  assert.equal(selectorB.route.openUrl, `http://${routeAuthorityB}/`);
  assert.equal(selectorB.health.reachable, "ok");
  assert.equal(selectorB.health.registryContact, registry.getNodeRow(nodeIdB).registry_contact);

  const directHttp = await requestHttp({ port, host: routeAuthorityA, path: "/http" });
  assert.equal(directHttp.status, 200);
  assert.equal(directHttp.headers["x-node-fixture"], "direct");
  const reverseHttp = await requestHttp({ port, host: routeAuthorityB, path: "/http" });
  assert.equal(reverseHttp.status, 200);
  assert.equal(reverseHttp.headers["x-node-fixture"], "reverse");
  const directModeReverseBrowserFlows = dshAReverse.recorded.filter((entry) => entry.url === "/http" || entry.url === "/ws");
  assert.equal(directModeReverseBrowserFlows.length, 0, "direct mode must not use the online reverse session");

  // Freeze an existing direct flow, then change mode. The open flow must
  // remain direct while only new flows observe the reverse transport.
  const directSocket = await openWebSocket({ port, host: routeAuthorityA, path: "/ws" });
  assert.equal(directSocket.kind, "upgrade");
  assert.equal(directSocket.response.statusCode, 101);
  assert.equal(directSocket.response.headers["x-node-fixture"], "direct");

  // The mode is changed explicitly at the registry seam used by the
  // operator lifecycle; only new flows may observe the new transport.
  registry.db.prepare("UPDATE nodes SET route_mode = 'reverse', reachable = 'unreachable' WHERE node_id = ?").run(nodeIdA);
  const switched = buildSelectorNodeRow(registry, registry.getNodeRow(nodeIdA), {
    routeDomain: ROUTE_DOMAIN,
    trustedScheme: "http",
    reverseSessions: hub.reverseSessions,
    reverseChannels: hub.reverseChannels,
  });
  assert.equal(switched.route.routeMode, "reverse");
  assert.equal(switched.route.eligible, true);

  const switchedHttp = await requestHttp({ port, host: routeAuthorityA, path: "/http" });
  assert.equal(switchedHttp.status, 200);
  assert.equal(switchedHttp.headers["x-node-fixture"], "direct-reverse-alternate");

  directSocket.socket.write(encodeFrame({ opcode: 0x1, payload: Buffer.from("direct"), mask: true }));
  assert.equal(await nextMessage(directSocket.socket), "direct");
  directSocket.socket.destroy();

  const reverseSocket = await openWebSocket({ port, host: routeAuthorityB, path: "/ws" });
  assert.equal(reverseSocket.kind, "upgrade");
  assert.equal(reverseSocket.response.statusCode, 101);
  assert.equal(reverseSocket.response.headers["x-node-fixture"], "reverse");
  reverseSocket.socket.write(encodeFrame({ opcode: 0x1, payload: Buffer.from("reverse"), mask: true }));
  assert.equal(await nextMessage(reverseSocket.socket), "reverse");

  // Reverse -> direct mode switch: a new flow uses the stored direct target,
  // while the already-open reverse flow remains bound to reverse transport.
  registry.db.prepare("UPDATE nodes SET route_mode = 'direct', reachable = 'ok' WHERE node_id = ?").run(nodeIdB);
  const switchedBack = buildSelectorNodeRow(registry, registry.getNodeRow(nodeIdB), {
    routeDomain: ROUTE_DOMAIN,
    trustedScheme: "http",
    reverseSessions: hub.reverseSessions,
    reverseChannels: hub.reverseChannels,
  });
  assert.equal(switchedBack.route.routeMode, "direct");
  assert.equal(switchedBack.route.eligible, true);
  const directFromB = await requestHttp({ port, host: routeAuthorityB, path: "/http" });
  assert.equal(directFromB.status, 200);
  assert.equal(directFromB.headers["x-node-fixture"], "direct");
  reverseSocket.socket.write(encodeFrame({ opcode: 0x1, payload: Buffer.from("reverse-still-bound"), mask: true }));
  assert.equal(await nextMessage(reverseSocket.socket), "reverse-still-bound");

  registry.db.prepare("UPDATE nodes SET route_mode = 'reverse', reachable = 'unreachable' WHERE node_id = ?").run(nodeIdB);
  reverseSocket.socket.write(encodeFrame({ opcode: 0x8, payload: Buffer.from([0x03, 0xe8]), mask: true }));
  await waitFor(() => hub.reverseChannels.idleChannels(nodeIdB).length >= 1, { label: "mixed reverse websocket idle" });
  reverseSocket.socket.destroy();

  // Return A to its explicit direct mode for the independent fault-isolation
  // check; the online reverse session still must not be consulted.
  registry.db.prepare("UPDATE nodes SET route_mode = 'direct', reachable = 'ok' WHERE node_id = ?").run(nodeIdA);

  // A direct transport outage is terminal for A even while B's reverse
  // session is healthy; the selector policy cannot cross node boundaries.
  const reverseBrowserFlowsBeforeDirectOutage = dshB.recorded.filter((entry) => entry.url === "/http" || entry.url === "/ws").length;
  ingressA.disable();
  const directOutage = await requestHttp({ port, host: routeAuthorityA, path: "/http" });
  assert.equal(directOutage.status, 503);
  const reverseBrowserFlowsAfterDirectOutage = dshB.recorded.filter((entry) => entry.url === "/http" || entry.url === "/ws").length;
  assert.equal(reverseBrowserFlowsAfterDirectOutage, reverseBrowserFlowsBeforeDirectOutage);
  ingressA.enable();
  const directAfterRecovery = await requestHttp({ port, host: routeAuthorityA, path: "/http" });
  assert.equal(directAfterRecovery.status, 200);
  assert.equal(directAfterRecovery.headers["x-node-fixture"], "direct");

  // B deliberately retains a stored direct target pointing at A's DSH. Once
  // its reverse session disappears, the selected reverse transport must fail
  // closed rather than use that alternate target.
  assert.equal(registry.getRouteTarget(nodeIdB).origin, dshA.target);
  const directCountBeforeReverseOutage = dshA.recorded.length;
  clientB.stop();
  await waitFor(() => hub.reverseSessions.getPresence(nodeIdB, "reverse") === "offline", { label: "mixed reverse session offline" });
  const reverseOutage = await requestHttp({ port, host: routeAuthorityB, path: "/http" });
  assert.equal(reverseOutage.status, 503);
  assert.equal(dshA.recorded.length, directCountBeforeReverseOutage);

  const reverseWsOutage = await openWebSocket({ port, host: routeAuthorityB, path: "/ws" });
  assert.equal(reverseWsOutage.kind, "response");
  assert.equal(reverseWsOutage.response.statusCode, 503);
  reverseWsOutage.socket?.destroy();

  const directHealthyAfterReverseOutage = await requestHttp({ port, host: routeAuthorityA, path: "/http" });
  assert.equal(directHealthyAfterReverseOutage.status, 200);
  assert.equal(directHealthyAfterReverseOutage.headers["x-node-fixture"], "direct");

  const selectorBOffline = buildSelectorNodeRow(registry, registry.getNodeRow(nodeIdB), {
    routeDomain: ROUTE_DOMAIN,
    trustedScheme: "http",
    reverseSessions: hub.reverseSessions,
    reverseChannels: hub.reverseChannels,
  });
  assert.equal(selectorBOffline.route.eligible, false);
  assert.equal(selectorBOffline.route.reasonCode, "reverse-offline");
  assert.equal(selectorBOffline.health.reachable, "unreachable");
  assert.equal(selectorBOffline.health.registryContact, registry.getNodeRow(nodeIdB).registry_contact);
});

test("Stage 5 route eligibility uses a non-destructive generation pool predicate", async (t) => {
  const topology = await setupTopology();
  t.after(topology.cleanup);
  const { hub, registry, nodeId } = topology;
  const currentSession = hub.reverseSessions.getSessionInfo(nodeId);
  assert.ok(currentSession?.reverseSessionId);
  const channels = hub.reverseChannels.idleChannels(nodeId, currentSession.reverseSessionId);
  assert.ok(channels.length >= 1);
  const before = channels.length;
  for (const channel of channels) channel.state = "busy";

  const busyRow = buildSelectorNodeRow(registry, registry.getNodeRow(nodeId), {
    routeDomain: ROUTE_DOMAIN,
    trustedScheme: "http",
    reverseSessions: hub.reverseSessions,
    reverseChannels: hub.reverseChannels,
  });
  assert.equal(busyRow.route.eligible, true, "busy channels remain eligible for bounded assignment wait");
  assert.equal(hub.reverseChannels.idleChannels(nodeId, currentSession.reverseSessionId).length, 0);
  assert.equal(hub.reverseChannels.hasChannelForSession(nodeId, currentSession.reverseSessionId), true);

  hub.reverseChannels.closeChannelsForNode(nodeId, "predicate-test");
  const unavailable = buildSelectorNodeRow(registry, registry.getNodeRow(nodeId), {
    routeDomain: ROUTE_DOMAIN,
    trustedScheme: "http",
    reverseSessions: hub.reverseSessions,
    reverseChannels: hub.reverseChannels,
  });
  assert.equal(unavailable.route.eligible, false);
  assert.equal(unavailable.route.reasonCode, "reverse-capacity");
  assert.equal(before >= 1, true);
});

test("Stage 5 reverse HTTP dispatch waits for a channel that becomes idle", async (t) => {
  const topology = await setupTopology();
  t.after(topology.cleanup);
  const { hub, nodeId, routeAuthority } = topology;
  const port = Number(new URL(hub.baseUrl).port);
  const channels = hub.reverseChannels.idleChannels(nodeId);
  assert.ok(channels.length >= 1);
  for (const channel of channels) channel.state = "busy";

  const pending = requestHttp({ port, host: routeAuthority, path: "/http" });
  await sleep(80);
  assert.equal(hub.reverseChannels.idleChannels(nodeId).length, 0);
  channels[0].state = "idle";
  hub.reverseChannels.onChannelIdle(channels[0]);

  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.body.toString("utf8"), "reverse-http-ok");
});

test("Stage 5 reverse WebSocket dispatch waits for a channel that becomes idle", async (t) => {
  const topology = await setupTopology();
  t.after(topology.cleanup);
  const { hub, nodeId, routeAuthority } = topology;
  const port = Number(new URL(hub.baseUrl).port);
  const channels = hub.reverseChannels.idleChannels(nodeId);
  assert.ok(channels.length >= 1);
  for (const channel of channels) channel.state = "busy";

  const pending = openWebSocket({ port, host: routeAuthority, path: "/ws" });
  await sleep(80);
  assert.equal(hub.reverseChannels.idleChannels(nodeId).length, 0);
  channels[0].state = "idle";
  hub.reverseChannels.onChannelIdle(channels[0]);

  const response = await pending;
  assert.equal(response.kind, "upgrade");
  assert.equal(response.response.statusCode, 101);
  response.socket.write(encodeFrame({ opcode: 0x8, payload: Buffer.from([0x03, 0xe8]), mask: true }));
  await waitFor(() => hub.reverseChannels.idleChannels(nodeId).length >= 1, { label: "reverse websocket waiter teardown" });
  response.socket.destroy();
});

test("Stage 5 reverse HTTP dispatch returns reverse-capacity only after the bounded waiter", async (t) => {
  const topology = await setupTopology();
  t.after(topology.cleanup);
  const { hub, nodeId, routeAuthority } = topology;
  const port = Number(new URL(hub.baseUrl).port);
  const channels = hub.reverseChannels.idleChannels(nodeId);
  for (const channel of channels) channel.state = "busy";
  hub.reverseChannels.capacityWaitMs = 120;

  const started = Date.now();
  const response = await requestHttp({ port, host: routeAuthority, path: "/http", headers: { accept: "application/json" } });
  const elapsed = Date.now() - started;
  assert.equal(response.status, 503);
  assert.match(response.body.toString("utf8"), /node-unavailable|reverse-capacity/);
  assert.ok(elapsed >= 90, `route bypassed the capacity waiter (${elapsed}ms)`);
});

test("Stage 5 reverse WebSocket tracker rejects before channel allocation and recovers after close", async (t) => {
  const topology = await setupMixedTopology({ wsTracker: new HubWebSocketTracker({ maxGlobal: 1, maxPerNode: 1 }) });
  t.after(topology.cleanup);
  const { hub, dshB, routeAuthorityA, routeAuthorityB } = topology;
  const port = Number(new URL(hub.baseUrl).port);

  const first = await openWebSocket({ port, host: routeAuthorityA, path: "/ws" });
  assert.equal(first.kind, "upgrade");
  assert.equal(hub.wsTracker.globalCount, 1);
  assert.equal(hub.wsTracker.nodeCounts.get(topology.nodeIdA), 1);

  const reverseWsCount = () => dshB.recorded.filter((entry) => entry.url === "/ws").length;
  const beforeRejected = reverseWsCount();
  const rejected = await openWebSocket({ port, host: routeAuthorityB, path: "/ws" });
  assert.equal(rejected.kind, "response");
  assert.equal(rejected.response.statusCode, 503);
  assert.equal(reverseWsCount(), beforeRejected, "tracker rejection must precede reverse channel allocation");
  assert.equal(hub.reverseChannels.idleChannels(topology.nodeIdB).length >= 1, true);

  first.socket.destroy();
  await waitFor(() => hub.wsTracker.globalCount === 0, { label: "tracker release after browser close" });
  assert.equal(hub.wsTracker.nodeCounts.has(topology.nodeIdA), false);

  const non101 = await openWebSocket({ port, host: routeAuthorityB, path: "/ws-401" });
  assert.equal(non101.kind, "response");
  assert.equal(non101.response.statusCode, 401);
  await waitFor(() => hub.wsTracker.globalCount === 0, { label: "tracker release after reverse non-101" });

  const recovered = await openWebSocket({ port, host: routeAuthorityB, path: "/ws" });
  assert.equal(recovered.kind, "upgrade");
  assert.equal(hub.wsTracker.globalCount, 1);
  recovered.socket.write(encodeFrame({ opcode: 0x8, payload: Buffer.from([0x03, 0xe8]), mask: true }));
  await waitFor(() => hub.reverseChannels.idleChannels(topology.nodeIdB).length >= 1, { label: "tracker reverse flow idle" });
  recovered.socket.destroy();
});

test("Stage 5 delete aborts an active reverse WebSocket and closes its generation", async (t) => {
  const topology = await setupTopology();
  t.after(topology.cleanup);
  const { registry, hub, nodeId, routeAuthority } = topology;
  const port = Number(new URL(hub.baseUrl).port);
  const ws = await openWebSocket({ port, host: routeAuthority, path: "/ws" });
  assert.equal(ws.kind, "upgrade");

  const deleted = registry.deleteNode({
    actor: "operator",
    nodeId,
    requestId: randomHex(16),
    reason: "stage5-active-flow-delete",
  });
  assert.equal(deleted.state, "tombstoned");
  await waitForSocketClose(ws.socket);
  await waitFor(() => hub.reverseSessions.getPresence(nodeId, "reverse") === "offline", { label: "reverse session closed after delete" });
  assert.equal(hub.reverseChannels.busyCount(nodeId), 0);
  assert.equal(hub.reverseChannels.idleChannels(nodeId).length, 0);
});

test("Stage 5 reverse session takeover cancels the old route waiter", async (t) => {
  const topology = await setupTopology();
  t.after(topology.cleanup);
  const { hub, nodeId } = topology;
  const current = hub.reverseSessions.getSessionInfo(nodeId);
  assert.ok(current?.reverseSessionId);
  const channels = hub.reverseChannels.idleChannels(nodeId);
  for (const channel of channels) channel.state = "busy";

  const waiting = hub.reverseChannels.acquireChannel(nodeId, { sessionId: current.reverseSessionId });
  await sleep(30);
  // Exercise the same manager callback used by ReverseSession.close(), while
  // keeping the test scoped to waiter cancellation rather than starting a
  // second client whose reconnect timers need separate teardown.
  hub.reverseChannels.closeChannelsForSession(current.reverseSessionId, "superseded");

  await assert.rejects(waiting, (error) => error.code === "reverse-session-stale");
  assert.equal(hub.reverseChannels.idleWaiters.size, 0);
});

test("Stage 5 credential overlap expiry closes old-key flow and preserves current-key reconnect", async (t) => {
  const topology = await setupTopology();
  t.after(topology.cleanup);
  const { registry, hub, nodeId, node, routeAuthority, client, credentialState } = topology;
  const port = Number(new URL(hub.baseUrl).port);
  const oldSession = hub.reverseSessions.getSessionInfo(nodeId);
  assert.ok(oldSession?.reverseSessionId);
  assert.equal(oldSession.keyId, node.keyId);
  const ws = await openWebSocket({ port, host: routeAuthority, path: "/ws" });
  assert.equal(ws.kind, "upgrade");
  t.after(() => ws.socket?.destroy());

  const newKeys = generateNodeKeyPair();
  const rotated = registry.rotateCredentialAuthenticated({
    node: registry.getNodeRow(nodeId),
    key: registry.deriveKeyRow(nodeId, node.keyId),
    rawBody: JSON.stringify({ newPublicKey: newKeys.publicKeyHex }),
  });
  assert.equal(registry.deriveKeyRow(nodeId, node.keyId).state, "active");
  assert.equal(hub.reverseSessions.getSessionInfo(nodeId)?.keyId, node.keyId, "old key remains valid during overlap");

  // Keep the original flow/session live while the overlap expires. The
  // reconnect callback is switched to the new key before maintenance closes
  // the old generation, so the same node client proves current-key recovery.
  credentialState.keyId = rotated.newKeyId;
  credentialState.privateKeyHex = newKeys.privateKeyHex;
  registry.db.prepare("UPDATE node_keys SET revoke_after = ? WHERE node_id = ? AND key_id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), nodeId, node.keyId);
  registry.maintenance();

  await waitForSocketClose(ws.socket);
  await waitFor(() => hub.reverseSessions.getSessionInfo(nodeId)?.keyId === rotated.newKeyId, { label: "current-key reverse reconnect" });
  assert.equal(hub.reverseSessions.getSessionInfo(nodeId)?.keyId, rotated.newKeyId);
  assert.equal(hub.reverseChannels.busyCount(nodeId), 0);
  assert.equal(registry.db.prepare("SELECT state, revocation_reason FROM node_keys WHERE node_id = ? AND key_id = ?").get(nodeId, node.keyId).state, "revoked");
  client.stop();
});

test("Stage 5 mixed-key data channel revocation closes only the revoked connection", async (t) => {
  const topology = await setupTopology();
  t.after(topology.cleanup);
  const { registry, hub, nodeId, node, nodePrivateKeyHex, routeAuthority, client, credentialState } = topology;
  const port = Number(new URL(hub.baseUrl).port);
  const oldKeyId = node.keyId;
  const oldPrivateKeyHex = nodePrivateKeyHex;

  const rotatedKeys = generateNodeKeyPair();
  const rotated = registry.rotateCredentialAuthenticated({
    node: registry.getNodeRow(nodeId),
    key: registry.deriveKeyRow(nodeId, oldKeyId),
    rawBody: JSON.stringify({ newPublicKey: rotatedKeys.publicKeyHex }),
  });

  // Re-establish the control generation with K_new while K_old remains
  // accepted during the normal overlap window.
  client.stop();
  credentialState.keyId = rotated.newKeyId;
  credentialState.privateKeyHex = rotatedKeys.privateKeyHex;
  client.start();
  await waitFor(() => hub.reverseSessions.getSessionInfo(nodeId)?.keyId === rotated.newKeyId, { label: "new-key control session" });
  const currentSession = hub.reverseSessions.getSessionInfo(nodeId);
  assert.ok(currentSession?.reverseSessionId);

  const newChannels = [...(hub.reverseChannels.channels.get(nodeId) ?? [])]
    .filter((channel) => channel.keyId === rotated.newKeyId);
  assert.ok(newChannels.length >= 1, "new-key channel must be registered");
  for (const channel of newChannels) channel.state = "busy";

  // D5/D10 permit a data channel to authenticate independently with K_old
  // while binding to the current K_new control generation.
  const oldPool = new ReverseChannelPool({
    hubBaseUrl: hub.baseUrl,
    getCredentials: () => ({ nodeId, keyId: oldKeyId, privateKeyHex: oldPrivateKeyHex }),
    routeDomain: ROUTE_DOMAIN,
    dshTarget: topology.dsh.target,
    nonceCache: new RouteNonceCache(),
    getTrustKeys: () => registry.db
      .prepare("SELECT key_id AS keyId, public_key AS publicKey, state FROM hub_route_keys WHERE node_id = ? AND state != 'revoked'")
      .all(nodeId),
  });
  t.after(() => oldPool.clearSession());
  oldPool.setSession(currentSession.reverseSessionId, 1, 4);
  await waitFor(() => [...(hub.reverseChannels.channels.get(nodeId) ?? [])]
    .some((channel) => channel.keyId === oldKeyId && channel.state === "idle"), { label: "old-key data channel" });
  // Prevent the deliberately old-key pool from replenishing after revocation;
  // the registered channel itself remains live for the active-flow assertion.
  oldPool.stopped = true;

  const ws = await openWebSocket({ port, host: routeAuthority, path: "/ws" });
  assert.equal(ws.kind, "upgrade");
  assert.equal(ws.response.statusCode, 101);
  t.after(() => ws.socket?.destroy());
  assert.ok([...(hub.reverseChannels.channels.get(nodeId) ?? [])]
    .some((channel) => channel.keyId === oldKeyId && channel.state === "busy"), "browser flow must use old-key data channel");

  registry.db.prepare("UPDATE node_keys SET revoke_after = ? WHERE node_id = ? AND key_id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), nodeId, oldKeyId);
  registry.maintenance();

  await waitForSocketClose(ws.socket);
  await waitFor(() => hub.reverseSessions.getSessionInfo(nodeId)?.keyId === rotated.newKeyId, { label: "new-key control survives old-key revoke" });
  assert.equal(hub.reverseSessions.getSessionInfo(nodeId)?.keyId, rotated.newKeyId);
  assert.equal([...(hub.reverseChannels.channels.get(nodeId) ?? [])]
    .some((channel) => channel.keyId === oldKeyId), false);
  assert.ok(newChannels.some((channel) => !channel.closed), "new-key data channel must remain open");

  // A revoked key cannot establish a fresh data channel, even when it knows
  // the current control session ID.
  const timestamp = String(Math.trunc(Date.now() / 1000));
  const nonce = randomHex(16);
  const signature = signSigningString(oldPrivateKeyHex, buildSigningString({
    label: MACHINE_V1_LABEL,
    method: "GET",
    path: "/api/v1/reverse/channel",
    timestamp,
    nonce,
    bodyHash: sha256Hex(""),
    nodeId,
  }));
  const denied = await openWebSocket({
    port,
    host: "127.0.0.1",
    path: "/api/v1/reverse/channel",
    headers: {
      "x-orbit-node": nodeId,
      "x-orbit-key": oldKeyId,
      "x-orbit-timestamp": timestamp,
      "x-orbit-nonce": nonce,
      "x-orbit-signature": signature,
      "x-orbit-reverse-session": currentSession.reverseSessionId,
    },
  });
  assert.equal(denied.kind, "response");
  assert.equal(denied.response.statusCode, 401);

  // The current-generation channel remains registered and usable after the
  // exact old-key teardown. Route eligibility is intentionally not asserted
  // here because maintenance may independently age compatibility evidence.
  const surviving = newChannels.find((channel) => !channel.closed);
  assert.ok(surviving);
  surviving.state = "idle";
  hub.reverseChannels.onChannelIdle(surviving);
  assert.equal(hub.reverseSessions.getSessionInfo(nodeId)?.reverseSessionId, currentSession.reverseSessionId);
  assert.equal(surviving.sessionId, currentSession.reverseSessionId);
  assert.equal(surviving.state, "idle");
  assert.equal(hub.reverseChannels.hasChannelForSession(nodeId, currentSession.reverseSessionId), true);
});

test("Stage 5 revoked old key cannot open a new reverse control session", async (t) => {
  const topology = await setupTopology(t);
  t.after(topology.cleanup);
  const { registry, hub, nodeId, node, nodePrivateKeyHex, routeAuthority } = topology;
  const port = Number(new URL(hub.baseUrl).port);
  const current = hub.reverseSessions.getSessionInfo(nodeId);
  assert.ok(current?.reverseSessionId);
  registry.db.prepare("UPDATE node_keys SET revoke_after = ? WHERE node_id = ? AND key_id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), nodeId, node.keyId);
  registry.maintenance();
  await waitFor(() => hub.reverseSessions.getSessionInfo(nodeId) === null, { label: "old-key session revoked" });

  const denied = await openWebSocket({
    port,
    host: "127.0.0.1",
    path: "/api/v1/reverse/control",
    headers: (() => {
      const timestamp = String(Math.trunc(Date.now() / 1000));
      const nonce = randomHex(16);
      const signature = signSigningString(nodePrivateKeyHex, buildSigningString({
        label: MACHINE_V1_LABEL,
        method: "GET",
        path: "/api/v1/reverse/control",
        timestamp,
        nonce,
        bodyHash: sha256Hex(""),
        nodeId,
      }));
      return {
        "x-orbit-node": nodeId,
        "x-orbit-key": node.keyId,
        "x-orbit-timestamp": timestamp,
        "x-orbit-nonce": nonce,
        "x-orbit-signature": signature,
      };
    })(),
  });
  assert.equal(denied.kind, "response");
  assert.equal(denied.response.statusCode, 401);
  assert.equal(hub.reverseSessions.getSessionInfo(nodeId), null);
});

test("Stage 5 live reverse route: deterministic authority carries HTTP and WebSocket without direct fallback", async (t) => {
  const topology = await setupTopology();
  t.after(topology.cleanup);
  let browserSocket = null;
  t.after(() => browserSocket?.destroy());
  const { hub, dsh, routeAuthority } = topology;
  const port = Number(new URL(hub.baseUrl).port);

  const httpResult = await requestHttp({
    port,
    host: routeAuthority,
    path: "/http",
    headers: { cookie: "dsh-orbit-hub-session=forbidden; dsh=browser", authorization: "Bearer browser-token", "x-orbit-route-signature": "forged" },
  });
  assert.equal(httpResult.status, 200);
  assert.equal(httpResult.body.toString("utf8"), "reverse-http-ok");
  assert.deepEqual(httpResult.headers["set-cookie"], ["one=1; Path=/", "two=2; Path=/"]);
  const httpHeaders = dsh.recorded.find((entry) => entry.url === "/http").headers;
  assert.equal(httpHeaders["x-orbit-route-signature"], undefined);
  assert.equal(httpHeaders.cookie, "dsh=browser");
  assert.equal(httpHeaders.authorization, "Bearer browser-token");

  const ws = await openWebSocket({
    port,
    host: routeAuthority,
    path: "/ws",
    headers: {
      origin: "https://browser.example",
      "sec-websocket-protocol": "orbit-test",
      cookie: "dsh-orbit-hub-session=forbidden; dsh=browser",
      authorization: "Bearer browser-token",
      "x-orbit-route-signature": "forged",
      "x-dsh-authenticated-proxy": "forged-gateway",
    },
  });
  assert.equal(ws.kind, "upgrade");
  browserSocket = ws.socket;
  assert.equal(ws.response.statusCode, 101);
  assert.equal(ws.response.headers["sec-websocket-protocol"], "orbit-test");
  assert.deepEqual(ws.response.headers["set-cookie"], ["dsh=1; Path=/"]);
  const wsHeaders = dsh.recorded.find((entry) => entry.url === "/ws").headers;
  assert.equal(wsHeaders.origin, "https://browser.example");
  assert.equal(wsHeaders["sec-websocket-protocol"], "orbit-test");
  assert.equal(wsHeaders.cookie, "dsh=browser");
  assert.equal(wsHeaders.authorization, "Bearer browser-token");
  assert.equal(wsHeaders["x-orbit-route-signature"], undefined);
  assert.equal(wsHeaders["x-dsh-authenticated-proxy"], undefined);

  ws.socket.write(encodeFrame({ opcode: 0x1, payload: Buffer.from("hello"), mask: true }));
  assert.equal(await nextMessage(ws.socket), "hello");
  const ping = Buffer.from("ping");
  ws.socket.write(encodeFrame({ opcode: 0x9, payload: ping, mask: true }));
  assert.deepEqual((await nextMessage(ws.socket)).pong, ping);

  const large = Buffer.alloc(512 * 1024, 0x61);
  ws.socket.write(encodeFrame({ opcode: 0x2, payload: large, mask: true }));
  assert.deepEqual(await nextMessage(ws.socket), large);

  ws.socket.write(encodeFrame({ opcode: 0x8, payload: Buffer.from([0x03, 0xe8]), mask: true }));
  await waitFor(() => hub.reverseChannels.idleChannels(topology.nodeId).length >= 1, { label: "reverse websocket teardown and channel idle" });
  assert.ok(dsh.recorded.some((entry) => entry.url === "/ws"));

  for (const status of [401, 403, 500]) {
    const denied = await openWebSocket({ port, host: routeAuthority, path: `/ws-${status}` });
    denied.socket?.destroy();
    assert.equal(denied.kind, "response");
    assert.equal(denied.response.statusCode, status);
    assert.equal(denied.body.toString("utf8"), `status-${status}`);
    await waitFor(() => hub.reverseChannels.idleChannels(topology.nodeId).length >= 1, { label: `channel idle after ${status}` });
  }
  const splitDenied = await openWebSocket({ port, host: routeAuthority, path: "/ws-split-401" });
  assert.equal(splitDenied.kind, "response");
  assert.equal(splitDenied.response.statusCode, 401);
  assert.equal(splitDenied.body.toString("utf8"), "status-401");

  await sleep(20);
});

test("Stage 5 browser abort before reverse response headers releases the channel", async (t) => {
  const topology = await setupTopology();
  t.after(topology.cleanup);
  const { hub, routeAuthority } = topology;
  const port = Number(new URL(hub.baseUrl).port);
  await new Promise((resolve) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: "/http-delay", headers: { host: routeAuthority } });
    request.once("socket", (socket) => {
      setTimeout(() => {
        request.destroy();
        resolve();
      }, 60).unref?.();
      void socket;
    });
    request.once("error", () => resolve());
    request.end();
  });
  await waitFor(() => hub.reverseChannels.busyCount(topology.nodeId) === 0, { label: "reverse channel release after early browser abort" });
  assert.ok(hub.reverseChannels.idleChannels(topology.nodeId).length >= 1);
});

test("Stage 5 reverse downstream close aborts the browser flow before channel reuse", async (t) => {
  const topology = await setupTopology();
  t.after(topology.cleanup);
  const { hub, routeAuthority } = topology;
  const port = Number(new URL(hub.baseUrl).port);
  const ws = await openWebSocket({ port, host: routeAuthority, path: "/ws-close" });
  assert.equal(ws.kind, "upgrade");
  await waitForSocketClose(ws.socket);
  await waitFor(() => hub.reverseChannels.busyCount(topology.nodeId) === 0, { label: "reverse flow teardown after downstream close" });
  assert.ok(hub.reverseChannels.idleChannels(topology.nodeId).length >= 1);
});
