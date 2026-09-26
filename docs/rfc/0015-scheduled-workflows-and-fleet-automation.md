# RFC 0015: Scheduled Workflows and Fleet Automation for v0.8

Status: **Proposed for v0.8 architecture review. Product construction is blocked until the Stage 0 / Gate A review records GO.**

Depends on: RFC-0001 node identity, RFC-0005 enrollment and registry persistence, RFC-0006 machine API, RFC-0007 browser management API, RFC-0008 per-node Hub route identity, RFC-0009 capability/health semantics, RFC-0010 node endpoint/routing, RFC-0011 browser node selection, RFC-0012 reverse-connected nodes, RFC-0013 multi-node sessions and target scoping, RFC-0014 fleet workflows and scheduling, and authorization `V08-CONSTRUCTION-20260926-A1`.

---

## 1. Goal

v0.8 builds upon the ad-hoc fleet workflow capabilities of v0.7 (`RFC-0014`), introducing **persistent scheduled workflows, cron/interval triggers, automated fleet execution, and durable dispatch history**.

In v0.7, operators can trigger fleet jobs on demand across selected nodes with capability-aware scheduling and failure independence. In production environments, cluster administration requires:
1. **Persistent Schedule Definitions**: recurring cron schedules (e.g. `0 2 * * *` for nightly diagnostics) and interval-based triggers (e.g. every 30 minutes for health and config audits) stored durably in the Hub's SQLite database;
2. **Deterministic Scheduling Engine**: an active in-process timer mechanism that tracks `nextRunAt`, detects due schedules, executes jobs strictly through the validated v0.7 `FleetJobScheduler`, and updates run counts;
3. **Missed-Run & Window Policies**: deterministic handling of missed dispatches after Hub downtime (`skip` vs `run-once`), avoiding duplicate thundering-herd executions;
4. **Lifecycle & Operator Controls**: pause, resume, trigger now (ad-hoc execution), update parameters, and delete schedules via authenticated endpoints and an operator UI panel;
5. **Durable Execution History & Auditability**: capturing every scheduled trigger event, dispatch job ID, execution duration, and outcome metrics in SQLite for regulatory compliance.

```text
Operator UI / Management API
   |
   | POST /hub/fleet/schedules { name: "nightly-audit", cron: "0 2 * * *", taskType: "diagnostic", ... }
   v
Hub Persistence (SQLite: `fleet_schedules`, `fleet_schedule_runs`)
   ^
   | Periodic tick & nextRunAt evaluation
   v
ScheduledWorkflowEngine
   |-- 1. Evaluates due schedules against wall clock
   |-- 2. Checks concurrency limit & schedule state (active vs paused)
   |-- 3. Dispatches via RFC-0014 FleetJobScheduler (enforcing target spec & capability rules)
   |-- 4. Records schedule run entry & emits audit log event
   v
RFC-0014 FleetJobScheduler (Direct & Reverse Node Dispatches)
```

Core safety principles:
- **No schedule without valid target spec**: schedules must carry an explicit node target list or capability selector matching RFC-0014 rules. Bare wildcards (`"*"`, `"all"`, `"broadcast"`) fail closed at schedule creation with `HTTP 400 Bad Request`.
- **Durable atomic state**: schedules transition strictly among `active`, `paused`, `completed` (for finite schedules), and `error`. Mutations are atomic in SQLite.
- **Fail-closed dispatch**: if a schedule's capability requirements are no longer met by any node at trigger time, the run records `empty-target-set` or `skipped` without corrupting the schedule.
- **Zero credential leakage in schedules**: schedule definitions and run logs scrub private keys, bearer tokens, and session cookies.

---

## 2. Decision Summary

1. **D1: Scheduled Workflow Data Model (`FleetSchedule` & `FleetScheduleRun`)**
   A schedule defines a recurring or one-off delayed fleet job. It contains trigger rules (`cron` or `intervalMs`), job template (taskType, payload, targetSpec, requiredCapabilities, timeoutMs), status, run counters, and execution history.
2. **D2: Time Parsing & Trigger Semantics**
   Supports standard 5-field cron syntax (`minute hour day-of-month month day-of-week`) and positive integer interval milliseconds. Time calculations pin UTC ISO-8601 formatting to eliminate timezone drift.
3. **D3: Deterministic Schedule Engine (`ScheduledWorkflowEngine`)**
   A singleton scheduler in the Hub evaluating due schedules, maintaining next-run calculations, preventing overlapping runs for the same schedule if `concurrencyPolicy: "forbid"`, and delegating execution directly to `FleetJobScheduler`.
4. **D4: Missed-Run Handling on Hub Restart**
   If Hub was down when a schedule was due, `missedRunPolicy` governs the outcome: `"skip"` (default, advances `nextRunAt` to next future slot) or `"run-once"` (triggers one immediate catch-up dispatch before rescheduling).
5. **D5: Management API & Audit Logging**
   RESTful endpoints under `/hub/fleet/schedules` for CRUD, pause/resume, and manual triggers. Every lifecycle transition records an audit event (`fleet.schedule.create`, `fleet.schedule.pause`, `fleet.schedule.resume`, `fleet.schedule.trigger`, `fleet.schedule.delete`).
6. **D6: Acceptance Matrix for v0.8 (M32 Matrix - 32 Canonical Fields)**
   A dedicated 32-field acceptance matrix extending M28 with 4 scheduled workflow fields, mechanically verified across automated qualification and mounted drill runs.

---

## 3. Detailed Technical Design

### D1: Fleet Schedule & Schedule Run Models

#### SQLite Schema Migration (v7 Schema)

```sql
CREATE TABLE IF NOT EXISTS fleet_schedules (
  schedule_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  schedule_type TEXT NOT NULL, -- 'cron' | 'interval' | 'once'
  cron_expression TEXT,
  interval_ms INTEGER,
  task_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  target_spec_json TEXT NOT NULL,
  required_capabilities_json TEXT NOT NULL DEFAULT '[]',
  timeout_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'completed' | 'error'
  concurrency_policy TEXT NOT NULL DEFAULT 'forbid', -- 'forbid' | 'allow'
  missed_run_policy TEXT NOT NULL DEFAULT 'skip', -- 'skip' | 'run-once'
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
  job_id TEXT, -- references in-memory/audit fleet job
  triggered_at TEXT NOT NULL,
  trigger_type TEXT NOT NULL, -- 'scheduled' | 'manual' | 'catch-up'
  status TEXT NOT NULL, -- 'dispatched' | 'completed' | 'failed' | 'partial' | 'skipped' | 'cancelled'
  summary_json TEXT,
  duration_ms INTEGER,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON fleet_schedules(next_run_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON fleet_schedule_runs(schedule_id, triggered_at DESC);
```

### D2: Time Parsing and Trigger Calculation

1. **Cron Expression**: Standard 5 fields (`* * * * *`). Evaluated via robust, zero-dependency parser supporting numbers, ranges (`1-5`), steps (`*/15`), and lists (`1,2,5`).
2. **Interval**: Positive integer millisecond intervals (minimum 1,000ms).
3. **Calculation Invariant**: `nextRunAt` is always strictly greater than current evaluation timestamp.

### D3: Engine & Dispatch Integration

The `ScheduledWorkflowEngine` runs inside the Hub process:
- Runs an internal evaluation loop every 1,000ms;
- Queries `SELECT * FROM fleet_schedules WHERE status = 'active' AND next_run_at <= ?`;
- For each due schedule:
  1. Validates concurrency: if `concurrency_policy === 'forbid'` and an active job from this schedule is running, skip this tick and log warning;
  2. Dispatches task via `fleetScheduler.submitJob(...)`;
  3. Records entry in `fleet_schedule_runs`;
  4. Computes new `next_run_at`; if `max_runs` reached, updates status to `completed`;
  5. Emits `fleet.schedule.dispatch` audit record.

### D4: Operator Management Endpoints

All endpoints require operator session authentication and CSRF validation:
- `GET /hub/fleet/schedules`: list all schedules with summary metrics;
- `POST /hub/fleet/schedules`: create a new schedule;
- `GET /hub/fleet/schedules/:scheduleId`: get schedule detail and recent runs;
- `PUT /hub/fleet/schedules/:scheduleId`: update schedule parameters;
- `POST /hub/fleet/schedules/:scheduleId/pause`: pause schedule;
- `POST /hub/fleet/schedules/:scheduleId/resume`: resume paused schedule;
- `POST /hub/fleet/schedules/:scheduleId/trigger`: immediate ad-hoc manual execution;
- `DELETE /hub/fleet/schedules/:scheduleId`: delete schedule;
- `GET /hub/fleet/schedules/:scheduleId/runs`: list historical execution runs.

---

## 4. Acceptance Matrix (M32 Matrix - 32 Canonical Fields)

v0.8 expands the RFC-0014 M28 matrix to **M32 (32 fields)**:

| # | Field | Scope | Minimum Evidence |
|---|---|---|---|
| 1-28 | RFC-0014 M28 Fields (1-28) | automated / mounted | As defined in RFC-0014 |
| 29 | `scheduledWorkflowDefinitionPersistence` | automated | Create, persist, mutate, and reload schedule in SQLite |
| 30 | `scheduledWorkflowCronAndIntervalParsing` | automated | Validate 5-field cron, interval math, invalid syntax rejection |
| 31 | `scheduledWorkflowAutomatedDispatch` | mounted | Engine dispatches due schedule automatically to FleetJobScheduler |
| 32 | `scheduledWorkflowLifecycleAndAudit` | mounted | Pause, resume, trigger now, cancellation, and complete audit logging |
