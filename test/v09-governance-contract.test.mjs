import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  M36_AUTOMATED_FIELDS,
  M36_MATRIX_FIELD_DEFINITIONS,
  M36_MATRIX_FIELDS,
  M36_MOUNTED_REQUIRED_FIELDS,
  assertCandidateSha,
  assertM36MatrixShape,
  emptyM36Matrix,
  generateCandidateBoundAutomatedReport,
  generateM36AutomatedQualificationMatrix,
  isCandidateSha,
  validateCandidateBoundReport,
} from "../scripts/v09-plugin-qr-acceptance-matrix.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

const ACCEPTED_V08_CLOSURE = "c15ca5865f1519fccbb277f2a440c3b1496e1bb9";

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

test("v0.9 construction package is anchored to the accepted v0.8 closure", async () => {
  const [authorizationJsonText, authorizationMdText, finalReviewText, roadmap, rfc, sop] = await Promise.all([
    read("docs/release-attestations/v0.9-construction-authorization-2026-09-27.json"),
    read("docs/release-attestations/v0.9-construction-authorization-2026-09-27.md"),
    read("docs/review/2026-09-26-v08-stage6-final-review-c15ca58.md"),
    read("docs/roadmap.md"),
    read("docs/rfc/0016-dsh-plugin-integration-and-qr-pairing.md"),
    read("docs/sop/v0.9-dsh-plugin-and-qr-pairing-multistage-sop.md"),
  ]);
  const authorization = JSON.parse(authorizationJsonText);

  assert.equal(authorization.authorizationId, "V09-CONSTRUCTION-20260927-A1");
  assert.equal(authorization.acceptedV08Closure, ACCEPTED_V08_CLOSURE);
  assert.equal(authorization.constructionLineage.mustDescendFromAcceptedV08Closure, true);
  assert.match(authorization.objective, /DSH native plugin/);
  assert.equal(authorization.status, "AUTHORIZED_FOR_V09_CONSTRUCTION");

  assert.match(authorizationMdText, /V09-CONSTRUCTION-20260927-A1/);
  assert.match(authorizationMdText, new RegExp(ACCEPTED_V08_CLOSURE));
  assert.match(authorizationMdText, /RFC-0016/);

  assert.match(finalReviewText, /Gate 4 Final Review Verdict/);
  assert.match(finalReviewText, /\*\*PASS/);
  assert.match(finalReviewText, /v0\.8 engineering acceptance is CLOSED/);

  assert.match(roadmap, /## 0\.9: DSH native plugin integration and QR pairing bootstrap/);
  assert.match(roadmap, /V09-CONSTRUCTION-20260927-A1/);

  assert.match(rfc, /# RFC 0016: DSH Native Plugin Integration and QR Pairing Bootstrap for v0\.9/);
  assert.match(rfc, /V09-CONSTRUCTION-20260927-A1/);

  assert.match(sop, /# v0\.9 DSH Native Plugin Integration & QR Pairing Bootstrap Multistage SOP/);
  assert.match(sop, new RegExp(ACCEPTED_V08_CLOSURE));
});

test("v0.9 construction authorization lineage is valid in git history", () => {
  assert.equal(gitObjectExists(ACCEPTED_V08_CLOSURE), true, "accepted v0.8 closure commit must exist");
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
  }).trim();
  assert.equal(gitIsAncestor(ACCEPTED_V08_CLOSURE, head), true, "HEAD must descend from accepted v0.8 closure");
});

test("RFC-0016 M36 acceptance matrix defines exactly 36 canonical fields", () => {
  assert.equal(M36_MATRIX_FIELD_DEFINITIONS.length, 36);
  assert.equal(M36_MATRIX_FIELDS.length, 36);
  assert.equal(M36_AUTOMATED_FIELDS.length, 17);
  assert.equal(M36_MOUNTED_REQUIRED_FIELDS.length, 19);

  // Inherited 32 fields from RFC-0015
  assert.ok(M36_MATRIX_FIELDS.includes("fleetJobListObservability"));
  assert.ok(M36_MATRIX_FIELDS.includes("fleetTaskExecutionDirectNode"));
  assert.ok(M36_MATRIX_FIELDS.includes("fleetTaskExecutionReverseNode"));
  assert.ok(M36_MATRIX_FIELDS.includes("zeroCrossNodeCredentialLeakInJob"));
  assert.ok(M36_MATRIX_FIELDS.includes("scheduledWorkflowDefinitionPersistence"));
  assert.ok(M36_MATRIX_FIELDS.includes("scheduledWorkflowCronAndIntervalParsing"));
  assert.ok(M36_MATRIX_FIELDS.includes("scheduledWorkflowAutomatedDispatch"));
  assert.ok(M36_MATRIX_FIELDS.includes("scheduledWorkflowLifecycleAndAudit"));

  // 4 new plugin & QR fields
  assert.ok(M36_MATRIX_FIELDS.includes("dshPluginCordisRegistration"));
  assert.ok(M36_MATRIX_FIELDS.includes("dshSettingsNamespacePersistence"));
  assert.ok(M36_MATRIX_FIELDS.includes("dshNativeSettingsSlotInjection"));
  assert.ok(M36_MATRIX_FIELDS.includes("qrPairingBootstrapAndExchange"));

  assert.equal(new Set(M36_MATRIX_FIELDS).size, 36);
});

test("RFC-0016 M36 matrix assertions and report generation work correctly", () => {
  const empty = emptyM36Matrix();
  assert.equal(Object.keys(empty).length, 36);
  assert.equal(Object.values(empty).every((v) => v === "NOT_EXECUTED"), true);

  const autoMatrix = generateM36AutomatedQualificationMatrix();
  assertM36MatrixShape(autoMatrix, { scope: "automated" });
  assert.throws(() => assertM36MatrixShape(autoMatrix, { scope: "mounted", requirePass: true }));

  const candidateSha = "a".repeat(40);
  assert.equal(isCandidateSha(candidateSha), true);
  assertCandidateSha(candidateSha);

  const report = generateCandidateBoundAutomatedReport({ candidateSha });
  assert.equal(report.candidateSha, candidateSha);
  assert.equal(report.scope, "automated");
  assert.equal(report.summary.automatedPass, 17);
  assert.equal(report.summary.mountedNotExecuted, 19);
  assert.equal(validateCandidateBoundReport(report, { candidateSha, scope: "automated" }), true);
});
