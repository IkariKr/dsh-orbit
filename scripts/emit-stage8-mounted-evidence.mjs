#!/usr/bin/env node
// Converts only runner-produced raw mounted evidence into the Stage 8
// mounted smoke artifact. It never accepts a matrix or PASS value from CLI.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMountedMatrixShape } from "./stage8-mounted-matrix.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const rawPath = join(REPO, "data", "drill-evidence.json");
const rawOutputPath = join(REPO, "test", "evidence", "stage8", "mounted-runner-raw.json");
const outputPath = join(REPO, "test", "evidence", "stage8", "two-node-mounted-smoke.json");

function fail(message) {
  throw new Error(`mounted evidence emitter: ${message}`);
}

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
}

const rawBuffer = readFileSync(rawPath);
const raw = JSON.parse(rawBuffer.toString("utf8"));
const revision = currentCommit();
if (raw.kind !== "stage8-mounted-runner-raw" || raw.producer !== "registry-drill-runner") fail("raw evidence producer is not the mounted runner");
if (raw.success !== true) fail("raw runner did not complete successfully");
if (!/^[0-9a-f]{40}$/.test(raw.commit ?? "")) fail("raw candidate commit is not a full SHA");
if (raw.commit !== revision) fail(`raw candidate ${raw.commit} does not match current frozen candidate ${revision}`);
if (!/^[0-9a-f-]{36}$/.test(raw.runId ?? "")) fail("raw runId is missing");
if (!raw.cleanup || /not executed|failed/i.test(String(raw.cleanup))) fail("raw cleanup is not complete");
const nodeIds = Array.isArray(raw.nodeIds) ? raw.nodeIds : [raw.aNodeId, raw.bNodeId];
if (nodeIds.length !== 2 || nodeIds.some((nodeId) => typeof nodeId !== "string" || nodeId.length === 0) || new Set(nodeIds).size !== 2) {
  fail("raw current node binding must contain two distinct node IDs");
}
if (
  raw.browserBridge?.producer !== "runner-owned-firefox-selenium" &&
  raw.browser?.browserProducer !== "runner-owned-firefox-selenium" &&
  raw.browserBootstrap?.browserProducer !== "runner-owned-firefox-selenium"
) {
  fail("raw browser evidence is not runner-owned Firefox/Selenium");
}
if (!raw.browserBridge?.challengeDigest) fail("raw browser challenge binding is missing");
if (raw.tls?.validation !== "enabled" || !raw.tls?.caFingerprint || !raw.tls?.leafFingerprint) fail("raw TLS binding is incomplete");
assertMountedMatrixShape(raw.requiredMatrix, { requirePass: true });

const startedAt = new Date(raw.startedAt);
const finishedAt = new Date(raw.finishedAt);
if (Number.isNaN(startedAt.getTime()) || Number.isNaN(finishedAt.getTime()) || finishedAt < startedAt) fail("raw execution timestamps are invalid");
const executedAt = raw.finishedAt;
const rawSha256 = createHash("sha256").update(rawBuffer).digest("hex");
const smoke = {
  schemaVersion: 3,
  kind: "stage8-final-two-node-mounted-smoke",
  candidateCommit: raw.commit,
  executedAt,
  execution: "executed",
  result: "PASS",
  runId: raw.runId,
  provenance: {
    producer: raw.producer,
    runnerCommit: raw.commit,
    rawEvidenceSha256: rawSha256,
    rawEvidenceBytes: rawBuffer.byteLength,
    browserProducer:
      raw.browser?.browserProducer ??
      raw.browserBootstrap?.browserProducer ??
      raw.browserBridge?.producer ??
      null,
    browserChallengeDigest:
      raw.browser?.challengeDigest ??
      raw.browserBootstrap?.challengeDigest ??
      raw.browserBridge?.challengeDigest ??
      null,
    browserChallengeBound: Boolean(
      raw.browser?.challengeDigest ??
      raw.browserBootstrap?.challengeDigest ??
      raw.browserBridge?.challengeDigest,
    ),
    browserTrustMode:
      raw.browser?.trustMode ??
      raw.browserBootstrap?.trustMode ??
      null,
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
    a: nodeIds[0],
    b: nodeIds[1],
  },
  requiredMatrix: raw.requiredMatrix,
  lifecycle: {
    steps: raw.steps,
    cleanup: raw.cleanup,
  },
  dsh: raw.dsh ? {
    version: raw.dsh.version ?? raw.dshVersion ?? null,
    commitSha: raw.dsh.commitSha ?? null,
    cliSha256: raw.dsh.cliSha256 ?? null,
  } : {
    version: raw.dshVersion ?? null,
    commitSha: raw.dshCommitSha ?? null,
    cliSha256: raw.dshCliSha256 ?? null,
  },
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(rawOutputPath, rawBuffer, { encoding: "utf8", mode: 0o640 });
writeFileSync(outputPath, JSON.stringify(smoke, null, 2) + "\n", { encoding: "utf8", mode: 0o640 });
rmSync(rawPath, { force: true });
console.log(JSON.stringify({ outputPath, runId: smoke.runId, candidateCommit: smoke.candidateCommit, rawEvidenceSha256: rawSha256, rawSourceRemoved: true }, null, 2));
