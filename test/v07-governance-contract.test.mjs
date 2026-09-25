import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  const [authorizationJsonText, authorizationMdText, finalReviewText, roadmap] = await Promise.all([
    read("docs/release-attestations/v0.7-construction-authorization-2026-09-26.json"),
    read("docs/release-attestations/v0.7-construction-authorization-2026-09-26.md"),
    read("docs/release-attestations/v0.6-stage6-final-review-2026-09-26.md"),
    read("docs/roadmap.md"),
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

  // Mechanically verify git existence and lineage
  assert.equal(gitObjectExists(ACCEPTED_V06_CLOSURE), true, `accepted v0.6 closure ${ACCEPTED_V06_CLOSURE} must exist in git`);
  assert.equal(
    gitIsAncestor(ACCEPTED_V06_CLOSURE, "HEAD"),
    true,
    `current HEAD must descend from accepted v0.6 closure ${ACCEPTED_V06_CLOSURE}`,
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
