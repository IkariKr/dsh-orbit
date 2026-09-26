# v0.7 Stage 2 Gate 2 Independent Re-Review (Round 5)

- Scope: `chore/v0.7-stage2-fleet-endpoints`, HEAD `03a1795738805f0d8ee8f59990b79ca578be44cb` (`03a1795`)
- Baseline for this re-review: `dd5858d` (round-4 review commit)
- Prior reviews:
  - `docs/review/2026-09-26-v07-stage2-gate-2-4b4f740.md` — FAIL (1x P0, 1x P1, 3x P2, 2x P3)
  - `docs/review/2026-09-26-v07-stage2-gate-2-rereview-1500729.md` — FAIL (1x P2, 3x P3)
  - `docs/review/2026-09-26-v07-stage2-gate-2-rereview-d137256.md` — FAIL (1x P2, 2x P3)
  - `docs/review/2026-09-26-v07-stage2-gate-2-rereview-dd5858d.md` — FAIL (1x P1, 1x P2, 2x P3)
- Reviewed commit: `03a1795` ("fix(security): resolve Gate 2 round 4 findings for bare key/auth scrubbing, session key redaction, and over-redaction")
- Reviewer: independent code review (`@code-reviewer2`)
- Verdict: **PASS (GO)** — 0x P0, 0x P1, 0x P2, 0x P3. Gate 2 granted.

---

## Review Scope

Independent re-review of the Stage 2 round-5 remediation. `git diff --stat dd5858d..03a1795` reports exactly three files changed (+86 / -21):

1. `src/registry/fleet-scheduler.mjs` (+17/-12):
   - Refined `isSensitiveKey` allow-list to exact matches (`author`, `authority`, `routeauthority`, `sessioncount`, `sessionstate` and their snake_case equivalents), removing over-broad substring checks.
   - Restored `lower.includes("session")` sensitive matching, and added `_key`/`-key` suffix matching alongside `lower === "key"`.
   - Restored bare `key`, `auth`, `authorization=` to the assignment scrubber regex.
   - Added generalized Authorization header redaction for non-Bearer/non-Basic schemes (`Authorization: token ...`, `Authorization: ApiKey ...`, `Authorization: secret ...`) with negative lookahead protecting Bearer, Basic, and already redacted values.
   - Removed unanchored `basic\s+[a-zA-Z0-9+/=]{8,}` rule to eliminate over-redaction of benign logs.
   - Removed `pass` alternative from assignment regex, keeping `password|passwd` only to prevent collision with `bypass` and `compass`.
2. `src/registry/registry.mjs` (+10/-7):
   - Synchronized `isSensitiveKey` with `fleet-scheduler.mjs` (verified byte-identical: 1298 bytes each).
3. `test/v07-stage2-fleet-endpoints.test.mjs` (+59/-2):
   - Comprehensive test suite expansion covering bare `key=`, `KEY:`, `authorization=`, `Authorization: token ...`, `Authorization: ApiKey ...`, `Authorization: secret123`, `KEY=...` in stderr.
   - Explicit assertions for `sessionKey`, `sessionValue`, `sessionData`, `sessionBlob`, `sessionNonce` redaction.
   - Explicit preservation assertions for benign strings: `basic authentication failed for user johnsmith`, `bypass=1`, `compass=1`, `author`, `authority`, `routeAuthority`, `sessionCount`.
   - Both HTTP submit (`POST /hub/fleet/jobs`) and cross-operator read (`GET /hub/fleet/jobs/:id`) tested with live scheduler execution and stdout/stderr log scrubbing.

Governing documents:
- RFC-0014 D5 (`docs/rfc/0014-fleet-workflows-and-scheduling.md:281`, "Zero credential leakage: task payloads and output logs scrub tokens, private keys, and session cookies")
- Transport invariant (`src/registry/server.mjs:4`, "5xx-never-allowed")
- v0.7 multistage SOP Stop-Work matrix (`docs/sop/v0.7-fleet-workflows-multistage-sop.md:178`, "Non-zero P0, P1, or P2 finding | Blocker")

---

## Status of Prior Findings

| # | Round-4 finding | Severity | Status in `03a1795` |
|---|---|---|---|
| 1 | Bare `key=` / `key:` / `KEY=` / `KEY:` and `authorization=` / `Authorization: <scheme> <token>` leaked verbatim | P1 | **FIXED & VERIFIED**. Standalone `key` and `auth` restored in assignment regex; dedicated non-Basic/Bearer Authorization header scrubber added. |
| 2 | `isSensitiveKey` dropped redaction for `sessionKey` / `sessionValue` / `sessionData` / `sessionBlob` / `sessionNonce` | P2 | **FIXED & VERIFIED**. Whitelist narrowed from `.includes()` to exact string matches; `lower.includes("session")` restored. |
| 3 | Over-redaction of `basic <b64>` and `pass` alternative in benign contexts (`basic authentication failed...`, `bypass=1`, `compass=1`) | P3 | **FIXED & VERIFIED**. Unanchored `basic` regex removed; `pass` candidate removed in favor of `password`/`passwd`. |
| 4 | Test suite lacked explicit assertions for regressed bare forms and benign vectors | P3 | **FIXED & VERIFIED**. Comprehensive payload, stdout, stderr, and cross-operator retrieval assertions added in `test/v07-stage2-fleet-endpoints.test.mjs`. |

---

## Technical Audit & Verification

### 1. Bare Key and Authorization Scrubbing (Round-4 P1)

In `src/registry/fleet-scheduler.mjs`:
- Generalized Authorization header regex:
  ```javascript
  s = s.replace(/authorization:[ \t]*(?!bearer|basic|\[redacted)[^\s,;\r\n]+(?:[ \t]+[^\s,;\r\n]+)?/gi, "Authorization: [REDACTED]");
  ```
  This matches custom schemes (e.g. `token <val>`, `ApiKey <val>`, `OAuth <val>`) as well as single-token credentials (`Authorization: secret123`), while negative lookahead `(?!bearer|basic|\[redacted)` prevents double-redaction or interference with Bearer and Basic scrubbers.
- Assignment regex:
  ```javascript
  s = s.replace(
    /(\b(?:[A-Za-z0-9_]*(?:token|secret|password|passwd|credential|session[_-]?id)|[A-Za-z0-9_]*[_-]key|api[_-]?key|key|auth)\b\s*[:=]\s*|\bauthorization\b\s*=\s*)(?:[\x27\x22][^\x27\x22\r\n]*[\x27\x22]|[^\s,;]+)/gim,
    "$1[REDACTED]",
  );
  ```
  `key` and `auth` are now explicit standalone alternatives with word boundaries `\b`. `authorization=` is explicitly handled for `=` assignments, leaving `Authorization:` headers to the specialized header scrubber.

Empirical verification:
- `key=abc` -> `key=[REDACTED]`
- `KEY=abc` -> `KEY=[REDACTED]`
- `key: abc` -> `key: [REDACTED]`
- `KEY: abc` -> `KEY: [REDACTED]`
- `authorization=xyz` -> `authorization=[REDACTED]`
- `Authorization=xyz` -> `Authorization=[REDACTED]`
- `Authorization: token ghp_abc123` -> `Authorization: [REDACTED]`
- `Authorization: secret123` -> `Authorization: [REDACTED]`
- `Authorization: ApiKey sk-live` -> `Authorization: [REDACTED]`
- `Authorization: OAuth tok` -> `Authorization: [REDACTED]`
- `Authorization: Bearer mytoken` -> `Authorization: Bearer [REDACTED_TOKEN]`
- `Authorization: Basic dXNlcjpwdw==` -> `Authorization: Basic [REDACTED_AUTH]`
- `curl -u user:mypassword https://api.example.com` -> `curl -u user:[REDACTED] https://api.example.com`
- `DB_PASSWORD=pw123` -> `DB_PASSWORD=[REDACTED]`
- `GITHUB_TOKEN="ghp_abc"` -> `GITHUB_TOKEN=[REDACTED]`
- `KEY=anothersecret` -> `KEY=[REDACTED]`

All vectors scrubbed as expected; zero bare credential leaks detected.

### 2. Sensitive Session Key Redaction and Whitelist Precision (Round-4 P2)

In `src/registry/fleet-scheduler.mjs` and `src/registry/registry.mjs`:
- Allowlist narrowed to exact string equalities:
  ```javascript
  if (
    lower === "monkey" ||
    lower === "hockey" ||
    lower === "author" ||
    lower === "authority" ||
    lower === "routeauthority" ||
    lower === "route_authority" ||
    lower === "sessioncount" ||
    lower === "session_count" ||
    lower === "sessionstate" ||
    lower === "session_state"
  ) {
    return false;
  }
  ```
- Sensitive match restores `lower.includes("session")`:
  ```javascript
  return (
    ...
    lower.includes("session") ||
    ...
  );
  ```

Empirical verification:
- `sessionKey` -> `sensitive: true` (Redacted)
- `sessionValue` -> `sensitive: true` (Redacted)
- `sessionData` -> `sensitive: true` (Redacted)
- `sessionBlob` -> `sensitive: true` (Redacted)
- `sessionNonce` -> `sensitive: true` (Redacted)
- `sessionId` / `session_id` / `session` -> `sensitive: true` (Redacted)
- `sessionCount` / `session_count` -> `sensitive: false` (Preserved)
- `sessionState` / `session_state` -> `sensitive: false` (Preserved)
- `author` -> `sensitive: false` (Preserved)
- `authority` -> `sensitive: false` (Preserved)
- `routeAuthority` / `route_authority` -> `sensitive: false` (Preserved)
- `keyId` / `nodeId` / `requestId` / `currentKeyId` / `newKeyId` -> `sensitive: false` (Preserved)
- `monkey` / `hockey` -> `sensitive: false` (Preserved)

Mirrored predicate check:
Extracted AST bodies of `isSensitiveKey` from `fleet-scheduler.mjs` and `registry.mjs` were compared and verified byte-identical (`1298` bytes each).

### 3. Elimination of Over-Redaction (Round-4 P3)

- Unanchored `/basic\s+[a-zA-Z0-9+/=]{8,}/gi` was deleted. Only `/authorization:[ \t]*basic[ \t]+[A-Za-z0-9+/=]{4,}/gi` remains.
- The `pass` token inside `[A-Za-z0-9_]*(?:...|pass|...)` was replaced with `password|passwd`.

Empirical verification:
- `basic authentication failed for user johnsmith` -> preserved verbatim
- `basic configuration settings applied` -> preserved verbatim
- `the basic authentication mechanism is disabled` -> preserved verbatim
- `bypass=1` -> preserved verbatim
- `compass=1` -> preserved verbatim
- `bypass: true` -> preserved verbatim
- `compass: north` -> preserved verbatim
- `passport=123` -> preserved verbatim
- `password=123` -> `password=[REDACTED]`
- `passwd=123` -> `passwd=[REDACTED]`
- `DB_PASSWORD=123` -> `DB_PASSWORD=[REDACTED]`

Zero false-positive redacting observed on benign operational text.

### 4. Test Suite and Environment Checks (Round-4 P3)

In `test/v07-stage2-fleet-endpoints.test.mjs`:
- Added 18 new payload field checks and 10 new stdout/stderr log assertions.
- Submitted via `POST /hub/fleet/jobs` and retrieved by another operator via `GET /hub/fleet/jobs/:id`.
- Verified that benign fields are uncorrupted and sensitive fields are scrubbed.

Execution results in `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate` (Node v25.9.0 on win32):
- `git diff --check`: Exit 0 (clean).
- `node scripts/check-public-tree.mjs`: Exit 0 ("Public-tree validation passed.").
- `node --test test/v07-stage1-fleet-scheduler.test.mjs`: 13/13 pass (0 fail, duration 299ms).
- `node --test test/v07-stage2-fleet-endpoints.test.mjs`: 9/9 pass (0 fail, duration 698ms).
- `npm run check`: 567 tests total: 561 passed, 0 failed, 6 skipped (pre-existing platform/drill skips).

---

## Residual Risks (Informational)

1. **Heuristic Log Scrubbing Boundary**: String scrubbing operates on recognized keywords and standard HTTP header structures. Opaque non-delimited secret strings or novel token schemes without identifiers cannot be identified without structured payload metadata.
2. **In-Memory Job Map**: `FleetJobScheduler.jobs` remains an in-memory `Map` across the lifetime of the Hub process without bounded eviction (pre-existing design from Stage 1).
3. **Swallowed Audit Write Failures**: Error handling in asynchronous post-execution audit logging uses fail-safe `catch {}`, preventing scheduler crashes but relying on database resilience.

None of these residuals violate RFC-0014 D5 or the SOP Gate 2 requirements.

---

## Gate 2 Verdict

**PASS (GO)**

Rationale:
All findings from Round 4 (1x P1, 1x P2, 2x P3) have been addressed and verified with zero regressions. Bare keys and authorization headers are scrubbed across payload and logs; session credentials are fully redacted while benign parameters remain uncorrupted; over-redaction of benign logs is eliminated; and test assertions cover the full regression matrix. All test suites pass cleanly with zero failures. Stage 2 meets all criteria under RFC-0014 D5 and SOP §5. Gate 2 is formally granted.
