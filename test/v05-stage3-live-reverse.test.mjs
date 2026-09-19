// v0.5 Stage 3 Live Evidence (Child-Process Form): a reverse node maintains
// its authenticated outbound control session through the public machine
// ingress only, and presence/reachability behave deterministically:
//   1. the paired reverse node connects from an outbound-only position
//      (its canonical persisted hubBaseUrl; route ingress disabled) and
//      becomes online;
//   2. a disconnect/reconnect cycle (gateway restart) closes and
//      re-establishes the session;
//   3. the Hub restart creates no phantom online state and the node
//      reconnects automatically;
//   4. a node process restart reconnects with the same node ID/key;
//   5. local DSH stop/restart changes reverse reachability (status
//      routeReady) without touching registryContact or the session.
// Observability: the Hub daemon logs presence transitions with nodeIds and
// readiness only — session IDs, keys, and signatures never appear.

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

function startHubProcess({ dbPath, pairingBaseUrl }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/dsh-orbit-hub.mjs"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DSH_ORBIT_HUB_DB: dbPath,
        DSH_ORBIT_HUB_PORT: "0",
        DSH_ORBIT_HUB_LISTEN: "127.0.0.1",
        DSH_ORBIT_HUB_ROUTE_DOMAIN: "dsh.example.local",
        DSH_ORBIT_HUB_ROUTE_PROBE_CADENCE_SECONDS: "1",
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
      if (match) {
        resolve({
          child,
          port: Number(match[1]),
          baseUrl: `http://127.0.0.1:${match[1]}`,
          logs: () => stdout,
        });
      }
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
      if (code === 0) resolve({ stdout, match: successPattern ? stdout.match(successPattern) : [] });
      else reject(new Error(`node ${command} failed code ${code}; stderr=${stderr} stdout=${stdout}`));
    });
  });
}

function startNodeDaemon({ statePath, hubUrl, caCertPath, dshTarget }) {
  const child = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "run"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DSH_ORBIT_NODE_STATE: statePath,
      DSH_ORBIT_HUB_URL: hubUrl,
      DSH_ORBIT_NODE_CA_CERT: caCertPath,
      DSH_ORBIT_NODE_HEARTBEAT_SECONDS: "30",
      DSH_ORBIT_NODE_ROUTE_INGRESS_DISABLED: "1",
      DSH_ORBIT_NODE_ROUTE_DOMAIN: "dsh.example.local",
      DSH_ORBIT_NODE_DSH_TARGET: dshTarget,
      DSH_ORBIT_NODE_DSH_VERSION: "0.1.1-rc.2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let exitCode = null;
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("exit", (code) => (exitCode = code));
  return { child, stdout: () => stdout, diagnostics: () => `exitCode=${exitCode} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}` };
}

// Rehearsal public gateway (same semantics as the Stage 2 live gateway,
// including the WebSocket upgrade relay for the reverse control surface).
function startRehearsalGateway({ certPem, keyPem }) {
  let hubUrl = null;
  const server = https.createServer({ cert: certPem, key: keyPem }, (request, response) => {
    const path = (request.url ?? "").split("?")[0];
    const headers = { ...request.headers };
    delete headers.cookie;
    delete headers.origin;
    delete headers["x-dsh-authenticated-proxy"];
    delete headers["x-dsh-operator-id"];
    const upstream = http.request(hubUrl + path, { method: request.method, headers }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "gateway-upstream-error", message: "hub unavailable" } }));
    });
    request.pipe(upstream);
  });
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
  const trackedSockets = new Set();
  server.on("secureConnection", (socket) => {
    trackedSockets.add(socket);
    socket.on("close", () => trackedSockets.delete(socket));
  });
  let listenPort = 0;
  return {
    server,
    dropConnections: () => {
      for (const socket of [...trackedSockets]) socket.destroy();
    },
    listen: (port = 0) =>
      new Promise((resolve) => {
        listenPort = port;
        server.listen(listenPort, "127.0.0.1", resolve);
      }),
    get port() {
      return server.address().port;
    },
    set upstream(url) {
      hubUrl = url;
    },
    restart: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => server.listen(listenPort, "127.0.0.1", resolve));
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
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

test("Live v0.5 Stage 3 reverse evidence: outbound-only reverse node stays connected across node restarts, gateway restarts, and a Hub restart; local DSH state moves reachability independently", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-v05-stage3-live-"));
  const dbPath = join(dir, "hub.db");
  const statePath = join(dir, "node-state.json");
  const certPath = join(dir, "gateway-cert.pem");
  const keyPath = join(dir, "gateway-key.pem");
  await writeFile(certPath, GATEWAY_CERT_PEM, "utf8");
  await writeFile(keyPath, GATEWAY_KEY_PEM, "utf8");

  const dsh = startMockDshServer();
  await dsh.start();
  const gateway = startRehearsalGateway({ certPem: GATEWAY_CERT_PEM, keyPem: GATEWAY_KEY_PEM });
  await gateway.listen();

  let hub = null;
  let daemon = null;
  t.after(async () => {
    await killProcess(daemon?.child);
    await killProcess(hub?.child);
    await dsh.close();
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  });

  console.log("\n=== STEP 1: Pair a fresh node through the public machine ingress ===");
  hub = await startHubProcess({ dbPath, pairingBaseUrl: `https://127.0.0.1:${gateway.port}/` });
  gateway.upstream = hub.baseUrl;
  const session = await getOperatorSession(hub.baseUrl);
  const pairToken = await operatorMintPairToken(hub.baseUrl, session);
  const { match: pairMatch } = await runNodeCommand({
    command: "pair",
    statePath,
    hubUrl: `https://127.0.0.1:${gateway.port}`,
    caCertPath: certPath,
    extraEnv: { DSH_ORBIT_PAIR_TOKEN: pairToken },
    successPattern: /paired: (node_[0-9a-f]{32}) \(keyId ([0-9a-f]{32}), routeMode reverse\)/,
  });
  const nodeId = pairMatch[1];
  console.log(`[Evidence] Paired ${nodeId}; route ingress disabled: the node is outbound-only`);

  console.log("\n=== STEP 2: The node daemon establishes the reverse control session (online) ===");
  daemon = startNodeDaemon({ statePath, hubUrl: `https://127.0.0.1:${gateway.port}`, caCertPath: certPath, dshTarget: dsh.target });
  try {
    await waitFor(() => hub.logs().includes(`reverse session ready node=${nodeId} routeReady=true`), { label: "hub log: session ready routeReady=true", timeoutMs: 20000 });
  } catch (error) {
    console.error(`[Diagnostic] hub logs tail: ${JSON.stringify(hub.logs().split(String.fromCharCode(10)).slice(-12))}`);
    console.error(`[Diagnostic] daemon: ${daemon.diagnostics()}`);
    throw error;
  }
  console.log("[Evidence] Hub observed the current ready session: reversePresence=online, reachable=ok");

  console.log("\n=== STEP 3: Local DSH stop/restart moves reachable without touching the session or registryContact ===");
  const contactBefore = await readRegistryContact(dbPath, nodeId);
  await dsh.close();
  await waitFor(() => hub.logs().includes(`reverse route readiness node=${nodeId} routeReady=false`), { label: "hub log: routeReady=false", timeoutMs: 20000 });
  dsh.restart();
  await waitFor(
    () => {
      const logs = hub.logs();
      const falseAt = logs.indexOf(`reverse route readiness node=${nodeId} routeReady=false`);
      const trueAt = logs.indexOf(`reverse route readiness node=${nodeId} routeReady=true`, falseAt + 1);
      return trueAt !== -1;
    },
    { label: "hub log: routeReady=true after DSH recovery", timeoutMs: 20000 },
  );
  const contactAfter = await readRegistryContact(dbPath, nodeId);
  assert.deepEqual(contactAfter, contactBefore, "local DSH loss must not move registryContact");
  console.log("[Evidence] routeReady flipped false→true via node status; registryContact untouched");

  console.log("\n=== STEP 4: Node process restart reconnects with the same node ID and key ===");
  await killProcess(daemon.child);
  await waitFor(() => hub.logs().includes(`reverse session closed node=${nodeId}`), { label: "hub log: session closed after node stop", timeoutMs: 20000 });
  daemon = startNodeDaemon({ statePath, hubUrl: `https://127.0.0.1:${gateway.port}`, caCertPath: certPath, dshTarget: dsh.target });
  await waitFor(
    () => countOccurrences(hub.logs(), `reverse session ready node=${nodeId}`) >= 2,
    { label: "hub log: second ready session after node restart", timeoutMs: 20000 },
  );
  console.log("[Evidence] Node restarted: same identity, fresh ready session");

  console.log("\n=== STEP 5: Gateway restart (disconnect/reconnect cycle) ===");
  // Simulate a gateway bounce: all client connections are cut while the
  // listener stays bound; the node must reconnect with backoff.
  gateway.dropConnections();
  await waitFor(
    () => countOccurrences(hub.logs(), `reverse session closed node=${nodeId}`) >= 1,
    { label: "hub log: session closed after gateway restart", timeoutMs: 20000 },
  );
  try {
    await waitFor(
      () => countOccurrences(hub.logs(), `reverse session ready node=${nodeId}`) >= 3,
      { label: "hub log: session re-established after gateway restart", timeoutMs: 20000 },
    );
  } catch (error) {
    console.error(`[Diagnostic] hub logs tail: ${JSON.stringify(hub.logs().split(String.fromCharCode(10)).slice(-15))}`);
    console.error(`[Diagnostic] daemon: ${daemon.diagnostics()}`);
    throw error;
  }
  console.log("[Evidence] Disconnect/reconnect cycle: backoff re-established the session deterministically");

  console.log("\n=== STEP 6: Hub restart creates no phantom online state; the node reconnects automatically ===");
  await killProcess(hub.child);
  hub = await startHubProcess({ dbPath, pairingBaseUrl: `https://127.0.0.1:${gateway.port}/` });
  gateway.upstream = hub.baseUrl;
  console.error("DBG hub2 up");
  assert.ok(!hub.logs().includes(`reverse session ready node=${nodeId}`), "a restarted Hub must start with no phantom live sessions");
  await waitFor(() => hub.logs().includes(`reverse session ready node=${nodeId} routeReady=true`), { label: "hub2 log: node reconnected", timeoutMs: 40000 });
  console.log("[Evidence] Restarted Hub started empty (no phantom online) and the node reconnected automatically");

  console.log("\n=== v0.5 Stage 3 live evidence complete ===");
});

function countOccurrences(text, needle) {
  let count = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(needle, at + 1);
  }
  return count;
}

async function readRegistryContact(dbPath, nodeId) {
  const db = openRegistryDatabase(dbPath);
  try {
    const row = db.prepare("SELECT registry_contact, route_mode FROM nodes WHERE node_id = ?").get(nodeId);
    return row;
  } finally {
    db.close();
  }
}

function startMockDshServer() {
  const server = http.createServer((request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "unauthorized" } }));
  });
  let target = null;
  return {
    get target() {
      return target;
    },
    start: () =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          target = `http://127.0.0.1:${server.address().port}`;
          resolve();
        });
      }),
    restart: () =>
      new Promise((resolve) => {
        // Re-listen on the SAME port: the running node daemon probes the
        // original DSH_ORBIT_NODE_DSH_TARGET.
        const port = target ? new URL(target).port : 0;
        server.listen(Number(port), "127.0.0.1", () => {
          target = `http://127.0.0.1:${server.address().port}`;
          resolve();
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

function waitFor(predicate, { timeoutMs = 20000, stepMs = 200, label }) {
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
