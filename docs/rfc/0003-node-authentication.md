# RFC 0003: Node authentication

Status: Accepted (2026-08-29) for the v0.3 architecture
Target milestone: 0.3 (node identity and registry)
Depends on: 0001-node-identity; the v0.2 trust boundary

## Context

The v0.2 security model already establishes the pattern this RFC extends: a gateway-held secret injected after user authentication, never exposed to browsers, verified server-side together with host, protocol, same-origin, and cross-site checks. A fleet must not regress this into a single permanent shared secret: one leaked fleet secret would compromise every node at once, and revocation would mean re-keying the fleet.

## Proposal

Every node has its own credential set, bound to its stable node ID:

1. **Per-node node-to-Hub credential** — one secret per node, generated at registration, presented by the node to authenticate registration refreshes and heartbeats. Stored hashed on the Hub side where the Hub keeps state.
2. **Per-node Hub-to-node trust continuation** — the node keeps its existing v0.2 gateway model. The Hub talks to each node through a per-node Hub service identity (never a reused operator account, and never a fleet-wide credential), authenticating at the node's gateway as any client does; the node's gateway injects the internal proxy secret. The Hub never receives the node's internal proxy secret in its own right; that secret remains gateway-held.
3. **Independent revocation** — deleting or suspending one node's credential affects exactly that node. A compromised node credential is revoked by the operator with a single action and no fleet-wide re-keying.
4. **Rotation** — rotation generates a new credential and keeps the old one valid for a bounded overlap window (default: 24 hours, operator-adjustable), so a node can be rotated without an outage. Revocation is immediate and separate from rotation.
5. **Least privilege** — a node credential authorizes only the node's own registration surface: identity refresh, heartbeat/health, capability advertisement, and compatibility-report upload. Anything that executes on or mutates a node (sessions, settings, terminals, agents) flows through the node's existing authenticated gateway path under the v0.2 trust boundary, never through the node-registry credential.

Rules:

- No mandatory fleet-wide permanent shared secret may exist in any 0.3 design.
- Credentials are never logged, never embedded in reports, and never derivable from node IDs.
- Credential issuance, rotation, and revocation are audited events with operator attribution.

## Implementation prerequisites

Two security boundaries must be designed separately before implementation. What carries over from the v0.2 model is the fail-closed live smoke methodology — a positive control plus denial cases as the acceptance bar — not a mechanical reuse of browser header checks on machine traffic.

1. **Registry machine API** (node-to-Hub: registration refresh, heartbeat, capability advertisement, report upload): credential binding to the stable node ID, credential expiry and replay protection, rate limiting, strict node scoping (a credential authorizes exactly its own node), and its own denial-case smoke matrix.
2. **Browser management API** (operator-facing Hub UI): the v0.2 browser trust requirements apply here — Origin and Sec-Fetch-Site checks, CSRF protection, and identity-header spoofing denial, exactly as the live authorization smoke suite exercises them.

## Upgrade-guard integration

The v0.2 authorization smoke suite is the acceptance template for the registry surface too: any node-registry endpoint designed by this RFC must be exercisable by the same live smoke methodology (positive control, unauthenticated denial, invalid-credential denial, cross-origin denial, cross-site denial, forged-assertion denial) before fleet code ships. Compatibility reports are uploaded by the node over its authenticated registry session; the report itself remains the sanitized v0.2 artifact and carries no credentials.

## Unresolved questions

- Credential format and storage on resource-constrained nodes (symmetric secret vs. keypair).
- Lifecycle of the per-node Hub service identities: issuance, expiry, and rotation windows.
- Overlap-window defaults for rotation in headless deployments that only come online weekly.
- Rate limiting and lockout behavior for the registration surface.
