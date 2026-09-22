# Independent Stage 6 Code Review

## Review Scope

- Repository: `D:/App/01_Ai/CodeX/dsh-orbit-v05-stage1`
- Branch: `chore/v0.5-stage2-public-machine-ingress`
- Exact review target: `b31e245b4ab791a2653a6e8a6e8f49a5d471202e`
- Parent/baseline: `809bb8fbc5c6b0edad3eeb999b747debc0ed094c`
- Governing sources:
  - `docs/rfc/0012-reverse-connected-nodes.md`
  - `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md`
- Review type: independent Stage 6 review; implementation report and prior construction claims were treated as untrusted evidence.
- Diff reviewed: complete parent-to-HEAD diff, including runtime, Registry, UI, tests, and the submitted Stage 6 completion report.

## Verdict and Finding Counts

- Verdict: **CHANGES REQUESTED**
- P0: **0**
- P1: **1**
- P2: **1**
- P3: **0**

## Findings

### [P1] Direct route probing continues after a node is switched to reverse mode, corrupting the authoritative `reachable` dimension

**Location**

- `src/registry/registry.mjs:1223-1308` (`probeNode`)
- `src/registry/registry.mjs:1025-1054` (`setRouteMode`)
- `src/registry/scheduler.mjs:24-50` (`createRouteProbeScheduler` / `probeAllNodes` scheduling)
- `bin/dsh-orbit-hub.mjs:154-155` (production route-probe scheduler startup)
- `src/registry/server.mjs:807-827` (management projection)

**Evidence**

`setRouteMode()` changes only `nodes.route_mode`; it does not invalidate or otherwise separate the persisted `nodes.reachable` value. The existing `probeNode()` then proceeds to read and probe the stored `routeTarget` without checking `route_mode`. The production scheduler calls `probeAllNodes()` for every active node, including reverse nodes.

I reproduced the state inconsistency against the reviewed HEAD using an enrolled node with an active Hub route key and a stored direct `routeTarget`: after setting `route_mode = 'reverse'`, `registry.probeNode()` returned `{ reachable: 'ok', probed: true }` and the Registry summary reported `routeMode: 'reverse'` with `health.reachable: 'ok'`. With no reverse session, the management projection simultaneously reported `reversePresence: 'offline'` and `reverseReason: 'reverse-session-offline'`.

The management UI renders `health.reachable` as an independent badge (`ui/app.mjs:100-114`) while also rendering the reverse status, so an operator can see a reverse node as `reachable=ok` even though its selected reverse transport is offline. This contradicts RFC-0012 D8/D9: in reverse mode, `reachable` must be derived from the current authenticated reverse session plus local route readiness; stored direct metadata is inactive and must not be used as a route-readiness source.

**Impact**

- An inactive direct target is still actively probed after the operator selects reverse mode.
- Persisted `reachable` becomes transport-inaccurate and can remain `ok` while reverse routing is unavailable.
- Management status is misleading and can cause an operator to believe the selected reverse route is ready when it is not.
- The actual route proxy remains fail-closed because `evaluateRouteEligibility()` uses the reverse session/readiness path, so this is not an observed direct-fallback bypass; it is nevertheless a release-blocking lifecycle/read-model correctness defect.

**Precise remediation**

Make route probing mode-aware: `probeNode()` and the scheduler must not probe `routeTarget` for `routeMode = 'reverse'`. On mode transition, invalidate any persisted direct reachability result as appropriate, and make the management read model expose reverse `reachable` from the same server-authoritative reverse session/readiness state used by route eligibility. Add a regression test covering `direct reachable=ok -> routeMode=reverse -> no reverse session`, asserting that management `health.reachable` is not `ok`, that the inactive direct target is not probed, and that recovery/offline transitions update the reverse projection independently of `registryContact`.

### [P2] Malformed `PUT /hub/nodes/:nodeId/route-mode` body can produce an internal 500 instead of a client error

**Location**

- `src/registry/server.mjs:694-706`

**Evidence**

The new route-mode handler does:

```js
const body = parseBody(await readBody(request, BODY_LIMIT_KIB));
const result = registry.setRouteMode({
  actor: session.operatorPrincipal,
  nodeId,
  routeMode: body.routeMode,
});
```

`parseBody()` legitimately returns JSON `null` for a body containing `null`; accessing `body.routeMode` then throws `TypeError`. The generic handler converts that to HTTP 500 `internal-error`. I reproduced this against the reviewed HEAD with an authenticated session and CSRF token: `PUT /hub/nodes/<id>/route-mode` with body `null` returned 500 and logged the TypeError. No state mutation occurred.

**Impact**

A malformed operator mutation is classified as an internal server failure rather than a bounded 4xx validation error. This leaks an avoidable error path into the management API and makes client behavior/retry semantics incorrect, although it does not bypass authorization or mutate node state.

**Precise remediation**

Validate that the parsed body is a non-null object before reading `routeMode`, or make `setRouteMode()` receive the body through a safe accessor. Return the existing `400 bad-request` contract for `null`, arrays, and other malformed payload shapes. Add an API test for `null` and non-object JSON bodies and assert no audit/event/state mutation.

## Verification

Executed against the exact reviewed HEAD:

- `git status --short --branch`, `git rev-parse HEAD`, parent resolution, and complete `git diff --stat`.
- Complete parent-to-HEAD diff review for all 19 changed files.
- Read and cross-checked RFC-0012 D1-D15 and the SOP Stage 6 requirements, including route-mode mutation, heartbeat propagation, reverse lifecycle, token secrecy, rotation, delete, reenrollment, UI projection, and scope boundaries.
- `git diff --check 809bb8fbc5c6b0edad3eeb999b747debc0ed094c b31e245b4ab791a2653a6e8a6e8f49a5d471202e` — PASS.
- Focused Stage 6 suite:
  - `node --test test/v05-stage5-route-mode-contract.test.mjs test/v05-stage5-live-reverse-route.test.mjs test/v05-stage6-node-route-mode.test.mjs test/v05-stage6-lifecycle.test.mjs test/v05-stage6-management-observability.test.mjs`
  - Result: **25 passed, 0 failed, 0 skipped**.
- Stage 6/admin/reenrollment/UI suite:
  - `node --test test/v05-stage6-node-route-mode.test.mjs test/v05-stage6-lifecycle.test.mjs test/v05-stage6-management-observability.test.mjs test/registry-admin-api.test.mjs test/registry-reenroll.test.mjs test/ui-dom.test.mjs test/ui-selector-view-model.test.mjs test/ui-view-model.test.mjs`
  - Result: **67 passed, 0 failed, 0 skipped**.
- Stage 3/5 reverse and public ingress regression suite:
  - `node --test test/v05-stage5-route-mode-contract.test.mjs test/v05-stage5-live-reverse-route.test.mjs test/v05-stage3-reverse-control.test.mjs test/v05-stage3-live-reverse.test.mjs test/v05-stage2-public-ingress.test.mjs`
  - Result: **40 passed, 0 failed, 0 skipped**.
- `npm run check` — PASS: public-tree validation passed; **484 tests, 479 passed, 0 failed, 5 skipped**.
- Independently reproduced the two findings with small read-only/in-process fixtures against the reviewed HEAD.

Passing tests do not cover the two findings: the existing tests do not assert that direct route probing stops after a reverse mode switch, do not assert management `health.reachable` consistency for a stale direct value, and do not test a JSON `null` route-mode mutation body.

## NOT_EXECUTED

The following were not executed and must not be represented as PASS:

- External/mounted production Stage 6 rotation, delete, and reenrollment evidence against this exact candidate.
- The exact frozen RFC-0012 48-field candidate matrix and candidate-bound evidence manifest.
- Stage 7 hardening and candidate freeze.
- Gate C independent candidate review.
- Stage 8 mounted evidence, cleanup/hygiene closure, and final engineering acceptance.
- Release tag, production promotion, or DNS/publication actions.

## Residual Risks

- The full repository suite is green, but the five existing skips were not converted into mounted evidence and do not close the Stage 8 requirements.
- No finding was raised for malformed reverse control `routeReady` values because that behavior predates this Stage 6 diff and belongs to the broader reverse protocol hardening surface; it remains a candidate-hardening item to verify before final qualification.
- No browser-mounted or external TLS topology was executed in this review.

## Gate

**CHANGES REQUESTED**

The Stage 6 implementation is not eligible for a Stage 6 acceptance/hand-off as-is because the selected reverse route can retain and display a stale direct reachability result, and the new route-mode mutation has an unhandled malformed-body path. Fix both findings, add the missing regression assertions, and rerun the exact focused and full checks before requesting the next gate.

Stage 7 remains **unauthorized**. Gate C remains **not reached and unauthorized**. Stage 8 remains **unauthorized**. No candidate freeze or mounted evidence run is authorized by this review.

## Review Report

Saved at:

`D:/App/01_Ai/CodeX/dsh-orbit-v05-stage1/docs/review/review-v0.5-stage6-independent-2026-09-22-b31e245.md`
