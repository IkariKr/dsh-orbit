# v0.7 Stage 3 Gate B Independent Code Review (Round 2 Re-Review)

- Scope: `chore/v0.7-stage3-operator-ui`, HEAD `aa6e1e55047ae374f1d4317f2fe963d3392ea814` (`aa6e1e5`)
- Prior reviewed commit (Round 1): `5e6179886d658468291dd965b01b0edf9bb93a99` (`5e61798`)
- Baseline parent: `5eb7f865f12e8739d48b11112e4f0dc2fcf02cb2` (Stage 2 Gate 2 PASS closure `03a1795`)
- Reviewer: independent code review (`@code-reviewer2`)
- Verdict: **PASS** — 0x P0, 0x P1, 0x P2, 0x P3. Gate B granted.

---

## Executive Summary

Commit `aa6e1e5` addresses all findings identified in the Round 1 Gate B independent review (`docs/review/2026-09-26-v07-stage3-gate-b-review-5e61798.md`).

The cumulative diff from Stage 2 base (`5eb7f86..aa6e1e5`) spans 7 files (+1073 / -15):
1. `src/registry/fleet-scheduler.mjs` (+19 / -1): Accepts and validates `timeoutMs`, persists it on `job`, exposes it in `getJob()`, and respects it during node task dispatch.
2. `src/registry/server.mjs` (+1 / -0): Passes incoming `body.timeoutMs` to `fleetScheduler.submitJob()`.
3. `ui/view-model.mjs` (+87 / -3): Canonical `status` and `finishedAt` mapping with backwards-compatible `state` and `completedAt` aliases; non-negative integer defensive normalization with `Number.isFinite`; bounded percentage calculation; robust timeout resolution.
4. `ui/app.mjs` (+353 / -20): Complete Operator UI Fleet Workflows panel, job list with progress bars, job details view with execution logs, modal trigger dialog with mode switching (`explicit` vs `capability`), cancellation handling from both list and detail views, and corrected badge class styling.
5. `ui/index.html` (+45 / -0): Fleet tab navigation button, `#fleet-view` section, `#fleet-jobs-list`, `#fleet-job-detail-view`, and modal dialog.
6. `ui/styles.css` (+20 / -2): Styles for fleet actions, cards, progress bars, task badges, node results table, and dark log viewers.
7. `test/v07-stage3-operator-ui.test.mjs` (+567 / -0, new): End-to-end unit, contract, and DOM integration tests covering view-models, capability mode selection, validation, dispatch, detail rendering, timeout display, and job cancellation.

All 573 test suite cases pass cleanly, public tree verification passes, and git diff checks show zero whitespace or formatting defects.

---

## Verification of Round 1 Findings

### 1. [P1] Schema Mismatch: `status` vs `state` & `finishedAt` vs `completedAt` — RESOLVED

- **Remediation in `ui/view-model.mjs`**:
  - `mapFleetJobRow` extracts `const status = job?.status ?? job?.state ?? "pending";`.
  - Exposes both `status` and `state: status`.
  - Extracts `const finishedAt = job?.finishedAt ?? job?.completedAt ?? null;`.
  - Exposes both `finishedAt` and `completedAt: finishedAt`.
  - Zero-targets progress calculation checks `isCompleted = status === "completed"`.
  - `mapFleetJobDetail` node results map both `finishedAt` and `completedAt: res?.finishedAt ?? res?.completedAt ?? null`.
- **Remediation in `ui/app.mjs`**:
  - `renderFleetJobRow` and `renderFleetJobDetail` evaluate `const status = job.status ?? job.state ?? "pending";`.
  - `isTerminal` evaluates `status === "completed" || status === "failed" || status === "partial"`.
  - Completed jobs now correctly omit the red `cancel` button in both list and detail views.
  - Progress bar fill classes receive `completed` or `failed` styling based on authoritative `status`.
  - Detail view renders completed timestamp via `detail.completedAt ?? detail.finishedAt ?? "-"`.
- **Test Coverage**:
  - `test/v07-stage3-operator-ui.test.mjs`:
    - `mapFleetJobRow` tests with canonical Hub fixture (`status: "running"`, `finishedAt: null`) and asserts `row.status === "running"` and `row.state === "running"`.
    - Integration tests assert that completed jobs render `<span class="badge completed">completed</span>` and verify that `data-cancel-job-id` and `#cancel-detail-job` are omitted from the DOM when terminal.

### 2. [P2] Dialog `timeoutMs` Parameter Handling — RESOLVED

- **Remediation in `src/registry/fleet-scheduler.mjs`**:
  - `submitJob` accepts `timeoutMs = null`.
  - Defensively normalizes `parsedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : ...`.
  - Sets `timeoutMs: parsedTimeout` on job record.
  - `getJob()` exposes `timeoutMs: job.timeoutMs ?? null`.
  - Execution dispatch (`dispatchWithTimeout` caller) resolves `job.timeoutMs` first before falling back to `job.payload?.timeoutMs` and `defaultTimeoutMs`.
- **Remediation in `src/registry/server.mjs`**:
  - Passes `timeoutMs: body.timeoutMs` to `fleetScheduler.submitJob()`.
- **Remediation in `ui/app.mjs` & `ui/view-model.mjs`**:
  - `submitFleetJob` passes `timeoutMs` at top-level and preserves it in `body.payload.timeoutMs` for fallback defense.
  - `mapFleetJobDetail` parses `timeoutMs` from either `job.timeoutMs` or `job.payload.timeoutMs`.
  - `renderFleetJobDetail` displays `${detail.timeoutMs}ms`.
- **Test Coverage**:
  - Integration test triggers a job with `fleet-job-timeout = "15000"`, navigates to detail view, and asserts `15000ms` is rendered in DOM.
  - View-model tests verify both top-level and payload fallback mapping.

### 3. [P3] Redundant Badge Class Prefix — RESOLVED

- **Remediation in `ui/app.mjs`**:
  - Removed redundant `badge` literal before `${badgeClass(...)}` in `renderFleetJobRow` and `renderFleetJobDetail`.
  - Resulting HTML renders cleanly as `<span class="badge completed">completed</span>` without `badge badge` duplication.
  - Audited full UI codebase; zero occurrences of `class="badge badge"` remain.

### 4. [P3] Numeric Field Defensiveness — RESOLVED

- **Remediation in `ui/view-model.mjs`**:
  - Added helper `toNonNegativeInt = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)` applied to `totalTargets`, `completed`, `failed`, `timeout`, `unreachable`, `skipped`.
  - Progress percentage calculation bounded with `Math.min(100, Math.max(0, Math.round((settled / total) * 100)))`.
  - `exitCode` guarded with `Number.isFinite(res?.exitCode) ? Math.floor(res.exitCode) : null`.
  - `durationMs` guarded with `Number.isFinite(res?.durationMs) && res.durationMs >= 0 ? Math.floor(res.durationMs) : null`.
  - `timeoutMs` guarded with `Number.isFinite(...) && ... > 0 ? Math.floor(...) : null`.
- **Test Coverage**:
  - Unit tests verify defensive behavior with `totalTargets: NaN` and `completed: -5`.

### 5. [P3] Test Coverage Gaps — RESOLVED

- **Remediation in `test/v07-stage3-operator-ui.test.mjs`**:
  - Added dedicated test `app-level: capability mode switching and target capability validation in dialog (P3)`:
    - Enrolls node with `["web.routes"]` capability.
    - Changes target mode select to `"capability"`.
    - Asserts explicit input container hides and capability container displays.
    - Tests submit with empty capability -> verifies validation error banner.
    - Submits with valid capability -> verifies dialog closure, scheduler job record creation with `targetSpec: { mode: "capability", capability: "web.routes" }`, and node resolution.
  - Expanded `app-level: job cancellation via UI list button and detail view button (P1, P3)`:
    - Verifies cancellation via job list row action button.
    - Verifies cancellation via job detail view `#cancel-detail-job` button.
    - Uses mock dispatch transport to verify in-flight cancellation requests and banner display.
  - Added explicit DOM content assertions checking badge classes and text across all states.

---

## Technical Audit Matrix

| Verification Item | Requirement | Status | Observations |
|---|---|---|---|
| **P1 Contract Alignment** | Canonical `status` & `finishedAt` | **PASS** | Fully integrated in view-model and UI; terminal jobs hide cancel button. |
| **P2 Timeout Handling** | End-to-end `timeoutMs` propagation | **PASS** | Passes through server, scheduler, and displays in detail view. |
| **P3 Badge Classes** | No duplicate `class="badge badge"` | **PASS** | Template literals updated; verified 0 duplicate class occurrences. |
| **P3 Defensive Math** | `Number.isFinite` & non-negative bounds | **PASS** | Counter and percentage calculations fail closed safely on NaN/negatives. |
| **P3 Test Coverage** | Capability mode, detail cancel, DOM badges | **PASS** | 6 integration and unit tests passing with high assertion density. |
| **XSS Prevention** | Strict HTML escaping on untrusted output | **PASS** | `stdout`, `stderr`, `error`, `jobId`, `payload` all escaped via `escapeHtml`. |
| **Tree Cleanliness** | `scripts/check-public-tree.mjs` | **PASS** | Public-tree validation passed. |
| **Diff Cleanliness** | `git diff --check` | **PASS** | Clean diff with zero whitespace or conflict warnings. |
| **Full Test Suite** | `npm run check` | **PASS** | 573 tests: 567 passed, 0 failed, 6 skipped. |

---

## Gate B Verdict

**PASS**

Commit `aa6e1e5` successfully resolves all P1, P2, and P3 findings from Round 1.
The Operator UI Fleet Workflows panel, job trigger dialog, real-time progress indicators, and detail inspection flows satisfy all RFC-0014 Stage 3 acceptance criteria (Acceptance Matrix Field 10).

Gate B is granted. Stage 3 is ready for merge into main/candidate branch.
