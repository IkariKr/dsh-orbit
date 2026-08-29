import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("../scripts/smoke-auth.mjs", import.meta.url));

const USER = "orbit-test-user";
const TEST_PASSWORD = "orbit-test-password";
const VALID_AUTHORIZATION = `Basic ${Buffer.from(`${USER}:${TEST_PASSWORD}`).toString("base64")}`;

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

async function runSmoke(baseUrl, { withCredentials = true, extraEnv = {} } = {}) {
  const env = { ...process.env, DSH_SMOKE_URL: baseUrl, ...extraEnv };
  if (withCredentials) {
    env.DSH_SMOKE_BASIC_USER = USER;
    env.DSH_SMOKE_BASIC_PASSWORD = TEST_PASSWORD;
  } else {
    delete env.DSH_SMOKE_BASIC_USER;
    delete env.DSH_SMOKE_BASIC_PASSWORD;
  }
  const child = spawn(process.execPath, [SCRIPT], {
    env,
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

function respond(res, rpcId, result, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "server-response", rpcId, result }));
}

async function readRequest(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return { headers: req.headers, body: JSON.parse(raw) };
}

function fenceHandler(captured, originMode = "host") {
  return async (req, res) => {
    const request = await readRequest(req);
    captured.push(request);
    const expectedOrigin =
      originMode === "host" ? `http://${req.headers.host}` : originMode;
    if (request.headers.authorization !== VALID_AUTHORIZATION) {
      respond(res, request.body.rpcId, { ok: false, error: { code: "E", message: "unauthorized" } }, 401);
      return;
    }
    if (request.headers["sec-fetch-site"] === "cross-site") {
      respond(res, request.body.rpcId, { ok: false, error: { code: "E", message: "cross-site" } }, 403);
      return;
    }
    if (request.headers.origin !== undefined && request.headers.origin !== expectedOrigin) {
      respond(res, request.body.rpcId, { ok: false, error: { code: "E", message: "origin" } }, 403);
      return;
    }
    respond(res, request.body.rpcId, { ok: true, value: { writable: true, namespaces: [] } });
  };
}

test("proves the full authorization matrix against a compliant deployment", async () => {
  const captured = [];
  const { code, stdout, stderr } = await withServer(fenceHandler(captured), (baseUrl) => runSmoke(baseUrl));
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /PASS allowed: authenticated same-origin settings\.describe/);
  assert.match(stdout, /PASS denied: unauthenticated privileged RPC/);
  assert.match(stdout, /PASS denied: invalid Basic credentials/);
  assert.match(stdout, /PASS denied: unexpected Origin/);
  assert.match(stdout, /PASS denied: Sec-Fetch-Site: cross-site/);
  assert.match(stdout, /PASS denied: forged Cf-Access-Jwt-Assertion/);
  assert.match(stdout, /authorization smoke: PASS \(6\/6 cases matched\)/);
  assert.ok(!stdout.includes(TEST_PASSWORD));
  assert.ok(!stdout.includes(VALID_AUTHORIZATION));
});

test("constructs authenticated same-origin requests for the positive control", async () => {
  const captured = [];
  const { code } = await withServer(fenceHandler(captured), (baseUrl) => runSmoke(baseUrl));
  assert.equal(code, 0);
  const positive = captured.find((entry) => entry.headers.authorization === VALID_AUTHORIZATION);
  assert.ok(positive, "positive control request was not captured");
  assert.equal(positive.body.type, "client-request");
  assert.equal(positive.body.method, "settings.describe");
  assert.deepEqual(positive.body.payload, {});
  assert.match(positive.body.rpcId, /^orbit-auth-smoke-/);
  assert.equal(positive.headers["content-type"], "application/json");
  assert.equal(positive.headers.origin, `http://${positive.headers.host}`);
  assert.equal(positive.headers["sec-fetch-site"], "same-origin");
});

test("fails closed when a negative case is accepted", async () => {
  const { code, stdout, stderr } = await withServer(
    async (req, res) => {
      const request = await readRequest(req);
      respond(res, request.body.rpcId, { ok: true, value: {} });
    },
    (baseUrl) => runSmoke(baseUrl),
  );
  assert.equal(code, 1);
  assert.match(stderr, /FAIL unauthenticated privileged RPC: expected denied, got allowed/);
  assert.match(stderr, /FAIL invalid Basic credentials/);
  assert.match(stderr, /FAIL unexpected Origin/);
  assert.match(stderr, /FAIL Sec-Fetch-Site: cross-site/);
  assert.match(stderr, /FAIL forged Cf-Access-Jwt-Assertion/);
  assert.match(stdout, /PASS allowed: authenticated same-origin settings\.describe/);
  assert.match(stderr, /authorization smoke: FAIL/);
});

test("fails when the positive control is rejected", async () => {
  const { code, stderr } = await withServer(
    async (req, res) => {
      const request = await readRequest(req);
      respond(res, request.body.rpcId, { ok: false, error: { code: "E", message: "denied" } }, 401);
    },
    (baseUrl) => runSmoke(baseUrl),
  );
  assert.equal(code, 1);
  assert.match(stderr, /FAIL authenticated same-origin settings\.describe: expected allowed, got denied \(HTTP 401\)/);
  assert.match(stderr, /authorization smoke: FAIL/);
});

test("redacts credentials from failure output", async () => {
  const invalidAuthorization = `Basic ${Buffer.from(`${USER}:${TEST_PASSWORD}-orbit-smoke-invalid`).toString("base64")}`;
  const { code, stdout, stderr } = await withServer(
    async (req, res) => {
      const request = await readRequest(req);
      respond(res, request.body.rpcId, {
        ok: false,
        error: {
          code: "E",
          message: `echo ${TEST_PASSWORD} ${VALID_AUTHORIZATION} ${invalidAuthorization}`,
        },
      });
    },
    (baseUrl) => runSmoke(baseUrl),
  );
  assert.equal(code, 1);
  const output = stdout + stderr;
  assert.ok(!output.includes(TEST_PASSWORD));
  assert.ok(!output.includes(VALID_AUTHORIZATION));
  assert.ok(!output.includes(invalidAuthorization));
  assert.ok(output.includes("[redacted]"));
});

test("reports gateway rejections without echoing response bodies", async () => {
  const { code, stderr } = await withServer(
    async (req, res) => {
      const request = await readRequest(req);
      res.writeHead(401, { "content-type": "text/plain" });
      res.end(`secret context: ${TEST_PASSWORD}`);
    },
    (baseUrl) => runSmoke(baseUrl),
  );
  assert.equal(code, 1);
  assert.match(stderr, /expected allowed, got denied \(HTTP 401\)/);
  assert.ok(!stderr.includes(TEST_PASSWORD));
});

test("a server error is a failed case, not a denied case", async () => {
  const { code, stderr } = await withServer(
    async (req, res) => {
      const request = await readRequest(req);
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("gateway overloaded");
    },
    (baseUrl) => runSmoke(baseUrl),
  );
  assert.equal(code, 1);
  assert.match(stderr, /FAIL authenticated same-origin settings\.describe: request error, expected allowed \(HTTP 503 server error\)/);
  assert.match(stderr, /FAIL unauthenticated privileged RPC: request error, expected denied \(HTTP 503 server error\)/);
  assert.ok(!stderr.includes("got denied (HTTP 503"), "server errors must not count as authorization denials");
});

test("honors DSH_SMOKE_ORIGIN when the gateway rewrites the Host", async () => {
  const captured = [];
  const { code, stdout } = await withServer(fenceHandler(captured, "https://dsh.example.com"), (baseUrl) =>
    runSmoke(baseUrl, { extraEnv: { DSH_SMOKE_ORIGIN: "https://dsh.example.com" } }),
  );
  assert.equal(code, 0);
  assert.match(stdout, /authorization smoke: PASS \(6\/6 cases matched\)/);
  const positive = captured.find((entry) => entry.headers.authorization === VALID_AUTHORIZATION);
  assert.equal(positive.headers.origin, "https://dsh.example.com");
});

test("rejects an invalid DSH_SMOKE_ORIGIN", async () => {
  const { code, stderr } = await withServer(fenceHandler(), (baseUrl) =>
    runSmoke(baseUrl, { extraEnv: { DSH_SMOKE_ORIGIN: "not-an-origin" } }),
  );
  assert.equal(code, 2);
  assert.match(stderr, /DSH_SMOKE_ORIGIN must be an absolute origin/);
});

test("requires the target URL", async () => {
  const { code, stderr } = await runSmoke("", { withCredentials: true });
  assert.equal(code, 2);
  assert.match(stderr, /DSH_SMOKE_URL is required/);
});

test("requires the Basic Auth credentials for the supported auth path", async () => {
  const { code, stderr } = await withServer(
    async (req, res) => {
      const request = await readRequest(req);
      respond(res, request.body.rpcId, { ok: true, value: {} });
    },
    (baseUrl) => runSmoke(baseUrl, { withCredentials: false }),
  );
  assert.equal(code, 2);
  assert.match(stderr, /DSH_SMOKE_BASIC_USER and DSH_SMOKE_BASIC_PASSWORD are required/);
});
