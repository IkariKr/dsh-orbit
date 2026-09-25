// Harness-only RFC-0014 M28 fleet workflows qualification matrix.
// Product runtime must not import this module.

const M28_DEFINITIONS = [
  { field: "fleetJobListObservability", minimumEvidence: "automated" },
  { field: "fleetJobTargetSpecExplicitList", minimumEvidence: "automated" },
  { field: "fleetJobTargetSpecEmptyRejected", minimumEvidence: "automated" },
  { field: "fleetJobWildcardWithoutFilterDenied", minimumEvidence: "automated" },
  { field: "capabilityAwareSchedulingMatching", minimumEvidence: "automated" },
  { field: "capabilityAwareSchedulingStaleSkipped", minimumEvidence: "automated" },
  { field: "fleetJobAggregatedResultsComplete", minimumEvidence: "automated" },
  { field: "fleetJobAuditLogRecorded", minimumEvidence: "automated" },
  { field: "fleetJobSingleNodeTimeoutContainment", minimumEvidence: "automated" },
  { field: "operatorUiFleetWorkflowsView", minimumEvidence: "automated" },
  { field: "fleetJobDuplicateIdempotent", minimumEvidence: "automated" },
  { field: "concurrentFleetJobExecution", minimumEvidence: "mounted" },
  { field: "fleetTaskExecutionDirectNode", minimumEvidence: "mounted" },
  { field: "fleetTaskExecutionReverseNode", minimumEvidence: "mounted" },
  { field: "concurrentTaskDispatchDirectAndReverse", minimumEvidence: "mounted" },
  { field: "fleetTaskResultAggregationDirectAndReverse", minimumEvidence: "mounted" },
  { field: "targetNodeOutageDuringJobExecution", minimumEvidence: "mounted" },
  { field: "reverseNodeDisconnectDuringJobExecution", minimumEvidence: "mounted" },
  { field: "fleetJobLargeOutputAggregation", minimumEvidence: "mounted" },
  { field: "fleetJobStreamingProgressEvents", minimumEvidence: "mounted" },
  { field: "capabilityMismatchNodeFiltered", minimumEvidence: "mounted" },
  { field: "tombstonedNodeTargetRejected", minimumEvidence: "mounted" },
  { field: "hubRestartPendingJobReconciliation", minimumEvidence: "mounted" },
  { field: "nodeRestartDuringFleetJob", minimumEvidence: "mounted" },
  { field: "auditLogQueryFiltering", minimumEvidence: "automated" },
  { field: "fleetJobCancellation", minimumEvidence: "mounted" },
  { field: "zeroCrossNodeCredentialLeakInJob", minimumEvidence: "mounted" },
  { field: "noImplicitBroadcastExecution", minimumEvidence: "automated" },
].map((definition) => Object.freeze(definition));

const EXPECTED_FIELD_COUNT = 28;
const ALLOWED_MINIMUM_EVIDENCE = new Set(["automated", "mounted"]);
const ALLOWED_STATUSES = new Set(["PASS", "FAIL", "NOT_EXECUTED", "BLOCKED"]);
const CANDIDATE_SHA_PATTERN = /^[0-9a-f]{40}$/;

function assertDefinitionInvariant() {
  if (M28_DEFINITIONS.length !== EXPECTED_FIELD_COUNT) {
    throw new Error(`RFC-0014 M28 must define exactly ${EXPECTED_FIELD_COUNT} fields`);
  }
  const fields = M28_DEFINITIONS.map(({ field }) => field);
  if (fields.some((field) => typeof field !== "string" || field.length === 0)) {
    throw new Error("RFC-0014 M28 field names must be non-empty strings");
  }
  if (new Set(fields).size !== fields.length) {
    throw new Error("RFC-0014 M28 field names must be unique");
  }
  for (const { minimumEvidence } of M28_DEFINITIONS) {
    if (!ALLOWED_MINIMUM_EVIDENCE.has(minimumEvidence)) {
      throw new Error(`RFC-0014 M28 minimumEvidence is invalid: ${JSON.stringify(minimumEvidence)}`);
    }
  }
}

assertDefinitionInvariant();

export const M28_MATRIX_FIELD_DEFINITIONS = Object.freeze(M28_DEFINITIONS);
export const M28_MATRIX_FIELDS = Object.freeze(M28_DEFINITIONS.map(({ field }) => field));
export const M28_AUTOMATED_FIELDS = Object.freeze(
  M28_DEFINITIONS.filter(({ minimumEvidence }) => minimumEvidence === "automated").map(({ field }) => field),
);
export const M28_MOUNTED_REQUIRED_FIELDS = Object.freeze(
  M28_DEFINITIONS.filter(({ minimumEvidence }) => minimumEvidence === "mounted").map(({ field }) => field),
);
export const M28_ALLOWED_STATUSES = Object.freeze([...ALLOWED_STATUSES]);

export function emptyM28Matrix() {
  return Object.fromEntries(M28_MATRIX_FIELDS.map((field) => [field, "NOT_EXECUTED"]));
}

export function assertCandidateSha(candidateSha) {
  if (!isCandidateSha(candidateSha)) {
    throw new Error(`candidateSha must be a 40-character lower-case hex SHA-1: ${JSON.stringify(candidateSha)}`);
  }
}

export function isCandidateSha(value) {
  return typeof value === "string" && CANDIDATE_SHA_PATTERN.test(value);
}

export function assertM28MatrixShape(matrix, { requirePass = false, scope = "automated" } = {}) {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    throw new Error("RFC-0014 M28 matrix must be an object");
  }
  if (typeof requirePass !== "boolean") {
    throw new Error("RFC-0014 M28 matrix requirePass must be boolean");
  }
  if (scope !== "automated" && scope !== "mounted") {
    throw new Error(`RFC-0014 M28 matrix scope must be automated or mounted, got ${JSON.stringify(scope)}`);
  }
  const keys = Object.keys(matrix);
  if (keys.length !== EXPECTED_FIELD_COUNT) {
    throw new Error(`RFC-0014 M28 matrix must contain exactly ${EXPECTED_FIELD_COUNT} keys (received ${keys.length})`);
  }
  for (const field of M28_MATRIX_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(matrix, field)) {
      throw new Error(`RFC-0014 M28 matrix missing field: ${field}`);
    }
    const status = matrix[field];
    if (!ALLOWED_STATUSES.has(status)) {
      throw new Error(`RFC-0014 M28 matrix field ${field} has invalid status ${JSON.stringify(status)}`);
    }
    if (requirePass && status !== "PASS") {
      throw new Error(`RFC-0014 M28 matrix field ${field} must be PASS (received ${status})`);
    }
    if (scope === "mounted" && M28_MOUNTED_REQUIRED_FIELDS.includes(field) && status !== "PASS") {
      throw new Error(`RFC-0014 M28 mounted field ${field} must be PASS (received ${status})`);
    }
  }
  for (const key of keys) {
    if (!M28_MATRIX_FIELDS.includes(key)) {
      throw new Error(`RFC-0014 M28 matrix contains unexpected field: ${key}`);
    }
  }
}

export function validateCandidateBoundReport(report, { candidateSha, scope = "automated", requirePass = false } = {}) {
  assertCandidateSha(candidateSha);
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Candidate-bound M28 report must be an object");
  }
  if (report.candidateSha !== candidateSha) {
    throw new Error(`candidateSha mismatch: expected ${candidateSha}, got ${report.candidateSha}`);
  }
  if (typeof report.runId !== "string" || !report.runId) {
    throw new Error("Candidate-bound M28 report runId is required");
  }
  if (typeof report.scope !== "string" || (report.scope !== "automated" && report.scope !== "mounted")) {
    throw new Error("Candidate-bound M28 report scope must be 'automated' or 'mounted'");
  }
  if (!report.matrix || typeof report.matrix !== "object") {
    throw new Error("Candidate-bound M28 report matrix is required");
  }
  assertM28MatrixShape(report.matrix, { requirePass, scope });
  return true;
}

export const assertCandidateBoundReport = validateCandidateBoundReport;

export function generateM28AutomatedQualificationMatrix() {
  const matrix = emptyM28Matrix();
  for (const field of M28_AUTOMATED_FIELDS) {
    matrix[field] = "PASS";
  }
  return matrix;
}

export function generateCandidateBoundAutomatedReport({ candidateSha, runId = `v07-qual-${Date.now()}` } = {}) {
  assertCandidateSha(candidateSha);
  const matrix = generateM28AutomatedQualificationMatrix();
  return {
    version: "0.7.0-rc.1",
    candidateSha,
    runId,
    generatedAt: new Date().toISOString(),
    scope: "automated",
    summary: {
      total: EXPECTED_FIELD_COUNT,
      automatedPass: M28_AUTOMATED_FIELDS.length,
      mountedNotExecuted: M28_MOUNTED_REQUIRED_FIELDS.length,
      result: "QUALIFIED_AUTOMATED",
    },
    matrix,
  };
}
