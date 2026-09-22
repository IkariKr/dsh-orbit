// Stage 6 lifecycle coverage added without changing product/UI code.
//
// This file intentionally focuses on the newly authorized operator lifecycle:
// authenticated management deletion, reverse-session cleanup/bookmark fail-closed,
// and a NodeClient credential rotation followed by a reverse reconnect using the
// current key. Same-node reenrollment/fresh Hub route identity is already covered
// by test/registry-reenroll.test.mjs and is not duplicated here.

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeClient } from "../src/node/client.mjs";
import { ReverseClient } from "../src/node/reverse-client.mjs";
import { loadNodeStoreAsync } from "../src/node/store.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";
import { createTestRegistry, createTestServer, defaultRuntimeIdentity, enrollNode } from "./helpers/registry-fixture.mjs";

const ASSERTION = "gateway-held-assertion-secret";
const GATEWAY_HEADER = "x-dsh-authenticated-proxy";
const PRINCIPAL_HEADER = "x-dsh-operator-id";
const SESSION_COOKIE = "dsh-orbit-hub-session";
const CSRF_HEADER = "x-csrf-token";
const ROUTE_DOMAIN = "stage6-lifecycle.example";

function gatewayHeaders(extra = {}) {
  return { [GATEWAY_HEADER]: ASSERTION, [PRINCIPAL_HEADER]: "operator", ...extra };
}

async function establishSession(baseUrl) {
  const response = await fetch(baseUrl + "/hub/session", {
    method: "POST",
    headers: gatewayHeaders(),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const cookie = response.headers.get("set-cookie")?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
  assert.ok(cookie);
  return { cookie, csrfToken: body.csrfToken };
}

function waitFor(predicate, { timeoutMs = 5000, stepMs = 20, label = "condition" } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = async () => {
      try {
        if (await predicate()) return resolve();
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started >= timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(check, stepMs);
    };
    check();
  });
}

function requestWithHost({ baseUrl, host, path = "/", headers = {} }) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: "GET",
        headers: { host, ...headers },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function runtimeIdentity() {
  return defaultRuntimeIdentity().runtime;
}

function makeNodeClient({ statePath, baseUrl }) {
  return new NodeClient({
    store: {
      schema: 1,
      nodeId: null,
      publicKeyHex: null,
      privateKeyHex: null,
      hubBaseUrl: null,
      state: "unenrolled",
      rotation: null,
      pendingEnrollment: null,
      pendingReenrollment: null,
      updatedAt: null,
    },
    storePath: statePath,
    hubBaseUrl: baseUrl,
    runtimeIdentity,
  });
}

test("authenticated management delete closes the active reverse session and makes the bookmark fail closed", async (t) => {
  const registry = createTestRegistry({ routeDomain: ROUTE_DOMAIN });
  const server = await createTestServer(registry, {
    gatewayAssertionSecret: ASSERTION,
    operatorPrincipal: { mode: "inject" },
  });
  const node = await enrollNode(server.baseUrl, registry);
  const reverse = new ReverseClient({
    hubBaseUrl: server.baseUrl,
    getCredentials: () => ({ nodeId: node.nodeId, keyId: node.keyId, privateKeyHex: node.privateKeyHex }),
    // A refused local DSH probe still establishes the authenticated control
    // session; this test is about delete cleanup and route fail-closed behavior.
    dshTarget: "http://127.0.0.1:1",
    livenessPollMs: 50,
  });

  t.after(async () => {
    reverse.stop();
    await server.close();
    registry.close();
  });

  registry.setRouteMode({ actor: "operator", nodeId: node.nodeId, routeMode: "reverse" });
  reverse.start();
  await waitFor(
    () => server.reverseSessions.getSessionInfo(node.nodeId)?.keyId === node.keyId,
    { label: "active reverse control session" },
  );
  const beforeDelete = server.reverseSessions.getSessionInfo(node.nodeId);
  assert.ok(beforeDelete?.reverseSessionId);
  assert.equal(server.reverseSessions.getPresence(node.nodeId, "reverse"), "online");

  const session = await establishSession(server.baseUrl);
  const deleted = await fetch(`${server.baseUrl}/hub/nodes/${node.nodeId}/delete`, {
    method: "POST",
    headers: {
      ...gatewayHeaders(),
      cookie: `${SESSION_COOKIE}=${session.cookie}`,
      [CSRF_HEADER]: session.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requestId: "ab".repeat(16), reason: "stage6-lifecycle-delete" }),
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), {
    nodeId: node.nodeId,
    state: "tombstoned",
    idempotentReplay: false,
  });

  // The authenticated management lifecycle hook closes live reverse state;
  // stop the client after the delete so its reconnect timer cannot obscure the
  // server-side cleanup assertion.
  reverse.stop();
  await waitFor(() => server.reverseSessions.getSessionInfo(node.nodeId) === null, { label: "reverse session cleanup after delete" });
  assert.equal(server.reverseSessions.getPresence(node.nodeId, "reverse"), "offline");

  const detail = await fetch(`${server.baseUrl}/hub/nodes/${node.nodeId}`, {
    headers: { ...gatewayHeaders(), cookie: `${SESSION_COOKIE}=${session.cookie}` },
  });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.equal(detailBody.state, "tombstoned");
  assert.equal(detailBody.routeMode, "reverse");
  assert.equal(detailBody.reversePresence, "offline");
  assert.equal(detailBody.reverseReason, "reverse-session-offline");

  // The deterministic bookmark authority remains the same, but a tombstoned
  // node cannot route or fall back to any stored alternate transport.
  const routeAuthority = computeRouteAuthority(node.nodeId, ROUTE_DOMAIN);
  const bookmark = await requestWithHost({
    baseUrl: server.baseUrl,
    host: routeAuthority,
    headers: { accept: "application/json" },
  });
  assert.equal(bookmark.status, 503);
  const bookmarkBody = JSON.parse(bookmark.body.toString("utf8"));
  assert.equal(bookmarkBody.error.code, "node-unavailable");
  assert.equal(bookmarkBody.error.selectorUrl, `http://${ROUTE_DOMAIN}/`);
});

test("NodeClient credential rotation persists the new key and reverse reconnect uses it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-stage6-lifecycle-"));
  const statePath = join(dir, "state.json");
  const registry = createTestRegistry();
  const server = await createTestServer(registry);
  const client = makeNodeClient({ statePath, baseUrl: server.baseUrl });
  let reverse = null;

  t.after(async () => {
    reverse?.stop();
    await server.close();
    registry.close();
    await rm(dir, { recursive: true, force: true });
  });

  const enrollment = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const enrolled = await client.enroll({ token: enrollment.token });
  const oldKeyId = client.status().keyId;
  assert.equal(oldKeyId, enrolled.keyId);

  reverse = new ReverseClient({
    hubBaseUrl: server.baseUrl,
    getCredentials: () => ({
      nodeId: client.store.nodeId,
      keyId: client.status().keyId,
      privateKeyHex: client.store.privateKeyHex,
    }),
    dshTarget: "http://127.0.0.1:1",
    livenessPollMs: 50,
  });
  reverse.start();
  await waitFor(
    () => server.reverseSessions.getSessionInfo(client.store.nodeId)?.keyId === oldKeyId,
    { label: "old-key reverse control session" },
  );
  const oldSessionId = server.reverseSessions.getSessionInfo(client.store.nodeId).reverseSessionId;

  const rotated = await client.rotateCredential();
  assert.equal(rotated.oldKeyId, oldKeyId);
  assert.equal(client.status().keyId, rotated.newKeyId);
  const persisted = await loadNodeStoreAsync(statePath);
  assert.equal(persisted.rotation.newKeyId, rotated.newKeyId);
  assert.equal(persisted.publicKeyHex, client.store.publicKeyHex);

  // ReverseClient reads credentials through the live callback. A clean stop /
  // start models the reconnect seam and must authenticate the new generation
  // with the NodeClient's current key, not the expired session's key.
  reverse.stop();
  await waitFor(() => server.reverseSessions.getSessionInfo(client.store.nodeId) === null, { label: "old reverse session close" });
  reverse.start();
  await waitFor(
    () => server.reverseSessions.getSessionInfo(client.store.nodeId)?.keyId === rotated.newKeyId,
    { label: "new-key reverse reconnect" },
  );
  const reconnected = server.reverseSessions.getSessionInfo(client.store.nodeId);
  assert.notEqual(reconnected.reverseSessionId, oldSessionId);
  assert.equal(reconnected.keyId, rotated.newKeyId);
  assert.equal((await client.heartbeat()).ok, true);
});
