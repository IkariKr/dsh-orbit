import assert from "node:assert/strict";
import test from "node:test";
import { deriveKeyId, generateNodeKeyPair, randomHex, sha256Hex, signSigningString, verifySigningString } from "../src/registry/crypto.mjs";
import { buildSigningString, MACHINE_V1_LABEL, REENROLL_V1_LABEL } from "../src/registry/protocol.mjs";

test("keyId is the first 16 bytes of SHA-256 of the raw public key", () => {
  const { publicKeyHex } = generateNodeKeyPair();
  const raw = Buffer.from(publicKeyHex, "hex");
  assert.equal(raw.length, 32);
  const expected = sha256Hex(raw).slice(0, 32);
  assert.equal(deriveKeyId(publicKeyHex), expected);
  assert.match(deriveKeyId(publicKeyHex), /^[0-9a-f]{32}$/);
});

test("sign/verify round-trips over the exact signing string", () => {
  const { publicKeyHex, privateKeyHex } = generateNodeKeyPair();
  const signing = buildSigningString({
    label: MACHINE_V1_LABEL,
    method: "POST",
    path: "/api/v1/heartbeat",
    timestamp: "1750000000",
    nonce: randomHex(16),
    bodyHash: sha256Hex(Buffer.from("{}")),
    nodeId: "node_" + randomHex(16),
  });
  const signature = signSigningString(privateKeyHex, signing);
  assert.match(signature, /^[0-9a-f]{128}$/);
  assert.equal(verifySigningString(publicKeyHex, signing, signature), true);
});

test("the signing string is label-method-path-timestamp-nonce-bodyhash-nodeid joined by a single newline, no trailing newline", () => {
  const signing = buildSigningString({
    label: MACHINE_V1_LABEL,
    method: "POST",
    path: "/api/v1/heartbeat",
    timestamp: "1750000000",
    nonce: "ab".repeat(16),
    bodyHash: "cd".repeat(32),
    nodeId: "node_" + "ef".repeat(16),
  });
  assert.equal(
    signing,
    "ORBIT-MACHINE-V1\nPOST\n/api/v1/heartbeat\n1750000000\n" + "ab".repeat(16) + "\n" + "cd".repeat(32) + "\nnode_" + "ef".repeat(16),
  );
  assert.equal(signing.endsWith("\n"), false);
});

test("different protocol labels produce different signing strings", () => {
  const common = {
    method: "POST",
    path: "/api/v1/reenroll",
    timestamp: "1750000000",
    nonce: randomHex(16),
    bodyHash: sha256Hex(Buffer.from("{}")),
    nodeId: "node_" + randomHex(16),
  };
  const machine = buildSigningString({ label: MACHINE_V1_LABEL, ...common });
  const reenroll = buildSigningString({ label: REENROLL_V1_LABEL, ...common });
  assert.notEqual(machine, reenroll);
});

test("a tampered body hash fails verification", () => {
  const { publicKeyHex, privateKeyHex } = generateNodeKeyPair();
  const signing = buildSigningString({
    label: MACHINE_V1_LABEL,
    method: "POST",
    path: "/api/v1/heartbeat",
    timestamp: "1750000000",
    nonce: randomHex(16),
    bodyHash: sha256Hex(Buffer.from('{"a":1}')),
    nodeId: "node_" + randomHex(16),
  });
  const signature = signSigningString(privateKeyHex, signing);
  const tampered = buildSigningString({
    label: MACHINE_V1_LABEL,
    method: "POST",
    path: "/api/v1/heartbeat",
    timestamp: "1750000000",
    nonce: randomHex(16),
    bodyHash: sha256Hex(Buffer.from('{"a":2}')),
    nodeId: "node_" + randomHex(16),
  });
  assert.equal(verifySigningString(publicKeyHex, tampered, signature), false);
});

test("a signature from another key fails verification", () => {
  const first = generateNodeKeyPair();
  const second = generateNodeKeyPair();
  const signing = buildSigningString({
    label: MACHINE_V1_LABEL,
    method: "POST",
    path: "/api/v1/heartbeat",
    timestamp: "1750000000",
    nonce: randomHex(16),
    bodyHash: sha256Hex(Buffer.from("{}")),
    nodeId: "node_" + randomHex(16),
  });
  const signature = signSigningString(first.privateKeyHex, signing);
  assert.equal(verifySigningString(second.publicKeyHex, signing, signature), false);
});

test("a swapped nodeId fails verification (NODE_ID is inside the signing string)", () => {
  const { publicKeyHex, privateKeyHex } = generateNodeKeyPair();
  const nodeA = "node_" + randomHex(16);
  const nodeB = "node_" + randomHex(16);
  const base = {
    label: MACHINE_V1_LABEL,
    method: "POST",
    path: "/api/v1/heartbeat",
    timestamp: "1750000000",
    nonce: randomHex(16),
    bodyHash: sha256Hex(Buffer.from("{}")),
  };
  const signature = signSigningString(privateKeyHex, buildSigningString({ ...base, nodeId: nodeA }));
  assert.equal(verifySigningString(publicKeyHex, buildSigningString({ ...base, nodeId: nodeB }), signature), false);
});

test("malformed encodings are rejected without throwing", () => {
  const { publicKeyHex } = generateNodeKeyPair();
  const signing = buildSigningString({
    label: MACHINE_V1_LABEL,
    method: "POST",
    path: "/api/v1/heartbeat",
    timestamp: "1750000000",
    nonce: randomHex(16),
    bodyHash: sha256Hex(Buffer.from("{}")),
    nodeId: "node_" + randomHex(16),
  });
  assert.equal(verifySigningString(publicKeyHex, signing, "zz"), false);
  // A non-hex public key fails the wire-format checks before any crypto.
  assert.throws(() => verifySigningString("not-hex", signing, "ab".repeat(64)), /public key/);
  assert.throws(() => deriveKeyId("not-hex"), /public key/);
});