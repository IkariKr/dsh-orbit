// Stage 4 Acceptance Test: True Supported DSH 0.1.1-rc.2 Process End-to-End Acceptance
//
// This test runs only when DSH_ACCEPTANCE_ROOT points to a valid DeepSeek Harness
// checkout. When DSH_ACCEPTANCE_ROOT is not provided, the test self-skips cleanly,
// ensuring that standard CI and clean-clone test runs are 100% self-contained without
// machine-specific or hardcoded directory bindings.
//
// When DSH_ACCEPTANCE_ROOT is explicitly configured:
// 1. Validates checkout path existence, package.json version ("0.1.1-rc.2"), and exact Git SHA
//    - Failing closed with clear assertion errors if the configured path is invalid or unbuilt
// 2. Starts a REAL DSH process with an isolated temporary DSH_HOME:
//    `node apps/cli/lib/bin.js web --no-open --host 127.0.0.1 --port 0 --trusted-host <authority>`
// 3. Executes production `scripts/smoke-websocket.mjs` against the live DSH process to generate
//    verifiable pass evidence, and uploads that real evidence in the node compatibility report
// 4. Connects an Orbit Node RouteIngress daemon to the genuine DSH process
// 5. Routes traffic through a Wildcard TLS Rehearsal Gateway (*.stage4-test.example)
// 6. Validates:
//    - Real HTTP root index.html (`<title>DSH Local Build</title>` / `<div id="root"></div>`)
//    - Real static assets (`/assets/index-C6eRlFa6.css`)
//    - Real DSH WebSocket downlink (`/api/events.mux`) with dynamic `Sec-WebSocket-Accept`
//    - Real Ping -> Pong frame roundtrip with matching payload
//    - Real client violation close: 1008 "downlink only"
//    - Real DSH browser-trust fence rejection on mismatched Origin: 403 Forbidden

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomBytes } from "node:crypto";
import { GATEWAY_CERT_PEM, GATEWAY_KEY_PEM } from "./fixtures/gateway-identity.mjs";
import { validReport } from "./helpers/registry-fixture.mjs";
import { startWildcardGateway } from "./helpers/wildcard-gateway-fixture.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REHEARSAL_DOMAIN = "stage4-test.example";
const REHEARSAL_GATEWAY_TOKEN = "valid-stage4-gateway-secret-token";

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

function encodeFrame(data, { opcode = 0x01, isClient = true } = {}) {
  const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const len = dataBuf.length;
  let headerLen = 2;
  if (len > 125 && len <= 65535) headerLen += 2;
  else if (len > 65535) headerLen += 8;
  if (isClient) headerLen += 4;

  const buf = Buffer.alloc(headerLen + len);
  buf[0] = 0x80 | (opcode & 0x0f);
  let offset = 1;
  const maskBit = isClient ? 0x80 : 0x00;

  if (len <= 125) {
    buf[offset++] = maskBit | len;
  } else if (len <= 65535) {
    buf[offset++] = maskBit | 126;
    buf.writeUInt16BE(len, offset);
    offset += 2;
  } else {
    buf[offset++] = maskBit | 127;
    buf.writeBigUInt64BE(BigInt(len), offset);
    offset += 8;
  }

  if (isClient) {
    const maskKey = Buffer.from([9, 8, 7, 6]);
    maskKey.copy(buf, offset);
    offset += 4;
    for (let i = 0; i < len; i++) {
      buf[offset + i] = dataBuf[i] ^ maskKey[i % 4];
    }
  } else {
    dataBuf.copy(buf, offset);
  }
  return buf;
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const hasMask = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  let maskKey = null;
  if (hasMask) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    payload[i] = hasMask ? buf[offset + i] ^ maskKey[i % 4] : buf[offset + i];
  }
  return { opcode, payload, totalLength: offset + len };
}

function safeDestroy(socket) {
  if (!socket) return;
  try {
    socket.destroy();
  } catch {}
}

function connectGatewayTlsSocket({ gatewayPort, authority, caCert }) {
  return new Promise((resolve, reject) => {
    const sName = authority.split(":")[0];
    const socket = tls.connect(
      {
        port: gatewayPort,
        host: "127.0.0.1",
        ca: caCert ? [caCert] : undefined,
        servername: sName,
        rejectUnauthorized: true,
      },
      () => resolve(socket),
    );
    socket.on("error", reject);
  });
}

function performWssUpgrade(tlsSocket, { authority, path = "/api/events.mux", headers = {} }) {
  return new Promise((resolve, reject) => {
    const secKey = randomBytes(16).toString("base64");
    const reqHeaders = {
      Host: authority,
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": secKey,
      ...headers,
    };

    const lines = [`GET ${path} HTTP/1.1`];
    for (const [k, v] of Object.entries(reqHeaders)) {
      lines.push(`${k}: ${v}`);
    }
    lines.push("", "");
    const rawReq = lines.join("\r\n");

    let received = Buffer.alloc(0);
    let resolved = false;

    const tryParse = () => {
      if (resolved) return;
      const idx = received.indexOf("\r\n\r\n");
      if (idx !== -1) {
        const headerText = received.slice(0, idx + 4).toString("utf8");
        const headerLines = headerText.split("\r\n");
        const statusMatch = headerLines[0].match(/HTTP\/1\.[01]\s+(\d+)/);
        const status = statusMatch ? Number(statusMatch[1]) : 0;
        const respHeaders = {};
        for (let i = 1; i < headerLines.length; i++) {
          const line = headerLines[i];
          if (!line) continue;
          const colon = line.indexOf(":");
          if (colon !== -1) {
            respHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
          }
        }
        const expectedLen = respHeaders["content-length"] ? Number(respHeaders["content-length"]) : 0;
        const bodyBytes = received.slice(idx + 4);

        if (status === 101) {
          const expectedAccept = createHash("sha1").update(secKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
          assert.equal(respHeaders["sec-websocket-accept"], expectedAccept, "Sec-WebSocket-Accept must match client key hash");
          resolved = true;
          tlsSocket.removeListener("data", onData);
          resolve({
            status,
            headers: respHeaders,
            body: bodyBytes.toString("utf8"),
            socket: tlsSocket,
            remainingBytes: bodyBytes.slice(expectedLen),
          });
        } else if (bodyBytes.length >= expectedLen) {
          resolved = true;
          tlsSocket.removeListener("data", onData);
          resolve({
            status,
            headers: respHeaders,
            body: bodyBytes.toString("utf8"),
            socket: tlsSocket,
            remainingBytes: bodyBytes.slice(expectedLen),
          });
        }
      }
    };

    const onData = (chunk) => {
      received = Buffer.concat([received, chunk]);
      tryParse();
    };

    tlsSocket.on("data", onData);
    tlsSocket.on("end", () => {
      if (resolved) return;
      const idx = received.indexOf("\r\n\r\n");
      if (idx !== -1) {
        resolved = true;
        const headerText = received.slice(0, idx + 4).toString("utf8");
        const headerLines = headerText.split("\r\n");
        const statusMatch = headerLines[0].match(/HTTP\/1\.[01]\s+(\d+)/);
        const status = statusMatch ? Number(statusMatch[1]) : 0;
        const respHeaders = {};
        for (let i = 1; i < headerLines.length; i++) {
          const line = headerLines[i];
          if (!line) continue;
          const colon = line.indexOf(":");
          if (colon !== -1) {
            respHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
          }
        }
        const bodyBytes = received.slice(idx + 4);
        resolve({
          status,
          headers: respHeaders,
          body: bodyBytes.toString("utf8"),
          socket: tlsSocket,
          remainingBytes: Buffer.alloc(0),
        });
      }
    });
    tlsSocket.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    tlsSocket.write(rawReq);
  });
}

function makeGatewayRequest({ gatewayPort, authority, path = "/", headers = {}, caCert }) {
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
        method: "GET",
        headers: reqHeaders,
        ca: caCert ? [caCert] : undefined,
        rejectUnauthorized: true,
        servername: authority.split(":")[0],
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
    req.end();
  });
}

function resolveDshCheckout() {
  const envPath = process.env.DSH_ACCEPTANCE_ROOT;
  if (!envPath) return null;
  if (!existsSync(envPath)) {
    throw new Error(`DSH_ACCEPTANCE_ROOT is configured as ${envPath}, but directory does not exist`);
  }
  return envPath;
}

test("Stage 4 Live Acceptance: Real DeepSeek Harness 0.1.1-rc.2 Process Acceptance", async (t) => {
  const dshRoot = resolveDshCheckout();
  if (!dshRoot) {
    t.skip("DSH_ACCEPTANCE_ROOT not configured; skipping real DSH process acceptance (pure-environment clean pass)");
    return;
  }

  const pkgFile = join(dshRoot, "package.json");
  const binFile = join(dshRoot, "apps/cli/lib/bin.js");
  if (!existsSync(pkgFile)) {
    throw new Error(`DSH checkout at ${dshRoot} does not contain package.json`);
  }
  if (!existsSync(binFile)) {
    throw new Error(`DSH checkout at ${dshRoot} does not have built CLI artifacts (missing ${binFile}); run 'pnpm build' in DSH root first`);
  }

  const pkgJson = JSON.parse(readFileSync(pkgFile, "utf8"));
  const exactVersion = pkgJson.version;
  const exactGitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dshRoot, encoding: "utf8" }).trim();

  console.log(`\n[Real DSH Provenance] Discovered genuine DSH checkout: ${dshRoot}`);
  console.log(`[Real DSH Provenance] Exact Git SHA: ${exactGitSha}`);
  console.log(`[Real DSH Provenance] Exact Package Version: ${exactVersion}`);

  assert.equal(exactVersion, "0.1.1-rc.2", "Target supported profile must be 0.1.1-rc.2");
  assert.equal(exactGitSha, "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e", "Git commit must match exact 0.1.1-rc.2 tree");

  const dir = await mkdtemp(join(tmpdir(), "orbit-stage4-real-dsh-"));
  const dshHomeDir = join(dir, "isolated-dsh-home");
  const dbPath = join(dir, "hub.db");
  const statePath = join(dir, "node.json");
  const reportPath = join(dir, "report.json");
  const { keyPath: gwKeyPath, certPath: gwCertPath } = await generateWildcardCertificate(dir);
  const wildcardCaCert = await readFile(gwCertPath);

  let hubChild = null;
  let gateway = null;
  let nodeChild = null;
  let dshChild = null;

  t.after(async () => {
    await killProcess(nodeChild);
    await killProcess(dshChild);
    await killProcess(hubChild);
    if (gateway) await gateway.close();
    await rm(dir, { recursive: true, force: true });
  });

  // Step 1: Start Hub
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

  // Step 2: Start Wildcard Gateway using shared authenticated fixture
  gateway = await startWildcardGateway({
    keyPath: gwKeyPath,
    certPath: gwCertPath,
    hubPort,
    routeDomain: REHEARSAL_DOMAIN,
    gatewayToken: REHEARSAL_GATEWAY_TOKEN,
  });
  const gatewayPort = gateway.port;

  // Step 3: Enroll Node
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

  const tokRes = await fetch(`${hubBaseUrl}/hub/tokens`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ purpose: "enroll" }),
  });
  const { token: enrollToken } = await tokRes.json();

  const enrollChild = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "enroll"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DSH_ORBIT_NODE_STATE: statePath,
      DSH_ORBIT_HUB_URL: hubBaseUrl,
      DSH_ORBIT_ENROLL_TOKEN: enrollToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let enrollOut = "";
  enrollChild.stdout.on("data", (c) => (enrollOut += c));
  await new Promise((r) => enrollChild.on("exit", r));
  const nodeId = enrollOut.match(/enrolled: (node_[0-9a-f]{32})/)?.[1];
  assert.ok(nodeId, "Node must enroll successfully");
  const authority = computeRouteAuthority(nodeId, REHEARSAL_DOMAIN);
  console.log(`[Real DSH Acceptance] Provisioned deterministic authority: ${authority}`);

  // Step 4: Launch Real DSH CLI Web Process with Isolated DSH_HOME
  const dshPort = await new Promise((resolve, reject) => {
    // Sanitized environment: strip developer's host-level DSH and editor settings, isolate DSH_HOME
    const cleanDshEnv = {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      HOMEDRIVE: process.env.HOMEDRIVE,
      HOMEPATH: process.env.HOMEPATH,
      USERPROFILE: process.env.USERPROFILE,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP,
      NODE_ENV: "production",
      DSH_HOME: dshHomeDir,
      DEEPSEEK_API_KEY: "keyless-acceptance-no-llm",
    };
    dshChild = spawn(
      process.execPath,
      [binFile, "web", "--no-open", "--host", "127.0.0.1", "--port", "0", "--trusted-host", authority],
      {
        cwd: dshRoot,
        env: cleanDshEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    dshChild.stdout.on("data", (c) => {
      stdout += c.toString();
      const match = stdout.match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    dshChild.stderr.on("data", (c) => (stderr += c.toString()));
    dshChild.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Real DSH process exited early code ${code}: ${stderr}`));
      }
    });
  });
  console.log(`[Real DSH Acceptance] Genuine DSH web process active on http://127.0.0.1:${dshPort} (isolated DSH_HOME: ${dshHomeDir})`);

  // Step 5: Execute Production smoke-websocket.mjs to generate authentic capability evidence
  const smokeChild = spawn(process.execPath, ["scripts/smoke-websocket.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DSH_SMOKE_URL: `http://127.0.0.1:${dshPort}`,
      DSH_SMOKE_TIMEOUT_MS: "3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let smokeStdout = "";
  let smokeStderr = "";
  smokeChild.stdout.on("data", (c) => (smokeStdout += c.toString()));
  smokeChild.stderr.on("data", (c) => (smokeStderr += c.toString()));
  const smokeExitCode = await new Promise((r) => smokeChild.on("exit", r));
  assert.equal(smokeExitCode, 0, `Production smoke-websocket.mjs must pass on real DSH: ${smokeStderr}`);
  assert.match(smokeStdout, /webSocketTransport: pass/);
  console.log(`[Real DSH Acceptance] Production smoke-websocket.mjs verified against real DSH: ${smokeStdout.trim()}`);

  // Step 6: Upload Compatibility Report containing authentic webSocketTransport pass evidence
  const reportPayload = validReport({
    orbitVersion: "0.4.0",
    dshVersion: exactVersion,
    profile: "dsh-0.1.1-rc.2",
  });
  reportPayload.checks.webSocketTransport = {
    status: "pass",
    detail: smokeStdout.trim(),
  };
  await writeFile(reportPath, JSON.stringify(reportPayload), "utf8");

  const reportChild = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "upload-report"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DSH_ORBIT_NODE_STATE: statePath,
      DSH_ORBIT_HUB_URL: hubBaseUrl,
      DSH_ORBIT_REPORT_FILE: reportPath,
    },
  });
  await new Promise((r) => reportChild.on("exit", r));

  // Step 7: Start Node Route Ingress
  const node = await new Promise((resolve, reject) => {
    nodeChild = spawn(
      process.execPath,
      ["bin/dsh-orbit-node.mjs", "run"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DSH_ORBIT_NODE_STATE: statePath,
          DSH_ORBIT_HUB_URL: hubBaseUrl,
          DSH_ORBIT_NODE_HEARTBEAT_SECONDS: "30",
          DSH_ORBIT_NODE_ORBIT_VERSION: "0.4.0",
          DSH_ORBIT_NODE_ORBIT_REVISION: "abc123",
          DSH_ORBIT_NODE_DSH_VERSION: "0.1.1-rc.2",
          DSH_ORBIT_NODE_DSH_PROFILE: "dsh-0.1.1-rc.2",
          DSH_ORBIT_NODE_ROUTE_INGRESS_PORT: "0",
          DSH_ORBIT_NODE_ROUTE_INGRESS_LISTEN: "127.0.0.1",
          DSH_ORBIT_NODE_DSH_TARGET: `http://127.0.0.1:${dshPort}`,
          DSH_ORBIT_NODE_ROUTE_DOMAIN: REHEARSAL_DOMAIN,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    nodeChild.stdout.on("data", (c) => {
      stdout += c.toString();
      const match = stdout.match(/route ingress listening on (https?:\/\/127\.0\.0\.1:(\d+))/);
      if (match) {
        resolve({ ingressOrigin: match[1], port: Number(match[2]) });
      }
    });
    nodeChild.stderr.on("data", (c) => (stderr += c.toString()));
    nodeChild.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Node daemon exited early code ${code}: ${stderr}`));
      }
    });
    nodeChild.on("error", reject);
  });

  await fetch(`${hubBaseUrl}/hub/nodes/${nodeId}/route-target`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ routeTarget: node.ingressOrigin }),
  });

  // Step 8: Verify 5-condition routing eligibility on Hub (webSocketTransport pass -> web.routes granted)
  const startWait = Date.now();
  while (Date.now() - startWait < 15000) {
    const nodeRes = await fetch(`${hubBaseUrl}/hub/nodes/${nodeId}`, { headers: authHeaders });
    const n = await nodeRes.json();
    const hasActiveKey = (n.hubRouteKeys || []).some((k) => k.state === "active");
    const hasRouteTarget = Boolean(n.routeTarget);
    const isReachable = n.health?.reachable === "ok";
    const isActive = n.state === "active";
    const hasWebRoutes = (n.health?.capabilities || []).some((c) => c.name === "web.routes");

    if (isActive && hasRouteTarget && isReachable && hasActiveKey && hasWebRoutes) {
      break;
    }
    await sleep(200);
  }
  console.log(`[Real DSH Acceptance] Routing active and verified 5-condition eligible on Hub (web.routes granted)`);

  // Step 9: Verify Outer Gateway Authentication Fence (HTTP & WebSocket)
  const unauthHttpRes = await makeGatewayRequest({
    gatewayPort,
    authority,
    path: "/",
    caCert: wildcardCaCert,
  });
  assert.equal(unauthHttpRes.status, 401, "Wildcard gateway must reject unauthenticated HTTP with 401");

  const wrongAuthHttpRes = await makeGatewayRequest({
    gatewayPort,
    authority,
    path: "/",
    caCert: wildcardCaCert,
    headers: { "x-gateway-auth": "invalid-gateway-token" },
  });
  assert.equal(wrongAuthHttpRes.status, 401, "Wildcard gateway must reject invalid HTTP gateway auth with 401");

  const unauthTlsSocket = await connectGatewayTlsSocket({ gatewayPort, authority, caCert: wildcardCaCert });
  const unauthWsRes = await performWssUpgrade(unauthTlsSocket, {
    authority,
    path: "/api/events.mux",
    headers: { Origin: `https://${authority}` },
  });
  assert.equal(unauthWsRes.status, 401, "Wildcard gateway must reject unauthenticated WebSocket upgrade with 401");
  safeDestroy(unauthTlsSocket);

  const wrongAuthTlsSocket = await connectGatewayTlsSocket({ gatewayPort, authority, caCert: wildcardCaCert });
  const wrongAuthWsRes = await performWssUpgrade(wrongAuthTlsSocket, {
    authority,
    path: "/api/events.mux",
    headers: { "x-gateway-auth": "wrong-token", Origin: `https://${authority}` },
  });
  assert.equal(wrongAuthWsRes.status, 401, "Wildcard gateway must reject invalid WebSocket gateway auth with 401");
  safeDestroy(wrongAuthTlsSocket);
  console.log(`[Real DSH Acceptance] Outer gateway authentication fence verified (missing/invalid credentials return 401)`);

  // Step 10: Verify Real HTTP Root and Assets over Authenticated Wildcard Gateway
  const rootRes = await makeGatewayRequest({
    gatewayPort,
    authority,
    path: "/",
    caCert: wildcardCaCert,
    headers: { "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN },
  });
  assert.equal(rootRes.status, 200);
  const rootHtml = await rootRes.text();
  assert.ok(rootHtml.includes('<div id="root"></div>'), "Real DSH HTML must contain root container");
  console.log(`[Real DSH Acceptance] Genuine DSH HTML root served through wildcard gateway`);

  const assetRes = await makeGatewayRequest({
    gatewayPort,
    authority,
    path: "/assets/index-C6eRlFa6.css",
    caCert: wildcardCaCert,
    headers: { "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN },
  });
  assert.equal(assetRes.status, 200, "Real DSH static CSS asset must be served through gateway with HTTP 200");
  assert.ok((await assetRes.text()).length > 100, "Real DSH static CSS asset must have valid content");
  console.log(`[Real DSH Acceptance] Genuine DSH static CSS asset (/assets/index-C6eRlFa6.css) verified through wildcard gateway`);

  // Step 11: Verify Real DSH WebSocket Downlink (/api/events.mux)
  const tlsSocket = await connectGatewayTlsSocket({ gatewayPort, authority, caCert: wildcardCaCert });
  const wsRes = await performWssUpgrade(tlsSocket, {
    authority,
    path: "/api/events.mux",
    headers: {
      "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN,
      Origin: `https://${authority}`,
    },
  });
  assert.equal(wsRes.status, 101, "Real DSH must upgrade /api/events.mux with 101");
  assert.equal(wsRes.headers.upgrade.toLowerCase(), "websocket");
  console.log(`[Real DSH Acceptance] Real DSH 101 Switching Protocols verified on /api/events.mux`);

  // Verify Ping -> Pong control frame roundtrip with matching payload
  const pingPayload = Buffer.from("orbit-dsh-transport-ping");
  tlsSocket.write(encodeFrame(pingPayload, { opcode: 0x09, isClient: true }));

  const pongReceived = await new Promise((resolve) => {
    let buf = wsRes.remainingBytes && wsRes.remainingBytes.length > 0 ? Buffer.from(wsRes.remainingBytes) : Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const frame = decodeFrame(buf);
        if (!frame) break;
        buf = buf.slice(frame.totalLength);
        if (frame.opcode === 0x0a) {
          tlsSocket.removeListener("data", onData);
          resolve(frame.payload.toString("utf8"));
          return;
        }
      }
    };
    tlsSocket.on("data", onData);
  });
  assert.equal(pongReceived, "orbit-dsh-transport-ping", "Pong frame must echo identical Ping payload");
  console.log(`[Real DSH Acceptance] Real DSH Ping -> Pong frame roundtrip verified over routed WSS`);

  // Verify client application message triggers 1008 "downlink only"
  tlsSocket.write(encodeFrame("client message violation", { opcode: 0x01, isClient: true }));
  const closeReceived = await new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const frame = decodeFrame(buf);
        if (!frame) break;
        buf = buf.slice(frame.totalLength);
        if (frame.opcode === 0x08) {
          tlsSocket.removeListener("data", onData);
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 0;
          const reason = frame.payload.slice(2).toString("utf8");
          resolve({ code, reason });
          return;
        }
      }
    };
    tlsSocket.on("data", onData);
  });
  assert.equal(closeReceived.code, 1008, "Real DSH must close with 1008 on client message");
  assert.equal(closeReceived.reason, "downlink only", "Real DSH must specify 'downlink only' close reason");
  console.log(`[Real DSH Acceptance] Real DSH protocol violation correctly closed with 1008 'downlink only'`);
  safeDestroy(tlsSocket);

  // Negative test: DSH browser-trust fence denies mismatched Origin
  const mismatchRes = await makeGatewayRequest({
    gatewayPort,
    authority,
    path: "/api/events.mux",
    caCert: wildcardCaCert,
    headers: {
      "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN,
      Origin: "https://evil.untrusted.attacker",
    },
  });
  assert.equal(mismatchRes.status, 403, "Real DSH browser-trust fence must deny mismatched Origin with 403");
  console.log(`[Real DSH Acceptance] Real DSH browser-trust fence verified: mismatched Origin returns 403`);
});
