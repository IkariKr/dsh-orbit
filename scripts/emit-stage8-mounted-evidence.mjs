#!/usr/bin/env node
// Converts only runner-produced raw mounted evidence into the Stage 8
// mounted smoke artifact. It never accepts a matrix or PASS value from CLI.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const rawBuffer = readFileSync(rawPath);
const raw = JSON.parse(rawBuffer.toString("utf8"));
if (raw.kind !== "stage8-mounted-runner-raw" || raw.producer !== "registry-drill-runner") fail("raw evidence producer is not the mounted runner");
if (raw.success !== true) fail("raw runner did not complete successfully");
if (!/^[0-9a-f]{40}$/.test(raw.commit ?? "")) fail("raw candidate commit is not a full SHA");
if (!/^[0-9a-f-]{36}$/.test(raw.runId ?? "")) fail("raw runId is missing");
if (!raw.cleanup || /not executed|failed/i.test(String(raw.cleanup))) fail("raw cleanup is not complete");
assertMountedMatrixShape(raw.requiredMatrix, { requirePass: true });
if (!Array.isArray(raw.nodeIds ?? [raw.aNodeId, raw.bNodeId]) && (!raw.aNodeId || !raw.bNodeId)) fail("raw current node binding is missing");

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
    version: raw.dshVersion ?? "0.1.1-rc.2",
    commitSha: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
    cliSha256: "c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62",
  },
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(rawOutputPath, rawBuffer, { encoding: "utf8", mode: 0o640 });
writeFileSync(outputPath, JSON.stringify(smoke, null, 2) + "\n", { encoding: "utf8", mode: 0o640 });
console.log(JSON.stringify({ outputPath, runId: smoke.runId, candidateCommit: smoke.candidateCommit, rawEvidenceSha256: rawSha256 }, null, 2));
