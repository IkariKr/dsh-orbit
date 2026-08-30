// Maintenance scheduler for the hub (round-2 P1): a 30s tick keeps the
// default 3x60s stale threshold and the 24h lost threshold reachable in
// production, and one maintenance pass runs immediately at startup so a
// freshly started hub never waits for the first tick.

import { MAINTENANCE_TICK_MS } from "./protocol.mjs";

export function createMaintenanceScheduler(registry, { tickMs = MAINTENANCE_TICK_MS, runImmediately = true } = {}) {
  if (typeof registry.maintenance !== "function") {
    throw new Error("maintenance scheduler requires a registry with maintenance()");
  }
  if (runImmediately) registry.maintenance();
  const timer = setInterval(() => {
    registry.maintenance();
  }, tickMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}