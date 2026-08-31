#!/usr/bin/env node
// v0.3 Node Registry Client (SOP Stage 2-4).
//
// Commands:
//   (default)     run the heartbeat/report loop (daemon; keeps alive)
//   enroll        one-time enrollment with an operator token
//   reenroll      explicit re-enrollment (revoked node, operator token)
//   rotate        initiate credential rotation (signed with the old key)
//   status        print persisted + runtime state
//   doctor        integrity checks + non-mutating reachability probe
//
// Configuration (environment):
//   DSH_ORBIT_NODE_STATE              state file path (default ./node-state.json)
//   DSH_ORBIT_HUB_URL                 hub base URL (required; must match the
//                                     persisted binding once enrolled)
//   DSH_ORBIT_ENROLL_TOKEN            one-time enrollment token (enroll only)
//   DSH_ORBIT_REENROLL_TOKEN          tombstone-bound re-enrollment token
//   DSH_ORBIT_NODE_HEARTBEAT_SECONDS  cadence 30-300 (default 60; others fail closed)
//   DSH_ORBIT_NODE_ORBIT_VERSION      orbit version reported to the hub
//   DSH_ORBIT_NODE_ORBIT_REVISION     orbit revision reported to the hub
//   DSH_ORBIT_NODE_DSH_VERSION        DSH version reported to the hub
//   DSH_ORBIT_NODE_DSH_PROFILE        DSH compatibility profile

import process from "node:process";
import { NodeClient } from "../src/node/client.mjs";
import { assertStateFilePermissions, loadNodeStore, loadNodeStoreAsync } from "../src/node/store.mjs";

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`dsh-orbit-node: ${name} is required`);
    process.exit(2);
  }
  return value;
}

function buildClient({ storePath, forbidEnrollmentBinding = false }) {
  const hubBaseUrl = requireEnv("DSH_ORBIT_HUB_URL");
  const availability = {
    orbitVersion: process.env.DSH_ORBIT_NODE_ORBIT_VERSION ?? "0.3.0",
    orbitRevision: process.env.DSH_ORBIT_NODE_ORBIT_REVISION ?? null,
    dshVersion: process.env.DSH_ORBIT_NODE_DSH_VERSION ?? "",
    compatibilityProfile: process.env.DSH_ORBIT_NODE_DSH_PROFILE ?? null,
  };
  const store = loadNodeStore(storePath);
  // An enrolled store's persisted binding is part of the identity: a
  // runtime URL mismatch fails closed (P1-06). The state file holds the
  // private key: over-permissive POSIX permissions fail closed (P1-10).
  if (store.state !== "unenrolled") {
    assertStateFilePermissions(storePath);
  }
  return new NodeClient({
    store,
    storePath,
    hubBaseUrl,
    runtimeIdentity: () => availability,
    heartbeatCadenceSeconds: Number.parseInt(process.env.DSH_ORBIT_NODE_HEARTBEAT_SECONDS ?? "60", 10),
  });
}

const [command = "run"] = process.argv.slice(2);
const storePath = process.env.DSH_ORBIT_NODE_STATE ?? "./node-state.json";
let client;
try {
  client = buildClient({ storePath });
} catch (error) {
  console.error(`dsh-orbit-node: ${error.message}`);
  process.exit(2);
}

switch (command) {
  case "enroll": {
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
    console.log(JSON.stringify(client.status(), null, 2));
    break;
  }
  case "doctor": {
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
    // The main heartbeat loop timer is REF'd: the daemon must stay alive
    // on its own (P1-04). Only the shutdown watchdog may unref.
    let mainTimer = null;
    const cadenceMs = client.heartbeatCadenceSeconds * 1000;
    loadNodeStoreAsync(storePath)
      .then(async (store) => {
        client.store = store;
        await client.recoverAfterRestart();
        console.log(`dsh-orbit-node: running against ${client.status().hubBaseUrl} (cadence ${client.heartbeatCadenceSeconds}s, state ${client.status().state})`);
        const loop = async () => {
          try {
            const outcome = await client.tick();
            if (outcome.attempted && !outcome.ok) {
              process.stderr.write(`dsh-orbit-node: ${outcome.state}: ${outcome.error?.message ?? "failure"}\n`);
            }
          } catch (error) {
            process.stderr.write(`dsh-orbit-node: tick failed: ${error.message}\n`);
          }
          // Keep the process alive: no unref() on the main scheduler.
          mainTimer = setTimeout(loop, Math.min(cadenceMs, 1000));
        };
        loop();
      })
      .catch((error) => {
        console.error(`dsh-orbit-node: cannot load state: ${error.message}`);
        process.exit(1);
      });

    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`dsh-orbit-node: ${signal}, shutting down`);
      if (mainTimer) clearTimeout(mainTimer);
      setTimeout(() => process.exit(0), 200).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }
}