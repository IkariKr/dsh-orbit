// Scheduled Workflow Engine (RFC-0015 D1, D3, D4)
// Evaluates active persistent schedules, manages missed-run recovery, concurrency policies,
// and delegates execution to FleetJobScheduler.

import { randomUUID } from "node:crypto";
import { calculateNextRunAt, parseCronExpression, ScheduleParseError } from "./schedule-parser.mjs";
import { scrubSensitiveCredentials } from "./fleet-scheduler.mjs";

const SCHEDULE_ID_PATTERN = /^sched_[0-9a-f]{16,64}$/;
const ALLOWED_SCHEDULE_TYPES = ["cron", "interval", "once"];
const ALLOWED_STATUSES = ["active", "paused", "completed", "error"];
const ALLOWED_CONCURRENCY_POLICIES = ["forbid", "allow"];
const ALLOWED_MISSED_RUN_POLICIES = ["skip", "run-once"];

export function randomScheduleId() {
  return `sched_${randomUUID().replace(/-/g, "").slice(0, 32)}`;
}

export function randomRunId() {
  return `srun_${randomUUID().replace(/-/g, "").slice(0, 32)}`;
}

export class ScheduledWorkflowEngine {
  constructor({
    db,
    fleetScheduler,
    registry = null,
    evaluationIntervalMs = 1000,
    now = () => new Date(),
    onScheduleDispatched = null,
  } = {}) {
    if (!db) throw new Error("ScheduledWorkflowEngine requires a SQLite database handle");
    if (!fleetScheduler) throw new Error("ScheduledWorkflowEngine requires a FleetJobScheduler instance");
    this.db = db;
    this.fleetScheduler = fleetScheduler;
    this.registry = registry;
    this.evaluationIntervalMs = Math.max(100, evaluationIntervalMs);
    this.now = now;
    this.onScheduleDispatched = typeof onScheduleDispatched === "function" ? onScheduleDispatched : null;
    this._timer = null;
    this._running = false;
    this._evaluating = false;
    this.initTables();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_schedules (
        schedule_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'interval', 'once')),
        cron_expression TEXT,
        interval_ms INTEGER,
        task_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        target_spec_json TEXT NOT NULL,
        required_capabilities_json TEXT NOT NULL DEFAULT '[]',
        timeout_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'error')),
        concurrency_policy TEXT NOT NULL DEFAULT 'forbid' CHECK (concurrency_policy IN ('forbid', 'allow')),
        missed_run_policy TEXT NOT NULL DEFAULT 'skip' CHECK (missed_run_policy IN ('skip', 'run-once')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        total_runs INTEGER NOT NULL DEFAULT 0,
        max_runs INTEGER
      );

      CREATE TABLE IF NOT EXISTS fleet_schedule_runs (
        run_id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES fleet_schedules(schedule_id) ON DELETE CASCADE,
        job_id TEXT,
        triggered_at TEXT NOT NULL,
        trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scheduled', 'manual', 'catch-up')),
        status TEXT NOT NULL CHECK (status IN ('dispatched', 'completed', 'failed', 'partial', 'skipped', 'cancelled')),
        summary_json TEXT,
        duration_ms INTEGER,
        error_code TEXT,
        error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON fleet_schedules(next_run_at) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON fleet_schedule_runs(schedule_id, triggered_at DESC);
    `);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.reconcileOnStartup();
    this._timer = setInterval(() => this.evaluateDueSchedules().catch(() => {}), this.evaluationIntervalMs);
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Startup reconciliation: evaluates missed runs for active schedules while Hub was offline (RFC-0015 D4).
   */
  reconcileOnStartup() {
    const currentIso = this.now().toISOString();
    const activeDue = this.db
      .prepare("SELECT * FROM fleet_schedules WHERE status = 'active' AND next_run_at <= ?")
      .all(currentIso);

    for (const row of activeDue) {
      const schedule = this.hydrateScheduleRow(row);
      if (schedule.missedRunPolicy === "run-once") {
        this.dispatchScheduleRun(schedule, "catch-up").catch(() => {});
      } else {
        // "skip": calculate next future occurrence
        try {
          const nextRunAt = calculateNextRunAt(schedule, this.now());
          this.db
            .prepare("UPDATE fleet_schedules SET next_run_at = ?, updated_at = ? WHERE schedule_id = ?")
            .run(nextRunAt, currentIso, schedule.scheduleId);
        } catch (err) {
          this.db
            .prepare("UPDATE fleet_schedules SET status = 'error', next_run_at = NULL, updated_at = ? WHERE schedule_id = ?")
            .run(currentIso, schedule.scheduleId);
        }
      }
    }
  }

  /**
   * Main evaluation loop: fetches due schedules and triggers dispatches.
   */
  async evaluateDueSchedules() {
    if (this._evaluating || !this._running) return;
    this._evaluating = true;
    try {
      const currentIso = this.now().toISOString();
      const dueRows = this.db
        .prepare("SELECT * FROM fleet_schedules WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 50")
        .all(currentIso);

      for (const row of dueRows) {
        if (!this._running) break;
        const schedule = this.hydrateScheduleRow(row);
        await this.dispatchScheduleRun(schedule, "scheduled");
      }
    } finally {
      this._evaluating = false;
    }
  }

  /**
   * Dispatches a single execution for a schedule (scheduled, manual, or catch-up).
   */
  async dispatchScheduleRun(schedule, triggerType = "scheduled") {
    const currentIso = this.now().toISOString();

    // Check concurrency policy: 'forbid' skips if any active job for this schedule is still running
    if (schedule.concurrencyPolicy === "forbid") {
      const hasActive = typeof this.fleetScheduler.hasActiveJobForSchedule === "function"
        ? this.fleetScheduler.hasActiveJobForSchedule(schedule.scheduleId)
        : this.fleetScheduler.listJobs().some(
            (j) => j.payload?._fleetScheduleId === schedule.scheduleId && (j.status === "pending" || j.status === "running")
          );
      if (hasActive) {
        // Record skipped run due to concurrency lock
        const runId = randomRunId();
        this.db.prepare(`
          INSERT INTO fleet_schedule_runs (
            run_id, schedule_id, job_id, triggered_at, trigger_type, status, summary_json, error_code, error_message
          ) VALUES (?, ?, NULL, ?, ?, 'skipped', NULL, 'concurrency-forbid', 'previous execution still in flight')
        `).run(runId, schedule.scheduleId, currentIso, triggerType);

        // Advance nextRunAt so it doesn't get stuck
        let nextRunAt = null;
        let updateStatus = schedule.status;
        try {
          nextRunAt = calculateNextRunAt(schedule, this.now());
        } catch {
          updateStatus = "error";
          nextRunAt = null;
        }
        this.db.prepare("UPDATE fleet_schedules SET status = ?, next_run_at = ?, updated_at = ? WHERE schedule_id = ?")
          .run(updateStatus, nextRunAt, currentIso, schedule.scheduleId);
        return { runId, status: "skipped", reason: "concurrency-forbid" };
      }
    }

    const runId = randomRunId();
    let jobId = null;
    let dispatchStatus = "dispatched";
    let errorCode = null;
    let errorMessage = null;

    try {
      const clonedPayload = {
        ...(schedule.payload || {}),
        _fleetScheduleId: schedule.scheduleId,
        _fleetScheduleRunId: runId,
      };

      const job = this.fleetScheduler.submitJob({
        taskType: schedule.taskType,
        payload: clonedPayload,
        targetSpec: schedule.targetSpec,
        requiredCapabilities: schedule.requiredCapabilities,
        timeoutMs: schedule.timeoutMs,
        operatorPrincipal: `schedule:${schedule.createdBy}`,
      });
      jobId = job.jobId;

      // Link job completion to run outcome update
      const internalJob = this.fleetScheduler.jobs?.get(jobId);
      const executionPromise = internalJob?._executionPromise || job._executionPromise;
      executionPromise?.then((finishedJob) => {
        try {
          const finished = finishedJob || this.fleetScheduler.getJob(jobId);
          if (!finished) return;
          const duration = finished.finishedAt && finished.startedAt
            ? Math.max(0, new Date(finished.finishedAt) - new Date(finished.startedAt))
            : null;
          this.db.prepare(`
            UPDATE fleet_schedule_runs SET
              status = ?, summary_json = ?, duration_ms = ?
            WHERE run_id = ?
          `).run(finished.status, JSON.stringify(finished.summary), duration, runId);
        } catch (updateErr) {
          try {
            this.db.prepare(`
              UPDATE fleet_schedule_runs SET
                status = 'failed', error_code = 'run-update-error', error_message = ?
              WHERE run_id = ?
            `).run(updateErr.message, runId);
          } catch {}
        }
      });
    } catch (err) {
      dispatchStatus = "failed";
      errorCode = err.code || "dispatch-error";
      errorMessage = err.message;
    }

    // Insert schedule run record
    this.db.prepare(`
      INSERT INTO fleet_schedule_runs (
        run_id, schedule_id, job_id, triggered_at, trigger_type, status, summary_json, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(runId, schedule.scheduleId, jobId, currentIso, triggerType, dispatchStatus, errorCode, errorMessage);

    // Update schedule metrics and next occurrence
    const newTotalRuns = schedule.totalRuns + 1;
    let newStatus = schedule.status;
    let nextRunAt = null;

    if (schedule.maxRuns && newTotalRuns >= schedule.maxRuns) {
      newStatus = "completed";
      nextRunAt = null;
    } else {
      try {
        nextRunAt = calculateNextRunAt(schedule, this.now());
      } catch (e) {
        newStatus = "error";
        nextRunAt = null;
      }
    }

    this.db.prepare(`
      UPDATE fleet_schedules SET
        total_runs = ?,
        last_run_at = ?,
        next_run_at = ?,
        status = ?,
        updated_at = ?
      WHERE schedule_id = ?
    `).run(newTotalRuns, currentIso, nextRunAt, newStatus, currentIso, schedule.scheduleId);

    try {
      this.onScheduleDispatched?.({ scheduleId: schedule.scheduleId, runId, jobId, triggerType });
    } catch {}

    return { runId, jobId, status: dispatchStatus };
  }

  /**
   * Creates a new scheduled workflow definition.
   */
  createSchedule({
    scheduleId = null,
    name,
    description = null,
    scheduleType,
    cronExpression = null,
    intervalMs = null,
    taskType,
    payload = {},
    targetSpec,
    requiredCapabilities = [],
    timeoutMs = null,
    concurrencyPolicy = "forbid",
    missedRunPolicy = "skip",
    maxRuns = null,
    createdBy = "operator",
  }) {
    if (scheduleId !== null && scheduleId !== undefined) {
      if (typeof scheduleId !== "string" || !SCHEDULE_ID_PATTERN.test(scheduleId)) {
        const err = new Error(`invalid scheduleId: ${scheduleId}; must match ${SCHEDULE_ID_PATTERN}`);
        err.code = "invalid-schedule-id";
        throw err;
      }
    }
    if (typeof name !== "string" || name.trim() === "") {
      const err = new Error("name is required and must be non-empty string");
      err.code = "invalid-schedule-name";
      throw err;
    }
    if (!ALLOWED_SCHEDULE_TYPES.includes(scheduleType)) {
      const err = new Error(`scheduleType must be one of: ${ALLOWED_SCHEDULE_TYPES.join(", ")}`);
      err.code = "invalid-schedule-type";
      throw err;
    }
    if (!ALLOWED_CONCURRENCY_POLICIES.includes(concurrencyPolicy)) {
      const err = new Error(`concurrencyPolicy must be one of: ${ALLOWED_CONCURRENCY_POLICIES.join(", ")}`);
      err.code = "invalid-concurrency-policy";
      throw err;
    }
    if (!ALLOWED_MISSED_RUN_POLICIES.includes(missedRunPolicy)) {
      const err = new Error(`missedRunPolicy must be one of: ${ALLOWED_MISSED_RUN_POLICIES.join(", ")}`);
      err.code = "invalid-missed-run-policy";
      throw err;
    }

    // Schedule type specific validations
    if (scheduleType === "cron") {
      parseCronExpression(cronExpression); // throws ScheduleParseError on invalid syntax
    } else if (scheduleType === "interval") {
      if (!Number.isInteger(intervalMs) || intervalMs < 1000) {
        const err = new Error("intervalMs must be an integer >= 1000");
        err.code = "invalid-interval";
        throw err;
      }
    }

    // Validate targetSpec using RFC-0014 validation (bare wildcards fail closed)
    const { validateFleetTargetSpec } = this.fleetScheduler.constructor;
    // We import validateFleetTargetSpec from fleet-scheduler directly
    const targetValidation = this.validateTarget(targetSpec);
    if (!targetValidation.valid) {
      const err = new Error(targetValidation.message);
      err.code = targetValidation.code;
      throw err;
    }

    const id = scheduleId || randomScheduleId();
    const currentIso = this.now().toISOString();

    const tempSched = {
      scheduleType,
      cronExpression,
      intervalMs,
      maxRuns,
    };
    const nextRunAt = calculateNextRunAt(tempSched, this.now());

    this.db.prepare(`
      INSERT INTO fleet_schedules (
        schedule_id, name, description, schedule_type, cron_expression, interval_ms,
        task_type, payload_json, target_spec_json, required_capabilities_json, timeout_ms,
        status, concurrency_policy, missed_run_policy, created_at, updated_at, created_by,
        next_run_at, last_run_at, total_runs, max_runs
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        'active', ?, ?, ?, ?, ?,
        ?, NULL, 0, ?
      )
    `).run(
      id, name.trim(), description ? description.trim() : null, scheduleType,
      cronExpression ? cronExpression.trim() : null, intervalMs,
      taskType, JSON.stringify(payload || {}), JSON.stringify(targetSpec),
      JSON.stringify(requiredCapabilities || []), timeoutMs,
      concurrencyPolicy, missedRunPolicy, currentIso, currentIso, createdBy,
      nextRunAt, maxRuns
    );

    return this.getSchedule(id);
  }

  validateTarget(targetSpec) {
    if (targetSpec === "*" || (typeof targetSpec === "object" && targetSpec !== null && (targetSpec.mode === "all" || targetSpec.mode === "broadcast" || targetSpec.nodeIds === "*"))) {
      return { valid: false, code: "wildcard-prohibited", message: "bare wildcard target specification is prohibited" };
    }
    if (!targetSpec || typeof targetSpec !== "object" || Array.isArray(targetSpec)) {
      return { valid: false, code: "invalid-target-spec", message: "targetSpec is required and must be an object" };
    }
    if (targetSpec.mode === "explicit") {
      if (!Array.isArray(targetSpec.nodeIds) || targetSpec.nodeIds.length === 0) {
        return { valid: false, code: "empty-target-set", message: "explicit targetSpec requires non-empty nodeIds array" };
      }
      return { valid: true };
    }
    if (targetSpec.mode === "capability") {
      if (typeof targetSpec.capability !== "string" || targetSpec.capability.trim() === "") {
        return { valid: false, code: "invalid-capability-spec", message: "capability mode requires non-empty capability string" };
      }
      return { valid: true };
    }
    return { valid: false, code: "unknown-target-mode", message: `unknown targetSpec mode: ${targetSpec.mode}` };
  }

  getSchedule(scheduleId) {
    const row = this.db.prepare("SELECT * FROM fleet_schedules WHERE schedule_id = ?").get(scheduleId);
    if (!row) return null;
    return this.hydrateScheduleRow(row);
  }

  listSchedules() {
    const rows = this.db.prepare("SELECT * FROM fleet_schedules ORDER BY created_at DESC").all();
    return rows.map((r) => this.hydrateScheduleRow(r));
  }

  pauseSchedule(scheduleId) {
    const current = this.getSchedule(scheduleId);
    if (!current) return false;
    if (current.status !== "active") return false;
    const currentIso = this.now().toISOString();
    this.db.prepare("UPDATE fleet_schedules SET status = 'paused', updated_at = ? WHERE schedule_id = ?")
      .run(currentIso, scheduleId);
    return true;
  }

  resumeSchedule(scheduleId) {
    const current = this.getSchedule(scheduleId);
    if (!current) return false;
    if (current.status !== "paused") return false;
    const currentIso = this.now().toISOString();
    const nextRunAt = calculateNextRunAt(current, this.now());
    this.db.prepare("UPDATE fleet_schedules SET status = 'active', next_run_at = ?, updated_at = ? WHERE schedule_id = ?")
      .run(nextRunAt, currentIso, scheduleId);
    return true;
  }

  deleteSchedule(scheduleId) {
    const current = this.getSchedule(scheduleId);
    if (!current) return false;
    this.db.prepare("DELETE FROM fleet_schedules WHERE schedule_id = ?").run(scheduleId);
    return true;
  }

  listScheduleRuns(scheduleId, limit = 50) {
    const rows = this.db.prepare(
      "SELECT * FROM fleet_schedule_runs WHERE schedule_id = ? ORDER BY triggered_at DESC LIMIT ?"
    ).all(scheduleId, Math.min(200, Math.max(1, limit)));
    return rows.map((r) => ({
      runId: r.run_id,
      scheduleId: r.schedule_id,
      jobId: r.job_id,
      triggeredAt: r.triggered_at,
      triggerType: r.trigger_type,
      status: r.status,
      summary: r.summary_json ? JSON.parse(r.summary_json) : null,
      durationMs: r.duration_ms,
      errorCode: r.error_code,
      errorMessage: r.error_message,
    }));
  }

  hydrateScheduleRow(row) {
    return {
      scheduleId: row.schedule_id,
      name: row.name,
      description: row.description,
      scheduleType: row.schedule_type,
      cronExpression: row.cron_expression,
      intervalMs: row.interval_ms,
      taskType: row.task_type,
      payload: scrubSensitiveCredentials(JSON.parse(row.payload_json || "{}")),
      targetSpec: JSON.parse(row.target_spec_json || "{}"),
      requiredCapabilities: JSON.parse(row.required_capabilities_json || "[]"),
      timeoutMs: row.timeout_ms,
      status: row.status,
      concurrencyPolicy: row.concurrency_policy,
      missedRunPolicy: row.missed_run_policy,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      totalRuns: row.total_runs,
      maxRuns: row.max_runs,
    };
  }
}
