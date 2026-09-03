// Shared fixture for registry tests: in-memory SQLite registry, an HTTP
// listener with the full protection stack, and machine-request helpers
// that build and sign ORBIT-MACHINE-V1 / ORBIT-REENROLL-V1 requests.

import { openRegistryDatabase } from "../../src/registry/sqlite.mjs";
import { Registry } from "../../src/registry/registry.mjs";
import { createHubServer } from "../../src/registry/server.mjs";
import {
  buildSigningString,
  MACHINE_V1_LABEL,
  REENROLL_V1_LABEL,
} from "../../src/registry/protocol.mjs";
import { generateNodeKeyPair, randomHex, sha256Hex, signSigningString } from "../../src/registry/crypto.mjs";

export function createTestRegistry(options = {}) {
  const db = openRegistryDatabase(":memory:");
  return new Registry({ db, ...options });
}

export async function createTestServer(registry, options = {}) {
  const { server } = createHubServer({ registry, options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function signedMachineRequest(baseUrl, { path, nodeId, keyId, keyHex, body = {}, nowSeconds, nonce, timestamp, signature, extraHeaders = {} }) {
  const rawBody = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const ts = String(timestamp ?? (nowSeconds ?? Math.trunc(Date.now() / 1000)));
  const freshNonce = nonce ?? randomHex(16);
  const bodyHash = sha256Hex(rawBody);
  const signing = buildSigningString({
    label: MACHINE_V1_LABEL,
    method: "POST",
    path,
    timestamp: ts,
    nonce: freshNonce,
    bodyHash,
    nodeId,
  });
  const sig = signature ?? signSigningString(keyHex, signing);
  return fetch(baseUrl + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-orbit-node": nodeId,
      "x-orbit-timestamp": ts,
      "x-orbit-nonce": freshNonce,
      "x-orbit-key": keyId,
      "x-orbit-signature": sig,
      ...extraHeaders,
    },
    body: rawBody,
  }).then(async (response) => ({
    status: response.status,
    body: await response.json().catch(() => ({})),
    response,
  }));
}

export function signedReenrollRequest(baseUrl, { path = "/api/v1/reenroll", nodeId, keyId, keyHex, body = {}, nowSeconds, nonce, timestamp, signature }) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const ts = String(timestamp ?? (nowSeconds ?? Math.trunc(Date.now() / 1000)));
  const freshNonce = nonce ?? randomHex(16);
  const bodyHash = sha256Hex(rawBody);
  const signing = buildSigningString({
    label: REENROLL_V1_LABEL,
    method: "POST",
    path,
    timestamp: ts,
    nonce: freshNonce,
    bodyHash,
    nodeId,
  });
  const sig = signature ?? signSigningString(keyHex, signing);
  return fetch(baseUrl + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-orbit-node": nodeId,
      "x-orbit-timestamp": ts,
      "x-orbit-nonce": freshNonce,
      "x-orbit-key": keyId,
      "x-orbit-signature": sig,
    },
    body: rawBody,
  }).then(async (response) => ({
    status: response.status,
    body: await response.json().catch(() => ({})),
    response,
  }));
}

// Enrolls a fresh node through the full HTTP path and returns everything
// needed to authenticate subsequent machine requests.
export async function enrollNode(baseUrl, registry, { purpose = "enroll", boundNodeId = null } = {}) {
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose, boundNodeId });
  const keys = generateNodeKeyPair();
  const requestId = randomHex(16);
  const enrollResponse = await fetch(baseUrl + "/api/v1/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: plain.token, enrollmentRequestId: requestId, publicKey: keys.publicKeyHex }),
  });
  const result = await enrollResponse.json();
  if (enrollResponse.status !== 200) {
    throw new Error(`enroll failed: ${enrollResponse.status} ${JSON.stringify(result)}`);
  }
  return {
    nodeId: result.nodeId,
    keyId: result.keyId,
    publicKeyHex: keys.publicKeyHex,
    privateKeyHex: keys.privateKeyHex,
    enrollmentRequestId: requestId,
  };
}

export function deleteNode(registry, nodeId, reason = "test") {
  return registry.deleteNode({ actor: "operator", nodeId, requestId: randomHex(16), reason });
}

export function defaultRuntimeIdentity(overrides = {}) {
  return {
    runtime: {
      orbitVersion: "0.3.0",
      orbitRevision: "abc123",
      dshVersion: "0.1.1-rc.2",
      compatibilityProfile: "dsh-0.1.1-rc.2",
      ...overrides,
    },
  };
}

export function validReport({ orbitVersion = "0.3.0", orbitRevision = "abc123", dshVersion = "0.1.1-rc.2", profile = "dsh-0.1.1-rc.2" } = {}) {
  const pass = () => ({ status: "pass", detail: "ok" });
  return {
    schemaVersion: 2,
    orbit: { version: orbitVersion, revision: orbitRevision },
    candidate: { dshVersion, profile },
    checks: {
      globalPatch: pass(),
      profilePatch: pass(),
      runtimeReadiness: pass(),
      settingsRead: pass(),
      settingsNoopWrite: pass(),
      authorizationSmoke: pass(),
      sessionResume: pass(),
      webPluginRoutes: pass(),
      webSocketTransport: pass(),
      longLivedTransport: { status: "not_run", detail: "" },
      terminalFence: { status: "not_run", detail: "" },
      terminalPtty: { status: "not_run", detail: "" },
    },
  };
}