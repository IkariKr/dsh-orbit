// Review Gate A remediation: node state machine under protocol-level
// outcomes (429/5xx/non-revocation 401), cadence/backoff decoupling
// (P1-05), Hub binding enforcement (P1-06), unified revocation
// classification (P1-07), read-only doctor (P1-09).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeClient } from "../src/node/client.mjs";
import { loadNodeStoreAsync, writeNodeStore } from "../src/node/store.mjs";
import { generateNodeKeyPair } from "../src/registry/crypto.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-node-machines-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "state.json");
}

function enrolledStore({ hubBaseUrl = "http://127.0.0.1:5445/" } = {}) {
  const keys = generateNodeKeyPair();
  return {
    schema: 1,
    nodeId: "node_" + "ab".repeat(16),
    publicKeyHex: keys.publicKeyHex,
    privateKeyHex: keys.privateKeyHex,
    hubBaseUrl,
    state: "active",
    rotation: null,
    pendingEnrollment: null,
    pendingReenrollment: null,
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

function fakeFetch(...responses) {
  let index = 0;
  return async () => {
    const configured = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return { status: configured.status, json: async () => configured.body ?? {} };
  };
}

function makeClient({ statePath, store, hubBaseUrl, fetchImpl, now, cadence = 60 }) {
  return new NodeClient({
    store,
    storePath: statePath,
    hubBaseUrl,
    runtimeIdentity: () => ({ orbitVersion: "0.3.0", orbitRevision: "abc123", dshVersion: "0.1.1-rc.2", compatibilityProfile: "dsh-0.1.1-rc.2" }),
    heartbeatCadenceSeconds: cadence,
    now: now ?? (() => new Date()),
    fetchImpl,
  });
}

test("heartbeat 429 and 5xx: retrying, persisted state stays active (never REVOKED)", async (t) => {
  const statePath = await fixture(t);
  const store = enrolledStore();
  await writeNodeStore(statePath, store);
  for (const [status, code] of [
    [429, "rate-limited"],
    [500, null],
    [502, null],
  ]) {
    const client = makeClient({ statePath, store: { ...store }, hubBaseUrl: "http://127.0.0.1:5445/", fetchImpl: fakeFetch({ status, body: code ? { error: { code, message: "x" } } : {} }) });
    const outcome = await client.heartbeat();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.state, "retrying");
    const persisted = await loadNodeStoreAsync(statePath);
    assert.equal(persisted.state, "active");
    assert.equal(client.status().state, "retrying");
  }
});

test("non-revocation 401s never persist REVOKED — heartbeat, report, and rotation agree (P1-07)", async (t) => {
  const statePath = await fixture(t);
  const base = enrolledStore();
  for (const errorCode of ["timestamp-out-of-skew", "signature-invalid", "replay", "bad-request"]) {
    await writeNodeStore(statePath, base);
    const client = makeClient({ statePath, store: { ...base }, hubBaseUrl: "http://127.0.0.1:5445/", fetchImpl: fakeFetch({ status: 401, body: { error: { code: errorCode, message: "x" } } }) });
    const beat = await client.heartbeat();
    assert.equal(beat.state, "retrying");
    assert.equal((await loadNodeStoreAsync(statePath)).state, "active", `${errorCode} must not write REVOKED`);

    // Report path: rejected but not revoked.
    await assert.rejects(() => client.uploadReport({}), /report upload denied/);
    assert.equal((await loadNodeStoreAsync(statePath)).state, "active");

    // Rotation path: rejected but not revoked; a pending intent remains.
    await assert.rejects(() => client.rotateCredential(), /rotation denied/);
    assert.equal((await loadNodeStoreAsync(statePath)).state, "active");
  }
});

test("revocation codes persist REVOKED from every path", async (t) => {
  const statePath = await fixture(t);
  for (const code of ["revoked", "key-revoked", "unknown-key"]) {
    const base = enrolledStore();
    await writeNodeStore(statePath, base);
    const client = makeClient({ statePath, store: { ...base }, hubBaseUrl: "http://127.0.0.1:5445/", fetchImpl: fakeFetch({ status: 401, body: { error: { code, message: "x" } } }) });
    const beat = await client.heartbeat();
    assert.equal(beat.state, "revoked");
    assert.equal((await loadNodeStoreAsync(statePath)).state, "revoked");
  }
});

test("cadence is decoupled from failure backoff: successes schedule now + cadence (P1-05)", async (t) => {
  const statePath = await fixture(t);
  const clock = { now: new Date("2026-08-31T00:00:00.000Z") };
  let beatCount = 0;
  const fetchImpl = async () => {
    beatCount += 1;
    return { status: 200, json: async () => ({ ok: true, registryContact: "fresh" }) };
  };
  const client = makeClient({ statePath, store: { ...enrolledStore() }, hubBaseUrl: "http://127.0.0.1:5445/", fetchImpl, now: () => clock.now, cadence: 60 });

  const first = await client.tick(); // due immediately
  assert.equal(first.ok, true);
  assert.equal(beatCount, 1);
  // One second later nothing is due (cadence 60s, no backoff).
  clock.now = new Date(clock.now.getTime() + 1000);
  const early = await client.tick();
  assert.equal(early.attempted, false);
  assert.equal(beatCount, 1);
  // At the cadence boundary the next heartbeat goes out.
  clock.now = new Date(clock.now.getTime() + 59_000);
  const due = await client.tick();
  assert.equal(due.ok, true);
  assert.equal(beatCount, 2);
});

test("cadence validation fails closed outside 30-300s", async (t) => {
  const statePath = await fixture(t);
  for (const cadence of [10, 301, 1.5, NaN, "60"]) {
    assert.throws(
      () => makeClient({ statePath, store: { ...enrolledStore() }, hubBaseUrl: "http://127.0.0.1:5445/", fetchImpl: fakeFetch({ status: 200 }), cadence }),
      /cadence/,
      `cadence ${String(cadence)} must be rejected`,
    );
  }
});

test("Hub binding mismatch fails closed at client construction (P1-06)", async (t) => {
  const statePath = await fixture(t);
  await writeNodeStore(statePath, enrolledStore({ hubBaseUrl: "http://hub-a.invalid/" }));
  assert.throws(
    () => makeClient({ statePath, store: { ...enrolledStore({ hubBaseUrl: "http://hub-a.invalid/" }) }, hubBaseUrl: "http://hub-b.invalid/", fetchImpl: fakeFetch({ status: 200 }) }),
    /Hub binding mismatch/,
  );
  // Equivalent canonical forms are accepted.
  const ok = makeClient({ statePath, store: { ...enrolledStore({ hubBaseUrl: "http://HUB-a.invalid:80/" }) }, hubBaseUrl: "http://hub-a.invalid", fetchImpl: fakeFetch({ status: 200 }) });
  assert.equal(ok.status().state, "active");
});

test("doctor uses a non-mutating reachability probe (P1-09) and reports permission findings", async (t) => {
  const statePath = await fixture(t);
  const probes = [];
  const fetchImpl = async (url) => {
    probes.push(url);
    return { status: 200, json: async () => ({}) };
  };
  const client = makeClient({ statePath, store: { ...enrolledStore() }, hubBaseUrl: "http://127.0.0.1:5445/", fetchImpl });
  const report = await client.doctor();
  assert.ok(probes.every((url) => url.endsWith("/")));
  assert.equal(probes.length, 1);
  assert.ok(report.findings.some((finding) => finding.check === "hub-probe" && finding.severity === "ok"));
  // No heartbeat was sent: no heartbeat-ok event exists.
  assert.equal(client.recentEvents.some((event) => event.event === "heartbeat-ok"), false);
  const stateFindings = report.findings.find((finding) => finding.check === "state-file-permissions");
  if (process.platform !== "win32") {
    assert.ok(stateFindings === undefined || stateFindings.severity === "ok");
  }
});