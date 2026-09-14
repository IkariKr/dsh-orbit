import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// A realistic unpatched connection-v1 bundle. The CLI fixture has to be really
// patchable: verification now regenerates the reviewed admission helper and
// requires it byte for byte, so a marker-only stub is no longer a valid tree.
const BUNDLE_SERVER_SOURCE = `import { randomUUID } from "node:crypto";

function header(headers, name) {
\treturn headers[name];
}
function parseAuthority(value) {
\treturn new URL(\`http://\${value}\`);
}
function isLoopbackHostname(hostname) {
\treturn hostname === "localhost" || hostname === "[::1]";
}
function isTrustedAuthority() {
\treturn false;
}
function isTrustedApiRequest(request, trustedHosts) {
\tconst host = header(request.headers, "host");
\tif (host === void 0) return false;
\tconst hostUrl = parseAuthority(host);
\tif (hostUrl === void 0) return false;
\tif (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
\tif (header(request.headers, "sec-fetch-site") === "cross-site") return false;
\treturn true;
}
`;

const BUNDLE_CLIENT_SOURCE = `function isLoopbackHostname(hostname) {
\tif (hostname === "localhost" || hostname === "[::1]") return true;
\treturn false;
}
`;

function runPatch(env, mode = "--check") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/dsh-orbit-patch.mjs", mode], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`patch CLI timed out; stdout=${stdout} stderr=${stderr}`));
    }, 15000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("patch CLI declares SSH_PATCH_ENABLED and keeps dsh-ssh disabled by default", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-patch-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const globalRoot = join(dir, "dsh");
  const connectionRoot = join(globalRoot, "node_modules", "@deepseek-ai", "dsh-client-connection", "lib");
  await mkdir(connectionRoot, { recursive: true });
  await writeFile(join(globalRoot, "package.json"), JSON.stringify({ version: "0.1.1-rc.2" }), "utf8");
  await writeFile(join(connectionRoot, "index.js"), BUNDLE_SERVER_SOURCE, "utf8");
  await writeFile(join(connectionRoot, "client.js"), BUNDLE_CLIENT_SOURCE, "utf8");

  const env = { ...process.env };
  delete env.DSH_ORBIT_PATCH_DSH_SSH;
  Object.assign(env, {
    DSH_GLOBAL_ROOT: globalRoot,
    DSH_GLOBAL_CONNECTION_ROOT: connectionRoot,
    DSH_PROFILE_ROOT: join(dir, "missing-profile"),
    DSH_PUBLIC_HOST: "dsh-a.test",
  });

  const built = await runPatch(env, "--build");
  assert.equal(built.code, 0, built.stderr);
  assert.match(built.stdout, /patched\/patched/);

  const result = await runPatch(env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /DSH Orbit dsh-ssh patch: disabled \(set DSH_ORBIT_PATCH_DSH_SSH=1 to enable\)/);
  assert.doesNotMatch(result.stdout, /dsh-ssh verification failed/);
});

test("runtime patch defaults to DSH_HOME's shared profile workspace", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-patch-cli-profile-root-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const globalRoot = join(dir, "dsh");
  const globalConnectionRoot = join(globalRoot, "node_modules", "@deepseek-ai", "dsh-client-connection", "lib");
  const dshHome = join(dir, "home");
  const profileConnectionRoot = join(
    dshHome,
    "profiles",
    "node_modules",
    "@deepseek-ai",
    "dsh-client-connection",
    "lib",
  );
  await mkdir(globalConnectionRoot, { recursive: true });
  await mkdir(profileConnectionRoot, { recursive: true });
  await writeFile(join(globalRoot, "package.json"), JSON.stringify({ version: "0.1.1-rc.2" }), "utf8");
  for (const root of [globalConnectionRoot, profileConnectionRoot]) {
    await writeFile(join(root, "index.js"), BUNDLE_SERVER_SOURCE, "utf8");
    await writeFile(join(root, "client.js"), BUNDLE_CLIENT_SOURCE, "utf8");
  }

  const env = { ...process.env };
  delete env.DSH_ORBIT_PATCH_DSH_SSH;
  delete env.DSH_PROFILE_CONNECTION_ROOT;
  Object.assign(env, {
    DSH_HOME: dshHome,
    DSH_GLOBAL_ROOT: globalRoot,
    DSH_GLOBAL_CONNECTION_ROOT: globalConnectionRoot,
    DSH_PROFILE_ROOT: join(dshHome, "profiles", "web"),
    DSH_PUBLIC_HOST: "dsh-a.test",
  });

  const result = await runPatch(env, "--runtime");
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout.replaceAll("\\", "/"),
    new RegExp(profileConnectionRoot.replaceAll("\\", "/").replaceAll("/", "\\/")),
  );
  assert.match(result.stdout, /patched\/patched/);
});

test("patch CLI refuses a patched tree whose admission helper was tampered", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-patch-cli-tamper-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const globalRoot = join(dir, "dsh");
  const connectionRoot = join(globalRoot, "node_modules", "@deepseek-ai", "dsh-client-connection", "lib");
  await mkdir(connectionRoot, { recursive: true });
  await writeFile(join(globalRoot, "package.json"), JSON.stringify({ version: "0.1.1-rc.2" }), "utf8");
  await writeFile(join(connectionRoot, "index.js"), BUNDLE_SERVER_SOURCE, "utf8");
  await writeFile(join(connectionRoot, "client.js"), BUNDLE_CLIENT_SOURCE, "utf8");

  const env = { ...process.env };
  delete env.DSH_ORBIT_PATCH_DSH_SSH;
  Object.assign(env, {
    DSH_GLOBAL_ROOT: globalRoot,
    DSH_GLOBAL_CONNECTION_ROOT: connectionRoot,
    DSH_PROFILE_ROOT: join(dir, "missing-profile"),
    DSH_PUBLIC_HOST: "dsh-a.test",
  });

  const built = await runPatch(env, "--build");
  assert.equal(built.code, 0, built.stderr);

  // Drop the shared-secret comparison: the helper still parses and the marker
  // still exists, so only exact-semantics verification can catch this.
  const patched = await readFile(join(connectionRoot, "index.js"), "utf8");
  const tampered = patched.replace(
    "\tif (header(request.headers, DSH_ORBIT_PROXY_HEADER) !== dshOrbitProxySecret) return false;\n",
    "",
  );
  assert.notEqual(tampered, patched);
  await writeFile(join(connectionRoot, "index.js"), tampered, "utf8");

  const result = await runPatch(env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Orbit admission helper mismatch/);
});
