// SOP Stage 6 required live evidence (automated, loopback deployment):
// persistent registry DB, Hub restart, two Nodes with strict state
// isolation, disconnect/stale/lost + reconnect, delete/denial,
// reenroll/restore, Node restart, and the multi-node contamination
// checks.
//
// Clock discipline: both nodes and the Hub share one controllable clock
// object. The outage window advances the clock stepwise; the healthy
// node re-beats at each new time before maintenance runs, so A's
// outage never ages B.

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
import { validReport } from "./helpers/registry-fixture.mjs";

const RUNTIME = () => ({ orbitVersion: "0.3.0", orbitRevision: "s6", dshVersion: "0.1.1-rc.2", compatibilityProfile: "dsh-0.1.1-rc.2" });
const REPORT = () => validReport({ orbitRevision: "s6" });

async function fixtureDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-s6-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeNode({ statePath, baseUrl, fetchImpl, now }) {
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
    runtimeIdentity: RUNTIME,
    heartbeatCadenceSeconds: 60,
    now,
    fetchImpl,
  });
}

function switchableFetch(realFetch) {
  let enabled = true;
  return {
    fetchImpl: async (url, options) => {
      if (!enabled) throw new Error("simulated network outage");
      return realFetch(url, options);
    },
    cut() {
      enabled = false;
    },
    restore() {
      enabled = true;
    },
  };
}

const spacing = () => new Promise((resolve) => setTimeout(resolve, 1150));
async function enrollNode({ baseUrl, registry, statePath, transport, now }) {
  const client = makeNode({ statePath, baseUrl, fetchImpl: transport.fetchImpl, now });
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const enrolled = await client.enroll({ token: plain.token });
  assert.equal((await client.heartbeat()).ok, true);
  const report = await client.uploadReport(REPORT());
  assert.equal(report.orbitCompatible, "pass");
  return { client, nodeId: enrolled.nodeId };
}

test("Stage 6 multi-node lifecycle: persistent DB, Hub restart, isolation, disconnect/reconnect, delete/reenroll", async (t) => {
  const dir = await fixtureDir(t);
  const dbPath = join(dir, "registry.db");
  const stateA = join(dir, "node-a.json");
  const stateB = join(dir, "node-b.json");
  const clock = { now: new Date() };

  // --- First Hub instance on a FILE-backed registry. ---
  let registry = new Registry({ db: openRegistryDatabase(dbPath) });
  let hub = createHubServer({ registry, options: {} });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const port = hub.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/`;
  const closeHub = async () => {
    const { server } = hub;
    server.closeAllConnections?.(); // synchronous: destroys keep-alive sockets
    await new Promise((resolve) => server.close(resolve));
    registry.close();
  };

  // --- Node A and Node B: both fresh, both reported. ---
  const transportA = switchableFetch(globalThis.fetch);
  const transportB = switchableFetch(globalThis.fetch);
  const runNow = () => clock.now; // shared clock for both nodes
  const a = await enrollNode({ baseUrl, registry, statePath: stateA, transport: transportA, now: runNow });
  const b = await enrollNode({ baseUrl, registry, statePath: stateB, transport: transportB, now: runNow });
  assert.notEqual(a.nodeId, b.nodeId);
  assert.equal(registry.getNode(a.nodeId).health.registryContact, "fresh");
  assert.equal(registry.getNode(b.nodeId).health.registryContact, "fresh");
  assert.deepEqual(registry.getNode(a.nodeId).health.capabilities.map((entry) => entry.name).sort(), ["sessions.resume", "settings.remote", "web.routes"]);
  assert.deepEqual(registry.getNode(b.nodeId).health.capabilities.map((entry) => entry.name).sort(), ["sessions.resume", "settings.remote", "web.routes"]);

  // --- Hub restart with the SAME persistent DB: identities survive. ---
  await closeHub();
  registry = new Registry({ db: openRegistryDatabase(dbPath) });
  hub = createHubServer({ registry, options: {} });
  await new Promise((resolve) => hub.server.listen(port, "127.0.0.1", resolve));
  const afterRestart = registry.getNode(a.nodeId);
  assert.equal(afterRestart.state, "active");
  assert.equal(afterRestart.health.registryContact, "fresh");
  assert.equal(registry.getNode(b.nodeId).health.capabilities.length, 3);

  // --- Nodes recover across the Hub restart (binding intact), and the
  // whole environment moves onto the shared clock. ---
  registry.now = () => clock.now;
  const recoveredA = makeNode({ statePath: stateA, baseUrl, fetchImpl: transportA.fetchImpl, now: runNow });
  recoveredA.store = await loadNodeStoreAsync(stateA);
  await recoveredA.recoverAfterRestart();
  assert.equal((await recoveredA.heartbeat()).ok, true);
  const recoveredB = makeNode({ statePath: stateB, baseUrl, fetchImpl: transportB.fetchImpl, now: runNow });
  recoveredB.store = await loadNodeStoreAsync(stateB);
  await recoveredB.recoverAfterRestart();
  await spacing();
  const beatB = async () => {
    await spacing();
    const result = await recoveredB.heartbeat();
    assert.equal(result.ok, true, `B heartbeat failed: ${result.error?.message}`);
  };
  await beatB();

  // --- A disconnects: A ages to stale then lost; B stays healthy. ---
  transportA.cut();
  const beatA = await recoveredA.heartbeat();
  assert.equal(beatA.ok, false);
  assert.equal(beatA.state, "retrying");

  // Advance 4 minutes with B re-beating at the new time: A is stale
  // (3x60s missed), B is fresh.
  clock.now = new Date(clock.now.getTime() + 4 * 60 * 1000);
  await beatB();
  registry.maintenance();
  assert.equal(registry.getNode(a.nodeId).health.registryContact, "stale");
  assert.equal(registry.getNode(b.nodeId).health.registryContact, "fresh");

  // Advance past 24h with B re-beating: A is lost + alerted, B fresh.
  clock.now = new Date(clock.now.getTime() + 24 * 60 * 60 * 1000);
  await beatB();
  registry.maintenance();
  const aState = registry.getNode(a.nodeId);
  assert.equal(aState.health.registryContact, "lost");
  assert.deepEqual(aState.health.alertFlags, ["contact-lost"]);
  assert.equal(aState.health.reachable, "unknown");
  const bState = registry.getNode(b.nodeId);
  assert.equal(bState.health.registryContact, "fresh");
  assert.equal(bState.health.capabilities.length, 3);
  assert.deepEqual(bState.health.alertFlags, []);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND dimension = 'registry_contact'").get(b.nodeId).n >= 1, true);

  // --- A reconnects: automatically back to fresh; B untouched. ---
  transportA.restore();
  const reconnected = await recoveredA.heartbeat();
  assert.equal(reconnected.ok, true);
  const afterReconnect = registry.getNode(a.nodeId);
  assert.equal(afterReconnect.health.registryContact, "fresh");
  assert.deepEqual(afterReconnect.health.alertFlags, []);
  assert.equal(registry.getNode(b.nodeId).health.registryContact, "fresh");

  // --- Delete A: A denied, B unaffected. ---
  registry.deleteNode({ actor: "operator", nodeId: a.nodeId, requestId: "ee".repeat(16), reason: "retired" });
  const denied = await recoveredA.heartbeat();
  assert.equal(denied.ok, false);
  assert.equal(denied.state, "revoked");
  assert.equal((await loadNodeStoreAsync(stateA)).state, "revoked");
  assert.equal(registry.getNode(a.nodeId).state, "tombstoned");
  const bAfterDelete = registry.getNode(b.nodeId);
  assert.equal(bAfterDelete.state, "active");
  assert.equal(bAfterDelete.health.registryContact, "fresh");
  assert.equal(bAfterDelete.health.capabilities.length, 3);

  // --- Reenroll A: same nodeId, new key; B still healthy. ---
  const reenrollToken = registry.mintEnrollmentToken({ actor: "operator", purpose: "reenroll", boundNodeId: a.nodeId });
  const reenrolled = await recoveredA.reenroll({ token: reenrollToken.token });
  assert.equal(reenrolled.nodeId, a.nodeId);
  assert.equal(registry.getNode(a.nodeId).state, "active");
  assert.equal((await recoveredA.heartbeat()).ok, true);
  assert.equal(registry.getNode(b.nodeId).health.registryContact, "fresh");
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE state = 'active'").get().n, 2);

  // --- Node B restart recovery: identity + health intact. ---
  const bRestart = makeNode({ statePath: stateB, baseUrl, fetchImpl: transportB.fetchImpl, now: runNow });
  bRestart.store = await loadNodeStoreAsync(stateB);
  await bRestart.recoverAfterRestart();
  await spacing();
  assert.equal(bRestart.store.nodeId, b.nodeId);
  assert.equal((await bRestart.heartbeat()).ok, true);
  assert.equal(registry.getNode(b.nodeId).health.registryContact, "fresh");

  // Shut the final hub down so the runner can exit.
  hub.server.closeAllConnections?.();
  await new Promise((resolve) => hub.server.close(resolve));
  registry.close();
});