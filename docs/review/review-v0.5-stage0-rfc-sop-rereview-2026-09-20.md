# DSH Orbit v0.5 Stage 0 Re-Review — RFC-0012 / Reverse-Connected Nodes SOP Architecture Review (Gate A, round 2)

Date: 2026-09-20

Review target:

- Branch: `chore/v0.5-stage0-rfc-sop`
- Reviewed design SHA: `5738c0ce6a4ec11bee62f9cfae44dd6463816768` (remediation commit)
- Remediation diff reviewed: `git diff c8ce475..5738c0c`
- Round 1 review record: `docs/review/review-v0.5-stage0-rfc-sop-2026-09-20.md` (HOLD, P0=0 / P1=1 / P2=6)
- Remote state: `origin/chore/v0.5-stage0-rfc-sop` = `5738c0ce6a4ec11bee62f9cfae44dd6463816768`, divergence 0/0
- Stage: v0.5 Stage 0 — Gate A architecture re-review after author remediation

## Verdict

**GO**

Severity summary:

- P0: 0
- P1: 0
- P2: 0

## Round 1 findings — remediation verification

Every round 1 finding was verified against the actual `c8ce475..5738c0c` diff and the amended document text; all landed, none exceeded the declared scope, none introduced a new finding.

### [P1-1] Resolved — machine-surface projection closes the field-9 evidence path

- RFC-0012 D2 now reads "exposes the v0.5 reverse machine surfaces **defined below**" (removing the public-gateway-exclusive reading) and adds the handler-set paragraph: one Hub machine handler set on every machine ingress a persisted canonical `hubBaseUrl` can reference; the pre-existing server-reachable machine listener additionally admits `POST /api/v1/pair`, `GET /api/v1/reverse/control`, `GET /api/v1/reverse/channel` with identical semantics; `/api/v1/enroll` remains server-reachability-only and never joins the public projection; the public gateway is the outward projection of the same handler set; "v0.5 adds no rebinding, no second binding, and no `reverseBaseUrl`".
- SOP Stage 2 mirrors the paragraph, adds the two automated tests (existing node reaches the added surfaces through its persisted binding without rebinding; machine path on a per-node route authority denied), and Stage 3 adds the named matrix-field-9 anchor (`existingNodeReverseConnectsWithoutRepair` via an existing node's own binding).
- The round 1 trilemma (unreviewed private-listener extension vs forged store vs mid-construction stop) is eliminated: field 9 now has a lawful implementation and evidence path.

### [P2-1] Resolved — Host-scoped admission

D2 and SOP Stage 2 both state machine paths are admitted only on the deployment-designated Hub authority referenced by `hubBaseUrl` and denied on per-node route authorities, with a Stage 2 negative assertion.

### [P2-2] Resolved — presence on direct-mode session death

D4.3 now scopes "offline immediately" to `routeMode = reverse` nodes and routes direct-mode dead sessions to `unknown`; D8 adds the matching "When that session dies, presence falls back to `unknown`." The two statements are now mutually consistent.

### [P2-3] Resolved — pending control connections bounded

D4.2 adds per-node pending bounds: a new authenticated connection closes that node's prior pending connections; a pending connection not reaching `ready` within 30 seconds is closed; neither rule can evict the current ready session. No conflict with takeover semantics (ready-only) or the reconnect backoff cap.

### [P2-4] Resolved — non-destructive eligibility

D9 eligibility now uses a non-destructive pool-availability predicate; the 2-second capacity wait and 503 `reverse-capacity` happen only at flow assignment. Consistent with D5.

### [P2-5] Resolved — cookie-isolation anchor

SOP Stage 4 required automated tests now name the RFC-0010 cookie-isolation test (downstream `Set-Cookie` domain stripping preserved; selector session cookies never reach DSH) tied to matrix field 31 `cookieIsolationReverse`.

### [P2-6] Resolved — gate wording

Gate A criterion is now "review-record P2 items marked must-fix-before-GO = 0" (mechanically decidable against the review record); Gate C gains "Stage 8 may begin only after Gate C GO."; the duplicated Stage 2 Origin-403 clause is deduplicated.

## Invariant preservation

The remediation diff touches only `docs/review/**`, `docs/rfc/0012-reverse-connected-nodes.md` (24 lines), and `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md` (15 lines). Verified still in place after amendment: `routeMode = direct | reverse` with no auto and "no automatic or priority-based selection"; transports "never silently fail over"; every flow carries "the **existing ORBIT-ROUTE-V1** proof" with the shared dual-transport nonce cache; one control connection + bounded pool; one channel = one flow, no multiplex; `/api/v1/enroll` doubly non-public; no TLS bypass; no new route/selector/DSH-profile system; no 0.6/0.7 scope absorption. The 48-field matrix table is byte-unchanged (`test/v05-governance-contract.test.mjs` exact-set deepEqual remains green). The RFC/SOP status sentences retain the governance-anchored text.

## Independent verification performed

- `git rev-parse HEAD` and `origin/chore/v0.5-stage0-rfc-sop` both `5738c0ce6a4ec11bee62f9cfae44dd6463816768`; worktree clean; `git diff --check` clean.
- `git diff --stat d66f435..5738c0c`: only the three docs files; no `src/**` / `bin/**` / `ui/**` / `docker-registry/**` changes (Stage 0 allowed scope).
- Line-by-line read of `git diff c8ce475..5738c0c` against the author's declared finding→fix mapping; no undeclared changes.
- `node --test test/v05-governance-contract.test.mjs`: 3 pass / 0 fail (48-field matrix exact match confirmed).
- `node --test test/stage8-release-contract.test.mjs`: 10 pass / 0 fail.
- `npm run check`: 395 tests, 390 pass, 0 fail, 5 skipped (POSIX environment-specific), all green.

## Gate A disposition

All Gate A GO conditions hold:

- RFC-0012 accepted (with all round 1 amendments): yes;
- unresolved P0/P1: 0;
- review-record must-fix-before-GO P2: 0;
- full tests green: yes;
- v0.5 scope still matches `V05-CONSTRUCTION-20260919-A1`: yes;
- this record names the exact pushed accepted Stage 0 design SHA: `5738c0ce6a4ec11bee62f9cfae44dd6463816768`.

**Accepted Stage 0 design SHA (v0.5 construction design baseline): `5738c0ce6a4ec11bee62f9cfae44dd6463816768`.**

Stage 1 construction must descend from this SHA (or from the direct review-record descendant naming it), in addition to the immutable v0.4 closure (`9891ab858a9c953a211978580910efcc2158bcd7`) and v0.5 authorization (`5ecde033a5336b873bf1fae102ebd0c1317d57f1`) ancestry. Stage 1 product construction is authorized to begin. Gates B and C execute per the SOP as written.
