// Shared harness for the Stage 9 DSH 0.1.5-rc.2 acceptances.
//
// Identity is pinned, not inferred: the checked-out version and Git commit are
// asserted rather than assumed, so a checkout that drifted cannot silently
// produce Stage 9 evidence. A configured-but-missing root fails closed instead
// of falling back to a machine-specific default path.
//
// Nothing here mutates the upstream checkout. The process acceptance patches the
// bundle copy inside its own temporary DSH_HOME, which is deleted on teardown.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DSH_015_VERSION = "0.1.5-rc.2";
export const DSH_015_COMMIT = "fb2c4b9e698e30edb738bca4cf0618587db7d203";
export const DSH_015_TAG = "dsh-v0.1.5-rc.2";

export const DSH_015_ROOT_ENV = "DSH_015_ACCEPTANCE_ROOT";

/**
 * Resolve the DSH 0.1.5-rc.2 checkout.
 * @returns the configured checkout path, or null when the acceptance is not configured.
 */
export function resolveDsh015Checkout() {
  const envPath = process.env[DSH_015_ROOT_ENV];
  if (!envPath) return null;
  if (!existsSync(envPath)) {
    throw new Error(`${DSH_015_ROOT_ENV} is configured as ${envPath}, but the directory does not exist`);
  }
  return envPath;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

/**
 * Assert the checkout is the exact reviewed upstream identity.
 * @param dshRoot - resolved checkout root.
 * @returns the pinned identity facts for evidence.
 */
export function assertDsh015Identity(dshRoot) {
  const manifestPath = join(dshRoot, "package.json");
  assert.ok(existsSync(manifestPath), `DSH checkout at ${dshRoot} does not contain package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.version, DSH_015_VERSION, "target upstream version must be pinned");

  const head = git(dshRoot, ["rev-parse", "HEAD"]);
  assert.equal(head, DSH_015_COMMIT, "target upstream commit must be pinned");

  const tagCommit = git(dshRoot, ["rev-parse", `${DSH_015_TAG}^{commit}`]);
  assert.equal(tagCommit, DSH_015_COMMIT, `${DSH_015_TAG} must point at the pinned commit`);

  // No tracked file may be modified: the acceptance never writes into the
  // checkout, so a modified tracked file means the artifact under test is not
  // the reviewed one. Untracked scratch files do not affect the build artifact.
  const dirty = git(dshRoot, ["status", "--porcelain", "--untracked-files=no"]);
  assert.equal(dirty, "", `DSH checkout has modified tracked files:\n${dirty}`);

  const binFile = join(dshRoot, "apps/cli/lib/bin.js");
  assert.ok(
    existsSync(binFile),
    `DSH checkout at ${dshRoot} has no built CLI artifacts (missing ${binFile}); build the DSH checkout first`,
  );

  return { version: DSH_015_VERSION, commitSha: DSH_015_COMMIT, tag: DSH_015_TAG, versionBanner: manifest.version };
}

/** Absolute path of the connection bundle a booted profile resolves. */
export function profileConnectionRoot(dshHome) {
  return join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh-client-connection", "lib");
}

/**
 * The bundle a booted profile actually loads. The profile's `node_modules` entry
 * is a symlink into the workspace, so this is also the path the DSH installer
 * links to; `profileConnectionRoot` and this must resolve to the same directory.
 */
export function builtConnectionRoot(dshRoot) {
  return join(dshRoot, "packages", "client", "connection", "lib");
}

const BUNDLE_FILES = Object.freeze(["index.js", "client.js"]);

/** Read both bundle files as raw bytes so a restore cannot re-encode them. */
export function readBundleBytes(bundleDir) {
  return Object.fromEntries(BUNDLE_FILES.map((file) => [file, readFileSync(join(bundleDir, file))]));
}

/** Write saved bytes back, restoring the exact pre-patch artifact. */
export function restoreBundleBytes(bundleDir, bytes) {
  for (const file of BUNDLE_FILES) writeFileSync(join(bundleDir, file), bytes[file]);
}

/**
 * The built bundle must be pristine before the acceptance patches it. A leftover
 * patch means the artifact under test is not the reviewed upstream build, and a
 * silently re-patched tree would make the teardown restore the patched bytes.
 */
export function assertPristineBundle(bundleDir) {
  for (const file of BUNDLE_FILES) {
    const text = readFileSync(join(bundleDir, file), "utf8");
    assert.ok(
      !text.includes("DSH_ORBIT") && !text.includes("isDshOrbitAuthenticatedProxyRequest"),
      `${join(bundleDir, file)} already carries an Orbit patch; restore the built bundle before running this acceptance`,
    );
  }
}

/**
 * The profile resolves the connection package through a symlink into the
 * workspace, so a booted process loads the built workspace artifact. Proving the
 * linkage keeps the teardown honest: that is the directory that must be restored.
 */
export function assertProfileLinksToBuiltBundle(dshHome, dshRoot) {
  const linked = realpathSync(profileConnectionRoot(dshHome));
  const built = realpathSync(builtConnectionRoot(dshRoot));
  assert.equal(
    linked,
    built,
    "the booted profile must load the workspace connection bundle, so the tested artifact is the restored one",
  );
  return linked;
}

const LAUNCH_URL_PATTERN = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/;

/**
 * Boot a real `dsh web` process on an isolated DSH_HOME and wait for its
 * launch URL.
 * @param options - checkout root, home directory, trusted authorities, timeout.
 * @returns the live process handle with its port and launch token.
 */
export async function startDshWeb({ dshRoot, dshHome, trustedHosts = [], timeoutMs = 120000 }) {
  const bin = join(dshRoot, "apps/cli/lib/bin.js");
  const args = [bin, "web", "--no-open", "--host", "127.0.0.1", "--port", "0"];
  if (trustedHosts.length > 0) args.push("--trusted-host", ...trustedHosts);

  const child = spawn(process.execPath, args, {
    cwd: dshRoot,
    env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: "1", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  const started = Date.now();

  const handle = {
    child,
    port: null,
    launchToken: null,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    get bootMs() { return Date.now() - started; },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
        timer.unref();
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
      });
    },
  };

  await new Promise((resolve, reject) => {
    const fail = (message) => reject(new Error(`${message}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    const timer = setTimeout(() => fail(`dsh web did not report a launch URL within ${timeoutMs}ms`), timeoutMs);
    timer.unref();
    const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = LAUNCH_URL_PATTERN.exec(stdout);
      if (match) {
        handle.port = Number(match[1]);
        handle.launchToken = match[2];
        settle(resolve)(handle);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", settle((code) => fail(`dsh web exited early with code ${code}`)));
    child.once("error", settle((error) => fail(`dsh web failed to spawn: ${error.message}`)));
  });

  return handle;
}
