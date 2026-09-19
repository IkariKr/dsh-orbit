# DSH Orbit v0.5 Stage 0 Review — RFC-0012 / Reverse-Connected Nodes SOP Architecture Review (Gate A, round 1)

Date: 2026-09-20

Review target:

- Branch: `chore/v0.5-stage0-rfc-sop`
- Accepted v0.4 closure baseline: `9891ab858a9c953a211978580910efcc2158bcd7`
- v0.5 construction authorization: `V05-CONSTRUCTION-20260919-A1` (commit `5ecde033a5336b873bf1fae102ebd0c1317d57f1`)
- Reviewed Stage 0 design SHA: `d66f4359a9d0a33b780ae421ace841442723c4eb`
- Remote HEAD at review start: `d66f4359a9d0a33b780ae421ace841442723c4eb` (pushed, divergence 0/0)
- Stage: v0.5 Stage 0 — RFC / architecture freeze, Gate A architecture review

Reviewed artifacts:

- `docs/rfc/0012-reverse-connected-nodes.md` (784 lines, D1–D15 + 48-field acceptance matrix)
- `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md` (1041 lines, Stage 0–8 + Gates A/B/C)
- `docs/release-attestations/v0.5-construction-authorization-2026-09-19.{md,json}`
- `test/v05-governance-contract.test.mjs`, `test/stage8-release-contract.test.mjs` (governance cleanup)

## Verdict

**HOLD**

Severity summary:

- P0: 0
- P1: 1
- P2: 6

The design package is high quality and closely aligned with both the v0.5 construction authorization and the existing code reality: no P0 was found, all D1–D15 seams close mechanically (D3 pairing idempotency against `enrollment_results`, D4 takeover generations, D5/D6/D7 numeric bounds, D6.1 shared ORBIT-ROUTE-V1 nonce cache, D8 presence separation, D11 schema v6 delta), the 47 of 48 matrix fields map to named Stage tests, the Stage 8 governance cleanup is implemented correctly (post-closure assertions read historical harness files from accepted closure `9891ab8` via `git show`), and the v0.5 governance contract test mechanically anchors the design package including the exact 48-field matrix.

Gate A cannot record GO because of one P1: the RFC's own D2/D3.4 language combined with the persisted-binding fail-closed behavior of the existing node runtime leaves the mandatory matrix field `existingNodeReverseConnectsWithoutRepair` (field 9) without a legitimate implementation/evidence path. The fix is a small D2/SOP amendment that does not touch any frozen invariant.

Stage 1 must not start until the P1 is remediated and the amended package is re-reviewed (GO).

## Independent verification

### Provenance

```text
local HEAD  = d66f4359a9d0a33b780ae421ace841442723c4eb
remote HEAD = d66f4359a9d0a33b780ae421ace841442723c4eb
```

`git merge-base --is-ancestor` confirmed `9891ab8`, `5ecde03` (authorization), and `30f8443` are ancestors of the reviewed SHA.

### Product-code leak check

`git diff --stat 3e6f8cd..d66f435` contains only `docs/rfc/0012-reverse-connected-nodes.md`, `docs/roadmap.md`, `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md`, `test/stage8-release-contract.test.mjs`, `test/v05-governance-contract.test.mjs`. No `src/**`, `bin/**`, `ui/**`, or `docker-registry/**` changes. `git diff --check` clean.

### Repository gate

Independent run of `npm run check`:

- tests: 395; pass: 390; fail: 0; skipped: 5 (Windows/POSIX environment-specific)
- public-tree validation: PASS
- `node --test test/stage8-release-contract.test.mjs`: 10 pass / 0 fail
- `node --test test/v05-governance-contract.test.mjs`: 3 pass / 0 fail

The three harness scripts asserted by the post-closure Stage 8 contract (`scripts/registry-drill.mjs`, `scripts/emit-stage8-mounted-evidence.mjs`, `scripts/registry-drill-firefox-bridge.py`) are byte-identical to accepted closure `9891ab8` today; the `postClosure` historical-read change is therefore preventive, protecting the closed v0.4 gate against future v0.5 harness changes.

### Code-reality cross-checks performed

- `src/registry/sqlite.mjs`: `SCHEMA_VERSION = 5`; `enrollment_tokens.purpose` CHECK `('enroll','reenroll')`; `enrollment_results.kind` CHECK `('enroll','reenroll')`; `migrate()` uses `upgradeSteps` + `user_version` + foreign-keys-off table rebuild — D11's v6 delta is implementable as specified.
- `src/registry/registry.mjs`: `/hub/tokens` create/list semantics can carry `purpose=pair` without new tables; list exposes neither plaintext nor digest.
- `src/registry/server.mjs` / `protocol.mjs`: `authenticateMachine` is method-independent with persistent `seen_nonces` transaction; GET + empty-body-hash upgrade authentication is feasible as D4 specifies. `computeRouteAuthority = n-<hex>.<domain>`.
- `src/registry/route-proxy.mjs`: 5-condition eligibility + immutable route snapshot match D9/D15 references.
- `src/node/route-ingress.mjs`: node-local `RouteNonceCache` is a process-level instance — D6.1's shared dual-transport replay cache is implementable node-side as specified.
- `docker-registry/Caddyfile.example`: public face answers `/api/v1/*` with 403 ("machine ingress NEVER ends here"); `src/registry/machine-ingress.mjs` private allowlist = exactly the 5 RFC-0006 paths. The RFC-0012 claim that the public projection reuses the existing selector deployment authority is feasible on the Caddy deployment (see P2-1).

### 48-field matrix mapping

47/48 fields map to named Stage 1–8 required tests / live evidence (Stage 1 → fields 1–9, 47; Stage 2 → 10–15, 35; Stage 3 → 16–23, 46; Stage 4 → 24–27, 32–34; Stage 5 → 28–31, 36–41, 48; Stage 6 → 42–45; Stage 7 → hardening support; Stage 8 → mounted execution). The single gap is field 31 (`cookieIsolationReverse`, P2-5) and the implementability gap for field 9 (P1-1). No Stage requirement lacks a matrix field (the matrix is a minimum set).

## Findings

### [P1-1] D2's "existing node enables reverse without pairing" path is not implementable against the persisted-binding reality; matrix field 9 has no legitimate evidence path

- Evidence:
  - RFC-0012 D2 (L102): an already-enrolled node may enable reverse mode only when its already-persisted canonical `hubBaseUrl` "is reachable from its current network and exposes the v0.5 public reverse machine ingress"; D3.4 (L220): "A currently registered node opens reverse connections with its existing node credential. It does not pair again."
  - But D2 (L98–L132) and SOP Stage 2 (L312–L334) define only the **outer public gateway** 7-path allowlist; neither document ever mentions the existing private machine listener (verified by full-text search).
  - Code reality: `src/node/client.mjs:172–199` `enforceBinding()` fails closed when the runtime `DSH_ORBIT_HUB_URL` differs from the persisted binding ("refusing to talk to another Hub"); `bin/dsh-orbit-node.mjs:48` takes the binding from startup env only; no rebinding tool exists. `docker-registry/Caddyfile.example` answers `/api/v1/*` with 403 on the public face; `src/registry/machine-ingress.mjs:3–11` private allowlist has exactly the 5 RFC-0006 paths — no `/api/v1/pair`, no `/api/v1/reverse/*`.
  - Consequence: every supported v0.4 node's persisted `hubBaseUrl` points at a machine surface that will not expose the v0.5 reverse surfaces; the node cannot rebind, cannot re-pair (D3.4 rejects), and behind NAT its old binding is unreachable. The public face denies `/api/v1/enroll` by design and `hubBaseUrl` is only ever established at enrollment, so **no real node can hold a binding that exposes the v0.5 public reverse ingress**. Field 9 `existingNodeReverseConnectsWithoutRepair` (D14: all 48 fields mandatory) would have no lawful path: either silently extend the private listener without a reviewed spec (unreviewed surface change), hand-forge store state (evidence falsification), or stop mid-construction and return to architecture review.
- Impact: not a P0 — it violates no frozen invariant, the fresh-pair main path (v0.5's target population) is fully self-consistent, and the fix does not touch any D1–D15 decision. But it is an implementability gap on a mandatory matrix field, and the SOP's literal Stage 2 scope (outer gateway only) would drive construction into the wrong implementation and rework. Per the SOP's own Gate A rule ("no unresolved P0/P1"), GO cannot be recorded until remediated.
- Fix direction (no invariant change): amend D2 to state that the Hub serves the same exact seven v0.5 machine surfaces on **every** machine ingress a persisted `hubBaseUrl` can reference — the pre-existing server-reachable machine listener extends its allowlist with `POST /api/v1/pair`, `GET /api/v1/reverse/control`, `GET /api/v1/reverse/channel` (identical semantics; `/api/v1/enroll` stays private), and the public gateway is the outward projection of that same handler set behind mandatory verified TLS/WSS, gateway rate limits, and header stripping. No rebinding, no second binding, no `reverseBaseUrl`. Add a named SOP Stage 2/3 test anchor for "existing registered node (non-pair) enables `routeMode=reverse` through its existing binding and completes a reverse control session" (matrix field 9).

### [P2-1] D2 does not pin the public machine ingress hostname nor require Host-scoped admission

- Evidence: RFC-0012 L104–L114 allowlist is method/path only; `docker-registry/Caddyfile.example`'s `n-*.domain` wildcard authority would also match machine paths with a pure path matcher.
- Impact: non-blocking (machine requests still require machine signatures), but needlessly widens the machine surface to every node authority and leaves "reuses the existing selector deployment authority" host placement to implementer guessing.
- Fix: D2 states machine paths are admitted only on the deployment-designated Hub authority referenced by `hubBaseUrl`; per-node route authorities (`n-<hex>.<domain>`) deny machine paths. Add a Stage 2 negative assertion.

### [P2-2] reversePresence state machine contradicts itself for a reverse session dying on a direct-mode node

- Evidence: RFC-0012 L472 (D8) defines `offline` only as "routeMode = reverse and no ready session" and `unknown` "only for a direct node with no reverse session"; L309 (D4.3) says "Control close changes reverse presence to offline immediately" without mode distinction.
- Impact: display semantics only (presence is not a routing credential; direct-mode eligibility in D9 does not depend on it); routing behavior unambiguous.
- Fix: D8/D4.3 clarify: "offline immediately" applies to reverse-mode nodes; on a direct-mode node a dead non-routing reverse session falls back to `unknown`.

### [P2-3] D4 sets no per-node bound or ready timeout on authenticated-but-not-ready pending control connections

- Evidence: RFC-0012 L292–L303 (D4.2) only prevents pending connections from evicting a healthy session; D13 requires "all queues/connections are bounded".
- Impact: an authenticated node repeatedly connecting without sending `ready` could accumulate pending connections; per-IP rate limits backstop it, but the resource invariant is not closed.
- Fix: D4 adds: a new authenticated control connection for a node closes that node's prior **pending** (never-ready) connections; a pending connection that has not reached `ready` is closed after 30 seconds. This does not touch the takeover semantics, which only apply to ready sessions.

### [P2-4] D9's eligibility condition "at least one data channel can be obtained within the 2-second capacity wait" reads as a destructive pool action

- Evidence: RFC-0012 L356 (D5: no idle channel → wait up to 2s → 503 `reverse-capacity`, at flow assignment) vs L519 (D9 lists channel obtainability as a selector eligibility condition). If eligibility actually obtained a channel, selector rendering could block 2s or double-consume.
- Impact: implementable but ambiguous; implementers could diverge on whether eligibility consumes pool resources.
- Fix: D9 states eligibility uses a non-destructive pool-availability predicate; the 2-second wait + 503 happens only at flow assignment.

### [P2-5] Matrix field 31 `cookieIsolationReverse` has no named test anchor in any Stage's required tests

- Evidence: RFC-0012 L704 (automated + mounted); SOP Stage 4 mentions cookie isolation only in implementation scope (L481), not in its required automated tests (L484–L511); Stage 5 likewise scope-only.
- Impact: the 48 fields are mandatory; without a named automated anchor the evidence source for field 31 is ambiguous. All other 47 fields map cleanly.
- Fix: add a named Stage 4 (or 5) required test: RFC-0010 cookie isolation intact through reverse transport (downstream `Set-Cookie` domain stripping preserved; selector session cookies never reach DSH through reverse).

### [P2-6] Gate wording not fully mechanical: Gate A "blocking P2 = 0" undefined; Gate C lacks a symmetric stop-work sentence

- Evidence: SOP L223 "blocking P2 = 0" — the P2 severity level is by definition non-blocking and the must-fix criterion is unwritten; Gate C (L738–L753) states only "GO means AUTHORIZED TO RUN v0.5 MOUNTED EVIDENCE" while Gate B has explicit "STOP after Stage 4" / "Stage 5 may begin only after Gate B GO". Minor duplication: SOP Stage 2 required security behavior repeats the Origin-403 clause twice (L346, L350).
- Impact: does not block this review; both gates are slightly less mechanically decidable than Gate B's standard.
- Fix: Gate A criterion becomes "review-record P2 items marked must-fix-before-GO = 0"; Gate C gains "Stage 8 may begin only after Gate C GO."; the duplicated Origin clause is merged.

## Disposition

The P1 must be remediated in the design package (allowed before Gate A: documentation/governance only), after which the amended package must be independently re-reviewed. P2 items 2–6 are resolved in the same remediation pass to avoid construction churn; P2-1 is resolved together with the P1-1 D2 amendment. None of the fixes changes a frozen invariant, the 48-field matrix membership, or the v0.5/v0.6/v0.7 scope boundary.
