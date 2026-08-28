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

async function runSmoke(baseUrl) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      DSH_SMOKE_URL: baseUrl,
      DSH_SMOKE_SESSION_ID: "session-test",
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
