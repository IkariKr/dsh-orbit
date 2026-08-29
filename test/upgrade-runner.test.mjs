import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadUpgradeConfig,
  preflight,
  runCandidateWorkflow,
} from "../src/upgrade-runner.mjs";
import { DECISION_OUTCOMES } from "../src/compatibility-report.mjs";

const PLUGIN_ASSET = "/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=abc123";
const PATCH_CHECK_STDOUT = [
  "DSH upstream: 0.1.1-rc.2",
  "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib: ok/ok",
  "/data/dsh-home/profiles/web/node_modules/@deepseek-ai/dsh-client-connection/lib: ok",
  "",
].join("\n");

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-upgrade-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fixtureConfig(workdir, overrides = {}) {
  return {
    dshVersion: "0.1.1-rc.2",
    publicHost: "dsh.example.com",
    candidateEndpoint: "https://candidate.example.com",
    basicUser: "admin",
    basicPassword: "orbit-candidate-value",
    sessionId: "session-historical",
    dataRoot: "/srv/dsh-production/data",
    candidateDataRoot: "/srv/dsh-candidate/data",
    baselineImage: "dsh-orbit:0.1.1-rc.2-ikari.4",
    orbitRevision: "8f3094e6d09c9337569f5cc1f965f8bd3d01e7d9",
    orbitVersion: "0.1.1",
    snapshotHook: "/opt/dsh-orbit/hooks/snapshot.sh",
    snapshotTimeoutSeconds: 900,
    candidateImage: "dsh-orbit:0.1.1-rc.2",
    project: "dsh-orbit-candidate",
    composeFile: "/opt/dsh-orbit/docker/compose.example.yaml",
    workdir,
    ...overrides,
  };
}

function fakeExecutors({ buildCode = 0, upCode = 0, authCode = 0, sessionCode = 0, settingsMutateOk = true } = {}) {
  const events = [];
  const runCommand = async (file, args, options = {}) => {
    const key = args.includes("build") ? "build" : args.includes("up") ? "up" : args[0].includes("smoke-settings") ? "settings" : args[0].includes("smoke-auth") ? "auth" : args[0].includes("smoke-session") ? "session" : "patch";
    events.push(`command:${key}`);
    if (key === "build") return { code: buildCode, stdout: "", stderr: buildCode === 0 ? "" : "patch failed: missing isTrustedApiRequest declaration" };
    if (key === "up") return { code: upCode, stdout: "", stderr: "" };
    if (key === "patch") return { code: 0, stdout: PATCH_CHECK_STDOUT, stderr: "" };
    if (key === "settings") {
      return {
        code: settingsMutateOk ? 0 : 1,
        stdout: settingsMutateOk
          ? "settings.describe: ok (26 namespaces)\nsettings.mutate: ok (agent-default-model, no-op)\n"
          : "settings.describe: ok (26 namespaces)\n",
        stderr: "",
      };
    }
    if (key === "auth") return { code: authCode, stdout: "", stderr: authCode === 0 ? "" : "FAIL unexpected Origin: expected denied, got allowed" };
    if (key === "session") return { code: sessionCode, stdout: "", stderr: sessionCode === 0 ? "" : "session.models: resume failed for session ... refusing to compose an unscoped context" };
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  };
  const fetchPage = async (url) => {
    events.push(`fetch:${url}`);
    if (url.endsWith("/")) {
      return { status: 200, body: `<html><body><script src="${PLUGIN_ASSET}"></script></body></html>` };
    }
    if (url.includes("/plugins/")) {
      return { status: 200, body: "// plugin module" };
    }
    return { status: 404, body: "" };
  };
  return { events, runCommand, fetchPage };
}

function fakeSnapshotHook(events, outcome) {
  return async (options) => {
    events.push("snapshot");
    if (outcome.ok) {
      return { ok: true, manifest: { ...outcome.manifest } };
    }
    return { ok: false, error: outcome.error };
  };
}

test("preflight rejects invalid or unsafe upgrade configuration", async () => {
  await withTempDir(async (dir) => {
    const dataRoot = join(dir, "data");
    const candidateDataRoot = join(dir, "candidate-data");
    await mkdir(dataRoot, { recursive: true });
    await mkdir(candidateDataRoot, { recursive: true });

    const base = fixtureConfig(workdir(dir), {
      dataRoot,
      candidateDataRoot,
    });

    const sameRoots = await preflight({ ...base, candidateDataRoot: dataRoot });
    assert.equal(sameRoots.ok, false);
    assert.ok(sameRoots.failures.some((failure) => failure.check === "copied-data-root"));

    const collidingImage = await preflight({ ...base, candidateImage: base.baselineImage });
    assert.equal(collidingImage.ok, false);
    assert.ok(collidingImage.failures.some((failure) => failure.check === "candidate-image"));

    const badHost = await preflight({ ...base, publicHost: "https://dsh.example.com" });
    assert.equal(badHost.ok, false);
    assert.ok(badHost.failures.some((failure) => failure.check === "public-host"));

    const unknownVersion = await preflight({ ...base, dshVersion: "9.9.9-future" });
    assert.equal(unknownVersion.ok, false);
    assert.ok(unknownVersion.failures.some((failure) => failure.check === "compatibility-profile"));

    const missingDir = await preflight({ ...base, candidateDataRoot: join(dir, "absent") });
    assert.equal(missingDir.ok, false);
    assert.ok(missingDir.failures.some((failure) => failure.check === "candidate-data-root"));

    const noSnapshot = await preflight({ ...base, snapshotHook: "" });
    assert.equal(noSnapshot.ok, false);
    assert.ok(noSnapshot.failures.some((failure) => failure.check === "snapshot-capability"));

    const ok = await preflight(base);
    assert.deepEqual(ok, { ok: true, failures: [] });
  });
});

function workdir(dir) {
  return join(dir, "run");
}

test("candidate workflow runs snapshot, build, isolated start, and the ordered verification sequence", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { events, runCommand, fetchPage } = fakeExecutors();
    const result = await runCandidateWorkflow({
      config,
      runCommand,
      fetchPage,
      snapshotHook: fakeSnapshotHook(events, {
        ok: true,
        manifest: { restoreReference: "/srv/backups/pre-candidate.tar.gz", snapshotId: "snap-1" },
      }),
    });

    assert.equal(result.eligible, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.banner, "CANDIDATE PASSED - ELIGIBLE FOR MANUAL PROMOTION");
    assert.equal(result.report.decision.outcome, DECISION_OUTCOMES.eligible);
    assert.equal(result.report.snapshot.reference, "/srv/backups/pre-candidate.tar.gz");

    const commandKeys = events.filter((event) => event.startsWith("command:")).map((event) => event.slice(8));
    assert.deepEqual(commandKeys, ["build", "up", "patch", "settings", "auth", "session"]);

    const checkOrder = Object.entries(result.report.checks).map(([name, entry]) => `${name}:${entry.status}`);
    assert.deepEqual(checkOrder, [
      "globalPatch:pass",
      "profilePatch:pass",
      "runtimeReadiness:pass",
      "settingsRead:pass",
      "settingsNoopWrite:pass",
      "authorizationSmoke:pass",
      "sessionResume:pass",
      "webPluginRoutes:pass",
      "longLivedTransport:not_run",
      "terminalPtty:not_run",
    ]);

    const snapshotIndex = events.indexOf("snapshot");
    const buildIndex = events.indexOf("command:build");
    const upIndex = events.indexOf("command:up");
    assert.ok(snapshotIndex < buildIndex && buildIndex < upIndex, "snapshot must precede build and start");

    const reportFromDisk = JSON.parse(await readFile(join(config.workdir, "report.json"), "utf8"));
    assert.equal(reportFromDisk.decision.outcome, DECISION_OUTCOMES.eligible);
    await readFile(join(config.workdir, "evidence.json"), "utf8");
  });
});

test("every docker command is scoped to the candidate project", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { events, runCommand, fetchPage } = fakeExecutors();
    const seen = [];
    const wrapped = async (file, args, options) => {
      if (file === "docker") seen.push(args);
      return runCommand(file, args, options);
    };
    await runCandidateWorkflow({
      config,
      runCommand: wrapped,
      fetchPage,
      snapshotHook: fakeSnapshotHook(events, {
        ok: true,
        manifest: { restoreReference: "/srv/backups/pre-candidate.tar.gz", snapshotId: "snap-1" },
      }),
    });
    assert.ok(seen.length >= 3);
    for (const args of seen) {
      assert.equal(args[0], "compose");
      assert.ok(args.includes(config.composeFile));
      const projectIndex = args.indexOf("-p");
      assert.equal(args[projectIndex + 1], config.project);
    }
  });
});

test("a required verification failure stops the sequence and marks later checks not_run", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { events, runCommand, fetchPage } = fakeExecutors({ authCode: 1 });
    const result = await runCandidateWorkflow({
      config,
      runCommand,
      fetchPage,
      snapshotHook: fakeSnapshotHook(events, {
        ok: true,
        manifest: { restoreReference: "/srv/backups/pre-candidate.tar.gz", snapshotId: "snap-1" },
      }),
    });

    assert.equal(result.eligible, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.banner, "CANDIDATE FAILED - NOT ELIGIBLE FOR PROMOTION");
    assert.equal(result.report.checks.authorizationSmoke.status, "fail");
    assert.equal(result.report.checks.sessionResume.status, "not_run");
    assert.equal(result.report.checks.webPluginRoutes.status, "not_run");
    assert.equal(result.report.decision.outcome, DECISION_OUTCOMES.notEligible);
    assert.ok(result.report.decision.reasons.includes("authorizationSmoke=fail"));

    const commandKeys = events.filter((event) => event.startsWith("command:")).map((event) => event.slice(8));
    assert.ok(!commandKeys.includes("session"), "checks after a hard failure must not execute");
  });
});

test("a failed no-op settings write blocks eligibility while the read may pass", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { events, runCommand, fetchPage } = fakeExecutors({ settingsMutateOk: false });
    const result = await runCandidateWorkflow({
      config,
      runCommand,
      fetchPage,
      snapshotHook: fakeSnapshotHook(events, {
        ok: true,
        manifest: { restoreReference: "/srv/backups/pre-candidate.tar.gz", snapshotId: "snap-1" },
      }),
    });

    assert.equal(result.report.checks.settingsRead.status, "pass");
    assert.equal(result.report.checks.settingsNoopWrite.status, "fail");
    assert.equal(result.report.decision.outcome, DECISION_OUTCOMES.notEligible);
    assert.ok(result.report.decision.reasons.includes("settingsNoopWrite=fail"));
  });
});

test("a failed production snapshot denies promotion readiness even when checks pass", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { events, runCommand, fetchPage } = fakeExecutors();
    const result = await runCandidateWorkflow({
      config,
      runCommand,
      fetchPage,
      snapshotHook: fakeSnapshotHook(events, { ok: false, error: "snapshot hook exited with code 3" }),
    });

    assert.equal(events[0], "snapshot");
    assert.equal(result.eligible, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.banner, "CANDIDATE FAILED - NOT ELIGIBLE FOR PROMOTION");
    assert.equal(result.report.snapshot.reference, null);
    assert.ok(result.report.decision.reasons.includes("snapshot=snapshot hook exited with code 3"));
    assert.ok(result.report.checks.runtimeReadiness.status !== "not_run");
  });
});

test("a failed candidate build never starts the stack and reports the patch gate", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { events, runCommand, fetchPage } = fakeExecutors({ buildCode: 1 });
    const result = await runCandidateWorkflow({
      config,
      runCommand,
      fetchPage,
      snapshotHook: fakeSnapshotHook(events, {
        ok: true,
        manifest: { restoreReference: "/srv/backups/pre-candidate.tar.gz", snapshotId: "snap-1" },
      }),
    });

    assert.equal(result.eligible, false);
    assert.equal(result.report.checks.globalPatch.status, "fail");
    assert.equal(result.report.checks.runtimeReadiness.status, "not_run");
    const commandKeys = events.filter((event) => event.startsWith("command:")).map((event) => event.slice(8));
    assert.ok(!commandKeys.includes("up"), "a failed build must not start the candidate stack");
    assert.ok(result.report.decision.reasons.includes("globalPatch=fail"));
  });
});

test("loadUpgradeConfig reports missing environment configuration", () => {
  const { missing, config } = loadUpgradeConfig({
    DSH_VERSION: "0.1.1-rc.2",
    DSH_PUBLIC_HOST: "dsh.example.com",
  });
  assert.ok(missing.includes("DSH_SMOKE_URL (candidate endpoint)"));
  assert.ok(missing.includes("DSH_SNAPSHOT_HOOK (snapshot capability)"));
  assert.equal(config.candidateImage, "dsh-orbit:0.1.1-rc.2");
  assert.ok(config.workdir.endsWith(".upgrade-run"));
});

test("an unsupported DSH version is never marked supported or promotion-ready", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir), { dshVersion: "9.9.9-future" });
    const gate = await preflight(config);
    assert.equal(gate.ok, false);
    assert.ok(gate.failures.some((failure) => failure.check === "compatibility-profile"));

    const { events, runCommand, fetchPage } = fakeExecutors({ buildCode: 1 });
    const result = await runCandidateWorkflow({
      config,
      runCommand,
      fetchPage,
      snapshotHook: fakeSnapshotHook(events, {
        ok: true,
        manifest: { restoreReference: "/srv/backups/pre-candidate.tar.gz", snapshotId: "snap-1" },
      }),
    });
    assert.equal(result.report.candidate.profile, null);
    assert.equal(result.report.checks.globalPatch.status, "fail");
    assert.equal(result.report.decision.outcome, DECISION_OUTCOMES.notEligible);
    assert.equal(result.banner, "CANDIDATE FAILED - NOT ELIGIBLE FOR PROMOTION");
  });
});

test("a missing profile-local patch verification fails the candidate", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { events, runCommand, fetchPage } = fakeExecutors();
    const wrapped = async (file, args, options) => {
      if (args.includes("--check")) {
        return {
          code: 0,
          stdout: `${PATCH_CHECK_STDOUT.split("\n")[0]}\n${PATCH_CHECK_STDOUT.split("\n")[1]}\n`,
          stderr: "",
        };
      }
      return runCommand(file, args, options);
    };
    const result = await runCandidateWorkflow({
      config,
      runCommand: wrapped,
      fetchPage,
      snapshotHook: fakeSnapshotHook(events, {
        ok: true,
        manifest: { restoreReference: "/srv/backups/pre-candidate.tar.gz", snapshotId: "snap-1" },
      }),
    });

    assert.equal(result.report.checks.globalPatch.status, "pass");
    assert.equal(result.report.checks.profilePatch.status, "fail");
    assert.equal(result.report.checks.authorizationSmoke.status, "not_run");
    assert.equal(result.report.decision.outcome, DECISION_OUTCOMES.notEligible);
    assert.ok(result.report.decision.reasons.includes("profilePatch=fail"));
    assert.equal(result.banner, "CANDIDATE FAILED - NOT ELIGIBLE FOR PROMOTION");
  });
});

test("a session-resume regression fails the candidate while preserving a sanitized report", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { events, runCommand, fetchPage } = fakeExecutors({ sessionCode: 1 });
    const result = await runCandidateWorkflow({
      config,
      runCommand,
      fetchPage,
      snapshotHook: fakeSnapshotHook(events, {
        ok: true,
        manifest: { restoreReference: "/srv/backups/pre-candidate.tar.gz", snapshotId: "snap-1" },
      }),
    });

    assert.equal(result.report.checks.sessionResume.status, "fail");
    assert.match(
      result.report.checks.sessionResume.detail,
      /refusing to compose an unscoped context/,
    );
    assert.equal(result.report.decision.outcome, DECISION_OUTCOMES.notEligible);
    assert.equal(result.report.checks.terminalPtty.status, "not_run");
    assert.ok(!result.report.decision.reasons.includes("terminalPtty=pass"));

    const text = result.text;
    assert.match(text, /NOT ELIGIBLE FOR PROMOTION/);
    assert.match(text, /refusing to compose an unscoped context/);
    await readFile(join(config.workdir, "report.json"), "utf8");
    const evidence = JSON.parse(await readFile(join(config.workdir, "evidence.json"), "utf8"));
    assert.equal(evidence.checks.sessionResume.status, "fail");
  });
});
