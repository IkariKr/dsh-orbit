// Review Gate A evidence: Hub commit + lost response + retry must
// never orphan the Node identity (P1-01 enrollment, P1-02 rotation,
// P1-03 re-enrollment). Each scenario performs the real request, lets
// the Hub commit, then destroys the response exactly once.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeClient } from "../src/node/client.mjs";
import { loadNodeStoreAsync } from "../src/node/store.mjs";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";

async function fixtureDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-node-loss-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function runtime() {
  return { orbitVersion: "0.3.0", orbitRevision: "abc123", dshVersion: "0.1.1-rc.2", compatibilityProfile: "dsh-0.1.1-rc.2" };
}

async function withHub(t) {
  const registry = new Registry({ db: openRegistryDatabase(":memory:") });
  const { server } = createHubServer({ registry, options: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    registry.close();
  });
  return { registry, baseUrl };
}

function makeClient({ statePath, baseUrl, fetchImpl }) {
  return new NodeClient({
    store: {
      schema: 1,
      nodeId: null,
      publicKeyHex: null,
      privateKeyHex: null,
      hubBaseUrl: null, // unenrolled stores carry no binding yet (invariant)
      state: "unenrolled",
      rotation: null,
      pendingEnrollment: null,
      pendingReenrollment: null,
      updatedAt: null,
    },
    storePath: statePath,
    hubBaseUrl: baseUrl,
    runtimeIdentity: runtime,
    fetchImpl,
  });
}

// Executes the real request, lets the Hub commit, then throws: the
// client sees an uncertain outcome although the Hub succeeded.
function dropOnceFetch(realFetch) {
  let dropped = false;
  return async (url, options) => {
    const response = await realFetch(url, options);
    if (!dropped) {
      dropped = true;
      // Drain the body so the Hub fully finished processing.
      await response.text().catch(() => "");
      throw new Error("simulated response loss after Hub commit");
    }
    return response;
  };
}

test("enrollment response loss: retry with the SAME token replays the exact request and adopts the recorded nodeId", async (t) => {
  const dir = await fixtureDir(t);
  const statePath = join(dir, "state.json");
  const { registry, baseUrl } = await withHub(t);
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });

  const first = makeClient({ statePath, baseUrl, fetchImpl: dropOnceFetch(globalThis.fetch) });
  await assert.rejects(() => first.enroll({ token: plain.token }), /outcome unknown/);
  // The Hub committed; the local store holds only the pending intent.
  const hubNodes = registry.db.prepare("SELECT COUNT(*) AS n FROM nodes").get().n;
  assert.equal(hubNodes, 1);
  const hubNodeId = registry.db.prepare("SELECT node_id FROM nodes").get().node_id;
  const afterLoss = await loadNodeStoreAsync(statePath);
  assert.equal(afterLoss.state, "unenrolled");
  assert.notEqual(afterLoss.pendingEnrollment, null);

  // Retry with the same token: exact replay (same requestId + keypair),
  // the Hub returns the recorded result, and the identity is adopted.
  const retry = makeClient({ statePath, baseUrl, fetchImpl: globalThis.fetch });
  retry.store = await loadNodeStoreAsync(statePath);
  const enrolled = await retry.enroll({ token: plain.token });
  assert.equal(enrolled.nodeId, hubNodeId);
  const final = await loadNodeStoreAsync(statePath);
  assert.equal(final.state, "active");
  assert.equal(final.nodeId, hubNodeId);
  assert.equal(final.pendingEnrollment, null);
});

test("rotation response loss: commit detection promotes the pending key; no third key is ever generated", async (t) => {
  const dir = await fixtureDir(t);
  const statePath = join(dir, "state.json");
  const { registry, baseUrl } = await withHub(t);
  const seed = makeClient({ statePath, baseUrl, fetchImpl: globalThis.fetch });
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  await seed.enroll({ token: plain.token });
  const nodeId = seed.store.nodeId;

  const rotating = makeClient({ statePath, baseUrl, fetchImpl: dropOnceFetch(globalThis.fetch) });
  rotating.store = await loadNodeStoreAsync(statePath);
  await assert.rejects(() => rotating.rotateCredential(), /rotation denied/);
  // The Hub committed: two active keys exist; locally a pending rotation
  // holds the exact keypair that was committed.
  const hubKeys = registry.db.prepare("SELECT COUNT(*) AS n FROM node_keys WHERE node_id = ? AND state = 'active'").get(nodeId).n;
  assert.equal(hubKeys, 2);
  const pending = (await loadNodeStoreAsync(statePath)).rotation;
  assert.equal(pending.overlapUntil, null);

  // Recovery: a probe with the PENDING new key detects the commit and
  // promotes locally — no freshly generated third key anywhere.
  const recovery = makeClient({ statePath, baseUrl, fetchImpl: globalThis.fetch });
  recovery.store = await loadNodeStoreAsync(statePath);
  const outcome = await recovery.tick();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.committedDetected, true);
  const final = await loadNodeStoreAsync(statePath);
  assert.equal(final.rotation.overlapUntil !== null, true);
  assert.equal(final.rotation.newKeyId, pending.newKeyId);
  const hubKeysAfter = registry.db.prepare("SELECT COUNT(*) AS n FROM node_keys WHERE node_id = ? AND state = 'active'").get(nodeId).n;
  assert.equal(hubKeysAfter, 2, "recovery must not mint a third key");
  const beat = await recovery.heartbeat();
  assert.equal(beat.ok, true);
});

test("rotation response loss with a truly uncommitted rotate: the SAME pending public key is re-submitted", async (t) => {
  const dir = await fixtureDir(t);
  const statePath = join(dir, "state.json");
  const { registry, baseUrl } = await withHub(t);
  const seed = makeClient({ statePath, baseUrl, fetchImpl: globalThis.fetch });
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  await seed.enroll({ token: plain.token });
  const nodeId = seed.store.nodeId;

  // A rotate that fails BEFORE reaching the hub (transport failure at
  // attempt time) leaves the hub with one key; the node holds a pending
  // rotation built from the keypair it was about to commit.
  const failing = makeClient({ statePath, baseUrl, fetchImpl: async () => Promise.reject(new Error("transport down")) });
  failing.store = await loadNodeStoreAsync(statePath);
  await assert.rejects(() => failing.rotateCredential(), /rotation denied/);
  const pending = (await loadNodeStoreAsync(statePath)).rotation;
  assert.equal(pending.overlapUntil, null);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM node_keys WHERE node_id = ? AND state = 'active'").get(nodeId).n, 1);

  // Recovery with the hub back online: the new key probe fails (not
  // committed), the old key still works, so the SAME pending public key
  // is re-submitted — the hub now has exactly two keys and the marker
  // is complete with that same newKeyId.
  const recovery = makeClient({ statePath, baseUrl, fetchImpl: globalThis.fetch });
  recovery.store = await loadNodeStoreAsync(statePath);
  const outcome = await recovery.tick();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.resubmitted, true);
  const final = await loadNodeStoreAsync(statePath);
  assert.equal(final.rotation.newKeyId, pending.newKeyId);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM node_keys WHERE node_id = ? AND state = 'active'").get(nodeId).n, 2);
});

test("re-enrollment response loss: retry with the SAME token replays and restores the same nodeId with the pending key", async (t) => {
  const dir = await fixtureDir(t);
  const statePath = join(dir, "state.json");
  const { registry, baseUrl } = await withHub(t);
  const seed = makeClient({ statePath, baseUrl, fetchImpl: globalThis.fetch });
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  await seed.enroll({ token: plain.token });
  const nodeId = seed.store.nodeId;
  registry.deleteNode({ actor: "operator", nodeId, requestId: "cd".repeat(16), reason: "retired" });
  seed.store = await loadNodeStoreAsync(statePath);
  await seed.heartbeat(); // machine denial persists REVOKED
  assert.equal((await loadNodeStoreAsync(statePath)).state, "revoked");

  const reenrollToken = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: nodeId });
  const loser = makeClient({ statePath, baseUrl, fetchImpl: dropOnceFetch(globalThis.fetch) });
  loser.store = await loadNodeStoreAsync(statePath);
  await assert.rejects(() => loser.reenroll({ token: reenrollToken.token }), /outcome unknown/);
  // The Hub committed the re-enrollment; the local store keeps the
  // pending reenrollment intent.
  assert.equal(registry.getNode(nodeId).state, "active");
  const afterLoss = await loadNodeStoreAsync(statePath);
  assert.equal(afterLoss.state, "revoked");
  assert.notEqual(afterLoss.pendingReenrollment, null);

  // Retry with the SAME token: exact replay; same nodeId + the pending
  // key are restored.
  const retry = makeClient({ statePath, baseUrl, fetchImpl: globalThis.fetch });
  retry.store = await loadNodeStoreAsync(statePath);
  const restored = await retry.reenroll({ token: reenrollToken.token });
  assert.equal(restored.nodeId, nodeId);
  const final = await loadNodeStoreAsync(statePath);
  assert.equal(final.state, "active");
  assert.equal(final.pendingReenrollment, null);
  assert.equal((await retry.heartbeat()).ok, true);
});