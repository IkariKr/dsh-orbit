# v0.8 Stage 3 Gate B Independent Code Review

- **Target Repository**: `D:/App/01_Ai/CodeX/dsh-orbit-v05-formal-candidate`
- **Scope**: `chore/v0.8-stage3-operator-ui`, HEAD `18a7dfa0d55907f8a426702fe9ee188de2a32cdf` (`18a7dfa`)
- **Baseline Parent**: `7d5a56b460d9d40cb97e594d2df423984ca53b6f` (`7d5a56b`)
- **Reviewer**: Independent Code Reviewer (`@code-reviewer2`)
- **Review Verdict**: **FAIL (REVISE/BLOCK)** — Gate B not granted.
- **Finding Counts**:
  - **P0**: 0
  - **P1**: 0
  - **P2**: 2 (Navigation tab active state leak on `nav-nodes`, unhandled promise rejections & missing error handling on schedule action buttons with stale metrics on trigger)
  - **P3**: 4 (Significant test blind spots vs claimed test header scope, orphaned `#schedule-detail-view` DOM element, payload field pollution in `submitSchedule`, missing `.badge.paused` CSS style)

---

## 1. Executive Summary & Review Scope

This review evaluates the Stage 3 Operator UI implementation for DSH Orbit v0.8 (Scheduled Workflows and Fleet Automation), delivered on branch `chore/v0.8-stage3-operator-ui` at commit `18a7dfa`.

The Stage 3 scope includes:
1. `ui/view-model.mjs`: View-model mappers (`mapScheduleRow`, `mapScheduleList`, `EMPTY_SCHEDULES_STATE`), mapping trigger rules, next/last run times, run counts, status badges, and scrubbed parameters.
2. `ui/index.html`: Navigation tab (`#nav-schedules`), view panel (`#schedules-view`), and creation dialog (`#schedule-dialog`) with cron/interval selectors and target mode toggles.
3. `ui/app.mjs`: DOM event wiring, schedule rendering (`renderScheduleRow`, `renderSchedules`), creation form handling (`submitSchedule`), and actions (pause, resume, manual trigger, delete).
4. `test/v08-stage3-operator-ui.test.mjs`: Unit and DOM integration tests verifying view-model mapping, dialog interactions, API calls, and list updates.

Governing specifications:
- RFC-0015 D1, D4 (`docs/rfc/0015-scheduled-workflows-and-fleet-automation.md`);
- v0.8 Multistage SOP (`docs/sop/v0.8-scheduled-workflows-multistage-sop.md:115-121, 170-183`);
- Stop-Work Matrix: "Non-zero P0, P1, or P2 finding | Blocker | Fix, re-test, re-review until PASS."

While the core view-model mappings and basic schedule creation flow are implemented cleanly without HTML injection vulnerabilities, the code contains two P2 defects:
1. A visual and state regression in tab navigation where clicking `nav-nodes` after visiting `nav-schedules` leaves both tabs marked `active` simultaneously.
2. Complete absence of `try/catch` error handling on all four schedule action button dispatches (`pause`, `resume`, `trigger now`, `delete`), resulting in unhandled promise rejections and silent UI freezing when API calls fail (e.g. HTTP 409 when pausing completed schedules), accompanied by failure to refresh schedule metrics upon manual trigger dispatch.

Under the SOP Stop-Work criteria, non-zero P2 findings mandate a verdict of **FAIL (REVISE/BLOCK)**.

---

## 2. Verification of Scope and Criteria

### 2.1 Commit Lineage & Working Tree Hygiene

1. Commit history:
   ```text
   18a7dfa feat(ui): implement Scheduled Workflows panel, creation dialog, and trigger controls (Stage 3)
   7d5a56b docs(review): record Stage 2 Gate 2 PASS code review and remediate P3 scheduleId validation
   840c72f feat(hub): implement fleet schedule management endpoints and audit logging (Stage 2)
   db06e07 docs(review): record Stage 1 Gate 1 PASS code review and remediate P3 range validation
   d0957aa feat(schedule): implement cron/interval parser, persistent storage, and ScheduledWorkflowEngine (Stage 1)
   ```
2. Ancestry check: `git merge-base --is-ancestor 7d5a56b 18a7dfa` evaluated to true. Direct linear descent is maintained.
3. Working tree status: `git status` reports working tree clean on branch `chore/v0.8-stage3-operator-ui`.
4. Whitespace and merge conflicts: `git diff --check` executed with zero warnings or errors.
5. Public tree check: `node scripts/check-public-tree.mjs` passed with status 0 (`Public-tree validation passed.`).

### 2.2 Test Suite Execution

The required test suites were executed directly against the candidate codebase:

- **Stage 3 Operator UI Integration Test**:
  `node --test test/v08-stage3-operator-ui.test.mjs`
  - 2 tests, 2 passed, 0 failed (195.4ms).
  - Validates `mapScheduleRow` and `mapScheduleList` with empty and populated states, and verifies tab navigation, dialog opening, and creation of an explicit cron schedule.
- **Stage 3 Fleet Operator UI Regression Test**:
  `node --test test/v07-stage3-operator-ui.test.mjs`
  - 6 tests, 6 passed, 0 failed (218.8ms). Zero regressions in fleet view models and DOM controls.
- **Stage 2 Hub Endpoints Integration Test**:
  `node --test test/v08-stage2-schedule-endpoints.test.mjs`
  - 1 test, 1 passed, 0 failed (62.7ms).
- **v0.8 Governance Contract Tests**:
  `node --test test/v08-governance-contract.test.mjs`
  - 4 tests, 4 passed, 0 failed (212.0ms).
- **Core UI DOM & Engine Tests**:
  `node --test test/ui-dom.test.mjs test/v08-stage1-schedule-engine.test.mjs`
  - 13 tests, 13 passed, 0 failed (241.5ms). Zero regressions in nodes, tokens, and routing UI.

---

## 3. Detailed Technical Assessment

### 3.1 `ui/view-model.mjs`

- `EMPTY_SCHEDULES_STATE`: Properly frozen object with `kind: "fleet-schedules"`, `rows: Object.freeze([])`, and `totalSchedules: 0`.
- `mapScheduleRow(schedule)`:
  - Gracefully handles nullish or malformed inputs without throwing.
  - Accurately constructs `triggerRule` for cron expressions (`cronExpression`), interval timers (`every ${intervalMs}ms`), or fallback (`"once"`).
  - Normalizes run counters with `toNonNegativeInt(schedule?.totalRuns)` and `maxRuns`.
  - Safely defaults `nextRunAt` and `lastRunAt` to `"-"`.
  - Maintains credential scrubbing: payloads and parameters are scrubbed server-side by `hydrateScheduleRow()`, and `mapScheduleRow` avoids leaking raw credential payloads into the list card view.
- `mapScheduleList(schedules)`: Safely returns `EMPTY_SCHEDULES_STATE` when given empty arrays, non-arrays, or nullish inputs.

### 3.2 `ui/index.html` & Layout

- Added `#nav-schedules` button to top navigation bar.
- Added `#schedules-view` section containing `#create-schedule-btn`, `#refresh-schedules-btn`, `#schedules-list`, and `#schedule-detail-view`.
- Added `#schedule-dialog` with:
  - `#schedule-name` input;
  - `#schedule-type` dropdown (`cron` vs `interval`);
  - `#schedule-cron-group` and `#schedule-cron` input;
  - `#schedule-interval-group` and `#schedule-interval` number input;
  - `#schedule-task-type` input;
  - `#schedule-target-mode` dropdown (`explicit` vs `capability`);
  - `#schedule-explicit-group` with `#schedule-target-nodes`;
  - `#schedule-capability-group` with `#schedule-target-capability`;
  - `#schedule-concurrency` dropdown (`forbid` vs `allow`);
  - `#schedule-error` banner container;
  - `#schedule-cancel` and `#schedule-submit` buttons.
- All input IDs align with those wired in `ui/app.mjs`.

### 3.3 `ui/app.mjs`

- Tab navigation properly switches view visibility (`hidden = false` for active section, `true` for others).
- XSS prevention: all dynamic strings in `renderScheduleRow` are properly escaped using `escapeHtml()`.
- Schedule creation dialog toggles input groups dynamically via `change` event listeners.
- **Defects identified**:
  - `$("nav-nodes")` click handler fails to remove `active` class from `nav-schedules`, causing two navigation tabs to remain highlighted as active simultaneously (Finding 1).
  - `$("schedules-list")` click listener delegates `pause`, `resume`, `trigger`, and `delete` actions directly to `api(...)` calls with zero `try/catch` wrapping. Any backend error (e.g. 401, 403, 404, 409, 503) throws an unhandled rejection without displaying feedback in `#state-banner` (Finding 2).
  - Triggering a schedule manually fails to call `loadSchedules()`, causing `Total Runs` and `Last Run` to remain stale on the UI card (Finding 2).
  - Schedules in `completed` state render a `pause` button that is invalid and fails with HTTP 409 (Finding 2).
  - Form submission does not clear unselected schedule type fields, submitting leftover cron expressions when creating interval schedules (Finding 5).

---

## 4. Findings & Remediation

### [P2] In `ui/app.mjs`, `nav-nodes` event listener fails to remove `active` class from `nav-schedules`

- **Location**: `ui/app.mjs:847-856`
- **Description**:
  When `nav-tokens`, `nav-fleet`, and `nav-schedules` event listeners were updated, they each remove `active` from the other three tabs. However, `nav-nodes` was not updated to remove `active` from `nav-schedules`:
  ```javascript
  $("nav-nodes")?.addEventListener("click", async () => {
    $("nav-nodes")?.classList.add("active");
    $("nav-tokens")?.classList.remove("active");
    $("nav-fleet")?.classList.remove("active");
    // MISSING: $("nav-schedules")?.classList.remove("active");
    if ($("tokens-view")) $("tokens-view").hidden = true;
    if ($("fleet-view")) $("fleet-view").hidden = true;
    if ($("schedules-view")) $("schedules-view").hidden = true;
    if ($("nodes-view")) $("nodes-view").hidden = false;
    await loadNodes();
  });
  ```
- **Reproduction**:
  1. Click "Scheduled Workflows" tab (`nav-schedules` receives `.active`).
  2. Click "Nodes" tab (`nav-nodes` receives `.active`).
  3. Inspect `nav-schedules.classList.contains("active")`: evaluates to `true`.
  4. Both "Nodes" and "Scheduled Workflows" appear simultaneously selected in the navigation bar.
- **Required Remediation**:
  Add `$("nav-schedules")?.classList.remove("active");` inside `$("nav-nodes")?.addEventListener(...)`.

---

### [P2] Missing error handling in `schedules-list` action button click handlers, stale metrics on manual trigger, and invalid pause button on completed schedules

- **Location**: `ui/app.mjs:739-743, 909-930`
- **Description**:
  1. **Unhandled Rejections**: In `schedules-list` click handling:
     ```javascript
     $("schedules-list")?.addEventListener("click", async (event) => {
       const target = event.target;
       if (target.dataset?.pauseScheduleId) {
         await api(`/hub/fleet/schedules/${target.dataset.pauseScheduleId}/pause`, { method: "POST" });
         await loadSchedules();
         return;
       }
       if (target.dataset?.resumeScheduleId) {
         await api(`/hub/fleet/schedules/${target.dataset.resumeScheduleId}/resume`, { method: "POST" });
         await loadSchedules();
         return;
       }
       if (target.dataset?.triggerScheduleId) {
         await api(`/hub/fleet/schedules/${target.dataset.triggerScheduleId}/trigger`, { method: "POST" });
         showBanner({ message: `schedule triggered manually` });
         return;
       }
       if (target.dataset?.deleteScheduleId) {
         await api(`/hub/fleet/schedules/${target.dataset.deleteScheduleId}`, { method: "DELETE" });
         await loadSchedules();
         return;
       }
     });
     ```
     None of these four operations are wrapped in `try...catch` blocks. If any request fails (e.g., HTTP 409 when attempting to pause an inactive or completed schedule, HTTP 404 for a deleted schedule, or network drop), an unhandled rejection is raised and the user receives no error message in `#state-banner`.
  2. **Stale Metrics on Trigger**: Manual trigger dispatch increments `total_runs` and updates `last_run_at` on the backend, but does not invoke `loadSchedules()`. As a result, the schedule card continues to display stale run counts and execution timestamps.
  3. **Completed Schedule Action State**: `renderScheduleRow` conditionally renders pause/resume using `isPaused = sched.status === "paused"`. If `sched.status === "completed"` (e.g. when `maxRuns` is reached), `isPaused` evaluates to `false`, rendering an active `pause` button. Clicking `pause` on a completed schedule sends a request to the Hub that is rejected with HTTP 409 `schedule-not-active`. For completed schedules, the pause/resume button should be omitted or disabled.
- **Required Remediation**:
  Wrap all schedule action handlers in `try...catch`, surface failures via `showBanner({ message: \`... failed: \${error.message}\` })`, invoke `await loadSchedules()` following manual trigger dispatch, and omit or disable the pause/resume button when `sched.status === "completed"`.

---

### [P3] False claims in test documentation and comprehensive blind spots in `test/v08-stage3-operator-ui.test.mjs`

- **Location**: `test/v08-stage3-operator-ui.test.mjs:1-6, 208-259`
- **Description**:
  The test file header explicitly claims:
  `// 3. Create schedule dialog with cron/interval selector and target mode toggle`
  `// 4. In-page pause, resume, trigger now, and delete action button dispatches`
  However, the test suite contains only two tests:
  1. A view-model test with a single static cron fixture.
  2. A DOM integration test that tests only explicit cron creation.
  None of the four in-page action buttons (`data-pause-schedule-id`, `data-resume-schedule-id`, `data-trigger-schedule-id`, `data-delete-schedule-id`), nor interval schedule creation, nor capability target mode, nor dialog cancel, nor refresh schedules, nor creation error banner display are tested anywhere in the test suite.
- **Remediation Guidance**:
  Expand `test/v08-stage3-operator-ui.test.mjs` to test in-page pause, resume, trigger, and delete action dispatches against the test Hub server, verify target capability mode creation, verify interval schedule creation, and verify creation error handling.

---

### [P3] Orphaned `#schedule-detail-view` DOM element and deferred execution history runs view

- **Location**: `ui/index.html:58`, `test/v08-stage3-operator-ui.test.mjs:56`
- **Description**:
  `ui/index.html` added `<div id="schedule-detail-view" hidden></div>`, and `test/v08-stage3-operator-ui.test.mjs` added it to `ELEMENT_IDS`. However, `ui/app.mjs` contains zero references or logic to render past scheduled runs. RFC-0015 SOP Stage 3 scope includes "Execution history modal viewing past scheduled runs", and Stage 2 implemented `GET /hub/fleet/schedules/:id/runs`. Currently, the `#schedule-detail-view` element remains orphaned dead code.
- **Remediation Guidance**:
  Either connect `#schedule-detail-view` to fetch and render past schedule runs from `/hub/fleet/schedules/:id/runs`, or clarify in the SOP that detailed run history is deferred to Stage 4.

---

### [P3] Payload field pollution in `submitSchedule()`

- **Location**: `ui/app.mjs:804-830`
- **Description**:
  `submitSchedule` extracts both `cronExpression` and `intervalMs` from the DOM regardless of `scheduleType`. When `scheduleType === "interval"`, `body.cronExpression` is populated with the default `"0 2 * * *"` from `#schedule-cron` and persisted into SQLite.
- **Remediation Guidance**:
  Sanitize the request body to send `cronExpression` only when `scheduleType === "cron"` and `intervalMs` only when `scheduleType === "interval"`:
  ```javascript
  const body = {
    name,
    scheduleType,
    cronExpression: scheduleType === "cron" ? $("schedule-cron")?.value : null,
    intervalMs: scheduleType === "interval" && $("schedule-interval")?.value ? Number($("schedule-interval").value) : null,
    taskType,
    targetSpec,
    concurrencyPolicy,
  };
  ```

---

### [P3] Missing CSS class definition for `.badge.paused` in `ui/styles.css`

- **Location**: `ui/styles.css:75, 131-136`
- **Description**:
  `ui/styles.css` defines badges for `.active`, `.ok`, `.pending`, `.running`, `.completed`, `.failed`, `.partial`, `.timeout`, and `.skipped`. However, `.badge.paused` is omitted. When a schedule is paused, it renders `<span class="badge paused">paused</span>` with unstyled default borders.
- **Remediation Guidance**:
  Add `.badge.paused { border-color: var(--warn); color: var(--warn); }` or `var(--muted)` to `ui/styles.css`.

---

## 5. Review Verdict & Recommendations

- **Gate B Verdict**: **FAIL (REVISE/BLOCK)**
- **Finding Counts**: 0x P0, 0x P1, 2x P2, 4x P3.
- **Action Plan for Gate B Clearance**:
  1. Fix `nav-nodes` event listener to remove `active` class from `nav-schedules` (`ui/app.mjs:850`).
  2. Add `try/catch` and `showBanner` error feedback for all four schedule actions (`pause`, `resume`, `trigger`, `delete`) in `schedules-list` click listener (`ui/app.mjs:909-930`).
  3. Call `await loadSchedules()` after manual trigger dispatch so `totalRuns` and `lastRunAt` are immediately updated.
  4. Omit or disable the `pause` button when `sched.status === "completed"`.
  5. Sanitize `submitSchedule` payload based on `scheduleType`.
  6. Expand `test/v08-stage3-operator-ui.test.mjs` with integration tests covering pause, resume, trigger now, delete, and mode switching.
  7. Add `.badge.paused` styling to `ui/styles.css`.
  8. Submit remediation commit and request Gate B re-review.
