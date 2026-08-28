#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { listRuntimeHooks } from "../src/runtime-hooks.mjs";

const hookDir = process.env.DSH_ORBIT_HOOK_DIR ?? "/opt/dsh-orbit/hooks";
const hooks = await listRuntimeHooks(hookDir);

if (hooks.length === 0) {
  console.log(`DSH Orbit runtime hooks: none (${hookDir})`);
  process.exit(0);
}

for (const hook of hooks) {
  const command = hook.runner === "node" ? process.execPath : "/bin/sh";
  console.log(`DSH Orbit runtime hook: ${hook.name}`);
  const result = spawnSync(command, [hook.path], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`DSH Orbit runtime hook failed: ${hook.name} (exit ${result.status})`);
  }
}
