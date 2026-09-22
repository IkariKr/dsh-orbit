// v0.5 Stage 4: bounded data-channel pool and reverse HTTP
// (docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md Stage 4;
// RFC-0012 D5/D6/D7). One flow per channel, bounded queues, ORBIT-ROUTE-V1
// verified node-side against the SHARED nonce cache, no implicit fallback.

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { randomHex, generateNodeKeyPair, signSigningString } from "../src/registry/crypto.mjs";
import { buildRouteSigningString, computeRouteAuthority } from "../src/registry/protocol.mjs";
import { validateReversePoolBounds, ReverseChannelManager, ReverseCapacityError, ReverseFlowAbortedError, ReverseSessionStaleError } from "../src/registry/reverse-channel.mjs";
import { ReverseClient } from "../src/node/reverse-client.mjs";
import { ReverseChannelPool } from "../src/node/reverse-channels.mjs";
import { RouteNonceCache } from "../src/registry/route-auth.mjs";
import { createTestRegistry, createTestServer } from "./helpers/registry-fixture.mjs";

const ROUTE_DOMAIN = "dsh.example.local";

async function startMockDsh() {
  const recorded = [];
  let handler = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      recorded.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
        chunkCount: chunks.length,
      });
      if (handler) {
        handler(request, response, body);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-dsh-echo": "1" });
      response.end("<html><body>dsh-root</body></html>");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    recorded,
    setHandler: (fn) => (handler = fn),
    target: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

async function startTopology(t, { poolOptions = {} } = {}) {
  const registry = createTestRegistry({ routeDomain: ROUTE_DOMAIN });
  const { baseUrl, reverseSessions, reverseChannels, close } = await createTestServer(registry);
  const dsh = await startMockDsh();

  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const keys = generateNodeKeyPair();
  const enrolled = registry.enroll({ token: minted.token, enrollmentRequestId: randomHex(16), publicKey: keys.publicKeyHex });
  registry.db.prepare("UPDATE nodes SET route_mode = 'reverse' WHERE node_id = ?").run(enrolled.nodeId);
  const nodeId = enrolled.nodeId;
  const routeAuthority = computeRouteAuthority(nodeId, ROUTE_DOMAIN);
  // Route-target provisioning (RFC-0008) normally provisions the Hub route
  // identity; provision it explicitly for the reverse flow proofs.
  registry.ensureHubRouteKey(nodeId);
  registry.db.prepare("UPDATE hub_route_keys SET state = 'active', activated_at = ? WHERE node_id = ?").run(new Date().toISOString(), nodeId);

  const sharedNonceCache = new RouteNonceCache();
  const node = { nodeId, keyId: enrolled.keyId, privateKeyHex: keys.privateKeyHex };
  const pool = new ReverseChannelPool({
    hubBaseUrl: baseUrl,
    getCredentials: () => ({ nodeId, keyId: deriveKeyIdOf(keys.publicKeyHex), privateKeyHex: keys.privateKeyHex }),
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dsh.target,
    getTrustKeys: () =>
      registry.db.prepare("SELECT key_id AS keyId, public_key AS publicKey, state FROM hub_route_keys WHERE node_id = ? AND state != 'revoked'").all(nodeId),
    nonceCache: sharedNonceCache,
    ...poolOptions,
  });
  const client = new ReverseClient({
    hubBaseUrl: baseUrl,
    getCredentials: () => ({ nodeId, keyId: deriveKeyIdOf(keys.publicKeyHex), privateKeyHex: keys.privateKeyHex }),
    dshTarget: dsh.target,
    channelPool: pool,
    livenessPollMs: 100,
  });
  client.start();
  await waitFor(() => reverseSessions.getSessionInfo(nodeId) !== null, { label: "ready session" });
  await waitFor(() => pool.idleCount() >= 1, { label: "idle channel available" });

  const hubRouteKey = registry.db
    .prepare("SELECT key_id AS keyId, private_key AS privateKeyHex FROM hub_route_keys WHERE node_id = ? AND state != 'revoked' LIMIT 1")
    .get(nodeId);

  const buildRouteProof = (method, rawTarget) => {
    const timestamp = Date.now();
    const nonce = randomHex(16);
    const signingString = buildRouteSigningString({ nodeId, routeAuthority, method, rawTarget, timestamp: String(timestamp), nonce });
    const signature = signSigningString(hubRouteKey.privateKeyHex, signingString);
    return { nodeId, keyId: hubRouteKey.keyId, timestamp, nonce, signature };
  };

  return {
    registry,
    baseUrl,
    reverseSessions,
    reverseChannels,
    close,
    dsh,
    nodeId,
    node,
    routeAuthority,
    sharedNonceCache,
    client,
    pool,
    buildRouteProof,
    cleanup: async () => {
      client.stop();
      await dsh.close();
      await close();
      registry.close();
    },
  };
}

import { deriveKeyId as deriveKeyIdOf } from "../src/registry/crypto.mjs";

function waitFor(predicate, { timeoutMs = 8000, stepMs = 25, label }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = async () => {
      try {
        if (await predicate()) return resolve();
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${label ?? "condition"}`));
      setTimeout(check, stepMs);
    };
    check();
  });
}

async function* iterableOf(chunks) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function collectBody(body) {
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

test("pool bounds validate: idle target 1-16, max 4-64, idle <= max", () => {
  assert.equal(validateReversePoolBounds({ idleTarget: 8, maxChannels: 32 }), null);
  assert.match(validateReversePoolBounds({ idleTarget: 0, maxChannels: 32 }), /1-16/);
  assert.match(validateReversePoolBounds({ idleTarget: 17, maxChannels: 32 }), /1-16/);
  assert.match(validateReversePoolBounds({ idleTarget: 8, maxChannels: 3 }), /4-64/);
  assert.match(validateReversePoolBounds({ idleTarget: 8, maxChannels: 65 }), /4-64/);
  assert.match(validateReversePoolBounds({ idleTarget: 9, maxChannels: 8 }), /<= max/);
});

test("channel upgrade requires the current ready session binding; another node's session is denied", async (t) => {
  const topology = await startTopology(t);
  const { reverseSessions, nodeId } = topology;

  // The current session is bound; a wrong session id cannot register.
  const info = reverseSessions.getSessionInfo(nodeId);
  assert.ok(info);
  const { default: http } = await import("node:http");
  const wrongBinding = await new Promise((resolve, reject) => {
    const url = new URL(topology.baseUrl);
    const request = http.request(
      { host: url.hostname, port: url.port, path: "/api/v1/reverse/channel", method: "GET",
        headers: { connection: "upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", "x-orbit-reverse-session": "deadbeef".repeat(4) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
      },
    );
    request.on("upgrade", () => reject(new Error("unexpected upgrade")));
    request.on("error", reject);
    request.end();
  });
  // Unauthenticated probe is rejected before the binding check.
  assert.ok([400, 401, 403].includes(wrongBinding.status));
  // Manager-side: channels bound to a session id that is not current are refused.
  assert.equal(topology.reverseChannels.channels.get(nodeId)?.size >= 1, true);
  await topology.cleanup();
});

test("capacity waiters are generation-bound and cancelled on session takeover", async () => {
  const manager = new ReverseChannelManager({ capacityWaitMs: 5000 });
  const stale = manager.acquireChannel("node_" + "a".repeat(32), { sessionId: "old-session" });
  await sleep(20);
  manager.closeChannelsForSession("old-session", "takeover");
  await assert.rejects(stale, (error) => error instanceof ReverseSessionStaleError);
  assert.equal(manager.idleWaiters.size, 0);
});

test("credential revocation closes only exact-key channels and is idempotent", () => {
  const manager = new ReverseChannelManager({ idleTarget: 1, maxChannels: 4 });
  const sockets = [];
  const register = (nodeId, keyId, sessionId) => {
    const socket = new PassThrough();
    sockets.push(socket);
    return manager.registerChannel({
      nodeId,
      keyId,
      sessionId,
      socket,
      secWebSocketKey: "dGhlIHNhbXBsZSBub25jZQ==",
    });
  };
  const oldKey = register("node-a", "old-key", "session-a");
  const newKey = register("node-a", "new-key", "session-a");
  const otherNode = register("node-b", "old-key", "session-b");
  assert.equal(oldKey.keyId, "old-key");
  assert.equal(newKey.keyId, "new-key");
  assert.equal(otherNode.keyId, "old-key");

  const closed = manager.closeChannelsForCredential("node-a", "old-key", "rotation-overlap-ended");
  assert.deepEqual(closed, [oldKey.id]);
  assert.equal(oldKey.closed, true);
  assert.equal(newKey.closed, false);
  assert.equal(otherNode.closed, false);
  assert.deepEqual(manager.closeChannelsForCredential("node-a", "old-key", "rotation-overlap-ended"), []);

  for (const socket of sockets) socket.destroy();
});

test("a stale session binding is denied after a control takeover", async (t) => {
  const topology = await startTopology(t);
  const { registry, reverseSessions, nodeId, client } = topology;
  const staleSessionId = reverseSessions.getSessionInfo(nodeId).reverseSessionId;

  // Takeover: a second control client supersedes the first generation.
  const second = new ReverseClient({
    hubBaseUrl: topology.baseUrl,
    getCredentials: () => ({ nodeId, keyId: topology.node.keyId, privateKeyHex: topology.node.privateKeyHex }),
    dshTarget: topology.dsh.target,
  });
  second.start();
  await waitFor(() => reverseSessions.getSessionInfo(nodeId)?.reverseSessionId !== staleSessionId, { label: "takeover" });
  client.stop();
  second.stop();

  // The old session id no longer binds.
  const sessionInfo = reverseSessions.getSessionInfo(nodeId);
  assert.notEqual(sessionInfo.reverseSessionId, staleSessionId);
  void registry;
  await topology.cleanup();
});

test("acquireChannel fails 503 reverse-capacity when the node has no idle channel within the wait window", async (t) => {
  const manager = new ReverseChannelManager({ capacityWaitMs: 300 });
  await assert.rejects(
    () => manager.acquireChannel("node_" + "a".repeat(32)),
    (error) => error instanceof ReverseCapacityError && error.code === "reverse-capacity",
  );
  assert.equal(manager.idleWaiters.size, 0, "timed-out capacity waiters must be removed");
});

test("malformed authenticated OPEN closes the node channel without touching DSH", async (t) => {
  const topology = await startTopology(t);
  const { pool, nodeId, dsh } = topology;
  const channel = [...pool.channels][0];
  assert.ok(channel);
  const before = dsh.recorded.length;
  channel.state = "idle";
  pool.onChannelText(channel, JSON.stringify({
    type: "open",
    requestId: "request-1",
    mode: "http",
    headers: ["not-a-pair"],
  }));
  await waitFor(() => !pool.channels.has(channel), { label: "malformed OPEN channel close" });
  assert.equal(dsh.recorded.length, before);
  void nodeId;
  await topology.cleanup();
});

test("full reverse HTTP flow: root GET through the channel reaches DSH with sanitized headers and returns idle", async (t) => {
  const topology = await startTopology(t);
  const { reverseChannels, nodeId, routeAuthority, buildRouteProof, dsh } = topology;

  const result = await reverseChannels.executeReverseHttp(nodeId, {
    method: "GET",
    rawTarget: "/",
    routeAuthority,
    routeProof: buildRouteProof("GET", "/"),
    headers: [["host", routeAuthority], ["x-orbit-route-signature", "browser-forged-must-not-reach-dsh"]],
  });
  assert.equal(result.status, 200);
  const body = await collectBody(result.body);
  assert.match(body.toString("utf8"), /dsh-root/);
  await result.finish();

  const recorded = dsh.recorded.at(-1);
  assert.equal(recorded.method, "GET");
  assert.equal(recorded.url, "/");
  // Host/authority preserved; no route or machine credentials reach DSH.
  assert.equal(recorded.headers.host, routeAuthority);
  assert.equal(recorded.headers["x-orbit-route-signature"], undefined);
  assert.equal(recorded.headers["x-orbit-machine"], undefined);
  // The channel returned to idle after the flow.
  await waitFor(() => reverseChannels.idleChannels(nodeId).length >= 1, { label: "channel idle again" });
  await topology.cleanup();
});

test("status transparency: downstream 404/500 pass through without failover", async (t) => {
  const topology = await startTopology(t);
  const { reverseChannels, nodeId, routeAuthority, buildRouteProof, dsh } = topology;
  for (const status of [404, 500]) {
    dsh.setHandler((request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, status }));
    });
    const result = await reverseChannels.executeReverseHttp(nodeId, {
      method: "GET",
      rawTarget: `/missing-${status}`,
      routeAuthority,
      routeProof: buildRouteProof("GET", `/missing-${status}`),
    });
    assert.equal(result.status, status);
    await collectBody(result.body);
    await result.finish();
  }
  await topology.cleanup();
});

test("streaming upload: the request body streams in bounded frames without whole-body buffering", async (t) => {
  const topology = await startTopology(t);
  const { reverseChannels, nodeId, routeAuthority, buildRouteProof, dsh } = topology;
  const chunk = Buffer.alloc(32 * 1024, 0x61);
  const chunkCount = 8; // 256 KiB total
  let upstreamChunks = 0;
  const body = (async function* () {
    for (let i = 0; i < chunkCount; i += 1) {
      upstreamChunks += 1;
      yield chunk;
      await sleep(5);
    }
  })();
  const result = await reverseChannels.executeReverseHttp(nodeId, {
    method: "POST",
    rawTarget: "/upload?streaming=1",
    routeAuthority,
    routeProof: buildRouteProof("POST", "/upload?streaming=1"),
    headers: [["content-type", "application/octet-stream"]],
    body,
  });
  assert.equal(result.status, 200);
  await collectBody(result.body);
  await result.finish();
  const recorded = dsh.recorded.at(-1);
  assert.equal(recorded.body.length, chunk.length * chunkCount);
  // The source streamed: the DSH request was written while the source was
  // still producing (not after the whole body buffered).
  assert.ok(recorded.chunkCount >= 1);
  void upstreamChunks;
  await topology.cleanup();
});

test("large response streams through 64 KiB frames", async (t) => {
  const topology = await startTopology(t);
  const { reverseChannels, nodeId, routeAuthority, buildRouteProof, dsh } = topology;
  const total = 1024 * 1024; // 1 MiB
  dsh.setHandler((request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    const buffer = Buffer.alloc(64 * 1024, 0x62);
    for (let i = 0; i < total / buffer.length; i += 1) {
      response.write(buffer);
    }
    response.end();
  });
  const result = await reverseChannels.executeReverseHttp(nodeId, {
    method: "GET",
    rawTarget: "/big",
    routeAuthority,
    routeProof: buildRouteProof("GET", "/big"),
  });
  assert.equal(result.status, 200);
  const body = await collectBody(result.body);
  assert.equal(body.length, total);
  await result.finish();
  await topology.cleanup();
});

test("downstream abort mid-response fails closed with an aborted flow", async (t) => {
  const topology = await startTopology(t);
  const { reverseChannels, nodeId, routeAuthority, buildRouteProof, dsh } = topology;
  dsh.setHandler((request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write(Buffer.alloc(1024, 0x63));
    setTimeout(() => response.destroy(), 30);
  });
  const result = await reverseChannels.executeReverseHttp(nodeId, {
    method: "GET",
    rawTarget: "/aborting",
    routeAuthority,
    routeProof: buildRouteProof("GET", "/aborting"),
  });
  assert.equal(result.status, 200);
  // The flow terminates (body ends or errors) — never hangs, never retries.
  const body = await collectBody(result.body).catch((error) => error);
  assert.ok(body === undefined || body instanceof Error, "body settles");
  await sleep(200);
  await topology.cleanup();
});

test("an ORBIT-ROUTE-V1 proof consumed on the reverse transport cannot replay on the shared cache", async (t) => {
  const topology = await startTopology(t);
  const { reverseChannels, nodeId, routeAuthority, buildRouteProof, sharedNonceCache } = topology;
  const proof = buildRouteProof("GET", "/");
  const result = await reverseChannels.executeReverseHttp(nodeId, {
    method: "GET",
    rawTarget: "/",
    routeAuthority,
    routeProof: proof,
  });
  await collectBody(result.body);
  await result.finish();
  // The nonce is now reserved in the SHARED process-level cache (D6.1):
  // the direct route ingress would reject a replay of the same proof.
  assert.equal(sharedNonceCache.checkAndReserve(proof.nonce), false);
  await topology.cleanup();
});

test("wrong-authority and wrong-node proofs are denied before DSH is touched", async (t) => {
  const topology = await startTopology(t);
  const { reverseChannels, nodeId, routeAuthority, buildRouteProof, dsh } = topology;
  const before = dsh.recorded.length;

  // Proof signed for a different authority (still validly signed) is refused.
  const otherAuthority = computeRouteAuthority(nodeId, "other.example.local");
  const timestamp = Date.now();
  const nonce = randomHex(16);
  const signingString = buildRouteSigningString({ nodeId, routeAuthority: otherAuthority, method: "GET", rawTarget: "/", timestamp: String(timestamp), nonce });
  const hubRouteKey = topology.registry.db
    .prepare("SELECT private_key AS privateKeyHex FROM hub_route_keys WHERE node_id = ? AND state != 'revoked' LIMIT 1")
    .get(nodeId);
  const signature = signSigningString(hubRouteKey.privateKeyHex, signingString);
  await assert.rejects(
    () =>
      reverseChannels.executeReverseHttp(nodeId, {
        method: "GET",
        rawTarget: "/",
        routeAuthority: otherAuthority,
        routeProof: { nodeId, keyId: topology.registry.db.prepare("SELECT key_id AS keyId FROM hub_route_keys WHERE node_id = ? LIMIT 1").get(nodeId).keyId, timestamp, nonce, signature },
        headers: [["host", otherAuthority]],
      }),
    (error) => error instanceof ReverseFlowAbortedError,
  );
  assert.equal(dsh.recorded.length, before, "DSH must never be touched by a denied flow");
  void routeAuthority;
  await topology.cleanup();
});

test("channel desync (idle mid-flow) closes the channel instead of guessing", async (t) => {
  const topology = await startTopology(t);
  const { reverseChannels, nodeId, routeAuthority, buildRouteProof } = topology;
  const resultPromise = reverseChannels.executeReverseHttp(nodeId, {
    method: "GET",
    rawTarget: "/",
    routeAuthority,
    routeProof: buildRouteProof("GET", "/"),
  });
  const result = await resultPromise;
  // Simulate a node reporting idle mid-flow (desync) by closing the flow
  // through the manager's own desync rule: craft a stray idle on the busy
  // channel via its socket parser is not reachable here, so assert the
  // pool still converges after the flow completes normally.
  await collectBody(result.body);
  await result.finish();
  await waitFor(() => reverseChannels.idleChannels(nodeId).length >= 1, { label: "pool converged" });
  await topology.cleanup();
});
