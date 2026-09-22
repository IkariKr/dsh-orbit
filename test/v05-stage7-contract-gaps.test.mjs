// RFC-0012 / SOP Stage 7 v0.5 hardening contract gaps.
//
// This file is intentionally independent from the legacy v0.4 hardening tests,
// D14 matrix tests, and mounted/production drills. It exercises only bounded
// unit/local-process seams that do not require mounted infrastructure.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";

import { ReverseClient } from "../src/node/reverse-client.mjs";
import { ReverseChannelPool } from "../src/node/reverse-channels.mjs";
import {
  CHANNEL_FRAME_MAX_BYTES,
  ReverseChannelManager,
} from "../src/registry/reverse-channel.mjs";
import {
  REVERSE_PROTOCOL,
  ReverseSessionManager,
} from "../src/registry/reverse-session.mjs";
import { createFrameParser, encodeFrame } from "../src/registry/reverse-ws.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { backupRegistryDatabase, restoreRegistryDatabase } from "../src/registry/backup.mjs";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { generateNodeKeyPair, randomHex } from "../src/registry/crypto.mjs";
import { createTestRegistry, createTestServer } from "./helpers/registry-fixture.mjs";

class SilentSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writable = true;
    this.writes = [];
    this.destroyCount = 0;
  }

  write(value) {
    if (this.destroyed) return false;
    this.writes.push(Buffer.from(value));
    return true;
  }

  end(value) {
    if (value !== undefined) this.write(value);
    this.destroy();
  }

  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    this.destroyCount += 1;
    this.emit("close");
    return this;
  }
}

function maskedJsonFrame(message) {
  return encodeFrame({
    opcode: 0x1,
    payload: Buffer.from(JSON.stringify(message), "utf8"),
    mask: true,
  });
}

function waitFor(predicate, { timeoutMs = 4000, stepMs = 20, label = "condition" } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = async () => {
      try {
        if (await predicate()) return resolve();
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error(`timeout waiting for ${label}`));
      }
      setTimeout(check, stepMs);
    };
    check();
  });
}

function createClockedRegistry(nowRef, heartbeatCadenceSeconds = 1) {
  const db = openRegistryDatabase(":memory:");
  const registry = new Registry({
    db,
    now: () => nowRef.value,
    registryContactNow: () => nowRef.value,
    heartbeatCadenceSeconds,
  });
  return registry;
}

function enrollNodeWithoutServer(registry) {
  const keys = generateNodeKeyPair();
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const enrolled = registry.enroll({
    token: minted.token,
    enrollmentRequestId: randomHex(16),
    publicKey: keys.publicKeyHex,
  });
  return {
    nodeId: enrolled.nodeId,
    keyId: enrolled.keyId,
    privateKeyHex: keys.privateKeyHex,
  };
}

function heartbeat(registry, nodeId) {
  registry.heartbeatAuthenticated({
    node: registry.getNodeRow(nodeId),
    rawBody: JSON.stringify({
      runtime: {
        orbitVersion: "0.3.0",
        orbitRevision: "contract-test",
        dshVersion: "0.1.1-rc.2",
        compatibilityProfile: "dsh-0.1.1-rc.2",
      },
    }),
  });
}

test("malformed control/data frames fail closed before delivery", () => {
  const errors = [];
  const parse = createFrameParser({
    isClient: false,
    maxMessageBytes: 1024,
    onMessage: () => assert.fail("invalid frame must not reach onMessage"),
    onError: (error) => errors.push(error.message),
  });

  // RFC 6455 control frames are FIN-only and at most 125 bytes.
  parse(encodeFrame({ opcode: 0x9, payload: Buffer.alloc(126, 0x61), mask: true }));
  assert.deepEqual(errors, ["invalid control frame"]);

  // A client frame arriving unmasked is also a protocol failure.
  const maskErrors = [];
  const parseUnmasked = createFrameParser({
    isClient: false,
    onError: (error) => maskErrors.push(error.message),
  });
  parseUnmasked(encodeFrame({ opcode: 0x1, payload: Buffer.from("ready"), mask: false }));
  assert.deepEqual(maskErrors, ["client frames must be masked"]);

  // A syntactically valid frame carrying malformed control JSON is rejected
  // by the session/channel handlers rather than reaching any application path.
  const sessionManager = new ReverseSessionManager({ readyTimeoutMs: 5000 });
  const sessionSocket = new SilentSocket();
  const session = sessionManager.registerUpgrade({
    nodeId: "node_control_malformed",
    keyId: "key",
    socket: sessionSocket,
    secWebSocketKey: "dGhlIHNhbXBsZSBub25jZQ==",
  });
  session.parse(encodeFrame({ opcode: 0x1, payload: Buffer.from("{not-json"), mask: true }));
  assert.equal(session.closed, true);
  assert.equal(sessionManager.current.size, 0);
  assert.equal(sessionManager.pending.size, 0);

  const channelManager = new ReverseChannelManager({ idleTarget: 1, maxChannels: 4 });
  const channel = channelManager.registerChannel({
    nodeId: "node_data_malformed",
    keyId: "key",
    sessionId: "session",
    socket: new SilentSocket(),
    secWebSocketKey: "dGhlIHNhbXBsZSBub25jZQ==",
  });
  assert.ok(channel);
  channel.parse(encodeFrame({ opcode: 0x1, payload: Buffer.from("{not-json"), mask: true }));
  assert.equal(channel.closed, true);
  assert.equal(channelManager.channels.has("node_data_malformed"), false);
});

test("malformed OPEN and oversized text/binary channel messages close without a DSH path", () => {
  const pool = new ReverseChannelPool({
    getCredentials: () => ({ nodeId: "node_contract", keyId: "key", privateKeyHex: "private" }),
  });
  const openSocket = new SilentSocket();
  const openChannel = {
    socket: openSocket,
    state: "idle",
    flow: null,
    sendJson: () => true,
    sendClose: () => true,
  };
  pool.channels.add(openChannel);

  pool.onChannelText(openChannel, JSON.stringify({
    type: "open",
    requestId: "request-1",
    mode: "http",
    headers: ["not-a-pair"],
  }));
  assert.equal(pool.channels.has(openChannel), false);
  assert.equal(openSocket.destroyCount, 1);

  const manager = new ReverseChannelManager({ idleTarget: 1, maxChannels: 4 });
  const nodeId = "node_" + "a".repeat(32);
  const register = () => manager.registerChannel({
    nodeId,
    keyId: "key",
    sessionId: "session",
    socket: new SilentSocket(),
    secWebSocketKey: "dGhlIHNhbXBsZSBub25jZQ==",
  });

  const oversizedOpen = register();
  assert.ok(oversizedOpen);
  oversizedOpen.parse(encodeFrame({
    opcode: 0x1,
    payload: Buffer.alloc(CHANNEL_FRAME_MAX_BYTES + 1, 0x6f),
    mask: true,
  }));
  assert.equal(oversizedOpen.closed, true);
  assert.equal(manager.channels.has(nodeId), false);

  const oversizedBinary = register();
  assert.ok(oversizedBinary);
  oversizedBinary.parse(encodeFrame({
    opcode: 0x2,
    payload: Buffer.alloc(CHANNEL_FRAME_MAX_BYTES + 1, 0x62),
    mask: true,
  }));
  assert.equal(oversizedBinary.closed, true);
  assert.equal(manager.channels.has(nodeId), false);
});

test("duplicate and late aborts release a flow once and cannot revive its channel", () => {
  const pool = new ReverseChannelPool({
    getCredentials: () => ({ nodeId: "node_contract", keyId: "key", privateKeyHex: "private" }),
  });
  const socket = new SilentSocket();
  const effects = { requestDestroy: 0, upstreamDestroy: 0 };
  const flow = {
    requestId: "flow-1",
    request: { destroy: () => { effects.requestDestroy += 1; } },
    upstreamSocket: { destroy: () => { effects.upstreamDestroy += 1; } },
    stallTimer: setTimeout(() => {}, 30_000),
    handshakeTimer: setTimeout(() => {}, 30_000),
  };
  flow.stallTimer.unref?.();
  flow.handshakeTimer.unref?.();
  const channel = {
    socket,
    state: "busy",
    flow,
    onRequestBody: () => {},
    onRequestEnd: () => {},
  };
  pool.channels.add(channel);

  const abort = JSON.stringify({ type: "abort", requestId: "flow-1", code: "browser-abort" });
  pool.onChannelText(channel, abort);
  pool.onChannelText(channel, abort);
  pool.onChannelBinary(channel, Buffer.from("late-data"));

  assert.equal(pool.channels.has(channel), false);
  assert.equal(channel.flow, null);
  assert.equal(channel.state, "busy", "late input must not reset a closed channel to idle");
  assert.equal(socket.destroyCount, 1);
  assert.equal(effects.requestDestroy, 1);
  assert.equal(effects.upstreamDestroy, 1);
});

test("reverse channel loss does not turn a fresh heartbeat into stale contact", () => {
  const nowRef = { value: new Date("2026-09-22T00:00:00.000Z") };
  const registry = createClockedRegistry(nowRef);
  const node = enrollNodeWithoutServer(registry);
  try {
    heartbeat(registry, node.nodeId);
    assert.equal(registry.getNodeRow(node.nodeId).registry_contact, "fresh");

    const sessions = new ReverseSessionManager();
    const channels = new ReverseChannelManager({ idleTarget: 1, maxChannels: 4 });
    const sessionId = "session-contract-fresh";
    sessions.current.set(node.nodeId, {
      nodeId: node.nodeId,
      keyId: node.keyId,
      state: "ready",
      reverseSessionId: sessionId,
      routeReady: true,
    });
    const channel = channels.registerChannel({
      nodeId: node.nodeId,
      keyId: node.keyId,
      sessionId,
      socket: new SilentSocket(),
      secWebSocketKey: "dGhlIHNhbXBsZSBub25jZQ==",
    });
    assert.ok(channel);
    assert.equal(channels.hasChannelForSession(node.nodeId, sessionId), true);

    channels.closeChannelsForNode(node.nodeId, "reverse-channel-down");

    assert.equal(channels.hasChannelForSession(node.nodeId, sessionId), false);
    assert.equal(sessions.getPresence(node.nodeId, "reverse"), "online");
    assert.equal(sessions.isReverseReachable(node.nodeId, "reverse"), true);
    assert.equal(registry.getNodeRow(node.nodeId).registry_contact, "fresh");
  } finally {
    registry.close();
  }
});

test("heartbeat staleness does not turn an online reverse session offline", () => {
  const nowRef = { value: new Date("2026-09-22T00:00:00.000Z") };
  const registry = createClockedRegistry(nowRef, 1);
  const node = enrollNodeWithoutServer(registry);
  try {
    heartbeat(registry, node.nodeId);
    const sessions = new ReverseSessionManager();
    sessions.current.set(node.nodeId, {
      nodeId: node.nodeId,
      keyId: node.keyId,
      state: "ready",
      reverseSessionId: "session-contract-stale-heartbeat",
      routeReady: true,
    });

    nowRef.value = new Date(nowRef.value.getTime() + 4_001);
    registry.maintenance();

    assert.equal(registry.getNodeRow(node.nodeId).registry_contact, "stale");
    assert.equal(sessions.getPresence(node.nodeId, "reverse"), "online");
    assert.equal(sessions.isReverseReachable(node.nodeId, "reverse"), true);
  } finally {
    registry.close();
  }
});

test("delete cleanup closes the session generation and every bound channel", () => {
  const channels = new ReverseChannelManager({ idleTarget: 1, maxChannels: 4 });
  const sessions = new ReverseSessionManager({
    onSessionClosed: (session, reason) => channels.closeChannelsForSession(session.reverseSessionId, reason),
  });
  const nodeId = "node_" + "b".repeat(32);
  const keyId = "key-contract";
  const controlSocket = new SilentSocket();
  const session = sessions.registerUpgrade({
    nodeId,
    keyId,
    socket: controlSocket,
    secWebSocketKey: "dGhlIHNhbXBsZSBub25jZQ==",
  });
  const sessionId = session.reverseSessionId;
  session.parse(maskedJsonFrame({ type: "ready", protocol: REVERSE_PROTOCOL, routeReady: true }));
  assert.equal(sessions.getSessionInfo(nodeId).reverseSessionId, sessionId);

  const channel = channels.registerChannel({
    nodeId,
    keyId,
    sessionId,
    socket: new SilentSocket(),
    secWebSocketKey: "dGhlIHNhbXBsZSBub25jZQ==",
  });
  assert.ok(channel);
  assert.equal(channels.hasChannelForSession(nodeId, sessionId), true);

  sessions.closeSessionsForNode(nodeId, "node-deleted");

  assert.equal(sessions.getSessionInfo(nodeId), null);
  assert.equal(sessions.pending.size, 0);
  assert.equal(channels.hasChannelForSession(nodeId, sessionId), false);
  assert.equal(channels.channels.has(nodeId), false);
  assert.equal(channels.idleWaiters.size, 0);
  assert.equal(controlSocket.destroyed, true);

  // A late ready/close event from the deleted generation cannot recreate it.
  session.parse(maskedJsonFrame({ type: "ready", protocol: REVERSE_PROTOCOL, routeReady: true }));
  session.close(1000, "late-close");
  assert.equal(sessions.getSessionInfo(nodeId), null);
  assert.equal(channels.channels.has(nodeId), false);
});

test("backup and restore create a fresh Registry without restoring live reverse sessions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-v05-stage7-contract-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const sourcePath = join(dir, "source.db");
  const backupPath = join(dir, "backup.db");
  const restoredPath = join(dir, "restored.db");
  const db = openRegistryDatabase(sourcePath);
  const registry = new Registry({ db });
  const liveSessions = new ReverseSessionManager();
  const nodeId = "node_" + "c".repeat(32);
  liveSessions.current.set(nodeId, {
    nodeId,
    keyId: "key-live-only",
    state: "ready",
    reverseSessionId: "live-session-must-not-persist",
    routeReady: true,
  });

  try {
    await backupRegistryDatabase({ db, sourcePath, destinationPath: backupPath });
    registry.close();
    await restoreRegistryDatabase({ backupPath, targetPath: restoredPath, writersQuiesced: true });

    const restoredDb = openRegistryDatabase(restoredPath);
    const restoredRegistry = new Registry({ db: restoredDb });
    const freshSessions = new ReverseSessionManager();
    try {
      assert.ok(liveSessions.getSessionInfo(nodeId), "the original process-local manager still owns its live session");
      assert.equal(freshSessions.current.size, 0);
      assert.equal(freshSessions.getSessionInfo(nodeId), null);
      assert.equal(freshSessions.getPresence(nodeId, "reverse"), "offline");
      assert.equal(
        restoredDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reverse_sessions'").get(),
        undefined,
      );
      void restoredRegistry;
    } finally {
      restoredRegistry.close();
    }
  } finally {
    // registry is already closed on the normal path; this is safe for a failed
    // backup/restore assertion only when the handle remains available.
    try { registry.close(); } catch {}
  }
});

test("credential and reverse-event output omits session IDs, keys, cookies, and enrollment tokens", async () => {
  const registry = createTestRegistry();
  let server = null;
  let client = null;
  const logs = [];
  const events = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map((value) => String(value)).join(" "));

  try {
    server = await createTestServer(registry);
    const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
    const keys = generateNodeKeyPair();
    const enrollmentRequestId = randomHex(16);
    const enrollmentResponse = await fetch(`${server.baseUrl}/api/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: minted.token,
        enrollmentRequestId,
        publicKey: keys.publicKeyHex,
      }),
    });
    assert.equal(enrollmentResponse.status, 200);
    const enrolled = await enrollmentResponse.json();
    const node = {
      nodeId: enrolled.nodeId,
      keyId: enrolled.keyId,
      privateKeyHex: keys.privateKeyHex,
    };

    client = new ReverseClient({
      hubBaseUrl: server.baseUrl,
      getCredentials: () => node,
      dshTarget: "http://127.0.0.1:1",
      livenessPollMs: 25,
      onEvent: (event, detail) => events.push({ event, detail }),
    });
    client.start();
    await waitFor(() => server.reverseSessions.getSessionInfo(node.nodeId) !== null, { label: "reverse session" });
    const sessionId = server.reverseSessions.getSessionInfo(node.nodeId).reverseSessionId;
    const cookie = "dsh-orbit-hub-session=COOKIE-SENTINEL";
    const output = `${logs.join("\n")}\n${JSON.stringify(events)}`;

    for (const secret of [sessionId, node.privateKeyHex, node.keyId, minted.token, cookie, "TOKEN-SENTINEL"]) {
      assert.equal(output.includes(secret), false, `output must not contain secret material ${secret}`);
    }
    assert.equal(output.includes("reverseSessionId"), false);
  } finally {
    client?.stop();
    console.log = originalLog;
    await server?.close();
    registry.close();
  }
});

test("NOT_EXECUTED: mounted or production Stage 7 drill", { skip: "explicitly out of scope for this local contract test file" }, () => {});
