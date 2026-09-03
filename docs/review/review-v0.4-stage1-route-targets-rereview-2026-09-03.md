# DSH Orbit v0.4 Endpoint Selector Stage 1 Narrow Re-review

Date: 2026-09-03

Review target:

- Branch: `feat/v0.4-stage1-route-targets`
- Construction base: `7b3960fb4fbacbe572a67b421f0920dcce2471db`
- Remediated implementation HEAD: `05188495bc6558d15073c4231dbfdc1feed5d31c`
- Contractor evidence-closure HEAD reviewed: `8c2a9b70f4c2d0986cabd926ac3156a54b6608f9`
- Previous review: `docs/review/review-v0.4-stage1-route-targets-2026-09-03.md`

## Verdict

**PASS — Stage 1 accepted. Stage 2 may begin under a separate construction instruction.**

Severity summary after re-review:

- P0: 0
- P1: 0
- P2: 0
- P3: 0 blocking

The two HOLD findings from the initial review are closed. No Stage 2 implementation was found in the reviewed contractor tree.

## Re-review scope

This was intentionally a narrow re-review of the initial HOLD findings plus regression checks around the changed surface. It did not trust the contractor remediation report as evidence.

Reviewed independently:

- actual diff `570651d..8c2a9b7`;
- final route-target method/path dispatcher;
- negative method/action tests and audit non-mutation checks;
- tombstoned-node UI behavior;
- remote branch provenance;
- Stage 1 evidence document;
- focused Stage 1/schema/UI tests;
- full repository gate;
- absence of Stage 2+ implementation.

## Previous findings

### P2-1 — contradictory method/action combinations

**CLOSED.**

The management surface is now the small exact contract:

```text
GET    /hub/nodes/:nodeId/route-target
PUT    /hub/nodes/:nodeId/route-target
DELETE /hub/nodes/:nodeId/route-target
```

The old `/set`, `/remove`, and POST aliases are gone. Unsupported exact-route methods return 405; unsupported action/path variants return 404. Dedicated tests prove every reviewed negative combination leaves both route-target state and route-target audit count unchanged.

### P2-2 — remote branch provenance

**CLOSED.**

Independent remote check:

```text
origin/feat/v0.4-stage1-route-targets
= 8c2a9b70f4c2d0986cabd926ac3156a54b6608f9
```

This matched the local contractor evidence-closure HEAD at re-review time.

### P3-1 — tombstoned node UI mutation controls

**CLOSED.**

Tombstoned node detail renders Route Target read-only and suppresses save/remove controls. DOM coverage verifies the behavior. This is a UI cleanup only; backend authorization/state semantics remain unchanged.

## Additional re-review observations

No new implementation blocker was found. Two evidence-hygiene issues were corrected during review:

1. the changed-files section still described the superseded POST route-target alias even though the actual implementation had removed it;
2. the evidence did not explicitly distinguish the remediated implementation commit from the later evidence-closure commit.

These are documentation/provenance corrections only. No product code change was required by this re-review.

The architecture documents were also moved from Proposed to Accepted/Active status because Stage 1 had already been constructed and independently accepted against the architecture-remediation baseline `7b3960f`. This removes an internal governance contradiction before Stage 2 begins; it does not alter the v0.3 release contract.

## Verification

Focused verification:

```text
node --test \
  test/registry-route-target.test.mjs \
  test/registry-sqlite.test.mjs \
  test/ui-dom.test.mjs \
  test/ui-view-model.test.mjs
```

Result:

- tests: 38
- pass: 38
- fail: 0
- skipped: 0

Full repository verification:

```text
npm run check
```

Result:

- tests: 313
- pass: 309
- fail: 0
- skipped: 4 Windows/POSIX environment-specific tests
- public-tree validation: PASS
- `git diff --check`: PASS

Remote provenance:

```text
git ls-remote --heads origin feat/v0.4-stage1-route-targets
8c2a9b70f4c2d0986cabd926ac3156a54b6608f9
```

## Stage 1 gate matrix

| Gate | Result |
| --- | --- |
| v3 → v4 migration | PASS |
| Existing Registry state retained | PASS |
| Reachable domain prepared | PASS |
| Stage 1 business state remains `reachable = unknown` | PASS |
| Zero/one route target per node | PASS |
| Operator GET/PUT/DELETE contract | PASS |
| Unsupported method/action matrix fail-closed | PASS |
| Auth / Origin / CSRF | PASS |
| Node cannot self-set target | PASS |
| Target validation | PASS |
| A/B isolation | PASS |
| Hub restart persistence | PASS |
| Backup / restore | PASS |
| Audit attribution | PASS |
| Tombstoned-node UI read-only | PASS |
| Stage 2+ implementation absent | PASS |
| Full regression | PASS |
| Remote provenance | PASS |

## Final disposition

**Stage 1 is accepted and closed.**

Stage 2 is authorized only under a dedicated construction instruction. Stage 3 is not implicitly authorized by this verdict. The Stage 2 contractor must stop after its own completion report and wait for independent review.
