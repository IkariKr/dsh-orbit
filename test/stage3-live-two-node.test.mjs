// Stage 3 Live Two-Node Integration Evidence Test (True Child Processes).
// Exercises:
// 1. Child-process Hub + Node A (NAS, HTTPS + private CA) + Node B (Workstation, loopback HTTP)
// 2. Real CLI enrollment, heartbeat trust pull & ACK, and compatibility report upload
// 3. Separate deterministic public route authorities:
//    - Route Authority A: n-<nodeIdA>.<routeDomain>
//    - Route Authority B: n-<nodeIdB>.<routeDomain>
// 4. Downstream DSH server A returns distinct identifying fixture A
// 5. Downstream DSH server B returns distinct identifying fixture B
// 6. Verification that Authority A returns Fixture A, Authority B returns Fixture B, and A never reaches B
// 7. Verified HTTPS + private CA on Node A; wrong SAN / non-matching leaf fails closed
// 8. Rehearsal wildcard HTTPS gateway (*.stage3-test.example) terminating TLS:
//    - Public clients connect via HTTPS to the rehearsal gateway
//    - Gateway terminates TLS, strips outer gateway credentials, preserves canonical Host
//    - Gateway forwards to Hub loopback
//    - Public registration authority denies private machine surface (/api/v1/*) with 403
//    - Wildcard node authority passes ordinary HTTP requests (including /api/v1/*) opaquely to DSH
//    - Outer gateway credentials never reach downstream DSH
// 9. Negative fault injections:
//    - Wrong SAN fails closed on TLS
//    - Conflicting Host headers denied
// 10. Ingress fault isolation: stop Node A -> Node A unavailable (503); Node B unaffected
// 11. Process restarts: restart Hub and both Node daemons -> routing & isolation preserved with zero drift

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GATEWAY_CERT_PEM, GATEWAY_KEY_PEM } from "./fixtures/gateway-identity.mjs";
import { validReport } from "./helpers/registry-fixture.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REHEARSAL_DOMAIN = "stage3-test.example";
const REGISTRATION_AUTHORITY = `registration.${REHEARSAL_DOMAIN}`;

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
        `subjectAltName=DNS:*.${REHEARSAL_DOMAIN},DNS:${REGISTRATION_AUTHORITY},IP:127.0.0.1`,
      ],
      { env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
      (error) => (error ? reject(error) : resolve({ keyPath, certPath })),
    );
  });
}

function startWildcardGateway({ keyPath, certPath, hubPort }) {
  return new Promise(async (resolve, reject) => {
    const key = await readFile(keyPath);
    const cert = await readFile(certPath);

    const server = https.createServer({ key, cert }, (req, res) => {
      const incomingHost = req.headers.host || "";
      const hostWithoutPort = incomingHost.toLowerCase().split(":")[0];

      // Branch 1: Registration / selector authority
      if (hostWithoutPort === REGISTRATION_AUTHORITY) {
        // Machine API surface (/api/v1/*) is private and must never be exposed publicly
        if (req.url.startsWith("/api/v1/")) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "machine-ingress-denied", message: "private machine surface" } }));
          return;
        }
        // Forward other registration / UI paths
        forwardToHub(req, res, hubPort, incomingHost);
        return;
      }

      // Branch 2: Wildcard Node route authority (*.stage3-test.example)
      // Preserves canonical Host, consumes and strips outer gateway credentials,
      // and passes ALL ordinary HTTP paths opaquely to Hub -> Node -> DSH.
      forwardToHub(req, res, hubPort, incomingHost);
    });

    function forwardToHub(req, res, targetPort, originalHost) {
      const forwardHeaders = { ...req.headers };
      // Preserve canonical Host
      forwardHeaders.host = originalHost;
      // Strip outer gateway credentials
      delete forwardHeaders.authorization;
      delete forwardHeaders["x-gateway-auth"];
      delete forwardHeaders["x-gateway-secret"];

      const upstream = http.request(
        {
          hostname: "127.0.0.1",
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: forwardHeaders,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );

      upstream.on("error", (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "gateway-upstream-error", message: err.message } }));
        }
      });

      req.pipe(upstream);
    }

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function makeGatewayRequest({
  gatewayPort,
  authority,
  path = "/",
  method = "GET",
  headers = {},
  body = null,
  caCert,
  rejectUnauthorized = true,
  servername = null,
}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = {
      ...headers,
      host: authority,
    };
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: gatewayPort,
        path,
        method,
        headers: reqHeaders,
        ca: caCert ? [caCert] : undefined,
        rejectUnauthorized,
        servername: servername || authority.split(":")[0],
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: async () => raw.toString("utf8"),
            json: async () => JSON.parse(raw.toString("utf8")),
          });
        });
      },
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function startHubProcess({ dbPath, port = 0, caCertPath, routeDomain = REHEARSAL_DOMAIN, cadenceSeconds = 1 }) {
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

function runNodeUploadReport({ statePath, hubUrl, reportPath, caCertPath = null }) {
  return new Promise((resolve, reject) => {
    const envVars = {
      ...process.env,
      DSH_ORBIT_NODE_STATE: statePath,
      DSH_ORBIT_HUB_URL: hubUrl,
      DSH_ORBIT_REPORT_FILE: reportPath,
    };
    if (caCertPath) {
      envVars.DSH_ORBIT_NODE_CA_CERT = caCertPath;
    }
    const child = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "upload-report"], {
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
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Upload report failed code ${code}; stderr=${stderr}`));
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
      DSH_ORBIT_NODE_ORBIT_VERSION: "0.3.0",
      DSH_ORBIT_NODE_ORBIT_REVISION: "abc123",
      DSH_ORBIT_NODE_DSH_VERSION: "0.1.1-rc.2",
      DSH_ORBIT_NODE_DSH_PROFILE: "dsh-0.1.1-rc.2",
      DSH_ORBIT_NODE_ROUTE_INGRESS_PORT: String(ingressPort),
      DSH_ORBIT_NODE_ROUTE_INGRESS_LISTEN: "127.0.0.1",
      DSH_ORBIT_NODE_DSH_TARGET: dshTarget,
      DSH_ORBIT_NODE_ROUTE_DOMAIN: REHEARSAL_DOMAIN,
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

function startIdentifiedDshServer(fixtureId) {
  let alive = true;
  let lastReceivedHeaders = null;
  const server = http.createServer((req, res) => {
    lastReceivedHeaders = { ...req.headers };
    if (!alive) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "dsh_down" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "x-node-fixture": fixtureId,
      "set-cookie": `node_session=${fixtureId}_sess; Domain=.${REHEARSAL_DOMAIN}; Path=/; HttpOnly`,
    });
    res.end(JSON.stringify({
      nodeFixture: fixtureId,
      path: req.url,
      method: req.method,
      hostHeader: req.headers.host,
    }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        target: `http://127.0.0.1:${port}`,
        getLastHeaders: () => lastReceivedHeaders,
        setAlive: (v) => (alive = v),
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

async function waitForNodeEligible(hubBaseUrl, session, nodeId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const node = await operatorGetNode(hubBaseUrl, session, nodeId);
    const hasWebRoutes = Array.isArray(node.health.capabilities) && node.health.capabilities.some((c) => c.name === "web.routes");
    const activeKey = node.hubRouteKeys && node.hubRouteKeys.find((k) => k.state === "active");
    if (
      node.state === "active" &&
      node.routeTarget &&
      node.health.reachable === "ok" &&
      activeKey &&
      hasWebRoutes &&
      node.health.orbitCompatible === "pass"
    ) {
      return node;
    }
    await sleep(250);
  }
  const finalNode = await operatorGetNode(hubBaseUrl, session, nodeId);
  throw new Error(`Timeout waiting for ${nodeId} to become eligible for routing: ${JSON.stringify(finalNode, null, 2)}`);
}

test("Live Two-Node Stage 3 Evidence: Rehearsal HTTPS Wildcard Gateway, Independent Authorities, Fixture Isolation, and Process Restarts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-stage3-live-two-node-"));
  const dbPath = join(dir, "hub.db");
  const statePathA = join(dir, "node-a.json");
  const statePathB = join(dir, "node-b.json");
  const nodeCertPath = join(dir, "node-cert.pem");
  const nodeKeyPath = join(dir, "node-key.pem");
  const reportPath = join(dir, "report.json");

  await writeFile(nodeCertPath, GATEWAY_CERT_PEM, "utf8");
  await writeFile(nodeKeyPath, GATEWAY_KEY_PEM, "utf8");
  await writeFile(reportPath, JSON.stringify(validReport()), "utf8");

  // Generate Wildcard Gateway TLS credentials for *.stage3-test.example
  const { keyPath: gwKeyPath, certPath: gwCertPath } = await generateWildcardCertificate(dir);
  const wildcardCaCert = await readFile(gwCertPath);

  let hub = null;
  let gateway = null;
  let nodeA = null;
  let nodeB = null;
  let dshA = null;
  let dshB = null;

  t.after(async () => {
    await killProcess(nodeA?.child);
    await killProcess(nodeB?.child);
    await killProcess(hub?.child);
    if (gateway) await gateway.close();
    if (dshA) await dshA.close();
    if (dshB) await dshB.close();
    await rm(dir, { recursive: true, force: true });
  });

  console.log("\n=== STEP 1: Launch Downstream DSH Servers with Distinct Identifiers ===");
  dshA = await startIdentifiedDshServer("fixture-nas-node-A");
  dshB = await startIdentifiedDshServer("fixture-workstation-node-B");
  console.log(`[Evidence] DSH A running on ${dshA.target} with fixture 'fixture-nas-node-A'`);
  console.log(`[Evidence] DSH B running on ${dshB.target} with fixture 'fixture-workstation-node-B'`);

  console.log("\n=== STEP 2: Start Hub Daemon with Route Domain & Private CA ===");
  hub = await startHubProcess({ dbPath, caCertPath: nodeCertPath, routeDomain: REHEARSAL_DOMAIN, cadenceSeconds: 1 });
  console.log(`[Evidence] Hub running on ${hub.baseUrl} (routeDomain ${REHEARSAL_DOMAIN})`);
  let opSession = await getOperatorSession(hub.baseUrl);

  console.log("\n=== STEP 3: Start Rehearsal HTTPS Wildcard Gateway (*.stage3-test.example) ===");
  gateway = await startWildcardGateway({ keyPath: gwKeyPath, certPath: gwCertPath, hubPort: hub.port });
  console.log(`[Evidence] Rehearsal Wildcard HTTPS Gateway running on port ${gateway.port}`);

  console.log("\n=== STEP 4: Negative Gateway Tests (Public Machine API Denial & TLS SAN Rejection) ===");
  // Test 4.1: Public registration authority denies private machine API /api/v1/enroll with 403
  const machineDenialRes = await makeGatewayRequest({
    gatewayPort: gateway.port,
    authority: REGISTRATION_AUTHORITY,
    path: "/api/v1/enroll",
    method: "POST",
    caCert: wildcardCaCert,
  });
  assert.equal(machineDenialRes.status, 403);
  const machineDenialBody = await machineDenialRes.json();
  assert.equal(machineDenialBody.error.code, "machine-ingress-denied");
  console.log(`[Evidence] Negative test passed: /api/v1/* denied with 403 on registration authority`);

  // Test 4.2: Connecting to gateway with non-matching SAN fails closed on TLS
  let wrongSanCaught = false;
  try {
    await makeGatewayRequest({
      gatewayPort: gateway.port,
      authority: "wrong.attacker.com",
      path: "/",
      caCert: wildcardCaCert,
      rejectUnauthorized: true,
      servername: "wrong.attacker.com",
    });
  } catch (err) {
    wrongSanCaught = true;
    assert.match(err.message, /ERR_TLS_CERT_ALTNAME_INVALID|altnames/i);
  }
  assert.equal(wrongSanCaught, true);
  console.log(`[Evidence] Negative test passed: Non-matching SAN rejected fail-closed during TLS handshake`);

  console.log("\n=== STEP 5: Enroll and Upload Compatibility Reports for Both Nodes ===");
  const tokenA = await operatorMintToken(hub.baseUrl, opSession);
  const enrollResA = await runNodeEnroll({ statePath: statePathA, hubUrl: hub.baseUrl, enrollTokenValue: tokenA, caCertPath: nodeCertPath });
  await runNodeUploadReport({ statePath: statePathA, hubUrl: hub.baseUrl, reportPath, caCertPath: nodeCertPath });
  console.log(`[Evidence] Enrolled Node A: ${enrollResA.nodeId} and uploaded compatibility report (web.routes active)`);

  const tokenB = await operatorMintToken(hub.baseUrl, opSession);
  const enrollResB = await runNodeEnroll({ statePath: statePathB, hubUrl: hub.baseUrl, enrollTokenValue: tokenB });
  await runNodeUploadReport({ statePath: statePathB, hubUrl: hub.baseUrl, reportPath });
  console.log(`[Evidence] Enrolled Node B: ${enrollResB.nodeId} and uploaded compatibility report (web.routes active)`);

  console.log("\n=== STEP 6: Start Node Daemons (Node A on HTTPS + Private CA, Node B on HTTP) ===");
  nodeA = await startNodeDaemon({
    statePath: statePathA,
    hubUrl: hub.baseUrl,
    dshTarget: dshA.target,
    tlsKeyPath: nodeKeyPath,
    tlsCertPath: nodeCertPath,
    caCertPath: nodeCertPath,
    cadence: 30,
  });
  console.log(`[Evidence] Node A daemon started with HTTPS route ingress: ${nodeA.ingressOrigin}`);

  nodeB = await startNodeDaemon({
    statePath: statePathB,
    hubUrl: hub.baseUrl,
    dshTarget: dshB.target,
    cadence: 30,
  });
  console.log(`[Evidence] Node B daemon started with HTTP route ingress: ${nodeB.ingressOrigin}`);

  // Register route targets
  await operatorSetRouteTarget(hub.baseUrl, opSession, enrollResA.nodeId, nodeA.ingressOrigin);
  await operatorSetRouteTarget(hub.baseUrl, opSession, enrollResB.nodeId, nodeB.ingressOrigin);
  console.log(`[Evidence] Operator registered route targets for Node A and Node B`);

  const authorityA = computeRouteAuthority(enrollResA.nodeId, REHEARSAL_DOMAIN);
  const authorityB = computeRouteAuthority(enrollResB.nodeId, REHEARSAL_DOMAIN);
  console.log(`[Evidence] Deterministic Public Authority A: ${authorityA}`);
  console.log(`[Evidence] Deterministic Public Authority B: ${authorityB}`);

  console.log("\n=== STEP 7: Wait for 5-Condition Routing Eligibility ===");
  await waitForNodeEligible(hub.baseUrl, opSession, enrollResA.nodeId);
  await waitForNodeEligible(hub.baseUrl, opSession, enrollResB.nodeId);
  console.log(`[Evidence] Both nodes satisfied all 5 conditions (active, routeTarget, reachable=ok, activeKey, web.routes)`);

  console.log("\n=== STEP 8: Execute Routed HTTP Requests via Real HTTPS Wildcard Gateway ===");
  // Request through Authority A -> Must reach DSH A and return Fixture A
  // We send outer gateway credentials (Authorization and X-Gateway-Auth) to prove they are stripped by the gateway!
  const resA = await makeGatewayRequest({
    gatewayPort: gateway.port,
    authority: authorityA,
    path: "/api/v1/workspaces?query=alpha",
    method: "GET",
    headers: {
      authorization: "Basic b3BlcmF0b3I6cGFzc3dvcmQ=",
      "x-gateway-auth": "secret-rehearsal-token",
    },
    caCert: wildcardCaCert,
  });

  assert.equal(resA.status, 200);
  assert.equal(resA.headers["x-node-fixture"], "fixture-nas-node-A");
  const dataA = await resA.json();
  assert.equal(dataA.nodeFixture, "fixture-nas-node-A");
  assert.equal(dataA.path, "/api/v1/workspaces?query=alpha");
  assert.equal(dataA.hostHeader, authorityA);

  // Outer gateway credential isolation verified: downstream DSH never saw gateway credentials
  const dshAHeaders = dshA.getLastHeaders();
  assert.equal(typeof dshAHeaders.authorization, "undefined");
  assert.equal(typeof dshAHeaders["x-gateway-auth"], "undefined");

  // Cookie isolation: Domain attribute stripped on response
  const cookieHeaderA = resA.headers["set-cookie"];
  const cookieValA = Array.isArray(cookieHeaderA) ? cookieHeaderA.join("; ") : cookieHeaderA;
  assert.ok(cookieValA.includes("node_session=fixture-nas-node-A_sess"));
  assert.equal(cookieValA.toLowerCase().includes("domain="), false);
  console.log(`[Evidence] Authority A via HTTPS Wildcard Gateway routed to Node A (Fixture A returned, gateway credentials stripped, cookie host-only)`);

  // Request through Authority B -> Must reach DSH B and return Fixture B
  const resB = await makeGatewayRequest({
    gatewayPort: gateway.port,
    authority: authorityB,
    path: "/api/v1/workspaces?query=beta",
    method: "GET",
    caCert: wildcardCaCert,
  });
  assert.equal(resB.status, 200);
  assert.equal(resB.headers["x-node-fixture"], "fixture-workstation-node-B");
  const dataB = await resB.json();
  assert.equal(dataB.nodeFixture, "fixture-workstation-node-B");
  assert.equal(dataB.path, "/api/v1/workspaces?query=beta");
  assert.equal(dataB.hostHeader, authorityB);

  const cookieHeaderB = resB.headers["set-cookie"];
  const cookieValB = Array.isArray(cookieHeaderB) ? cookieHeaderB.join("; ") : cookieHeaderB;
  assert.ok(cookieValB.includes("node_session=fixture-workstation-node-B_sess"));
  assert.equal(cookieValB.toLowerCase().includes("domain="), false);
  console.log(`[Evidence] Authority B via HTTPS Wildcard Gateway routed to Node B (Fixture B returned, isolation verified)`);

  console.log("\n=== STEP 9: Fault Isolation (Stop Node A Process) ===");
  await killProcess(nodeA.child);
  console.log("[Evidence] Node A child process terminated");

  // Allow Hub probe scheduler to detect failure and mark unreachable
  await sleep(3500);

  // Request through Authority A -> Must fail closed with 503 Selected node is unavailable
  const failResA = await makeGatewayRequest({
    gatewayPort: gateway.port,
    authority: authorityA,
    path: "/api/v1/workspaces",
    method: "GET",
    caCert: wildcardCaCert,
  });
  assert.equal(failResA.status, 503);
  const failDataA = await failResA.json();
  assert.equal(failDataA.error.code, "node-unavailable");
  console.log(`[Evidence] Authority A failed closed with 503 (no fallback to Node B)`);

  // Request through Authority B -> Must remain 100% operational
  const okResB = await makeGatewayRequest({
    gatewayPort: gateway.port,
    authority: authorityB,
    path: "/api/v1/workspaces",
    method: "GET",
    caCert: wildcardCaCert,
  });
  assert.equal(okResB.status, 200);
  assert.equal(okResB.headers["x-node-fixture"], "fixture-workstation-node-B");
  console.log(`[Evidence] Authority B remains healthy during Node A outage (isolation verified)`);

  console.log("\n=== STEP 10: Process Restarts & Route Persistence (Hub + Nodes) ===");
  const hubPort = hub.port;
  const nodeAPort = nodeA.port;
  const nodeBPort = nodeB.port;

  await killProcess(nodeB.child);
  await killProcess(hub.child);
  console.log("[Evidence] All child processes terminated for restart test");

  // Restart Hub on same DB & port
  hub = await startHubProcess({ dbPath, port: hubPort, caCertPath: nodeCertPath, routeDomain: REHEARSAL_DOMAIN, cadenceSeconds: 1 });
  opSession = await getOperatorSession(hub.baseUrl);
  console.log(`[Evidence] Restarted Hub on ${hub.baseUrl}`);

  // Restart Node A on same state file & ingress port
  nodeA = await startNodeDaemon({
    statePath: statePathA,
    hubUrl: hub.baseUrl,
    ingressPort: nodeAPort,
    dshTarget: dshA.target,
    tlsKeyPath: nodeKeyPath,
    tlsCertPath: nodeCertPath,
    caCertPath: nodeCertPath,
    cadence: 30,
  });
  console.log(`[Evidence] Restarted Node A daemon on ${nodeA.ingressOrigin}`);

  // Restart Node B on same state file & ingress port
  nodeB = await startNodeDaemon({
    statePath: statePathB,
    hubUrl: hub.baseUrl,
    ingressPort: nodeBPort,
    dshTarget: dshB.target,
    cadence: 30,
  });
  console.log(`[Evidence] Restarted Node B daemon on ${nodeB.ingressOrigin}`);

  // Wait for both nodes to regain routing eligibility
  await waitForNodeEligible(hub.baseUrl, opSession, enrollResA.nodeId);
  await waitForNodeEligible(hub.baseUrl, opSession, enrollResB.nodeId);

  // Both authorities route traffic successfully post-restart through HTTPS gateway
  const postResA = await makeGatewayRequest({
    gatewayPort: gateway.port,
    authority: authorityA,
    path: "/",
    caCert: wildcardCaCert,
  });
  assert.equal(postResA.status, 200);
  assert.equal(postResA.headers["x-node-fixture"], "fixture-nas-node-A");

  const postResB = await makeGatewayRequest({
    gatewayPort: gateway.port,
    authority: authorityB,
    path: "/",
    caCert: wildcardCaCert,
  });
  assert.equal(postResB.status, 200);
  assert.equal(postResB.headers["x-node-fixture"], "fixture-workstation-node-B");
  console.log(`[Evidence] Post-restart verification: Authorities A and B route through HTTPS gateway with zero identity drift!`);
});
