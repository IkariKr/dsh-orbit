# DSH Orbit v0.5 D8 Readiness-Target Architecture Ratification

Date: 2026-09-24
Review type: focused architecture review / governance-only ratification
Reviewer: independent architecture reviewer (`code-reviewer`)

## 1. Exact target and accepted baseline

- Ratified frozen candidate SHA: `7e8bb397775dc37f411cc084173525fbb056bf15`
- Accepted Stage 0 design SHA: `5738c0ce6a4ec11bee62f9cfae44dd6463816768`
- Baseline review: `docs/review/review-v0.5-stage0-rfc-sop-rereview-2026-09-20.md`
- Candidate freeze record: `docs/review/review-v0.5-successor-freeze-7e8bb397775d-2026-09-24.md`
- Related change review: `docs/review/review-v0.5-gate-c-successor-7e8bb397775dc37f411cc084173525fbb056bf15-2026-09-24.md`

The accepted Stage 0 RFC D8 text defines generic local DSH transport readiness but does not name a separately configurable readiness target. The frozen candidate adds optional `DSH_ORBIT_NODE_DSH_READINESS_TARGET`, defaulting to `DSH_ORBIT_NODE_DSH_TARGET`, and uses it only for reverse-control readiness probes.

## 2. Architecture disposition

```text
VERDICT: RATIFY_CURRENT_BEHAVIOR
P0 = 0
P1 = 0
P2 = 0
P3 = 0
```

The architecture reviewer ratifies the D8 readiness-target behavior already present in the exact frozen candidate above. This is a governance-only review record: it does not amend the RFC, alter product or harness behavior, modify the D14 matrix, or authorize any other SHA.

## 3. Ratified semantic boundary

- `DSH_ORBIT_NODE_DSH_TARGET` remains the route-flow destination for direct RouteIngress and the reverse data-channel pool.
- `DSH_ORBIT_NODE_DSH_READINESS_TARGET` is an optional reverse-control readiness probe target. When unset, it defaults to `DSH_ORBIT_NODE_DSH_TARGET`, preserving prior behavior.
- When route flows use an adapter/proxy and the readiness target is separately configured to the local DSH listener, `routeReady` measures generic transport responsiveness of that DSH listener: any HTTP response, including BrowserAuth 401 or an application error, is responsive; connection refusal or timeout is not.
- With distinct targets, `routeReady=true` / reverse `reachable=ok` means the DSH readiness endpoint is transport-responsive and the reverse session is current. It does **not** assert that a distinct route adapter is healthy. Adapter/route-flow failure remains independently observable on actual routed requests; no automatic fallback is introduced.
- `registryContact`, reverse control-session presence, DSH semantic health, compatibility, and route readiness remain separate read-model facts.
- No new route authority, selector, compatibility-profile, tunnel, multiplexing, or failover system is introduced.

The reviewer found this additive and default-preserving choice within the authorized v0.5 reverse-connection objective. The documented boundary above is part of this ratification and must not be broadened by implication.

## 4. Effect and stop conditions

- Candidate freeze remains valid at `7e8bb397775dc37f411cc084173525fbb056bf15`; no product, RFC, SOP, test, or harness files were changed by this ratification.
- This ratification itself does **not** grant Gate C and does **not** authorize Stage 8. Gate C authorization must be separately recorded for the exact candidate SHA; the independent Gate C GO is in `docs/review/review-v0.5-gate-c-successor-7e8bb397775dc37f411cc084173525fbb056bf15-2026-09-24.md`.
- If a future architecture review finds the distinct-target semantics unacceptable, or a change is needed to make `reachable` assert route-adapter health, stop. Do not amend the frozen candidate; return to architecture review, then create a new candidate with fresh candidate-bound evidence and new Gate C review.
- No evidence in this record claims that mounted evidence ran. The external runner pinned to `405c2ac` is not thereby approved or made capable.
- Release tag/publication, production promotion, and DNS cutover remain separately unauthorized.
