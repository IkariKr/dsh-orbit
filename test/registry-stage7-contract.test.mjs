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
  assert.match(source, /requireCleanCandidateWorktree/);
  assert.match(source, /requiredPredicates/);
  assert.match(source, /failedPredicates/);
  assert.match(source, /STAGE7 DRILL SUCCESS/);
  assert.match(source, /runStage7ProcessDrill/);
  assert.doesNotMatch(source, /registry-drill\.mjs/);
});

test("Stage 7 implementation does not open forbidden feature scope", async () => {
  const files = [
    "../src/registry/backup.mjs",
    "../src/registry/sqlite.mjs",
    "../bin/dsh-orbit-hub.mjs",
    "../scripts/registry-stage7-drill.mjs",
    "../scripts/stage7-process-harness.mjs",
    "../scripts/stage7-process-scenarios.mjs",
  ];
  const source = (await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), "utf8")))).join("\n");
  assert.doesNotMatch(source, /reverse connection|NAT traversal|fleet execution|terminal\.pty|agents\.run/i);
  assert.doesNotMatch(source, /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|ignore-certificate-errors/i);
});

test("Stage 7 startup integrity and file protection are explicit", async () => {
  const sqlite = await readFile(new URL("../src/registry/sqlite.mjs", import.meta.url), "utf8");
  const backup = await readFile(new URL("../src/registry/backup.mjs", import.meta.url), "utf8");
  assert.match(sqlite, /PRAGMA integrity_check/);
  assert.match(sqlite, /PRAGMA foreign_key_check/);
  assert.match(sqlite, /pre-migration/);
  assert.match(sqlite, /post-migration/);
  assert.match(sqlite, /0o600/);
  assert.match(backup, /chmod/);
  assert.match(backup, /0o600/);
});

test("Stage 7 drill enforces v0.4 failure hardening predicates (S7-F1 through S7-F13)", async () => {
  const source = await readFile(new URL("../scripts/registry-stage7-drill.mjs", import.meta.url), "utf8");
  const requiredHardeningPredicates = [
    "migrationV04",
    "routeIdentityBackupRestore",
    "secretProtection",
    "routeIdentityCorruption",
    "hubRouteKeyRotation",
    "nonceRestartSemantics",
    "tlsFailureMatrix",
    "compatibilityWithdrawal",
    "dshLossRecovery",
    "bookmarkReenroll",
    "httpWsCleanup",
    "restartStability",
  ];
  for (const pred of requiredHardeningPredicates) {
    assert.match(source, new RegExp(pred), `registry-stage7-drill.mjs must declare predicate ${pred}`);
  }
});

test("Stage 7 delivers operator troubleshooting guidance for every v0.4 hardening boundary", async () => {
  const troubleshooting = await readFile(new URL("../docs/troubleshooting.md", import.meta.url), "utf8");
  const requiredTopics = [
    "Route/Hub identity backup and restore",
    "Hub route-key rotation and restart",
    "Nonce replay and RouteIngress restart",
    "TLS trust failures",
    "DSH loss behind a live RouteIngress",
    "Compatibility withdrawal and Open availability",
    "Delete, bookmark, and reenroll",
    "HTTP/WS abort and capacity cleanup",
  ];
  for (const topic of requiredTopics) {
    assert.match(troubleshooting, new RegExp(topic.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")), `troubleshooting.md must cover ${topic}`);
  }
  assert.match(troubleshooting, /process-local/);
  assert.match(troubleshooting, /not durable replay prevention/);
  assert.match(troubleshooting, /rejectUnauthorized: false/);
  assert.match(troubleshooting, /NODE_TLS_REJECT_UNAUTHORIZED=0/);
  assert.match(troubleshooting, /private keys/);
});

test("Stage 7 provenance report reconciles post-E7.3 Stage 8 history and remote review prerequisites", async () => {
  const report = await readFile(new URL("../docs/release-attestations/v0.4-stage7-construction-report-2026-09-18.md", import.meta.url), "utf8");
  assert.doesNotMatch(report, /^Stage 8: NOT STARTED$/m, "the report must not deny known post-E7.3 Stage 8 history");
  assert.match(report, /pre-review, unauthorized, and quarantined historical construction/);
  assert.match(report, /closure must be pushed/);
  assert.match(report, /remote Stage 7 branch still pointed to E7\.3/);
  assert.match(report, /valid retained or operator-approved route target/);
  assert.match(report, /Stage 8 accepted status: NOT ESTABLISHED/);
});
