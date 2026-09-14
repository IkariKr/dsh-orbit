import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import process from "node:process";
import { rpcEndpoint, rpcPayload, wireContractForGeneration } from "../src/dsh-wire-contract.mjs";

const baseUrl = process.env.DSH_SMOKE_URL;
const sessionId = process.env.DSH_SMOKE_SESSION_ID;

if (!baseUrl) {
  console.error("DSH_SMOKE_URL is required, for example https://dsh.example.com");
  process.exit(2);
}
if (!sessionId) {
  console.error("DSH_SMOKE_SESSION_ID is required");
  process.exit(2);
}

// The smoke must be told which reviewed connection generation the candidate
// speaks; the endpoints and payload shapes follow from that generation's wire
// contract — never from a version comparison. The semantic goal is identical
// for both generations: a session created before the upgrade must resolve on
// the candidate, and its current model selection must be re-selectable through
// a safe, side-effect-free operation.
const generation = process.env.DSH_SMOKE_CONNECTION_PATCH;
if (!generation) {
  console.error(
    "DSH_SMOKE_CONNECTION_PATCH is required: set it to the candidate's reviewed connection patch generation " +
      "(connection-v1 or connection-browser-auth-v1)",
  );
  process.exit(2);
}
let contract;
try {
  contract = wireContractForGeneration(generation);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const headers = { "content-type": "application/json" };
if (process.env.DSH_SMOKE_BASIC_USER && process.env.DSH_SMOKE_BASIC_PASSWORD) {
  headers.authorization =
    "Basic " +
    Buffer.from(
      `${process.env.DSH_SMOKE_BASIC_USER}:${process.env.DSH_SMOKE_BASIC_PASSWORD}`,
    ).toString("base64");
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const followTimeoutMs = Number(process.env.DSH_SMOKE_TIMEOUT_MS || 5000);

function encodeClientFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > 0xffff) throw new Error("session follow: client frame is too large");
  const headerLength = body.length <= 125 ? 2 : 4;
  const mask = randomBytes(4);
  const out = Buffer.alloc(headerLength + 4 + body.length);
  out[0] = 0x80 | (opcode & 0x0f);
  if (body.length <= 125) {
    out[1] = 0x80 | body.length;
  } else {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(body.length, 2);
  }
  mask.copy(out, headerLength);
  for (let i = 0; i < body.length; i++) out[headerLength + 4 + i] = body[i] ^ mask[i % 4];
  return out;
}

function parseServerFrame(buffer) {
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

function browserAuthFollowSnapshot(targetSessionId) {
  return new Promise((resolve, reject) => {
    const target = new URL("/api/remote.mux", baseUrl);
    const transport = target.protocol === "https:" ? https : http;
    const secKey = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(secKey + WS_GUID).digest("base64");
    const streamId = `orbit-resume-follow-${randomUUID()}`;
    const origin = process.env.DSH_SMOKE_ORIGIN || target.origin;
    const requestHeaders = {
      host: target.host,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": secKey,
      origin,
      "sec-fetch-site": "same-origin",
    };
    if (headers.authorization) requestHeaders.authorization = headers.authorization;

    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      action(value);
    };

    const req = transport.request(target, { method: "GET", headers: requestHeaders, timeout: followTimeoutMs });
    req.on("upgrade", (res, socket, head) => {
      if (res.headers["sec-websocket-accept"] !== expectedAccept) {
        socket.destroy();
        finish(reject, new Error("session follow: WebSocket accept mismatch"));
        return;
      }

      let buffered = head?.length ? Buffer.from(head) : Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        finish(reject, new Error(`session follow: opening snapshot timed out after ${followTimeoutMs}ms`));
      }, followTimeoutMs);
      const fail = (message) => {
        clearTimeout(timer);
        socket.destroy();
        finish(reject, new Error(`session follow: ${message}`));
      };
      const succeed = (snapshot) => {
        clearTimeout(timer);
        try { socket.write(encodeClientFrame(0x08, Buffer.from([0x03, 0xe8]))); } catch {}
        socket.destroy();
        finish(resolve, snapshot);
      };

      const onData = (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        for (;;) {
          const frame = parseServerFrame(buffered);
          if (!frame) return;
          buffered = buffered.subarray(frame.used);
          if (frame.opcode === 0x08) {
            fail("server closed the stream before the opening snapshot");
            return;
          }
          if (frame.opcode === 0x09) {
            socket.write(encodeClientFrame(0x0a, frame.payload));
            continue;
          }
          if (frame.opcode !== 0x01) continue;
          let message;
          try {
            message = JSON.parse(frame.payload.toString("utf8"));
          } catch {
            continue;
          }
          if (message?.streamId !== streamId) continue;
          if (message.type === "item" && message.value?.type === "snapshot") {
            succeed(message.value);
            return;
          }
          if (message.type === "error" || message.type === "end") {
            fail(`remote.mux ended before snapshot (${JSON.stringify(message)})`);
            return;
          }
        }
      };
      socket.on("data", onData);
      socket.on("error", (error) => fail(error.message));
      socket.on("end", () => fail("socket ended before the opening snapshot"));

      socket.write(
        encodeClientFrame(
          0x01,
          JSON.stringify({
            type: "open",
            streamId,
            endpoint: "session/follow",
            payload: {
              args: {
                request: {
                  address: { kind: "session", sessionId: targetSessionId },
                  maxMessages: 50,
                },
              },
            },
          }),
        ),
      );
      if (buffered.length) onData(Buffer.alloc(0));
    });
    req.on("response", (res) => {
      res.resume();
      finish(reject, new Error(`session follow: HTTP ${res.statusCode}`));
    });
    req.on("error", (error) => finish(reject, new Error(`session follow: ${error.message}`)));
    req.on("timeout", () => {
      req.destroy();
      finish(reject, new Error(`session follow: connection timed out after ${followTimeoutMs}ms`));
    });
    req.end();
  });
}

async function rpc(namespace, method, args) {
  const endpoint = rpcEndpoint(contract, namespace, method);
  const rpcId = `orbit-resume-smoke-${randomUUID()}`;
  const response = await fetch(new URL(`/api/${endpoint}`, baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "client-request",
      rpcId,
      method: endpoint,
      payload: rpcPayload(contract, args),
    }),
  });

  if (!response.ok) {
    throw new Error(`${endpoint}: HTTP ${response.status}`);
  }

  const body = await response.json();
  if (body.rpcId !== rpcId) throw new Error(`${endpoint}: rpcId mismatch`);
  if (!body.result?.ok) {
    const message = body.result?.error?.message || "RPC failed";
    const error = new Error(`${endpoint}: ${message}`);
    error.rpcCode = body.result?.error?.code;
    throw error;
  }
  return body.result.value;
}

function formatSelection(selection) {
  return `${selection.provider}/${selection.model}${
    selection.reasoningEffort ? `, reasoning=${selection.reasoningEffort}` : ""
  }`;
}

try {
  if (generation === "connection-v1") {
    const models = await rpc("session", "models", { sessionId });
    const current = models?.current;
    if (!current?.provider || !current?.model) {
      throw new Error("session models: current model selection is incomplete");
    }

    console.log(`session.models: ok (${formatSelection(current)})`);

    const selection = { sessionId, provider: current.provider, model: current.model };
    if (current.reasoningEffort) selection.reasoningEffort = current.reasoningEffort;

    await rpc("session", "selectModel", selection);
    console.log("session.selectModel: ok (existing-session resume)");
  } else {
    // The BrowserAuth generation exposes the session surface as Remotes. The
    // pre-upgrade session must appear in the candidate's own session listing —
    // that is the resolve step — and its recorded selection is re-selected
    // through session/selectModel, which forces the session to load without
    // changing the model choice or prompting any business side effect. There is
    // deliberately no fallback to the deployment-wide model catalog: a
    // historical session whose recorded selection cannot be recovered is
    // exactly the upgrade-continuity failure this smoke exists to catch, and
    // selecting the global default would launder it into a pass.
    const list = await rpc("session", "list", { _request: {} });
    const item = list?.items?.find((entry) => entry.sessionId === sessionId);
    if (!item) {
      throw new Error(
        `session list: pre-upgrade session ${JSON.stringify(sessionId)} was not resolvable on the candidate`,
      );
    }

    // session/list intentionally exposes only already-cached projection hints and
    // never materializes missing cells for cold Sessions. A pre-upgrade 0.1.1
    // Session can therefore be fully valid while list omits modelSelection. The
    // opening session/follow snapshot is the authoritative cold-safe read: the
    // Host observes the durable log with projectionMode=all and folds historical
    // request/header events into modelSelection before promoting the Session.
    const snapshot = await browserAuthFollowSnapshot(sessionId);
    if (snapshot?.header?.id !== sessionId) {
      throw new Error(`session follow: opening snapshot identity mismatch for ${JSON.stringify(sessionId)}`);
    }
    const selection =
      snapshot.projections?.values?.modelSelection?.next
      ?? snapshot.projections?.values?.modelSelection?.lastUsed;
    if (!selection?.provider || !selection?.model) {
      throw new Error(
        `session follow: pre-upgrade session ${JSON.stringify(sessionId)} carries no recoverable model selection; ` +
          "existing-session continuity cannot be verified against the deployment-wide default",
      );
    }

    console.log(`session follow: ok (${sessionId.slice(0, 8)}…, recorded selection: ${formatSelection(selection)})`);

    const request = { sessionId, provider: selection.provider, model: selection.model };
    if (selection.reasoningEffort) request.reasoningEffort = selection.reasoningEffort;

    const selected = await rpc("session", "selectModel", { request });
    const applied = selected?.selected;
    if (applied?.provider !== selection.provider || applied?.model !== selection.model) {
      throw new Error(
        `session selectModel: candidate reported ${formatSelection(applied ?? {})} instead of ${formatSelection(selection)}`,
      );
    }
  }

  console.log("sessionResume: pass (existing session resumed on the candidate)");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("resume failed for session") &&
    message.includes("refusing to compose an unscoped context")
  ) {
    console.error(
      `Existing-session resume compatibility failure: ${message}`,
    );
    process.exit(1);
  }
  console.error(message);
  process.exit(1);
}
