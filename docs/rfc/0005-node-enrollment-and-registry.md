# RFC 0005: Node enrollment and registry persistence (decided, rev. 3)

Status: Accepted (2026-08-30), rev. 3 after architecture review rounds 1–2: token-digest storage and replay retention fixed, operator-attestation recovery path removed, Hub→Node key material fully deferred to v0.4, persistence contract fixed. Decisions are fixed; implementation may proceed only after the v0.3 architecture review passes.

Depends on: 0001-node-identity, 0003-node-authentication. **Pairing** means exclusively the v0.5 reverse-connected device flow; **enrollment/bootstrap** means registering a server-reachable node with the Hub.

## Scope

Enrollment for nodes the Hub can reach directly. Does **not** design reverse connection, NAT traversal, device pairing, endpoint routing, multi-node sessions, or fleet execution.

## Decisions

### D1: Stable node ID mint and persistence

- Hub mints `node_` + 128 bits of random hex at enrollment. Opaque; never derived from addresses, credentials, or hostnames; never reused for another installation.
- Hub persists `{ nodeId, mintedAt, state, nodePublicKey, ... }` in the registry.
- Node persists `{ nodeId, hub: { baseUrl }, keys }` locally. Node store loss → the node re-enrolls as a new installation (ordinary enrollment always mints a NEW nodeId — see D5/D6); the old record is removed by the operator.

### D2: One-time enrollment with idempotency (token stored as digest; purpose-minted)

- The operator mints short-lived, single-use enrollment tokens (128-bit random; TTL default 10 min, 1–60 configurable; burst limits per RFC-0006). **The Hub stores only a SHA-256 digest of the token — never the plaintext.**
- **Every token carries a fixed `purpose`**: `enroll` or `reenroll`, set at mint time (RFC-0007). `enroll` tokens have `boundNodeId = NULL`; `reenroll` tokens carry `boundNodeId` = the tombstoned nodeId they are bound to. Both machine endpoints reject tokens of the wrong purpose (RFC-0006).
- The node sends its Ed25519 public key and a client-generated `enrollmentRequestId` (128-bit random, 32 hex) with the token.
- **Idempotency**: the same `token + enrollmentRequestId + publicKey` replay returns the same enrollment result (the Hub persists the completed enrollment keyed by `enrollmentRequestId` in `enrollment_results`); the same token with any different content is denied (the token is consumed exactly once per distinct enrollment).
- A failed attempt does not consume the token; a successful one does.
- If the response is lost after a successful enrollment, the node retries the identical request and receives the identical result (including the issued nodeId and registry contact parameters).
- **Replay retention (fixed)**: `enrollment_results` rows are retained for the standard retention (default 90 days, aligned with RFC-0009 event retention). **An exact successful replay is served from the recorded result even after the token has expired** — token TTL governs first-time acceptance only; expiry never invalidates an already-recorded enrollment result. Replays older than the retention period are denied (the node re-enrolls as a new installation).

### D3: Credential issuance (Ed25519; Hub→Node key material deferred to v0.4)

- **Node side**: the node generates its Ed25519 keypair before enrollment; the private key never leaves the node; the Hub stores only the node's public key (verified from the enrollment request). Encoding per RFC-0006 wire contract.
- **Hub side**: **v0.3 generates no Hub→Node keypair and no Hub service identity material at all.** The identity lifecycle (RFC-0008) is design-only until v0.4, when Hub→Node flows actually exist; then the Hub generates its own per-node keypair, the Hub private key never leaves the Hub, and the node receives only the Hub public key.

### D4: Duplicate registration

- Same token cannot enroll twice with distinct content (D2).
- A node already registered (persisted nodeId) that calls ordinary enrollment is rejected with an explicit reconcile error: registered nodes authenticate with their existing key (heartbeat/update path).
- A signature bound to one nodeId replayed against another is rejected (RFC-0006).

### D5: Delete, tombstone, and re-registration (original private key required)

- Operator delete: credential keys revoked immediately; the record becomes a **tombstone** (nodeId + deletedAt + reason kept).
- Re-registration restores an original nodeId **only** through a re-enrollment token minted by `hub.nodes.reenroll(nodeId)` with `purpose = reenroll` and `boundNodeId` = the tombstoned nodeId, **and only when the holder demonstrates possession of the original node private key**. The browser endpoint mints the token only; **completion is the machine endpoint `POST /api/v1/reenroll` with the `ORBIT-REENROLL-V1` possession proof** (RFC-0006 protocol, including the fixed `reenrollmentRequestId` idempotency key and the success transaction). The tombstone retains the node's last public key so the Hub can verify the proof; that historical key **stays `revoked` permanently** and authorizes nothing except verifying this proof. Ordinary enrollment always mints a fresh nodeId.
- **There is no operator-attestation recovery path**: if the original private key is lost, the old nodeId is permanently unrecoverable; the node re-enrolls as a new installation (new nodeId) and the operator tombstones the stale record. A future force-rebind is a separate, explicitly dangerous operation (independent design, mandatory full audit) — out of v0.3 scope.
- There is no implicit re-registration: anything auto-registering a node without an operator-minted token is a bug.

### D6: Registry/installation loss

- Hub registry loss: nodes re-enroll with fresh tokens after the operator rebuilds the registry.
- Node store loss: per D5 — no attestation path; new installation → new nodeId.

### D7: Registry persistence contract (SQLite/WAL; fixed transaction boundaries)

- **Store**: SQLite in WAL mode is the v0.3 registry store (single-file, transactional, crash-safe; no separate database service). Writes go through a single connection with `BEGIN IMMEDIATE` semantics and `busy_timeout`; readers use the WAL snapshot.
- **Fixed transaction boundaries** (each is an all-or-nothing unit):
  - enrollment consume+create: consume token (by digest) + insert `enrollment_results` + create `nodes`/`node_keys` — one transaction; idempotent replay reads the recorded result and writes nothing new.
  - nonce reserve: unique `(node_id, nonce)` insert committed before business logic, never rolled back by business outcomes (RFC-0006).
  - rotation: insert new `node_keys` row + set overlap window + schedule old-key revocation — one transaction.
  - delete/tombstone: `nodes.state = tombstoned` + revoke all keys + audit row — one transaction. Reports/events/audit are never cascade-deleted (RFC-0009).
  - report upload: insert `reports` row + recompute derived capabilities + health transition event — one transaction.
  - heartbeat: update contact/lastSeen + health transition event when a dimension changes — one transaction.
  - session bootstrap/logout: insert/delete `browser_sessions` + audit row — one transaction (RFC-0007).
- **Minimal persistence contract** (the v0.3 table set is exactly: `nodes`, `node_keys`, `enrollment_tokens` (digest, `purpose`, nullable `boundNodeId`), `enrollment_results`, `seen_nonces`, `reports`, `events`, `audit`, `browser_sessions`); no third-party plugin fields anywhere (ADR-0001).

## MVP scope (fixed)

In scope: stable identity, enrollment (with the idempotency rules above), per-node credential (Ed25519 public keys), registry persistence (D7), heartbeat, compatibility-report upload, evidence-backed capabilities, health/event history, operator node management. Out of scope (later milestones): endpoint routing, reverse connection, multi-node sessions, fleet execution, Hub service identity generation/activation (v0.4).

## Acceptance and failure conditions

- Enrollment succeeds only with a valid, unexpired, unconsumed **enroll-purpose** token; re-enrollment completion only with a valid, unexpired, unconsumed **reenroll-purpose** token whose `boundNodeId` matches the tombstone; all other attempts fail closed.
- Replays of a completed enrollment/re-enrollment (identical idempotency content) return the same result within the replay retention, even past token expiry; different content is denied.
- No anonymous enrollment endpoint exists; ordinary enrollment never restores a historical nodeId.
- No attestation path: a lost node private key yields a new installation, never the old nodeId.
- The Hub never stores an enrollment-token plaintext (digest only), and `seen_nonces` is transactional.
- Deletion immediately revokes keys; re-registration requires a re-enrollment token bound to the tombstone plus the original private key.
- Reverse connection is out of scope: no inbound-connection acceptance, NAT traversal, or device pairing in v0.3.