// Domain service for the v0.3 registry (RFC-0005/0006/0007/0009). All
// protocol decisions live in the frozen RFCs; this module implements
// exactly them. HTTP transport and rate limiting live in server.mjs.

import { createCompatibilityReport } from "../compatibility-report.mjs";
import { deriveCapabilities, deriveDshHealthy, deriveOrbitCompatible, identityMatches, reportIdentity } from "./capabilities.mjs";
import { deriveKeyId, randomHex, sha256Hex, signSigningString, verifySigningString } from "./crypto.mjs";
import {
  ENROLLMENT_RESULT_RETENTION_MS,
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
  ROTATION_OVERLAP_HOURS_DEFAULT,
  ROTATION_OVERLAP_HOURS_MAX,
  ROTATION_OVERLAP_HOURS_MIN,
  SESSION_IDLE_MS,
  SESSION_TTL_MS,
  SIGNATURE_PATTERN,
  SIGNATURE_SKEW_SECONDS,
  TOKEN_PATTERN,
  TOKEN_TTL_SECONDS_DEFAULT,
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
  constructor({ db, now = () => new Date(), heartbeatCadenceSeconds = HEARTBEAT_CADENCE_SECONDS_DEFAULT, rotationOverlapHours = ROTATION_OVERLAP_HOURS_DEFAULT }) {
    this.db = db;
    this.now = now;
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
    return this.db.prepare("SELECT * FROM reports WHERE node_id = ? ORDER BY uploaded_at DESC LIMIT 1").get(nodeId);
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
  // runtime identity; never capabilities.

  heartbeat({ nodeId, keyId, method, path, timestamp, nonce, bodyHash, signature, rawBody }) {
    const { key } = this.authenticateMachine({ nodeId, keyId, method, path, timestamp, nonce, bodyHash, signature });
    const runtime = requireIdentityJson(parseJsonBody(rawBody));
    withTransaction(this.db, () => {
      const node = this.getNodeRow(nodeId);
      this.transitionRegistryContact(node, "fresh", "heartbeat");
      const at = nowIso(this.now());
      this.db
        .prepare("UPDATE nodes SET last_seen = ?, last_seen_source = 'heartbeat', orbit_version = ?, orbit_revision = ?, dsh_version = ?, compatibility_profile = ? WHERE node_id = ?")
        .run(at, runtime.orbitVersion, runtime.orbitRevision, runtime.dshVersion, runtime.compatibilityProfile, nodeId);
      const latest = this.getLatestReport(nodeId);
      if (latest) {
        const identity = JSON.parse(latest.identity_json);
        if (!identityMatches(identity, runtime)) {
          this.transitionDimension(nodeId, "orbit_compatible", "stale", "heartbeat");
          this.db.prepare("UPDATE nodes SET orbit_compatible = 'stale' WHERE node_id = ?").run(nodeId);
          const current = this.getNodeRow(nodeId);
          if (current.capabilities_stale !== 1) {
            this.db.prepare("UPDATE nodes SET capabilities_stale = 1 WHERE node_id = ?").run(nodeId);
          }
        }
      }
    });
    return { ok: true, registryContact: "fresh", heartbeatCadenceSeconds: this.heartbeatCadenceSeconds };
  }

  transitionRegistryContact(node, toValue, source) {
    const nowMs = this.now().getTime();
    const lastSeenMs = node.last_seen ? Date.parse(node.last_seen) : null;
    let fromValue = node.registry_contact;
    if (lastSeenMs !== null && nowMs - lastSeenMs > HEARTBEAT_LOST_MS && fromValue !== "lost") {
      fromValue = "lost";
    } else if (
      lastSeenMs !== null &&
      nowMs - lastSeenMs > HEARTBEAT_MISSED_BEATS_STALE * this.heartbeatCadenceSeconds * 1000 &&
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

  // ------------------------------------------------------------------
  // Compatiblity report upload (RFC-0006 route; RFC-0009 capability and
  // health derivation). The report is re-sanitized with the v0.2
  // schema; capabilities derive from it, and only from it.

  uploadReport({ nodeId, keyId, method, path, timestamp, nonce, bodyHash, signature, rawBody }) {
    const { key } = this.authenticateMachine({ nodeId, keyId, method, path, timestamp, nonce, bodyHash, signature });
    const input = parseJsonBody(rawBody);
    let report;
    try {
      report = createCompatibilityReport(input);
    } catch (error) {
      denied(400, "invalid-report", error.message);
    }
    withTransaction(this.db, () => {
      const at = nowIso(this.now());
      this.db
        .prepare(
          "INSERT INTO reports (node_id, uploaded_at, orbit_version, orbit_revision, dsh_version, compatibility_profile, compatibility, identity_json, checks_json, report_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          nodeId,
          at,
          report.orbit.version,
          report.orbit.revision ?? null,
          report.candidate.dshVersion,
          report.candidate.profile ?? null,
          report.compatibility.outcome,
          JSON.stringify(reportIdentity(report)),
          JSON.stringify(report.checks),
          JSON.stringify(report),
        );
      const capabilities = deriveCapabilities(report);
      const dshHealthy = deriveDshHealthy(report);
      const orbitCompatible = deriveOrbitCompatible(report);
      this.transitionDimension(nodeId, "dsh_healthy", dshHealthy, "report-upload");
      this.transitionDimension(nodeId, "orbit_compatible", orbitCompatible, "report-upload");
      this.transitionDimension(nodeId, "registry_contact", "fresh", "report-upload");
      this.db
        .prepare(
          "UPDATE nodes SET last_seen = ?, last_seen_source = 'report-upload', dsh_healthy = ?, orbit_compatible = ?, capabilities = ?, capabilities_stale = 0, registry_contact = 'fresh', orbit_version = ?, orbit_revision = ?, dsh_version = ?, compatibility_profile = ? WHERE node_id = ?",
        )
        .run(
          at,
          dshHealthy,
          orbitCompatible,
          JSON.stringify(capabilities),
          report.orbit.version,
          report.orbit.revision ?? null,
          report.candidate.dshVersion,
          report.candidate.profile ?? null,
          nodeId,
        );
      this.recordAudit(`node:${nodeId}`, "node.report-uploaded", { checkCount: Object.keys(report.checks).length });
    });
    return { ok: true, capabilities: deriveCapabilities(report), dshHealthy: deriveDshHealthy(report), orbitCompatible: deriveOrbitCompatible(report) };
  }

  // ------------------------------------------------------------------
  // Credential rotation (RFC-0006): the new public key is introduced by
  // a request signed with the old private key, with a bounded overlap.

  rotateCredential({ nodeId, keyId, method, path, timestamp, nonce, bodyHash, signature, rawBody }) {
    const { key } = this.authenticateMachine({ nodeId, keyId, method, path, timestamp, nonce, bodyHash, signature });
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

  deleteNode({ actor, nodeId, reason }) {
    const node = this.getNodeRow(nodeId);
    if (!node) {
      denied(404, "not-found", "no such node");
    }
    if (node.state === "tombstoned") {
      denied(409, "already-tombstoned", "node is already tombstoned");
    }
    withTransaction(this.db, () => {
      const at = nowIso(this.now());
      this.db
        .prepare("UPDATE nodes SET state = 'tombstoned', tombstoned_at = ?, tombstone_reason = ?, authenticated = 'revoked' WHERE node_id = ?")
        .run(at, requireString(reason, "reason"), nodeId);
      // Immediate revocation; reports/events/audit are never deleted.
      this.db
        .prepare("UPDATE node_keys SET state = 'revoked', revoked_at = ?, revocation_reason = 'node-delete' WHERE node_id = ? AND state = 'active'")
        .run(at, nodeId);
      this.recordAudit(actor, "hub.nodes.delete", { nodeId, reason });
      this.recordEvent(nodeId, "state", "active", "tombstoned", "operator-delete");
    });
    return { nodeId, state: "tombstoned" };
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
        capabilities: JSON.parse(row.capabilities),
        capabilitiesStale: row.capabilities_stale === 1,
        lastSeen: row.last_seen,
        lastSeenSource: row.last_seen_source,
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
  // principal only; client IP is never part of the binding.

  bootstrapSession({ principal }) {
    const sessionId = `sess_${randomHex(24)}`;
    const csrfToken = randomHex(24);
    const at = this.now().getTime();
    const expiresAt = new Date(at + SESSION_TTL_MS).toISOString();
    const idleUntil = new Date(at + SESSION_IDLE_MS).toISOString();
    this.db
      .prepare(
        "INSERT INTO browser_sessions (session_id, operator_principal, csrf_token, created_at, expires_at, idle_until) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(sessionId, principal, csrfToken, nowIso(this.now()), expiresAt, idleUntil);
    this.recordAudit(principal, "session.bootstrap", { sessionId });
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
    this.db.prepare("UPDATE browser_sessions SET revoked_at = ? WHERE session_id = ?").run(nowIso(this.now()), sessionId);
    this.recordAudit(actor, "session.logout", { sessionId });
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Maintenance: bounded retention everywhere (RFC-0006 seen_nonces
  // purge; RFC-0009 event history; RFC-0005 D2 replay retention; lazy
  // rotation revocation at the end of the overlap window).

  maintenance() {
    const at = this.now().getTime();
    this.db.prepare("DELETE FROM seen_nonces WHERE created_at <= ?").run(new Date(at - NONCE_RETENTION_MS).toISOString());
    this.db.prepare("DELETE FROM events WHERE at <= ?").run(new Date(at - EVENT_RETENTION_MS).toISOString());
    this.db.prepare("DELETE FROM audit WHERE at <= ?").run(new Date(at - AUDIT_RETENTION_MS).toISOString());
    this.db.prepare("DELETE FROM enrollment_results WHERE created_at <= ?").run(new Date(at - ENROLLMENT_RESULT_RETENTION_MS).toISOString());
    const rotated = this.db
      .prepare("SELECT node_id, key_id FROM node_keys WHERE state = 'active' AND revoke_after IS NOT NULL AND revoke_after <= ?")
      .all(nowIso(this.now()));
    for (const row of rotated) {
      this.db
        .prepare("UPDATE node_keys SET state = 'revoked', revoked_at = ?, revocation_reason = 'rotation-overlap-ended' WHERE node_id = ? AND key_id = ?")
        .run(nowIso(this.now()), row.node_id, row.key_id);
    }
  }

  close() {
    this.db.close();
  }
}

// Re-exported signing helpers for tests and the server's reenroll path.
export { buildSigningString, signSigningString, verifySigningString };