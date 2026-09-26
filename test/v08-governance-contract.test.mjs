import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  M32_AUTOMATED_FIELDS,
  M32_MATRIX_FIELD_DEFINITIONS,
  M32_MATRIX_FIELDS,
  M32_MOUNTED_REQUIRED_FIELDS,
  assertCandidateSha,
  assertM32MatrixShape,
  emptyM32Matrix,
  generateCandidateBoundAutomatedReport,
  generateM32AutomatedQualificationMatrix,
  isCandidateSha,
  validateCandidateBoundReport,
} from "../scripts/v08-scheduled-acceptance-matrix.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

const ACCEPTED_V07_CLOSURE = "53e29f3ea56ad6b1374b0319de0059252558db9d";

function gitObjectExists(commit) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      cwd: new URL("../", import.meta.url),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function gitIsAncestor(ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: new URL("../", import.meta.url),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

test("v0.8 construction package is anchored to the accepted v0.7 closure", async () => {
  const [authorizationJsonText, authorizationMdText, finalReviewText, roadmap, rfc, sop] = await Promise.all([
    read("docs/release-attestations/v0.8-construction-authorization-2026-09-26.json"),
    read("docs/release-attestations/v0.8-construction-authorization-2026-09-26.md"),
    read("docs/review/2026-09-26-v07-stage6-final-review-53e29f3.md"),
    read("docs/roadmap.md"),
    read("docs/rfc/0015-scheduled-workflows-and-fleet-automation.md"),
    read("docs/sop/v0.8-scheduled-workflows-multistage-sop.md"),
  ]);
  const authorization = JSON.parse(authorizationJsonText);

  assert.equal(authorization.authorizationId, "V08-CONSTRUCTION-20260926-A1");
  assert.equal(authorization.acceptedV07Closure, ACCEPTED_V07_CLOSURE);
  assert.equal(authorization.constructionLineage.mustDescendFromAcceptedV07Closure, true);
  assert.match(authorization.objective, /scheduled workflows/);
  assert.equal(authorization.status, "AUTHORIZED_FOR_V08_CONSTRUCTION");

  assert.match(authorizationMdText, /V08-CONSTRUCTION-20260926-A1/);
  assert.match(authorizationMdText, new RegExp(ACCEPTED_V07_CLOSURE));
  assert.match(authorizationMdText, /RFC-0015/);

  assert.match(finalReviewText, /Gate 4 Final Review conclusion: \*\*PASS\*\*/);
  assert.match(finalReviewText, /v0\.7 engineering acceptance is CLOSED/);

  assert.match(roadmap, /## 0\.8: scheduled workflows and fleet automation/);
  assert.match(roadmap, /V08-CONSTRUCTION-20260926-A1/);

  assert.match(rfc, /# RFC 0015: Scheduled Workflows and Fleet Automation for v0\.8/);
  assert.match(rfc, /V08-CONSTRUCTION-20260926-A1/);

  assert.match(sop, /# v0\.8 Scheduled Workflows and Fleet Automation Multistage SOP/);
  assert.match(sop, new RegExp(ACCEPTED_V07_CLOSURE));
});

test("v0.8 construction authorization lineage is valid in git history", () => {
  assert.equal(gitObjectExists(ACCEPTED_V07_CLOSURE), true, "accepted v0.7 closure commit must exist");
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
  }).trim();
  assert.equal(gitIsAncestor(ACCEPTED_V07_CLOSURE, head), true, "HEAD must descend from accepted v0.7 closure");
});

test("RFC-0015 M32 acceptance matrix defines exactly 32 canonical fields", () => {
  assert.equal(M32_MATRIX_FIELD_DEFINITIONS.length, 32);
  assert.equal(M32_MATRIX_FIELDS.length, 32);
  assert.equal(M32_AUTOMATED_FIELDS.length, 15);
  assert.equal(M32_MOUNTED_REQUIRED_FIELDS.length, 17);

  // First 28 fields match RFC-0014 M28
  assert.ok(M32_MATRIX_FIELDS.includes("fleetJobListObservability"));
  assert.ok(M32_MATRIX_FIELDS.includes("fleetTaskExecutionDirectNode"));
  assert.ok(M32_MATRIX_FIELDS.includes("fleetTaskExecutionReverseNode"));
  assert.ok(M32_MATRIX_FIELDS.includes("zeroCrossNodeCredentialLeakInJob"));

  // 4 new scheduled fields
  assert.ok(M32_MATRIX_FIELDS.includes("scheduledWorkflowDefinitionPersistence"));
  assert.ok(M32_MATRIX_FIELDS.includes("scheduledWorkflowCronAndIntervalParsing"));
  assert.ok(M32_MATRIX_FIELDS.includes("scheduledWorkflowAutomatedDispatch"));
  assert.ok(M32_MATRIX_FIELDS.includes("scheduledWorkflowLifecycleAndAudit"));

  assert.equal(new Set(M32_MATRIX_FIELDS).size, 32);
});

test("RFC-0015 M32 matrix assertions and report generation work correctly", () => {
  const empty = emptyM32Matrix();
  assert.equal(Object.keys(empty).length, 32);
  assert.equal(Object.values(empty).every((v) => v === "NOT_EXECUTED"), true);

  const autoMatrix = generateM32AutomatedQualificationMatrix();
  assertM32MatrixShape(autoMatrix, { scope: "automated" });
  assert.throws(() => assertM32MatrixShape(autoMatrix, { scope: "mounted", requirePass: true }));

  const candidateSha = "a".repeat(40);
  assert.equal(isCandidateSha(candidateSha), true);
  assertCandidateSha(candidateSha);

  const report = generateCandidateBoundAutomatedReport({ candidateSha });
  assert.equal(report.candidateSha, candidateSha);
  assert.equal(report.scope, "automated");
  assert.equal(report.summary.automatedPass, 15);
  assert.equal(report.summary.mountedNotExecuted, 17);
  assert.equal(validateCandidateBoundReport(report, { candidateSha, scope: "automated" }), true);
});
