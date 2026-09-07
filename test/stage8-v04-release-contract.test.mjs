import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const text = async (path) => readFile(new URL(path, ROOT), "utf8");
const rootPath = new URL("../", import.meta.url);

const STAGE8_C8_BASE = "5a6f94fa8bfc1adf850627d28f2cad150af55c20";
const STAGE7_E72_BASE = "b8bdbbda91180b91005f9344aa28fa029cf37df2";

function gitCommitExists(commit) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: rootPath, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitCommitParent(commit) {
  try {
    return execFileSync("git", ["rev-parse", `${commit}^`], { cwd: rootPath, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function gitCommitDate(commit) {
  const iso = execFileSync("git", ["show", "-s", "--format=%cI", commit], { cwd: rootPath, encoding: "utf8" }).trim();
  return new Date(iso);
}

function gitCommitSubject(commit) {
  return execFileSync("git", ["show", "-s", "--format=%s", commit], { cwd: rootPath, encoding: "utf8" }).trim();
}

function gitTagExists(tag) {
  try {
    execFileSync("git", ["show-ref", "--tags", "--verify", `refs/tags/${tag}`], { cwd: rootPath, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootPath, encoding: "utf8" }).trim();
}

function gitIsAncestor(ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: rootPath, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function assertFullCommit(commit, label) {
  assert.match(commit ?? "", /^[0-9a-f]{40}$/, `${label} must be a full 40-character SHA`);
  assert.equal(gitCommitExists(commit), true, `${label} must resolve to a real commit`);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Mechanically validates release provenance for a given bundle.
 * If mode === "final-release", requires all gates (mounted PASS, closure SHA in attestation,
 * strict chronology, no pending wording) or throws an assertion error (fail closed).
 */
function validateReleaseProvenance({
  candidateCommit,
  releaseClosureCommit,
  candidateCommitDate,
  closureCommitDate,
  parentBaseline,
  manifest,
  artifacts,
  attestationText,
  mode = "evaluate",
}) {
  assertFullCommit(candidateCommit, "executableCandidateCommit");
  assertFullCommit(releaseClosureCommit, "releaseClosureCommit");
  assert.equal(gitCommitParent(releaseClosureCommit), candidateCommit, "releaseClosureCommit parent must equal candidateCommit");
  assert.equal(gitIsAncestor(STAGE8_C8_BASE, candidateCommit), true, "candidateCommit must descend from C8");

  assert.equal(manifest.testedCandidateCommit, candidateCommit, "manifest.testedCandidateCommit must equal candidateCommit");
  assert.equal(manifest.parentStage7Evidence, parentBaseline, "manifest.parentStage7Evidence must match parent baseline");

  assert.ok(attestationText.includes(candidateCommit), "attestation must contain candidateCommit SHA");
  assert.ok(attestationText.includes(parentBaseline), "attestation must contain parent baseline SHA");

  for (const [fileName, meta] of Object.entries(manifest.artifacts)) {
    const artifact = artifacts[fileName];
    assert.ok(artifact, `artifact ${fileName} must be provided`);
    const actualSha = sha256(artifact.buffer);
    assert.equal(actualSha, meta.sha256, `${fileName} sha256 mismatch`);
    assert.equal(artifact.buffer.byteLength, meta.bytes, `${fileName} bytes mismatch`);
    assert.equal(artifact.json.candidateCommit, candidateCommit, `${fileName} candidateCommit mismatch`);

    const executedDate = new Date(artifact.json.executedAt);
    assert.ok(!Number.isNaN(executedDate.getTime()), `${fileName} executedAt must be a valid date`);
    assert.ok(
      candidateCommitDate.getTime() < executedDate.getTime(),
      `chronology: candidate commit (${candidateCommitDate.toISOString()}) must precede ${fileName} executedAt (${executedDate.toISOString()})`,
    );

    if (mode === "final-release") {
      assert.ok(
        executedDate.getTime() < closureCommitDate.getTime(),
        `chronology: ${fileName} executedAt (${executedDate.toISOString()}) must precede closure commit (${closureCommitDate.toISOString()})`,
      );
    }
  }

  const mountedArtifact = artifacts["two-node-mounted-smoke.json"]?.json;
  const isPass =
    mountedArtifact?.result === "PASS" &&
    manifest.physicalMountedGate === "PASS" &&
    attestationText.includes(releaseClosureCommit) &&
    !/\bpending\b/i.test(attestationText);

  if (mode === "final-release") {
    assert.equal(mountedArtifact?.result, "PASS", "final release requires mounted smoke result PASS");
    assert.equal(manifest.physicalMountedGate, "PASS", "final release requires manifest physicalMountedGate PASS");
    assert.ok(attestationText.includes(releaseClosureCommit), "final release requires releaseClosureCommit in attestation");
    assert.doesNotMatch(attestationText, /\bpending\b/i, "final release forbids pending wording in attestation");
  }

  return { isPass, candidateCommit, releaseClosureCommit };
}

const requiredDocs = [
  "package.json",
  "CHANGELOG.md",
  "README.md",
  "docs/architecture.md",
  "docs/roadmap.md",
  "docs/configuration-reference.md",
  "docs/sop/v0.3-operator-sop.md",
  "docs/sop/v0.4-selector-operator-sop.md",
  "docs/sop/v0.3-node-enrollment-sop.md",
  "docs/sop/v0.3-registry-backup-restore-sop.md",
  "docs/sop/v0.4-production-promotion-rollback-plan.md",
  "docs/troubleshooting.md",
  "docs/release-attestations/v0.4-stage7-failure-hardening.md",
];

test("Stage 8 v0.4 release closure artifacts and version declarations", async () => {
  const releaseClosure = currentCommit();
  const candidate = gitCommitParent(releaseClosure);
  assertFullCommit(releaseClosure, "release closure commit (current HEAD)");
  assertFullCommit(candidate, "executable candidate commit (HEAD^)");
  assert.equal(gitCommitParent(releaseClosure), candidate, "release closure parent must equal executable candidate commit");
  assert.equal(gitIsAncestor(STAGE8_C8_BASE, candidate), true, "executable candidate must descend from C8");
  assert.equal(gitTagExists("v0.4.0-rc.1"), false, "release tag must not exist before Final Review");
  const lock = JSON.parse(await text("package-lock.json"));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.version, "0.4.0-rc.1");
  assert.equal(lock.packages?.[""].version, "0.4.0-rc.1");
  for (const path of requiredDocs) {
    await access(new URL(`../${path}`, import.meta.url));
  }

  const pkg = JSON.parse(await text("package.json"));
  assert.equal(pkg.version, "0.4.0-rc.1");

  const changelog = await text("CHANGELOG.md");
  assert.match(changelog, /### 0\.4\.0-rc\.1 candidate/);

  const readme = await text("README.md");
  assert.match(readme, /0\.4\.0-rc\.1/);
  assert.match(readme, /Reverse-connected nodes are not part of v0\.4/i);

  const roadmap = await text("docs/roadmap.md");
  assert.match(roadmap, /Implemented in `v0\.4\.0-rc\.1`/);
  assert.match(roadmap, /Reverse-connected nodes are not part of v0\.4/i);

  const architecture = await text("docs/architecture.md");
  assert.match(architecture, /Implemented v0\.4 Endpoint Selector/);
  assert.match(architecture, /Reverse-connected nodes are not part of v0\.4/i);

  const config = await text("docs/configuration-reference.md");
  assert.match(config, /`DSH_ORBIT_NODE_ORBIT_VERSION`.*`0\.4\.0-rc\.1`/s);
  assert.match(config, /`DSH_ORBIT_REGISTRY_TAG`.*`v0\.4\.0-rc\.1`/s);
});

test("Stage 8 v0.4 release provenance contract: candidate vs closure, evidence manifest, and fail-closed gate", async () => {
  const releaseClosureCommit = currentCommit();
  const candidateCommit = gitCommitParent(releaseClosureCommit);

  assertFullCommit(releaseClosureCommit, "releaseClosureCommit (current HEAD)");
  assertFullCommit(candidateCommit, "executableCandidateCommit (parent of HEAD)");
  assert.equal(gitCommitParent(releaseClosureCommit), candidateCommit, "release closure parent must equal executable candidate");
  assert.equal(gitIsAncestor(STAGE8_C8_BASE, candidateCommit), true, "executable candidate must descend from C8");

  // Candidate commit must be an executable commit (C8.1/C8.2), not an evidence closure commit (E8.1/E8.2)
  const candidateSubject = gitCommitSubject(candidateCommit);
  assert.doesNotMatch(candidateSubject, /^docs\(release\):/i, "candidate commit must be an executable C8.1/C8.2 commit, not an evidence E8 commit");

  // Tag must not exist before final review
  assert.equal(gitTagExists("v0.4.0-rc.1"), false, "release tag v0.4.0-rc.1 must not exist before Final Review");

  const manifestText = await text("test/evidence/stage8/manifest.json");
  const manifest = JSON.parse(manifestText);
  const attestation = await text("docs/release-attestations/v0.4.0-rc.1.md");

  assert.equal(manifest.testedCandidateCommit, candidateCommit, "manifest.testedCandidateCommit must equal candidateCommit");
  assert.equal(manifest.parentStage7Evidence, STAGE7_E72_BASE, "manifest parentStage7Evidence must match Stage 7 baseline");

  assert.ok(attestation.includes(candidateCommit), "attestation must contain exact candidateCommit SHA");
  assert.ok(attestation.includes(STAGE7_E72_BASE), "attestation must contain parent Stage 7 baseline SHA");

  const candidateCommitDate = gitCommitDate(candidateCommit);
  const closureCommitDate = gitCommitDate(releaseClosureCommit);

  const artifacts = {};
  for (const [fileName, meta] of Object.entries(manifest.artifacts)) {
    const buf = await readFile(new URL(`test/evidence/stage8/${fileName}`, ROOT));
    const actualSha = sha256(buf);
    assert.equal(actualSha, meta.sha256, `${fileName} sha256 must match manifest.json`);
    assert.equal(buf.byteLength, meta.bytes, `${fileName} byte count must match manifest.json`);

    const parsed = JSON.parse(buf.toString("utf8"));
    assert.equal(parsed.candidateCommit, candidateCommit, `${fileName} candidateCommit must match executable candidate`);

    const executedDate = new Date(parsed.executedAt);
    assert.ok(!Number.isNaN(executedDate.getTime()), `${fileName} executedAt must be a valid ISO date`);
    assert.ok(
      candidateCommitDate.getTime() < executedDate.getTime(),
      `chronology violation: candidate commit timestamp (${candidateCommitDate.toISOString()}) must precede ${fileName} executedAt (${executedDate.toISOString()})`,
    );

    artifacts[fileName] = { buffer: buf, json: parsed };
  }

  // Validate release gate disposition: mounted result must be PASS/executed for a release PASS, otherwise contract must fail closed.
  const mountedSmoke = artifacts["two-node-mounted-smoke.json"].json;
  const isFinalReleasePass =
    mountedSmoke.result === "PASS" &&
    manifest.physicalMountedGate === "PASS" &&
    attestation.includes(releaseClosureCommit) &&
    !/\bpending\b/i.test(attestation);

  if (isFinalReleasePass) {
    // Final release acceptance criteria (expected once updated for C8.2/E8.2)
    assert.equal(mountedSmoke.result, "PASS", "two-node mounted smoke must be PASS for release");
    assert.equal(manifest.physicalMountedGate, "PASS", "manifest physicalMountedGate must be PASS for release");
    assert.ok(attestation.includes(releaseClosureCommit), "attestation must contain releaseClosureCommit SHA");
    assert.doesNotMatch(attestation, /\bpending\b/i, "attestation must have no pending wording");
    for (const [fileName, art] of Object.entries(artifacts)) {
      const executedDate = new Date(art.json.executedAt);
      assert.ok(
        executedDate.getTime() < closureCommitDate.getTime(),
        `chronology: ${fileName} executedAt must precede releaseClosureCommit timestamp`,
      );
    }
  } else {
    // Fail-closed gate: mounted smoke is not PASS; contract fails closed.
    // Assert current evidence currently HOLD (expected until updated for C8.2/E8.2)
    assert.notEqual(mountedSmoke.result, "PASS", "contract must fail closed when mounted smoke is not PASS");
    assert.match(manifest.status, /HOLD/i, "manifest must record HOLD status when not releasable");
    assert.match(attestation, /HOLD/i, "attestation must record HOLD status when not releasable");
    assert.match(attestation, /NOT AUTHORIZED TO PASS/i, "attestation must state NOT AUTHORIZED TO PASS when on HOLD");
  }
});

test("Stage 8 v0.4 release provenance mechanical validation: enforce fail-closed gate semantics", () => {
  const candidateCommit = "6245c66d399bb8d593ab445649135699c28d0bcc";
  const releaseClosureCommit = "cee5efce4dae090407b07cc77859d7fa2cfb53e5";
  const candidateCommitDate = new Date("2026-09-07T07:42:34.000Z");
  const closureCommitDate = new Date("2026-09-07T08:30:00.000Z");

  const validFreshInstallJson = {
    schemaVersion: 1,
    candidateCommit,
    executedAt: "2026-09-07T08:00:00.000Z",
    result: "PASS",
  };
  const validMountedSmokeJson = {
    schemaVersion: 1,
    candidateCommit,
    executedAt: "2026-09-07T08:10:00.000Z",
    result: "PASS",
  };
  const freshBuf = Buffer.from(JSON.stringify(validFreshInstallJson));
  const mountedBuf = Buffer.from(JSON.stringify(validMountedSmokeJson));

  const validManifest = {
    testedCandidateCommit: candidateCommit,
    parentStage7Evidence: STAGE7_E72_BASE,
    physicalMountedGate: "PASS",
    artifacts: {
      "fresh-install.json": { sha256: sha256(freshBuf), bytes: freshBuf.byteLength },
      "two-node-mounted-smoke.json": { sha256: sha256(mountedBuf), bytes: mountedBuf.byteLength },
    },
  };
  const validAttestation = `Candidate: ${candidateCommit}\nClosure: ${releaseClosureCommit}\nParent: ${STAGE7_E72_BASE}\nStatus: PASS`;

  const validArtifacts = {
    "fresh-install.json": { buffer: freshBuf, json: validFreshInstallJson },
    "two-node-mounted-smoke.json": { buffer: mountedBuf, json: validMountedSmokeJson },
  };

  // 1. Valid final release bundle passes
  const validResult = validateReleaseProvenance({
    candidateCommit,
    releaseClosureCommit,
    candidateCommitDate,
    closureCommitDate,
    parentBaseline: STAGE7_E72_BASE,
    manifest: validManifest,
    artifacts: validArtifacts,
    attestationText: validAttestation,
    mode: "final-release",
  });
  assert.equal(validResult.isPass, true);

  // 2. Fails closed if mounted smoke result is not PASS
  const blockedMountedJson = { ...validMountedSmokeJson, result: "BLOCKED" };
  const blockedBuf = Buffer.from(JSON.stringify(blockedMountedJson));
  assert.throws(
    () =>
      validateReleaseProvenance({
        candidateCommit,
        releaseClosureCommit,
        candidateCommitDate,
        closureCommitDate,
        parentBaseline: STAGE7_E72_BASE,
        manifest: {
          ...validManifest,
          physicalMountedGate: "BLOCKED",
          artifacts: {
            ...validManifest.artifacts,
            "two-node-mounted-smoke.json": { sha256: sha256(blockedBuf), bytes: blockedBuf.byteLength },
          },
        },
        artifacts: {
          ...validArtifacts,
          "two-node-mounted-smoke.json": { buffer: blockedBuf, json: blockedMountedJson },
        },
        attestationText: validAttestation,
        mode: "final-release",
      }),
    /final release requires mounted smoke result PASS/,
  );

  // 3. Fails closed if attestation contains pending wording
  assert.throws(
    () =>
      validateReleaseProvenance({
        candidateCommit,
        releaseClosureCommit,
        candidateCommitDate,
        closureCommitDate,
        parentBaseline: STAGE7_E72_BASE,
        manifest: validManifest,
        artifacts: validArtifacts,
        attestationText: `${validAttestation}\nDocs pending commit below`,
        mode: "final-release",
      }),
    /final release forbids pending wording/,
  );

  // 4. Fails closed if attestation lacks releaseClosureCommit
  assert.throws(
    () =>
      validateReleaseProvenance({
        candidateCommit,
        releaseClosureCommit,
        candidateCommitDate,
        closureCommitDate,
        parentBaseline: STAGE7_E72_BASE,
        manifest: validManifest,
        artifacts: validArtifacts,
        attestationText: `Candidate: ${candidateCommit}\nParent: ${STAGE7_E72_BASE}\nStatus: PASS`,
        mode: "final-release",
      }),
    /final release requires releaseClosureCommit in attestation/,
  );

  // 5. Fails closed if executedAt is after closure timestamp
  const lateMountedJson = { ...validMountedSmokeJson, executedAt: "2026-09-07T09:00:00.000Z" };
  const lateBuf = Buffer.from(JSON.stringify(lateMountedJson));
  assert.throws(
    () =>
      validateReleaseProvenance({
        candidateCommit,
        releaseClosureCommit,
        candidateCommitDate,
        closureCommitDate,
        parentBaseline: STAGE7_E72_BASE,
        manifest: {
          ...validManifest,
          artifacts: {
            ...validManifest.artifacts,
            "two-node-mounted-smoke.json": { sha256: sha256(lateBuf), bytes: lateBuf.byteLength },
          },
        },
        artifacts: {
          ...validArtifacts,
          "two-node-mounted-smoke.json": { buffer: lateBuf, json: lateMountedJson },
        },
        attestationText: validAttestation,
        mode: "final-release",
      }),
    /chronology: two-node-mounted-smoke\.json executedAt .* must precede closure commit/,
  );

  // 6. Fails closed if executedAt is before candidate commit timestamp
  const earlyMountedJson = { ...validMountedSmokeJson, executedAt: "2026-09-07T07:00:00.000Z" };
  const earlyBuf = Buffer.from(JSON.stringify(earlyMountedJson));
  assert.throws(
    () =>
      validateReleaseProvenance({
        candidateCommit,
        releaseClosureCommit,
        candidateCommitDate,
        closureCommitDate,
        parentBaseline: STAGE7_E72_BASE,
        manifest: {
          ...validManifest,
          artifacts: {
            ...validManifest.artifacts,
            "two-node-mounted-smoke.json": { sha256: sha256(earlyBuf), bytes: earlyBuf.byteLength },
          },
        },
        artifacts: {
          ...validArtifacts,
          "two-node-mounted-smoke.json": { buffer: earlyBuf, json: earlyMountedJson },
        },
        attestationText: validAttestation,
        mode: "evaluate",
      }),
    /chronology: candidate commit .* must precede two-node-mounted-smoke\.json executedAt/,
  );

  // 7. Fails closed if artifact candidateCommit does not match
  const mismatchedArtifactJson = { ...validMountedSmokeJson, candidateCommit: "5a6f94fa8bfc1adf850627d28f2cad150af55c20" };
  const mismatchBuf = Buffer.from(JSON.stringify(mismatchedArtifactJson));
  assert.throws(
    () =>
      validateReleaseProvenance({
        candidateCommit,
        releaseClosureCommit,
        candidateCommitDate,
        closureCommitDate,
        parentBaseline: STAGE7_E72_BASE,
        manifest: {
          ...validManifest,
          artifacts: {
            ...validManifest.artifacts,
            "two-node-mounted-smoke.json": { sha256: sha256(mismatchBuf), bytes: mismatchBuf.byteLength },
          },
        },
        artifacts: {
          ...validArtifacts,
          "two-node-mounted-smoke.json": { buffer: mismatchBuf, json: mismatchedArtifactJson },
        },
        attestationText: validAttestation,
        mode: "evaluate",
      }),
    /candidateCommit mismatch/,
  );
});

test("Stage 8 pinned external DeepSeek Harness baseline contract", async () => {
  const readme = await text("README.md");
  assert.match(readme, /0\.1\.1-rc\.2/);

  const stage6Contract = await text("test/stage6-mounted-drill-contract.test.mjs");
  assert.match(stage6Contract, /b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/);
  assert.match(stage6Contract, /c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62/);

  const stage7Attestation = await text("docs/release-attestations/v0.4-stage7-failure-hardening.md");
  assert.match(stage7Attestation, /0\.1\.1-rc\.2/);
  assert.match(stage7Attestation, /b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/);
  assert.match(stage7Attestation, /c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62/);
});

test("Stage 8 schema version and route configuration safety", async () => {
  const sqliteSource = await text("src/registry/sqlite.mjs");
  assert.match(sqliteSource, /SCHEMA_VERSION = 5/);

  const configDoc = await text("docs/configuration-reference.md");
  assert.match(configDoc, /DSH_ORBIT_HUB_ROUTE_DOMAIN/);
  assert.match(configDoc, /DSH_ORBIT_HUB_ROUTE_PROBE_CADENCE_SECONDS/);
  assert.match(configDoc, /DSH_ORBIT_HUB_WS_GLOBAL_LIMIT/);
  assert.match(configDoc, /DSH_ORBIT_HUB_WS_PER_NODE_LIMIT/);
  assert.match(configDoc, /DSH_ORBIT_NODE_WS_LIMIT/);
});

test("Stage 8 production promotion and rollback plan constraints", async () => {
  const plan = await text("docs/sop/v0.4-production-promotion-rollback-plan.md");
  assert.match(plan, /dsh\.ikarikore\.top/);
  assert.match(plan, /n-<nodeId>\.dsh\.ikarikore\.top/);
  assert.match(plan, /Rollback Contract/);
  assert.match(plan, /No Identity Destruction/);
});

test("Stage 8 security boundaries: strictly no TLS bypass permitted", async () => {
  const files = [
    "src/node/route-ingress.mjs",
    "src/registry/route-proxy.mjs",
    "src/registry/registry.mjs",
    "scripts/registry-stage7-drill.mjs",
    "scripts/registry-drill.mjs",
    "test/stage7-hardening.test.mjs",
  ];
  for (const f of files) {
    const content = await text(f);
    assert.doesNotMatch(content, /rejectUnauthorized\s*:\s*false/);
    assert.doesNotMatch(content, new RegExp("NODE_" + "TLS_" + "REJECT_" + "UNAUTHORIZED"));
    assert.doesNotMatch(content, /ignore-certificate-errors/);
  }
});
