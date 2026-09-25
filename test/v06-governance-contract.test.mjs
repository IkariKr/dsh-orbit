import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

const ACCEPTED_V05_CLOSURE = "bfcc541d84f3fc5fb3bb14fa54100276e41816ba";

test("v0.6 construction package is anchored to the accepted v0.5 closure", async () => {
  const [authorizationJsonText, authorizationMdText, finalReviewText, roadmap] = await Promise.all([
    read("docs/release-attestations/v0.6-construction-authorization-2026-09-25.json"),
    read("docs/release-attestations/v0.6-construction-authorization-2026-09-25.md"),
    read("docs/release-attestations/v0.5-stage8-final-review-2026-09-24.md"),
    read("docs/roadmap.md"),
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
});

test("v0.6 scope remains multi-node sessions only and excludes fleet/v0.7 scope", async () => {
  const [authorizationJsonText, authorizationMdText, roadmap] = await Promise.all([
    read("docs/release-attestations/v0.6-construction-authorization-2026-09-25.json"),
    read("docs/release-attestations/v0.6-construction-authorization-2026-09-25.md"),
    read("docs/roadmap.md"),
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
});
