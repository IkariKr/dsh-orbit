// Stage 9 Process Acceptance: real DeepSeek Harness 0.1.5-rc.2 `dsh web`
// end-to-end acceptance for the connection-browser-auth-v1 generation.
//
// This is the process-level counterpart to the bundle integration test. It boots
// the genuine `dsh web` CLI on an isolated DSH_HOME, patches the connection
// bundle that the booted profile actually loads, and then drives the running
// process over real sockets. Nothing in the upstream checkout is modified: the
// patched bundle lives in the temporary DSH_HOME and is deleted on teardown.
//
// Set DSH_015_ACCEPTANCE_ROOT to a built DSH 0.1.5-rc.2 checkout to run it. An
// explicitly configured but missing root fails closed rather than falling back.
//
// Covered:
//   1. Pinned upstream identity (0.1.5-rc.2 at fb2c4b9e...)
//   2. The booted process actually loaded the patched admission path
//   3. Native BrowserAuth: ?token= -> 303 + cookie, on the loopback and on the
//      configured trusted authority, plus authority-bound cookie rejection
//   4. Orbit authenticated-proxy admission over real HTTP
//   5. Trust fence vs BrowserAuth vs proof precedence on real HTTP
//   6. /api/remote.mux: upgrade admission, physical Ping/Pong, and the real
//      `$events` logical stream handshake (open -> item -> value.type "ready")

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchConnectionRootForGeneration, verifyConnectionRoot } from "../src/remote-settings-patch.mjs";
import {
  assertDsh015Identity,
  assertPristineBundle,
  assertProfileLinksToBuiltBundle,
  builtConnectionRoot,
  readBundleBytes,
  resolveDsh015Checkout,
  restoreBundleBytes,
  startDshWeb,
} from "./helpers/dsh-015-acceptance-fixture.mjs";

const PUBLIC_HOST = "dsh.example.com";
const OTHER_HOST = "other.example.com";
const UNTRUSTED_HOST = "evil.example.com";
const REMOTE_MUX_PATH = "/api/remote.mux";
// The exact secret the patched bundle reads from its proxy auth file.
const PROXY_SECRET = "test-orbit-proxy-secret";

const dshRoot = resolveDsh015Checkout();
let session = null;

before(async () => {
  if (!dshRoot) return;
  const identity = assertDsh015Identity(dshRoot);

  const dshHome = await mkdtemp(join(tmpdir(), "orbit-stage9-home-"));
  const proxyAuthFile = join(dshHome, "orbit-proxy-secret");
  await writeFile(proxyAuthFile, PROXY_SECRET, "utf8");

  let boot = null;
  let pristine = null;
  let bundleDir = null;
  try {
    // Phase 1: bootstrap the profile tree so the connection package is linked.
    boot = await startDshWeb({ dshRoot, dshHome, trustedHosts: [PUBLIC_HOST, OTHER_HOST] });
    await boot.stop();

    // The booted profile loads the workspace build artifact through a symlink,
    // so that artifact is what gets patched and what must be restored.
    bundleDir = assertProfileLinksToBuiltBundle(dshHome, dshRoot);
    assertPristineBundle(bundleDir);
    pristine = readBundleBytes(bundleDir);

    // Phase 2: patch the bundle the booted process loads.
    const patch = await patchConnectionRootForGeneration({
      root: bundleDir,
      connectionPatch: "connection-browser-auth-v1",
      publicHost: PUBLIC_HOST,
      proxyAuthFile,
    });
    assert.equal(patch.server, "patched", "the upstream connection bundle must accept the reviewed patch");
    assert.equal(patch.client, "patched");
    await verifyConnectionRoot({
      root: bundleDir,
      publicHost: PUBLIC_HOST,
      proxyAuthFile,
      connectionPatch: "connection-browser-auth-v1",
    });

    // Phase 3: serve the patched bundle.
    boot = await startDshWeb({ dshRoot, dshHome, trustedHosts: [PUBLIC_HOST, OTHER_HOST] });
    session = { ...identity, dshHome, bundleDir, pristine, boot };
  } catch (error) {
    await boot?.stop();
    if (bundleDir && pristine) restoreBundleBytes(bundleDir, pristine);
    await rm(dshHome, { recursive: true, force: true });
    throw error;
  }
});

after(async () => {
  if (!session) return;
  await session.boot.stop();
  // Restore the upstream build artifact byte for byte, then prove it: the
  // checkout must not be left carrying an Orbit patch.
  restoreBundleBytes(session.bundleDir, session.pristine);
  assertPristineBundle(session.bundleDir);
  await rm(session.dshHome, { recursive: true, force: true });
});

function live(t) {
  if (!session) {
    t.skip("DSH_015_ACCEPTANCE_ROOT not configured; skipping real dsh web process acceptance");
    return null;
  }
  return session.boot;
}

// ---------------------------------------------------------------------------
// HTTP helpers driving the real process.
// ---------------------------------------------------------------------------

function request(boot, { path = "/", host = PUBLIC_HOST, headers = {}, method = "GET" }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: boot.port, path, method, headers: { host, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.setTimeout(20000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function proofHeaders(overrides = {}) {
  return {
    host: PUBLIC_HOST,
    "x-forwarded-proto": "https",
    "x-dsh-orbit-authenticated-proxy": PROXY_SECRET,
    "sec-fetch-site": "same-origin",
    origin: `https://${PUBLIC_HOST}`,
    ...overrides,
  };
}

function cookiePair(response) {
  const raw = response.headers["set-cookie"];
  assert.ok(Array.isArray(raw) && raw.length > 0, "token exchange must set a cookie");
  return raw[0].match(/^([^;]+)/)[1];
}

/** Fence rejection is 403 and browser-auth rejection is 401; admitted is neither. */
function assertAdmitted(status, label) {
  assert.notEqual(status, 401, `${label}: must not be rejected by BrowserAuth`);
  assert.notEqual(status, 403, `${label}: must not be rejected by the trust fence`);
}

// ---------------------------------------------------------------------------
// Raw RFC 6455 client: needed because the matrix sets Host, Cookie, and
// proof headers, which a browser-shaped WebSocket client will not send.
// ---------------------------------------------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const mask = randomBytes(4);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function upgradeWebSocket({ port, headers }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    const response = { status: null, headers: null, accept: null };
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    const frames = [];
    const waiters = [];
    let closeFrame = null;
    let failed = null;

    const fail = (error) => {
      failed = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    };

    const deliver = (frame) => {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame);
      else frames.push(frame);
    };

    const parse = () => {
      while (true) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        let offset = 2;
        let length = buffer[1] & 0x7f;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (buffer[1] & 0x80) !== 0;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x8) closeFrame = { code: payload.length >= 2 ? payload.readUInt16BE(0) : null };
        deliver({ opcode, payload: Buffer.from(payload) });
      }
    };

    const finishHandshake = (head) => {
      const headerText = head.toString("latin1");
      const statusLine = /^HTTP\/1\.1 (\d{3})/.exec(headerText);
      response.status = statusLine ? Number(statusLine[1]) : null;
      for (const line of headerText.split("\r\n").slice(1)) {
        const at = line.indexOf(":");
        if (at > 0) response.headers = { ...(response.headers ?? {}), [line.slice(0, at).toLowerCase()]: line.slice(at + 1).trim() };
      }
      response.accept = response.headers?.["sec-websocket-accept"] ?? null;
      const expected = createHash("sha1").update(key + WS_GUID).digest("base64");

      const api = {
        response,
        validAccept: response.accept === expected,
        sendText: (text) => socket.write(encodeFrame(0x1, text)),
        sendBinary: (buf) => socket.write(encodeFrame(0x2, buf)),
        sendPing: (text) => socket.write(encodeFrame(0x9, text)),
        async nextFrame(timeoutMs = 15000) {
          if (frames.length > 0) return frames.shift();
          if (failed) throw failed;
          return new Promise((resolveFrame, rejectFrame) => {
            const timer = setTimeout(() => rejectFrame(new Error("timed out waiting for a WebSocket frame")), timeoutMs);
            timer.unref();
            waiters.push({
              resolve: (frame) => { clearTimeout(timer); resolveFrame(frame); },
              reject: (error) => { clearTimeout(timer); rejectFrame(error); },
            });
          });
        },
        async nextJson(timeoutMs = 15000) {
          for (;;) {
            const frame = await api.nextFrame(timeoutMs);
            if (frame.opcode !== 0x1) continue;
            return JSON.parse(frame.payload.toString("utf8"));
          }
        },
        get closeFrame() { return closeFrame; },
        destroy: () => socket.destroy(),
      };
      handshakeDone = true;
      if (response.status !== 101) {
        socket.destroy();
      }
      resolve(api);
    };

    socket.setTimeout(20000, () => fail(new Error("WebSocket socket timed out")));
    socket.on("connect", () => {
      socket.write(
        [
          `GET ${REMOTE_MUX_PATH} HTTP/1.1`,
          `Host: ${headers.host ?? PUBLIC_HOST}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${key}`,
          ...Object.entries(headers)
            .filter(([name]) => !["host", "Connection", "Upgrade", "Sec-WebSocket-Version", "Sec-WebSocket-Key"].includes(name))
            .map(([name, value]) => `${name}: ${value}`),
        ].join("\r\n") + "\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const at = buffer.indexOf("\r\n\r\n");
        if (at < 0) return;
        const head = buffer.subarray(0, at);
        buffer = buffer.subarray(at + 4);
        if (/^HTTP\/1\.1 101/.test(head.toString("latin1")) === false) {
          response.status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head.toString("latin1"))?.[1] ?? 0);
          finishHandshake(head);
          return;
        }
        finishHandshake(head);
        parse();
        return;
      }
      parse();
    });
    socket.on("error", (error) => { if (!handshakeDone) reject(error); else fail(error); });
    socket.on("close", () => { if (!handshakeDone) reject(new Error("socket closed before the upgrade completed")); });
  });
}

// ---------------------------------------------------------------------------
// 1. Identity and patch deployment
// ---------------------------------------------------------------------------

test("acceptance process boots the pinned upstream identity with the patched admission path", async (t) => {
  const boot = live(t);
  if (!boot) return;

  assert.equal(session.versionBanner, "0.1.5-rc.2");
  assert.equal(session.commitSha, "fb2c4b9e698e30edb738bca4cf0618587db7d203");
  assert.ok(boot.port > 0, "the process must report a listening port");

  // The booted process serving the Orbit proof is the behavioural proof that it
  // loaded the patched bundle, not an unpatched one.
  const response = await request(boot, { path: "/api/probe", headers: proofHeaders() });
  assertAdmitted(response.status, "booted process Orbit proof");
});

// ---------------------------------------------------------------------------
// 2. Native BrowserAuth on the real process
// ---------------------------------------------------------------------------

test("native token exchange mints an authority-bound cookie on the trusted authority", async (t) => {
  const boot = live(t);
  if (!boot) return;

  const exchange = await request(boot, {
    path: `/?token=${encodeURIComponent(boot.launchToken)}`,
    host: PUBLIC_HOST,
  });
  assert.equal(exchange.status, 303, "a valid native token must redirect");
  assert.equal(exchange.headers.location, "/");
  const cookie = cookiePair(exchange);

  // Trusted authority + native cookie: the remote-authority native path works.
  const trusted = await request(boot, { path: "/api/probe", headers: { cookie } });
  assertAdmitted(trusted.status, "native cookie on the trusted authority");

  // Authority-bound cookie: the same cookie must not authenticate another
  // authority, even though that authority passes the trust fence.
  const wrongAuthority = await request(boot, { path: "/api/probe", host: OTHER_HOST, headers: { cookie } });
  assert.equal(wrongAuthority.status, 401, "a cookie minted for another authority must be rejected");

  // The fence still runs first for a non-trusted authority.
  const untrusted = await request(boot, { path: "/api/probe", host: UNTRUSTED_HOST, headers: { cookie } });
  assert.equal(untrusted.status, 403, "an untrusted authority must be rejected by the fence before auth");
});

test("native token exchange works on the loopback authority and its cookie is rejected elsewhere", async (t) => {
  const boot = live(t);
  if (!boot) return;

  const loopbackAuthority = `127.0.0.1:${boot.port}`;
  const exchange = await request(boot, {
    path: `/?token=${encodeURIComponent(boot.launchToken)}`,
    host: loopbackAuthority,
  });
  assert.equal(exchange.status, 303, "the loopback authority must complete the native exchange");
  const cookie = cookiePair(exchange);

  const loopback = await request(boot, { path: "/api/probe", host: loopbackAuthority, headers: { cookie } });
  assertAdmitted(loopback.status, "native cookie on the loopback authority");

  const reused = await request(boot, { path: "/api/probe", host: PUBLIC_HOST, headers: { cookie } });
  assert.equal(reused.status, 401, "a loopback-bound cookie must not authenticate the trusted authority");
});

test("index admission keeps the native token contract ahead of the Orbit proof", async (t) => {
  const boot = live(t);
  if (!boot) return;

  // A tokenless Orbit proof serves the application shell.
  const shell = await request(boot, { path: "/", headers: proofHeaders() });
  assert.equal(shell.status, 200, "a tokenless Orbit proof must serve the index");

  // An invalid native token must still be rejected even with a valid proof.
  const invalid = await request(boot, { path: "/?token=invalid", headers: proofHeaders() });
  assert.equal(invalid.status, 401, "an invalid native token must not be masked by the Orbit proof");

  // No credentials: unchanged 401.
  const anonymous = await request(boot, { path: "/", headers: { host: PUBLIC_HOST } });
  assert.equal(anonymous.status, 401, "an unauthenticated index request must be rejected");
});

// ---------------------------------------------------------------------------
// 3. Trust fence, BrowserAuth, and proof precedence on real HTTP
// ---------------------------------------------------------------------------

test("real HTTP admission matrix distinguishes fence, BrowserAuth, and proof", async (t) => {
  const boot = live(t);
  if (!boot) return;

  const cases = [
    { label: "no credentials", headers: { host: PUBLIC_HOST }, expected: 401 },
    { label: "untrusted host with a valid proof", headers: proofHeaders({ host: UNTRUSTED_HOST }), expected: 403 },
    { label: "valid proof", headers: proofHeaders(), expected: null },
    { label: "wrong secret", headers: proofHeaders({ "x-dsh-orbit-authenticated-proxy": "wrong-secret-value" }), expected: 401 },
    { label: "missing secret", headers: proofHeaders({ "x-dsh-orbit-authenticated-proxy": undefined }), expected: 401 },
    { label: "missing forwarded proto", headers: proofHeaders({ "x-forwarded-proto": undefined }), expected: 401 },
    { label: "insecure forwarded proto", headers: proofHeaders({ "x-forwarded-proto": "http" }), expected: 401 },
    { label: "cross-site fetch metadata", headers: proofHeaders({ "sec-fetch-site": "cross-site" }), expected: 403 },
    { label: "foreign origin", headers: proofHeaders({ origin: `https://${UNTRUSTED_HOST}` }), expected: 403 },
    // A trusted Host with a same-origin-rule violation is still a fence rejection.
    {
      label: "trusted host with a mismatched origin",
      headers: proofHeaders({ host: OTHER_HOST }),
      expected: 403,
    },
    // Same authority rules satisfied, but the proof itself only authorizes the
    // configured public host, so BrowserAuth decides and rejects.
    {
      label: "proof for another trusted authority",
      headers: proofHeaders({ host: OTHER_HOST, origin: `https://${OTHER_HOST}` }),
      expected: 401,
    },
  ];

  for (const { label, headers, expected } of cases) {
    const clean = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    const response = await request(boot, { path: "/api/probe", headers: clean });
    if (expected === null) assertAdmitted(response.status, label);
    else assert.equal(response.status, expected, `${label}: unexpected status ${response.status}`);
  }
});

// ---------------------------------------------------------------------------
// 4. /api/remote.mux on the real process
// ---------------------------------------------------------------------------

test("real /api/remote.mux upgrades only for an admitted request", async (t) => {
  const boot = live(t);
  if (!boot) return;

  const anonymous = await upgradeWebSocket({ port: boot.port, headers: { host: PUBLIC_HOST } });
  assert.equal(anonymous.response.status, 401, "an unauthenticated upgrade must be rejected");

  const untrusted = await upgradeWebSocket({ port: boot.port, headers: proofHeaders({ host: UNTRUSTED_HOST }) });
  assert.equal(untrusted.response.status, 403, "an untrusted authority must be rejected by the fence");

  const trusted = await upgradeWebSocket({ port: boot.port, headers: proofHeaders() });
  assert.equal(trusted.response.status, 101, "a valid proof must upgrade");
  assert.equal(trusted.validAccept, true, "the upgrade must carry a correct Sec-WebSocket-Accept");

  // Physical transport check on the live process.
  trusted.sendPing("orbit-stage9-ping");
  let pong = null;
  for (let i = 0; i < 5 && pong === null; i += 1) {
    const frame = await trusted.nextFrame();
    if (frame.opcode === 0xa) pong = frame.payload.toString("utf8");
  }
  assert.equal(pong, "orbit-stage9-ping", "the live process must answer a Ping with a matching Pong");
  trusted.destroy();
});

test("real /api/remote.mux carries the $events handshake to value.type ready", async (t) => {
  const boot = live(t);
  if (!boot) return;

  const socket = await upgradeWebSocket({ port: boot.port, headers: proofHeaders() });
  assert.equal(socket.response.status, 101, "the authenticated mux upgrade must succeed");

  const streamId = "orbit-stage9-events";
  socket.sendText(JSON.stringify({ type: "open", streamId, endpoint: "$events", payload: { args: {} } }));

  let ready = null;
  for (let i = 0; i < 8 && ready === null; i += 1) {
    const message = await socket.nextJson();
    if (message.type !== "item" || message.streamId !== streamId) continue;
    ready = message;
  }

  assert.ok(ready, "the mux must deliver an item for the opened $events stream");
  assert.equal(ready.streamId, streamId, "the response must carry the same streamId");
  assert.equal(ready.value?.type, "ready", "the first $events item must be the ready frame");
  assert.equal(typeof ready.value.clientId, "string", "the ready frame must bind a clientId");
  assert.ok(ready.value.clientId.length > 0, "the clientId must not be empty");
  assert.equal(typeof ready.value.host?.home, "string", "the ready frame must publish the Host home");
  assert.ok(ready.value.host.home.length > 0, "the Host home must not be empty");

  // Cancel and close cleanly so the live process releases the stream.
  socket.sendText(JSON.stringify({ type: "cancel", streamId }));
  socket.destroy();
});
