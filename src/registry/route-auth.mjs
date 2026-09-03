// ORBIT-ROUTE-V1 signing and verification protocol (RFC-0010 D5).
// Authenticates hop-by-hop Hub -> Node route requests without body buffering.

import { signSigningString, verifySigningString } from "./crypto.mjs";
import {
  buildRouteSigningString,
  KEY_ID_PATTERN,
  NODE_ID_PATTERN,
  NONCE_PATTERN,
  ROUTE_HEADERS,
  ROUTE_SKEW_MS,
  ROUTE_V1_LABEL,
  SIGNATURE_PATTERN,
} from "./protocol.mjs";

export class RouteNonceCache {
  constructor({ retentionMs = 60_000, now = () => Date.now() } = {}) {
    this.retentionMs = retentionMs;
    this.now = now;
    this.nonces = new Map();
  }

  checkAndReserve(nonce) {
    const at = this.now();
    this.purge(at);
    if (this.nonces.has(nonce)) {
      return false;
    }
    this.nonces.set(nonce, at);
    return true;
  }

  purge(at = this.now()) {
    const cutoff = at - this.retentionMs;
    for (const [nonce, seenAt] of this.nonces.entries()) {
      if (seenAt < cutoff) {
        this.nonces.delete(nonce);
      } else {
        break;
      }
    }
  }

  clear() {
    this.nonces.clear();
  }
}

export function signRouteRequest({
  privateKeyHex,
  keyId,
  nodeId,
  routeAuthority,
  method,
  rawTarget,
  nowMs = Date.now(),
  nonce,
}) {
  if (!nodeId || !NODE_ID_PATTERN.test(nodeId)) {
    throw new Error(`invalid nodeId for route signature: ${nodeId}`);
  }
  if (!keyId || !KEY_ID_PATTERN.test(keyId)) {
    throw new Error(`invalid keyId for route signature: ${keyId}`);
  }
  if (!nonce) {
    throw new Error("nonce is required for route signature");
  }
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error(`invalid nonce for route signature: ${nonce}`);
  }
  const timestamp = String(nowMs);
  const signingString = buildRouteSigningString({
    label: ROUTE_V1_LABEL,
    nodeId,
    routeAuthority,
    method,
    rawTarget,
    timestamp,
    nonce,
  });
  const signature = signSigningString(privateKeyHex, signingString);
  return {
    headers: {
      "x-orbit-route-node": nodeId,
      "x-orbit-route-key": keyId,
      "x-orbit-route-timestamp": timestamp,
      "x-orbit-route-nonce": nonce,
      "x-orbit-route-signature": signature,
    },
    signingString,
  };
}

export function verifyRouteRequest({
  headers,
  method,
  rawTarget,
  expectedNodeId,
  expectedRouteAuthority,
  getPublicKey,
  nonceCache,
  nowMs = Date.now(),
}) {
  const normHeaders = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    normHeaders[k.toLowerCase()] = typeof v === "string" ? v.trim() : "";
  }

  const nodeId = normHeaders["x-orbit-route-node"];
  const keyId = normHeaders["x-orbit-route-key"];
  const timestampStr = normHeaders["x-orbit-route-timestamp"];
  const nonce = normHeaders["x-orbit-route-nonce"];
  const signature = normHeaders["x-orbit-route-signature"];

  if (!nodeId || !keyId || !timestampStr || !nonce || !signature) {
    return { ok: false, status: 400, code: "bad-request", message: "missing required ORBIT-ROUTE-V1 headers" };
  }
  if (!NODE_ID_PATTERN.test(nodeId)) {
    return { ok: false, status: 400, code: "bad-request", message: "malformed x-orbit-route-node" };
  }
  if (!KEY_ID_PATTERN.test(keyId)) {
    return { ok: false, status: 400, code: "bad-request", message: "malformed x-orbit-route-key" };
  }
  if (!NONCE_PATTERN.test(nonce)) {
    return { ok: false, status: 400, code: "bad-request", message: "malformed x-orbit-route-nonce" };
  }
  if (!SIGNATURE_PATTERN.test(signature)) {
    return { ok: false, status: 400, code: "bad-request", message: "malformed x-orbit-route-signature" };
  }
  if (!/^\d+$/.test(timestampStr)) {
    return { ok: false, status: 400, code: "bad-request", message: "malformed x-orbit-route-timestamp" };
  }

  const timestamp = Number(timestampStr);
  if (Math.abs(nowMs - timestamp) > ROUTE_SKEW_MS) {
    return { ok: false, status: 401, code: "timestamp-out-of-skew", message: "timestamp outside 30s skew window" };
  }

  if (expectedNodeId && nodeId !== expectedNodeId) {
    return { ok: false, status: 401, code: "node-mismatch", message: "nodeId does not match expected node" };
  }

  const key = getPublicKey(keyId);
  if (!key) {
    return { ok: false, status: 401, code: "unknown-key", message: `unknown Hub route keyId ${keyId}` };
  }
  if (key.state === "provisioned") {
    return { ok: false, status: 401, code: "key-not-active", message: "provisioned Hub route key cannot sign route traffic" };
  }
  if (key.state === "revoked") {
    return { ok: false, status: 401, code: "key-revoked", message: "Hub route key is revoked" };
  }
  if (key.state !== "active" && key.state !== "rotating") {
    return { ok: false, status: 401, code: "key-not-active", message: `Hub route key state '${key.state}' is not active` };
  }
  if (key.overlapUntil && Date.parse(key.overlapUntil) <= nowMs) {
    return { ok: false, status: 401, code: "key-revoked", message: "Hub route key rotation overlap has ended" };
  }

  const incomingAuthority = (normHeaders["x-orbit-route-authority"] || normHeaders["host"] || "").split(":")[0].toLowerCase();
  const expectedHostname = expectedRouteAuthority ? expectedRouteAuthority.split(":")[0].toLowerCase() : "";
  if (expectedHostname && incomingAuthority && incomingAuthority !== expectedHostname) {
    return { ok: false, status: 401, code: "authority-mismatch", message: `route authority mismatch: expected ${expectedHostname}, got ${incomingAuthority}` };
  }

  const signingString = buildRouteSigningString({
    label: ROUTE_V1_LABEL,
    nodeId,
    routeAuthority: expectedRouteAuthority,
    method,
    rawTarget,
    timestamp: timestampStr,
    nonce,
  });

  const verified = verifySigningString(key.publicKey, signingString, signature);
  if (!verified) {
    return { ok: false, status: 401, code: "signature-invalid", message: "signature does not verify over ORBIT-ROUTE-V1 signing string" };
  }

  // Reserve replay state only after the request has authenticated. Invalid
  // public input must not be able to fill the in-memory nonce cache.
  if (nonceCache && !nonceCache.checkAndReserve(nonce)) {
    return { ok: false, status: 401, code: "replay", message: "nonce already used" };
  }

  return { ok: true, nodeId, keyId, key };
}
