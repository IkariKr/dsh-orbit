// Maintenance scheduler for the hub (round-2 P1): a 30s tick keeps the
// default 3x60s stale threshold and the 24h lost threshold reachable in
// production, and one maintenance pass runs immediately at startup so a
// freshly started hub never waits for the first tick.

import { MAINTENANCE_TICK_MS, ROUTE_PROBE_CADENCE_SECONDS_DEFAULT } from "./protocol.mjs";

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

export function createRouteProbeScheduler(
  registry,
  { cadenceSeconds = ROUTE_PROBE_CADENCE_SECONDS_DEFAULT, runImmediately = true } = {},
) {
  if (typeof registry.probeAllNodes !== "function") {
    throw new Error("route probe scheduler requires a registry with probeAllNodes()");
  }
  let probing = false;
  const tick = async () => {
    if (probing) return;
    probing = true;
    try {
      await registry.probeAllNodes();
    } catch {
      // Probing errors are handled within probeNode, but catch here to guarantee probing flag resets
    } finally {
      probing = false;
    }
  };

  if (runImmediately) {
    tick();
  }
  const timer = setInterval(tick, cadenceSeconds * 1000);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}