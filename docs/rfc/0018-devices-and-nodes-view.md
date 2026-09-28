# RFC 0018: Unified Devices and Nodes View for v0.11

Status: **Proposed / Stage 0 design package. Product code MUST NOT begin until
this RFC and the v0.11 SOP receive Architecture Review GO at Gate A.**

Authorization: `V11-CONSTRUCTION-20260929-A1`  
Baseline: `v0.10.0-rc.1` (`cc826b720124bd9249a334c6f1786e73bb44266b`)  
Predecessors: RFC-0011 (browser node selection), RFC-0013 (multi-node sessions
and target scope), RFC-0017 (hub QR pairing landing page, v0.10)

## 1. Goal

Deliver the one roadmap 0.6 SHOULD line that shipped waves have not yet built:
a **first-class Devices and Nodes view** in the authenticated operator surface
(`docs/ux/dsh-remote-mobile.md` §"Recommended roadmap placement", 0.6 row) —
browser-session visibility, per-node session/connection indicators, explicit
target scope, and mobile-friendly selector/session navigation.

Concretely, against the v0.10 baseline:

- The operator can see **which operator sessions exist** and **revoke** one
  explicitly. Today the only session visibility is a bare count in
  `GET /hub/pairing/status` (`src/registry/server.mjs:972`,
  `registry.countActiveSessions()`); there is no list and no per-session
  revocation (only self-logout, `POST /hub/session/logout`).
- The **selector** shows per-node connection indicators. Today
  `buildSelectorNodeRow` exposes reachability, route mode, and reverse
  presence (`src/registry/selector-view.mjs:100-130`) but not
  `activeFlows`, although the hub already tracks it per node
  (`src/registry/server.mjs:1536`) and the management UI already renders it
  (`ui/app.mjs:144-146`).
- The selector states the **target route authority explicitly** before
  navigation, and the selector is **usable on a phone**. Today
  `ui/selector/styles.css` contains no `@media` rule at all (a single
  `max-width: 960px` shell at line 62), so narrow-viewport behavior is
  accidental rather than designed; target visibility is implicit in the
  `openUrl` link (`ui/selector/view-model.mjs:61-70`).

The wave is a **read-model and presentation wave with exactly one new
mutation** (explicit session revocation). It changes no route eligibility, no
cookie semantics, no edge posture, and no node-route behavior.

### Core Architecture and Security Invariants

1. **Device ≠ node.** A browser session is an operator session; a node is an
   enrolled DSH runtime. The view may present both together but must never
   treat a session as a node identity or vice versa
   (`docs/ux/dsh-remote-mobile.md` §"Distinguish browser devices from DSH
   nodes"). Stable identities remain the Registry's (`nodeId`) and the
   session store's (`sessionId`).
2. **No global active node, no cross-node session migration, no implicit
   broadcast, no automatic retargeting.** These are the four 0.6 boundary
   prohibitions (RFC-0011 §"Explicit non-goals";
   `docs/ux/dsh-remote-mobile.md` 0.6 row). Selection remains navigation to a
   deterministic per-node route authority; `validateTargetScope`
   (`src/registry/flow-tracker.mjs:16-63`) remains the only accepted target
   shape for every mutation.
3. **The selector-apex allowlist does not change.** The apex branch is a
   strict `(method, path)` allowlist of four session/selector tuples plus the
   two RFC-0017 pairing tuples (`src/registry/server.mjs:455-458`,
   `483-486`, `494-498`). `GET /hub/selector/nodes` is already allowed, so
   per-node indicators ship by **enriching that existing response** — no new
   apex tuple, no new public surface, and the v0.10 Gate C edge adjudication
   (narrow pairing-path exemption only; the selector read surface stays
   behind the operator's edge gate) is untouched.
4. **Indicator honesty.** The hub can see its own proxied flows and reverse
   presence — not node-local DSH login state. Orbit does not parse DSH
   cookies or tokens (RFC-0011 D4), so no view may claim "logged-in sessions
   on the node". Labels say *hub-routed flows* and *reverse presence*.
5. **Session visibility is hub-side, cookies stay host-only.** All operator
   sessions live in the single registry `browser_sessions` table
   (`src/registry/sqlite.mjs:768-778`) of the one hub process that serves
   every host class (`src/registry/server.mjs:325`). Listing them from the
   management surface is a hub read model, not a browser cross-origin read;
   the session cookie keeps its exact host-only attributes
   (`HttpOnly; Secure; SameSite=Strict; Path=/hub; Max-Age=12h`,
   `src/registry/server.mjs:598-606` and `816-824`).
6. **No new device-identifying data.** `browser_sessions` records no
   User-Agent, no IP, and no bootstrapping authority — by design (RFC-0007:
   the client IP is never part of the binding). v0.11 does not add such
   columns; the devices view shows exactly what the store already knows.

## 2. Decision Summary

| Decision | Choice |
| --- | --- |
| Session list endpoint | `GET /hub/sessions` (management surface only, session-gated, read-only) over the existing `browser_sessions` store. |
| Session revocation | `POST /hub/sessions/revoke` (management surface, CSRF + same-origin) with strict single-`sessionId` target validation; audit event `session.revoke`; self-revocation ≡ logout. |
| Per-node indicator on the selector | `buildSelectorNodeRow` gains `activeFlows` (integer ≥ 0) from the existing `MultiNodeFlowTracker`; served through the already-allowed `GET /hub/selector/nodes` tuple — apex allowlist unchanged. |
| Indicator semantics | "hub-routed flows (HTTP/WS)" + existing `reversePresence`; never node-local DSH login state. |
| Target scope display | Every selector card renders an explicit `target:` line with the deterministic route authority (truncated ID per RFC-0013 D2); failure surfaces stay target-preserving (regression-asserted). |
| UI path | Evolve the existing `ui/` (management) and `ui/selector/` surfaces; **no** new asset root and **no** new page/authority (the v0.10 `AUTH_UI_ROOT` precedent was for a new public entry — this wave adds none). |
| Mobile friendliness | Responsive breakpoints + touch-safe controls in `ui/selector/styles.css`; real-phone mounted acceptance; no separate mobile backend, no third-party UI code. |
| Refresh model | Manual refresh (existing) + periodic polling fallback; no new push/SSE channel (the existing pairing SSE is untouched). |
| Apex / edge posture | Byte-identical apex allowlist; v0.10 edge adjudication stands. Pinned mechanically by matrix field A3. |
| Acceptance matrix | **M22** — 22 canonical fields: 16 automated + 6 mounted, enforced via `scripts/v11-devices-nodes-acceptance-matrix.mjs` + governance-contract test (the established M-number-equals-field-count convention: M17, M24, M32, M36). |

## 3. Detailed Technical Design

### D1: What the hub can and cannot see (visibility honesty)

**Session store facts.** `browser_sessions`
(`src/registry/sqlite.mjs:768-778`) has exactly:
`session_id`, `operator_principal`, `csrf_token`, `created_at`,
`expires_at`, `idle_until`, `revoked_at`, `expiry_audited_at`. Sessions are
created by `bootstrapSession` (`src/registry/registry.mjs:1599-1614`,
`sess_` + 48 hex chars), kept alive by a sliding idle window
(`validateSession`, `registry.mjs:1616-1626`; `SESSION_IDLE_MS = 30 min`,
`src/registry/protocol.mjs:88`; absolute TTL `SESSION_TTL_MS = 12 h`,
`protocol.mjs:87`), ended by `endSession` (`registry.mjs:1628-1636`), and
counted by `countActiveSessions` (`registry.mjs:1638-1644`). Session
mutations and their audit rows share one transaction
(`registry.mjs:1605-1612`).

**What the devices view can therefore show**: session id, principal,
created/expiry times, derived last activity (`idle_until` is rewritten on
every `validateSession`, so `lastActivity ≈ idle_until − SESSION_IDLE_MS`),
and revoked state. **What it cannot show**: which device (no UA/IP —
deliberately not stored), which authority bootstrapped the session (no such
column), and anything about a node-local DSH login (opaque per RFC-0011 D4).
These limitations are stated in the UI copy rather than papered over; adding
capture columns is out of scope (§2 out-of-scope list).

**Why a hub-global list is correct here.** One hub process serves all host
classes and classifies each request by `Host`
(`src/registry/server.mjs:325`); its SQLite store is the single session
authority. Host-only cookies (`Path=/hub`, no `Domain`) keep browser cookie
jars isolated per origin — that is a browser boundary, not a reason for the
hub's own read model to pretend sessions are per-origin. The list endpoint
therefore lives on the **management surface only** (where operator sessions
are already administered) and is **not** added to the apex allowlist: a
session list on the apex would both extend the strict allowlist and sit on
the phone-reachable public origin whose read surface the v0.10 Gate C
adjudication explicitly kept behind the edge gate. Rejected alternatives:
(a) a per-origin session scope — inexpressible without a new
bootstrap-authority column (out of scope); (b) an apex session list —
rejected above; (c) reusing `/hub/pairing/status` — wrong audience (it
reports pairing-engine state) and it must not grow a session inventory.

### D2: Session list and explicit revocation endpoints

Two new management routes inside the existing `handleBrowserRequest`
fall-through (`src/registry/server.mjs:577-580`), i.e. after
`admitBrowserRequest` → `checkOriginAndFetchSite` (`server.mjs:731-758`,
`763-782`) and, for everything below the bootstrap block,
`validateSessionOnly` (`server.mjs:784-796`):

**`GET /hub/sessions`** (plus trailing-slash variant; read-only, listed
before the `requireCsrf` gate like the other GETs):

```json
{
  "sessions": [
    {
      "sessionId": "sess_<48 hex>",
      "sessionIdHint": "sess_<first 8>",
      "operatorPrincipal": "operator",
      "createdAt": "2026-09-29T10:00:00.000Z",
      "expiresAt": "2026-09-29T22:00:00.000Z",
      "idleUntil": "2026-09-29T10:30:00.000Z",
      "revokedAt": null
    }
  ],
  "activeCount": 2
}
```

- Rows include revoked sessions (with `revokedAt`) so revocation is visible
  in history; `activeCount` comes from the same liveness predicate as
  `countActiveSessions` (`registry.mjs:1640-1643`).
- **Secret hygiene**: `csrf_token` is **never** included — for any session.
  The full `sessionId` is the explicit revocation target and is returned for
  the same reason `GET /hub/session` returns the caller's `csrfToken`
  (`server.mjs:830-831`): the caller is an admitted, session-gated operator
  over verified TLS. The UI renders only `sessionIdHint` (precedent:
  `ui/selector/app.mjs:63` renders the principal, never the csrf token).
- New registry method `listSessions()` (SELECT over `browser_sessions`,
  ordered by `created_at`), paired with `revokeSession({ sessionId, actor })`
  which sets `revoked_at` + writes the `session.revoke` audit row in **one
  transaction** (the RFC-0005 D7 pattern used by `bootstrapSession`/`endSession`).

**`POST /hub/sessions/revoke`** (mutating; behind the existing
`requireCsrf` gate at `server.mjs:1006`):

- Body `{ "sessionId": "sess_<48 hex>" }`; the value must match
  `^sess_[0-9a-f]{48}$` and passes a target-scope check in the
  `validateTargetScope` spirit (`flow-tracker.mjs:16-63`): missing, empty,
  non-string, array, wildcard (`all`/`*`/`any`/`broadcast`/`cluster`), or
  multi-id input ⇒ `400 {"error":{"code":"invalid-target-scope"}}`.
- Unknown or already-revoked session ⇒ `404 {"code":"not-found"}`.
- Revoking the **caller's own** session is allowed and equivalent to
  logout (`endSession` semantics): the response is `200 {ok:true}` and the
  next request with that cookie is `401 no-session`.
- Rate limiting reuses the in-memory limiter pattern (e.g. the
  `30/60s per-IP` shape of `POST /hub/session`, `server.mjs:812`) under a
  `session-revoke:` key.
- Audit: `session.revoke` with `{sessionId, targetSessionId}` — never the
  csrf token. Note on scope: in `single` principal mode every session is the
  same operator; in `inject` mode the operator surface may revoke other
  principals' sessions. That power is inherent in the existing management
  surface (node delete is already operator-gated the same way) and is
  recorded here as an accepted, disclosed property — not silently assumed.

**What is deliberately NOT built**: no session filtering by authority, no
"revoke all" endpoint (a loop of explicit single-target revocations is
possible from the UI and keeps every mutation single-target), no session
extend/refresh endpoint, no new session type.

### D3: Per-node connection indicator in the selector read model

`buildSelectorNodeRow` (`src/registry/selector-view.mjs:69-131`) gains one
field in its `route` object:

```json
"route": {
  "eligible": true,
  "routeMode": "direct",
  "reversePresence": "online",
  "activeFlows": 2,
  "reasonCode": null,
  "reason": null,
  "openUrl": "https://n-<32hex>.<routeDomain>/"
}
```

- Source: the existing `MultiNodeFlowTracker.getActiveFlowCount(nodeId)`
  (`src/registry/flow-tracker.mjs:120+`; counted on the node-route branch at
  `server.mjs:387` and for WebSocket upgrades at `server.mjs:1720`), passed
  into `buildSelectorReadModel` via the same `flowTracker` reference the
  server already holds (`server.mjs:306`, `843-848`).
- Semantics: number of hub-routed HTTP/WS flows currently in flight to that
  node — **not** browser-tab count, **not** DSH login count. `0` means "no
  active hub-routed flows", which is true even when a browser holds an idle
  keep-alive-less connection. UI copy uses "active hub-routed flows".
- Sanitization regression: the enriched row must still exclude credentials,
  internal targets, and raw reports — the field is an integer count, nothing
  else moves (matrix A2).
- Management surface unchanged in shape: `/hub/nodes` and `/hub/overview`
  already carry per-node `activeFlows` and hub-level
  `activeSessions` (`server.mjs:851-859`, `1527-1538`) and the management UI
  already renders them (`ui/app.mjs:144-146`, `182-188`).

**Apex consequences: none.** The apex allowlist already admits
`GET /hub/selector/nodes` (`server.mjs:498`); enriching the response adds no
tuple, no route, and no unauthenticated reachability (the tuple stays inside
`handleBrowserRequest`, so an unauthenticated caller still gets
`401 gateway-denied` from `admitBrowserRequest`). Matrix A3 pins this.

### D4: Explicit target scope before and during navigation

- **Before navigation**: each selector card renders an explicit target line —
  `target: n-<first 8>…` with the full deterministic authority as the
  accessible text of the Open control (the server-computed `openUrl`
  remains the only navigation source, `selector-view.mjs:96-98` — the UI
  never derives URLs itself). Canonical node IDs only; `displayName`
  aliasing stays with v0.7 fleet inventory (RFC-0013 D3 deferral).
- **During navigation**: the browser origin bar is the target indicator —
  this is RFC-0011 D1/D2 doctrine and the hub must not (and cannot) inject
  banners into proxied DSH pages (node routes are pure proxies,
  `server.mjs:327-439`).
- **On failure**: `renderUnavailableHtml`
  (`src/registry/selector-view.mjs:189-218`) already renders the failed
  route authority and a selector return link; this behavior is
  regression-asserted (matrix A13) — a failed node never silently shows
  another node's surface, and there is no automatic retargeting
  (RFC-0011 D5).
- **On the management surface**: the Devices and Nodes section shows, per
  node, the same target authority next to the existing flow/presence
  indicators, unifying the "device" and "node" columns in one screen
  (the roadmap 0.6 "first-class Devices and Nodes view").

### D5: UI surface decision — evolve, do not add

The view ships inside the two existing asset roots:

- `ui/` (management): new **Devices and Nodes** section alongside
  `nodes-view` / `tokens-view` / `fleet-view` / `schedules-view`
  (`ui/index.html:25-53`), rendering the session list (D2), the node rows
  with `activeFlows`/presence/target, and the revoke control with
  confirmation. `docs/registry-ui.md` gains the corresponding section.
- `ui/selector/`: cards gain the target line and the `activeFlows`
  indicator (`ui/selector/view-model.mjs`); `app.mjs` gains periodic
  polling (interval + manual refresh retained; polling failure degrades to
  the existing error banner and never mutates server state).

Rationale against the alternatives: a new `ui/devices/` root + new page
would repeat the session/nav plumbing, require a third asset map
(the existing maps are `UI_ASSETS`/`SELECTOR_UI_ASSETS`,
`server.mjs:288-304`), and add a new authenticated page surface for data the
management shell already fetches. The v0.10 `AUTH_UI_ROOT` precedent
(`server.mjs:134`) exists to share **one new public entry** across
authorities — this wave adds no new entry, so that mechanism has nothing to
do here. A new page would also drift toward "a new selector system beyond
RFC-0011", which the roadmap 0.6 OUT list forbids.

### D6: Mobile-friendly selector

- `ui/selector/styles.css` gains defined breakpoints (e.g. ≤ 640 px,
  ≤ 900 px): single-column card flow, badges wrap without horizontal
  overflow, Open/Logout controls meet touch-target sizing, header nav
  collapses cleanly. No external fonts, no CDN, no framework — the file
  stays dependency-free like the rest of `ui/`.
- The existing viewport meta (`ui/selector/index.html:5`) is kept; layout
  work is CSS + minimal DOM structure only.
- The `/auth` landing page (v0.10) already ships a mobile-first layout; the
  selector must now match that bar at phone widths.
- Acceptance is **real-phone mounted evidence** (matrix M1/M2), not
  emulator-only: the phone reaches the selector with the pairing-issued
  session (post-v0.10 flow), sees nodes with target/flow indicators, and
  performs explicit A→B navigation.
- The management surface receives at most a minimal responsive pass so the
  devices view is inspectable from a phone that has edge credentials;
  desktop-first remains acceptable there (SHOULD, not MUST).

### D7: Acceptance Matrix for v0.11 (M22 Matrix — 22 Canonical Fields)

Automated qualification (candidate-bound, mechanically validated):
`scope: "automated"` — 16 fields.

| # | Field | Mechanical assertion |
| --- | --- | --- |
| A1 | `sessionListRequiresValidSession` | `GET /hub/sessions` without a valid session ⇒ 401 `no-session`/`gateway-denied`; with one ⇒ 200 |
| A2 | `selectorReadModelEnrichedAndSanitized` | `GET /hub/selector/nodes` rows carry integer `route.activeFlows` ≥ 0 consistent with `flowTracker` counts, and the row shape otherwise matches the v0.10 sanitized model (no credentials/internal targets/raw reports; no new secret fields) |
| A3 | `apexAllowlistByteIdentical` | on the selector-apex host: the four session/selector tuples + `(GET, /auth)` + `(POST, /hub/pairing/verify)` behave as today; `GET /hub/sessions` and `POST /hub/sessions/revoke` ⇒ 404 `selector authority exposes only selector surface`; an unauthenticated `GET /hub/selector/nodes` still ⇒ 401 `gateway-denied` |
| A4 | `sessionListShapeAndHygiene` | 200 body rows expose exactly `sessionId`, `sessionIdHint`, `operatorPrincipal`, `createdAt`, `expiresAt`, `idleUntil`, `revokedAt` + `activeCount`; **no** `csrf_token` value appears anywhere in the response |
| A5 | `sessionRevokeRequiresCsrf` | `POST /hub/sessions/revoke` without/with wrong `x-csrf-token` ⇒ 403 `csrf-denied`; cross-origin `Origin`/`sec-fetch-site` ⇒ 403 via `checkOriginAndFetchSite` |
| A6 | `sessionRevokeTargetValidation` | missing / empty / non-string / array / `all` / `*` / comma-joined ids / wrong-prefix ids ⇒ 400 `invalid-target-scope`; unknown or already-revoked id ⇒ 404 `not-found` |
| A7 | `sessionRevokeEffectAndIsolation` | revoked session's `GET /hub/session` ⇒ 401 afterward; audit row `session.revoke` present; all other sessions (including the caller's) remain valid |
| A8 | `sessionSelfRevokeEqualsLogout` | revoking the caller's own session ⇒ 200, subsequent requests 401, audit written; behavior indistinguishable from `POST /hub/session/logout` |
| A9 | `sessionListMatchesStore` | list content equals the `browser_sessions` table projection (including revoked rows); `activeCount` equals `countActiveSessions()`; `idleUntil` advances on activity (sliding window) |
| A10 | `pairingStatusCountConsistency` | `GET /hub/pairing/status` `activeSessions` equals `activeCount` for the same instant |
| A11 | `selectorTargetScopeIndication` | selector view-model renders the explicit `target:` authority line per card and the Open control's accessible target equals the server `openUrl` (DOM model check; RFC-0013 field-23 precedent) |
| A12 | `selectorFlowIndicatorWording` | rendered label states hub-routed flow semantics and never claims DSH login/session visibility (string-contract check on the view-model) |
| A13 | `failureSurfaceTargetPreserving` | `renderUnavailableHtml` still renders the failed route authority + selector return link; route policy failure still yields 503 with `node-unavailable`/`selectorUrl`, never another node's surface |
| A14 | `nodeRoutesStayPureProxies` | `GET /hub/sessions` and `POST /hub/sessions/revoke` on a `n-<32hex>` host are proxied to the node DSH, not intercepted (regression: registry never intercepts non-machine paths on route authorities) |
| A15 | `responsiveBreakpointsPresent` | `ui/selector/styles.css` defines `@media` breakpoints and touch-target rules (mechanical presence + structure check); no external URLs/fonts added |
| A16 | `cookieAttributesUnchanged` | every session-issuing path (`POST /hub/session`, `POST /hub/pairing/verify`) emits the byte-identical `HttpOnly; Secure; SameSite=Strict; Path=/hub; Max-Age=43200` cookie |

Mounted qualification (live, two-node deployment — one direct, one reverse):
`scope: "mounted"` — 6 fields.

| # | Field | Live assertion |
| --- | --- | --- |
| M1 | `phoneSelectorUsable` | on a real phone (narrow viewport), the selector lists both nodes with target/flow indicators visible, no horizontal overflow, touch-safe controls; performed after pairing via the v0.10 QR flow |
| M2 | `phoneExplicitSessionNavigation` | on the phone: open node A (origin becomes A's authority), return to the selector, open node B — each target change is an explicit navigation; the A tab is never retargeted |
| M3 | `devicesViewSessionVisibilityAndRevocation` | with a desktop and a phone session both live, the devices view lists both with last-activity; revoking the phone's session from the desktop makes the phone's next hub request fail 401 while the desktop session stays valid (and vice versa) |
| M4 | `perNodeFlowIndicatorLive` | with an active page/WS on node A, its selector/management indicator shows `activeFlows ≥ 1`; after closing flows it returns to 0 — on both a direct and a reverse node |
| M5 | `targetScopeVisibleAcrossNavigationAndFailure` | the target authority is visible on the card before navigation and in the origin after it; stopping node A's DSH makes A's authority show the target-preserving unavailable page with a selector return link while B remains openable — no silent failover |
| M6 | `hostOnlySessionIsolationRegression` | the apex (pairing-issued) and management sessions coexist; revoking one never affects the other; no cookie set by one authority ever appears in the other's requests |

## 4. Security Considerations & Threat Model

- **Public exposure delta — stated precisely: zero.** No new tuple on the
  selector apex, no new unauthenticated route, no edge-policy change, no new
  authority, no new asset served pre-admission. The two new endpoints sit
  behind the full existing admission chain (gateway assertion or loopback
  LAN-boundary admission, Origin/`Sec-Fetch-Site` checks, session cookie,
  CSRF for the mutation). Matrix A3/A14/A16 pin the boundaries that must not
  move.
- **Session IDs in the list.** A `sessionId` is the cookie value — a bearer
  credential for that session. Returning it to an admitted operator is the
  same trust decision as returning the caller's `csrfToken`
  (`server.mjs:831`) and the pairing response's `csrfToken`
  (`server.mjs:618-623`); without the exact id, explicit single-target
  revocation is impossible. Mitigations: management-surface-only endpoint,
  verified TLS, CSRF on the mutation, UI renders only `sessionIdHint`,
  audit on every revocation, and mounted evidence must mask session ids and
  principals (the v0.10 sanitization lesson: the evidence's sanitization
  statement must describe exactly what was masked). Residual accepted risk:
  an operator can enumerate/terminate sessions of the same (or, in `inject`
  mode, other) principals — that is the feature, disclosed in D2.
- **Denial-of-service via revocation.** A compromised operator session can
  revoke other sessions (locking the operator out until re-login /
  re-pairing). Recovery is the existing bootstrap path
  (`POST /hub/session` via gateway admission; `POST /hub/pairing/verify`
  via QR); revocation never destroys credentials, nodes, or route targets.
  Rate limiting bounds abuse of the endpoint itself.
- **Indicator inference.** `activeFlows` reveals "someone is using node X
  right now" to a session-gated operator — information already exposed by
  `/hub/nodes` on the management surface since v0.6; serving it through the
  selector tuple adds no reachability, only convenience. The apex response
  remains session-gated and edge-gated (v0.10 adjudication).
- **CSRF / origin.** The mutation uses the unchanged `checkOriginAndFetchSite`
  + `requireCsrf` pair (field A5 asserts both rejection paths); no new
  token type is introduced.
- **Privacy.** No UA/IP capture, no fingerprinting, no third-party requests
  in the UI; the devices view stores nothing new (it projects
  `browser_sessions` as it exists).
- **Docs hygiene.** Design and evidence must pass the public-tree check
  (no private-IP literals — use TEST-NET-1 `192.0.2.10` in examples; no
  credential-like assignments), per the v0.10 Gate A lesson.

## 5. Stop-Work Matrix

| Trigger | Action |
| --- | --- |
| A review requires widening the apex allowlist, the public surface, or the v0.10 edge exemption to make any part of this view reachable | Stop; that is a security-posture decision requiring separate authorization, not a v0.11 implementation detail |
| A requirement needs node-local DSH session state (login counts, DSH cookie presence) in any view | Stop; Orbit must not inspect DSH session internals (RFC-0011 D4) — record the need and re-scope |
| A requirement asks for device fingerprinting (UA/IP capture, bootstrap-authority columns) | Stop; new schema + privacy design, out of v0.11 scope |
| Pressure to add a global active node, cross-node session migration, broadcast/multi-target actions, or automatic retargeting | Stop; the four 0.6 prohibitions are design invariants |
| A requirement needs a new page, a new asset root, or a new real-time event channel | Stop; the evolve-don't-add surface decision (D5) is a scope invariant |
| Revocation semantics grow beyond single-target explicit revoke (e.g. bulk endpoints, auto-expiry mutation, cross-principal policy engine) | Stop; the one-mutation scope is frozen |
| Real DSH, harness, or gateway changes are needed to produce evidence | Stop; new candidate per the candidate-freeze rule (deployment-config edge changes are separately adjudicated and not part of this wave) |
| Any evidence staleness, provenance mismatch, or review verdict below PASS | Stop; fresh candidate-bound evidence, no in-place patching of a frozen candidate |
