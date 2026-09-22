// Harness-only RFC-0012 D14 qualification matrix.
// Product runtime must not import this module.

const D14_DEFINITIONS = [
  { field: "pairTokenMinted", minimumEvidence: "mounted" },
  { field: "pairTokenDigestOnly", minimumEvidence: "automated" },
  { field: "pairFreshNodeSuccess", minimumEvidence: "mounted" },
  { field: "pairReplayIdempotent", minimumEvidence: "automated" },
  { field: "pairDifferentContentDenied", minimumEvidence: "automated" },
  { field: "pairWrongPurposeDenied", minimumEvidence: "automated" },
  { field: "pairExpiredDenied", minimumEvidence: "automated" },
  { field: "pairLostKeyCreatesNewNodeId", minimumEvidence: "automated" },
  { field: "existingNodeReverseConnectsWithoutRepair", minimumEvidence: "automated" },
  { field: "publicMachineIngressAuthenticated", minimumEvidence: "mounted" },
  { field: "machineWrongSignatureDenied", minimumEvidence: "automated" },
  { field: "machineNonceReplayDenied", minimumEvidence: "automated" },
  { field: "machineStaleTimestampDenied", minimumEvidence: "automated" },
  { field: "reverseTlsUnknownCaDenied", minimumEvidence: "mounted" },
  { field: "reverseTlsWrongSanDenied", minimumEvidence: "mounted" },
  { field: "reverseControlOnline", minimumEvidence: "mounted" },
  { field: "duplicateControlDeterministicTakeover", minimumEvidence: "mounted" },
  { field: "controlReconnectAfterNetworkLoss", minimumEvidence: "mounted" },
  { field: "hubRestartReconnect", minimumEvidence: "mounted" },
  { field: "nodeRestartReconnect", minimumEvidence: "mounted" },
  { field: "reversePresenceIndependentOfRegistryContact", minimumEvidence: "automated" },
  { field: "reverseDshLossUnreachable", minimumEvidence: "mounted" },
  { field: "reverseDshRecoveryReachable", minimumEvidence: "mounted" },
  { field: "dataChannelPoolBounded", minimumEvidence: "automated" },
  { field: "httpRootReverse", minimumEvidence: "mounted" },
  { field: "staticAssetReverse", minimumEvidence: "mounted" },
  { field: "streamingUploadReverse", minimumEvidence: "mounted" },
  { field: "websocketUpgradeReverse", minimumEvidence: "mounted" },
  { field: "websocketPingPongReverse", minimumEvidence: "mounted" },
  { field: "websocketLargePayloadReverse", minimumEvidence: "mounted" },
  { field: "cookieIsolationReverse", minimumEvidence: "mounted" },
  { field: "routeProofWrongNodeDenied", minimumEvidence: "automated" },
  { field: "routeProofReplayDenied", minimumEvidence: "automated" },
  { field: "channelAbortCleanup", minimumEvidence: "mounted" },
  { field: "noCredentialLeak", minimumEvidence: "mounted" },
  { field: "nodeAOutageIsolation", minimumEvidence: "mounted" },
  { field: "nodeBHealthyDuringAOutage", minimumEvidence: "mounted" },
  { field: "noImplicitDirectFallback", minimumEvidence: "mounted" },
  { field: "noImplicitReverseFallback", minimumEvidence: "mounted" },
  { field: "explicitRouteModeSwitch", minimumEvidence: "mounted" },
  { field: "directModeRegression", minimumEvidence: "mounted" },
  { field: "credentialRotationReconnect", minimumEvidence: "mounted" },
  { field: "deleteClosesReverseSession", minimumEvidence: "mounted" },
  { field: "reenrollFreshHubRouteIdentity", minimumEvidence: "mounted" },
  { field: "deletedBookmarkFailClosed", minimumEvidence: "mounted" },
  { field: "hubRestartNoPhantomReverseSession", minimumEvidence: "mounted" },
  { field: "backupRestoreNoLiveReverseSession", minimumEvidence: "automated" },
  { field: "selectorReverseEligibility", minimumEvidence: "mounted" },
].map((definition) => Object.freeze(definition));

const EXPECTED_FIELD_COUNT = 48;
const ALLOWED_MINIMUM_EVIDENCE = new Set(["automated", "mounted"]);
const ALLOWED_STATUSES = new Set(["PASS", "FAIL", "NOT_EXECUTED", "BLOCKED"]);
const CANDIDATE_SHA_PATTERN = /^[0-9a-f]{40}$/;

function assertDefinitionInvariant() {
  if (D14_DEFINITIONS.length !== EXPECTED_FIELD_COUNT) {
    throw new Error(`RFC-0012 D14 must define exactly ${EXPECTED_FIELD_COUNT} fields`);
  }
  const fields = D14_DEFINITIONS.map(({ field }) => field);
  if (fields.some((field) => typeof field !== "string" || field.length === 0)) {
    throw new Error("RFC-0012 D14 field names must be non-empty strings");
  }
  if (new Set(fields).size !== fields.length) {
    throw new Error("RFC-0012 D14 field names must be unique");
  }
  for (const { minimumEvidence } of D14_DEFINITIONS) {
    if (!ALLOWED_MINIMUM_EVIDENCE.has(minimumEvidence)) {
      throw new Error(`RFC-0012 D14 minimumEvidence is invalid: ${JSON.stringify(minimumEvidence)}`);
    }
  }
}

assertDefinitionInvariant();

export const D14_MATRIX_FIELD_DEFINITIONS = Object.freeze(D14_DEFINITIONS);
export const D14_MATRIX_FIELDS = Object.freeze(D14_MATRIX_FIELD_DEFINITIONS.map(({ field }) => field));
export const D14_MATRIX_FIELD_KEYS = D14_MATRIX_FIELDS;
export const D14_MATRIX_MINIMUM_EVIDENCE = Object.freeze(
  Object.fromEntries(D14_MATRIX_FIELD_DEFINITIONS.map(({ field, minimumEvidence }) => [field, minimumEvidence])),
);
export const D14_MOUNTED_REQUIRED_FIELDS = Object.freeze(
  D14_MATRIX_FIELD_DEFINITIONS
    .filter(({ minimumEvidence }) => minimumEvidence === "mounted")
    .map(({ field }) => field),
);
export const D14_AUTOMATED_FIELDS = Object.freeze(
  D14_MATRIX_FIELD_DEFINITIONS
    .filter(({ minimumEvidence }) => minimumEvidence === "automated")
    .map(({ field }) => field),
);
export const D14_ALLOWED_STATUSES = Object.freeze(["PASS", "FAIL", "NOT_EXECUTED", "BLOCKED"]);
export const CANDIDATE_SHA_PATTERN_SOURCE = CANDIDATE_SHA_PATTERN.source;

const D14_FIELD_SET = new Set(D14_MATRIX_FIELDS);
const D14_MOUNTED_REQUIRED_FIELD_SET = new Set(D14_MOUNTED_REQUIRED_FIELDS);
const D14_ALLOWED_STATUS_SET = new Set(D14_ALLOWED_STATUSES);

export function getD14MatrixFieldKeys() {
  return [...D14_MATRIX_FIELDS];
}

export function hasUniqueD14MatrixFieldKeys() {
  return new Set(D14_MATRIX_FIELDS).size === D14_MATRIX_FIELDS.length;
}

export function assertD14MatrixFieldKeys() {
  if (D14_MATRIX_FIELDS.length !== EXPECTED_FIELD_COUNT) {
    throw new Error(`D14 matrix must expose exactly ${EXPECTED_FIELD_COUNT} fields`);
  }
  if (!hasUniqueD14MatrixFieldKeys()) {
    throw new Error("D14 matrix field keys must be unique");
  }
  return true;
}

export function emptyD14Matrix() {
  return Object.fromEntries(D14_MATRIX_FIELDS.map((field) => [field, "NOT_EXECUTED"]));
}

function assertPlainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
}

function ownKeys(value) {
  return Reflect.ownKeys(value);
}

function assertExactD14Keys(matrix) {
  const actualKeys = ownKeys(matrix);
  const actualStringKeys = actualKeys.filter((key) => typeof key === "string");
  const symbolKeys = actualKeys.filter((key) => typeof key === "symbol");
  const missing = D14_MATRIX_FIELDS.filter((field) => !D14_FIELD_SET.has(field) || !Object.prototype.hasOwnProperty.call(matrix, field));
  const extra = actualStringKeys.filter((field) => !D14_FIELD_SET.has(field));
  if (symbolKeys.length > 0 || missing.length > 0 || extra.length > 0 || actualStringKeys.length !== D14_MATRIX_FIELDS.length) {
    const suffix = symbolKeys.length > 0 ? ", symbol keys are not allowed" : "";
    throw new Error(
      `D14 matrix fields mismatch: missing ${missing.join(",") || "none"}; extra ${extra.join(",") || "none"}${suffix}`,
    );
  }
}

export function assertD14MatrixShape(matrix, { requirePass = false, scope = "automated" } = {}) {
  assertPlainRecord(matrix, "D14 matrix");
  if (typeof requirePass !== "boolean") throw new Error("D14 matrix requirePass must be boolean");
  if (scope !== "automated" && scope !== "mounted") {
    throw new Error(`D14 matrix scope must be automated or mounted, got ${JSON.stringify(scope)}`);
  }
  assertExactD14Keys(matrix);
  for (const field of D14_MATRIX_FIELDS) {
    const status = matrix[field];
    if (!D14_ALLOWED_STATUS_SET.has(status)) {
      throw new Error(`D14 matrix.${field} has invalid status ${JSON.stringify(status)}`);
    }
    if (requirePass && status !== "PASS") {
      throw new Error(`D14 matrix.${field} must be PASS, got ${JSON.stringify(status)}`);
    }
    if (scope === "mounted" && D14_MOUNTED_REQUIRED_FIELD_SET.has(field) && status !== "PASS") {
      throw new Error(`D14 mounted-required matrix.${field} must be PASS, got ${JSON.stringify(status)}`);
    }
  }
  return true;
}

export function isD14Matrix(matrix, options) {
  try {
    assertD14MatrixShape(matrix, options);
    return true;
  } catch {
    return false;
  }
}

export function isCandidateSha(value) {
  return typeof value === "string" && CANDIDATE_SHA_PATTERN.test(value);
}

export function assertCandidateSha(value, label = "candidate SHA") {
  if (!isCandidateSha(value)) {
    throw new Error(`${label} must be a complete lowercase 40-hex SHA`);
  }
  return true;
}

function normalizeReportOptions(candidateShaOrOptions, maybeOptions) {
  if (typeof candidateShaOrOptions === "string") {
    return { ...(maybeOptions ?? {}), candidateSha: candidateShaOrOptions };
  }
  if (candidateShaOrOptions === undefined || candidateShaOrOptions === null) return {};
  assertPlainRecord(candidateShaOrOptions, "D14 validator options");
  return candidateShaOrOptions;
}

export function validateCandidateBoundReport(report, candidateShaOrOptions, maybeOptions) {
  const options = normalizeReportOptions(candidateShaOrOptions, maybeOptions);
  const expectedCandidateSha = options.candidateSha ?? options.expectedCandidateSha;
  assertCandidateSha(expectedCandidateSha, "expected candidate SHA");
  if (options.requirePass !== undefined && typeof options.requirePass !== "boolean") {
    throw new Error("D14 validator requirePass must be boolean");
  }
  const scope = options.scope === undefined ? "automated" : options.scope;
  if (scope !== "automated" && scope !== "mounted") {
    throw new Error(`D14 validator scope must be automated or mounted, got ${JSON.stringify(scope)}`);
  }
  assertPlainRecord(report, "candidate-bound D14 report");
  assertCandidateSha(report.candidateSha, "report candidate SHA");
  if (report.candidateSha !== expectedCandidateSha) {
    throw new Error(`candidate SHA mismatch: expected ${expectedCandidateSha}, got ${report.candidateSha}`);
  }
  if (!Object.prototype.hasOwnProperty.call(report, "matrix")) {
    throw new Error("candidate-bound D14 report matrix is required");
  }
  assertD14MatrixShape(report.matrix, { requirePass: options.requirePass ?? false, scope });
  return true;
}

export const assertCandidateBoundReport = validateCandidateBoundReport;
export const validateCandidateBoundD14Report = validateCandidateBoundReport;
export const assertCandidateBoundD14Report = validateCandidateBoundReport;

// Compatibility aliases for harness callers using the reverse-acceptance terminology.
export const REVERSE_MATRIX_FIELD_DEFINITIONS = D14_MATRIX_FIELD_DEFINITIONS;
export const REVERSE_MATRIX_FIELDS = D14_MATRIX_FIELDS;
export const REVERSE_MATRIX_MOUNTED_FIELDS = D14_MOUNTED_REQUIRED_FIELDS;
export const emptyReverseAcceptanceMatrix = emptyD14Matrix;
export const assertReverseAcceptanceMatrixShape = assertD14MatrixShape;
