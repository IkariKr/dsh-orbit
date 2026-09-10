import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const DRIVER = new URL("../scripts/registry-drill.mjs", import.meta.url);
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
  assert.match(source, /ROUTE_DOMAIN_HOST/);
  assert.match(source, /DNS:registry-hub/);
  assert.match(source, /certificateHasDnsSan\(DRILL_CERT_PATH, "registry-hub"\)/);
  assert.match(source, /NODE_HUB_URL = "https:\/\/registry-hub:5446\//);
  assert.match(source, /NODE_HUB_CA_PATH = "\/etc\/caddy\/tls\/ca\.crt"/);
  assert.match(source, /DSH_ORBIT_NODE_CA_CERT: NODE_HUB_CA_PATH/);
  assert.match(source, /ROUTE_DOMAIN =/);
  assert.match(source, /checkpoint\.leafFingerprint/);
  assert.match(source, /runner-owned-firefox-selenium/);
  assert.match(source, /DSH_ORBIT_BROWSER_CHALLENGE/);
  assert.match(source, /BROWSER_NODE_BINDING_PATH/);
  assert.match(source, /browserBridgeProcess/);
  assert.match(source, /BROWSER_BRIDGE_LOG_PATH/);
  assert.match(source, /prepareDrillProxySecret\(\)/);
  assert.match(source, /removeDrillProxySecret\(\)/);
  assert.match(source, /DRILL_PROXY_SECRET_PATH/);
  assert.match(source, /nodeIds: \[aNodeId, bNodeId\]/);
  assert.match(source, /runVerificationSequence\(/);
  assert.match(source, /createCompatibilityReport\(/);
  assert.match(source, /REQUIRED_MOUNTED_MATRIX_FIELDS/);
  assert.match(source, /ROUTE_DOMAIN/);
  assert.match(source, /GATEWAY_URL/);
  assert.match(source, /requiredMatrix/);
  assert.match(source, /browserCheckpoint\.selectorOpenAVerified/);
  assert.match(source, /browserCheckpoint\.cookieIsolationVerified/);
  assert.match(source, /browser lifecycle checkpoint did not verify Selector Open A\/B navigation/);
  assert.match(source, /routeTargetsConfiguredAB/);
  assert.match(source, /hubRestartRecovery/);
  assert.match(source, /headers:\{host:'127\.0\.0\.1:8443'\}/);
  assert.doesNotMatch(source, /get\('http:\/\/127\.0\.0\.1:5445\//);
  assert.match(source, /dshLossAndRecovery/);
  assert.match(source, /bookmarkFailClosed/);
  assert.match(source, /sameNodeIdReenroll/);
  assert.match(source, /freshHubRouteIdentity/);
  assert.match(source, /assertMatrixComplete\(\)/);
  assert.match(source, /docker restart \$\{hubContainer\}/);
  assert.match(source, /suspendDsh/);
  assert.match(source, /routeWebSocket\(/);
  assert.match(source, /runningImageEvidence\(/);
  assert.match(source, /aging reset healed A without heartbeat/);
  assert.doesNotMatch(source, /rejectUnauthorized:\s*false/);
  assert.doesNotMatch(source, /http:\/\/registry-hub:5446/);
  assert.doesNotMatch(source, /accept_insecure_certs\s*=\s*True/);
  assert.doesNotMatch(source, /NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.doesNotMatch(source, /--ignore-certificate-errors/);
  assert.doesNotMatch(source, /requiredMatrix\s*=\s*\{[^}]*PASS/s);
});

test("runner-owned Firefox bridge requires trusted browser settings and secret-free checkpoints", async () => {
  const source = await readFile(BRIDGE, "utf8");
  assert.match(source, /accept_insecure_certs = False/);
  assert.match(source, /security\.enterprise_roots\.enabled/);
  assert.match(source, /runner-owned-firefox-selenium/);
  assert.match(source, /data-plaintext-once/);
  assert.match(source, /application document never runs[\s\S]*contains userinfo/);
  assert.match(source, /driver\.get\(gateway \+ "\/"\)/);
  assert.match(source, /authority_warmup\.replace\("https:\/\/", "https:\/\/operator:drill-password@", 1\)/);
  assert.match(source, /gateway_warmup = gateway\.rstrip\("\/"\) \+ "\/styles\.css"/);
  assert.match(source, /authority_warmup = warm_url\.rstrip\("\/"\) \+ "\/styles\.css"/);
  assert.ok(
    source.indexOf("write_json(Path(args.bootstrap_path), bootstrap)") <
      source.indexOf("for warm_url in [selector_url, open_urls[\"a\"], open_urls[\"b\"]]"),
    "Selector/Node authority warmup must occur after management bootstrap",
  );
  assert.match(source, /if stop_path\.exists\(\):/);
  assert.match(source, /CERTUTIL_TIMEOUT_SECONDS/);
  assert.match(source, /certutil timed out/);
  assert.match(source, /forced import is idempotent/);
  assert.doesNotMatch(source, /certutil_run\(\["-user", "-store", "Root"/);
  assert.match(source, /Firefox trust setup unavailable/);
  assert.match(source, /driver\.get\(gateway \+ "\/"\)/);
  assert.match(source, /management-nodes-reloaded/);
  assert.match(source, /wait_for_node_ids\(driver, node_ids, stop_path, log=log\)/);
  assert.match(source, /nodes-observed:count=/);
  assert.match(source, /selectorOpenAVerified/);
  assert.match(source, /selectorOpenBVerified/);
  assert.match(source, /cookieIsolationVerified/);
  assert.match(source, /driver\.get_cookies\(\)/);
  assert.match(source, /verify_cookie_jar_isolation/);
  assert.match(source, /expected_value/);
  assert.match(source, /drill_node/);
  assert.match(source, /host-only/);
  assert.match(source, /open_urls/);
  assert.match(source, /selectorUrl/);
  assert.match(source, /return True/);
  assert.doesNotMatch(source, /plaintext.*write_text|token.*write_text/i);
  assert.doesNotMatch(source, /accept_insecure_certs\s*=\s*True/);
  assert.doesNotMatch(source, /ignore.*certificate|--ignore-certificate-errors|rejectUnauthorized.*false/i);
});

test("mounted evidence emitter is the only PASS artifact producer", async () => {
  const source = await readFile(new URL("../scripts/emit-stage8-mounted-evidence.mjs", import.meta.url), "utf8");
  assert.match(source, /drill-evidence\.json/);
  assert.match(source, /assertMountedMatrixShape\(raw\.requiredMatrix, \{ requirePass: true \}\)/);
  assert.match(source, /rawEvidenceSha256/);
  assert.match(source, /rawEvidenceBytes/);
  assert.doesNotMatch(source, /process\.argv.*PASS|process\.argv.*requiredMatrix/);
});

test("mounted drill keeps the RFC production thresholds explicit", async () => {
  const source = await readFile(DRIVER, "utf8");
  assert.match(source, /HEARTBEAT_CADENCE_SECONDS = 60/);
  assert.match(source, /HEARTBEAT_MISSED_BEATS = 3/);
  assert.match(source, /HEARTBEAT_LOST_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(source, /productionThresholdsUnchanged: true/);
});
