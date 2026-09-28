# v0.10 Stage 1 — Gate 1 Review

Reviewed head: `f989b98` (`chore/v010-stage1-registry-auth-surface`, pushed)  
Base: `eb22f1e` (Gate A PASS closure on `chore/v0.10-stage0-design`)  
Reviewer: independent `@code-reviewer` (read-only; live `createHubServer` probes
with Host override across apex / management / node-route authorities, real
`bin` boot-path exercise, full `npm run check`)  
Date: 2026-09-28

## Verdict

**Gate 1 Verdict: PASS** — P0 = 0, P1 = 0, P2 = 1, P3 = 7.

The reviewer confirmed on every load-bearing point that the implementation is
faithful to the Gate A design:

- The fence exception is a raw-query allowlist predicate layered before an
  unchanged, byte-identical rejection path; a broad bypass sweep (absolute-form
  targets, `#fragment`, `%`/`+` encodings, double `?`, case variants, `;`,
  `/auth/`, HEAD/OPTIONS, `//auth`, `/./auth`, traversal) found **no bypass
  surface**.
- The apex verify tuple reaches `handlePairingVerify` by dedicated dispatch;
  A13's `code-not-found` pin holds and is discriminating; cross-origin ⇒ 403,
  cross-site ⇒ 403, oversized body ⇒ 413; `generate-code` stays 404 on the
  apex.
- `/auth` is served from one shared `AUTH_UI_ROOT` on both branches with
  `no-store`/`no-referrer` and apex-only `selector-authority` meta.
- The mint override is applied to both `generate-code` and `pairing/status`
  with fail-closed double validation; the machine-pairing env is untouched;
  unset behavior is byte-identical to v0.9.
- `npm run check` green: 636 tests / 630 pass / 0 fail / 6 skipped — zero
  regressions against the v0.9 baseline (623).

## Findings and disposition (converged in follow-up commit before Stage 2)

- **[P2] Empty-string env value crashed boot with an uncaught stack** —
  `validateHubConfig` treated `""` as unset while `createHubServer`/`bin`
  treated it as set-and-invalid, so `DSH_ORBIT_HUB_QR_PAIRING_BASE_URL=`
  passed config and then threw raw. **Fixed**: bin normalizes `""` → `null`
  (repo-wide env convention, mirroring the machine-pairing canonicalizer);
  A11 now pins the unset semantics for `""`.
- **[P3] Path-bearing mint override accepted but semantically split** (mint
  dropped the path, `pairing/status` echoed it). **Fixed**: both validators
  now require an origin-only https URL (`pathname === "/"`), and A11 pins
  `https://pair.example.org/hub` as rejected.
- **[P3] Zero-parameter raw queries (`?`, `?&`) on `/auth` served 200** —
  pre-existing v0.9 fence posture for every path (fence gates on
  `searchParams.size > 0`), no token involved. **Converged in D2 wording**
  rather than behavior: documented as carried-over v0.9 behavior, unchanged.
- **[P3] M17 script lacked the report generators every v0.6–v0.9 matrix
  script exports.** **Fixed**: `generateM17AutomatedQualificationMatrix` and
  `generateCandidateBoundAutomatedReport` added with governance-test coverage
  (summary 17/13/4, `QUALIFIED_AUTOMATED`).
- **[P3] A7's second clause (apex node list still gated) unpinned.** **Fixed**:
  the apex test now asserts `GET /hub/selector/nodes` without a session ⇒ 401
  `gateway-denied`.
- **[P3] A12's test title overclaimed (no stdout/stderr scan)** — accepted as
  staging per SOP: the complete leakage sweep (including logs) is a Stage 3
  deliverable; Stage 2 will rename the test to match its stage scope.
- **[P3] D1's trailing-slash parenthetical contradicted D2/A6** (`/auth/` is a
  rejected path; only verify has a trailing-slash variant) and one new code
  comment claimed the apex verify tuple was "the only mutation surface" when
  session mutations also exist (gateway-gated). **Both fixed** (doc wording +
  comment now says "the only unauthenticated mutation surface").

## Gate outcome

Gate 1 is **closed with PASS**. All convergence landed on
`chore/v010-stage1-registry-auth-surface` before Stage 2 began; the suite at
convergence is 637 tests / 631 pass / 0 fail / 6 skipped. Stage 2 (landing
page behavior and token hygiene) is authorized to begin.
