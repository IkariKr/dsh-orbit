// Wire-format and protocol constants for the v0.3 registry machine API
// (docs/rfc/0006-registry-machine-api.md, rev. 5). Fixed encodings only:
// no negotiation, no query strings, no canonicalization.

export const MACHINE_V1_LABEL = "ORBIT-MACHINE-V1";
export const REENROLL_V1_LABEL = "ORBIT-REENROLL-V1";
export const ROUTE_V1_LABEL = "ORBIT-ROUTE-V1";

export const SIGNATURE_SKEW_SECONDS = 30;
export const ROUTE_SKEW_MS = 30 * 1000;
export const NONCE_CACHE_RETENTION_MS = 60 * 1000;

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

export const ROUTE_HEADERS = Object.freeze([
  "x-orbit-route-node",
  "x-orbit-route-key",
  "x-orbit-route-timestamp",
  "x-orbit-route-nonce",
  "x-orbit-route-signature",
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

export const HUB_ROUTE_ROTATION_OVERLAP_DAYS_DEFAULT = 14;
export const HUB_ROUTE_ROTATION_OVERLAP_DAYS_MIN = 1;
export const HUB_ROUTE_ROTATION_OVERLAP_DAYS_MAX = 30;

export const ROUTE_PROBE_CADENCE_SECONDS_DEFAULT = 60;
export const ROUTE_PROBE_FAILURE_THRESHOLD = 3;
export const DEFAULT_ROUTE_DOMAIN = "dsh.example.com";

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
// RFC-0009: reports retention 90 days; every report upload is an event.
export const REPORT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// RFC-0009: daily rollups after 7 days.
export const EVENT_ROLLUP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// Hub maintenance cadence: 30s ticks with an immediate run at startup,
// so the default 3x60s stale threshold and the 24h lost threshold are
// actually reachable in production (phase-1 review round 2, P1).
export const MAINTENANCE_TICK_MS = 30 * 1000;

export function buildSigningString({ label, method, path, timestamp, nonce, bodyHash, nodeId }) {
  return [label, method, path, String(timestamp), nonce, bodyHash, nodeId].join("\n");
}

export function buildRouteSigningString({ label = ROUTE_V1_LABEL, nodeId, routeAuthority, method, rawTarget, timestamp, nonce }) {
  return [label, nodeId, routeAuthority, method, rawTarget, String(timestamp), nonce].join("\n");
}

export function validateRouteDomain(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("routeDomain is required");
  }
  const trimmed = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (trimmed.includes("/") || trimmed.includes("?") || trimmed.includes("#") || trimmed.includes("@")) {
    throw new Error(`routeDomain must carry no scheme, path, query, or credentials (got ${JSON.stringify(value)})`);
  }
  if (!/^[a-z0-9.-]+(:[0-9]+)?$/.test(trimmed)) {
    throw new Error(`routeDomain is malformed (got ${JSON.stringify(value)})`);
  }
  return trimmed;
}

export function computeRouteAuthority(nodeId, routeDomain = DEFAULT_ROUTE_DOMAIN) {
  if (typeof nodeId !== "string" || !NODE_ID_PATTERN.test(nodeId)) {
    throw new Error(`invalid nodeId for route authority: ${JSON.stringify(nodeId)}`);
  }
  const cleanDomain = validateRouteDomain(routeDomain);
  const hex = nodeId.slice("node_".length);
  return `n-${hex}.${cleanDomain}`;
}

// RFC 9112 origin-form target validation:
// Must begin with a single "/" and must not begin with "//" (scheme-relative)
// or contain scheme "://" or backslash before the query component.
export function isValidOriginFormTarget(target) {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//")) {
    return false;
  }
  const qIdx = target.indexOf("?");
  const pathOnly = qIdx === -1 ? target : target.slice(0, qIdx);
  if (pathOnly.startsWith("//") || pathOnly.includes("://") || pathOnly.includes("\\")) {
    return false;
  }
  return true;
}

export function requireHex(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    return new Error(`registry wire contract: ${label} must be ${pattern} (got ${JSON.stringify(value)})`);
  }
  return null;
}