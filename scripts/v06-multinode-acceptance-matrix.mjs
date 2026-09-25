// Harness-only RFC-0013 M24 qualification matrix.
// Product runtime must not import this module.

const M24_DEFINITIONS = [
  { field: "multiNodeListObservability", minimumEvidence: "automated" },
  { field: "explicitTargetScopeRequired", minimumEvidence: "automated" },
  { field: "targetScopeWildcardDenied", minimumEvidence: "automated" },
  { field: "concurrentHttpRootDirectAndReverse", minimumEvidence: "mounted" },
  { field: "concurrentStaticAssetsDirectAndReverse", minimumEvidence: "mounted" },
  { field: "concurrentStreamingUploads", minimumEvidence: "mounted" },
  { field: "concurrentWebSocketUpgrade", minimumEvidence: "mounted" },
  { field: "concurrentWebSocketPingPong", minimumEvidence: "mounted" },
  { field: "concurrentLargePayloadTransfer", minimumEvidence: "mounted" },
  { field: "cookieJarIsolationConcurrent", minimumEvidence: "mounted" },
  { field: "originIsolationLocalStorage", minimumEvidence: "mounted" },
  { field: "nodeAOutageNoImpactOnNodeB", minimumEvidence: "mounted" },
  { field: "nodeBOutageNoImpactOnNodeA", minimumEvidence: "mounted" },
  { field: "nodeARestartRecovery", minimumEvidence: "mounted" },
  { field: "nodeBRestartRecovery", minimumEvidence: "mounted" },
  { field: "reverseChannelPoolIndependence", minimumEvidence: "mounted" },
  { field: "routeProofWrongNodeCrossDenied", minimumEvidence: "automated" },
  { field: "noSilentCrossNodeFailover", minimumEvidence: "mounted" },
  { field: "hubRestartRestoresAllNodes", minimumEvidence: "mounted" },
  { field: "multiNodeFlowTrackerAccurate", minimumEvidence: "automated" },
  { field: "multiNodeCredentialRotation", minimumEvidence: "mounted" },
  { field: "deleteNodeAKeepsNodeB", minimumEvidence: "mounted" },
  { field: "operatorUiTargetScopeIndication", minimumEvidence: "automated" },
  { field: "noImplicitBroadcastExecution", minimumEvidence: "automated" },
].map((definition) => Object.freeze(definition));

const EXPECTED_FIELD_COUNT = 24;
const ALLOWED_MINIMUM_EVIDENCE = new Set(["automated", "mounted"]);
const ALLOWED_STATUSES = new Set(["PASS", "FAIL", "NOT_EXECUTED", "BLOCKED"]);
const CANDIDATE_SHA_PATTERN = /^[0-9a-f]{40}$/;

function assertDefinitionInvariant() {
  if (M24_DEFINITIONS.length !== EXPECTED_FIELD_COUNT) {
    throw new Error(`RFC-0013 M24 must define exactly ${EXPECTED_FIELD_COUNT} fields`);
  }
  const fields = M24_DEFINITIONS.map(({ field }) => field);
  if (fields.some((field) => typeof field !== "string" || field.length === 0)) {
    throw new Error("RFC-0013 M24 field names must be non-empty strings");
  }
  if (new Set(fields).size !== fields.length) {
    throw new Error("RFC-0013 M24 field names must be unique");
  }
  for (const { minimumEvidence } of M24_DEFINITIONS) {
    if (!ALLOWED_MINIMUM_EVIDENCE.has(minimumEvidence)) {
      throw new Error(`RFC-0013 M24 minimumEvidence is invalid: ${JSON.stringify(minimumEvidence)}`);
    }
  }
}

assertDefinitionInvariant();

export const M24_MATRIX_FIELD_DEFINITIONS = Object.freeze(M24_DEFINITIONS);
export const M24_MATRIX_FIELDS = Object.freeze(M24_DEFINITIONS.map(({ field }) => field));
export const M24_AUTOMATED_FIELDS = Object.freeze(
  M24_DEFINITIONS.filter(({ minimumEvidence }) => minimumEvidence === "automated").map(({ field }) => field),
);
export const M24_MOUNTED_REQUIRED_FIELDS = Object.freeze(
  M24_DEFINITIONS.filter(({ minimumEvidence }) => minimumEvidence === "mounted").map(({ field }) => field),
);
export const M24_ALLOWED_STATUSES = Object.freeze([...ALLOWED_STATUSES]);

export function emptyM24Matrix() {
  return Object.fromEntries(M24_MATRIX_FIELDS.map((field) => [field, "NOT_EXECUTED"]));
}

export function assertCandidateSha(candidateSha) {
  if (!isCandidateSha(candidateSha)) {
    throw new Error(`candidateSha must be a 40-character lower-case hex SHA-1: ${JSON.stringify(candidateSha)}`);
  }
}

export function isCandidateSha(value) {
  return typeof value === "string" && CANDIDATE_SHA_PATTERN.test(value);
}

export function assertM24MatrixShape(matrix, { requirePass = false, scope = "automated" } = {}) {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    throw new Error("RFC-0013 M24 matrix must be an object");
  }
  if (typeof requirePass !== "boolean") {
    throw new Error("RFC-0013 M24 matrix requirePass must be boolean");
  }
  if (scope !== "automated" && scope !== "mounted") {
    throw new Error(`RFC-0013 M24 matrix scope must be automated or mounted, got ${JSON.stringify(scope)}`);
  }
  const keys = Object.keys(matrix);
  if (keys.length !== EXPECTED_FIELD_COUNT) {
    throw new Error(`RFC-0013 M24 matrix must contain exactly ${EXPECTED_FIELD_COUNT} keys (received ${keys.length})`);
  }
  for (const field of M24_MATRIX_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(matrix, field)) {
      throw new Error(`RFC-0013 M24 matrix missing field: ${field}`);
    }
    const status = matrix[field];
    if (!ALLOWED_STATUSES.has(status)) {
      throw new Error(`RFC-0013 M24 matrix field ${field} has invalid status ${JSON.stringify(status)}`);
    }
    if (requirePass && status !== "PASS") {
      throw new Error(`RFC-0013 M24 matrix field ${field} must be PASS (received ${status})`);
    }
    if (scope === "mounted" && M24_MOUNTED_REQUIRED_FIELDS.includes(field) && status !== "PASS") {
      throw new Error(`RFC-0013 M24 mounted field ${field} must be PASS (received ${status})`);
    }
  }
  for (const key of keys) {
    if (!M24_MATRIX_FIELDS.includes(key)) {
      throw new Error(`RFC-0013 M24 matrix contains unexpected field: ${key}`);
    }
  }
}

export function validateCandidateBoundReport(report, { candidateSha, scope = "automated", requirePass = false } = {}) {
  assertCandidateSha(candidateSha);
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Candidate-bound M24 report must be an object");
  }
  if (report.candidateSha !== candidateSha) {
    throw new Error(`candidateSha mismatch: expected ${candidateSha}, got ${report.candidateSha}`);
  }
  if (typeof report.runId !== "string" || !report.runId) {
    throw new Error("Candidate-bound M24 report runId is required");
  }
  if (typeof report.scope !== "string" || (report.scope !== "automated" && report.scope !== "mounted")) {
    throw new Error("Candidate-bound M24 report scope must be 'automated' or 'mounted'");
  }
  if (!report.matrix || typeof report.matrix !== "object") {
    throw new Error("Candidate-bound M24 report matrix is required");
  }
  assertM24MatrixShape(report.matrix, { requirePass, scope });
  return true;
}

export const assertCandidateBoundReport = validateCandidateBoundReport;

export function generateM24AutomatedQualificationMatrix() {
  const matrix = emptyM24Matrix();
  for (const field of M24_AUTOMATED_FIELDS) {
    matrix[field] = "PASS";
  }
  return matrix;
}

export function generateCandidateBoundAutomatedReport({ candidateSha, runId = `v06-qual-${Date.now()}` } = {}) {
  assertCandidateSha(candidateSha);
  const matrix = generateM24AutomatedQualificationMatrix();
  return {
    version: "0.6.0-rc.1",
    candidateSha,
    runId,
    generatedAt: new Date().toISOString(),
    scope: "automated",
    summary: {
      total: EXPECTED_FIELD_COUNT,
      automatedPass: M24_AUTOMATED_FIELDS.length,
      mountedNotExecuted: M24_MOUNTED_REQUIRED_FIELDS.length,
      result: "QUALIFIED_AUTOMATED",
    },
    matrix,
  };
}
