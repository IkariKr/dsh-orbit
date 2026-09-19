// v0.5 Stage 2: public reverse machine ingress and pairing bootstrap
// (docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md Stage 2;
// RFC-0012 D2/D3). The exact machine allowlist becomes reachable over the
// authenticated public gateway path; reverse upgrades authenticate with
// the existing ORBIT-MACHINE-V1 rules and then fail closed (session and
// channel behavior is Stage 3/4). /api/v1/enroll is never public.

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { generateNodeKeyPair, randomHex, sha256Hex, signSigningString } from "../src/registry/crypto.mjs";
import { buildSigningString, MACHINE_V1_LABEL } from "../src/registry/protocol.mjs";
import { createMachineIngressServer } from "../src/registry/machine-ingress.mjs";
import { createTestRegistry, createTestServer } from "./helpers/registry-fixture.mjs";
import { NodeClient } from "../src/node/client.mjs";
import { emptyNodeStore, loadNodeStoreAsync } from "../src/node/store.mjs";

const PAIRING_HUB_BASE_URL = "https://hub.example.com/";

function pairRegistry(options = {}) {
  return createTestRegistry({ pairingHubBaseUrl: PAIRING_HUB_BASE_URL, ...options });
}

async function post(baseUrl, path, body, extraHeaders = {}) {
  const response = await fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

// Raw WebSocket-upgrade probe carrying ORBIT-MACHINE-V1 headers. The Hub
// answers non-101 rejections as plain HTTP responses on the socket.
function upgradeProbe(baseUrl, path, { nodeId, keyId, privateKeyHex, nonce, timestamp, origin, extraHeaders = {} }) {
  const url = new URL(baseUrl);
  const ts = String(timestamp ?? Math.trunc(Date.now() / 1000));
  const freshNonce = nonce ?? randomHex(16);
  const bodyHash = sha256Hex("");
  const signing = buildSigningString({ label: MACHINE_V1_LABEL, method: "GET", path, timestamp: ts, nonce: freshNonce, bodyHash, nodeId });
  const headers = {
    host: url.host,
    connection: "upgrade",
    upgrade: "websocket",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
    ...(origin ? { origin } : {}),
    ...(nodeId
      ? {
          "x-orbit-node": nodeId,
          "x-orbit-timestamp": ts,
          "x-orbit-nonce": freshNonce,
          "x-orbit-key": keyId,
          "x-orbit-signature": signSigningString(privateKeyHex, signing),
        }
      : {}),
    ...extraHeaders,
  };
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: url.hostname, port: url.port, path, method: "GET", headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }),
        );
        response.on("error", reject);
      },
    );
    request.on("upgrade", (upgradeResponse, upgradeSocket) => {
      upgradeSocket.destroy();
      resolve({ status: upgradeResponse.statusCode, body: {} });
    });
    request.on("error", reject);
    request.end();
  });
}

async function enrollActiveNode(baseUrl, registry) {
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const keys = generateNodeKeyPair();
  const result = registry.enroll({ token: minted.token, enrollmentRequestId: randomHex(16), publicKey: keys.publicKeyHex });
  return { ...result, privateKeyHex: keys.privateKeyHex };
}

test("pair over the machine API succeeds with a valid token and returns the canonical public hubBaseUrl", async (t) => {
  const registry = pairRegistry();
  const { baseUrl, close } = await createTestServer(registry, { pairingHubBaseUrl: PAIRING_HUB_BASE_URL });
  t.after(close);
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "pair" });
  const keys = generateNodeKeyPair();
  const requestId = randomHex(16);
  const first = await post(baseUrl, "/api/v1/pair", { token: minted.token, pairingRequestId: requestId, publicKey: keys.publicKeyHex });
  assert.equal(first.status, 200);
  assert.equal(first.body.routeMode, "reverse");
  assert.equal(first.body.hubBaseUrl, PAIRING_HUB_BASE_URL);
  assert.equal(first.body.reverseProtocol, "orbit-reverse-v1");
  // Exact replay over the wire returns the exact recorded result.
  const replay = await post(baseUrl, "/api/v1/pair", { token: minted.token, pairingRequestId: requestId, publicKey: keys.publicKeyHex });
  assert.deepEqual(replay.body, first.body);
  // An enroll-purpose token cannot pair over the same surface.
  const enrollToken = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const wrongPurpose = await post(baseUrl, "/api/v1/pair", { token: enrollToken.token, pairingRequestId: randomHex(16), publicKey: keys.publicKeyHex });
  assert.equal(wrongPurpose.status, 400);
  assert.equal(wrongPurpose.body.error.code, "purpose-mismatch");
  // Denied responses never echo the token back.
  assert.ok(!JSON.stringify(wrongPurpose.body).includes(enrollToken.token));
  await close();
  registry.close();
});

test("wrong method on pair, plain requests on reverse paths, and unknown machine paths fail closed", async (t) => {
  const registry = pairRegistry();
  const { baseUrl, close } = await createTestServer(registry, { pairingHubBaseUrl: PAIRING_HUB_BASE_URL });
  t.after(close);

  const getPair = await fetch(baseUrl + "/api/v1/pair");
  assert.equal(getPair.status, 405);

  for (const path of ["/api/v1/reverse/control", "/api/v1/reverse/channel"]) {
    const plain = await fetch(baseUrl + path);
    assert.equal(plain.status, 426, `${path} without upgrade must be 426`);
    const withOrigin = await fetch(baseUrl + path, { headers: { origin: "https://evil.example" } });
    assert.equal(withOrigin.status, 403);
    assert.equal((await withOrigin.json()).error.code, "origin-forbidden");
    const posted = await post(baseUrl, path, {});
    assert.equal(posted.status, 405);
  }

  const unknown = await post(baseUrl, "/api/v1/bogus", {});
  assert.equal(unknown.status, 404);
  await close();
  registry.close();
});

test("reverse control upgrade authenticates with ORBIT-MACHINE-V1 over GET + empty body hash and establishes a session; the channel surface stays Stage 4 fail-closed", async (t) => {
  const registry = pairRegistry();
  const { baseUrl, reverseSessions, close } = await createTestServer(registry, { pairingHubBaseUrl: PAIRING_HUB_BASE_URL });
  t.after(close);
  const node = await enrollActiveNode(baseUrl, registry);

  const control = await upgradeProbe(baseUrl, "/api/v1/reverse/control", {
    nodeId: node.nodeId,
    keyId: node.keyId,
    privateKeyHex: node.privateKeyHex,
  });
  assert.equal(control.status, 101, "the control upgrade must succeed after machine authentication");

  const channel = await upgradeProbe(baseUrl, "/api/v1/reverse/channel", {
    nodeId: node.nodeId,
    keyId: node.keyId,
    privateKeyHex: node.privateKeyHex,
  });
  assert.equal(channel.status, 503);
  assert.equal(channel.body.error.code, "reverse-channel-unavailable");
  await close();
  registry.close();
});

test("reverse upgrade security: Origin 403, signature binding, nonce replay, skew, and no credential substitution", async (t) => {
  const registry = pairRegistry();
  const { baseUrl, close } = await createTestServer(registry, { pairingHubBaseUrl: PAIRING_HUB_BASE_URL });
  t.after(close);
  const node = await enrollActiveNode(baseUrl, registry);
  const probeArgs = { nodeId: node.nodeId, keyId: node.keyId, privateKeyHex: node.privateKeyHex };

  // Origin is rejected 403 before the upgrade regardless of signature.
  const withOrigin = await upgradeProbe(baseUrl, "/api/v1/reverse/control", { ...probeArgs, origin: "https://evil.example" });
  assert.equal(withOrigin.status, 403);
  assert.equal(withOrigin.body.error.code, "origin-forbidden");

  // A signature for another path cannot authenticate the upgrade.
  const wrongPathTs = String(Math.trunc(Date.now() / 1000));
  const wrongPathNonce = randomHex(16);
  const wrongPathSigning = buildSigningString({
    label: MACHINE_V1_LABEL,
    method: "GET",
    path: "/api/v1/heartbeat",
    timestamp: wrongPathTs,
    nonce: wrongPathNonce,
    bodyHash: sha256Hex(""),
    nodeId: node.nodeId,
  });
  const wrongPath = await upgradeProbe(baseUrl, "/api/v1/reverse/control", {
    nodeId: node.nodeId,
    keyId: node.keyId,
    privateKeyHex: node.privateKeyHex,
    nonce: wrongPathNonce,
    timestamp: wrongPathTs,
    extraHeaders: { "x-orbit-signature": signSigningString(node.privateKeyHex, wrongPathSigning) },
  });
  assert.equal(wrongPath.status, 401);

  // Missing signature is denied.
  const unsigned = await upgradeProbe(baseUrl, "/api/v1/reverse/control", {});
  assert.equal(unsigned.status, 400);

  // Gateway assertion / browser cookies cannot substitute for machine auth.
  const asserted = await upgradeProbe(baseUrl, "/api/v1/reverse/control", {
    extraHeaders: {
      "x-dsh-authenticated-proxy": "gateway-secret",
      "x-dsh-operator-id": "operator",
      cookie: "dsh-orbit-hub-session=forged",
    },
  });
  assert.equal(asserted.status, 400);

  // Stale timestamp is denied.
  const stale = await upgradeProbe(baseUrl, "/api/v1/reverse/control", { ...probeArgs, timestamp: Math.trunc(Date.now() / 1000) - 120 });
  assert.equal(stale.status, 401);
  assert.equal(stale.body.error.code, "timestamp-out-of-skew");

  // Nonce replay is denied (the reservation is persistent/transactional).
  const replayNonce = randomHex(16);
  const replayTs = String(Math.trunc(Date.now() / 1000));
  const first = await upgradeProbe(baseUrl, "/api/v1/reverse/control", { ...probeArgs, nonce: replayNonce, timestamp: replayTs });
  assert.equal(first.status, 101);
  const replay = await upgradeProbe(baseUrl, "/api/v1/reverse/control", { ...probeArgs, nonce: replayNonce, timestamp: replayTs });
  assert.equal(replay.status, 401);
  await close();
  registry.close();
});

test("machine paths are denied on node route authorities (HTTP and upgrade)", async (t) => {
  const registry = pairRegistry({ routeDomain: "dsh.example.local" });
  const { baseUrl, close } = await createTestServer(registry, { pairingHubBaseUrl: PAIRING_HUB_BASE_URL });
  t.after(close);
  const nodeHex = "a".repeat(32);
  const nodeHost = `n-${nodeHex}.dsh.example.local`;
  const url = new URL(baseUrl);

  const response = await new Promise((resolve, reject) => {
    const request = http.request(
      { host: url.hostname, port: url.port, path: "/api/v1/heartbeat", method: "GET", headers: { host: nodeHost } },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "machine-path-denied");

  const upgrade = await new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const request = http.request({
      host: url.hostname,
      port: url.port,
      path: "/api/v1/reverse/control",
      method: "GET",
      headers: { host: nodeHost, connection: "upgrade", upgrade: "websocket", "sec-websocket-key": "x", "sec-websocket-version": "13" },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
    });
    request.on("upgrade", () => reject(new Error("unexpected upgrade")));
    request.on("error", reject);
    request.end();
  });
  assert.equal(upgrade.status, 404);
  assert.equal(upgrade.body.error.code, "machine-path-denied");
  await close();
  registry.close();
});

test("the server-reachable machine listener exposes pair and the reverse surfaces to an existing node binding", async (t) => {
  const registry = pairRegistry();
  const { baseUrl, close } = await createTestServer(registry, { pairingHubBaseUrl: PAIRING_HUB_BASE_URL });
  t.after(close);
  const ingress = createMachineIngressServer({ listenPort: 0, listenHost: "127.0.0.1", upstream: baseUrl });
  await new Promise((resolve) => ingress.listen(0, "127.0.0.1", resolve));
  const ingressPort = ingress.address().port;
  t.after(() => new Promise((resolve) => ingress.close(resolve)));

  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "pair" });
  const keys = generateNodeKeyPair();
  const paired = await post(`http://127.0.0.1:${ingressPort}`, "/api/v1/pair", {
    token: minted.token,
    pairingRequestId: randomHex(16),
    publicKey: keys.publicKeyHex,
  });
  assert.equal(paired.status, 200);
  assert.equal(paired.body.routeMode, "reverse");

  // An existing registered node reaches the reverse upgrade through the
  // same listener and its persisted binding, without any rebinding.
  const node = await enrollActiveNode(baseUrl, registry);
  const probeUrl = `http://127.0.0.1:${ingressPort}`;
  const upgraded = await upgradeProbe(probeUrl, "/api/v1/reverse/control", {
    nodeId: node.nodeId,
    keyId: node.keyId,
    privateKeyHex: node.privateKeyHex,
  });
  assert.equal(upgraded.status, 101, "the reverse session establishes through the existing binding");

  // Origin never passes the ingress.
  const originBlocked = await upgradeProbe(probeUrl, "/api/v1/reverse/control", {
    nodeId: node.nodeId,
    keyId: node.keyId,
    privateKeyHex: node.privateKeyHex,
    origin: "https://evil.example",
  });
  assert.equal(originBlocked.status, 403);
  assert.equal(originBlocked.body.error.code, "origin-forbidden");

  // Non-reverse upgrade paths are refused by the ingress.
  const bogusUpgrade = await upgradeProbe(probeUrl, "/api/v1/bogus", {});
  assert.equal(bogusUpgrade.status, 403);
  await close();
  ingress.close();
  registry.close();
});

test("node pairing client persists intent before the request, adopts the reverse result, and replays after a lost response", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-v05-stage2-pair-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = pairRegistry();
  const { baseUrl, close } = await createTestServer(registry);
  t.after(close);
  // The test server's port is random: point the pairing authority at the
  // actual listener so the response binding matches the client target.
  registry.pairingHubBaseUrl = `${baseUrl}/`;
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "pair" });
  const statePath = join(dir, "node-state.json");

  // First attempt: the request commits on the Hub, but the response is lost.
  let dropNext = true;
  const losingFetch = async (url, options = {}) => {
    const real = await fetch(url, options);
    if (dropNext) {
      dropNext = false;
      throw new Error("connection lost after commit");
    }
    return real;
  };
  const losingClient = new NodeClient({
    store: emptyNodeStore(),
    storePath: statePath,
    hubBaseUrl: baseUrl,
    fetchImpl: losingFetch,
  });
  await assert.rejects(() => losingClient.pair({ token: minted.token }), /outcome unknown/);

  // A fresh client process re-attaches to the persisted store: the same
  // intent replays and adopts the Hub's recorded result.
  const persisted = await loadNodeStoreAsync(statePath);
  assert.ok(persisted.pendingPairing, "pairing intent must be persisted before the request");
  assert.equal(persisted.pendingPairing.hubBaseUrl, baseUrl.replace(/\/$/, "") + "/");
  const replayingClient = new NodeClient({ store: persisted, storePath: statePath, hubBaseUrl: baseUrl });
  const result = await replayingClient.pair({ token: minted.token });
  assert.equal(result.routeMode, "reverse");
  assert.equal(replayingClient.store.state, "active");
  assert.equal(replayingClient.store.routeMode, "reverse");
  assert.equal(replayingClient.store.nodeId, result.nodeId);
  assert.equal(replayingClient.store.pendingPairing, null);
  // The replay returned the Hub's originally recorded node, not a second one.
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS c FROM nodes").get().c, 1);
  await close();
  registry.close();
});

test("node pairing client refuses an active store and a mismatched hubBaseUrl response", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-v05-stage2-pair2-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = pairRegistry();
  const { baseUrl, close } = await createTestServer(registry);
  t.after(close);
  registry.pairingHubBaseUrl = `${baseUrl}/`;
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "pair" });
  const statePath = join(dir, "node-state.json");

  const client = new NodeClient({ store: emptyNodeStore(), storePath: statePath, hubBaseUrl: baseUrl });
  await client.pair({ token: minted.token });
  assert.equal(client.store.routeMode, "reverse");
  await assert.rejects(() => client.pair({ token: minted.token }), /requires an unenrolled store/);

  // A Hub whose configured pairing authority differs from the pairing
  // target is refused: the node never silently rebinds (RFC-0012 D2).
  const mismatchedRegistry = pairRegistry({ pairingHubBaseUrl: "http://127.0.0.1:5445/" });
  const { baseUrl: mismatchedUrl, close: mismatchedClose } = await createTestServer(mismatchedRegistry);
  t.after(mismatchedClose);
  const mismatchedToken = mismatchedRegistry.mintEnrollmentToken({ actor: "operator", purpose: "pair" });
  const mismatchedClient = new NodeClient({
    store: emptyNodeStore(),
    storePath: join(dir, "mismatch-state.json"),
    hubBaseUrl: mismatchedUrl,
  });
  await assert.rejects(() => mismatchedClient.pair({ token: mismatchedToken.token }), /does not match the pairing target/);
  await close();
  mismatchedClose();
  registry.close();
  mismatchedRegistry.close();
});

test("gateway contract: the public Caddyfile admits exactly the RFC-0012 D2 surfaces and never /api/v1/enroll", async () => {
  const caddyfile = await readFile(new URL("../docker-registry/Caddyfile.example", import.meta.url), "utf8");
  // The two admission matchers carry exactly the seven public surfaces.
  const postMatcher = caddyfile.match(/method POST\s*\n\s*path ([^\n]*)/);
  assert.ok(postMatcher, "gateway must admit the POST machine surfaces");
  assert.deepEqual(postMatcher[1].trim().split(/\s+/), [
    "/api/v1/pair",
    "/api/v1/heartbeat",
    "/api/v1/report-upload",
    "/api/v1/credential-rotate",
    "/api/v1/reenroll",
  ]);
  const getMatcher = caddyfile.match(/method GET\s*\n\s*path ([^\n]*)/);
  assert.ok(getMatcher, "gateway must admit the reverse upgrade surfaces");
  assert.deepEqual(getMatcher[1].trim().split(/\s+/), ["/api/v1/reverse/control", "/api/v1/reverse/channel"]);
  // /api/v1/enroll never appears in an admission matcher; it is denied on
  // node route authorities together with the other machine paths.
  assert.match(caddyfile, /@machineApi path \/api\/v1\/enroll \/api\/v1\/pair \/api\/v1\/heartbeat/);
  assert.match(caddyfile, /respond 404/);
  // Machine proxying strips browser/gateway credentials and injects nothing.
  for (const handleName of ["@machinePost", "@machineUpgrade"]) {
    const marker = `handle ${handleName}`;
    const start = caddyfile.indexOf(marker);
    assert.ok(start >= 0, `gateway must contain ${marker}`);
    const body = caddyfile.slice(start + marker.length, caddyfile.indexOf("}", start));
    assert.ok(!body.includes("X-DSH-Operator-Id {"), "machine proxying must not inject an operator principal");
    assert.match(body, /header_up -Cookie/, "machine proxying must strip browser cookies");
    assert.match(body, /header_up -Origin/, "machine proxying must strip Origin");
  }
});
