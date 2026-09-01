import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const DRIVER = new URL("../scripts/registry-drill.mjs", import.meta.url);

test("mounted drill requires trusted browser evidence and real compatibility reports", async () => {
  const source = await readFile(DRIVER, "utf8");
  assert.match(source, /requireCleanCandidateWorktree\(\);/);
  assert.match(source, /requireBrowserBootstrapCheckpoint\(\{ wait: waitForBrowser \}\)/);
  assert.match(source, /requireBrowserCheckpoint\(\{ wait: waitForBrowser, nodeIds: \[aNodeId, bNodeId\] \}\)/);
  assert.match(source, /--wait-for-browser/);
  assert.match(source, /attempts = 1800/);
  assert.match(source, /browser bootstrap checkpoint/);
  assert.match(source, /tlsValidation !== "enabled"/);
  assert.match(source, /checkpoint\.runId/);
  assert.match(source, /checkpoint\.commit/);
  assert.match(source, /BROWSER_BINDINGS_PATH/);
  assert.match(source, /resolveOpenSsl\(\)/);
  assert.match(source, /DSH_ORBIT_OPENSSL_BIN/);
  assert.match(source, /checkpoint\.leafFingerprint/);
  assert.match(source, /nodeIds: \[aNodeId, bNodeId\]/);
  assert.match(source, /runVerificationSequence\(/);
  assert.match(source, /createCompatibilityReport\(/);
  assert.match(source, /runningImageEvidence\(/);
  assert.match(source, /aging reset healed A without heartbeat/);
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
