import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { validReport } from "./helpers/registry-fixture.mjs";
import { startWildcardGateway } from "./helpers/wildcard-gateway-fixture.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REHEARSAL_DOMAIN = "stage5-e2e.example";
const REHEARSAL_GATEWAY_TOKEN = "test-stage5-gw-token";

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

function generateWildcardCertificate(dir) {
  const keyPath = join(dir, "wildcard-gateway-key.pem");
  const certPath = join(dir, "wildcard-gateway-cert.pem");
  return new Promise((resolve, reject) => {
    execFile(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        `/CN=*.${REHEARSAL_DOMAIN}`,
        "-addext",
        `subjectAltName=DNS:*.${REHEARSAL_DOMAIN},DNS:${REHEARSAL_DOMAIN},IP:127.0.0.1`,
      ],
      { env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
      (error) => (error ? reject(error) : resolve({ keyPath, certPath })),
    );
  });
}

function startIdentifiedDshServer(fixtureId) {
  let alive = true;
  const activeSockets = new Set();

  const server = http.createServer((req, res) => {
    if (!alive) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "dsh_down" }));
      return;
    }

    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "x-node-fixture": fixtureId,
      });
      res.end(`<!DOCTYPE html><html><head><title>DSH ${fixtureId}</title></head><body><h1>Welcome to ${fixtureId}</h1></body></html>`);
      return;
    }

    res.writeHead(200, {
      "content-type": "application/json",
      "x-node-fixture": fixtureId,
    });
    res.end(JSON.stringify({
      ok: true,
      identifier: fixtureId,
      url: req.url,
    }));
  });

  server.on("upgrade", (req, socket) => {
    socket.on("error", () => {});
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));

    if (!alive) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.end();
      return;
    }

    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        target: `http://127.0.0.1:${port}`,
        setAlive: (v) => (alive = v),
        close: () => new Promise((r) => {
          for (const s of activeSockets) {
            try { s.destroy(); } catch {}
          }
          activeSockets.clear();
          server.close(r);
        }),
      });
    });
  });
}

function makeGatewayRequest({ gatewayPort, authority, path = "/", headers = {}, caCert }) {
  return new Promise((resolve, reject) => {
    const forwardHeaders = {
      ...headers,
      host: authority,
    };
    const req = https.request({
      hostname: "127.0.0.1",
      port: gatewayPort,
      path,
      method: "GET",
      headers: forwardHeaders,
      ca: caCert,
      servername: authority.split(":")[0],
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: async () => raw,
          json: async () => JSON.parse(raw),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("Stage 5 Live End-to-End: Rehearsal Wildcard Gateway + Selector Shell + Open Navigation + Fault Isolation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-stage5-live-"));
  const dbPath = join(dir, "hub.db");
  const statePathA = join(dir, "node-a.json");
  const statePathB = join(dir, "node-b.json");
  const reportPathA = join(dir, "report-a.json");
  const reportPathB = join(dir, "report-b.json");
  const { keyPath: gwKeyPath, certPath: gwCertPath } = await generateWildcardCertificate(dir);
  const wildcardCaCert = await readFile(gwCertPath);

  let hubChild = null;
  let gateway = null;
  let nodeChildA = null;
  let nodeChildB = null;
  let dshA = null;
  let dshB = null;

  t.after(async () => {
    await killProcess(nodeChildA);
    await killProcess(nodeChildB);
    await killProcess(hubChild);
    if (gateway) await gateway.close();
    if (dshA) await dshA.close();
    if (dshB) await dshB.close();
    await rm(dir, { recursive: true, force: true });
  });

  // Step 1: Start 2 distinct downstream fixtures
  dshA = await startIdentifiedDshServer("downstream-A");
  dshB = await startIdentifiedDshServer("downstream-B");

  // Step 2: Start Hub
  const hubPort = await new Promise((resolve, reject) => {
    hubChild = spawn(
      process.execPath,
      ["bin/dsh-orbit-hub.mjs"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DSH_ORBIT_HUB_DB: dbPath,
          DSH_ORBIT_HUB_PORT: "0",
          DSH_ORBIT_HUB_LISTEN: "127.0.0.1",
          DSH_ORBIT_HUB_ROUTE_DOMAIN: REHEARSAL_DOMAIN,
          DSH_ORBIT_HUB_ROUTE_PROBE_CADENCE_SECONDS: "1",
          DSH_ORBIT_HUB_GATEWAY_SECRET: "test-gateway-secret",
          DSH_ORBIT_HUB_OPERATOR_PRINCIPAL: "operator",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    hubChild.stdout.on("data", (c) => {
      stdout += c.toString();
      const match = stdout.match(/registry listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    hubChild.stderr.on("data", (c) => (stderr += c.toString()));
    hubChild.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Hub exited early code ${code}; stderr=${stderr}`));
      }
    });
    hubChild.on("error", reject);
  });
  const hubBaseUrl = `http://127.0.0.1:${hubPort}`;

  // Step 3: Start Authenticated Wildcard Gateway
  gateway = await startWildcardGateway({
    keyPath: gwKeyPath,
    certPath: gwCertPath,
    hubPort,
    routeDomain: REHEARSAL_DOMAIN,
    gatewayToken: REHEARSAL_GATEWAY_TOKEN,
  });
  const gatewayPort = gateway.port;

  // Step 4: Enroll Node A & Node B
  const opHeaders = {
    "x-dsh-authenticated-proxy": "test-gateway-secret",
    "x-dsh-operator-id": "operator",
    origin: hubBaseUrl,
    "sec-fetch-site": "same-origin",
  };
  const sessRes = await fetch(`${hubBaseUrl}/hub/session`, { method: "POST", headers: opHeaders });
  const sessionCookie = sessRes.headers.get("set-cookie")?.match(/dsh-orbit-hub-session=([^;]+)/)?.[1];
  const { csrfToken } = await sessRes.json();
  const authHeaders = {
    ...opHeaders,
    "content-type": "application/json",
    cookie: `dsh-orbit-hub-session=${sessionCookie}`,
    "x-csrf-token": csrfToken,
  };

  const tokResA = await fetch(`${hubBaseUrl}/hub/tokens`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ purpose: "enroll" }),
  });
  const { token: tokenA } = await tokResA.json();

  const tokResB = await fetch(`${hubBaseUrl}/hub/tokens`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ purpose: "enroll" }),
  });
  const { token: tokenB } = await tokResB.json();

  // Enroll A
  const enrollChildA = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "enroll"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DSH_ORBIT_NODE_STATE: statePathA, DSH_ORBIT_HUB_URL: hubBaseUrl, DSH_ORBIT_ENROLL_TOKEN: tokenA },
  });
  let enrollOutA = "";
  enrollChildA.stdout.on("data", (c) => (enrollOutA += c));
  await new Promise((r) => enrollChildA.on("exit", r));
  const nodeIdA = enrollOutA.match(/enrolled: (node_[0-9a-f]{32})/)?.[1];
  assert.ok(nodeIdA);

  // Enroll B
  const enrollChildB = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "enroll"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DSH_ORBIT_NODE_STATE: statePathB, DSH_ORBIT_HUB_URL: hubBaseUrl, DSH_ORBIT_ENROLL_TOKEN: tokenB },
  });
  let enrollOutB = "";
  enrollChildB.stdout.on("data", (c) => (enrollOutB += c));
  await new Promise((r) => enrollChildB.on("exit", r));
  const nodeIdB = enrollOutB.match(/enrolled: (node_[0-9a-f]{32})/)?.[1];
  assert.ok(nodeIdB);

  // Upload compatible reports for A & B
  const reportA = validReport({ orbitVersion: "0.4.0", dshVersion: "0.1.1-rc.2", profile: "dsh-0.1.1-rc.2" });
  reportA.checks.webSocketTransport = { status: "pass", detail: "matching pong" };
  await writeFile(reportPathA, JSON.stringify(reportA), "utf8");

  const reportB = validReport({ orbitVersion: "0.4.0", dshVersion: "0.1.1-rc.2", profile: "dsh-0.1.1-rc.2" });
  reportB.checks.webSocketTransport = { status: "pass", detail: "matching pong" };
  await writeFile(reportPathB, JSON.stringify(reportB), "utf8");

  const repChildA = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "upload-report"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DSH_ORBIT_NODE_STATE: statePathA, DSH_ORBIT_HUB_URL: hubBaseUrl, DSH_ORBIT_REPORT_FILE: reportPathA },
  });
  await new Promise((r) => repChildA.on("exit", r));

  const repChildB = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "upload-report"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DSH_ORBIT_NODE_STATE: statePathB, DSH_ORBIT_HUB_URL: hubBaseUrl, DSH_ORBIT_REPORT_FILE: reportPathB },
  });
  await new Promise((r) => repChildB.on("exit", r));

  // Step 5: Start Node daemons for A and B
  const nodeInfoA = await new Promise((resolve, reject) => {
    nodeChildA = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "run"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DSH_ORBIT_NODE_STATE: statePathA,
        DSH_ORBIT_HUB_URL: hubBaseUrl,
        DSH_ORBIT_NODE_HEARTBEAT_SECONDS: "30",
        DSH_ORBIT_NODE_ORBIT_VERSION: "0.4.0",
        DSH_ORBIT_NODE_ORBIT_REVISION: "abc123",
        DSH_ORBIT_NODE_DSH_VERSION: "0.1.1-rc.2",
        DSH_ORBIT_NODE_DSH_PROFILE: "dsh-0.1.1-rc.2",
        DSH_ORBIT_NODE_ROUTE_INGRESS_PORT: "0",
        DSH_ORBIT_NODE_ROUTE_INGRESS_LISTEN: "127.0.0.1",
        DSH_ORBIT_NODE_DSH_TARGET: dshA.target,
        DSH_ORBIT_NODE_ROUTE_DOMAIN: REHEARSAL_DOMAIN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    nodeChildA.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/route ingress listening on (https?:\/\/127\.0\.0\.1:(\d+))/);
      if (m) resolve({ origin: m[1] });
    });
    nodeChildA.on("error", reject);
  });

  const nodeInfoB = await new Promise((resolve, reject) => {
    nodeChildB = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "run"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DSH_ORBIT_NODE_STATE: statePathB,
        DSH_ORBIT_HUB_URL: hubBaseUrl,
        DSH_ORBIT_NODE_HEARTBEAT_SECONDS: "30",
        DSH_ORBIT_NODE_ORBIT_VERSION: "0.4.0",
        DSH_ORBIT_NODE_ORBIT_REVISION: "abc123",
        DSH_ORBIT_NODE_DSH_VERSION: "0.1.1-rc.2",
        DSH_ORBIT_NODE_DSH_PROFILE: "dsh-0.1.1-rc.2",
        DSH_ORBIT_NODE_ROUTE_INGRESS_PORT: "0",
        DSH_ORBIT_NODE_ROUTE_INGRESS_LISTEN: "127.0.0.1",
        DSH_ORBIT_NODE_DSH_TARGET: dshB.target,
        DSH_ORBIT_NODE_ROUTE_DOMAIN: REHEARSAL_DOMAIN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    nodeChildB.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/route ingress listening on (https?:\/\/127\.0\.0\.1:(\d+))/);
      if (m) resolve({ origin: m[1] });
    });
    nodeChildB.on("error", reject);
  });

  // Set route targets
  await fetch(`${hubBaseUrl}/hub/nodes/${nodeIdA}/route-target`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ routeTarget: nodeInfoA.origin }),
  });
  await fetch(`${hubBaseUrl}/hub/nodes/${nodeIdB}/route-target`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ routeTarget: nodeInfoB.origin }),
  });

  // Wait for both nodes to become eligible
  const authorityA = computeRouteAuthority(nodeIdA, REHEARSAL_DOMAIN);
  const authorityB = computeRouteAuthority(nodeIdB, REHEARSAL_DOMAIN);

  const startWait = Date.now();
  let lastNodeA = null;
  let lastNodeB = null;
  while (Date.now() - startWait < 15000) {
    lastNodeA = await (await fetch(`${hubBaseUrl}/hub/nodes/${nodeIdA}`, { headers: authHeaders })).json();
    lastNodeB = await (await fetch(`${hubBaseUrl}/hub/nodes/${nodeIdB}`, { headers: authHeaders })).json();
    const okA = lastNodeA.state === "active" && lastNodeA.health?.reachable === "ok" && (lastNodeA.health?.capabilities || []).some((c) => c.name === "web.routes");
    const okB = lastNodeB.state === "active" && lastNodeB.health?.reachable === "ok" && (lastNodeB.health?.capabilities || []).some((c) => c.name === "web.routes");
    if (okA && okB) break;
    await sleep(200);
  }
  console.log("Node A status:", JSON.stringify(lastNodeA?.health));
  console.log("Node B status:", JSON.stringify(lastNodeB?.health));

  // Step 6: Verify Selector Authority over Wildcard Gateway
  // 6.1 Unauthenticated selector access fails closed with 401
  const unauthSel = await makeGatewayRequest({
    gatewayPort,
    authority: REHEARSAL_DOMAIN,
    path: "/",
    caCert: wildcardCaCert,
  });
  assert.equal(unauthSel.status, 401, "Unauthenticated selector access must return 401");

  // 6.2 Authenticated selector access loads HTML shell
  const authSel = await makeGatewayRequest({
    gatewayPort,
    authority: REHEARSAL_DOMAIN,
    path: "/",
    headers: { "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN },
    caCert: wildcardCaCert,
  });
  assert.equal(authSel.status, 200);
  const selHtml = await authSel.text();
  assert.ok(selHtml.includes("DSH Orbit Endpoint Selector"));

  // 6.3 Open Node A through Gateway -> Reaches downstream A exclusively
  const openResA = await makeGatewayRequest({
    gatewayPort,
    authority: authorityA,
    path: "/api/test",
    headers: { "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN },
    caCert: wildcardCaCert,
  });
  assert.equal(openResA.status, 200);
  const jsonA = await openResA.json();
  assert.equal(jsonA.identifier, "downstream-A");

  // 6.4 Open Node B through Gateway -> Reaches downstream B exclusively
  const openResB = await makeGatewayRequest({
    gatewayPort,
    authority: authorityB,
    path: "/api/test",
    headers: { "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN },
    caCert: wildcardCaCert,
  });
  assert.equal(openResB.status, 200);
  const jsonB = await openResB.json();
  assert.equal(jsonB.identifier, "downstream-B");

  // Step 7: Fault Isolation (Stop Node A -> Node A returns 503 HTML return surface; Node B remains fully available)
  await killProcess(nodeChildA);
  await sleep(1500); // Allow route probe failure threshold

  // Node A browser navigation returns HTML 503 with return link to selector
  const failedResA = await makeGatewayRequest({
    gatewayPort,
    authority: authorityA,
    path: "/",
    headers: {
      "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN,
      accept: "text/html,application/xhtml+xml",
    },
    caCert: wildcardCaCert,
  });
  assert.equal(failedResA.status, 503);
  assert.equal(failedResA.headers["content-type"], "text/html; charset=utf-8");
  const failedHtmlA = await failedResA.text();
  assert.ok(failedHtmlA.includes("Selected Endpoint Unavailable"));
  assert.ok(failedHtmlA.includes(`href="https://${REHEARSAL_DOMAIN}/"`));

  // Node B remains 100% functional and untouched
  const healthyResB = await makeGatewayRequest({
    gatewayPort,
    authority: authorityB,
    path: "/api/test",
    headers: { "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN },
    caCert: wildcardCaCert,
  });
  assert.equal(healthyResB.status, 200);
  assert.equal((await healthyResB.json()).identifier, "downstream-B");
});
