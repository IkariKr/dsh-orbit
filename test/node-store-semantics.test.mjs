// Review Gate A remediation tests: store semantic invariants (P1-08),
// keypair consistency, POSIX permissions (P1-10), canonical Hub binding
// (P1-06).

import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalHubBaseUrl, loadNodeStoreAsync, validateNodeStore, writeNodeStore } from "../src/node/store.mjs";
import { generateNodeKeyPair } from "../src/registry/crypto.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-node-store2-"));
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
    hubBaseUrl: "http://127.0.0.1:5445/",
    state: "active",
    rotation: null,
    pendingEnrollment: null,
    pendingReenrollment: null,
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

test("semantic invariant: active/revoked state without identity material is invalid and unwritable", async (t) => {
  const path = await fixture(t);
  const broken = { ...enrolledStore(), state: "active", nodeId: null, publicKeyHex: null, privateKeyHex: null };
  const problems = validateNodeStore(broken);
  assert.ok(problems.some((problem) => problem.includes("missing nodeId")));
  assert.ok(problems.some((problem) => problem.includes("missing public key")));
  assert.ok(problems.some((problem) => problem.includes("missing private key")));
  await assert.rejects(() => writeNodeStore(path, broken), /refusing to persist/);
  await writeFile(path, JSON.stringify(broken), "utf8");
  await assert.rejects(loadNodeStoreAsync(path), /invalid/);
});

test("keypair mismatch is detected by self-verification", () => {
  const first = generateNodeKeyPair();
  const second = generateNodeKeyPair();
  const store = { ...enrolledStore(), publicKeyHex: first.publicKeyHex, privateKeyHex: second.privateKeyHex };
  assert.ok(validateNodeStore(store).some((problem) => problem.includes("does not self-verify")));
});

test("unenrolled store rejects stray identity material; pendingEnrollment carries its own keypair", () => {
  const withKeys = { ...enrolledStore(), state: "unenrolled", nodeId: null, hubBaseUrl: null, publicKeyHex: "aa".repeat(32), privateKeyHex: "bb".repeat(48) };
  assert.ok(validateNodeStore(withKeys).some((problem) => problem.includes("unenrolled")));
  const keys = generateNodeKeyPair();
  const pending = {
    ...enrolledStore(),
    state: "unenrolled",
    nodeId: null,
    hubBaseUrl: null,
    publicKeyHex: null,
    privateKeyHex: null,
    pendingEnrollment: {
      enrollmentRequestId: "cd".repeat(16),
      publicKeyHex: keys.publicKeyHex,
      privateKeyHex: keys.privateKeyHex,
      generatedAt: "2026-08-31T00:00:00.000Z",
    },
  };
  assert.deepEqual(validateNodeStore(pending), []);
  const badPending = { ...pending, pendingEnrollment: { ...pending.pendingEnrollment, enrollmentRequestId: "zz" } };
  assert.ok(validateNodeStore(badPending).some((problem) => problem.includes("enrollmentRequestId")));
});

test("pending rotation requires a full, consistent new keypair", async () => {
  const { deriveKeyId } = await import("../src/registry/crypto.mjs");
  const keys = generateNodeKeyPair();
  const pendingRotation = {
    oldKeyId: deriveKeyId("aa".repeat(32)),
    oldPrivateKeyHex: "aa".repeat(48),
    newKeyId: deriveKeyId(keys.publicKeyHex),
    newPublicKeyHex: keys.publicKeyHex,
    newPrivateKeyHex: keys.privateKeyHex,
    generatedAt: "2026-08-31T00:00:00.000Z",
    overlapUntil: null,
  };
  const store = { ...enrolledStore(), rotation: pendingRotation };
  assert.deepEqual(validateNodeStore(store), []);
  const missingNewKey = { ...store, rotation: { ...pendingRotation, newPublicKeyHex: null, newPrivateKeyHex: null } };
  assert.ok(validateNodeStore(missingNewKey).some((problem) => problem.includes("pending rotation lacks the new keypair")));
  const mismatchedKeyId = { ...store, rotation: { ...pendingRotation, newKeyId: "00".repeat(32) } };
  assert.ok(validateNodeStore(mismatchedKeyId).some((problem) => problem.includes("does not match the new public key")));
});

test("canonical Hub binding: scheme/host/port normalized; path/query/fragment rejected", () => {
  assert.equal(canonicalHubBaseUrl("http://HUB.example:8080/"), "http://hub.example:8080/");
  assert.equal(canonicalHubBaseUrl("https://hub.example:443/"), "https://hub.example/");
  assert.equal(canonicalHubBaseUrl("http://hub.example:80"), "http://hub.example/");
  assert.throws(() => canonicalHubBaseUrl("http://hub.example/path"), /no path/);
  assert.throws(() => canonicalHubBaseUrl("http://hub.example?x=1"), /no query/);
  assert.throws(() => canonicalHubBaseUrl("http://hub.example#f"), /query or fragment/);
  assert.throws(() => canonicalHubBaseUrl("ftp://hub.example/"), /protocol/);
});

test("POSIX: the state file is written 0600 and never group/other readable", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits do not apply on Windows");
    return;
  }
  const path = await fixture(t);
  await writeNodeStore(path, enrolledStore());
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test("round-trip through load stays valid and pending fields default to null", async (t) => {
  const path = await fixture(t);
  await writeNodeStore(path, enrolledStore());
  const reloaded = await loadNodeStoreAsync(path);
  assert.equal(reloaded.pendingEnrollment, null);
  assert.equal(reloaded.pendingReenrollment, null);
  assert.deepEqual(validateNodeStore(reloaded), []);
});