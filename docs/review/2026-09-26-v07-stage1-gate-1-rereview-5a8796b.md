# v0.7 Stage 1 Gate 1 Independent Code Re-Review

- Scope: `chore/v0.7-stage1-fleet-scheduler`, HEAD `5a8796b45c803dac09e44b19d70a8415b06a4a3a` (`5a8796b`)
- Reviewed fix commit: `5a8796b` ("fix(fleet): resolve Gate 1 review findings for cancellation, immutability, and capability fail-closed")
- Prior review: `docs/review/2026-09-26-v07-stage1-gate-1-2003ab3.md` (initial verdict FAIL, 1x P1 / 3x P2 / 1x P3)
- Reviewer: independent code review (`@code-reviewer2`)
- Verdict: **FAIL (REVISE)** — all 5 prior findings verified fixed; 1x new P2 regression introduced by the fix, plus 1x P3 test gap

---

## Review Scope

Independent Gate 1 re-review of the Stage 1 fix commit `5a8796b` on branch `chore/v0.7-stage1-fleet-scheduler`. `git diff --name-only 2003ab3 5a8796b` reports exactly three files:

1. `src/registry/fleet-scheduler.mjs` (+55 / -24 net; cancellation, snapshot isolation, capability fail-closed, dispatch AbortSignal)
2. `test/v07-stage1-fleet-scheduler.test.mjs` (+108 / -12; 2 new tests, cancellation test hardened)
3. `docs/review/2026-09-26-v07-stage1-gate-1-2003ab3.md` (prior review record, added)

Reviewed against RFC-0014 (`docs/rfc/0014-fleet-workflows-and-scheduling.md`), the v0.7 multistage SOP (`docs/sop/v0.7-fleet-workflows-multistage-sop.md`), the M28 acceptance matrix (`scripts/v07-fleet-acceptance-matrix.mjs`), and reused frozen dependencies (`src/registry/registry.mjs` `getNodeRow`/`listNodes`/`toNodeSummary`, `src/registry/flow-tracker.mjs` `validateTargetScope`, `src/registry/crypto.mjs` `randomHex`).

Re-review focus (the 5 items requested): cancellation race + summary invariant, `getJob` deep isolation, capability fail-closed, dispatch timeout/cancel AbortSignal propagation, and test completeness.

---

## Prior Findings — Re-verification

All five findings from `2026-09-26-v07-stage1-gate-1-2003ab3.md` were independently re-tested and are **fixed**:

### [P1] Cancellation race / summary invariant — FIXED

`src/registry/fleet-scheduler.mjs:349-406`, `:548-566`

- `cancelJob` now aborts, sets terminal `status:"failed"`, `finishedAt`, and marks every `pending`/`running` node `failed` with `job-cancelled` (`:554-564`), returning `false` for already-terminal jobs (`:551-553`).
- `dispatchNext` re-checks `job._abortController.signal.aborted || nodeTask.status === "failed"` after `await dispatchWithTimeout(...)` (`:370-373`), in the `catch` (`:396-398`), and before starting a task (`:354-356`). The post-`await` guard and the summary increments run in one synchronous block with no intervening `await`, so `cancelJob` cannot interleave between the check and the count — the resurrection/double-count race is genuinely closed.
- Step C (`:421-430`) forces `failed` when aborted, and the accounting guard now sets `status="failed"` before throwing (`:441`, `:447`).

Independent reproduction (60-iteration cancel sweep, multi-node, pool=1, timeout-then-cancel, skip+`cancel`, unreachable+`cancel`): **0 invariant violations**, cancelled nodes never resurrect to `completed`, `completed` never double-counts. Cases exercised: 3-node cancel with 1 already completed → `{totalTargets:3, completed:1, failed:2}`, `status:"failed"`, invariant holds; pool=1 with 2 queued → all 3 `failed`; timeout-then-cancel → `{timeout:1, failed:2}`, `status:"failed"`, invariant holds.

### [P2] `getJob` snapshot deep isolation — FIXED (with a new side effect, see Finding 1)

`src/registry/fleet-scheduler.mjs:237-254` now uses `structuredClone` for `payload`, `targetSpec`, and `results`. Independent reproduction confirms caller mutations to nested `snap.payload.nested.*`, `snap.targetSpec.nodeIds`, and `snap.results[A].*` no longer reach internal state; the dedicated test `snapshots are deep clones and mutate-isolated` passes.

### [P2] Capability filter fail-closed — FIXED

`src/registry/fleet-scheduler.mjs:296-341`. `isEligible` now initializes to `false`; the registry-missing / `getNodeRow`-missing branch (`:325-329`) fails closed with `capability-evidence-stale`; a `null` row fails closed with `target-not-found` (`:302-304`); stale evidence (`:305-307`) and parse failure (`:320-323`) remain fail-closed. Independently verified:

- registry exposing only `listNodes`, `getNodeRow` returns `null`, `requiredCapabilities:["audit"]` → node **not** dispatched, `status:"failed"`, `skipped:1`, `reason:"target-not-found"`.
- registry exposing only `listNodes` (no `getNodeRow`) → node **not** dispatched, `skipped:1`, `reason:"capability-evidence-stale"`.
- registry absent + `requiredCapabilities` + explicit targets → rejected at `submitJob` validation (`target-not-found`), fail-closed.

No unverified-capability dispatch path remains.

### [P2] Dispatch timeout / cancel AbortSignal — FIXED

`src/registry/fleet-scheduler.mjs:457-497`. `dispatchWithTimeout` creates a per-task `AbortController` (`:458`), links it to the job controller via `onJobAbort` (`:459-467`), aborts it on timeout (`:472`), passes `signal` into `dispatchTransport` (`:487`) and `defaultDispatch` (`:489`, signature `:502`), and removes the listener in `finally` (`:495`). A transport that listens for `abort` now observes it on both timeout and cancellation (test asserts `transportSignalAborted === true`; independently reproduced for reject-on-abort transports with no unhandled rejections).

### [P3] Cancellation test completeness — FIXED

`test/v07-stage1-fleet-scheduler.test.mjs:382-440` now awaits `_executionPromise`, asserts the settled terminal status, node status, `summary` counts, transport signal abort, and the accounting invariant. New dedicated tests cover snapshot isolation (`:442-467`) and capability fail-closed on a missing row (`:469-501`).

---

## Findings

### [P2] `getJob` now throws `DataCloneError` on non-cloneable payloads — `submitJob` is non-atomic (dispatches, then throws) and `listJobs()` is permanently poisoned

`src/registry/fleet-scheduler.mjs:243-252` (called from `submitJob` `:227` and `listJobs` `:263`)

Replacing the shallow spreads with `structuredClone` introduced a new, deterministic throw path. `structuredClone` throws `DataCloneError` for any value containing a function, symbol, `WeakMap`/`WeakSet`, or other non-cloneable object. Because `submitJob` builds and **starts executing** the job (`:222` `this.jobs.set(...)`, `:225` `this.executeJob(...)`) *before* it returns `this.getJob(finalJobId)` (`:227`), a non-cloneable payload causes `submitJob` to throw **after** the job was registered and dispatched to nodes. Reproduced against the committed HEAD:

```
GHOST: submitThrew= DataCloneError: ()=>{} could not be cloned.
GHOST: jobsRegistered= 1 | nodesExecuted= [node_0123..., node_fedcb...]
GHOST: listJobs()= THROWS DataCloneError
GHOST: internal status= completed summary= {"totalTargets":2,"completed":2,...}
```

And the retained-reference variant (a job submitted successfully, then the caller mutates a nested object it still holds):

```
post-submit poison -> getJob: DataCloneError | listJobs: DataCloneError
```

The same defect class applies to `results` (`:252`): a custom `dispatchTransport` returning a non-cloneable value in `error`/`stdout` makes every subsequent `getJob`/`listJobs` throw.

Impact, threefold:

1. **Ghost job / non-atomic `submitJob`**: the caller receives an exception and never learns the `jobId`, yet the task has already been dispatched to production nodes — an operator-visible side effect with no returned handle, and the job is unreachable from the caller's perspective (audit/accountability gap, RFC-0014 D5).
2. **Shared observability poison pill**: `listJobs()` maps over *all* jobs (`:262-263`), so a single job with a non-cloneable payload makes the entire fleet job listing throw permanently — a Stage 2 `GET /hub/fleet/jobs` handler backed by `listJobs()` would 500 for every request (M28 field 1 `fleetJobListObservability`).
3. **Regression**: the pre-fix shallow spread never threw. Confirmed by running the identical scenario against `git show 2003ab3:src/registry/fleet-scheduler.mjs` → `submitThrew= null | listJobs= ok`.

Trigger: any `submitJob` whose `payload` (or a transport-returned `results` field) contains a non-cloneable value. Reachability is bounded: RFC-0014 D3.2 constrains the wire payload to JSON, and Stage 2 will `JSON.parse` the request body, so an HTTP-sourced payload is always cloneable. The defect is therefore reachable through the in-process API (other Hub modules, tests) rather than the wire — but the scheduler validates nothing about cloneability and fails inconsistently (side effects committed before the throw), which is why it is recorded as P2 rather than P3. If the team formally codifies "payload MUST be JSON-serializable" and enforces it at validation, this can be revisited.

Minimal fix direction (any one): validate payload JSON-serializability in `submitJob` step 4 (`:180-184`) and reject with `invalid-payload` before registering/dispatching; and/or make `getJob` clone defensively (try/catch fallback, or clone-on-ingest so `submitJob` snapshots cannot throw). Either way, `submitJob` must not commit side effects before the operation that can throw.

### [P3] Fail-closed test covers only the missing-row branch, not the missing-`getNodeRow` / missing-registry branches

`test/v07-stage1-fleet-scheduler.test.mjs:469-501`

The new fail-closed test constructs a registry that exposes `getNodeRow` returning `null` (`reason:"target-not-found"`). The other two fail-closed branches fixed by this commit are untested: a registry with **no** `getNodeRow` function (`:325-329`, `reason:"capability-evidence-stale"`) and a scheduler with no registry at all. Both were verified manually (see above) and behave correctly, but the regression guard is incomplete for the exact branches the prior P2 named.

---

## Verification

Executed in `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate` (branch `chore/v0.7-stage1-fleet-scheduler`, Node v25.9.0):

- `git rev-parse HEAD` → `5a8796b45c803dac09e44b19d70a8415b06a4a3a`; `git status --porcelain` → empty; `git rev-list --left-right --count HEAD...@{u}` → `0 0`; `git merge-base --is-ancestor 2003ab3 HEAD` → true. Confirmed.
- `git diff --name-only 2003ab3 5a8796b` → exactly the three declared files. `git diff --name-only cabeea1 5a8796b -- package.json package-lock.json` → empty (no new dependency).
- `git diff --check 2003ab3 5a8796b` → clean (exit 0); `git diff --check 5a8796b` → clean (exit 0).
- `node scripts/check-public-tree.mjs` → "Public-tree validation passed."
- `node --test test/v07-stage1-fleet-scheduler.test.mjs` → 11 tests, 11 pass, 0 fail.
- `npm run check` → **556 tests, 550 pass, 0 fail, 6 skipped** (matches the claimed figure). The 6 skipped are pre-existing environment-gated suites (`DSH_ACCEPTANCE_ROOT` etc.), unrelated to this diff.
- Independent behavioural reproduction (read-only, absolute-path ESM scripts): cancellation sweep over 60 iterations across multi-node / pool=1 / timeout-then-cancel / skip-then-cancel / unreachable-then-cancel topologies → 0 invariant violations, 0 resurrections, 0 double-counts, 0 unhandled rejections; snapshot deep-isolation mutation; capability fail-closed across all three branches; abort propagation for signal-honouring transports; and the new `DataCloneError` regression (Finding 1) confirmed against both HEAD and the pre-fix `2003ab3` source.

Not verified (out of Stage 1 scope; no code exists yet): real direct/reverse transport dispatch, `ORBIT-ROUTE-V1` auth, reverse `mode:"task"` framing, SQLite audit emission, Hub endpoints, UI. M28 fields requiring mounted evidence (12-24, 26, 27) cannot be exercised at this stage; field 26 remains `mounted` and is asserted by an in-process test only.

---

## Residual Risks

- **Finding 1 fix may be judged unnecessary** if the team treats `payload` as guaranteed JSON by construction; the current code neither documents nor enforces that guarantee, so the ghost-job/`listJobs` poison remains reachable through the in-process API.
- `defaultDispatch` is still a stub returning `completed` for both routes; the newly wired `signal` is accepted but not yet honoured by a real transport, so timeout/cancel channel-abort semantics (RFC-0014 D3.4) remain a Stage 2/4 concern.
- The M28 automated fields are asserted PASS unconditionally by `generateM28AutomatedQualificationMatrix()` with no binding to executed test results (accepted v0.6 M24 prior art); unchanged by this commit, still a Stage 5 evidence-honesty dependency.
- Duplicate-`jobId` submission is resolved before `taskType`/`targetSpec` validation, so a conflicting re-submission with the same `jobId` silently returns the original job rather than signalling a mismatch (consistent with documented idempotency intent; not raised as a finding).
- The 6 skipped full-suite tests were not individually enumerated; they are pre-existing and unrelated to this diff.

---

## Gate

**FAIL (REVISE)**

Rationale: the five prior findings (1x P1, 3x P2, 1x P3) are all independently verified fixed and the D4 accounting invariant now holds under every cancellation topology exercised. However, the `structuredClone`-based snapshot fix introduces a **new P2 regression** (Finding 1): `submitJob` commits registration and dispatch side effects before a `getJob` snapshot that can throw `DataCloneError`, producing a ghost job that executed on nodes but was never returned to the caller, and `listJobs()` becomes permanently unusable for all jobs once any job holds a non-cloneable payload. Per the SOP Stop-Work matrix ("Non-zero P0, P1, or P2 finding | Blocker | Fix, re-test, re-review until PASS"), the P0/P1/P2 = 0 condition is not met, so PASS cannot be granted. One P3 test gap (missing-`getNodeRow` branch) is additionally recorded.

Required action: make `submitJob` atomic with respect to snapshot cloning (validate payload serializability at validation time and/or clone defensively so `getJob` cannot throw), add a regression test for a non-cloneable payload, extend the fail-closed test to the missing-`getNodeRow` branch, then re-review.

---

## Review Report

`D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate\docs\review\2026-09-26-v07-stage1-gate-1-rereview-5a8796b.md`
