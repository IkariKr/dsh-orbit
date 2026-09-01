import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function runPatch(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/dsh-orbit-patch.mjs", "--check"], {
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
  await writeFile(
    join(connectionRoot, "index.js"),
    'const DSH_ORBIT_PROXY_HEADER = "x-dsh-orbit-authenticated-proxy";\nconst DSH_ORBIT_PROXY_HOST = "dsh-a.test";\n',
    "utf8",
  );
  await writeFile(join(connectionRoot, "client.js"), 'if (hostname === "dsh-a.test") return true;\n', "utf8");

  const env = { ...process.env };
  delete env.DSH_ORBIT_PATCH_DSH_SSH;
  Object.assign(env, {
    DSH_GLOBAL_ROOT: globalRoot,
    DSH_GLOBAL_CONNECTION_ROOT: connectionRoot,
    DSH_PROFILE_ROOT: join(dir, "missing-profile"),
    DSH_PUBLIC_HOST: "dsh-a.test",
  });
  const result = await runPatch(env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /DSH Orbit dsh-ssh patch: disabled \(set DSH_ORBIT_PATCH_DSH_SSH=1 to enable\)/);
  assert.doesNotMatch(result.stdout, /dsh-ssh verification failed/);
});
