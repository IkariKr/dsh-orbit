// Ed25519 protocol primitives for the v0.3 registry (RFC-0006 wire
// contract): raw 32-byte public keys and 64-byte signatures, lowercase
// hex; keyId = first 16 bytes of SHA-256(raw public key), lowercase hex.
//
// The wire format is the raw 32-byte public key and the raw 64-byte
// signature. Node:crypto needs DER containers, so verification wraps
// the raw public key in the fixed Ed25519 SPKI prefix, and private keys
// are carried as full PKCS8 DER (hex) — never the raw seed alone.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

// Prefix bytes of the DER SPKI encoding of an Ed25519 public key:
// 30 2a 30 05 06 03 2b 65 70 03 21 00 + raw(32)
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// The DER PKCS8 encoding of an Ed25519 private key is
// 30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 + seed(32).
const ED25519_PKCS8_SEED_OFFSET = 16;
const ED25519_PKCS8_LENGTH = 48;

export function randomHex(byteLength) {
  return randomBytes(byteLength).toString("hex");
}

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function deriveKeyId(publicKeyHex) {
  return sha256Hex(rawPublicKey(publicKeyHex)).slice(0, 32);
}

export function generateNodeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const privateKeyHex = privateKey.export({ type: "pkcs8", format: "der" }).toString("hex");
  if (Buffer.from(privateKeyHex, "hex").length !== ED25519_PKCS8_LENGTH) {
    throw new Error("unexpected Ed25519 PKCS8 encoding");
  }
  return { publicKeyHex, privateKeyHex };
}

function rawPublicKey(publicKeyHex) {
  if (typeof publicKeyHex !== "string" || !/^[0-9a-f]{64}$/.test(publicKeyHex)) {
    throw new Error(`registry wire contract: public key must be 64 lowercase hex chars (got ${JSON.stringify(publicKeyHex)})`);
  }
  return Buffer.from(publicKeyHex, "hex");
}

function rawPrivateKey(privateKeyHex) {
  if (typeof privateKeyHex !== "string" || !/^[0-9a-f]{96}$/.test(privateKeyHex)) {
    throw new Error(`registry wire contract: private key must be PKCS8 DER hex (got ${JSON.stringify(privateKeyHex)})`);
  }
  return Buffer.from(privateKeyHex, "hex");
}

export function signSigningString(privateKeyHex, signingString) {
  const raw = rawPrivateKey(privateKeyHex);
  if (raw.length !== ED25519_PKCS8_LENGTH || !raw.subarray(0, ED25519_PKCS8_SEED_OFFSET).equals(Buffer.from("302e020100300506032b657004220420", "hex"))) {
    throw new Error("registry wire contract: private key is not a valid Ed25519 PKCS8 encoding");
  }
  const key = createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(signingString, "utf8"), key).toString("hex");
}

export function verifySigningString(publicKeyHex, signingString, signatureHex) {
  const signature = Buffer.from(String(signatureHex ?? ""), "hex");
  if (signature.length !== 64) return false;
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey(publicKeyHex)]),
    format: "der",
    type: "spki",
  });
  return verify(null, Buffer.from(signingString, "utf8"), key, signature);
}