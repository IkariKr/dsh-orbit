# v0.10 Stage 3 — Gate 3 Review

Reviewed head: `a0c9067` (`chore/v010-stage1-registry-auth-surface`, pushed)  
Diff: `9fe813a..a0c9067` — test-only (`test/v10-stage3-hardening.test.mjs`,
+299); product bytes unchanged since Gate 1's reviewed implementation.  
Reviewer: independent `@code-reviewer2` (read-only; live engine contract
probes including the lockout sequence, mutant testing of the log-scan
channel, full `npm run check` and public-tree re-run)  
Date: 2026-09-28

## Verdict

**Gate 3 Verdict: PASS** — P0 = 0, P1 = 0, P2 = 1, P3 = 3
(reviewer's gate note: Stage 3 has no P0/P1/P2 = 0 threshold of its own; the
P2 is nonetheless converged before the candidate freeze as recommended).

Confirmed by the reviewer: the lockout interplay matches the engine
semantics exactly (attempts 1–5 → 401 `code-not-found`, attempt 6 on a live
code → 429 `rate-limited`, 900 s lock); the audit/response/log sweep is real
(a console.log mutant fails the suite); the 429 carries no `Retry-After`
header; the 13 automated M17 fields all have mechanical tests; the mounted
preconditions are documented; `npm run check` 647/641/0/6 and public-tree
PASS; the Stage 3 file is flake-free across 8 solo runs.

## Findings and disposition (converged before the candidate freeze)

- **[P2] Session-cookie `Max-Age=43200` was not pinned** ("exact v0.9
  attributes" required it; a lifetime regression would have passed
  silently). **Fixed**: the verify-issued cookie and the `/hub/session`
  bootstrap cookie both assert `Max-Age=43200` plus the other attributes.
- **[P3] Failed-attempt and locked response bodies were captured but not
  asserted.** **Fixed**: each 401 failure body is asserted not to echo the
  submitted value (a server-side echo mutant would now fail).
- **[P3] Log-capture channel coverage incomplete** (`console.info/debug/
  trace/dir` missed). **Fixed**: all console channels are captured and
  restored; raw `process.stdout.write`/`stderr.write` are deliberately not
  intercepted — in-process the node:test runner owns those streams (its
  events contain this test's own title), and `src/` logs exclusively through
  the console channels, as the reviewer verified.
- **[P3] Malformed-Origin and empty-body verify paths unpinned; test 3's
  name overclaimed "apex".** **Fixed**: malformed Origin ⇒ 403
  `origin-denied` and empty body ⇒ 400 `bad-json` are pinned; the test is
  renamed "pairing verify defenses" (the apex routing pin remains A13 in the
  Stage 1 suite).

## Gate outcome

Gate 3 is **closed with PASS**; all findings converged on the branch before
the freeze. Suite at convergence: 647 tests / 641 pass / 0 fail / 6 skipped.
Stage 4 (candidate freeze, deployment qualification, mounted evidence) is
authorized to begin.
