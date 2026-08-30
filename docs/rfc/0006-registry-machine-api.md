# RFC 0006: Registry machine API — security and acceptance matrix (decided)

Status: Accepted (2026-08-30). Independent of the browser management API (RFC-0007); the shared element is the fail-closed live smoke methodology, not browser header requirements.

## Scope

Machine-to-machine endpoints between a registered node and the Hub: registration refresh, heartbeat, compatibility-report upload, and capability advertisement updates. No browser trust semantics (Origin/Sec-Fetch-Site/CSRF) apply here.

## Decided: node credential format and replay protection

- **Format**: 256-bit random symmetric secret, transport-encoded `node_sk_<base64url(32 bytes)>`. The Hub stores only a verifier (`SHA-256(credential)`), never the plaintext; the raw secret is delivered exactly once at enrollment (RFC-0005 D3).
- **Request authentication**: HMAC-SHA256 request signing. Every machine request carries:
  - `nodeId` (scoped, in the body);
  - `ts` — Unix timestamp (seconds);
  - `nonce` — 128-bit random per request;
  - `X-Orbit-Mac: base64(HMAC-SHA256(credential, method + "\n" + path + "\n" + ts + "\n" + nonce + "\n" + canonical-body-hash))`.
- **Replay protection (decided, not deferred)**:
  - timestamp skew window: server rejects `|now - ts| > 30s`;
  - nonce replay cache: every accepted nonce is retained for 60s beyond the skew window (i.e., ~90s total) and rejected on reuse; the cache is per-node;
  - the MAC covers the canonical body hash, so the body cannot be swapped, and covers the `nodeId`, so a captured request cannot be replayed against another node;
  - TLS (1.2+) for transport; the MAC adds authenticity and replay protection beyond TLS.
- **Rotation**: a new credential replaces the old with a bounded overlap (default 24h, operator-configurable 1–168h); revocation is immediate and independent.
- **Rate limiting**: per-node and per-IP token-bucket limits on machine endpoints; mailbox re-enrollment after repeated failures requires operator action.

## Machine API surface (v0.3 MVP)

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `node.enroll` | enrollment token (RFC-0005) | one-time enrollment, credential + Hub identity issuance |
| `node.heartbeat` | HMAC (node credential) | liveness + last-seen + health fields + capability set |
| `node.report-upload` | HMAC (node credential) | sanitized v0.2 compatibility report upload |
| `node.update-capabilities` | HMAC (node credential) | capability advertisement refresh (evidence-bound, RFC-0009) |
| `node.credential-rotate` | HMAC (old credential) | rotation with overlap window |

## Security/acceptance matrix (all fail closed)

| Case | Expected |
| --- | --- |
| enroll with valid token | success, token consumed |
| enroll with missing / malformed / unknown token | denied |
| enroll with already-consumed token | denied |
| enroll with expired token | denied |
| heartbeats with valid MAC, fresh ts, fresh nonce | accepted |
| missing MAC | denied |
| wrong MAC (tampered body, wrong key, swapped nodeId) | denied |
| valid MAC + reused nonce (replay capture) | denied |
| valid MAC + stale ts (> skew) | denied |
| valid MAC + future ts (> skew) | denied |
| valid MAC + body modified after MAC (body hash mismatch) | denied |
| valid MAC for node A replayed against node B | denied (MAC covers nodeId) |
| revoked credential (after delete) | denied with `revoked` hint |
| report-upload with credential mismatch / oversized body | denied |
| rate-limit exceeded | denied (429) with retry-after |

## Acceptance methodology

The matrix is exercised by a fail-closed live smoke suite (positive control plus every denial case), runnable in CI against a local registry harness with injected secrets/nonces; no production credentials are used in tests. The suite must exit non-zero on any mismatch and must never require the browser header semantics of the management API.