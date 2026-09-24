# DSH Orbit v0.5 Successor Candidate Freeze Record

Date: 2026-09-24
Record type: exact-SHA candidate freeze confirmation and pre-Gate-C evidence index

This record follows `docs/rfc/0012-reverse-connected-nodes.md`, the v0.5 construction authorization, and `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md`. It does not grant Gate C or authorize Stage 8 mounted execution by itself.

## 1. Frozen candidate

- Candidate SHA: `7e8bb397775dc37f411cc084173525fbb056bf15`
- Candidate parent: `aeb54a4b5b374c8172d29ff3eec2aca2d4f0d712`
- Branch: `chore/v0.5-stage2-public-machine-ingress`
- Remote ref: `origin/chore/v0.5-stage2-public-machine-ingress`
- Candidate commit: `fix(v0.5): probe reverse readiness at DSH endpoint`
- Freeze decision: this exact product candidate is frozen for independent Gate C review; subsequent commits on the branch are qualification/governance/evidence records only.

The candidate descends from the authorized v0.5 construction lineage, including accepted v0.4 closure `9891ab858a9c953a211978580910efcc2158bcd7`, Gate A baseline `402d8995`, and Stage 1 pairing baseline `045d3e3`. The candidate commit is a direct child of the prior un-frozen Stage 8 preparation head `aeb54a4b5b374c8172d29ff3eec2aca2d4f0d712`.

The product change separates the reverse readiness probe endpoint from the route-flow target. `DSH_ORBIT_NODE_DSH_TARGET` continues to serve route forwarding; optional `DSH_ORBIT_NODE_DSH_READINESS_TARGET` is used only for reverse readiness and defaults to the route target when unset. The change preserves generic transport semantics: any HTTP response from the configured direct DSH listener, including 401 or application 5xx, indicates a responsive transport; refusal or timeout does not. The existing reverse channel pool continues using the route target.

Changed candidate paths are limited to:

- `bin/dsh-orbit-node.mjs`
- `docs/configuration-reference.md`
- `docs/rfc/0012-reverse-connected-nodes.md`
- `src/node/reverse-client.mjs`
- `test/v05-stage3-live-reverse.test.mjs`
- `test/v05-stage3-reverse-control.test.mjs`

No frozen Stage 8 harness, Compose drill, registry-drill runner/emitter, D14 schema, or external mounted runner was modified in the candidate commit.

## 2. Pre-freeze verification

All checks below were run against candidate SHA `7e8bb397775dc37f411cc084173525fbb056bf15` after the candidate commit was created:

- `npm run check`: public-tree PASS; 503 tests, 497 passed, 0 failed, 6 skipped.
- Focused v0.5, Stage 7, Node, and migration/backup suite: 144 tests, 142 passed, 0 failed, 2 skipped.
- Reverse-control and live reverse regressions: 13 tests, 13 passed, 0 failed.
- `git diff --check`: PASS.
- Candidate branch push: PASS; `git ls-remote` returned the exact candidate SHA.
- Worktree and ignored-state scan immediately after candidate commit: clean; no runtime residue.
- Product/harness boundary: no Stage 8 harness path occurs in the candidate diff.

The automated D14 evidence is separately bound to this candidate at:

`docs/review/v05-d14-automated-qualification-7e8bb397775dc37f411cc084173525fbb056bf15.json`

It uses run ID `v05-automated-7e8bb397775d-1790238348804`, validates against the shared candidate-bound matrix validator, records all 15 automated-evidence fields as PASS, and leaves all 33 mounted-required fields NOT_EXECUTED. Its result is `AUTOMATED_PASS_MOUNTED_PENDING`; it is not mounted evidence.

## 3. Independent gate and evidence status

- Candidate freeze: CONFIRMED at `7e8bb397775dc37f411cc084173525fbb056bf15`.
- Gate C for this successor SHA: PENDING independent review.
- Gate C GO recorded for `405c2ac6258b5a0d669431a169f9c196b2a01e49`: does not transfer to this successor.
- Stage 8 mounted evidence: NOT EXECUTED for this SHA.
- Mounted-required D14 fields: 33 NOT_EXECUTED.
- Seven-artifact evidence set and evidence-only closure: NOT CREATED.
- Independent Final Review: PENDING.
- Tag/release, production promotion, and DNS cutover: NOT AUTHORIZED.

The external formal-runner checkout was not used to start a mounted run. Its current script and Compose configuration remain pinned to the earlier `405c2ac` candidate, and its explicit blocked-field guard plus incomplete successful-run cleanup/provenance mean it is not evidence that all 33 mounted fields are observable. No rehearsal, unit test, or partial live check is substituted for Stage 8 evidence.

Any finding requiring product, harness, or execution-semantics change invalidates this freeze and requires a new successor candidate and fresh candidate-bound qualification. Stage 8 may begin only after an independent Gate C GO names this exact SHA.
