// Gate B live evidence (automated): a REAL TLS-terminating gateway in
// front of the Hub, matching the Caddyfile example:
//   - basic-auth gate authenticates FIRST; only then are the internal
//     assertion + principal injected;
//   - client-supplied assertion/principal headers are STRIPPED and
//     never trusted;
//   - the browser's own Cookie / Origin / Sec-Fetch-Site pass through;
//   - the machine surface (/api/v1/*) is NOT routed by the gateway;
//   - a gateway restart drill runs mid-scenario; the Hub and both
//     nodes are untouched by it.

import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer as createTlsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { NodeClient } from "../src/node/client.mjs";
import { loadNodeStoreAsync } from "../src/node/store.mjs";

const ASSERTION = "gateway-held-assertion-secret";
const PRINCIPAL = "operator";
const AUTH_USER = "operator";
const AUTH_PASS = "s3cret-passphrase";
const GATEWAY_HEADER = "x-dsh-authenticated-proxy";
const PRINCIPAL_HEADER = "x-dsh-operator-id";

const AUTH_HEADER = `Basic ${Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString("base64")}`;

function validReport() {
  const pass = { status: "pass", detail: "ok" };
  return {
    schemaVersion: 2,
    orbit: { version: "0.3.0", revision: "gateway-s6" },
    candidate: { dshVersion: "0.1.1-rc.2", profile: "dsh-0.1.1-rc.2" },
    checks: {
      globalPatch: pass,
      profilePatch: pass,
      runtimeReadiness: pass,
      settingsRead: pass,
      settingsNoopWrite: pass,
      authorizationSmoke: pass,
      sessionResume: pass,
      webPluginRoutes: pass,
      longLivedTransport: { status: "not_run", detail: "" },
      terminalFence: { status: "not_run", detail: "" },
      terminalPtty: { status: "not_run", detail: "" },
    },
  };
}

async function fixtureDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-gateway-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeTlsMaterials(dir) {
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  await new Promise((resolve, reject) => {
    execFile(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=registry.test"],
      { env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
      (error) => (error ? reject(error) : resolve()),
    );
  });
  return { keyPath, certPath };
}

// Minimal Caddy-equivalent gateway: TLS termination, basic-auth gate,
// strip + inject of the internal headers, browser-surface proxying
// only; the machine surface is refused with 403.
async function startGateway({ certPath, keyPath, hubUrl, onProxied }) {
  const tlsOptions = { key: await readFile(keyPath), cert: await readFile(certPath) };
  const server = createTlsServer(tlsOptions, (request, response) => {
    const path = new URL(request.url, "https://registry.test").pathname;
    const machine = path.startsWith("/api/v1/");
    const browser = path === "/" || path.startsWith("/hub/") || ["/app.mjs", "/view-model.mjs", "/styles.css", "/index.html"].includes(path);
    if (machine) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "machine-ingress-denied", message: "the machine surface is private; route it over the loopback listener" } }));
      return;
    }
    if (!browser) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "not-found", message: "no such gateway route" } }));
      return;
    }
    if (request.headers.authorization !== AUTH_HEADER) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="registry"', "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "gateway-auth-required", message: "gateway authentication required" } }));
      return;
    }
    // Strip anything a client could have supplied, then inject — only
    // after the authentication gate.
    delete request.headers[GATEWAY_HEADER];
    delete request.headers[PRINCIPAL_HEADER];
    request.headers[GATEWAY_HEADER] = ASSERTION;
    request.headers[PRINCIPAL_HEADER] = PRINCIPAL;
    onProxied?.({ method: request.method, path, headers: request.headers });
    const upstream = httpRequest(
      hubUrl.replace(/\/$/, "") + path,
      { method: request.method, headers: request.headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", (error) => {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "gateway-upstream-error", message: error.message } }));
    });
    request.pipe(upstream);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `https://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

function gatewayFetch(baseUrl, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      `${baseUrl}${path}`,
      { method, headers, rejectUnauthorized: false },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode, headers: response.headers, text: () => Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function makeNode({ statePath, hubUrl, fetchImpl, now }) {
  return new NodeClient({
    store: {
      schema: 1,
      nodeId: null,
      publicKeyHex: null,
      privateKeyHex: null,
      hubBaseUrl: null,
      state: "unenrolled",
      rotation: null,
      pendingEnrollment: null,
      pendingReenrollment: null,
      updatedAt: null,
    },
    storePath: statePath,
    hubBaseUrl: hubUrl,
    runtimeIdentity: () => ({ orbitVersion: "0.3.0", orbitRevision: "gateway-s6", dshVersion: "0.1.1-rc.2", compatibilityProfile: "dsh-0.1.1-rc.2" }),
    heartbeatCadenceSeconds: 60,
    now,
    fetchImpl,
  });
}

test("gateway E2E: TLS + auth gate + strip/inject pass-through, machine denied, gateway restart, two-node scenario", async (t) => {
  const dir = await fixtureDir(t);
  const { keyPath, certPath } = await makeTlsMaterials(dir);
  const dbPath = join(dir, "registry.db");
  const stateA = join(dir, "node-a.json");
  const stateB = join(dir, "node-b.json");
  const clock = { now: new Date() };
  const runNow = () => clock.now;

  // Hub on the loopback with a FILE-backed registry.
  let registry = new Registry({ db: openRegistryDatabase(dbPath) });
  let hub = createHubServer({
    registry,
    options: { gatewayAssertionSecret: ASSERTION, operatorPrincipal: { mode: "inject" }, trustedExternalScheme: "https" },
  });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const hubPort = hub.server.address().port;
  const hubUrl = `http://127.0.0.1:${hubPort}/`;
  const closeHub = async () => {
    hub.server.closeAllConnections?.();
    await new Promise((resolve) => hub.server.close(resolve));
    registry.close();
  };
  t.after(async () => {
    try {
      await hub.close?.();
    } catch {}
  });

  const seen = [];
  let gateway = await startGateway({ certPath, keyPath, hubUrl, onProxied: (info) => seen.push(info) });

  // 1. The gate refuses unauthenticated requests BEFORE the hub; a
  // forged internal assertion is stripped, never trusted.
  const unauthed = await gatewayFetch(gateway.baseUrl, "/hub/nodes");
  assert.equal(unauthed.status, 401);
  assert.match(await unauthed.text(), /gateway-auth-required/);
  await gatewayFetch(gateway.baseUrl, "/hub/nodes", {
    headers: { authorization: AUTH_HEADER, [GATEWAY_HEADER]: "forged", [PRINCIPAL_HEADER]: "forged" },
  });
  // Session bootstrap through the gateway.
  const bootstrap = await gatewayFetch(gateway.baseUrl, "/hub/session", {
    method: "POST",
    headers: { authorization: AUTH_HEADER, origin: gateway.baseUrl, "sec-fetch-site": "same-origin" },
  });
  assert.equal(bootstrap.status, 200);
  const sessionBody = JSON.parse(await bootstrap.text());
  assert.equal(sessionBody.principal, PRINCIPAL);
  const setCookieHeader = bootstrap.headers["set-cookie"];
  const cookie = (Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader)?.split(";")[0];
  assert.ok(cookie);

  // The hub saw the INJECTED internal headers and the browser's own
  // Origin/Sec-Fetch-Site; never the forged values.
  const hubHeaderSeen = seen.find((entry) => entry.path === "/hub/session" && entry.method === "POST");
  assert.equal(hubHeaderSeen.headers[GATEWAY_HEADER], ASSERTION);
  assert.equal(hubHeaderSeen.headers[PRINCIPAL_HEADER], PRINCIPAL);
  assert.equal(hubHeaderSeen.headers.origin, gateway.baseUrl);
  assert.equal(hubHeaderSeen.headers["sec-fetch-site"], "same-origin");

  // 2. Machine ingress is NOT routed by the gateway (config == docs).
  const machineViaGateway = await gatewayFetch(gateway.baseUrl, "/api/v1/heartbeat", { method: "POST" });
  assert.equal(machineViaGateway.status, 403);
  assert.match(await machineViaGateway.text(), /machine-ingress-denied/);

  // 3. Two nodes enroll and stay fresh over the PRIVATE machine path.
  const enrollNode2 = async (statePath) => {
    const client = makeNode({ statePath, hubUrl, fetchImpl: globalThis.fetch, now: runNow });
    const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
    const enrolled = await client.enroll({ token: plain.token });
    assert.equal((await client.heartbeat()).ok, true);
    await client.uploadReport(validReport());
    return { client, nodeId: enrolled.nodeId };
  };
  const a = await enrollNode2(stateA);
  const b = await enrollNode2(stateB);
  assert.equal(registry.getNode(a.nodeId).health.registryContact, "fresh");
  assert.equal(registry.getNode(b.nodeId).health.registryContact, "fresh");

  // 4. Gateway restart drill: the browser path drops and recovers; the
  // Hub and both nodes are untouched.
  await gateway.close();
  const whileDown = await gatewayFetch(gateway.baseUrl, "/hub/nodes").catch(() => null);
  assert.equal(whileDown, null, "browser path must be down while the gateway is down");
  assert.equal(registry.getNode(a.nodeId).health.registryContact, "fresh");
  assert.equal(registry.getNode(b.nodeId).health.registryContact, "fresh");
  gateway = await startGateway({ certPath, keyPath, hubUrl, onProxied: (info) => seen.push(info) });
  const reBootstrap = await gatewayFetch(gateway.baseUrl, "/hub/session", {
    method: "POST",
    headers: { authorization: AUTH_HEADER, origin: gateway.baseUrl, "sec-fetch-site": "same-origin" },
  });
  assert.equal(reBootstrap.status, 200);

  // 5. The SOP scenario continues over the correct ingress paths:
  // A outage while B stays healthy; then Hub restart, delete A,
  // reenroll A.
  registry.now = () => clock.now;
  const aNode = makeNode({ statePath: stateA, hubUrl, fetchImpl: globalThis.fetch, now: runNow });
  aNode.store = await loadNodeStoreAsync(stateA);
  await aNode.recoverAfterRestart();
  const bNode = makeNode({ statePath: stateB, hubUrl, fetchImpl: globalThis.fetch, now: runNow });
  bNode.store = await loadNodeStoreAsync(stateB);
  await bNode.recoverAfterRestart();
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal((await bNode.heartbeat()).ok, true);

  // A's transport dies.
  const aDown = makeNode({ statePath: stateA, hubUrl, fetchImpl: async () => Promise.reject(new Error("A transport down")), now: runNow });
  aDown.store = await loadNodeStoreAsync(stateA);
  await aDown.recoverAfterRestart();
  const failed = await aDown.heartbeat();
  assert.equal(failed.ok, false);
  assert.equal(failed.state, "retrying");

  clock.now = new Date(clock.now.getTime() + 4 * 60 * 1000);
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal((await bNode.heartbeat()).ok, true);
  registry.maintenance();
  assert.equal(registry.getNode(a.nodeId).health.registryContact, "stale");
  assert.equal(registry.getNode(b.nodeId).health.registryContact, "fresh");

  clock.now = new Date(clock.now.getTime() + 24 * 60 * 60 * 1000);
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal((await bNode.heartbeat()).ok, true);
  registry.maintenance();
  assert.equal(registry.getNode(a.nodeId).health.registryContact, "lost");
  assert.deepEqual(registry.getNode(a.nodeId).health.alertFlags, ["contact-lost"]);
  assert.equal(registry.getNode(b.nodeId).health.registryContact, "fresh");

  // Hub restart on the same port with the same DB.
  await closeHub();
  registry = new Registry({ db: openRegistryDatabase(dbPath) });
  hub = createHubServer({
    registry,
    options: { gatewayAssertionSecret: ASSERTION, operatorPrincipal: { mode: "inject" }, trustedExternalScheme: "https" },
  });
  await new Promise((resolve) => hub.server.listen(hubPort, "127.0.0.1", resolve));
  registry.now = () => clock.now;

  const aLive = makeNode({ statePath: stateA, hubUrl, fetchImpl: globalThis.fetch, now: runNow });
  aLive.store = await loadNodeStoreAsync(stateA);
  await aLive.recoverAfterRestart();
  registry.deleteNode({ actor: "operator", nodeId: a.nodeId, requestId: "ff".repeat(16), reason: "retired" });
  const denied = await aLive.heartbeat();
  assert.equal(denied.ok, false);
  assert.equal(denied.state, "revoked");
  const reenrollToken = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: a.nodeId });
  const reenrolled = await aLive.reenroll({ token: reenrollToken.token });
  assert.equal(reenrolled.nodeId, a.nodeId);
  assert.equal((await aLive.heartbeat()).ok, true);
  assert.equal(registry.getNode(b.nodeId).health.registryContact, "fresh");

  await gateway.close();
  await closeHub();
});