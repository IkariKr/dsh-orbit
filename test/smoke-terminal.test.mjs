import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createPatchedFenceModule, FENCE_PUBLIC_HOST, withTempDir } from "./helpers/ssh-fence-fixture.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/smoke-terminal.mjs", import.meta.url));

const USER = "orbit-test-user";
const TEST_PASSWORD = "orbit-test-password";
const VALID_AUTHORIZATION = `Basic ${Buffer.from(`${USER}:${TEST_PASSWORD}`).toString("base64")}`;
const EXPECTED_ORIGIN = `https://${FENCE_PUBLIC_HOST}`;

async function withServer(handler, run) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function runSmoke(baseUrl, extraEnv = {}) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      DSH_SMOKE_URL: baseUrl,
      DSH_SMOKE_BASIC_USER: USER,
      DSH_SMOKE_BASIC_PASSWORD: TEST_PASSWORD,
      DSH_SMOKE_ORIGIN: EXPECTED_ORIGIN,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

async function readRequest(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return { headers: req.headers, body: raw };
}

test("proves the terminal authorization matrix against a patched fence behind the gateway", async () => {
  const { code, stdout, stderr } = await withTempDir(async (dir) => {
    const { secret, moduleUrl } = await createPatchedFenceModule(dir);
    const fence = await import(moduleUrl);
    return withServer(async (req, res) => {
    await readRequest(req);
    const expectedAuthorization = VALID_AUTHORIZATION;
    if (req.headers.authorization !== expectedAuthorization) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    // gateway simulation: rewrite Host to the public authority, inject the
    // internal proxy secret, keep the browser context headers, then fence
    const request = {
      headers: {
        host: FENCE_PUBLIC_HOST,
        "x-forwarded-proto": "https",
        "x-dsh-orbit-authenticated-proxy": secret,
        "sec-fetch-site": req.headers["sec-fetch-site"],
        origin: req.headers.origin,
      },
    };
    if (fence.isDshOrbitAuthenticatedProxyRequest(request)) {
      res.writeHead(101, { connection: "upgrade", upgrade: "websocket" });
      res.end();
      return;
    }
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden: loopback-only or untrusted proxy" }));
    }, runSmoke);
  });

  assert.equal(code, 0, stderr);
  assert.match(stdout, /PASS allowed: authenticated same-origin terminal upgrade \(HTTP 101 upgrade admitted\)/);
  assert.match(stdout, /PASS denied: unauthenticated terminal upgrade \(HTTP 401\)/);
  assert.match(stdout, /PASS denied: invalid Basic credentials on terminal upgrade \(HTTP 401\)/);
  assert.match(stdout, /PASS denied: unexpected Origin on terminal upgrade \(HTTP 403\)/);
  assert.match(stdout, /PASS denied: Sec-Fetch-Site: cross-site on terminal upgrade \(HTTP 403\)/);
  assert.match(stdout, /PASS denied: forged Cf-Access-Jwt-Assertion on terminal upgrade \(HTTP 401\)/);
  assert.match(stdout, /terminal smoke: PASS \(6\/6 cases matched\)/);
});

test("fails closed when a negative terminal case is accepted", async () => {
  const { code, stdout, stderr } = await withTempDir(async (dir) => {
    await createPatchedFenceModule(dir);
    return withServer(async (req, res) => {
      await readRequest(req);
      res.writeHead(101, { connection: "upgrade", upgrade: "websocket" });
      res.end();
    }, runSmoke);
  });

  assert.equal(code, 1);
  assert.match(stderr, /FAIL unauthenticated terminal upgrade: expected denied, got allowed/);
  assert.match(stderr, /FAIL invalid Basic credentials on terminal upgrade: expected denied, got allowed/);
  assert.match(stderr, /FAIL Sec-Fetch-Site: cross-site on terminal upgrade: expected denied, got allowed/);
  assert.match(stdout, /PASS allowed: authenticated same-origin terminal upgrade/);
});

test("a server error is a failed case, not a denial", async () => {
  const { code, stderr } = await withServer(async (req, res) => {
    await readRequest(req);
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("overloaded");
  }, runSmoke);
  assert.equal(code, 1);
  assert.match(stderr, /HTTP 503 server error/);
  assert.ok(!stderr.includes("got denied (HTTP 503"), "server errors must not count as denials");
});

test("requires configuration", async () => {
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  assert.equal(code, 2);
  assert.match(stderr, /DSH_SMOKE_URL is required/);
});