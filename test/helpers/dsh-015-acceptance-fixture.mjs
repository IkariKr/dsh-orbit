// Shared harness for the Stage 9 DSH 0.1.5-rc.2 acceptances.
//
// Identity is pinned, not inferred: the checked-out version, Git commit, and tag
// are asserted rather than assumed, so a checkout that drifted cannot silently
// produce Stage 9 evidence. A configured-but-missing root fails closed instead
// of falling back to a machine-specific default path.
//
// The profile links the connection package into the workspace, so the tested
// artifact is the checkout's built bundle. This module reads its bytes, and the
// process acceptance restores them in teardown; no tracked file is written.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, realpathSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const DSH_015_VERSION = "0.1.5-rc.2";
export const DSH_015_COMMIT = "fb2c4b9e698e30edb738bca4cf0618587db7d203";
export const DSH_015_TAG = "dsh-v0.1.5-rc.2";

// Reviewed SHA-256 of the gitignored build artifacts that actually run. A
// correct HEAD and tag do not by themselves prove the built files came from that
// commit, so the acceptance pins the artifacts it loads. The v0.4 baseline
// already bound its CLI digest this way; v0.4.1 must not lower that bar.
export const DSH_015_BUILD_ARTIFACTS = Object.freeze({
  "apps/cli/lib/bin.js": "0ff7f1d72c4e0cbe14001709c81e20a04b70464118a7f78568952988e28f2ac5",
  "packages/client/connection/lib/index.js": "bbe7c9aa6d82a7a4ec657aa8bc51064e12bb091be0465526d0b9f5e031f540f7",
  "packages/client/connection/lib/client.js": "319cc46762af6ccb7ac74c9bab37ab8377be212dad9de4dba1f892b7e5b4d8a1",
  "packages/api/gateway/lib/index.js": "ee3b7ee01e87638813d0f304a8f7527d79e8e42990247116fa67086eb268e699",
});

export const DSH_015_ROOT_ENV = "DSH_015_ACCEPTANCE_ROOT";

/** SHA-256 of one file, lowercase hex. */
export function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Assert every pinned build artifact still carries its reviewed digest. This runs
 * before the patch and again after the restore, so a drifted or unrecovered
 * build cannot pass unnoticed.
 * @param dshRoot - resolved checkout root.
 * @returns the measured digests, for evidence.
 */
export function assertBuildArtifacts(dshRoot) {
  const measured = {};
  for (const [relative, expected] of Object.entries(DSH_015_BUILD_ARTIFACTS)) {
    const path = join(dshRoot, relative);
    assert.ok(existsSync(path), `pinned build artifact is missing: ${relative}`);
    measured[relative] = fileSha256(path);
    assert.equal(
      measured[relative],
      expected,
      `${relative} does not match the reviewed artifact digest; rebuild the pinned checkout`,
    );
  }
  return measured;
}

// Minimal child environment. Acceptance evidence must not be influenced by an
// operator's DSH_*, DEEPSEEK_*, NODE_OPTIONS, NODE_PATH, or TSX_* leftovers, so
// only the variables a booted Node process needs on this platform are inherited.
const INHERITED_ENV_ALLOWLIST = Object.freeze([
  "PATH", "PATHEXT", "COMSPEC", "SystemRoot", "windir", "SystemDrive",
  "TEMP", "TMP", "TMPDIR",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS",
  "HOME", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ",
]);

/**
 * Build the child process environment from an explicit allowlist.
 * @param extra - variables this acceptance adds deliberately.
 * @param source - the environment to read from; defaults to the current process.
 * @returns the sanitized environment.
 */
export function sanitizedEnv(extra = {}, source = process.env) {
  const env = {};
  for (const name of INHERITED_ENV_ALLOWLIST) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return { ...env, ...extra };
}

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

  // No tracked source file may be modified: a modified tracked file means the
  // build artifacts under test may not correspond to the pinned commit.
  // Untracked and ignored paths (including the gitignored build output that the
  // acceptance patches and restores) are outside this check and are handled by
  // the bundle save/restore instead.
  const dirty = git(dshRoot, ["status", "--porcelain", "--untracked-files=no"]);
  assert.equal(dirty, "", `DSH checkout has modified tracked files:\n${dirty}`);

  const binFile = join(dshRoot, "apps/cli/lib/bin.js");
  assert.ok(
    existsSync(binFile),
    `DSH checkout at ${dshRoot} has no built CLI artifacts (missing ${binFile}); build the DSH checkout first`,
  );

  // Pin what actually executes, not just what Git says.
  const buildArtifacts = assertBuildArtifacts(dshRoot);

  return {
    version: DSH_015_VERSION,
    commitSha: DSH_015_COMMIT,
    tag: DSH_015_TAG,
    versionBanner: manifest.version,
    buildArtifacts,
  };
}

/** Absolute path of the connection bundle a booted profile resolves. */
export function profileConnectionRoot(dshHome) {
  return join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh-client-connection", "lib");
}

const LOCK_TIMEOUT_MS = 10 * 60_000;
const LOCK_STALE_MS = 15 * 60_000;

/**
 * Serialize the 0.1.5-rc.2 acceptances that touch the built bundle. The test
 * runner executes files concurrently, and more than one acceptance patches the
 * same gitignored build artifact in place; without the lock, one file's
 * identity assertion can observe another file's patched bytes. A lock left by
 * a crashed run is broken after the stale window, never silently ignored.
 * @param dshRoot - resolved checkout root.
 * @returns the lock path to pass to `releaseDsh015AcceptanceLock`.
 */
export async function acquireDsh015AcceptanceLock(dshRoot) {
  const lockPath = join(dshRoot, "packages", "client", "connection", ".stage9-acceptance.lock");
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      closeSync(fd);
      return lockPath;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // The lock vanished between the probe and the stat; retry.
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(
          `another Stage 9 acceptance still holds ${lockPath}; the 0.1.5-rc.2 acceptances ` +
            "must patch the built bundle one at a time",
        );
      }
      await sleep(500);
    }
  }
}

/** Release the acceptance lock; a missing lock is not an error. */
export function releaseDsh015AcceptanceLock(lockPath) {
  if (!lockPath) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // Another holder released it first, or the stale breaker removed it.
  }
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
    env: sanitizedEnv({ DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: "1", NO_COLOR: "1" }),
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
