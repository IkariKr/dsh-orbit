#!/usr/bin/env node
// Private mounted-drill machine ingress. Only the fixed Registry machine
// route family is reachable; browser/admin paths are denied before upstream.

import process from "node:process";
import { createMachineIngressServer } from "../src/registry/machine-ingress.mjs";

const server = createMachineIngressServer({ listenPort: 5446, upstream: "http://127.0.0.1:5445" });
server.listen(5446, "0.0.0.0", () => {
  console.log("dsh-orbit-machine-ingress: listening privately on 5446");
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
