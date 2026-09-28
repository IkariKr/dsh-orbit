import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  M17_ALLOWED_STATUSES,
  M17_AUTOMATED_FIELDS,
  M17_MATRIX_FIELD_DEFINITIONS,
  M17_MATRIX_FIELDS,
  M17_MOUNTED_REQUIRED_FIELDS,
  assertCandidateSha,
  assertM17MatrixShape,
  emptyM17Matrix,
  isCandidateSha,
  validateCandidateBoundReport,
} from "../scripts/v10-landing-acceptance-matrix.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

test("RFC-0017 M17 acceptance matrix defines exactly 17 canonical fields", () => {
  assert.equal(M17_MATRIX_FIELD_DEFINITIONS.length, 17);
  assert.equal(M17_MATRIX_FIELDS.length, 17);
  assert.equal(M17_AUTOMATED_FIELDS.length, 13);
  assert.equal(M17_MOUNTED_REQUIRED_FIELDS.length, 4);

  // A1-A13 automated fields in RFC order
  assert.deepEqual(M17_AUTOMATED_FIELDS, [
    "authLandingServedManagementNoQuery",
    "authLandingServedManagementWithToken",
    "fenceRejectsExtraParameters",
    "fenceRejectsShapeAndEncodingVariants",
    "fenceUnchangedOnOtherRoutes",
    "authMethodDiscipline",
    "authLandingServedOnSelectorApex",
    "nodeRouteAuthPassthroughUnintercepted",
    "mintOverrideAppliedWhenSet",
    "mintFallbackRequestHostWhenUnset",
    "mintOverrideInvalidConfigFailsClosed",
    "zeroTokenLeakageAndCookieRegression",
    "apexVerifyRoutingDedicatedDispatch",
  ]);

  // M1-M4 mounted fields
  assert.deepEqual(M17_MOUNTED_REQUIRED_FIELDS, [
    "landingHappyPathScanMobile",
    "landingDeadCodeScan",
    "landingAddressBarScrub",
    "landingReplayDenial",
  ]);

  assert.equal(new Set(M17_MATRIX_FIELDS).size, 17);
});

test("RFC-0017 M17 matrix assertions and report validation work correctly", () => {
  const empty = emptyM17Matrix();
  assert.equal(Object.keys(empty).length, 17);
  assert.equal(Object.values(empty).every((v) => v === "NOT_EXECUTED"), true);

  assertM17MatrixShape(empty, { scope: "automated" });
  // Mounted scope demands mounted fields PASS even without requirePass —
  // an empty matrix therefore always fails mounted validation.
  assert.throws(() => assertM17MatrixShape(empty, { scope: "mounted" }));
  assert.throws(() => assertM17MatrixShape(empty, { scope: "automated", requirePass: true }));
  assert.throws(() => assertM17MatrixShape(empty, { scope: "mounted", requirePass: true }));
  assert.throws(() => assertM17MatrixShape({ ...empty, rogueField: "PASS" }));

  const candidateSha = "b".repeat(40);
  assert.equal(isCandidateSha(candidateSha), true);
  assertCandidateSha(candidateSha);
  assert.throws(() => assertCandidateSha("not-a-sha"));

  const passing = Object.fromEntries(M17_MATRIX_FIELDS.map((f) => [f, "PASS"]));
  assertM17MatrixShape(passing, { scope: "automated", requirePass: true });
  assertM17MatrixShape(passing, { scope: "mounted", requirePass: true });

  const mixed = emptyM17Matrix();
  for (const field of M17_AUTOMATED_FIELDS) mixed[field] = "PASS";
  // requirePass applies to every field, so a matrix with mounted fields still
  // NOT_EXECUTED fails under requirePass in either scope...
  assert.throws(() => assertM17MatrixShape(mixed, { scope: "automated", requirePass: true }));
  assert.throws(() => assertM17MatrixShape(mixed, { scope: "mounted", requirePass: true }));
  // ...but is the valid shape of an automated qualification report.
  assertM17MatrixShape(mixed, { scope: "automated" });

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
  assert.deepEqual(M17_ALLOWED_STATUSES, ["PASS", "FAIL", "NOT_EXECUTED", "BLOCKED"]);
});

test("v0.10 governance records are present and internally consistent", async () => {
  const authorizationJson = JSON.parse(await read("docs/release-attestations/v0.10-construction-authorization-2026-09-28.json"));
  assert.equal(authorizationJson.authorizationId, "V10-CONSTRUCTION-20260928-A1");
  assert.equal(authorizationJson.status, "AUTHORIZED_FOR_V010_CONSTRUCTION");
  assert.equal(authorizationJson.acceptedV09Closure, "145203b8219848796ef627b1f40c0c63233a1d31");
  assert.equal(authorizationJson.acceptedV09ClosureTag, "v0.9.0-rc.1");
  assert.equal(authorizationJson.evidenceRequirements.candidateMustBeFrozenBeforeEvidence, true);
  assert.match(authorizationJson.evidenceRequirements.landingMatrixRequired, /M17/);
  assert.match(authorizationJson.evidenceRequirements.landingMatrixRequired, /v10-landing-acceptance-matrix\.mjs/);

  const must = authorizationJson.scopeFreeze.must.join("\n");
  // Gate A findings: the apex verify tuple is in scope and A13 is its pin...
  assert.match(must, /\(POST, \/hub\/pairing\/verify\)/);
  assert.match(must, /matrix field A13/);
  // ...and the Retry-After header is explicitly out of scope.
  const out = authorizationJson.scopeFreeze.outOfScope.join("\n");
  assert.match(out, /Retry-After/);

  const rfc = await read("docs/rfc/0017-hub-qr-pairing-landing.md");
  assert.match(rfc, /M17 Matrix — 17 Canonical Fields/);
  assert.match(rfc, /A13/);
  assert.match(rfc, /code-not-found/);
  assert.match(rfc, /gateway-denied/);
  assert.match(rfc, /\^token\\=\[0-9\]\{6\}\$/);
  assert.doesNotMatch(rfc, /192\.168\.\d/);

  const sop = await read("docs/sop/v0.10-hub-qr-pairing-landing-multistage-sop.md");
  assert.match(sop, /v10-landing-acceptance-matrix\.mjs/);
  assert.match(sop, /GO requires P0\/P1\/P2 = 0/);
  assert.doesNotMatch(sop, /Retry-After` honored/);

  // Gate A review records exist and record the FAIL → PASS arc.
  const firstReview = await read("docs/review/2026-09-28-v10-stage0-gate-a-review-38bc2d4.md");
  assert.match(firstReview, /Gate A Verdict: FAIL/);
  const rereview = await read("docs/review/2026-09-28-v10-stage0-gate-a-rereview-4ada45c.md");
  assert.match(rereview, /Gate A Verdict: PASS/);
});
