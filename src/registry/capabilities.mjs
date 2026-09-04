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
  if (!report?.checks) return capabilities;
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
  if (!report?.checks) return "unknown";
  const runtime = report.checks.runtimeReadiness?.status;
  const settings = report.checks.settingsRead?.status;
  if (runtime === "pass" && settings === "pass") return "ok";
  if (runtime === "fail" || settings === "fail") return "degraded";
  return "unknown";
}

export function deriveOrbitCompatible(report) {
  if (!report?.compatibility) return "unknown";
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

// Stage 4 Capability Reconciliation:
// Re-evaluates materialized node capabilities against the latest uploaded
// compatibility report using current contract evidence rules (e.g. web.routes
// requiring webSocketTransport). Reconciles stale, missing, or pre-v0.4 capabilities.
export function reconcileNodeCapabilities(
  db,
  { now = () => new Date(), recordAudit = null, recordTransition = null } = {},
) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('nodes', 'reports')")
    .all()
    .map((r) => r.name);
  if (!tables.includes("nodes") || !tables.includes("reports")) {
    return;
  }

  const nodes = db.prepare("SELECT * FROM nodes WHERE state = 'active'").all();
  const getLatestReportStmt = db.prepare(
    "SELECT * FROM reports WHERE node_id = ? ORDER BY uploaded_at DESC, id DESC LIMIT 1",
  );
  const updateNodeStmt = db.prepare(
    "UPDATE nodes SET capabilities = ?, capabilities_stale = ?, orbit_compatible = ?, dsh_healthy = ? WHERE node_id = ?",
  );

  const nowMs = now().getTime();

  const persistReconciledState = (
    node,
    { capabilities, capabilitiesStale, orbitCompatible, dshHealthy, auditDetail },
  ) => {
    if (recordTransition && node.orbit_compatible !== orbitCompatible) {
      recordTransition(
        node.node_id,
        "orbit_compatible",
        node.orbit_compatible,
        orbitCompatible,
        "capability-reconciliation",
      );
    }
    if (recordTransition && node.dsh_healthy !== dshHealthy) {
      recordTransition(
        node.node_id,
        "dsh_healthy",
        node.dsh_healthy,
        dshHealthy,
        "capability-reconciliation",
      );
    }
    updateNodeStmt.run(
      JSON.stringify(capabilities),
      capabilitiesStale,
      orbitCompatible,
      dshHealthy,
      node.node_id,
    );
    if (recordAudit) {
      recordAudit(node.node_id, auditDetail);
    }
  };

  for (const node of nodes) {
    const latest = getLatestReportStmt.get(node.node_id);
    if (!latest) {
      if (
        node.capabilities !== "[]" ||
        node.capabilities_stale !== 1 ||
        node.orbit_compatible !== "unknown" ||
        node.dsh_healthy !== "unknown"
      ) {
        persistReconciledState(node, {
          capabilities: [],
          capabilitiesStale: 1,
          orbitCompatible: "unknown",
          dshHealthy: "unknown",
          auditDetail: { previous: node.capabilities, next: [], reason: "no-report" },
        });
      }
      continue;
    }

    let report;
    try {
      report = JSON.parse(latest.report_json);
    } catch {
      if (
        node.capabilities !== "[]" ||
        node.capabilities_stale !== 1 ||
        node.orbit_compatible !== "unknown" ||
        node.dsh_healthy !== "unknown"
      ) {
        persistReconciledState(node, {
          capabilities: [],
          capabilitiesStale: 1,
          orbitCompatible: "unknown",
          dshHealthy: "unknown",
          auditDetail: { previous: node.capabilities, next: [], reason: "invalid-report" },
        });
      }
      continue;
    }

    let reportIdent;
    try {
      reportIdent = JSON.parse(latest.identity_json);
    } catch {
      reportIdent = null;
    }

    const runtimeIdentity = {
      orbitVersion: node.orbit_version,
      orbitRevision: node.orbit_revision,
      dshVersion: node.dsh_version,
      compatibilityProfile: node.compatibility_profile,
    };

    const runtimeUnset = node.orbit_version === "" && node.dsh_version === "";
    const matches = runtimeUnset || (reportIdent && identityMatches(reportIdent, runtimeIdentity));

    const uploadedMs = Date.parse(latest.uploaded_at);
    const ageFresh = !Number.isNaN(uploadedMs) && nowMs - uploadedMs <= 7 * 24 * 60 * 60 * 1000;
    const isFresh = matches && ageFresh;

    // Re-derive capabilities under current Stage 4 evidence rules
    const rederived = deriveCapabilities(report);
    const rederivedJson = JSON.stringify(rederived);

    const nextStale = isFresh ? 0 : 1;
    const nextCompatible = isFresh ? deriveOrbitCompatible(report) : "stale";
    const nextDshHealthy = isFresh ? deriveDshHealthy(report) : "unknown";

    if (
      node.capabilities !== rederivedJson ||
      node.capabilities_stale !== nextStale ||
      node.orbit_compatible !== nextCompatible ||
      node.dsh_healthy !== nextDshHealthy
    ) {
      persistReconciledState(node, {
        capabilities: rederived,
        capabilitiesStale: nextStale,
        orbitCompatible: nextCompatible,
        dshHealthy: nextDshHealthy,
        auditDetail: {
          previous: node.capabilities,
          next: rederived,
          stale: nextStale,
        },
      });
    }
  }
}