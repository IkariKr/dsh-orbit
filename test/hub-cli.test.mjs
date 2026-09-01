import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const HUB = join(REPO_ROOT, "bin", "dsh-orbit-hub.mjs");

function runHub(env, { stopWhenReady = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HUB], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stopped = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stopWhenReady && !stopped && stdout.includes("registry listening")) {
        stopped = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Hub CLI timed out; stdout=${stdout} stderr=${stderr}`));
    }, 5000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("Hub drill aging flags fail closed unless both controls are present", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-hub-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = {
    DSH_ORBIT_HUB_DB: join(dir, "registry.db"),
    DSH_ORBIT_HUB_PORT: "0",
    DSH_ORBIT_HUB_GATEWAY_SECRET: "test-gateway-secret",
    DSH_ORBIT_HUB_OPERATOR_PRINCIPAL: "operator",
  };

  const pathWithoutFlag = await runHub({ ...base, DSH_ORBIT_HUB_DRILL_AGING_CLOCK: join(dir, "clock.json") });
  assert.equal(pathWithoutFlag.code, 1);
  assert.match(pathWithoutFlag.stderr, /clock requires DSH_ORBIT_HUB_DRILL_AGING=1/);

  const flagWithoutPath = await runHub({ ...base, DSH_ORBIT_HUB_DRILL_AGING: "1" });
  assert.equal(flagWithoutPath.code, 1);
  assert.match(flagWithoutPath.stderr, /DSH_ORBIT_HUB_DRILL_AGING_CLOCK is required/);
});

test("Hub accepts an explicit empty node-scoped aging map in drill mode", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-hub-cli-valid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = join(dir, "clock.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(clock, "{}\n", "utf8");
  const result = await runHub({
    DSH_ORBIT_HUB_DB: join(dir, "registry.db"),
    DSH_ORBIT_HUB_PORT: "0",
    DSH_ORBIT_HUB_GATEWAY_SECRET: "test-gateway-secret",
    DSH_ORBIT_HUB_OPERATOR_PRINCIPAL: "operator",
    DSH_ORBIT_HUB_DRILL_AGING: "1",
    DSH_ORBIT_HUB_DRILL_AGING_CLOCK: clock,
  }, { stopWhenReady: true });
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGTERM");
  assert.match(result.stdout, /registry listening/);
});

test("Hub drill aging rejects missing and malformed clock files before serving", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-hub-cli-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = {
    DSH_ORBIT_HUB_DB: join(dir, "registry.db"),
    DSH_ORBIT_HUB_PORT: "0",
    DSH_ORBIT_HUB_GATEWAY_SECRET: "test-gateway-secret",
    DSH_ORBIT_HUB_OPERATOR_PRINCIPAL: "operator",
    DSH_ORBIT_HUB_DRILL_AGING: "1",
  };
  const missing = await runHub({ ...base, DSH_ORBIT_HUB_DRILL_AGING_CLOCK: join(dir, "missing.json") });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /drill aging clock is unavailable or invalid/);

  const clock = join(dir, "clock.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(clock, "[]\n", "utf8");
  const nonObject = await runHub({ ...base, DSH_ORBIT_HUB_DRILL_AGING_CLOCK: clock });
  assert.equal(nonObject.code, 1);
  assert.match(nonObject.stderr, /nodeId-to-ISO-timestamp object/);

  await writeFile(clock, JSON.stringify({ node_test: "not-a-timestamp" }) + "\n", "utf8");
  const malformedValue = await runHub({ ...base, DSH_ORBIT_HUB_DRILL_AGING_CLOCK: clock });
  assert.equal(malformedValue.code, 1);
  assert.match(malformedValue.stderr, /node_test.*not an ISO timestamp/);
});
