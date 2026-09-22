import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeClient } from "../src/node/client.mjs";
import { generateNodeKeyPair } from "../src/registry/crypto.mjs";
import { loadNodeStoreAsync, writeNodeStore } from "../src/node/store.mjs";

function enrolledStore(routeMode = null) {
  const keys = generateNodeKeyPair();
  return {
    schema: 1,
    nodeId: `node_${"ab".repeat(16)}`,
    publicKeyHex: keys.publicKeyHex,
    privateKeyHex: keys.privateKeyHex,
    hubBaseUrl: "http://127.0.0.1:5445/",
    hubRouteKeys: null,
    state: "active",
    rotation: null,
    pendingEnrollment: null,
    pendingPairing: null,
    pendingReenrollment: null,
    routeMode,
    updatedAt: "2026-09-22T00:00:00.000Z",
  };
}

async function fixture(t, routeMode = null) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-stage6-route-mode-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "state.json");
  const store = enrolledStore(routeMode);
  await writeNodeStore(statePath, store);
  return { statePath, store };
}

function clientFor({ statePath, store, responseBody }) {
  return new NodeClient({
    store: { ...store },
    storePath: statePath,
    hubBaseUrl: "http://127.0.0.1:5445/",
    runtimeIdentity: () => ({ orbitVersion: "0.3.0", orbitRevision: "stage6", dshVersion: "0.1.1-rc.2", compatibilityProfile: "dsh-0.1.1-rc.2" }),
    heartbeatCadenceSeconds: 60,
    fetchImpl: async () => ({ status: 200, json: async () => responseBody }),
  });
}

test("authenticated heartbeat persists explicit Hub routeMode without rebinding the Hub", async (t) => {
  const { statePath, store } = await fixture(t, null);
  const client = clientFor({
    statePath,
    store,
    responseBody: { ok: true, registryContact: "fresh", routeMode: "reverse" },
  });
  const outcome = await client.heartbeat();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.routeMode, "reverse");
  assert.equal(client.store.routeMode, "reverse");
  assert.equal(client.store.hubBaseUrl, store.hubBaseUrl);
  assert.equal((await loadNodeStoreAsync(statePath)).routeMode, "reverse");
  assert.equal((await loadNodeStoreAsync(statePath)).hubBaseUrl, store.hubBaseUrl);
  assert.equal(client.recentEvents.at(-1).event, "route-mode-updated");
});

test("authenticated heartbeat applies reverse-to-direct explicitly and never falls back on failure", async (t) => {
  const { statePath, store } = await fixture(t, "reverse");
  const client = clientFor({
    statePath,
    store,
    responseBody: { ok: true, registryContact: "fresh", routeMode: "direct" },
  });
  const outcome = await client.heartbeat();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.routeMode, "direct");
  assert.equal(client.store.routeMode, "direct");

  const failed = new NodeClient({
    store: { ...client.store },
    storePath: statePath,
    hubBaseUrl: store.hubBaseUrl,
    runtimeIdentity: client.runtimeIdentity,
    heartbeatCadenceSeconds: 60,
    fetchImpl: async () => ({ status: 503, json: async () => ({ error: { code: "hub-unavailable", message: "offline" } }) }),
  });
  const failure = await failed.heartbeat();
  assert.equal(failure.ok, false);
  assert.equal(failure.state, "retrying");
  assert.equal(failed.store.routeMode, "direct");
  assert.equal((await loadNodeStoreAsync(statePath)).routeMode, "direct");
});

test("invalid routeMode from an otherwise successful response fails closed and is not persisted", async (t) => {
  const { statePath, store } = await fixture(t, "direct");
  const client = clientFor({
    statePath,
    store,
    responseBody: { ok: true, registryContact: "fresh", routeMode: "auto" },
  });
  const outcome = await client.heartbeat();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.state, "retrying");
  assert.equal(outcome.error.code, "invalid-route-mode");
  assert.equal(client.store.routeMode, "direct");
  assert.equal((await loadNodeStoreAsync(statePath)).routeMode, "direct");
});
