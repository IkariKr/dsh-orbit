import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  D14_ALLOWED_STATUSES,
  D14_MATRIX_FIELD_DEFINITIONS,
  D14_MATRIX_FIELDS,
  D14_MOUNTED_REQUIRED_FIELDS,
  assertCandidateSha,
  assertD14MatrixFieldKeys,
  assertD14MatrixShape,
  emptyD14Matrix,
  getD14MatrixFieldKeys,
  hasUniqueD14MatrixFieldKeys,
  isCandidateSha,
  validateCandidateBoundReport,
} from "../scripts/v05-reverse-acceptance-matrix.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");
const CANDIDATE_SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_CANDIDATE_SHA = "fedcba9876543210fedcba9876543210fedcba98";

function report(matrix = emptyD14Matrix(), candidateSha = CANDIDATE_SHA) {
  return { candidateSha, matrix };
}

function withMatrixValue(matrix, field, value) {
  return { ...matrix, [field]: value };
}

test("RFC-0012 D14 fields and minimum evidence are the shared contract", async () => {
  const rfc = await read("docs/rfc/0012-reverse-connected-nodes.md");
  const actual = [...rfc.matchAll(/^\|\s*(\d+)\s*\|\s*`([A-Za-z0-9]+)`\s*\|\s*(automated(?:\s*\+\s*mounted)?)\s*\|/gm)].map(
    ([, number, field, evidence]) => ({
      number: Number(number),
      field,
      minimumEvidence: evidence.includes("mounted") ? "mounted" : "automated",
    }),
  );
  const expected = D14_MATRIX_FIELD_DEFINITIONS.map((definition, index) => ({ number: index + 1, ...definition }));

  assert.equal(actual.length, 48);
  assert.deepEqual(actual, expected);
  assert.deepEqual(D14_MATRIX_FIELDS, expected.map(({ field }) => field));
  assert.equal(hasUniqueD14MatrixFieldKeys(), true);
  assert.doesNotThrow(() => assertD14MatrixFieldKeys());
  assert.equal(D14_MOUNTED_REQUIRED_FIELDS.length, 33);
});

test("empty D14 matrix has exactly 48 NOT_EXECUTED fields", () => {
  const matrix = emptyD14Matrix();
  assert.deepEqual(getD14MatrixFieldKeys(), D14_MATRIX_FIELDS);
  assert.equal(Object.keys(matrix).length, 48);
  assert.deepEqual(Object.keys(matrix), D14_MATRIX_FIELDS);
  assert.ok(Object.values(matrix).every((status) => status === "NOT_EXECUTED"));
  assert.doesNotThrow(() => assertD14MatrixShape(matrix));
  assert.throws(() => assertD14MatrixShape(matrix, { requirePass: true }), /must be PASS/);
});

test("D14 matrix shape rejects missing, extra, and malformed fields", () => {
  const matrix = emptyD14Matrix();
  const [firstField, secondField] = D14_MATRIX_FIELDS;
  const missing = { ...matrix };
  delete missing[firstField];
  assert.throws(() => assertD14MatrixShape(missing), /fields mismatch/);

  const extra = { ...matrix, unexpectedField: "NOT_EXECUTED" };
  assert.throws(() => assertD14MatrixShape(extra), /fields mismatch/);

  const invalidStatus = withMatrixValue(matrix, secondField, "SKIPPED");
  assert.throws(() => assertD14MatrixShape(invalidStatus), /invalid status/);

  for (const status of D14_ALLOWED_STATUSES) {
    assert.doesNotThrow(() => assertD14MatrixShape(withMatrixValue(matrix, firstField, status)));
  }
  assert.throws(() => assertD14MatrixShape({}), /fields mismatch/);
  assert.throws(() => assertD14MatrixShape([]), /must be an object/);
});

test("candidate SHA helper requires a complete 40-hex SHA", () => {
  assert.equal(isCandidateSha(CANDIDATE_SHA), true);
  assert.equal(isCandidateSha("a".repeat(39)), false);
  assert.equal(isCandidateSha("g".repeat(40)), false);
  assert.equal(isCandidateSha(undefined), false);
  assert.doesNotThrow(() => assertCandidateSha(CANDIDATE_SHA));
  assert.throws(() => assertCandidateSha("short"), /complete lowercase 40-hex SHA/);
});

test("candidate-bound validator fails closed on missing and mismatched bindings", () => {
  assert.doesNotThrow(() => validateCandidateBoundReport(report(), CANDIDATE_SHA));
  assert.throws(() => validateCandidateBoundReport(report(), OTHER_CANDIDATE_SHA), /candidate SHA mismatch/);
  assert.throws(() => validateCandidateBoundReport({ matrix: emptyD14Matrix() }, CANDIDATE_SHA), /report candidate SHA/);
  assert.throws(() => validateCandidateBoundReport({ candidateSha: CANDIDATE_SHA }, CANDIDATE_SHA), /matrix is required/);
  assert.throws(() => validateCandidateBoundReport({ candidateSha: "short", matrix: emptyD14Matrix() }, CANDIDATE_SHA), /report candidate SHA/);
});

test("candidate-bound validator rejects invalid matrix shape and status", () => {
  const matrix = emptyD14Matrix();
  const firstField = D14_MATRIX_FIELDS[0];
  assert.throws(
    () => validateCandidateBoundReport(report({ ...matrix, unexpectedField: "PASS" }), CANDIDATE_SHA),
    /fields mismatch/,
  );
  assert.throws(
    () => validateCandidateBoundReport(report(withMatrixValue(matrix, firstField, "SKIPPED")), CANDIDATE_SHA),
    /invalid status/,
  );
});

test("requirePass rejects every non-PASS status, including NOT_EXECUTED", () => {
  const matrix = Object.fromEntries(D14_MATRIX_FIELDS.map((field) => [field, "PASS"]));
  assert.doesNotThrow(() => validateCandidateBoundReport(report(matrix), { candidateSha: CANDIDATE_SHA, requirePass: true }));
  for (const status of ["FAIL", "NOT_EXECUTED", "BLOCKED"]) {
    const nonPassing = { ...matrix, [D14_MATRIX_FIELDS[0]]: status };
    assert.throws(
      () => validateCandidateBoundReport(report(nonPassing), { candidateSha: CANDIDATE_SHA, requirePass: true }),
      /must be PASS/,
    );
  }
});

test("mounted scope requires every mounted-required field to be PASS", () => {
  const matrix = Object.fromEntries(D14_MATRIX_FIELDS.map((field) => [field, "PASS"]));
  const mountedField = D14_MOUNTED_REQUIRED_FIELDS[0];
  const automatedField = D14_MATRIX_FIELDS.find((field) => !D14_MOUNTED_REQUIRED_FIELDS.includes(field));
  assert.ok(automatedField);

  assert.doesNotThrow(() => validateCandidateBoundReport(report(matrix), { candidateSha: CANDIDATE_SHA, scope: "mounted" }));
  assert.throws(
    () => validateCandidateBoundReport(report({ ...matrix, [mountedField]: "NOT_EXECUTED" }), { candidateSha: CANDIDATE_SHA, scope: "mounted" }),
    /mounted-required matrix/,
  );
  assert.doesNotThrow(
    () => validateCandidateBoundReport(report({ ...matrix, [automatedField]: "NOT_EXECUTED" }), { candidateSha: CANDIDATE_SHA, scope: "mounted" }),
  );
  assert.throws(
    () => validateCandidateBoundReport(report({ ...matrix, [automatedField]: "NOT_EXECUTED" }), {
      candidateSha: CANDIDATE_SHA,
      scope: "mounted",
      requirePass: true,
    }),
    /must be PASS/,
  );
  assert.throws(
    () => validateCandidateBoundReport(report(matrix), { candidateSha: CANDIDATE_SHA, scope: null }),
    /scope must be automated or mounted/,
  );
  assert.throws(
    () => validateCandidateBoundReport(report(matrix), { candidateSha: CANDIDATE_SHA, scope: "staging" }),
    /scope must be automated or mounted/,
  );
});
