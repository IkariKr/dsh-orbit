#!/usr/bin/env node
// Converts only runner-produced raw mounted evidence into the release mounted
// smoke artifact. It never accepts a matrix or PASS value from CLI, and it
// writes into the release's own evidence namespace — never the frozen v0.4.0
// Stage 8 closure directory.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMountedMatrixShape } from "./stage8-mounted-matrix.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const rawPath = join(REPO, "data", "drill-evidence.json");

function fail(message) {
  throw new Error(`mounted evidence emitter: ${message}`);
}

const rawBuffer = readFileSync(rawPath);
const raw = JSON.parse(rawBuffer.toString("utf8"));
if (raw.kind !== "stage8-mounted-runner-raw" || raw.producer !== "registry-drill-runner") fail("raw evidence producer is not the mounted runner");
if (raw.success !== true) fail("raw runner did not complete successfully");
if (!/^[0-9a-f]{40}$/.test(raw.commit ?? "")) fail("raw candidate commit is not a full SHA");
if (!/^[0-9a-f-]{36}$/.test(raw.runId ?? "")) fail("raw runId is missing");
if (!raw.cleanup || /not executed|failed/i.test(String(raw.cleanup))) fail("raw cleanup is not complete");
assertMountedMatrixShape(raw.requiredMatrix, { requirePass: true });
if (!Array.isArray(raw.nodeIds ?? [raw.aNodeId, raw.bNodeId]) && (!raw.aNodeId || !raw.bNodeId)) fail("raw current node binding is missing");

// Pinned upstream identity per mounted baseline. The sealed evidence must bind
// the DSH identity the run actually executed, so an unreviewed baseline (or a
// raw record missing its version) fails closed instead of inheriting a stale
// literal. These digests mirror test/helpers/dsh-015-acceptance-fixture.mjs and
// the release attestations; a new baseline adds its own reviewed entry.
const DSH_PINNED_IDENTITIES = {
  "0.1.1-rc.2": {
    commitSha: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
    cliSha256: "c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62",
  },
  "0.1.5-rc.2": {
    commitSha: "fb2c4b9e698e30edb738bca4cf0618587db7d203",
    cliSha256: "0ff7f1d72c4e0cbe14001709c81e20a04b70464118a7f78568952988e28f2ac5",
    buildArtifacts: {
      "apps/cli/lib/bin.js": "0ff7f1d72c4e0cbe14001709c81e20a04b70464118a7f78568952988e28f2ac5",
      "packages/client/connection/lib/index.js": "bbe7c9aa6d82a7a4ec657aa8bc51064e12bb091be0465526d0b9f5e031f540f7",
      "packages/client/connection/lib/client.js": "319cc46762af6ccb7ac74c9bab37ab8377be212dad9de4dba1f892b7e5b4d8a1",
      "packages/api/gateway/lib/index.js": "ee3b7ee01e87638813d0f304a8f7527d79e8e42990247116fa67086eb268e699",
    },
  },
};

// Release evidence namespace. This producer is the v0.4.1 release evidence
// producer, not a general replay tool: the v0.4.1 candidate artifact has its
// own directory so a fresh run can never write into (or stand next to) the
// frozen v0.4.0 Stage 8 closure. Writing anywhere under the frozen namespace
// is forbidden in every mode.
const RELEASE_EVIDENCE_DIR = "test/evidence/v0.4.1";
const FROZEN_EVIDENCE_DIR = "test/evidence/stage8";
const LEGACY_REPLAY_DIR = "test/evidence/stage8-legacy-replay";

const orbitPackage = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const orbitVersion = orbitPackage.version;
if (!/^0\.4\.1-rc\.\d+$/.test(orbitVersion)) {
  fail(`this producer seals v0.4.1 release evidence, but package.json carries version ${JSON.stringify(orbitVersion)}`);
}

const currentCandidateCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
const dshVersion = raw.dshVersion;
const pinnedDsh = DSH_PINNED_IDENTITIES[dshVersion];
if (!pinnedDsh) fail(`raw evidence carries no pinned identity for mounted baseline ${JSON.stringify(dshVersion)}`);

let evidenceDir;
if (process.env.DSH_ORBIT_EVIDENCE_LEGACY_REPLAY === "1") {
  // Historical replay of the v0.4.0 legacy baseline is a diagnostic mode; it
  // never feeds a release and must never touch the frozen closure directory.
  if (dshVersion !== "0.1.1-rc.2") {
    fail(`legacy replay mode requires raw dshVersion 0.1.1-rc.2, got ${JSON.stringify(dshVersion)}`);
  }
  evidenceDir = LEGACY_REPLAY_DIR;
} else {
  // The v0.4.1 release path binds every identity axis mechanically: the
  // selected baseline, its reviewed connection generation, and the exact
  // candidate commit this producer runs from.
  if (dshVersion !== "0.1.5-rc.2") {
    fail(`v0.4.1 release evidence requires the selected baseline 0.1.5-rc.2, got ${JSON.stringify(dshVersion)}`);
  }
  if (raw.dshConnectionPatch !== "connection-browser-auth-v1") {
    fail(`v0.4.1 release evidence requires the connection-browser-auth-v1 generation, got ${JSON.stringify(raw.dshConnectionPatch)}`);
  }
  if (raw.commit !== currentCandidateCommit) {
    fail(
      `raw evidence commit ${raw.commit} does not match the running candidate ${currentCandidateCommit}; ` +
        "release evidence must bind the exact candidate tree",
    );
  }
  evidenceDir = RELEASE_EVIDENCE_DIR;
}

const executedAt = raw.finishedAt ?? raw.startedAt;
if (!executedAt || Number.isNaN(new Date(executedAt).getTime())) fail("raw execution timestamp is invalid");
const rawSha256 = createHash("sha256").update(rawBuffer).digest("hex");
const smoke = {
  schemaVersion: 3,
  kind: "stage8-final-two-node-mounted-smoke",
  candidateCommit: raw.commit,
  executedAt,
  execution: "executed",
  result: "PASS",
  runId: raw.runId,
  orbit: {
    version: orbitVersion,
    revision: currentCandidateCommit,
  },
  provenance: {
    producer: raw.producer,
    runnerCommit: raw.commit,
    rawEvidenceSha256: rawSha256,
    rawEvidenceBytes: rawBuffer.byteLength,
    browserProducer: raw.browser?.browserProducer ?? raw.browserBootstrap?.browserProducer ?? null,
    browserChallengeBound: Boolean(raw.browserBridge?.challengeDigest),
    browserBridgeExitCode: raw.browserBridgeExit?.code ?? null,
  },
  gateway: raw.tls ? {
    url: "https://127.0.0.1:8443",
    tlsValidation: raw.tls.validation,
    caFingerprint: raw.tls.caFingerprint,
    leafFingerprint: raw.tls.leafFingerprint,
    sans: raw.tls.sans,
  } : null,
  nodes: {
    a: raw.aNodeId,
    b: raw.bNodeId,
  },
  requiredMatrix: raw.requiredMatrix,
  lifecycle: {
    steps: raw.steps,
    cleanup: raw.cleanup,
  },
  dsh: {
    version: dshVersion,
    commitSha: pinnedDsh.commitSha,
    cliSha256: pinnedDsh.cliSha256,
    ...(pinnedDsh.buildArtifacts ? { buildArtifacts: pinnedDsh.buildArtifacts } : {}),
    ...(raw.dshConnectionPatch ? { connectionPatch: raw.dshConnectionPatch } : {}),
  },
};
// The frozen v0.4.0 closure directory is untouchable by construction: the
// release and replay paths resolve elsewhere, and this guard keeps it that way
// even if a future edit reintroduces a stage8 output path.
if (join(evidenceDir, "/").includes(join(FROZEN_EVIDENCE_DIR, "/")) || evidenceDir === FROZEN_EVIDENCE_DIR) {
  fail(`evidence namespace ${evidenceDir} must never overlap the frozen ${FROZEN_EVIDENCE_DIR} closure`);
}
const rawOutputPath = join(REPO, evidenceDir, "mounted-runner-raw.json");
const outputPath = join(REPO, evidenceDir, "two-node-mounted-smoke.json");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(rawOutputPath, rawBuffer, { encoding: "utf8", mode: 0o640 });
writeFileSync(outputPath, JSON.stringify(smoke, null, 2) + "\n", { encoding: "utf8", mode: 0o640 });
console.log(JSON.stringify({ evidenceDir, outputPath, runId: smoke.runId, candidateCommit: smoke.candidateCommit, rawEvidenceSha256: rawSha256 }, null, 2));
