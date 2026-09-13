import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("../scripts/smoke-session-resume.mjs", import.meta.url));

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

async function runSmoke(baseUrl, { generation = "connection-v1", sessionId = "session-test" } = {}) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      DSH_SMOKE_URL: baseUrl,
      DSH_SMOKE_SESSION_ID: sessionId,
      DSH_SMOKE_CONNECTION_PATCH: generation,
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

function respond(res, rpcId, result) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "server-response", rpcId, result }));
}

test("re-selects the current model to exercise existing-session resume without changing selection", async () => {
  const calls = [];
  const result = await withServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ path: req.url, body });

    if (body.method === "session.models") {
      respond(res, body.rpcId, {
        ok: true,
        value: {
          current: {
            provider: "provider-a",
            model: "model-a",
            reasoningEffort: "high",
          },
          routable: true,
          groups: [],
          failures: [],
        },
      });
      return;
    }

    if (body.method === "session.selectModel") {
      assert.deepEqual(body.payload, {
        sessionId: "session-test",
        provider: "provider-a",
        model: "model-a",
        reasoningEffort: "high",
      });
      respond(res, body.rpcId, {
        ok: true,
        value: { selected: body.payload },
      });
      return;
    }

    res.writeHead(404).end();
  }, runSmoke);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /session\.models: ok/);
  assert.match(result.stdout, /session\.selectModel: ok \(existing-session resume\)/);
  assert.match(result.stdout, /sessionResume: pass \(existing session resumed on the candidate\)/);
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/session.models",
    "/api/session.selectModel",
  ]);
});

test("reports the upstream unscoped-context resume failure clearly", async () => {
  const result = await withServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);

    if (body.method === "session.models") {
      respond(res, body.rpcId, {
        ok: true,
        value: {
          current: { provider: "provider-a", model: "model-a" },
          routable: true,
          groups: [],
          failures: [],
        },
      });
      return;
    }

    respond(res, body.rpcId, {
      ok: false,
      error: {
        code: "internal",
        message:
          'resume failed for session "session-test": Error: agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset',
      },
    });
  }, runSmoke);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /existing-session resume compatibility failure/i);
  assert.match(result.stderr, /unscoped context/i);
});

test("BrowserAuth generation resolves the pre-upgrade session and re-selects its recorded model", async () => {
  const calls = [];
  const result = await withServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ path: req.url, body });

    if (body.method === "session/list") {
      assert.deepEqual(body.payload, { args: { _request: {} } });
      respond(res, body.rpcId, {
        ok: true,
        value: {
          items: [
            {
              sessionId: "session-other",
              updatedAt: 1,
              running: false,
              blank: false,
            },
            {
              sessionId: "session-test",
              updatedAt: 2,
              running: false,
              blank: false,
              projections: {
                asOfSeq: 2,
                values: {
                  modelSelection: {
                    lastUsed: { provider: "provider-a", model: "model-a", reasoningEffort: "high" },
                    next: { provider: "provider-b", model: "model-b" },
                  },
                },
              },
            },
          ],
          hasMore: false,
        },
      });
      return;
    }

    if (body.method === "session/selectModel") {
      assert.deepEqual(body.payload, {
        args: { request: { sessionId: "session-test", provider: "provider-b", model: "model-b" } },
      });
      respond(res, body.rpcId, {
        ok: true,
        value: { selected: { provider: "provider-b", model: "model-b" } },
      });
      return;
    }

    res.writeHead(404).end();
  }, (baseUrl) => runSmoke(baseUrl, { generation: "connection-browser-auth-v1" }));

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /recorded selection: provider-b\/model-b/);
  assert.match(result.stdout, /sessionResume: pass \(existing session resumed on the candidate\)/);
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/session/list",
    "/api/session/selectModel",
  ]);
});

test("BrowserAuth generation falls back to the model catalog default when no selection is recorded", async () => {
  const result = await withServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);

    if (body.method === "session/list") {
      respond(res, body.rpcId, {
        ok: true,
        value: {
          items: [
            { sessionId: "session-test", updatedAt: 2, running: false, blank: true },
          ],
          hasMore: false,
        },
      });
      return;
    }

    if (body.method === "session/modelCatalog") {
      assert.deepEqual(body.payload, { args: {} });
      respond(res, body.rpcId, {
        ok: true,
        value: { default: { provider: "provider-a", model: "model-a" }, routableProviders: [], groups: [] },
      });
      return;
    }

    if (body.method === "session/selectModel") {
      assert.deepEqual(body.payload, {
        args: { request: { sessionId: "session-test", provider: "provider-a", model: "model-a" } },
      });
      respond(res, body.rpcId, {
        ok: true,
        value: { selected: { provider: "provider-a", model: "model-a" } },
      });
      return;
    }

    res.writeHead(404).end();
  }, (baseUrl) => runSmoke(baseUrl, { generation: "connection-browser-auth-v1" }));

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /model catalog default: provider-a\/model-a/);
  assert.match(result.stdout, /sessionResume: pass/);
});

test("BrowserAuth generation fails when the pre-upgrade session is not resolvable", async () => {
  const result = await withServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.method === "session/list") {
      respond(res, body.rpcId, { ok: true, value: { items: [], hasMore: false } });
      return;
    }
    res.writeHead(404).end();
  }, (baseUrl) => runSmoke(baseUrl, { generation: "connection-browser-auth-v1" }));

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /was not resolvable on the candidate/);
});

test("BrowserAuth generation rejects a mismatched selectModel echo", async () => {
  const result = await withServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);

    if (body.method === "session/list") {
      respond(res, body.rpcId, {
        ok: true,
        value: {
          items: [
            {
              sessionId: "session-test",
              updatedAt: 2,
              running: false,
              blank: false,
              projections: { asOfSeq: 2, values: { modelSelection: { lastUsed: { provider: "provider-a", model: "model-a" } } } },
            },
          ],
          hasMore: false,
        },
      });
      return;
    }

    if (body.method === "session/selectModel") {
      respond(res, body.rpcId, {
        ok: true,
        value: { selected: { provider: "provider-x", model: "model-x" } },
      });
      return;
    }

    res.writeHead(404).end();
  }, (baseUrl) => runSmoke(baseUrl, { generation: "connection-browser-auth-v1" }));

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /instead of provider-a\/model-a/);
});

test("fails closed without a declared connection generation", async () => {
  const result = await withServer(
    async (req, res) => {
      res.writeHead(404).end();
    },
    (baseUrl) => runSmoke(baseUrl, { generation: "" }),
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /DSH_SMOKE_CONNECTION_PATCH is required/);
});

test("rejects an unreviewed connection generation", async () => {
  const result = await withServer(
    async (req, res) => {
      res.writeHead(404).end();
    },
    (baseUrl) => runSmoke(baseUrl, { generation: "connection-v99" }),
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no reviewed wire contract for connection patch "connection-v99"/);
});
