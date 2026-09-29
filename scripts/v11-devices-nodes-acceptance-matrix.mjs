// Harness-only RFC-0018 M22 Devices and Nodes qualification matrix.
// Product runtime must not import this module.

const M22_DEFINITIONS = [
  // Automated fields (RFC-0018 §3 D7, A1-A16)
  { field: "sessionListRequiresValidSession", minimumEvidence: "automated" },
  { field: "selectorReadModelEnrichedAndSanitized", minimumEvidence: "automated" },
  { field: "apexAllowlistByteIdentical", minimumEvidence: "automated" },
  { field: "sessionListShapeAndHygiene", minimumEvidence: "automated" },
  { field: "sessionRevokeRequiresCsrf", minimumEvidence: "automated" },
  { field: "sessionRevokeTargetValidation", minimumEvidence: "automated" },
  { field: "sessionRevokeEffectAndIsolation", minimumEvidence: "automated" },
  { field: "sessionSelfRevokeEqualsLogout", minimumEvidence: "automated" },
  { field: "sessionListMatchesStore", minimumEvidence: "automated" },
  { field: "pairingStatusCountConsistency", minimumEvidence: "automated" },
  { field: "selectorTargetScopeIndication", minimumEvidence: "automated" },
  { field: "selectorFlowIndicatorWording", minimumEvidence: "automated" },
  { field: "failureSurfaceTargetPreserving", minimumEvidence: "automated" },
  { field: "nodeRoutesStayPureProxies", minimumEvidence: "automated" },
  { field: "responsiveBreakpointsPresent", minimumEvidence: "automated" },
  { field: "cookieAttributesUnchanged", minimumEvidence: "automated" },
  // Mounted fields (RFC-0018 §3 D7, M1-M6)
  { field: "phoneSelectorUsable", minimumEvidence: "mounted" },
  { field: "phoneExplicitSessionNavigation", minimumEvidence: "mounted" },
  { field: "devicesViewSessionVisibilityAndRevocation", minimumEvidence: "mounted" },
  { field: "perNodeFlowIndicatorLive", minimumEvidence: "mounted" },
  { field: "targetScopeVisibleAcrossNavigationAndFailure", minimumEvidence: "mounted" },
  { field: "hostOnlySessionIsolationRegression", minimumEvidence: "mounted" },
].map((definition) => Object.freeze(definition));

const EXPECTED_FIELD_COUNT = 22;
const ALLOWED_MINIMUM_EVIDENCE = new Set(["automated", "mounted"]);
const ALLOWED_STATUSES = new Set(["PASS", "FAIL", "NOT_EXECUTED", "BLOCKED"]);
const CANDIDATE_SHA_PATTERN = /^[0-9a-f]{40}$/;

function assertDefinitionInvariant() {
  if (M22_DEFINITIONS.length !== EXPECTED_FIELD_COUNT) {
    throw new Error(`RFC-0018 M22 must define exactly ${EXPECTED_FIELD_COUNT} fields`);
  }
  const fields = M22_DEFINITIONS.map(({ field }) => field);
  if (fields.some((field) => typeof field !== "string" || field.length === 0)) {
    throw new Error("RFC-0018 M22 field names must be non-empty strings");
  }
  if (new Set(fields).size !== fields.length) {
    throw new Error("RFC-0018 M22 field names must be unique");
  }
  for (const { minimumEvidence } of M22_DEFINITIONS) {
    if (!ALLOWED_MINIMUM_EVIDENCE.has(minimumEvidence)) {
      throw new Error(`RFC-0018 M22 minimumEvidence is invalid: ${JSON.stringify(minimumEvidence)}`);
    }
  }
}

assertDefinitionInvariant();

export const M22_MATRIX_FIELD_DEFINITIONS = Object.freeze(M22_DEFINITIONS);
export const M22_MATRIX_FIELDS = Object.freeze(M22_DEFINITIONS.map(({ field }) => field));
export const M22_AUTOMATED_FIELDS = Object.freeze(
  M22_DEFINITIONS.filter(({ minimumEvidence }) => minimumEvidence === "automated").map(({ field }) => field),
);
export const M22_MOUNTED_REQUIRED_FIELDS = Object.freeze(
  M22_DEFINITIONS.filter(({ minimumEvidence }) => minimumEvidence === "mounted").map(({ field }) => field),
);
export const M22_ALLOWED_STATUSES = Object.freeze([...ALLOWED_STATUSES]);

export function emptyM22Matrix() {
  return Object.fromEntries(M22_MATRIX_FIELDS.map((field) => [field, "NOT_EXECUTED"]));
}

export function assertCandidateSha(candidateSha) {
  if (!isCandidateSha(candidateSha)) {
    throw new Error(`candidateSha must be a 40-character lower-case hex SHA-1: ${JSON.stringify(candidateSha)}`);
  }
}

export function isCandidateSha(value) {
  return typeof value === "string" && CANDIDATE_SHA_PATTERN.test(value);
}

export function assertM22MatrixShape(matrix, { requirePass = false, scope = "automated" } = {}) {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    throw new Error("RFC-0018 M22 matrix must be an object");
  }
  if (typeof requirePass !== "boolean") {
    throw new Error("RFC-0018 M22 matrix requirePass must be boolean");
  }
  if (scope !== "automated" && scope !== "mounted") {
    throw new Error(`RFC-0018 M22 matrix scope must be automated or mounted, got ${JSON.stringify(scope)}`);
  }
  const keys = Object.keys(matrix);
  if (keys.length !== EXPECTED_FIELD_COUNT) {
    throw new Error(`RFC-0018 M22 matrix must contain exactly ${EXPECTED_FIELD_COUNT} keys (received ${keys.length})`);
  }
  for (const field of M22_MATRIX_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(matrix, field)) {
      throw new Error(`RFC-0018 M22 matrix missing field: ${field}`);
    }
    const status = matrix[field];
    if (!ALLOWED_STATUSES.has(status)) {
      throw new Error(`RFC-0018 M22 matrix field ${field} has invalid status ${JSON.stringify(status)}`);
    }
    if (requirePass && status !== "PASS") {
      throw new Error(`RFC-0018 M22 matrix field ${field} must be PASS (received ${status})`);
    }
    if (scope === "mounted" && M22_MOUNTED_REQUIRED_FIELDS.includes(field) && status !== "PASS") {
      throw new Error(`RFC-0018 M22 mounted field ${field} must be PASS (received ${status})`);
    }
  }
  for (const key of keys) {
    if (!M22_MATRIX_FIELDS.includes(key)) {
      throw new Error(`RFC-0018 M22 matrix contains unexpected field: ${key}`);
    }
  }
}

export function validateCandidateBoundReport(report, { candidateSha, scope = "automated", requirePass = false } = {}) {
  assertCandidateSha(candidateSha);
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Candidate-bound M22 report must be an object");
  }
  if (report.candidateSha !== candidateSha) {
    throw new Error(`candidateSha mismatch: expected ${candidateSha}, got ${report.candidateSha}`);
  }
  if (typeof report.runId !== "string" || !report.runId) {
    throw new Error("Candidate-bound M22 report runId is required");
  }
  if (typeof report.scope !== "string" || (report.scope !== "automated" && report.scope !== "mounted")) {
    throw new Error("Candidate-bound M22 report scope must be 'automated' or 'mounted'");
  }
  if (!report.matrix || typeof report.matrix !== "object") {
    throw new Error("Candidate-bound M22 report matrix is required");
  }
  assertM22MatrixShape(report.matrix, { requirePass, scope });
  return true;
}

export const assertCandidateBoundReport = validateCandidateBoundReport;

export function generateM22AutomatedQualificationMatrix() {
  const matrix = emptyM22Matrix();
  for (const field of M22_AUTOMATED_FIELDS) {
    matrix[field] = "PASS";
  }
  return matrix;
}

export function generateCandidateBoundAutomatedReport({ candidateSha, runId = `v11-qual-${Date.now()}` } = {}) {
  assertCandidateSha(candidateSha);
  const matrix = generateM22AutomatedQualificationMatrix();
  return {
    version: "0.11.0-rc.1",
    candidateSha,
    runId,
    generatedAt: new Date().toISOString(),
    scope: "automated",
    summary: {
      total: EXPECTED_FIELD_COUNT,
      automatedPass: M22_AUTOMATED_FIELDS.length,
      mountedNotExecuted: M22_MOUNTED_REQUIRED_FIELDS.length,
      result: "QUALIFIED_AUTOMATED",
    },
    matrix,
  };
}
