import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

const MANIFEST_PATH = join(process.cwd(), "test", "evidence", "stage6", "manifest.json");

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

  const allowedResults = new Set(["PASS", "FAIL", "NOT_EXECUTED", "BLOCKED"]);
  for (const s of manifest.scenarios) {
    assert.ok(s.id, "scenario id required");
    assert.ok(s.name, "scenario name required");
    assert.ok(s.expected, "scenario expected required");
    assert.ok(s.actual, "scenario actual required");
    assert.ok(allowedResults.has(s.result), `Scenario ${s.id} result must be PASS, FAIL, NOT_EXECUTED, or BLOCKED`);
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
  if (manifest.scope === "physical-two-host-mounted-e2e") {
    assert.equal(cookieBrowser.result, "PASS", "physical/browser Cookie Jar drill must pass in physical two-host manifest");
  } else {
    assert.equal(cookieBrowser.result, "NOT_EXECUTED", "physical/browser Cookie Jar drill must remain NOT_EXECUTED in the local rehearsal manifest");
  }

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
    scenarios: sample.scenarios.map((scenario) =>
      scenario.id === "cookie-browser-jar-isolation" ? { ...scenario, result: "PASS" } : scenario,
    ),
  };
  assert.equal(validateStage6Manifest(physicalSample), true);

  // Negative: physical two-host manifest cannot claim Review Gate B PASS prematurely
  assert.throws(() => {
    validateStage6Manifest({ ...physicalSample, reviewGate: "PASS" });
  });
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
});
