#!/usr/bin/env node
// Private mounted-drill machine ingress. Only the fixed Registry machine
// route family is reachable; browser/admin paths are denied before upstream.

import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { createMachineIngressServer } from "../src/registry/machine-ingress.mjs";

function requiredTlsPem(name) {
  const value = process.env[name];
  if (value === undefined || value === "") return null;
  try {
    return existsSync(value) ? readFileSync(value, "utf8") : value;
  } catch (error) {
    throw new Error(`${name} could not be read: ${error.message}`);
  }
}

const tlsKey = requiredTlsPem("DSH_ORBIT_MACHINE_INGRESS_TLS_KEY");
const tlsCert = requiredTlsPem("DSH_ORBIT_MACHINE_INGRESS_TLS_CERT");
if ((tlsKey === null) !== (tlsCert === null)) {
  throw new Error("DSH_ORBIT_MACHINE_INGRESS_TLS_KEY and DSH_ORBIT_MACHINE_INGRESS_TLS_CERT must be configured together");
}
if (tlsKey === null) {
  throw new Error("private machine ingress requires verified TLS listener configuration");
}

const server = createMachineIngressServer({
  listenPort: 5446,
  upstream: "http://127.0.0.1:5445",
  tls: { key: tlsKey, cert: tlsCert },
});
server.listen(5446, "0.0.0.0", () => {
  console.log("dsh-orbit-machine-ingress: listening privately on verified TLS 5446");
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
