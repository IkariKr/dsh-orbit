import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

test("Stage 7 drill is separate, provenance-bound, and uses SQLite-consistent restore primitives", async () => {
  const source = await readFile(new URL("../scripts/registry-stage7-drill.mjs", import.meta.url), "utf8");
  assert.match(source, /Stage 7 operational hardening drill/);
  assert.match(source, /stage7-drill-evidence\.json/);
  assert.match(source, /backupRegistryDatabase/);
  assert.match(source, /restoreRegistryDatabase/);
  assert.match(source, /testedCommit/);
  assert.match(source, /emptyBeforeStartup/);
  assert.doesNotMatch(source, /registry-drill\.mjs/);
});

test("Stage 7 implementation does not open forbidden feature scope", async () => {
  const files = [
    "../src/registry/backup.mjs",
    "../src/registry/sqlite.mjs",
    "../bin/dsh-orbit-hub.mjs",
    "../scripts/registry-stage7-drill.mjs",
  ];
  const source = (await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), "utf8")))).join("\n");
  assert.doesNotMatch(source, /reverse connection|NAT traversal|fleet execution|terminal\.pty|agents\.run/i);
  assert.doesNotMatch(source, /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|ignore-certificate-errors/i);
});
