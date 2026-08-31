// Node Registry Client local state store (SOP Stage 2; RFC-0001,
// RFC-0005 D1/D6; Review Gate A remediation). A single JSON file
// persisted atomically (temp file + rename) with POSIX 0600
// permissions. The store is validated on EVERY load and every write:
// semantic invariants (state/identity consistency, keypair matching,
// pending-operation integrity) are enforced, not just field shapes.

import { readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { deriveKeyId, signSigningString, verifySigningString } from "../registry/crypto.mjs";

export const NODE_STORE_SCHEMA = 1;

export const PERSISTED_STATES = Object.freeze(["unenrolled", "active", "revoked"]);

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX96 = /^[0-9a-f]{96}$/;

// Probe used to prove a private key signs for a public key. Fixed
// content; never sent anywhere.
const KEYPAIR_PROBE = "dsh-orbit-node-keypair-probe";

export function emptyNodeStore() {
  return {
    schema: NODE_STORE_SCHEMA,
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

function keyPairMatches(publicKeyHex, privateKeyHex) {
  if (typeof publicKeyHex !== "string" || typeof privateKeyHex !== "string") return false;
  if (!HEX64.test(publicKeyHex) || !HEX96.test(privateKeyHex)) return false;
  try {
    const signature = signSigningString(privateKeyHex, KEYPAIR_PROBE);
    return verifySigningString(publicKeyHex, KEYPAIR_PROBE, signature);
  } catch {
    return false;
  }
}

function keyIdOf(publicKeyHex) {
  try {
    return deriveKeyId(publicKeyHex);
  } catch {
    return null;
  }
}

// Semantic store validation (Review Gate A P1-08): a store that claims
// active/revoked with missing identity material is corrupt, and a
// keypair that does not self-verify is corrupt.
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
    return problems;
  }
  if (store.nodeId !== null && !/^node_[0-9a-f]{32}$/.test(store.nodeId)) {
    problems.push(`nodeId ${JSON.stringify(store.nodeId)} is not a node_ identifier`);
  }
  if (store.hubBaseUrl !== null) {
    try {
      const url = new URL(store.hubBaseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        problems.push(`hubBaseUrl protocol ${JSON.stringify(url.protocol)} is not http(s)`);
      }
      if (url.pathname !== "/") {
        problems.push(`hubBaseUrl must carry no path (got ${JSON.stringify(url.pathname)})`);
      }
      if (url.search !== "" || url.hash !== "") {
        problems.push("hubBaseUrl must carry no query or fragment");
      }
    } catch {
      problems.push(`hubBaseUrl ${JSON.stringify(store.hubBaseUrl)} is not a valid URL`);
    }
  }

  // State/identity invariants (P1-08) + cross-state relations (P2-02)
  if (store.state === "unenrolled") {
    if (store.nodeId !== null) problems.push("unenrolled store must not carry a nodeId");
    if (store.hubBaseUrl !== null) problems.push("unenrolled store must not carry a Hub binding");
    if (store.publicKeyHex !== null || store.privateKeyHex !== null) {
      problems.push("unenrolled store must not carry main identity keys (keys belong in pendingEnrollment)");
    }
    if (store.pendingReenrollment !== null && store.pendingReenrollment !== undefined) {
      problems.push("unenrolled store must not carry a pendingReenrollment");
    }
    if (store.rotation !== null && store.rotation !== undefined) {
      problems.push("unenrolled store must not carry a rotation marker");
    }
  } else {
    for (const [field, label] of [
      ["nodeId", "nodeId"],
      ["hubBaseUrl", "Hub binding"],
      ["publicKeyHex", "public key"],
      ["privateKeyHex", "private key"],
    ]) {
      if (store[field] === null || store[field] === undefined) {
        problems.push(`${store.state} store is missing ${label}`);
      }
    }
    if (store.publicKeyHex !== null && store.privateKeyHex !== null) {
      if (!HEX64.test(store.publicKeyHex)) problems.push("public key is not 32 raw bytes in hex");
      else if (!HEX96.test(store.privateKeyHex)) problems.push("private key is not a valid PKCS8 hex encoding");
      else if (!keyPairMatches(store.publicKeyHex, store.privateKeyHex)) {
        problems.push("public/private keypair does not self-verify");
      }
    }
    if (store.pendingEnrollment !== null && store.pendingEnrollment !== undefined) {
      problems.push("active/revoked store must not carry a pendingEnrollment");
    }
    if (store.pendingReenrollment !== null && store.pendingReenrollment !== undefined && store.state !== "revoked") {
      problems.push("active store must not carry a pendingReenrollment (re-enrollment requires REVOKED)");
    }
    // Re-enrollment intent must target the SAME nodeId (P2-02).
    if (store.state === "revoked" && store.pendingReenrollment !== null && store.pendingReenrollment !== undefined) {
      if (store.pendingReenrollment.nodeId !== store.nodeId) {
        problems.push("pendingReenrollment nodeId does not match the store nodeId");
      }
    }
  }

  // Pending enrollment (P1-01): requestId + keypair + the canonical Hub
  // binding persisted BEFORE the request so an exact replay is possible
  // and the intent can never be replayed against another Hub; the token
  // itself is never stored.
  if (store.pendingEnrollment !== null && store.pendingEnrollment !== undefined) {
    const pending = store.pendingEnrollment;
    if (typeof pending !== "object" || !HEX32.test(pending.enrollmentRequestId ?? "")) {
      problems.push("pendingEnrollment lacks a valid enrollmentRequestId");
    }
    if (!HEX64.test(pending.publicKeyHex ?? "") || !HEX96.test(pending.privateKeyHex ?? "")) {
      problems.push("pendingEnrollment lacks a valid keypair");
    } else if (!keyPairMatches(pending.publicKeyHex, pending.privateKeyHex)) {
      problems.push("pendingEnrollment keypair does not self-verify");
    }
    if (typeof pending.hubBaseUrl !== "string" || pending.hubBaseUrl === "") {
      problems.push("pendingEnrollment lacks its Hub binding");
    } else {
      try {
        if (canonicalHubBaseUrl(pending.hubBaseUrl) !== pending.hubBaseUrl) {
          problems.push("pendingEnrollment Hub binding is not canonicalized");
        }
      } catch (error) {
        problems.push(`pendingEnrollment Hub binding is invalid: ${error.message}`);
      }
    }
  }

  // Rotation (P1-02): a pending rotation keeps the pending new keypair so
  // commit detection can probe with it and re-submission reuses it.
  if (store.rotation !== null && store.rotation !== undefined) {
    if (typeof store.rotation !== "object") {
      problems.push("rotation marker is not an object");
    } else {
      const rotation = store.rotation;
      const pending = rotation.overlapUntil === null || rotation.overlapUntil === undefined;
      if (!HEX32.test(rotation.oldKeyId ?? "")) problems.push("rotation marker lacks a valid oldKeyId");
      if (!HEX96.test(rotation.oldPrivateKeyHex ?? "")) problems.push("rotation marker lacks a valid retained old private key");
      if (!HEX32.test(rotation.newKeyId ?? "")) problems.push("rotation marker lacks a valid newKeyId");
      if (store.state !== "unenrolled") {
        // The rotation's keys must relate to the MAIN identity
        // (P2-02): while pending the old key IS the main key; once
        // completed the new key IS the main key.
        const mainKeyId = keyIdOf(store.publicKeyHex);
        if (pending) {
          if (mainKeyId !== null && rotation.oldKeyId !== mainKeyId) {
            problems.push("pending rotation oldKeyId does not match the current main key");
          }
          if (mainKeyId !== null && !keyPairMatches(store.publicKeyHex, rotation.oldPrivateKeyHex)) {
            problems.push("pending rotation old private key does not sign for the current main public key");
          }
        } else if (mainKeyId !== null && rotation.newKeyId !== mainKeyId) {
          problems.push("completed rotation newKeyId does not match the current main key");
        }
      }
      if (pending) {
        // Pending: full new keypair required and consistent.
        if (!HEX64.test(rotation.newPublicKeyHex ?? "") || !HEX96.test(rotation.newPrivateKeyHex ?? "")) {
          problems.push("pending rotation lacks the new keypair");
        } else {
          if (!keyPairMatches(rotation.newPublicKeyHex, rotation.newPrivateKeyHex)) {
            problems.push("pending rotation new keypair does not self-verify");
          }
          if (keyIdOf(rotation.newPublicKeyHex) !== rotation.newKeyId) {
            problems.push("pending rotation newKeyId does not match the new public key");
          }
        }
        if (typeof rotation.generatedAt !== "string" || Number.isNaN(Date.parse(rotation.generatedAt))) {
          problems.push("pending rotation lacks a valid generatedAt");
        }
      } else {
        if (typeof rotation.overlapUntil !== "string" || Number.isNaN(Date.parse(rotation.overlapUntil))) {
          problems.push("rotation marker has no valid overlapUntil");
        }
      }
    }
  }

  // Pending re-enrollment (P1-03): requestId + new keypair persisted so
  // the same operator token replays the exact request.
  if (store.pendingReenrollment !== null && store.pendingReenrollment !== undefined) {
    const pending = store.pendingReenrollment;
    if (typeof pending !== "object" || !HEX32.test(pending.reenrollmentRequestId ?? "")) {
      problems.push("pendingReenrollment lacks a valid reenrollmentRequestId");
    }
    if (!HEX64.test(pending.publicKeyHex ?? "") || !HEX96.test(pending.privateKeyHex ?? "")) {
      problems.push("pendingReenrollment lacks a valid keypair");
    } else if (!keyPairMatches(pending.publicKeyHex, pending.privateKeyHex)) {
      problems.push("pendingReenrollment keypair does not self-verify");
    }
    if (!/^node_[0-9a-f]{32}$/.test(pending.nodeId ?? "")) {
      problems.push("pendingReenrollment lacks a valid nodeId");
    }
  }

  return problems;
}

export function canonicalHubBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`hubBaseUrl protocol ${JSON.stringify(url.protocol)} is not http(s)`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`hubBaseUrl must carry no path (got ${JSON.stringify(url.pathname)})`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("hubBaseUrl must carry no query or fragment");
  }
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const port = url.port !== "" && url.port !== defaultPort ? `:${url.port}` : "";
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}/`;
}

function decode(raw, path) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`node state file ${path} is corrupt: ${error.message}`, { cause: error });
  }
  const problems = validateNodeStore(parsed);
  if (problems.length > 0) {
    throw new Error(`node state file ${path} is invalid: ${problems.join("; ")}`, { cause: null });
  }
  return parsed;
}

// Synchronous load for doctor/status CLI paths; validated immediately.
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
// Validation happens here, not only at doctor time (P1-08).
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

// POSIX-only permission check: the state file holds the Node private
// key, so group/other access fails closed (P1-10). Returns null when
// the platform has no meaningful mode bits (Windows).
export function stateFilePermissionProblem(path) {
  if (process.platform === "win32") return null;
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      return `state file ${path} is readable by group/other (mode ${mode.toString(8)}); expected 0600`;
    }
    return null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return `cannot inspect state file permissions: ${error.message}`;
  }
}

export function assertStateFilePermissions(path) {
  const problem = stateFilePermissionProblem(path);
  if (problem) throw new Error(problem);
}

export async function writeNodeStore(path, store) {
  const problems = validateNodeStore(store);
  if (problems.length > 0) {
    throw new Error(`refusing to persist an invalid node store: ${problems.join("; ")}`);
  }
  const json = JSON.stringify(store, null, 2);
  const temporary = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  // POSIX: the private-key-bearing state file is created and kept at
  // 0600 explicitly; never left to umask (P1-10).
  await writeFile(temporary, json, { encoding: "utf8", mode: 0o600 });
  // rename is atomic on the same filesystem: a crash anywhere before
  // this point leaves the previous store intact.
  await rename(temporary, path);
  try {
    await chmod(path, 0o600);
  } catch {
    // Non-POSIX filesystems ignore the mode; the creation mode above
    // already applied where it matters.
  }
}