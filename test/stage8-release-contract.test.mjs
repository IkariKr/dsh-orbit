import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  "docs/release-attestations/v0.3-stage7-operational-hardening.md",
  "docs/release-attestations/v0.3.0-rc.1.md",
];

const readReleaseSources = async () =>
  Object.fromEntries(
    await Promise.all(
      [
        "CHANGELOG.md",
        "README.md",
        "docs/architecture.md",
        "docs/registry-mvp.md",
        "docs/registry-deployment.md",
        ...requiredDocs,
      ].map(async (path) => [path, await text(path)]),
    ),
  );

function gitObjectExists(object) {
  try {
    execFileSync("git", ["cat-file", "-e", `${object}^{commit}`], {
      cwd: new URL("../", import.meta.url),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function gitCommitParent(commit) {
  try {
    return execFileSync("git", ["rev-parse", `${commit}^`], {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function gitIsAncestor(ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: new URL("../", import.meta.url),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

test("Stage 8 release candidate artifact set exists", async () => {
  for (const path of requiredDocs) await access(new URL(`../${path}`, import.meta.url));
  const changelog = await text("CHANGELOG.md");
  assert.match(changelog, /^## Unreleased$/m);
  assert.match(changelog, /^### 0\.3\.0-rc\.1 candidate - 2026-09-02$/m);
  assert.doesNotMatch(changelog, /^## 0\.3\.0-rc\.1 - 2026-08-31$/m);
});

test("Registry Compose requires an explicit release image tag", async () => {
  const compose = await text("docker-registry/compose.example.yaml");
  const imageLine = /^\s*image:\s+[^\n]+$/m.exec(compose)?.[0] ?? "";
  assert.match(
    imageLine,
    /image:\s+dsh-orbit-registry:\$\{DSH_ORBIT_REGISTRY_TAG:\?set DSH_ORBIT_REGISTRY_TAG\}/,
  );
  assert.doesNotMatch(imageLine, /v0\.3\.0-s6/);
  assert.doesNotMatch(imageLine, /:-/);

  const config = await text("docs/configuration-reference.md");
  assert.match(config, /`DSH_ORBIT_REGISTRY_TAG`/);
  assert.match(config, /Required.*Default.*Meaning and constraints/s);
  assert.match(config, /explicitly bound.*v0\.3\.0-rc\.1.*fail closed/s);
  assert.match(config, /v0\.3\.0-s6.*not permitted/s);
});

test("Node enrollment SOP carries configuration through every CLI lifecycle", async () => {
  const source = await text("docs/sop/v0.3-node-enrollment-sop.md");
  for (const variable of [
    "DSH_ORBIT_NODE_STATE",
    "DSH_ORBIT_HUB_URL",
    "DSH_ORBIT_NODE_ORBIT_VERSION",
    "DSH_ORBIT_NODE_ORBIT_REVISION",
    "DSH_ORBIT_NODE_DSH_VERSION",
    "DSH_ORBIT_NODE_DSH_PROFILE",
    "DSH_ORBIT_NODE_HEARTBEAT_SECONDS",
  ]) {
    assert.match(source, new RegExp(`export ${variable}=`));
  }
  assert.match(source, /every Node CLI process/);
  assert.match(source, /never restores them from the state file/);
  assert.match(source, /DSH_ORBIT_ENROLL_TOKEN=.*node bin\/dsh-orbit-node\.mjs enroll/);
  assert.match(source, /DSH_ORBIT_REPORT_FILE=.*node bin\/dsh-orbit-node\.mjs upload-report/);
  assert.match(source, /DSH_ORBIT_REENROLL_TOKEN=.*node bin\/dsh-orbit-node\.mjs reenroll/);
  assert.doesNotMatch(source, /export DSH_ORBIT_(?:ENROLL_TOKEN|REENROLL_TOKEN|REPORT_FILE)=/);
});

test("Registry backup and restore SOP contains runnable primitive procedures", async () => {
  const source = await text("docs/sop/v0.3-registry-backup-restore-sop.md");
  assert.match(source, /There is no production backup or restore CLI/);
  assert.match(source, /npm run\s+stage7:drill[\s\S]*not a[\s\S]*production backup\/restore/);
  assert.match(source, /node --input-type=module/);
  assert.match(source, /DSH_ORBIT_REGISTRY_SOURCE=\/data\/orbit\/registry\.db/);
  assert.match(source, /DSH_ORBIT_REGISTRY_BACKUP=\/backups\/registry-\d+T\d+Z\.db/);
  assert.match(source, /DSH_ORBIT_REGISTRY_TARGET=\/data\/orbit\/registry\.db/);
  assert.match(source, /import \{ openRegistryDatabase \}/);
  assert.match(source, /backupRegistryDatabase/);
  assert.match(source, /restoreRegistryDatabase/);
  assert.match(source, /inspectRegistryDatabase/);
  assert.match(source, /const db = openRegistryDatabase\(sourcePath\);/);
  assert.match(source, /try \{[\s\S]*backupRegistryDatabase[\s\S]*finally \{[\s\S]*db\.close\(\)/);
  assert.match(source, /writersQuiesced: true/);
  assert.match(source, /const verificationDb = openRegistryDatabase\(targetPath\);/);
  assert.match(source, /verificationDb\.close\(\)/);
  assert.match(source, /VACUUM INTO/);
  assert.match(source, /WAL\/SHM/);
});

test("Operator readiness and release status wording match the implementation", async () => {
  const operator = await text("docs/sop/v0.3-operator-sop.md");
  assert.match(operator, /dsh-orbit-hub: registry listening/);
  assert.match(operator, /GET `?\/`? root\/UI readiness/);
  assert.match(operator, /authenticated `\/hub\/\*` state/);
  assert.doesNotMatch(operator, /health endpoint|`\/health`/i);

  const deployment = await text("docs/registry-deployment.md");
  const stage7 = await text("docs/release-attestations/v0.3-stage7-operational-hardening.md");
  assert.match(deployment, /Stage 7 is\s+complete and accepted/);
  assert.doesNotMatch(deployment, /Stage 7[^\n]*awaiting review/i);
  assert.match(stage7, /Status: \*\*complete; accepted\*\*/);
  assert.doesNotMatch(stage7, /Stage 7[^\n]*awaiting review/i);
  assert.doesNotMatch(stage7, /does not authorize\s+Stage 8/i);
});

test("RC attestation has valid release provenance and final-review disposition", async () => {
  const source = await text("docs/release-attestations/v0.3.0-rc.1.md");
  assert.doesNotMatch(source, /^attestationCommit:/m);

  const fields = Object.fromEntries(
    [
      "testedCommit",
      "initialEvidenceCommit",
      "executableLiveSmokeCommit",
      "releaseClosureParent",
      "releaseClosureCommit",
    ].map((field) => [
      field,
      new RegExp(`^${field}:\\s*([0-9a-f]{40})$`, "m").exec(source)?.[1],
    ]),
  );
  for (const [field, value] of Object.entries(fields)) {
    assert.ok(value, `attestation must record a full ${field} SHA`);
    assert.ok(gitObjectExists(value), `${field} ${value} must exist`);
  }

  assert.equal(
    fields.testedCommit,
    fields.releaseClosureCommit,
    "tested commit must be the release closure commit",
  );
  assert.equal(
    gitCommitParent(fields.releaseClosureCommit),
    fields.releaseClosureParent,
    "release closure parent must be the direct parent of the release closure commit",
  );
  assert.ok(
    gitIsAncestor(fields.initialEvidenceCommit, fields.releaseClosureCommit),
    "initial evidence commit must be an ancestor of the release closure commit",
  );
  assert.ok(
    gitIsAncestor(fields.executableLiveSmokeCommit, fields.releaseClosureCommit),
    "executable live smoke commit must be an ancestor of the release closure commit",
  );
  assert.equal(
    /^releaseClosureRange:\s*([^\n]+)$/m.exec(source)?.[1],
    `${fields.executableLiveSmokeCommit}..${fields.releaseClosureCommit}`,
    "release closure range must identify the executable smoke and closure commits",
  );
  assert.equal(
    /^orbitRevision:\s*([0-9a-f]{40})$/m.exec(source)?.[1],
    fields.testedCommit,
    "orbit revision must match the tested commit",
  );

  assert.match(source, /stage7Gate\.success: true/);
  assert.match(source, /stage7Gate\.failedPredicates: \[\]/);
  assert.match(source, /tag:\s*`?not-created/i);
  assert.match(source, /published:\s*`?false/i);
  assert.match(source, /promotion:\s*`?not-performed/i);
  assert.match(source, /awaiting-final-review/);
});

test("Stage 8 docs do not introduce forbidden feature scope", async () => {
  const sources = await readReleaseSources();
  const source = Object.values(sources).join("\n");
  assert.doesNotMatch(source, /reverse connections?\s+(?:are|will be)\s+implemented/i);
  assert.doesNotMatch(source, /feature\s+work\s+added/i);
  assert.doesNotMatch(source, /new (?:runtime )?(?:backup|restore) CLI/i);
});
