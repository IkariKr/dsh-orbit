export const REPORT_SCHEMA_VERSION = 2;

export const CHECK_STATUSES = new Set(["pass", "fail", "not_run"]);

export const REQUIRED_CHECKS = Object.freeze([
  "globalPatch",
  "profilePatch",
  "runtimeReadiness",
  "settingsRead",
  "settingsNoopWrite",
  "authorizationSmoke",
  "sessionResume",
  "webPluginRoutes",
]);

export const OPTIONAL_CHECKS = Object.freeze([
  "longLivedTransport",
  "webSocketTransport",
  "terminalFence",
  "terminalPtty",
]);

export const KNOWN_CHECKS = new Set([...REQUIRED_CHECKS, ...OPTIONAL_CHECKS]);

export const COMPATIBILITY_OUTCOMES = Object.freeze({ pass: "pass", fail: "fail" });

export const PROMOTION_OUTCOMES = Object.freeze({
  eligible: "eligible-for-manual-promotion",
  notEligible: "not-eligible-for-promotion",
  notEvaluated: "promotion-readiness-not-evaluated",
});

export function sanitizeDetail(value, redactions) {
  let text = String(value);
  for (const secret of redactions ?? []) {
    if (secret) text = text.replaceAll(secret, "[redacted]");
  }
  return text;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`compatibility report: ${label} is required`);
  }
  return value;
}

function optionalString(value, label = "value") {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error(`compatibility report: ${label} must be a string or null`);
  }
  return value;
}

function normalizeChecks(inputChecks, redactions) {
  for (const name of Object.keys(inputChecks ?? {})) {
    if (!KNOWN_CHECKS.has(name)) {
      throw new Error(`compatibility report: unknown check ${JSON.stringify(name)}`);
    }
  }
  const checks = {};
  for (const name of KNOWN_CHECKS) {
    const entry = inputChecks?.[name];
    const required = REQUIRED_CHECKS.includes(name);
    if (entry === undefined || entry === null) {
      checks[name] = { status: "not_run", required, detail: "" };
      continue;
    }
    if (typeof entry !== "object" || !CHECK_STATUSES.has(entry.status)) {
      throw new Error(
        `compatibility report: check ${name} has invalid status ${JSON.stringify(entry?.status)}` +
          ` (expected one of ${[...CHECK_STATUSES].join(", ")})`,
      );
    }
    checks[name] = {
      status: entry.status,
      required,
      detail: entry.detail === undefined ? "" : sanitizeDetail(entry.detail, redactions),
    };
  }
  return checks;
}

export function deriveCompatibility(checks) {
  const reasons = [];
  for (const [name, entry] of Object.entries(checks)) {
    if (entry.status === "fail") reasons.push(`${name}=fail`);
    else if (entry.status === "not_run" && entry.required) reasons.push(`${name}=not_run`);
  }
  return reasons.length === 0
    ? { outcome: COMPATIBILITY_OUTCOMES.pass, reasons: [] }
    : { outcome: COMPATIBILITY_OUTCOMES.fail, reasons };
}

export function derivePromotionReadiness({ compatibility, orbit, candidate, baseline, snapshot, promotionEvaluated }) {
  if (!promotionEvaluated) {
    return { outcome: PROMOTION_OUTCOMES.notEvaluated, reasons: [] };
  }
  const reasons = [...compatibility.reasons];
  if (!orbit.revision) reasons.push("orbit.revision missing");
  if (!candidate.profile) reasons.push("candidate.profile missing");
  if (!baseline.image) reasons.push("baseline.image missing");
  if (!baseline.orbitRevision) reasons.push("baseline.orbitRevision missing");
  if (!baseline.dshVersion) reasons.push("baseline.dshVersion missing");
  if (snapshot.failure) reasons.push(`snapshot=${snapshot.failure}`);
  else if (!snapshot.reference) reasons.push("snapshot reference missing");
  return reasons.length === 0
    ? { outcome: PROMOTION_OUTCOMES.eligible, reasons: [] }
    : { outcome: PROMOTION_OUTCOMES.notEligible, reasons };
}

export function createCompatibilityReport(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("compatibility report: evidence input must be an object");
  }
  const redactions = input.redactions ?? [];
  if (!Array.isArray(redactions) || redactions.some((value) => typeof value !== "string")) {
    throw new Error("compatibility report: redactions must be an array of strings");
  }
  if (typeof input.promotionEvaluated !== "undefined" && typeof input.promotionEvaluated !== "boolean") {
    throw new Error("compatibility report: promotionEvaluated must be a boolean");
  }
  const promotionEvaluated = input.promotionEvaluated !== false;
  if (input.baseline !== undefined && (typeof input.baseline !== "object" || input.baseline === null)) {
    throw new Error("compatibility report: baseline must be an object when provided");
  }

  const orbit = {
    version: requiredString(input.orbit?.version, "orbit.version"),
    revision: optionalString(input.orbit?.revision, "orbit.revision"),
  };
  const baseline = {
    image: optionalString(input.baseline?.image, "baseline.image"),
    orbitRevision: optionalString(input.baseline?.orbitRevision, "baseline.orbitRevision"),
    dshVersion: optionalString(input.baseline?.dshVersion, "baseline.dshVersion"),
  };
  const candidate = {
    dshVersion: requiredString(input.candidate?.dshVersion, "candidate.dshVersion"),
    profile: optionalString(input.candidate?.profile, "candidate.profile"),
  };
  const checks = normalizeChecks(input.checks, redactions);
  const snapshot = {
    reference: optionalString(input.snapshot?.reference, "snapshot.reference"),
    failure: optionalString(input.snapshot?.failure, "snapshot.failure"),
  };

  const compatibility = deriveCompatibility(checks);
  const promotionReadiness = derivePromotionReadiness({
    compatibility,
    orbit,
    candidate,
    baseline,
    snapshot,
    promotionEvaluated,
  });

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    orbit,
    baseline,
    candidate,
    checks,
    snapshot,
    compatibility,
    promotionReadiness,
  };
}

export function renderReportJson(report) {
  return JSON.stringify(report, null, 2);
}

export function renderReportText(report) {
  const lines = [];
  lines.push(`DSH Orbit compatibility report (schema v${report.schemaVersion})`);
  lines.push(`generated: ${report.generatedAt}`);
  const revision = report.orbit.revision ? ` revision ${report.orbit.revision}` : " revision unavailable";
  lines.push(`orbit: ${report.orbit.version}${revision}`);
  lines.push(
    `baseline: ${report.baseline.image ?? "unavailable"}` +
      ` revision ${report.baseline.orbitRevision ?? "unavailable"}` +
      ` (dsh ${report.baseline.dshVersion ?? "unavailable"})`,
  );
  const profile = report.candidate.profile ? ` profile ${report.candidate.profile}` : " profile unavailable";
  lines.push(`candidate dsh: ${report.candidate.dshVersion}${profile}`);
  lines.push("checks:");
  for (const [name, entry] of Object.entries(report.checks)) {
    const detail = entry.detail ? ` ${entry.detail}` : "";
    lines.push(`  [${entry.status}]${entry.required ? "" : " (optional)"} ${name}${detail}`);
  }
  const snapshotFailure = report.snapshot.failure ? ` (failure: ${report.snapshot.failure})` : "";
  lines.push(`snapshot: ${report.snapshot.reference ?? "none"}${snapshotFailure}`);
  if (report.compatibility.outcome === COMPATIBILITY_OUTCOMES.pass) {
    lines.push("compatibility: PASS");
  } else {
    lines.push(`compatibility: FAIL (${report.compatibility.reasons.join(", ")})`);
  }
  if (report.promotionReadiness.outcome === PROMOTION_OUTCOMES.eligible) {
    lines.push("promotion readiness: ELIGIBLE FOR MANUAL PROMOTION");
  } else if (report.promotionReadiness.outcome === PROMOTION_OUTCOMES.notEvaluated) {
    lines.push("promotion readiness: NOT EVALUATED");
  } else {
    lines.push(`promotion readiness: NOT ELIGIBLE (${report.promotionReadiness.reasons.join(", ")})`);
  }
  return lines.join("\n");
}
