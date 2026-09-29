import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  M22_ALLOWED_STATUSES,
  M22_AUTOMATED_FIELDS,
  M22_MATRIX_FIELD_DEFINITIONS,
  M22_MATRIX_FIELDS,
  M22_MOUNTED_REQUIRED_FIELDS,
  assertCandidateSha,
  assertM22MatrixShape,
  emptyM22Matrix,
  generateCandidateBoundAutomatedReport,
  generateM22AutomatedQualificationMatrix,
  isCandidateSha,
  validateCandidateBoundReport,
} from "../scripts/v11-devices-nodes-acceptance-matrix.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

test("RFC-0018 M22 acceptance matrix defines exactly 22 canonical fields", () => {
  assert.equal(M22_MATRIX_FIELD_DEFINITIONS.length, 22);
  assert.equal(M22_MATRIX_FIELDS.length, 22);
  assert.equal(M22_AUTOMATED_FIELDS.length, 16);
  assert.equal(M22_MOUNTED_REQUIRED_FIELDS.length, 6);

  // A1-A16 automated fields in RFC order (RFC-0018 §3 D7)
  assert.deepEqual(M22_AUTOMATED_FIELDS, [
    "sessionListRequiresValidSession",
    "selectorReadModelEnrichedAndSanitized",
    "apexAllowlistByteIdentical",
    "sessionListShapeAndHygiene",
    "sessionRevokeRequiresCsrf",
    "sessionRevokeTargetValidation",
    "sessionRevokeEffectAndIsolation",
    "sessionSelfRevokeEqualsLogout",
    "sessionListMatchesStore",
    "pairingStatusCountConsistency",
    "selectorTargetScopeIndication",
    "selectorFlowIndicatorWording",
    "failureSurfaceTargetPreserving",
    "nodeRoutesStayPureProxies",
    "responsiveBreakpointsPresent",
    "cookieAttributesUnchanged",
  ]);

  // M1-M6 mounted fields
  assert.deepEqual(M22_MOUNTED_REQUIRED_FIELDS, [
    "phoneSelectorUsable",
    "phoneExplicitSessionNavigation",
    "devicesViewSessionVisibilityAndRevocation",
    "perNodeFlowIndicatorLive",
    "targetScopeVisibleAcrossNavigationAndFailure",
    "hostOnlySessionIsolationRegression",
  ]);

  assert.equal(new Set(M22_MATRIX_FIELDS).size, 22);
});

test("RFC-0018 M22 matrix assertions and report validation work correctly", () => {
  const empty = emptyM22Matrix();
  assert.equal(Object.keys(empty).length, 22);
  assert.equal(Object.values(empty).every((v) => v === "NOT_EXECUTED"), true);

  assertM22MatrixShape(empty, { scope: "automated" });
  // Mounted scope demands mounted fields PASS even without requirePass —
  // an empty matrix therefore always fails mounted validation.
  assert.throws(() => assertM22MatrixShape(empty, { scope: "mounted" }));
  assert.throws(() => assertM22MatrixShape(empty, { scope: "automated", requirePass: true }));
  assert.throws(() => assertM22MatrixShape(empty, { scope: "mounted", requirePass: true }));
  assert.throws(() => assertM22MatrixShape({ ...empty, rogueField: "PASS" }));

  const candidateSha = "b".repeat(40);
  assert.equal(isCandidateSha(candidateSha), true);
  assertCandidateSha(candidateSha);
  assert.throws(() => assertCandidateSha("not-a-sha"));

  const passing = Object.fromEntries(M22_MATRIX_FIELDS.map((f) => [f, "PASS"]));
  assertM22MatrixShape(passing, { scope: "automated", requirePass: true });
  assertM22MatrixShape(passing, { scope: "mounted", requirePass: true });

  const mixed = emptyM22Matrix();
  for (const field of M22_AUTOMATED_FIELDS) mixed[field] = "PASS";
  // requirePass applies to every field, so a matrix with mounted fields still
  // NOT_EXECUTED fails under requirePass in either scope...
  assert.throws(() => assertM22MatrixShape(mixed, { scope: "automated", requirePass: true }));
  assert.throws(() => assertM22MatrixShape(mixed, { scope: "mounted", requirePass: true }));
  // ...but is the valid shape of an automated qualification report.
  assertM22MatrixShape(mixed, { scope: "automated" });

  assert.equal(
    validateCandidateBoundReport(
      { candidateSha, runId: "run-x", scope: "automated", matrix: mixed },
      { candidateSha, scope: "automated" },
    ),
    true,
  );
  assert.throws(() =>
    validateCandidateBoundReport(
      { candidateSha: "c".repeat(40), runId: "run-x", scope: "automated", matrix: mixed },
      { candidateSha, scope: "automated" },
    ),
  );
  assert.deepEqual(M22_ALLOWED_STATUSES, ["PASS", "FAIL", "NOT_EXECUTED", "BLOCKED"]);
});

test("RFC-0018 M22 automated qualification report generation mirrors the v0.9/v0.10 convention", () => {
  const candidateSha = "d".repeat(40);
  const matrix = generateM22AutomatedQualificationMatrix();
  assertM22MatrixShape(matrix, { scope: "automated" });
  assert.equal(Object.values(matrix).every((v) => v === "PASS" || v === "NOT_EXECUTED"), true);

  const report = generateCandidateBoundAutomatedReport({ candidateSha, runId: "v11-qual-test" });
  assert.equal(report.candidateSha, candidateSha);
  assert.equal(report.runId, "v11-qual-test");
  assert.equal(report.scope, "automated");
  assert.equal(report.summary.total, 22);
  assert.equal(report.summary.automatedPass, 16);
  assert.equal(report.summary.mountedNotExecuted, 6);
  assert.equal(report.summary.result, "QUALIFIED_AUTOMATED");
  assert.equal(validateCandidateBoundReport(report, { candidateSha, scope: "automated" }), true);
});

test("v0.11 governance records are present and internally consistent", async () => {
  const authorizationJson = JSON.parse(await read("docs/release-attestations/v0.11-construction-authorization-2026-09-29.json"));
  assert.equal(authorizationJson.authorizationId, "V11-CONSTRUCTION-20260929-A1");
  assert.equal(authorizationJson.status, "AUTHORIZED_FOR_V011_CONSTRUCTION");
  assert.equal(authorizationJson.acceptedV010Closure, "cc826b720124bd9249a334c6f1786e73bb44266b");
  assert.equal(authorizationJson.acceptedV010ClosureTag, "v0.10.0-rc.1");
  assert.equal(authorizationJson.evidenceRequirements.candidateMustBeFrozenBeforeEvidence, true);
  assert.match(authorizationJson.evidenceRequirements.devicesNodesMatrixRequired, /M22/);
  assert.match(authorizationJson.evidenceRequirements.devicesNodesMatrixRequired, /v11-devices-nodes-acceptance-matrix\.mjs/);
  assert.match(authorizationJson.evidenceRequirements.devicesNodesMatrixRequired, /16 automated \+ 6 mounted/);

  const must = authorizationJson.scopeFreeze.must.join("\n");
  // Gate A converged decisions, pinned by scopeFreeze: the apex allowlist is
  // byte-identical, revocation is single-target with the invalid-target-scope
  // code, the audit event is session.revoke, and self-revocation ≡ logout.
  assert.match(must, /selector-apex strict \(method, path\) allowlist stays byte-identical/);
  assert.match(must, /session\.revoke/);
  assert.match(must, /invalid-target-scope/);
  assert.match(must, /csrf_token/);
  // The response shape records the Gate A P3 retention decision: bounded
  // responses with a total count.
  assert.match(must, /idleUntil-derived last activity/);

  const out = authorizationJson.scopeFreeze.outOfScope.join("\n");
  // No new push channel beyond the existing pairing SSE; no DSH login-state
  // inspection; no new device-identifying columns.
  assert.match(out, /existing pairing SSE/);
  assert.match(out, /node-local DSH session state/);
  assert.match(out, /User-Agent, IP/);

  const rfc = await read("docs/rfc/0018-devices-and-nodes-view.md");
  assert.match(rfc, /M22 Matrix — 22 Canonical Fields/);
  assert.match(rfc, /— 16 fields/);
  assert.match(rfc, /— 6 fields/);
  // Every canonical field name in the script must be named in the RFC D7
  // tables (matrix definition and RFC cannot drift apart).
  for (const field of M22_MATRIX_FIELDS) {
    assert.ok(rfc.includes(field), `RFC-0018 D7 must name field ${field}`);
  }
  // Key contract strings.
  assert.match(rfc, /\^sess_\[0-9a-f\]\{48\}\$/);
  assert.match(rfc, /invalid-target-scope/);
  assert.match(rfc, /gateway-denied/);
  assert.match(rfc, /session\.revoke/);
  assert.match(rfc, /active hub-routed flows/);
  assert.doesNotMatch(rfc, /192\.168\.\d/);

  const sop = await read("docs/sop/v0.11-devices-and-nodes-multistage-sop.md");
  assert.match(sop, /v11-devices-nodes-acceptance-matrix\.mjs/);
  assert.match(sop, /v11-governance-contract\.test\.mjs/);
  assert.match(sop, /GO requires P0\/P1\/P2 = 0/);
  assert.match(sop, /requirePass: true/);
});
