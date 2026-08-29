export const REPORT_SCHEMA_VERSION = 1;

export const CHECK_STATUSES = new Set(["pass", "fail", "not_run"]);

export const REQUIRED_CHECKS = Object.freeze([
  "globalPatch",
  "profilePatch",
  "runtimeReadiness",
  "settingsRead",
  "settingsNoopWrite",
  "authorizationSmoke",
  "sessionResume",
]);

export const OPTIONAL_CHECKS = Object.freeze(["terminalPtty"]);

export const KNOWN_CHECKS = new Set([...REQUIRED_CHECKS, ...OPTIONAL_CHECKS]);

export const DECISION_OUTCOMES = Object.freeze({
  eligible: "eligible-for-manual-promotion",
  notEligible: "not-eligible-for-promotion",
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

function optionalString(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error(`compatibility report: expected a string or null, got ${JSON.stringify(value)}`);
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

export function decide(checks) {
  const reasons = [];
  for (const [name, entry] of Object.entries(checks)) {
    if (entry.status === "fail") reasons.push(`${name}=fail`);
    else if (entry.status === "not_run" && entry.required) reasons.push(`${name}=not_run`);
  }
  if (reasons.length === 0) {
    return { outcome: DECISION_OUTCOMES.eligible, reasons: [] };
  }
  return { outcome: DECISION_OUTCOMES.notEligible, reasons };
}

export function createCompatibilityReport(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("compatibility report: evidence input must be an object");
  }
  const redactions = input.redactions ?? [];
  if (!Array.isArray(redactions) || redactions.some((value) => typeof value !== "string")) {
    throw new Error("compatibility report: redactions must be an array of strings");
  }

  const orbit = {
    version: requiredString(input.orbit?.version, "orbit.version"),
    revision: optionalString(input.orbit?.revision),
  };
  const candidate = {
    dshVersion: requiredString(input.candidate?.dshVersion, "candidate.dshVersion"),
    profile: optionalString(input.candidate?.profile),
  };
  const checks = normalizeChecks(input.checks, redactions);
  const snapshot = { reference: optionalString(input.snapshot?.reference) };
  const decision = decide(checks);

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    orbit,
    candidate,
    checks,
    snapshot,
    decision,
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
  const profile = report.candidate.profile ? ` profile ${report.candidate.profile}` : " profile unavailable";
  lines.push(`orbit: ${report.orbit.version}${revision}`);
  lines.push(`candidate dsh: ${report.candidate.dshVersion}${profile}`);
  lines.push("checks:");
  for (const [name, entry] of Object.entries(report.checks)) {
    const detail = entry.detail ? ` ${entry.detail}` : "";
    lines.push(`  [${entry.status}]${entry.required ? "" : " (optional)"} ${name}${detail}`);
  }
  lines.push(`snapshot: ${report.snapshot.reference ?? "none"}`);
  if (report.decision.outcome === DECISION_OUTCOMES.eligible) {
    lines.push("decision: ELIGIBLE FOR MANUAL PROMOTION");
  } else {
    lines.push(`decision: NOT ELIGIBLE FOR PROMOTION (${report.decision.reasons.join(", ")})`);
  }
  return lines.join("\n");
}
