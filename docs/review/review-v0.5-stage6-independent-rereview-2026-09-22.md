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

## 4. Gate status

```text
P0 = 0
P1 = 0 after remediation
P2 = 0 after remediation

Stage 6 implementation: remediation complete
Independent Stage 6 re-review: required before acceptance
Stage 7: NOT AUTHORIZED
Candidate freeze: NOT AUTHORIZED
Gate C: NOT REACHED
Stage 8: NOT AUTHORIZED
```

No candidate freeze, Stage 7 hardening, Gate C review, mounted evidence, release tag, promotion, DNS, or publication is authorized by this remediation record.
