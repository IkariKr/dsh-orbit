import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  const [authorizationJsonText, authorizationMdText, finalReviewText, roadmap] = await Promise.all([
    read("docs/release-attestations/v0.9-construction-authorization-2026-09-27.json"),
    read("docs/release-attestations/v0.9-construction-authorization-2026-09-27.md"),
    read("docs/review/2026-09-26-v08-stage6-final-review-c15ca58.md"),
    read("docs/roadmap.md"),
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
});

test("v0.9 construction authorization lineage is valid in git history", () => {
  assert.equal(gitObjectExists(ACCEPTED_V08_CLOSURE), true, "accepted v0.8 closure commit must exist");
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
  }).trim();
  assert.equal(gitIsAncestor(ACCEPTED_V08_CLOSURE, head), true, "HEAD must descend from accepted v0.8 closure");
});
