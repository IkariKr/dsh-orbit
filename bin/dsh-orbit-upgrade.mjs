#!/usr/bin/env node

import process from "node:process";
import {
  PROMOTION_OUTCOMES,
  createCompatibilityReport,
  renderReportText,
} from "../src/compatibility-report.mjs";
import {
  loadEvidence,
  loadUpgradeConfig,
  preflight,
  runCandidateWorkflow,
  runVerifyWorkflow,
} from "../src/upgrade-runner.mjs";

const USAGE = `usage: node bin/dsh-orbit-upgrade.mjs <command>

commands:
  preflight  validate the upgrade configuration without touching anything
  candidate  full workflow: production snapshot, candidate build against the verified compose
             binding, isolated start, verification, report, promotion readiness
  verify     run preflight, the compose binding check, and the verification sequence against an
             already-running candidate; promotion readiness is NOT evaluated
  report     regenerate the report from the workdir evidence (all gates are preserved)

configuration is read from the environment (DSH_VERSION, DSH_PUBLIC_HOST,
DSH_CANDIDATE_ORBIT_REVISION, DSH_BASELINE_IMAGE, DSH_BASELINE_ORBIT_REVISION,
DSH_BASELINE_DSH_VERSION, DSH_CANDIDATE_IMAGE, DSH_CANDIDATE_DATA_ROOT,
DSH_CANDIDATE_WORKSPACE_ROOT, DSH_UPGRADE_HOST_PORT, DSH_DATA_ROOT, DSH_SMOKE_URL,
DSH_SMOKE_BASIC_USER, DSH_SMOKE_BASIC_PASSWORD, DSH_SMOKE_SESSION_ID, DSH_SNAPSHOT_HOOK;
optional: DSH_ORBIT_VERSION, DSH_SMOKE_ORIGIN, DSH_UPGRADE_PROJECT, DSH_UPGRADE_COMPOSE,
DSH_UPGRADE_WORKDIR, DSH_UPGRADE_GATEWAY_SERVICE, DSH_UPGRADE_GATEWAY_CERT_TARGET,
DSH_UPGRADE_GATEWAY_KEY_TARGET, DSH_SNAPSHOT_TIMEOUT_SECONDS, DSH_ORBIT_PATCH_DSH_SSH
(the dsh-ssh terminal fence enable flag; 1 enables the patched fence and the automated
terminalFence smoke), DSH_SSH_PLUGIN_ROOT, DSH_SSH_PLUGIN_VERSION)

the gateway identity certificate defaults to the public example paths
(DSH_UPGRADE_GATEWAY_SERVICE=caddy, cert target /run/certs/fullchain.pem, key target
/run/certs/privkey.pem); deployments whose gateway reads certificates elsewhere must set
the corresponding targets, and the base compose gateway must already mount a certificate
at those targets.

exit codes: 0 candidate passed (eligible for manual promotion) or verification/report with
passing compatibility, 1 candidate/verification/report failed, 2 configuration or binding error`;

function bannerFor(report) {
  if (report.promotionReadiness.outcome === PROMOTION_OUTCOMES.eligible) {
    return "CANDIDATE PASSED - ELIGIBLE FOR MANUAL PROMOTION";
  }
  if (report.promotionReadiness.outcome === PROMOTION_OUTCOMES.notEvaluated) {
    return report.compatibility.outcome === COMPATIBILITY_OUTCOMES.pass
      ? "VERIFICATION PASSED - PROMOTION READINESS NOT EVALUATED"
      : "VERIFICATION FAILED - PROMOTION READINESS NOT EVALUATED";
  }
  return "CANDIDATE FAILED - NOT ELIGIBLE FOR PROMOTION";
}

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

  try {
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
      const result = await runVerifyWorkflow({ config });
      console.log(result.text);
      console.log(result.banner);
      process.exitCode = result.exitCode;
      return;
    }

    const evidence = await loadEvidence(config.workdir);
    const report = createCompatibilityReport(evidence);
    console.log(renderReportText(report));
    console.log(bannerFor(report));
    process.exitCode = report.compatibility.outcome === COMPATIBILITY_OUTCOMES.pass ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

main();
