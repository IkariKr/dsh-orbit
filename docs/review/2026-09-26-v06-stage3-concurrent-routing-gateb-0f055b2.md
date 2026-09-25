# Review Report — v0.6 Stage 3 (Concurrent Routing & Resource Partitioning) — Gate B

- Date: 2026-09-26
- Reviewer: independent code/architecture review (@code-reviewer, Gate B)
- Workspace: `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate`
- Branch: `chore/v0.6-stage3-concurrent-routing`
- Reviewed commit (HEAD): `0f055b2` — "feat(routing): implement multi-node concurrent routing, resource partitioning, and failure isolation (Stage 3)"
- Baseline (Stage 2 Gate 2 PASS): `3ef4f7f` (confirmed ancestor of `0f055b2`)
- Authorization lineage: `6748495` (V06-CONSTRUCTION-20260925-A1) confirmed ancestor of `0f055b2`
- Verdict: **PASS WITH NON-BLOCKING FINDINGS** (SOP vocabulary: PASS / REVISE / BLOCK → **PASS**)

---

## Review Scope

### Changed files (diff `3ef4f7f..0f055b2`)

| File | Δ | Nature |
| --- | --- | --- |
| `src/registry/reverse-channel.mjs` | +3 | destroy browser socket in `onBrowserClose` |
| `src/registry/server.mjs` | +14/-2 | duck-typed `reverseChannels` option; `end`/`error` listeners + single-shot guard for WS flow end |
| `test/v06-stage3-concurrent-routing.test.mjs` | +587 (new) | 5 end-to-end integration tests |

### Contract surfaces examined

1. **RFC-0013 D1 / D4** — deterministic route authority isolation; per-node reverse channel pool partitioning (`this.channels`, `this.idleWaiters` are `nodeId -> Set`).
2. **RFC-0013 D5** — failure independence / zero cross-node failover, strict fail-closed (502/503).
3. **SOP `docs/sop/v0.6-multi-node-sessions-multistage-sop.md`** §3 Stage 3 (Gate B) and §5 stop-work matrix.
4. **RFC-0013 M24 matrix** rows relevant to Stage 3: #4–#9 (mounted concurrency), #16 (`reverseChannelPoolIndependence`), #18 (`noSilentCrossNodeFailover`), #20 (`multiNodeFlowTrackerAccurate`).

### Method

Read the real diff, both production files in full context (`reverse-channel.mjs` `executeReverseHttp` / `executeReverseWebSocket`, `server.mjs` upgrade pipeline and management read model), `route-proxy.mjs` routing/eligibility, `flow-tracker.mjs`, and the new test file. Ran the focused suite, the full suite, a hygiene check, a 25× stability loop, and independent revert experiments in throwaway copies to determine which changed lines are load-bearing.

---

## Findings

Findings are non-blocking. No P0/P1 was found. No cross-node failover, cross-node channel sharing, or fail-open path was identified.

### [P2] `options.reverseChannels: null` now throws at Hub construction instead of falling back to defaults

`src/registry/server.mjs:911`

```js
const reverseChannels =
  options.reverseChannels && typeof options.reverseChannels.hasChannelForSession === "function"
    ? options.reverseChannels
    : new ReverseChannelManager(options.reverseChannels);
```

- **Trigger**: `createHubServer({ registry, options: { reverseChannels: null } })`.
- **Before**: `options.reverseChannels ?? new ReverseChannelManager()` — `null` was nullish, so a default manager was constructed. Valid, silent fallback.
- **Now**: `null && ...` is falsy → the else branch runs `new ReverseChannelManager(null)` → constructor destructuring throws `TypeError: Cannot read properties of null (reading 'limits')`. Verified empirically.
- **Impact**: an explicit `null` (e.g. a JSON config field serialized as `null`, or an embedder that normalizes "unset" to `null`) now aborts Hub startup with an opaque `TypeError` instead of using defaults. `undefined` still falls back correctly.
- **Minimal fix**: normalize first, e.g. `const rc = options.reverseChannels ?? null; const reverseChannels = rc && typeof rc.hasChannelForSession === "function" ? rc : new ReverseChannelManager(rc ?? undefined);` (or `rc || undefined`).

### [P2] A duck-typed injected manager that lacks `hasChannelForSession` is silently discarded and replaced

`src/registry/server.mjs:911-914`

- **Trigger**: pass a manager-like object that implements the pool API but not `hasChannelForSession`, e.g. `{ idleTarget, maxChannels, idleChannels(), busyCount(), closeChannelsForNode(), ... }`.
- **Observed**: the object is not used (`hub.reverseChannels === injected` → `false`); a fresh default `ReverseChannelManager` is returned, and the injected object is instead passed as the *config* argument. The injected dependency disappears with no error or log.
- **Impact**: this is exactly the "duck-typed mock object" seam the change is meant to support. A mock/pool that omits one method is not rejected loudly — it is substituted, so a test or embedder can silently run against a different pool than intended (e.g. one with default bounds instead of the injected constraints), masking a broken/constrained pool. The one in-repo mock that exercises this path (`test/v05-stage6-management-observability.test.mjs:139`) happens to define the method, so no current test detects the substitution.
- **Minimal fix**: make the option single-purpose. Either accept only config (`new ReverseChannelManager(options.reverseChannels ?? {})`) and move instance injection to a separate `reverseChannelsInstance` option, or validate the injected object and throw a clear error when it is present but not a usable manager.

### [P3] The two production changes are not covered by any test (verified by independent revert)

- Reverting the `wsFlowEnded` single-shot guard + `socket.on("end"/"error")` listeners back to the baseline `socket.on("close", endWsFlow)` (`server.mjs`), then running the **full** suite: `# tests 533 / # pass 527 / # fail 0 / # skipped 6`.
- Reverting the new `onBrowserClose` `socket.destroy()` (`reverse-channel.mjs`), then running the full suite: `# tests 533 / # pass 527 / # fail 0 / # skipped 6`.

Both production edits therefore pass with or without the change; the Stage 3 suite's "flow count returns to zero" assertions pass on the baseline source too. The edits are defensively reasonable (`endWsFlow` is already idempotent via `MultiNodeFlowTracker`'s idempotent closure, and a TCP socket always emits `close` after `end`/`error`), so this is a coverage gap rather than a defect: no regression is guarded, and the stated "杜绝 WebSocket 活跃流计数漂移泄漏" claim is not demonstrated by an executable test. A test that drives an `end`-without-immediate-`close` path (or asserts single invocation of the end callback) would close the gap.

### [P3] Untracked residue `test/zz-probe-multiframe.mjs` left in the reviewed worktree

- File is untracked (`?? test/zz-probe-multiframe.mjs`), 86 lines, a debug probe that `console.log`s frame-size results and runs a top-level `await setup()`.
- **Impact**: it is auto-discovered and executed by the default `node --test` / `npm test` glob — it appeared as `ok 87 - test\zz-probe-multiframe.mjs` in the full run. It adds an un-reviewed artifact to the test tree and violates the SOP §5 stop-work rule "Hygiene/residue remaining after run → clean completely before review".
- **Minimal fix**: delete the file (or move it out of `test/`).

---

## Verification

All checks below were executed in this review.

| Check | Command | Result |
| --- | --- | --- |
| Focused Stage 3 suite | `node --test test/v06-stage3-concurrent-routing.test.mjs` | 5 tests, 5 pass, 0 fail |
| Stage 3 stability | 25 consecutive runs of the focused suite | 0 failing runs (0/25) |
| Full suite (regression) | `node --test --test-reporter=tap` | 533 tests, 527 pass, 0 fail, 6 skipped |
| Hygiene | `node scripts/check-public-tree.mjs` | passed |
| Whitespace | `git diff --check 3ef4f7f..0f055b2` | clean (exit 0) |
| Ancestry | `git merge-base --is-ancestor` for `3ef4f7f` and `6748495` vs `0f055b2` | both OK |
| Load-bearing analysis (WS flow end) | revert `wsFlowEnded`/`end`/`error` in a throwaway copy → full suite | 527 pass / 0 fail (change not detected) |
| Load-bearing analysis (browser close) | revert `onBrowserClose` destroy in a throwaway copy → full suite | 527 pass / 0 fail (change not detected) |
| Baseline sanity | revert both source files to `3ef4f7f` → focused suite | 5/5 fail (`reverseChannels.registerChannel is not a function`) — confirms the new tests genuinely depend on the Stage 3 wiring |
| Duck-typing / null probes | direct `createHubServer` invocation with `reverseChannels: null` and with a manager-like object | reproduced the two P2 findings |

Additional design verification (read, not merely asserted):

- **Per-node partitioning holds**: `ReverseChannelManager.channels` and `idleWaiters` are keyed strictly by `nodeId` (`reverse-channel.mjs:551-552`); `claimIdleChannel`/`acquireChannel`/`idleChannels`/`busyCount`/`registerChannel`/`closeChannelsForNode` all resolve the set for one `nodeId` only. `closeChannelsForSession` iterates all node sets but filters by the (node-unique) `sessionId`, so it cannot touch a peer node's live channels.
- **No cross-node failover**: transport is frozen per flow by `evaluateRouteEligibility` into `snapshot.routeMode`; the upgrade/HTTP handlers dispatch to exactly one of `proxyReverse*` / `proxy*` for `snapshot.nodeId`. There is no fallback branch from a failed direct node to a reverse peer or vice versa. Reverse ineligibility (`reverse-session-offline`, `reverse-route-unreachable`, `reverse-capacity`) returns 503, not a redirect.
- **Fail-closed preserved**: capacity exhaustion throws `ReverseCapacityError` (`code: "reverse-capacity"`) → 503 in `proxyReverseHttpRequest` / `proxyReverseWebSocketUpgrade`; the Stage 3 saturation test asserts Node B 503 while Node A stays 200.
- **Byte integrity**: the untracked probe and the Stage 3 test both confirm byte-exact transfer across 1 B … 600 KB with independent SHA-256 per node.

Not executed / not claimed: any mounted two-node live run, container crash/restart drills, cookie-jar isolation, or cross-node route-proof replay (these are Stage 4/Gate 3 and Stage 6 mounted fields per the SOP).

---

## Residual Risks

- The M24 rows the new test names (#4–#9) are classified **mounted** in RFC-0013. The Stage 3 suite is an in-process integration substitute, not mounted evidence; the mounted fields remain NOT_EXECUTED and must be re-run at Stage 6. (Not a Stage 3 defect — noting the boundary so the automated PASS is not mistaken for mounted PASS.)
- `test/v06-stage3-concurrent-routing.test.mjs:484` asserts `elapsedA < 200` ms for Node A while Node B is saturated. This is a wall-clock assertion and is inherently load-sensitive on a busy CI host; it did not flake in 25 runs here, but it is the most probable future flake. A relative/ordering assertion would be more robust.
- Both production edits are functionally unverified by tests (Finding P3). Their correctness rests on read-only reasoning (`endWsFlow` idempotency; TCP always emitting `close`), not on an executable regression guard.
- Stage 3 does not exercise a **reverse-vs-reverse** pair or a reverse node whose control session is alive but whose channel pool is empty while a peer streams — the D4 isolation evidence is direct-vs-reverse only. The per-node keying makes a violation unlikely, but this combination is not covered.
- Reviewer process note (disclosure): while running revert experiments I copied the worktree to `%TEMP%`; those copies share the same `gitdir` pointer, and a `git checkout`/`git reset` executed inside one of them staged/cleared entries in the *reviewed* worktree's index. No file content was modified (`git diff HEAD` was empty throughout); the index was restored with `git reset` and the worktree is byte-identical to `0f055b2` apart from the pre-existing untracked probe. This did not affect any conclusion, but it is recorded for transparency.

---

## Gate

**PASS WITH NON-BLOCKING FINDINGS**

(SOP Gate B verdict mapping: **PASS** — no P0/P1; findings are P2/P3 and non-blocking.)

Rationale: the commit is a small, focused change that correctly implements the Stage 3 contract. All 5 new end-to-end tests pass and are stable (0/25 failures), the full 533-test suite passes with no regressions, per-node channel partitioning and fail-closed/no-failover routing hold on inspection, and the two production edits introduce no functional regression on any in-repo path. The findings are confined to the `options.reverseChannels` embedding seam (P2), an unverified-by-test coverage gap (P3), and worktree residue (P3). None of these block Gate B; the residue and the two P2s should be resolved before the Stage 5 candidate freeze.

---

## Review Report

Path: `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate\docs\review\2026-09-26-v06-stage3-concurrent-routing-gateb-0f055b2.md`
