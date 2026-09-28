import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  generateCandidateBoundAutomatedReport,
  generateM17AutomatedQualificationMatrix,
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

test("RFC-0017 M17 automated qualification report generation mirrors the v0.9 convention", () => {
  const candidateSha = "d".repeat(40);
  const matrix = generateM17AutomatedQualificationMatrix();
  assertM17MatrixShape(matrix, { scope: "automated" });
  assert.equal(Object.values(matrix).every((v) => v === "PASS" || v === "NOT_EXECUTED"), true);

  const report = generateCandidateBoundAutomatedReport({ candidateSha, runId: "v10-qual-test" });
  assert.equal(report.candidateSha, candidateSha);
  assert.equal(report.runId, "v10-qual-test");
  assert.equal(report.scope, "automated");
  assert.equal(report.summary.total, 17);
  assert.equal(report.summary.automatedPass, 13);
  assert.equal(report.summary.mountedNotExecuted, 4);
  assert.equal(report.summary.result, "QUALIFIED_AUTOMATED");
  assert.equal(validateCandidateBoundReport(report, { candidateSha, scope: "automated" }), true);
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

test("Caddyfile.example carries the adjudicated edge-exemption shape", async () => {
  const example = await read("docker-registry/Caddyfile.example");
  // Isolate the apex site block: from its site label to the next top-level
  // closing brace, so assertions cannot be satisfied by another site's
  // fallback handle (the registration site also carries one).
  const apexMarker = "dsh.example.local, *.dsh.example.local {";
  const apexStart = example.indexOf(apexMarker);
  assert.ok(apexStart > 0, "apex site block must exist");
  const apexEnd = example.indexOf("\n}", apexStart);
  assert.ok(apexEnd > apexStart, "apex site block must be closed at top level");
  const apexBlock = example.slice(apexStart, apexEnd);

  // Combined matchers + dedicated handle blocks (the house pattern), not
  // the invalid `handle path X` form a previous draft used.
  assert.match(apexBlock, /@qrLandingGet \{[\s\S]*?method GET[\s\S]*?path \/auth/);
  assert.match(apexBlock, /@qrVerifyPost \{[\s\S]*?method POST[\s\S]*?path \/hub\/pairing\/verify/);
  assert.doesNotMatch(apexBlock, /handle path \/auth/);

  // Host pinning (Gate C round 3): the exemption applies to the apex host
  // only — node-route and other wildcard hosts keep the gate.
  const landingMatcher = /@qrLandingGet \{[\s\S]*?\}/.exec(apexBlock)[0];
  const verifyMatcher = /@qrVerifyPost \{[\s\S]*?\}/.exec(apexBlock)[0];
  assert.match(landingMatcher, /host dsh\.example\.local/);
  assert.match(verifyMatcher, /host dsh\.example\.local/);

  // The gate lives inside a matcherless fallback handle WITHIN THE APEX
  // BLOCK — a site-level basic_auth would 401 the exempt paths regardless
  // of text order, and no fallback at all would remove the apex gate.
  const basicAuthCount = (apexBlock.match(/basic_auth/g) ?? []).length;
  assert.equal(basicAuthCount, 1, "apex block must carry exactly one basic_auth (inside the fallback handle)");
  const fallbackIndex = apexBlock.indexOf("handle {");
  const basicAuthIndex = apexBlock.indexOf("basic_auth");
  assert.ok(fallbackIndex > 0 && basicAuthIndex > fallbackIndex, "basic_auth must sit inside the matcherless fallback handle");

  // The do-not-widen rationale is inline where an operator will read it.
  assert.match(apexBlock, /Do not widen this list/);
});

test("Caddyfile.example passes real `caddy validate` (docker-gated)", async (t) => {
  let dockerOk = false;
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 30000 });
    dockerOk = true;
  } catch {
    dockerOk = false;
  }
  if (!dockerOk) {
    t.skip("docker unavailable");
    return;
  }
  const caddyfilePath = new URL("docker-registry/Caddyfile.example", ROOT);
  const windowsPath = decodeURIComponent(caddyfilePath.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const stdout = execFileSync(
    "docker",
    [
      "run", "--rm",
      "-v", `${windowsPath}:/tmp/Caddyfile:ro`,
      "caddy:2-alpine",
      "caddy", "validate", "--adapter", "caddyfile", "--config", "/tmp/Caddyfile",
    ],
    { encoding: "utf8", timeout: 120000 },
  );
  assert.match(stdout, /Valid configuration/);
});
