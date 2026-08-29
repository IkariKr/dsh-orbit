import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { randomUUID, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import tls from "node:tls";

import { compatibilityFor } from "./compatibility.mjs";
import { validateHost } from "./remote-settings-patch.mjs";
import { runSnapshotHook } from "./snapshot-contract.mjs";
import {
  COMPATIBILITY_OUTCOMES,
  PROMOTION_OUTCOMES,
  createCompatibilityReport,
  renderReportJson,
  renderReportText,
} from "./compatibility-report.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const SMOKE_SETTINGS = fileURLToPath(new URL("../scripts/smoke-settings.mjs", import.meta.url));
const SMOKE_AUTH = fileURLToPath(new URL("../scripts/smoke-auth.mjs", import.meta.url));
const SMOKE_SESSION = fileURLToPath(new URL("../scripts/smoke-session-resume.mjs", import.meta.url));
const PATCHER = "/usr/local/lib/dsh-orbit/bin/dsh-orbit-patch.mjs";
const CANDIDATE_TOKEN_ENV = "DSH_ORBIT_CANDIDATE_TOKEN";

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

export class UpgradeBindingError extends Error {}

function quoteYaml(value) {
  return JSON.stringify(String(value));
}

export function generateComposeOverride(config, candidateToken, gatewayIdentity = null) {
  const lines = [
    "services:",
    "  dsh:",
    `    image: ${quoteYaml(config.candidateImage)}`,
    "    environment:",
    `      ${CANDIDATE_TOKEN_ENV}: ${quoteYaml(candidateToken)}`,
    "    volumes:",
    `      - ${quoteYaml(`${config.candidateDataRoot}:/data:rw`)}`,
    `      - ${quoteYaml(`${config.candidateWorkspaceRoot}:/workspace:rw`)}`,
    "    ports:",
    `      - ${quoteYaml(`127.0.0.1:${config.candidateHostPort}:9443`)}`,
  ];
  if (gatewayIdentity) {
    lines.push(
      `  ${config.gatewayService}:`,
      "    volumes:",
      `      - ${quoteYaml(`${gatewayIdentity.certPath}:${config.gatewayCertTarget}:ro`)}`,
      `      - ${quoteYaml(`${gatewayIdentity.keyPath}:${config.gatewayKeyTarget}:ro`)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function resolvedPortOf(entry) {
  const published = entry?.published ?? entry?.Published ?? "";
  return String(published).split(":").pop();
}

function resolvedSourceOf(volume) {
  return volume?.source ?? volume?.Source ?? "";
}

function resolvedTargetOf(volume) {
  return volume?.target ?? volume?.Destination ?? "";
}

export function verifyResolvedComposeConfig(resolved, config, gatewayIdentity = null) {
  const problems = [];
  if (resolved?.name !== config.project) {
    problems.push(`resolved project name ${JSON.stringify(resolved?.name)} is not ${JSON.stringify(config.project)}`);
  }
  const dsh = resolved?.services?.dsh;
  if (!dsh) {
    problems.push("resolved configuration has no dsh service");
    throw new UpgradeBindingError(`candidate compose binding verification failed: ${problems.join("; ")}`);
  }
  if (dsh.image !== config.candidateImage) {
    problems.push(`resolved image ${JSON.stringify(dsh.image)} is not the candidate image ${JSON.stringify(config.candidateImage)}`);
  }
  const volumes = dsh.volumes ?? [];
  const dataVolume = volumes.find((volume) => resolvedTargetOf(volume) === "/data");
  if (!dataVolume || resolvedSourceOf(dataVolume) !== config.candidateDataRoot) {
    problems.push(
      `resolved /data mount ${JSON.stringify(dataVolume ? resolvedSourceOf(dataVolume) : null)}` +
        ` is not the candidate data root ${JSON.stringify(config.candidateDataRoot)}`,
    );
  }
  const workspaceVolume = volumes.find((volume) => resolvedTargetOf(volume) === "/workspace");
  if (!workspaceVolume || resolvedSourceOf(workspaceVolume) !== config.candidateWorkspaceRoot) {
    problems.push(
      `resolved /workspace mount ${JSON.stringify(workspaceVolume ? resolvedSourceOf(workspaceVolume) : null)}` +
        ` is not the candidate workspace root ${JSON.stringify(config.candidateWorkspaceRoot)}`,
    );
  }
  const port = (dsh.ports ?? []).find((entry) => String(entry?.target) === "9443");
  if (!port) {
    problems.push("resolved configuration publishes no 9443 port");
  } else {
    const publishedPort = resolvedPortOf(port);
    if (publishedPort !== String(config.candidateHostPort)) {
      problems.push(
        `resolved published port ${JSON.stringify(publishedPort)} is not the candidate port ${JSON.stringify(String(config.candidateHostPort))}`,
      );
    }
    const hostIp = port?.host_ip ?? port?.HostIp ?? "";
    if (!["127.0.0.1", "::1"].includes(String(hostIp))) {
      problems.push(
        `resolved published port must bind to loopback (127.0.0.1 or ::1), got ${JSON.stringify(hostIp || "all interfaces")}`,
      );
    }
  }
  const environment = dsh.environment ?? {};
  if (environment[CANDIDATE_TOKEN_ENV] !== undefined) {
    const tokenValue =
      typeof environment[CANDIDATE_TOKEN_ENV] === "string"
        ? environment[CANDIDATE_TOKEN_ENV]
        : environment[CANDIDATE_TOKEN_ENV]?.value;
    if (tokenValue === undefined || tokenValue === "") {
      problems.push(`resolved configuration does not set ${CANDIDATE_TOKEN_ENV}`);
    }
  } else {
    problems.push(`resolved configuration does not set ${CANDIDATE_TOKEN_ENV}`);
  }
  if (gatewayIdentity) {
    const gateway = resolved?.services?.[config.gatewayService];
    if (!gateway) {
      problems.push(`resolved configuration has no ${config.gatewayService} service`);
    } else {
      const gatewayVolumes = gateway.volumes ?? [];
      for (const [target, source] of [
        [config.gatewayCertTarget, gatewayIdentity.certPath],
        [config.gatewayKeyTarget, gatewayIdentity.keyPath],
      ]) {
        const mount = gatewayVolumes.find((volume) => resolvedTargetOf(volume) === target);
        if (!mount || resolvedSourceOf(mount) !== source) {
          problems.push(
            `resolved gateway mount ${JSON.stringify(mount ? resolvedSourceOf(mount) : null)} for ${target}` +
              ` is not the per-run identity file ${JSON.stringify(source)}`,
          );
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new UpgradeBindingError(`candidate compose binding verification failed: ${problems.join("; ")}`);
  }
}

export function loadUpgradeConfig(env) {
  const required = {
    "DSH_VERSION (candidate DSH version)": env.DSH_VERSION,
    "DSH_PUBLIC_HOST (bare public hostname)": env.DSH_PUBLIC_HOST,
    "DSH_CANDIDATE_ORBIT_REVISION (candidate Orbit revision)": env.DSH_CANDIDATE_ORBIT_REVISION,
    "DSH_BASELINE_IMAGE (last known-good image tag)": env.DSH_BASELINE_IMAGE,
    "DSH_BASELINE_ORBIT_REVISION (production Orbit revision)": env.DSH_BASELINE_ORBIT_REVISION,
    "DSH_BASELINE_DSH_VERSION (production DSH version)": env.DSH_BASELINE_DSH_VERSION,
    "DSH_CANDIDATE_IMAGE (candidate image tag)": env.DSH_CANDIDATE_IMAGE,
    "DSH_CANDIDATE_DATA_ROOT (copied candidate data)": env.DSH_CANDIDATE_DATA_ROOT,
    "DSH_CANDIDATE_WORKSPACE_ROOT (copied candidate workspace)": env.DSH_CANDIDATE_WORKSPACE_ROOT,
    "DSH_UPGRADE_HOST_PORT (candidate loopback port)": env.DSH_UPGRADE_HOST_PORT,
    "DSH_DATA_ROOT (production data root)": env.DSH_DATA_ROOT,
    "DSH_SMOKE_URL (candidate endpoint)": env.DSH_SMOKE_URL,
    "DSH_SMOKE_BASIC_USER": env.DSH_SMOKE_BASIC_USER,
    "DSH_SMOKE_BASIC_PASSWORD": env.DSH_SMOKE_BASIC_PASSWORD,
    "DSH_SMOKE_SESSION_ID (historical session)": env.DSH_SMOKE_SESSION_ID,
    "DSH_SNAPSHOT_HOOK (snapshot capability)": env.DSH_SNAPSHOT_HOOK,
  };
  const missing = Object.keys(required).filter((name) => !required[name]);

  return {
    missing,
    config: {
      dshVersion: env.DSH_VERSION,
      orbitRevision: env.DSH_CANDIDATE_ORBIT_REVISION,
      orbitVersion: env.DSH_ORBIT_VERSION ?? "0.2.0-snapshot",
      baselineImage: env.DSH_BASELINE_IMAGE,
      baselineOrbitRevision: env.DSH_BASELINE_ORBIT_REVISION,
      baselineDshVersion: env.DSH_BASELINE_DSH_VERSION,
      candidateImage: env.DSH_CANDIDATE_IMAGE,
      candidateDataRoot: env.DSH_CANDIDATE_DATA_ROOT,
      candidateWorkspaceRoot: env.DSH_CANDIDATE_WORKSPACE_ROOT,
      candidateHostPort: env.DSH_UPGRADE_HOST_PORT ? Number(env.DSH_UPGRADE_HOST_PORT) : null,
      productionDataRoot: env.DSH_DATA_ROOT,
      candidateEndpoint: env.DSH_SMOKE_URL,
      publicHost: env.DSH_PUBLIC_HOST,
      basicUser: env.DSH_SMOKE_BASIC_USER,
      basicPassword: env.DSH_SMOKE_BASIC_PASSWORD,
      smokeOrigin: env.DSH_SMOKE_ORIGIN,
      sessionId: env.DSH_SMOKE_SESSION_ID,
      snapshotHook: env.DSH_SNAPSHOT_HOOK,
      snapshotTimeoutSeconds: Number(env.DSH_SNAPSHOT_TIMEOUT_SECONDS ?? 900),
      gatewayService: env.DSH_UPGRADE_GATEWAY_SERVICE ?? "caddy",
      gatewayCertTarget: env.DSH_UPGRADE_GATEWAY_CERT_TARGET ?? "/etc/caddy/certs/fullchain.pem",
      gatewayKeyTarget: env.DSH_UPGRADE_GATEWAY_KEY_TARGET ?? "/etc/caddy/certs/privkey.pem",
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
  check(
    "candidate-host-port",
    Number.isInteger(config.candidateHostPort) && config.candidateHostPort >= 1 && config.candidateHostPort <= 65535,
    `candidate host port ${JSON.stringify(config.candidateHostPort)} must be an integer between 1 and 65535`,
  );
  check(
    "copied-data-root",
    config.candidateDataRoot !== config.productionDataRoot,
    "the candidate data root must be a copy, not the production data root",
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
  for (const [label, dir] of [
    ["production-data-root", config.productionDataRoot],
    ["candidate-data-root", config.candidateDataRoot],
    ["candidate-workspace-root", config.candidateWorkspaceRoot],
  ]) {
    try {
      await access(dir);
    } catch {
      check(label, false, `${dir} is not available`);
    }
  }
  const endpointHost = new URL(config.candidateEndpoint).hostname;
  if (["127.0.0.1", "localhost", "[::1]"].includes(endpointHost)) {
    const endpointPort = new URL(config.candidateEndpoint).port;
    check(
      "endpoint-binding",
      endpointPort === String(config.candidateHostPort),
      `a loopback candidate endpoint must use the candidate host port ${config.candidateHostPort}` +
        ` (endpoint uses ${endpointPort || "no port"})`,
    );
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

async function defaultFetchPage(url, options = {}) {
  const response = await fetch(url, {
    headers: { connection: "close", ...options.headers },
  });
  const body = await response.text().catch(() => "");
  return { status: response.status, body };
}

function failDetail(output, fallback) {
  const line = (output ?? "").trim().split("\n").find((entry) => entry.trim() !== "");
  return line ?? fallback;
}

function composeArgs(config, ...subcommand) {
  return [
    "compose",
    "-f",
    config.composeFile,
    "-f",
    `${config.workdir}/compose.override.yaml`,
    "-p",
    config.project,
    ...subcommand,
  ];
}

export async function resolveCandidateBinding({ config, runCommand = defaultRunCommand, gatewayIdentity = null }) {
  const base = await runCommand("docker", [
    "compose",
    "-f",
    config.composeFile,
    "-p",
    config.project,
    "config",
    "--format",
    "json",
  ]);
  if (base.code !== 0) {
    throw new UpgradeBindingError(
      `docker compose config failed for the base file: ${failDetail(base.stderr, `exit ${base.code}`)}`,
    );
  }
  let baseConfig;
  try {
    baseConfig = JSON.parse(base.stdout);
  } catch {
    throw new UpgradeBindingError("docker compose config did not return valid JSON for the base file");
  }
  if (!baseConfig?.services?.[config.gatewayService]) {
    throw new UpgradeBindingError(
      `the base compose file defines no ${config.gatewayService} service; the candidate gateway must exist to bind the endpoint identity`,
    );
  }

  const resolved = await runCommand("docker", composeArgs(config, "config", "--format", "json"));
  if (resolved.code !== 0) {
    throw new UpgradeBindingError(
      `docker compose config failed: ${failDetail(resolved.stderr, `exit ${resolved.code}`)}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(resolved.stdout);
  } catch {
    throw new UpgradeBindingError("docker compose config did not return valid JSON");
  }
  verifyResolvedComposeConfig(parsed, config, gatewayIdentity);
}

export async function probeCandidateToken({ config, candidateToken, runCommand = defaultRunCommand }) {
  const probe = await runCommand("docker", composeArgs(config, "exec", "-T", "dsh", "printenv", CANDIDATE_TOKEN_ENV));
  if (probe.code !== 0 || probe.stdout.trim() !== candidateToken) {
    throw new UpgradeBindingError(
      `candidate stack identity mismatch: the running dsh container does not carry this run's candidate token`,
    );
  }
}

export async function generateGatewayIdentityCertificate({ config, runCommand = defaultRunCommand }) {
  const endpoint = new URL(config.candidateEndpoint);
  const host = endpoint.hostname;
  const san = isIP(host) ? `IP:${host}` : `DNS:${host}`;
  const identity = {
    certPath: `${config.workdir}/gateway-identity-cert.pem`,
    keyPath: `${config.workdir}/gateway-identity-key.pem`,
  };
  const generated = await runCommand("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "2",
    "-nodes",
    "-keyout",
    identity.keyPath,
    "-out",
    identity.certPath,
    "-subj",
    `/CN=${host}`,
    "-addext",
    `subjectAltName=${san}`,
  ]);
  if (generated.code !== 0) {
    throw new UpgradeBindingError(
      `could not generate the per-run gateway identity certificate (openssl must be available in the runner environment): ` +
        failDetail(generated.stderr, `exit ${generated.code}`),
    );
  }
  const certificate = new X509Certificate(await readFile(identity.certPath));
  return { ...identity, fingerprint: certificate.fingerprint256 };
}

async function defaultTlsProbe({ host, port, servername }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false }, () => {
      const certificate = socket.getPeerCertificate();
      socket.destroy();
      resolve(certificate?.fingerprint256 ?? null);
    });
    socket.once("error", (error) => {
      socket.destroy();
      reject(new UpgradeBindingError(`gateway certificate probe failed: ${error.message}`));
    });
  });
}

export async function verifyGatewayIdentity({ config, identity, tlsProbe = defaultTlsProbe }) {
  const endpoint = new URL(config.candidateEndpoint);
  const presented = await tlsProbe({
    host: endpoint.hostname,
    port: Number(endpoint.port || 443),
    servername: endpoint.hostname,
  });
  if (presented !== identity.fingerprint) {
    throw new UpgradeBindingError(
      `candidate endpoint identity mismatch: ${config.candidateEndpoint} does not present this run's candidate gateway certificate` +
        ` (presented fingerprint: ${JSON.stringify(presented)}, expected: ${JSON.stringify(identity.fingerprint)})`,
    );
  }
}

export async function runVerificationSequence({
  config,
  runCommand = defaultRunCommand,
  fetchPage = defaultFetchPage,
  identityCaPath = null,
}) {
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
    ...(config.smokeOrigin ? { DSH_SMOKE_ORIGIN: config.smokeOrigin } : {}),
    ...(identityCaPath ? { NODE_EXTRA_CA_CERTS: identityCaPath } : {}),
    ...extra,
  });
  const gatewayHeaders = () => ({
    authorization: `Basic ${Buffer.from(`${config.basicUser}:${config.basicPassword}`).toString("base64")}`,
    "sec-fetch-site": "same-origin",
  });

  const steps = [
    {
      names: ["runtimeReadiness"],
      required: true,
      run: async () => {
        const home = await fetchPage(`${config.candidateEndpoint}/`, { headers: gatewayHeaders() });
        record(
          "runtimeReadiness",
          home.status === 200 ? "pass" : "fail",
          `GET / with authenticated gateway headers -> HTTP ${home.status}`,
        );
      },
    },
    {
      names: ["globalPatch", "profilePatch"],
      required: true,
      run: async () => {
        const patch = await runCommand("docker", composeArgs(config, "exec", "-T", "dsh", "node", PATCHER, "--check"));
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
        const home = await fetchPage(`${config.candidateEndpoint}/`, { headers: gatewayHeaders() });
        const pluginMatch = typeof home.body === "string" ? home.body.match(/src="(\/plugins\/[^"]+)"/) : null;
        if (!pluginMatch) {
          record("webPluginRoutes", "fail", "the web UI references no plugin asset");
          return;
        }
        const asset = await fetchPage(`${config.candidateEndpoint}${pluginMatch[1]}`, {
          headers: gatewayHeaders(),
        });
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

async function finalizeReport({ config, evidence }) {
  const report = createCompatibilityReport(evidence);
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
  tlsProbe = defaultTlsProbe,
}) {
  const evidence = {
    promotionEvaluated: true,
    orbit: { version: config.orbitVersion, revision: config.orbitRevision },
    baseline: {
      image: config.baselineImage,
      orbitRevision: config.baselineOrbitRevision,
      dshVersion: config.baselineDshVersion,
    },
    candidate: {
      dshVersion: config.dshVersion,
      profile: null,
      image: config.candidateImage,
      endpoint: config.candidateEndpoint,
    },
    checks: {},
    snapshot: { reference: null, failure: null },
  };
  try {
    compatibilityFor(config.dshVersion);
    evidence.candidate.profile = config.dshVersion;
  } catch {
    evidence.candidate.profile = null;
  }

  await mkdir(config.workdir, { recursive: true });
  const candidateToken = randomUUID().replaceAll("-", "");

  const snapshot = await snapshotHook({
    hookPath: config.snapshotHook,
    manifestPath: `${config.workdir}/snapshot-manifest.json`,
    snapshotId: `pre-candidate-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
    dataRoot: config.productionDataRoot,
    orbitRevision: config.orbitRevision,
    dshVersion: config.baselineDshVersion,
    candidateDshVersion: config.dshVersion,
    timeoutSeconds: config.snapshotTimeoutSeconds,
  });
  if (snapshot.ok) {
    evidence.snapshot.reference = snapshot.manifest.restoreReference;
  } else {
    evidence.snapshot.failure = snapshot.error;
  }

  const gatewayIdentity = await generateGatewayIdentityCertificate({ config, runCommand });
  evidence.candidate.gatewayIdentityFingerprint = gatewayIdentity.fingerprint;
  await writeFile(
    `${config.workdir}/compose.override.yaml`,
    generateComposeOverride(config, candidateToken, gatewayIdentity),
    "utf8",
  );
  await resolveCandidateBinding({ config, runCommand, gatewayIdentity });

  const build = await runCommand("docker", composeArgs(config, "build"), {
    env: { DSH_VERSION: config.dshVersion, DSH_PUBLIC_HOST: config.publicHost },
  });
  if (build.code !== 0) {
    evidence.checks.globalPatch = {
      status: "fail",
      detail: "candidate build failed: unsupported version, source mismatch, or unverifiable patch",
    };
  } else {
    const up = await runCommand("docker", composeArgs(config, "up", "-d", "--wait"));
    if (up.code !== 0) {
      evidence.checks.runtimeReadiness = {
        status: "fail",
        detail: "candidate stack did not become healthy on the isolated endpoint",
      };
    } else {
      await probeCandidateToken({ config, candidateToken, runCommand });
      await verifyGatewayIdentity({ config, identity: gatewayIdentity, tlsProbe });
      const { checks } = await runVerificationSequence({
        config,
        runCommand,
        fetchPage,
        identityCaPath: gatewayIdentity.certPath,
      });
      evidence.checks = checks;
    }
  }

  const { report, text } = await finalizeReport({ config, evidence });
  const eligible = report.promotionReadiness.outcome === PROMOTION_OUTCOMES.eligible;
  return {
    eligible,
    compatible: report.compatibility.outcome === COMPATIBILITY_OUTCOMES.pass,
    exitCode: eligible ? 0 : 1,
    banner: eligible ? "CANDIDATE PASSED - ELIGIBLE FOR MANUAL PROMOTION" : "CANDIDATE FAILED - NOT ELIGIBLE FOR PROMOTION",
    report,
    text,
  };
}

export async function loadEvidence(workdir) {
  return JSON.parse(await readFile(`${workdir}/evidence.json`, "utf8"));
}
