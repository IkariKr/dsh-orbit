// Wire-format and protocol constants for the v0.3 registry machine API
// (docs/rfc/0006-registry-machine-api.md, rev. 5). Fixed encodings only:
// no negotiation, no query strings, no canonicalization.

export const MACHINE_V1_LABEL = "ORBIT-MACHINE-V1";
export const REENROLL_V1_LABEL = "ORBIT-REENROLL-V1";

export const SIGNATURE_SKEW_SECONDS = 30;

export const NODE_ID_PATTERN = /^node_[0-9a-f]{32}$/;
export const KEY_ID_PATTERN = /^[0-9a-f]{32}$/;
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;
export const PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/;
export const SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;
export const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
export const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;

export const MACHINE_HEADERS = Object.freeze([
  "x-orbit-node",
  "x-orbit-timestamp",
  "x-orbit-nonce",
  "x-orbit-key",
  "x-orbit-signature",
]);

// Body size limits (fixed): heartbeat/enroll/reenroll/rotate <= 64 KiB,
// report upload <= 16 MiB.
export const BODY_LIMIT_KIB = 64 * 1024;
export const BODY_LIMIT_REPORT = 16 * 1024 * 1024;

// Rate limit defaults (fixed; in-memory sliding windows are acceptable:
// they bound abuse and never affect protocol state).
export const RATE_LIMITS = Object.freeze({
  heartbeat: { perSecond: 1, burst: 3 },
  reportUpload: { perMinute: 10 },
  enrollmentAttemptsPerToken: 10,
  reenrollAttemptsPerToken: 10,
  tokenMintingPerHour: 20,
  perIpPerMinute: 120,
});

export const ROTATION_OVERLAP_HOURS_DEFAULT = 24;
export const ROTATION_OVERLAP_HOURS_MIN = 1;
export const ROTATION_OVERLAP_HOURS_MAX = 168;

export const HEARTBEAT_CADENCE_SECONDS_DEFAULT = 60;

// Registry contact thresholds (RFC-0009): 3 consecutive missed beats ->
// stale; 24h without contact -> lost.
export const HEARTBEAT_MISSED_BEATS_STALE = 3;
export const HEARTBEAT_LOST_MS = 24 * 60 * 60 * 1000;

// Report staleness window (RFC-0009): a report is fresh when uploaded
// within 7 days AND its identity tuple matches the heartbeat identity.
export const REPORT_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;

export const TOKEN_TTL_SECONDS_DEFAULT = 10 * 60;
export const TOKEN_TTL_SECONDS_MIN = 60;
export const TOKEN_TTL_SECONDS_MAX = 60 * 60;

// Replay retention for completed enrollments (RFC-0005 D2), aligned with
// the RFC-0009 event retention.
export const ENROLLMENT_RESULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// seen_nonces purge retention (RFC-0006).
export const NONCE_RETENTION_MS = 24 * 60 * 60 * 1000;

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 30 * 60 * 1000;

export const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
// RFC-0009: daily rollups after 7 days.
export const EVENT_ROLLUP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function buildSigningString({ label, method, path, timestamp, nonce, bodyHash, nodeId }) {
  return [label, method, path, String(timestamp), nonce, bodyHash, nodeId].join("\n");
}

export function requireHex(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    return new Error(`registry wire contract: ${label} must be ${pattern} (got ${JSON.stringify(value)})`);
  }
  return null;
}