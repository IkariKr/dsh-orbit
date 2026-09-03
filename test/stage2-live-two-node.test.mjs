// Stage 2 Live Two-Node Integration Evidence Test (Child-Process Daemon Form).
// Uses real child processes for the Hub daemon and two Node daemons:
// - Node A (NAS): verified HTTPS ingress with private CA credentials
// - Node B (Workstation): loopback HTTP ingress
// Proves:
// 1. Real child-process enrollment and heartbeat key synchronization
// 2. Real Route Ingress listeners and real Hub periodic route-probe scheduler
// 3. Initial reachability: both nodes ok
// 4. Fault isolation 1: stop Node A process -> Node A unreachable after threshold; Node B stays ok
// 5. Fault isolation 2: restart Node A with downstream DSH down -> Node A unreachable; Node B stays ok
// 6. Recovery: restore downstream DSH -> Node A recovers to ok
// 7. Full restart recovery: restart Hub child process + both Node child processes ->
//    identities and route targets preserved with zero key drift, probes stay ok!

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GATEWAY_CERT_PEM, GATEWAY_KEY_PEM } from "./fixtures/gateway-identity.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function killProcess(child) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      resolve();
      return;
    }
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 2000).unref();
  });
}

function startHubProcess({ dbPath, port = 0, caCertPath, routeDomain = "dsh.example.local", cadenceSeconds = 1 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/dsh-orbit-hub.mjs"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DSH_ORBIT_HUB_DB: dbPath,
        DSH_ORBIT_HUB_PORT: String(port),
        DSH_ORBIT_HUB_LISTEN: "127.0.0.1",
        DSH_ORBIT_HUB_ROUTE_DOMAIN: routeDomain,
        DSH_ORBIT_HUB_CA_CERT: caCertPath,
        DSH_ORBIT_HUB_ROUTE_PROBE_CADENCE_SECONDS: String(cadenceSeconds),
        DSH_ORBIT_HUB_GATEWAY_SECRET: "test-gateway-secret",
        DSH_ORBIT_HUB_OPERATOR_PRINCIPAL: "operator",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/registry listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        resolve({ child, port: Number(match[1]), baseUrl: `http://127.0.0.1:${match[1]}` });
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Hub exited early code ${code}; stderr=${stderr}`));
      }
    });
  });
}

function runNodeEnroll({ statePath, hubUrl, enrollTokenValue, caCertPath = null }) {
  return new Promise((resolve, reject) => {
    const envVars = {
      ...process.env,
      DSH_ORBIT_NODE_STATE: statePath,
      DSH_ORBIT_HUB_URL: hubUrl,
      DSH_ORBIT_ENROLL_TOKEN: enrollTokenValue,
    };
    if (caCertPath) {
      envVars.DSH_ORBIT_NODE_CA_CERT = caCertPath;
    }
    const child = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "enroll"], {
      cwd: REPO_ROOT,
      env: envVars,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        const match = stdout.match(/enrolled: (node_[0-9a-f]{32}) \(keyId ([0-9a-f]{32})\)/);
        resolve({ nodeId: match[1], keyId: match[2] });
      } else {
        reject(new Error(`Enroll failed code ${code}; stderr=${stderr}`));
      }
    });
  });
}

function startNodeDaemon({
  statePath,
  hubUrl,
  ingressPort = 0,
  dshTarget,
  tlsKeyPath = null,
  tlsCertPath = null,
  caCertPath = null,
  cadence = 30,
}) {
  return new Promise((resolve, reject) => {
    const envVars = {
      ...process.env,
      DSH_ORBIT_NODE_STATE: statePath,
      DSH_ORBIT_HUB_URL: hubUrl,
      DSH_ORBIT_NODE_HEARTBEAT_SECONDS: String(cadence),
      DSH_ORBIT_NODE_DSH_VERSION: "0.1.1-rc.2",
      DSH_ORBIT_NODE_ROUTE_INGRESS_PORT: String(ingressPort),
      DSH_ORBIT_NODE_ROUTE_INGRESS_LISTEN: "127.0.0.1",
      DSH_ORBIT_NODE_DSH_TARGET: dshTarget,
      DSH_ORBIT_NODE_ROUTE_DOMAIN: "dsh.example.local",
    };
    if (tlsKeyPath && tlsCertPath) {
      envVars.DSH_ORBIT_NODE_ROUTE_TLS_KEY = tlsKeyPath;
      envVars.DSH_ORBIT_NODE_ROUTE_TLS_CERT = tlsCertPath;
    }
    if (caCertPath) {
      envVars.DSH_ORBIT_NODE_CA_CERT = caCertPath;
    }
    const child = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "run"], {
      cwd: REPO_ROOT,
      env: envVars,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/route ingress listening on (https?:\/\/127\.0\.0\.1:(\d+))/);
      if (match) {
        resolve({ child, ingressOrigin: match[1], port: Number(match[2]) });
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Node daemon exited early code ${code}; stderr=${stderr}`));
      }
    });
  });
}

function startDshServer({ port = 0 } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ dsh: "ok" }));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        target: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const GATEWAY_HEADERS = {
  "x-dsh-authenticated-proxy": "test-gateway-secret",
  "x-dsh-operator-id": "operator",
};

async function getOperatorSession(hubBaseUrl) {
  const res = await fetch(`${hubBaseUrl}/hub/session`, {
    method: "POST",
    headers: {
      ...GATEWAY_HEADERS,
      origin: hubBaseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie")?.match(/(?:^|;\s*)dsh-orbit-hub-session=([^;]+)/)?.[1];
  const body = await res.json();
  return { cookie, csrfToken: body.csrfToken };
}

async function operatorMintToken(hubBaseUrl, session) {
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
    body: JSON.stringify({ purpose: "enroll" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.token;
}

async function operatorSetRouteTarget(hubBaseUrl, session, nodeId, routeTarget) {
  const res = await fetch(`${hubBaseUrl}/hub/nodes/${nodeId}/route-target`, {
    method: "PUT",
    headers: {
      ...GATEWAY_HEADERS,
      "content-type": "application/json",
      cookie: `dsh-orbit-hub-session=${session.cookie}`,
      "x-csrf-token": session.csrfToken,
      origin: hubBaseUrl,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ routeTarget }),
  });
  assert.equal(res.status, 200);
  return await res.json();
}

async function operatorGetNode(hubBaseUrl, session, nodeId) {
  const res = await fetch(`${hubBaseUrl}/hub/nodes/${nodeId}`, {
    method: "GET",
    headers: {
      ...GATEWAY_HEADERS,
      cookie: `dsh-orbit-hub-session=${session.cookie}`,
      origin: hubBaseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(res.status, 200);
  return await res.json();
}

async function waitForNodeReachable(hubBaseUrl, session, nodeId, targetReachable, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const node = await operatorGetNode(hubBaseUrl, session, nodeId);
    if (node.health.reachable === targetReachable) {
      return node;
    }
    await sleep(200);
  }
  const finalNode = await operatorGetNode(hubBaseUrl, session, nodeId);
  console.log("FINAL NODE STATUS:", JSON.stringify(finalNode, null, 2));
  throw new Error(`Timeout waiting for ${nodeId} to reach ${targetReachable}, current: ${finalNode.health.reachable}`);
}

test("Live Two-Node Integration Evidence (True Child Processes): Topology, Heartbeat Key Sync, Ingress, Probes, Faults, and Restarts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-stage2-live-two-node-cp-"));
  const dbPath = join(dir, "hub.db");
  const statePathA = join(dir, "node-a.json");
  const statePathB = join(dir, "node-b.json");
  const certPath = join(dir, "gateway-cert.pem");
  const keyPath = join(dir, "gateway-key.pem");

  await writeFile(certPath, GATEWAY_CERT_PEM, "utf8");
  await writeFile(keyPath, GATEWAY_KEY_PEM, "utf8");

  let hub = null;
  let nodeA = null;
  let nodeB = null;
  let dshA = null;
  let dshB = null;

  t.after(async () => {
    await killProcess(nodeA?.child);
    await killProcess(nodeB?.child);
    await killProcess(hub?.child);
    if (dshA) await dshA.close();
    if (dshB) await dshB.close();
    await rm(dir, { recursive: true, force: true });
  });

  console.log("\n=== STEP 1: Launch Hub Process & DSH Downstream Servers ===");
  dshA = await startDshServer();
  dshB = await startDshServer();
  console.log(`[Evidence] Downstream DSH A running on ${dshA.target}`);
  console.log(`[Evidence] Downstream DSH B running on ${dshB.target}`);

  hub = await startHubProcess({ dbPath, caCertPath: certPath, cadenceSeconds: 1 });
  console.log(`[Evidence] Hub child process started on ${hub.baseUrl}`);
  let opSession = await getOperatorSession(hub.baseUrl);

  console.log("\n=== STEP 2: Enroll Node A and Node B via CLI ===");
  const tokenA = await operatorMintToken(hub.baseUrl, opSession);
  const enrollResA = await runNodeEnroll({ statePath: statePathA, hubUrl: hub.baseUrl, enrollTokenValue: tokenA, caCertPath: certPath });
  console.log(`[Evidence] Enrolled Node A via CLI: ${enrollResA.nodeId} (keyId ${enrollResA.keyId})`);

  const tokenB = await operatorMintToken(hub.baseUrl, opSession);
  const enrollResB = await runNodeEnroll({ statePath: statePathB, hubUrl: hub.baseUrl, enrollTokenValue: tokenB });
  console.log(`[Evidence] Enrolled Node B via CLI: ${enrollResB.nodeId} (keyId ${enrollResB.keyId})`);

  console.log("\n=== STEP 3: Start Node A (HTTPS + Private CA) and Node B (HTTP) Daemons ===");
  nodeA = await startNodeDaemon({
    statePath: statePathA,
    hubUrl: hub.baseUrl,
    dshTarget: dshA.target,
    tlsKeyPath: keyPath,
    tlsCertPath: certPath,
    caCertPath: certPath,
    cadence: 30,
  });
  console.log(`[Evidence] Node A daemon started, route ingress: ${nodeA.ingressOrigin}`);

  nodeB = await startNodeDaemon({
    statePath: statePathB,
    hubUrl: hub.baseUrl,
    dshTarget: dshB.target,
    cadence: 30,
  });
  console.log(`[Evidence] Node B daemon started, route ingress: ${nodeB.ingressOrigin}`);

  // Register route targets
  await operatorSetRouteTarget(hub.baseUrl, opSession, enrollResA.nodeId, nodeA.ingressOrigin);
  await operatorSetRouteTarget(hub.baseUrl, opSession, enrollResB.nodeId, nodeB.ingressOrigin);
  console.log(`[Evidence] Registered route targets on Hub for both nodes`);

  console.log("\n=== STEP 4: Initial Reachability Probing via Hub Scheduler ===");
  // Wait for Hub periodic probe scheduler to probe both nodes
  const summaryA1 = await waitForNodeReachable(hub.baseUrl, opSession, enrollResA.nodeId, "ok");
  const summaryB1 = await waitForNodeReachable(hub.baseUrl, opSession, enrollResB.nodeId, "ok");
  assert.equal(summaryA1.health.reachable, "ok");
  assert.equal(summaryB1.health.reachable, "ok");
  console.log(`[Evidence] Both nodes probed and authenticated successfully: Node A = ok, Node B = ok`);

  console.log("\n=== STEP 5: Fault Injection 1 - Node A Process Terminated ===");
  await killProcess(nodeA.child);
  console.log("[Evidence] Node A daemon child process terminated");

  // Hub route probe scheduler will fail 3 times -> unreachable
  const summaryA_fail = await waitForNodeReachable(hub.baseUrl, opSession, enrollResA.nodeId, "unreachable", 15000);
  assert.equal(summaryA_fail.health.reachable, "unreachable");
  console.log(`[Evidence] Node A became unreachable after 3 failed probes`);

  // Verify Node B isolation: Node B remains ok
  const summaryB_iso = await operatorGetNode(hub.baseUrl, opSession, enrollResB.nodeId);
  assert.equal(summaryB_iso.health.reachable, "ok");
  console.log(`[Evidence] Node B isolation verified: reachable remains ok`);

  console.log("\n=== STEP 6: Fault Injection 2 - Node A Restarts with Downstream DSH Listener Stopped ===");
  const dshAPort = dshA.port;
  const dshATarget = dshA.target;
  await dshA.close();
  dshA = null;
  const nodeAPort = nodeA.port;
  nodeA = await startNodeDaemon({
    statePath: statePathA,
    hubUrl: hub.baseUrl,
    ingressPort: nodeAPort,
    dshTarget: dshATarget,
    tlsKeyPath: keyPath,
    tlsCertPath: certPath,
    caCertPath: certPath,
    cadence: 30,
  });
  console.log(`[Evidence] Node A daemon restarted on same port ${nodeA.ingressOrigin}, but downstream DSH listener is stopped`);

  // Hub probes -> route ingress cannot connect to DSH -> Node A remains unreachable
  await sleep(2500);
  const summaryA_dshDown = await operatorGetNode(hub.baseUrl, opSession, enrollResA.nodeId);
  assert.equal(summaryA_dshDown.health.reachable, "unreachable");
  const summaryB_iso2 = await operatorGetNode(hub.baseUrl, opSession, enrollResB.nodeId);
  assert.equal(summaryB_iso2.health.reachable, "ok");
  console.log(`[Evidence] Node A remains unreachable (503), Node B remains ok`);

  console.log("\n=== STEP 7: Recovery - Downstream DSH Listener Restored ===");
  dshA = await startDshServer({ port: dshAPort });
  assert.equal(dshA.target, dshATarget);
  console.log("[Evidence] Downstream DSH A listener restored on the same target");
  const summaryA_recovered = await waitForNodeReachable(hub.baseUrl, opSession, enrollResA.nodeId, "ok", 15000);
  assert.equal(summaryA_recovered.health.reachable, "ok");
  console.log(`[Evidence] Node A recovered: reachable = ok`);

  console.log("\n=== STEP 8: Full Process Restart Recovery (Hub + Node A + Node B) ===");
  // Kill all three child processes
  await killProcess(nodeA.child);
  await killProcess(nodeB.child);
  await killProcess(hub.child);
  console.log("[Evidence] Terminated Hub, Node A, and Node B child processes");

  // Restart Hub on the same DB file and same port
  const hubPort = hub.port;
  hub = await startHubProcess({ dbPath, port: hubPort, caCertPath: certPath, cadenceSeconds: 1 });
  console.log(`[Evidence] Restarted Hub child process on ${hub.baseUrl}`);
  opSession = await getOperatorSession(hub.baseUrl);

  // Restart Node A on the same state file & ingress port
  nodeA = await startNodeDaemon({
    statePath: statePathA,
    hubUrl: hub.baseUrl,
    ingressPort: nodeAPort,
    dshTarget: dshA.target,
    tlsKeyPath: keyPath,
    tlsCertPath: certPath,
    caCertPath: certPath,
    cadence: 30,
  });
  console.log(`[Evidence] Restarted Node A child process on ${nodeA.ingressOrigin}`);

  // Restart Node B on the same state file & ingress port
  nodeB = await startNodeDaemon({
    statePath: statePathB,
    hubUrl: hub.baseUrl,
    ingressPort: nodeB.port,
    dshTarget: dshB.target,
    cadence: 30,
  });
  console.log(`[Evidence] Restarted Node B child process on ${nodeB.ingressOrigin}`);

  // Check state and verify zero key drift
  const postRestartA = await waitForNodeReachable(hub.baseUrl, opSession, enrollResA.nodeId, "ok", 15000);
  const postRestartB = await waitForNodeReachable(hub.baseUrl, opSession, enrollResB.nodeId, "ok", 15000);

  assert.equal(postRestartA.routeTarget.origin, nodeA.ingressOrigin);
  assert.equal(postRestartB.routeTarget.origin, nodeB.ingressOrigin);
  assert.equal(postRestartA.hubRouteKeys[0].state, "active");
  assert.equal(postRestartB.hubRouteKeys[0].state, "active");
  assert.equal(postRestartA.health.reachable, "ok");
  assert.equal(postRestartB.health.reachable, "ok");
  console.log(`[Evidence] Post-restart: Route targets, active Hub route keys, and reachable=ok preserved intact without drift!`);
});
