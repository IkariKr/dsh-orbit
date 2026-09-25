# v0.7 Stage 0 Gate A Architecture Re-Review

- Scope: `chore/v0.7-stage0-rfc-sop`, HEAD `7a07777f8400ea54fb7e5506160f5d45d2c9c270`
- Supersedes / re-reviews: `52209c0` and `docs/review/2026-09-26-v07-stage0-gate-a-52209c0.md` (prior verdict REVISE: 1x P1, 2x P2, 3x P3)
- Baseline lineage: `6ef5c5118ddd69f580afd6c7e9d911de068d2f2a` (v0.6 closure), `7b0978bf8aba5257ee52cfe70b095b07f882f932` (v0.6 final review), `c75b2f46e09bee619531bc7275adf2b5e0724bfe` (`V07-CONSTRUCTION-20260926-A1`)
- Reviewer: independent architecture / contract review (`@code-reviewer2`)
- Verdict: **GO** (P0/P1/P2 = 0; 5x P3 non-blocking documentation-accuracy findings)

---

## Review Scope

Independent re-review of the v0.7 Stage 0 design package after commit `7a07777` ("resolve Gate A review findings for RFC-0014 transport and audit schema"). The commit changes exactly three files:

1. `docs/rfc/0014-fleet-workflows-and-scheduling.md` (modified, +139/-31)
2. `docs/sop/v0.7-fleet-workflows-multistage-sop.md` (modified, +3)
3. `docs/review/2026-09-26-v07-stage0-gate-a-52209c0.md` (new, the prior review record)

Focus, per the re-review request:

1. D3 dispatch transport: direct `POST /_orbit/task` endpoint, `ORBIT-ROUTE-V1` auth, never-forward-to-DSH; reverse control-channel closure preserved; reverse data-channel `mode: "task"` framing, `routeProof`, capacity wait, timeout abort, replay-cache — and the declared RFC-0012 amendment.
2. D5 audit table alignment (`audit` table, `registry.recordAudit`, `detail_json`).
3. D6 M28 split (13 automated / 15 mounted).
4. D2 wildcard-ordering and capability read-model consistency.
5. Node status vocabulary / summary reconciliation.
6. SOP Stop-Work matrix completeness.
7. Process constraints: RFC-first freeze (no `src/**`, `ui/**`, `bin/**`), governance tests, public-tree check, `npm run check`, `git diff --check`, ancestry, clean worktree.

No product code is present in this commit; this is a design/contract review.

---

## Findings

All findings are **P3** (real but limited impact). None blocks Gate A: each inaccuracy below is recoverable because the RFC explicitly cross-references the authoritative frozen source (RFC-0010 D5, RFC-0012 D5/D6/D7, or the actual code), and none changes a design decision. They should nevertheless be corrected before Stage 1 implementation, since Gate A freezes the transport contract that Stage 1-4 implement.

### [P3] D3.2 route-auth header list names a non-existent header and omits a required one

`docs/rfc/0014-fleet-workflows-and-scheduling.md:209`

D3.2 item 2 says the Hub transmits "standard route headers (`x-orbit-route-key-id`, `x-orbit-route-timestamp`, `x-orbit-route-nonce`, `x-orbit-route-signature`)". The frozen `ORBIT-ROUTE-V1` header set is `x-orbit-route-node`, `x-orbit-route-key`, `x-orbit-route-timestamp`, `x-orbit-route-nonce`, `x-orbit-route-signature` (`src/registry/protocol.mjs:29-35`, RFC-0010 D5). The listed name `x-orbit-route-key-id` does not exist (the real header is `x-orbit-route-key`), and `x-orbit-route-node` — the header that binds the Hub node identity and is required by `verifyRouteRequest` (`src/registry/route-auth.mjs:108-113`) — is omitted.

Impact: an implementer transcribing the header list literally emits `x-orbit-route-key-id` and omits `x-orbit-route-node`, which `verifyRouteRequest` rejects with HTTP 400 `bad-request` ("missing required ORBIT-ROUTE-V1 headers"). Trigger: Stage 1 direct-dispatch implementation taken from this sentence. Recoverable because the same sentence cites "the `ORBIT-ROUTE-V1` signature scheme (RFC-0010 D5)", whose header list is normative and correct. Fix: replace the four names with the exact RFC-0010 D5 set (five headers).

### [P3] D3.3 example frames are not verifiable as written (authority format, missing `routeProof.nodeId`, missing `headers`)

`docs/rfc/0014-fleet-workflows-and-scheduling.md:217`, `:228`, `:229-234`, `:220-242`

Three concrete inconsistencies between the new `mode: "task"` wire example and the frozen contract / code it depends on:

1. The example sets `"routeAuthority": "<nodeId>.orbit.internal"` (line 228). The deterministic authority is `n-<32hex>.<routeDomain>` (`computeRouteAuthority`, `src/registry/protocol.mjs:124-131`; RFC-0010 D1). The node compares the OPEN authority against `computeRouteAuthority(credentials.nodeId, this.routeDomain)` and aborts `authority-mismatch` on any other value (`src/node/reverse-channels.mjs:341-343`). D3.2 itself correctly writes `routeAuthority: computeRouteAuthority(nodeId, routeDomain)` (line 209), so the example contradicts D3.2 within the same RFC.
2. The example `routeProof` carries only `keyId/timestamp/nonce/signature` (lines 229-234), but the node verifier reads `open.routeProof?.nodeId` to populate `x-orbit-route-node` (`src/node/reverse-channels.mjs:354`); with the field absent, verification fails `bad-request`. (Note: RFC-0012 D6.1's own example has the same omission, so this mirrors prior art rather than introducing a new pattern.)
3. The example OPEN omits the `headers` ordered array required by RFC-0012 D6.1 and validated by the current node frame guard (`src/node/reverse-channels.mjs:313-320` rejects a non-array `headers` as `malformed-open` before the mode branch).

Impact: the literal frames as printed cannot authenticate. Trigger: Stage 1-4 implementing the reverse task frame verbatim. Recoverable via the cited RFC-0010 D5 / RFC-0012 D6.1. Fix: use the real authority form, include `routeProof.nodeId`, and state the `headers` representation (or explicitly document that `mode: "task"` frames are exempt from the `headers` guard).

### [P3] RFC-0012 amendment citation is inaccurate and RFC-0012 is not updated

`docs/rfc/0014-fleet-workflows-and-scheduling.md:216`, `:217`

D3.3 item 1 cites "the v0.5 deferral in RFC-0012 §11 ("Fleet commands/tasks and multi-node batch operations: defer to v0.7")". Neither the section nor the quote exists in RFC-0012:

- RFC-0012 has no numeric §11; its numbered sections are D1-D15, followed by "Explicit non-goals" and "Construction seams" (D11 is "Persistence, migration, restart, and backup").
- The string "defer to v0.7" does not appear anywhere in RFC-0012 (the phrase lives in the v0.6 SOP stop-work row and the v0.6 construction authorization). The actual controlling text is RFC-0012 "Explicit non-goals": "fleet commands/tasks;" and "remote shell/task execution over the control channel;" (`docs/rfc/0012-reverse-connected-nodes.md:778-779`).

Also, D3.3 item 2 cites the reverse control channel as `/api/v1/reverse-channel` (line 217); the real path is `/api/v1/reverse/control` (`src/registry/reverse-session.mjs:22`, RFC-0012 D4).

Impact: a reader/auditor following the citation finds no §11 and no such quote, weakening the lineage record for the amendment. Trigger: any audit of the RFC-0012 scope change. The substantive amendment intent is still clear and the underlying non-goal genuinely exists, so impact is limited. Fix: cite the "Explicit non-goals" section and the exact entries, correct the control-channel path, and (optionally) add a cross-reference note in RFC-0012 or in this RFC stating that RFC-0012's non-goal list is superseded for v0.7.

### [P3] Reverse task payload bound is unspecified and unreconciled with the 64 KiB OPEN frame

`docs/rfc/0014-fleet-workflows-and-scheduling.md:212`, `:220-242`

D3.2 bounds the direct-transport body to 1 MiB (HTTP 413 `payload-too-large`). D3.3 embeds the same `task.payload` inside the data-channel OPEN JSON but states no size bound. RFC-0012 D6.1 fixes OPEN JSON at 64 KiB and D7 bounds binary messages at 64 KiB (soft 512 KiB / hard 2 MiB per direction), matching the code (`maxMessageBytes: 64 * 1024`, `src/node/reverse-channels.mjs:263`; `CHANNEL_FRAME_MAX_BYTES = 64 * 1024`, `src/registry/reverse-channel.mjs:24`). A task payload near the 1 MiB direct limit therefore cannot be dispatched over the reverse channel, and no chunking or rejection code is defined for that case.

Impact: reverse-node tasks with payloads above ~64 KiB have undefined behavior; a single fleet job can succeed on a direct node and fail/abort on a reverse node for the same payload. Trigger: any reverse dispatch with a payload > ~64 KiB (e.g. field 19 `fleetJobLargeOutputAggregation` scenarios combined with large request payloads). Fix: state the reverse-transport payload bound (derived from the OPEN frame limit) and the failure code, or define payload chunking on the data channel.

### [P3] New error code `reverse-capacity-exhausted` diverges from the frozen `reverse-capacity`

`docs/rfc/0014-fleet-workflows-and-scheduling.md:219`

D3.3 names the pool-exhaustion failure `reverse-capacity-exhausted`. The frozen RFC-0012 D5 pool semantics and all existing code use `reverse-capacity` (`src/registry/reverse-channel.mjs:48,587`; `src/registry/route-proxy.mjs:200,486,489`; `src/registry/selector-view.mjs:18`). Introducing a second code for the same condition splits the error vocabulary across surfaces.

Impact: fleet dispatch and browser routing would report different codes for identical pool exhaustion, complicating operator diagnostics and test assertions. Trigger: Stage 2/4 asserting the code. Fix: reuse `reverse-capacity` or explicitly register the new code as a distinct fleet-only outcome.

---

## Verification

Actually executed in `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate`:

- `git status --porcelain` → empty (clean worktree); `git rev-parse HEAD` → `7a07777f8400ea54fb7e5506160f5d45d2c9c270`; branch `chore/v0.7-stage0-rfc-sop`; `git rev-list --left-right --count HEAD...@{u}` → `0 0`. Confirmed.
- `git show --name-only 7a07777` → only `docs/review/2026-09-26-v07-stage0-gate-a-52209c0.md`, `docs/rfc/0014-fleet-workflows-and-scheduling.md`, `docs/sop/v0.7-fleet-workflows-multistage-sop.md`. `git diff --name-only 52209c0 7a07777 | grep -E "^(src|ui|bin)/"` → none. RFC-first freeze respected. Confirmed.
- `git diff --check 52209c0 7a07777` → clean; `git diff --check` / `git diff --cached --check` on the worktree → clean.
- Ancestry: `git merge-base --is-ancestor` for `6ef5c51`, `7b0978b`, `c75b2f4`, `52209c0` against HEAD → all true; `git rev-parse 52209c0^` → `c75b2f4`. Lineage claims confirmed.
- `node --test test/v07-governance-contract.test.mjs` → 5 tests, 5 pass, 0 fail.
- `npm run check` (`node scripts/check-public-tree.mjs && node --test`) → "Public-tree validation passed." then 545 tests / 539 pass / 0 fail / 6 skipped. No regression.
- Re-verified the six prior findings against the new text and the real contracts:
  - P1 transport: D3.2 now defines `POST /_orbit/task` on `RouteIngress` with `ORBIT-ROUTE-V1` auth and explicit non-forwarding to DSH (lines 206-212); D3.3 declares a formal RFC-0012 extension, preserves the closed control vocabulary, and defines `mode: "task"` OPEN/task-result/close framing, `routeProof`, shared `RouteNonceCache`, 2 s capacity wait, and timeout abort (lines 214-262). Substantively resolved (see P3 residuals above).
  - P2 audit: D5 now names the `audit` table with schema `id, at, actor, action, detail_json` written via `registry.recordAudit(actor, action, detail)` (lines 274-275), matching `src/registry/sqlite.mjs:88,760` and `src/registry/registry.mjs:333-336`. No `audit_log`/`metadata` naming remains in RFC-0014. Resolved.
  - P2 M28 split: D6 now reads "13 fields / 15 fields" (line 59); matrix and test assert 13 automated + 15 mounted (`scripts/v07-fleet-acceptance-matrix.mjs`, `test/v07-governance-contract.test.mjs:127-128`). Resolved.
  - P3 D2 wildcard ordering: bare `"*"` / `mode: all|broadcast` / `nodeIds === "*"` now return `wildcard-prohibited` before the object-type guard (lines 134-147), matching acceptance field 4; capability mode now reads `n.health.capabilities` / `n.health.capabilitiesStale` / `n.nodeId` (lines 179-183), matching `toNodeSummary` (`src/registry/registry.mjs:1409-1441`). Resolved.
  - P3 status/summary: `summary.unreachable` added and a deterministic status mapping plus reconciliation invariant defined (lines 104-125, 270); field 17 (crash → `failed`) and field 18 (disconnect → `unreachable`) are now consistent with the mapping. Resolved.
  - P3 SOP matrix: freeze-invalidation, unexecuted-mounted-field, and residue rows added (`docs/sop/v0.7-fleet-workflows-multistage-sop.md:174-176`). Resolved.
- Source cross-checks (read-only): `src/registry/sqlite.mjs` (audit DDL/columns), `src/registry/registry.mjs` (`recordAudit`, `getNodeRow`, `toNodeSummary`), `src/registry/route-auth.mjs` (`verifyRouteRequest`, `RouteNonceCache`), `src/registry/protocol.mjs` (`ROUTE_HEADERS`, `buildRouteSigningString`, `computeRouteAuthority`), `src/node/route-ingress.mjs`, `src/node/reverse-channels.mjs` (`onChannelOpen`, frame guards, nonce cache), `src/registry/reverse-channel.mjs` (`CHANNEL_CAPACITY_WAIT_MS`, frame bounds), `src/registry/reverse-session.mjs` (paths), `docs/rfc/0010-node-endpoint-and-routing.md` (D3, D5, D7), `docs/rfc/0012-reverse-connected-nodes.md` (D4, D5, D6, D7, Explicit non-goals).

Not verified (no code exists for v0.7; out of scope for Stage 0): actual fleet dispatch, scheduling, aggregation, audit emission, and reverse `mode: "task"` runtime behavior. These are Stage 1-4 deliverables.

---

## Residual Risks

- Whether RFC-0012's "Explicit non-goals" list (and RFC-0010 D3's reserved-path language, which authorizes only `/_orbit/route-ready` as an Orbit-owned ingress path) must be edited in place, or whether a declared extension in RFC-0014 is sufficient, is a governance convention. RFC-0013 depended on RFC-0012 without editing it, so the declared-extension approach has precedent, but the two documents remain textually contradictory until reconciled.
- The reverse data channel's current node frame guard validates `open.headers` and mode `http|websocket` before any `mode: "task"` branch (`src/node/reverse-channels.mjs:313-328`); Stage 1-4 must extend this validator, and the RFC should state the exact `mode: "task"` validation order so the guard is not loosened for the browser modes.
- `generateM28AutomatedQualificationMatrix()` still sets all 13 automated fields to PASS unconditionally (`scripts/v07-fleet-acceptance-matrix.mjs:143-149`) with no binding to executed test results; this mirrors the accepted v0.6 M24 prior art and remains a Stage 5 evidence-honesty dependency.
- `assertM28MatrixShape(..., { scope: "mounted" })` validates mounted fields as PASS but does not require the 13 automated fields to be PASS, so a mounted-scope candidate-bound report can validate with automated fields still `NOT_EXECUTED`. Identical to accepted v0.6 M24 behavior; prior-art residual, not a new finding.
- D3.4 leaves `maxConcurrentDispatches` (8) and the per-task timeout (30 s) without an explicit relationship to the RFC-0012 reverse pool bounds (one flow per channel, 2 s capacity wait, 503 `reverse-capacity`); concurrent fleet dispatch on reverse nodes can contend for the pool in ways D3 does not quantify.

---

## Gate

**GO** — Gate A verdict: **GO** (no P0/P1/P2).

Rationale: all six prior findings (1x P1, 2x P2, 3x P3) are substantively resolved and independently reproduced against the real code and frozen RFCs, the RFC-first freeze is respected (no `src/**`, `ui/**`, `bin/**`), governance tests pass 5/5, the full suite is 545/539/0-fail/6-skip, the public-tree check passes, `git diff --check` is clean, ancestry and a clean worktree are confirmed. The five remaining findings are P3 documentation-accuracy items in the newly written transport prose; each is recoverable via the RFC's own normative cross-references and none alters a design decision, so P0/P1/P2 = 0 and Gate A is granted. The P3 items should be corrected before Stage 1 implementation begins.

---

## Review Report

`D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate\docs\review\2026-09-26-v07-stage0-gate-a-rereview-7a07777.md`
