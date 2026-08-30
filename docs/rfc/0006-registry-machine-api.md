# RFC 0006: Registry machine API — security and acceptance matrix (decided, rev. 5)

Status: Accepted (2026-08-30), rev. 5 after architecture review round 4: `reenrollmentRequestId` and fixed idempotency key, the revoked-key exception confined to `/api/v1/reenroll`, the re-enroll success transaction fixed (failures consume nothing), and token `purpose` enforcement at both endpoints. Independent of the browser management API (RFC-0007); the shared element is the fail-closed live smoke methodology, not browser header requirements.

## Scope

Machine-to-machine endpoints between a registered node and the Hub: enrollment completion, tombstone re-enrollment completion, heartbeat, compatibility-report upload, and signed credential rotation. No browser trust semantics (Origin/Sec-Fetch-Site/CSRF) apply here.

## Decided: node authentication with Ed25519 (no symmetric verifier)

- The node generates an Ed25519 keypair **before enrollment**; the private key never leaves the node.
- The Hub stores only the node **public key** (verified at enrollment from the enrollment request).
- Machine requests are signed: an Ed25519 signature over the fixed signing string below, carried in the fixed transport headers (`X-Orbit-Node`, `X-Orbit-Timestamp`, `X-Orbit-Nonce`, `X-Orbit-Key`, `X-Orbit-Signature`; see the transport-header section).
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

**Field provenance (fixed)**: every signing-string field comes verbatim from the transport, with nothing reconstructed or canonicalized server-side:

- `METHOD` and `PATH+QUERY` — from the request line (machine routes carry no query strings, so `PATH+QUERY` is always exactly `PATH`; the route is fixed).
- `TIMESTAMP` — from `X-Orbit-Timestamp`.
- `NONCE` — from `X-Orbit-Nonce`.
- `NODE_ID` — from `X-Orbit-Node`.
- `SHA256(raw-request-body)` — computed over the exact raw body bytes as received.

A missing or malformed header is rejected (400) before any verification.

- `TIMESTAMP`: Unix epoch seconds (UTC), integer string. Server rejects `|now - timestamp| > 30s`.
- `NONCE`: 128-bit random, 32 hex chars. Replay resistance is transactional (see below).
- `NODE_ID`: the node's stable ID; included in the signature, so a captured request cannot be replayed against another node.
- Body hashing uses the exact bytes received (no normalization).

## Decided: fixed transport headers

Exactly these five headers carry the protocol on every authenticated machine request (enrollment carries none of them):

| Header | Field it feeds | Content |
| --- | --- | --- |
| `X-Orbit-Node` | `NODE_ID` | the node's stable ID (`node_` + 32 hex) |
| `X-Orbit-Timestamp` | `TIMESTAMP` | Unix epoch seconds, integer string |
| `X-Orbit-Nonce` | `NONCE` | 128-bit random, 32 lowercase hex |
| `X-Orbit-Key` | — (key selection) | keyId: first 16 bytes of SHA-256(raw public key), lowercase hex |
| `X-Orbit-Signature` | — (signature) | 64-byte Ed25519 signature over the signing-string UTF-8 bytes, lowercase hex |

The keyId selects which stored public key verifies the signature (enables rotation and re-enrollment). No other headers participate in authentication; all other headers are ignored for admission purposes.

## Decided: fixed wire contract (encodings, no negotiation)

- **Public key encoding**: the raw 32-byte Ed25519 public key, lowercase hex (64 chars). Accepted in the enrollment body and the rotation body; no other encoding (no DER, no base64, no PEM) in v0.3.
- **Signature encoding**: the raw 64-byte Ed25519 signature over the UTF-8 bytes of the signing string above (lines joined with a single `\n`, no trailing newline), lowercase hex (128 chars), in `X-Orbit-Signature`.
- **keyId derivation**: the first 16 bytes of SHA-256(raw public key bytes), lowercase hex (32 chars). Deterministic; the Hub derives and stores it at enrollment/rotation/re-enrollment and must never accept a client-supplied keyId that does not match the derivation.
- **SHA-256 text encoding**: lowercase hex of the digest of the exact raw request body bytes.
- **Signing path representation**: the URL path only (`/api/v1/heartbeat`). **v0.3 machine routes reject any request with a non-empty query string (400, before authentication)** — the protocol has no query strings, so no URL canonicalization question exists. PATH+QUERY canonicalization is therefore excluded by construction.
- String fields in the signing string are byte-exact as sent/received; no trimming, no charset conversion.

## Decided: nonce consumption is transactional

Order is fixed per authenticated machine request. **Exception set**: `enroll` (which uses token + `enrollmentRequestId` idempotency and has no nonce) and the dedicated `reenroll` flow (which reserves its nonce inside its own success transaction, below). For every other route (heartbeat, report-upload, credential-rotate):

1. Key resolution: `X-Orbit-Key` keyId known, not revoked, not pre-overlap.
2. Signature verification over the signing string; timestamp within ±30s.
3. **Nonce reservation (atomic)**: a unique `(nodeId, nonce)` insert into the transactional `seen_nonces` registry table (RFC-0005 D7) commits **before any business side effect**. A conflicting insert → denied (401 replay).
4. Business logic; response.

A request whose signature/timestamp/keyId checks fail consumes nothing (it never reached the reservation). A request that passes checks then fails business logic (4xx schema rejection, 5xx upstream, rate limit) has **already consumed its nonce** — the reservation is not rolled back; retrying with the same nonce is denied. Clients retry with a fresh nonce. `seen_nonces` rows are purged after a fixed retention (default 24h; index `(node_id, at)`), so the reservation is bounded, not a cache: it lives in the same transactional store as the registry, not in process memory.

## Decided: rotation

- New public key rotates in by a request signed with the **old private key** (`node.credential-rotate` with `X-Orbit-Key: oldKeyId` and the new public key in the body).
- Bounded overlap: default 24h, operator-configurable 1–168h; both keys accepted during the overlap; the old key is revoked at its end.
- Revocation is immediate and independent (node delete → both keys revoked).

## Decided: tombstone re-enrollment completion (`ORBIT-REENROLL-V1`)

Restoring a tombstoned nodeId is a **machine** protocol, not a browser write: the browser endpoint `hub.nodes.reenroll` (RFC-0007) only mints the token; completion happens at `POST /api/v1/reenroll` and proves possession of the historical identity with the original node private key (RFC-0005 D5).

- **Token**: minted by `hub.nodes.reenroll(nodeId)` with `purpose = reenroll` and `boundNodeId` = the tombstoned nodeId; stored as digest; TTL default 10 min; single-use. The enroll endpoint rejects it (purpose mismatch) and the reenroll endpoint rejects enroll-purpose tokens.
- **Signing string** (the label differs so a captured MACHINE-V1 signature can never be replayed as re-enrollment proof):

```text
ORBIT-REENROLL-V1
<METHOD>
<PATH>
<TIMESTAMP>
<NONCE>
<SHA256(raw-request-body)>
<NODE_ID>
```

- `NODE_ID` is the **tombstoned** nodeId; the proof is signed with the **original node private key**.
- **Body**: `{ reenrollmentToken, reenrollmentRequestId, newPublicKey }`. `reenrollmentRequestId` is fixed at 128-bit random, 32 lowercase hex. `newPublicKey` is in the fixed wire encoding.
- **Idempotency key (fixed)**: `tokenDigest + reenrollmentRequestId + tombstonedNodeId + newPublicKey`. An exact replay returns the recorded result (enrollment_results mechanics, served past token expiry within the replay retention); any difference is denied.
- **Revoked-key exception (the ONLY one)**: ordinary ORBIT-MACHINE-V1 authentication always rejects revoked keyIds — including on heartbeat, report-upload, and credential-rotate. `POST /api/v1/reenroll` is the sole exception: `X-Orbit-Key` may name the **tombstone-retained historical public key**, whose only purpose is verifying the ORBIT-REENROLL-V1 possession proof. That historical key **permanently remains `revoked`**; it never authorizes any other machine route, and the restored node's new key is the only credential thereafter.
- **Success transaction (fixed order)**: pre-validation first, read-only: token exists + unexpired + `purpose = reenroll` + `boundNodeId` matches + tombstone exists + historical key present + signature verifies over the signing string + timestamp within skew + wire encodings valid. Any failure here consumes **nothing** (neither token nor nonce). On success, a single `BEGIN IMMEDIATE` transaction executes, in order: re-confirm token unused → reserve nonce (unique `(node_id, nonce)` insert; the reservation lives in this transaction) → consume token (by digest) → persist the idempotency result (enrollment_results) → install the new public key (node_keys) → restore the node to `active` → the historical key **stays `revoked`** → audit + health-event rows (RFC-0005 D7). All-or-nothing; a failed transaction consumes nothing.
- Nonce semantics intentionally differ from MACHINE-V1 routes: here the nonce reservation is inside the success transaction, and every failure path consumes nothing — a re-enrollment token is high-value single-use material.
- **Denied**: proof signed by the new key or any other key; target not tombstoned; purpose mismatch; consumed token with different idempotency content; expired token on first use; malformed `reenrollmentRequestId`; wire-encoding violations.
- **Limits**: body ≤ 64 KiB; 10 attempts per token; timestamp/nonce rules as for ORBIT-MACHINE-V1.

## Decided: rate limiting and limits (fixed defaults)

- Per-node heartbeat: 1/s average (burst 3); report upload: 10/min; enrollment/reenroll attempts per token: 10; token minting (operator): 20/h; per-IP machine limits: 120/min.
- Body size limits: heartbeat ≤ 64 KiB; report upload ≤ 16 MiB; enrollment ≤ 64 KiB.

## Machine API surface (v0.3 MVP)

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/enroll` | enrollment token + node public key + enrollmentRequestId | one-time enrollment, returns nodeId + registryContact params |
| `POST /api/v1/heartbeat` | Ed25519 (ORBIT-MACHINE-V1) | liveness + **non-authoritative runtime identity** (`orbitVersion`, `orbitRevision`, `dshVersion`, `compatibilityProfile`, mapped 1:1 to report fields below): updates `registryContact` + `lastSeen`; runtime identity is compared with the latest report's identity tuple to flag staleness at the Hub (RFC-0009). **Carries no capabilities and declares nothing about capability state.** |
| `POST /api/v1/report-upload` | Ed25519 (ORBIT-MACHINE-V1) | sanitized compatibility report upload; capabilities derive from it at the Hub |
| `POST /api/v1/credential-rotate` | Ed25519 (ORBIT-MACHINE-V1, old key) | new public key rotation with overlap |
| `POST /api/v1/reenroll` | ORBIT-REENROLL-V1 (original node private key) + re-enrollment token | restore a tombstoned nodeId with a new public key (see re-enrollment protocol) |

**Heartbeat runtime identity ↔ report fields (1:1, fixed)**: `orbitVersion` ↔ `report.orbit.version`; `orbitRevision` ↔ `report.orbit.revision`; `dshVersion` ↔ `report.candidate.dshVersion`; `compatibilityProfile` ↔ `report.candidate.profile`. There is no `orbitCommit` field (no corresponding report field).

There is **no** `update-capabilities` endpoint: capabilities are derived deterministically from the latest uploaded report at the Hub (single source of truth; RFC-0009). All machine routes are fixed paths **without query strings**; any request carrying a query string is denied (400) before authentication (see wire contract).

## Security/acceptance matrix (all fail closed)

| Case | Expected |
| --- | --- |
| enroll with valid token, fresh keypair, unique requestId | success; result idempotent per requestId+token+publicKey |
| enroll with missing / malformed / unknown token | denied |
| enroll with already-consumed token (same content) | same result returned (idempotent replay) |
| enroll with consumed token + different request/body | denied |
| enroll with expired token | denied |
| enroll with a `reenroll`-purpose token | denied (purpose mismatch) |
| reenroll with an `enroll`-purpose token | denied (purpose mismatch) |
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
| keyId that is not the first 16 bytes of SHA-256(pubkey) (lowercase hex) | denied (400, wire contract) |
| revoked node (after delete) | denied with `revoked` hint |
| rotated key before overlap start | denied |
| non-empty query string on a machine route | denied (400; the protocol has no query strings) |
| report-upload oversized body | denied (413) |
| rate limit exceeded | denied (429, Retry-After) |
| reenroll with valid token + ORBIT-REENROLL-V1 proof signed by the original private key | success; nodeId restored with the new public key; historical key stays revoked |
| reenroll with malformed `reenrollmentRequestId` (not 32 lowercase hex) | denied (400, wire contract) |
| reenroll with an idempotency-key exact replay | same result (idempotent replay) |
| reenroll with consumed token, different idempotency content | denied |
| reenroll proof signed with the new key or any other key | denied (possession proof failed; nothing consumed) |
| reenroll targeting a non-tombstoned nodeId | denied |
| the tombstone-retained historical key used on heartbeat / report-upload / credential-rotate | denied (revoked; the reenroll route is the only exception) |
| 5xx upstream failure | failed case (never "allowed") |

## Acceptance methodology

The matrix is exercised by a fail-closed live smoke suite (positive control plus every denial case) against a local registry harness using generated Ed25519 keys; no production keys are used in tests. The suite exits non-zero on any mismatch and never applies browser header semantics.