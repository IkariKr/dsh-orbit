import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  COMPATIBILITY_OUTCOMES,
  PROMOTION_OUTCOMES,
  REPORT_SCHEMA_VERSION,
  createCompatibilityReport,
  renderReportJson,
  renderReportText,
} from "../src/compatibility-report.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/report-compatibility.mjs", import.meta.url));

const PRIVATE_VALUE = "orbit-report-private-value";

function passingEvidence(overrides = {}) {
  return {
    promotionEvaluated: true,
    orbit: { version: "0.1.1", revision: "386e4d1aa825c41446e2e5eebb67bfe7570564b1" },
    baseline: {
      image: "dsh-orbit:0.1.1-rc.2-production.4",
      orbitRevision: "8f3094e6d09c9337569f5cc1f965f8bd3d01e7d9",
      dshVersion: "0.1.1-rc.2",
    },
    candidate: { dshVersion: "0.1.1-rc.2", profile: "0.1.1-rc.2" },
    checks: {
      globalPatch: { status: "pass", detail: "ok/ok" },
      profilePatch: { status: "pass", detail: "ok/ok" },
      runtimeReadiness: { status: "pass", detail: "ready" },
      settingsRead: { status: "pass" },
      settingsNoopWrite: { status: "pass" },
      authorizationSmoke: { status: "pass" },
      sessionResume: { status: "pass" },
      webPluginRoutes: { status: "pass" },
    },
    snapshot: { reference: "pre-candidate-20260829.tar.gz" },
    ...overrides,
  };
}

test("a fully passing candidate run is eligible for manual promotion", () => {
  const report = createCompatibilityReport(passingEvidence());
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(report.compatibility.outcome, COMPATIBILITY_OUTCOMES.pass);
  assert.equal(report.promotionReadiness.outcome, PROMOTION_OUTCOMES.eligible);
  assert.deepEqual(report.promotionReadiness.reasons, []);
  assert.equal(report.baseline.image, "dsh-orbit:0.1.1-rc.2-production.4");

  const text = renderReportText(report);
  assert.match(text, /compatibility: PASS/);
  assert.match(text, /promotion readiness: ELIGIBLE FOR MANUAL PROMOTION/);
  assert.match(text, /\[pass\] globalPatch ok\/ok/);
  assert.match(text, /\[not_run\] \(optional\) terminalPtty/);
  assert.match(text, /baseline: dsh-orbit:0\.1\.1-rc\.2-production\.4 revision 8f3094e/);
});

test("a report without exact identities or a snapshot must not be promotion eligible", () => {
  const report = createCompatibilityReport(
    passingEvidence({
      orbit: { version: "0.1.1", revision: null },
      candidate: { dshVersion: "0.1.1-rc.2", profile: null },
      baseline: { image: null, orbitRevision: null, dshVersion: null },
      snapshot: { reference: null },
    }),
  );
  assert.equal(report.compatibility.outcome, COMPATIBILITY_OUTCOMES.pass, "checks alone still pass compatibility");
  assert.equal(report.promotionReadiness.outcome, PROMOTION_OUTCOMES.notEligible);
  assert.deepEqual(report.promotionReadiness.reasons, [
    "orbit.revision missing",
    "candidate.profile missing",
    "baseline.image missing",
    "baseline.orbitRevision missing",
    "baseline.dshVersion missing",
    "snapshot reference missing",
  ]);
  assert.match(renderReportText(report), /promotion readiness: NOT ELIGIBLE \(orbit\.revision missing/);
});

test("an unexecuted required check fails compatibility and blocks promotion", () => {
  const evidence = passingEvidence();
  delete evidence.checks.sessionResume;
  const report = createCompatibilityReport(evidence);
  assert.equal(report.checks.sessionResume.status, "not_run");
  assert.equal(report.compatibility.outcome, COMPATIBILITY_OUTCOMES.fail);
  assert.deepEqual(report.compatibility.reasons, ["sessionResume=not_run"]);
  assert.equal(report.promotionReadiness.outcome, PROMOTION_OUTCOMES.notEligible);
  assert.ok(report.promotionReadiness.reasons.includes("sessionResume=not_run"));
});

test("passing patch evidence alone cannot produce a compatibility pass", () => {
  const report = createCompatibilityReport(
    passingEvidence({
      checks: {
        globalPatch: { status: "pass" },
        profilePatch: { status: "pass" },
        runtimeReadiness: { status: "pass" },
        settingsRead: { status: "pass" },
        settingsNoopWrite: { status: "pass" },
        authorizationSmoke: { status: "fail", detail: "unexpected Origin accepted" },
        sessionResume: { status: "fail", detail: "refusing to compose an unscoped context" },
        webPluginRoutes: { status: "pass" },
      },
    }),
  );
  assert.equal(report.compatibility.outcome, COMPATIBILITY_OUTCOMES.fail);
  assert.deepEqual(report.compatibility.reasons, ["authorizationSmoke=fail", "sessionResume=fail"]);
  assert.equal(report.promotionReadiness.outcome, PROMOTION_OUTCOMES.notEligible);
});

test("a failed optional check blocks compatibility but an untested one does not", () => {
  const untested = createCompatibilityReport(passingEvidence());
  assert.equal(untested.compatibility.outcome, COMPATIBILITY_OUTCOMES.pass);

  const failed = createCompatibilityReport(
    passingEvidence({
      checks: {
        ...passingEvidence().checks,
        terminalPtty: { status: "fail", detail: "node-pty binding missing" },
      },
    }),
  );
  assert.equal(failed.compatibility.outcome, COMPATIBILITY_OUTCOMES.fail);
  assert.ok(failed.compatibility.reasons.includes("terminalPtty=fail"));
});

test("a persisted snapshot failure survives report regeneration", () => {
  const evidence = passingEvidence({
    snapshot: { reference: null, failure: "snapshot hook exited with code 3" },
  });
  const first = createCompatibilityReport(evidence);
  assert.equal(first.promotionReadiness.outcome, PROMOTION_OUTCOMES.notEligible);
  assert.ok(first.promotionReadiness.reasons.includes("snapshot=snapshot hook exited with code 3"));

  const regenerated = createCompatibilityReport(JSON.parse(JSON.stringify(evidence)));
  assert.equal(regenerated.promotionReadiness.outcome, PROMOTION_OUTCOMES.notEligible);
  assert.ok(regenerated.promotionReadiness.reasons.includes("snapshot=snapshot hook exited with code 3"));
});

test("verification-only reports are not evaluated for promotion", () => {
  const report = createCompatibilityReport(passingEvidence({ promotionEvaluated: false }));
  assert.equal(report.compatibility.outcome, COMPATIBILITY_OUTCOMES.pass);
  assert.equal(report.promotionReadiness.outcome, PROMOTION_OUTCOMES.notEvaluated);
  assert.deepEqual(report.promotionReadiness.reasons, []);
  assert.match(renderReportText(report), /promotion readiness: NOT EVALUATED/);

  const failedVerification = createCompatibilityReport(
    passingEvidence({
      promotionEvaluated: false,
      checks: { ...passingEvidence().checks, sessionResume: { status: "fail" } },
    }),
  );
  assert.equal(failedVerification.promotionReadiness.outcome, PROMOTION_OUTCOMES.notEvaluated);
  assert.equal(failedVerification.compatibility.outcome, COMPATIBILITY_OUTCOMES.fail);
});

test("report output never contains configured secrets", () => {
  const report = createCompatibilityReport(
    passingEvidence({
      checks: {
        ...passingEvidence().checks,
        settingsRead: { status: "fail", detail: `request failed with ${PRIVATE_VALUE}` },
      },
      redactions: [PRIVATE_VALUE],
    }),
  );
  const text = renderReportText(report);
  const json = renderReportJson(report);
  assert.ok(!text.includes(PRIVATE_VALUE));
  assert.ok(!json.includes(PRIVATE_VALUE));
  assert.ok(text.includes("[redacted]"));
  assert.ok(json.includes("[redacted]"));
});

test("unknown checks and invalid inputs are rejected", () => {
  assert.throws(() => createCompatibilityReport(passingEvidence({ checks: { bogus: { status: "pass" } } })), /unknown check/);
  assert.throws(
    () => createCompatibilityReport(passingEvidence({ checks: { globalPatch: { status: "ok" } } })),
    /invalid status/,
  );
  assert.throws(() => createCompatibilityReport({ candidate: { dshVersion: "x" } }), /orbit\.version is required/);
  assert.throws(
    () => createCompatibilityReport(passingEvidence({ redactions: "not-an-array" })),
    /redactions must be an array/,
  );
  assert.throws(
    () => createCompatibilityReport(passingEvidence({ promotionEvaluated: "yes" })),
    /promotionEvaluated must be a boolean/,
  );
  assert.throws(
    () => createCompatibilityReport(passingEvidence({ baseline: "not-an-object" })),
    /baseline must be an object/,
  );
});

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-report-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runCli(args, env = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, ...env },
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
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

test("cli produces machine-readable and human-readable reports", async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, "evidence.json");
    const jsonOut = join(dir, "report.json");
    await writeFile(input, JSON.stringify(passingEvidence()), "utf8");

    const { code, stdout } = await runCli(["--input", input, "--format", "json", "--json-out", jsonOut]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.schemaVersion, REPORT_SCHEMA_VERSION);
    assert.equal(parsed.promotionReadiness.outcome, PROMOTION_OUTCOMES.eligible);

    const file = JSON.parse(await readFile(jsonOut, "utf8"));
    assert.equal(file.candidate.dshVersion, "0.1.1-rc.2");

    const textRun = await runCli(["--input", input]);
    assert.equal(textRun.code, 0);
    assert.match(textRun.stdout, /DSH Orbit compatibility report \(schema v2\)/);
    assert.match(textRun.stdout, /ELIGIBLE FOR MANUAL PROMOTION/);
  });
});

test("cli keeps a persisted snapshot failure through regeneration", async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, "evidence.json");
    await writeFile(
      input,
      JSON.stringify(
        passingEvidence({
          snapshot: { reference: null, failure: "snapshot manifest did not match the request" },
        }),
      ),
      "utf8",
    );
    const { code, stdout } = await runCli(["--input", input]);
    assert.equal(code, 0);
    assert.match(stdout, /promotion readiness: NOT ELIGIBLE \(snapshot=snapshot manifest did not match the request\)/);
    assert.match(stdout, /snapshot: none \(failure: snapshot manifest did not match the request\)/);
  });
});

test("cli redacts secrets provided through the environment", async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, "evidence.json");
    await writeFile(
      input,
      JSON.stringify(
        passingEvidence({
          checks: {
            ...passingEvidence().checks,
            settingsRead: { status: "fail", detail: `failed after ${PRIVATE_VALUE}` },
          },
        }),
      ),
      "utf8",
    );
    const { code, stdout } = await runCli(["--input", input], {
      DSH_REPORT_REDACTIONS: JSON.stringify([PRIVATE_VALUE]),
    });
    assert.equal(code, 0);
    assert.ok(!stdout.includes(PRIVATE_VALUE));
    assert.ok(stdout.includes("[redacted]"));
  });
});

test("cli fails closed on invalid evidence and usage", async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, "evidence.json");
    await writeFile(
      input,
      JSON.stringify(passingEvidence({ checks: { globalPatch: { status: "maybe" } } })),
      "utf8",
    );
    const invalid = await runCli(["--input", input]);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /invalid status/);

    const missing = await runCli(["--input", join(dir, "absent.json")]);
    assert.equal(missing.code, 1);

    const usage = await runCli([]);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /usage:/);
  });
});
