# RFC 0005: Node enrollment and bootstrap (decided design)

Status: Accepted (2026-08-30) — decisions are fixed; implementation may proceed only after the v0.3 architecture review.

Depends on: 0001-node-identity, 0003-node-authentication. Supersedes the "pairing" terminology for v0.3: **pairing** now means exclusively the v0.5 reverse-connected device flow; **enrollment/bootstrap** means registering a server-reachable node with the Hub.

## Scope

This RFC decides the enrollment flow for nodes the Hub can reach directly over the network. It explicitly does **not** design reverse connection, NAT traversal, device pairing for NAT-restricted devices, endpoint routing, multi-node sessions, or fleet execution (all later milestones).

## Decisions

### D1: Stable node ID mint and persistence

- The Hub mints the stable node ID at enrollment: `node_` + 128 bits of cryptographically random data, hex-encoded.
- The ID is opaque, never derived from addresses, credentials, or hostnames, and never reused for a different installation after deletion.
- The Hub persists `{ nodeId, mintedAt, state, credentialRef, ... }` in the registry.
- The node persists `{ nodeId, hub: { baseUrl }, credential }` in its local store (DSH home). If the node's local store is lost, the node re-enrolls as a new installation; the old registry record is removed by the operator (D6).

### D2: One-time enrollment

- Enrollment uses a short-lived, single-use enrollment token minted by the operator through the browser management API.
- Token properties: 128-bit random secret; TTL default 10 minutes (operator-configurable 1–60 minutes); single-use (consumed atomically at first successful use); burst-limited (max 20 mint attempts per operator per hour, max 10 enrollment attempts per token).
- Flow: node presents token → Hub validates (exists, unexpired, unused) → atomically consumes → mints node ID (D1) → issues node credential (D3) → returns the enrollment response exactly once.
- A failed enrollment attempt does not consume the token; a successful one does.

### D3: First credential issuance

- At enrollment the Hub issues both secrets to the node:
  1. the **node credential** (see RFC-0006 for format); it is returned exactly once and stored by the Hub only as a verifier (hash), never in plaintext;
  2. the **Hub service identity** for this node (see RFC-0008).
- The node stores both locally (mode-600-equivalent permissions). Re-issuance of the node credential after the single delivery requires rotation (RFC-0006) or re-enrollment.

### D4: Duplicate registration

- The same enrollment token cannot enroll twice (single-use).
- A node already registered (per its persisted node ID) that calls enrollment is treated as a configuration error: enrollment accepts only tokens; an already-registered node must authenticate with its existing credential (heartbeat/update path), not re-enroll. The Hub rejects "enroll with existing nodeId token conflict" with an explicit error indicating the operator should reconcile.
- A node credential presented with a mismatched node ID is rejected (node scope binding, RFC-0006).

### D5: Delete and re-registration

- Operator delete: the registry record is removed and the credential verifier is revoked immediately; the node's next authenticated request fails with 401 and an explicit `revoked` hint.
- Re-registration after explicit delete: the node may enroll again with a fresh token; if it still holds its persisted node ID, the Hub accepts the same node ID for a new record (identity continuity), provided no other live record claims that node ID. The node's old credential is already revoked by the delete.
- There is no implicit re-registration: anything that auto-registers a node without a fresh operator-minted token is a bug.

### D6: Registry/installation loss

- Hub registry loss: nodes re-enroll with fresh tokens after the operator rebuilds the registry; node IDs are preserved only where the node store still holds them (D5).
- Node store loss: the node re-enrolls as a new installation; the operator deletes the stale record.

## v0.3 Registry MVP scope (fixed)

In scope for the MVP: stable identity, enrollment, per-node credential, registry persistence, heartbeat, compatibility-report upload, evidence-backed capabilities, health/event history, and operator node management. Out of scope (later milestones): endpoint routing, reverse connection, multi-node sessions, fleet execution.

## Acceptance and failure conditions

- Enrollment succeeds only with a valid, unexpired, unconsumed token; all other attempts fail closed.
- No anonymous enrollment endpoint exists.
- Deletion is the only path that revokes the credential; re-enrollment always requires a fresh operator token.
- Reverse connection is out of scope: no inbound-connection acceptance, NAT traversal, or device pairing appears in v0.3 (see roadmap).