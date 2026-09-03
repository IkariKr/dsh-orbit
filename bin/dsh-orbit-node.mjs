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
//   DSH_ORBIT_NODE_CA_CERT            optional private-CA PEM or PEM file for Hub HTTPS
//   DSH_ORBIT_NODE_ROUTE_INGRESS_DISABLED set 1 to suppress the Stage 2 route ingress
//   DSH_ORBIT_NODE_ROUTE_INGRESS_PORT route-ingress listen port (default 0; use a fixed port for persistent route targets)
//   DSH_ORBIT_NODE_ROUTE_INGRESS_LISTEN route-ingress listen address (default 127.0.0.1)
//   DSH_ORBIT_NODE_ROUTE_DOMAIN       deterministic v0.4 route domain (default localhost)
//   DSH_ORBIT_NODE_DSH_TARGET         node-local DSH transport target (default http://127.0.0.1:3080)
//   DSH_ORBIT_NODE_ROUTE_TLS_KEY/CERT optional TLS PEM values or file paths; both are required together

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { NodeClient } from "../src/node/client.mjs";
import { RouteIngress } from "../src/node/route-ingress.mjs";
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
  // The state file can carry private keys in ANY state — including a
  // pendingEnrollment on an unenrolled store (round-2 P2-01) — so the
  // POSIX permission check applies to every existing state file.
  assertStateFilePermissions(storePath);

  let caCertificates = null;
  if (process.env.DSH_ORBIT_NODE_CA_CERT) {
    const caTarget = process.env.DSH_ORBIT_NODE_CA_CERT;
    try {
      if (existsSync(caTarget)) {
        caCertificates = [readFileSync(caTarget, "utf8")];
      } else {
        caCertificates = [caTarget];
      }
    } catch {
      caCertificates = [caTarget];
    }
  }

  return new NodeClient({
    store,
    storePath,
    hubBaseUrl,
    caCertificates,
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
  case "upload-report": {
    const reportFile = requireEnv("DSH_ORBIT_REPORT_FILE");
    try {
      const report = JSON.parse(await readFile(reportFile, "utf8"));
      const result = await client.uploadReport(report);
      const count = Array.isArray(result.capabilities) ? result.capabilities.length : 0;
      console.log(`uploaded: orbitCompatible ${result.orbitCompatible}, capabilities ${count}`);
    } catch (error) {
      console.error(`report upload failed: ${error.message}`);
      process.exitCode = 1;
    }
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
    let ingress = null;
    const cadenceMs = client.heartbeatCadenceSeconds * 1000;

    const routeIngressDisabled = process.env.DSH_ORBIT_NODE_ROUTE_INGRESS_DISABLED === "1";
    const ingressPort = Number(process.env.DSH_ORBIT_NODE_ROUTE_INGRESS_PORT ?? "0");
    const ingressListen = process.env.DSH_ORBIT_NODE_ROUTE_INGRESS_LISTEN ?? "127.0.0.1";
    const routeDomain = process.env.DSH_ORBIT_NODE_ROUTE_DOMAIN ?? "localhost";
    const dshTarget = process.env.DSH_ORBIT_NODE_DSH_TARGET ?? "http://127.0.0.1:3080";
    if (!Number.isInteger(ingressPort) || ingressPort < 0 || ingressPort > 65535) {
      console.error("dsh-orbit-node: DSH_ORBIT_NODE_ROUTE_INGRESS_PORT must be an integer from 0 to 65535");
      process.exit(2);
    }

    const tlsKeyConfigured = Boolean(process.env.DSH_ORBIT_NODE_ROUTE_TLS_KEY);
    const tlsCertConfigured = Boolean(process.env.DSH_ORBIT_NODE_ROUTE_TLS_CERT);
    if (tlsKeyConfigured !== tlsCertConfigured) {
      console.error("dsh-orbit-node: DSH_ORBIT_NODE_ROUTE_TLS_KEY and DSH_ORBIT_NODE_ROUTE_TLS_CERT must be configured together");
      process.exit(2);
    }

    let tls = null;
    if (tlsKeyConfigured && tlsCertConfigured) {
      const keyVal = process.env.DSH_ORBIT_NODE_ROUTE_TLS_KEY;
      const certVal = process.env.DSH_ORBIT_NODE_ROUTE_TLS_CERT;
      const key = existsSync(keyVal) ? readFileSync(keyVal, "utf8") : keyVal;
      const cert = existsSync(certVal) ? readFileSync(certVal, "utf8") : certVal;
      tls = { key, cert };
    }
    const loopbackIngress = ingressListen === "127.0.0.1" || ingressListen === "::1" || ingressListen === "[::1]";
    if (!routeIngressDisabled && !tls && !loopbackIngress) {
      console.error("dsh-orbit-node: non-loopback route ingress requires TLS; bind plaintext ingress to explicit loopback only");
      process.exit(2);
    }

    loadNodeStoreAsync(storePath)
      .then(async (store) => {
        client.store = store;
        await client.recoverAfterRestart();

        if (!routeIngressDisabled) {
          ingress = new RouteIngress({
            nodeId: () => client.store.nodeId,
            routeDomain,
            dshTarget,
            tls,
            getTrustKeys: () => client.getHubRouteKeys(),
            getNodeState: () => client.status().state,
          });
          client.routeIngress = ingress;
          await ingress.listen(ingressPort, ingressListen);
          const scheme = tls ? "https" : "http";
          console.log(`dsh-orbit-node: route ingress listening on ${scheme}://${ingressListen}:${ingress.port} (target ${dshTarget})`);
        }

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
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`dsh-orbit-node: ${signal}, shutting down`);
      if (mainTimer) clearTimeout(mainTimer);
      if (ingress) {
        try {
          await ingress.close();
        } catch {}
      }
      setTimeout(() => process.exit(0), 200).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }
}