# v0.10 Stage 0 — Gate A Architecture Review (First Review)

Reviewed head: `38bc2d4` (`chore/v0.10-stage0-design`, pushed)  
Baseline verified: tag `v0.9.0-rc.1` → `145203b8219848796ef627b1f40c0c63233a1d31`,
confirmed ancestor of the reviewed head; `git diff v0.9.0-rc.1 HEAD -- src ui bin
test scripts` empty (docs-only, RFC-first discipline held).  
Reviewer: independent `@code-reviewer` (read-only, live probing performed)  
Date: 2026-09-28

## Verdict

**Gate A Verdict: FAIL** — P0 = 0, P1 = 2, P2 = 3, P3 = 3.

The reviewer verified the design against the real implementation with live
`createHubServer` probes (apex, management, and node-route authorities) plus
mechanical suite runs. Design claims about fence locations, the apex strict
allowlist, `handlePairingVerify` semantics, `checkOriginAndFetchSite`, mint
base derivation, the machine-vs-QR pairing env split, and
`classifyHostAuthority` port rules were all confirmed accurate. The findings
below are design gaps, not documentation nits.

## Findings (all accepted; fixes applied before re-review)

- **[P1] Apex verify routing missing from scope.** The RFC's core flow (land
  on apex `/auth`, same-origin `POST /hub/pairing/verify`) is impossible as
  drafted: the apex branch is a strict `(method, path)` allowlist and
  `handlePairingVerify` is registered only on the management fall-through —
  live probe returned `404 "selector authority exposes only selector surface"`.
  The RFC granted the apex only a `(GET, /auth)` tuple, and neither the SOP
  Stage 1 deliverables nor the authorization JSON named the required routing
  change. Fix: RFC D1/D2 now grant exactly two apex allowlist tuples
  (`(GET, /auth)`, `(POST, /hub/pairing/verify)` + trailing-slash variants),
  new matrix field **A13** pins apex verify routing (and generate-code's
  continued 404), and the authorization JSON `must` list records the tuple
  change.
- **[P1] Stage 0 deliverables broke `npm run check`.** The RFC contained a
  site-specific private IPv4 (a private LAN address) flagged by
  `scripts/check-public-tree.mjs`, violating the SOP's own Stage 0 baseline
  and reddening CI. Fix: replaced with the TEST-NET-1 documentation address
  (`192.0.2.10`); a "credential-like assignment" flag from the percent-encoded
  matrix example was resolved by placeholder phrasing and a documented
  `token\=` regex spelling.
- **[P2] D2 grammar was ambiguously specified** (two divergent readings for
  `token=123456&`, `&token=123456`, `token=123456&&`, percent-encoded digits;
  HEAD/OPTIONS undefined). Fix: D2 is now a single total grammar over the raw
  query string — `^token\=[0-9]{6}$` byte-for-byte, no decoding, no parameter
  parsing; HEAD/OPTIONS explicitly excluded from the exception; A3/A4/A6 pin
  the boundary variants and exact status codes.
- **[P2] A6 asserted wrong status codes** (`POST /auth?token=…` is 400
  `query-not-allowed`, not 404/405). Fix: A6 states the measured codes.
- **[P2] Threat model misstatement + unresolved edge conflict.** "Identical to
  v0.9 semantics" was false for the apex (v0.9 never issued operator sessions
  there), and the RFC simultaneously required the public apex to be
  phone-reachable and kept the edge basic-auth gate in front of it. Fix: §4
  now states the exposure delta precisely (first-time operator-session
  issuance on the public apex without gateway admission, accepted because the
  code is the designed admission credential) and records a decided edge
  strategy: exactly `GET /auth` and `POST /hub/pairing/verify` are exempt
  from the edge basic-auth gate on the apex (deployment change recorded with
  the closure); all other apex paths keep the gate; M1 asserts landing
  without edge credentials.
- **[P3] Matrix script and governance-contract test were absent from Stage 0**
  (v0.9 Gate A precedent includes them). Fix: SOP Stage 1 now lists
  `scripts/v10-landing-acceptance-matrix.mjs` (M17 shape, `requirePass` /
  `scope` conventions) plus the governance-contract wiring as Gate 1's first
  review targets.
- **[P3] Shared asset root was unspecified** (the two existing asset maps
  bind to different roots; a shared file cannot be expressed without a
  per-entry root). Fix: RFC D1 specifies `AUTH_UI_ROOT` → `ui/auth/` backing
  the `/auth` entry on both branches; per-branch copies are forbidden
  (authorization JSON `outOfScope`).
- **[P3] Env validation locus and strictness delta unspecified.** Fix: RFC D3
  places validation in `validateHubConfig` with the collected-config clean
  exit, and records the intentional strictness difference versus the
  machine-pairing canonicalizer (QR base is printed into a scannable URL ⇒
  https-only, no userinfo).

Also accepted from residual risks: the RFC no longer promises a
`Retry-After` header (the verify handler emits none; v0.10 adds none; the
page's locked state uses fixed fallback copy).

## Disposition

All findings addressed in the follow-up design commit on
`chore/v0.10-stage0-design`. Re-review required before Gate A can close; see
the subsequent `2026-09-28-v10-stage0-gate-a-rereview-*.md` record.
