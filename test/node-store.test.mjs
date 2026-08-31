// Node local state store (SOP Stage 2): atomic persistence, corruption
// detection, restart recovery.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyNodeStore, loadNodeStore, loadNodeStoreAsync, validateNodeStore, writeNodeStore } from "../src/node/store.mjs";
import { generateNodeKeyPair } from "../src/registry/crypto.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-node-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "state.json");
}

function enrolledStore() {
  const keys = generateNodeKeyPair();
  return {
    schema: 1,
    nodeId: "node_" + "ab".repeat(16),
    publicKeyHex: keys.publicKeyHex,
    privateKeyHex: keys.privateKeyHex,
    hubBaseUrl: "http://127.0.0.1:5445",
    state: "active",
    rotation: null,
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

test("write is atomic: no partial file is ever observable and a reload round-trips", async (t) => {
  const path = await fixture(t);
  await writeNodeStore(path, enrolledStore());
  const reloaded = await loadNodeStoreAsync(path);
  assert.equal(reloaded.nodeId, enrolledStore().nodeId);
  assert.equal(reloaded.state, "active");
  // The temporary file is gone.
  await assert.rejects(readFile(`${path}.tmp`, "utf8"), { code: "ENOENT" });
});

test("a missing store is an unenrolled fresh store; a corrupt store is reported, not guessed", async (t) => {
  const path = await fixture(t);
  const missing = await loadNodeStoreAsync(path);
  assert.equal(missing.state, "unenrolled");
  await writeFile(path, "{not json", "utf8");
  await assert.rejects(loadNodeStoreAsync(path), /corrupt/);
  assert.throws(() => loadNodeStore(path), /corrupt/);
});

test("validation rejects malformed identities and non-hex keys", () => {
  const badNodeId = { ...enrolledStore(), nodeId: "node_zz" };
  assert.ok(validateNodeStore(badNodeId).some((problem) => problem.includes("nodeId")));
  const badKey = { ...enrolledStore(), privateKeyHex: "zz" };
  assert.ok(validateNodeStore(badKey).some((problem) => problem.includes("private key")));
  const badRotation = { ...enrolledStore(), rotation: { oldPrivateKeyHex: "zz", overlapUntil: "nope" } };
  const problems = validateNodeStore(badRotation);
  assert.ok(problems.some((problem) => problem.includes("overlapUntil")));
  assert.ok(problems.some((problem) => problem.includes("old private key")));
  assert.ok(validateNodeStore(enrolledStore()).length === 0);
});

test("write refuses to persist an invalid store (no corrupt self-inflicted files)", async (t) => {
  const path = await fixture(t);
  await assert.rejects(() => writeNodeStore(path, { ...enrolledStore(), schema: 99 }), /refusing to persist/);
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
});

test("restart recovery: an enrolled store reloads to the same identity and is never re-enrolled", async (t) => {
  const path = await fixture(t);
  const original = enrolledStore();
  await writeNodeStore(path, original);
  const reloaded = await loadNodeStore(path);
  assert.equal(reloaded.nodeId, original.nodeId);
  assert.equal(reloaded.privateKeyHex, original.privateKeyHex);
  assert.notEqual(reloaded.state, "unenrolled");
  assert.equal(emptyNodeStore().state, "unenrolled");
});