# v0.6 Stage 6 Gate 4 Final Review — Mounted Live Evidence, Seven-Artifact Set & Closure

- Date: 2026-09-26
- Scope: Gate 4 Final Review (Stage 6 mounted live evidence, seven-artifact set, evidence-only closure)
- Branch: `release/v0.6.0-rc.1`
- Reviewed HEAD (closure commit): `74aea07d8c71eba4f84ab7fb555c25ae588c3ca7`
- Frozen candidate SHA: `e6a96eff2df7090b71f41e6c13335a0b607ebcf8`
- v0.5 accepted closure baseline: `bfcc541d84f3fc5fb3bb14fa54100276e41816ba`
- v0.6 construction authorization commit: `67484950226784d939687aa4634259fac7082804`
- Decision: **PASS WITH NON-BLOCKING FINDINGS** (P0 = 0, P1 = 0, P2 = 1, P3 = 3)

## Review Scope

Independent final acceptance and code review of the v0.6 Stage 6 evidence-only closure:

1. Ancestry / closure structure (single direct child of the frozen candidate);
2. Closure diff scope (evidence + attestation only);
3. Seven-artifact set completeness and mechanical SHA-256 / byte binding;
4. M24 (24-field) matrix PASS status across `mounted-runner-raw.json`, `two-node-mounted-smoke.json`, and `manifest.json`;
5. Node B inbound direct-ingress denial (`inboundDeniedProbe` = `connection-refused`);
6. Release attestation content, citations, self-reference discipline, and UNAUTHORIZED declarations;
7. Security / cleanliness (secret scan, `check-public-tree.mjs`, `git diff --check`, local=remote, residue);
8. Full regression (`npm run check`).

## Findings

### [P2] `backup-restore.json` test count is internally inconsistent (tests ≠ pass + fail + skipped)

`test/evidence/v06/backup-restore.json:15`

The artifact records `"tests": 6` while the same execution record carries `pass: 3`, `fail: 0`, `skipped: 2` (sum = 5). Reproducing the exact recorded invocation

```text
node --test "--test-name-pattern=(backup|restore preserves route mode|no live reverse session)" \
  test/registry-backup.test.mjs test/v05-stage1-pairing.test.mjs
```

yields `tests 5 / pass 3 / fail 0 / skipped 2` under both the spec and TAP reporters on the reviewed HEAD. The v0.5 counterpart (`test/evidence/v05/backup-restore.json`) recorded `tests: 5`, which was self-consistent.

Impact: a machine-generated, hash-bound evidence artifact overstates the executed test count by one, contradicting its own pass/fail/skipped fields. It does not change the acceptance conclusion (the two required test names are present and `fail: 0`), but it weakens the "evidence honesty" property the v0.6 SOP §2.4 relies on. Trigger: any reviewer or downstream consumer reconciling `tests` against `pass + fail + skipped` in this artifact.

Minimal fix direction: correct `"tests"` to `5` in `backup-restore.json` (and regenerate the manifest hash for that artifact + the attestation row), or record the exact reporter invocation whose `tests` equals 6.

### [P3] Attestation cites a Gate 1 review path that does not exist in any commit

`docs/release-attestations/v0.6.0-rc.1.md:36`

The attestation cites `docs/review/2026-09-25-v06-stage1-gate1-review-928c466.md`. No commit in the repository ever contained that path (`git rev-list --all` scan returns empty). The real Gate 1 record is `docs/review/review-v0.6-gate-1-pass-928c466-2026-09-25.md`, added by `e884131`. The referenced commit `e884131f` and the gate outcome are genuine; only the path is wrong.

Impact: the Gate 1 lineage link in the release attestation is not resolvable by a reader, weakening traceability of the successor-gate chain. Minimal fix: replace the path with the actual filename.

### [P3] Attestation cites a Gate C review path that resolves only on another branch, without naming that branch

`docs/release-attestations/v0.6.0-rc.1.md:40`

`docs/review/2026-09-26-v06-stage5-candidate-freeze-gatec-5a6fc10.md` is absent from the closure branch and from `HEAD`; it exists only on `chore/v0.6-stage5-candidate-freeze` (commit `b470dca`). The v0.5 precedent handled this by explicitly scoping such citations, e.g. "recorded on `chore/v0.5-stage2-public-machine-ingress`" (`docs/release-attestations/v0.5.0-rc.1.md:35`). The v0.6 attestation omits any branch qualifier, so the citation appears broken from the closure commit.

Impact: same traceability defect as above, for the Gate C authorizing record. Minimal fix: annotate the citation with the carrying branch (as v0.5 did), or copy the record into the closure lineage.

### [P3] Attestation cites the wrong SOP sections for the direct-child closure rule

`docs/release-attestations/v0.6.0-rc.1.md:42`

The attestation states "Per SOP §4 and §5, an evidence closure must be a single direct child of the frozen candidate commit". In `docs/sop/v0.6-multi-node-sessions-multistage-sop.md`, §4 is "Stage handoff format" (lines 160-181) and §5 is "Stop-work matrix" (lines 182-200); neither contains an evidence-only-closure or direct-child rule. The rule lives in the inherited v0.5 SOP §8.7 "Evidence-only closure" (`docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md:914`); the v0.5 attestation correctly cited "SOP 8.7". The v0.6 SOP itself only says "Direct-child closure commit on frozen candidate" (line 155) under Stage 6.

Impact: citation inaccuracy only; the direct-child property is independently verified true (see Verification). Minimal fix: cite v0.6 SOP Stage 6 and/or inherited v0.5 SOP §8.7.

### [P3] Seven-artifact set has no mechanical validator, and the v0.6 smoke artifact dropped the raw-evidence provenance binding

`test/evidence/v06/manifest.json` (whole set); `test/evidence/v06/two-node-mounted-smoke.json`

No test or script in the repository reads `test/evidence/v06/manifest.json` or the six content artifacts to verify SHA-256 / byte exactness. `grep` over `test/**.mjs` and `scripts/**.mjs` finds no consumer of the v06 evidence directory, and the closure adds no validator. The attestation's claim at line 61 ("All six content artifacts have been validated byte-exact against `test/evidence/v06/manifest.json`") therefore rests on out-of-band validation, not a repeatable in-repo check. (It is nonetheless independently true — see Verification.)

Separately, the inherited v0.5 SOP §8.4 requires `mounted-runner-raw.json` and `two-node-mounted-smoke.json` to agree on candidate, runId, node IDs, route modes, matrix, DSH identity, TLS fingerprints, browser provenance, and reverse transport provenance. In the v0.6 set, `mounted-runner-raw.json` carries only `kind/producer/success/cleanupComplete/candidateSha/runId/startedAt/matrix/steps` — it does not carry node IDs, route modes, DSH identity, TLS, browser, or reverse provenance at all, so cross-agreement on those fields is not satisfiable as written. The v0.5 smoke artifact additionally bound the raw file via `provenance.rawEvidenceSha256` / `rawEvidenceBytes`; the v0.6 smoke artifact has no `provenance` block, so the only remaining raw↔smoke binding is the manifest's two independent hashes.

Impact: limited — the substantive acceptance data is present in the smoke artifact and both files are hash-bound by the manifest — but the SOP's stated cross-artifact agreement property is not met and the evidence set is not guarded by any regression test. Minimal fix: add a small test that reads the manifest and asserts each artifact's SHA-256/bytes, and either restore the raw binding fields or narrow the SOP 8.4 agreement clause to what the v0.6 emitter actually produces.

## Verification

Executed on `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate` at HEAD `74aea07`.

| Check | Command / method | Result |
| --- | --- | --- |
| Closure ancestry | `git log -n 1 --format="%P" 74aea07` | Single parent, exactly `e6a96eff2df7090b71f41e6c13335a0b607ebcf8` — PASS |
| Closure diff scope | `git diff e6a96eff 74aea07 --name-status` | 8 files, all `A`: `docs/release-attestations/v0.6.0-rc.1.md` + `test/evidence/v06/**`; no product/harness/test code — PASS |
| Artifact hashes | `sha256sum` + `wc -c` vs `manifest.json` | All 6 files byte-exact (hash and bytes match) — PASS |
| Encoding | `grep -c '\r'`, `tail -c 1 \| xxd` | All 7 files LF-only, final newline `0a` — PASS |
| M24 raw matrix | 24 unique keys, all `PASS` | 24/24 PASS — PASS |
| M24 smoke matrix | 24 unique keys, all `PASS`; identical set to raw | 24/24 PASS — PASS |
| Manifest matrix block | `{fieldCount:24,PASS:24,FAIL:0,NOT_EXECUTED:0,BLOCKED:0}` | Consistent — PASS |
| M24 field definitions vs RFC-0013 | Scripted compare of RFC table to attestation table | 24 fields, 7 automated / 17 mounted, zero scope or name mismatch — PASS |
| Inbound denial | `two-node-mounted-smoke.json` `inboundDeniedProbe` | Node B, port 9445, `result: "connection-refused"` — PASS |
| Attestation content | grep/manual read | Candidate `e6a96eff…` cited (3×), runId `v06-formal-1790365200` (1×), 6 hashes+bytes listed, 24 fields listed, no self-SHA reference, four `UNAUTHORIZED` declarations present — PASS |
| M24 provenance binding | `sha256sum` of the cited report read from `chore/v0.6-stage5-candidate-freeze` | `b407741b…` / 6529 bytes — matches manifest — PASS |
| Secret scan | `grep -rniE` private keys/tokens/secrets over closure paths | No matches; only hashes, fingerprints, and loopback URL — PASS |
| Public tree | `node scripts/check-public-tree.mjs` | "Public-tree validation passed." exit 0 — PASS |
| Whitespace | `git diff --check` | Clean — PASS |
| Divergence / residue | `git status --porcelain`, `git rev-list --left-right --count origin/release/v0.6.0-rc.1...HEAD` | Clean tree, 0/0 divergence — PASS |
| Full regression | `npm run check` | **540 tests / 534 passed / 0 failed / 6 skipped**, exit 0 — PASS |

Note on the regression count: the review request stated 539 / 533. The observed values on the reviewed HEAD are 540 / 534 / 0 / 6, which is the expected consequence of the frozen candidate `e6a96eff` adding one test relative to its parent — the same correction already documented in the Gate C record. This is not a defect.

## Residual Risks

- The mounted run itself (two-node Docker topology, Node B reverse channel, TLS, Firefox/Selenium browser producer) cannot be re-executed in this review environment; the mounted PASS fields were reviewed as recorded, hash-bound evidence, not re-observed. **Unverified by re-execution.**
- The `tests: 6` inconsistency in `backup-restore.json` (P2) could not be reproduced from any invocation found; the value appears to be an emitter off-by-one whose exact origin was not located (no v0.6 producer script is present in this checkout — only the v0.5 `dsh-orbit-v05-formal-runner` exists, pinned to the v0.5 candidate SHA). The producer for this run is **not available for inspection**.
- Several attestation citations (P3 findings) resolve only on side branches; a future reader checking out only the closure lineage will not be able to follow them.
- No in-repo mechanical validator guards the v0.6 evidence set, so any post-hoc edit to the artifacts would be caught only by manual hash recomputation.

## Gate

**PASS WITH NON-BLOCKING FINDINGS**

Rationale: the closure is structurally correct (single direct child of the frozen candidate, evidence-only diff), the seven-artifact set is complete and byte-exact against the manifest, the M24 matrix is 24/24 PASS and internally consistent, Node B inbound denial is recorded as `connection-refused`, the attestation does not self-reference its future SHA and keeps release/promotion/DNS `UNAUTHORIZED`, security and cleanliness checks are green, and the full regression is 0-fail. No P0/P1 issue was found. The P2/P3 findings are evidence-precision and traceability defects that do not affect the acceptance conclusion.
