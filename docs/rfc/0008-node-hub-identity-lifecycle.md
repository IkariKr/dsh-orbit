# RFC 0008: Per-node Hub service identity lifecycle (design, rev. 3)

Status: Accepted (2026-08-30), rev. 3 after architecture review round 2. **Design only: v0.3 generates no Hub→Node key material of any kind.** Provision and activation both occur in v0.4, when Hub→Node flows actually exist. This closes the round-1 conflict between "v0.3 provision / v0.4 activation" and "issuance/activation all in v0.4": the answer is the latter.

## Key direction (fixed, design-time)

- When the Hub needs to talk to a node, it generates a per-node Ed25519 keypair.
- The **Hub private key never leaves the Hub**; the node stores only the Hub **public key** for the node.
- There is no symmetric "verifier at the node" problem: verification uses the public key the node holds.

## Identity object (not created in v0.3)

- In v0.4: one Hub identity per node — an Ed25519 keypair, `hub_ik_<keyId>` label, bound to the node ID.
- All hub→node requests are signed with the node's Hub private key over the ORBIT-MACHINE-V1 signing string (RFC-0006), with the hub keyId carried in the header; the node verifies with its stored Hub public key. Encodings follow the RFC-0006 wire contract.
- The identity is unusable against any other node (node ID is part of the signing string).
- v0.3 consequence: the Hub holds no Hub→Node private keys, the node stores no Hub public key, and no lifecycle row exists for this direction.

## Lifecycle states (v0.4 flow; zero instances exist in v0.3)

`provisioned → active → rotating → revoked` (terminal).

- **provisioned**: keypair generated Hub-side; the node receives the public key through an authenticated handover (delivered in a Hub-signed message, or fetched by the node via a Hub-signed handover).
- **active**: first Hub→Node use; the node's first successful verification confirms activation.
- **rotating**: new Hub keypair issued with an overlap window (default 14 days, operator-configurable 1–30 days); both keys valid during the overlap; the old revoked at its end.
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
- In v0.3 none of these can be exercised against live material (none exists); verification is at design level only, and the tests belong to the v0.4 activation suite. This is the intended state: **nothing to provision, nothing to activate, no partial lifetime.**

## Change note (rev. 2 → rev. 3)

- Removed "v0.3 provisions and persists the identity material; it becomes active only in v0.4".
- Fixed: v0.3 generates nothing Hub-side; RFC-0005 D3 now matches this.