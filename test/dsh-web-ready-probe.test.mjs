import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PROBE = new URL("../bin/dsh-orbit-web-ready", import.meta.url);
const DOCKERFILE = new URL("../docker/Dockerfile", import.meta.url);
const DSH_COMPOSE = new URL("../docker/compose.example.yaml", import.meta.url);
const DRILL_COMPOSE = new URL("../docker-registry/drill.compose.yaml", import.meta.url);
const DRIVER = new URL("../scripts/registry-drill.mjs", import.meta.url);

// Mirrors scripts/check-public-tree.mjs: on Windows a file URL pathname carries a
// leading slash before the drive letter, and the shell needs forward slashes.
const probePath = PROBE.pathname.replace(/^\/[A-Za-z]:/, (value) => value.slice(1));
const probeSource = await readFile(PROBE, "utf8");

// curl exit codes this suite distinguishes: 22 is `--fail` seeing an HTTP error
// status (a real answer), 28 is a timeout and 7 a refused connection.
const CURL_HTTP_ERROR = 22;

function resolveShell() {
  const candidates = [process.env.DSH_ORBIT_SH, "sh", "bash"].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-c", "exit 0"], { encoding: "utf8" });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

function hasCurl() {
  const result = spawnSync("curl", ["--version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

const shell = resolveShell();
const curlAvailable = hasCurl();
const canRunProbe = shell !== null && curlAvailable;
const skipReason = `probe behavior needs a POSIX shell and curl on PATH (shell=${shell ?? "missing"}, curl=${curlAvailable})`;

// The probe is a real child process, so it must be awaited asynchronously: a
// blocking spawn keeps Node's event loop busy and the in-process test server
// below could never answer the request.
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, error, stdout, stderr });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function runProbe(url) {
  return run(shell, [probePath, url]);
}

async function withServer(status, runAgainstServer) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(status, { "content-type": "text/plain" });
    response.end("probe target\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;
  try {
    return await runAgainstServer(url, port, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the DSH web probe treats an authenticated 401 as ready", { skip: !canRunProbe && skipReason }, async () => {
  // This is the exact shape of the generation that broke the previous probe:
  // native BrowserAuth answers every unauthenticated request with 401 while the
  // web server is healthy. The old tokenless probe read that as "not ready".
  const { exitCode, requests } = await withServer(401, async (url, _port, seen) => ({
    exitCode: (await runProbe(url)).status,
    requests: seen.length,
  }));
  assert.equal(requests, 1, "the probe must actually reach the server for this result to mean anything");
  assert.equal(exitCode, 0, "a 401 answer proves the web server is up and must satisfy readiness");
});

test("the DSH web probe still accepts a public 200", { skip: !canRunProbe && skipReason }, async () => {
  const { exitCode, requests } = await withServer(200, async (url, _port, seen) => ({
    exitCode: (await runProbe(url)).status,
    requests: seen.length,
  }));
  assert.equal(requests, 1);
  assert.equal(exitCode, 0, "a 200 answer must keep satisfying readiness for a public generation");
});

test("the DSH web probe rejects an internal 500", { skip: !canRunProbe && skipReason }, async () => {
  const { exitCode, requests } = await withServer(500, async (url, _port, seen) => ({
    exitCode: (await runProbe(url)).status,
    requests: seen.length,
  }));
  assert.equal(requests, 1, "the probe must reach the server for the 500 boundary to be meaningful");
  assert.equal(exitCode, 1, "an HTTP 500 is a failed service response and must not satisfy readiness");
});

test("the DSH web probe fails closed when nothing is listening", { skip: !canRunProbe && skipReason }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "text/plain" });
    response.end("probe target\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  await new Promise((resolve) => server.close(resolve));
  const result = await runProbe(url);
  assert.equal(result.status, 1, "a refused connection must not be reported as ready");
});

test("a probe that requires an unauthenticated 2xx cannot observe readiness", { skip: !canRunProbe && skipReason }, async () => {
  // Negative control for the fixed defect. `curl --fail` fails on any HTTP error
  // status exactly as `wget -q -O /dev/null` did, so this reproduces the old
  // contract. The exact exit code matters: 22 proves curl read a real 401 from a
  // live server, whereas a timeout (28) or refusal (7) would pass a looser
  // "not zero" assertion for the wrong reason.
  const exitCode = await withServer(401, async (url) => (await run("curl", ["--fail", "--silent", "--max-time", "10", url])).status);
  assert.equal(exitCode, CURL_HTTP_ERROR, "the previous 2xx-only contract must read a real 401 as failure");
});

test("the image installs the shared probe and every healthcheck uses it", async () => {
  const dockerfile = await readFile(DOCKERFILE, "utf8");
  assert.match(dockerfile, /COPY bin\/dsh-orbit-web-ready \/usr\/local\/bin\/dsh-orbit-web-ready/);
  assert.match(dockerfile, /chmod 0755 [^\n]*\/usr\/local\/bin\/dsh-orbit-web-ready/);

  for (const [label, url] of [
    ["product compose", DSH_COMPOSE],
    ["drill compose", DRILL_COMPOSE],
  ]) {
    const compose = await readFile(url, "utf8");
    const healthchecks = compose.match(/^\s*test: \["CMD-SHELL"[^\n]*$/gm) ?? [];
    const dshHealthchecks = healthchecks.filter((line) => line.includes("/tmp/dsh-orbit-ready"));
    assert.ok(dshHealthchecks.length > 0, `${label} must declare a DSH healthcheck`);
    for (const line of dshHealthchecks) {
      assert.match(line, /\/usr\/local\/bin\/dsh-orbit-web-ready/, `${label} healthcheck must use the shared probe`);
    }
    assert.doesNotMatch(
      compose,
      /wget -q -O \/dev\/null http:\/\/127\.0\.0\.1:3080/,
      `${label} must not keep the tokenless probe that a 401 answer defeats`,
    );
  }
});

test("the probe accepts non-5xx responses and rejects non-answers", () => {
  assert.match(probeSource, /%\{http_code\}/, "readiness must be judged from the HTTP status");
  assert.match(probeSource, /2\?\?\|3\?\?\|4\?\?\) exit 0/, "2xx, 3xx, and 4xx answers must satisfy readiness");
  assert.match(probeSource, /\*\) exit 1/, "empty, 5xx, and malformed statuses must fail closed");
});

test("the drill claims stack ownership before compose can create a partial stack", async () => {
  const source = await readFile(DRIVER, "utf8");
  assert.match(
    source,
    /stackStarted = true;\s*\n\s*sh\(`docker compose -f \$\{COMPOSE\} up -d --build`\)/,
    "stack ownership must be claimed before `compose up` runs, so a dependency failure still tears the partial stack down",
  );
});
