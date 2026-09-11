import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { GATEWAY_CERT_PEM, GATEWAY_KEY_PEM } from "./fixtures/gateway-identity.mjs";
import {
  generateComposeOverride,
  UpgradeBindingError,
  loadUpgradeConfig,
  preflight,
  probeCandidateToken,
  runCandidateWorkflow,
  verifyResolvedComposeConfig,
} from "../src/upgrade-runner.mjs";
import {
  COMPATIBILITY_OUTCOMES,
  PROMOTION_OUTCOMES,
  createCompatibilityReport,
} from "../src/compatibility-report.mjs";


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
    sshPatchEnabled: true,
    sshPluginRoot: "/opt/dsh-orbit/plugins",
    sshPluginVersion: "0.3.2",
    snapshotHook: "/opt/dsh-orbit/hooks/snapshot.sh",
    snapshotTimeoutSeconds: 900,
    gatewayService: "caddy",
    gatewayCertTarget: "/run/certs/fullchain.pem",
    gatewayKeyTarget: "/run/certs/privkey.pem",
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
        user: "10001:10001",
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

function fakeExecutors(config, { buildCode = 0, upCode = 0, authCode = 0, sessionCode = 0, terminalCode = 0, settingsMutateOk = true, resolved = null, tokenMismatch = false, identityFingerprintMismatch = false } = {}) {
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
        // the base compose file is fixed in reality: its gateway certificate
        // mounts stay at the public example paths regardless of operator env
        const gatewayVolumes = [
          { source: "/srv/certs/fullchain.pem", target: "/run/certs/fullchain.pem" },
          { source: "/srv/certs/privkey.pem", target: "/run/certs/privkey.pem" },
        ];
        if (merged) {
          gatewayVolumes[0].source = `${config.workdir}/gateway-identity-cert.pem`;
          gatewayVolumes[1].source = `${config.workdir}/gateway-identity-key.pem`;
        }
        const resolvedConfig =
          resolved ??
          resolvedCompose(config, {
            services: {
              dsh: resolvedCompose(config).services.dsh,
              [config.gatewayService]: { user: "1000:1000", volumes: gatewayVolumes },
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
    if (script.includes("smoke-websocket")) {
      events.push("command:websocket");
      return {
        code: 0,
        stdout: "webSocketTransport: pass (WebSocket 101 upgrade handshake successful)\n",
        stderr: "",
      };
    }
    if (script.includes("smoke-terminal")) {
      events.push("command:terminal");
      return {
        code: terminalCode,
        stdout: "",
        stderr: terminalCode === 0 ? "" : "FAIL unauthenticated terminal upgrade: expected denied, got allowed",
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
      "websocket",
      "terminal",
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
      "webSocketTransport:pass",
      "terminalFence:pass",
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

test("patch verification rejects a mismatched reported DSH upstream version", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    const { runCommand, fetchPage, snapshotHook, tlsProbe } = fakeExecutors(config);
    const mismatched = async (file, args, options) => {
      const result = await runCommand(file, args, options);
      if (file === "docker" && args.includes("--check")) {
        return { ...result, stdout: result.stdout.replace("DSH upstream: 0.1.1-rc.2", "DSH upstream: 9.9.9") };
      }
      return result;
    };
    const result = await runCandidateWorkflow({ config, runCommand: mismatched, fetchPage, snapshotHook, tlsProbe });
    assert.equal(result.report.checks.globalPatch.status, "fail");
    assert.match(result.report.checks.globalPatch.detail, /reported DSH upstream/);
    assert.equal(result.report.checks.profilePatch.status, "pass");
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

test("numeric zero uid formatting fails the binding verification", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir));
    for (const user of ["0:10001", "00:10001", "000:10001", "000000000000000000000:10001", "10001:10001x"]) {
      const resolved = resolvedCompose(config, {
        services: {
          dsh: {
            ...resolvedCompose(config).services.dsh,
            user,
          },
          [config.gatewayService]: {
            user: "1000:1000",
            volumes: [
              { source: `${config.workdir}/gateway-identity-cert.pem`, target: config.gatewayCertTarget },
              { source: `${config.workdir}/gateway-identity-key.pem`, target: config.gatewayKeyTarget },
            ],
          },
        },
      });
      assert.throws(
        () => verifyResolvedComposeConfig(resolved, config, {
          certPath: `${config.workdir}/gateway-identity-cert.pem`,
          keyPath: `${config.workdir}/gateway-identity-key.pem`,
        }),
        (error) => error instanceof UpgradeBindingError && /explicit non-root uid:gid/.test(error.message),
        `must reject ${user}`,
      );
    }

    const gatewayZero = resolvedCompose(config, {
      services: {
        dsh: resolvedCompose(config).services.dsh,
        [config.gatewayService]: {
          user: "00:1000",
          volumes: [
            { source: `${config.workdir}/gateway-identity-cert.pem`, target: config.gatewayCertTarget },
            { source: `${config.workdir}/gateway-identity-key.pem`, target: config.gatewayKeyTarget },
          ],
        },
      },
    });
    assert.throws(
      () => verifyResolvedComposeConfig(gatewayZero, config, {
        certPath: `${config.workdir}/gateway-identity-cert.pem`,
        keyPath: `${config.workdir}/gateway-identity-key.pem`,
      }),
      (error) => error instanceof UpgradeBindingError && /caddy service must use an explicit non-root uid:gid/.test(error.message),
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

test("runner gateway certificate defaults match the public compose example", async () => {
  const { readFile: readExample } = await import("node:fs/promises");
  const examplePath = fileURLToPath(new URL("../docker/compose.example.yaml", import.meta.url));
  const example = await readExample(examplePath, "utf8");
  const certLine = example.split("\n").find((line) => line.includes("fullchain.pem:/"));
  const keyLine = example.split("\n").find((line) => line.includes("privkey.pem:/"));
  assert.ok(certLine && keyLine, "the public compose example mounts gateway certificates");

  const { config } = loadUpgradeConfig({});
  const certTarget = certLine.split(":").slice(-2)[0].trim();
  const keyTarget = keyLine.split(":").slice(-2)[0].trim();
  assert.equal(config.gatewayCertTarget, certTarget);
  assert.equal(config.gatewayKeyTarget, keyTarget);
  assert.equal(config.gatewayService, "caddy");
});

test("the base gateway service must already mount a certificate at the configured target", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir), {
      gatewayCertTarget: "/nowhere/fullchain.pem",
    });
    const { events, runCommand, fetchPage, snapshotHook, tlsProbe } = fakeExecutors(config);

    await assert.rejects(
      runCandidateWorkflow({ config, runCommand, fetchPage, snapshotHook, tlsProbe }),
      (error) =>
        error instanceof UpgradeBindingError &&
        /mounts no certificate at "\/nowhere\/fullchain\.pem"/.test(error.message),
    );
    const commandKeys = events.filter((event) => event.startsWith("command:")).map((event) => event.slice(8));
    assert.ok(!commandKeys.includes("build"), "a misconfigured gateway target must fail before the build");
  });
});

test("the terminal fence smoke is gated by the patch enable flag", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir), { sshPatchEnabled: false });
    const { events, runCommand, fetchPage, snapshotHook, tlsProbe } = fakeExecutors(config);
    const result = await runCandidateWorkflow({ config, runCommand, fetchPage, snapshotHook, tlsProbe });

    assert.equal(result.report.checks.terminalFence.status, "not_run", "disabled patch must not run the fence smoke");
    assert.equal(result.report.checks.terminalPtty.status, "not_run");
    assert.equal(result.report.promotionReadiness.outcome, PROMOTION_OUTCOMES.eligible, "not_run must not block eligibility");
    const commandKeys = events.filter((event) => event.startsWith("command:")).map((event) => event.slice(8));
    assert.ok(!commandKeys.includes("terminal"), "no terminal command may run when the patch is disabled");
  });
});

test("a failed terminal fence blocks promotion when the patch is enabled", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir), { sshPatchEnabled: true });
    const { runCommand, fetchPage, snapshotHook, tlsProbe } = fakeExecutors(config, { terminalCode: 1 });
    const result = await runCandidateWorkflow({ config, runCommand, fetchPage, snapshotHook, tlsProbe });

    assert.equal(result.report.checks.terminalFence.status, "fail");
    assert.equal(result.report.checks.terminalPtty.status, "not_run");
    assert.equal(result.report.promotionReadiness.outcome, PROMOTION_OUTCOMES.notEligible);
    assert.ok(result.report.promotionReadiness.reasons.includes("terminalFence=fail"));
  });
});

test("the candidate override propagates the ssh plugin root and version with the patch flag", async () => {
  await withTempDir(async (dir) => {
    const config = fixtureConfig(workdir(dir), {
      sshPluginRoot: "/opt/plugins/dsh-ssh",
      sshPluginVersion: "0.3.2",
    });
    await mkdir(config.workdir, { recursive: true });
    const override = generateComposeOverride(config, "abc123def4567890", null);
    assert.ok(override.includes('DSH_ORBIT_PATCH_DSH_SSH: "1"'));
    assert.ok(override.includes('DSH_SSH_PLUGIN_ROOT: "/opt/plugins/dsh-ssh"'));
    assert.ok(override.includes('DSH_SSH_PLUGIN_VERSION: "0.3.2"'));

    const disabled = generateComposeOverride(
      { ...config, sshPatchEnabled: false },
      "abc123def4567890",
      null,
    );
    assert.ok(!disabled.includes("DSH_ORBIT_PATCH_DSH_SSH"));
    assert.ok(!disabled.includes("DSH_SSH_PLUGIN_ROOT"));

    const bare = generateComposeOverride(
      { ...config, sshPatchEnabled: true, sshPluginRoot: null, sshPluginVersion: null },
      "abc123def4567890",
      null,
    );
    assert.ok(bare.includes('DSH_ORBIT_PATCH_DSH_SSH: "1"'));
    assert.ok(!bare.includes("DSH_SSH_PLUGIN_ROOT"));
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
