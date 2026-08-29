import process from "node:process";
import { runSnapshotHook, promotionReadiness } from "../src/snapshot-contract.mjs";

const hookPath = process.env.DSH_SNAPSHOT_HOOK;
const manifestPath = process.env.DSH_SNAPSHOT_MANIFEST;
const required = {
  DSH_SNAPSHOT_HOOK: hookPath,
  DSH_SNAPSHOT_MANIFEST: manifestPath,
  DSH_SNAPSHOT_ID: process.env.DSH_SNAPSHOT_ID,
  DSH_DATA_ROOT: process.env.DSH_DATA_ROOT,
  DSH_ORBIT_REVISION: process.env.DSH_ORBIT_REVISION,
  DSH_VERSION: process.env.DSH_VERSION,
};
const missing = Object.keys(required).filter((name) => !required[name]);
if (missing.length > 0) {
  console.error(`snapshot hook configuration is missing: ${missing.join(", ")}`);
  process.exit(2);
}

const result = await runSnapshotHook({
  hookPath,
  manifestPath,
  snapshotId: process.env.DSH_SNAPSHOT_ID,
  dataRoot: process.env.DSH_DATA_ROOT,
  orbitRevision: process.env.DSH_ORBIT_REVISION,
  dshVersion: process.env.DSH_VERSION,
  timeoutSeconds: Number(process.env.DSH_SNAPSHOT_TIMEOUT_SECONDS ?? 900),
});

const readiness = promotionReadiness(result);
if (!result.ok) {
  console.error(`snapshot failed: ${result.error}`);
  console.error(`promotion readiness: DENIED (${readiness.reason})`);
  process.exitCode = 1;
} else {
  console.log(`snapshot complete: ${result.manifest.snapshotId} (${result.manifest.method})`);
  console.log(`restore reference: ${result.manifest.restoreReference}`);
  console.log(`promotion readiness: READY (${readiness.reason})`);
}
