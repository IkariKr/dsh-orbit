import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const text = async (path) => readFile(new URL(path, ROOT), "utf8");

const requiredDocs = [
  "package.json",
  "CHANGELOG.md",
  "README.md",
  "docs/architecture.md",
  "docs/roadmap.md",
  "docs/configuration-reference.md",
  "docs/sop/v0.3-operator-sop.md",
  "docs/sop/v0.4-selector-operator-sop.md",
  "docs/sop/v0.3-node-enrollment-sop.md",
  "docs/sop/v0.3-registry-backup-restore-sop.md",
  "docs/sop/v0.4-production-promotion-rollback-plan.md",
  "docs/troubleshooting.md",
  "docs/release-attestations/v0.4-stage7-failure-hardening.md",
];

test("Stage 8 v0.4 release closure artifacts and version declarations", async () => {
  for (const path of requiredDocs) {
    await access(new URL(`../${path}`, import.meta.url));
  }

  const pkg = JSON.parse(await text("package.json"));
  assert.equal(pkg.version, "0.4.0-rc.1");

  const changelog = await text("CHANGELOG.md");
  assert.match(changelog, /### 0\.4\.0-rc\.1 candidate/);

  const readme = await text("README.md");
  assert.match(readme, /0\.4\.0-rc\.1/);
  assert.match(readme, /Reverse-connected nodes are not part of v0\.4/i);

  const roadmap = await text("docs/roadmap.md");
  assert.match(roadmap, /Implemented in `v0\.4\.0-rc\.1`/);
  assert.match(roadmap, /Reverse-connected nodes are not part of v0\.4/i);

  const architecture = await text("docs/architecture.md");
  assert.match(architecture, /Implemented v0\.4 Endpoint Selector/);
  assert.match(architecture, /Reverse-connected nodes are not part of v0\.4/i);
});

test("Stage 8 pinned external DeepSeek Harness baseline contract", async () => {
  const readme = await text("README.md");
  assert.match(readme, /0\.1\.1-rc\.2/);

  const stage6Contract = await text("test/stage6-mounted-drill-contract.test.mjs");
  assert.match(stage6Contract, /b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/);
  assert.match(stage6Contract, /c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62/);

  const stage7Attestation = await text("docs/release-attestations/v0.4-stage7-failure-hardening.md");
  assert.match(stage7Attestation, /0\.1\.1-rc\.2/);
  assert.match(stage7Attestation, /b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/);
  assert.match(stage7Attestation, /c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62/);
});

test("Stage 8 schema version and route configuration safety", async () => {
  const sqliteSource = await text("src/registry/sqlite.mjs");
  assert.match(sqliteSource, /SCHEMA_VERSION = 5/);

  const configDoc = await text("docs/configuration-reference.md");
  assert.match(configDoc, /DSH_ORBIT_HUB_ROUTE_DOMAIN/);
  assert.match(configDoc, /DSH_ORBIT_HUB_ROUTE_PROBE_CADENCE_SECONDS/);
  assert.match(configDoc, /DSH_ORBIT_HUB_WS_GLOBAL_LIMIT/);
  assert.match(configDoc, /DSH_ORBIT_HUB_WS_PER_NODE_LIMIT/);
  assert.match(configDoc, /DSH_ORBIT_NODE_WS_LIMIT/);
});

test("Stage 8 production promotion and rollback plan constraints", async () => {
  const plan = await text("docs/sop/v0.4-production-promotion-rollback-plan.md");
  assert.match(plan, /dsh\.ikarikore\.top/);
  assert.match(plan, /n-<nodeId>\.dsh\.ikarikore\.top/);
  assert.match(plan, /Rollback Contract/);
  assert.match(plan, /No Identity Destruction/);
});

test("Stage 8 security boundaries: strictly no TLS bypass permitted", async () => {
  const files = [
    "src/node/route-ingress.mjs",
    "src/registry/route-proxy.mjs",
    "src/registry/registry.mjs",
    "scripts/registry-stage7-drill.mjs",
    "test/stage7-hardening.test.mjs",
  ];
  for (const f of files) {
    const content = await text(f);
    assert.doesNotMatch(content, /rejectUnauthorized\s*:\s*false/);
    assert.doesNotMatch(content, new RegExp("NODE_" + "TLS_" + "REJECT_" + "UNAUTHORIZED"));
    assert.doesNotMatch(content, /ignore-certificate-errors/);
  }
});
