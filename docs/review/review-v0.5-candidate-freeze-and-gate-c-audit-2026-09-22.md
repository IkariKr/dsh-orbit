# DSH Orbit v0.5 Candidate Freeze and Gate C Audit Record

日期：2026-09-22
报告类型：candidate freeze confirmation + Gate C independent audit record

> 本记录依据 `docs/rfc/0012-reverse-connected-nodes.md` 与
> `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md` 编写。
> 本记录确认冻结一个 exact candidate SHA，但不授权执行 Stage 8 mounted evidence，
> 除非独立 Gate C review 给出 GO。

## 1. Candidate freeze confirmation

- Worktree：`dsh-orbit-v05-stage1`
- Branch：`chore/v0.5-stage2-public-machine-ingress`
- Frozen candidate SHA：`405c2ac6258b5a0d669431a169f9c196b2a01e49`
- Freeze time：2026-09-22
- Freeze decision：authoritative confirmation recorded here

Pre-freeze checks completed against the frozen SHA:

- `npm run check`：503 tests / 497 passed / 0 failed / 6 skipped; public-tree validation PASS
- Focused v0.5 + Stage 7 qualification suites：118 tests / 115 passed / 0 failed / 3 skipped
- `git diff --check`：PASS
- local=remote：`405c2ac6258b5a0d669431a169f9c196b2a01e49` == `405c2ac6258b5a0d669431a169f9c196b2a01e49`
- divergence：0/0
- worktree：clean
- ignored runtime residue scan：no data/secrets/backups/logs residue at freeze confirmation

The frozen candidate descends from the accepted v0.4 closure `9891ab8`,
the v0.5 construction authorization, the accepted Stage 0 design SHA
`5738c0ce6a4ec11bee62f9cfae44dd6463816768`, Gate A `402d8995`,
Gate B `d9490ac`, the Stage 5 acceptance `809bb8f`,
the Stage 6 acceptance `55cdd47`, and the Stage 7 qualification record `00844af`.

From the freeze point onward:

- no product, harness, or execution-semantics documentation change is permitted;
- only qualification/evidence changes are allowed;
- a real defect requiring a semantic change invalidates this candidate and requires a new candidate with fresh evidence.

This record supersedes the earlier Stage 7 record line that said candidate freeze was
`NOT AUTHORIZED / NOT EXECUTED`; that line described the state before this freeze
confirmation and is preserved as historical record, not as current status.

## 2. Candidate-bound automated qualification evidence

`docs/review/v05-d14-automated-qualification-405c2ac6258b5a0d669431a169f9c196b2a01e49.json`
is the tracked candidate-bound automated D14 qualification report:

- exact 48 RFC-0012 D14 fields;
- 15 automated-evidence fields marked PASS, bound to the named automated tests;
- 33 mounted-required fields remain NOT_EXECUTED;
- `result` is `AUTOMATED_PASS_MOUNTED_PENDING`, never a full PASS;
- `candidateSha` exactly equals the frozen candidate;
- shared matrix validator acceptance: PASS;
- no secret material, private keys, cookies, tokens, or raw session IDs.

## 3. Independent Gate C audit

An independent reviewer audited the frozen candidate `405c2ac6258b5a0d669431a169f9c196b2a01e49`.

Passing audit evidence:

- authorization ancestry：PASS
- full diff scope from v0.5 construction root：PASS (no 0.6/0.7 scope)
- RFC/SOP invariants：PASS by source inspection
- D14 matrix shape and candidate binding：PASS
- recorded full/tests and hygiene：PASS
- no new route/selector architecture, no generic tunnel/fleet/RPC/multiplex/failover, no TLS bypass

Independent Gate C findings:

- [P1] Authoritative candidate-freeze status was not established by the prior stage record; resolved by this record.
- [P2] A D14 qualification document physically present under ignored runtime data conflicted with the recorded hygiene claim; resolved by moving the document to tracked review evidence.

### Gate C disposition

```text
VERDICT: HOLD
P0/P1/P2/P3: 0/1/1/0 (both items remediated by this record)
Candidate freeze: CONFIRMED at 405c2ac6258b5a0d669431a169f9c196b2a01e49
Gate C authorization: NOT GRANTED
Stage 8 mounted evidence: NOT AUTHORIZED / NOT EXECUTED
```

The exact candidate remains available for the required re-review after these
governance remediations. Gate C GO requires a fresh independent review of the
frozen SHA; this record does not and cannot grant it.