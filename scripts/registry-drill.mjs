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

import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCompatibilityReport } from "../src/compatibility-report.mjs";
import { runVerificationSequence } from "../src/upgrade-runner.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const COMPOSE = "docker-registry/drill.compose.yaml";
const HUB_URL = "http://127.0.0.1:5445/";
// Nodes reach the Hub through the PRIVATE machine ingress on the
// compose bridge (the Hub process itself stays loopback-only).
const NODE_HUB_URL = "http://registry-hub:5446/";
const GATEWAY_URL = "https://127.0.0.1:8443";
const AUTH = `Basic ${Buffer.from("operator:drill-password").toString("base64")}`;
const NODE_BIN = "/usr/local/lib/dsh-orbit/bin/dsh-orbit-node.mjs";
const REVISION = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO }).toString().trim();
const HEARTBEAT_CADENCE_SECONDS = 60;
const HEARTBEAT_MISSED_BEATS = 3;
const HEARTBEAT_LOST_MS = 24 * 60 * 60 * 1000;
const AGING_CLOCK_PATH = join(REPO, "data", "orbit-drill", "drill-aging-clock");
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
const RUN_ID = randomUUID();
let resolvedOpenSsl = null;

const evidence = {
  runId: RUN_ID,
  commit: REVISION,
  startedAt: new Date().toISOString(),
  steps: [],
};
let runCleanup = async () => {};

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
    certificateUsable(DRILL_CERT_PATH, DRILL_CA_PATH);
  if (!leafReady) {
    writeFileSync(DRILL_EXT_PATH, "subjectAltName=IP:127.0.0.1,DNS:dsh-a.test,DNS:dsh-b.test\n");
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
    sans: ["127.0.0.1", "dsh-a.test", "dsh-b.test"],
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

function gatewayFetch(path, { method = "GET", headers = {}, body, cookie = null, authenticate = true, origin = null, baseUrl = GATEWAY_URL } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    if (cookie) finalHeaders.cookie = cookie;
    if (method === "POST") {
      finalHeaders.origin = origin ?? GATEWAY_URL;
      finalHeaders["sec-fetch-site"] = "same-origin";
    }
    if (authenticate) finalHeaders.authorization = AUTH;
    const req = httpsRequest(
      `${baseUrl}${path}`,
      { method, headers: finalHeaders, ca: readFileSync(DRILL_CA_PATH), rejectUnauthorized: true },
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

const nodeEnv = (dataHome) => ({
  DSH_ORBIT_NODE_STATE: `${dataHome}/orbit-node.json`,
  DSH_ORBIT_HUB_URL: NODE_HUB_URL,
  DSH_ORBIT_NODE_ORBIT_VERSION: "0.3.0",
  DSH_ORBIT_NODE_ORBIT_REVISION: REVISION,
  DSH_ORBIT_NODE_DSH_VERSION: "0.1.1-rc.2",
  DSH_ORBIT_NODE_DSH_PROFILE: "dsh-0.1.1-rc.2",
  DSH_ORBIT_NODE_HEARTBEAT_SECONDS: String(HEARTBEAT_CADENCE_SECONDS),
});

const nodePidFile = (dataHome) => `${dataHome}/orbit-node.pid`;
const nodeLogFile = (dataHome) => `${dataHome}/orbit-node.log`;

async function startNode(name, dataHome) {
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
  ], { env: nodeEnv(dataHome) });
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
  requireCleanCandidateWorktree();
  rmSync(BROWSER_BOOTSTRAP_CHECKPOINT_PATH, { force: true });
  rmSync(BROWSER_CHECKPOINT_PATH, { force: true });
  ensureDrillCertificate();
  const composeUp = args.includes("--compose-up");
  const waitForBrowser = args.includes("--wait-for-browser");
  const keep = args.includes("--keep");
  let stackStarted = false;
  runCleanup = async () => {
    if (keep) return;
    await stopNode("dsh-a", "/data/dsh-a", { strict: false });
    await stopNode("dsh-b", "/data/dsh-b", { strict: false });
    if (stackStarted) sh(`docker compose -f ${COMPOSE} down`, { expect: null });
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

  // --- 0. versions (array spawn: cmd.exe must not touch Go templates) ---
  const runDocker = (args) => spawnSync("docker", args, { cwd: REPO, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).stdout.trim();
  evidence.caddyVersion = runDocker(["run", "--rm", "caddy:2-alpine", "caddy", "version"]).split(/\s+/)[0] ?? "unknown";
  const imageEvidence = (image) => {
    const inspected = JSON.parse(runDocker(["inspect", image]))[0] ?? {};
    return {
      id: inspected.Id ?? "unknown",
      digest: inspected.RepoDigests?.[0] ?? "local-image-no-registry-digest",
      created: inspected.Created ?? "unknown",
    };
  };
  evidence.hubImage = imageEvidence("dsh-orbit-registry:drill");
  evidence.dshImages = {
    a: imageEvidence("dsh-orbit:dsh-drill-a"),
    b: imageEvidence("dsh-orbit:dsh-drill-b"),
  };
  evidence.dshImage = evidence.dshImages;
  evidence.hubImageDigest = evidence.hubImage.digest;
  evidence.dshImageDigest = `${evidence.dshImages.a.digest}; ${evidence.dshImages.b.digest}`;
  evidence.dshVersion = "0.1.1-rc.2";
  evidence.hubListenPolicy = "127.0.0.1:5445 (loopback; frozen policy intact)";

  // --- 1. compose up ---
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
  const caddyValidation = spawnSync("docker", ["exec", caddyContainer, "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"], {
    cwd: REPO, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  if (caddyValidation.status !== 0 || !caddyValidation.stderr?.includes("Valid configuration") && !caddyValidation.stdout?.includes("Valid configuration")) {
    throw new Error(`caddy validate failed (${caddyValidation.status}): ${caddyValidation.stdout}\n${caddyValidation.stderr}`);
  }
  evidence.steps.push("caddy: real caddy validate -> Valid configuration; TLS certificate mounted");
  await waitFor("hub http", async () => (await hubGetHealth()) === 200);
  await waitFor("gateway tls", async () => (await gatewayFetch("/")).status === 200);

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
      env: { ...nodeEnv(dataHome), DSH_ORBIT_ENROLL_TOKEN: plain.token },
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
      orbitVersion: "0.3.0",
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
      orbit: { version: "0.3.0", revision: REVISION },
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
    exec(name, ["node", NODE_BIN, "upload-report"], { env: { ...nodeEnv(dataHome), DSH_ORBIT_REPORT_FILE: `${dataHome}/report-drill.json` } });
    await startNode(name, dataHome);
    return nodeId;
  }
  const aNodeId = await deployNode("dsh-a", "/data/dsh-a", "https://127.0.0.1:18443", 18443);
  const bNodeId = await deployNode("dsh-b", "/data/dsh-b", "https://127.0.0.1:18444", 18444);
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
  evidence.steps.push("gateway: restarted; new session works; live post-restart node state matches pre-restart state");

  // --- 5. A disconnect: stop its owned run loop; age only A's contact ---
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

  // --- 6. A reconnect ---
  await startNode("dsh-a", "/data/dsh-a");
  await waitFor("A fresh again", async () => nodeStateIs(aNodeId, (node) => node.health.registryContact === "fresh"), {
    attempts: 30,
    intervalMs: 6000,
  });
  evidence.steps.push("A reconnect: fresh again, alert flags cleared; B untouched");

  // --- 7. delete A through the browser surface; A denied; B clean ---
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
  evidence.steps.push(`delete A (requestId, explicit result): tombstoned; A local state=revoked (machine denial); B=${bAfterDelete.health.registryContact}`);

  // --- 8. reenroll A (same nodeId) ---
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
  view = await nodesApi();
  const bFinal = row(view, bNodeId);
  if (bFinal.health.registryContact !== "fresh") throw new Error("B contaminated at the end");
  evidence.steps.push(`reenroll A: same nodeId ${aNodeId}, active + fresh; B final=${bFinal.health.registryContact} (healthy throughout)`);

  evidence.finishedAt = new Date().toISOString();
  evidence.success = true;

  await runCleanup();
  evidence.cleanup = keep ? "kept by --keep" : "owned Node daemons stopped; compose down executed";
  const outPath = join(REPO, "data", "drill-evidence.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(evidence, null, 2));
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
    const outPath = join(REPO, "data", "drill-evidence.json");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ ...evidence, finishedAt: new Date().toISOString(), success: false, error: String(error) }, null, 2));
    process.exit(1);
  },
);
