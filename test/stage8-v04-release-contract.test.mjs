import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { assertMountedMatrixShape, REQUIRED_MOUNTED_MATRIX_FIELDS } from "../scripts/stage8-mounted-matrix.mjs";

const ROOT = new URL("../", import.meta.url);
const text = async (path) => readFile(new URL(path, ROOT), "utf8");
const rootPath = new URL("../", import.meta.url);

const STAGE8_E73_BASE = "0dc00ceb3b0574e2a6bd81eb62502fd6c2e233f3";
const TEST_CONTRACT_BASE = "2559a17ed6e7ff0cbe58f1b45d40e3b166eb0582";

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

function gitChangedPaths(from, to) {
  try {
    const stdout = execFileSync("git", ["diff", "--name-only", `${from}..${to}`], { cwd: rootPath, encoding: "utf8" });
    return stdout.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function assertFullCommit(commit, label) {
  assert.match(commit ?? "", /^[0-9a-f]{40}$/, `${label} must be a full 40-character SHA`);
  assert.equal(gitCommitExists(commit), true, `${label} must resolve to a real commit`);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function detectProvenanceMode() {
  const attestationPath = new URL("../docs/release-attestations/v0.4.0-rc.1.md", import.meta.url);
  const manifestPath = new URL("../test/evidence/stage8/manifest.json", import.meta.url);
  const stage8Dir = new URL("../test/evidence/stage8", import.meta.url);
  let hasAttestation = false;
  let hasManifest = false;
  let hasStage8Dir = false;
  try { await access(attestationPath); hasAttestation = true; } catch {}
  try { await access(manifestPath); hasManifest = true; } catch {}
  try { await access(stage8Dir); hasStage8Dir = true; } catch {}
  if (!hasAttestation && !hasManifest && !hasStage8Dir) return "construction";
  if (!hasAttestation || !hasManifest) {
    assert.fail(`Partial release bundle detected: hasAttestation=${hasAttestation}, hasManifest=${hasManifest}, hasStage8Dir=${hasStage8Dir}`);
  }
  return "closure";
}

function validateMountedBinding({ mountedArtifact, rawArtifact, rawBuffer, manifest }) {
  assert.equal(rawArtifact.kind, "stage8-mounted-runner-raw", "raw mounted evidence kind mismatch");
  assert.equal(rawArtifact.producer, "registry-drill-runner", "raw mounted evidence producer mismatch");
  assert.equal(rawArtifact.success, true, "raw mounted evidence must be successful");
  assert.equal(rawArtifact.commit, mountedArtifact.candidateCommit, "raw mounted candidate mismatch");
  assert.equal(rawArtifact.runId, mountedArtifact.runId, "raw mounted runId mismatch");
  assertMountedMatrixShape(rawArtifact.requiredMatrix, { requirePass: true });
  assert.deepEqual(mountedArtifact.requiredMatrix, rawArtifact.requiredMatrix, "mounted matrix must equal runner raw matrix");
  const rawSha = sha256(rawBuffer);
  assert.equal(mountedArtifact.provenance?.rawEvidenceSha256, rawSha, "mounted raw evidence hash mismatch");
  assert.equal(mountedArtifact.provenance?.rawEvidenceBytes, rawBuffer.byteLength, "mounted raw evidence byte count mismatch");
  assert.equal(manifest.mountedRun?.rawEvidenceSha256, rawSha, "manifest raw evidence hash mismatch");
  assert.equal(manifest.mountedRun?.runId, rawArtifact.runId, "manifest mounted runId mismatch");
}

/**
 * Mechanically validates a frozen candidate/closure bundle.
 * Final-release mode requires mounted PASS, strict chronology, hashes, and no pending wording.
 * The closure SHA is never required inside the attestation itself.
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
  if (!mode.endsWith("-synthetic")) {
    assert.equal(gitIsAncestor(STAGE8_E73_BASE, candidateCommit), true, "candidateCommit must descend from E7.3");
  }

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
    const artifactCommit = fileName === "mounted-runner-raw.json" ? artifact.json.commit : artifact.json.candidateCommit;
    assert.equal(artifactCommit, candidateCommit, `${fileName} candidate commit mismatch`);

    const executedDate = new Date(artifact.json.executedAt ?? artifact.json.finishedAt ?? artifact.json.startedAt);
    assert.ok(!Number.isNaN(executedDate.getTime()), `${fileName} executedAt must be a valid date`);
    assert.ok(
      candidateCommitDate.getTime() < executedDate.getTime(),
      `chronology: candidate commit (${candidateCommitDate.toISOString()}) must precede ${fileName} executedAt (${executedDate.toISOString()})`,
    );

    assert.ok(
      executedDate.getTime() < closureCommitDate.getTime(),
      `chronology: ${fileName} executedAt (${executedDate.toISOString()}) must precede closure commit (${closureCommitDate.toISOString()})`,
    );
  }

  const mountedArtifact = artifacts["two-node-mounted-smoke.json"]?.json;
  const rawArtifact = artifacts["mounted-runner-raw.json"]?.json;
  if (rawArtifact || mountedArtifact?.result === "PASS" || mountedArtifact?.execution === "executed" || manifest.physicalMountedGate === "PASS") {
    assert.ok(rawArtifact, "mounted PASS requires runner-owned raw evidence");
    validateMountedBinding({
      mountedArtifact,
      rawArtifact,
      rawBuffer: artifacts["mounted-runner-raw.json"].buffer,
      manifest,
    });
  }
  const isPass =
    mountedArtifact?.result === "PASS" &&
    mountedArtifact?.execution === "executed" &&
    manifest.physicalMountedGate === "PASS" &&
    !/\bpending\b/i.test(attestationText);

  if (mode.startsWith("final-release")) {
    assert.equal(mountedArtifact?.result, "PASS", "final release requires mounted smoke result PASS");
    assert.equal(mountedArtifact?.execution, "executed", "final release requires mounted smoke execution executed");
    assert.equal(manifest.physicalMountedGate, "PASS", "final release requires manifest physicalMountedGate PASS");
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

test("Stage 8 construction candidate version declarations", async () => {
  const candidate = currentCommit();
  assertFullCommit(candidate, "construction candidate (current HEAD)");
  assert.equal(gitIsAncestor(STAGE8_E73_BASE, candidate), true, "construction candidate must descend from E7.3");
  assert.equal(gitTagExists("v0.4.0-rc.1"), false, "release tag must not exist before Final Review");
  const lock = JSON.parse(await text("package-lock.json"));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.version, "0.4.0-rc.1");
  assert.equal(lock.packages?.[""].version, "0.4.0-rc.1");
  const requiredDocs = [
    "package.json",
    "CHANGELOG.md",
    "README.md",
    "docs/architecture.md",
    "docs/roadmap.md",
    "docs/configuration-reference.md",
    "docs/sop/v0.4-selector-operator-sop.md",
    "docs/sop/v0.3-node-enrollment-sop.md",
    "docs/sop/v0.4-production-promotion-rollback-plan.md",
    "docs/troubleshooting.md",
    "docs/release-attestations/v0.4-stage7-failure-hardening.md",
  ];
  for (const path of requiredDocs) await access(new URL(`../${path}`, import.meta.url));

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
  const current = currentCommit();
  assertFullCommit(current, "current commit (HEAD)");
  assert.equal(gitTagExists("v0.4.0-rc.1"), false, "release tag must not exist before Final Review");
  const mode = await detectProvenanceMode();
  if (mode === "construction") {
    assert.equal(gitIsAncestor(STAGE8_E73_BASE, current), true, "current construction candidate must descend from E7.3");
    const constructionPaths = gitChangedPaths(STAGE8_E73_BASE, current);
    assert.ok(constructionPaths.length > 0, "construction candidate must contain transplanted construction");
    assert.equal(constructionPaths.some((p) => p.startsWith("test/evidence/stage8/")), false, "construction candidate must not contain Stage 8 evidence");
    assert.equal(constructionPaths.includes("docs/release-attestations/v0.4.0-rc.1.md"), false, "construction candidate must not contain release closure attestation");
    return;
  }

  const releaseClosureCommit = current;
  const candidateCommit = gitCommitParent(releaseClosureCommit);
  assertFullCommit(candidateCommit, "executable candidate commit (HEAD^)");
  assert.equal(gitIsAncestor(STAGE8_E73_BASE, candidateCommit), true, "closure candidate must descend from E7.3");
  const changedPaths = gitChangedPaths(candidateCommit, releaseClosureCommit);
  assert.ok(changedPaths.length > 0, "closure commit must contain evidence changes");
  for (const changedPath of changedPaths) {
    assert.ok(changedPath === "docs/release-attestations/v0.4.0-rc.1.md" || changedPath.startsWith("test/evidence/stage8/"), `closure changed forbidden path: ${changedPath}`);
  }
  const manifest = JSON.parse(await text("test/evidence/stage8/manifest.json"));
  const attestationText = await text("docs/release-attestations/v0.4.0-rc.1.md");
  assert.ok(manifest.artifacts && Object.keys(manifest.artifacts).length > 0, "closure manifest must declare artifacts");
  const artifacts = {};
  for (const [fileName] of Object.entries(manifest.artifacts)) {
    const buffer = await readFile(new URL(`../test/evidence/stage8/${fileName}`, import.meta.url));
    artifacts[fileName] = { buffer, json: JSON.parse(buffer.toString("utf8")) };
  }
  validateReleaseProvenance({
    candidateCommit,
    releaseClosureCommit,
    candidateCommitDate: gitCommitDate(candidateCommit),
    closureCommitDate: gitCommitDate(releaseClosureCommit),
    parentBaseline: STAGE8_E73_BASE,
    manifest,
    artifacts,
    attestationText,
    mode: "final-release",
  });
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
  const validMatrix = Object.fromEntries(REQUIRED_MOUNTED_MATRIX_FIELDS.map((field) => [field, "PASS"]));
  const validRawJson = {
    schemaVersion: 3,
    kind: "stage8-mounted-runner-raw",
    producer: "registry-drill-runner",
    commit: candidateCommit,
    candidateCommit,
    runId: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-09-07T08:05:00.000Z",
    finishedAt: "2026-09-07T08:09:00.000Z",
    success: true,
    cleanup: "complete",
    requiredMatrix: validMatrix,
  };
  const rawBuf = Buffer.from(JSON.stringify(validRawJson));
  const validMountedSmokeJson = {
    schemaVersion: 3,
    candidateCommit,
    executedAt: "2026-09-07T08:10:00.000Z",
    execution: "executed",
    result: "PASS",
    runId: validRawJson.runId,
    requiredMatrix: validMatrix,
    provenance: {
      rawEvidenceSha256: sha256(rawBuf),
      rawEvidenceBytes: rawBuf.byteLength,
    },
  };
  const freshBuf = Buffer.from(JSON.stringify(validFreshInstallJson));
  const mountedBuf = Buffer.from(JSON.stringify(validMountedSmokeJson));
  const rawArtifact = { buffer: rawBuf, json: validRawJson };

  const validManifest = {
    testedCandidateCommit: candidateCommit,
    parentStage7Evidence: STAGE8_E73_BASE,
    physicalMountedGate: "PASS",
    artifacts: {
      "fresh-install.json": { sha256: sha256(freshBuf), bytes: freshBuf.byteLength },
    "mounted-runner-raw.json": { sha256: sha256(rawBuf), bytes: rawBuf.byteLength },
    "two-node-mounted-smoke.json": { sha256: sha256(mountedBuf), bytes: mountedBuf.byteLength },
  },
  mountedRun: {
    runId: validRawJson.runId,
    rawEvidenceSha256: sha256(rawBuf),
  },
};

  const validAttestation = `Candidate: ${candidateCommit}\nClosure: ${releaseClosureCommit}\nParent: ${STAGE8_E73_BASE}\nStatus: PASS`;

  const validArtifacts = {
    "fresh-install.json": { buffer: freshBuf, json: validFreshInstallJson },
    "mounted-runner-raw.json": rawArtifact,
    "two-node-mounted-smoke.json": { buffer: mountedBuf, json: validMountedSmokeJson },
  };

  // 1. Valid final release bundle passes
  const validResult = validateReleaseProvenance({
    candidateCommit,
    releaseClosureCommit,
    candidateCommitDate,
    closureCommitDate,
    parentBaseline: STAGE8_E73_BASE,
    manifest: validManifest,
    artifacts: validArtifacts,
    attestationText: validAttestation,
    mode: "final-release-synthetic",
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
        parentBaseline: STAGE8_E73_BASE,
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
        mode: "final-release-synthetic",
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
        parentBaseline: STAGE8_E73_BASE,
        manifest: validManifest,
        artifacts: validArtifacts,
        attestationText: `${validAttestation}\nDocs pending commit below`,
        mode: "final-release-synthetic",
      }),
    /final release forbids pending wording/,
  );

  // 4. Constructibility test: attestation does NOT require self-referential releaseClosureCommit SHA.
  // Proves that a valid bundle where attestation does not mention closure commit succeeds,
  // whereas requiring attestation to contain releaseClosureCommit would fail constructibility.
  const attestationWithoutClosure = `Candidate: ${candidateCommit}\nParent: ${STAGE8_E73_BASE}\nStatus: PASS`;
  const constructibleResult = validateReleaseProvenance({
    candidateCommit,
    releaseClosureCommit,
    candidateCommitDate,
    closureCommitDate,
    parentBaseline: STAGE8_E73_BASE,
    manifest: validManifest,
    artifacts: validArtifacts,
    attestationText: attestationWithoutClosure,
    mode: "final-release-synthetic",
  });
  assert.equal(constructibleResult.isPass, true, "constructibility: attestation must not require self-referential closure SHA");

  // Constructibility verification: verify that requiring closure commit in attestation WOULD fail
  assert.throws(
    () => {
      assert.ok(
        attestationWithoutClosure.includes(releaseClosureCommit),
        "impossible requirement: attestation must contain releaseClosureCommit",
      );
    },
    /impossible requirement: attestation must contain releaseClosureCommit/,
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
        parentBaseline: STAGE8_E73_BASE,
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
        mode: "final-release-synthetic",
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
        parentBaseline: STAGE8_E73_BASE,
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
        mode: "final-release-synthetic",
      }),
    /chronology: candidate commit .* must precede two-node-mounted-smoke\.json executedAt/,
  );

  // 7. Fails closed if artifact candidateCommit does not match
  const mismatchedArtifactJson = { ...validMountedSmokeJson, candidateCommit: TEST_CONTRACT_BASE };
  const mismatchBuf = Buffer.from(JSON.stringify(mismatchedArtifactJson));
  assert.throws(
    () =>
      validateReleaseProvenance({
        candidateCommit,
        releaseClosureCommit,
        candidateCommitDate,
        closureCommitDate,
        parentBaseline: STAGE8_E73_BASE,
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
        mode: "final-release-synthetic",
      }),
    /candidate commit mismatch/,
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
