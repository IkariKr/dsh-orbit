# v0.7 Stage 3 Gate B Independent Code Review

- Scope: `chore/v0.7-stage3-operator-ui`, HEAD `5e6179886d658468291dd965b01b0edf9bb93a99` (`5e61798`)
- Baseline parent: `5eb7f865f12e8739d48b11112e4f0dc2fcf02cb2` (Stage 2 Gate 2 PASS closure `03a1795`)
- Reviewed commit: `5e61798` ("feat(ui): implement operator Fleet Workflows panel, job trigger dialog, and real-time progress view (Stage 3, Gate B)")
- Reviewer: independent code review (`@code-reviewer2`)
- Verdict: **FAIL (REVISE/BLOCK)** — 0x P0, 1x P1, 1x P2, 3x P3. Gate B not granted.

---

## Review Scope

Independent Gate B review of the Stage 3 Operator UI Fleet Workflows panel, job trigger dialog, and real-time progress view.

`git diff --stat 5eb7f86..5e61798` reports 6 files changed (+927 / -12):

1. `ui/view-model.mjs` (+72 / -1): `EMPTY_FLEET_JOBS_STATE`, `mapFleetJobRow`, `mapFleetJobList`, `mapFleetJobDetail`.
2. `ui/app.mjs` (+343 / -10): Fleet Workflows navigation tab switching, job list rendering with progress indicators, job detail view with execution logs, job trigger modal dialog (explicit and capability modes), form validation, and job cancellation handling.
3. `ui/index.html` (+45 / -0): `nav-fleet` navigation button, `#fleet-view` section (`fleet-jobs-list`, `fleet-job-detail-view`), and `#fleet-job-dialog`.
4. `ui/styles.css` (+20 / -2): Styles for fleet actions, job cards, monospace job IDs, progress bars, all 7 task result badges, node results table, and dark log viewer.
5. `test/ui-dom.test.mjs` (+18 / -0): Added fleet element IDs to FakeDom `ELEMENT_IDS`.
6. `test/v07-stage3-operator-ui.test.mjs` (+441 / -0, new): Contract tests for view-model functions and DOM integration tests covering tab navigation, trigger validation, dispatch, detail rendering, and cancellation.

Governing documents:
- RFC-0014 D1, D2, D4, and Acceptance Matrix Field 10 (`operatorUiFleetWorkflowsView`)
- RFC-0007 (`docs/rfc/0007-browser-management-api.md`)
- v0.7 multistage SOP Stop-Work matrix (`docs/sop/v0.7-fleet-workflows-multistage-sop.md:178`, "Non-zero P0, P1, or P2 finding | Blocker")

---

## Findings

### [P1] Schema Mismatch in `mapFleetJobRow` and `ui/app.mjs` maps `job.status` to `undefined`, permanently freezing UI job status to `"pending"` and keeping cancel buttons enabled on terminal jobs

`ui/view-model.mjs:217-219, 224, 228, 260`, `ui/app.mjs:468-472, 478, 509-512, 545, 549, 559`

#### Root Cause
RFC-0014 D1 (`docs/rfc/0014-fleet-workflows-and-scheduling.md:100`), `src/registry/fleet-scheduler.mjs:406-418`, and `src/registry/server.mjs:766, 779` establish the canonical fleet job contract:
- The lifecycle status property is named `status` (`FleetJobStatus = "pending" | "running" | "completed" | "failed" | "partial"`).
- The completion timestamp property is named `finishedAt` (`string | null`).
- Neither `FleetJob` nor `FleetJobScheduler.getJob()` exposes `state` or `completedAt`.

However, `ui/view-model.mjs:205-239` maps `job` fields assuming `state` and `completedAt`:
```javascript
export function mapFleetJobRow(job) {
  ...
  const progressPercent =
    total > 0
      ? Math.min(100, Math.round((settled / total) * 100))
      : job?.state === "completed"
        ? 100
        : 0;

  return {
    ...
    state: job?.state ?? "pending",
    ...
    completedAt: job?.completedAt ?? null,
    ...
  };
}
```
And in `mapFleetJobDetail` (`ui/view-model.mjs:260`):
```javascript
completedAt: res?.completedAt ?? null,
```
Because the Hub backend returns `status` and `finishedAt`, `job?.state` is `undefined`, so `row.state` defaults to `"pending"` **for every real fleet job regardless of actual execution status (`running`, `completed`, `failed`, or `partial`)**.

#### Empirical Evidence & Reproduction
Executing a live scheduler dispatch and passing the returned job into `mapFleetJobRow`:
```javascript
const fetched = scheduler.getJob(job.jobId);
// fetched: { jobId: 'job_9ffe...', status: 'completed', finishedAt: '2026-09-26T02:49:49.710Z', ... }

const row = mapFleetJobRow(fetched);
// row: { jobId: 'job_9ffe...', state: 'pending', completedAt: null, ... }
```

In `ui/app.mjs:468`:
```javascript
const isTerminal = job.state === "completed" || job.state === "failed" || job.state === "partial";
const cancelBtn = !isTerminal
  ? `<button class="danger" data-cancel-job-id="${escapeHtml(job.jobId)}">cancel</button>`
  : "";
```
Because `job.state` is always `"pending"`:
1. `isTerminal` evaluates to `false` for every job. The red `cancel` button is **permanently rendered and clickable** on all terminal jobs.
2. Clicking `cancel` on a completed job triggers `POST /hub/fleet/jobs/:id/cancel`, which responds with HTTP 409 `job-already-terminal`, displaying an error banner to the operator: `cancel failed: job is already in terminal state`.
3. The status badge in the job row and job detail view permanently renders as `<span class="badge ...">pending</span>` with info-blue styling.
4. The progress bar fill class (`progress-bar-fill ${progressClass}`) never receives `.completed` or `.failed` classes.
5. In `renderFleetJobDetail` (`ui/app.mjs:549`), completed timestamp always displays `-` because `completedAt` is `null` (backend property is `finishedAt`).
6. In `mapFleetJobDetail` (`ui/view-model.mjs:260`), `nodeResults[i].completedAt` is `null` because per-node task results define `finishedAt`.
7. When `totalTargets === 0`, `progressPercent` evaluates to `0` instead of `100` for completed jobs because `job?.state === "completed"` evaluates to `false`.

#### Test Blind Spot
In `test/v07-stage3-operator-ui.test.mjs:187, 246`, the unit tests mocked artificial job fixtures using `state: "running"` and `state: "partial"` instead of the authoritative schema `status`.
In the integration test (`test/v07-stage3-operator-ui.test.mjs:366`):
```javascript
assert.ok(jobsListHtml.includes("completed"));
```
This assertion passed purely by coincidence because `jobsListHtml` contained the substring `"completed 2"` from `summary.completed` in the metadata string. The test never asserted `mapped.rows[0].state === "completed"` or inspected the actual status badge element.

#### Required Remediation
1. In `ui/view-model.mjs`:
   - Fall back to `job?.status`:
     ```javascript
     const status = job?.status ?? job?.state ?? "pending";
     ```
     Expose both `state: status` (for UI compatibility) and `status: status`.
   - Fall back to `job?.finishedAt`:
     ```javascript
     const finishedAt = job?.finishedAt ?? job?.completedAt ?? null;
     ```
     Expose both `completedAt: finishedAt` and `finishedAt: finishedAt`.
   - In zero-targets progress calculation:
     ```javascript
     : status === "completed" ? 100 : 0
     ```
   - In `mapFleetJobDetail`:
     ```javascript
     completedAt: res?.finishedAt ?? res?.completedAt ?? null,
     finishedAt: res?.finishedAt ?? res?.completedAt ?? null,
     ```
2. In `test/v07-stage3-operator-ui.test.mjs`:
   - Update unit test fixtures to test both `status` (canonical) and `state` (legacy).
   - Add explicit assertions verifying that `row.state === "completed"`, that the status badge renders `completed`, and that the `cancel` button is removed once the job settles.

---

### [P2] Dialog `timeoutMs` parameter is dropped by Hub server and ignored in Job Detail view

`ui/index.html:74-76`, `ui/app.mjs:744-747`, `ui/view-model.mjs:269`, `ui/app.mjs:550`, `src/registry/server.mjs:817-824`

#### Root Cause
In `ui/index.html:74-76`, the trigger modal dialog provides a timeout input:
```html
<label>Timeout (ms)
  <input id="fleet-job-timeout" type="number" value="30000" min="1000" max="300000">
</label>
```
In `ui/app.mjs:744-747`, `submitFleetJob` extracts this value and submits:
```javascript
const rawTimeout = $("fleet-job-timeout")?.value;
const timeoutMs = rawTimeout ? parseInt(rawTimeout, 10) : 30000;
const body = { taskType, targetSpec, timeoutMs };
if (payload !== undefined) body.payload = payload;
```
However, on the server side (`src/registry/server.mjs:817-824`):
```javascript
job = fleetScheduler.submitJob({
  jobId: body.jobId,
  taskType: body.taskType,
  payload: body.payload,
  targetSpec: body.targetSpec,
  requiredCapabilities: body.requiredCapabilities,
  operatorPrincipal: session.operatorPrincipal,
});
```
`body.timeoutMs` is completely omitted from the scheduler invocation.
`FleetJobScheduler.submitJob()` does not accept `timeoutMs` as a top-level parameter (`fleet-scheduler.mjs:281-288`), and `dispatchWithTimeout()` resolves timeout from `job.payload.timeoutMs` (`fleet-scheduler.mjs:529-531`):
```javascript
const timeoutMs = typeof job.payload.timeoutMs === "number" && job.payload.timeoutMs > 0
  ? job.payload.timeoutMs
  : this.defaultTimeoutMs;
```
Furthermore, `FleetJobScheduler.getJob()` does not include `timeoutMs` in the returned snapshot.
In `ui/view-model.mjs:269`:
```javascript
timeoutMs: typeof job?.timeoutMs === "number" ? job.timeoutMs : null,
```
Because `job.timeoutMs` is never set or returned by the scheduler, `detail.timeoutMs` is always `null`.
In `ui/app.mjs:550`:
```javascript
<dt>timeout</dt><dd>${detail.timeoutMs !== null ? `${detail.timeoutMs}ms` : "-"}</dd>
```
The detail view always displays `timeout: -`.

#### Impact
1. Any custom timeout entered by an operator in the trigger dialog (e.g. 5000ms or 120000ms) is discarded; the scheduler always falls back to the default 30000ms.
2. The job detail view cannot display the execution timeout configured for the job.

#### Required Remediation
1. When submitting a job from `ui/app.mjs`, embed `timeoutMs` into `payload.timeoutMs` if not present, and/or update `server.mjs` and `FleetJobScheduler.submitJob` to accept and preserve top-level `timeoutMs`.
2. In `ui/view-model.mjs`: check `typeof job?.timeoutMs === "number" ? job.timeoutMs : (typeof job?.payload?.timeoutMs === "number" ? job.payload.timeoutMs : null)`.

---

### [P3] Badge class string duplication produces `class="badge badge <type>"`

`ui/app.mjs:477-478, 521, 545`

#### Detail
`badgeClass(dimension, value)` returns `"badge " + value`.
In `renderFleetJobRow` and `renderFleetJobDetail`, the template writes:
```javascript
<span class="badge ${badgeClass("taskType", job.taskType)}">${escapeHtml(job.taskType)}</span>
<span class="badge ${badgeClass("state", job.state)}">${escapeHtml(job.state)}</span>
```
This generates duplicate class names: `class="badge badge diagnostic"` and `class="badge badge pending"`. In contrast, existing code in `ui/app.mjs:119, 199` writes `<span class="${badgeClass(...)}">` without the redundant `badge` literal.

#### Required Remediation
Remove the redundant `badge` class prefix in template literals where `badgeClass` is used.

---

### [P3] Numeric mapping in `mapFleetJobRow` and `mapFleetJobDetail` lacks `Number.isFinite` and non-negative guards

`ui/view-model.mjs:207-212, 257-258`

#### Detail
`ui/view-model.mjs` checks:
```javascript
const total = typeof summary.totalTargets === "number" ? summary.totalTargets : 0;
const completed = typeof summary.completed === "number" ? summary.completed : 0;
```
In JavaScript, `typeof NaN === "number"` and `typeof -5 === "number"` are both `true`.
If `summary` contains `NaN` or negative values, `progressPercent` can evaluate to `NaN` or negative numbers, producing invalid inline styles (`style="width: NaN%"`).
Similarly, `res.durationMs` and `res.exitCode` preserve `NaN` instead of normalizing to `null`.

#### Required Remediation
Use `Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0` for counters, `Number.isFinite(v) ? v : null` for exit code and duration, and `Math.min(100, Math.max(0, Math.round((settled / total) * 100)))` for percentage calculation.

---

### [P3] Test suite testing gaps: capability target mode, cancellation from detail view, and badge verification omitted

`test/v07-stage3-operator-ui.test.mjs:44-45, 328-370, 430-438`

#### Detail
1. Although `fleet-job-capability-group` and `fleet-job-target-capability` are registered in `ELEMENT_IDS`, the test suite never simulates selecting `mode: "capability"`, never tests the `change` event on the mode select dropdown, never verifies the error banner when capability name is empty, and never executes a capability-based dispatch.
2. The cancellation test only verifies cancellation from the list row; cancellation from `#cancel-detail-job` is unexercised.
3. The cancellation test does not inspect the UI DOM after cancellation; it only checks the server state (`server.fleetScheduler.jobs.get(jobId).status === "failed"`), missing the UI freeze documented in P1.

#### Required Remediation
Expand `test/v07-stage3-operator-ui.test.mjs` to test:
- Mode dropdown toggle and capability input form validation.
- End-to-end capability mode submission.
- Cancellation from the detail view.
- Explicit DOM assertions on badge classes and text content after execution and cancellation.

---

## Technical Audit & Verification

### 1. Tab Navigation & View Management
Verified in `ui/app.mjs:758-787`:
- Clicking `#nav-fleet` marks `#nav-fleet` active, deactivates `#nav-nodes` and `#nav-tokens`, hides `#nodes-view` and `#tokens-view`, and displays `#fleet-view`.
- Navigation resets view hierarchy so that `#fleet-jobs-list` is shown and `#fleet-job-detail-view` is hidden.
- Clicking `#back-to-fleet-jobs` successfully switches back to the job list.

### 2. XSS & HTML Injection Audit
Audited all template strings in `renderFleetJobRow` and `renderFleetJobDetail`:
- `jobId`, `taskType`, `state`, `createdAt`, `updatedAt`, `startedAt`, `completedAt` are passed through `escapeHtml()`.
- `targetSpec` and `payload` are passed through `JSON.stringify(..., null, 2)` and `escapeHtml()`.
- Node results `stdout`, `stderr`, and `error` are strictly escaped before insertion into `<div class="log-box">` and `<div class="banner error">`.
- Dialog error messages use `err.textContent = ...` directly.
- Banner messages are escaped via `showBanner`.
- Double-quoted HTML attributes are used consistently with `escapeHtml()`.
- Verdict on XSS: **SECURE (PASS)**.

### 3. Error Handling & 5xx Invariant
- All API interactions in `ui/app.mjs` (`loadFleetJobs`, `loadFleetJobDetail`, `cancelFleetJob`, `submitFleetJob`) are wrapped in `try ... catch` blocks.
- Non-OK responses are caught and translated into operator-facing banner messages without throwing unhandled exceptions.
- JSON parsing for payload textarea is wrapped in `try ... catch` with user-facing validation errors before network submission.
- Verdict on error handling: **PASS**.

### 4. Gate Verification Suite
Executed in `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate` (Node v25.9.0 on win32):
- `git diff --check 5eb7f86..5e61798`: Exit 0 (clean, no whitespace/conflict markers).
- `node scripts/check-public-tree.mjs`: Exit 0 ("Public-tree validation passed.").
- `node --test test/ui-dom.test.mjs`: 7/7 passed (duration 264ms).
- `node --test test/v07-stage3-operator-ui.test.mjs`: 5/5 passed (duration 88ms).
- `npm run check`: 572 tests total: 566 passed, 0 failed, 6 skipped (pre-existing platform/drill skips).

---

## Gate B Verdict

**FAIL (REVISE/BLOCK)**

### Stop-Work Justification
Under SOP §5 (`v0.7-fleet-workflows-multistage-sop.md:178`), any non-zero P0, P1, or P2 finding is a hard Blocker:
- **P1 Blocker**: Schema mismatch between backend `status`/`finishedAt` and UI view-model `state`/`completedAt` permanently freezes UI status to `"pending"`, breaks status badges, leaves cancel buttons enabled on completed jobs, and causes HTTP 409 conflict errors upon cancel clicks.
- **P2 Blocker**: Dialog `timeoutMs` parameter is dropped by the Hub server and ignored by the detail view, preventing custom task timeout configuration and suppressing timeout display.

Remediation is required before Gate B can be granted.
