// Harness-only RFC-0017 M17 hub QR pairing landing qualification matrix.
// Product runtime must not import this module.

const M17_DEFINITIONS = [
  // Automated fields (RFC-0017 §3 D7, A1-A13)
  { field: "authLandingServedManagementNoQuery", minimumEvidence: "automated" },
  { field: "authLandingServedManagementWithToken", minimumEvidence: "automated" },
  { field: "fenceRejectsExtraParameters", minimumEvidence: "automated" },
  { field: "fenceRejectsShapeAndEncodingVariants", minimumEvidence: "automated" },
  { field: "fenceUnchangedOnOtherRoutes", minimumEvidence: "automated" },
  { field: "authMethodDiscipline", minimumEvidence: "automated" },
  { field: "authLandingServedOnSelectorApex", minimumEvidence: "automated" },
  { field: "nodeRouteAuthPassthroughUnintercepted", minimumEvidence: "automated" },
  { field: "mintOverrideAppliedWhenSet", minimumEvidence: "automated" },
  { field: "mintFallbackRequestHostWhenUnset", minimumEvidence: "automated" },
  { field: "mintOverrideInvalidConfigFailsClosed", minimumEvidence: "automated" },
  { field: "zeroTokenLeakageAndCookieRegression", minimumEvidence: "automated" },
  { field: "apexVerifyRoutingDedicatedDispatch", minimumEvidence: "automated" },
  // Mounted fields (RFC-0017 §3 D7, M1-M4)
  { field: "landingHappyPathScanMobile", minimumEvidence: "mounted" },
  { field: "landingDeadCodeScan", minimumEvidence: "mounted" },
  { field: "landingAddressBarScrub", minimumEvidence: "mounted" },
  { field: "landingReplayDenial", minimumEvidence: "mounted" },
].map((definition) => Object.freeze(definition));

const EXPECTED_FIELD_COUNT = 17;
const ALLOWED_MINIMUM_EVIDENCE = new Set(["automated", "mounted"]);
const ALLOWED_STATUSES = new Set(["PASS", "FAIL", "NOT_EXECUTED", "BLOCKED"]);
const CANDIDATE_SHA_PATTERN = /^[0-9a-f]{40}$/;

function assertDefinitionInvariant() {
  if (M17_DEFINITIONS.length !== EXPECTED_FIELD_COUNT) {
    throw new Error(`RFC-0017 M17 must define exactly ${EXPECTED_FIELD_COUNT} fields`);
  }
  const fields = M17_DEFINITIONS.map(({ field }) => field);
  if (fields.some((field) => typeof field !== "string" || field.length === 0)) {
    throw new Error("RFC-0017 M17 field names must be non-empty strings");
  }
  if (new Set(fields).size !== fields.length) {
    throw new Error("RFC-0017 M17 field names must be unique");
  }
  for (const { minimumEvidence } of M17_DEFINITIONS) {
    if (!ALLOWED_MINIMUM_EVIDENCE.has(minimumEvidence)) {
      throw new Error(`RFC-0017 M17 minimumEvidence is invalid: ${JSON.stringify(minimumEvidence)}`);
    }
  }
}

assertDefinitionInvariant();

export const M17_MATRIX_FIELD_DEFINITIONS = Object.freeze(M17_DEFINITIONS);
export const M17_MATRIX_FIELDS = Object.freeze(M17_DEFINITIONS.map(({ field }) => field));
export const M17_AUTOMATED_FIELDS = Object.freeze(
  M17_DEFINITIONS.filter(({ minimumEvidence }) => minimumEvidence === "automated").map(({ field }) => field),
);
export const M17_MOUNTED_REQUIRED_FIELDS = Object.freeze(
  M17_DEFINITIONS.filter(({ minimumEvidence }) => minimumEvidence === "mounted").map(({ field }) => field),
);
export const M17_ALLOWED_STATUSES = Object.freeze([...ALLOWED_STATUSES]);

export function emptyM17Matrix() {
  return Object.fromEntries(M17_MATRIX_FIELDS.map((field) => [field, "NOT_EXECUTED"]));
}

export function assertCandidateSha(candidateSha) {
  if (!isCandidateSha(candidateSha)) {
    throw new Error(`candidateSha must be a 40-character lower-case hex SHA-1: ${JSON.stringify(candidateSha)}`);
  }
}

export function isCandidateSha(value) {
  return typeof value === "string" && CANDIDATE_SHA_PATTERN.test(value);
}

export function assertM17MatrixShape(matrix, { requirePass = false, scope = "automated" } = {}) {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    throw new Error("RFC-0017 M17 matrix must be an object");
  }
  if (typeof requirePass !== "boolean") {
    throw new Error("RFC-0017 M17 matrix requirePass must be boolean");
  }
  if (scope !== "automated" && scope !== "mounted") {
    throw new Error(`RFC-0017 M17 matrix scope must be automated or mounted, got ${JSON.stringify(scope)}`);
  }
  const keys = Object.keys(matrix);
  if (keys.length !== EXPECTED_FIELD_COUNT) {
    throw new Error(`RFC-0017 M17 matrix must contain exactly ${EXPECTED_FIELD_COUNT} keys (received ${keys.length})`);
  }
  for (const field of M17_MATRIX_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(matrix, field)) {
      throw new Error(`RFC-0017 M17 matrix missing field: ${field}`);
    }
    const status = matrix[field];
    if (!ALLOWED_STATUSES.has(status)) {
      throw new Error(`RFC-0017 M17 matrix field ${field} has invalid status ${JSON.stringify(status)}`);
    }
    if (requirePass && status !== "PASS") {
      throw new Error(`RFC-0017 M17 matrix field ${field} must be PASS (received ${status})`);
    }
    if (scope === "mounted" && M17_MOUNTED_REQUIRED_FIELDS.includes(field) && status !== "PASS") {
      throw new Error(`RFC-0017 M17 mounted field ${field} must be PASS (received ${status})`);
    }
  }
  for (const key of keys) {
    if (!M17_MATRIX_FIELDS.includes(key)) {
      throw new Error(`RFC-0017 M17 matrix contains unexpected field: ${key}`);
    }
  }
}

export function validateCandidateBoundReport(report, { candidateSha, scope = "automated", requirePass = false } = {}) {
  assertCandidateSha(candidateSha);
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Candidate-bound M17 report must be an object");
  }
  if (report.candidateSha !== candidateSha) {
    throw new Error(`candidateSha mismatch: expected ${candidateSha}, got ${report.candidateSha}`);
  }
  if (typeof report.runId !== "string" || !report.runId) {
    throw new Error("Candidate-bound M17 report runId is required");
  }
  if (typeof report.scope !== "string" || (report.scope !== "automated" && report.scope !== "mounted")) {
    throw new Error("Candidate-bound M17 report scope must be 'automated' or 'mounted'");
  }
  if (!report.matrix || typeof report.matrix !== "object") {
    throw new Error("Candidate-bound M17 report matrix is required");
  }
  assertM17MatrixShape(report.matrix, { requirePass, scope });
  return true;
}

export const assertCandidateBoundReport = validateCandidateBoundReport;
