# RFC 0008: Per-node Hub service identity lifecycle (decided, rev. 2)

Status: Accepted (2026-08-30), rev. 2 after architecture review P0/P1 closure. Closes the Hub-to-node authentication direction from RFC-0003. **Design only: activation is deferred to v0.4** (the v0.3 MVP performs no Hub→node execution or routing).

## Key direction (fixed)

- The Hub generates a per-node Ed25519 keypair at enrollment.
- The **Hub private key never leaves the Hub**; the node stores only the Hub **public key** for the node.
- There is no symmetric "verifier at the node" problem: verification uses the public key the node holds.

## Identity object

- One Hub identity per node: an Ed25519 keypair, `hub_ik_<keyId>` label, bound to the node ID.
- All hub→node requests are signed with the node's Hub private key over the ORBIT-MACHINE-V1 signing string (RFC-0006), with the hub keyId carried in the header; the node verifies with its stored Hub public key.
- The identity is unusable against any other node (node ID is part of the signing string).

## Lifecycle states

`provisioned → active → rotating → revoked` (terminal). v0.3 provisions and persists the identity material; it becomes `active` only in v0.4 when Hub→node flows exist.

- **provisioned**: created at enrollment; stored Hub-side (private) and node-side (public); no traffic.
- **active (v0.4)**: the Hub first uses it, and the node's first successful verification confirms activation.
- **rotating**: new Hub keypair issued with an overlap window (default 14 days, operator-configurable 1–30 days); both keys valid during the overlap; the old revoked at its end. The new public key is delivered to the node in an authenticated message from the Hub (signed by the Hub with the OLD key, or fetched by the node with a Hub-signed handover).
- **revoked**: terminal on node deletion (immediately) or failed rotation (operator action).

## Rules

- No two nodes share a Hub identity; no Hub-wide master identity.
- Rotation is per node; no global re-key.
- All transitions are audited events with operator attribution where initiated by the operator.
- Node side stores only public material for the Hub identity; nothing secret is stored on the node for this direction.

## Acceptance

- A node rejects Hub requests signed with another node's identity.
- After node deletion, the Hub identity fails immediately (negative test).
- Rotation with overlap: both keys valid in-window; the old key fails after the window.
- These are part of the machine API live smoke matrix methodology (RFC-0006); in v0.3 the checks are simulation-level because no Hub→node flow exists yet.