# RFC 0006: Registry machine API — security and acceptance matrix (decided, rev. 3)

Status: Accepted (2026-08-30), rev. 3 after architecture review round 2: fixed wire encodings, transactional nonce consumption, heartbeat runtime identity, and the query-string ban. Independent of the browser management API (RFC-0007); the shared element is the fail-closed live smoke methodology, not browser header requirements.

## Scope

Machine-to-machine endpoints between a registered node and the Hub: enrollment completion, heartbeat, and compatibility-report upload. No browser trust semantics (Origin/Sec-Fetch-Site/CSRF) apply here.

## Decided: node authentication with Ed25519 (no symmetric verifier)

- The node generates an Ed25519 keypair **before enrollment**; the private key never leaves the node.
- The Hub stores only the node **public key** (verified at enrollment from the enrollment request).
- Machine requests are signed: an Ed25519 signature over the fixed signing string below, delivered in the `X-Orbit-Signature` header; `X-Orbit-Key: {keyId}` selects the public key (enables rotation).
- There is no shared symmetric secret and therefore no one-way verifier problem: the Hub holds public keys only.

## Decided: fixed signing protocol (`ORBIT-MACHINE-V1`)

The exact signing string, no JSON canonicalization (the raw request body bytes are hashed):

```text
ORBIT-MACHINE-V1
<METHOD>
<PATH+QUERY>
<TIMESTAMP>
<NONCE>
<SHA256(raw-request-body)>
<NODE_ID>
```

Concatenated with a single `\n` (the final `NODE_ID` line has no trailing newline). Node picks a fresh random NONCE per request.

- `TIMESTAMP`: Unix epoch seconds (UTC), integer string. Server rejects `|now - timestamp| > 30s`.
- `NONCE`: 128-bit random, 32 hex chars. Replay resistance is transactional (see below).
- `NODE_ID`: the node's stable ID; included in the signature, so a captured request cannot be replayed against another node.
- Body hashing uses the exact bytes received (no normalization).

## Decided: fixed wire contract (encodings, no negotiation)

- **Public key encoding**: the raw 32-byte Ed25519 public key, lowercase hex (64 chars). Accepted in the enrollment body and the rotation body; no other encoding (no DER, no base64, no PEM) in v0.3.
- **Signature encoding**: the raw 64-byte Ed25519 signature over the UTF-8 bytes of the signing string above (lines joined with a single `\n`, no trailing newline), lowercase hex (128 chars), in `X-Orbit-Signature`.
- **keyId derivation**: `SHA-256(raw public key bytes)[0:16]`, lowercase hex (32 chars). Deterministic; the Hub derives and stores it at enrollment/rotation and must never accept a client-supplied keyId that does not match the derivation.
- **SHA-256 text encoding**: lowercase hex of the digest of the exact raw request body bytes.
- **Signing path representation**: the URL path only (`/api/v1/heartbeat`). **v0.3 machine routes reject any request with a non-empty query string (400, before authentication)** — the protocol has no query strings, so no URL canonicalization question exists. PATH+QUERY canonicalization is therefore excluded by construction.
- String fields in the signing string are byte-exact as sent/received; no trimming, no charset conversion.

## Decided: nonce consumption is transactional

Order is fixed per authenticated machine request (all routes except `enroll`, which uses token + `enrollmentRequestId` idempotency and has no nonce):

1. Key resolution: `X-Orbit-Key` keyId known, not revoked, not pre-overlap.
2. Signature verification over the signing string; timestamp within ±30s.
3. **Nonce reservation (atomic)**: a unique `(nodeId, nonce)` insert into the transactional `seen_nonces` registry table (RFC-0005 D7) commits **before any business side effect**. A conflicting insert → denied (401 replay).
4. Business logic; response.

A request whose signature/timestamp/keyId checks fail consumes nothing (it never reached the reservation). A request that passes checks then fails business logic (4xx schema rejection, 5xx upstream, rate limit) has **already consumed its nonce** — the reservation is not rolled back; retrying with the same nonce is denied. Clients retry with a fresh nonce. `seen_nonces` rows are purged after a fixed retention (default 24h; index `(node_id, at)`), so the reservation is bounded, not a cache: it lives in the same transactional store as the registry, not in process memory.

## Decided: rotation

- New public key rotates in by a request signed with the **old private key** (`node.credential-rotate` with `X-Orbit-Key: oldKeyId` and the new public key in the body).
- Bounded overlap: default 24h, operator-configurable 1–168h; both keys accepted during the overlap; the old key is revoked at its end.
- Revocation is immediate and independent (node delete → both keys revoked).

## Decided: rate limiting and limits (fixed defaults)

- Per-node heartbeat: 1/s average (burst 3); report upload: 10/min; enrollment attempts per token: 10; token minting (operator): 20/h; per-IP machine limits: 120/min.
- Body size limits: heartbeat ≤ 64 KiB; report upload ≤ 16 MiB; enrollment ≤ 64 KiB.

## Machine API surface (v0.3 MVP)

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/enroll` | enrollment token + node public key + enrollmentRequestId | one-time enrollment, returns nodeId + registryContact params |
| `POST /api/v1/heartbeat` | Ed25519 (ORBIT-MACHINE-V1) | liveness + **non-authoritative runtime identity** (`orbitRevision`, `orbitCommit`, `dshVersion`, `compatibilityProfile`): updates `registryContact` + `lastSeen`; runtime identity is compared with the latest report's identity tuple to flag staleness at the Hub (RFC-0009). **Carries no capabilities and declares nothing about capability state.** |
| `POST /api/v1/report-upload` | Ed25519 (ORBIT-MACHINE-V1) | sanitized compatibility report upload; capabilities derive from it at the Hub |
| `POST /api/v1/credential-rotate` | Ed25519 (ORBIT-MACHINE-V1, old key) | new public key rotation with overlap |

There is **no** `update-capabilities` endpoint: capabilities are derived deterministically from the latest uploaded report at the Hub (single source of truth; RFC-0009). All machine routes are fixed paths **without query strings**; any request carrying a query string is denied (400) before authentication (see wire contract).

## Security/acceptance matrix (all fail closed)

| Case | Expected |
| --- | --- |
| enroll with valid token, fresh keypair, unique requestId | success; result idempotent per requestId+token+publicKey |
| enroll with missing / malformed / unknown token | denied |
| enroll with already-consumed token (same content) | same result returned (idempotent replay) |
| enroll with consumed token + different request/body | denied |
| enroll with expired token | denied |
| enroll with non-hex / wrong-length public key | denied (400, wire contract) |
| heartbeat with valid signature, fresh ts, fresh nonce, known keyId | accepted |
| missing signature | denied |
| malformed signature encoding (wrong length, non-hex) | denied (400) |
| wrong signature (tampered body, wrong key, swapped nodeId) | denied |
| valid signature + reused nonce (replay) | denied (401, nonce reservation conflict) |
| valid signature + fresh nonce, business rejection (schema 4xx, upstream 5xx, rate limit) | nonce already consumed; same-nonce retry denied, fresh nonce required |
| valid signature + stale/future ts (> skew) | denied |
| valid signature + body modified after signing (body-hash mismatch in signing string) | denied |
| valid signature for node A replayed against node B | denied (NODE_ID in signing string) |
| unknown/revoked keyId | denied |
| keyId that does not match `SHA-256(pubkey)[0:16]` derivation | denied (400, wire contract) |
| revoked node (after delete) | denied with `revoked` hint |
| rotated key before overlap start | denied |
| non-empty query string on a machine route | denied (400; the protocol has no query strings) |
| report-upload oversized body | denied (413) |
| rate limit exceeded | denied (429, Retry-After) |

## Acceptance methodology

The matrix is exercised by a fail-closed live smoke suite (positive control plus every denial case) against a local registry harness using generated Ed25519 keys; no production keys are used in tests. The suite exits non-zero on any mismatch and never applies browser header semantics.