// Mounted-deployment drill driver (SOP Stage 6 / Gate B live evidence).
// Requires Docker Desktop with the Linux engine running.
//
// Topology: docker-registry/drill.compose.yaml — real Caddy (shared
// netns with the Hub), real Hub image (loopback bind, persistent
// SQLite), two real DSH containers each running a real Orbit Node.
// Browser-surface operations go through the TLS gateway; machine-path
// operations run inside the containers through the private 5446 ingress,
// which forwards to the Hub's loopback-only 127.0.0.1:5445 listener.
//
// Usage:
//   node scripts/registry-drill.mjs [--compose-up] [--wait-for-browser] [--keep]
// Prints a JSON evidence record and writes data/drill-evidence.json.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { request as httpsRequest } from "node:https";
import tls from "node:tls";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCompatibilityReport } from "../src/compatibility-report.mjs";
import { runVerificationSequence } from "../src/upgrade-runner.mjs";
import { REQUIRED_MOUNTED_MATRIX_FIELDS, emptyMountedMatrix, assertMountedMatrixShape } from "./stage8-mounted-matrix.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const COMPOSE = "docker-registry/drill.compose.yaml";
const HUB_URL = "http://127.0.0.1:5445/";
const ROUTE_DOMAIN = "dsh-orbit.test";
const ROUTE_GATEWAY_TOKEN = "drill-proxy-secret";
// Nodes reach the Hub through the PRIVATE machine ingress on the
// compose bridge (the Hub process itself stays loopback-only).
const NODE_HUB_URL = "http://registry-hub:5446/";
const GATEWAY_URL = "https://127.0.0.1:8443";
const ROUTE_GATEWAY_URL = GATEWAY_URL;
const AUTH = `Basic ${Buffer.from("operator:drill-password").toString("base64")}`;
const DRILL_PROXY_SECRET = "drill-proxy-secret";
const DRILL_PROXY_SECRET_PATH = join(REPO, "secrets", "dsh_proxy_auth");
const NODE_BIN = "/usr/local/lib/dsh-orbit/bin/dsh-orbit-node.mjs";
const REVISION = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO }).toString().trim();
const HEARTBEAT_CADENCE_SECONDS = 60;
const HEARTBEAT_MISSED_BEATS = 3;
const HEARTBEAT_LOST_MS = 24 * 60 * 60 * 1000;
const AGING_CLOCK_PATH = join(REPO, "data", "orbit-drill", "drill-aging-clock");
const RAW_EVIDENCE_PATH = join(REPO, "data", "drill-evidence.json");
const DRILL_CA_PATH = join(REPO, "data", "orbit-drill", "tls", "ca.crt");
const DRILL_CA_KEY_PATH = join(REPO, "data", "orbit-drill", "tls", "ca.key");
const DRILL_CERT_PATH = join(REPO, "data", "orbit-drill", "tls", "tls.crt");
const DRILL_CERT_KEY_PATH = join(REPO, "data", "orbit-drill", "tls", "tls.key");
const DRILL_CSR_PATH = join(REPO, "data", "orbit-drill", "tls", "tls.csr");
const DRILL_EXT_PATH = join(REPO, "data", "orbit-drill", "tls", "tls.ext");
const BROWSER_BOOTSTRAP_CHECKPOINT_PATH = join(
  REPO,
  "data",
  "orbit-drill",
  "browser-bootstrap-checkpoint.json",
);
const BROWSER_CHECKPOINT_PATH = join(REPO, "data", "orbit-drill", "browser-checkpoint.json");
const BROWSER_BINDINGS_PATH = join(REPO, "data", "orbit-drill", "browser-checkpoint-bindings.json");
const BROWSER_NODE_BINDING_PATH = join(REPO, "data", "orbit-drill", "browser-node-binding.json");
const BROWSER_STOP_PATH = join(REPO, "data", "orbit-drill", "browser-stop");
const BROWSER_BRIDGE_LOG_PATH = join(REPO, "data", "orbit-drill", "browser-bridge.log");
const BROWSER_BRIDGE_PATH = join(REPO, "scripts", "registry-drill-firefox-bridge.py");
const REQUIRED_MATRIX_FIELDS = REQUIRED_MOUNTED_MATRIX_FIELDS;
const RUN_ID = randomUUID();
const BROWSER_CHALLENGE = randomUUID();
let browserBridgeProcess = null;
let resolvedOpenSsl = null;

const evidence = {
  schemaVersion: 3,
  kind: "stage8-mounted-runner-raw",
  runId: RUN_ID,
  commit: REVISION,
  candidateCommit: REVISION,
  startedAt: new Date().toISOString(),
  producer: "registry-drill-runner",
  requiredMatrix: emptyMountedMatrix(),
  steps: [],
};
let runCleanup = async () => {};

function markMatrix(...fields) {
  for (const field of fields) {
    if (!REQUIRED_MATRIX_FIELDS.includes(field)) throw new Error(`unknown mounted matrix field: ${field}`);
    evidence.requiredMatrix[field] = "PASS";
  }
}

function assertMatrixComplete() {
  assertMountedMatrixShape(evidence.requiredMatrix, { requirePass: true });
}

function requireCleanCandidateWorktree() {
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: REPO })
    .toString()
    .trim();
  if (status !== "") {
    throw new Error(
      `mounted drill requires a clean candidate worktree; commit ${REVISION} has uncommitted changes`,
    );
  }
  evidence.provenance = {
    commit: REVISION,
    cleanWorktree: true,
    statusPorcelain: "",
  };
}

function resolveOpenSsl() {
  if (resolvedOpenSsl !== null) return resolvedOpenSsl;
  const candidates = [];
  if (process.env.DSH_ORBIT_OPENSSL_BIN) candidates.push(process.env.DSH_ORBIT_OPENSSL_BIN);
  if (process.platform === "win32") {
    const where = spawnSync("where.exe", ["openssl.exe"], { cwd: REPO, encoding: "utf8" });
    candidates.push(...(where.stdout ?? "").split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean));
    candidates.push(
      "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
      "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    );
  }
  candidates.push("openssl");
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["version"], { cwd: REPO, encoding: "utf8" });
    if (probe.status === 0) {
      resolvedOpenSsl = candidate;
      return candidate;
    }
  }
  throw new Error(
    "OpenSSL is required for the trusted drill certificate. Install OpenSSL, add openssl.exe to PATH, or set DSH_ORBIT_OPENSSL_BIN to its full path",
  );
}

function certificateUsable(path, caPath = null) {
  if (!existsSync(path)) return false;
  const openssl = resolveOpenSsl();
  const expiry = spawnSync(openssl, ["x509", "-in", path, "-noout", "-checkend", "60"], {
    cwd: REPO,
    encoding: "utf8",
  });
  if (expiry.status !== 0) return false;
  if (caPath !== null) {
    const verified = spawnSync(openssl, ["verify", "-CAfile", caPath, path], {
      cwd: REPO,
      encoding: "utf8",
    });
    if (verified.status !== 0) return false;
  }
  return true;
}

function ensureDrillCertificate() {
  const openssl = resolveOpenSsl();
  mkdirSync(join(REPO, "data", "orbit-drill", "tls"), { recursive: true });
  const caReady = existsSync(DRILL_CA_KEY_PATH) && certificateUsable(DRILL_CA_PATH);
  if (!caReady) {
    file(openssl, [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "2",
      "-nodes",
      "-keyout",
      DRILL_CA_KEY_PATH,
      "-out",
      DRILL_CA_PATH,
      "-subj",
      "/CN=dsh-orbit-drill-ca",
    ]);
  }

  const leafReady =
    existsSync(DRILL_CERT_KEY_PATH) &&
    existsSync(DRILL_EXT_PATH) &&
    readFileSync(DRILL_EXT_PATH, "utf8").includes(ROUTE_DOMAIN) &&
    certificateUsable(DRILL_CERT_PATH, DRILL_CA_PATH);
  if (!leafReady) {
    writeFileSync(
      DRILL_EXT_PATH,
      `subjectAltName=IP:127.0.0.1,DNS:${ROUTE_DOMAIN},DNS:*.${ROUTE_DOMAIN},DNS:dsh-a,DNS:dsh-b,DNS:dsh-a.test,DNS:dsh-b.test\n`,
    );
    file(openssl, [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      DRILL_CERT_KEY_PATH,
      "-out",
      DRILL_CSR_PATH,
      "-subj",
      "/CN=127.0.0.1",
    ]);
    file(openssl, [
      "x509",
      "-req",
      "-in",
      DRILL_CSR_PATH,
      "-CA",
      DRILL_CA_PATH,
      "-CAkey",
      DRILL_CA_KEY_PATH,
      "-CAcreateserial",
      "-out",
      DRILL_CERT_PATH,
      "-days",
      "2",
      "-sha256",
      "-extfile",
      DRILL_EXT_PATH,
    ]);
  }
  try {
    chmodSync(DRILL_CERT_PATH, 0o644);
    chmodSync(DRILL_CERT_KEY_PATH, 0o644);
    chmodSync(DRILL_CA_PATH, 0o644);
  } catch {}
  evidence.tls = {
    validation: "enabled",
    caPath: DRILL_CA_PATH,
    caFingerprint: file(openssl, ["x509", "-in", DRILL_CA_PATH, "-noout", "-fingerprint", "-sha256"]),
    leafFingerprint: file(openssl, ["x509", "-in", DRILL_CERT_PATH, "-noout", "-fingerprint", "-sha256"]),
    sans: ["127.0.0.1", ROUTE_DOMAIN, `*.${ROUTE_DOMAIN}`, "dsh-a", "dsh-b", "dsh-a.test", "dsh-b.test"],
  };
  mkdirSync(dirname(BROWSER_BINDINGS_PATH), { recursive: true });
  writeFileSync(
    BROWSER_BINDINGS_PATH,
    JSON.stringify(
      {
        runId: RUN_ID,
        commit: REVISION,
        gatewayUrl: GATEWAY_URL,
        caFingerprint: evidence.tls.caFingerprint,
        leafFingerprint: evidence.tls.leafFingerprint,
        tlsValidation: "enabled",
      },
      null,
      2,
    ) + "\n",
    { encoding: "utf8", mode: 0o640 },
  );
}

function readCheckpoint(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} missing: complete the required browser walkthrough and write ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function validateBrowserBindings(checkpoint, label) {
  if (checkpoint.browserProducer !== "runner-owned-firefox-selenium") {
    throw new Error(`${label} must be produced by runner-owned Firefox bridge`);
  }
  const expectedChallengeDigest = createHash("sha256").update(BROWSER_CHALLENGE).digest("hex");
  if (checkpoint.challengeDigest !== expectedChallengeDigest) {
    throw new Error(`${label} challenge binding mismatch`);
  }
  const bindings = [
    ["runId", checkpoint.runId, RUN_ID],
    ["commit", checkpoint.commit, REVISION],
    ["gatewayUrl", checkpoint.gatewayUrl, GATEWAY_URL],
    ["caFingerprint", checkpoint.caFingerprint, evidence.tls?.caFingerprint],
    ["leafFingerprint", checkpoint.leafFingerprint, evidence.tls?.leafFingerprint],
  ];
  const mismatched = bindings
    .filter(([, actual, expected]) => actual !== expected)
    .map(([name]) => name);
  if (mismatched.length > 0) {
    throw new Error(`${label} binding mismatch: ${mismatched.join(", ")}`);
  }
}

async function waitForCheckpoint(path, label, { attempts = 1800, intervalMs = 1000 } = {}) {
  return waitFor(label, async () => {
    if (browserBridgeProcess && browserBridgeProcess.exitCode !== null) {
      const status = evidence.browserBridgeExit;
      throw new Error(`runner-owned Firefox bridge exited ${status?.code ?? browserBridgeProcess.exitCode}${status?.error ? `: ${status.error}` : ""}`);
    }
    if (!existsSync(path)) return false;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return false;
    }
  }, { attempts, intervalMs });
}

async function requireBrowserBootstrapCheckpoint({ wait = false } = {}) {
  const checkpoint = wait
    ? await waitForCheckpoint(BROWSER_BOOTSTRAP_CHECKPOINT_PATH, "browser bootstrap checkpoint")
    : readCheckpoint(BROWSER_BOOTSTRAP_CHECKPOINT_PATH, "browser bootstrap checkpoint");
  const required = ["trustedHttps", "authenticated", "sessionBootstrapped", "tokenMinted", "plaintextOneTimeVerified"];
  const missing = required.filter((key) => checkpoint[key] !== true);
  if (missing.length > 0) {
    throw new Error(`browser bootstrap checkpoint incomplete: ${missing.join(", ")}`);
  }
  if (checkpoint.tlsValidation !== "enabled") {
    throw new Error("browser bootstrap checkpoint must record tlsValidation=enabled");
  }
  validateBrowserBindings(checkpoint, "browser bootstrap checkpoint");
  evidence.browserBootstrap = {
    checkpoint: "passed",
    tlsValidation: "enabled",
    recordedAt: checkpoint.recordedAt ?? null,
    gatewayUrl: GATEWAY_URL,
    caFingerprint: evidence.tls.caFingerprint,
    leafFingerprint: evidence.tls.leafFingerprint,
  };
}

async function requireBrowserCheckpoint({ wait = false, nodeIds = [] } = {}) {
  const checkpoint = wait
    ? await waitForCheckpoint(BROWSER_CHECKPOINT_PATH, "browser lifecycle checkpoint")
    : readCheckpoint(BROWSER_CHECKPOINT_PATH, "browser lifecycle checkpoint");
  const required = ["trustedHttps", "authenticated", "nodesObserved", "nodeDetailObserved", "sessionBootstrapped", "tokenMinted", "plaintextOneTimeVerified"];
  const missing = required.filter((key) => checkpoint[key] !== true);
  if (missing.length > 0) {
    throw new Error(`browser checkpoint incomplete: ${missing.join(", ")}`);
  }
  if (checkpoint.tlsValidation !== "enabled") {
    throw new Error("browser checkpoint must record tlsValidation=enabled");
  }
  if (!Array.isArray(checkpoint.nodeIds) || nodeIds.some((nodeId) => !checkpoint.nodeIds.includes(nodeId))) {
    throw new Error(`browser lifecycle checkpoint must include the live nodeIds: ${nodeIds.join(", ")}`);
  }
  const bindings = [
    ["runId", checkpoint.runId, RUN_ID],
    ["commit", checkpoint.commit, REVISION],
    ["gatewayUrl", checkpoint.gatewayUrl, GATEWAY_URL],
    ["caFingerprint", checkpoint.caFingerprint, evidence.tls?.caFingerprint],
    ["leafFingerprint", checkpoint.leafFingerprint, evidence.tls?.leafFingerprint],
  ];
  const mismatched = bindings
    .filter(([, actual, expected]) => actual !== expected)
    .map(([name]) => name);
  if (mismatched.length > 0) {
    throw new Error(`browser checkpoint binding mismatch: ${mismatched.join(", ")}`);
  }
  evidence.browser = {
    checkpoint: "passed",
    tlsValidation: "enabled",
    recordedAt: checkpoint.recordedAt ?? null,
    gatewayUrl: GATEWAY_URL,
    caFingerprint: evidence.tls.caFingerprint,
    leafFingerprint: evidence.tls.leafFingerprint,
    nodeIds: [...checkpoint.nodeIds],
  };
}

function prepareDrillProxySecret() {
  mkdirSync(dirname(DRILL_PROXY_SECRET_PATH), { recursive: true });
  if (existsSync(DRILL_PROXY_SECRET_PATH)) {
    const stat = lstatSync(DRILL_PROXY_SECRET_PATH);
    if (stat.isDirectory()) {
      const entries = readdirSync(DRILL_PROXY_SECRET_PATH);
      if (entries.length !== 0) throw new Error("secrets/dsh_proxy_auth directory is not an empty placeholder");
      rmSync(DRILL_PROXY_SECRET_PATH, { recursive: true, force: true });
    } else if (!stat.isFile()) {
      throw new Error("secrets/dsh_proxy_auth must be a regular file or empty placeholder directory");
    } else if (readFileSync(DRILL_PROXY_SECRET_PATH, "utf8").trim() !== DRILL_PROXY_SECRET) {
      throw new Error("secrets/dsh_proxy_auth exists with unexpected content; refusing to overwrite");
    } else {
      chmodSync(DRILL_PROXY_SECRET_PATH, 0o600);
      return;
    }
  }
  writeFileSync(DRILL_PROXY_SECRET_PATH, `${DRILL_PROXY_SECRET}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(DRILL_PROXY_SECRET_PATH, 0o600); } catch {}
}

function removeDrillProxySecret() {
  if (!existsSync(DRILL_PROXY_SECRET_PATH)) return;
  const stat = lstatSync(DRILL_PROXY_SECRET_PATH);
  if (stat.isFile() && readFileSync(DRILL_PROXY_SECRET_PATH, "utf8").trim() === DRILL_PROXY_SECRET) {
    rmSync(DRILL_PROXY_SECRET_PATH, { force: true });
    mkdirSync(DRILL_PROXY_SECRET_PATH, { recursive: true });
  }
}

function browserBridgeArgs() {
  return [
    "--bindings-path", BROWSER_BINDINGS_PATH,
    "--ca-path", DRILL_CA_PATH,
    "--bootstrap-path", BROWSER_BOOTSTRAP_CHECKPOINT_PATH,
    "--lifecycle-path", BROWSER_CHECKPOINT_PATH,
    "--node-binding-path", BROWSER_NODE_BINDING_PATH,
    "--stop-path", BROWSER_STOP_PATH,
    "--log-path", BROWSER_BRIDGE_LOG_PATH,
  ];
}

function startBrowserBridge() {
  if (!existsSync(BROWSER_BRIDGE_PATH)) {
    throw new Error(`runner-owned Firefox bridge missing: ${BROWSER_BRIDGE_PATH}`);
  }
  const python = process.env.DSH_ORBIT_PYTHON ?? "python";
  browserBridgeProcess = spawn(python, [BROWSER_BRIDGE_PATH, ...browserBridgeArgs()], {
    cwd: REPO,
    env: {
      ...process.env,
      DSH_ORBIT_BROWSER_CHALLENGE: BROWSER_CHALLENGE,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  browserBridgeProcess.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  browserBridgeProcess.on("exit", (code, signal) => {
    evidence.browserBridgeExit = { code, signal, error: code === 0 ? null : stderr.trim().slice(0, 500) };
  });
  evidence.browserBridge = {
    producer: "runner-owned-firefox-selenium",
    challengeDigest: createHash("sha256").update(BROWSER_CHALLENGE).digest("hex"),
    python,
    startedAt: new Date().toISOString(),
  };
}

async function stopBrowserBridge() {
  if (!browserBridgeProcess) return;
  writeFileSync(BROWSER_STOP_PATH, "stop\n", { encoding: "utf8", mode: 0o640 });
  await waitFor("Firefox bridge exit", async () => browserBridgeProcess.exitCode !== null, { attempts: 60, intervalMs: 500 });
  if (browserBridgeProcess.exitCode !== 0) {
    throw new Error(`runner-owned Firefox bridge exited ${browserBridgeProcess.exitCode}`);
  }
  browserBridgeProcess = null;
  rmSync(BROWSER_STOP_PATH, { force: true });
}

function file(command, args, { expect = 0 } = {}) {
  const result = spawnSync(command, args, { cwd: REPO, encoding: "utf8" });
  if (result.status !== expect && expect !== null) {
    throw new Error(
      `command failed (${result.status ?? "unknown"}; error ${result.error?.message ?? "none"}): ${command} ${args.join(" ")}\n` +
      `STDOUT: ${result.stdout ?? ""}\nSTDERR: ${result.stderr ?? ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function sh(cmd, { expect = 0 } = {}) {
  const result = spawnSync(cmd, { shell: true, cwd: REPO, encoding: "utf8" });
  if (result.status !== expect && expect !== null) {
    throw new Error(
      `command failed (${result.status ?? "unknown"}; error ${result.error?.message ?? "none"}): ${cmd}\n` +
      `STDOUT: ${result.stdout ?? ""}\nSTDERR: ${result.stderr ?? ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function exec(service, args, { env = {}, expect = 0, timeoutMs = 120000 } = {}) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  // Direct docker exec on the compose container: compose exec's service
  // view drifts from the running container in this sandbox.
  const containerName = `docker-registry-${service}-1`;
  const detached = args[0] === "-d";
  const realArgs = detached ? args.slice(1) : args;
  const dockerArgs = ["exec", "-i", ...(detached ? ["-d"] : []), ...envArgs, containerName, ...realArgs];
  const result = spawnSync("docker", dockerArgs, {
    cwd: REPO,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  if (result.status !== expect && expect !== null) {
    throw new Error(`docker exec ${service} failed (${result.status}): ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function routeAuthority(nodeId) {
  if (!/^node_[0-9a-f]{32}$/.test(nodeId)) throw new Error(`invalid mounted nodeId: ${nodeId}`);
  return `n-${nodeId.slice(5)}.${ROUTE_DOMAIN}`;
}

function routeFetch(path, authority, options = {}) {
  return gatewayFetch(path, {
    ...options,
    authority,
    headers: {
      authorization: AUTH,
      ...(options.headers ?? {}),
    },
  });
}

function connectRouteTls(authority) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      port: 8443,
      servername: authority,
      ca: readFileSync(DRILL_CA_PATH),
      rejectUnauthorized: true,
    }, () => resolve(socket));
    socket.on("error", reject);
  });
}

function encodeWsFrame(payload, { opcode = 0x01 } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = Buffer.from([1, 2, 3, 4]);
  const length = data.length;
  const extra = length <= 125 ? 0 : length <= 65535 ? 2 : 8;
  const out = Buffer.alloc(2 + extra + 4 + length);
  out[0] = 0x80 | opcode;
  let offset = 2;
  if (length <= 125) out[1] = 0x80 | length;
  else if (length <= 65535) { out[1] = 0x80 | 126; out.writeUInt16BE(length, offset); offset += 2; }
  else { out[1] = 0x80 | 127; out.writeBigUInt64BE(BigInt(length), offset); offset += 8; }
  mask.copy(out, offset); offset += 4;
  for (let i = 0; i < length; i += 1) out[offset + i] = data[i] ^ mask[i % 4];
  return out;
}

function decodeWsFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4; }
  else if (length === 127) { if (buffer.length < 10) return null; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
  const masked = (buffer[1] & 0x80) !== 0;
  if (masked) { if (buffer.length < offset + 4) return null; offset += 4; }
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.slice(offset, offset + length));
  return { opcode, payload, totalLength: offset + length };
}

async function routeWebSocket(authority, { path = "/api/events.mux", pingPayload = "orbit-mounted-ping", expectedNode = null } = {}) {
  const socket = await connectRouteTls(authority);
  const secKey = randomBytes(16).toString("base64");
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: ${authority}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${secKey}`,
    `Origin: https://${authority}`,
    `Authorization: Basic ${Buffer.from("operator:drill-password").toString("base64")}`,
    "",
    "",
  ].join("\r\n"));
  let received = Buffer.alloc(0);
  const response = await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      received = Buffer.concat([received, chunk]);
      const marker = received.indexOf("\r\n\r\n");
      if (marker === -1) return;
      const header = received.slice(0, marker).toString("utf8");
      const status = Number(header.match(/^HTTP\/1\.[01] (\d+)/m)?.[1] ?? 0);
      const headers = Object.fromEntries(header.split("\r\n").slice(1).filter(Boolean).map((line) => {
        const index = line.indexOf(":"); return [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()];
      }));
      socket.removeListener("data", onData);
      resolve({ status, headers, remaining: received.slice(marker + 4) });
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
  if (response.status !== 101) { socket.destroy(); return { ...response, ping: false }; }
  if (expectedNode && response.headers["x-drill-node"] !== expectedNode) throw new Error(`mounted WSS reached wrong node: expected ${expectedNode}, got ${response.headers["x-drill-node"]}`);
  const expected = createHash("sha1").update(secKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  if (response.headers["sec-websocket-accept"] !== expected) throw new Error("mounted WSS Sec-WebSocket-Accept mismatch");
  socket.write(encodeWsFrame(pingPayload, { opcode: 0x09 }));
  const pong = await new Promise((resolve, reject) => {
    let pending = response.remaining;
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      let frame;
      while ((frame = decodeWsFrame(pending)) !== null) {
        pending = pending.slice(frame.totalLength);
        if (frame.opcode === 0x0a) { socket.removeListener("data", onData); resolve(frame.payload.toString("utf8")); return; }
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
  socket.destroy();
  return { ...response, ping: pong === pingPayload };
}

function gatewayFetch(path, { method = "GET", headers = {}, body, cookie = null, authenticate = true, origin = null, baseUrl = GATEWAY_URL, authority = null } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    if (authority) finalHeaders.host = authority;
    if (cookie) finalHeaders.cookie = cookie;
    if (method === "POST") {
      finalHeaders.origin = origin ?? GATEWAY_URL;
      finalHeaders["sec-fetch-site"] = "same-origin";
    }
    if (authenticate) finalHeaders.authorization = AUTH;
    const req = httpsRequest(
      `${baseUrl}${path}`,
      {
        method,
        headers: finalHeaders,
        ca: readFileSync(DRILL_CA_PATH),
        rejectUnauthorized: true,
        servername: authority ? authority.split(":")[0] : undefined,
        timeout: 10000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (c) => chunks.push(c));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text: () => Buffer.concat(chunks).toString("utf8"),
            json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("gateway request timeout")));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// The machine backend publishes to the VM loopback only (frozen
// policy): the driver probes it from INSIDE the hub container.
function hubGetHealth() {
  try {
    exec("registry-hub", ["sh", "-c", "node -e \"const {get}=require('node:http');get('http://127.0.0.1:5445/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\""]);
    return Promise.resolve(200);
  } catch {
    return Promise.resolve(0);
  }
}

const waitFor = async (label, fn, { attempts = 40, intervalMs = 3000 } = {}) => {
  let last;
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      last = await fn();
      lastError = null;
      if (last) return last;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `waitFor ${label} timed out; last=${JSON.stringify(last)}${
      lastError ? `; lastError=${lastError.message}` : ""
    }`,
  );
};

const nodeEnv = (dataHome, name = null) => ({
  DSH_ORBIT_NODE_STATE: `${dataHome}/orbit-node.json`,
  DSH_ORBIT_HUB_URL: NODE_HUB_URL,
  DSH_ORBIT_NODE_ORBIT_VERSION: "0.4.0-rc.1",
  DSH_ORBIT_NODE_ORBIT_REVISION: REVISION,
  DSH_ORBIT_NODE_DSH_VERSION: "0.1.1-rc.2",
  DSH_ORBIT_NODE_DSH_PROFILE: "dsh-0.1.1-rc.2",
  DSH_ORBIT_NODE_HEARTBEAT_SECONDS: String(HEARTBEAT_CADENCE_SECONDS),
  ...(name === "dsh-a" ? {
    DSH_ORBIT_NODE_ROUTE_INGRESS_PORT: "9444",
    DSH_ORBIT_NODE_ROUTE_INGRESS_LISTEN: "0.0.0.0",
    DSH_ORBIT_NODE_ROUTE_DOMAIN: ROUTE_DOMAIN,
    DSH_ORBIT_NODE_DSH_TARGET: "http://127.0.0.1:3081",
    DSH_ORBIT_NODE_ROUTE_TLS_KEY: "/etc/caddy/tls/tls.key",
    DSH_ORBIT_NODE_ROUTE_TLS_CERT: "/etc/caddy/tls/tls.crt",
  } : name === "dsh-b" ? {
    DSH_ORBIT_NODE_ROUTE_INGRESS_PORT: "9445",
    DSH_ORBIT_NODE_ROUTE_INGRESS_LISTEN: "0.0.0.0",
    DSH_ORBIT_NODE_ROUTE_DOMAIN: ROUTE_DOMAIN,
    DSH_ORBIT_NODE_DSH_TARGET: "http://127.0.0.1:3081",
    DSH_ORBIT_NODE_ROUTE_TLS_KEY: "/etc/caddy/tls/tls.key",
    DSH_ORBIT_NODE_ROUTE_TLS_CERT: "/etc/caddy/tls/tls.crt",
  } : {}),
});

const nodePidFile = (dataHome) => `${dataHome}/orbit-node.pid`;
const nodeLogFile = (dataHome) => `${dataHome}/orbit-node.log`;

async function startNode(name, dataHome, nodeName = name) {
  const pidFile = nodePidFile(dataHome);
  const logFile = nodeLogFile(dataHome);
  exec(name, [
    "-d",
    "sh",
    "-c",
    'set -eu; printf \'%s\\n\' "$$" > "$1"; exec node "$2" run > "$3" 2>&1 < /dev/null',
    "orbit-node-wrapper",
    pidFile,
    NODE_BIN,
    logFile,
  ], { env: nodeEnv(dataHome, nodeName) });
  await waitFor(`${name} daemon start`, async () => {
    try {
      exec(name, ["sh", "-c", `pid=$(cat ${pidFile} 2>/dev/null) || exit 1; case "$pid" in ''|*[!0-9]*) exit 1;; esac; test -r /proc/$pid/cmdline; tr '\\0' ' ' < /proc/$pid/cmdline | grep -F -- '${NODE_BIN} run' >/dev/null; printf ready`]);
      return true;
    } catch {
      return false;
    }
  }, { attempts: 20, intervalMs: 250 });
}

async function stopNode(name, dataHome, { strict = true } = {}) {
  const pidFile = nodePidFile(dataHome);
  const command = `
set -eu
pid=$(cat ${pidFile} 2>/dev/null || true)
if [ -z "$pid" ]; then
  rm -f ${pidFile}
  exit 0
fi
case "$pid" in
  ''|*[!0-9]*) echo "invalid node pid: $pid" >&2; exit 2 ;;
esac
if [ ! -e /proc/$pid ]; then
  rm -f ${pidFile}
  exit 0
fi
cmdline=$(tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null || true)
state=$(awk '{print $3}' /proc/$pid/stat 2>/dev/null || true)
if [ "$state" = "Z" ]; then
  rm -f ${pidFile}
  exit 0
fi
case "$cmdline" in
  *'${NODE_BIN} run'*) ;;
  *) echo "node pid $pid is not the expected Orbit daemon: $cmdline" >&2; exit 3 ;;
esac
kill -TERM "$pid"
i=0
while [ "$i" -lt 30 ]; do
  if [ ! -e /proc/$pid ]; then
    rm -f ${pidFile}
    exit 0
  fi
  state=$(awk '{print $3}' /proc/$pid/stat 2>/dev/null || true)
  if [ "$state" = "Z" ]; then
    rm -f ${pidFile}
    exit 0
  fi
  sleep 0.5
  i=$((i + 1))
done
echo "Orbit daemon pid $pid did not exit" >&2
exit 4
`;
  try {
    exec(name, ["sh", "-c", command]);
  } catch (error) {
    if (strict) throw error;
    console.error(`drill cleanup: unable to stop ${name}: ${error.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  rmSync(RAW_EVIDENCE_PATH, { force: true });
  requireCleanCandidateWorktree();
  rmSync(BROWSER_BOOTSTRAP_CHECKPOINT_PATH, { force: true });
  rmSync(BROWSER_CHECKPOINT_PATH, { force: true });
  rmSync(BROWSER_NODE_BINDING_PATH, { force: true });
  rmSync(BROWSER_STOP_PATH, { force: true });
  rmSync(BROWSER_BRIDGE_LOG_PATH, { force: true });
  ensureDrillCertificate();
  const composeUp = args.includes("--compose-up");
  const waitForBrowser = args.includes("--wait-for-browser");
  const keep = args.includes("--keep");
  let stackStarted = false;
  runCleanup = async () => {
    try {
      await stopBrowserBridge();
    } catch (error) {
      console.error(`drill cleanup: browser bridge: ${error.message}`);
    }
    if (keep) return;
    await stopNode("dsh-a", "/data/dsh-a", { strict: false });
    await stopNode("dsh-b", "/data/dsh-b", { strict: false });
    if (stackStarted) sh(`docker compose -f ${COMPOSE} down`, { expect: null });
    removeDrillProxySecret();
  };

  // The drill Hub performs an immediate maintenance pass at startup, so
  // provision the private aging control before compose up. It is a
  // nodeId-to-ISO map; unmapped nodes use the Hub wall clock.
  mkdirSync(dirname(AGING_CLOCK_PATH), { recursive: true });
  writeFileSync(AGING_CLOCK_PATH, "{}\n", { encoding: "utf8", mode: 0o640 });
  try { chmodSync(AGING_CLOCK_PATH, 0o640); } catch {}
  evidence.aging = {
    mode: "controlled-accelerated-contact-aging",
    clockPath: AGING_CLOCK_PATH,
    heartbeatCadenceSeconds: HEARTBEAT_CADENCE_SECONDS,
    missedBeatsForStale: HEARTBEAT_MISSED_BEATS,
    lostAfterMs: HEARTBEAT_LOST_MS,
    productionThresholdsUnchanged: true,
  };

  // --- 0. versions/build provenance ---
  const runDocker = (args) => spawnSync("docker", args, { cwd: REPO, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).stdout.trim();
  evidence.dshVersion = "0.1.1-rc.2";
  evidence.hubListenPolicy = "127.0.0.1:5445 (loopback; frozen policy intact)";

  // --- 1. compose up ---
  prepareDrillProxySecret();
  if (composeUp || !existsSync(join(REPO, "data", "orbit-drill"))) {
    sh(`docker compose -f ${COMPOSE} up -d --build`);
    stackStarted = true;
    evidence.steps.push("compose: up (hub, caddy, dsh-a, dsh-b)");
  }
  const caddyContainer = sh(`docker compose -f ${COMPOSE} ps -q caddy`).trim().split("\n")[0];
  const hubContainer = sh(`docker compose -f ${COMPOSE} ps -q registry-hub`).trim().split("\n")[0];
  const dshAContainer = sh(`docker compose -f ${COMPOSE} ps -q dsh-a`).trim().split("\n")[0];
  const dshBContainer = sh(`docker compose -f ${COMPOSE} ps -q dsh-b`).trim().split("\n")[0];
  if (!hubContainer || !caddyContainer || !dshAContainer || !dshBContainer) throw new Error("containers not running; start with --compose-up");
  evidence.containers = { hub: hubContainer, caddy: caddyContainer, dshA: dshAContainer, dshB: dshBContainer };

  // Capture the ACTUAL images backing the running containers, after any
  // --build step. Inspecting mutable tags before compose-up can record stale
  // image IDs from a previous drill and break exact candidate provenance.
  const runningImageEvidence = (containerId) => {
    const container = JSON.parse(runDocker(["inspect", containerId]))[0] ?? {};
    const imageId = container.Image;
    if (typeof imageId !== "string" || imageId === "") throw new Error(`container ${containerId} has no image identity`);
    const image = JSON.parse(runDocker(["image", "inspect", imageId]))[0] ?? {};
    return {
      id: image.Id ?? imageId,
      digest: image.RepoDigests?.[0] ?? "local-image-no-registry-digest",
      created: image.Created ?? "unknown",
    };
  };
  evidence.hubImage = runningImageEvidence(hubContainer);
  evidence.dshImages = {
    a: runningImageEvidence(dshAContainer),
    b: runningImageEvidence(dshBContainer),
  };
  evidence.dshImage = evidence.dshImages;
  evidence.hubImageDigest = evidence.hubImage.digest;
  evidence.dshImageDigest = `${evidence.dshImages.a.digest}; ${evidence.dshImages.b.digest}`;
  evidence.caddyImage = runningImageEvidence(caddyContainer);
  evidence.caddyVersion = exec("caddy", ["caddy", "version"]).split(/\s+/)[0] ?? "unknown";

  const caddyValidation = spawnSync("docker", ["exec", caddyContainer, "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"], {
    cwd: REPO, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  if (caddyValidation.status !== 0 || !caddyValidation.stderr?.includes("Valid configuration") && !caddyValidation.stdout?.includes("Valid configuration")) {
    throw new Error(`caddy validate failed (${caddyValidation.status}): ${caddyValidation.stdout}\n${caddyValidation.stderr}`);
  }
  evidence.steps.push("caddy: real caddy validate -> Valid configuration; TLS certificate mounted");
  await waitFor("hub http", async () => (await hubGetHealth()) === 200);
  await waitFor("gateway tls", async () => {
    try {
      const response = await gatewayFetch("/");
      if (response.status !== 200) {
        evidence.gatewayProbe = { status: response.status, bodyPrefix: response.text().slice(0, 120) };
        return false;
      }
      return true;
    } catch (error) {
      evidence.gatewayProbe = { error: error.message };
      return false;
    }
  });

  if (waitForBrowser) startBrowserBridge();

  // The mounted lifecycle is not final evidence until the real browser
  // walkthrough has proved trusted HTTPS, authentication, session bootstrap,
  // and one-time token handling. Nodes do not exist yet, so node-list/detail
  // observation is checked at the second barrier below.
  await requireBrowserBootstrapCheckpoint({ wait: waitForBrowser });
  evidence.steps.push("browser: trusted HTTPS bootstrap checkpoint accepted");

  // --- 2. operator session through the gateway (real browser surface) ---
  const unauthenticated = await gatewayFetch("/hub/nodes", { authenticate: false });
  if (unauthenticated.status !== 401) throw new Error(`gateway did not enforce authentication: ${unauthenticated.status}`);
  evidence.steps.push("gateway: unauthenticated browser request -> 401 before Hub");
  const machineDenied = await gatewayFetch("/api/v1/heartbeat", { method: "POST" });
  if (machineDenied.status !== 403) throw new Error(`gateway machine route was not denied: ${machineDenied.status}`);
  evidence.steps.push("gateway: /api/v1/* machine surface -> 403 (not proxied)");
  const session = await gatewayFetch("/hub/session", { method: "POST" });
  const sessionBody = await session.json();
  if (session.status !== 200 || sessionBody.principal !== "operator") {
    throw new Error(`session failed: ${session.status} ${JSON.stringify(sessionBody)}`);
  }
  const setCookieHeader = session.headers["set-cookie"];
  let sessionCookie = (Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader).split(";")[0];
  let csrf = sessionBody.csrfToken;
  evidence.steps.push(`session: bootstrap via TLS gateway -> ${sessionBody.principal} (cookie + CSRF issued)`);

  const browserHeaders = () => ({ cookie: sessionCookie, "x-csrf-token": csrf, "content-type": "application/json" });
  const nodesApi = async () => (await (await gatewayFetch("/hub/nodes", { headers: browserHeaders() })).json()).nodes;
  const nodeApi = async (nodeId) => (await (await gatewayFetch(`/hub/nodes/${nodeId}`, { headers: browserHeaders() })).json());
  const routeTargetApi = async (nodeId) => (await (await gatewayFetch(`/hub/nodes/${nodeId}/route-target`, { headers: browserHeaders() })).json());
  const row = (list, nodeId) => list.find((n) => n.nodeId === nodeId);
  const nodeStateIs = async (nodeId, predicate) => {
    const list = await nodesApi();
    const node = row(list, nodeId);
    return Boolean(node && predicate(node));
  };

  // --- 3. enroll + run + report for BOTH real DSH nodes ---
  async function createHistoricalSession(endpoint, logicalOrigin) {
    const rpcId = `drill-session-create-${randomUUID()}`;
    const response = await gatewayFetch("/api/session.create", {
      method: "POST",
      baseUrl: endpoint,
      origin: logicalOrigin,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method: "session.create",
        payload: { agentPreset: "standard" },
      }),
    });
    const body = await response.json();
    const sessionId = body?.result?.value?.sessionId;
    if (response.status !== 200 || body?.rpcId !== rpcId || typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error(`real DSH session.create failed at ${endpoint}: HTTP ${response.status} ${JSON.stringify(body)}`);
    }
    const listed = await gatewayFetch("/api/session.list", {
      method: "POST",
      baseUrl: endpoint,
      origin: logicalOrigin,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: `drill-session-list-${randomUUID()}`,
        method: "session.list",
        payload: {},
      }),
    });
    const listedBody = await listed.json();
    if (!Array.isArray(listedBody?.result?.value?.items) || !listedBody.result.value.items.some((item) => item.sessionId === sessionId)) {
      throw new Error(`real DSH session.create was not persisted at ${endpoint}: ${sessionId}`);
    }
    return sessionId;
  }

  async function deployNode(name, dataHome, endpoint, port) {
    // Idempotent reruns: stop only a daemon owned by this drill, then drop
    // the prior node identity and report from the mounted data volume.
    const logicalOrigin = `https://${name}.test`;
    const sessionId = await createHistoricalSession(endpoint, logicalOrigin);
    evidence.steps.push(`${name}: real DSH session.create + session.list persisted ${sessionId}`);
    await stopNode(name, dataHome, { strict: false });
    exec(name, ["sh", "-c", `rm -f ${dataHome}/orbit-node.json ${dataHome}/report-drill.json`]);
    const plain = await (
      await gatewayFetch("/hub/tokens", { method: "POST", headers: browserHeaders(), body: JSON.stringify({ purpose: "enroll" }) })
    ).json();
    const enrolled = exec(name, ["node", NODE_BIN, "enroll"], {
      env: { ...nodeEnv(dataHome, name), DSH_ORBIT_ENROLL_TOKEN: plain.token },
    });
    const nodeId = /enrolled: (node_[0-9a-f]{32})/.exec(enrolled)?.[1];
    if (!nodeId) throw new Error(`${name} enroll failed: ${enrolled}`);
    const verificationWorkdir = join(REPO, "data", "orbit-drill", `verification-${name}`);
    const verificationConfig = {
      candidateImage: name === "dsh-a" ? "dsh-orbit:dsh-drill-a" : "dsh-orbit:dsh-drill-b",
      candidateDataRoot: `/data/${name}`,
      candidateWorkspaceRoot: `/workspace`,
      candidateHostPort: port,
      productionDataRoot: `/data/${name}`,
      candidateEndpoint: endpoint,
      publicHost: `${name}.test`,
      basicUser: "operator",
      basicPassword: "drill-password",
      smokeOrigin: `https://${name}.test`,
      sessionId,
      sshPatchEnabled: false,
      snapshotHook: "mounted-drill",
      snapshotTimeoutSeconds: 1,
      gatewayService: `${name}-gateway`,
      gatewayUser: "1000:1000",
      gatewayCertTarget: "/run/certs/fullchain.pem",
      gatewayKeyTarget: "/run/certs/privkey.pem",
      project: "docker-registry",
      composeFile: COMPOSE,
      composeOverrideFile: null,
      composeService: name,
      workdir: verificationWorkdir,
      orbitVersion: "0.4.0-rc.1",
      orbitRevision: REVISION,
      dshVersion: "0.1.1-rc.2",
      baselineImage: "mounted-drill",
      baselineOrbitRevision: REVISION,
      baselineDshVersion: "0.1.1-rc.2",
    };
    mkdirSync(verificationWorkdir, { recursive: true });
    const { checks } = await runVerificationSequence({
      config: verificationConfig,
      identityCaPath: DRILL_CA_PATH,
      identityCa: readFileSync(DRILL_CA_PATH),
    });
    const report = createCompatibilityReport({
      promotionEvaluated: false,
      orbit: { version: "0.4.0-rc.1", revision: REVISION },
      candidate: { dshVersion: "0.1.1-rc.2", profile: "dsh-0.1.1-rc.2" },
      checks,
      snapshot: { reference: null, failure: null },
    });
    if (report.compatibility.outcome !== "pass") {
      throw new Error(`${name} real compatibility verification failed: ${report.compatibility.reasons.join(", ")}`);
    }
    const reportHostPath = join(REPO, "data", "orbit-drill", "report-" + name + ".json");
    mkdirSync(dirname(reportHostPath), { recursive: true });
    writeFileSync(reportHostPath, JSON.stringify(report));
    const cp = spawnSync("docker", ["cp", reportHostPath, `docker-registry-${name}-1:/data/${name}/report-drill.json`], {
      cwd: REPO, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    });
    if (cp.status !== 0) throw new Error("docker cp report failed: " + cp.stderr);
    exec(name, ["node", NODE_BIN, "upload-report"], { env: { ...nodeEnv(dataHome, name), DSH_ORBIT_REPORT_FILE: `${dataHome}/report-drill.json` } });
    await startNode(name, dataHome, name);
    return nodeId;
  }
  const aNodeId = await deployNode("dsh-a", "/data/dsh-a", "https://127.0.0.1:18443", 18443);
  const bNodeId = await deployNode("dsh-b", "/data/dsh-b", "https://127.0.0.1:18444", 18444);
  const authorityA = routeAuthority(aNodeId);
  const authorityB = routeAuthority(bNodeId);
  const routeTargetA = "https://dsh-a:9444";
  const routeTargetB = "https://dsh-b:9445";
  const setRouteTarget = async (nodeId, routeTarget) => {
    const response = await gatewayFetch(`/hub/nodes/${nodeId}/route-target`, {
      method: "PUT",
      headers: browserHeaders(),
      body: JSON.stringify({ routeTarget }),
    });
    if (response.status !== 200) throw new Error(`route target set failed for ${nodeId}: ${response.status}`);
    return response.json();
  };
  await setRouteTarget(aNodeId, routeTargetA);
  await setRouteTarget(bNodeId, routeTargetB);
  markMatrix("routeTargetsConfiguredAB");
  const persistedA = await routeTargetApi(aNodeId);
  const persistedB = await routeTargetApi(bNodeId);
  if (persistedA.routeTarget?.origin !== routeTargetA || persistedB.routeTarget?.origin !== routeTargetB) {
    throw new Error(`mounted route target persistence mismatch: A=${JSON.stringify(persistedA)} B=${JSON.stringify(persistedB)}`);
  }
  markMatrix("routeTargetsPersisted");
  evidence.routeAuthorities = { a: authorityA, b: authorityB };
  evidence.routeTargets = { a: routeTargetA, b: routeTargetB };
  if (waitForBrowser) {
    writeFileSync(
      BROWSER_NODE_BINDING_PATH,
      JSON.stringify({ runId: RUN_ID, commit: REVISION, nodeIds: [aNodeId, bNodeId], recordedAt: new Date().toISOString() }, null, 2) + "\n",
      { encoding: "utf8", mode: 0o640 },
    );
  }
  evidence.aNodeId = aNodeId;
  evidence.bNodeId = bNodeId;
  evidence.steps.push(`nodes: A=${aNodeId} B=${bNodeId} enrolled, running, reports uploaded`);

  await waitFor("A fresh", async () => {
    try {
      const list = await nodesApi();
      const root = list.find((n) => n.nodeId === aNodeId);
      if (!root) return false;
      return root.health.registryContact === "fresh";
    } catch (error) {
      throw error;
    }
  });
  await waitFor("B fresh", async () => {
    const list = await nodesApi();
    const root = list.find((n) => n.nodeId === bNodeId);
    return root?.health.registryContact === "fresh";
  });
  await waitFor("A route eligible", async () => {
    const node = await nodeApi(aNodeId);
    return node.state === "active" && node.routeTarget?.origin === routeTargetA && node.health.reachable === "ok" &&
      node.hubRouteKeys?.some((key) => key.state === "active") && node.health.capabilities?.some((capability) => capability.name === "web.routes");
  }, { attempts: 40, intervalMs: 1000 });
  await waitFor("B route eligible", async () => {
    const node = await nodeApi(bNodeId);
    return node.state === "active" && node.routeTarget?.origin === routeTargetB && node.health.reachable === "ok" &&
      node.hubRouteKeys?.some((key) => key.state === "active") && node.health.capabilities?.some((capability) => capability.name === "web.routes");
  }, { attempts: 40, intervalMs: 1000 });
  markMatrix("eligibilityAB");
  let view = await nodesApi();
  const aRow = row(view, aNodeId);
  const bRow = row(view, bNodeId);
  if (aRow.health.capabilities.length === 0 || bRow.health.capabilities.length === 0) {
    throw new Error(`capabilities missing: A=${JSON.stringify(aRow.health.capabilities)} B=${JSON.stringify(bRow.health.capabilities)}`);
  }
  if (typeof aRow.health.lastHeartbeatAt !== "string" || typeof bRow.health.lastHeartbeatAt !== "string") {
    throw new Error(`lastHeartbeatAt missing: A=${JSON.stringify(aRow.health.lastHeartbeatAt)} B=${JSON.stringify(bRow.health.lastHeartbeatAt)}`);
  }
  evidence.steps.push(`both fresh with ${aRow.health.capabilities.length} capabilities each; registryContact A=${aRow.health.registryContact} B=${bRow.health.registryContact}; lastHeartbeatAt surfaced for both`);

  // Nodes now exist and are visible. Require the browser to inspect the live
  // Nodes list and at least one node detail before the failure lifecycle.
  await requireBrowserCheckpoint({ wait: waitForBrowser, nodeIds: [aNodeId, bNodeId] });
  evidence.steps.push("browser: trusted HTTPS live Nodes/detail checkpoint accepted");

  const selectorResponse = await gatewayFetch("/hub/selector/nodes", {
    headers: browserHeaders(),
    authority: ROUTE_DOMAIN,
  });
  const selectorBody = await selectorResponse.json();
  const selectorA = selectorBody.nodes?.find((node) => node.nodeId === aNodeId);
  const selectorB = selectorBody.nodes?.find((node) => node.nodeId === bNodeId);
  if (selectorResponse.status !== 200 || !selectorA?.route?.eligible || !selectorB?.route?.eligible ||
      selectorA.route.openUrl !== `https://${authorityA}/` || selectorB.route.openUrl !== `https://${authorityB}/`) {
    throw new Error(`mounted selector matrix mismatch: ${JSON.stringify(selectorBody)}`);
  }
  markMatrix("selectorListsAB", "selectorOpenA", "selectorOpenB");

  const routeRootA = await routeFetch("/", authorityA, { headers: { accept: "text/html" } });
  const routeRootB = await routeFetch("/", authorityB, { headers: { accept: "text/html" } });
  const routeRootTextA = routeRootA.text();
  const routeRootTextB = routeRootB.text();
  if (routeRootA.status !== 200 || routeRootB.status !== 200 ||
      routeRootA.headers["x-drill-node"] !== "A" || routeRootB.headers["x-drill-node"] !== "B" ||
      routeRootTextA.includes("dsh-b") || routeRootTextB.includes("dsh-a")) {
    throw new Error(`mounted route root isolation failed: A=${routeRootA.status}/${routeRootA.headers["x-drill-node"]} B=${routeRootB.status}/${routeRootB.headers["x-drill-node"]}`);
  }
  markMatrix("httpRootA", "httpRootB", "nodeContextIsolation");

  const staticA = await routeFetch("/assets/index-C6eRlFa6.css", authorityA);
  const staticB = await routeFetch("/assets/index-C6eRlFa6.css", authorityB);
  if (staticA.status !== 200 || staticB.status !== 200 || staticA.headers["x-drill-node"] !== "A" || staticB.headers["x-drill-node"] !== "B" || staticA.text().length < 100 || staticB.text().length < 100) {
    throw new Error(`mounted static asset matrix failed: A=${staticA.status} B=${staticB.status}`);
  }
  markMatrix("staticAssetA", "staticAssetB");
  const cookies = [staticA.headers["set-cookie"], staticB.headers["set-cookie"]].flat().filter(Boolean).join(";");
  if (/domain=/i.test(cookies)) throw new Error("mounted route response leaked Domain cookie attribute");
  markMatrix("cookieIsolation");

  const wsA = await routeWebSocket(authorityA, { expectedNode: "A" });
  const wsB = await routeWebSocket(authorityB, { expectedNode: "B" });
  if (wsA.status !== 101 || wsB.status !== 101) throw new Error(`mounted WSS upgrade failed: A=${wsA.status} B=${wsB.status}`);
  markMatrix("websocketUpgradeA", "websocketUpgradeB");
  if (!wsA.ping || !wsB.ping) throw new Error("mounted WSS Ping/Pong failed");
  markMatrix("websocketPingPongA", "websocketPingPongB");

  // --- 4. gateway restart drill ---
  const preRestart = await nodesApi();
  const preRestartRows = new Map(preRestart.map((node) => [node.nodeId, {
    registryContact: node.health.registryContact,
    capabilities: node.health.capabilities,
    lastHeartbeatAt: node.health.lastHeartbeatAt,
  }]));
  sh(`docker restart ${caddyContainer}`);
  await waitFor("gateway down", async () => !(await gatewayFetch("/").catch(() => null)), { attempts: 20, intervalMs: 2000 });
  sh(`docker start ${caddyContainer}`);
  await waitFor("gateway back", async () => (await gatewayFetch("/")).status === 200);
  const res2 = await gatewayFetch("/hub/session", { method: "POST" });
  const set2 = res2.headers["set-cookie"];
  sessionCookie = (Array.isArray(set2) ? set2[0] : set2).split(";")[0];
  csrf = (await res2.json()).csrfToken;
  const postRestart = await nodesApi();
  for (const nodeId of [aNodeId, bNodeId]) {
    const before = preRestartRows.get(nodeId);
    const after = row(postRestart, nodeId);
    if (!before || !after) throw new Error(`gateway restart lost node ${nodeId}`);
    if (after.health.registryContact !== before.registryContact ||
        JSON.stringify(after.health.capabilities) !== JSON.stringify(before.capabilities)) {
      throw new Error(`node health changed across gateway restart for ${nodeId}`);
    }
  }
  view = postRestart;
  const gatewayRouteA = await routeFetch("/", authorityA, { headers: { accept: "text/html" } });
  const gatewayRouteB = await routeFetch("/", authorityB, { headers: { accept: "text/html" } });
  if (gatewayRouteA.status !== 200 || gatewayRouteB.status !== 200) {
    throw new Error(`gateway restart route recovery failed: A=${gatewayRouteA.status} B=${gatewayRouteB.status}`);
  }
  markMatrix("gatewayRestartRecovery");
  evidence.steps.push("gateway: restarted; new session works; selector and A/B routed HTTP recovered");

  // --- 4b. actual Hub process/container restart with persistent registry ---
  sh(`docker restart ${hubContainer}`);
  await waitFor("Hub process restart", async () => (await hubGetHealth()) === 200, { attempts: 40, intervalMs: 1000 });
  await waitFor("gateway after Hub restart", async () => (await gatewayFetch("/").catch(() => null))?.status === 200, { attempts: 40, intervalMs: 1000 });
  const postHubSession = await gatewayFetch("/hub/session", { method: "POST" });
  const postHubSessionBody = await postHubSession.json();
  if (postHubSession.status !== 200 || typeof postHubSessionBody.csrfToken !== "string") throw new Error("Hub restart session bootstrap failed");
  const postHubCookie = (Array.isArray(postHubSession.headers["set-cookie"]) ? postHubSession.headers["set-cookie"][0] : postHubSession.headers["set-cookie"]).split(";")[0];
  sessionCookie = postHubCookie;
  csrf = postHubSessionBody.csrfToken;
  const persistedAfterHubRestartA = await routeTargetApi(aNodeId);
  const persistedAfterHubRestartB = await routeTargetApi(bNodeId);
  if (persistedAfterHubRestartA.routeTarget?.origin !== routeTargetA || persistedAfterHubRestartB.routeTarget?.origin !== routeTargetB) {
    throw new Error("Hub restart lost mounted route targets");
  }
  const postHubRouteA = await routeFetch("/", authorityA, { headers: { accept: "text/html" } });
  const postHubRouteB = await routeFetch("/", authorityB, { headers: { accept: "text/html" } });
  if (postHubRouteA.status !== 200 || postHubRouteB.status !== 200) throw new Error("Hub restart lost A/B route recovery");
  markMatrix("hubRestartRecovery");
  evidence.steps.push("Hub: restarted with persistent SQLite; route targets and A/B routed HTTP recovered");

  // --- 5. DSH loss behind live RouteIngress: suspend only DSH web ---
  const suspendDsh = (service) => exec(service, ["sh", "-c", "pid=$(ps -eo pid,args | awk '/bin.js web/ && !/awk/ {print $1; exit}'); test -n \"$pid\"; kill -STOP \"$pid\""]);
  const resumeDsh = (service) => exec(service, ["sh", "-c", "pid=$(ps -eo pid,args | awk '/bin.js web/ && !/awk/ {print $1; exit}'); test -n \"$pid\"; kill -CONT \"$pid\""]);
  suspendDsh("dsh-a");
  await waitFor("A route unreachable with live ingress", async () => (await nodeApi(aNodeId)).health?.reachable === "unreachable", { attempts: 20, intervalMs: 1000 });
  const dshLossA = await routeFetch("/", authorityA, { headers: { accept: "application/json" } });
  const dshLossB = await routeFetch("/", authorityB, { headers: { accept: "text/html" } });
  if (dshLossA.status !== 503 || dshLossB.status !== 200) throw new Error(`DSH loss isolation failed: A=${dshLossA.status} B=${dshLossB.status}`);
  markMatrix("nodeAFailClosedOutage", "nodeBHealthyDuringAOutage");
  resumeDsh("dsh-a");
  await waitFor("A route recovered after DSH resume", async () => (await nodeApi(aNodeId)).health?.reachable === "ok", { attempts: 30, intervalMs: 1000 });
  const dshRecoveryA = await routeFetch("/", authorityA, { headers: { accept: "text/html" } });
  if (dshRecoveryA.status !== 200) throw new Error(`A route did not recover after DSH resume: ${dshRecoveryA.status}`);
  markMatrix("dshLossAndRecovery");

  // --- 5b. A disconnect: stop its owned run loop; age only A's contact ---
  await stopNode("dsh-a", "/data/dsh-a");
  const disconnectWallClock = new Date();
  const aBeforeAging = row(await nodesApi(), aNodeId);
  const aLastHeartbeatMs = Date.parse(aBeforeAging.health.lastHeartbeatAt);
  const staleClock = new Date(aLastHeartbeatMs + HEARTBEAT_MISSED_BEATS * HEARTBEAT_CADENCE_SECONDS * 1000 + 1000);
  writeFileSync(AGING_CLOCK_PATH, JSON.stringify({ [aNodeId]: staleClock.toISOString() }) + "\n");
  evidence.aging.disconnectWallClock = disconnectWallClock.toISOString();
  evidence.aging.staleAcceleratedClock = staleClock.toISOString();
  evidence.steps.push(`A disconnect: aging clock advanced for A only to ${staleClock.toISOString()} (${HEARTBEAT_MISSED_BEATS} missed beats at ${HEARTBEAT_CADENCE_SECONDS}s cadence)`);
  await waitFor("A stale", async () => nodeStateIs(aNodeId, (node) => node.health.registryContact === "stale"), {
    attempts: 20,
    intervalMs: 3000,
  });

  const lostClock = new Date(aLastHeartbeatMs + HEARTBEAT_LOST_MS + 1000);
  writeFileSync(AGING_CLOCK_PATH, JSON.stringify({ [aNodeId]: lostClock.toISOString() }) + "\n");
  evidence.aging.lostAcceleratedClock = lostClock.toISOString();
  await waitFor("A lost", async () => nodeStateIs(aNodeId, (node) => node.health.registryContact === "lost"), {
    attempts: 20,
    intervalMs: 3000,
  });
  view = await nodesApi();
  const bDuring = row(view, bNodeId);
  const aLost = row(view, aNodeId);
  if (aLost.health.registryContact !== "lost" || !aLost.health.alertFlags.includes("contact-lost")) {
    throw new Error(`A did not reach lost/contact-lost: ${JSON.stringify(aLost.health)}`);
  }
  if (bDuring.health.registryContact !== "fresh" || bDuring.health.capabilities.length === 0) {
    throw new Error(`B contaminated during A outage: ${JSON.stringify(bDuring.health)}`);
  }
  evidence.steps.push(`A disconnect: A=lost with contact-lost; B=${bDuring.health.registryContact}, capabilities=${bDuring.health.capabilities.length}, alerts=${JSON.stringify(bDuring.health.alertFlags)}`);

  // Reset the accelerated override before any reconnect traffic. An empty
  // map makes every node fall back to the real wall-clock path while keeping
  // the Hub's immediate maintenance callback valid across restart.
  writeFileSync(AGING_CLOCK_PATH, "{}\n");
  evidence.aging.resetBeforeReconnect = true;
  evidence.aging.resetWallClock = new Date().toISOString();

  // Cross at least one real 30s maintenance tick after the accelerated
  // clock is removed. Maintenance must be aging-only: resetting the test
  // clock may not heal A. A must remain lost until a real heartbeat arrives.
  await sleep(35_000);
  view = await nodesApi();
  const aAfterClockReset = row(view, aNodeId);
  if (aAfterClockReset.health.registryContact !== "lost" || !aAfterClockReset.health.alertFlags.includes("contact-lost")) {
    throw new Error(`aging reset healed A without heartbeat: ${JSON.stringify(aAfterClockReset.health)}`);
  }
  evidence.aging.resetDidNotHealWithoutHeartbeat = true;
  evidence.steps.push("aging override reset: A remained lost across a real maintenance tick until heartbeat");

  // --- 6. A reconnect ---
  await startNode("dsh-a", "/data/dsh-a");
  await waitFor("A fresh again", async () => nodeStateIs(aNodeId, (node) => node.health.registryContact === "fresh"), {
    attempts: 30,
    intervalMs: 6000,
  });
  evidence.steps.push("A reconnect: fresh again, alert flags cleared; B untouched");

  // --- 7. delete A through the browser surface; old bookmark must fail closed ---
  const beforeDeleteNode = await nodeApi(aNodeId);
  const oldHubRouteKeyId = beforeDeleteNode.hubRouteKeys?.find((key) => key.state === "active")?.keyId ?? null;
  if (!oldHubRouteKeyId) throw new Error("missing active Hub route identity before delete");
  const deleted = await gatewayFetch(`/hub/nodes/${aNodeId}/delete`, {
    method: "POST",
    headers: browserHeaders(),
    body: JSON.stringify({ requestId: randomUUID().replaceAll("-", ""), reason: "drill-retirement" }),
  });
  const deletedBody = await deleted.json();
  if (deletedBody.state !== "tombstoned") throw new Error(`delete failed: ${JSON.stringify(deletedBody)}`);
  await waitFor("A revoked locally", async () => {
    const stateFile = exec("dsh-a", ["sh", "-c", "cat /data/dsh-a/orbit-node.json"], { expect: null });
    try {
      return JSON.parse(stateFile).state === "revoked";
    } catch {
      return false;
    }
  }, { attempts: 20, intervalMs: 4000 });
  view = await nodesApi();
  const bAfterDelete = row(view, bNodeId);
  if (bAfterDelete.health.registryContact !== "fresh") throw new Error("B contaminated after delete");
  const oldBookmark = await routeFetch("/", authorityA, { headers: { accept: "application/json" } });
  if (oldBookmark.status !== 503) throw new Error(`deleted node bookmark did not fail closed: ${oldBookmark.status}`);
  markMatrix("bookmarkFailClosed");
  evidence.steps.push(`delete A (requestId, explicit result): tombstoned; A local state=revoked; old bookmark fail-closed; B=${bAfterDelete.health.registryContact}`);

  // --- 8. reenroll A (same nodeId, fresh Hub route identity) ---
  const reenrollMint = await (await gatewayFetch(`/hub/nodes/${aNodeId}/reenroll`, { method: "POST", headers: browserHeaders() })).json();
  const reenrolled = exec("dsh-a", ["node", NODE_BIN, "reenroll"], {
    env: { ...nodeEnv("/data/dsh-a"), DSH_ORBIT_REENROLL_TOKEN: reenrollMint.token },
  });
  const restoredId = /re-enrolled: (node_[0-9a-f]{32})/.exec(reenrolled)?.[1];
  if (restoredId !== aNodeId) throw new Error(`reenroll restored ${restoredId} !== ${aNodeId}`);
  await startNode("dsh-a", "/data/dsh-a");
  await waitFor("A active again", async () => nodeStateIs(aNodeId, (node) => node.state === "active"), { attempts: 30, intervalMs: 5000 });
  await waitFor("A fresh after reenroll", async () => nodeStateIs(aNodeId, (node) => node.health.registryContact === "fresh"), {
    attempts: 30,
    intervalMs: 6000,
  });
  const afterReenrollNode = await nodeApi(aNodeId);
  const newHubRouteKeyId = afterReenrollNode.hubRouteKeys?.find((key) => key.state === "active")?.keyId ?? null;
  if (!newHubRouteKeyId || newHubRouteKeyId === oldHubRouteKeyId) throw new Error("reenroll did not create a fresh Hub route identity");
  markMatrix("sameNodeIdReenroll", "freshHubRouteIdentity");
  const restoredBookmark = await routeFetch("/", authorityA, { headers: { accept: "text/html" } });
  if (restoredBookmark.status !== 200) throw new Error(`reenrolled bookmark did not recover: ${restoredBookmark.status}`);
  markMatrix("deleteBookmarkAndReenroll");
  const bFinal = row(await nodesApi(), bNodeId);
  if (bFinal.health.registryContact !== "fresh") throw new Error("B contaminated at the end");
  evidence.routeIdentity = { beforeDelete: oldHubRouteKeyId, afterReenroll: newHubRouteKeyId };
  evidence.steps.push(`reenroll A: same nodeId ${aNodeId}, fresh Hub route identity, bookmark recovered; B final=${bFinal.health.registryContact}`);

  assertMatrixComplete();
  evidence.finishedAt = new Date().toISOString();
  evidence.success = true;

  await runCleanup();
  evidence.cleanup = keep ? "kept by --keep" : "owned Node daemons stopped; compose down executed";
  mkdirSync(dirname(RAW_EVIDENCE_PATH), { recursive: true });
  writeFileSync(RAW_EVIDENCE_PATH, JSON.stringify(evidence, null, 2), { encoding: "utf8", mode: 0o640 });
  console.log(JSON.stringify(evidence, null, 2));
}

main().then(
  () => process.exit(0),
  async (error) => {
    console.error(`DRILL FAILED: ${error.stack ?? error}`);
    try {
      await runCleanup();
    } catch (cleanupError) {
      console.error(`DRILL CLEANUP FAILED: ${cleanupError.stack ?? cleanupError}`);
    }
    mkdirSync(dirname(RAW_EVIDENCE_PATH), { recursive: true });
    writeFileSync(RAW_EVIDENCE_PATH, JSON.stringify({ ...evidence, finishedAt: new Date().toISOString(), success: false, error: String(error) }, null, 2), { encoding: "utf8", mode: 0o640 });
    process.exit(1);
  },
);
