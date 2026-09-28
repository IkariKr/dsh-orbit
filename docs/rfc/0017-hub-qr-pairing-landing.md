# RFC 0017: Hub QR Pairing Landing Page for v0.10

Status: **Proposed / Stage 0 design package. Product code MUST NOT begin until
this RFC and the v0.10 SOP receive Architecture Review GO at Gate A.**

Authorization: `V10-CONSTRUCTION-20260928-A1`  
Baseline: `v0.9.0-rc.1` (`145203b8219848796ef627b1f40c0c63233a1d31`)  
Predecessor: RFC-0016 (v0.9 DSH plugin integration and QR pairing bootstrap)

## 1. Goal

Close the one carried-forward product gap of v0.9: the pairing engine mints
`/auth?token=<code>` QR URLs
(`src/registry/pairing-code.mjs`, `targetUrl = new URL("/auth", hubBaseUrl)`),
but the registry has no `/auth` route and its global query fence rejects every
request that carries a query string (`query-not-allowed`). A scanned QR today
lands on a 404 or a 400. v0.10 gives the scanned code a landing page and a
disciplined path into the existing verification endpoint — nothing more.

### Core Architecture and Security Invariants

1. **No new credentials.** The landing page consumes the existing
   `POST /hub/pairing/verify` (public, unauthenticated, engine-enforced
   single-use destruction, IP lockout) whose success already bootstraps the
   existing operator session with its exact cookie attributes
   (`HttpOnly; Secure; SameSite=Strict; Path=/hub; Max-Age=12h`). The page
   adds no token type, no endpoint, and no session semantics.
2. **The query fence stays fail-closed.** The global "no query strings"
   posture is preserved everywhere except one mechanically specified grammar:
   `GET /auth` with exactly one parameter named `token` whose value matches
   `^[0-9]{6}$`. Any other method, path, parameter count, parameter name, or
   value shape is rejected exactly as today.
3. **Node routes stay pure proxies.** Route authorities
   (`n-<32hex>.<routeDomain>`) proxy every path — including `/auth` — to the
   node's DSH. The registry never intercepts `/auth` on a node-route host and
   the fence exception never applies there (route branches already pass query
   strings through to the node; that behavior is unchanged and regression-
   asserted).
4. **Token hygiene.** The pairing code is a 300-second single-use operator
   admission secret. The landing page scrubs it from the address bar after
   reading, never renders it back, never transmits it anywhere except the
   verify POST, and the server never writes it to logs, audit records, or
   error bodies. `/auth` responses carry `Cache-Control: no-store` and
   `Referrer-Policy: no-referrer`.
5. **Verified TLS only.** Minted QR URLs must be `https://` (existing engine
   invariant, unchanged). The new mint base override is validated https-only
   at boot and per use.
6. **Zero external requests.** The page is one self-contained asset (inline
   CSS/JS), consistent with the v0.9 SVG-QR invariant. No CDN, no fonts, no
   analytics.

## 2. Decision Summary

| Decision | Choice |
| --- | --- |
| Landing route | `GET /auth` on the **selector-apex** authority and the **management (unrelated-host)** authority. 404 unchanged on machine routes; node routes proxy untouched. |
| Mint base | New env `DSH_ORBIT_HUB_QR_PAIRING_BASE_URL`: when set and valid (https, no query, no userinfo), it replaces the request-Host-derived base in `/hub/pairing/generate-code`. Unset ⇒ today's behavior byte-for-byte. Machine-pairing env `DSH_ORBIT_HUB_PAIRING_BASE_URL` is untouched. |
| Fence exception | Exactly `GET /auth?token=^[0-9]{6}$` (single parameter, single ampersand-free pair). Implemented as a pre-parse allowlist in the two affected branches; all other branches keep their existing fences. |
| Verification | Client-side: read token → `history.replaceState` scrub → `fetch("/hub/pairing/verify", {method: "POST", same-origin})` → map result states. Server-side: zero changes to the verify handler. |
| Success behavior | Show a confirmed state and navigate to the first-party constant path `/` on the same origin (selector UI on the apex, management UI on management origins). Never a parameter-derived redirect. |
| Failure behavior | Map existing engine/handler outcomes only: `401 invalid-or-expired`, `429 rate-limited` (+`retry-after`), network errors ⇒ retry state. No new error codes. |
| Page asset | One file: `ui/auth/index.html` with inline CSS/JS, served through the existing asset-map mechanism (`SelectorUiAuthority`-style meta injection where applicable). |
| Why the apex | The operator-designated phone-reachable origin is the public apex (`dsh.ikarikore.top`). The landing page is only useful if it is served where the QR actually points. |
| Why not mint on the apex | `POST /hub/pairing/generate-code` stays session-gated on the management surface. The apex's open session bootstrap must never become a code-minting oracle. |

## 3. Detailed Technical Design

### D1: `/auth` route surface and authority scope

`classifyHostAuthority` (RFC-0010) yields four host classes. Their `/auth`
behavior after this RFC:

| Host class | `GET /auth` behavior |
| --- | --- |
| `selector-apex` (e.g. `dsh.ikarikore.top`) | Served: the landing HTML (added to the selector strict allowlist as one `(GET, /auth)` tuple plus its fence exception). |
| `unrelated` / management (e.g. `192.168.1.4:28443`, tailscale hostnames) | Served: the same landing HTML (added to the management UI asset map). This is where minting happens today. |
| `node-route` (`n-<32hex>.<routeDomain>`) | Not intercepted — proxied to the node DSH exactly as every other path. Regression-asserted. |
| machine routes (`/api/v1/*` on hub authority) | Unchanged; `/auth` is not a machine path. |

The management branch serves `/auth` from `ui/auth/` the same way `UI_ASSETS`
serves the management UI; the apex branch serves it from the same file through
its own allowlist entry, injecting the existing `selector-authority` meta so
the page can state which authority it stands on.

### D2: Query fence exception (narrow, fail-closed)

Today two branches reject every query string: the selector-apex branch and the
management branch (both return `400 query-not-allowed` before route
dispatch). The exception is specified as a total grammar, not a flag:

- Method is exactly `GET` (HEAD follows Caddy/framework semantics; anything
  else ⇒ existing behavior).
- Path is exactly `/auth` (no trailing slash tolerance beyond what the
  existing routes already canonicalize; `/auth/` is a distinct, rejected
  path).
- The raw query string, after the leading `?`, contains exactly one
  `key=value` pair: `token=<value>` with `<value>` matching `^[0-9]{6}$`.
  Zero parameters, two parameters, unknown parameter names, repeated
  parameters, `+`/`%`-encoded characters that do not decode to plain digits,
  values of any other length ⇒ `400 query-not-allowed`, byte-identical to
  today's rejection.

The exception is evaluated before the existing fence check as an allowlist
predicate; the fence code itself is not weakened (its rejection message and
status stay identical). A `/auth` request that passes the grammar proceeds to
asset serving **with the query string stripped from all server-side
handling** — the token is never parsed, logged, or echoed by the server.

### D3: QR mint base override

`/hub/pairing/generate-code` derives the mint base today as
`${trustedExternalScheme}://${request.headers.host}` — the origin the operator
happened to browse, which is typically a LAN address a phone cannot resolve or
trust. v0.10 adds:

- New env `DSH_ORBIT_HUB_QR_PAIRING_BASE_URL`. Validation at boot (fail-closed,
  exit 1): must parse as an absolute URL, scheme exactly `https:`, no
  username/password, no search, no hash; port allowed (public origins behind
  non-standard ports remain expressible).
- When set, `generate-code` uses it verbatim as `hubBaseUrl` for
  `pairingEngine.generateCode`. When unset, behavior is byte-identical to
  v0.9 (request-Host-derived).
- The machine-pairing env `DSH_ORBIT_HUB_PAIRING_BASE_URL` (node enrollment
  bootstrap payload, `registry.pair`) is a different mechanism for a different
  audience and is not read, reused, or renamed.
- The `/hub/pairing/status` response's `hubBaseUrl` (request-Host-derived
  today) gains the same override semantics so the settings UI's status panel
  reflects the mint origin.

### D4: Landing page behavior and token hygiene

`ui/auth/index.html` (single file, inline CSS/JS, no external requests):

1. Read `location.search`; extract `token` (client-side duplicate of the D2
   grammar; a server-accepted request always satisfies it).
2. **Immediately** scrub: `history.replaceState(null, "", "/auth")` — the
   address bar, history entries, and session restore never retain the code.
3. States (all rendered from a fixed template; the code value is never
   interpolated into the DOM):
   - `verifying` — spinner text while the POST is in flight.
   - `confirmed` — verify returned 200; show success and a first-party link
     (and auto-redirect after a short delay) to `/` on the same origin.
   - `expired` / `invalid` — 401 mapping; show "code expired or invalid;
     request a new code from the operator".
   - `locked` — 429 mapping; show retry guidance honoring `Retry-After` when
     present.
   - `error` — network/5xx; show a retry action that re-runs step 3 only
     (the token is already scrubbed, so a retry keeps the in-memory value;
     a page reload intentionally starts over).
4. `fetch("/hub/pairing/verify", { method: "POST", credentials: "same-origin",
   headers: { "content-type": "application/json" }, body: JSON.stringify({
   token }) })` — same-origin by construction; `checkOriginAndFetchSite`
   accepts it (Origin matches Host on both authorities; `sec-fetch-site` is
   `same-origin` from a real browser).
5. `<meta name="referrer" content="no-referrer">` and no `preload`/`prefetch`
   of anything that could carry the token.

### D5: Verification, session bootstrap, and post-success navigation

Zero server changes to `handlePairingVerify`. The existing response contract
is consumed as-is: `200 {ok, principal, csrfToken, expiresAt}` with the
session `Set-Cookie`, `401 {error:{code,message}}`, `429` with
`retry-after`. The success cookie (`Path=/hub`, host-scoped) is valid on the
same origin that served `/auth`, so the constant `/` target works on both
authorities: on the apex it reaches the selector UI (which resumes via
`GET /hub/session`); on management origins it reaches the management UI.
The page performs no cross-origin navigation and accepts no redirect target
from any parameter.

### D6: Logging, caching, and leakage controls

- Server: the token is read only by the fence predicate as a shape check; it
  is not included in `recordAudit` payloads, error bodies, or console output.
  (Pre-existing v0.9 behavior, recorded but unchanged here:
  `pairing.code.generate` audit entries contain the operator-minted code —
  generation-side, operator-visible by design, 300 s single-use.)
- `Cache-Control: no-store` on every `/auth` response (the QR URL contains
  the code; no intermediary may retain it).
- `Referrer-Policy: no-referrer` on `/auth` responses.
- The engine's existing controls are the only brute-force defense and are
  explicitly reused: 6-digit space, 300 s TTL, single-use destruction,
  per-IP failure lockout (5 failures ⇒ 15 min lock), per-IP rate limits.

### D7: Acceptance Matrix for v0.10 (M16 Matrix — 16 Canonical Fields)

Automated qualification (candidate-bound, mechanically validated):
`scope: "automated"` — 12 fields.

| # | Field | Mechanical assertion |
| --- | --- | --- |
| A1 | `/auth` no query, management authority | 200, `text/html`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` |
| A2 | `/auth?token=123456`, management authority | 200, same headers, token absent from response body |
| A3 | Fence narrowness — two params | `GET /auth?token=123456&x=1` ⇒ 400 `query-not-allowed` |
| A4 | Fence narrowness — shape | `GET /auth?token=12345` / `?token=1234567` / `?token=abcdef` / `?code=123456` ⇒ 400 |
| A5 | Fence unchanged elsewhere | `GET /styles.css?v=1` and `GET /?token=123456` ⇒ 400 (v0.9 behavior) |
| A6 | Method discipline | `POST /auth` and `POST /auth?token=123456` ⇒ 404/405 (no landing path opens a POST surface) |
| A7 | Apex serving | `GET /auth?token=123456` on `selector-apex` host ⇒ 200 with `selector-authority` meta; node list still gated by session |
| A8 | Node-route passthrough | `GET /auth?token=123456` on `n-<hex>` host ⇒ proxied to node DSH (no registry interception), behavior identical with and without query |
| A9 | Mint override set | env valid ⇒ minted `url` starts with override origin, `/auth?token=<6 digits>` shape, `code` 6 digits |
| A10 | Mint override unset | minted `url` starts with `https://<request host>` (v0.9 byte-identical) |
| A11 | Mint override invalid | non-https / with-query / userinfo ⇒ boot exits 1 |
| A12 | Zero leakage | audit store + all captured responses/logs for a full verify round contain no `token=` value; session cookie attributes unchanged (regression) |

Mounted qualification (live, two-node deployment):
`scope: "mounted"` — 4 fields.

| # | Field | Live assertion |
| --- | --- | --- |
| M1 | Happy path scan | operator mints code via management UI (override base = public apex); phone scans QR; landing page verifies over verified TLS; selector UI reachable with operator session on the phone |
| M2 | Dead code scan | expired or already-verified code ⇒ explicit failure state; no session cookie set |
| M3 | Address-bar scrub | after landing, the code is absent from the address bar and history |
| M4 | Replay denial | second verification of the same (destroyed) code ⇒ failure state, no new session |

## 4. Security Considerations & Threat Model

- **Public exposure delta.** The apex is publicly reachable, so v0.10 makes
  `GET /auth` and (via the page) `POST /hub/pairing/verify` reachable there.
  The verify endpoint's defenses are pre-existing and engine-level: 6-digit
  space, 300 s window, single-use destruction, per-IP lockout. A distributed
  guesser needs to defeat all four simultaneously; the operator's edge
  authentication (Cloudflare Access / basic auth, preserved in front of the
  hub) adds an outer gate on the public apex.
- **Operator session by code possession.** Whoever holds a live code and
  reaches the mint origin obtains an operator session on that origin for the
  cookie lifetime. This is identical to v0.9 semantics (the code was always
  the admission secret); the landing page only removes the manual typing
  step. Codes are shown only on the operator's own screen for 300 s.
- **Token leakage surfaces** addressed: browser history/address bar
  (replaceState scrub), Referer headers (no-referrer), intermediary caches
  (no-store), server logs/audit (never written), DOM (never rendered).
  Residual accepted risk: shoulder-surfing the QR itself (same as v0.9).
- **Fence integrity.** The exception is a total grammar, not a bypass flag;
  the fence's rejection path is byte-identical for everything outside the
  grammar, and A3–A5 pin it mechanically.
- **No new origin authority.** Mint-base override changes which origin a QR
  points at, not what any origin may do. The override is https-only and
  boot-validated; a mis-set value fails closed at startup, not at scan time.

## 5. Stop-Work Matrix

| Trigger | Action |
| --- | --- |
| A review requires weakening the fence beyond the D2 grammar | Stop; escalate to architecture review — the fence posture is a design invariant, not an implementation detail |
| A requirement needs the landing page to carry its own credential or session type | Stop; that is a new protocol, out of v0.10 scope |
| The verify handler needs server changes to support the page | Stop; the page consuming the existing contract is a scope invariant |
| Wildcard node-route/DNS/Cloudflare work is requested alongside | Stop; operator infrastructure decision, explicitly out of scope |
| Real DSH or harness changes are needed for evidence | Stop; new candidate per the candidate-freeze rule |
| Any pressure to mint codes on the selector apex | Stop; minting stays session-gated on the management surface |
