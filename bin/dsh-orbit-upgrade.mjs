#!/usr/bin/env node

import process from "node:process";
import {
  DECISION_OUTCOMES,
  createCompatibilityReport,
  renderReportText,
} from "../src/compatibility-report.mjs";
import {
  loadEvidence,
  loadUpgradeConfig,
  preflight,
  runCandidateWorkflow,
  runVerificationSequence,
} from "../src/upgrade-runner.mjs";

const USAGE = `usage: node bin/dsh-orbit-upgrade.mjs <command>

commands:
  preflight  validate the upgrade configuration without touching anything
  candidate  full workflow: production snapshot, candidate build, isolated start, verification, report
  verify     run the verification sequence and report against an already-running candidate
  report     regenerate the report from the workdir evidence

configuration is read from the environment (DSH_VERSION, DSH_PUBLIC_HOST, DSH_SMOKE_URL,
DSH_SMOKE_BASIC_USER, DSH_SMOKE_BASIC_PASSWORD, DSH_SMOKE_SESSION_ID, DSH_DATA_ROOT,
DSH_CANDIDATE_DATA_ROOT, DSH_BASELINE_IMAGE, DSH_ORBIT_REVISION, DSH_SNAPSHOT_HOOK;
optional: DSH_CANDIDATE_IMAGE, DSH_UPGRADE_PROJECT, DSH_UPGRADE_COMPOSE,
DSH_UPGRADE_WORKDIR, DSH_SNAPSHOT_TIMEOUT_SECONDS)

exit codes: 0 candidate passed (eligible for manual promotion), 1 candidate failed,
2 configuration or usage error`;

async function main() {
  const command = process.argv[2];
  if (!command || !["preflight", "candidate", "verify", "report"].includes(command)) {
    console.error(USAGE);
    process.exit(2);
  }

  const { config, missing } = loadUpgradeConfig(process.env);
  if (missing.length > 0) {
    console.error(`upgrade configuration is missing: ${missing.join(", ")}`);
    process.exit(2);
  }

  if (command === "preflight") {
    const result = await preflight(config);
    if (result.ok) {
      console.log("preflight: ok (candidate workflow configuration is valid)");
      return;
    }
    for (const failure of result.failures) {
      console.error(`preflight: ${failure.check}: ${failure.detail}`);
    }
    process.exitCode = 1;
    return;
  }

  if (command === "candidate") {
    const gate = await preflight(config);
    if (!gate.ok) {
      for (const failure of gate.failures) {
        console.error(`preflight: ${failure.check}: ${failure.detail}`);
      }
      console.error("candidate: preflight failed, nothing was built or started");
      process.exitCode = 1;
      return;
    }
    const result = await runCandidateWorkflow({ config });
    console.log(result.text);
    console.log(result.banner);
    process.exitCode = result.exitCode;
    return;
  }

  if (command === "verify") {
    const { checks } = await runVerificationSequence({ config });
    const report = createCompatibilityReport({
      orbit: { version: config.orbitVersion, revision: config.orbitRevision },
      candidate: { dshVersion: config.dshVersion, profile: config.dshVersion },
      checks,
      snapshot: { reference: null },
    });
    console.log(renderReportText(report));
    console.log(
      report.decision.outcome === DECISION_OUTCOMES.eligible
        ? "CANDIDATE PASSED - ELIGIBLE FOR MANUAL PROMOTION"
        : "CANDIDATE FAILED - NOT ELIGIBLE FOR PROMOTION",
    );
    process.exitCode = report.decision.outcome === DECISION_OUTCOMES.eligible ? 0 : 1;
    return;
  }

  const evidence = await loadEvidence(config.workdir);
  const report = createCompatibilityReport(evidence);
  console.log(renderReportText(report));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
