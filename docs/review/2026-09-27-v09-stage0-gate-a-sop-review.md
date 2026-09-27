# Gate A Architecture & SOP Re-Review Report (Round 2)

**Review Target**: `docs/sop/v0.9-dsh-plugin-and-qr-pairing-multistage-sop.md`  
**Absolute File Paths**:  
- `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate\docs\sop\v0.9-dsh-plugin-and-qr-pairing-multistage-sop.md`  
- `D:\App\01_Ai\CodeX\dsh-orbit\docs\sop\v0.9-dsh-plugin-and-qr-pairing-multistage-sop.md`  
**Review Type**: Independent Adversarial Architecture Review (Gate A Re-Review, Round 2)  
**Reviewer Role**: Independent Code Reviewer (`@code-reviewer2`)  
**Authorization Baseline**: `c15ca5865f1519fccbb277f2a440c3b1496e1bb9` (Accepted v0.8 Engineering Closure)  
**Target Version**: `0.9.0-rc.1`  

---

## 1. Executive Summary & Gate Verdict

In Round 1 of the Gate A Review, the SOP received a verdict of **NO-GO / FAIL** due to one P1 finding, three P2 findings, and three P3 findings (F-01 through F-07).

A re-audit of the remediated SOP in both project locations was conducted. All seven findings (F-01 through F-07) have been addressed with exact architectural demarcations, verified cryptographic commitments, strict transport security requirements, and stop-work safeguards. The M36 acceptance matrix partitioning (17 automated + 19 mounted = 36 total fields) is consistent with the inherited baseline and Stage 5/6 qualification scopes. Core Orbit security boundaries (no virtual loopback, mandatory TLS, strict operator session vs node identity separation, and 5-minute ephemeral pairing codes) are fully preserved.

### Gate Verdict: GO / PASS

| Severity | Count | Status |
|:---|:---:|:---|
| **P0 (Blocker)** | 0 | None identified |
| **P1 (Critical)** | 0 | Remediated (F-01 resolved) |
| **P2 (Major)** | 0 | Remediated (F-02, F-03, F-04 resolved) |
| **P3 (Minor)** | 0 | Remediated (F-05, F-06, F-07 resolved) |

The SOP is authorized to pass Gate A. Product code implementation remains prohibited until RFC-0016 and the Stage 0 governance test suite are committed to baseline.

---

## 2. Status of Previous Findings (Round 1 Audit)

### F-01 (P1): Corrupted / Phantom v0.8 Baseline Commit SHA
- **Initial Finding**: The SOP referenced a phantom commit SHA (`c15ca581eb033a258832a76f2bc8a7f45778fc39`) that did not exist in the repository commit graph, breaking lineage validation.
- **Verification**: Lines 8 and 80 of the remediated SOP were inspected. The baseline SHA is updated to `c15ca5865f1519fccbb277f2a440c3b1496e1bb9`. Git verification confirmed this commit exists in the repository as the Stage 6 release closure for v0.8.0-rc.1:
  `c15ca58 docs(release): record mechanically verified v0.8.0-rc.1 mounted evidence and seven-artifact set (Stage 6 closure)`.
- **Status**: **RESOLVED (PASS)**

---

### F-02 (P2): Unspecified QR URL Scheme & Risk of Insecure HTTP Fallback
- **Initial Finding**: The SOP permitted QR payloads without mandating a verified TLS gateway scheme (`https://`), risking plaintext credentials or insecure HTTP fallback across local networks.
- **Verification**: Verified TLS requirements are now codified in multiple sections:
  1. Section 1.1, Invariant 3: Mandates standard HTTPS/WSS over verified TLS certificates and explicitly forbids plain HTTP with client-side RSA padding.
  2. Section 2.3: Mandates that the URL encoded in the QR code must resolve to the Hub's verified TLS route authority (`https://...`), never raw unencrypted `http://` IP addresses.
  3. Section 3 (Stage 2 & Stage 3): Codifies that `POST /hub/pairing/generate-code` and `generateQrSvg` strictly emit `https://<hub-domain>/auth?token=...`.
  4. Section 6: Stop-Work matrix marks unencrypted HTTP across networks as a Critical stop-work blocker.
- **Status**: **RESOLVED (PASS)**

---

### F-03 (P2): Ambiguous DSH Plugin Endpoints vs Hub Endpoints
- **Initial Finding**: The SOP conflated local DSH Node webServer routes with Hub registry pairing endpoints under identical or vague path definitions.
- **Verification**: Section 3 now explicitly establishes architectural demarcation across stages:
  1. Stage 1 (DSH Node Plugin Scope): `src/plugin/index.mjs` registers local node health/status endpoint `GET /api/orbit/node-status` on the DSH Node's `ctx.webServer` (distinct from Hub endpoints).
  2. Stage 2 (Hub Server Ingress Scope): Authoritative Hub server endpoints (`src/registry/server.mjs`) are isolated to `/hub/pairing/*`:
     - `POST /hub/pairing/generate-code`
     - `POST /hub/pairing/verify`
     - `GET /hub/pairing/status`
     - `GET /hub/pairing/events` (SSE event stream)
- **Status**: **RESOLVED (PASS)**

---

### F-04 (P2): Omission of Stage 5 Qualification & Anti-Pattern Stop-Work Safeguards
- **Initial Finding**: The SOP lacked explicit prohibitions against claiming mounted fields PASS during Stage 5 candidate qualification, and lacked stop-work entries for DSH core monkey-patching or unclean worktree residue.
- **Verification**: The remediated SOP includes explicit constraints:
  1. Section 1.1, Invariant 5: Forbids monkey-patching DSH core services (`connection`, `browserAuth`, etc.) and mandates official extension points (`slots.inject('settings.section')`).
  2. Section 3, Stage 5: Mandates that all 19 mounted fields remain `NOT_EXECUTED` during Gate C automated qualification.
  3. Section 6 (Stop-Work Matrix): Added three explicit stop-work blockers:
     - "DSH core files or backend services monkey-patched/hijacked" -> Blocker / STOP.
     - "Mounted field claimed PASS during Stage 5 qualification" -> Blocker / STOP.
     - "Unclean worktree, credential residue, or dangling test processes" -> Blocker / STOP.
- **Status**: **RESOLVED (PASS)**

---

### F-05 (P3): Missing `dsh.bundle.patch` in package.json Packaging Standards
- **Initial Finding**: Section 2.2 omitted the required Cordis bundle patch pointer (`dsh.bundle.patch`) in `package.json`.
- **Verification**: Section 2.2 now states:
  `package.json must declare "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "inject": ["@deepseek-ai/dsh-client-ui-settings"], "platform": "web" } }`.
- **Status**: **RESOLVED (PASS)**

---

### F-06 (P3): Cordis Dependency Injection Syntax Ambiguity
- **Initial Finding**: The Cordis dependency injection declaration was ambiguous as to whether it belonged inside `apply(ctx)` or as a module-level export.
- **Verification**: Section 2.2 and Section 3 (Stage 1) both mandate:
  `export const inject = ['webServer', 'settings'];` declared at the module level prior to `export function apply(ctx)`.
- **Status**: **RESOLVED (PASS)**

---

### F-07 (P3): Omission of `lib/**` in Pre-Gate-A Prohibited Runtime Code
- **Initial Finding**: Section 2.1 banned pre-Gate-A commits to `src/**`, `ui/**`, and `bin/**`, but omitted `lib/**`, where compiled or bundled plugin artifacts (`lib/client.js`) reside.
- **Verification**: Section 2.1 now explicitly specifies:
  `No v0.9 product runtime code under src/**, ui/**, bin/**, or lib/** may be committed before Gate A records an explicit GO verdict.`
- **Status**: **RESOLVED (PASS)**

---

## 3. M36 Acceptance Matrix Consistency Verification

The M36 matrix defined in Section 4 and Stage 5 was checked against the RFC-0015 M32 baseline:

1. **Inherited RFC-0015 M32 Baseline (32 Fields)**:
   - **15 Automated Fields**:
     - Fields 1–11: `fleetJobListObservability`, `fleetJobTargetSpecExplicitList`, `fleetJobTargetSpecEmptyRejected`, `fleetJobWildcardWithoutFilterDenied`, `capabilityAwareSchedulingMatching`, `capabilityAwareSchedulingStaleSkipped`, `fleetJobAggregatedResultsComplete`, `fleetJobAuditLogRecorded`, `fleetJobSingleNodeTimeoutContainment`, `operatorUiFleetWorkflowsView`, `fleetJobDuplicateIdempotent`
     - Field 25: `auditLogQueryFiltering`
     - Field 28: `noImplicitBroadcastExecution`
     - Fields 29–30: `scheduledWorkflowDefinitionPersistence`, `scheduledWorkflowCronAndIntervalParsing`
   - **17 Mounted Fields**:
     - Fields 12–24: `concurrentFleetJobExecution`, `fleetTaskExecutionDirectNode`, `fleetTaskExecutionReverseNode`, `concurrentTaskDispatchDirectAndReverse`, `fleetTaskResultAggregationDirectAndReverse`, `targetNodeOutageDuringJobExecution`, `reverseNodeDisconnectDuringJobExecution`, `fleetJobLargeOutputAggregation`, `fleetJobStreamingProgressEvents`, `capabilityMismatchNodeFiltered`, `tombstonedNodeTargetRejected`, `hubRestartPendingJobReconciliation`, `nodeRestartDuringFleetJob`
     - Fields 26–27: `fleetJobCancellation`, `zeroCrossNodeCredentialLeakInJob`
     - Fields 31–32: `scheduledWorkflowAutomatedDispatch`, `scheduledWorkflowLifecycleAndAudit`

2. **v0.9 Additions (4 Fields)**:
   - Field 33: `dshPluginCordisRegistration` (**automated**)
   - Field 34: `dshSettingsNamespacePersistence` (**automated**)
   - Field 35: `dshNativeSettingsSlotInjection` (**mounted**)
   - Field 36: `qrPairingBootstrapAndExchange` (**mounted**)

3. **Partitioning and Total Invariant**:
   - Total Automated Fields: 15 + 2 = **17 automated fields**
   - Total Mounted Fields: 17 + 2 = **19 mounted fields**
   - Total Matrix Count: 17 + 19 = **36 canonical fields**

4. **Gate Qualification Alignment**:
   - Stage 5 (Gate C): All 17 automated fields (Fields 1–11, 25, 28, 29, 30, 33, 34) must be PASS; all 19 mounted fields must be strictly `NOT_EXECUTED`.
   - Stage 6 (Gate 4 Final Review): All 36 fields must be PASS based on fresh mounted evidence and the seven-artifact release set.

The acceptance matrix definition is mathematically and architecturally sound.

---

## 4. Orbit Security Boundaries & Safeguard Verification

The SOP adheres to Orbit's architectural invariants:

1. **Prohibition of Virtual Loopback / Host-Origin Spoofing**:
   - Section 1.1 Invariant 2 and Section 6 Stop-Work matrix strictly forbid modifying request `Host`, `Origin`, `Sec-Fetch-Site`, or `socket.remoteAddress` to `127.0.0.1`. DNS rebinding and cross-site protection remain active.
2. **Strict Transport Security (Verified TLS Invariant)**:
   - Section 1.1 Invariant 3, Section 2.3, and Section 3 Stage 2/3 enforce verified TLS (`https://...` / `wss://...`). Plain HTTP with client-side RSA padding cannot substitute for TLS and is barred across all network boundaries.
3. **Strict Operator Session vs Node Identity Separation**:
   - Section 1.1 Invariant 1 and Section 6 mandate that QR code scanning authenticates an operator session (`sessionToken`), not an enrolled DSH node (`nodeId`, Ed25519 keypair). Browser sessions cannot obtain node-level machine credentials.
4. **Ephemeral 5-Minute Single-Use Pairing Codes**:
   - Section 1.1 Invariant 4, Section 2.3, Section 3 Stage 2/4, and Section 6 mandate that pairing codes are 6-digit random values with a maximum 300-second TTL, destroyed on the first verification attempt, with 5-attempt/15-minute IP rate limiting. No long-lived static bearer tokens are permitted.
5. **Clean Seam DSH Integration**:
   - Section 1.1 Invariant 5 and Section 2.2 require official Cordis plugin hooks and `slots.inject('settings.section')`, prohibiting monkey-patching of DSH core authentication or internal services.

---

## 5. Conclusion & Next Steps

All criteria for Gate A Architecture & SOP approval are satisfied.

- **Gate A Verdict**: **GO / PASS**
- **Next Actions**:
  1. Author and commit `docs/rfc/0016-dsh-plugin-integration-and-qr-pairing.md`.
  2. Implement Stage 0 governance test harness (`scripts/v09-plugin-qr-acceptance-matrix.mjs` and `test/v09-governance-contract.test.mjs`).
  3. Validate lineage descendancy from `c15ca5865f1519fccbb277f2a440c3b1496e1bb9`.
  4. Upon closing Stage 0, proceed to Stage 1 Cordis packaging and settings persistence.
