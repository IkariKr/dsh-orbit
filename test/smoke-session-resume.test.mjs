import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("../scripts/smoke-session-resume.mjs", import.meta.url));

async function withServer(handler, run, upgradeHandler = undefined) {
  const server = http.createServer(handler);
  if (upgradeHandler) server.on("upgrade", upgradeHandler);
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

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeServerTextFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length > 0xffff) throw new Error("test WebSocket payload is too large");
  const header = payload.length <= 125 ? Buffer.alloc(2) : Buffer.alloc(4);
  header[0] = 0x81;
  if (payload.length <= 125) {
    header[1] = payload.length;
  } else {
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, payload]);
}

function parseClientFrame(buffer) {
  if (buffer.length < 2) return null;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked && mask.length < 4) return null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    payload[i] = masked ? buffer[offset + i] ^ mask[i % 4] : buffer[offset + i];
  }
  return { opcode: buffer[0] & 0x0f, payload, used: offset + length };
}

function followSnapshotUpgrade(modelSelection) {
  return (req, socket, head) => {
    assert.equal(req.url, "/api/remote.mux");
    const key = req.headers["sec-websocket-key"];
    assert.ok(key);
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    let buffered = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const frame = parseClientFrame(buffered);
        if (!frame) return;
        buffered = buffered.subarray(frame.used);
        if (frame.opcode === 0x8) {
          socket.destroy();
          return;
        }
        if (frame.opcode !== 0x1) continue;
        const message = JSON.parse(frame.payload.toString("utf8"));
        if (message?.type !== "open") continue;
        assert.equal(message.endpoint, "session/follow");
        assert.deepEqual(message.payload, {
          args: {
            request: {
              address: { kind: "session", sessionId: "session-test" },
              maxMessages: 50,
            },
          },
        });
        const values = modelSelection === null
          ? {}
          : { modelSelection: { lastUsed: modelSelection, next: modelSelection } };
        socket.write(
          encodeServerTextFrame({
            type: "item",
            streamId: message.streamId,
            value: {
              type: "snapshot",
              header: { version: 1, id: "session-test", createdAt: 1, cwd: "/workspace", isSeeded: false },
              cursor: 10,
              records: [],
              hasMore: false,
              projections: { asOfSeq: 10, values },
            },
          }),
        );
        return;
      }
    };
    socket.on("data", onData);
    if (buffered.length) onData(Buffer.alloc(0));
  };
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
  }, (baseUrl) => runSmoke(baseUrl, { generation: "connection-browser-auth-v1" }), followSnapshotUpgrade({
    provider: "provider-b",
    model: "model-b",
  }));

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /recorded selection: provider-b\/model-b/);
  assert.match(result.stdout, /sessionResume: pass \(existing session resumed on the candidate\)/);
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/session/list",
    "/api/session/selectModel",
  ]);
});

test("BrowserAuth generation fails a historical session whose selection cannot be recovered", async () => {
  // The deployment-wide default must never stand in for the session's own
  // recorded selection: losing that projection is precisely the upgrade
  // continuity failure this smoke exists to catch.
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

    res.writeHead(404).end();
  }, (baseUrl) => runSmoke(baseUrl, { generation: "connection-browser-auth-v1" }), followSnapshotUpgrade(null));

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /carries no recoverable model selection/);
  assert.match(result.stderr, /deployment-wide default/);
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
  }, (baseUrl) => runSmoke(baseUrl, { generation: "connection-browser-auth-v1" }), followSnapshotUpgrade({
    provider: "provider-a",
    model: "model-a",
  }));

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
