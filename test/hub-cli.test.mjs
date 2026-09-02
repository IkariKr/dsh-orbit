import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";

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

test("Hub refuses unsupported or malformed persistent databases before serving", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-hub-cli-db-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = {
    DSH_ORBIT_HUB_PORT: "0",
    DSH_ORBIT_HUB_GATEWAY_SECRET: "test-gateway-secret",
    DSH_ORBIT_HUB_OPERATOR_PRINCIPAL: "operator",
  };

  const futurePath = join(dir, "future.db");
  const future = openRegistryDatabase(futurePath);
  future.exec("PRAGMA user_version = 99");
  future.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  future.close();
  const futureResult = await runHub({ ...base, DSH_ORBIT_HUB_DB: futurePath });
  assert.equal(futureResult.code, 1);
  assert.match(futureResult.stderr, /database startup failed \(unsupported-schema\)/);
  assert.doesNotMatch(futureResult.stdout, /registry listening/);

  const corruptPath = join(dir, "corrupt.db");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(corruptPath, "not sqlite", "utf8");
  const corruptResult = await runHub({ ...base, DSH_ORBIT_HUB_DB: corruptPath });
  assert.equal(corruptResult.code, 1);
  assert.match(corruptResult.stderr, /database startup failed/);
  assert.doesNotMatch(corruptResult.stdout, /registry listening/);
});

async function makeCorruptHubDatabase(path, kind) {
  const db = openRegistryDatabase(path);
  const nodeId = "node_" + "a".repeat(32);
  db.prepare("INSERT INTO nodes (node_id, state, minted_at, authenticated) VALUES (?, 'active', 't', 'ok')").run(nodeId);
  db.prepare("INSERT INTO reports (node_id, uploaded_at, orbit_version, dsh_version, compatibility, identity_json, checks_json, report_json) VALUES (?, 't', '0.3.0', 'd', 'pass', '{}', '{}', '{}')").run(nodeId);
  if (kind === "legacy") {
    db.exec("ALTER TABLE nodes DROP COLUMN alert_flags");
    db.exec("ALTER TABLE nodes DROP COLUMN last_heartbeat_at");
    db.exec("ALTER TABLE browser_sessions DROP COLUMN expiry_audited_at");
    db.exec("PRAGMA user_version = 1");
  }
  if (kind === "fk") {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO node_keys (node_id, key_id, public_key, state, created_at) VALUES ('node_missing', 'orphan', ?, 'active', 't')").run("a".repeat(64));
  }
  db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  db.close();
  if (kind === "page") {
    const raw = await readFile(path);
    const probe = new DatabaseSync(path);
    const pageSize = Number(probe.prepare("PRAGMA page_size").get().page_size);
    const rootPage = Number(probe.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'reports'").get().rootpage);
    probe.close();
    const offset = (rootPage - 1) * pageSize;
    raw[offset + 8] = 0;
    raw[offset + 9] = 1;
    await writeFile(path, raw);
  }
}

test("Hub rejects valid-header page corruption and existing FK violations before listening", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-hub-integrity-failures-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = {
    DSH_ORBIT_HUB_PORT: "0",
    DSH_ORBIT_HUB_GATEWAY_SECRET: "test-gateway-secret",
    DSH_ORBIT_HUB_OPERATOR_PRINCIPAL: "operator",
  };
  for (const kind of ["page", "fk"]) {
    const path = join(dir, `${kind}.db`);
    await makeCorruptHubDatabase(path, kind);
    const before = await readFile(path);
    const result = await runHub({ ...base, DSH_ORBIT_HUB_DB: path });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /database startup failed \(integrity-failed\)/);
    assert.doesNotMatch(result.stdout, /registry listening/);
    assert.deepEqual(await readFile(path), before);
  }
});

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
