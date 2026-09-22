# Independent Stage 6 Review Remediation / Re-review Record

日期：2026-09-22

## 1. Provenance

- Original independent review: `docs/review/review-v0.5-stage6-independent-2026-09-22-b31e245.md`
- Original review target: `b31e245b4ab791a2653a6e8a6e8f49a5d471202e`
- Original verdict: **CHANGES REQUESTED**
- Original findings: P0=0, P1=1, P2=1, P3=0
- Governing documents:
  - `docs/rfc/0012-reverse-connected-nodes.md`
  - `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md`

The original review is preserved unchanged. This record binds the remediation delta and its fresh verification.

## 2. Remediations

### P1 — direct probing after reverse mode

**Status: CLOSED**

Changes:

- `Registry.setRouteMode()` now invalidates persisted `health.reachable` to `unknown` on an actual mode transition and clears route-probe failure counters.
- `Registry.probeNode()` returns `{ reachable: "unknown", probed: false, reason: "reverse-mode" }` for active reverse nodes without touching the stored direct target or invoking the transport.
- `Registry.recordProbeResult()` rejects late direct probe results after the node has switched to reverse mode and keeps the persisted reachable dimension unknown.
- Management node summaries now project reverse-mode `health.reachable` from current reverse route readiness: `ok` only when the current reverse session is route-ready; otherwise `unreachable`.
- `registryContact` remains heartbeat-derived and independent.

Regression coverage:

- `test/v05-stage6-management-observability.test.mjs`
  - direct target exists and persisted reachable is `ok`;
  - explicit switch to reverse invalidates the stale value;
  - probe transport is not called in reverse mode;
  - authenticated heartbeat still updates registry contact without making direct reachability authoritative;
  - management reverse offline/online projection returns `unreachable`/`ok` consistently.

### P2 — malformed route-mode mutation body

**Status: CLOSED**

Changes:

- `PUT /hub/nodes/:nodeId/route-mode` validates parsed JSON before reading `routeMode`.
- `null`, arrays, and scalar JSON bodies return the existing `400 bad-request` contract.
- No route-mode state, audit row, or event is created for malformed bodies.

Regression coverage:

- `test/registry-admin-api.test.mjs` asserts 400 for `null`, `[]`, and `1`, and verifies unchanged route mode/audit/event counts.

## 3. Fresh verification

Focused remediation suite:

```text
node --test \
  test/registry-admin-api.test.mjs \
  test/v05-stage6-management-observability.test.mjs \
  test/v05-stage6-node-route-mode.test.mjs \
  test/v05-stage6-lifecycle.test.mjs \
  test/registry-route-target.test.mjs

49 passed / 0 failed / 0 skipped
```

The original Stage 6 focused and full suites are rerun below after the remediation commit.

## 4. Independent re-review disposition

The independent remediation re-review was executed against exact commit `41e3ce95c632da638e1acb60df141ee324bd3526`.

```text
Verdict: PASS / ACCEPTED
P0 = 0
P1 = 0
P2 = 0

Stage 6: ACCEPTED for 41e3ce9
Stage 7: AUTHORIZED TO PROCEED, but not started by this session
Candidate freeze: NOT AUTHORIZED / NOT EXECUTED
Gate C: NOT REACHED / NOT AUTHORIZED
Stage 8: NOT AUTHORIZED / NOT EXECUTED
```

Independent re-review verification:

```text
focused remediation suite: 49 passed / 0 failed / 0 skipped
reverse ingress and transport regressions: 40 passed / 0 failed / 0 skipped
npm run check: 486 tests / 481 passed / 0 failed / 5 skipped
```

The reviewer independently verified that direct probing stops in reverse mode, late direct probe results cannot restore reachability, management `health.reachable` follows reverse readiness, and malformed route-mode bodies return 400 without mutation. No new P0/P1/P2 findings were identified.

The following remain explicitly unexecuted: external/mounted production Stage 6 evidence, the frozen 48-field candidate matrix, Stage 7 hardening, candidate freeze, Gate C review, Stage 8 mounted evidence, release tagging, promotion, DNS, and publication.
