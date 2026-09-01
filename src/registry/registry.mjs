// Domain service for the v0.3 registry (RFC-0005/0006/0007/0009). All
// protocol decisions live in the frozen RFCs; this module implements
// exactly them. HTTP transport and rate limiting live in server.mjs.

import { createCompatibilityReport } from "../compatibility-report.mjs";
import { deriveCapabilities, deriveDshHealthy, deriveOrbitCompatible, identityMatches, reportIdentity } from "./capabilities.mjs";
import { deriveKeyId, randomHex, sha256Hex, signSigningString, verifySigningString } from "./crypto.mjs";
import {
  AUDIT_RETENTION_MS,
  ENROLLMENT_RESULT_RETENTION_MS,
  EVENT_RETENTION_MS,
  EVENT_ROLLUP_AFTER_MS,
  HEARTBEAT_CADENCE_SECONDS_DEFAULT,
  HEARTBEAT_LOST_MS,
  HEARTBEAT_MISSED_BEATS_STALE,
  MACHINE_V1_LABEL,
  NONCE_PATTERN,
  NODE_ID_PATTERN,
  NONCE_RETENTION_MS,
  PUBLIC_KEY_PATTERN,
  REENROLL_V1_LABEL,
  REQUEST_ID_PATTERN,
  REPORT_RETENTION_MS,
  REPORT_STALENESS_MS,
  ROTATION_OVERLAP_HOURS_DEFAULT,
  ROTATION_OVERLAP_HOURS_MAX,
  ROTATION_OVERLAP_HOURS_MIN,
  SESSION_IDLE_MS,
  SESSION_TTL_MS,
  SIGNATURE_PATTERN,
  SIGNATURE_SKEW_SECONDS,
  TOKEN_PATTERN,
  TOKEN_TTL_SECONDS_DEFAULT,
  TOKEN_TTL_SECONDS_MAX,
  TOKEN_TTL_SECONDS_MIN,
  buildSigningString,
  requireHex,
} from "./protocol.mjs";
import { nowIso, withTransaction } from "./sqlite.mjs";

export class DeniedError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function denied(status, code, message) {
  throw new DeniedError(status, code, message);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    denied(400, "bad-request", `${label} is required`);
  }
  return value;
}

// protocol.mjs requireHex validates and returns an Error; here it is
// converted to the wire-contract denial.
function requireWire(value, pattern, label) {
  const error = requireHex(value, pattern, label);
  if (error) denied(400, "bad-request", error.message);
  return value;
}

function parseJsonBody(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch {
    denied(400, "bad-json", "request body must be valid JSON");
  }
}

function requireIdentityJson(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body) || typeof body.runtime !== "object" || body.runtime === null) {
    denied(400, "bad-request", "heartbeat body must be { runtime: { orbitVersion, orbitRevision?, dshVersion, compatibilityProfile? } }");
  }
  const runtime = body.runtime;
  const orbitVersion = requireString(runtime.orbitVersion, "runtime.orbitVersion");
  const dshVersion = requireString(runtime.dshVersion, "runtime.dshVersion");
  const revision = typeof runtime.orbitRevision === "string" && runtime.orbitRevision !== "" ? runtime.orbitRevision : null;
  const profile = typeof runtime.compatibilityProfile === "string" && runtime.compatibilityProfile !== "" ? runtime.compatibilityProfile : null;
  return { orbitVersion, orbitRevision: revision, dshVersion, compatibilityProfile: profile };
}

export class Registry {
  constructor({
    db,
    now = () => new Date(),
    registryContactNow = null,
    heartbeatCadenceSeconds = HEARTBEAT_CADENCE_SECONDS_DEFAULT,
    rotationOverlapHours = ROTATION_OVERLAP_HOURS_DEFAULT,
  }) {
    this.db = db;
    this.now = now;
    this.registryContactNow = registryContactNow ?? (() => this.now());
    this.heartbeatCadenceSeconds = heartbeatCadenceSeconds;
    if (rotationOverlapHours < ROTATION_OVERLAP_HOURS_MIN || rotationOverlapHours > ROTATION_OVERLAP_HOURS_MAX) {
      throw new Error(`rotation overlap must be within ${ROTATION_OVERLAP_HOURS_MIN}-${ROTATION_OVERLAP_HOURS_MAX} hours`);
    }
    this.rotationOverlapHours = rotationOverlapHours;
  }

  // ------------------------------------------------------------------
  // Enrollment tokens (RFC-0005 D2 / RFC-0007 hub.tokens.create and
  // hub.nodes.reenroll): digest-only persistence, plaintext returned once.

  mintEnrollmentToken({ actor, purpose, boundNodeId = null, ttlSeconds = TOKEN_TTL_SECONDS_DEFAULT }) {
    if (purpose !== "enroll" && purpose !== "reenroll") {
      denied(400, "bad-request", `token purpose must be enroll or reenroll (got ${JSON.stringify(purpose)})`);
    }
    // RFC-0005 D2: TTL is fixed at 1-60 minutes, integer only; anything
    // else fails closed (an enrollment token must stay short-lived).
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < TOKEN_TTL_SECONDS_MIN || ttlSeconds > TOKEN_TTL_SECONDS_MAX) {
      denied(
        400,
        "bad-request",
        `token TTL must be an integer between ${TOKEN_TTL_SECONDS_MIN} and ${TOKEN_TTL_SECONDS_MAX} seconds`,
      );
    }
    if (purpose === "reenroll") {
      const node = this.getNodeRow(requireString(boundNodeId, "boundNodeId"));
      if (!node || node.state !== "tombstoned") {
        denied(409, "not-tombstoned", "re-enrollment tokens can only be minted for a tombstoned nodeId");
      }
    } else if (boundNodeId !== null) {
      denied(400, "bad-request", "enroll-purpose tokens must not carry boundNodeId");
    }
    const plaintextToken = randomHex(16);
    const tokenId = `etok_${randomHex(8)}`;
    const digest = sha256Hex(plaintextToken);
    const createdAt = nowIso(this.now());
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000).toISOString();
    this.db.prepare(
      "INSERT INTO enrollment_tokens (token_id, token_digest, purpose, bound_node_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(tokenId, digest, purpose, boundNodeId, createdAt, expiresAt);
    this.recordAudit(actor, "hub.tokens.create", { tokenId, purpose, boundNodeId, expiresAt });
    return { tokenId, token: plaintextToken, expiresAt, purpose, boundNodeId };
  }

  listTokens() {
    const rows = this.db
      .prepare(
        "SELECT token_id, purpose, bound_node_id, created_at, expires_at, consumed_at FROM enrollment_tokens ORDER BY created_at DESC",
      )
      .all();
    return rows.map((row) => ({
      tokenId: row.token_id,
      purpose: row.purpose,
      boundNodeId: row.bound_node_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      // Token history semantics (P2-03): the list carries explicit
      // status so consumers never infer it from timestamps.
      status: row.consumed_at !== null ? "consumed" : row.expires_at <= nowIso(this.now()) ? "expired" : "active",
    }));
  }

  // ------------------------------------------------------------------
  // Machine authentication (RFC-0006): key resolution, signature
  // verification, timestamp skew, then the transactional nonce
  // reservation. Business side effects run afterwards in their own
  // transactions and never release the reservation.

  authenticateMachine({ nodeId, keyId, method, path, timestamp, nonce, bodyHash, signature }) {
    requireString(nodeId, "X-Orbit-Node");
    requireString(keyId, "X-Orbit-Key");
    requireString(signature, "X-Orbit-Signature");
    requireWire(nonce, NONCE_PATTERN, "X-Orbit-Nonce");
    requireWire(signature, SIGNATURE_PATTERN, "X-Orbit-Signature");
    requireWire(keyId, /^[0-9a-f]{32}$/, "X-Orbit-Key");
    if (!NODE_ID_PATTERN.test(nodeId)) {
      denied(400, "bad-request", "X-Orbit-Node must be a node_ identifier");
    }
    if (!/^-?\d+$/.test(String(timestamp))) {
      denied(400, "bad-request", "X-Orbit-Timestamp must be an integer Unix epoch string");
    }
    const timestampSeconds = Number(timestamp);
    if (Math.abs(this.now().getTime() / 1000 - timestampSeconds) > SIGNATURE_SKEW_SECONDS) {
      denied(401, "timestamp-out-of-skew", "X-Orbit-Timestamp is outside the 30s skew window");
    }

    const node = this.getNodeRow(nodeId);
    if (!node || node.state !== "active") {
      denied(401, "revoked", "node is not an active registry member");
    }
    const key = this.deriveKeyRow(nodeId, keyId);
    if (!key) {
      denied(401, "unknown-key", "unknown keyId");
    }
    if (key.state !== "active" || (key.revoke_after !== null && key.revoke_after <= nowIso(this.now()))) {
      denied(401, "key-revoked", "keyId is revoked or past its rotation overlap");
    }

    const signingString = buildSigningString({ label: MACHINE_V1_LABEL, method, path, timestamp: String(timestamp), nonce, bodyHash, nodeId });
    if (!verifySigningString(key.public_key, signingString, signature)) {
      denied(401, "signature-invalid", "signature does not verify over the ORBIT-MACHINE-V1 signing string");
    }

    this.reserveNonce(nodeId, nonce);
    return { node, key };
  }

  // The nonce reservation is its own atomic unit and is never rolled
  // back by later business outcomes (RFC-0006).
  reserveNonce(nodeId, nonce) {
    try {
      withTransaction(this.db, () => {
        this.db.prepare("INSERT INTO seen_nonces (node_id, nonce, created_at) VALUES (?, ?, ?)").run(nodeId, nonce, nowIso(this.now()));
      });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        denied(401, "replay", "nonce already used for this node");
      }
      throw error;
    }
  }

  deriveKeyRow(nodeId, keyId) {
    return this.db.prepare("SELECT * FROM node_keys WHERE node_id = ? AND key_id = ?").get(nodeId, keyId);
  }

  getNodeRow(nodeId) {
    return this.db.prepare("SELECT * FROM nodes WHERE node_id = ?").get(nodeId);
  }

  getLatestReport(nodeId) {
    // Deterministic latest-report ordering (round-2 P1): same-millisecond
    // uploads resolve by insertion id, never by clock ambiguity.
    return this.db
      .prepare("SELECT * FROM reports WHERE node_id = ? ORDER BY uploaded_at DESC, id DESC LIMIT 1")
      .get(nodeId);
  }

  recordEvent(nodeId, dimension, fromValue, toValue, source) {
    if (fromValue === toValue) return;
    this.db
      .prepare("INSERT INTO events (node_id, at, dimension, from_value, to_value, source) VALUES (?, ?, ?, ?, ?, ?)")
      .run(nodeId, nowIso(this.now()), dimension, fromValue, toValue, source);
  }

  recordAudit(actor, action, detail) {
    this.db
      .prepare("INSERT INTO audit (at, actor, action, detail_json) VALUES (?, ?, ?, ?)")
      .run(nowIso(this.now()), actor, action, JSON.stringify(detail ?? {}));
  }

  // ------------------------------------------------------------------
  // Enrollment (RFC-0005 D2): one-time, purpose-checked, idempotent.

  enroll({ token, enrollmentRequestId, publicKey, actor = "system" }) {
    requireString(token, "token");
    requireString(enrollmentRequestId, "enrollmentRequestId");
    requireString(publicKey, "publicKey");
    requireWire(token, TOKEN_PATTERN, "token");
    requireWire(enrollmentRequestId, REQUEST_ID_PATTERN, "enrollmentRequestId");
    requireWire(publicKey, PUBLIC_KEY_PATTERN, "publicKey");

    const entry = this.db.prepare("SELECT * FROM enrollment_tokens WHERE token_digest = ?").get(sha256Hex(token));
    if (!entry) {
      denied(401, "unknown-token", "no enrollment token matches");
    }
    if (entry.purpose !== "enroll") {
      denied(400, "purpose-mismatch", "token is not an enroll-purpose token");
    }
    // A consumed token is judged by the recorded idempotency result
    // FIRST: an exact successful replay is served even past token
    // expiry, because TTL governs first-time acceptance only
    // (RFC-0005 D2).
    if (entry.consumed_at !== null) {
      return this.replayOrDeny(entry, "enroll", `${entry.token_digest}:${enrollmentRequestId}:${publicKey}`);
    }
    if (entry.expires_at <= nowIso(this.now())) {
      denied(401, "token-expired", "enrollment token has expired");
    }

    const keyId = deriveKeyId(publicKey);
    const recorded = this.db
      .prepare("SELECT * FROM enrollment_results WHERE idempotency_key = ? AND kind = 'enroll'")
      .get(`${entry.token_digest}:${enrollmentRequestId}:${publicKey}`);
    if (recorded) {
      return JSON.parse(recorded.result_json);
    }

    const result = withTransaction(this.db, () => {
      const fresh = this.db.prepare("SELECT consumed_at FROM enrollment_tokens WHERE token_id = ?").get(entry.token_id);
      if (fresh.consumed_at !== null) {
        return this.replayOrDeny(entry, "enroll", `${entry.token_digest}:${enrollmentRequestId}:${publicKey}`);
      }
      const nodeId = `node_${randomHex(16)}`;
      const at = nowIso(this.now());
      this.db.prepare("UPDATE enrollment_tokens SET consumed_at = ?, consumed_by = ? WHERE token_id = ?").run(at, nodeId, entry.token_id);
      this.db
        .prepare(
          "INSERT INTO nodes (node_id, state, minted_at, authenticated, capabilities, capabilities_stale) VALUES (?, 'active', ?, 'ok', '[]', 1)",
        )
        .run(nodeId, at);
      this.db
        .prepare("INSERT INTO node_keys (node_id, key_id, public_key, state, created_at) VALUES (?, ?, ?, 'active', ?)")
        .run(nodeId, keyId, publicKey, at);
      const resultJson = JSON.stringify({ nodeId, keyId, tokenId: entry.token_id, registryContact: this.registryContactParameters() });
      this.db
        .prepare(
          "INSERT INTO enrollment_results (idempotency_key, token_digest, request_id, kind, node_id, result_json, created_at) VALUES (?, ?, ?, 'enroll', ?, ?, ?)",
        )
        .run(`${entry.token_digest}:${enrollmentRequestId}:${publicKey}`, entry.token_digest, enrollmentRequestId, nodeId, resultJson, at);
      this.recordAudit(`${actor}:${nodeId}`, "node.enrolled", { nodeId, keyId, tokenId: entry.token_id });
      return JSON.parse(resultJson);
    });
    return result;
  }

  registryContactParameters() {
    return { heartbeatCadenceSeconds: this.heartbeatCadenceSeconds };
  }

  // ------------------------------------------------------------------
  // Tombstone re-enrollment completion (RFC-0005 D5 / RFC-0006
  // ORBIT-REENROLL-V1): the ONLY route that verifies with a revoked
  // historical key, and only as a possession proof. Every failure
  // consumes nothing; success is a single BEGIN IMMEDIATE transaction.

  reenroll({ token, reenrollmentRequestId, newPublicKey, nodeId, keyId, method, path, timestamp, nonce, bodyHash, signature, actor = "system" }) {
    requireString(token, "token");
    requireString(reenrollmentRequestId, "reenrollmentRequestId");
    requireString(newPublicKey, "newPublicKey");
    requireString(nodeId, "nodeId");
    requireString(keyId, "X-Orbit-Key");
    requireWire(token, TOKEN_PATTERN, "token");
    requireWire(reenrollmentRequestId, REQUEST_ID_PATTERN, "reenrollmentRequestId");
    requireWire(newPublicKey, PUBLIC_KEY_PATTERN, "newPublicKey");
    requireWire(nonce, NONCE_PATTERN, "X-Orbit-Nonce");
    requireWire(signature, SIGNATURE_PATTERN, "X-Orbit-Signature");
    if (!NODE_ID_PATTERN.test(nodeId)) {
      denied(400, "bad-request", "nodeId must be a node_ identifier");
    }
    if (!/^-?\d+$/.test(String(timestamp))) {
      denied(400, "bad-request", "timestamp must be an integer Unix epoch string");
    }
    if (Math.abs(this.now().getTime() / 1000 - Number(timestamp)) > SIGNATURE_SKEW_SECONDS) {
      denied(401, "timestamp-out-of-skew", "timestamp is outside the 30s skew window");
    }

    const entry = this.db.prepare("SELECT * FROM enrollment_tokens WHERE token_digest = ?").get(sha256Hex(token));
    if (!entry) {
      denied(401, "unknown-token", "no re-enrollment token matches");
    }
    if (entry.purpose !== "reenroll") {
      denied(400, "purpose-mismatch", "token is not a reenroll-purpose token");
    }
    if (entry.bound_node_id !== nodeId) {
      denied(403, "token-node-mismatch", "token is bound to a different nodeId");
    }
    // Consumed-token replays are judged on the recorded idempotency
    // result before expiry (RFC-0005 D2 applies to re-enrollment too).
    const idempotencyKey = `${entry.token_digest}:${reenrollmentRequestId}:${nodeId}:${newPublicKey}`;
    if (entry.consumed_at !== null) {
      return this.replayOrDeny(entry, "reenroll", idempotencyKey);
    }
    if (entry.expires_at <= nowIso(this.now())) {
      denied(401, "token-expired", "re-enrollment token has expired");
    }

    const node = this.getNodeRow(nodeId);
    if (!node || node.state !== "tombstoned") {
      denied(409, "not-tombstoned", "nodeId is not tombstoned");
    }
    const historicalKey = this.db
      .prepare("SELECT * FROM node_keys WHERE node_id = ? AND state = 'revoked' ORDER BY created_at DESC LIMIT 1")
      .get(nodeId);
    if (!historicalKey) {
      denied(500, "missing-historical-key", "tombstone has no retained public key");
    }
    requireWire(keyId, /^[0-9a-f]{32}$/, "X-Orbit-Key");
    // X-Orbit-Key must name the tombstone-retained historical key: the
    // revoked-key exception is confined to exactly this key, and only
    // for the possession proof (RFC-0006).
    if (keyId !== historicalKey.key_id) {
      denied(401, "key-revoked", "only the tombstone-retained historical key verifies the possession proof");
    }

    const signingString = buildSigningString({
      label: REENROLL_V1_LABEL,
      method,
      path,
      timestamp: String(timestamp),
      nonce,
      bodyHash,
      nodeId,
    });
    if (!verifySigningString(historicalKey.public_key, signingString, signature)) {
      denied(401, "possession-proof-failed", "ORBIT-REENROLL-V1 proof does not verify with the original node private key");
    }

    const recorded = this.db.prepare("SELECT * FROM enrollment_results WHERE idempotency_key = ? AND kind = 'reenroll'").get(idempotencyKey);
    if (recorded) {
      return JSON.parse(recorded.result_json);
    }

    const newKeyId = deriveKeyId(newPublicKey);
    const result = withTransaction(this.db, () => {
      const fresh = this.db.prepare("SELECT consumed_at FROM enrollment_tokens WHERE token_id = ?").get(entry.token_id);
      if (fresh.consumed_at !== null) {
        return this.replayOrDeny(entry, "reenroll", idempotencyKey);
      }
      // Nonce reservation lives inside the success transaction; a
      // failed proof consumed nothing before this point (RFC-0006).
      try {
        this.db
          .prepare("INSERT INTO seen_nonces (node_id, nonce, created_at) VALUES (?, ?, ?)")
          .run(nodeId, nonce, nowIso(this.now()));
      } catch (error) {
        if (String(error.message).includes("UNIQUE")) {
          denied(401, "replay", "nonce already used for this node");
        }
        throw error;
      }
      const at = nowIso(this.now());
      this.db.prepare("UPDATE enrollment_tokens SET consumed_at = ?, consumed_by = ? WHERE token_id = ?").run(at, nodeId, entry.token_id);
      const resultJson = JSON.stringify({ nodeId, keyId: newKeyId, tokenId: entry.token_id, registryContact: this.registryContactParameters() });
      this.db
        .prepare(
          "INSERT INTO enrollment_results (idempotency_key, token_digest, request_id, kind, node_id, result_json, created_at) VALUES (?, ?, ?, 'reenroll', ?, ?, ?)",
        )
        .run(idempotencyKey, entry.token_digest, reenrollmentRequestId, nodeId, resultJson, at);
      this.db
        .prepare("INSERT INTO node_keys (node_id, key_id, public_key, state, created_at) VALUES (?, ?, ?, 'active', ?)")
        .run(nodeId, newKeyId, newPublicKey, at);
      this.db
        .prepare(
          "UPDATE nodes SET state = 'active', tombstoned_at = NULL, tombstone_reason = NULL, minted_at = ?, registry_contact = 'unknown', authenticated = 'ok', dsh_healthy = 'unknown', orbit_compatible = 'unknown', reachable = 'unknown', capabilities = '[]', capabilities_stale = 1, last_seen = NULL, last_seen_source = NULL, orbit_version = '', orbit_revision = NULL, dsh_version = '', compatibility_profile = NULL WHERE node_id = ?",
        )
        .run(at, nodeId);
      // The historical key permanently stays revoked: it verified the
      // possession proof and authorizes nothing else.
      this.db.prepare("UPDATE node_keys SET revocation_reason = 'reenroll-possession' WHERE node_id = ? AND key_id = ?").run(nodeId, historicalKey.key_id);
      this.recordAudit(`${actor}:${nodeId}`, "node.reenrolled", { nodeId, newKeyId, oldKeyId: historicalKey.key_id });
      this.recordEvent(nodeId, "state", "tombstoned", "active", "reenroll");
      return JSON.parse(resultJson);
    });
    return result;
  }

  // An enrollment/re-enrollment token consumed by the exact same
  // idempotency content returns the recorded result (RFC-0005 D2);
  // any other content is denied.
  replayOrDeny(entry, kind, idempotencyKey) {
    const recorded = this.db.prepare("SELECT * FROM enrollment_results WHERE idempotency_key = ? AND kind = ?").get(idempotencyKey, kind);
    if (recorded && recorded.token_digest === entry.token_digest) {
      return JSON.parse(recorded.result_json);
    }
    denied(401, "token-consumed", "token already consumed by a different enrollment");
  }

  // ------------------------------------------------------------------
  // Heartbeat (RFC-0006 route, RFC-0009 semantics): moves registryContact
  // and lastSeen only; never touches reachable; carries non-authoritative
  // runtime identity; never capabilities. The authenticated variant runs
  // after the machine authentication (including the nonce reservation),
  // so protocol-level rate limiting in the transport can act on
  // authenticated requests without replaying them (RFC-0006).

  heartbeat({ nodeId, keyId, method, path, timestamp, nonce, bodyHash, signature, rawBody }) {
    const auth = this.authenticateMachine({ nodeId, keyId, method, path, timestamp, nonce, bodyHash, signature });
    return this.heartbeatAuthenticated({ node: auth.node, rawBody });
  }

  // The heartbeat is the authoritative writer of the current runtime
  // identity AND of registryContact: it updates lastHeartbeatAt and
  // lastSeen. A report upload never moves registryContact and never
  // clears the contact-lost alert flag (round-2 P1).
  heartbeatAuthenticated({ node, rawBody }) {
    const runtime = requireIdentityJson(parseJsonBody(rawBody));
    const nodeId = node.node_id;
    withTransaction(this.db, () => {
      const current = this.getNodeRow(nodeId);
      this.transitionRegistryContact(current, "fresh", "heartbeat");
      this.clearAlertFlag(nodeId, "contact-lost");
      const at = nowIso(this.now());
      this.db
        .prepare(
          "UPDATE nodes SET last_seen = ?, last_seen_source = 'heartbeat', last_heartbeat_at = ?, orbit_version = ?, orbit_revision = ?, dsh_version = ?, compatibility_profile = ? WHERE node_id = ?",
        )
        .run(at, at, runtime.orbitVersion, runtime.orbitRevision, runtime.dshVersion, runtime.compatibilityProfile, nodeId);
      const latest = this.getLatestReport(nodeId);
      if (latest) {
        const identity = JSON.parse(latest.identity_json);
        if (!identityMatches(identity, runtime)) {
          this.withholdCapabilities(nodeId, "heartbeat");
        }
      }
    });
    return { ok: true, registryContact: "fresh", heartbeatCadenceSeconds: this.heartbeatCadenceSeconds };
  }

  // Active capability withholding (RFC-0009 "withheld until refreshed"
  // and P1-04): stale evidence yields an empty active set, an explicit
  // stale compatibility state, and unknown dshHealthy; the change ends
  // only with a fresh report upload.
  withholdCapabilities(nodeId, source) {
    const current = this.getNodeRow(nodeId);
    if (current.orbit_compatible === "pass" || current.orbit_compatible === "unknown") {
      this.transitionDimension(nodeId, "orbit_compatible", "stale", source);
    }
    this.transitionDimension(nodeId, "dsh_healthy", "unknown", source);
    this.db
      .prepare("UPDATE nodes SET orbit_compatible = CASE WHEN orbit_compatible IN ('pass', 'unknown') THEN 'stale' ELSE orbit_compatible END, dsh_healthy = 'unknown', capabilities_stale = 1 WHERE node_id = ?")
      .run(nodeId);
  }

  transitionRegistryContact(node, toValue, source) {
    const nowMs = this.now().getTime();
    const lastBeatMs = node.last_heartbeat_at ? Date.parse(node.last_heartbeat_at) : null;
    let fromValue = node.registry_contact;
    if (lastBeatMs !== null && nowMs - lastBeatMs > HEARTBEAT_LOST_MS && fromValue !== "lost") {
      fromValue = "lost";
    } else if (
      lastBeatMs !== null &&
      nowMs - lastBeatMs > HEARTBEAT_MISSED_BEATS_STALE * this.heartbeatCadenceSeconds * 1000 &&
      fromValue === "fresh"
    ) {
      fromValue = "stale";
    }
    this.transitionDimension(node.node_id, "registry_contact", toValue, source, fromValue);
    this.db.prepare("UPDATE nodes SET registry_contact = ? WHERE node_id = ?").run(toValue, node.node_id);
  }

  transitionDimension(nodeId, column, toValue, source, fromOverride) {
    const node = this.getNodeRow(nodeId);
    const fromValue = fromOverride ?? node[column];
    if (fromValue === toValue) return;
    this.recordEvent(nodeId, column, String(fromValue), toValue, source);
  }

  getAlertFlags(nodeId) {
    const node = this.getNodeRow(nodeId);
    if (!node) return [];
    try {
      const flags = JSON.parse(node.alert_flags);
      return Array.isArray(flags) ? flags : [];
    } catch {
      return [];
    }
  }

  setAlertFlag(nodeId, flag) {
    const flags = this.getAlertFlags(nodeId);
    if (flags.includes(flag)) return;
    flags.push(flag);
    this.db.prepare("UPDATE nodes SET alert_flags = ? WHERE node_id = ?").run(JSON.stringify(flags), nodeId);
  }

  clearAlertFlag(nodeId, flag) {
    const flags = this.getAlertFlags(nodeId);
    if (!flags.includes(flag)) return;
    this.db.prepare("UPDATE nodes SET alert_flags = ? WHERE node_id = ?").run(JSON.stringify(flags.filter((entry) => entry !== flag)), nodeId);
  }

  // ------------------------------------------------------------------
  // Compatiblity report upload (RFC-0006 route; RFC-0009 capability and
  // health derivation). The report is re-sanitized with the v0.2
  // schema; capabilities derive from it, and only from it.

  uploadReport({ nodeId, keyId, method, path, timestamp, nonce, bodyHash, signature, rawBody }) {
    const auth = this.authenticateMachine({ nodeId, keyId, method, path, timestamp, nonce, bodyHash, signature });
    return this.uploadReportAuthenticated({ node: auth.node, rawBody });
  }

  uploadReportAuthenticated({ node, rawBody }) {
    const nodeId = node.node_id;
    const input = parseJsonBody(rawBody);
    let report;
    try {
      report = createCompatibilityReport(input);
    } catch (error) {
      denied(400, "invalid-report", error.message);
    }
    const identity = reportIdentity(report);
    // Authority model (P1-05): heartbeat owns the current runtime
    // identity. A report only initializes it when no heartbeat has ever
    // arrived (enrollment -> first report); once heartbeats exist, a
    // mismatching report is stored as history but never overwrites the
    // runtime identity, and the evidence is withheld.
    const current = this.getNodeRow(nodeId);
    const runtime = {
      orbitVersion: current.orbit_version,
      orbitRevision: current.orbit_revision,
      dshVersion: current.dsh_version,
      compatibilityProfile: current.compatibility_profile,
    };
    const runtimeUnset = runtime.orbitVersion === "" || runtime.orbitVersion === null;
    const fresh = runtimeUnset || identityMatches(identity, runtime);

    withTransaction(this.db, () => {
      const at = nowIso(this.now());
      const inserted = this.db
        .prepare(
          "INSERT INTO reports (node_id, uploaded_at, orbit_version, orbit_revision, dsh_version, compatibility_profile, compatibility, identity_json, checks_json, report_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .get(
          nodeId,
          at,
          report.orbit.version,
          report.orbit.revision ?? null,
          report.candidate.dshVersion,
          report.candidate.profile ?? null,
          report.compatibility.outcome,
          JSON.stringify(identity),
          JSON.stringify(report.checks),
          JSON.stringify(report),
        );
      // RFC-0009: EVERY report upload is an event, including identical
      // re-uploads (round-2 P2).
      this.db
        .prepare("INSERT INTO events (node_id, at, dimension, from_value, to_value, source) VALUES (?, ?, 'report', 'uploaded', ?, 'report-upload')")
        .run(nodeId, at, String(inserted.id));
      const capabilities = deriveCapabilities(report);
      const dshHealthy = fresh ? deriveDshHealthy(report) : "unknown";
      const orbitCompatible = fresh ? deriveOrbitCompatible(report) : "stale";
      this.transitionDimension(nodeId, "dsh_healthy", dshHealthy, "report-upload");
      this.transitionDimension(nodeId, "orbit_compatible", orbitCompatible, "report-upload");
      // A report upload is NOT a registry contact: it only updates the
      // generic lastSeen and never moves registryContact (round-2 P1).
      const status = fresh ? 0 : 1;
      if (runtimeUnset) {
        this.db
          .prepare(
            "UPDATE nodes SET last_seen = ?, last_seen_source = 'report-upload', dsh_healthy = ?, orbit_compatible = ?, capabilities = ?, capabilities_stale = ?, orbit_version = ?, orbit_revision = ?, dsh_version = ?, compatibility_profile = ? WHERE node_id = ?",
          )
          .run(
            at,
            dshHealthy,
            orbitCompatible,
            JSON.stringify(capabilities),
            status,
            report.orbit.version,
            report.orbit.revision ?? null,
            report.candidate.dshVersion,
            report.candidate.profile ?? null,
            nodeId,
          );
      } else {
        this.db
          .prepare(
            "UPDATE nodes SET last_seen = ?, last_seen_source = 'report-upload', dsh_healthy = ?, orbit_compatible = ?, capabilities = ?, capabilities_stale = ? WHERE node_id = ?",
          )
          .run(at, dshHealthy, orbitCompatible, JSON.stringify(capabilities), status, nodeId);
      }
      this.recordAudit(`node:${nodeId}`, "node.report-uploaded", { checkCount: Object.keys(report.checks).length, fresh });
    });
    return {
      ok: true,
      capabilities: fresh ? deriveCapabilities(report) : [],
      dshHealthy: fresh ? deriveDshHealthy(report) : "unknown",
      orbitCompatible: fresh ? deriveOrbitCompatible(report) : "stale",
    };
  }

  // ------------------------------------------------------------------
  // Credential rotation (RFC-0006): the new public key is introduced by
  // a request signed with the old private key, with a bounded overlap.

  rotateCredential({ nodeId, keyId, method, path, timestamp, nonce, bodyHash, signature, rawBody }) {
    const auth = this.authenticateMachine({ nodeId, keyId, method, path, timestamp, nonce, bodyHash, signature });
    return this.rotateCredentialAuthenticated({ node: auth.node, key: auth.key, rawBody });
  }

  rotateCredentialAuthenticated({ node, key, rawBody }) {
    const nodeId = node.node_id;
    const body = parseJsonBody(rawBody);
    const newPublicKey = requireString(body.newPublicKey, "newPublicKey");
    requireWire(newPublicKey, PUBLIC_KEY_PATTERN, "newPublicKey");
    const newKeyId = deriveKeyId(newPublicKey);
    if (newKeyId === key.key_id) {
      denied(400, "bad-request", "newPublicKey must differ from the current key");
    }
    const overlapMs = this.rotationOverlapHours * 60 * 60 * 1000;
    const at = nowIso(this.now());
    const revokeAfter = new Date(this.now().getTime() + overlapMs).toISOString();
    withTransaction(this.db, () => {
      this.db.prepare("UPDATE node_keys SET revoke_after = ? WHERE node_id = ? AND key_id = ?").run(revokeAfter, nodeId, key.key_id);
      this.db
        .prepare("INSERT INTO node_keys (node_id, key_id, public_key, state, created_at, revoke_after) VALUES (?, ?, ?, 'active', ?, NULL)")
        .run(nodeId, newKeyId, newPublicKey, at);
      this.recordAudit(`node:${nodeId}`, "node.credential-rotated", { oldKeyId: key.key_id, newKeyId, overlapUntil: revokeAfter });
    });
    return { oldKeyId: key.key_id, newKeyId, overlapUntil: revokeAfter };
  }

  // ------------------------------------------------------------------
  // Node lifecycle (RFC-0005 D5/D6, RFC-0009 deletion retention).
  //
  // Destructive deletes require confirmation semantics: a client
  // requestId (RFC-0007 matrix "delete without confirmation semantics
  // (idempotency key) -> denied"). The completion is recorded in the
  // audit trail; exact replays return the same result, the same
  // requestId with different content is denied, and a second delete of
  // the same node with a fresh requestId stays a 409.

  deleteNode({ actor, nodeId, requestId, reason }) {
    requireString(nodeId, "nodeId");
    requireString(requestId, "requestId");
    requireString(reason, "reason");
    if (REQUEST_ID_PATTERN.test(requestId) === false) {
      denied(400, "bad-request", "delete requestId must be 32 lowercase hex characters");
    }
    const node = this.getNodeRow(nodeId);
    if (!node) {
      denied(404, "not-found", "no such node");
    }
    const prior = this.db
      .prepare(
        "SELECT detail_json FROM audit WHERE action = 'hub.nodes.delete' AND json_extract(detail_json, '$.requestId') = ?",
      )
      .all(requestId);
    // requestId is globally unique among operator deletes: a replay must
    // match node AND content; any other reuse is denied.
    for (const row of prior) {
      const detail = JSON.parse(row.detail_json);
      if (detail.nodeId === nodeId && detail.reason === reason) {
        return { nodeId, state: "tombstoned", idempotentReplay: true };
      }
      denied(409, "request-id-reused", "requestId was already used for a different delete");
    }
    if (node.state === "tombstoned") {
      denied(409, "already-tombstoned", "node is already tombstoned");
    }
    withTransaction(this.db, () => {
      const at = nowIso(this.now());
      this.db
        .prepare("UPDATE nodes SET state = 'tombstoned', tombstoned_at = ?, tombstone_reason = ?, authenticated = 'revoked' WHERE node_id = ?")
        .run(at, reason, nodeId);
      // Immediate revocation; reports/events/audit are never deleted.
      this.db
        .prepare("UPDATE node_keys SET state = 'revoked', revoked_at = ?, revocation_reason = 'node-delete' WHERE node_id = ? AND state = 'active'")
        .run(at, nodeId);
      this.recordAudit(actor, "hub.nodes.delete", { nodeId, reason, requestId });
      this.recordEvent(nodeId, "state", "active", "tombstoned", "operator-delete");
    });
    return { nodeId, state: "tombstoned", idempotentReplay: false };
  }

  listNodes() {
    return this.db.prepare("SELECT * FROM nodes ORDER BY minted_at").all().map((row) => this.toNodeSummary(row));
  }

  getNode(nodeId) {
    const row = this.getNodeRow(nodeId);
    if (!row) {
      denied(404, "not-found", "no such node");
    }
    const latest = this.getLatestReport(nodeId);
    const events = this.db.prepare("SELECT * FROM events WHERE node_id = ? ORDER BY at DESC LIMIT 50").all(nodeId);
    return {
      ...this.toNodeSummary(row),
      latestReport: latest
        ? {
            uploadedAt: latest.uploaded_at,
            orbit: { version: latest.orbit_version, revision: latest.orbit_revision },
            candidate: { dshVersion: latest.dsh_version, profile: latest.compatibility_profile },
            compatibility: latest.compatibility,
          }
        : null,
      events: events.map((event) => ({ at: event.at, dimension: event.dimension, from: event.from_value, to: event.to_value, source: event.source })),
    };
  }

  toNodeSummary(row) {
    const storedCapabilities = JSON.parse(row.capabilities);
    let parsedAlertFlags = [];
    try {
      const flags = JSON.parse(row.alert_flags);
      if (Array.isArray(flags)) parsedAlertFlags = flags;
    } catch {
      // malformed alert_flags -> no flags
    }
    return {
      nodeId: row.node_id,
      state: row.state,
      mintedAt: row.minted_at,
      tombstonedAt: row.tombstoned_at,
      tombstoneReason: row.tombstone_reason,
      health: {
        registryContact: row.registry_contact,
        authenticated: row.authenticated,
        dshHealthy: row.dsh_healthy,
        orbitCompatible: row.orbit_compatible,
        reachable: row.reachable,
        // Withheld semantics (RFC-0009 / P1-04): a stale flag empties the
        // active set; the stored derived set is exposed separately as
        // evidence only.
        capabilities: row.capabilities_stale === 1 ? [] : storedCapabilities,
        capabilityEvidence: storedCapabilities,
        alertFlags: parsedAlertFlags,
        capabilitiesStale: row.capabilities_stale === 1,
        lastSeen: row.last_seen,
        lastSeenSource: row.last_seen_source,
        // The heartbeat clock, surfaced explicitly (Stage 6):
        lastHeartbeatAt: row.last_heartbeat_at ?? null,
      },
      runtimeIdentity: {
        orbitVersion: row.orbit_version,
        orbitRevision: row.orbit_revision,
        dshVersion: row.dsh_version,
        compatibilityProfile: row.compatibility_profile,
      },
    };
  }

  // ------------------------------------------------------------------
  // Browser sessions (RFC-0007): bound to the gateway-verified operator
  // principal only; client IP is never part of the binding. Session
  // mutations and their audit rows share one transaction (RFC-0005 D7).

  bootstrapSession({ principal }) {
    const sessionId = `sess_${randomHex(24)}`;
    const csrfToken = randomHex(24);
    const at = this.now().getTime();
    const expiresAt = new Date(at + SESSION_TTL_MS).toISOString();
    const idleUntil = new Date(at + SESSION_IDLE_MS).toISOString();
    withTransaction(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO browser_sessions (session_id, operator_principal, csrf_token, created_at, expires_at, idle_until) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(sessionId, principal, csrfToken, nowIso(this.now()), expiresAt, idleUntil);
      this.recordAudit(principal, "session.bootstrap", { sessionId });
    });
    return { sessionId, csrfToken, expiresAt, idleUntil };
  }

  validateSession(sessionId) {
    if (typeof sessionId !== "string") return null;
    const row = this.db.prepare("SELECT * FROM browser_sessions WHERE session_id = ?").get(sessionId);
    if (!row) return null;
    const at = this.now().getTime();
    if (row.revoked_at !== null || Date.parse(row.expires_at) <= at || Date.parse(row.idle_until) <= at) {
      return null;
    }
    this.db.prepare("UPDATE browser_sessions SET idle_until = ? WHERE session_id = ?").run(new Date(at + SESSION_IDLE_MS).toISOString(), sessionId);
    return { sessionId: row.session_id, operatorPrincipal: row.operator_principal, csrfToken: row.csrf_token, expiresAt: row.expires_at };
  }

  endSession({ sessionId, actor }) {
    const row = this.db.prepare("SELECT * FROM browser_sessions WHERE session_id = ?").get(sessionId);
    if (!row) return { ok: false };
    withTransaction(this.db, () => {
      this.db.prepare("UPDATE browser_sessions SET revoked_at = ? WHERE session_id = ?").run(nowIso(this.now()), sessionId);
      this.recordAudit(actor, "session.logout", { sessionId });
    });
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Maintenance: time-based semantics that nothing else advances
  // (RFC-0009 aging, RFC-0006 nonce retention, RFC-0005 D2 replay
  // retention, daily event rollups after 7 days, lazy rotation
  // revocation at the end of the overlap window).

  maintenance() {
    const at = this.now().getTime();
    const cutoff = (ms) => new Date(at - ms).toISOString();
    const cadenceMs = this.heartbeatCadenceSeconds * 1000;

    withTransaction(this.db, () => {
      // Rotation overlap expiry: old keys become revoked (RFC-0006).
      const rotated = this.db
        .prepare("SELECT node_id, key_id FROM node_keys WHERE state = 'active' AND revoke_after IS NOT NULL AND revoke_after <= ?")
        .all(nowIso(this.now()));
      for (const row of rotated) {
        this.db
          .prepare("UPDATE node_keys SET state = 'revoked', revoked_at = ?, revocation_reason = 'rotation-overlap-ended' WHERE node_id = ? AND key_id = ?")
          .run(nowIso(this.now()), row.node_id, row.key_id);
      }

      // Nonce and replay retention (RFC-0006 / RFC-0005 D2).
      this.db.prepare("DELETE FROM seen_nonces WHERE created_at <= ?").run(cutoff(NONCE_RETENTION_MS));
      this.db.prepare("DELETE FROM enrollment_results WHERE created_at <= ?").run(cutoff(ENROLLMENT_RESULT_RETENTION_MS));

      // Compatibility report retention (RFC-0009: 90 days). When the
      // LAST report of a node is purged, its derived state returns to
      // unknown: no evidence, no claimed capabilities (round-2 P1).
      this.db.prepare("DELETE FROM reports WHERE uploaded_at <= ?").run(cutoff(REPORT_RETENTION_MS));
      const activeNodes = this.db.prepare("SELECT * FROM nodes WHERE state = 'active'").all();
      for (const node of activeNodes) {
        const latest = this.getLatestReport(node.node_id);
        if (!latest) {
          if (node.capabilities !== "[]" || node.capabilities_stale === 0 || node.orbit_compatible !== "unknown" || node.dsh_healthy !== "unknown") {
            this.transitionDimension(node.node_id, "orbit_compatible", "unknown", "maintenance");
            this.transitionDimension(node.node_id, "dsh_healthy", "unknown", "maintenance");
            this.db
              .prepare("UPDATE nodes SET orbit_compatible = 'unknown', dsh_healthy = 'unknown', capabilities = '[]', capabilities_stale = 1 WHERE node_id = ?")
              .run(node.node_id);
          }
          continue;
        }
        // A report older than 7 days is no longer fresh evidence: the
        // frozen RFC semantics age ANY outcome (pass or fail) to stale;
        // the last failure detail stays visible in latestReport
        // (round-2 P2).
        if (at - Date.parse(latest.uploaded_at) > REPORT_STALENESS_MS) {
          if (node.orbit_compatible === "pass" || node.orbit_compatible === "fail") {
            this.transitionDimension(node.node_id, "orbit_compatible", "stale", "maintenance");
          }
          if (node.dsh_healthy !== "unknown") {
            this.transitionDimension(node.node_id, "dsh_healthy", "unknown", "maintenance");
          }
          this.db
            .prepare(
              "UPDATE nodes SET orbit_compatible = CASE WHEN orbit_compatible IN ('pass', 'fail') THEN 'stale' ELSE orbit_compatible END, dsh_healthy = 'unknown', capabilities_stale = 1 WHERE node_id = ?",
            )
            .run(node.node_id);
        }
      }

      // Daily rollups for events older than 7 days (RFC-0009): each
      // (node, day, dimension) group becomes one summary row. ONLY
      // complete natural days roll up — a day participates when the
      // whole day is already past the cutoff (day < the cutoff's
      // calendar day), so count/final/delete always cover the exact
      // same event set and raw events younger than the cutoff are never
      // deleted early on a partial cutoff day. The summary's final
      // value is the LAST event of that day and dimension by
      // (at DESC, id DESC) — never a string-max of values. Summary
      // rows are excluded from grouping and inserted only when absent,
      // so repeated maintenance runs are strictly idempotent.
      const rollupCutoff = cutoff(EVENT_ROLLUP_AFTER_MS);
      const groups = this.db
        .prepare(
          `SELECT node_id, substr(at, 1, 10) AS day, dimension, COUNT(*) AS count,
                  (SELECT e2.to_value FROM events e2
                    WHERE e2.node_id = e1.node_id
                      AND e2.dimension = e1.dimension
                      AND substr(e2.at, 1, 10) = substr(e1.at, 1, 10)
                    ORDER BY e2.at DESC, e2.id DESC LIMIT 1) AS final_value
             FROM events e1
            WHERE at < ?
              AND dimension != 'rollup'
              AND substr(at, 1, 10) < substr(?, 1, 10)
            GROUP BY node_id, substr(at, 1, 10), dimension`,
        )
        .all(rollupCutoff, rollupCutoff);
      for (const group of groups) {
        const summaryAt = `${group.day}T23:59:59.999Z`;
        const exists = this.db
          .prepare("SELECT id FROM events WHERE node_id = ? AND at = ? AND dimension = 'rollup' AND from_value = ?")
          .get(group.node_id, summaryAt, group.dimension);
        if (exists) continue;
        this.db
          .prepare("DELETE FROM events WHERE node_id = ? AND dimension = ? AND at >= ? AND at < ?")
          .run(group.node_id, group.dimension, `${group.day}T00:00:00.000Z`, summaryAt);
        this.db
          .prepare("INSERT INTO events (node_id, at, dimension, from_value, to_value, source) VALUES (?, ?, 'rollup', ?, ?, 'retention-rollup')")
          .run(group.node_id, summaryAt, group.dimension, JSON.stringify({ count: group.count, final: group.final_value }));
      }
      this.db.prepare("DELETE FROM events WHERE at <= ?").run(cutoff(EVENT_RETENTION_MS));
      this.db.prepare("DELETE FROM audit WHERE at <= ?").run(cutoff(AUDIT_RETENTION_MS));

      // registryContact aging (RFC-0009): 3 consecutive missed beats ->
      // stale; 24h without contact -> lost + operator alert flag.
      // Driven by lastHeartbeatAt ONLY — report uploads are not contact
      // (round-2 P1). Only actual transitions write events.
      const contacted = this.db.prepare("SELECT * FROM nodes WHERE state = 'active' AND last_heartbeat_at IS NOT NULL").all();
      for (const node of contacted) {
        const gapMs = this.registryContactNow(node).getTime() - Date.parse(node.last_heartbeat_at);
        // Maintenance is aging-only. It may advance fresh -> stale -> lost,
        // but it must never make contact healthier when a clock moves
        // backwards (including the mounted-drill aging override reset).
        // Only an authenticated heartbeat restores registryContact=fresh.
        let target = null;
        if (gapMs > HEARTBEAT_LOST_MS && node.registry_contact !== "lost") {
          target = "lost";
        } else if (
          gapMs > HEARTBEAT_MISSED_BEATS_STALE * cadenceMs &&
          node.registry_contact === "fresh"
        ) {
          target = "stale";
        }
        if (target !== null) {
          this.transitionDimension(node.node_id, "registry_contact", target, "maintenance");
          this.db.prepare("UPDATE nodes SET registry_contact = ? WHERE node_id = ?").run(target, node.node_id);
          if (target === "lost") {
            this.setAlertFlag(node.node_id, "contact-lost");
          }
        }
      }

      // Session expiry audit (RFC-0007, round-2 P2): every expired or
      // idle-expired session is audited exactly once, in the same
      // transaction as its marker; the request path never audits.
      const expiredSessions = this.db
        .prepare(
          "SELECT session_id, operator_principal FROM browser_sessions WHERE revoked_at IS NULL AND expiry_audited_at IS NULL AND (expires_at <= ? OR idle_until <= ?)",
        )
        .all(nowIso(this.now()), nowIso(this.now()));
      for (const session of expiredSessions) {
        this.db.prepare("UPDATE browser_sessions SET expiry_audited_at = ? WHERE session_id = ?").run(nowIso(this.now()), session.session_id);
        this.recordAudit(session.operator_principal, "session.expired", { sessionId: session.session_id });
      }
    });
  }

  close() {
    this.db.close();
  }
}

// Re-exported signing helpers for tests and the server's reenroll path.
export { buildSigningString, signSigningString, verifySigningString };