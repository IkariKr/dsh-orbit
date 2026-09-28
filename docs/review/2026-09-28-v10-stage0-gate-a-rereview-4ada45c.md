# v0.10 Stage 0 — Gate A Architecture Review (Re-review)

Reviewed head: `4ada45c` (`chore/v0.10-stage0-design`, pushed; remote-identical)  
Baseline re-verified: tag `v0.9.0-rc.1` → `145203b8219848796ef627b1f40c0c63233a1d31`,
ancestor of the reviewed head; product-code diff vs baseline empty (docs-only).  
Reviewer: independent `@code-reviewer` (read-only re-review with fresh live
probes and a full mechanical re-run)  
Date: 2026-09-28  
Predecessor: `docs/review/2026-09-28-v10-stage0-gate-a-review-38bc2d4.md` (first
review, FAIL)

## Verdict

**Gate A Verdict: PASS** — P0 = 0, P1 = 0, P2 = 0, P3 = 3
(PASS with non-blocking findings).

## Verification performed by the reviewer

- `npm run check` green (623 tests / 617 pass / 0 fail / 6 skipped);
  `check-public-tree` independently re-run, PASS.
- Live `createHubServer` probes against apex / management / node-route
  authorities re-confirmed every fixed assertion, including raw request-target
  variants (`#fragment`, `%20`, `+`, absolute-form) — no new bypass surface.
- All 8 first-review fixes verified point-by-point against code facts (apex
  verify tuple in RFC §2/D1/A13/authorization JSON; TEST-NET-1 substitution;
  single raw-query grammar; A6 measured status codes; precise public-exposure
  delta and decided edge strategy; M17 matrix script staged as Gate 1's first
  deliverable; `AUTH_UI_ROOT` single asset root; `validateHubConfig` locus with
  the intentional strictness delta vs the machine-pairing canonicalizer).
- M17 field count (13 automated + 4 mounted) consistent across RFC, SOP, and
  authorization JSON; no stale M16 references.

## Non-blocking findings (P3 ×3) and disposition

1. **A13's mechanical form was not discriminating** — on the apex, extending
   the existing selector allowlist boolean would dispatch into
   `handleBrowserRequest` → `admitBrowserRequest` and yield
   `401 {"code":"gateway-denied"}`, which the old "e.g. 401" example also
   satisfies. **Converged now**: A13 pins the error code — apex
   `POST /hub/pairing/verify` with an unknown code ⇒ 401 with
   `error.code === "code-not-found"`, explicitly excluding both
   `gateway-denied` and the selector-surface 404 — and RFC D1 + SOP Stage 1
   now require a **dedicated dispatch** of that tuple to
   `handlePairingVerify` (not an `isAllowedSelectorApi` extension).
2. **SOP Stage 3 still contained "`Retry-After` honored"** — removed;
   replaced with "locked state uses fixed fallback copy and asserts the 429
   mapping". The authorization JSON `should` line reworded to "retry guidance
   (fixed copy)".
3. **Gate A exit threshold implicit; `/auth/` not pinned.** Converged: SOP
   Gate A exit criteria now state "P0/P1/P2 = 0"; A6 additionally pins
   `GET /auth/` ⇒ 404.

These P3 fixes land in the follow-up commit on this branch before Stage 1
begins; they are documentation/test-precision only (verified against the
reviewer's line references) and do not alter any decided design point.

## Gate outcome

Gate A is **closed with GO**. Per the v0.10 SOP, Stage 1 (registry `/auth`
surface, fence exception, mint base override, matrix script +
governance-contract test) is now authorized to begin on
`chore/v010-stage1-registry-auth-surface`.
