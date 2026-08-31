// Review Gate A round-3 (persist() commit order): a persistence failure
// must never mutate this.store in memory. Only after writeNodeStore()
// succeeds is the candidate published. Regression: forced write/rename
// failures leave BOTH memory and disk at the previous committed state,
// and a retried identity-changing operation re-persists its pending
// intent before any network request.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeClient } from "../src/node/client.mjs";
import { loadNodeStoreAsync, writeNodeStore } from "../src/node/store.mjs";
import { deriveKeyId, generateNodeKeyPair } from "../src/registry/crypto.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-node-persist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function unenrolledStore() {
  return {
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
  };
}

function spyClient({ statePath, hubBaseUrl, fetchImpl }) {
  const requests = [];
  const spy = async (url, options) => {
    requests.push({ url, options });
    return fetchImpl ? await fetchImpl(url, options) : { status: 404, json: async () => ({}) };
  };
  const client = new NodeClient({
    store: unenrolledStore(),
    storePath: statePath,
    hubBaseUrl,
    runtimeIdentity: () => ({ orbitVersion: "0.3.0", orbitRevision: "abc123", dshVersion: "0.1.1-rc.2", compatibilityProfile: "dsh-0.1.1-rc.2" }),
    fetchImpl: spy,
  });
  return { client, requests };
}

const TOKEN = "ab".repeat(16);

test("a forced write failure never mutates memory or disk, and no network request is sent", async (t) => {
  const dir = await fixture(t);
  // Block the state file's parent directory with a regular file so
  // mkdir() (and therefore the full write) fails inside writeNodeStore.
  const blocker = join(dir, "blocker");
  const statePath = join(blocker, "state.json");
  await writeFile(blocker, "not a directory", "utf8");

  const { client, requests } = spyClient({ statePath, hubBaseUrl: "http://127.0.0.1:5445/", fetchImpl: async () => { throw new Error("must not be reached"); } });
  await assert.rejects(() => client.enroll({ token: TOKEN }), /mkdir|persist|ENOTDIR|EEXIST/i);

  // Memory unchanged: still the plain unenrolled store, no pending intent.
  assert.equal(client.store.state, "unenrolled");
  assert.equal(client.store.pendingEnrollment, null);
  assert.equal(client.store.updatedAt, null);

  // Disk unchanged: the retry must be able to start from an intact store.
  const onDisk = await loadNodeStoreAsync(statePath);
  assert.equal(onDisk.pendingEnrollment, null);
  assert.equal(onDisk.state, "unenrolled");

  // No network request was made before the intent existed on disk.
  assert.equal(requests.length, 0);
});

test("a forced temp-write failure (rename stage) leaves memory and disk untouched", async (t) => {
  const dir = await fixture(t);
  const statePath = join(dir, "state.json");
  // A directory occupying the temp-file path makes the atomic write
  // fail after validation, while the real state file stays absent.
  await mkdir(`${statePath}.tmp`, { recursive: true });

  const { client, requests } = spyClient({ statePath, hubBaseUrl: "http://127.0.0.1:5445/" });
  await assert.rejects(() => client.enroll({ token: TOKEN }), /EISDIR|ENOTDIR|persist/i);
  assert.equal(client.store.pendingEnrollment, null);
  assert.equal(requests.length, 0);
  // The state file was never created: the load yields the pristine
  // empty store with no intent.
  const onDisk = await loadNodeStoreAsync(statePath);
  assert.equal(onDisk.pendingEnrollment, null);
  assert.equal(onDisk.state, "unenrolled");
});

test("after the failure is removed, retry persists the pending intent BEFORE the first network request and enrolls", async (t) => {
  const dir = await fixture(t);
  const blocker = join(dir, "blocker");
  const statePath = join(blocker, "state.json");
  await writeFile(blocker, "not a directory", "utf8");

  const keys = generateNodeKeyPair();
  let onDiskAtFirstRequest = null;
  let requestBodies = [];
  const { client, requests } = spyClient({
    statePath,
    hubBaseUrl: "http://127.0.0.1:5445/",
    fetchImpl: async (url, options) => {
      // At the moment the identity-changing request goes out, the
      // pending intent MUST already be on disk (persist-before-send).
      if (onDiskAtFirstRequest === null) {
        onDiskAtFirstRequest = await loadNodeStoreAsync(statePath);
        requestBodies = [JSON.parse(options.body)];
      }
      return {
        status: 200,
        json: async () => ({
          nodeId: "node_" + "cd".repeat(16),
          keyId: deriveKeyId(onDiskAtFirstRequest.pendingEnrollment.publicKeyHex),
        }),
      };
    },
  });

  // First attempt: persistence fails; nothing sent.
  await assert.rejects(() => client.enroll({ token: TOKEN }), /mkdir|persist|ENOTDIR|EEXIST/i);
  assert.equal(requests.length, 0);

  // Unblock the path; the same token retry succeeds.
  await rm(blocker, { force: true });
  const enrolled = await client.enroll({ token: TOKEN });
  assert.equal(enrolled.nodeId, "node_" + "cd".repeat(16));
  assert.equal(requests.length, 1);

  // The persisted pending intent existed at request time and is exactly
  // what the wire carried — replay-safe even if THIS response is lost.
  assert.notEqual(onDiskAtFirstRequest, null);
  assert.equal(onDiskAtFirstRequest.pendingEnrollment.enrollmentRequestId, requestBodies[0].enrollmentRequestId);
  assert.equal(onDiskAtFirstRequest.pendingEnrollment.publicKeyHex, requestBodies[0].publicKey);
  assert.equal(requestBodies[0].token, TOKEN);
  // After success, memory and disk agree on the active identity.
  assert.equal(client.store.state, "active");
  const final = await loadNodeStoreAsync(statePath);
  assert.equal(final.state, "active");
  assert.equal(final.pendingEnrollment, null);
  assert.equal(final.nodeId, "node_" + "cd".repeat(16));
});

test("persist() publishes only after validation: an invalid candidate never reaches this.store or disk", async (t) => {
  const dir = await fixture(t);
  const statePath = join(dir, "state.json");
  const wrote = await writeNodeStore(statePath, unenrolledStore());
  void wrote;
  const client = new NodeClient({
    store: await loadNodeStoreAsync(statePath),
    storePath: statePath,
    hubBaseUrl: "http://127.0.0.1:5445/",
    runtimeIdentity: () => ({ orbitVersion: "0.3.0", orbitRevision: "abc123", dshVersion: "0.1.1-rc.2", compatibilityProfile: "dsh-0.1.1-rc.2" }),
  });
  // A candidate that violates the store invariants (main key without an
  // identity on an active store) must be refused by writeNodeStore
  // before it can be published.
  await assert.rejects(
    () => client.persist({ state: "active", nodeId: null, publicKeyHex: generateNodeKeyPair().publicKeyHex, privateKeyHex: generateNodeKeyPair().privateKeyHex }),
    /refusing to persist/,
  );
  assert.equal(client.store.state, "unenrolled");
  assert.equal((await loadNodeStoreAsync(statePath)).state, "unenrolled");
});