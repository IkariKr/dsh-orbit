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
import { createMaintenanceScheduler } from "../src/registry/scheduler.mjs";
import { validateHubConfig } from "../src/registry/config.mjs";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";

const dbPath = process.env.DSH_ORBIT_HUB_DB ?? "./registry.db";
const port = Number.parseInt(process.env.DSH_ORBIT_HUB_PORT ?? "5445", 10);
const listen = process.env.DSH_ORBIT_HUB_LISTEN ?? "127.0.0.1";
const gatewaySecret = process.env.DSH_ORBIT_HUB_GATEWAY_SECRET ?? null;
const singlePrincipal = process.env.DSH_ORBIT_HUB_OPERATOR_PRINCIPAL ?? null;
const lanBoundaryOnly = process.env.DSH_ORBIT_HUB_LAN_BOUNDARY_ONLY === "1";
const trustedExternalScheme = process.env.DSH_ORBIT_HUB_TRUSTED_SCHEME ?? "http";
const rotationOverlapHours = Number.parseInt(process.env.DSH_ORBIT_HUB_ROTATION_OVERLAP_H ?? "24", 10);

const configErrors = validateHubConfig({ listen, trustedExternalScheme });
if (configErrors.length > 0) {
  for (const error of configErrors) {
    console.error(`dsh-orbit-hub: ${error}`);
  }
  process.exit(1);
}

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
const options = { lanBoundaryOnly, trustedExternalScheme };
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

// 30s maintenance tick with an immediate pass at startup (round-2 P1):
// the default 3x60s stale threshold and 24h lost threshold are only
// reachable when maintenance actually runs at that cadence.
const maintenanceScheduler = createMaintenanceScheduler(registry, { tickMs: 30 * 1000 });

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`dsh-orbit-hub: ${signal}, shutting down`);
  maintenanceScheduler.stop();
  server.close(() => {
    registry.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));