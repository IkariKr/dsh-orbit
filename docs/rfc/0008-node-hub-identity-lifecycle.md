# RFC 0008: Per-node Hub service identity lifecycle (decided)

Status: Accepted (2026-08-30). Closes the Hub-to-node authentication direction from RFC-0003.

## Decision

The Hub talks to each node through a **per-node Hub service identity** — never a reused operator account, and never a fleet-wide credential. Each node receives its own Hub identity at enrollment (RFC-0005 D3) and the Hub uses it whenever it connects to that node (for example to inspect node state, request reports, or act on operator intent).

## Identity object

- One Hub service identity per node: `hub_sk_<base64url(32 bytes)>` (same random format and storage rules as node credentials: verifier-hashed at rest on the node, plaintext held by the Hub's node-record).
- Bound to the node ID: the identity is unusable against any other node (remote commands/reads must include the node ID and be MAC-bound to it, mirroring RFC-0006).

## Lifecycle states

`issued → active → rotating → revoked` (terminal).

- **issued**: created at enrollment with the node credential; becomes active once the node confirms its first authenticated heartbeat/registration refresh.
- **active**: valid for its base validity (default 90 days). Refresh/rotation policies below keep it active.
- **rotating**: when nearing expiry (default: rotation starts at 80% of validity), a new Hub identity is issued with an overlap window (default 14 days, operator-configurable 1–30 days); both remain valid during the overlap; the old one is revoked at the end of the overlap.
- **revoked**: terminal on node deletion (immediately) or after a failed rotation (operator action); revoked identities never return to active.

## Rules

- No two nodes share a Hub identity; no Hub-wide master identity exists.
- Rotation is independent per node; no global re-key.
- All transitions are audited events with operator attribution where the operator initiated them.
- Node-side storage mirrors the node credential rules (runtime-private file, never logged, never in reports).

## Acceptance

- A node must reject Hub requests authenticated with another node's identity.
- After node deletion, the Hub identity fails immediately (negative test).
- Rotation with overlap: both identities valid during the window; after the window, the old one fails.
- These behaviors are part of the machine API live smoke matrix (RFC-0006 methodology).