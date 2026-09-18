import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const text = async (path) => readFile(new URL(path, ROOT), "utf8");

const requiredDocs = [
  "docs/configuration-reference.md",
  "docs/sop/v0.3-operator-sop.md",
  "docs/sop/v0.3-node-enrollment-sop.md",
  "docs/sop/v0.3-registry-backup-restore-sop.md",
  "docs/troubleshooting.md",
  "docs/release-attestations/v0.3-stage7-operational-hardening.md",
  "docs/release-attestations/v0.3.0-rc.1.md",
];

const readReleaseSources = async () =>
  Object.fromEntries(
    await Promise.all(
      [
        "CHANGELOG.md",
        "README.md",
        "docs/architecture.md",
        "docs/registry-mvp.md",
        "docs/registry-deployment.md",
        ...requiredDocs,
      ].map(async (path) => [path, await text(path)]),
    ),
  );

function gitObjectExists(object) {
  try {
    execFileSync("git", ["cat-file", "-e", `${object}^{commit}`], {
      cwd: new URL("../", import.meta.url),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function gitCommitParent(commit) {
  try {
    return execFileSync("git", ["rev-parse", `${commit}^`], {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
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

test("Stage 8 release candidate artifact set exists", async () => {
  for (const path of requiredDocs) await access(new URL(`../${path}`, import.meta.url));
  const changelog = await text("CHANGELOG.md");
  assert.match(changelog, /^## Unreleased$/m);
  assert.match(changelog, /^### 0\.3\.0-rc\.1 candidate - 2026-09-02$/m);
  assert.doesNotMatch(changelog, /^## 0\.3\.0-rc\.1 - 2026-08-31$/m);
});

test("Registry Compose requires an explicit release image tag", async () => {
  const compose = await text("docker-registry/compose.example.yaml");
  const imageLine = /^\s*image:\s+[^\n]+$/m.exec(compose)?.[0] ?? "";
  assert.match(
    imageLine,
    /image:\s+dsh-orbit-registry:\$\{DSH_ORBIT_REGISTRY_TAG:\?set DSH_ORBIT_REGISTRY_TAG\}/,
  );
  assert.doesNotMatch(imageLine, /v0\.3\.0-s6/);
  assert.doesNotMatch(imageLine, /:-/);

  const config = await text("docs/configuration-reference.md");
  assert.match(config, /`DSH_ORBIT_REGISTRY_TAG`/);
  assert.match(config, /Required.*Default.*Meaning and constraints/s);
  assert.match(config, /explicitly bound.*v0\.4\.0-rc\.2.*fail closed/s);
  assert.match(config, /Historical construction tags are not permitted/s);
});

test("Node enrollment SOP carries configuration through every CLI lifecycle", async () => {
  const source = await text("docs/sop/v0.3-node-enrollment-sop.md");
  for (const variable of [
    "DSH_ORBIT_NODE_STATE",
    "DSH_ORBIT_HUB_URL",
    "DSH_ORBIT_NODE_ORBIT_VERSION",
    "DSH_ORBIT_NODE_ORBIT_REVISION",
    "DSH_ORBIT_NODE_DSH_VERSION",
    "DSH_ORBIT_NODE_DSH_PROFILE",
    "DSH_ORBIT_NODE_HEARTBEAT_SECONDS",
  ]) {
    assert.match(source, new RegExp(`export ${variable}=`));
  }
  assert.match(source, /every Node CLI process/);
  assert.match(source, /never restores them from the state file/);
  assert.match(source, /DSH_ORBIT_ENROLL_TOKEN=.*node bin\/dsh-orbit-node\.mjs enroll/);
  assert.match(source, /DSH_ORBIT_REPORT_FILE=.*node bin\/dsh-orbit-node\.mjs upload-report/);
  assert.match(source, /DSH_ORBIT_REENROLL_TOKEN=.*node bin\/dsh-orbit-node\.mjs reenroll/);
  assert.doesNotMatch(source, /export DSH_ORBIT_(?:ENROLL_TOKEN|REENROLL_TOKEN|REPORT_FILE)=/);
});

test("Registry backup and restore SOP contains runnable primitive procedures", async () => {
  const source = await text("docs/sop/v0.3-registry-backup-restore-sop.md");
  assert.match(source, /There is no production backup or restore CLI/);
  assert.match(source, /npm run\s+stage7:drill[\s\S]*not a[\s\S]*production backup\/restore/);
  assert.match(source, /node --input-type=module/);
  assert.match(source, /DSH_ORBIT_REGISTRY_SOURCE=\/data\/orbit\/registry\.db/);
  assert.match(source, /DSH_ORBIT_REGISTRY_BACKUP=\/backups\/registry-\d+T\d+Z\.db/);
  assert.match(source, /DSH_ORBIT_REGISTRY_TARGET=\/data\/orbit\/registry\.db/);
  assert.match(source, /import \{ openRegistryDatabase \}/);
  assert.match(source, /backupRegistryDatabase/);
  assert.match(source, /restoreRegistryDatabase/);
  assert.match(source, /inspectRegistryDatabase/);
  assert.match(source, /const db = openRegistryDatabase\(sourcePath\);/);
  assert.match(source, /try \{[\s\S]*backupRegistryDatabase[\s\S]*finally \{[\s\S]*db\.close\(\)/);
  assert.match(source, /writersQuiesced: true/);
  assert.match(source, /const verificationDb = openRegistryDatabase\(targetPath\);/);
  assert.match(source, /verificationDb\.close\(\)/);
  assert.match(source, /VACUUM INTO/);
  assert.match(source, /WAL\/SHM/);
});

test("Operator readiness and release status wording match the implementation", async () => {
  const operator = await text("docs/sop/v0.3-operator-sop.md");
  assert.match(operator, /dsh-orbit-hub: registry listening/);
  assert.match(operator, /GET `?\/`? root\/UI readiness/);
  assert.match(operator, /authenticated `\/hub\/\*` state/);
  assert.doesNotMatch(operator, /health endpoint|`\/health`/i);

  const deployment = await text("docs/registry-deployment.md");
  const stage7 = await text("docs/release-attestations/v0.3-stage7-operational-hardening.md");
  assert.match(deployment, /Stage 7 is\s+complete and accepted/);
  assert.doesNotMatch(deployment, /Stage 7[^\n]*awaiting review/i);
  assert.match(stage7, /Status: \*\*complete; accepted\*\*/);
  assert.doesNotMatch(stage7, /Stage 7[^\n]*awaiting review/i);
  assert.doesNotMatch(stage7, /does not authorize\s+Stage 8/i);
});

test("RC attestation has valid release provenance and final-review disposition", async () => {
  const source = await text("docs/release-attestations/v0.3.0-rc.1.md");
  assert.doesNotMatch(source, /^attestationCommit:/m);

  const fields = Object.fromEntries(
    [
      "testedCommit",
      "initialEvidenceCommit",
      "executableLiveSmokeCommit",
      "releaseClosureParent",
      "releaseClosureCommit",
    ].map((field) => [
      field,
      new RegExp(`^${field}:\\s*([0-9a-f]{40})$`, "m").exec(source)?.[1],
    ]),
  );
  for (const [field, value] of Object.entries(fields)) {
    assert.ok(value, `attestation must record a full ${field} SHA`);
    assert.ok(gitObjectExists(value), `${field} ${value} must exist`);
  }

  assert.equal(
    fields.testedCommit,
    fields.releaseClosureCommit,
    "tested commit must be the release closure commit",
  );
  assert.equal(
    gitCommitParent(fields.releaseClosureCommit),
    fields.releaseClosureParent,
    "release closure parent must be the direct parent of the release closure commit",
  );
  assert.ok(
    gitIsAncestor(fields.initialEvidenceCommit, fields.releaseClosureCommit),
    "initial evidence commit must be an ancestor of the release closure commit",
  );
  assert.ok(
    gitIsAncestor(fields.executableLiveSmokeCommit, fields.releaseClosureCommit),
    "executable live smoke commit must be an ancestor of the release closure commit",
  );
  assert.equal(
    /^releaseClosureRange:\s*([^\n]+)$/m.exec(source)?.[1],
    `${fields.executableLiveSmokeCommit}..${fields.releaseClosureCommit}`,
    "release closure range must identify the executable smoke and closure commits",
  );
  assert.equal(
    /^orbitRevision:\s*([0-9a-f]{40})$/m.exec(source)?.[1],
    fields.testedCommit,
    "orbit revision must match the tested commit",
  );

  assert.match(source, /stage7Gate\.success: true/);
  assert.match(source, /stage7Gate\.failedPredicates: \[\]/);
  assert.match(source, /tag:\s*`?not-created/i);
  assert.match(source, /published:\s*`?false/i);
  assert.match(source, /promotion:\s*`?not-performed/i);
  assert.match(source, /awaiting-final-review/);
});

test("Stage 8 docs do not introduce forbidden feature scope", async () => {
  const sources = await readReleaseSources();
  const source = Object.values(sources).join("\n");
  assert.doesNotMatch(source, /reverse connections?\s+(?:are|will be)\s+implemented/i);
  assert.doesNotMatch(source, /feature\s+work\s+added/i);
  assert.doesNotMatch(source, /new (?:runtime )?(?:backup|restore) CLI/i);
});

test("Stage 8 provenance reconciliation historical record remains fail-closed", async () => {
  const report = await text("docs/release-attestations/v0.4-stage8-provenance-reconciliation-2026-09-18.md");
  const ledger = JSON.parse(await text("docs/release-attestations/v0.4-stage8-provenance-ledger-2026-09-18.json"));
  assert.match(report, /Provenance reconciliation: HOLD/);
  assert.match(report, /Stage 8 candidate: NOT SELECTED/);
  assert.match(report, /Stage 8 construction: NOT AUTHORIZED/);
  assert.match(report, /v0\.4\.0-rc\.1/);
  assert.match(report, /Final Review: NOT YET PERFORMED/);
  assert.match(report, /E8\.3/);
  assert.match(report, /E8\.5/);
  assert.match(report, /de8eb467a844ef56191f629cdecc6879e561d90a/);
  assert.match(report, /must be rebuilt/i);
  assert.doesNotMatch(report, /Stage 8: NOT STARTED/);
  assert.match(report, /historical wording `Stage 7 acceptance: HOLD`/);
  assert.match(report, /current\s+independent review disposition accepts `de8eb467`/);
  assert.match(report, /historical release action exists/);
  assert.match(report, /authorization\s+provenance is contradictory\/not independently verifiable/);
  assert.match(report, /merge `3b9a28f`/);
  assert.match(report, /`7a8bdf1` states/);
  assert.match(report, /PR #6/);
  assert.equal(ledger.status, "PROVENANCE RECONCILIATION HOLD");
  assert.equal(ledger.independentFinalReviewSearch.status, "NOT_INDEPENDENTLY_VERIFIABLE");
  assert.equal(ledger.mainlinePublicReconciliation.mergeCommit, "3b9a28fc88dcf05a5037aeff61bf1a3f62518592");
  assert.equal(ledger.candidateLineageDecision.newCandidateRequired, true);
  assert.ok(ledger.e85ReuseDecision.mustRebuild.includes("mounted-runner-raw.json"));
  assert.equal(ledger.candidate.selected, false);
  assert.ok(ledger.histories.some((item) => item.id === "root-e8.3" && item.status === "HOLD"));
  assert.ok(ledger.histories.some((item) => item.id === "e8.5" && item.classification.includes("historical")));
  assert.match(ledger.releaseContradictions[0].classification, /contradiction/);
  assert.ok(ledger.stopConditions.includes("No runtime construction started"));
  assert.ok(ledger.stopConditions.includes("No tag/release mutation"));
  assert.equal(ledger.subsequentConstructionAuthorization.authorizationId, "S8-CONSTRUCTION-20260918-A1");
  assert.equal(ledger.subsequentConstructionAuthorization.status, "AUTHORIZED_FOR_STAGE8_CONSTRUCTION");
  assert.match(ledger.subsequentConstructionAuthorization.effect, /supersedes only the pre-authorization construction stop/);
  assert.match(report, /later, separately reviewed construction authorization now exists/);
});

test("Stage 8 construction authorization is explicit, bounded, and non-self-referential", async () => {
  const report = await text("docs/release-attestations/v0.4-stage8-construction-authorization-2026-09-18.md");
  const auth = JSON.parse(await text("docs/release-attestations/v0.4-stage8-construction-authorization-2026-09-18.json"));
  const expectedMatrix = [
    "routeTargetsConfiguredAB",
    "routeTargetsPersisted",
    "eligibilityAB",
    "selectorListsAB",
    "selectorOpenA",
    "selectorOpenB",
    "httpRootA",
    "httpRootB",
    "staticAssetA",
    "staticAssetB",
    "websocketUpgradeA",
    "websocketUpgradeB",
    "websocketPingPongA",
    "websocketPingPongB",
    "cookieIsolation",
    "nodeContextIsolation",
    "gatewayRestartRecovery",
    "hubRestartRecovery",
    "nodeAFailClosedOutage",
    "nodeBHealthyDuringAOutage",
    "dshLossAndRecovery",
    "bookmarkFailClosed",
    "sameNodeIdReenroll",
    "freshHubRouteIdentity",
    "deleteBookmarkAndReenroll",
  ];

  assert.equal(auth.authorizationId, "S8-CONSTRUCTION-20260918-A1");
  assert.equal(auth.status, "AUTHORIZED_FOR_STAGE8_CONSTRUCTION");
  assert.equal(auth.acceptedRuntimeBase, "de8eb467a844ef56191f629cdecc6879e561d90a");
  assert.equal(auth.governancePredecessor, "2a1f41a734e0395615ab0ae1ee41173e257a42ec");
  assert.equal(auth.constructionLineage.candidateSelected, false);
  assert.equal(auth.constructionLineage.candidateMustBeFrozenBeforeEvidence, true);
  assert.equal(auth.candidateScope.runtimeSemanticChangesForbidden, true);
  for (const forbidden of [
    "src/**",
    "bin/**",
    "ui/**",
    "docker-registry/compose.example.yaml",
    "docker-registry/Caddyfile.example",
  ]) {
    assert.ok(auth.candidateScope.forbiddenProductPaths.includes(forbidden), `missing forbidden product path ${forbidden}`);
  }
  assert.ok(auth.candidateScope.candidateForbiddenPaths.includes("test/evidence/stage8/**"));
  assert.ok(auth.candidateScope.candidateForbiddenPaths.includes("docs/release-attestations/v0.4.0-rc.x.md"));
  assert.equal(auth.evidenceHarness.wholeCommitCherryPickForbidden, true);
  assert.equal(auth.evidenceHarness.minimumHarnessMustBeRebuilt, true);
  assert.deepEqual(auth.mountedMatrix.requiredFields, expectedMatrix);
  assert.equal(auth.mountedMatrix.requiredCount, expectedMatrix.length);
  assert.equal(expectedMatrix.length, 25);
  assert.equal(auth.diffGates.candidateToClosure.directChildRequired, true);
  assert.deepEqual(auth.diffGates.candidateToClosure.allowedPaths, [
    "docs/release-attestations/v0.4.0-rc.x.md",
    "test/evidence/stage8/**",
  ]);
  assert.equal(auth.diffGates.candidateToClosure.allOtherPathsForbidden, true);
  assert.equal(auth.closureRules.closureShaSelfReferenceForbidden, true);
  assert.equal(auth.closureRules.closureShaRecordedExternallyAfterCommit, true);
  assert.ok(auth.runResidueHygiene.forbiddenBeforeClosureCommit.includes("data/**"));
  for (const blocked of ["canonical E9", "P3", "tag or release creation/mutation", "production promotion"]) {
    assert.ok(auth.notAuthorized.includes(blocked), `authorization must continue to block ${blocked}`);
  }
  assert.equal(auth.finalReview.required, true);
  assert.equal(auth.finalReview.tagReleaseAuthorizationSeparate, true);
  assert.equal(auth.finalReview.productionPromotionAuthorizationSeparate, true);

  assert.match(report, /AUTHORIZED FOR STAGE 8 CONSTRUCTION/);
  assert.match(report, /pushed commit containing this\s+authorization record/);
  assert.match(report, /25 exact fields/);
  assert.match(report, /direct evidence-only closure child/);
  assert.match(report, /must not\s+require or predict its own closure Git SHA/);
  assert.match(report, /return to implementation\/security remediation/);
  assert.match(report, /Tag\/release and production promotion each require\s+separate explicit authorization/);
});

test("Stage 8 construction root and candidate boundary are mechanically anchored", async () => {
  const auth = JSON.parse(await text("docs/release-attestations/v0.4-stage8-construction-authorization-2026-09-18.json"));
  const repo = new URL("../", import.meta.url);
  const authorizationRoot = "6f766acfc67dff41afe15f228078938f44922a87";
  const current = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const allowed = (path) =>
    path === "CHANGELOG.md" || path === "README.md" || path === "package.json" || path === "package-lock.json" ||
    (path.startsWith("docs/") && path !== "docs/release-attestations/v0.4.0-rc.x.md") ||
    (path.startsWith("test/") && !path.startsWith("test/evidence/stage8/")) ||
    [
      "scripts/stage8-mounted-matrix.mjs",
      "scripts/emit-stage8-mounted-evidence.mjs",
      "scripts/registry-drill-firefox-bridge.py",
      "scripts/registry-drill.mjs",
      "docker-registry/drill.compose.yaml",
      "docker-registry/drill.Caddyfile",
      "docker-registry/dsh-drill.Caddyfile",
    ].includes(path);
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repo, encoding: "utf8" }).trimEnd();
  const statusPaths = status ? status.split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean) : [];
  assert.equal(auth.constructionLineage.candidateSelected, false);
  assert.equal(auth.constructionLineage.candidateMustBeFrozenBeforeEvidence, true);
  assert.equal(gitIsAncestor(auth.acceptedRuntimeBase, current), true);
  assert.equal(gitIsAncestor(auth.governancePredecessor, current), true);
  if (current === authorizationRoot) {
    assert.ok(statusPaths.every(allowed), `pre-freeze changes outside candidate allowlist: ${statusPaths.join(", ")}`);
  } else {
    assert.equal(gitIsAncestor(authorizationRoot, current), true);
    const committed = execFileSync("git", ["diff", "--name-only", `${authorizationRoot}..HEAD`], { cwd: repo, encoding: "utf8" }).trim();
    const committedPaths = committed ? committed.split(/\r?\n/).filter(Boolean) : [];
    assert.ok(committedPaths.length > 0, "frozen candidate must contain construction changes");
    assert.ok(committedPaths.every(allowed), `candidate paths outside allowlist: ${committedPaths.join(", ")}`);
    assert.equal(status, "", "frozen candidate worktree must be clean before evidence execution");
  }
  assert.equal(statusPaths.some((path) => path.startsWith("test/evidence/stage8/") || path === "docs/release-attestations/v0.4.0-rc.x.md" || path.startsWith("data/")), false, "pre-freeze worktree must not contain candidate evidence, attestation, or run residue");
});
