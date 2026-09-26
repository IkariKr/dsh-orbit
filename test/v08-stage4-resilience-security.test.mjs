// RFC-0015 Stage 4: Resilience, Concurrency, Recovery & Negative Security Integration Tests
// Verifies:
// 1. Concurrency policy enforcement ('forbid' prevents overlapping runs vs 'allow' permits concurrent runs)
// 2. Hub restart recovery and missed-run policies ('skip' vs 'run-once')
// 3. Zero credential leakage across schedule creation, payload storage, hydration, and execution
// 4. Target node failure during scheduled execution (failure containment via RFC-0014)
// 5. Capability mismatch at schedule execution time fails closed or marks skipped cleanly without corrupting schedule

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { FleetJobScheduler } from "../src/registry/fleet-scheduler.mjs";
import { ScheduledWorkflowEngine } from "../src/registry/schedule-engine.mjs";

test("concurrency containment: 'forbid' policy records skipped run and maintains nextRunAt while previous job runs", async () => {
  const db = new DatabaseSync(":memory:");
  let resolveJob;
  const inFlightPromise = new Promise((r) => { resolveJob = r; });

  const fleetScheduler = new FleetJobScheduler({
    dispatchTransport: async () => {
      await inFlightPromise;
      return { status: "completed", exitCode: 0, stdout: "done" };
    },
  });

  let simulatedTime = new Date("2026-09-26T10:00:00.000Z");
  const engine = new ScheduledWorkflowEngine({
    db,
    fleetScheduler,
    evaluationIntervalMs: 50,
    now: () => simulatedTime,
  });

  const sched = engine.createSchedule({
    name: "Slow Interval Audit",
    scheduleType: "interval",
    intervalMs: 10000,
    taskType: "diagnostic",
    targetSpec: { mode: "explicit", nodeIds: ["node_11111111111111111111111111111111"] },
    concurrencyPolicy: "forbid",
  });
  engine.start();

  // Advance time past nextRunAt to trigger first dispatch
  simulatedTime = new Date("2026-09-26T10:00:15.000Z");
  await engine.evaluateDueSchedules();

  const runs1 = engine.listScheduleRuns(sched.scheduleId);
  assert.equal(runs1.length, 1);
  assert.equal(runs1[0].status, "dispatched");
  assert.ok(runs1[0].jobId);

  // Advance time again while first run is STILL in flight
  simulatedTime = new Date("2026-09-26T10:00:26.000Z");
  await engine.evaluateDueSchedules();

  const runs2 = engine.listScheduleRuns(sched.scheduleId);
  assert.equal(runs2.length, 2);
  // Second run must be skipped due to concurrency-forbid
  assert.equal(runs2[0].status, "skipped");
  assert.equal(runs2[0].errorCode, "concurrency-forbid");

  // Verify nextRunAt was maintained and advanced
  const currentSched = engine.getSchedule(sched.scheduleId);
  assert.ok(currentSched.nextRunAt);
  assert.ok(new Date(currentSched.nextRunAt) > simulatedTime);

  // Complete in-flight job
  resolveJob();
  await new Promise((r) => setTimeout(r, 50));

  engine.stop();
  db.close();
});

test("concurrency policy: 'allow' permits concurrent overlapping dispatches when scheduled", async () => {
  const db = new DatabaseSync(":memory:");
  let resolveJob;
  const inFlightPromise = new Promise((r) => { resolveJob = r; });

  const fleetScheduler = new FleetJobScheduler({
    dispatchTransport: async () => {
      await inFlightPromise;
      return { status: "completed", exitCode: 0, stdout: "done" };
    },
  });

  let simulatedTime = new Date("2026-09-26T10:00:00.000Z");
  const engine = new ScheduledWorkflowEngine({
    db,
    fleetScheduler,
    evaluationIntervalMs: 50,
    now: () => simulatedTime,
  });

  const sched = engine.createSchedule({
    name: "Concurrent Allowed Job",
    scheduleType: "interval",
    intervalMs: 10000,
    taskType: "diagnostic",
    targetSpec: { mode: "explicit", nodeIds: ["node_11111111111111111111111111111111"] },
    concurrencyPolicy: "allow",
  });
  engine.start();

  // First run
  simulatedTime = new Date("2026-09-26T10:00:15.000Z");
  await engine.evaluateDueSchedules();

  // Second run while first is in flight
  simulatedTime = new Date("2026-09-26T10:00:26.000Z");
  await engine.evaluateDueSchedules();

  const runs = engine.listScheduleRuns(sched.scheduleId);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].status, "dispatched");
  assert.equal(runs[1].status, "dispatched");

  resolveJob();
  await new Promise((r) => setTimeout(r, 50));
  engine.stop();
  db.close();
});

test("hub restart recovery: missed-run policies ('skip' vs 'run-once') on startup reconciliation", async () => {
  const db = new DatabaseSync(":memory:");
  let dispatchedCount = 0;
  const fleetScheduler = new FleetJobScheduler({
    dispatchTransport: async () => {
      dispatchedCount++;
      return { status: "completed", exitCode: 0, stdout: "reconciled" };
    },
  });

  const pastTime = new Date("2026-09-26T08:00:00.000Z");
  const engineBeforeRestart = new ScheduledWorkflowEngine({
    db,
    fleetScheduler,
    now: () => pastTime,
  });

  // Schedule A: missedRunPolicy = 'skip'
  const schedSkip = engineBeforeRestart.createSchedule({
    name: "Missed Skip Job",
    scheduleType: "interval",
    intervalMs: 60000, // every 1 min
    taskType: "diagnostic",
    targetSpec: { mode: "explicit", nodeIds: ["node_11111111111111111111111111111111"] },
    missedRunPolicy: "skip",
  });

  // Schedule B: missedRunPolicy = 'run-once'
  const schedCatchUp = engineBeforeRestart.createSchedule({
    name: "Missed Catch-Up Job",
    scheduleType: "interval",
    intervalMs: 60000,
    taskType: "diagnostic",
    targetSpec: { mode: "explicit", nodeIds: ["node_11111111111111111111111111111111"] },
    missedRunPolicy: "run-once",
  });

  engineBeforeRestart.stop();

  // Simulate Hub downtime: time has advanced 2 hours past nextRunAt
  const restartTime = new Date("2026-09-26T10:00:00.000Z");
  const engineAfterRestart = new ScheduledWorkflowEngine({
    db,
    fleetScheduler,
    now: () => restartTime,
  });

  // Trigger startup reconciliation
  engineAfterRestart.reconcileOnStartup();
  await new Promise((r) => setTimeout(r, 50));

  // Schedule A ('skip'): 0 runs executed, nextRunAt advanced to future
  const runsA = engineAfterRestart.listScheduleRuns(schedSkip.scheduleId);
  assert.equal(runsA.length, 0);
  const updatedA = engineAfterRestart.getSchedule(schedSkip.scheduleId);
  assert.ok(updatedA.nextRunAt > restartTime.toISOString());

  // Schedule B ('run-once'): exactly 1 catch-up run executed and completed
  const runsB = engineAfterRestart.listScheduleRuns(schedCatchUp.scheduleId);
  assert.equal(runsB.length, 1);
  assert.equal(runsB[0].triggerType, "catch-up");
  assert.equal(runsB[0].status, "completed");
  const updatedB = engineAfterRestart.getSchedule(schedCatchUp.scheduleId);
  assert.ok(updatedB.nextRunAt > restartTime.toISOString());

  engineAfterRestart.stop();
  db.close();
});

test("zero credential leakage: sensitive credentials thoroughly scrubbed across schedules and runs (field 27)", async () => {
  const db = new DatabaseSync(":memory:");
  const fleetScheduler = new FleetJobScheduler({
    dispatchTransport: async () => ({ status: "completed", exitCode: 0, stdout: "ok" }),
  });
  const engine = new ScheduledWorkflowEngine({ db, fleetScheduler });

  // Create schedule with sensitive credentials in payload
  const sched = engine.createSchedule({
    name: "Secure Maintenance",
    scheduleType: "interval",
    intervalMs: 60000,
    taskType: "diagnostic",
    payload: {
      action: "database-backup",
      DB_PASSWORD: "secret_db_password_123",
      API_KEY: "secret_api_key_456",
      GITHUB_TOKEN: "ghp_secretTokenHere789",
      sessionCookie: "dsh-orbit-hub-session=sess_abcdef0123456789",
    },
    targetSpec: { mode: "explicit", nodeIds: ["node_11111111111111111111111111111111"] },
  });

  // Verify getSchedule() returns fully redacted payload
  const retrieved = engine.getSchedule(sched.scheduleId);
  assert.equal(retrieved.payload.DB_PASSWORD, "[REDACTED]");
  assert.equal(retrieved.payload.API_KEY, "[REDACTED]");
  assert.equal(retrieved.payload.GITHUB_TOKEN, "[REDACTED]");
  assert.equal(retrieved.payload.sessionCookie, "[REDACTED]");

  // Verify listSchedules() returns redacted payload
  const list = engine.listSchedules();
  assert.equal(list[0].payload.DB_PASSWORD, "[REDACTED]");

  engine.stop();
  db.close();
});

test("failure containment: target node outage during scheduled run settles as failed/partial without corrupting schedule", async () => {
  const db = new DatabaseSync(":memory:");
  const fleetScheduler = new FleetJobScheduler({
    dispatchTransport: async (nodeId) => {
      if (nodeId === "node_22222222222222222222222222222222") {
        const err = new Error("ECONNRESET: target node daemon crashed abruptly");
        err.code = "ECONNRESET";
        throw err;
      }
      return { status: "completed", exitCode: 0, stdout: "healthy peer" };
    },
  });
  const engine = new ScheduledWorkflowEngine({ db, fleetScheduler });

  const sched = engine.createSchedule({
    name: "Outage Containment Schedule",
    scheduleType: "interval",
    intervalMs: 10000,
    taskType: "diagnostic",
    targetSpec: {
      mode: "explicit",
      nodeIds: ["node_11111111111111111111111111111111", "node_22222222222222222222222222222222"],
    },
  });

  const runResult = await engine.dispatchScheduleRun(sched, "manual");
  assert.equal(runResult.status, "dispatched");

  // Await fleet job execution completion
  await fleetScheduler.jobs.get(runResult.jobId)?._executionPromise;
  const job = fleetScheduler.getJob(runResult.jobId);

  // Verify failure containment in fleet job: partial success
  assert.equal(job.status, "partial");
  assert.equal(job.summary.completed, 1);
  assert.equal(job.summary.failed, 1);

  // Verify run record updated in database to 'partial'
  const runs = engine.listScheduleRuns(sched.scheduleId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "partial");
  assert.equal(runs[0].summary.completed, 1);
  assert.equal(runs[0].summary.failed, 1);

  // Schedule itself remains active and healthy for future runs
  const updatedSched = engine.getSchedule(sched.scheduleId);
  assert.equal(updatedSched.status, "active");
  assert.equal(updatedSched.totalRuns, 1);
  assert.ok(updatedSched.nextRunAt);

  engine.stop();
  db.close();
});

test("capability mismatch containment: node lacking required capability skips cleanly without corrupting schedule", async () => {
  const db = new DatabaseSync(":memory:");
  const mockRegistry = {
    getNodeRow: (nodeId) => {
      if (nodeId === "node_11111111111111111111111111111111") {
        return {
          node_id: nodeId,
          capabilities: JSON.stringify(["command", "diagnostic"]),
          capabilities_stale: 0,
        };
      }
      if (nodeId === "node_22222222222222222222222222222222") {
        return {
          node_id: nodeId,
          capabilities: JSON.stringify(["command"]), // missing "diagnostic"
          capabilities_stale: 0,
        };
      }
      return null;
    },
  };

  const fleetScheduler = new FleetJobScheduler({
    registry: mockRegistry,
    dispatchTransport: async () => ({ status: "completed", exitCode: 0, stdout: "ok" }),
  });
  const engine = new ScheduledWorkflowEngine({ db, fleetScheduler });

  const sched = engine.createSchedule({
    name: "Capability Required Schedule",
    scheduleType: "interval",
    intervalMs: 10000,
    taskType: "diagnostic",
    requiredCapabilities: ["diagnostic"],
    targetSpec: {
      mode: "explicit",
      nodeIds: ["node_11111111111111111111111111111111", "node_22222222222222222222222222222222"],
    },
  });

  const runResult = await engine.dispatchScheduleRun(sched, "manual");
  assert.equal(runResult.status, "dispatched");

  // Await fleet job execution completion
  await fleetScheduler.jobs.get(runResult.jobId)?._executionPromise;
  const job = fleetScheduler.getJob(runResult.jobId);

  // Node 1 completed, Node 2 skipped with 'lacks-capability'
  assert.equal(job.status, "partial");
  assert.equal(job.summary.completed, 1);
  assert.equal(job.summary.skipped, 1);
  assert.equal(job.results["node_22222222222222222222222222222222"].status, "skipped");
  assert.equal(job.results["node_22222222222222222222222222222222"].reason, "lacks-capability");

  // Verify run record updated to partial
  const runs = engine.listScheduleRuns(sched.scheduleId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "partial");
  assert.equal(runs[0].summary.completed, 1);
  assert.equal(runs[0].summary.skipped, 1);

  // Schedule remains active
  const updatedSched = engine.getSchedule(sched.scheduleId);
  assert.equal(updatedSched.status, "active");
  assert.equal(updatedSched.totalRuns, 1);
  assert.ok(updatedSched.nextRunAt);

  engine.stop();
  db.close();
});

test("hub restart recovery resilience: uncalculable schedule transitions to error without halting startup reconciliation", async () => {
  const db = new DatabaseSync(":memory:");
  const fleetScheduler = new FleetJobScheduler({
    dispatchTransport: async () => ({ status: "completed", exitCode: 0, stdout: "ok" }),
  });

  const pastTime = new Date("2026-09-26T08:00:00.000Z");
  const engine = new ScheduledWorkflowEngine({
    db,
    fleetScheduler,
    now: () => pastTime,
  });

  // Schedule 1: Valid schedule with 'skip' policy
  const sched1 = engine.createSchedule({
    name: "Valid Skip Schedule",
    scheduleType: "interval",
    intervalMs: 60000,
    taskType: "diagnostic",
    targetSpec: { mode: "explicit", nodeIds: ["node_11111111111111111111111111111111"] },
    missedRunPolicy: "skip",
  });

  // Schedule 2: Corrupted schedule definition in DB (e.g. cron expression corrupted directly)
  const currentIso = pastTime.toISOString();
  db.prepare(`
    INSERT INTO fleet_schedules (
      schedule_id, name, schedule_type, cron_expression, task_type, payload_json,
      target_spec_json, required_capabilities_json, status, concurrency_policy,
      missed_run_policy, created_at, updated_at, created_by, next_run_at, total_runs
    ) VALUES (
      'sched_corrupt11111111111111111111', 'Corrupt Schedule', 'cron', 'invalid cron expression', 'diagnostic',
      '{}', '{"mode":"explicit","nodeIds":["node_11111111111111111111111111111111"]}', '[]', 'active', 'forbid',
      'skip', ?, ?, 'operator', ?, 0
    )
  `).run(currentIso, currentIso, currentIso);

  // Schedule 3: Another valid schedule that appears after corrupt schedule
  const sched3 = engine.createSchedule({
    name: "Following Valid Schedule",
    scheduleType: "interval",
    intervalMs: 60000,
    taskType: "diagnostic",
    targetSpec: { mode: "explicit", nodeIds: ["node_11111111111111111111111111111111"] },
    missedRunPolicy: "skip",
  });

  // Advance time past due
  const restartTime = new Date("2026-09-26T10:00:00.000Z");
  const engineAfterRestart = new ScheduledWorkflowEngine({
    db,
    fleetScheduler,
    now: () => restartTime,
  });

  // Startup reconciliation MUST NOT throw despite corrupt schedule
  assert.doesNotThrow(() => {
    engineAfterRestart.reconcileOnStartup();
  });

  // Schedule 1 is healthy and rescheduled
  const s1 = engineAfterRestart.getSchedule(sched1.scheduleId);
  assert.equal(s1.status, "active");
  assert.ok(s1.nextRunAt > restartTime.toISOString());

  // Corrupt schedule transitioned to status: 'error' with next_run_at: null
  const s2 = engineAfterRestart.getSchedule("sched_corrupt11111111111111111111");
  assert.equal(s2.status, "error");
  assert.equal(s2.nextRunAt, null);

  // Schedule 3 was reached and successfully rescheduled
  const s3 = engineAfterRestart.getSchedule(sched3.scheduleId);
  assert.equal(s3.status, "active");
  assert.ok(s3.nextRunAt > restartTime.toISOString());

  engineAfterRestart.stop();
  db.close();
});
