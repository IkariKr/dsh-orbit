# v0.7 Stage 2 Gate 2 Independent Re-Review (Round 3)

- Scope: `chore/v0.7-stage2-fleet-endpoints`, HEAD `d137256f2e50d401d7702a0633df61b97a1e5659` (`d137256`)
- Baseline for this re-review: `1500729` (round-2 remediation commit)
- Prior reviews:
  - `docs/review/2026-09-26-v07-stage2-gate-2-4b4f740.md` — FAIL (1x P0, 1x P1, 3x P2, 2x P3)
  - `docs/review/2026-09-26-v07-stage2-gate-2-rereview-1500729.md` — FAIL (1x P2, 3x P3)
- Reviewed commit: `d137256` ("fix(security): resolve Gate 2 review round 2 findings for inline token scrubbing and URI decoding")
- Reviewer: independent code review (`@code-reviewer2`)
- Verdict: **FAIL (REVISE/BLOCK)** — 1x P2, 2x P3. Gate 2 not granted.

---

## Review Scope

Independent re-review of the Stage 2 round-3 remediation, verifying that each of the four round-2 findings is genuinely fixed, that the fixes do not introduce new defects, and that the full functional/regression surface is safe. `git diff --stat 1500729..d137256` reports exactly five files (+333 / -47):

1. `src/registry/fleet-scheduler.mjs` (+81/-…): new exported `isSensitiveKey` and `scrubString`; `scrubSensitiveCredentials` now routes string values through `scrubString` and uses the shared key predicate; `getJob` still applies scrubbing to `payload` and `results`.
2. `src/registry/registry.mjs` (+54): `sanitizeAuditDetail` now recurses arrays element-wise and reuses a mirrored `isSensitiveKey` predicate with benign-key allow-list.
3. `src/registry/server.mjs` (+15): `safeDecodeUri` applied to `GET /hub/nodes/:id`, `PUT /hub/nodes/:id/route-mode`, `PUT|DELETE /hub/nodes/:id/route-target`.
4. `test/v07-stage2-fleet-endpoints.test.mjs` (+91): extended P1 scrub test (injected transport, cross-operator read, stdout/stderr) and a new P3 test (array audit redaction + malformed node URL).
5. `docs/review/2026-09-26-v07-stage2-gate-2-rereview-1500729.md` (+139): prior review record.

Reviewed against RFC-0014 D5 (`docs/rfc/0014-fleet-workflows-and-scheduling.md:281`, "Zero credential leakage: task payloads and output logs scrub tokens, private keys, and session cookies"), RFC-0007 security matrix (`docs/rfc/0007-browser-management-api.md:65`, "5xx upstream | failed case (never allowed)"), the transport's own invariant (`src/registry/server.mjs:4`, "5xx-never-allowed"), and the v0.7 multistage SOP Stop-Work matrix (`docs/sop/v0.7-fleet-workflows-multistage-sop.md:178`, "Non-zero P0, P1, or P2 finding | Blocker"). No `AGENTS.md` exists in this repository; the controlling governance documents are the SOP and the RFCs.

---

## Status of Prior Findings

| # | Round-2 finding | Severity | Status |
|---|---|---|---|
| 1 | Inline token forms, `sessionId` key, and `key`/`auth`/`credential`/`x-api-key` keys leaked to every operator | P2 | **PARTIALLY FIXED** → residual downgraded/re-scoped (see Finding 1) |
| 2 | `sanitizeAuditDetail` did not recurse arrays | P3 | **FIXED** (verified) |
| 3 | `sanitizeAuditDetail` over-redacted benign `keyId`/`monkey` | P3 | **FIXED for those keys** (verified); a new over-redaction class appeared (Finding 3) |
| 4 | Non-fleet routes returned 500 on malformed `%ZZ` | P3 | **PARTIALLY FIXED** → residual on two routes (Finding 2) |

---

## Findings

### [P2] Inline credential scrubbing still leaks conventional prefixed env-var assignments (RFC-0014 D5 not fully met)

`src/registry/fleet-scheduler.mjs:106-109` (`scrubString` inline regex)

The new inline-assignment regex is

```
/(\b(?:api[_-]?)?(?:token|secret|password|passwd|key|credential|authorization|session[_-]?id)\b\s*[:=]\s*)([^\s,;\x27\x22]+)/gim
```

The leading `\b` plus the alternation means the sensitive word must itself be a whole word at the match position. For snake/upper-snake env-var names — the canonical form an environment dump or a config-printing `command` task emits — the sensitive word is glued to a prefix (`DB_PASSWORD`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `CLIENT_SECRET`, `OPENAI_API_KEY`), so `\b` fails and the value is returned verbatim. Quoted values also defeat the `[^\s,;\x27\x22]+` value class.

Reproduced end-to-end over the HTTP surface with an injected dispatch transport (two operators, operator-bob reading operator-alice's job):

```
submit 201
bob sees stdout: "starting\nDB_PASSWORD=pw123\nGITHUB_TOKEN=ghp_abc\nACCESS_TOKEN=xyz\nAPI_TOKEN=[REDACTED]\nfinished"
bob sees stderr: "client_secret=s3cr3t"
bob sees payload: {"envLine":"DB_PASSWORD=pw123","ghLine":"GITHUB_TOKEN=ghp_abc","note":"ACCESS_TOKEN=xyz","normal":"hello"}
```

Direct scrubber matrix (LEAK = returned unchanged):

```
LEAK  "DB_PASSWORD=pw123"          LEAK  "AWS_SECRET_ACCESS_KEY=AKIAx"
LEAK  "DATABASE_PASSWORD=pw123"    LEAK  "OPENAI_API_KEY=sk-x"
LEAK  "MYSQL_PASSWORD=pw123"       LEAK  "STRIPE_SECRET_KEY=sk_live_x"
LEAK  "POSTGRES_PASSWORD=pw"       LEAK  "X_API_KEY=abc"
LEAK  "GITHUB_TOKEN=ghp_x"         LEAK  "PGPASSWORD=pw"
LEAK  "ACCESS_TOKEN=abc"           LEAK  "REDIS_PASSWORD=abc"
LEAK  "REFRESH_TOKEN=abc"          LEAK  "SMTP_PASSWORD=abc"
LEAK  "AUTH_TOKEN=abc"             LEAK  "SECRET_KEY=abc"
LEAK  "CLIENT_SECRET=abc"          LEAK  "MY_SECRET=abc"
LEAK  "password=\"hunter2\""       LEAK  "curl -u user:pw https://h"
ok    "API_TOKEN=abc123"           ok    "token=zzz999"      ok  "password=hunter2"
ok    "apiKey=abc"                 ok    "apikey=abc"        ok  "session_id=sess_abc"
```

Two further realistic forms also survive: `Authorization: Basic dXNlcjpwdw==` is reduced only to `Authorization: [REDACTED] dXNlcjpwdw==` (the base64 credential remains), and `curl -u user:pw` is untouched. The commit message and the task brief both scope the fix to "inline `API_TOKEN=` / `token=` / `password=` / `secret=`"; those exact bare tokens are now handled, but the prefixed/quoted variants of the same class are not, and the new test only asserts the bare forms (`test/v07-stage2-fleet-endpoints.test.mjs:406-407,426,454`), so the gap is invisible to the suite.

Impact: cross-operator disclosure of live credentials through job `payload` and node `stdout`/`stderr`, a direct deviation from RFC-0014 D5. `getJob` is the source for `listJobs`, `onJobCompleted`, and the GET detail/list routes, so the leak reaches every read path. Graded P2 (not P1) to stay consistent with the prior round's calibration for this class — the structured key vectors and the three RFC-named classes in canonical form are handled; the residual requires the credential to be embedded under a prefixed/quoted key. It still blocks the Gate under SOP §5.

Minimal fix direction: drop the leading `\b` (or match a boundary on the value side only) so prefixed names match, e.g. `/([A-Za-z0-9_.-]*(?:token|secret|password|passwd|apikey|api[_-]?key|credential|authorization|session[_-]?id)[A-Za-z0-9_.-]*\s*[:=]\s*)(["']?)([^\s,;]+?)\2(?=[\s,;]|$)/gim`, and extend the bearer rule to `Basic <base64>`.

### [P3] Malformed-percent 500 remains on two node routes (prior P3 only partially fixed)

`src/registry/server.mjs:733` (`GET /hub/nodes/:id/route-target`), `src/registry/server.mjs:1011` (`POST /hub/nodes/:id/delete`, `POST /hub/nodes/:id/reenroll`)

The round-2 fix routed three decode sites through `safeDecodeUri` but missed the two that the prior review explicitly named. The `GET /hub/nodes/:id` handler (line 747) and the `PUT`/`DELETE` route-mode/route-target handlers (lines 935, 958) are fixed; however the sibling `GET` route-target handler at line 733 and the delete/reenroll handler at line 1011 still call `decodeURIComponent` directly, so a `URIError` propagates through `sendError` to a 500. Reproduced over HTTP with a valid session + CSRF:

```
GET    /hub/nodes/%ZZ                -> 400 bad-request          (fixed)
PUT    /hub/nodes/%ZZ/route-mode     -> 400 bad-request          (fixed)
PUT    /hub/nodes/%ZZ/route-target   -> 400 bad-request          (fixed)
DELETE /hub/nodes/%ZZ/route-target   -> 400 bad-request          (fixed)
GET    /hub/nodes/%ZZ/route-target   -> 500 internal-error       <<< NOT fixed
POST   /hub/nodes/%ZZ/delete         -> 500 internal-error       <<< NOT fixed
POST   /hub/nodes/%ZZ/reenroll       -> 500 internal-error       <<< NOT fixed
```

Server console confirms `URIError: URI malformed at handleBrowserRequest (server.mjs:733 / server.mjs:1011)`. This violates the transport's own stated invariant (`server.mjs:4` "5xx-never-allowed"; RFC-0007 matrix line 65). No SQL injection or state change — impact is the incorrect status code, console error noise, and the broken never-5xx contract. Graded P3 (pre-existing class, not introduced by this diff, no data corruption). Minimal fix: apply `safeDecodeUri` + the 400 guard to lines 733 and 1011 exactly as done for the other node routes.

### [P3] New over-redaction class in the shared key predicate: `auth`/`session` substrings match benign `author`, `authority`, `routeAuthority`

`src/registry/fleet-scheduler.mjs:86` and `src/registry/registry.mjs:86` (`lower.includes("auth")`), `src/registry/fleet-scheduler.mjs:85` / `registry.mjs:85` (`lower.includes("session")`)

The round-2 predicate allow-listed the specific benign keys it had over-redacted (`keyId`, `tokenId`, `currentKeyId`, `newKeyId`, `monkey`, `hockey`), which fixes the reported cases (verified: `keyId`, `tokenId`, `monkey`, `hockey` now pass through). But `includes("auth")` still matches `author`/`authority`, and `includes("session")` matches `sessionState`/`sessionCount`. Verified:

```
author: "[REDACTED]"          authority: "[REDACTED]"
routeAuthority: "[REDACTED]"  sessionState: "[REDACTED]"
sessionCount: "[REDACTED]"    keyId: "kid1"   monkey: "banana"   (preserved)
```

Graded P3 and latent: no current `recordAudit` detail uses `author`/`authority`/`sessionState`/`sessionCount` (grep of all `recordAudit` call sites), so there is no live trigger today; `routeAuthority` is, however, a first-class concept in this codebase (`protocol.mjs`, `route-auth.mjs`, `route-proxy.mjs`, `server.mjs`), so a future audit detail carrying it would be silently blanked. Impact limited to the read-model usefulness of `GET /hub/audit` / `POST /hub/audit/query` (raw rows remain in SQLite `detail_json`). Minimal fix: narrow the predicate to credential-suffix/whole-word keys (drop the bare `includes("auth")`/`includes("session")` in favour of `authorization`, `auth_token`, `session_id`, `session_token`, or exclude `author`/`authority`/`sessionState`/`sessionCount` explicitly as done for `keyId`).

---

## Verification

Executed in `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate` (Node v25.9.0, Git Bash on win32):

- `git rev-parse HEAD` → `d137256f2e50d401d7702a0633df61b97a1e5659`; `git branch --show-current` → `chore/v0.7-stage2-fleet-endpoints`; `git status --porcelain` → empty (clean worktree, 0 lines).
- `git diff --stat 1500729..d137256` → exactly the five declared files (+333 / -47); `git show --stat d137256` matches.
- `git diff --check` → clean (exit 0).
- `node scripts/check-public-tree.mjs` → "Public-tree validation passed." (exit 0).
- `npm run check` (public-tree + full suite) → **567 tests, 561 pass, 0 fail, 6 skipped** — exactly matches the claimed figures. The 6 skipped are pre-existing, environment-gated suites (POSIX permission bits on Windows, `DSH_ACCEPTANCE_ROOT` not configured, `NOT_EXECUTED` mounted Stage 7 drill).
- `node --test test/v07-stage2-fleet-endpoints.test.mjs` → 9/9 pass (including the extended P1 scrub test and the new P3 array/URL test).

Independent read-only ESM reproductions against the committed modules (throwaway scripts under the OS temp dir; worktree re-verified clean afterwards):

- **Prior P3 (arrays) — FIXED:** `POST /hub/audit/query` / `GET /hub/audit` for a detail `{items:[{token},{secret},{nested:[{password}]}], nested:{arr:[{password}]}, benign:{monkey,keyId,nodeId,requestId}}` returns every array-nested credential key as `[REDACTED]`; `JSON.stringify(detail).match(/LEAK/)` → null. Benign `monkey`/`keyId`/`nodeId`/`requestId` preserved.
- **Prior P2 (keys) — FIXED:** `sessionId`, `session_id`, `key`, `auth`, `x-api-key`, `credential` keys all now `[REDACTED]`; `keyId`, `tokenId`, `nodeId`, `requestId`, `currentKeyId`, `newKeyId`, `monkey`, `hockey` preserved.
- **Prior P2 (bare inline forms) — FIXED:** `API_TOKEN=abc123` → `API_TOKEN=[REDACTED]`; `token=zzz999`, `password=hunter2`, `secret=s3cr3t`, `api_key=xyz`, `PASSWD=pw`, `credential=abc`, `key=abc` all redacted. `sess_<48 hex>` → `[REDACTED_SESSION]`; PEM private key → `[REDACTED_PRIVATE_KEY]`; `Bearer <token>` → `Bearer [REDACTED_TOKEN]`; `dsh-orbit-hub-session=...` → redacted; `postgres://user:pw@host/db` → `postgres://user:[REDACTED]@host/db` (also `postgresql://`, `mongodb+srv://`, `http(s)_proxy`).
- **Prior P2 residual (Finding 1):** reproduced the unredacted prefixed env-var forms, quoted values, `Authorization: Basic <base64>`, and `curl -u user:pw`, both at the `scrubString` level and end-to-end (operator-bob reading operator-alice's job stdout/stderr/payload).
- **`getJob` scrubbing path:** `payload` and `results` are both scrubbed by default (`fleet-scheduler.mjs:378,387`); `listJobs` (line 398) and `onJobCompleted` (line 587) both go through `getJob` with default `scrub=true`. `getJob(jobId, {scrub:false})` remains an unused escape hatch (grep: no caller).
- **Prior P3 (URL decoding, fleet + fixed node routes) — VERIFIED:** `GET /hub/fleet/jobs/%ZZ`, `.../audit`, `POST .../cancel` → 400; `GET /hub/nodes/%ZZ`, `PUT /hub/nodes/%ZZ/route-mode`, `PUT|DELETE /hub/nodes/%ZZ/route-target` → 400. Remaining 500s enumerated in Finding 2.
- **No new 5xx introduced by the scrubber:** the regexes in `scrubString` are linear (no nested quantifiers / catastrophic backtracking); deep and cyclic-free structures are handled by the existing `assertValidJsonPayload` depth cap (64) and `safeClone`.
- **Regression sanity:** the two previously-passing Stage 2 tests (P0 audit redaction + principal binding, P2 audit-query 400 validation, P2 cancel-terminal 409 / replay dedup) still pass unchanged in the full suite.

Not verified (out of Stage 2 scope; no code exists yet): the UI Fleet Workflows view (Stage 3), real direct/reverse transport dispatch, and all M28 `mounted` fields (12-24, 26, 27). Stage 2 provides no mounted evidence. Production wiring of a real dispatch transport was not exercised — `bin/dsh-orbit-hub.mjs` constructs the scheduler with `dispatchTransport: options.fleetDispatchTransport ?? null`, so the built-in `defaultDispatch` synthesizes placeholder stdout; Findings 1 and 3 were therefore reproduced with an injected transport and asserted at the `getJob`/`scrubString`/HTTP-surface level, not against a live node.

---

## Residual Risks

- **The scrubbing model is still heuristic, not exhaustive.** Even after Finding 1 is fixed, string-level redaction can never be complete (e.g. base64-only payloads, unusual key names). The durable control would be operator-scoped job visibility, which this remediation again declined in favour of scrubbing.
- **Cross-operator job visibility is still unrestricted.** Any authenticated operator can enumerate and read any other operator's job snapshot (and a replay of another operator's `jobId` returns that job's snapshot with 200). This is the channel by which Finding 1's residual is exposed. Whether cross-operator visibility is intended is not stated in RFC-0014 or the SOP.
- **Audit-write failures remain silently swallowed and non-transactional (prior residual, unchanged).** `fleet-scheduler.mjs:587` (`this.onJobCompleted?.(...)` with no error handling on the audit path) and `server.mjs:1094` (`catch {}`) still discard errors, and `fleet.job.create` is written after execution has already started asynchronously. RFC-0014 D5 ("Every fleet job execution writes directly to the Hub's authoritative SQLite audit table") can therefore fail unobservably for M28 field 8. Fail-safe, not corrupting.
- **`sanitizeAuditDetail` now returns non-object primitives unchanged** (`registry.mjs:94,98`), a behaviour change from the previous `return {}`. With current call sites (`queryAudit` always parses to an object or `{}`) this is benign, but a future non-object `detail` would now be surfaced rather than dropped.
- **`FleetJobScheduler.jobs` is an unbounded in-memory `Map`** with no eviction/retention and no submit rate limit; a job flood is bounded only by process memory. Pre-existing, now remotely reachable via `POST /hub/fleet/jobs`.
- The 6 skipped full-suite tests were enumerated and are pre-existing, environment-gated, and unrelated to this diff.

---

## Gate

**FAIL (REVISE/BLOCK)**

Rationale: the round-2 array-recursion P3, the `keyId`/`monkey` over-redaction P3, the benign-key allow-list, and the three newly guarded node decode sites are genuinely and independently verified fixed, and the full suite (`npm run check`: 567/561/0/6), `check-public-tree`, and `git diff --check` all pass. However the central P2 credential-scrubbing remediation is incomplete: the inline regex leaks conventional prefixed env-var assignments (`DB_PASSWORD=`, `GITHUB_TOKEN=`, `AWS_SECRET_ACCESS_KEY=`, `CLIENT_SECRET=`), quoted values, `Authorization: Basic <base64>`, and `curl -u user:pw` through job `payload` and node `stdout`/`stderr`, cross-operator readable — a direct deviation from RFC-0014 D5. The prior P3 (never-5xx) is also only partially fixed, with `GET /hub/nodes/:id/route-target`, `POST /hub/nodes/:id/delete`, and `POST /hub/nodes/:id/reenroll` still returning 500 on malformed encoding, and a new over-redaction class (`author`/`authority`/`routeAuthority`) was introduced. Per the SOP §5 Stop-Work matrix ("Non-zero P0, P1, or P2 finding | Blocker"), the P2 finding blocks Gate 2. Re-review is required after remediating Finding 1 (and preferably Findings 2-3).

---

## Review Report

`D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate\docs\review\2026-09-26-v07-stage2-gate-2-rereview-d137256.md`
