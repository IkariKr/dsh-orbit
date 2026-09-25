import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  M24_AUTOMATED_FIELDS,
  M24_MATRIX_FIELD_DEFINITIONS,
  M24_MATRIX_FIELDS,
  M24_MOUNTED_REQUIRED_FIELDS,
  assertCandidateSha,
  assertM24MatrixShape,
  emptyM24Matrix,
  generateCandidateBoundAutomatedReport,
  generateM24AutomatedQualificationMatrix,
  isCandidateSha,
  validateCandidateBoundReport,
} from "../scripts/v06-multinode-acceptance-matrix.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

const ACCEPTED_V05_CLOSURE = "bfcc541d84f3fc5fb3bb14fa54100276e41816ba";

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

test("v0.6 construction package is anchored to the accepted v0.5 closure", async () => {
  const [authorizationJsonText, authorizationMdText, finalReviewText, roadmap, rfc, sop] = await Promise.all([
    read("docs/release-attestations/v0.6-construction-authorization-2026-09-25.json"),
    read("docs/release-attestations/v0.6-construction-authorization-2026-09-25.md"),
    read("docs/release-attestations/v0.5-stage8-final-review-2026-09-24.md"),
    read("docs/roadmap.md"),
    read("docs/rfc/0013-multi-node-sessions-and-target-scope.md"),
    read("docs/sop/v0.6-multi-node-sessions-multistage-sop.md"),
  ]);
  const authorization = JSON.parse(authorizationJsonText);

  assert.equal(authorization.authorizationId, "V06-CONSTRUCTION-20260925-A1");
  assert.equal(authorization.acceptedV05Closure, ACCEPTED_V05_CLOSURE);
  assert.equal(authorization.constructionLineage.mustDescendFromAcceptedV05Closure, true);
  assert.match(authorization.objective, /multi-node sessions/);
  assert.equal(authorization.status, "AUTHORIZED_FOR_V06_CONSTRUCTION");

  assert.match(authorizationMdText, /V06-CONSTRUCTION-20260925-A1/);
  assert.match(authorizationMdText, new RegExp(ACCEPTED_V05_CLOSURE));
  assert.match(authorizationMdText, /RFC-0013/);

  assert.match(finalReviewText, /v0\.5 STAGE 8 CLOSED/);
  assert.match(finalReviewText, /v0\.5 ENGINEERING ACCEPTANCE = PASS/);
  assert.match(finalReviewText, new RegExp(ACCEPTED_V05_CLOSURE));

  assert.match(roadmap, /## 0\.6: multi-node sessions/);
  assert.match(roadmap, /V06-CONSTRUCTION-20260925-A1/);
  assert.match(roadmap, new RegExp(ACCEPTED_V05_CLOSURE));
  assert.match(roadmap, /RFC-0013/);

  assert.match(rfc, /Product construction is blocked until the Stage 0 \/ Gate A review records GO/);
  assert.match(rfc, /explicit single-node target scope/i);
  assert.match(rfc, /strict per-node session and cookie isolation/i);

  assert.match(sop, new RegExp(ACCEPTED_V05_CLOSURE));
  assert.match(sop, /Gate A/);
  assert.match(sop, /Gate B/);
  assert.match(sop, /Gate C/);

  // Mechanically verify the authorization commit cited in the SOP
  const sopAuthCommitMatch = /v0\.6 construction authorization commit:\s*```text\s*([0-9a-f]{40})\s*```/m.exec(sop);
  assert.ok(sopAuthCommitMatch, "SOP must cite a 40-character lower-case hex authorization commit SHA");
  const sopAuthCommit = sopAuthCommitMatch[1];
  assert.equal(gitObjectExists(sopAuthCommit), true, `SOP authorization commit ${sopAuthCommit} must exist in git`);
  assert.equal(
    gitIsAncestor(ACCEPTED_V05_CLOSURE, sopAuthCommit),
    true,
    `SOP authorization commit must descend from accepted v0.5 closure ${ACCEPTED_V05_CLOSURE}`,
  );
  assert.equal(
    gitIsAncestor(sopAuthCommit, "HEAD"),
    true,
    `current HEAD must descend from SOP authorization commit ${sopAuthCommit}`,
  );
});

test("RFC-0013 freezes the exact 24-field multi-node acceptance matrix", async () => {
  const rfc = await read("docs/rfc/0013-multi-node-sessions-and-target-scope.md");
  const actual = [...rfc.matchAll(/^\|\s*(\d+)\s*\|\s*`([A-Za-z0-9]+)`\s*\|\s*(automated|mounted)\s*\|/gm)].map(
    ([, number, field, scope]) => ({
      number: Number(number),
      field,
      minimumEvidence: scope,
    }),
  );
  const expected = M24_MATRIX_FIELD_DEFINITIONS.map((def, idx) => ({ number: idx + 1, ...def }));

  assert.equal(actual.length, 24);
  assert.deepEqual(actual, expected);
  assert.deepEqual(M24_MATRIX_FIELDS, expected.map(({ field }) => field));
  assert.equal(new Set(M24_MATRIX_FIELDS).size, 24);
  assert.equal(M24_AUTOMATED_FIELDS.length, 7);
  assert.equal(M24_MOUNTED_REQUIRED_FIELDS.length, 17);
});

test("empty M24 matrix has exactly 24 NOT_EXECUTED fields", () => {
  const matrix = emptyM24Matrix();
  assert.equal(Object.keys(matrix).length, 24);
  assert.deepEqual(Object.keys(matrix), M24_MATRIX_FIELDS);
  assert.ok(Object.values(matrix).every((status) => status === "NOT_EXECUTED"));
  assert.doesNotThrow(() => assertM24MatrixShape(matrix));
  assert.throws(() => assertM24MatrixShape(matrix, { requirePass: true }), /must be PASS/);
});

test("M24 candidate-bound automated qualification report generation and validation", () => {
  const dummyCandidateSha = "0123456789abcdef0123456789abcdef01234567";
  const report = generateCandidateBoundAutomatedReport({
    candidateSha: dummyCandidateSha,
    runId: "v06-qual-test-run",
  });

  assert.equal(report.candidateSha, dummyCandidateSha);
  assert.equal(report.runId, "v06-qual-test-run");
  assert.equal(report.scope, "automated");
  assert.equal(report.summary.automatedPass, 7);
  assert.equal(report.summary.mountedNotExecuted, 17);

  // All 7 automated fields must be PASS
  for (const field of M24_AUTOMATED_FIELDS) {
    assert.equal(report.matrix[field], "PASS");
  }

  // All 17 mounted fields must be NOT_EXECUTED
  for (const field of M24_MOUNTED_REQUIRED_FIELDS) {
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

test("v0.6 scope remains multi-node sessions only and excludes fleet/v0.7 scope", async () => {
  const [authorizationJsonText, authorizationMdText, roadmap, rfc, sop] = await Promise.all([
    read("docs/release-attestations/v0.6-construction-authorization-2026-09-25.json"),
    read("docs/release-attestations/v0.6-construction-authorization-2026-09-25.md"),
    read("docs/roadmap.md"),
    read("docs/rfc/0013-multi-node-sessions-and-target-scope.md"),
    read("docs/sop/v0.6-multi-node-sessions-multistage-sop.md"),
  ]);
  const authorization = JSON.parse(authorizationJsonText);

  for (const forbidden of [
    "fleet workflows and scheduled multi-node command execution (roadmap 0.7)",
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

  assert.match(authorizationMdText, /implicit broadcast execution/i);
  assert.match(authorizationMdText, /per-node session and cookie isolation/i);
  assert.match(roadmap, /no implicit broadcast execution/i);
  assert.match(roadmap, /per-node session isolation/i);
  assert.match(rfc, /zero implicit broadcast/i);
  assert.match(sop, /Strict target scope & no broadcast/i);
});
