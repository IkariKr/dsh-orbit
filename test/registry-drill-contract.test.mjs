import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const text = async (path) => readFile(new URL(path, ROOT), "utf8");
const DRIVER = new URL("../scripts/registry-drill.mjs", import.meta.url);
const MATRIX = new URL("../scripts/stage8-mounted-matrix.mjs", import.meta.url);
const EMITTER = new URL("../scripts/emit-stage8-mounted-evidence.mjs", import.meta.url);
const BRIDGE = new URL("../scripts/registry-drill-firefox-bridge.py", import.meta.url);

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
  assert.match(source, /NODE_HUB_URL = "https:\/\/registry-hub:5446\//);
  assert.doesNotMatch(source, /NODE_HUB_URL = "http:\/\/registry-hub:5446\//);
  assert.match(source, /DSH_ORBIT_NODE_CA_CERT: NODE_HUB_CA_PATH/);
});

test("mounted drill keeps the RFC production thresholds explicit", async () => {
  const source = await readFile(DRIVER, "utf8");
  assert.match(source, /HEARTBEAT_CADENCE_SECONDS = 60/);
  assert.match(source, /HEARTBEAT_MISSED_BEATS = 3/);
  assert.match(source, /HEARTBEAT_LOST_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(source, /productionThresholdsUnchanged: true/);
});

test("Stage 8 harness freezes the exact matrix and raw evidence contract", async () => {
  const matrix = await readFile(MATRIX, "utf8");
  const driver = await readFile(DRIVER, "utf8");
  const emitter = await readFile(EMITTER, "utf8");
  const bridge = await readFile(BRIDGE, "utf8");
  assert.match(matrix, /REQUIRED_MOUNTED_MATRIX_FIELDS = Object\.freeze\(\[/);
  assert.match(matrix, /Object\.keys\(matrix\)\.sort\(\)/);
  assert.match(matrix, /requirePass && matrix\[field\] !== "PASS"/);
  assert.match(driver, /kind: "stage8-mounted-runner-raw"/);
  assert.match(driver, /producer: "registry-drill-runner"/);
  assert.match(driver, /candidateCommit: REVISION/);
  assert.match(driver, /assertMountedMatrixShape\(evidence\.requiredMatrix, \{ requirePass: true \}\)/);
  assert.match(driver, /producer: "runner-owned-firefox-selenium"/);
  assert.match(driver, /challengeDigest/);
  assert.match(emitter, /raw\.commit !== revision/);
  assert.match(emitter, /rawEvidenceSha256/);
  assert.match(emitter, /rawEvidenceBytes/);
  assert.match(emitter, /assertMountedMatrixShape\(raw\.requiredMatrix, \{ requirePass: true \}\)/);
  assert.match(emitter, /nodeIds\.length !== 2/);
  assert.match(emitter, /runner-owned Firefox\/Selenium/);
  assert.doesNotMatch(emitter, /c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62/);
  assert.match(bridge, /runner-owned-firefox-selenium/);
  assert.doesNotMatch(bridge, /page_load_strategy = "none"/);
  assert.match(bridge, /def wait_for_navigation_element\(/);
  assert.match(bridge, /selector-load-complete/);
  assert.match(bridge, /len\(snapshot\.get\("links", \[\]\)\) >= expected/);
  assert.match(bridge, /wait_for_navigation_element\(driver, By\.ID, "selector-view", "selector"/);
  assert.match(bridge, /wait_for_navigation_element\(driver, By\.ID, "selector-view", "selector-reload"/);
  assert.ok(bridge.includes('navigate(driver, gateway + "/", "gateway-management")'));
  assert.match(bridge, /wait_for_navigation_element\(driver, By\.TAG_NAME, "body", "gateway-management"/);
  assert.match(bridge, /wait_for_navigation_element\(driver, By\.ID, "session-status", "gateway-session"/);
  assert.match(bridge, /expected_path="\/"/);
  assert.match(bridge, /_client_config\.timeout = WEBDRIVER_COMMAND_TIMEOUT_SECONDS/);
  assert.match(bridge, /WebDriverWait\(driver, 60, poll_frequency=POLL_SECONDS\)/);

  assert.match(bridge, /DSH_ORBIT_NSS_CERTUTIL/);
  assert.match(bridge, /firefox-profile-nss/);
  assert.match(bridge, /install_profile_ca/);
  assert.match(bridge, /"C,,"/);
  assert.match(bridge, /sql:/);
  assert.match(bridge, /log_output=subprocess\.DEVNULL/);
  assert.match(bridge, /security\.enterprise_roots\.enabled", False/);
  assert.doesNotMatch(bridge, /security\.enterprise_roots\.enabled", True/);
  assert.match(bridge, /firefox-start-failed:/);
  assert.match(bridge, /cleanup-start/);
  assert.match(bridge, /cleanup-profile-done/);
  assert.match(bridge, /trustMode/);
  assert.match(bridge, /redact_error_text/);
  assert.match(bridge, /safe_url_for_log/);
  assert.match(bridge, /navigation-returned:.*safe_url_for_log/);
  assert.doesNotMatch(bridge, /CurrentUser\\\\Root|addstore|delstore|Remove-Item|installed-retained/);
  assert.match(emitter, /rmSync\(rawPath/);
  assert.doesNotMatch(bridge, /Retain the drill anchor/);
  assert.match(bridge, /challengeDigest/);
  assert.match(bridge, /cookieIsolationVerified/);
  assert.match(bridge, /cookie-isolation-start/);
  assert.match(bridge, /cookie-open-a-observed/);
  assert.match(bridge, /cookie-selector-observed/);
  assert.match(bridge, /cookie-isolation-inputs/);
  assert.doesNotMatch(bridge, /cookie-jars-before-verify/);
  assert.match(bridge, /cookie-isolation-verified/);
  assert.match(bridge, /UnexpectedAlertPresentException/);
  assert.match(bridge, /navigation-alert-dismissed/);
  assert.match(bridge, /gateway-session/);
  assert.match(bridge, /except \(OSError, ValueError\)/);
  assert.match(bridge, /broken socket escape/);
  assert.doesNotMatch(bridge, /ignore.*certificate|--ignore-certificate-errors|rejectUnauthorized.*false/i);
});

test("Stage 8 candidate tooling requires explicit current external runtime identity", async () => {
  const source = await readFile(DRIVER, "utf8");
  for (const variable of [
    "DSH_ORBIT_DRILL_ORBIT_VERSION",
    "DSH_ORBIT_DRILL_DSH_VERSION",
    "DSH_ORBIT_DRILL_DSH_COMMIT",
    "DSH_ORBIT_DRILL_DSH_CLI_SHA256",
  ]) assert.match(source, new RegExp(variable));
  for (const variable of ["DSH_ORBIT_DRILL_GATEWAY_PORT", "DSH_ORBIT_DRILL_NODE_A_PORT", "DSH_ORBIT_DRILL_NODE_B_PORT"]) {
    assert.match(source, new RegExp(variable));
  }
  assert.match(source, /is required for candidate-bound mounted evidence/);
  assert.match(source, /port: Number\(GATEWAY_PORT\)/);
  assert.doesNotMatch(source, /port: 8443/);
  assert.doesNotMatch(source, /0\\.4\\.0-rc\\.1/);
  assert.doesNotMatch(source, /0\\.1\\.1-rc\\.2/);
});
