# RFC 0007: Browser management API — security and acceptance matrix (decided, rev. 2)

Status: Accepted (2026-08-30), rev. 2 after architecture review round 2: unforgeable gateway admission proof, `hub.credentials.rotate` removed from v0.3. Independent of the registry machine API (RFC-0006): the management surface is operator-facing and uses the v0.2 browser trust requirements.

## Scope

Operator-facing Hub UI endpoints: node list/detail, enrollment-token minting, node delete/re-register, health and compatibility views, credential rotation initiation. This surface carries browser sessions, so the v0.2 browser trust requirements apply: Origin, Sec-Fetch-Site, CSRF protection, and identity-header spoofing denial.

## Session/CSRF lifecycle (fixed chain)

The browser trust chain is fixed in this order; each hop must complete before the next exists:

1. **Gateway authentication with unforgeable proof** — the deployment's authenticated gateway (Cloudflare Access / LAN basic-auth / SSH tunnel) admits the operator request. The Hub must be able to prove gateway authentication happened; two accepted, non-exclusive mechanisms:
   - **(a) Gateway-held internal assertion**: the gateway injects a per-deployment secret header (`X-DSH-Authenticated-Proxy` pattern from v0.2) after its own authentication; the Hub admits only requests carrying the exact secret, and **strips/denies any client-supplied version of that header**. The secret is gateway-held, never exposed to browsers, never a browser-accessible value.
   - **(b) Strict gateway-only network boundary**: the Hub's management listener binds only to loopback / a private VPN interface; only the gateway path can reach it. Any request arriving from outside that boundary is denied at the transport/bind level, regardless of headers.
   - **`X-Forwarded-For` and client IP are never authentication credentials** — they are audit/risk metadata only. No admission decision may depend on them.
   The Hub itself never accepts an unauthenticated management request.
2. **Hub session bootstrap** — the Hub issues a session cookie bound to the gateway-verified identity plus the client's IP/forwarded identity: `HttpOnly; Secure; SameSite=Strict`, default TTL 12h, idle timeout 30min, hard absolute expiry. A fresh session always re-issues a fresh session ID.
3. **Per-session CSRF token** — minted at session bootstrap, bound to the session ID, required on every state-changing request (POST/PATCH/DELETE), rotated on re-authentication. A new session gets a new token; reuse of an old token with a new session is denied.
4. **Same-origin + `Sec-Fetch-Site`** — Origin (when present) must match the request host and scheme; `Sec-Fetch-Site: cross-site` denied; `Sec-Fetch-Site: same-site` only with a matching Origin or no Origin.
5. **Identity-header spoofing** — management requests through the LAN path must not be admitted based on a client-supplied identity-provider assertion header; the LAN path strips such headers, and acceptance tests assert forged assertions are denied.

Logout terminates the session server-side (cookie + CSRF token invalidated immediately). Session events (bootstrap, expiry, logout, token rotation) are audit records.

Other operator-behavior notes: operator authentication mechanics (identity provider choice) are intentionally out of v0.3 scope; the chain above is what v0.3 guarantees given any gateway that satisfies hop 1.

## Management API surface (v0.3 MVP)

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `hub.nodes.list` | GET | list registered nodes with health summary |
| `hub.nodes.get` | GET | node detail (identity, health, compat, capabilities) |
| `hub.nodes.delete` | POST (CSRF) | delete node record; revokes credential + Hub identity immediately |
| `hub.nodes.reenroll` | POST (CSRF) | mint a re-enrollment token **bound to a tombstoned nodeId** (RFC-0005 D5); completion requires the original node private key |
| `hub.tokens.list` | GET | active enrollment tokens (digests only) |

**Credential rotation is not a v0.3 browser endpoint.** Rotation is node-initiated and signed with the old node private key (`POST /api/v1/credential-rotate`, RFC-0006); there is no operator-initiated browser rotation surface until a heartbeat-response/control-message flow is designed (future milestone). <code>hub.credentials.rotate</code> is removed from v0.3.

## Security/acceptance matrix (all fail closed)

| Case | Expected |
| --- | --- |
| operator session, same-origin, valid CSRF token, expected host | allowed |
| no session (anonymous) | denied (redirect/401) |
| invalid session | denied |
| expired session / idle timeout exceeded | denied (re-bootstrap required) |
| CSRF token from a different session | denied |
| bootstrap without gateway proof (no internal assertion, source outside gateway-only boundary) | denied |
| client-supplied internal assertion header (no gateway injection) | denied (header stripped; assertion is gateway-held) |
| admission decision influenced by `X-Forwarded-For`/client IP | forbidden by design; IP is audit metadata only |
| cross-site `Sec-Fetch-Site` | denied |
| mismatched `Origin` | denied |
| state-changing request without CSRF token | denied |
| forged identity-provider assertion on the LAN path | denied |
| delete without confirmation semantics (idempotency key) | denied |
| rate limit exceeded on token minting | denied (429) |
| 5xx upstream | failed case (never "allowed") |

## Acceptance methodology

The matrix is exercised by the live smoke methodology (positive control + denial cases) against the management surface with an operator-authenticated context; CI uses a local harness. Browser-specific headers are asserted on this surface only — never on the machine API (RFC-0006).