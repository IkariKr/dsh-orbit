# v0.7 Stage 1 Gate 1 Independent Code Re-Review (2nd Re-Review)

- Scope: `chore/v0.7-stage1-fleet-scheduler`, HEAD `dffa83e8afab4c27d0c2292bbf5504548dfe8c1d` (`dffa83e`)
- Reviewed fix commit: `dffa83e` ("fix(fleet): enforce JSON payload validation upfront and safe cloning in getJob")
- Prior review: `docs/review/2026-09-26-v07-stage1-gate-1-rereview-5a8796b.md` (verdict FAIL (REVISE); 1x P2 payload non-cloneable ghost-task / `listJobs` poison, 1x P3 fail-closed test gap)
- Reviewer: independent code review (`@code-reviewer2`)
- Verdict: **PASS** — both prior findings verified fixed; no P0/P1/P2 introduced; 2x P3 non-blocking notes recorded.

---

## Review Scope

Independent Gate 1 second re-review of the Stage 1 fix commit `dffa83e` on branch `chore/v0.7-stage1-fleet-scheduler`. `git diff --name-only 5a8796b dffa83e` reports exactly three files:

1. `src/registry/fleet-scheduler.mjs` (+69 / -7; new `assertValidJsonPayload` / `safeClone`, atomic payload + targetSpec cloning in `submitJob`, defensive cloning in `getJob`)
2. `test/v07-stage1-fleet-scheduler.test.mjs` (+77; non-serializable-payload regression test, missing-`getNodeRow`/null-registry fail-closed test)
3. `docs/review/2026-09-26-v07-stage1-gate-1-rereview-5a8796b.md` (prior review record, added)

Reviewed against RFC-0014 (`docs/rfc/0014-fleet-workflows-and-scheduling.md`), the v0.7 multistage SOP (`docs/sop/v0.7-fleet-workflows-multistage-sop.md`), the M28 acceptance matrix (`scripts/v07-fleet-acceptance-matrix.mjs`), and reused frozen dependencies (`src/registry/registry.mjs`, `src/registry/flow-tracker.mjs` `validateTargetScope`, `src/registry/crypto.mjs` `randomHex`).

Re-review focus (as requested): (1) atomic, side-effect-free payload validation with `invalid-payload` on functions/Symbols/circular references, no ghost tasks, no `listJobs()` poisoning, `safeClone` in `getJob`; (2) complete fail-closed test coverage for the three branches; (3) full functional/regression safety of Stage 1.

---

## Prior Findings — Re-verification

### [P2] Non-cloneable payload ghost task / `listJobs()` poison — FIXED

`src/registry/fleet-scheduler.mjs:41-70`, `:210-239`, `:277-282`, `:298-307`

- `submitJob` now performs `assertValidJsonPayload(payload)` + `JSON.parse(JSON.stringify(payload))` (`:217-230`) and `JSON.parse(JSON.stringify(targetSpec))` (`:232-239`) **before** `this.jobs.set(...)` (`:277`), `executeJob(...)` (`:280`), and the returning `getJob` (`:282`). Any throw occurs before any registration or dispatch side effect.
- `getJob` now uses `safeClone` (structuredClone with a `JSON` round-trip fallback, then a `{}` fallback) for `payload`, `targetSpec`, and `results` (`:298-299`, `:307`), so snapshot creation can no longer throw.

Independent reproduction against HEAD `dffa83e`:

```
payload-case threw= invalid-payload: ... property "fn" cannot be a function or symbol | jobs.size= 0 | listJobs.len= 0
payload-case threw= invalid-payload: ... property "sym" cannot be a function or symbol | jobs.size= 0 | listJobs.len= 0
payload-case threw= invalid-payload: ... payload exceeds maximum nesting depth    | jobs.size= 0 | listJobs.len= 0
nodesExecuted= []
```

- **Atomicity**: after 3 consecutive non-serializable submissions (function / Symbol / circular), `jobs.size=0`, `executed=0`, `listJobs()=[]`. No ghost job, no dispatch, no poison.
- **No poison**: `listJobs()` remains healthy (`len=0`) after all rejected submissions, and after a valid job whose caller-retained nested object is mutated post-submit (`post-mutate getJob ok payload={"nested":{"count":1}}`; `listJobs len=1`).
- **results path**: a `dispatchTransport` returning a non-cloneable `stdout` (`{weird:()=>{}}`) no longer poisons `getJob`/`listJobs` (`results-poison getJob ok`, `listJobs len=1`); the JSON fallback preserves the cloneable remainder (`stdout={"keep":"value"}`).
- **Duplicate jobId**: a bad-payload re-submission with an existing `jobId` still short-circuits at the idempotency check (`:190-192`) and returns the original job without throwing (`DUP: returned jobId=... threw= null jobs.size=1`) — consistent with documented idempotency.

The pre-fix regression (`2003ab3`/`5a8796b` shallow spread + raw `structuredClone`) is closed.

### [P3] Fail-closed test gap (missing `getNodeRow` / null registry) — FIXED

`test/v07-stage1-fleet-scheduler.test.mjs:538-578` adds a test exercising both previously-untested branches: registry lacking `getNodeRow` (Case A, `reason:"capability-evidence-stale"`) and `registry: null` (Case B, `reason:"capability-evidence-stale"`), each asserting `summary.skipped===1`, node `status:"skipped"`, and the reason code. Combined with the existing missing-row test (`:469-501`, `reason:"target-not-found"`), all three fail-closed branches named by the prior review now have automated regression guards.

Independently re-verified all six eligibility outcomes (`dispatched=false` in every case):

| Branch | reason |
| --- | --- |
| `getNodeRow` returns `null` | `target-not-found` |
| registry lacks `getNodeRow` | `capability-evidence-stale` |
| `registry: null` | `capability-evidence-stale` |
| `capabilities_stale === 1` | `capability-evidence-stale` |
| malformed `capabilities` JSON | `lacks-capability` |
| node lacks required capability | `lacks-capability` |

No unverified-capability dispatch path remains.

---

## Findings

### [P3] `safeClone`'s `{}` fallback can silently drop all `results` keys when a transport returns a circular non-cloneable value

`src/registry/fleet-scheduler.mjs:59-70`, `:307`

`safeClone` falls back to `{}` only when **both** `structuredClone` and `JSON.stringify` fail (i.e. a value that is simultaneously circular and non-cloneable, such as `{self:<self>, fn:()=>{}}`). In that case `getJob().results` degrades to `{}` while the internal `results` and `summary` stay intact and consistent — reproduced: `snapshot.results keys=0` vs `summary.totalTargets=2`, `internal.results keys=2`. Internal state and the D4 accounting invariant are unaffected, and `listJobs()` stays healthy.

Impact/reachability: bounded to a non-JSON-returning transport. RFC-0014 D3.2/D3.3 constrain node responses to JSON (`{status, exitCode, stdout, stderr, durationMs}`), so a real direct/reverse transport cannot produce a circular value; the degradation is reachable only through an in-process misuse of `dispatchTransport`. It is a snapshot-fidelity degradation, not corruption or a throw. No blocking action required; noted for Stage 2 to consider rejecting non-JSON transport results at the transport boundary rather than silently degrading the snapshot.

### [P3] Payload validation is stricter than documented JSON semantics for `Map`/`Set`/symbol-keyed values and imposes an undocumented depth cap

`src/registry/fleet-scheduler.mjs:41-57`, `:217-230`

`assertValidJsonPayload` rejects functions and symbols but not `Map`/`Set`/symbol-keyed properties, which then pass `JSON.parse(JSON.stringify(...))` and are silently coerced to `{}` (`payload: new Map([["a",1]])` → accepted `payload={}`). Separately, `assertValidJsonPayload` rejects any structure deeper than 64 levels with `code:"invalid-payload"` (verified: depth 64 accepted, depth 65 rejected), which is not stated in RFC-0014 (which bounds payloads by size, 1 MiB / 32 KiB, not depth).

Impact/reachability: both are fail-safe (data reduction / rejection, never corruption, never a ghost task) and unreachable from the JSON wire path; they affect only in-process callers passing non-JSON values. Neither the RFC nor the Stage 1 SOP mandates `Map`/`Set` rejection, so this is a documentation-vs-behavior nuance rather than a defect. Suggested (non-blocking): state the JSON-only contract and the depth cap in the `submitJob` doc comment, and/or reject `Map`/`Set` explicitly if silent coercion is undesirable.

No P0/P1/P2 findings. The two P3 notes above are the only items recorded.

---

## Verification

Executed in `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate` (branch `chore/v0.7-stage1-fleet-scheduler`, Node v25.9.0):

- `git rev-parse HEAD` → `dffa83e8afab4c27d0c2292bbf5504548dfe8c1d`; `git status --porcelain` → empty; `git rev-list --left-right --count HEAD...@{u}` → `0 0`; `git merge-base --is-ancestor 5a8796b HEAD` → true; `git merge-base --is-ancestor 2003ab3 HEAD` → true.
- `git diff --name-only 5a8796b dffa83e` → exactly the three declared files; `git diff --name-only cabeea1 dffa83e -- package.json package-lock.json` → empty (no new dependency).
- `git diff --check 5a8796b dffa83e` → clean (exit 0); `git diff --check` (worktree) → clean (exit 0).
- `node scripts/check-public-tree.mjs` → "Public-tree validation passed." (exit 0).
- `node --test test/v07-stage1-fleet-scheduler.test.mjs` → **13 tests, 13 pass, 0 fail** (was 11; +2 new tests).
- `npm run check` → **558 tests, 552 pass, 0 fail, 6 skipped** (matches the claimed figure). The 6 skipped are pre-existing environment-gated suites unrelated to this diff.
- Independent read-only ESM reproductions (absolute-path scripts under the temp dir, importing the committed module):
  - Atomicity / anti-poison: function, Symbol, circular, deep-function payloads → all `invalid-payload`, `jobs.size=0`, `executed=0`, `listJobs()=[]`; retained-reference post-submit mutation does not poison `getJob`/`listJobs`; non-cloneable transport `results` no longer poison.
  - Fail-closed: all six eligibility branches return `dispatched=false` with the expected reason codes (table above).
  - Cancellation invariant sweep: 60 iterations across multi-node / pool=1 / timeout-then-cancel / reject-then-cancel / timeout-result topologies → `violations=0`, non-terminal residual=0, total mismatch=0, unhandled rejections=0.
  - Boundary/coercion probe: depth 64 accepted vs 65 rejected; `Map`/`Set`/symbol-keyed coercion; `safeClone` double-failure degradation (Finding 1).

Not verified (out of Stage 1 scope; no code exists yet): real direct/reverse transport dispatch, `ORBIT-ROUTE-V1` auth, reverse `mode:"task"` framing, SQLite audit emission, Hub endpoints, UI. M28 fields requiring mounted evidence (12-24, 26, 27) cannot be exercised at this stage; field 26 remains asserted by an in-process test only.

---

## Residual Risks

- `safeClone`'s `{}` fallback can drop `results` keys in a `getJob` snapshot if a transport returns a circular non-cloneable value (Finding 1); internal state and the D4 invariant are unaffected, and real JSON transports cannot trigger it. Stage 2 should consider validating transport results at the boundary.
- `requiredCapabilities` is still shallow-copied in `getJob` (`:300`) and is not type-validated; a caller passing object entries leaks nested mutations into internal state and the entries never match (`hasAll` compares by identity), causing a fail-closed skip rather than a crash. By contract `requiredCapabilities` is a string array, so this is in-process misuse only.
- `defaultDispatch` remains a stub returning `completed` for both routes; the wired `signal` is accepted but not yet honoured by a real transport, so timeout/cancel channel-abort semantics (RFC-0014 D3.4) remain a Stage 2/4 concern.
- The M28 automated fields are asserted PASS unconditionally by `generateM28AutomatedQualificationMatrix()` with no binding to executed test results (accepted v0.6 M24 prior art); unchanged by this commit, still a Stage 5 evidence-honesty dependency.
- The 6 skipped full-suite tests were not individually enumerated; they are pre-existing and unrelated to this diff.

---

## Gate

**PASS**

Rationale: both prior findings are independently verified fixed. The P2 ghost-task/`listJobs` poison is closed — payload validation and JSON cloning are performed atomically before any job registration or dispatch, non-JSON values (function / Symbol / circular) raise `code:"invalid-payload"` with `jobs.size` unchanged and `listJobs()` unpoisoned, and `getJob` uses `safeClone` so snapshot creation cannot throw `DataCloneError`. The P3 fail-closed test gap is closed — all three branches (`getNodeRow` returns null, registry lacks `getNodeRow`, registry null) now have automated assertions, independently confirmed. Full functional/regression scope (target validation + wildcard rejection, capability-aware scheduling + stale filtering, complete results aggregation + D4 accounting invariant, single-node timeout containment + cancel AbortSignal propagation) holds; `npm run check` reports 558/552/0/6, `check-public-tree` passes, and `git diff --check` is clean. No P0/P1/P2 findings were found, so per the SOP Stop-Work matrix the PASS condition is met. Two P3 non-blocking notes are recorded (snapshot-fidelity degradation under a circular non-JSON transport result; JSON-semantics/depth-cap documentation nuance).

---

## Review Report

`D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate\docs\review\2026-09-26-v07-stage1-gate-1-rereview-dffa83e.md`
