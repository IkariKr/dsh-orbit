import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("../scripts/watch-upstream.mjs", import.meta.url));

async function withRegistry(manifest, status = 200) {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unavailable" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(manifest));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/@deepseek-ai/dsh/latest`;
  return { url, close: () => server.close() };
}

async function runWatcher(registryUrl, jsonOut) {
  const args = [SCRIPT];
  if (jsonOut) args.push("--json-out", jsonOut);
  const child = spawn(process.execPath, args, {
    env: { ...process.env, DSH_WATCH_REGISTRY_URL: registryUrl },
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
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

test("a published version already in the registry is classified as supported", async () => {
  const registry = await withRegistry({ version: "0.1.1-rc.2" });
  try {
    const { code, stdout } = await runWatcher(registry.url);
    assert.equal(code, 0);
    assert.match(stdout, /upstream dsh: 0\.1\.1-rc\.2 \(supported\)/);
    assert.match(stdout, /no action required/);
  } finally {
    registry.close();
  }
});

test("an unknown published version is recorded without modifying the registry state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-watcher-"));
  try {
    const registry = await withRegistry({ version: "9.9.9-future" });
    const jsonOut = join(dir, "report.json");
    try {
      const { code, stdout } = await runWatcher(registry.url, jsonOut);
      assert.equal(code, 0);
      assert.match(stdout, /upstream dsh: 9\.9\.9-future \(unknown\)/);
      assert.match(stdout, /known compatibility profiles: 0\.1\.1-rc\.2/);
      assert.match(stdout, /review required before any support claim/);

      const report = JSON.parse(await readFile(jsonOut, "utf8"));
      assert.equal(report.latestVersion, "9.9.9-future");
      assert.equal(report.classification, "unknown");
      assert.deepEqual(report.knownProfiles, ["0.1.1-rc.2"]);
    } finally {
      registry.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry failures fail the check without emitting a classification", async () => {
  const registry = await withRegistry({}, 503);
  try {
    const { code, stdout, stderr } = await runWatcher(registry.url);
    assert.equal(code, 2);
    assert.match(stderr, /registry returned HTTP 503/);
    assert.ok(!stdout.includes("supported"));
  } finally {
    registry.close();
  }
});

test("a malformed registry manifest fails the check", async () => {
  const registry = await withRegistry({ "dist-tags": {} });
  try {
    const { code, stderr } = await runWatcher(registry.url);
    assert.equal(code, 2);
    assert.match(stderr, /no version field/);
  } finally {
    registry.close();
  }
});
