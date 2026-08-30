# RFC 0001: Node identity

Status: Accepted (2026-08-29) for the v0.3 architecture
Target milestone: 0.3 (node identity and registry)
Depends on: v0.2.0 compatibility evidence (see "Upgrade-guard integration")

## Context

A future Orbit Hub must talk to many DSH nodes. Deployments live on home servers, NAS devices, and VMs whose addresses change (DHCP, Tailscale, tunnel ingress). v0.2 production runs already show this: the same DSH deployment is reached by LAN split DNS, Tailscale, and a Cloudflare tunnel under one public authority.

If a hostname or address becomes a node's identity, every DNS or tunnel change silently creates a "new" node and orphans the old entry — including its credentials, health history, and compatibility evidence.

## Proposal

A node record separates four concepts:

1. **Stable node ID** — the primary identity. An opaque, generated identifier (for example `node_` + 128 bits of random hex), created once at node registration and never derived from network properties.
2. **Installation ID** — where a single Orbit/DSH installation may be re-registered under multiple Hubs or after a Hub rebuild, an optional secondary identifier minted at first Orbit start and persisted in DSH home. It lets a Hub recognize "the same installation" even when the operator re-registers it, without making the installation ID a secret or a credential.
3. **Display name** — mutable, user-facing, non-unique (for example `ugreen-nas`). Never used for authorization or routing decisions.
4. **Address metadata** — mutable list of known endpoints (LAN address, Tailscale name, tunnel URL) with source and last-verified timestamps. Addresses are observations about a node, not the node.

Rules:

- A hostname or IP address alone must never be treated as the stable identity.
- Node identity must not be derived from credentials (rotating a credential must not change the identity).
- Deleting a node is an explicit operator action; a lost node ID cannot be reconstructed from addresses.

## Upgrade-guard integration

The v0.2 compatibility report is keyed to an exact Orbit revision and candidate DSH version. A node registration message carries the node ID plus the same identity tuple (Orbit version/revision, DSH version, compatibility profile), so the Hub attaches each compatibility report to a stable node rather than to a hostname. Re-registering a node under a new address keeps its compatibility history; a DSH upgrade on the node produces a new report against the same node ID.

## Implementation prerequisites

The enrollment/bootstrap flow (Hub-minted stable node ID, local persistence, one-time enrollment, first credential issuance) is closed by `docs/rfc/0005-node-enrollment-and-registry.md`. "Pairing" in this project now refers exclusively to the v0.5 reverse-connected device flow, not to v0.3 enrollment.

## Resolved questions (P2 sweep, 2026-08-30)

- **Where the stable node ID is first minted** — CLOSED: the Hub mints the node ID at enrollment (RFC-0005 D1); ordinary enrollment always mints a new ID; re-registration of a historical ID requires a tombstone-bound re-enrollment token (RFC-0005 D5).
- **Whether installation IDs are exposed in the 0.3 registry** — CLOSED: no installation ID in the v0.3 registry; deferred to multi-Hub work. The node ID is the only registry identity (RFC-0005 D1).
- **Retention policy for address metadata history** — CLOSED: address history may be retained with the general event retention (90 days; RFC-0009); addresses remain observations, never identity.
- **How node deletion interacts with archived compatibility reports** — CLOSED: operator delete tombstones the node and revokes credentials immediately; compatibility reports, health events, and audit records are kept to their defined retention with no cascade delete (RFC-0009 "Deletion and history retention").
- **Node authentication mechanism** — CLOSED: Ed25519, node private key never leaves the node, Hub stores only public keys, ORBIT-MACHINE-V1 signing string (RFC-0005 D3, RFC-0006).
- **Credential rotation** — CLOSED: new public key introduced by a request signed with the old private key, bounded overlap window (RFC-0006).

## Remaining open questions

None for v0.3. (Multi-Hub identity, installation IDs as credentials, and reverse-connected device pairing are deferred to their own milestones and are out of scope here.)
