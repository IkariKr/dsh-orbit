# v0.7 Stage 2 Gate 2 Independent Re-Review (Round 4)

- Scope: `chore/v0.7-stage2-fleet-endpoints`, HEAD `dd5858dd8040d382bc78431c550a7fc0a1d3ec1e` (`dd5858d`)
- Baseline for this re-review: `d137256` (round-3 remediation commit)
- Prior reviews:
  - `docs/review/2026-09-26-v07-stage2-gate-2-4b4f740.md` — FAIL (1x P0, 1x P1, 3x P2, 2x P3)
  - `docs/review/2026-09-26-v07-stage2-gate-2-rereview-1500729.md` — FAIL (1x P2, 3x P3)
  - `docs/review/2026-09-26-v07-stage2-gate-2-rereview-d137256.md` — FAIL (1x P2, 2x P3)
- Reviewed commit: `dd5858d` ("fix(security): resolve Gate 2 round 3 findings for prefixed credentials, basic auth, and node route decoding")
- Reviewer: independent code review (`@code-reviewer2`)
- Verdict: **FAIL (REVISE/BLOCK)** — 1x P1, 1x P2, 2x P3. Gate 2 not granted.

---

## Review Scope

Independent re-review of the Stage 2 round-4 remediation. `git diff --stat d137256..dd5858d` reports exactly five files (+287 / -27):

1. `src/registry/fleet-scheduler.mjs` (+26/-9): `isSensitiveKey` narrowed (`includes("session")`/`includes("auth")` replaced by exact/substring forms; new `author`/`authority`/`sessioncount`/`sessionstate` allow-list); `scrubString` gained Basic-auth, `curl -u`, and a rewritten prefixed-assignment regex.
2. `src/registry/registry.mjs` (+23/-…): mirrored predicate changes (byte-identical to the scheduler's — verified by diff).
3. `src/registry/server.mjs` (+10/-2): `safeDecodeUri` + 400 guard applied to `GET /hub/nodes/:id/route-target` (line 733) and `POST /hub/nodes/:id/{delete,reenroll}` (line 1014).
4. `test/v07-stage2-fleet-endpoints.test.mjs` (+80/-…): extended P1 scrub test (prefixed env vars, quoted values, Basic auth, `curl -u`, benign `author`/`routeAuthority`/`sessionCount`) and a table-driven P3 malformed-route test.
5. `docs/review/2026-09-26-v07-stage2-gate-2-rereview-d137256.md` (+166): prior review record.

Reviewed against RFC-0014 D5 (`docs/rfc/0014-fleet-workflows-and-scheduling.md:281`, "Zero credential leakage: task payloads and output logs scrub tokens, private keys, and session cookies"), the transport invariant (`src/registry/server.mjs:4`, "5xx-never-allowed"), and the v0.7 multistage SOP Stop-Work matrix (`docs/sop/v0.7-fleet-workflows-multistage-sop.md:178`, "Non-zero P0, P1, or P2 finding | Blocker"). No `AGENTS.md` exists in this repository; the controlling documents are the SOP and the RFCs.

---

## Status of Prior Findings

| # | Round-3 finding | Severity | Status |
|---|---|---|---|
| 1 | Prefixed env vars (`DB_PASSWORD=`, `GITHUB_TOKEN=`, `AWS_SECRET_ACCESS_KEY=`, `CLIENT_SECRET=`), quoted values, `Authorization: Basic <b64>`, `curl -u user:pass` leaked | P2 | **FIXED** for every named vector (verified) — but the rewritten regex introduced a **regression** on previously-redacted bare forms (Finding 1) |
| 2 | Over-redaction of `author`/`authority`/`routeAuthority`/`sessionCount`/`sessionState` and preservation of `keyId`/`nodeId`/`requestId`/`monkey`/`hockey` | P3 | **FIXED** (verified) — but the narrowing traded in a new leak-direction gap (Finding 2) |
| 3 | Malformed `%ZZ` 500 on `GET /hub/nodes/:id/route-target`, `POST .../delete`, `POST .../reenroll` | P3 | **FIXED** (verified; exhaustive fuzz, zero 5xx) |

---

## Findings

### [P1] Regression: the rewritten inline regex no longer redacts bare `key=` / `key:` and `authorization=` / `Authorization: <scheme> <token>` forms

`src/registry/fleet-scheduler.mjs:132` (inline assignment regex), `src/registry/fleet-scheduler.mjs:103` (`isSensitiveKey` `startsWith("auth")`)

The round-3 regex alternation `(?:api[_-]?)?(?:token|secret|password|passwd|key|credential|authorization|session[_-]?id)` contained the bare alternatives `key` and `authorization`. The round-4 rewrite replaced it with:

```
/(\b[A-Za-z0-9_]*(?:token|secret|password|passwd|pass|api[_-]?key|credential|session[_-]?id|[_-]key)\b\s*[:=]\s*)(?:[\x27\x22][^\x27\x22\r\n]*[\x27\x22]|[^\s,;]+)/gim
```

`key` and `authorization` are no longer standalone alternatives (bare `key` requires the prefix class plus `[_-]key`, i.e. a leading `_`/`-`; `authorization` is gone entirely). Verified against the **actual committed prior module** (`git show d137256:src/registry/fleet-scheduler.mjs`), 12 previously-redacted forms now return verbatim:

```
REGRESSION "key=abc"                       old="key=[REDACTED]"                       new="key=abc"
REGRESSION "KEY=abc"                       old="KEY=[REDACTED]"                       new="KEY=abc"
REGRESSION "key: abc"                      old="key: [REDACTED]"                      new="key: abc"
REGRESSION "Authorization=xyz"             old="Authorization=[REDACTED]"             new="Authorization=xyz"
REGRESSION "authorization=xyz"             old="authorization=[REDACTED]"             new="authorization=xyz"
REGRESSION "Authorization: token ghp_abc123"  old="Authorization: [REDACTED] ghp_abc123"  new="Authorization: token ghp_abc123"
REGRESSION "Authorization: secret123"      old="Authorization: [REDACTED]"            new="Authorization: secret123"
REGRESSION "Authorization: ApiKey sk-live" old="Authorization: [REDACTED] sk-live"    new="Authorization: ApiKey sk-live"
REGRESSION "Authorization: OAuth tok"      old="Authorization: [REDACTED] tok"        new="Authorization: OAuth tok"
```

Reproduced end-to-end over the HTTP surface with an injected dispatch transport (operator-alice submits, operator-bob reads via `GET /hub/fleet/jobs/:jobId`):

```
submit 201
bob sees payload: {"keyLine":"key=SECRETKEYVAL","authLine":"[REDACTED]","authEq":"[REDACTED]","benign":"hello"}
bob sees stdout: "starting\nkey=SECRETKEYVAL\nAuthorization: token tok_abc123\nauthorization=xyzsecret\nfinished"
bob sees stderr: "KEY=anothersecret"
```

(The payload values `authLine`/`authEq` are redacted because `isSensitiveKey` matches the *field name* `authLine`; the leak is in the string values and in stdout/stderr, which is exactly the RFC-0014 D5 surface.)

Impact: a previously-fixed, canonical-form credential leak is reintroduced. `key=<value>` is the single most conventional secret-assignment form, and `Authorization: token …` / `Authorization: ApiKey …` are real non-Basic/non-Bearer schemes. The values are cross-operator readable through job `payload` and node `stdout`/`stderr`, deviating directly from RFC-0014 D5. This is a regression of a control the round-3 review explicitly verified as fixed (that review's Verification section recorded `key=abc` and `Authorization` as redacted).

Graded **P1** because it is a regression ("现实条件下的重大功能错误或回归") of a security control on canonical forms. Note that even under the more lenient P2 calibration the prior rounds used for this scrubber class, the finding still blocks the Gate under SOP §5.

Minimal fix direction: re-add the bare alternatives, e.g. `(?:token|secret|password|passwd|pass|key|api[_-]?key|apikey|credential|authorization|auth[_-]?token|session[_-]?id)` (or restore `key|authorization` inside the existing alternation while keeping the new prefix class), and add regression assertions for `key=`, `key:`, `authorization=`, and `Authorization: <non-Basic scheme> <token>` to the P1 test.

### [P2] Regression: `isSensitiveKey` no longer redacts `sessionKey` / `sessionValue` / `sessionData` / `sessionBlob` / `sessionNonce`

`src/registry/fleet-scheduler.mjs:94-98` and `src/registry/registry.mjs:94-98`

The round-3 predicate used `lower.includes("session")`, which redacted every `session*` key. Round 4 replaced it with `lower === "session" || includes("sessionid") || includes("session_id") || includes("session-id")`, so session-prefixed keys that carry a credential but do not end in `id` are no longer redacted. Verified against the committed prior module:

```
sessionKey     old=REDACT new=keep   <== LOST REDACTION
sessionValue   old=REDACT new=keep   <== LOST REDACTION
sessionData    old=REDACT new=keep   <== LOST REDACTION
sessionBlob    old=REDACT new=keep   <== LOST REDACTION
sessionNonce   old=REDACT new=keep   <== LOST REDACTION
sessionToken / sessionSecret / sessionCookie / sessionId / session   old=REDACT new=REDACT  (still covered)
```

Impact: an operator-supplied payload field named `sessionKey`/`sessionValue`/… (holding a session key or opaque session blob) is returned verbatim to any other operator reading the job or the audit read-model, in the leak direction that RFC-0014 D5 forbids. Graded **P2** (not P1) because it is latent today — a repository-wide grep of all `recordAudit` call sites and payload constructions finds no live `sessionKey`/`sessionValue`/`sessionData`/`sessionBlob`/`sessionNonce` key; it requires an operator to choose that specific field name. Minimal fix: match the credential suffix/whole-word forms (`includes("sessionkey")`, `includes("sessionvalue")`, `includes("sessionnonce")`, `includes("sessionblob")`, `includes("sessiondata")`) or narrow the allow-list to the two benign keys actually required (`sessioncount`, `sessionstate`) while restoring a broader `session` match.

### [P3] New over-redaction: `basic <base64-ish>` and the `pass` alternative mangle benign text

`src/registry/fleet-scheduler.mjs:121` (`/basic\s+[a-zA-Z0-9+/=]{8,}/gi`), `src/registry/fleet-scheduler.mjs:132` (`pass` alternative)

The new `basic …` rule is not anchored to an authorization context, so ordinary English matches whenever a word of ≥8 `[A-Za-z0-9+/=]` characters follows "basic". The `pass` alternative similarly matches `bypass`/`compass` (prefix class + `pass`):

```
"basic authentication failed for user johnsmith" -> "Basic [REDACTED_AUTH] failed for user johnsmith"
"basic configuration settings applied"           -> "Basic [REDACTED_AUTH] settings applied"
"the basic authentication mechanism is disabled" -> "the Basic [REDACTED_AUTH] mechanism is disabled"
"bypass=1"  -> "bypass=[REDACTED]"     "compass=1" -> "compass=[REDACTED]"
"bypass: enabled" -> "bypass: [REDACTED]"
```

Impact: silent corruption of benign log/stdout text in the job read-model (`GET /hub/fleet/jobs/:jobId`, `listJobs`) and audit detail. No leak; read-model usefulness only. Graded **P3** consistent with the prior rounds' calibration for over-redaction. Minimal fix: require an authorization context for the base64 rule (it is already covered by the `authorization: basic …` rule above it), and drop the bare `pass` alternative (keep `passwd`/`password`, which do not collide with `bypass`/`compass`).

### [P3] Test coverage: the new assertions do not cover the regressed bare forms

`test/v07-stage2-fleet-endpoints.test.mjs:438-447,475-482`

The extended P1 test asserts only the prefixed/quoted/Basic/curl vectors named in the round-3 finding; `grep` of the test for `key=`/`key:`/`authorization=`/`Authorization: token` returns nothing. The regression in Finding 1 is therefore invisible to the suite, and the P3 malformed-route test now covers the full node surface but has no counterpart asserting the still-redacted bare forms. Graded **P3**. Minimal fix: add the Finding-1 vectors as assertions (they are cheap and would have caught the regression).

---

## Verification

Executed in `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate` (Node v25.9.0, Git Bash on win32):

- `git rev-parse HEAD` → `dd5858dd8040d382bc78431c550a7fc0a1d3ec1e`; `git branch --show-current` → `chore/v0.7-stage2-fleet-endpoints`; `git status --porcelain` → empty (clean worktree).
- `git diff --stat d137256..dd5858d` → exactly the five declared files (+287 / -27); `git show -s` confirms the reviewed commit/message.
- `git diff --check` → clean (exit 0).
- `node scripts/check-public-tree.mjs` → "Public-tree validation passed." (exit 0).
- `npm run check` (public-tree + full suite) → **567 tests, 561 pass, 0 fail, 6 skipped** — matches the claimed figures. The 6 skipped are pre-existing, environment-gated suites (POSIX permission bits on Windows, `DSH_ACCEPTANCE_ROOT` unset, mounted Stage 7 drill).
- `node --test test/v07-stage2-fleet-endpoints.test.mjs` → 9/9 pass.
- Mirrored predicates: `sed`-extracted `isSensitiveKey` from `fleet-scheduler.mjs` and `registry.mjs` are byte-identical (`diff` clean).

Independent read-only ESM reproductions against the committed modules and against the actual prior module (`git show d137256:src/registry/fleet-scheduler.mjs`, materialised outside the repo under the OS temp dir; worktree re-verified clean afterwards):

- **Round-3 finding 1 (named vectors) — FIXED:** `DB_PASSWORD=`, `DATABASE_PASSWORD=`, `MYSQL_PASSWORD=`, `POSTGRES_PASSWORD=`, `PGPASSWORD=`, `REDIS_PASSWORD=`, `SMTP_PASSWORD=`, `GITHUB_TOKEN=`, `ACCESS_TOKEN=`, `REFRESH_TOKEN=`, `AUTH_TOKEN=`, `AWS_SECRET_ACCESS_KEY=`, `SECRET_KEY=`, `MY_SECRET=`, `CLIENT_SECRET=`, `OPENAI_API_KEY=`, `STRIPE_SECRET_KEY=`, `X_API_KEY=` all → `[REDACTED]`; `password="hunter2"`, `password='hunter2'`, `GITHUB_TOKEN="ghp_abc"`, `AWS_SECRET_ACCESS_KEY='secret_key_abc'` → `[REDACTED]`; `Authorization: Basic dXNlcjpwdw==` and `authorization: basic …` → `Authorization: Basic [REDACTED_AUTH]`; `curl -u user:pw`, `curl --user admin:mypassword` → `curl -u user:[REDACTED]`.
- **Round-3 finding 1 — REGRESSION (Finding 1):** bare `key=`, `key:`, `Authorization=`, `authorization=`, `Authorization: token …`, `Authorization: secret123`, `Authorization: ApiKey …`, `Authorization: OAuth …` return verbatim; confirmed both at `scrubString` level and end-to-end (operator-bob reading operator-alice's stdout/stderr/payload).
- **Round-3 finding 2 (benign identifiers) — FIXED:** `author`, `authority`, `routeAuthority`, `sessionCount`, `sessionState`, `keyId`, `nodeId`, `requestId`, `monkey`, `hockey` all preserved by `isSensitiveKey`; `token`, `secret`, `password`, `apiKey`, `sessionId`, `auth`, `authorization`, `key`, `cookie`, `csrf` still redacted. Audit-detail array recursion and benign-key preservation re-verified via `GET /hub/audit`.
- **Round-3 finding 2 — new gap (Finding 2):** `sessionKey`/`sessionValue`/`sessionData`/`sessionBlob`/`sessionNonce` no longer redacted (prior module redacted them).
- **Round-3 finding 3 (malformed encoding) — FIXED:** `GET|PUT|DELETE /hub/nodes/%ZZ…`, `GET /hub/nodes/%ZZ/route-target`, `POST /hub/nodes/%ZZ/{delete,reenroll}` all → **400 bad-request**; `GET /hub/fleet/jobs/%ZZ`, `…/audit`, `POST …/cancel` → 400; query strings `?limit=%ZZ`, `?x=%ZZ`, `?jobId=%ZZ` → 400; `/hub/nodes/%E0%A4%A` (truncated UTF-8) → 400. An exhaustive fuzz of the management surface (4 methods x 18 malformed/traversal paths, incl. `%C0%AF`, encoded `../../etc`) produced **zero 5xx**.
- **`getJob` scrubbing path:** `payload` (`fleet-scheduler.mjs:403`) and `results` (`:412`) are both scrubbed by default; `listJobs` (`:420`) routes through `getJob`.
- **No new ReDoS introduced:** the `url-password` regex is the quadratic one (~3.5s on a 100 KB single token) and is **unchanged and pre-existing**; benchmarked old vs new on 100 KB adversarial inputs shows no regression (`token=100KB` x1.0, `basic 100KB` x1.0, `curl 50KB` x1.0, realistic 20 KB log 0.1→0.3ms). Only the inline-assignment regex is materially on the hot path for large logs and remains linear.
- **Regression sanity:** the P0 audit-redaction/principal-binding, P2 audit-query 400, and P2 cancel-terminal 409 tests still pass.

Not verified (out of Stage 2 scope; no code exists yet): the UI Fleet Workflows view (Stage 3), real direct/reverse transport dispatch, and all M28 `mounted` fields. Production wiring of a real dispatch transport was not exercised — `bin/dsh-orbit-hub.mjs` constructs the scheduler with `dispatchTransport: options.fleetDispatchTransport ?? null`, so Findings 1-3 were reproduced with an injected transport and asserted at the `getJob`/`scrubString`/HTTP-surface level, not against a live node.

---

## Residual Risks

- **The scrubbing model remains heuristic.** Even with Findings 1-2 fixed, string-level redaction cannot be complete (base64-only payloads, arbitrary key names). The durable control would be operator-scoped job visibility, which remediation again declined in favour of scrubbing.
- **Cross-operator job visibility is still unrestricted.** Any authenticated operator can read any other operator's job snapshot, and a replay of another operator's `jobId` returns that snapshot with 200. This is the channel that exposes Findings 1-2. Whether this is intended is not stated in RFC-0014 or the SOP.
- **`isSensitiveKey` allow-list is broad in the leak direction.** `lower.includes("authority")`, `includes("sessioncount")`, `includes("sessionstate")` are checked *before* the sensitive tests, so a hypothetical key such as `authorityToken` or `sessionCountSecret` would be allow-listed and leak. No live call site; latent.
- **Audit-write failures remain silently swallowed and non-transactional (prior residual, unchanged).** `fleet-scheduler.mjs` `onJobCompleted` and `server.mjs:1094` (`catch {}`) discard errors; `fleet.job.create` is written after execution has started asynchronously. RFC-0014 D5's "writes directly to the Hub's authoritative SQLite audit table" can therefore fail unobservably for M28 field 8. Fail-safe, not corrupting.
- **`FleetJobScheduler.jobs` is an unbounded in-memory `Map`** with no eviction/retention and no submit rate limit; pre-existing, now remotely reachable via `POST /hub/fleet/jobs`.
- The 6 skipped full-suite tests were enumerated and are pre-existing, environment-gated, and unrelated to this diff.

---

## Gate

**FAIL (REVISE/BLOCK)**

Rationale: the three findings named for round 4 are genuinely addressed — every prefixed env-var / quoted-value / Basic-auth / `curl -u` vector named in the round-3 P2 is now redacted, the benign identifiers (`author`/`authority`/`routeAuthority`/`sessionCount`/`sessionState`/`keyId`/`nodeId`/`requestId`/`monkey`/`hockey`) are preserved, and the entire node management surface now returns 400 on malformed `%ZZ` with zero 5xx under exhaustive fuzzing. The full suite (`npm run check`: 567/561/0/6), `check-public-tree`, and `git diff --check` all pass. However, the round-4 rewrite of the inline-assignment regex **regressed** previously-fixed, canonical-form credential scrubbing: bare `key=`/`key:` and `authorization=`/`Authorization: <non-Basic scheme> <token>` now leak through job `payload` and node `stdout`/`stderr`, cross-operator readable — a direct RFC-0014 D5 deviation and a regression of a control the round-3 review verified as fixed (Finding 1, P1). The predicate narrowing also stopped redacting credential-bearing `sessionKey`/`sessionValue`/… keys (Finding 2, P2), and the new `basic …`/`pass` rules over-redact benign text (Finding 3, P3). Per the SOP §5 Stop-Work matrix ("Non-zero P0, P1, or P2 finding | Blocker"), Findings 1-2 block Gate 2. Re-review is required after remediating Finding 1 (and preferably Findings 2-3), with regression assertions added for the bare forms.

---

## Review Report

`D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate\docs\review\2026-09-26-v07-stage2-gate-2-rereview-dd5858d.md`
