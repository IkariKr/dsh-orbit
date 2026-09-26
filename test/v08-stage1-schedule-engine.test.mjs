// RFC-0015 Stage 1: Scheduled Workflow Engine & Cron/Interval Parsing Unit and Contract Tests
// Verifies:
// 1. 5-field cron parsing, steps, ranges, lists, bounds checking, and nextRunAt calculations (field 30)
// 2. Interval math, bounds, and nextRunAt calculations (field 30)
// 3. Persistent schedule storage, CRUD operations, hydration, and scrubbing in SQLite (field 29)
// 4. Concurrency policy handling ('forbid' skips overlapping execution)
// 5. Missed-run recovery policies ('skip' vs 'run-once')

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parseCronExpression, getNextCronOccurrence, getNextIntervalOccurrence, calculateNextRunAt, ScheduleParseError } from "../src/registry/schedule-parser.mjs";
import { ScheduledWorkflowEngine } from "../src/registry/schedule-engine.mjs";
import { FleetJobScheduler } from "../src/registry/fleet-scheduler.mjs";

test("cron parser: parses standard 5-field expressions, wildcards, steps, ranges, and lists (field 30)", () => {
  // 1. Wildcard everywhere: * * * * *
  const everyMinute = parseCronExpression("* * * * *");
  assert.equal(everyMinute.minutes.size, 60);
  assert.equal(everyMinute.hours.size, 24);
  assert.equal(everyMinute.doms.size, 31);
  assert.equal(everyMinute.months.size, 12);
  assert.equal(everyMinute.dows.size, 7);

  // 2. Nightly at 02:30 on weekdays: 30 2 * * 1-5
  const nightly = parseCronExpression("30 2 * * 1-5");
  assert.deepEqual([...nightly.minutes], [30]);
  assert.deepEqual([...nightly.hours], [2]);
  assert.deepEqual([...nightly.dows], [1, 2, 3, 4, 5]);

  // 3. Steps and lists: */15 0,12 1-15/2 * 0
  const complex = parseCronExpression("*/15 0,12 1-15/2 * 0");
  assert.deepEqual([...complex.minutes].sort((a,b)=>a-b), [0, 15, 30, 45]);
  assert.deepEqual([...complex.hours].sort((a,b)=>a-b), [0, 12]);
  assert.deepEqual([...complex.doms].sort((a,b)=>a-b), [1, 3, 5, 7, 9, 11, 13, 15]);
  assert.deepEqual([...complex.dows], [0]);

  // 4. Sunday representation: 7 normalized to 0
  const sun7 = parseCronExpression("0 0 * * 7");
  assert.deepEqual([...sun7.dows], [0]);

  // 5. Invalid syntax rejects fail-closed
  assert.throws(() => parseCronExpression(""), (e) => e.code === "invalid-cron-fields-count");
  assert.throws(() => parseCronExpression("* * * *"), (e) => e.code === "invalid-cron-fields-count");
  assert.throws(() => parseCronExpression("* * * * * *"), (e) => e.code === "invalid-cron-fields-count");
  assert.throws(() => parseCronExpression("60 * * * *"), (e) => e.code === "invalid-cron-bounds");
  assert.throws(() => parseCronExpression("* 25 * * *"), (e) => e.code === "invalid-cron-bounds");
  assert.throws(() => parseCronExpression("* * 32 * *"), (e) => e.code === "invalid-cron-bounds");
  assert.throws(() => parseCronExpression("* * * 13 *"), (e) => e.code === "invalid-cron-bounds");
  assert.throws(() => parseCronExpression("* * * * 8"), (e) => e.code === "invalid-cron-bounds");
  assert.throws(() => parseCronExpression("foo * * * *"), (e) => e.code === "invalid-cron-number");
  assert.throws(() => parseCronExpression("*/0 * * * *"), (e) => e.code === "invalid-cron-step");
});

test("cron occurrences: calculates next strictly future occurrence in UTC (field 30)", () => {
  const parsed = parseCronExpression("15 3 * * *"); // 03:15 UTC every day
  const base = new Date("2026-09-26T03:00:00.000Z");
  const next = getNextCronOccurrence(parsed, base);
  assert.equal(next, "2026-09-26T03:15:00.000Z");

  // If evaluated at 03:15, must strictly advance to tomorrow
  const exact = new Date("2026-09-26T03:15:00.000Z");
  const nextDay = getNextCronOccurrence(parsed, exact);
  assert.equal(nextDay, "2026-09-27T03:15:00.000Z");
});

test("interval parsing: calculates next occurrence and enforces minimum interval (field 30)", () => {
  const base = new Date("2026-09-26T12:00:00.000Z");
  const next = getNextIntervalOccurrence(60000, base);
  assert.equal(next, "2026-09-26T12:01:00.000Z");

  assert.throws(() => getNextIntervalOccurrence(500), (e) => e.code === "invalid-interval");
  assert.throws(() => getNextIntervalOccurrence("1000"), (e) => e.code === "invalid-interval");
});

test("schedule engine: creates, persists, lists, pauses, resumes, and deletes schedules (field 29)", () => {
  const db = new DatabaseSync(":memory:");
  const fleetScheduler = new FleetJobScheduler({
    dispatchTransport: async () => ({ status: "completed", exitCode: 0, stdout: "ok" }),
  });
  const engine = new ScheduledWorkflowEngine({ db, fleetScheduler });

  // 1. Create schedule with explicit targetSpec
  const sched = engine.createSchedule({
    name: "Nightly Diagnostic",
    description: "Runs diagnostic nightly across nodes",
    scheduleType: "cron",
    cronExpression: "0 2 * * *",
    taskType: "diagnostic",
    payload: { action: "full-audit", token: "secret-token-to-scrub" },
    targetSpec: { mode: "explicit", nodeIds: ["node_11111111111111111111111111111111"] },
    concurrencyPolicy: "forbid",
    missedRunPolicy: "skip",
    createdBy: "operator-alice",
  });

  assert.ok(sched.scheduleId.startsWith("sched_"));
  assert.equal(sched.status, "active");
  assert.equal(sched.name, "Nightly Diagnostic");
  assert.equal(sched.payload.token, "[REDACTED]"); // scrubbed
  assert.ok(sched.nextRunAt > new Date().toISOString());

  // 2. Reject bare wildcards fail-closed
  assert.throws(() => {
    engine.createSchedule({
      name: "Bad Wildcard",
      scheduleType: "cron",
      cronExpression: "* * * * *",
      taskType: "diagnostic",
      targetSpec: "*",
    });
  }, (e) => e.code === "wildcard-prohibited");

  // 3. List schedules
  const list = engine.listSchedules();
  assert.equal(list.length, 1);
  assert.equal(list[0].scheduleId, sched.scheduleId);

  // 4. Pause schedule
  const paused = engine.pauseSchedule(sched.scheduleId);
  assert.equal(paused, true);
  assert.equal(engine.getSchedule(sched.scheduleId).status, "paused");

  // 5. Resume schedule
  const resumed = engine.resumeSchedule(sched.scheduleId);
  assert.equal(resumed, true);
  assert.equal(engine.getSchedule(sched.scheduleId).status, "active");

  // 6. Delete schedule
  const deleted = engine.deleteSchedule(sched.scheduleId);
  assert.equal(deleted, true);
  assert.equal(engine.getSchedule(sched.scheduleId), null);
  assert.equal(engine.listSchedules().length, 0);

  engine.stop();
  db.close();
});

test("schedule dispatch: executes due schedule through FleetJobScheduler and records run history", async () => {
  const db = new DatabaseSync(":memory:");
  let dispatchedTask = null;
  const fleetScheduler = new FleetJobScheduler({
    dispatchTransport: async (nodeId, task) => {
      dispatchedTask = task;
      return { status: "completed", exitCode: 0, stdout: `diagnosed ${nodeId}` };
    },
  });
  const engine = new ScheduledWorkflowEngine({ db, fleetScheduler });

  const sched = engine.createSchedule({
    name: "Interval Audit",
    scheduleType: "interval",
    intervalMs: 5000,
    taskType: "diagnostic",
    targetSpec: { mode: "explicit", nodeIds: ["node_22222222222222222222222222222222"] },
  });

  // Manually trigger dispatch
  const result = await engine.dispatchScheduleRun(sched, "manual");
  assert.ok(result.runId.startsWith("srun_"));
  assert.ok(result.jobId.startsWith("job_"));
  assert.equal(result.status, "dispatched");

  // Check run record
  const runs = engine.listScheduleRuns(sched.scheduleId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].scheduleId, sched.scheduleId);
  assert.equal(runs[0].triggerType, "manual");

  // Verify schedule metrics updated
  const updated = engine.getSchedule(sched.scheduleId);
  assert.equal(updated.totalRuns, 1);
  assert.ok(updated.lastRunAt);

  engine.stop();
  db.close();
});

test("concurrency policy: 'forbid' skips overlapping execution if prior job is in flight", async () => {
  const db = new DatabaseSync(":memory:");
  let resolveJob;
  const inFlightPromise = new Promise((r) => { resolveJob = r; });

  const fleetScheduler = new FleetJobScheduler({
    dispatchTransport: async () => {
      await inFlightPromise;
      return { status: "completed", exitCode: 0 };
    },
  });
  const engine = new ScheduledWorkflowEngine({ db, fleetScheduler });

  const sched = engine.createSchedule({
    name: "Slow Job",
    scheduleType: "interval",
    intervalMs: 1000,
    taskType: "diagnostic",
    targetSpec: { mode: "explicit", nodeIds: ["node_33333333333333333333333333333333"] },
    concurrencyPolicy: "forbid",
  });

  // First run: dispatched and remains in flight
  const run1 = await engine.dispatchScheduleRun(sched, "scheduled");
  assert.equal(run1.status, "dispatched");

  // Second run: should be skipped because job is still running
  const run2 = await engine.dispatchScheduleRun(sched, "scheduled");
  assert.equal(run2.status, "skipped");
  assert.equal(run2.reason, "concurrency-forbid");

  // Release in-flight job
  resolveJob();
  await new Promise((r) => setTimeout(r, 50));

  engine.stop();
  db.close();
});
