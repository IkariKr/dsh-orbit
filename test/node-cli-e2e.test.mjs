// SOP Stage 2 Required Live Evidence, child-process form: a REAL hub in
// the parent, separate dsh-orbit-node CLI processes for enroll, then
// status/run on the SAME store. Restart is a true process boundary, not
// a new object in the same process.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { validReport } from "./helpers/registry-fixture.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function runCli({ env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", ...env.args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env.vars },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out; stdout=${stdout} stderr=${stderr}`));
    }, 15000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("child-process enrollment + restart: identity preserved, exactly one Node on the Hub, heartbeat live", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-node-clie2e-"));
  const statePath = join(dir, "state.json");
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Parent runs a REAL loopback Hub.
  const registry = new Registry({ db: openRegistryDatabase(":memory:") });
  const { server } = createHubServer({ registry, options: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    registry.close();
  });

  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const common = {
    DSH_ORBIT_NODE_STATE: statePath,
    DSH_ORBIT_HUB_URL: baseUrl,
    DSH_ORBIT_NODE_ORBIT_VERSION: "0.3.0",
    DSH_ORBIT_NODE_ORBIT_REVISION: "abc123",
    DSH_ORBIT_NODE_DSH_VERSION: "0.1.1-rc.2",
    DSH_ORBIT_NODE_DSH_PROFILE: "dsh-0.1.1-rc.2",
  };

  // Child #1: enroll, then exit.
  const enrolled = await runCli({ env: { args: ["enroll"], vars: { ...common, DSH_ORBIT_ENROLL_TOKEN: plain.token } } });
  assert.equal(enrolled.code, 0, enrolled.stderr);
  const nodeId = enrolled.stdout.match(/enrolled: (node_[0-9a-f]{32})/)?.[1];
  assert.ok(nodeId, `enroll output did not contain a nodeId: ${enrolled.stdout}`);
  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM nodes").get().n, 1, "the Hub must hold exactly one Node");

  // Child #2: status on the SAME store (a real separate process).
  const status = await runCli({ env: { args: ["status"], vars: common } });
  assert.equal(status.code, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.nodeId, nodeId, "restart must preserve the nodeId");
  const statusKeyId = parsed.keyId;

  // Child #3: a short `run` — its heartbeat must be accepted by the Hub
  // and create no second Node.
  const runner = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "run"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...common },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let runStdout = "";
  runner.stdout.on("data", (chunk) => (runStdout += chunk));
  await new Promise((resolve) => setTimeout(resolve, 2600));
  assert.equal(runner.exitCode, null, "run must stay alive");
  assert.match(runStdout, /running against/);
  runner.kill();
  await new Promise((resolve) => runner.once("exit", resolve));

  assert.equal(registry.db.prepare("SELECT COUNT(*) AS n FROM nodes").get().n, 1, "no second enrollment may ever occur");
  const node = registry.getNode(nodeId);
  assert.equal(node.health.registryContact, "fresh", "the run child's heartbeat reached the Hub");
  assert.equal(node.state, "active");
  const storedKeyId = registry.db.prepare("SELECT key_id FROM node_keys WHERE node_id = ? AND state = 'active'").get(nodeId).key_id;
  assert.equal(storedKeyId, statusKeyId, "the keyId must match across processes");

  const reportPath = join(dir, "report.json");
  await writeFile(reportPath, JSON.stringify(validReport()), "utf8");
  const uploaded = await runCli({ env: { args: ["upload-report"], vars: { ...common, DSH_ORBIT_REPORT_FILE: reportPath } } });
  assert.equal(uploaded.code, 0, uploaded.stderr);
  assert.equal(uploaded.stderr, "");
  assert.match(uploaded.stdout, /uploaded: orbitCompatible pass, capabilities 3/);
  assert.equal(registry.getNode(nodeId).health.orbitCompatible, "pass");
  assert.equal(registry.getNode(nodeId).health.dshHealthy, "ok");

  const missingEnv = await runCli({ env: { args: ["upload-report"], vars: common } });
  assert.equal(missingEnv.code, 2);
  assert.match(missingEnv.stderr, /DSH_ORBIT_REPORT_FILE is required/);

  const malformedPath = join(dir, "malformed.json");
  await writeFile(malformedPath, "not-json", "utf8");
  const malformed = await runCli({ env: { args: ["upload-report"], vars: { ...common, DSH_ORBIT_REPORT_FILE: malformedPath } } });
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /report upload failed/);

  const missingPath = join(dir, "missing.json");
  const missing = await runCli({ env: { args: ["upload-report"], vars: { ...common, DSH_ORBIT_REPORT_FILE: missingPath } } });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /report upload failed/);
  assert.match(missing.stderr, /ENOENT|no such file/i);

  registry.deleteNode({ actor: "operator", nodeId, requestId: "ab".repeat(16), reason: "cli-contract" });
  const revoked = await runCli({ env: { args: ["upload-report"], vars: { ...common, DSH_ORBIT_REPORT_FILE: reportPath } } });
  assert.equal(revoked.code, 1);
  assert.match(revoked.stderr, /report upload failed/);
  assert.match(revoked.stderr, /revoked|key-revoked/i);
});
