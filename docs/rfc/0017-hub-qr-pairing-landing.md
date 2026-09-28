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
   the raw query string of `GET /auth` must match `^token=[0-9]{6}$`
   byte-for-byte. Any other method, path, parameter count, parameter name, or
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
| Apex verify routing | The selector-apex allowlist gains exactly **one new tuple: `(POST, /hub/pairing/verify)`** (plus its existing trailing-slash variant), so the landing page's same-origin POST reaches the unchanged `handlePairingVerify`. Without this tuple the apex returns the selector-surface 404 and the whole flow is dead — verified by live probe at Gate A. `POST /hub/pairing/generate-code` stays management-only (minting must never become reachable from the open-bootstrap apex). |
| Mint base | New env `DSH_ORBIT_HUB_QR_PAIRING_BASE_URL`: when set and valid (https, no query, no userinfo), it replaces the request-Host-derived base in `/hub/pairing/generate-code`. Unset ⇒ today's behavior byte-for-byte. Machine-pairing env `DSH_ORBIT_HUB_PAIRING_BASE_URL` is untouched. |
| Fence exception | One total grammar over the **raw** query string: it must match `^token=[0-9]{6}$` byte-for-byte (no decoding, no parameter parsing, no trailing `&`, no leading `&`). Any other method, path, or raw query ⇒ the existing `400 query-not-allowed`, byte-identical. |
| Verification | Client-side: read token → `history.replaceState` scrub → `fetch("/hub/pairing/verify", {method: "POST", same-origin})` → map result states. Server-side: zero changes to the verify **handler**; the only server change is the apex routing tuple above. |
| Success behavior | Show a confirmed state and navigate to the first-party constant path `/` on the same origin (selector UI on the apex, management UI on management origins). Never a parameter-derived redirect. |
| Failure behavior | Map existing engine/handler outcomes only: `401 invalid-or-expired`, `429 rate-limited`, network errors ⇒ retry state. No new error codes. The verify handler emits **no `Retry-After` header** today and v0.10 does not add one; the locked state uses fixed fallback copy (engine lock default: 5 failures ⇒ 15 minutes). |
| Page asset | One file: `ui/auth/index.html` with inline CSS/JS, served to **both** authorities from a single dedicated root (`AUTH_UI_ROOT` → `ui/auth/`) — no per-branch copies (`SelectorUiAuthority`-style meta injection on the apex). |
| Edge strategy | On the public apex, **exactly** `GET /auth` and `POST /hub/pairing/verify` are exempt from the operator's edge basic-auth gate (a deployment-config change on the operator's NAS gateway, recorded in the closure evidence); every other apex path keeps the gate; the Cloudflare-Access fast path is unchanged. Rationale: the pairing code is the designed admission credential for exactly this surface — an unexempted edge gate would make the scanned flow impossible without sharing the edge password, defeating the feature. |
| Why the apex | The operator-designated phone-reachable origin is the public apex (`dsh.ikarikore.top`). The landing page is only useful if it is served where the QR actually points. |
| Why not mint on the apex | `POST /hub/pairing/generate-code` stays session-gated on the management surface. The apex's open session bootstrap must never become a code-minting oracle. |

## 3. Detailed Technical Design

### D1: `/auth` route surface and authority scope

`classifyHostAuthority` (RFC-0010) yields four host classes. Their `/auth`
behavior after this RFC:

| Host class | `GET /auth` behavior |
| --- | --- |
| `selector-apex` (e.g. `dsh.ikarikore.top`) | Served: the landing HTML. The selector strict allowlist grows by exactly two tuples: `(GET, /auth)` (no trailing-slash variant — `/auth/` is a rejected path) and `(POST, /hub/pairing/verify)` (plus the existing trailing-slash variant). `POST /hub/pairing/verify` must receive a **dedicated dispatch** to the unchanged `handlePairingVerify` — it MUST NOT be routed through the existing selector dispatch into `handleBrowserRequest`/`admitBrowserRequest`, whose product for an unauthenticated caller is `401 {"code":"gateway-denied"}` (live probing at Gate A confirmed both the current selector-surface 404 and this dispatch trap). `POST /hub/pairing/generate-code` remains outside the allowlist (404). |
| `unrelated` / management (e.g. `192.0.2.10:28443`, tailscale hostnames) | Served: the same landing HTML (added to the management UI asset map). This is where minting happens today. |
| `node-route` (`n-<32hex>.<routeDomain>`) | Not intercepted — proxied to the node DSH exactly as every other path (queries already pass through on route branches). Regression-asserted. |
| machine routes (`/api/v1/*` on hub authority) | Unchanged; `/auth` is not a machine path. |

**Asset serving.** A dedicated root constant `AUTH_UI_ROOT = new URL("../../ui/auth/", import.meta.url)` backs the `/auth` entry in **both** branches, so the single `ui/auth/index.html` is served from one file — the existing per-root asset maps (`UI_ASSETS` → `ui/`, `SELECTOR_UI_ASSETS` → `ui/selector/`) cannot express a shared file without either duplication or a per-entry root, and duplication is forbidden. The apex entry injects the existing `selector-authority` meta so the page can state which authority it stands on.

### D2: Query fence exception (narrow, fail-closed)

Today two branches reject every query string: the selector-apex branch and the
management branch (both return `400 query-not-allowed` before route
dispatch). The exception is a **single total grammar over the raw query
string**, deliberately not a parsed-parameter check:

- Method is exactly `GET`. `HEAD` and `OPTIONS` are **not** covered by the
  exception and fall through to the fence (400) — their current behavior is
  pinned by A6.
- Path is exactly `/auth` (no trailing-slash tolerance; `/auth/` is a
  distinct, rejected path).
- The raw query string, after the leading `?`, matches the regex
  **`^token\=[0-9]{6}$`** (equals sign escaped for clarity) byte-for-byte. No URL decoding, no
  `URLSearchParams` parsing, no tolerance for a trailing `&`, a leading `&`,
  doubled `&`, percent-encoded digits (`%31...`), plus-encoded characters,
  or any additional parameter. Anything else ⇒ `400 query-not-allowed`,
  byte-identical to today's rejection (status, code, and message).

The exception is evaluated as one allowlist predicate before the existing
fence check; the fence code itself is not weakened (its rejection path stays
byte-identical). Clarification carried over from v0.9, unchanged by this RFC:
raw queries that parse to zero parameters (e.g. `?`, `?&`) never enter the
fence at all on any path, so on `/auth` they serve the same landing HTML as
no query — no token is present to protect. A `/auth` request that passes the grammar proceeds to asset
serving **with the query string stripped from all server-side handling** —
the token is never parsed, logged, or echoed by the server.

### D3: QR mint base override

`/hub/pairing/generate-code` derives the mint base today as
`${trustedExternalScheme}://${request.headers.host}` — the origin the operator
happened to browse, which is typically a LAN address a phone cannot resolve or
trust. v0.10 adds:

- New env `DSH_ORBIT_HUB_QR_PAIRING_BASE_URL`. Validation lives in
  `validateHubConfig` (`src/registry/config.mjs`), collected and reported by
  the bin entrypoint's existing collect-then-exit pattern (clean
  `console.error` + `process.exit(1)`, no uncaught stack). Rules: must parse
  as an absolute URL, scheme exactly `https:`, no username/password, no
  search, no hash; port allowed (public origins behind non-standard ports
  remain expressible).
- When set, `generate-code` uses it verbatim as `hubBaseUrl` for
  `pairingEngine.generateCode`. When unset, behavior is byte-identical to
  v0.9 (request-Host-derived).
- The machine-pairing env `DSH_ORBIT_HUB_PAIRING_BASE_URL` (node enrollment
  bootstrap payload, `registry.pair`) is a different mechanism for a different
  audience and is not read, reused, or renamed. The two envs have
  **intentionally different strictness**: the machine-pairing canonicalizer
  permits loopback `http:` because nodes bootstrap over trusted LAN
  transports, while the QR mint base is printed into a scannable URL and is
  therefore https-only with no userinfo. This difference is by design.
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
   - `locked` — 429 mapping; show fixed fallback copy ("too many attempts;
     try again later" — the engine lock default is 5 failures ⇒ 15 minutes).
     The verify handler emits no `Retry-After` header and v0.10 does not add
     one; if a future wave adds it, the page may honor it then.
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
session `Set-Cookie`, `401 {error:{code,message}}`, `429 {error:{code,message}}`
(no `Retry-After` header exists and none is added). The success cookie
(`Path=/hub`, host-scoped) is valid on the
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

### D7: Acceptance Matrix for v0.10 (M17 Matrix — 17 Canonical Fields)

Automated qualification (candidate-bound, mechanically validated):
`scope: "automated"` — 13 fields.

| # | Field | Mechanical assertion |
| --- | --- | --- |
| A1 | `/auth` no query, management authority | 200, `text/html`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` |
| A2 | `/auth?token=123456`, management authority | 200, same headers, token absent from response body |
| A3 | Fence narrowness — extra parameters | `GET /auth?token=123456&x=1` / `GET /auth?token=123456&` / `GET /auth?&token=123456` / `GET /auth?token=123456&&` ⇒ all 400 `query-not-allowed` |
| A4 | Fence narrowness — shape and encoding | `GET /auth?token=12345` / `?token=1234567` / `?token=abcdef` / `?code=123456` / `?token=<percent-encoded digits>` ⇒ all 400 (raw-regex match only; no decoding) |
| A5 | Fence unchanged elsewhere | `GET /styles.css?v=1` and `GET /?token=123456` ⇒ 400 (v0.9 behavior) |
| A6 | Method discipline | `POST /auth` ⇒ 404; `POST /auth?token=123456` ⇒ 400 `query-not-allowed` (fence fires before method handling); `HEAD /auth?token=123456` and `OPTIONS /auth?token=123456` ⇒ 400 (exception is GET-only); `GET /auth/` ⇒ 404 (distinct rejected path) |
| A7 | Apex serving | `GET /auth?token=123456` on `selector-apex` host ⇒ 200 with `selector-authority` meta; node list still gated by session |
| A8 | Node-route passthrough | `GET /auth?token=123456` on `n-<hex>` host ⇒ proxied to node DSH (no registry interception), behavior identical with and without query |
| A9 | Mint override set | env valid ⇒ minted `url` starts with override origin, `/auth?token=<6 digits>` shape, `code` 6 digits |
| A10 | Mint override unset | minted `url` starts with `https://<request host>` (v0.9 byte-identical) |
| A11 | Mint override invalid | non-https / with-query / userinfo ⇒ boot exits 1 with a clean collected-config error (no uncaught stack) |
| A12 | Zero leakage | audit store + all captured responses/logs for a full verify round contain no `token=` value; session cookie attributes unchanged (regression) |
| A13 | Apex verify routing | on the `selector-apex` host, `POST /hub/pairing/verify` and `POST /hub/pairing/verify/` reach the `handlePairingVerify` contract: an unknown code ⇒ **401 with `error.code === "code-not-found"`** — explicitly not the selector-surface 404 and not `401 {"code":"gateway-denied"}` (the existing selector dispatch's product); `POST /hub/pairing/generate-code` on the apex still ⇒ 404 selector-surface |

Mounted qualification (live, two-node deployment):
`scope: "mounted"` — 4 fields.

| # | Field | Live assertion |
| --- | --- | --- |
| M1 | Happy path scan | operator mints code via management UI (override base = public apex); phone scans QR and lands on `/auth` **without edge credentials** (edge exemption per §2 Edge strategy); landing page verifies over verified TLS; selector UI reachable with operator session on the phone |
| M2 | Dead code scan | expired or already-verified code ⇒ explicit failure state; no session cookie set |
| M3 | Address-bar scrub | after landing, the code is absent from the address bar and history |
| M4 | Replay denial | second verification of the same (destroyed) code ⇒ failure state, no new session |

## 4. Security Considerations & Threat Model

- **Public exposure delta — stated precisely.** In v0.9, `POST
  /hub/pairing/verify` existed only on the management surface; on the public
  apex it returned the selector-surface 404 (confirmed by live probe at Gate
  A). v0.10 therefore extends code-verification — and with it, operator
  **session issuance** — to the public apex for the first time. The delta is:
  a holder of a live code who reaches the apex obtains an operator session on
  that origin **without gateway admission**, gated solely by the pairing
  engine (6-digit space, 300 s window, single-use destruction, per-IP
  lockout: 5 failures ⇒ 15 min). This is a real, new exposure surface — not
  a restatement of v0.9 semantics — and it is accepted because the code is
  the designed admission credential and the alternative (typing the code
  into a management UI) was never phone-reachable anyway.
- **Edge strategy — decided.** On the public apex, exactly `GET /auth` and
  `POST /hub/pairing/verify` are exempt from the operator's edge basic-auth
  gate (deployment-config change on the operator's NAS gateway, recorded in
  the closure evidence). Every other apex path keeps the edge gate; the
  Cloudflare-Access fast path is unchanged. Without the exemption the
  scanned flow would demand the edge password on the phone — sharing the
  edge password would be strictly worse than exposing the two self-defending
  pairing paths. Residual risk if the exemption is mis-scoped in deployment:
  wider unauthenticated reach to the hub UI — mitigated by M1 asserting the
  exemption is sufficient for landing and by the edge gate remaining on `/`
  and all management paths.
- **Token leakage surfaces** addressed: browser history/address bar
  (replaceState scrub), Referer headers (no-referrer), intermediary caches
  (no-store), server logs/audit (never written), DOM (never rendered).
  Residual accepted risk: shoulder-surfing the QR itself (same as v0.9).
- **Fence integrity.** The exception is a single raw-query grammar, not a
  bypass flag; the fence's rejection path is byte-identical for everything
  outside the grammar, and A3–A6 pin it mechanically, including encoding and
  parameter-boundary variants.
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
