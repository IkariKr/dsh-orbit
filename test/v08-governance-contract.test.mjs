import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  const [authorizationJsonText, authorizationMdText, finalReviewText, roadmap] = await Promise.all([
    read("docs/release-attestations/v0.8-construction-authorization-2026-09-26.json"),
    read("docs/release-attestations/v0.8-construction-authorization-2026-09-26.md"),
    read("docs/review/2026-09-26-v07-stage6-final-review-53e29f3.md"),
    read("docs/roadmap.md"),
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
});

test("v0.8 construction authorization lineage is valid in git history", () => {
  assert.equal(gitObjectExists(ACCEPTED_V07_CLOSURE), true, "accepted v0.7 closure commit must exist");
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
  }).trim();
  assert.equal(gitIsAncestor(ACCEPTED_V07_CLOSURE, head), true, "HEAD must descend from accepted v0.7 closure");
});
