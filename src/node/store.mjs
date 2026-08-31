// Node Registry Client local state store (SOP Stage 2; RFC-0001,
// RFC-0005 D1/D6). A single JSON file persisted atomically (temp file
// + rename), so a crash never leaves a half-written identity. The node
// never holds a Hub secret: only its own private key, the issued
// nodeId, and the Hub binding.

import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const NODE_STORE_SCHEMA = 1;

export const PERSISTED_STATES = Object.freeze(["unenrolled", "active", "revoked"]);

export function emptyNodeStore() {
  return {
    schema: NODE_STORE_SCHEMA,
    nodeId: null,
    publicKeyHex: null,
    privateKeyHex: null,
    hubBaseUrl: null,
    state: "unenrolled",
    rotation: null,
    updatedAt: null,
  };
}

export function validateNodeStore(store) {
  const problems = [];
  if (typeof store !== "object" || store === null) {
    return ["store is not an object"];
  }
  if (store.schema !== NODE_STORE_SCHEMA) {
    problems.push(`unsupported state schema ${JSON.stringify(store.schema)} (expected ${NODE_STORE_SCHEMA})`);
  }
  if (!PERSISTED_STATES.includes(store.state)) {
    problems.push(`unknown persisted state ${JSON.stringify(store.state)}`);
  }
  if (store.nodeId !== null && !/^node_[0-9a-f]{32}$/.test(store.nodeId)) {
    problems.push(`nodeId ${JSON.stringify(store.nodeId)} is not a node_ identifier`);
  }
  if (store.publicKeyHex !== null && !/^[0-9a-f]{64}$/.test(store.publicKeyHex)) {
    problems.push("public key is not 32 raw bytes in hex");
  }
  if (store.privateKeyHex !== null && !/^[0-9a-f]{96}$/.test(store.privateKeyHex)) {
    problems.push("private key is not a valid PKCS8 hex encoding");
  }
  if (store.hubBaseUrl !== null) {
    try {
      const url = new URL(store.hubBaseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        problems.push(`hubBaseUrl protocol ${JSON.stringify(url.protocol)} is not http(s)`);
      }
    } catch {
      problems.push(`hubBaseUrl ${JSON.stringify(store.hubBaseUrl)} is not a valid URL`);
    }
  }
  if (store.rotation !== null) {
    if (typeof store.rotation.overlapUntil !== "string" || Number.isNaN(Date.parse(store.rotation.overlapUntil))) {
      problems.push("rotation marker has no valid overlapUntil");
    }
    if (!/^[0-9a-f]{96}$/.test(store.rotation.oldPrivateKeyHex ?? "")) {
      problems.push("rotation marker lacks a valid retained old private key");
    }
  }
  return problems;
}

function decode(raw, path) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`node state file ${path} is corrupt: ${error.message}`, { cause: error });
  }
}

// Synchronous load for doctor/status CLI paths.
export function loadNodeStore(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyNodeStore();
    throw new Error(`node state file ${path} is unreadable: ${error.message}`, { cause: error });
  }
  return decode(raw, path);
}

// Load used by the client; a missing file is a fresh unenrolled store.
export async function loadNodeStoreAsync(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyNodeStore();
    throw new Error(`node state file ${path} is unreadable: ${error.message}`, { cause: error });
  }
  return decode(raw, path);
}

export async function writeNodeStore(path, store) {
  const problems = validateNodeStore(store);
  if (problems.length > 0) {
    throw new Error(`refusing to persist an invalid node store: ${problems.join("; ")}`);
  }
  const json = JSON.stringify(store, null, 2);
  const temporary = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, json, "utf8");
  // rename is atomic on the same filesystem: a crash anywhere before
  // this point leaves the previous store intact.
  await rename(temporary, path);
}