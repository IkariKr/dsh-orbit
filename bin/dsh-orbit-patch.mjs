#!/usr/bin/env node

import { access } from "node:fs/promises";
import process from "node:process";
import {
  patchConnectionRoot,
  readDshVersion,
  verifyConnectionRoot,
} from "../src/remote-settings-patch.mjs";
import {
  patchDshSshPlugin,
  verifyDshSshPlugin,
} from "../src/plugin-patch-dsh-ssh.mjs";

const GLOBAL_DSH_ROOT =
  process.env.DSH_GLOBAL_ROOT || "/usr/local/lib/node_modules/@deepseek-ai/dsh";
const GLOBAL_CONNECTION_ROOT =
  process.env.DSH_GLOBAL_CONNECTION_ROOT ||
  `${GLOBAL_DSH_ROOT}/node_modules/@deepseek-ai/dsh-client-connection/lib`;
const PROFILE_ROOT = process.env.DSH_PROFILE_ROOT || "/data/dsh-home/profiles/web";
const PROFILE_CONNECTION_ROOT =
  process.env.DSH_PROFILE_CONNECTION_ROOT ||
  `${PROFILE_ROOT}/node_modules/@deepseek-ai/dsh-client-connection/lib`;
const PUBLIC_HOST = process.env.DSH_PUBLIC_HOST;
const PROXY_AUTH_FILE = process.env.DSH_PROXY_AUTH_FILE || "/run/secrets/dsh_proxy_auth";
const SSH_PATCH_ENABLED = process.env.DSH_ORBIT_PATCH_DSH_SSH === "1";
const SSH_PLUGIN_ROOT =
  process.env.DSH_SSH_PLUGIN_ROOT ||
  `${PROFILE_ROOT}/node_modules/@linxin666/dsh-ssh`;
const SSH_PLUGIN_VERSION = process.env.DSH_SSH_PLUGIN_VERSION || undefined;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const mode = process.argv[2] || "--check";
  const dshVersion = await readDshVersion(`${GLOBAL_DSH_ROOT}/package.json`);
  const common = {
    dshVersion,
    publicHost: PUBLIC_HOST,
    proxyAuthFile: PROXY_AUTH_FILE,
  };

  const sshPatch = async (apply) => {
    if (!SSH_PATCH_ENABLED) {
      console.log("DSH Orbit dsh-ssh patch: disabled (set DSH_ORBIT_PATCH_DSH_SSH=1 to enable)");
      return;
    }
    if (!(await exists(SSH_PLUGIN_ROOT))) {
      throw new Error(`dsh-ssh plugin is not installed at ${SSH_PLUGIN_ROOT}`);
    }
    const options = {
      root: SSH_PLUGIN_ROOT,
      publicHost: PUBLIC_HOST,
      proxyAuthFile: PROXY_AUTH_FILE,
      ...(SSH_PLUGIN_VERSION ? { pluginVersion: SSH_PLUGIN_VERSION } : {}),
    };
    const result = apply
      ? await patchDshSshPlugin(options)
      : await verifyDshSshPlugin(options);
    console.log(`${result.root}: dsh-ssh v${result.version} ${result.status}`);
  };

  let results = [];
  if (mode === "--build") {
    results = [
      await patchConnectionRoot({ root: GLOBAL_CONNECTION_ROOT, ...common }),
      await verifyConnectionRoot({ root: GLOBAL_CONNECTION_ROOT, publicHost: PUBLIC_HOST }),
    ];
  } else if (mode === "--runtime") {
    if (!(await exists(`${PROFILE_CONNECTION_ROOT}/index.js`))) {
      throw new Error(`Profile client-connection is not installed at ${PROFILE_CONNECTION_ROOT}`);
    }
    results = [
      await patchConnectionRoot({ root: PROFILE_CONNECTION_ROOT, ...common }),
      await verifyConnectionRoot({ root: PROFILE_CONNECTION_ROOT, publicHost: PUBLIC_HOST }),
    ];
    await sshPatch(true);
  } else if (mode === "--check") {
    results.push(await verifyConnectionRoot({ root: GLOBAL_CONNECTION_ROOT, publicHost: PUBLIC_HOST }));
    if (await exists(`${PROFILE_CONNECTION_ROOT}/index.js`)) {
      results.push(await verifyConnectionRoot({ root: PROFILE_CONNECTION_ROOT, publicHost: PUBLIC_HOST }));
    }
    await sshPatch(false);
  } else {
    throw new Error(`Unknown mode ${mode}. Use --build, --runtime, or --check.`);
  }

  console.log(`DSH upstream: ${dshVersion}`);
  for (const result of results) {
    const details = [result.server, result.client, result.status].filter(Boolean).join("/");
    console.log(`${result.root}: ${details}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
