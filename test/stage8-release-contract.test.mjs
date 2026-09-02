import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const text = async (path) => readFile(new URL(path, ROOT), "utf8");

const requiredDocs = [
  "docs/configuration-reference.md",
  "docs/sop/v0.3-operator-sop.md",
  "docs/sop/v0.3-node-enrollment-sop.md",
  "docs/sop/v0.3-registry-backup-restore-sop.md",
  "docs/troubleshooting.md",
  "docs/release-attestations/v0.3.0-rc.1.md",
];

test("Stage 8 release candidate artifact set exists", async () => {
  for (const path of requiredDocs) await access(new URL(`../${path}`, import.meta.url));
  assert.match(await text("CHANGELOG.md"), /## 0\.3\.0-rc\.1/);
});

test("Stage 8 RC attestation contains the release-closing contract", async () => {
  const source = await text("docs/release-attestations/v0.3.0-rc.1.md");
  for (const field of [
    "releaseCandidate",
    "testedCommit",
    "cleanWorktreeBefore",
    "cleanWorktreeAfter",
    "registrySchemaVersion",
    "compatibilityReportSchemaVersion",
    "nodeStateSchemaVersion",
    "npm run check",
    "npm run stage7:drill",
    "fresh install",
    "migration",
    "backup",
    "restore",
    "live smoke",
    "known limitations",
    "awaiting-final-review",
  ]) assert.match(source, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /tag:\s*`?not-created/i);
  assert.match(source, /published:\s*`?false/i);
  assert.match(source, /promotion:\s*`?not-performed/i);
});

test("Stage 8 docs do not introduce forbidden feature scope", async () => {
  const files = ["README.md", "docs/architecture.md", "docs/registry-mvp.md", "docs/registry-deployment.md", ...requiredDocs, "CHANGELOG.md"];
  const source = (await Promise.all(files.map((path) => text(path)))).join("\n");
  assert.doesNotMatch(source, /reverse connections?\s+(?:are|will be)\s+implemented/i);
  assert.doesNotMatch(source, /feature\s+work\s+added/i);
});
