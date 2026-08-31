#!/usr/bin/env node
// v0.3 Node Registry Client (SOP Stage 2-4).
//
// Commands:
//   (default)     run the heartbeat/report loop
//   enroll        one-time enrollment with an operator token
//   status        print persisted + runtime state
//   doctor        integrity checks + live hub probe (never mutates)
//   rotate        initiate credential rotation (signed with the old key)
//   reenroll      explicit re-enrollment (revoked node, operator token)
//
// Configuration (environment):
//   DSH_ORBIT_NODE_STATE              state file path (default ./node-state.json)
//   DSH_ORBIT_HUB_URL                 hub base URL (required)
//   DSH_ORBIT_ENROLL_TOKEN            one-time enrollment token (enroll only)
//   DSH_ORBIT_REENROLL_TOKEN          tombstone-bound re-enrollment token
//   DSH_ORBIT_NODE_HEARTBEAT_SECONDS  cadence 30-300 (default 60)
//   DSH_ORBIT_NODE_ORBIT_VERSION      orbit version reported to the hub
//   DSH_ORBIT_NODE_ORBIT_REVISION     orbit revision reported to the hub
//   DSH_ORBIT_NODE_DSH_VERSION        DSH version reported to the hub
//   DSH_ORBIT_NODE_DSH_PROFILE        DSH compatibility profile

import process from "node:process";
import { NodeClient } from "../src/node/client.mjs";
import { loadNodeStore, loadNodeStoreAsync } from "../src/node/store.mjs";

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`dsh-orbit-node: ${name} is required`);
    process.exit(2);
  }
  return value;
}

function buildClient({ storePath }) {
  const hubBaseUrl = requireEnv("DSH_ORBIT_HUB_URL");
  const availability = {
    orbitVersion: process.env.DSH_ORBIT_NODE_ORBIT_VERSION ?? "0.3.0",
    orbitRevision: process.env.DSH_ORBIT_NODE_ORBIT_REVISION ?? null,
    dshVersion: process.env.DSH_ORBIT_NODE_DSH_VERSION ?? "",
    compatibilityProfile: process.env.DSH_ORBIT_NODE_DSH_PROFILE ?? null,
  };
  const store = loadNodeStore(storePath);
  const client = new NodeClient({
    store,
    storePath,
    hubBaseUrl,
    runtimeIdentity: () => availability,
    heartbeatCadenceSeconds: Number.parseInt(process.env.DSH_ORBIT_NODE_HEARTBEAT_SECONDS ?? "60", 10),
  });
  return client;
}

const [command = "run"] = process.argv.slice(2);
const storePath = process.env.DSH_ORBIT_NODE_STATE ?? "./node-state.json";

switch (command) {
  case "enroll": {
    const client = buildClient({ storePath });
    const token = requireEnv("DSH_ORBIT_ENROLL_TOKEN");
    client
      .enroll({ token })
      .then((result) => {
        console.log(`enrolled: ${result.nodeId} (keyId ${result.keyId})`);
      })
      .catch((error) => {
        console.error(`enroll failed: ${error.message}`);
        process.exit(1);
      });
    break;
  }
  case "reenroll": {
    const client = buildClient({ storePath });
    const token = requireEnv("DSH_ORBIT_REENROLL_TOKEN");
    client
      .reenroll({ token })
      .then((result) => {
        console.log(`re-enrolled: ${result.nodeId} (keyId ${result.keyId})`);
      })
      .catch((error) => {
        console.error(`re-enroll failed: ${error.message}`);
        process.exit(1);
      });
    break;
  }
  case "rotate": {
    const client = buildClient({ storePath });
    client
      .rotateCredential()
      .then((result) => {
        console.log(`rotated: ${result.oldKeyId} -> ${result.newKeyId} (overlap until ${result.overlapUntil})`);
      })
      .catch((error) => {
        console.error(`rotation failed: ${error.message}`);
        process.exit(1);
      });
    break;
  }
  case "status": {
    const client = buildClient({ storePath });
    console.log(JSON.stringify(client.status(), null, 2));
    break;
  }
  case "doctor": {
    // Doctor loads the store fresh and never writes state.
    const client = buildClient({ storePath });
    client
      .doctor()
      .then((report) => {
        console.log(JSON.stringify(report, null, 2));
        const failed = report.findings.some((finding) => finding.severity === "fail");
        process.exit(failed ? 1 : 0);
      })
      .catch((error) => {
        console.error(`doctor failed: ${error.message}`);
        process.exit(1);
      });
    break;
  }
  case "run":
  default: {
    const client = buildClient({ storePath });
    const cadenceMs = client.heartbeatCadenceSeconds * 1000;
    loadNodeStoreAsync(storePath)
      .then(async (store) => {
        client.store = store;
        await client.recoverAfterRestart();
        console.log(`dsh-orbit-node: running against ${client.hubBaseUrl} (state ${client.status().state})`);
        const loop = async () => {
          try {
            const outcome = await client.tick();
            if (outcome.attempted && !outcome.ok) {
              process.stderr.write(`dsh-orbit-node: ${outcome.state}: ${outcome.error?.message ?? "failure"}\n`);
            }
          } catch (error) {
            process.stderr.write(`dsh-orbit-node: tick failed: ${error.message}\n`);
          }
          setTimeout(loop, Math.min(cadenceMs, 1000)).unref();
        };
        loop();
      })
      .catch((error) => {
        console.error(`dsh-orbit-node: cannot load state: ${error.message}`);
        process.exit(1);
      });
  }
}