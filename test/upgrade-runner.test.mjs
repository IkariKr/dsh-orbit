import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  UpgradeBindingError,
  loadUpgradeConfig,
  preflight,
  probeCandidateToken,
  runCandidateWorkflow,
} from "../src/upgrade-runner.mjs";
import {
  COMPATIBILITY_OUTCOMES,
  PROMOTION_OUTCOMES,
  createCompatibilityReport,
} from "../src/compatibility-report.mjs";

// Per-run gateway identity fixture (self-signed, test-only; CN=dsh.example.com).
const GATEWAY_CERT_PEM = "-----BEGIN CERTIFICATE-----\r\nMIIDMTCCAhmgAwIBAgIUTpDv9KIJtE+G35NL8g6oz2eyO1cwDQYJKoZIhvcNAQEL\r\nBQAwGjEYMBYGA1UEAwwPZHNoLmV4YW1wbGUuY29tMB4XDTI2MDgyOTE2MTc0MFoX\r\nDTM2MDgyNjE2MTc0MFowGjEYMBYGA1UEAwwPZHNoLmV4YW1wbGUuY29tMIIBIjAN\r\nBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArpcKILYea80dLSCJUpOve1p1K4t3\r\nU4BUPpk+AcWYp11YHuh1KFcF8xcmqbT2Eaxlq37rq34sbbkt/y1qf8mSI7EkDiyx\r\nBPgqvKADLYQx0oPDqyq8Q1TNPw2LoKj/CfQR4Z1H4o5foHPfzzutJ2ITGF6dR1cP\r\niS+EIHqD4aj17dlta1S3cfhE/aOcRg30JKOGKjVkaf4OXMbgIJYugHqV4yCG2Mwx\r\n8RJz/+nq6VMGL/46u9ftuGuM1GwwR0mxVdPf4YUJviczqvG+pdw9L1n91xPiF+hR\r\nAl4GAoBvhSDrojtrGQ9kti0/3mRI26Jd3WbAEPCmorV6v6G6uBLI79Gb/wIDAQAB\r\no28wbTAdBgNVHQ4EFgQUEKYimjSXhPm3+RaSOxR1pLRm1G0wHwYDVR0jBBgwFoAU\r\nEKYimjSXhPm3+RaSOxR1pLRm1G0wDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzAR\r\ngg9kc2guZXhhbXBsZS5jb20wDQYJKoZIhvcNAQELBQADggEBAJwq/iv1NSDA+wEO\r\ndOEOoJILe9suxS70RF/cGjn0QJZmhNxxKyoHnhLYLkpWaZHnwQkfIU4O0aPF7fM2\r\n1XgtHrAcNy5LSVtFIyWmAGasfL50igQHU2V/rCEsPDsRUDtAas8ruBzBMKH48Bav\r\nNqYrjGBO5QCudWXY1fim3nu4ixGiuwESCiokJRclrji+r3yd3atEaTl0vHYGSRrz\r\nECKmgh44o0rh33XOpniW+oy2grPgHLuXxp66IUXn8tRvrd2tfYil93Zzif6idloT\r\nwQXDE0QyATOcVxe3mt/2PiSng3mULTUkEZtkv59Ps5059kiGjNaflEjKwocVjuWa\r\ne+PuidE=\r\n-----END CERTIFICATE-----\r\n";
const GATEWAY_KEY_PEM = "-----BEGIN PRIVATE KEY-----\r\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCulwogth5rzR0t\r\nIIlSk697WnUri3dTgFQ+mT4BxZinXVge6HUoVwXzFyaptPYRrGWrfuurfixtuS3/\r\nLWp/yZIjsSQOLLEE+Cq8oAMthDHSg8OrKrxDVM0/DYugqP8J9BHhnUfijl+gc9/P\r\nO60nYhMYXp1HVw+JL4QgeoPhqPXt2W1rVLdx+ET9o5xGDfQko4YqNWRp/g5cxuAg\r\nli6AepXjIIbYzDHxEnP/6erpUwYv/jq71+24a4zUbDBHSbFV09/hhQm+JzOq8b6l\r\n3D0vWf3XE+IX6FECXgYCgG+FIOuiO2sZD2S2LT/eZEjbol3dZsAQ8KaitXq/obq4\r\nEsjv0Zv/AgMBAAECggEAGh6anfOLxZD1hnom++WrC9yn9DsfP6zOmGGQt0R6kWoT\r\nnubOxZmPWE45szX8LP9fuTJ5y471fUzbpsuCnVo+CiecP0qhs8lKNiyyN62z+SH2\r\ntLWQs3oNDXEsrH0xT/87FZ0pff7S1kxqSrSg3mgmdy+LKXsgOzk9SSagcwg2Er6E\r\nsDJH6Gy+M+pcnJIalrxw5NPwv4G5lShD9UeGrmtJ1TSDYoMaJRzknky9vlCTMHg9\r\nR/+YPH21mVpBNG/joHLszmzNZiRLkwD0zGzji98qOw7OmFg5cG0nRKUCTMwr+unS\r\nAXzdnCdE/pw7LLXPbkeV2T7IYzB7lU9umhB1epvUUQKBgQDT6pUF/NfryF6U8RQT\r\nzpCuSrxLa0jJFucjk2P7TbLnlmh63/ub8ZwBSy+ziCAFyxX1qo2OEwP1M9IJMkCD\r\nODy/k0s2ubSzJFbrr0zh3PClmBAfW6ImTJx7DJhnYz8XIMTAVNlu+7uasCS0dxTE\r\ncYTY4BE9ipTs3Uk+GiJ8n8kD1QKBgQDS6K0Zoq4XkVYSy8Z/EC0jEkvRCGQpbx1G\r\nWszBQXRiIfESsu6CHSYWpU3tooSm3JxL0KvlqGrcxhUiOZ0Qyz4KdbJwk0thFxnl\r\n4gc8vGZLvgn3biGrsaHwtTdG8NFcSMZz4kRKrluuz0fEM6ZCyTmufjqYpmduc/7h\r\nJ1Yw+UMOgwKBgA32YMc6N4fDdefeUnJTo9i399wIP41wQt5nMak3H1h+4ndmFo/Z\r\nxWuYZpYvm9yF2vaKvDTmL9aSCX6tnu6GYApHTCdY6Pz8ofV5YVloUzq14CoQwYhA\r\nd/brh4cYVOnTMONzM7hKQbwZavGw/t9Kk3QunzQs008f7Vl4I1mOtZHZAoGAWs9o\r\nSNNs1iTzxKAM1YTnimREVLqiNdzr4/EQnF1MeTxYCk8Utt1KGxIN3bXOG/J9MX+l\r\no/rCGFEJpHTeFe8MxYAr1qD1IdbKhdqudw4/lXk73VeEE+Ml8Ph11ou1+WA0Yo0Y\r\nDnfIbho9slLy0WrG9UTQgg2UF1DGe7duOyP4JXUCgYBoVN0q+0dHOfeL+wweLwbz\r\niECUPVKpeu4LL0K443Bceqdxx7GDctQWewOZ7iuyjnUOxe/CgLbaxdKHXMTk5IJ0\r\n4WWbCiyklOQLOi/y0UW0P3Kxxh4vTDiurhqiPpJgQHDOG8G6sz4ViVDdhOQXAfMC\r\nwEZbrn3sVQ1HwqvK9TTNIg==\r\n-----END PRIVATE KEY-----\r\n";

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
    orbitRevision: "386e4d1aa825c41446e2e5eebb67bfe7570564b1",
    orbitVersion: "0.1.1",
    baselineImage: "dsh-orbit:0.1.1-rc.2-production.4",
    baselineOrbitRevision: "8f3094e6d09c9337569f5cc1f965f8bd3d01e7d9",
    baselineDshVersion: "0.1.1-rc.2",
    candidateImage: "dsh-orbit:0.1.1-rc.2",
    candidateDataRoot: "/srv/dsh-candidate/data",
    candidateWorkspaceRoot: "/srv/dsh-candidate/workspace",
    candidateHostPort: 18444,
    productionDataRoot: "/srv/dsh-production/data",
    candidateEndpoint: "https://dsh.example.com:9443",
    publicHost: "dsh.example.com",
    basicUser: "admin",
    basicPassword: "orbit-candidate-value",
    smokeOrigin: null,
    sessionId: "session-historical",
    snapshotHook: "/opt/dsh-orbit/hooks/snapshot.sh",
    snapshotTimeoutSeconds: 900,
    gatewayService: "caddy",
    gatewayCertTarget: "/etc/caddy/certs/fullchain.pem",
    gatewayKeyTarget: "/etc/caddy/certs/privkey.pem",
    project: "dsh-orbit-candidate",
    composeFile: "/opt/dsh-orbit/docker/compose.example.yaml",
    workdir,
    ...overrides,
  };
}

function resolvedCompose(config, overrides = {}) {
  return {
    name: config.project,
    services: {
      dsh: {
        image: config.candidateImage,
        volumes: [
          { source: config.candidateDataRoot, target: "/data" },
          { source: config.candidateWorkspaceRoot, target: "/workspace" },
        ],
        ports: [{ target: 9443, published: String(config.candidateHostPort), host_ip: "127.0.0.1" }],
        environment: { DSH_ORBIT_CANDIDATE_TOKEN: "tokenvalue" },
      },
    },
    ...overrides,
  };
}

function fakeExecutors(config, { buildCode = 0, upCode = 0, authCode = 0, sessionCode = 0, settingsMutateOk = true, resolved = null, tokenMismatch = false, identityFingerprintMismatch = false } = {}) {
  const events = [];
  const identityFingerprint = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
  const runCommand = async (file, args, options = {}) => {
    if (file === "openssl") {
      events.push("command:openssl");
      const { writeFile: writeFixture } = await import("node:fs/promises");
      await writeFixture(args[args.indexOf("-keyout") + 1], GATEWAY_KEY_PEM, "utf8");
      await writeFixture(args[args.indexOf("-out") + 1], GATEWAY_CERT_PEM, "utf8");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (file === "docker") {
      if (args.includes("config")) {
        const merged = args.includes(`${config.workdir}/compose.override.yaml`);
        events.push(merged ? "command:config" : "command:config-base");
        const resolvedConfig =
          resolved ??
          resolvedCompose(config, {
            services: {
              dsh: resolvedCompose(config).services.dsh,
              [config.gatewayService]: merged
                ? {
                    volumes: [
                      { source: `${config.workdir}/gateway-identity-cert.pem`, target: config.gatewayCertTarget },
                      { source: `${config.workdir}/gateway-identity-key.pem`, target: config.gatewayKeyTarget },
                    ],
                  }
                : {},
            },
          });
        return { code: 0, stdout: JSON.stringify(resolvedConfig), stderr: "" };
      }
      if (args.includes("build")) {
        events.push("command:build");
        return {
          code: buildCode,
          stdout: "",
          stderr: buildCode === 0 ? "" : "patch failed: missing isTrustedApiRequest declaration",
        };
      }
      if (args.includes("up")) {
        events.push("command:up");
        return { code: upCode, stdout: "", stderr: "" };
      }
      if (args.includes("printenv")) {
        events.push("command:token");
        const override = await readFile(join(config.workdir, "compose.override.yaml"), "utf8");
        const candidateToken = override.match(/DSH_ORBIT_CANDIDATE_TOKEN: "?([0-9a-f]+)"?/)[1];
        return { code: 0, stdout: tokenMismatch ? "a-different-token" : `${candidateToken}\n`, stderr: "" };
      }
      if (args.includes("--check")) {
        events.push("command:patch");
        return { code: 0, stdout: PATCH_CHECK_STDOUT, stderr: "" };
      }
    }
    const script = args[0] ?? "";
    if (script.includes("smoke-settings")) {
      events.push("command:settings");
      return {
        code: settingsMutateOk ? 0 : 1,
        stdout: settingsMutateOk
          ? "settings.describe: ok (26 namespaces)\nsettings.mutate: ok (agent-default-model, no-op)\n"
          : "settings.describe: ok (26 namespaces)\n",
        stderr: "",
      };
    }
    if (script.includes("smoke-auth")) {
      events.push("command:auth");
      return {
        code: authCode,
        stdout: "",
        stderr: authCode === 0 ? "" : "FAIL unexpected Origin: expected denied, got allowed",
      };
    }
    if (script.includes("smoke-session")) {
      events.push("command:session");
      return {
        code: sessionCode,
        stdout: "",
        stderr:
          sessionCode === 0
            ? ""
            : "session.models: resume failed for session ... refusing to compose an unscoped context",
      };
    }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  };
  const fetchPage = async (url, options = {}) => {
    events.push(`fetch:${url}`);
    if (url.endsWith("/")) {
      assert.equal(
        options.headers.authorization,
        `Basic ${Buffer.from("admin:orbit-candidate-value").toString("base64")}`,
      );
      assert.equal(options.headers["sec-fetch-site"], "same-origin");
      return { status: 200, body: `<html><body><script src="${PLUGIN_ASSET}"></script></body></html>` };
    }
    if (url.includes("/plugins/")) {
      return { status: 200, body: "// plugin module" };
    }
    return { status: 404, body: "" };
  };
  const snapshotEvents = [];
  const snapshotHook = async (options) => {
    snapshotEvents.push(options);
    events.push("snapshot");
    return {
      ok: true,
      manifest: { restoreReference: "/srv/backups/pre-candidate.tar.gz", snapshotId: "snap-1" },
    };
  };
  const tlsProbe = async (probe) => {
    events.push(`probe:gateway-identity:${probe.host}:${probe.port}`);
    const { X509Certificate } = await import("node:crypto");
    const { readFile: readCert } = await import("node:fs/promises");
    const generated = new X509Certificate(
      await readCert(`${config.workdir}/gateway-identity-cert.pem`, "utf8"),
    ).fingerprint256;
    return identityFingerprintMismatch ? "FF:EE:DD:CC:BB:AA" : generated;
  };
  return { events, snapshotEvents, runCommand, fetchPage, snapshotHook, tlsProbe };
}

function workdir(dir) {
  return join(dir, "run");
}

test("preflight rejects invalid or unsafe upgrade configuration", async () => {
  await withTempDir(async (dir) => {
    const dataRoot = join(dir, "data");
    const candidateDataRoot = join(dir, "candidate-data");
    const workspaceRoot = join(dir, "candidate-workspace");
    for (const d of [dataRoot, candidateDataRoot, workspaceRoot]) await mkdir(d, { recursive: true });

    const base = fixtureConfig(workdir(dir), {
      productionDataRoot: dataRoot,
      candidateDataRoot,
      candidateWorkspaceRoot: workspaceRoot,
    });

    const cases = [
      ["copied-data-root", { candidateDataRoot: dataRoot }],
      ["candidate-image", { candidateImage: base.baselineImage }],
      ["public-host", { publicHost: "https://dsh.example.com" }],
      ["compatibility-profile", { dshVersion: "9.9.9-future" }],
      ["candidate-data-root", { candidateDataRoot: join(dir, "absent") }],
      ["candidate-workspace-root", { candidateWorkspaceRoot: join(dir, "absent") }],
      ["production-data-root", { productionDataRoot: join(dir, "absent") }],
      ["candidate-host-port", { candidateHostPort: 99999 }],
      ["snapshot-capability", { snapshotHook: "" }],
      [
        "endpoint-binding",
        { candidateEndpoint: "https://127.0.0.1:9999" },
      ],
    ];
    for (const [expectedCheck, overrides] of cases) {
      const result = await preflight({ ...base, ...overrides });
      assert.equal(result.ok, false, `preflight should fail for ${expectedCheck}`);
      assert.ok(
        result.failures.some((failure) => failure.check === expectedCheck),
        `preflight should name ${expectedCheck}: ${JSON.stringify(result.failures)}`,
      );
    }

    const loopbackMatched = await preflight({
      ...base,
      candidateEndpoint: "https://127.0.0.1:18444",
    });
    assert.deepEqual(loopbackMatched, { ok: true, failures: [] });
  });
});

test("candidate workflow binds the verified compose configuration before starting", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { events, runCommand, fetchPage, snapshotHook, tlsProbe } = fakeExecutors(config);
    const result = await runCandidateWorkflow({ config, runCommand, fetchPage, snapshotHook, tlsProbe });

    assert.equal(result.eligible, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.banner, "CANDIDATE PASSED - ELIGIBLE FOR MANUAL PROMOTION");
    assert.equal(result.report.promotionReadiness.outcome, PROMOTION_OUTCOMES.eligible);
    assert.equal(result.report.snapshot.reference, "/srv/backups/pre-candidate.tar.gz");

    const commandKeys = events
      .filter((event) => event.startsWith("command:"))
      .map((event) => event.slice(8));
    assert.deepEqual(commandKeys, [
      "openssl",
      "config-base",
      "config",
      "build",
      "up",
      "token",
      "patch",
      "settings",
      "auth",
      "session",
    ]);
    assert.ok(events.includes("probe:gateway-identity:dsh.example.com:9443"));

    const snapshotIndex = events.indexOf("snapshot");
    const opensslIndex = events.indexOf("command:openssl");
    const configIndex = events.indexOf("command:config");
    const buildIndex = events.indexOf("command:build");
    const upIndex = events.indexOf("command:up");
    const probeIndex = events.indexOf("probe:gateway-identity:dsh.example.com:9443");
    assert.ok(
      snapshotIndex < opensslIndex &&
        opensslIndex < configIndex &&
        configIndex < buildIndex &&
        buildIndex < upIndex &&
        upIndex < probeIndex,
      "snapshot, identity, binding verification, and start must be ordered; endpoint identity probe must follow start",
    );

    const checkStatuses = Object.entries(result.report.checks).map(([name, entry]) => `${name}:${entry.status}`);
    assert.deepEqual(checkStatuses, [
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

    const evidence = JSON.parse(await readFile(join(config.workdir, "evidence.json"), "utf8"));
    assert.equal(evidence.promotionEvaluated, true);
    assert.equal(evidence.baseline.image, config.baselineImage);
    assert.equal(evidence.baseline.dshVersion, config.baselineDshVersion);
    assert.equal(evidence.candidate.image, config.candidateImage);
    assert.equal(evidence.snapshot.failure, null);

    const reportFromDisk = JSON.parse(await readFile(join(config.workdir, "report.json"), "utf8"));
    assert.equal(reportFromDisk.promotionReadiness.outcome, PROMOTION_OUTCOMES.eligible);
  });
});

test("the snapshot request carries the data version and the candidate version separately", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir), {
      baselineDshVersion: "0.1.0-rc.1",
      dshVersion: "0.1.1-rc.2",
    });
    const { snapshotEvents, runCommand, fetchPage, snapshotHook, tlsProbe } = fakeExecutors(config);
    await runCandidateWorkflow({ config, runCommand, fetchPage, snapshotHook, tlsProbe });

    assert.equal(snapshotEvents.length, 1);
    assert.equal(snapshotEvents[0].dshVersion, "0.1.0-rc.1", "the snapshot records the data-producing version");
    assert.equal(snapshotEvents[0].candidateDshVersion, "0.1.1-rc.2", "the candidate version travels separately");
  });
});

test("every docker command is scoped to the candidate project and both compose files", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { events, runCommand, fetchPage, snapshotHook, tlsProbe } = fakeExecutors(config);
    const seen = [];
    const wrapped = async (file, args, options) => {
      if (file === "docker") seen.push(args);
      return runCommand(file, args, options);
    };
    await runCandidateWorkflow({ config, runCommand: wrapped, fetchPage, snapshotHook, tlsProbe });

    assert.ok(seen.length >= 5);
    for (const args of seen) {
      assert.equal(args[0], "compose");
      assert.ok(args.includes(config.composeFile));
      const projectIndex = args.indexOf("-p");
      assert.equal(args[projectIndex + 1], config.project);
      const isBaseConfigOnly = args.includes("config") && !args.includes(`${config.workdir}/compose.override.yaml`);
      if (!isBaseConfigOnly) {
        assert.ok(args.includes(`${config.workdir}/compose.override.yaml`));
      }
    }
  });
});

test("a required verification failure stops the sequence and marks later checks not_run", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { events, runCommand, fetchPage, snapshotHook, tlsProbe } = fakeExecutors(config, { authCode: 1 });
    const result = await runCandidateWorkflow({ config, runCommand, fetchPage, snapshotHook, tlsProbe });

    assert.equal(result.eligible, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.banner, "CANDIDATE FAILED - NOT ELIGIBLE FOR PROMOTION");
    assert.equal(result.report.checks.authorizationSmoke.status, "fail");
    assert.equal(result.report.checks.sessionResume.status, "not_run");
    assert.equal(result.report.promotionReadiness.outcome, PROMOTION_OUTCOMES.notEligible);
    assert.ok(result.report.promotionReadiness.reasons.includes("authorizationSmoke=fail"));

    const commandKeys = events.filter((event) => event.startsWith("command:")).map((event) => event.slice(8));
    assert.ok(!commandKeys.includes("session"), "checks after a hard failure must not execute");
  });
});

test("a failed production snapshot is persisted and denies promotion even when checks pass", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { runCommand, fetchPage, tlsProbe } = fakeExecutors(config);
    const snapshotHook = async () => ({ ok: false, error: "snapshot hook exited with code 3" });
    const result = await runCandidateWorkflow({ config, runCommand, fetchPage, snapshotHook, tlsProbe });

    assert.equal(result.eligible, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.banner, "CANDIDATE FAILED - NOT ELIGIBLE FOR PROMOTION");
    assert.equal(result.report.snapshot.reference, null);
    assert.ok(result.report.promotionReadiness.reasons.includes("snapshot=snapshot hook exited with code 3"));
    assert.ok(result.report.checks.runtimeReadiness.status !== "not_run");

    const evidence = JSON.parse(await readFile(join(config.workdir, "evidence.json"), "utf8"));
    assert.equal(evidence.snapshot.failure, "snapshot hook exited with code 3");

    const regenerated = createCompatibilityReport(evidence);
    assert.equal(regenerated.promotionReadiness.outcome, PROMOTION_OUTCOMES.notEligible);
    assert.ok(regenerated.promotionReadiness.reasons.includes("snapshot=snapshot hook exited with code 3"));
  });
});

test("a failed candidate build never starts the stack and reports the patch gate", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { events, runCommand, fetchPage, snapshotHook, tlsProbe } = fakeExecutors(config, { buildCode: 1 });
    const result = await runCandidateWorkflow({ config, runCommand, fetchPage, snapshotHook, tlsProbe });

    assert.equal(result.eligible, false);
    assert.equal(result.report.checks.globalPatch.status, "fail");
    assert.equal(result.report.checks.runtimeReadiness.status, "not_run");
    const commandKeys = events.filter((event) => event.startsWith("command:")).map((event) => event.slice(8));
    assert.ok(!commandKeys.includes("up"), "a failed build must not start the candidate stack");
    assert.ok(result.report.promotionReadiness.reasons.includes("globalPatch=fail"));
  });
});

test("a resolved compose configuration that ignores the candidate spec fails closed", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const misbound = resolvedCompose(config, {
      services: {
        dsh: {
          image: config.candidateImage,
          volumes: [{ source: "/srv/dsh-production/data", target: "/data" }],
          ports: [{ target: 9443, published: String(config.candidateHostPort) }],
          environment: { DSH_ORBIT_CANDIDATE_TOKEN: "tokenvalue" },
        },
        [config.gatewayService]: {
          volumes: [
            { source: `${config.workdir}/gateway-identity-cert.pem`, target: config.gatewayCertTarget },
            { source: `${config.workdir}/gateway-identity-key.pem`, target: config.gatewayKeyTarget },
          ],
        },
      },
    });
    const { runCommand, fetchPage, snapshotHook, tlsProbe } = fakeExecutors(config, { resolved: misbound });

    await assert.rejects(
      runCandidateWorkflow({ config, runCommand, fetchPage, snapshotHook, tlsProbe }),
      (error) => error instanceof UpgradeBindingError && /\/data mount/.test(error.message),
    );
    await assert.rejects(
      readFile(join(config.workdir, "report.json"), "utf8"),
      /ENOENT/,
      "a binding failure must not produce a report",
    );
  });
});

test("a running stack without this run's candidate token fails closed", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { runCommand, fetchPage, snapshotHook, tlsProbe } = fakeExecutors(config, { tokenMismatch: true });

    await assert.rejects(
      runCandidateWorkflow({ config, runCommand, fetchPage, snapshotHook, tlsProbe }),
      (error) => error instanceof UpgradeBindingError && /does not carry this run's candidate token/.test(error.message),
    );
  });
});

test("probeCandidateToken verifies the running stack carries the run token", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { runCommand } = fakeExecutors(config);
    const candidateToken = "abcdef1234567890";
    await mkdir(config.workdir, { recursive: true });
    await writeFile(join(config.workdir, "compose.override.yaml"), `services:\n  dsh:\n    environment:\n      DSH_ORBIT_CANDIDATE_TOKEN: "${candidateToken}"\n`, "utf8");
    await probeCandidateToken({ config, candidateToken, runCommand });

    await assert.rejects(
      probeCandidateToken({ config, candidateToken: "wrong", runCommand }),
      UpgradeBindingError,
    );
  });
});

test("a non-loopback published port fails the binding verification", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const misbound = resolvedCompose(config, {
      services: {
        dsh: {
          ...resolvedCompose(config).services.dsh,
          ports: [{ target: 9443, published: String(config.candidateHostPort), host_ip: "0.0.0.0" }],
        },
        [config.gatewayService]: {
          volumes: [
            { source: `${config.workdir}/gateway-identity-cert.pem`, target: config.gatewayCertTarget },
            { source: `${config.workdir}/gateway-identity-key.pem`, target: config.gatewayKeyTarget },
          ],
        },
      },
    });
    const { runCommand, fetchPage, snapshotHook, tlsProbe } = fakeExecutors(config, { resolved: misbound });

    await assert.rejects(
      runCandidateWorkflow({ config, runCommand, fetchPage, snapshotHook, tlsProbe }),
      (error) =>
        error instanceof UpgradeBindingError &&
        /must bind to loopback \(127\.0\.0\.1 or ::1\), got "0\.0\.0\.0"/.test(error.message),
    );
  });
});

test("an endpoint that does not present the per-run gateway certificate fails closed", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { runCommand, fetchPage, snapshotHook, tlsProbe } = fakeExecutors(config, {
      identityFingerprintMismatch: true,
    });

    await assert.rejects(
      runCandidateWorkflow({ config, runCommand, fetchPage, snapshotHook, tlsProbe }),
      (error) =>
        error instanceof UpgradeBindingError &&
        /does not present this run's candidate gateway certificate/.test(error.message),
    );
  });
});

test("loadUpgradeConfig reports missing environment configuration", () => {
  const { missing, config } = loadUpgradeConfig({
    DSH_VERSION: "0.1.1-rc.2",
    DSH_PUBLIC_HOST: "dsh.example.com",
  });
  assert.ok(missing.includes("DSH_CANDIDATE_ORBIT_REVISION (candidate Orbit revision)"));
  assert.ok(missing.includes("DSH_BASELINE_ORBIT_REVISION (production Orbit revision)"));
  assert.ok(missing.includes("DSH_UPGRADE_HOST_PORT (candidate loopback port)"));
  assert.ok(missing.includes("DSH_SNAPSHOT_HOOK (snapshot capability)"));
  assert.equal(config.candidateImage, undefined);
  assert.ok(config.workdir.endsWith(".upgrade-run"));
});
