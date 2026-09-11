// Hub route public key trust set validation (RFC-0006, RFC-0008 rev. 5).
// hubRouteKeys is an authoritative complete desired trust set, not an
// incremental patch.

import { deriveKeyId } from "./crypto.mjs";

const KEY_ID_REGEX = /^[0-9a-f]{32}$/;
const PUBLIC_KEY_REGEX = /^[0-9a-f]{64}$/;

export function validateHubRouteKeySet(hubRouteKeys, now = new Date()) {
  if (!Array.isArray(hubRouteKeys)) {
    return { valid: false, reason: "hubRouteKeys must be an array" };
  }
  if (hubRouteKeys.length === 0) {
    return { valid: false, reason: "hubRouteKeys must not be empty" };
  }
  if (hubRouteKeys.length > 2) {
    return { valid: false, reason: `hubRouteKeys contains ${hubRouteKeys.length} keys (maximum 2)` };
  }

  const seenKeyIds = new Set();
  const seenPublicKeys = new Set();
  const keys = [];

  for (const item of hubRouteKeys) {
    if (typeof item !== "object" || item === null) {
      return { valid: false, reason: "key entry must be an object" };
    }
    const { keyId, publicKey, state, overlapUntil } = item;
    if (typeof keyId !== "string" || !KEY_ID_REGEX.test(keyId)) {
      return { valid: false, reason: `invalid keyId: ${JSON.stringify(keyId)}` };
    }
    if (typeof publicKey !== "string" || !PUBLIC_KEY_REGEX.test(publicKey)) {
      return { valid: false, reason: `invalid publicKey: ${JSON.stringify(publicKey)}` };
    }
    const derived = deriveKeyId(publicKey);
    if (derived !== keyId) {
      return { valid: false, reason: `keyId mismatch: expected ${derived} but got ${keyId}` };
    }
    if (seenKeyIds.has(keyId)) {
      return { valid: false, reason: `duplicate keyId ${keyId}` };
    }
    seenKeyIds.add(keyId);
    if (seenPublicKeys.has(publicKey)) {
      return { valid: false, reason: `duplicate publicKey ${publicKey}` };
    }
    seenPublicKeys.add(publicKey);

    if (!["provisioned", "active", "rotating"].includes(state)) {
      return { valid: false, reason: `unsupported key state ${JSON.stringify(state)}` };
    }

    if (state === "provisioned" || state === "active") {
      if (overlapUntil !== null && overlapUntil !== undefined) {
        return { valid: false, reason: `${state} key must have overlapUntil = null` };
      }
    } else if (state === "rotating") {
      if (typeof overlapUntil !== "string" || isNaN(Date.parse(overlapUntil))) {
        return { valid: false, reason: "rotating key requires a valid ISO timestamp for overlapUntil" };
      }
      const nowMs = now instanceof Date ? now.getTime() : Date.now();
      if (Date.parse(overlapUntil) <= nowMs) {
        return { valid: false, reason: "rotating key overlapUntil must be in the future" };
      }
    }

    keys.push({ keyId, publicKey, state, overlapUntil: overlapUntil ?? null });
  }

  // Exactly 1 key: Form 1 (1 provisioned) or Form 2 (1 active)
  if (keys.length === 1) {
    const k = keys[0];
    if (k.state === "provisioned" && k.overlapUntil === null) {
      return { valid: true, form: 1, keys };
    }
    if (k.state === "active" && k.overlapUntil === null) {
      return { valid: true, form: 2, keys };
    }
    return { valid: false, reason: `single key cannot be in state ${k.state} with overlapUntil ${k.overlapUntil}` };
  }

  // Exactly 2 keys: Form 3 (1 active + 1 provisioned) or Form 4 (1 active + 1 rotating)
  if (keys.length === 2) {
    const active = keys.find((k) => k.state === "active");
    const provisioned = keys.find((k) => k.state === "provisioned");
    const rotating = keys.find((k) => k.state === "rotating");

    if (active && provisioned && !rotating) {
      if (active.overlapUntil === null && provisioned.overlapUntil === null) {
        return { valid: true, form: 3, keys };
      }
      return { valid: false, reason: "Form 3 rotation keys must have overlapUntil = null" };
    }

    if (active && rotating && !provisioned) {
      if (active.overlapUntil === null && typeof rotating.overlapUntil === "string") {
        return { valid: true, form: 4, keys };
      }
      return { valid: false, reason: "Form 4 active key must have overlapUntil = null and rotating must have future overlapUntil" };
    }

    return { valid: false, reason: "two keys must be either (active + provisioned) or (active + rotating)" };
  }

  return { valid: false, reason: "unrecognized key set structure" };
}
