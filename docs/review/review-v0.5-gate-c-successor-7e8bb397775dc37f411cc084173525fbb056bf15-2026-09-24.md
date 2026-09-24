# DSH Orbit v0.5 Gate C Independent Review — Successor Candidate

Date: 2026-09-24
Review type: independent Gate C candidate review
Reviewer: `@code-reviewer2`

## 1. Exact review target and provenance

- Frozen candidate SHA: `7e8bb397775dc37f411cc084173525fbb056bf15`
- Candidate parent: `aeb54a4b5b374c8172d29ff3eec2aca2d4f0d712`
- Freeze record: `docs/review/review-v0.5-successor-freeze-7e8bb397775d-2026-09-24.md`
- Candidate-bound automated D14 report: `docs/review/v05-d14-automated-qualification-7e8bb397775dc37f411cc084173525fbb056bf15.json`
- The candidate is the direct child of its declared parent. Later remote tip `e69a325e23f5cf2d29cf7c0bee39ef3089e93053` is a direct child of the candidate and contains only the two governance/evidence files above; candidate product, tests, and harness remain identical to the reviewed SHA.

## 2. Independent verdict

```text
VERDICT: GO
P0 = 0
P1 = 0
P2 = 1
P3 = 2
```

The exact frozen candidate `7e8bb397775dc37f411cc084173525fbb056bf15` is authorized to run v0.5 mounted evidence. This GO is scoped only to that exact SHA. It does not claim that mounted evidence has been executed and does not authorize release tagging, production promotion, or DNS cutover.

## 3. Verified candidate properties

- Authorization and ancestry to the v0.4 accepted closure, v0.5 construction authorization, Stage 0 accepted baseline, Gate A, and Stage 1 pairing baseline were verified.
- The candidate diff from parent changes exactly six paths: Node CLI readiness wiring, ReverseClient readiness selection, RFC/configuration documentation, and two reverse readiness tests.
- No Stage 8 harness, D14 schema, Compose drill, registry-drill runner/emitter, or deployment harness path is in the candidate diff.
- The implementation probes `readinessTarget` for reverse control readiness while preserving `dshTarget` for RouteIngress and the reverse channel pool. An unset readiness target falls back to `dshTarget`.
- Generic transport semantics remain: any HTTP response from the configured DSH readiness endpoint is responsive; refusal or timeout is not. Tests cover a 502 route adapter alongside a responsive direct DSH target, direct DSH 500 response, DSH loss, timeout/refusal, and unchanged heartbeat contact.
- The candidate-bound qualification report validates against the shared D14 validator, has exactly 48 fields, 15 automated PASS, 33 mounted-required NOT_EXECUTED, and resolvable test evidence references.
- Independent full check: public-tree PASS; 503 tests, 497 passed, 0 failed, 6 skipped. Reverse-control and child-process live reverse checks passed. No candidate-bound mounted PASS was claimed.

## 4. Findings

### [P2] D8 normative amendment needed explicit architecture ratification — closed by a separate governance-only record

The candidate extends D8 with a configurable readiness target and direct DSH probing for deployments whose route-flow target is an adapter. The accepted Stage 0 RFC baseline did not spell out this configurable input. The route/presence/heartbeat separation remains intact, but the D8 amendment requires explicit architecture ratification. The exact-SHA ratification is recorded separately at `docs/review/review-v0.5-d8-readiness-ratification-7e8bb397775dc37f411cc084173525fbb056bf15-2026-09-24.md`. That record changes no RFC, product, harness, or execution behavior and does not extend this Gate C GO to any other SHA.

### [P3] Operator variable omitted from the CLI's inline environment list

The new `DSH_ORBIT_NODE_DSH_READINESS_TARGET` is documented in `docs/configuration-reference.md` but is not listed in the CLI's inline environment-variable comment. This is an operator-discoverability issue only and does not affect runtime behavior.

### [P3] Mounted runner must explicitly set the new readiness target

For adapter-based route targets, the readiness-only benefit requires the mounted runner to set `DSH_ORBIT_NODE_DSH_READINESS_TARGET` to the direct DSH listener. If it is unset, compatibility fallback intentionally preserves the previous behavior. The existing formal runner remains pinned to candidate `405c2ac` and does not configure this input; it was not run and is not approved evidence for this candidate. A capable external runner/configuration is a precondition to executing the authorized mounted run.

## 5. Mounted execution and authorization boundaries

```text
Candidate freeze: CONFIRMED at 7e8bb397775dc37f411cc084173525fbb056bf15
Gate C: GO for that exact candidate SHA
Stage 8 mounted evidence: NOT EXECUTED
D14 mounted-required fields: 33 NOT_EXECUTED
Seven-artifact evidence set: NOT CREATED
Independent Final Review: PENDING
Tag/release, production promotion, DNS cutover: NOT AUTHORIZED
```

The Gate C review did not approve changing the frozen harness. Any later product, harness, or execution-semantics change invalidates the candidate and requires a new candidate, fresh candidate-bound evidence, and a new independent Gate C review.
