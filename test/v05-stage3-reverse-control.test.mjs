// v0.5 Stage 3: reverse control session, presence, and reconnect
// (docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md Stage 3;
// RFC-0012 D4/D8). The authenticated Node→Hub reverse presence channel
// carries no browser payload: only session/ready/status/ping-pong/close.

import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { randomHex, sha256Hex, signSigningString, generateNodeKeyPair } from "../src/registry/crypto.mjs";
import { buildSigningString, MACHINE_V1_LABEL } from "../src/registry/protocol.mjs";
import { createFrameParser, encodeFrame } from "../src/registry/reverse-ws.mjs";
import { ReverseSessionManager } from "../src/registry/reverse-session.mjs";
import { ReverseClient, probeDshTransport } from "../src/node/reverse-client.mjs";
import { createTestRegistry, createTestServer } from "./helpers/registry-fixture.mjs";

function pairRegistry(options = {}) {
  return createTestRegistry(options);
}

async function startMockDsh() {
  const server = http.createServer((request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "unauthorized" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    target: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

function enrollReverseNode(registry) {
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const keys = generateNodeKeyPair();
  const result = registry.enroll({ token: minted.token, enrollmentRequestId: randomHex(16), publicKey: keys.publicKeyHex });
  registry.db.prepare("UPDATE nodes SET route_mode = 'reverse' WHERE node_id = ?").run(result.nodeId);
  return {
    nodeId: result.nodeId,
    keyId: result.keyId,
    publicKeyHex: keys.publicKeyHex,
    privateKeyHex: keys.privateKeyHex,
  };
}

function makeReverseClient(baseUrl, node, { dshTarget, onEvent, livenessPollMs = 100 } = {}) {
  return new ReverseClient({
    hubBaseUrl: baseUrl,
    getCredentials: () => ({ nodeId: node.nodeId, keyId: node.keyId, privateKeyHex: node.privateKeyHex }),
    dshTarget: dshTarget ?? "http://127.0.0.1:1",
    livenessPollMs,
    onEvent: onEvent ?? (() => {}),
  });
}

// Raw control-upgrade probe for protocol-abuse paths: performs the
// WebSocket handshake with machine-auth headers and exposes frames.
function controlUpgradeProbe(baseUrl, { nodeId, keyId, privateKeyHex, nonce, timestamp, path = "/api/v1/reverse/control" }) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const socket = net.connect(Number(url.port), url.hostname, () => {
      const ts = String(timestamp ?? Math.trunc(Date.now() / 1000));
      const freshNonce = nonce ?? randomHex(16);
      const machineHeaders = nodeId
        ? [
            `x-orbit-node: ${nodeId}`,
            `x-orbit-key: ${keyId}`,
            `x-orbit-timestamp: ${ts}`,
            `x-orbit-nonce: ${freshNonce}`,
            `x-orbit-signature: ${signSigningString(privateKeyHex, buildSigningString({ label: MACHINE_V1_LABEL, method: "GET", path, timestamp: ts, nonce: freshNonce, bodyHash: sha256Hex(""), nodeId }))}`,
          ]
        : [];
      socket.write(
        [`GET ${path} HTTP/1.1`, `host: ${url.host}`, "connection: Upgrade", "upgrade: websocket", "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version: 13", ...machineHeaders, "", ""].join("\r\n"),
      );
    });
    let head = "";
    let parser = null;
    let bodyText = "";
    const messages = [];
    const waiters = [];
    const waitForMessage = (timeoutMs = 2000) =>
      new Promise((res, rej) => {
        if (messages.length > 0) return res(messages.shift());
        const timer = setTimeout(() => rej(new Error("timeout waiting for frame")), timeoutMs);
        waiters.push((text) => {
          clearTimeout(timer);
          res(text);
        });
      });
    const sendText = (message) => socket.write(encodeFrame({ opcode: 0x1, payload: Buffer.from(JSON.stringify(message), "utf8"), mask: true }));
    socket.on("data", (chunk) => {
      if (!parser) {
        head += chunk.toString("latin1");
        const boundary = head.indexOf("\r\n\r\n");
        if (boundary === -1) return;
        const statusLine = head.slice(0, head.indexOf("\r\n"));
        const status = Number(statusLine.split(" ")[1] ?? 0);
        if (status !== 101) {
          bodyText += head.slice(head.indexOf("\r\n\r\n") + 4);
          socket.on("data", (more) => {
            bodyText += more.toString("utf8");
          });
          socket.on("close", () => {
            let parsed = {};
            try {
              parsed = JSON.parse(bodyText);
            } catch {}
            resolve({ status, body: parsed, messages, waitForMessage, sendText, socket });
          });
          return;
        }
        parser = createFrameParser({
          isClient: true,
          onMessage: (text) => {
            const waiter = waiters.shift();
            if (waiter) waiter(text);
            else messages.push(text);
          },
        });
        resolve({ status, messages, waitForMessage, sendText, socket });
        const rest = chunk.subarray(chunk.indexOf(Buffer.from("\r\n\r\n")) + 4);
        if (rest.length > 0) parser(rest);
        return;
      }
      parser(chunk);
    });
    socket.on("error", reject);
  });
}

// Ordered cleanup: node clients first (they keep pollers and sockets),
// then servers. A still-running liveness poller would reopen connections
// behind server.close() and stall it forever.
async function cleanupReverse({ clients = [], dshServers = [], closeServer = null }) {
  for (const client of clients) {
    try {
      client?.stop();
    } catch {}
  }
  for (const dsh of dshServers) {
    await dsh?.close();
  }
  await closeServer?.();
}

function waitFor(predicate, { timeoutMs = 5000, stepMs = 25, label }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = async () => {
      try {
        if (await predicate()) return resolve();
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${label ?? "condition"}`));
      setTimeout(check, stepMs);
    };
    check();
  });
}

test("probeDshTransport treats any HTTP answer as ready and refusal as not ready", async () => {
  const dsh = await startMockDsh();
  assert.equal(await probeDshTransport(dsh.target), true);
  await dsh.close();
  assert.equal(await probeDshTransport("http://127.0.0.1:1"), false);
});

test("valid active node connects, answers ready, and becomes online", async (t) => {
  const registry = pairRegistry();
  const { baseUrl, reverseSessions, close } = await createTestServer(registry);
  t.after(() => close());
  const node = enrollReverseNode(registry);
  const dsh = await startMockDsh();

  const client = makeReverseClient(baseUrl, node, { dshTarget: dsh.target });
  client.start();
  await waitFor(() => reverseSessions.getSessionInfo(node.nodeId) !== null, { label: "ready session" });

  const info = reverseSessions.getSessionInfo(node.nodeId);
  assert.match(info.reverseSessionId, /^[0-9a-f]{32}$/);
  assert.equal(info.routeReady, true);
  assert.equal(reverseSessions.getPresence(node.nodeId, "reverse"), "online");
  assert.equal(reverseSessions.isReverseReachable(node.nodeId, "reverse"), true);
  await sleep(50);
  // One current ready generation: exactly one session for the node.
  assert.equal(reverseSessions.current.size, 1);
  await sleep(200);
  await cleanupReverse({ clients: [client], dshServers: [dsh], closeServer: close });
});

test("tombstoned node is denied the control upgrade", async (t) => {
  const registry = pairRegistry();
  const { baseUrl, reverseSessions, close } = await createTestServer(registry);
  t.after(() => close());
  const node = enrollReverseNode(registry);
  registry.deleteNode({ actor: "operator", nodeId: node.nodeId, requestId: randomHex(16), reason: "test" });

  const events = [];
  const client = makeReverseClient(baseUrl, node, { onEvent: (event) => events.push(event) });
  client.start();
  await waitFor(() => events.some((event) => event === "reverse-upgrade-denied"), { label: "denied event" });
  client.stop();
  assert.equal(reverseSessions.getSessionInfo(node.nodeId), null);
  assert.equal(reverseSessions.getPresence(node.nodeId, "reverse"), "offline");
  await sleep(150);
  await cleanupReverse({ closeServer: close });
});

test("a signature for node A cannot open a control session as node B; replays and skew are denied", async (t) => {
  const registry = pairRegistry();
  const { baseUrl, reverseSessions, close } = await createTestServer(registry);
  t.after(() => close());
  const nodeA = enrollReverseNode(registry);
  const nodeB = enrollReverseNode(registry);

  const asB = await controlUpgradeProbe(baseUrl, { nodeId: nodeB.nodeId, keyId: nodeB.keyId, privateKeyHex: nodeA.privateKeyHex });
  assert.equal(asB.status, 401);
  assert.equal(asB.body.error.code, "signature-invalid");
  assert.equal(reverseSessions.getSessionInfo(nodeB.nodeId), null);
  asB.socket.destroy();

  // Nonce replay: the second handshake with the same nonce is denied even
  // though the first established a pending session.
  const reusedNonce = randomHex(16);
  const first = await controlUpgradeProbe(baseUrl, { nodeId: nodeA.nodeId, keyId: nodeA.keyId, privateKeyHex: nodeA.privateKeyHex, nonce: reusedNonce });
  assert.equal(first.status, 101);
  const replay = await controlUpgradeProbe(baseUrl, { nodeId: nodeA.nodeId, keyId: nodeA.keyId, privateKeyHex: nodeA.privateKeyHex, nonce: reusedNonce });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, "replay");
  first.socket.destroy();

  const stale = await controlUpgradeProbe(baseUrl, {
    nodeId: nodeA.nodeId,
    keyId: nodeA.keyId,
    privateKeyHex: nodeA.privateKeyHex,
    timestamp: Math.trunc(Date.now() / 1000) - 120,
  });
  assert.equal(stale.status, 401);
  assert.equal(stale.body.error.code, "timestamp-out-of-skew");
  await sleep(150);
  await cleanupReverse({ closeServer: close });
});

test("invalid protocol on ready fails closed", async (t) => {
  const registry = pairRegistry();
  const { baseUrl, reverseSessions, close } = await createTestServer(registry);
  t.after(() => close());
  const node = enrollReverseNode(registry);

  const probe = await controlUpgradeProbe(baseUrl, { nodeId: node.nodeId, keyId: node.keyId, privateKeyHex: node.privateKeyHex });
  assert.equal(probe.status, 101);
  const sessionMessage = JSON.parse(await probe.waitForMessage());
  assert.equal(sessionMessage.type, "session");
  assert.equal(sessionMessage.protocol, "orbit-reverse-v1");
  probe.sendText({ type: "ready", protocol: "orbit-reverse-v2", routeReady: true });
  await sleep(100);
  assert.equal(reverseSessions.getSessionInfo(node.nodeId), null);
  assert.equal(probe.socket.destroyed || !probe.socket.writable, true);
  await sleep(100);
  await cleanupReverse({ closeServer: close });
});

test("unknown control types fail closed without executing anything", async (t) => {
  const registry = pairRegistry();
  const { baseUrl, reverseSessions, close } = await createTestServer(registry);
  t.after(() => close());
  const node = enrollReverseNode(registry);

  const probe = await controlUpgradeProbe(baseUrl, { nodeId: node.nodeId, keyId: node.keyId, privateKeyHex: node.privateKeyHex });
  assert.equal(probe.status, 101);
  await probe.waitForMessage(); // session
  probe.sendText({ type: "ready", protocol: "orbit-reverse-v1", routeReady: true });
  await waitFor(() => reverseSessions.getSessionInfo(node.nodeId) !== null, { label: "ready" });
  probe.sendText({ type: "exec", command: "rm -rf /", dshRpc: "sessions.kill" });
  await sleep(100);
  assert.equal(reverseSessions.getSessionInfo(node.nodeId), null, "the session must be closed, the message never executed");
  probe.socket.destroy();
  await sleep(100);
  await cleanupReverse({ closeServer: close });
});

test("only a ready newcomer takes over; unready connections cannot evict a healthy session", async (t) => {
  const registry = pairRegistry();
  const { baseUrl, reverseSessions, close } = await createTestServer(registry);
  t.after(() => close());
  const node = enrollReverseNode(registry);

  const first = await controlUpgradeProbe(baseUrl, { nodeId: node.nodeId, keyId: node.keyId, privateKeyHex: node.privateKeyHex });
  await first.waitForMessage();
  first.sendText({ type: "ready", protocol: "orbit-reverse-v1", routeReady: true });
  await waitFor(() => reverseSessions.getSessionInfo(node.nodeId) !== null, { label: "first ready" });
  const firstSessionId = reverseSessions.getSessionInfo(node.nodeId).reverseSessionId;

  // An unready newcomer connects but never sends ready.
  const newcomer = await controlUpgradeProbe(baseUrl, { nodeId: node.nodeId, keyId: node.keyId, privateKeyHex: node.privateKeyHex });
  await newcomer.waitForMessage(); // its session message
  await sleep(80);
  assert.equal(reverseSessions.getSessionInfo(node.nodeId).reverseSessionId, firstSessionId, "healthy session survives an unready newcomer");

  // A ready newcomer deterministically supersedes the old generation.
  const second = await controlUpgradeProbe(baseUrl, { nodeId: node.nodeId, keyId: node.keyId, privateKeyHex: node.privateKeyHex });
  await second.waitForMessage();
  second.sendText({ type: "ready", protocol: "orbit-reverse-v1", routeReady: true });
  await waitFor(() => reverseSessions.getSessionInfo(node.nodeId)?.reverseSessionId !== firstSessionId, { label: "takeover" });
  const secondSessionId = reverseSessions.getSessionInfo(node.nodeId).reverseSessionId;
  assert.notEqual(secondSessionId, firstSessionId);

  // A late disconnect from the superseded generation cannot clear the new session.
  first.socket.destroy();
  await waitFor(() => reverseSessions.getSessionInfo(node.nodeId)?.reverseSessionId === secondSessionId, { label: "second still current" });
  second.socket.destroy();
  await waitFor(() => reverseSessions.getSessionInfo(node.nodeId) === null, { label: "second cleared" });
  await cleanupReverse({ closeServer: close });
});

test("control loss makes reverse presence offline; reconnect restores online; node restart reuses the same identity", async (t) => {
  const registry = pairRegistry();
  const { baseUrl, reverseSessions, close } = await createTestServer(registry);
  t.after(() => close());
  const node = enrollReverseNode(registry);
  const dsh = await startMockDsh();

  const client = makeReverseClient(baseUrl, node, { dshTarget: dsh.target });
  client.start();
  await waitFor(() => reverseSessions.getPresence(node.nodeId, "reverse") === "online", { label: "online" });

  client.socket.destroy(); // control loss
  await waitFor(() => reverseSessions.getPresence(node.nodeId, "reverse") === "offline", { label: "offline" });

  client.backoffAttempt = 5; // even from deep backoff, reconnect recovers
  client.scheduleReconnect();
  await waitFor(() => reverseSessions.getPresence(node.nodeId, "reverse") === "online", { label: "reconnected online" });

  // Node restart: a fresh client process with the same node ID/key.
  client.stop();
  const restarted = makeReverseClient(baseUrl, node, { dshTarget: dsh.target });
  restarted.start();
  await waitFor(() => reverseSessions.getPresence(node.nodeId, "reverse") === "online", { label: "restarted online" });
  assert.equal(reverseSessions.getSessionInfo(node.nodeId).keyId, node.keyId);
  restarted.stop();
  await cleanupReverse({ dshServers: [dsh], closeServer: close });
});

test("local DSH readiness changes reachable and presence without touching registryContact", async (t) => {
  const registry = pairRegistry();
  const { baseUrl, reverseSessions, close } = await createTestServer(registry);
  t.after(() => close());
  const node = enrollReverseNode(registry);
  const dsh = await startMockDsh();

  const client = makeReverseClient(baseUrl, node, { dshTarget: dsh.target, livenessPollMs: 60 });
  client.start();
  await waitFor(() => reverseSessions.isReverseReachable(node.nodeId, "reverse") === true, { label: "reachable ok" });

  const rowBefore = registry.db.prepare("SELECT registry_contact, last_seen FROM nodes WHERE node_id = ?").get(node.nodeId);
  await dsh.close(); // local DSH transport loss
  await waitFor(() => reverseSessions.isReverseReachable(node.nodeId, "reverse") === false, { label: "reachable false" });
  assert.equal(reverseSessions.getSessionInfo(node.nodeId).routeReady, false);
  assert.equal(reverseSessions.getPresence(node.nodeId, "reverse"), "online", "presence tracks the control session, not DSH health");

  const rowAfter = registry.db.prepare("SELECT registry_contact, last_seen FROM nodes WHERE node_id = ?").get(node.nodeId);
  assert.deepEqual(rowAfter, rowBefore, "reverse reachability must never move registryContact");
  client.stop();
  await cleanupReverse({ closeServer: close });
});

test("direct-mode nodes: presence falls back to unknown and is never routable", () => {
  const manager = new ReverseSessionManager();
  assert.equal(manager.getPresence("node_" + "a".repeat(32), "direct"), "unknown");
  assert.equal(manager.getPresence("node_" + "a".repeat(32), "reverse"), "offline");
  assert.equal(manager.isReverseReachable("node_" + "a".repeat(32), "direct"), null);
});

test("hub restart leaves no phantom online state; pending connections time out", async (t) => {
  const registry = pairRegistry();
  const { baseUrl, close } = await createTestServer(registry);
  t.after(() => close());
  const node = enrollReverseNode(registry);

  const probe = await controlUpgradeProbe(baseUrl, { nodeId: node.nodeId, keyId: node.keyId, privateKeyHex: node.privateKeyHex });
  assert.equal(probe.status, 101);
  probe.socket.destroy();

  // A restarted Hub owns a fresh manager: no live sessions survive.
  const freshManager = new ReverseSessionManager();
  assert.equal(freshManager.getSessionInfo(node.nodeId), null);
  assert.equal(freshManager.getPresence(node.nodeId, "reverse"), "offline");

  // Pending connections that never reach ready are closed by the ready timeout.
  const pendingManager = new ReverseSessionManager({ readyTimeoutMs: 120 });
  const closeReasons = [];
  pendingManager.onSessionClosed = (session, reason) => closeReasons.push(reason);
  const silentServer = net.createServer(() => {});
  await new Promise((resolve) => silentServer.listen(0, "127.0.0.1", resolve));
  const pendingSocket = net.connect(silentServer.address().port, "127.0.0.1");
  await new Promise((resolve) => pendingSocket.on("connect", resolve));
  pendingManager.registerUpgrade({ nodeId: node.nodeId, keyId: node.keyId, socket: pendingSocket, secWebSocketKey: "dGhlIHNhbXBsZSBub25jZQ==" });
  await waitFor(() => closeReasons.includes("ready-timeout"), { label: "ready timeout" });
  pendingSocket.destroy();
  silentServer.close();
  await cleanupReverse({ closeServer: close });
});
