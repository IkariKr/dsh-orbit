import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const MANIFEST_PATH = join(process.cwd(), "test", "evidence", "stage6", "manifest.json");
const ACCEPTED_DSH_VERSION = "0.1.1-rc.2";
const ACCEPTED_DSH_COMMIT_SHA = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e";
const ACCEPTED_DSH_CLI_BINARY_SHA256 = "c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62";

function assertGitCommitExists(commitSha) {
  assert.match(commitSha, /^[0-9a-f]{40}$/, "git commit identity must be a full 40-character SHA");
  assert.doesNotThrow(
    () => execFileSync("git", ["cat-file", "-e", `${commitSha}^{commit}`], { cwd: process.cwd(), stdio: "ignore" }),
    `testedCommit must resolve to a real git commit (${commitSha})`,
  );
}

export function validateStage6Manifest(manifest) {
  assert.equal(typeof manifest, "object", "manifest must be an object");
  assert.ok(manifest !== null, "manifest cannot be null");

  // Mandatory top-level fields
  assert.equal(manifest.schemaVersion, 2, "schemaVersion must be 2");
  assert.ok(manifest.stage && manifest.stage.includes("Stage 6"), "stage must reference Stage 6");
  assert.equal(manifest.branch, "feat/v0.4-stage6-mounted-e2e", "branch must match Stage 6 branch");
  assert.ok(
    ["local-multi-process-rehearsal", "physical-two-host-mounted-e2e"].includes(manifest.scope),
    "scope must describe either local-multi-process-rehearsal or physical-two-host-mounted-e2e",
  );
  assert.equal(manifest.reviewGate, "HOLD", "rehearsal evidence must keep Review Gate B on HOLD until independent review");
  if (manifest.scope === "physical-two-host-mounted-e2e") {
    assert.equal(manifest.physicalTwoHostE2E, "PASS", "physical two-host E2E must be PASS when scope is physical-two-host-mounted-e2e");
  } else {
    assert.equal(manifest.physicalTwoHostE2E, "NOT_EXECUTED", "physical two-host E2E must not be claimed before it is executed");
  }
  assert.match(manifest.testedCommit, /^[0-9a-f]{40}$/, "testedCommit must be a 40-character git SHA");
  assert.ok(!Number.isNaN(Date.parse(manifest.timestamp)), "timestamp must be valid ISO date");

  // Browser metadata
  assert.ok(manifest.browser, "browser metadata must exist");
  assert.ok(manifest.browser.name, "browser.name required");
  assert.ok(manifest.browser.version, "browser.version required");
  assert.ok(manifest.browser.engine, "browser.engine required");
  assert.ok(manifest.browser.backend, "browser.backend required");
  assert.ok(manifest.browser.viewport?.width >= 320, "browser.viewport.width required");
  assert.ok(manifest.browser.viewport?.height >= 320, "browser.viewport.height required");

  // Gateway metadata
  assert.ok(manifest.gateway, "gateway metadata must exist");
  assert.ok(manifest.gateway.rehearsalSelectorAuthority, "gateway.rehearsalSelectorAuthority required");
  assert.ok(["http", "https"].includes(manifest.gateway.trustedExternalScheme), "gateway.trustedExternalScheme required");
  assert.ok(manifest.gateway.tlsState, "gateway.tlsState required");

  // Node A & B identities
  assert.ok(manifest.nodeA, "nodeA metadata required");
  assert.match(manifest.nodeA.nodeId, /^node_[0-9a-f]{32}$/, "nodeA.nodeId must be valid node identifier");
  assert.match(manifest.nodeA.authority, /^n-[0-9a-f]{32}\..+$/, "nodeA.authority must follow deterministic grammar");
  assert.ok(manifest.nodeA.routeTargetClass, "nodeA.routeTargetClass required");
  assert.ok(["http", "https"].includes(manifest.nodeA.routeTargetScheme), "nodeA.routeTargetScheme must be http or https");
  assert.ok(["none", "private-ca", "system"].includes(manifest.nodeA.tlsMode), "nodeA.tlsMode must be a known transport TLS mode");
  if (manifest.nodeA.routeTargetScheme === "https") {
    assert.notEqual(manifest.nodeA.tlsMode, "none", "HTTPS Node A must declare a TLS mode");
    assert.equal(manifest.nodeA.tlsVerified, true, "HTTPS Node A must record successful TLS verification");
  } else {
    assert.equal(manifest.nodeA.tlsMode, "none", "HTTP Node A cannot declare TLS");
    assert.equal(manifest.nodeA.tlsVerified, null, "HTTP Node A has no TLS verification result");
  }
  assert.ok(manifest.nodeA.dshIdentity, "nodeA.dshIdentity required");

  assert.ok(manifest.nodeB, "nodeB metadata required");
  assert.match(manifest.nodeB.nodeId, /^node_[0-9a-f]{32}$/, "nodeB.nodeId must be valid node identifier");
  assert.match(manifest.nodeB.authority, /^n-[0-9a-f]{32}\..+$/, "nodeB.authority must follow deterministic grammar");
  assert.ok(manifest.nodeB.routeTargetClass, "nodeB.routeTargetClass required");
  assert.ok(["http", "https"].includes(manifest.nodeB.routeTargetScheme), "nodeB.routeTargetScheme must be http or https");
  assert.ok(["none", "private-ca", "system"].includes(manifest.nodeB.tlsMode), "nodeB.tlsMode must be a known transport TLS mode");
  if (manifest.nodeB.routeTargetScheme === "https") {
    assert.notEqual(manifest.nodeB.tlsMode, "none", "HTTPS Node B must declare a TLS mode");
    assert.equal(manifest.nodeB.tlsVerified, true, "HTTPS Node B must record successful TLS verification");
  } else {
    assert.equal(manifest.nodeB.tlsMode, "none", "HTTP Node B cannot declare TLS");
    assert.equal(manifest.nodeB.tlsVerified, null, "HTTP Node B has no TLS verification result");
  }
  assert.ok(manifest.nodeB.dshIdentity, "nodeB.dshIdentity required");

  // Distinctness invariants
  assert.notEqual(manifest.nodeA.nodeId, manifest.nodeB.nodeId, "Node A and Node B IDs must be distinct");
  assert.notEqual(manifest.nodeA.authority, manifest.nodeB.authority, "Node A and Node B authorities must be distinct");

  // Scenario requirements
  assert.ok(Array.isArray(manifest.scenarios), "manifest.scenarios must be an array");
  assert.ok(manifest.scenarios.length >= 6, "manifest must cover all required Stage 6 scenarios");

  const requiredIds = [
    "scenario-1-selector",
    "scenario-2-open-a",
    "scenario-3-open-b",
    "route-isolation",
    "cookie-credential-isolation-automated",
    "cookie-browser-jar-isolation",
    "drill-route-outage",
    "drill-dsh-outage",
    "drill-recovery",
    "drill-delete",
    "drill-restart",
  ];

  const presentIds = new Set(manifest.scenarios.map((s) => s.id));
  for (const reqId of requiredIds) {
    assert.ok(presentIds.has(reqId), `Scenario '${reqId}' must be present in manifest`);
  }

  const isPhysical = manifest.scope === "physical-two-host-mounted-e2e";
  if (isPhysical) {
    assert.ok(manifest.candidate, "manifest.candidate required in physical scope");
    assert.match(manifest.candidate.orbitRevision, /^[0-9a-f]{40}$/, "candidate.orbitRevision must be a full 40-character git SHA");
    assert.equal(
      manifest.testedCommit,
      manifest.candidate.orbitRevision,
      "testedCommit must exactly match candidate.orbitRevision in physical scope",
    );
    assertGitCommitExists(manifest.testedCommit);
    assert.equal(manifest.candidate.dshVersion, ACCEPTED_DSH_VERSION, `candidate.dshVersion must be ${ACCEPTED_DSH_VERSION}`);
    assert.equal(
      manifest.candidate.dshCommitSha,
      ACCEPTED_DSH_COMMIT_SHA,
      `candidate.dshCommitSha must be the accepted Stage 6 DSH commit ${ACCEPTED_DSH_COMMIT_SHA}`,
    );
    assert.equal(
      manifest.candidate.dshCliBinarySha256,
      ACCEPTED_DSH_CLI_BINARY_SHA256,
      "candidate.dshCliBinarySha256 must match the accepted Stage 6 DSH CLI binary",
    );
  }

  const allowedResults = isPhysical
    ? new Set(["PASS"])
    : new Set(["PASS", "FAIL", "NOT_EXECUTED", "BLOCKED"]);

  for (const s of manifest.scenarios) {
    assert.ok(s.id, "scenario id required");
    assert.ok(s.name, "scenario name required");
    assert.ok(s.expected, "scenario expected required");
    assert.ok(s.actual, "scenario actual required");
    if (isPhysical) {
      assert.equal(s.result, "PASS", `In physical two-host scope, all required scenarios must be PASS (got ${s.result} for '${s.id}')`);
    } else {
      assert.ok(allowedResults.has(s.result), `Scenario ${s.id} result must be PASS, FAIL, NOT_EXECUTED, or BLOCKED`);
    }
    if (s.result !== "PASS") {
      assert.equal(Boolean(s.file), false, `Scenario ${s.id} must not attach PASS-style screenshot evidence when result is ${s.result}`);
    }
    if (s.file) {
      assert.ok(s.bytes > 0, `Scenario ${s.id} bytes must be positive`);
      assert.match(s.sha256, /^[0-9a-f]{64}$/, `Scenario ${s.id} sha256 must be valid hex hash`);
    }
  }

  // No secrets constraint
  const jsonStr = JSON.stringify(manifest).toLowerCase();
  const forbiddenSubstrings = [
    "operator-edge-session-token",
    "test-gateway-secret",
    "dsh-orbit-hub-session=",
    "-----begin private key-----",
    "-----begin rsa private key-----",
    "password=",
    "secret=",
  ];
  for (const forbidden of forbiddenSubstrings) {
    assert.equal(jsonStr.includes(forbidden), false, `Manifest must not contain secret or token '${forbidden}'`);
  }

  const cookieAutomated = manifest.scenarios.find((s) => s.id === "cookie-credential-isolation-automated");
  assert.equal(cookieAutomated.result, "PASS", "automated cookie/credential boundary coverage must pass");

  const cookieBrowser = manifest.scenarios.find((s) => s.id === "cookie-browser-jar-isolation");
  if (isPhysical) {
    assert.equal(cookieBrowser.result, "PASS", "physical/browser Cookie Jar drill must pass in physical two-host manifest");
    assert.ok(cookieBrowser.file, "physical cookie-browser-jar-isolation must attach structured evidence file");
    assert.ok(cookieBrowser.bytes > 0, "physical cookie-browser-jar-isolation bytes must be positive");
    assert.match(cookieBrowser.sha256, /^[0-9a-f]{64}$/, "physical cookie-browser-jar-isolation sha256 must be valid hex hash");
  } else {
    assert.equal(cookieBrowser.result, "NOT_EXECUTED", "physical/browser Cookie Jar drill must remain NOT_EXECUTED in the local rehearsal manifest");
  }

  // Transport and session-resume evidence artifacts required in physical scope
  if (isPhysical) {
    assert.ok(manifest.artifacts, "manifest.artifacts must exist in physical scope");
    assert.ok(manifest.artifacts.nodeATransport, "manifest.artifacts.nodeATransport required in physical scope");
    assert.match(manifest.artifacts.nodeATransport.sha256, /^[0-9a-f]{64}$/, "nodeATransport sha256 must be valid");
    assert.ok(manifest.artifacts.nodeBTransport, "manifest.artifacts.nodeBTransport required in physical scope");
    assert.match(manifest.artifacts.nodeBTransport.sha256, /^[0-9a-f]{64}$/, "nodeBTransport sha256 must be valid");
    assert.ok(manifest.artifacts.sessionResume, "manifest.artifacts.sessionResume required in physical scope");
    assert.match(manifest.artifacts.sessionResume.sha256, /^[0-9a-f]{64}$/, "sessionResume sha256 must be valid");
  }

  return true;
}

export function validateTransportArtifactSemantics(
  doc,
  { expectedRole, expectedNodeId, expectedAuthority, expectedDshCommitSha, expectedCliBinarySha256 } = {},
) {
  assert.equal(typeof doc, "object", "transport doc must be an object");
  assert.ok(doc.checks, "transport doc.checks required");

  if (expectedNodeId) {
    assert.equal(doc.nodeId, expectedNodeId, `doc.nodeId must match expected ${expectedNodeId}`);
  }
  if (expectedAuthority) {
    assert.equal(doc.authority, expectedAuthority, `doc.authority must match expected ${expectedAuthority}`);
  }

  assert.equal(doc.checks.htmlRoot?.result, "PASS", "htmlRoot check result must be PASS");
  assert.equal(doc.checks.asset?.result, "PASS", "asset check result must be PASS");
  assert.equal(doc.checks.routeReadyApi?.result, "PASS", "routeReadyApi check result must be PASS");
  assert.equal(doc.checks.webSocket101?.result, "PASS", "webSocket101 check result must be PASS");
  assert.equal(doc.checks.pingPong?.result, "PASS", "pingPong check result must be PASS");
  assert.equal(doc.checks.longLivedTransport?.result, "PASS", "longLivedTransport check result must be PASS");

  assert.ok(
    Number(doc.checks.longLivedTransport?.idleDurationMs) >= 31000,
    `longLivedTransport idleDurationMs must be >= 31000ms (got ${doc.checks.longLivedTransport?.idleDurationMs})`,
  );
  assert.equal(doc.checks.longLivedTransport?.postIdlePingPong, "PASS", "postIdlePingPong must be PASS");
  assert.equal(doc.checks.longLivedTransport?.retainedOpen, true, "retainedOpen must be true");

  assert.ok(doc.checks.compatibilityReport, "compatibilityReport required");
  assert.equal(doc.checks.compatibilityReport?.webSocketTransport, "pass", "compatibilityReport webSocketTransport must be pass");
  assert.equal(doc.checks.compatibilityReport?.webRoutesCapability, true, "compatibilityReport webRoutesCapability must be true");

  assert.ok(doc.runtimeIdentity, "runtimeIdentity required");
  assert.equal(doc.runtimeIdentity.dshVersion, "0.1.1-rc.2", "dshVersion must be 0.1.1-rc.2");
  assert.match(doc.runtimeIdentity.dshCommitSha, /^[0-9a-f]{40}$/, "dshCommitSha must be a 40-character hex string");
  assert.match(doc.runtimeIdentity.cliBinarySha256, /^[0-9a-f]{64}$/, "cliBinarySha256 must be a 64-character hex string");

  if (expectedDshCommitSha) {
    assert.equal(doc.runtimeIdentity.dshCommitSha, expectedDshCommitSha, `doc.runtimeIdentity.dshCommitSha must match expected ${expectedDshCommitSha}`);
  }
  if (expectedCliBinarySha256) {
    assert.equal(doc.runtimeIdentity.cliBinarySha256, expectedCliBinarySha256, `doc.runtimeIdentity.cliBinarySha256 must match expected ${expectedCliBinarySha256}`);
  }

  if (expectedRole === "nas") {
    assert.ok(doc.runtimeIdentity.containerImageDigest, "NAS runtimeIdentity must contain containerImageDigest");
    assert.match(doc.runtimeIdentity.containerImageDigest, /^sha256:[0-9a-f]{64}$/, "containerImageDigest must be sha256:hex");
  } else if (expectedRole === "workstation") {
    assert.ok(doc.runtimeIdentity.processRole, "Workstation runtimeIdentity must declare processRole");
  }
  return true;
}

export function validateSessionResumeArtifactSemantics(doc, { expectedNodeA, expectedNodeB } = {}) {
  assert.equal(typeof doc, "object", "session resume doc must be an object");
  assert.ok(doc.nodeA, "sessionResume.nodeA required");
  assert.ok(doc.nodeB, "sessionResume.nodeB required");

  if (expectedNodeA?.authority) {
    assert.equal(doc.nodeA.authority, expectedNodeA.authority, "nodeA authority mismatch");
  }
  if (expectedNodeB?.authority) {
    assert.equal(doc.nodeB.authority, expectedNodeB.authority, "nodeB authority mismatch");
  }

  assert.equal(doc.nodeA.sessionResume, "PASS", "nodeA sessionResume must be PASS");
  assert.equal(doc.nodeB.sessionResume, "PASS", "nodeB sessionResume must be PASS");
  assert.equal(doc.nodeA.modelReselected, true, "nodeA modelReselected must be true");
  assert.equal(doc.nodeB.modelReselected, true, "nodeB modelReselected must be true");
  assert.equal(doc.result, "PASS", "overall session resume result must be PASS");
  return true;
}

export function validateCookieJarArtifactSemantics(doc) {
  assert.equal(typeof doc, "object", "cookie jar doc must be an object");
  assert.equal(doc.authorityA?.probeCookiePresent, true, "authorityA probeCookiePresent must be true");
  assert.equal(doc.selector?.probeCookiePresent, false, "selector probeCookiePresent must be false");
  assert.equal(doc.authorityB?.probeCookiePresent, false, "authorityB probeCookiePresent must be false");
  assert.equal(doc.downstreamHeaders?.gatewayAuthCookiePresent, false, "gatewayAuthCookiePresent must be false");
  assert.equal(doc.downstreamHeaders?.gatewayAuthHeaderPresent, false, "gatewayAuthHeaderPresent must be false");
  assert.equal(doc.downstreamHeaders?.hubSessionPresent, false, "hubSessionPresent must be false");
  assert.equal(doc.downstreamHeaders?.managementCredentialPresent, false, "managementCredentialPresent must be false");
  assert.equal(doc.result, "PASS", "cookie jar result must be PASS");
  return true;
}

export function validateRestartArtifactSemantics(doc) {
  assert.equal(typeof doc, "object", "restart doc must be an object");
  assert.ok(doc.beforeRestart?.authorityB, "beforeRestart.authorityB required");
  assert.ok(doc.beforeRestart?.routeTargetB, "beforeRestart.routeTargetB required");
  assert.ok(doc.afterRestart?.authorityB, "afterRestart.authorityB required");
  assert.ok(doc.afterRestart?.routeTargetB, "afterRestart.routeTargetB required");
  assert.equal(doc.beforeRestart.authorityB, doc.afterRestart.authorityB, "authorityB must match across restart");
  assert.equal(doc.beforeRestart.routeTargetB, doc.afterRestart.routeTargetB, "routeTargetB must match across restart");
  assert.equal(doc.afterRestart.eligibleB, true, "afterRestart.eligibleB must be true");
  assert.equal(doc.result, "PASS", "restart result must be PASS");
  return true;
}

test("Stage 6 Mounted Contract: sample valid manifest passes validation and rejects tampering", () => {
  const sample = {
    schemaVersion: 2,
    stage: "v0.4 Stage 6 Real Two-Node Mounted Product E2E",
    branch: "feat/v0.4-stage6-mounted-e2e",
    scope: "local-multi-process-rehearsal",
    reviewGate: "HOLD",
    physicalTwoHostE2E: "NOT_EXECUTED",
    testedCommit: "44d875b68528636cc9a0a8790f29b5d5cf5ce9f1",
    timestamp: "2026-09-05T05:30:00.000Z",
    browser: {
      name: "ZCode In-app Browser",
      version: "3.11.2",
      engine: "Chromium 146.0.7680.80 / Electron 41.0.3",
      backend: "iab",
      viewport: { width: 1280, height: 720 },
    },
    gateway: {
      rehearsalSelectorAuthority: "stage6.localhost:60400",
      trustedExternalScheme: "https",
      tlsState: "verified",
    },
    nodeA: {
      nodeId: "node_11111111111111111111111111111111",
      authority: "n-11111111111111111111111111111111.stage6.localhost:60400",
      routeTargetClass: "nas-class",
      routeTargetScheme: "https",
      tlsMode: "private-ca",
      tlsVerified: true,
      dshIdentity: "fixture-nas-node-A",
    },
    nodeB: {
      nodeId: "node_22222222222222222222222222222222",
      authority: "n-22222222222222222222222222222222.stage6.localhost:60400",
      routeTargetClass: "workstation-class",
      routeTargetScheme: "http",
      tlsMode: "none",
      tlsVerified: null,
      dshIdentity: "fixture-workstation-node-B",
    },
    scenarios: [
      { id: "scenario-1-selector", name: "Selector Initial Shell", expected: "A/B eligible", actual: "A/B eligible", result: "PASS" },
      { id: "scenario-2-open-a", name: "Open Node A", expected: "A loads", actual: "A loads", result: "PASS" },
      { id: "scenario-3-open-b", name: "Open Node B in Tab 2", expected: "B loads, Tab 1 on A", actual: "B loads, Tab 1 on A", result: "PASS" },
      { id: "route-isolation", name: "Route Isolation", expected: "Strict separation", actual: "Strict separation", result: "PASS" },
      { id: "cookie-credential-isolation-automated", name: "Automated Cookie & Credential Boundary", expected: "Gateway credentials stripped and Domain removed", actual: "Automated boundary coverage passed", result: "PASS" },
      { id: "cookie-browser-jar-isolation", name: "Mounted Browser Cookie Jar Isolation", expected: "Probe cookie present only on A and absent on selector/B", actual: "Not executed in local multi-process rehearsal", result: "NOT_EXECUTED" },
      { id: "drill-route-outage", name: "RouteIngress Outage", expected: "A fail closed, B unaffected", actual: "A fail closed, B unaffected", result: "PASS" },
      { id: "drill-dsh-outage", name: "DSH Down, Ingress Alive", expected: "A unreachable, B unaffected", actual: "A unreachable, B unaffected", result: "PASS" },
      { id: "drill-recovery", name: "Recovery Drill", expected: "A Open returns", actual: "A Open returns", result: "PASS" },
      { id: "drill-delete", name: "Delete Drill", expected: "A tombstoned, bookmark 404", actual: "A tombstoned, bookmark 404", result: "PASS" },
      { id: "drill-restart", name: "Restart Stability Drill", expected: "Identities stable", actual: "Identities stable", result: "PASS" },
    ],
  };

  assert.equal(validateStage6Manifest(sample), true);

  // Negative: Secret presence throws
  assert.throws(() => {
    validateStage6Manifest({ ...sample, leak: "test-gateway-secret" });
  });

  // Negative: Duplicate node IDs throws
  assert.throws(() => {
    validateStage6Manifest({
      ...sample,
      nodeB: { ...sample.nodeB, nodeId: sample.nodeA.nodeId },
    });
  });

  // Negative: a local rehearsal cannot claim Review Gate B approval.
  assert.throws(() => {
    validateStage6Manifest({ ...sample, reviewGate: "PASS" });
  });

  // Negative: HTTP transport cannot claim TLS verification.
  assert.throws(() => {
    validateStage6Manifest({
      ...sample,
      nodeB: { ...sample.nodeB, tlsVerified: true },
    });
  });

  // Negative: the unexecuted browser Cookie Jar drill cannot be relabeled PASS in local scope.
  assert.throws(() => {
    validateStage6Manifest({
      ...sample,
      scenarios: sample.scenarios.map((scenario) =>
        scenario.id === "cookie-browser-jar-isolation" ? { ...scenario, result: "PASS" } : scenario,
      ),
    });
  });

  // Positive: physical two-host manifest passes validation with HOLD gate
  const physicalSample = {
    ...sample,
    scope: "physical-two-host-mounted-e2e",
    physicalTwoHostE2E: "PASS",
    reviewGate: "HOLD",
    candidate: {
      orbitVersion: "0.4.0",
      orbitRevision: sample.testedCommit,
      dshVersion: ACCEPTED_DSH_VERSION,
      dshCommitSha: ACCEPTED_DSH_COMMIT_SHA,
      dshCliBinarySha256: ACCEPTED_DSH_CLI_BINARY_SHA256,
    },
    artifacts: {
      nodeATransport: { file: "node-a-transport.json", bytes: 100, sha256: "0".repeat(64) },
      nodeBTransport: { file: "node-b-transport.json", bytes: 100, sha256: "0".repeat(64) },
      sessionResume: { file: "session-resume.json", bytes: 100, sha256: "0".repeat(64) },
    },
    scenarios: sample.scenarios.map((scenario) =>
      scenario.id === "cookie-browser-jar-isolation"
        ? {
            ...scenario,
            result: "PASS",
            file: "cookie-browser-isolation.json",
            bytes: 100,
            sha256: "0".repeat(64),
          }
        : scenario,
    ),
  };
  assert.equal(validateStage6Manifest(physicalSample), true);

  // Negative: physical two-host manifest cannot claim Review Gate B PASS prematurely
  assert.throws(() => {
    validateStage6Manifest({ ...physicalSample, reviewGate: "PASS" });
  });

  // Negative: physical two-host manifest rejects a shortened candidate revision.
  assert.throws(() => {
    validateStage6Manifest({
      ...physicalSample,
      candidate: { ...physicalSample.candidate, orbitRevision: physicalSample.candidate.orbitRevision.slice(0, 7) },
    });
  }, /candidate.orbitRevision must be a full 40-character git SHA/);

  // Negative: physical two-host manifest rejects testedCommit / candidate.orbitRevision mismatch.
  assert.throws(() => {
    validateStage6Manifest({
      ...physicalSample,
      candidate: { ...physicalSample.candidate, orbitRevision: "1".repeat(40) },
    });
  }, /testedCommit must exactly match candidate.orbitRevision/);

  // Negative: an internally consistent but nonexistent candidate SHA is rejected by Git object verification.
  assert.throws(() => {
    validateStage6Manifest({
      ...physicalSample,
      testedCommit: "0".repeat(40),
      candidate: { ...physicalSample.candidate, orbitRevision: "0".repeat(40) },
    });
  }, /testedCommit must resolve to a real git commit/);

  // Negative: an internally consistent fake DSH commit is still rejected against the accepted Stage 6 pin.
  assert.throws(() => {
    validateStage6Manifest({
      ...physicalSample,
      candidate: { ...physicalSample.candidate, dshCommitSha: "0".repeat(40) },
    });
  }, /candidate.dshCommitSha must be the accepted Stage 6 DSH commit/);

  // Negative: an internally consistent fake DSH CLI hash is still rejected against the accepted Stage 6 pin.
  assert.throws(() => {
    validateStage6Manifest({
      ...physicalSample,
      candidate: { ...physicalSample.candidate, dshCliBinarySha256: "0".repeat(64) },
    });
  }, /candidate.dshCliBinarySha256 must match the accepted Stage 6 DSH CLI binary/);

  // Negative: physical two-host manifest fails closed if any required scenario is FAIL
  assert.throws(() => {
    validateStage6Manifest({
      ...physicalSample,
      scenarios: physicalSample.scenarios.map((s) =>
        s.id === "drill-dsh-outage" ? { ...s, result: "FAIL", file: undefined, bytes: undefined, sha256: undefined } : s,
      ),
    });
  }, /In physical two-host scope, all required scenarios must be PASS/);

  // Negative: physical two-host manifest fails closed if cookie-browser-jar-isolation lacks structured evidence file
  assert.throws(() => {
    validateStage6Manifest({
      ...physicalSample,
      scenarios: physicalSample.scenarios.map((s) =>
        s.id === "cookie-browser-jar-isolation" ? { ...s, file: undefined, bytes: undefined, sha256: undefined } : s,
      ),
    });
  }, /physical cookie-browser-jar-isolation must attach structured evidence file/);

  // Positive: validateTransportArtifactSemantics accepts valid transport doc
  const sampleTransport = {
    checks: {
      htmlRoot: { result: "PASS" },
      asset: { result: "PASS" },
      routeReadyApi: { result: "PASS" },
      webSocket101: { result: "PASS" },
      pingPong: { result: "PASS" },
      longLivedTransport: {
        result: "PASS",
        idleDurationMs: 31500,
        postIdlePingPong: "PASS",
        retainedOpen: true,
      },
      compatibilityReport: {
        webSocketTransport: "pass",
        webRoutesCapability: true,
      },
    },
    runtimeIdentity: {
      dshVersion: "0.1.1-rc.2",
      dshCommitSha: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
      cliBinarySha256: "c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62",
      containerImageDigest: "sha256:ad3a966f19b273c9f918e074111e92c3aaeaca66960701f447438d4e9f71dfc5",
      processRole: "nas-containerized-dsh",
    },
  };
  assert.equal(validateTransportArtifactSemantics(sampleTransport, { expectedRole: "nas" }), true);

  // Negative: validateTransportArtifactSemantics rejects short idleDurationMs
  assert.throws(() => {
    validateTransportArtifactSemantics({
      ...sampleTransport,
      checks: {
        ...sampleTransport.checks,
        longLivedTransport: { ...sampleTransport.checks.longLivedTransport, idleDurationMs: 3000 },
      },
    });
  }, /idleDurationMs must be >= 31000ms/);

  // Negative: validateTransportArtifactSemantics rejects mismatched nodeId or authority
  assert.throws(() => {
    validateTransportArtifactSemantics(sampleTransport, {
      expectedRole: "nas",
      expectedNodeId: "node_mismatched_0000000000000000",
    });
  }, /must match expected/);

  // Negative: validateTransportArtifactSemantics rejects mismatched DSH commit SHA
  assert.throws(() => {
    validateTransportArtifactSemantics(sampleTransport, {
      expectedRole: "nas",
      expectedDshCommitSha: "0".repeat(40),
    });
  }, /must match expected/);

  // Positive: validateSessionResumeArtifactSemantics accepts valid session resume doc
  const sampleResume = {
    nodeA: {
      authority: "n-nodeA.stage6.localhost:51558",
      sessionResume: "PASS",
      modelReselected: true,
    },
    nodeB: {
      authority: "n-nodeB.stage6.localhost:51558",
      sessionResume: "PASS",
      modelReselected: true,
    },
    result: "PASS",
  };
  assert.equal(
    validateSessionResumeArtifactSemantics(sampleResume, {
      expectedNodeA: { authority: "n-nodeA.stage6.localhost:51558" },
      expectedNodeB: { authority: "n-nodeB.stage6.localhost:51558" },
    }),
    true,
  );

  // Negative: validateSessionResumeArtifactSemantics rejects failed resume
  assert.throws(() => {
    validateSessionResumeArtifactSemantics({
      ...sampleResume,
      nodeA: { ...sampleResume.nodeA, sessionResume: "FAIL" },
    });
  }, /sessionResume must be PASS/);
});

test("Stage 6 Mounted Contract: live manifest verification if manifest is present", () => {
  if (!existsSync(MANIFEST_PATH)) {
    // Before live rehearsal execution, pass gracefully
    return;
  }

  const raw = readFileSync(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw);
  validateStage6Manifest(manifest);

  const evidenceDir = join(process.cwd(), "test", "evidence", "stage6");
  for (const s of manifest.scenarios) {
    if (s.file) {
      const filePath = join(evidenceDir, s.file);
      assert.ok(existsSync(filePath), `Evidence file '${s.file}' must exist on disk`);
      const fileBuf = readFileSync(filePath);
      assert.equal(fileBuf.length, s.bytes, `File size mismatch for ${s.file}`);
      const computedHash = crypto.createHash("sha256").update(fileBuf).digest("hex");
      assert.equal(computedHash, s.sha256, `SHA256 hash mismatch for ${s.file}`);
    }
  }

  if (manifest.artifacts) {
    for (const [artKey, art] of Object.entries(manifest.artifacts)) {
      if (art && art.file) {
        const filePath = join(evidenceDir, art.file);
        assert.ok(existsSync(filePath), `Artifact file '${art.file}' must exist on disk`);
        const fileBuf = readFileSync(filePath);
        assert.equal(fileBuf.length, art.bytes, `File size mismatch for artifact ${artKey}`);
        const computedHash = crypto.createHash("sha256").update(fileBuf).digest("hex");
        assert.equal(computedHash, art.sha256, `SHA256 hash mismatch for artifact ${artKey}`);

        if (manifest.scope === "physical-two-host-mounted-e2e") {
          const doc = JSON.parse(fileBuf.toString("utf8"));
          if (artKey === "nodeATransport") {
            validateTransportArtifactSemantics(doc, {
              expectedRole: "nas",
              expectedNodeId: manifest.nodeA?.nodeId,
              expectedAuthority: manifest.nodeA?.authority,
              expectedDshCommitSha: manifest.candidate?.dshCommitSha,
              expectedCliBinarySha256: manifest.candidate?.dshCliBinarySha256,
            });
          } else if (artKey === "nodeBTransport") {
            validateTransportArtifactSemantics(doc, {
              expectedRole: "workstation",
              expectedNodeId: manifest.nodeB?.nodeId,
              expectedAuthority: manifest.nodeB?.authority,
              expectedDshCommitSha: manifest.candidate?.dshCommitSha,
              expectedCliBinarySha256: manifest.candidate?.dshCliBinarySha256,
            });
          } else if (artKey === "sessionResume") {
            validateSessionResumeArtifactSemantics(doc, {
              expectedNodeA: manifest.nodeA,
              expectedNodeB: manifest.nodeB,
            });
          } else if (artKey === "restartIdentity") {
            validateRestartArtifactSemantics(doc);
          }
        }
      }
    }
  }

  if (manifest.scope === "physical-two-host-mounted-e2e") {
    const cookieScenario = manifest.scenarios.find((s) => s.id === "cookie-browser-jar-isolation");
    if (cookieScenario && cookieScenario.file) {
      const cookieDoc = JSON.parse(readFileSync(join(evidenceDir, cookieScenario.file), "utf8"));
      validateCookieJarArtifactSemantics(cookieDoc);
    }
  }
});
