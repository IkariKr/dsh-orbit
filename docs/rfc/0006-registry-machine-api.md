# RFC 0006: Registry machine API — security and acceptance matrix (decided, rev. 2)

Status: Accepted (2026-08-30), rev. 2 after architecture review P0/P1 closure. Independent of the browser management API (RFC-0007); the shared element is the fail-closed live smoke methodology, not browser header requirements.

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
- `NONCE`: 128-bit random, 32 hex chars. Replay cache per node retains accepted nonces for 60s beyond the skew window (~90s total); reuse rejected.
- `NODE_ID`: the node's stable ID; included in the signature, so a captured request cannot be replayed against another node.
- Body hashing uses the exact bytes received (no normalization).

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
| `POST /api/v1/heartbeat` | Ed25519 (ORBIT-MACHINE-V1) | liveness: updates `registryContact` + `lastSeen` only |
| `POST /api/v1/report-upload` | Ed25519 (ORBIT-MACHINE-V1) | sanitized compatibility report upload; capabilities derive from it at the Hub |
| `POST /api/v1/credential-rotate` | Ed25519 (ORBIT-MACHINE-V1, old key) | new public key rotation with overlap |

There is **no** `update-capabilities` endpoint: capabilities are derived deterministically from the latest uploaded report at the Hub (single source of truth; RFC-0009).

## Security/acceptance matrix (all fail closed)

| Case | Expected |
| --- | --- |
| enroll with valid token, fresh keypair, unique requestId | success; result idempotent per requestId+token+publicKey |
| enroll with missing / malformed / unknown token | denied |
| enroll with already-consumed token (same content) | same result returned (idempotent replay) |
| enroll with consumed token + different request/body | denied |
| enroll with expired token | denied |
| heartbeat with valid signature, fresh ts, fresh nonce, known keyId | accepted |
| missing signature | denied |
| wrong signature (tampered body, wrong key, swapped nodeId) | denied |
| valid signature + reused nonce (replay) | denied |
| valid signature + stale/future ts (> skew) | denied |
| valid signature + body modified after signing (body-hash mismatch in signing string) | denied |
| valid signature for node A replayed against node B | denied (NODE_ID in signing string) |
| unknown/revoked keyId | denied |
| revoked node (after delete) | denied with `revoked` hint |
| rotated key before overlap start | denied |
| report-upload oversized body | denied (413) |
| rate limit exceeded | denied (429, Retry-After) |

## Acceptance methodology

The matrix is exercised by a fail-closed live smoke suite (positive control plus every denial case) against a local registry harness using generated Ed25519 keys; no production keys are used in tests. The suite exits non-zero on any mismatch and never applies browser header semantics.