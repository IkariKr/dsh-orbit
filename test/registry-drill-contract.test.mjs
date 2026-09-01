import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const DRIVER = new URL("../scripts/registry-drill.mjs", import.meta.url);

test("mounted drill requires trusted browser evidence and real compatibility reports", async () => {
  const source = await readFile(DRIVER, "utf8");
  assert.match(source, /requireCleanCandidateWorktree\(\);/);
  assert.match(source, /requireBrowserCheckpoint\(\);/);
  assert.match(source, /tlsValidation !== "enabled"/);
  assert.match(source, /checkpoint\.commit/);
  assert.match(source, /checkpoint\.leafFingerprint/);
  assert.match(source, /runVerificationSequence\(/);
  assert.match(source, /createCompatibilityReport\(/);
  assert.doesNotMatch(source, /Object\.fromEntries\(/);
  assert.doesNotMatch(source, /rejectUnauthorized:\s*false/);
});

test("mounted drill keeps the RFC production thresholds explicit", async () => {
  const source = await readFile(DRIVER, "utf8");
  assert.match(source, /HEARTBEAT_CADENCE_SECONDS = 60/);
  assert.match(source, /HEARTBEAT_MISSED_BEATS = 3/);
  assert.match(source, /HEARTBEAT_LOST_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(source, /productionThresholdsUnchanged: true/);
});
