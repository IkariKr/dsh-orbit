// Round-2 P1 (production maintenance cadence): the hub must run
// maintenance at a cadence that makes the 3x60s stale threshold and
// 24h lost threshold reachable (30s tick), and once immediately at
// startup so a fresh hub never waits for the first tick.

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createMaintenanceScheduler, createRouteProbeScheduler } from "../src/registry/scheduler.mjs";

test("the scheduler runs maintenance immediately at startup", () => {
  let calls = 0;
  const registry = { maintenance: () => (calls += 1) };
  const scheduler = createMaintenanceScheduler(registry, { tickMs: 60_000, runImmediately: true });
  assert.equal(calls, 1);
  scheduler.stop();
});

test("runImmediately=false skips the startup pass", () => {
  let calls = 0;
  const registry = { maintenance: () => (calls += 1) };
  const scheduler = createMaintenanceScheduler(registry, { tickMs: 60_000, runImmediately: false });
  assert.equal(calls, 0);
  scheduler.stop();
});

test("the scheduler ticks at the configured cadence and stops cleanly", async () => {
  let calls = 0;
  const registry = { maintenance: () => (calls += 1) };
  const scheduler = createMaintenanceScheduler(registry, { tickMs: 20, runImmediately: true });
  await sleep(70);
  assert.ok(calls >= 3, `expected at least 3 maintenance runs, got ${calls}`);
  scheduler.stop();
  const afterStop = calls;
  await sleep(60);
  assert.equal(calls, afterStop);
});

test("the scheduler requires a registry with maintenance()", () => {
  assert.throws(() => createMaintenanceScheduler({}), /maintenance\(\)/);
});

test("the route probe scheduler runs probeAllNodes immediately and avoids overlap", async () => {
  let calls = 0;
  let inFlight = false;
  let overlapping = false;
  const registry = {
    probeAllNodes: async () => {
      if (inFlight) overlapping = true;
      inFlight = true;
      calls += 1;
      await sleep(15);
      inFlight = false;
    },
  };
  const scheduler = createRouteProbeScheduler(registry, { cadenceSeconds: 0.02, runImmediately: true });
  await sleep(60);
  assert.ok(calls >= 2);
  assert.equal(overlapping, false);
  scheduler.stop();
  const after = calls;
  await sleep(40);
  assert.equal(calls, after);
});

test("the route probe scheduler requires a registry with probeAllNodes()", () => {
  assert.throws(() => createRouteProbeScheduler({}), /probeAllNodes\(\)/);
});