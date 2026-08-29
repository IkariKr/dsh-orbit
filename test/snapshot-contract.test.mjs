import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  bindSnapshotManifest,
  promotionReadiness,
  readSnapshotManifest,
  runSnapshotHook,
  snapshotHookRunner,
  validateSnapshotManifest,
} from "../src/snapshot-contract.mjs";

const REFERENCE_HOOK = fileURLToPath(
  new URL("../examples/snapshot-hook-reference.sh", import.meta.url),
);

const ORBIT_REVISION = "8f3094e6d09c9337569f5cc1f965f8bd3d01e7d9";

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-snapshot-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeHook(dir, name, body) {
  const hookPath = join(dir, name);
  await writeFile(hookPath, body, "utf8");
  return hookPath;
}

function hookArguments(dir, overrides = {}) {
  return {
    hookPath: REFERENCE_HOOK,
    manifestPath: join(dir, "manifest.json"),
    snapshotId: "snap-test-0001",
    dataRoot: join(dir, "data"),
    orbitRevision: ORBIT_REVISION,
    dshVersion: "0.1.1-rc.2",
    candidateDshVersion: "0.2.0-candidate",
    timeoutSeconds: 60,
    ...overrides,
  };
}

const referenceHookTest = (name, fn) =>
  test(
    name,
    {
      skip:
        process.platform === "win32"
          ? "GNU tar misreads Windows drive letters as remote hosts; covered on POSIX CI"
          : false,
    },
    fn,
  );

referenceHookTest("the reference snapshot hook completes and produces a valid manifest", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(join(dir, "data", "marker.txt"), "known-good", "utf8");

    const result = await runSnapshotHook(hookArguments(dir));
    assert.equal(result.ok, true);
    assert.equal(result.manifest.snapshotId, "snap-test-0001");
    assert.equal(result.manifest.status, "complete");
    assert.equal(result.manifest.orbitRevision, ORBIT_REVISION);
    assert.equal(result.manifest.dshVersion, "0.1.1-rc.2");
    assert.equal(result.manifest.candidateDshVersion, "0.2.0-candidate");
    assert.equal(result.manifest.dataRoot, join(dir, "data"));
    assert.equal(result.manifest.method, "tar-gz-reference");

    await access(result.manifest.restoreReference);
    assert.equal(promotionReadiness(result).ready, true);
  });
});

test("a failing snapshot hook stops promotion readiness", async () => {
  await withTempDir(async (dir) => {
    const hookPath = await writeHook(dir, "fail.sh", '#!/bin/sh\necho "boom" >&2\nexit 3\n');
    const result = await runSnapshotHook(hookArguments(dir, { hookPath }));
    assert.equal(result.ok, false);
    assert.match(result.error, /exited with code 3/);
    const readiness = promotionReadiness(result);
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason, /exited with code 3/);
  });
});

test("a hook that exits zero without writing a manifest is a failure", async () => {
  await withTempDir(async (dir) => {
    const hookPath = await writeHook(dir, "silent.sh", "#!/bin/sh\nexit 0\n");
    const result = await runSnapshotHook(hookArguments(dir, { hookPath }));
    assert.equal(result.ok, false);
    assert.match(result.error, /manifest was not written/);
    assert.equal(promotionReadiness(result).ready, false);
  });
});

test("a manifest left over from a previous request cannot satisfy this request", async () => {
  await withTempDir(async (dir) => {
    const hookPath = await writeHook(dir, "silent.sh", "#!/bin/sh\nexit 0\n");
    const manifestPath = join(dir, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        snapshotId: "snap-OLD",
        createdAt: "2026-08-29T00:00:00Z",
        orbitRevision: "oldrev",
        dshVersion: "oldver",
        dataRoot: "/old/data",
        method: "tar-gz-reference",
        restoreReference: "/old/backups/snap-OLD.tar.gz",
        status: "complete",
      }),
      "utf8",
    );

    const result = await runSnapshotHook(hookArguments(dir, { hookPath, manifestPath }));
    assert.equal(result.ok, false, "a stale manifest must not be reported as a fresh snapshot");
    assert.match(result.error, /manifest was not written/);
    assert.equal(promotionReadiness(result).ready, false);
  });
});

test("a manifest that does not match the request tuple is rejected", async () => {
  await withTempDir(async (dir) => {
    const hookPath = await writeHook(
      dir,
      "wrong-tuple.sh",
      '#!/bin/sh\nprintf \'%s\' \'{"snapshotId":"snap-OTHER","createdAt":"%s","orbitRevision":"%s","dshVersion":"%s","dataRoot":"%s","method":"m","restoreReference":"rr","status":"complete"}\' > "$DSH_SNAPSHOT_MANIFEST"\n',
    );
    const result = await runSnapshotHook(hookArguments(dir, { hookPath }));
    assert.equal(result.ok, false);
    assert.match(
      result.error,
      /mismatched fields: snapshotId, dataRoot, orbitRevision, dshVersion/,
    );
    assert.equal(promotionReadiness(result).ready, false);
  });
});

test("bindSnapshotManifest validates tuple and creation time", () => {
  const request = {
    snapshotId: "snap-1",
    dataRoot: "/data",
    orbitRevision: ORBIT_REVISION,
    dshVersion: "0.1.1-rc.2",
    startedAt: Date.parse("2026-08-29T08:00:00Z"),
  };
  const manifest = (createdAt) => ({
    snapshotId: "snap-1",
    createdAt,
    orbitRevision: ORBIT_REVISION,
    dshVersion: "0.1.1-rc.2",
    dataRoot: "/data",
    method: "tar-gz-reference",
    restoreReference: "/backups/snap-1.tar.gz",
    status: "complete",
  });

  assert.equal(bindSnapshotManifest(manifest("2026-08-29T08:00:02Z"), request).ok, true);
  assert.equal(bindSnapshotManifest(manifest("2026-08-29T07:59:58Z"), request).ok, true, "within clock tolerance");

  const stale = bindSnapshotManifest(manifest("2026-08-28T23:59:00Z"), request);
  assert.equal(stale.ok, false);
  assert.match(stale.error, /createdAt predates the snapshot request/);

  const invalid = bindSnapshotManifest(manifest("not-a-timestamp"), request);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /createdAt is not a valid timestamp/);

  const wrongId = bindSnapshotManifest({ ...manifest("2026-08-29T08:00:02Z"), snapshotId: "snap-2" }, request);
  assert.equal(wrongId.ok, false);
  assert.match(wrongId.error, /mismatched fields: snapshotId/);

  const candidateMissing = bindSnapshotManifest(
    { ...manifest("2026-08-29T08:00:02Z"), candidateDshVersion: undefined },
    { ...request, candidateDshVersion: "0.2.0-candidate" },
  );
  assert.equal(candidateMissing.ok, false);
  assert.match(candidateMissing.error, /mismatched fields: candidateDshVersion/);

  const candidateMismatch = bindSnapshotManifest(
    { ...manifest("2026-08-29T08:00:02Z"), candidateDshVersion: "0.9.0-other" },
    { ...request, candidateDshVersion: "0.2.0-candidate" },
  );
  assert.equal(candidateMismatch.ok, false);
  assert.match(candidateMismatch.error, /mismatched fields: candidateDshVersion/);

  const candidateMatch = bindSnapshotManifest(
    { ...manifest("2026-08-29T08:00:02Z"), candidateDshVersion: "0.2.0-candidate" },
    { ...request, candidateDshVersion: "0.2.0-candidate" },
  );
  assert.equal(candidateMatch.ok, true);
});

test("incomplete manifests are rejected with field names only", async () => {
  const missing = validateSnapshotManifest({ snapshotId: "snap-1", status: "complete" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /missing required fields: createdAt, orbitRevision/);
  assert.ok(!missing.error.includes("snap-1"));

  const partial = validateSnapshotManifest({
    snapshotId: "snap-1",
    createdAt: "2026-08-29T00:00:00Z",
    orbitRevision: ORBIT_REVISION,
    dshVersion: "0.1.1-rc.2",
    dataRoot: "/data",
    method: "tar-gz-reference",
    restoreReference: "/backups/snap-1.tar.gz",
    status: "partial",
  });
  assert.equal(partial.ok, false);
  assert.match(partial.error, /status is not complete/);
});

test("manifests with credential-like extra fields are rejected without echoing values", async () => {
  const embedded = validateSnapshotManifest({
    snapshotId: "snap-1",
    createdAt: "2026-08-29T00:00:00Z",
    orbitRevision: ORBIT_REVISION,
    dshVersion: "0.1.1-rc.2",
    dataRoot: "/data",
    method: "nas-vendor-api",
    restoreReference: "nas://backups/snap-1",
    status: "complete",
    storageCredential: "hunter2-super-secret-value",
  });
  assert.equal(embedded.ok, false);
  assert.match(embedded.error, /unknown fields: storageCredential/);
  assert.ok(!embedded.error.includes("hunter2-super-secret-value"));

  await withTempDir(async (dir) => {
    const hookPath = await writeHook(
      dir,
      "embed.sh",
      '#!/bin/sh\nprintf \'%s\' \'{"snapshotId":"snap-1","createdAt":"t","orbitRevision":"r","dshVersion":"v","dataRoot":"d","method":"m","restoreReference":"rr","status":"complete","storageCredential":"hunter2-super-secret-value"}\' > "$DSH_SNAPSHOT_MANIFEST"\n',
    );
    const result = await runSnapshotHook(hookArguments(dir, { hookPath }));
    assert.equal(result.ok, false);
    assert.match(result.error, /unknown fields: storageCredential/);
    assert.ok(!result.error.includes("hunter2-super-secret-value"));
  });
});

test("a timed out snapshot hook stops promotion readiness", async () => {
  await withTempDir(async (dir) => {
    const hookPath = await writeHook(dir, "slow.sh", "#!/bin/sh\nsleep 10\n");
    const result = await runSnapshotHook(hookArguments(dir, { hookPath, timeoutSeconds: 1 }));
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out after 1s/);
    assert.equal(promotionReadiness(result).ready, false);
  });
}, { timeout: 15000 });

test("unsupported hook extensions are rejected before execution", async () => {
  assert.throws(() => snapshotHookRunner("/opt/hooks/snapshot.py"), /unsupported snapshot hook/);
  await withTempDir(async (dir) => {
    const hookPath = await writeHook(dir, "hook.py", "print('hi')\n");
    const result = await runSnapshotHook(hookArguments(dir, { hookPath }));
    assert.equal(result.ok, false);
    assert.match(result.error, /unsupported snapshot hook/);
  });
});

test("readSnapshotManifest validates a written manifest file", async () => {
  await withTempDir(async (dir) => {
    const manifestPath = join(dir, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        snapshotId: "snap-1",
        createdAt: "2026-08-29T00:00:00Z",
        orbitRevision: ORBIT_REVISION,
        dshVersion: "0.1.1-rc.2",
        dataRoot: "/data",
        method: "tar-gz-reference",
        restoreReference: "/backups/snap-1.tar.gz",
        status: "complete",
      }),
      "utf8",
    );
    const result = await readSnapshotManifest(manifestPath);
    assert.equal(result.ok, true);
    assert.equal(result.manifest.restoreReference, "/backups/snap-1.tar.gz");
    assert.equal(promotionReadiness(result).ready, true);

    const broken = await readSnapshotManifest(join(dir, "absent.json"));
    assert.equal(broken.ok, false);
    assert.match(broken.error, /was not written/);
    assert.equal(promotionReadiness(broken).ready, false);
  });
});
