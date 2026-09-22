# DSH Orbit v0.5 Stage 7 Qualification Preparation Record

日期：2026-09-22
报告类型：Stage 7 local hardening / qualification preparation record

> 本记录对照 `docs/rfc/0012-reverse-connected-nodes.md` 与
> `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md` 编写。
> 本记录不是 candidate freeze，不是 Gate C GO，不授权 Stage 8 mounted evidence。

## 1. Provenance and gate boundary

- Worktree：`dsh-orbit-v05-stage1`
- Branch：`chore/v0.5-stage2-public-machine-ingress`
- Stage 6 accepted implementation/review baseline：`55cdd473ef2c0f4b0c8d7a9c9f904874bffba160`
- Stage 7 qualification implementation commit：`18de37b`
- Stage 7 implementation scope：qualification harness and local hardening contract tests only
- Independent review target：`18de37b`
- Independent re-review verdict：**PASS**
- Independent re-review findings：P0=0, P1=0, P2=0, P3=0
- Stage 7 local qualification preparation：**COMPLETE — locally verified**
- Candidate freeze：**NOT AUTHORIZED / NOT EXECUTED**
- Gate C：**NOT REACHED / NOT AUTHORIZED**
- Stage 8 mounted evidence：**NOT AUTHORIZED / NOT EXECUTED**

The implementation does not change the v0.5 architecture invariants:

- `routeMode = direct | reverse`; no `auto` mode;
- reverse remains an RFC-0010 route-authority transport;
- one reverse control connection plus a bounded data-channel pool;
- one data channel carries one browser flow; no multiplexing;
- no automatic direct/reverse failover;
- no command queue on the reverse control channel;
- no public `/api/v1/enroll` exposure;
- TLS verification remains enabled;
- no new route authority, selector architecture, compatibility profile, generic tunnel, VPN, service mesh, remote shell, fleet RPC, or multi-node control surface.

## 2. Stage 7 implementation

### 2.1 Shared RFC-0012 D14 matrix

Added harness-only `scripts/v05-reverse-acceptance-matrix.mjs` as the shared source for the exact RFC-0012 D14 matrix:

- exactly 48 field definitions in RFC order;
- each field is bound to `minimumEvidence: automated | mounted`;
- 33 mounted-required fields are derived from the shared definitions;
- field uniqueness, exact key shape, and allowed evidence states are checked;
- empty matrices contain `NOT_EXECUTED` for every field;
- allowed states are exactly `PASS`, `FAIL`, `NOT_EXECUTED`, and `BLOCKED`;
- candidate bindings require a complete lowercase 40-hex SHA;
- candidate-bound reports reject missing/extra fields, invalid states, missing matrix, missing/invalid candidate SHA, and candidate SHA mismatch;
- `requirePass` rejects every non-`PASS` field;
- mounted scope requires every mounted-required field to be `PASS`;
- explicit `null` or unknown scope values fail closed rather than defaulting to automated scope.

`test/v05-governance-contract.test.mjs` now consumes the shared field source instead of carrying a second 48-field array.

### 2.2 Local Stage 7 hardening contracts

Added `test/v05-stage7-contract-gaps.test.mjs` with bounded local/in-process coverage for:

- malformed control frames and unmasked client frames;
- malformed `OPEN` and oversized text/binary channel messages;
- duplicate and late abort cleanup without double release or channel revival;
- reverse channel loss remaining independent from fresh registry heartbeat contact;
- stale heartbeat contact remaining independent from an online reverse session;
- delete cleanup of session generation and bound channels;
- backup/restore creating a fresh Registry without restoring process-local reverse sessions;
- credential, cookie, token, private-key, and reverse-session identifier non-disclosure in captured output;
- explicit skipped marker for mounted/production Stage 7 drill.

The existing Stage 7 hardening, migration, backup/restore, maintenance, TLS, gateway, and configuration suites remain in the focused qualification run. No product runtime source was changed by this Stage 7 qualification delta.

## 3. Verification

### D14 and local gap contracts

```text
node --test \
  test/v05-d14-matrix-contract.test.mjs \
  test/v05-governance-contract.test.mjs \
  test/v05-stage7-contract-gaps.test.mjs

19 passed / 0 failed / 1 skipped
```

The one skipped test is the explicit `NOT_EXECUTED` mounted/production Stage 7 drill marker.

### Stage 7 qualification focused suite

```text
node --test \
  test/stage7-hardening.test.mjs \
  test/registry-stage7-contract.test.mjs \
  test/registry-backup.test.mjs \
  test/registry-sqlite.test.mjs \
  test/registry-maintenance.test.mjs \
  test/hub-cli.test.mjs \
  test/registry-gateway-e2e.test.mjs \
  test/registry-config.test.mjs \
  test/v05-d14-matrix-contract.test.mjs \
  test/v05-governance-contract.test.mjs \
  test/v05-stage7-contract-gaps.test.mjs

84 passed / 0 failed / 3 skipped
```

### Full repository verification

```text
npm run check
public-tree validation: PASS
tests: 503
pass: 497
fail: 0
skipped: 6
exit: 0
```

The six skipped cases are existing platform/environment-gated cases, including Windows/POSIX permission behavior and unavailable external acceptance conditions. No test failed.

Additional checks:

- `git diff --check`: PASS
- `git diff --cached --check`: PASS before commit
- ignored `data/**`, `secrets/**`, `backups/**`, and `logs/**` residue scan: no findings
- public-tree/secret scan: PASS
- no mounted evidence artifact was created or modified

## 4. Independent review disposition

The independent review first identified one P1: explicit `scope: null` was silently treated as automated scope by the D14 validator. The remediation changed defaulting to apply only when `scope === undefined` and added regression tests for `null` and unknown scopes.

The independent re-review of exact commit `18de37b` concluded:

```text
PASS
P0 = 0
P1 = 0
P2 = 0
P3 = 0
```

The reviewer independently confirmed:

- the P1 is closed;
- the D14 shape and minimum-evidence contract is exact;
- candidate SHA and matrix validation fail closed;
- mounted-required fields cannot be bypassed by `NOT_EXECUTED` or invalid scope;
- local tests do not claim mounted evidence;
- no candidate freeze, Gate C, or Stage 8 boundary was crossed.

This is an implementation review, not Gate C candidate authorization.

## 5. NOT_EXECUTED / outside this gate

The following remain explicitly **NOT_EXECUTED** and are not relabeled PASS:

- one candidate-bound final D14 report with all automated fields populated;
- candidate-bound mounted evidence manifest under `test/evidence/v05/`;
- a frozen candidate SHA;
- the full pre-freeze clean/pushed candidate gate as a freeze decision;
- Gate C independent candidate review;
- mounted two-node production evidence;
- external/mounted reverse credential rotation, delete-during-flow, and same-node reenrollment evidence;
- release tag, production promotion, DNS/publication;
- Stage 8 canonical artifact set and final review.

Historical v0.4 evidence is not rebound to this v0.5 qualification record.

## 6. Disposition

```text
Stage 7 local hardening / qualification preparation: COMPLETE — locally verified
D14 shared matrix and validator: COMPLETE — independently re-reviewed
P0/P1/P2/P3 after re-review: 0/0/0/0
Candidate freeze: NOT AUTHORIZED / NOT EXECUTED
Gate C: NOT REACHED / NOT AUTHORIZED
Stage 8: NOT AUTHORIZED / NOT EXECUTED
```

施工在 candidate freeze 前停止。下一项需要独立授权的是 candidate-bound pre-freeze review / Gate C；不得将本记录或 `18de37b` 重新标记为 Gate C GO 或 Stage 8 mounted evidence authorization。
