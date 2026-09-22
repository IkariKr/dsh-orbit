# DSH Orbit v0.5 Stage 8 Mounted Position Record

日期：2026-09-23
记录类型：evidence-only mounted disposition record

> 本记录依据 `docs/rfc/0012-reverse-connected-nodes.md` 与
> `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md` 编写。
> 本记录不修改 harness，不产生 mounted PASS，不授权 release tag / promotion / DNS。

## 1. Position

- Frozen candidate SHA：`405c2ac6258b5a0d669431a169f9c196b2a01e49`
- Gate C verdict：**GO**（`docs/review/review-v0.5-gate-c-rereview-2026-09-23-e6cb335.md`）
- Stage 8 mounted evidence：**NOT EXECUTED — operator/external responsibility**
- Harness modification：**out of scope — not performed**
- Final Review：**PENDING** — cannot run until mounted evidence exists

## 2. Why mounted evidence is not executable from this session

The mounted runner inside the frozen candidate
(`scripts/registry-drill.mjs` with `scripts/stage8-mounted-matrix.mjs`)
is the v0.4 two-node **direct** topology runner:

- its `requiredMatrix` contains exactly 25 fields, all direct-node A/B behaviors
  (route targets, eligibility, selector, HTTP/WS on direct authorities,
  gateway/Hub restart, outage, delete/reenroll);
- it never sets a node to `routeMode: reverse`, never establishes a reverse
  control session / data-channel pool, and never proves an inbound-deny path
  for a reverse-only Node B;
- of the 33 D14 mounted-required fields, 32 cannot be produced by this runner
  (reverse control, reverse HTTP/WS/streaming, cookie isolation on reverse,
  takeover/reconnect/restart races, DSH loss/recovery on reverse,
  no-implicit-fallback, credential rotation, delete during flow,
  reenroll fresh Hub route identity, selector reverse eligibility, etc.).

D15 requires a canonical topology with Node A as direct regression and
Node B as demonstrably reverse-only. The frozen runner cannot satisfy D15,
therefore a truthful mounted PASS cannot be produced by this session.

## 3. Boundary decision

- No product/harness change was made to retrofit the runner; that would
  invalidate the frozen candidate and is outside this record's scope.
- The mounted run and its 33-field evidence are an operator/external-mounted
  responsibility using a reverse-capable runner against the exact frozen
  candidate SHA, with tools and checkerboards already recorded in the
  repository (drill certificates, compose topology, browser bridge contract).
- Nothing in this record relabels `NOT_EXECUTED` as PASS.

## 4. Current disposition

```text
Candidate freeze: CONFIRMED at 405c2ac6258b5a0d669431a169f9c196b2a01e49
Gate C: GO (mounted evidence authorized for the exact frozen SHA)
Stage 8 mounted evidence: NOT EXECUTED (operator/external responsibility)
D14 mounted-required fields (33): NOT_EXECUTED
D14 automated fields (15): PASS (candidate-bound report)
Final Review: PENDING
Release tag / promotion / DNS: NOT AUTHORIZED
```