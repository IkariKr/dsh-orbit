import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  M28_AUTOMATED_FIELDS,
  M28_MATRIX_FIELD_DEFINITIONS,
  M28_MATRIX_FIELDS,
  M28_MOUNTED_REQUIRED_FIELDS,
  assertCandidateSha,
  assertM28MatrixShape,
  emptyM28Matrix,
  generateCandidateBoundAutomatedReport,
  generateM28AutomatedQualificationMatrix,
  isCandidateSha,
  validateCandidateBoundReport,
} from "../scripts/v07-fleet-acceptance-matrix.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

const ACCEPTED_V06_CLOSURE = "6ef5c5118ddd69f580afd6c7e9d911de068d2f2a";

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

test("v0.7 construction package is anchored to the accepted v0.6 closure", async () => {
  const [authorizationJsonText, authorizationMdText, finalReviewText, roadmap, rfc, sop] = await Promise.all([
    read("docs/release-attestations/v0.7-construction-authorization-2026-09-26.json"),
    read("docs/release-attestations/v0.7-construction-authorization-2026-09-26.md"),
    read("docs/release-attestations/v0.6-stage6-final-review-2026-09-26.md"),
    read("docs/roadmap.md"),
    read("docs/rfc/0014-fleet-workflows-and-scheduling.md"),
    read("docs/sop/v0.7-fleet-workflows-multistage-sop.md"),
  ]);
  const authorization = JSON.parse(authorizationJsonText);

  assert.equal(authorization.authorizationId, "V07-CONSTRUCTION-20260926-A1");
  assert.equal(authorization.acceptedV06Closure, ACCEPTED_V06_CLOSURE);
  assert.equal(authorization.constructionLineage.mustDescendFromAcceptedV06Closure, true);
  assert.match(authorization.objective, /fleet workflows/);
  assert.equal(authorization.status, "AUTHORIZED_FOR_V07_CONSTRUCTION");

  assert.match(authorizationMdText, /V07-CONSTRUCTION-20260926-A1/);
  assert.match(authorizationMdText, new RegExp(ACCEPTED_V06_CLOSURE));
  assert.match(authorizationMdText, /RFC-0014/);

  assert.match(finalReviewText, /v0\.6 STAGE 6 CLOSED/);
  assert.match(finalReviewText, /v0\.6 ENGINEERING ACCEPTANCE = PASS/);
  assert.match(finalReviewText, new RegExp(ACCEPTED_V06_CLOSURE));

  assert.match(roadmap, /## 0\.7: fleet workflows/);
  assert.match(roadmap, /V07-CONSTRUCTION-20260926-A1/);
  assert.match(roadmap, new RegExp(ACCEPTED_V06_CLOSURE));
  assert.match(roadmap, /RFC-0014/);

  assert.match(rfc, /Product construction is blocked until the Stage 0 \/ Gate A review records GO/);
  assert.match(rfc, /Fleet workflows and capability-aware scheduling/i);
  assert.match(rfc, /explicit tasks targeting selected nodes/i);

  assert.match(sop, new RegExp(ACCEPTED_V06_CLOSURE));
  assert.match(sop, /Gate A/);
  assert.match(sop, /Gate B/);
  assert.match(sop, /Gate C/);

  // Mechanically verify git existence and lineage
  assert.equal(gitObjectExists(ACCEPTED_V06_CLOSURE), true, `accepted v0.6 closure ${ACCEPTED_V06_CLOSURE} must exist in git`);
  assert.equal(
    gitIsAncestor(ACCEPTED_V06_CLOSURE, "HEAD"),
    true,
    `current HEAD must descend from accepted v0.6 closure ${ACCEPTED_V06_CLOSURE}`,
  );

  // Mechanically verify the authorization commit cited in the SOP
  const sopAuthCommitMatch = /v0\.7 construction authorization commit:\s*```text\s*([0-9a-f]{40})\s*```/m.exec(sop);
  assert.ok(sopAuthCommitMatch, "SOP must cite a 40-character lower-case hex authorization commit SHA");
  const sopAuthCommit = sopAuthCommitMatch[1];
  assert.equal(gitObjectExists(sopAuthCommit), true, `SOP authorization commit ${sopAuthCommit} must exist in git`);
  assert.equal(
    gitIsAncestor(ACCEPTED_V06_CLOSURE, sopAuthCommit),
    true,
    `SOP authorization commit must descend from accepted v0.6 closure ${ACCEPTED_V06_CLOSURE}`,
  );
  assert.equal(
    gitIsAncestor(sopAuthCommit, "HEAD"),
    true,
    `current HEAD must descend from SOP authorization commit ${sopAuthCommit}`,
  );
});

test("RFC-0014 freezes the exact 28-field fleet acceptance matrix (M28)", async () => {
  const rfc = await read("docs/rfc/0014-fleet-workflows-and-scheduling.md");
  const actual = [...rfc.matchAll(/^\|\s*(\d+)\s*\|\s*`([A-Za-z0-9]+)`\s*\|\s*(automated|mounted)\s*\|/gm)].map(
    ([, number, field, scope]) => ({
      number: Number(number),
      field,
      minimumEvidence: scope,
    }),
  );
  const expected = M28_MATRIX_FIELD_DEFINITIONS.map((def, idx) => ({ number: idx + 1, ...def }));

  assert.equal(actual.length, 28);
  assert.deepEqual(actual, expected);
  assert.deepEqual(M28_MATRIX_FIELDS, expected.map(({ field }) => field));
  assert.equal(new Set(M28_MATRIX_FIELDS).size, 28);
  assert.equal(M28_AUTOMATED_FIELDS.length, 13);
  assert.equal(M28_MOUNTED_REQUIRED_FIELDS.length, 15);
});

test("empty M28 matrix has exactly 28 NOT_EXECUTED fields", () => {
  const matrix = emptyM28Matrix();
  assert.equal(Object.keys(matrix).length, 28);
  assert.deepEqual(Object.keys(matrix), M28_MATRIX_FIELDS);
  assert.ok(Object.values(matrix).every((status) => status === "NOT_EXECUTED"));
  assert.doesNotThrow(() => assertM28MatrixShape(matrix));
  assert.throws(() => assertM28MatrixShape(matrix, { requirePass: true }), /must be PASS/);
});

test("M28 candidate-bound automated qualification report generation and validation", () => {
  const dummyCandidateSha = "0123456789abcdef0123456789abcdef01234567";
  const report = generateCandidateBoundAutomatedReport({
    candidateSha: dummyCandidateSha,
    runId: "v07-qual-test-run",
  });

  assert.equal(report.candidateSha, dummyCandidateSha);
  assert.equal(report.runId, "v07-qual-test-run");
  assert.equal(report.scope, "automated");
  assert.equal(report.summary.automatedPass, 13);
  assert.equal(report.summary.mountedNotExecuted, 15);

  // All 13 automated fields must be PASS
  for (const field of M28_AUTOMATED_FIELDS) {
    assert.equal(report.matrix[field], "PASS");
  }

  // All 15 mounted fields must be NOT_EXECUTED
  for (const field of M28_MOUNTED_REQUIRED_FIELDS) {
    assert.equal(report.matrix[field], "NOT_EXECUTED");
  }

  // Report validation passes
  assert.equal(validateCandidateBoundReport(report, { candidateSha: dummyCandidateSha, scope: "automated" }), true);

  // Mismatch candidateSha throws
  assert.throws(
    () => validateCandidateBoundReport(report, { candidateSha: "fedcba9876543210fedcba9876543210fedcba98" }),
    /candidateSha mismatch/,
  );

  // Scope mounted requires all mounted fields to pass
  assert.throws(
    () => validateCandidateBoundReport(report, { candidateSha: dummyCandidateSha, scope: "mounted" }),
    /mounted field .* must be PASS/,
  );
});

test("v0.7 scope remains fleet workflows and capability-aware scheduling only", async () => {
  const [authorizationJsonText, authorizationMdText, roadmap] = await Promise.all([
    read("docs/release-attestations/v0.7-construction-authorization-2026-09-26.json"),
    read("docs/release-attestations/v0.7-construction-authorization-2026-09-26.md"),
    read("docs/roadmap.md"),
  ]);
  const authorization = JSON.parse(authorizationJsonText);

  for (const forbidden of [
    "a new route authority system beyond RFC-0010",
    "a new selector system beyond RFC-0011",
    "unrelated UI refactor",
    "unrelated runtime refactor",
    "tag or release creation/mutation without separate authorization",
    "production promotion without separate authorization",
    "DNS cutover without separate authorization",
  ]) {
    assert.ok(authorization.scopeFreeze.outOfScope.includes(forbidden));
  }

  assert.match(authorizationMdText, /capability-aware scheduling/i);
  assert.match(authorizationMdText, /aggregated results/i);
  assert.match(roadmap, /auditability of target selection and execution scope/i);
});
