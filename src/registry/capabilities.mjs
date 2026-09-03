// Capability contract v1 and health mappings (RFC-0009, rev. 3):
// capabilities and dshHealthy are derived deterministically at the Hub
// from the latest uploaded compatibility report — never node-declared.

import { COMPATIBILITY_OUTCOMES } from "../compatibility-report.mjs";

export const CAPABILITY_CONTRACT_VERSION = 1;

// name -> every report check that must be `pass` for the capability.
export const CAPABILITY_EVIDENCE = Object.freeze({
  "sessions.resume": ["sessionResume"],
  "settings.remote": ["settingsRead", "settingsNoopWrite", "authorizationSmoke"],
  "web.routes": ["runtimeReadiness", "webPluginRoutes", "webSocketTransport"],
});

// terminal.pty and agents.run are NOT claimable in v0.3 (RFC-0009):
// no automated PTY/streaming runtime evidence exists.
export const NON_CLAIMABLE_CAPABILITIES = Object.freeze(["terminal.pty", "agents.run"]);

export function deriveCapabilities(report) {
  const capabilities = [];
  for (const [name, checks] of Object.entries(CAPABILITY_EVIDENCE)) {
    if (checks.every((check) => report.checks[check]?.status === "pass")) {
      capabilities.push({ name, version: CAPABILITY_CONTRACT_VERSION });
    }
  }
  return capabilities;
}

// dshHealthy is deterministic and uses exactly two checks: runtime
// readiness and settings reachability (RFC-0009 "Deterministic
// dshHealthy mapping").
export function deriveDshHealthy(report) {
  const runtime = report.checks.runtimeReadiness?.status;
  const settings = report.checks.settingsRead?.status;
  if (runtime === "pass" && settings === "pass") return "ok";
  if (runtime === "fail" || settings === "fail") return "degraded";
  return "unknown";
}

export function deriveOrbitCompatible(report) {
  return report.compatibility.outcome === COMPATIBILITY_OUTCOMES.pass ? "pass" : "fail";
}

// The runtime-identity tuple that must match between a heartbeat and
// the latest report for the report to be fresh (RFC-0009, 1:1 mapping).
export function reportIdentity(report) {
  return {
    orbitVersion: report.orbit.version,
    orbitRevision: report.orbit.revision ?? null,
    dshVersion: report.candidate.dshVersion,
    compatibilityProfile: report.candidate.profile ?? null,
  };
}

export function identityMatches(reportIdentity, runtimeIdentity) {
  return (
    reportIdentity.orbitVersion === runtimeIdentity.orbitVersion &&
    reportIdentity.orbitRevision === runtimeIdentity.orbitRevision &&
    reportIdentity.dshVersion === runtimeIdentity.dshVersion &&
    reportIdentity.compatibilityProfile === runtimeIdentity.compatibilityProfile
  );
}