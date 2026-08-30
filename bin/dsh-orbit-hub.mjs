#!/usr/bin/env node
// v0.3 Registry MVP hub. Starts the machine API (RFC-0006) and the
// browser management API (RFC-0007) over one listener backed by a
// SQLite/WAL registry (RFC-0005 D7).
//
// Configuration (environment):
//   DSH_ORBIT_HUB_DB                 registry database path (default ./registry.db)
//   DSH_ORBIT_HUB_PORT               listen port (default 5445)
//   DSH_ORBIT_HUB_LISTEN             listen address (default 127.0.0.1)
//   DSH_ORBIT_HUB_GATEWAY_SECRET     gateway-held internal assertion secret;
//                                    required for browser management, or
//                                    DSH_ORBIT_HUB_LAN_BOUNDARY_ONLY=1
//   DSH_ORBIT_HUB_OPERATOR_PRINCIPAL fixed single operator principal
//   DSH_ORBIT_HUB_LAN_BOUNDARY_ONLY  accept browser requests from loopback only
//   DSH_ORBIT_HUB_ROTATION_OVERLAP_H rotation overlap in hours (1-168, default 24)

import process from "node:process";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`dsh-orbit-hub: ${name} is required`);
    process.exit(1);
  }
  return value;
}

const dbPath = process.env.DSH_ORBIT_HUB_DB ?? "./registry.db";
const port = Number.parseInt(process.env.DSH_ORBIT_HUB_PORT ?? "5445", 10);
const listen = process.env.DSH_ORBIT_HUB_LISTEN ?? "127.0.0.1";
const gatewaySecret = process.env.DSH_ORBIT_HUB_GATEWAY_SECRET ?? null;
const singlePrincipal = process.env.DSH_ORBIT_HUB_OPERATOR_PRINCIPAL ?? null;
const lanBoundaryOnly = process.env.DSH_ORBIT_HUB_LAN_BOUNDARY_ONLY === "1";
const rotationOverlapHours = Number.parseInt(process.env.DSH_ORBIT_HUB_ROTATION_OVERLAP_H ?? "24", 10);

if (gatewaySecret === null && !lanBoundaryOnly) {
  console.error(
    "dsh-orbit-hub: browser management needs DSH_ORBIT_HUB_GATEWAY_SECRET (gateway-held assertion) or DSH_ORBIT_HUB_LAN_BOUNDARY_ONLY=1",
  );
  process.exit(1);
}

const registry = new Registry({
  db: openRegistryDatabase(dbPath),
  rotationOverlapHours,
});
const options = { lanBoundaryOnly };
if (gatewaySecret !== null) options.gatewayAssertionSecret = gatewaySecret;
if (singlePrincipal !== null) {
  options.operatorPrincipal = { mode: "single", principal: singlePrincipal };
} else {
  options.operatorPrincipal = { mode: "inject" };
}

const { server } = createHubServer({ registry, options });
server.listen(port, listen, () => {
  console.log(`dsh-orbit-hub: registry listening on http://${listen}:${port} (db ${dbPath})`);
});

const maintenanceTimer = setInterval(() => {
  try {
    registry.maintenance();
  } catch (error) {
    console.error(`dsh-orbit-hub: maintenance failed: ${error.stack ?? error}`);
  }
}, 15 * 60 * 1000);
maintenanceTimer.unref();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`dsh-orbit-hub: ${signal}, shutting down`);
  server.close(() => {
    clearInterval(maintenanceTimer);
    registry.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));