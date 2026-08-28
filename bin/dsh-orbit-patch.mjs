#!/usr/bin/env node

import { access } from "node:fs/promises";
import process from "node:process";
import {
  patchConnectionRoot,
  readDshVersion,
  verifyConnectionRoot,
} from "../src/remote-settings-patch.mjs";

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
  } else if (mode === "--check") {
    results.push(await verifyConnectionRoot({ root: GLOBAL_CONNECTION_ROOT, publicHost: PUBLIC_HOST }));
    if (await exists(`${PROFILE_CONNECTION_ROOT}/index.js`)) {
      results.push(await verifyConnectionRoot({ root: PROFILE_CONNECTION_ROOT, publicHost: PUBLIC_HOST }));
    }
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
