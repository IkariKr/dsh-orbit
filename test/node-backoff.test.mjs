// Heartbeat backoff (SOP Stage 3): exponential growth, jitter bounds,
// cap, and reset on success.

import assert from "node:assert/strict";
import test from "node:test";
import { BACKOFF_MAX_MS, HeartbeatBackoff } from "../src/node/backoff.mjs";

test("backoff grows exponentially toward the cap", () => {
  let now = 0;
  const backoff = new HeartbeatBackoff({ now: () => now, random: () => 0.5, initialMs: 1000 });
  const delays = [];
  for (let index = 0; index < 10; index += 1) {
    delays.push(backoff.recordFailure());
  }
  assert.deepEqual(delays.slice(0, 4), [1000, 2000, 4000, 8000]);
  assert.equal(delays.at(-1), BACKOFF_MAX_MS);
  assert.equal(delays.every((delay) => delay <= BACKOFF_MAX_MS), true);
});

test("jitter stays within +/-20% of the base delay", () => {
  const backoff = new HeartbeatBackoff({ now: () => 0, random: () => 1, initialMs: 1000 });
  const high = backoff.recordFailure();
  assert.equal(high, 1200);
  const low = new HeartbeatBackoff({ now: () => 0, random: () => 0, initialMs: 1000 });
  assert.equal(low.recordFailure(), 800);
});

test("success resets the backoff and clears the due window", () => {
  let now = 0;
  const backoff = new HeartbeatBackoff({ now: () => now, random: () => 0.5 });
  backoff.recordFailure();
  backoff.recordFailure();
  assert.equal(backoff.due(), false);
  now = 10_000;
  assert.equal(backoff.due(), true);
  backoff.recordSuccess();
  assert.equal(backoff.attempt, 0);
  assert.equal(backoff.due(), true);
  assert.equal(backoff.lastDelayMs, 0);
});

test("nextAttemptAt schedules the next attempt after the backoff delay", () => {
  let now = 1_000_000;
  const backoff = new HeartbeatBackoff({ now: () => now, random: () => 0.5 });
  backoff.recordFailure();
  assert.equal(backoff.nextAttemptAt, 1_001_000);
  assert.equal(backoff.due(), false);
  now = 1_001_000;
  assert.equal(backoff.due(), true);
});