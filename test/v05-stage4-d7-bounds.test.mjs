// v0.5 Stage 4 D7 numeric bounds: receive-side backpressure (node -> hub
// response direction) and hub-side OPEN header sanitation (RFC-0012 D6/D7).

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { randomHex, generateNodeKeyPair, signSigningString } from "../src/registry/crypto.mjs";
import { buildRouteSigningString, computeRouteAuthority } from "../src/registry/protocol.mjs";
import { ReverseChannelManager, ReverseFlowAbortedError } from "../src/registry/reverse-channel.mjs";
import { ReverseClient } from "../src/node/reverse-client.mjs";
import { ReverseChannelPool } from "../src/node/reverse-channels.mjs";
import { createTestRegistry, createTestServer } from "./helpers/registry-fixture.mjs";

const ROUTE_DOMAIN = "dsh.example.local";

async function startMockDsh() {
  const recorded = [];
  let handler = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      recorded.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
      if (handler) return handler(request, response);
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>dsh</html>");
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

async function startSmallBoundsTopology(t, limits) {
  const registry = createTestRegistry({ routeDomain: ROUTE_DOMAIN });
  const smallManager = new ReverseChannelManager({ limits, capacityWaitMs: 500 });
  const { baseUrl, reverseSessions, reverseChannels, close } = await createTestServer(registry, { reverseChannels: smallManager });
  const dsh = await startMockDsh();

  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const keys = generateNodeKeyPair();
  const enrolled = registry.enroll({ token: minted.token, enrollmentRequestId: randomHex(16), publicKey: keys.publicKeyHex });
  const nodeId = enrolled.nodeId;
  const routeAuthority = computeRouteAuthority(nodeId, ROUTE_DOMAIN);
  registry.ensureHubRouteKey(nodeId);
  registry.db.prepare("UPDATE hub_route_keys SET state = 'active', activated_at = ? WHERE node_id = ?").run(new Date().toISOString(), nodeId);

  const pool = new ReverseChannelPool({
    hubBaseUrl: baseUrl,
    getCredentials: () => ({ nodeId, keyId: deriveKey(keys.publicKeyHex), privateKeyHex: keys.privateKeyHex }),
    routeDomain: ROUTE_DOMAIN,
    dshTarget: dsh.target,
    getTrustKeys: () =>
      registry.db.prepare("SELECT key_id AS keyId, public_key AS publicKey, state FROM hub_route_keys WHERE node_id = ? AND state != 'revoked'").all(nodeId),
  });
  const client = new ReverseClient({
    hubBaseUrl: baseUrl,
    getCredentials: () => ({ nodeId, keyId: deriveKey(keys.publicKeyHex), privateKeyHex: keys.privateKeyHex }),
    dshTarget: dsh.target,
    channelPool: pool,
  });
  client.start();
  await waitFor(() => reverseSessions.getSessionInfo(nodeId) !== null, { label: "ready session" });
  await waitFor(() => pool.idleCount() >= 1, { label: "idle channel" });

  const buildRouteProof = (method, rawTarget) => {
    const hubRouteKey = registry.db
      .prepare("SELECT key_id AS keyId, private_key AS privateKeyHex FROM hub_route_keys WHERE node_id = ? AND state != 'revoked' LIMIT 1")
      .get(nodeId);
    const timestamp = Date.now();
    const nonce = randomHex(16);
    const signingString = buildRouteSigningString({ nodeId, routeAuthority, method, rawTarget, timestamp: String(timestamp), nonce });
    return { nodeId, keyId: hubRouteKey.keyId, timestamp, nonce, signature: signSigningString(hubRouteKey.privateKeyHex, signingString) };
  };

  return { registry, reverseSessions, reverseChannels, nodeId, routeAuthority, dsh, client, pool, buildRouteProof, close };
}

function deriveKey(publicKeyHex) {
  // Local alias to keep the fixture terse; same derivation as crypto.mjs.
  // eslint-disable-next-line no-bitwise
  return require_deriveKeyId(publicKeyHex);
}
import { deriveKeyId as require_deriveKeyId } from "../src/registry/crypto.mjs";

function waitFor(predicate, { timeoutMs = 10000, stepMs = 25, label }) {
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

async function collectBody(body) {
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

test("D7 receive bounds: response overrun past the hard cap aborts the flow and closes the channel", async (t) => {
  const topology = await startSmallBoundsTopology(t, {
    hardCapBytes: 16 * 1024,
    softMarkBytes: 4 * 1024,
    resumeBelowBytes: 2 * 1024,
    stallTimeoutMs: 800,
  });
  const { registry, reverseSessions, reverseChannels, nodeId, routeAuthority, dsh, client, buildRouteProof, close } = topology;

  // A single 60 KiB frame against a 16 KiB receive hard cap with no
  // consumer: the queued bytes blow past the hard cap in one push and the
  // flow aborts fail-closed. (For gradual pumping the soft-mark pause plus
  // the stall timer abort first — that path is covered by the stall test.)
  dsh.setHandler((request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(Buffer.alloc(60 * 1024, 0x64));
  });
  const rawTarget = "/overrun";
  const result = await reverseChannels.executeReverseHttp(nodeId, {
    method: "GET",
    rawTarget,
    routeAuthority,
    routeProof: buildRouteProof("GET", rawTarget),
  });
  assert.equal(result.status, 200);
  const outcome = await result.body.next().then(
    () => "kept-flowing",
    (error) => error,
  );
  assert.ok(outcome instanceof ReverseFlowAbortedError, `the flow must abort on overrun (got ${outcome})`);
  assert.equal(outcome.code, "flow-overrun");
  await waitFor(() => result.channel.closed, { label: "channel closed after overrun" });
  client.stop();
  await dsh.close();
  await close();
  registry.close();
});

test("D7 stall: a consumer that stops consuming for the stall window aborts the flow", async (t) => {
  const topology = await startSmallBoundsTopology(t, {
    hardCapBytes: 4 * 1024 * 1024,
    softMarkBytes: 8 * 1024,
    resumeBelowBytes: 2 * 1024,
    stallTimeoutMs: 600,
  });
  const { registry, reverseSessions, reverseChannels, nodeId, routeAuthority, dsh, client, buildRouteProof, close } = topology;

  dsh.setHandler((request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    const buffer = Buffer.alloc(4 * 1024, 0x65);
    const pump = setInterval(() => response.write(buffer), 10);
    setTimeout(() => {
      clearInterval(pump);
      response.end();
    }, 5000);
    pump.unref?.();
  });
  const rawTarget = "/stalling";
  const result = await reverseChannels.executeReverseHttp(nodeId, {
    method: "GET",
    rawTarget,
    routeAuthority,
    routeProof: buildRouteProof("GET", rawTarget),
  });
  const generator = result.body;
  // Consume one chunk, then stop consuming entirely: the stall timer must
  // abort the flow within the stall window.
  const first = await generator.next();
  assert.equal(first.done, false);
  await sleep(2000);
  const outcome = await generator.next().then(
    () => "kept-flowing",
    (error) => error,
  );
  assert.ok(outcome instanceof ReverseFlowAbortedError, `the stalled flow must abort (got ${JSON.stringify(outcome)})`);
  assert.equal(outcome.code, "flow-stall");
  client.stop();
  await dsh.close();
  await close();
  registry.close();
});

test("hub-side OPEN sanitation: browser cookies and gateway assertion headers never reach the node or DSH", async (t) => {
  const topology = await startSmallBoundsTopology(t, {
    hardCapBytes: 2 * 1024 * 1024,
    softMarkBytes: 512 * 1024,
    resumeBelowBytes: 256 * 1024,
    stallTimeoutMs: 30000,
  });
  const { registry, reverseSessions, reverseChannels, nodeId, routeAuthority, dsh, client, buildRouteProof, close } = topology;

  const result = await reverseChannels.executeReverseHttp(nodeId, {
    method: "GET",
    rawTarget: "/sanitized",
    routeAuthority,
    routeProof: buildRouteProof("GET", "/sanitized"),
    headers: [
      ["host", routeAuthority],
      ["cookie", "dsh-orbit-hub-session=forged; other=1"],
      ["x-orbit-route-signature", "forged"],
      ["x-dsh-authenticated-proxy", "gateway-secret"],
      ["x-dsh-operator-id", "operator"],
      ["x-gateway-auth", "gateway-assertion"],
      ["x-gateway-secret", "gateway-secret"],
      ["accept", "text/html"],
    ],
  });
  assert.equal(result.status, 200);
  await collectBody(result.body);
  await result.finish();
  const recorded = dsh.recorded.at(-1);
  assert.equal(recorded.headers.cookie, "other=1");
  assert.equal(recorded.headers["x-orbit-route-signature"], undefined);
  assert.equal(recorded.headers["x-dsh-authenticated-proxy"], undefined);
  assert.equal(recorded.headers["x-dsh-operator-id"], undefined);
  assert.equal(recorded.headers["x-gateway-auth"], undefined);
  assert.equal(recorded.headers["x-gateway-secret"], undefined);
  assert.equal(recorded.headers.accept, "text/html");
  client.stop();
  await dsh.close();
  await close();
  registry.close();
});
