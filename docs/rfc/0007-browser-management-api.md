# RFC 0007: Browser management API — security and acceptance matrix (decided)

Status: Accepted (2026-08-30). Independent of the registry machine API (RFC-0006): the management surface is operator-facing and uses the v0.2 browser trust requirements.

## Scope

Operator-facing Hub UI endpoints: node list/detail, enrollment-token minting, node delete/re-register, health and compatibility views, credential rotation initiation. This surface carries browser sessions, so the v0.2 browser trust requirements apply: Origin, Sec-Fetch-Site, CSRF protection, and identity-header spoofing denial.

## Session model

- Operator authentication is out of v0.3 scope design-wise (reuses the deployment's existing authenticated gateway pattern); the unambiguous assumption: management endpoints are reachable only through an operator-authenticated session.
- CSRF: cookie-based sessions are protected by same-origin checks (Origin header, if present, must match the request host), `Sec-Fetch-Site` (cross-site denied), and a per-session CSRF token for state-changing requests.
- Identity-header spoofing: management requests through the local/LAN path must not be admitted based on a client-supplied identity-provider assertion header; the LAN path must strip such headers, and acceptance tests assert forged assertions are denied.

## Management API surface (v0.3 MVP)

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `hub.nodes.list` | GET | list registered nodes with health summary |
| `hub.nodes.get` | GET | node detail (identity, health, compat, capabilities) |
| `hub.nodes.delete` | POST (CSRF) | delete node record; revokes credential + Hub identity immediately |
| `hub.nodes.reenroll` | POST (CSRF) | mint a fresh enrollment token (operator action) |
| `hub.tokens.list` | GET | active enrollment tokens |
| `hub.credentials.rotate` | POST (CSRF) | initiate node credential rotation (sets overlap window) |

## Security/acceptance matrix (all fail closed)

| Case | Expected |
| --- | --- |
| operator session, same-origin, valid CSRF token, expected host | allowed |
| no session (anonymous) | denied (redirect/401) |
| invalid session | denied |
| cross-site `Sec-Fetch-Site` | denied |
| mismatched `Origin` | denied |
| state-changing request without CSRF token | denied |
| forged identity-provider assertion on the LAN path | denied |
| delete without confirmation semantics (idempotency key) | denied |
| rate limit exceeded on token minting | denied (429) |
| 5xx upstream | failed case (never "allowed") |

## Acceptance methodology

The matrix is exercised by the live smoke methodology (positive control + denial cases) against the management surface with an operator-authenticated context; CI uses a local harness. Browser-specific headers are asserted on this surface only — never on the machine API (RFC-0006).