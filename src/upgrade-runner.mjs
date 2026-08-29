import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { compatibilityFor } from "./compatibility.mjs";
import { validateHost } from "./remote-settings-patch.mjs";
import { runSnapshotHook } from "./snapshot-contract.mjs";
import {
  DECISION_OUTCOMES,
  createCompatibilityReport,
  renderReportJson,
  renderReportText,
} from "./compatibility-report.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const SMOKE_SETTINGS = fileURLToPath(new URL("../scripts/smoke-settings.mjs", import.meta.url));
const SMOKE_AUTH = fileURLToPath(new URL("../scripts/smoke-auth.mjs", import.meta.url));
const SMOKE_SESSION = fileURLToPath(new URL("../scripts/smoke-session-resume.mjs", import.meta.url));
const PATCHER = "/usr/local/lib/dsh-orbit/bin/dsh-orbit-patch.mjs";

export const UPGRADE_CHECK_ORDER = Object.freeze([
  "runtimeReadiness",
  "globalPatch",
  "profilePatch",
  "settingsRead",
  "settingsNoopWrite",
  "authorizationSmoke",
  "sessionResume",
  "webPluginRoutes",
  "longLivedTransport",
  "terminalPtty",
]);

export function loadUpgradeConfig(env) {
  const dshVersion = env.DSH_VERSION;
  const required = {
    "DSH_VERSION (candidate DSH version)": dshVersion,
    "DSH_PUBLIC_HOST (bare public hostname)": env.DSH_PUBLIC_HOST,
    "DSH_SMOKE_URL (candidate endpoint)": env.DSH_SMOKE_URL,
    "DSH_SMOKE_BASIC_USER": env.DSH_SMOKE_BASIC_USER,
    "DSH_SMOKE_BASIC_PASSWORD": env.DSH_SMOKE_BASIC_PASSWORD,
    "DSH_SMOKE_SESSION_ID (historical session)": env.DSH_SMOKE_SESSION_ID,
    "DSH_DATA_ROOT (production data root)": env.DSH_DATA_ROOT,
    "DSH_CANDIDATE_DATA_ROOT (copied candidate data)": env.DSH_CANDIDATE_DATA_ROOT,
    "DSH_BASELINE_IMAGE (last known-good image tag)": env.DSH_BASELINE_IMAGE,
    "DSH_ORBIT_REVISION (baseline identity)": env.DSH_ORBIT_REVISION,
    "DSH_SNAPSHOT_HOOK (snapshot capability)": env.DSH_SNAPSHOT_HOOK,
  };
  const missing = Object.keys(required).filter((name) => !required[name]);

  return {
    missing,
    config: {
      dshVersion,
      publicHost: env.DSH_PUBLIC_HOST,
      candidateEndpoint: env.DSH_SMOKE_URL,
      basicUser: env.DSH_SMOKE_BASIC_USER,
      basicPassword: env.DSH_SMOKE_BASIC_PASSWORD,
      sessionId: env.DSH_SMOKE_SESSION_ID,
      dataRoot: env.DSH_DATA_ROOT,
      candidateDataRoot: env.DSH_CANDIDATE_DATA_ROOT,
      baselineImage: env.DSH_BASELINE_IMAGE,
      orbitRevision: env.DSH_ORBIT_REVISION,
      orbitVersion: env.DSH_ORBIT_VERSION ?? "0.2.0-snapshot",
      snapshotHook: env.DSH_SNAPSHOT_HOOK,
      snapshotTimeoutSeconds: Number(env.DSH_SNAPSHOT_TIMEOUT_SECONDS ?? 900),
      candidateImage: env.DSH_CANDIDATE_IMAGE ?? `dsh-orbit:${dshVersion}`,
      project: env.DSH_UPGRADE_PROJECT ?? "dsh-orbit-candidate",
      composeFile: env.DSH_UPGRADE_COMPOSE ?? `${REPO_ROOT}docker/compose.example.yaml`,
      workdir: env.DSH_UPGRADE_WORKDIR ?? `${REPO_ROOT}.upgrade-run`,
    },
  };
}

export async function preflight(config) {
  const failures = [];
  const check = (name, ok, detail) => {
    if (!ok) failures.push({ check: name, detail });
    return ok;
  };

  check(
    "candidate-image",
    config.candidateImage !== config.baselineImage,
    `candidate image ${config.candidateImage} must differ from the last known-good image ${config.baselineImage}`,
  );
  try {
    validateHost(config.publicHost);
  } catch (error) {
    check("public-host", false, error.message);
  }
  try {
    compatibilityFor(config.dshVersion);
  } catch (error) {
    check("compatibility-profile", false, error.message);
  }
  check(
    "copied-data-root",
    config.candidateDataRoot !== config.dataRoot,
    "the candidate data root must be a copy, not the production data root",
  );
  for (const [label, dir] of [
    ["data-root", config.dataRoot],
    ["candidate-data-root", config.candidateDataRoot],
  ]) {
    try {
      await access(dir);
    } catch {
      check(label, false, `${dir} is not available`);
    }
  }
  check(
    "snapshot-capability",
    Boolean(config.snapshotHook),
    "DSH_SNAPSHOT_HOOK must be configured for production promotion readiness",
  );

  return { ok: failures.length === 0, failures };
}

async function defaultRunCommand(file, args, options = {}) {
  const { spawn } = await import("node:child_process");
  const child = spawn(file, args, {
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.once("close", resolve));
  return { code, stdout, stderr };
}

async function defaultFetchPage(url) {
  const response = await fetch(url, { headers: { connection: "close" } });
  const body = await response.text().catch(() => "");
  return { status: response.status, body };
}

function failDetail(output, fallback) {
  const line = (output ?? "").trim().split("\n").find((entry) => entry.trim() !== "");
  return line ?? fallback;
}

export async function runVerificationSequence({ config, runCommand = defaultRunCommand, fetchPage = defaultFetchPage }) {
  const checks = {};
  let stoppedAfter = null;
  const record = (name, status, detail = "") => {
    checks[name] = { status, detail };
    if (status === "fail") stoppedAfter = name;
    return status !== "fail";
  };

  const smokeEnv = (extra = {}) => ({
    DSH_SMOKE_URL: config.candidateEndpoint,
    DSH_SMOKE_BASIC_USER: config.basicUser,
    DSH_SMOKE_BASIC_PASSWORD: config.basicPassword,
    ...extra,
  });

  const steps = [
    {
      names: ["runtimeReadiness"],
      required: true,
      run: async () => {
        const home = await fetchPage(`${config.candidateEndpoint}/`);
        record(
          "runtimeReadiness",
          home.status === 200 ? "pass" : "fail",
          `GET / -> HTTP ${home.status}`,
        );
      },
    },
    {
      names: ["globalPatch", "profilePatch"],
      required: true,
      run: async () => {
        const patch = await runCommand("docker", [
          "compose",
          "-f",
          config.composeFile,
          "-p",
          config.project,
          "exec",
          "-T",
          "dsh",
          "node",
          PATCHER,
          "--check",
        ]);
        const roots = patch.stdout
          .split("\n")
          .filter((line) => line.startsWith("/"))
          .map((line) => line.trim());
        const globalOk = roots[0]?.includes(": ok") ?? false;
        const profileOk = roots[1]?.includes(": ok") ?? false;
        record("globalPatch", globalOk ? "pass" : "fail", globalOk ? roots[0] : failDetail(patch.stderr, `patch check exit ${patch.code}`));
        record(
          "profilePatch",
          profileOk ? "pass" : "fail",
          profileOk ? roots[1] : "patch check did not report a verified profile root",
        );
      },
    },
    {
      names: ["settingsRead", "settingsNoopWrite"],
      required: true,
      run: async () => {
        const settings = await runCommand(process.execPath, [SMOKE_SETTINGS], {
          env: smokeEnv(),
        });
        const describeOk = settings.stdout.includes("settings.describe: ok");
        const mutateOk = settings.code === 0 && settings.stdout.includes("settings.mutate: ok");
        record("settingsRead", describeOk ? "pass" : "fail", describeOk ? "settings.describe: ok" : failDetail(settings.stderr, `exit ${settings.code}`));
        record("settingsNoopWrite", mutateOk ? "pass" : "fail", mutateOk ? "settings.mutate: ok (no-op)" : "no-op settings.mutate did not succeed");
      },
    },
    {
      names: ["authorizationSmoke"],
      required: true,
      run: async () => {
        const auth = await runCommand(process.execPath, [SMOKE_AUTH], { env: smokeEnv() });
        record("authorizationSmoke", auth.code === 0 ? "pass" : "fail", auth.code === 0 ? "6/6 authorization cases matched" : failDetail(auth.stderr, `exit ${auth.code}`));
      },
    },
    {
      names: ["sessionResume"],
      required: true,
      run: async () => {
        const session = await runCommand(process.execPath, [SMOKE_SESSION], {
          env: smokeEnv({ DSH_SMOKE_SESSION_ID: config.sessionId }),
        });
        record("sessionResume", session.code === 0 ? "pass" : "fail", session.code === 0 ? "existing session resumed, current model re-selected" : failDetail(session.stderr, `exit ${session.code}`));
      },
    },
    {
      names: ["webPluginRoutes"],
      required: true,
      run: async () => {
        const home = await fetchPage(`${config.candidateEndpoint}/`);
        const pluginMatch = typeof home.body === "string" ? home.body.match(/src="(\/plugins\/[^"]+)"/) : null;
        if (!pluginMatch) {
          record("webPluginRoutes", "fail", "the web UI references no plugin asset");
          return;
        }
        const asset = await fetchPage(`${config.candidateEndpoint}${pluginMatch[1]}`);
        record(
          "webPluginRoutes",
          asset.status === 200 ? "pass" : "fail",
          asset.status === 200 ? `plugin asset ${pluginMatch[1]} -> HTTP 200` : `plugin asset ${pluginMatch[1]} -> HTTP ${asset.status}`,
        );
      },
    },
    {
      names: ["longLivedTransport"],
      required: false,
      run: async () => {
        record("longLivedTransport", "not_run", "no automated long-lived transport check in this release");
      },
    },
    {
      names: ["terminalPtty"],
      required: false,
      run: async () => {
        record("terminalPtty", "not_run", "no automated terminal check in this release");
      },
    },
  ];

  for (const step of steps) {
    if (stoppedAfter !== null) {
      for (const name of step.names) {
        checks[name] = { status: "not_run", detail: `skipped after ${stoppedAfter} failed` };
      }
      continue;
    }
    await step.run();
  }

  return { checks, stoppedAfter };
}

function applySnapshotGate(report, snapshotFailure) {
  if (!snapshotFailure) return report;
  const reasons = report.decision.reasons.includes(`snapshot=${snapshotFailure}`)
    ? report.decision.reasons
    : [...report.decision.reasons, `snapshot=${snapshotFailure}`];
  return {
    ...report,
    snapshot: { reference: null },
    decision: { outcome: DECISION_OUTCOMES.notEligible, reasons },
  };
}

async function finalizeReport({ config, evidence, snapshotFailure, runCommand, fetchPage }) {
  const report = applySnapshotGate(createCompatibilityReport(evidence), snapshotFailure);
  await mkdir(config.workdir, { recursive: true });
  await writeFile(`${config.workdir}/evidence.json`, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  await writeFile(`${config.workdir}/report.json`, renderReportJson(report) + "\n", "utf8");
  return { report, text: renderReportText(report) };
}

export async function runCandidateWorkflow({
  config,
  runCommand = defaultRunCommand,
  fetchPage = defaultFetchPage,
  snapshotHook = runSnapshotHook,
}) {
  const evidence = {
    orbit: { version: config.orbitVersion, revision: config.orbitRevision },
    candidate: { dshVersion: config.dshVersion, profile: null },
    checks: {},
    snapshot: { reference: null },
  };
  try {
    compatibilityFor(config.dshVersion);
    evidence.candidate.profile = config.dshVersion;
  } catch {
    evidence.candidate.profile = null;
  }

  let snapshotFailure = null;
  if (config.snapshotHook) {
    const snapshot = await snapshotHook({
      hookPath: config.snapshotHook,
      manifestPath: `${config.workdir}/snapshot-manifest.json`,
      snapshotId: `pre-candidate-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
      dataRoot: config.dataRoot,
      orbitRevision: config.orbitRevision,
      dshVersion: config.dshVersion,
      timeoutSeconds: config.snapshotTimeoutSeconds,
    });
    if (snapshot.ok) {
      evidence.snapshot.reference = snapshot.manifest.restoreReference;
    } else {
      snapshotFailure = snapshot.error;
    }
  }

  {
    const build = await runCommand(
      "docker",
      ["compose", "-f", config.composeFile, "-p", config.project, "build"],
      { env: { DSH_VERSION: config.dshVersion, DSH_PUBLIC_HOST: config.publicHost } },
    );
    if (build.code !== 0) {
      evidence.checks.globalPatch = {
        status: "fail",
        detail: "candidate build failed: unsupported version, source mismatch, or unverifiable patch",
      };
    } else {
      const up = await runCommand("docker", [
        "compose",
        "-f",
        config.composeFile,
        "-p",
        config.project,
        "up",
        "-d",
        "--wait",
      ]);
      if (up.code !== 0) {
        evidence.checks.runtimeReadiness = {
          status: "fail",
          detail: "candidate stack did not become healthy on the isolated endpoint",
        };
      } else {
        const { checks } = await runVerificationSequence({ config, runCommand, fetchPage });
        evidence.checks = checks;
      }
    }
  }

  const { report, text } = await finalizeReport({ config, evidence, snapshotFailure, runCommand, fetchPage });
  const eligible = report.decision.outcome === DECISION_OUTCOMES.eligible;
  return {
    eligible,
    exitCode: eligible ? 0 : 1,
    banner: eligible ? "CANDIDATE PASSED - ELIGIBLE FOR MANUAL PROMOTION" : "CANDIDATE FAILED - NOT ELIGIBLE FOR PROMOTION",
    report,
    text,
  };
}

export async function loadEvidence(workdir) {
  return JSON.parse(await readFile(`${workdir}/evidence.json`, "utf8"));
}
