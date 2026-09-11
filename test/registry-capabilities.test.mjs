import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_EVIDENCE,
  deriveCapabilities,
  deriveDshHealthy,
  deriveOrbitCompatible,
  identityMatches,
  reportIdentity,
} from "../src/registry/capabilities.mjs";
import { createCompatibilityReport } from "../src/compatibility-report.mjs";
import { validReport } from "./helpers/registry-fixture.mjs";

function reportWith(checkResults) {
  return createCompatibilityReport(validReport({ ...(checkResults ?? {}) }));
}

function reportWithChecks(overrides) {
  const input = validReport();
  for (const [name, status] of Object.entries(overrides)) {
    input.checks[name].status = status;
  }
  return createCompatibilityReport(input);
}

test("capability derivation maps only all-pass evidence (RFC-0009 table)", () => {
  const capabilities = deriveCapabilities(reportWith());
  assert.deepEqual(capabilities, [
    { name: "sessions.resume", version: 1 },
    { name: "settings.remote", version: 1 },
    { name: "web.routes", version: 1 },
  ]);
});

test("a failing evidence check withholds exactly that capability", () => {
  const report = reportWithChecks({ settingsRead: "fail" });
  const capabilities = deriveCapabilities(report);
  assert.deepEqual(capabilities, [
    { name: "sessions.resume", version: 1 },
    { name: "web.routes", version: 1 },
  ]);
});

test("not_run evidence never claims a capability", () => {
  const report = reportWithChecks({ sessionResume: "not_run" });
  const names = deriveCapabilities(report).map((entry) => entry.name);
  assert.equal(names.includes("sessions.resume"), false);
});

test("web.routes requires webSocketTransport: missing, not_run, or fail withholds web.routes", () => {
  // not_run withholds web.routes
  const reportNotRun = reportWithChecks({ webSocketTransport: "not_run" });
  assert.equal(deriveCapabilities(reportNotRun).some((c) => c.name === "web.routes"), false);

  // fail withholds web.routes
  const reportFail = reportWithChecks({ webSocketTransport: "fail" });
  assert.equal(deriveCapabilities(reportFail).some((c) => c.name === "web.routes"), false);

  // pass grants web.routes
  const reportPass = reportWithChecks({ webSocketTransport: "pass" });
  assert.equal(deriveCapabilities(reportPass).some((c) => c.name === "web.routes"), true);
});

test("terminal.pty and agents.run are never claimable in v0.3", () => {
  const report = reportWith();
  const names = deriveCapabilities(report).map((entry) => entry.name);
  assert.equal(names.includes("terminal.pty"), false);
  assert.equal(names.includes("agents.run"), false);
});

test("dshHealthy is deterministic: both gates pass -> ok; either fails -> degraded; otherwise unknown", () => {
  assert.equal(deriveDshHealthy(reportWith()), "ok");
  assert.equal(deriveDshHealthy(reportWithChecks({ settingsRead: "fail" })), "degraded");
  assert.equal(deriveDshHealthy(reportWithChecks({ runtimeReadiness: "fail" })), "degraded");
  assert.equal(deriveDshHealthy(reportWithChecks({ runtimeReadiness: "not_run" })), "unknown");
});

test("orbitCompatible mirrors the report compatibility outcome", () => {
  assert.equal(deriveOrbitCompatible(reportWith()), "pass");
  assert.equal(deriveOrbitCompatible(reportWithChecks({ globalPatch: "fail" })), "fail");
});

test("runtime identity maps 1:1 to the v0.2 report fields (RFC-0009)", () => {
  const report = reportWith();
  assert.deepEqual(reportIdentity(report), {
    orbitVersion: "0.3.0",
    orbitRevision: "abc123",
    dshVersion: "0.1.1-rc.2",
    compatibilityProfile: "dsh-0.1.1-rc.2",
  });
  assert.equal(identityMatches(reportIdentity(report), { orbitVersion: "0.3.0", orbitRevision: "abc123", dshVersion: "0.1.1-rc.2", compatibilityProfile: "dsh-0.1.1-rc.2" }), true);
  assert.equal(identityMatches(reportIdentity(report), { orbitVersion: "0.3.1", orbitRevision: "abc123", dshVersion: "0.1.1-rc.2", compatibilityProfile: "dsh-0.1.1-rc.2" }), false);
  assert.equal(identityMatches(reportIdentity(report), { orbitVersion: "0.3.0", orbitRevision: "abc123", dshVersion: "0.1.2", compatibilityProfile: "dsh-0.1.1-rc.2" }), false);
});

test("CAPABILITY_EVIDENCE covers exactly the RFC-0009 table", () => {
  assert.deepEqual(Object.keys(CAPABILITY_EVIDENCE).sort(), ["sessions.resume", "settings.remote", "web.routes"]);
});