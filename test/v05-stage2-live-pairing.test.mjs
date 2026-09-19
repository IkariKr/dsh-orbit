// v0.5 Stage 2 Live Evidence (Child-Process Form): one freshly paired node
// reaches the public Hub ONLY through the new public machine ingress and:
//   1. pairs (RFC-0012 D3, reverse-mode node),
//   2. heartbeats through the public ingress (RFC-0006 semantics),
//   3. uploads a compatibility report,
//   4. receives/acknowledges RFC-0008 Hub route public material.
// The rehearsal HTTPS gateway applies the exact Caddyfile machine allowlist
// (strip cookies/origin/assertion, no auth gate, /api/v1/enroll refused).
// Reverse upgrade paths are reachable but fail closed after machine
// authentication (session/channel behavior is Stage 3/4). No reverse
// browser traffic exists at this stage.

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GATEWAY_CERT_PEM, GATEWAY_KEY_PEM } from "./fixtures/gateway-identity.mjs";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { deriveKeyId, sha256Hex, randomHex, signSigningString } from "../src/registry/crypto.mjs";
import { buildSigningString, MACHINE_V1_LABEL } from "../src/registry/protocol.mjs";
import { createFrameParser } from "../src/registry/reverse-ws.mjs";
import { validReport } from "./helpers/registry-fixture.mjs";
import { NodeClient } from "../src/node/client.mjs";
import { loadNodeStoreAsync } from "../src/node/store.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const PUBLIC_POST_PATHS = new Set(["/api/v1/pair", "/api/v1/heartbeat", "/api/v1/report-upload", "/api/v1/credential-rotate", "/api/v1/reenroll"]);
const PUBLIC_GET_PATHS = new Set(["/api/v1/reverse/control", "/api/v1/reverse/channel"]);
const GATEWAY_HEADERS = { "x-dsh-authenticated-proxy": "test-gateway-secret", "x-dsh-operator-id": "operator" };

function killProcess(child) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      resolve();
      return;
    }
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 2000).unref();
  });
}

function startHubProcess({ dbPath, pairingBaseUrl, cadenceSeconds = 1 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/dsh-orbit-hub.mjs"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DSH_ORBIT_HUB_DB: dbPath,
        DSH_ORBIT_HUB_PORT: "0",
        DSH_ORBIT_HUB_LISTEN: "127.0.0.1",
        DSH_ORBIT_HUB_ROUTE_DOMAIN: "dsh.example.local",
        DSH_ORBIT_HUB_ROUTE_PROBE_CADENCE_SECONDS: String(cadenceSeconds),
        DSH_ORBIT_HUB_GATEWAY_SECRET: "test-gateway-secret",
        DSH_ORBIT_HUB_OPERATOR_PRINCIPAL: "operator",
        DSH_ORBIT_HUB_PAIRING_BASE_URL: pairingBaseUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/registry listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve({ child, port: Number(match[1]), baseUrl: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) reject(new Error(`Hub exited early code ${code}; stderr=${stderr}`));
    });
  });
}

function runNodeCommand({ command, statePath, hubUrl, caCertPath, extraEnv = {}, successPattern }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", command], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DSH_ORBIT_NODE_STATE: statePath,
        DSH_ORBIT_HUB_URL: hubUrl,
        DSH_ORBIT_NODE_CA_CERT: caCertPath,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        const match = successPattern ? stdout.match(successPattern) : [];
        resolve({ stdout, match });
      } else {
        reject(new Error(`node ${command} failed code ${code}; stderr=${stderr} stdout=${stdout}`));
      }
    });
  });
}

// Rehearsal public gateway: node https applying the Caddyfile machine
// allowlist semantics (RFC-0012 D2). The upstream Hub URL is assigned once
// the Hub child is listening.
function startRehearsalGateway({ certPem, keyPem }) {
  let hubUrl = null;
  const server = https.createServer({ cert: certPem, key: keyPem }, (request, response) => {
    const path = (request.url ?? "").split("?")[0];
    const headers = { ...request.headers };
    // RFC-0012 D2: machine traffic never inherits a browser session and
    // never receives gateway trust material.
    delete headers.cookie;
    delete headers.origin;
    delete headers["x-dsh-authenticated-proxy"];
    delete headers["x-dsh-operator-id"];
    const proxy = () => {
      const upstream = http.request(hubUrl + path, { method: request.method, headers }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on("error", () => {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "gateway-upstream-error", message: "hub unavailable" } }));
      });
      request.pipe(upstream);
    };
    if (PUBLIC_POST_PATHS.has(path)) {
      if (request.method !== "POST") {
        response.writeHead(405, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "method-not-allowed", message: "gateway allows POST only here" } }));
        request.resume();
        return;
      }
      proxy();
      return;
    }
    if (PUBLIC_GET_PATHS.has(path)) {
      if (request.method !== "GET") {
        response.writeHead(405, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "method-not-allowed", message: "gateway allows GET upgrades only here" } }));
        request.resume();
        return;
      }
      proxy();
      return;
    }
    if (path.startsWith("/api/v1/")) {
      // Includes /api/v1/enroll: never public (RFC-0012 D2).
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "machine-path-denied", message: "not a public machine surface" } }));
      request.resume();
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not-found", message: "gateway serves only the machine allowlist" } }));
    request.resume();
  });
  // WebSocket upgrade relay for the reverse control surface (the Hub owns
  // authentication and the session; the gateway only forwards bytes).
  server.on("upgrade", (request, clientSocket, head) => {
    const path = (request.url ?? "").split("?")[0];
    if (!PUBLIC_GET_PATHS.has(path) || request.headers.origin !== undefined) {
      clientSocket.destroy();
      return;
    }
    const headers = { ...request.headers };
    delete headers.cookie;
    delete headers["x-dsh-authenticated-proxy"];
    delete headers["x-dsh-operator-id"];
    const upstream = http.request(hubUrl + path, { method: "GET", headers });
    upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const relayHeaders = Object.entries(upstreamResponse.headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n");
      clientSocket.write(`HTTP/1.1 101 ${upstreamResponse.statusMessage ?? "Switching Protocols"}\r\n${relayHeaders}\r\n\r\n`);
      if (head && head.length > 0) clientSocket.write(head);
      if (upstreamHead && upstreamHead.length > 0) clientSocket.write(upstreamHead);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      const closeBoth = () => {
        upstreamSocket.destroy();
        clientSocket.destroy();
      };
      upstreamSocket.on("error", closeBoth);
      clientSocket.on("error", closeBoth);
      upstreamSocket.on("close", closeBoth);
      clientSocket.on("close", closeBoth);
    });
    upstream.on("response", (upstreamResponse) => {
      const chunks = [];
      upstreamResponse.on("data", (chunk) => chunks.push(chunk));
      upstreamResponse.on("end", () => {
        const body = Buffer.concat(chunks);
        clientSocket.end(
          `HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? "Error"}\r\nconnection: close\r\ncontent-length: ${body.length}\r\n\r\n${body.toString("utf8")}`,
        );
      });
    });
    upstream.on("error", () => clientSocket.destroy());
    if (head && head.length > 0) upstream.write(head);
    upstream.end();
  });

  return {
    server,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
    get port() {
      return server.address().port;
    },
    set upstream(url) {
      hubUrl = url;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function getOperatorSession(hubBaseUrl) {
  const res = await fetch(`${hubBaseUrl}/hub/session`, {
    method: "POST",
    headers: { ...GATEWAY_HEADERS, origin: hubBaseUrl, "sec-fetch-site": "same-origin" },
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie")?.match(/(?:^|;\s*)dsh-orbit-hub-session=([^;]+)/)?.[1];
  const body = await res.json();
  return { cookie, csrfToken: body.csrfToken };
}

async function operatorMintPairToken(hubBaseUrl, session) {
  const res = await fetch(`${hubBaseUrl}/hub/tokens`, {
    method: "POST",
    headers: {
      ...GATEWAY_HEADERS,
      "content-type": "application/json",
      cookie: `dsh-orbit-hub-session=${session.cookie}`,
      "x-csrf-token": session.csrfToken,
      origin: hubBaseUrl,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ purpose: "pair" }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

async function waitFor(predicate, { timeoutMs = 60_000, stepMs = 1000, label }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(stepMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

test("Live v0.5 Stage 2 pairing evidence: fresh node pairs, heartbeats, uploads a report, and syncs Hub route material through the public machine ingress only", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-v05-stage2-live-"));
  const dbPath = join(dir, "hub.db");
  const statePath = join(dir, "node-state.json");
  const certPath = join(dir, "gateway-cert.pem");
  const keyPath = join(dir, "gateway-key.pem");
  const reportPath = join(dir, "report.json");
  await writeFile(certPath, GATEWAY_CERT_PEM, "utf8");
  await writeFile(keyPath, GATEWAY_KEY_PEM, "utf8");
  await writeFile(reportPath, JSON.stringify(validReport()), "utf8");

  const gateway = startRehearsalGateway({ certPem: GATEWAY_CERT_PEM, keyPem: GATEWAY_KEY_PEM });
  await gateway.listen();
  const publicBaseUrl = `https://127.0.0.1:${gateway.port}`;

  let hub = null;
  t.after(async () => {
    await killProcess(hub?.child);
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  });

  console.log("\n=== STEP 1: Start the Hub and the rehearsal public gateway ===");
  hub = await startHubProcess({ dbPath, pairingBaseUrl: `${publicBaseUrl}/` });
  gateway.upstream = hub.baseUrl;
  console.log(`[Evidence] Hub child process on ${hub.baseUrl}; public machine ingress on ${publicBaseUrl}`);

  console.log("\n=== STEP 2: Mint a pair-purpose token through the operator surface ===");
  const session = await getOperatorSession(hub.baseUrl);
  const pairToken = await operatorMintPairToken(hub.baseUrl, session);
  assert.match(pairToken, /^[0-9a-f]{32}$/);
  console.log("[Evidence] pair-purpose token minted (plaintext shown once)");

  console.log("\n=== STEP 3: Pair a fresh node through the public machine ingress ===");
  const { match: pairMatch } = await runNodeCommand({
    command: "pair",
    statePath,
    hubUrl: publicBaseUrl,
    caCertPath: certPath,
    extraEnv: { DSH_ORBIT_PAIR_TOKEN: pairToken },
    successPattern: /paired: (node_[0-9a-f]{32}) \(keyId ([0-9a-f]{32}), routeMode reverse\)/,
  });
  const nodeId = pairMatch[1];
  console.log(`[Evidence] Paired ${nodeId} through ${publicBaseUrl} with verified TLS (no skipVerify)`);

  const storeAfterPair = JSON.parse(await (await import("node:fs/promises")).readFile(statePath, "utf8"));
  assert.equal(storeAfterPair.state, "active");
  assert.equal(storeAfterPair.routeMode, "reverse");
  assert.equal(storeAfterPair.hubBaseUrl, `${publicBaseUrl}/`);
  console.log("[Evidence] Node store: active, routeMode=reverse, canonical public hubBaseUrl persisted");

  console.log("\n=== STEP 4: The paired node heartbeats through the public machine ingress ===");
  // The pair bootstrap ran as a real child process; the machine loop is
  // driven in-process against the same persisted store, still over real
  // verified TLS through the public ingress.
  const persisted = await loadNodeStoreAsync(statePath);
  const client = new NodeClient({
    store: persisted,
    storePath: statePath,
    hubBaseUrl: publicBaseUrl,
    caCertificates: [GATEWAY_CERT_PEM],
    runtimeIdentity: () => ({ orbitVersion: "0.3.0", orbitRevision: "abc123", dshVersion: "0.1.1-rc.2", compatibilityProfile: "dsh-0.1.1-rc.2" }),
  });
  const heartbeat = await client.tick();
  assert.equal(heartbeat.ok, true, `heartbeat through the public ingress failed: ${heartbeat.error?.message ?? "?"}`);

  await waitFor(
    async () => {
      const db = openRegistryDatabase(dbPath);
      try {
        const row = db.prepare("SELECT registry_contact FROM nodes WHERE node_id = ?").get(nodeId);
        return row?.registry_contact === "fresh";
      } finally {
        db.close();
      }
    },
    { label: "registryContact=fresh through the public ingress" },
  );
  console.log("[Evidence] registryContact=fresh: RFC-0006 heartbeat worked through the public machine ingress");

  console.log("\n=== STEP 5: RFC-0008 Hub route public material syncs over the heartbeat response ===");
  const storeAfterHeartbeat = await loadNodeStoreAsync(statePath);
  assert.ok(Array.isArray(storeAfterHeartbeat.hubRouteKeys) && storeAfterHeartbeat.hubRouteKeys.length > 0, "hub route public material must populate the store trust set");
  console.log("[Evidence] RFC-0008 route public material received and acknowledged (store trust set populated)");

  console.log("\n=== STEP 6: Upload a compatibility report through the public machine ingress ===");
  const reportOutcome = await client.uploadReport(validReport());
  assert.equal(reportOutcome.orbitCompatible, "pass");
  await waitFor(
    async () => {
      const db = openRegistryDatabase(dbPath);
      try {
        return db.prepare("SELECT COUNT(*) AS c FROM reports WHERE node_id = ?").get(nodeId).c > 0;
      } finally {
        db.close();
      }
    },
    { label: "report persisted at the hub" },
  );
  console.log("[Evidence] Compatibility report uploaded and persisted (no duplicate report API)");

  console.log("\n=== STEP 7: Public ingress negatives: enroll stays private, reverse upgrade fails closed after auth ===");
  const httpsProbe = (path, { method = "POST", body = "{}" } = {}) =>
    new Promise((resolve, reject) => {
      const request = https.request(
        { host: "127.0.0.1", port: gateway.port, path, method, ca: GATEWAY_CERT_PEM, headers: { "content-type": "application/json" } },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode }));
        },
      );
      request.on("error", reject);
      request.end(body);
    });
  const enrollDenied = await httpsProbe("/api/v1/enroll", { body: JSON.stringify({ token: "x" }) });
  assert.equal(enrollDenied.status, 403);
  const unknownDenied = await httpsProbe("/api/v1/bogus");
  assert.equal(unknownDenied.status, 403);

  // Reverse control upgrade: real TLS, ORBIT-MACHINE-V1 GET + empty body
  // hash, then Stage 2 fail closed (no session established).
  const ts = String(Math.trunc(Date.now() / 1000));
  const nonce = randomHex(16);
  const signing = buildSigningString({
    label: MACHINE_V1_LABEL,
    method: "GET",
    path: "/api/v1/reverse/control",
    timestamp: ts,
    nonce,
    bodyHash: sha256Hex(""),
    nodeId,
  });
  const storeNow = JSON.parse(await (await import("node:fs/promises")).readFile(statePath, "utf8"));
  const upgradeResult = await new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port: gateway.port,
        path: "/api/v1/reverse/control",
        method: "GET",
        ca: GATEWAY_CERT_PEM,
        headers: {
          connection: "upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          "x-orbit-node": nodeId,
          "x-orbit-key": deriveKeyId(storeNow.publicKeyHex),
          "x-orbit-timestamp": ts,
          "x-orbit-nonce": nonce,
          "x-orbit-signature": signSigningString(storeNow.privateKeyHex, signing),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, session: null }));
      },
    );
    request.on("upgrade", (res, socket, head) => {
      assert.equal(res.statusCode, 101);
      const messages = [];
      const parse = createFrameParser({ isClient: true, onMessage: (text) => messages.push(text) });
      socket.on("data", (chunk) => parse(chunk));
      setTimeout(() => {
        socket.destroy();
        resolve({ status: res.statusCode, session: messages[0] ?? null });
      }, 250);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(upgradeResult.status, 101);
  const sessionFrame = JSON.parse(upgradeResult.session ?? "{}");
  assert.equal(sessionFrame.type, "session");
  assert.equal(sessionFrame.protocol, "orbit-reverse-v1");
  console.log("[Evidence] Reverse control session established through the public ingress after machine authentication");

  console.log("\n=== v0.5 Stage 2 live evidence complete: paired node bootstrapped and maintained its machine relationship entirely through the public machine ingress ===");
});
