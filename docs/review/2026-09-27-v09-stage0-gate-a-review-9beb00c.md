# Gate A Architecture & Governance Review Report: Stage 0 of v0.9

**Target Repository**: `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate`  
**Active Branch**: `chore/v0.9-stage0-rfc-sop`  
**Target Commit**: `9beb00cdd8a6716cfb5bd3a14ac70bcfcea8ffa9` (`9beb00c`)  
**Base Commit**: `bd2cf9be8030773d2b4df6cd755fa5cda168f9c7` (`bd2cf9b`, `chore/v0.9-construction-authorization`)  
**Accepted Baseline**: `c15ca5865f1519fccbb277f2a440c3b1496e1bb9` (`c15ca58`, `v0.8.0-rc.1` release closure)  
**Governing Authorization**: `V09-CONSTRUCTION-20260927-A1`  
**Review Type**: Independent, Adversarial, and Rigorous Stage 0 / Gate A Review  
**Reviewer Role**: Independent Code Reviewer (`@code-reviewer2`)  
**Date**: 2026-09-27  

---

## 1. Executive Summary & Gate A Verdict

An independent and adversarial Gate A architecture review was conducted on the Stage 0 deliverables for v0.9 on branch `chore/v0.9-stage0-rfc-sop` at commit `9beb00c`.

The review evaluated:
1. **RFC-0016** (`docs/rfc/0016-dsh-plugin-integration-and-qr-pairing.md`), covering technical designs D1 through D6 and the mandatory Orbit security invariants.
2. **Multistage SOP** (`docs/sop/v0.9-dsh-plugin-and-qr-pairing-multistage-sop.md`), covering Stage 0 through Stage 6 and Gates A, 1, 2, B, 3, C, 4.
3. **M36 Acceptance Matrix** (`scripts/v09-plugin-qr-acceptance-matrix.mjs`), covering 36 canonical fields (17 automated + 19 mounted) and qualification report generation.
4. **Governance Contract Tests** (`test/v09-governance-contract.test.mjs`), validating git ancestry, lineage anchors, and matrix assertions.
5. **Code Cleanliness & Hygiene**, verifying `node scripts/check-public-tree.mjs`, `git diff --check`, and ensuring zero product runtime code exists in `src/**`, `ui/**`, `bin/**`, or `lib/**` prior to Gate A approval.

### Gate A Verdict: GO / PASS

| Severity | Count | Threshold for GO | Status |
|:---|:---:|:---|:---|
| **P0 (Blocker)** | 0 | 0 | **PASS** |
| **P1 (Critical)** | 0 | 0 | **PASS** |
| **P2 (Major)** | 0 | 0 | **PASS** |
| **P3 (Minor / Hygiene)** | 2 | Advisory | **OBSERVED (Non-blocking)** |

**Decision**: Gate A is approved (**GO / PASS**). Stage 1 Cordis packaging and settings service persistence implementation is authorized to commence.

---

## 2. Lineage, Ancestry & Scope Enforcement

1. **Lineage Ancestry**:
   - `git merge-base --is-ancestor c15ca5865f1519fccbb277f2a440c3b1496e1bb9 9beb00c` confirmed that commit `9beb00c` descends directly from the accepted v0.8 engineering closure `c15ca58`.
   - Direct parent lineage graph:
     `c15ca58` (v0.8 closure) -> `2754f86` (v0.8 final review) -> `bd2cf9b` (v0.9 construction authorization) -> `9beb00c` (Stage 0 RFC & SOP).
2. **Scope Enforcement**:
   - The files modified between `bd2cf9b` and `9beb00c` are strictly confined to documentation, matrix definitions, and governance contract tests:
     - `docs/research/2026-09-27-dsh-plugin-registration-and-qr-pairing-analysis.md`
     - `docs/rfc/0016-dsh-plugin-integration-and-qr-pairing.md`
     - `docs/sop/v0.9-dsh-plugin-and-qr-pairing-multistage-sop.md`
     - `scripts/v09-plugin-qr-acceptance-matrix.mjs`
     - `test/v09-governance-contract.test.mjs`
   - Zero runtime code exists in `src/**`, `ui/**`, `bin/**`, or `lib/**`.

---

## 3. Evaluation of Scope 1: RFC-0016 Technical Design & Security Invariants

### 3.1 Design Items D1 through D6

- **D1 (Cordis Plugin Packaging & Metadata Standards)**:
  - `package.json` specifications declare keywords `["dsh", "dsh-plugin", "cordis-plugin", "orbit"]`.
  - Export map defines entry points for server runtime (`.`), client UI bundle (`./client`), and patch metadata (`./cordis.patch.yml`).
  - DSH manifest declares bundle patch (`cordis.patch.yml`) and client service injection (`@deepseek-ai/dsh-client-ui-settings`).
  - Module exports `export const name = 'dsh-orbit'` and top-level dependency declaration `export const inject = ['webServer', 'settings']` prior to `export function apply(ctx)`.
  - Clear architectural demarcation is established: local DSH Node health route `GET /api/orbit/node-status` mounts on `ctx.webServer`, segregated from Hub endpoints.
- **D2 (Settings Service Persistence Binding)**:
  - Configuration binds reactive state to `~/.dsh/settings.yaml` under namespace `dsh-orbit` via `ctx.get('settings').register()`.
  - Implements bidirectional synchronization: initial load (`scope.get()`), external change detection (`scope.watch()`), and atomic mutations (`settingsService.mutate()`).
- **D3 (Ephemeral QR Pairing Protocol & Hub Verification)**:
  - `PairingCodeManager` (`src/registry/pairing-code.mjs`) generates 6-digit random codes (`100000` to `999999`) using `crypto.randomInt`.
  - TTL is bounded to 300 seconds (5 minutes).
  - Anti-replay destruction: Codes are deleted immediately upon the first verification attempt.
  - Endpoints in `src/registry/server.mjs`:
    - `POST /hub/pairing/generate-code` (requires authenticated operator session; returns code, TTL, and verified TLS QR link);
    - `POST /hub/pairing/verify` (rate-limited public endpoint; consumes code, issues authenticated session, sets HttpOnly cookie);
    - `GET /hub/pairing/status` (reports network route state, verified TLS host, and active session metrics);
    - `GET /hub/pairing/events` (SSE real-time stream).
  - Fail-closed brute-force mitigation: 5 failed attempts per client IP trigger a 15-minute 429 lockout.
- **D4 (DSH Desktop Settings UI Slot Injection & Inline SVG QR)**:
  - Injects into DSH settings slot `slots.inject('settings.section')` with label "Orbit Remote & Fleet" (`id: 'orbit-fleet'`, `order: 140`).
  - Implements zero-dependency inline vector `<svg>` QR generator (`generateQrSvg`) running purely in client-side JavaScript without third-party APIs or CDN requests.
  - Enforces verified TLS URLs in the QR code payload (`https://...`).
- **D5 (Server-Sent Events Pipeline)**:
  - Streams real-time connection events (`device-connected`, `node-paired`, `session-revoked`) via `GET /hub/pairing/events`.
  - Includes a periodic `: ping\n\n` heartbeat (25s interval) to prevent reverse proxy dropouts.
  - Client UI updates session tables live without requiring full page reload.
- **D6 (M36 Acceptance Matrix Specification)**:
  - Extends RFC-0015 M32 (32 fields) to 36 canonical fields:
    - Field 33: `dshPluginCordisRegistration` (automated)
    - Field 34: `dshSettingsNamespacePersistence` (automated)
    - Field 35: `dshNativeSettingsSlotInjection` (mounted)
    - Field 36: `qrPairingBootstrapAndExchange` (mounted)

### 3.2 Security Invariants & Threat Modeling

1. **Strict Operator Session vs Node Identity Separation**:
   - RFC-0016 Section 1 and Section 4 enforce that QR code verification authenticates an operator session (`sessionToken`), not an enrolled DSH machine node. Machine nodes maintain immutable Ed25519 keypairs (`nodeId`) per RFC-0001/RFC-0012. Scanning a QR code cannot obtain machine execution authority.
2. **Prohibition of Virtual Loopback / Host-Origin Rewriting**:
   - RFC-0016 forbids spoofing or rewriting `Host`, `Origin`, `Sec-Fetch-Site`, or `socket.remoteAddress` to `127.0.0.1`. Genuine authority boundaries and DNS rebinding protections are preserved.
3. **Strict Transport Security (Verified TLS Invariant)**:
   - All pairing exchanges, API communications, and QR links must use verified TLS (`https://...`). Insecure HTTP with client-side RSA padding is strictly forbidden across all network boundaries.
4. **Single-Use 5-Minute Pairing Codes & Anti-Replay**:
   - Pairing codes are 6-digit random values with a maximum TTL of 300 seconds. Immediate deletion occurs on the first lookup in `verifyCode()`, preventing replay attacks.
5. **Brute-Force & Denial-of-Service Defense**:
   - 6-digit space represents $10^6$ combinations. Rate limiting (5 attempts per 15 minutes) bounds brute-force probability to $5 \times 10^{-6}$ during the lifetime of a code.
6. **Clean Seam DSH Integration**:
   - Integration operates exclusively through official DSH extension hooks (`slots.inject` and `settings` service). Monkey-patching of DSH core authentication or internal services is strictly barred.

---

## 4. Evaluation of Scope 2: Multistage SOP Alignment

The Multistage SOP (`docs/sop/v0.9-dsh-plugin-and-qr-pairing-multistage-sop.md`) was reviewed against RFC-0016:

1. **Stage and Gate Coherence**:
   - Stage 0 (Architecture & Governance) -> **Gate A** (RFC-0016, SOP, M36 Matrix, Governance Tests).
   - Stage 1 (Cordis Plugin & Settings Persistence) -> **Gate 1** (Plugin packaging, entry lifecycle, settings service).
   - Stage 2 (QR Pairing Protocol & Hub Endpoints) -> **Gate 2** (Code manager, Hub pairing routes, SSE).
   - Stage 3 (DSH Native Settings UI Injection) -> **Gate B** (UI slot injection, inline SVG QR, client pairing).
   - Stage 4 (Resilience, Rate Limiting & Zero-Leak Security) -> **Gate 3** (IP lockout, anti-replay, negative security).
   - Stage 5 (Candidate Freeze & Automated Qualification) -> **Gate C** (17 automated fields PASS, 19 mounted fields NOT_EXECUTED).
   - Stage 6 (Mounted Live Evidence, Seven-Artifact Set & Closure) -> **Gate 4 Final Review** (all 36 fields PASS, canonical seven-artifact release package).
2. **Stop-Work Matrix**:
   - Section 6 codifies explicit stop-work triggers for virtual loopback, session/node conflation, unencrypted HTTP, code TTL violations, credential leakage in QR, DSH monkey-patching, and mounted field execution during Stage 5 qualification.
3. **Stage Handoff Standard**:
   - Section 5 defines mandatory metadata for stage transitions (HEAD, parent baseline, branch, divergence, tests, tree check, diff check, worktree status, and independent review verdict).

---

## 5. Evaluation of Scope 3: M36 Acceptance Matrix Verification

The matrix implementation in `scripts/v09-plugin-qr-acceptance-matrix.mjs` was mechanically validated:

1. **Field Partitioning**:
   - Total Fields: **36 canonical fields** (verified via `M36_MATRIX_FIELDS.length === 36`).
   - Automated Fields: **17 automated fields** (`minimumEvidence === 'automated'`).
   - Mounted Fields: **19 mounted fields** (`minimumEvidence === 'mounted'`).
2. **Field Breakdown**:
   - **Inherited M32 Fields (1–32)**:
     - Automated (15): `fleetJobListObservability`, `fleetJobTargetSpecExplicitList`, `fleetJobTargetSpecEmptyRejected`, `fleetJobWildcardWithoutFilterDenied`, `capabilityAwareSchedulingMatching`, `capabilityAwareSchedulingStaleSkipped`, `fleetJobAggregatedResultsComplete`, `fleetJobAuditLogRecorded`, `fleetJobSingleNodeTimeoutContainment`, `operatorUiFleetWorkflowsView`, `fleetJobDuplicateIdempotent`, `auditLogQueryFiltering`, `noImplicitBroadcastExecution`, `scheduledWorkflowDefinitionPersistence`, `scheduledWorkflowCronAndIntervalParsing`.
     - Mounted (17): `concurrentFleetJobExecution`, `fleetTaskExecutionDirectNode`, `fleetTaskExecutionReverseNode`, `concurrentTaskDispatchDirectAndReverse`, `fleetTaskResultAggregationDirectAndReverse`, `targetNodeOutageDuringJobExecution`, `reverseNodeDisconnectDuringJobExecution`, `fleetJobLargeOutputAggregation`, `fleetJobStreamingProgressEvents`, `capabilityMismatchNodeFiltered`, `tombstonedNodeTargetRejected`, `hubRestartPendingJobReconciliation`, `nodeRestartDuringFleetJob`, `fleetJobCancellation`, `zeroCrossNodeCredentialLeakInJob`, `scheduledWorkflowAutomatedDispatch`, `scheduledWorkflowLifecycleAndAudit`.
   - **v0.9 New Plugin & QR Fields (33–36)**:
     - Field 33: `dshPluginCordisRegistration` (automated).
     - Field 34: `dshSettingsNamespacePersistence` (automated).
     - Field 35: `dshNativeSettingsSlotInjection` (mounted).
     - Field 36: `qrPairingBootstrapAndExchange` (mounted).
3. **Assertion & Report Verification**:
   - `emptyM36Matrix()` generates 36 fields with initial status `NOT_EXECUTED`.
   - `generateM36AutomatedQualificationMatrix()` generates 17 automated `PASS` fields and 19 mounted `NOT_EXECUTED` fields.
   - `assertM36MatrixShape()` enforces exact field count, recognized statuses, and scope integrity.
   - `generateCandidateBoundAutomatedReport()` and `validateCandidateBoundReport()` validate candidate SHA binding, run ID, and matrix structure.
   - Negative assertions verified: Invalid candidate SHA formats, unexpected field keys, and premature mounted PASS claims in automated scope fail closed.

---

## 6. Evaluation of Scope 4 & 5: Tests, Public Tree, and Cleanliness

1. **Governance Contract Tests**:
   - Executed `node --test test/v09-governance-contract.test.mjs`:
     - Test 1: v0.9 construction package is anchored to accepted v0.8 closure (PASS).
     - Test 2: v0.9 construction authorization lineage is valid in git history (PASS).
     - Test 3: RFC-0016 M36 acceptance matrix defines exactly 36 canonical fields (PASS).
     - Test 4: RFC-0016 M36 matrix assertions and report generation work correctly (PASS).
     - Result: 4 passing tests, 0 failures, duration 186ms.
2. **Full Repository Regression Suite**:
   - Executed `npm test`:
     - Total tests: 602.
     - Passed: 596.
     - Skipped: 6 (mounted fixtures requiring external services).
     - Failed: 0.
3. **Public Tree Check**:
   - Executed `node scripts/check-public-tree.mjs`:
     - Result: `Public-tree validation passed.`
4. **Pre-Gate-A Runtime Code Prohibition**:
   - Verified that zero runtime code was added or modified in `src/**`, `ui/**`, `bin/**`, or `lib/**` in commit `9beb00c` and across the entire diff from `c15ca58`.

---

## 7. Defect Classification & Observations

### P0 (Blocker) - None
None identified.

### P1 (Critical) - None
None identified.

### P2 (Major) - None
None identified.

### P3 (Minor / Hygiene - Advisory) - 2 Observations

- **Finding F-A01 (P3 - Advisory)**: Trailing whitespace in research document.
  - **Location**: `docs/research/2026-09-27-dsh-plugin-registration-and-qr-pairing-analysis.md` (lines 3, 4, 95, 269, 270).
  - **Impact**: Non-blocking. Does not affect runtime, tests, or RFC specifications. Cleaned up in follow-up commit.
- **Finding F-A02 (P3 - Advisory)**: Working directory cleanup.
  - **Impact**: Cleaned and reconciled with git index.

---

## 8. Final Gate A Review Verdict & Authorization

All gating requirements for Stage 0 of v0.9 under `V09-CONSTRUCTION-20260927-A1` are met.

- **Gate A Review Verdict**: **GO / PASS**
- **Defect Counts**: P0 = 0, P1 = 0, P2 = 0, P3 = 2 (advisory).
- **Authorized Next Step**: Construction may proceed to **Stage 1 (Cordis Plugin Packaging & Settings Persistence Model)** on branch `chore/v0.9-stage1-cordis-settings`. No product code may bypass Stage 1 / Gate 1 review.
