import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

export const SNAPSHOT_MANIFEST_FIELDS = Object.freeze([
  "snapshotId",
  "createdAt",
  "orbitRevision",
  "dshVersion",
  "dataRoot",
  "method",
  "restoreReference",
  "status",
]);

export const SNAPSHOT_OPTIONAL_MANIFEST_FIELDS = Object.freeze(["candidateDshVersion"]);

export const SNAPSHOT_COMPLETED_STATUS = "complete";

export const SNAPSHOT_CLOCK_TOLERANCE_MS = 5000;

const RUNNERS = new Map([
  [".mjs", "node"],
  [".js", "node"],
  [".sh", "sh"],
]);

export function snapshotHookRunner(hookPath) {
  const dot = hookPath.lastIndexOf(".");
  const extension = dot >= 0 ? hookPath.slice(dot) : "";
  const runner = RUNNERS.get(extension);
  if (!runner) {
    throw new Error(
      `unsupported snapshot hook ${hookPath}: expected one of ${[...RUNNERS.keys()].join(", ")}`,
    );
  }
  return runner;
}

export function validateSnapshotManifest(manifest) {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return { ok: false, error: "snapshot manifest must be a JSON object" };
  }
  const known = new Set([...SNAPSHOT_MANIFEST_FIELDS, ...SNAPSHOT_OPTIONAL_MANIFEST_FIELDS]);
  const unknown = Object.keys(manifest).filter((field) => !known.has(field));
  if (unknown.length > 0) {
    return { ok: false, error: `snapshot manifest has unknown fields: ${unknown.join(", ")}` };
  }
  const missing = SNAPSHOT_MANIFEST_FIELDS.filter(
    (field) => typeof manifest[field] !== "string" || manifest[field].trim() === "",
  );
  if (missing.length > 0) {
    return { ok: false, error: `snapshot manifest is missing required fields: ${missing.join(", ")}` };
  }
  const optionalInvalid = SNAPSHOT_OPTIONAL_MANIFEST_FIELDS.filter(
    (field) => manifest[field] !== undefined && (typeof manifest[field] !== "string" || manifest[field].trim() === ""),
  );
  if (optionalInvalid.length > 0) {
    return {
      ok: false,
      error: `snapshot manifest optional fields must be non-empty strings when present: ${optionalInvalid.join(", ")}`,
    };
  }
  if (manifest.status !== SNAPSHOT_COMPLETED_STATUS) {
    return { ok: false, error: `snapshot manifest status is not ${SNAPSHOT_COMPLETED_STATUS}` };
  }
  return { ok: true };
}

export async function readSnapshotManifest(manifestPath) {
  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return { ok: false, error: `snapshot manifest was not written to ${manifestPath}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return { ok: false, error: "snapshot manifest is not valid JSON" };
  }
  const validation = validateSnapshotManifest(manifest);
  return validation.ok ? { ok: true, manifest } : validation;
}

export async function runSnapshotHook({
  hookPath,
  manifestPath,
  snapshotId,
  dataRoot,
  orbitRevision,
  dshVersion,
  candidateDshVersion,
  timeoutSeconds = 900,
  spawnImpl = spawn,
}) {
  let runner;
  try {
    runner = snapshotHookRunner(hookPath);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  await rm(manifestPath, { force: true });
  const startedAt = Date.now();

  const timedOut = { value: false };
  const hookEnv = {
    ...process.env,
    DSH_SNAPSHOT_ID: snapshotId,
    DSH_DATA_ROOT: dataRoot,
    DSH_ORBIT_REVISION: orbitRevision,
    DSH_VERSION: dshVersion,
    DSH_SNAPSHOT_MANIFEST: manifestPath,
  };
  if (candidateDshVersion) hookEnv.DSH_CANDIDATE_DSH_VERSION = candidateDshVersion;
  try {
    const exit = await new Promise((resolve) => {
      const child = spawnImpl(runner, [hookPath], {
        env: hookEnv,
        stdio: "inherit",
      });
      const guard = setTimeout(() => {
        timedOut.value = true;
        child.kill("SIGTERM");
      }, timeoutSeconds * 1000);
      child.once("close", (code, signal) => {
        clearTimeout(guard);
        resolve({ code, signal });
      });
      child.once("error", (error) => {
        clearTimeout(guard);
        resolve({ error });
      });
    });
    if (timedOut.value) {
      return { ok: false, error: `snapshot hook timed out after ${timeoutSeconds}s` };
    }
    if (exit.error) {
      return { ok: false, error: `snapshot hook failed to start: ${exit.error.message}` };
    }
    if (exit.code !== 0) {
      return {
        ok: false,
        error: `snapshot hook exited with ${exit.signal ?? `code ${exit.code}`}`,
      };
    }
  } catch (error) {
    return { ok: false, error: `snapshot hook failed to start: ${error.message}` };
  }

  const result = await readSnapshotManifest(manifestPath);
  if (!result.ok) return result;
  const binding = bindSnapshotManifest(result.manifest, {
    snapshotId,
    dataRoot,
    orbitRevision,
    dshVersion,
    candidateDshVersion,
    startedAt,
  });
  return binding.ok ? result : binding;
}

export function bindSnapshotManifest(manifest, request) {
  const mismatched = ["snapshotId", "dataRoot", "orbitRevision", "dshVersion"].filter(
    (field) => manifest[field] !== request[field],
  );
  if (request.candidateDshVersion !== undefined && manifest.candidateDshVersion !== request.candidateDshVersion) {
    mismatched.push("candidateDshVersion");
  }
  if (mismatched.length > 0) {
    return {
      ok: false,
      error: `snapshot manifest does not match this snapshot request (mismatched fields: ${mismatched.join(", ")})`,
    };
  }
  const createdAt = Date.parse(manifest.createdAt);
  if (Number.isNaN(createdAt)) {
    return { ok: false, error: "snapshot manifest createdAt is not a valid timestamp" };
  }
  if (createdAt < request.startedAt - SNAPSHOT_CLOCK_TOLERANCE_MS) {
    return { ok: false, error: "snapshot manifest createdAt predates the snapshot request" };
  }
  return { ok: true };
}

export function promotionReadiness(snapshotResult) {
  if (!snapshotResult?.ok) {
    return {
      ready: false,
      reason: snapshotResult?.error ?? "no snapshot result was provided",
    };
  }
  return { ready: true, reason: `snapshot ${snapshotResult.manifest.snapshotId} is complete` };
}
