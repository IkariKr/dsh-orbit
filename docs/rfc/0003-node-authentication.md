# RFC 0003: Node authentication

Status: Accepted (2026-08-29) for the v0.3 architecture
Target milestone: 0.3 (node identity and registry)
Depends on: 0001-node-identity; the v0.2 trust boundary

## Context

The v0.2 security model already establishes the pattern this RFC extends: a gateway-held secret injected after user authentication, never exposed to browsers, verified server-side together with host, protocol, same-origin, and cross-site checks. A fleet must not regress this into a single permanent shared secret: one leaked fleet secret would compromise every node at once, and revocation would mean re-keying the fleet.

## Proposal

Every node has its own credential set, bound to its stable node ID:

1. **Per-node node-to-Hub credential** — one Ed25519 **public key** per node, registered at enrollment; the node signs its machine requests with the matching private key over the fixed ORBIT-MACHINE-V1 signing string (RFC-0006). The private key is generated on the node and never leaves it; the Hub stores only the public key (never a symmetric secret, never a hash of a verifiable secret).
2. **Per-node Hub-to-node trust continuation** — the node keeps its existing v0.2 gateway model. The Hub talks to each node through a per-node Hub service identity (never a reused operator account, and never a fleet-wide credential), authenticating at the node's gateway as any client does; the node's gateway injects the internal proxy secret. The Hub never receives the node's internal proxy secret in its own right; that secret remains gateway-held.
3. **Independent revocation** — deleting or suspending one node's credential affects exactly that node. A compromised node credential is revoked by the operator with a single action and no fleet-wide re-keying.
4. **Rotation** — rotation generates a new credential and keeps the old one valid for a bounded overlap window (default: 24 hours, operator-adjustable), so a node can be rotated without an outage. Revocation is immediate and separate from rotation.
5. **Least privilege** — a node credential authorizes only the node's own registration surface: identity refresh (re-enrollment), heartbeat/health, and compatibility-report upload. Capability state is derived at the Hub from uploaded reports (RFC-0009), so there is nothing node-side to authorize for it. Anything that executes on or mutates a node (sessions, settings, terminals, agents) flows through the node's existing authenticated gateway path under the v0.2 trust boundary, never through the node-registry credential.

Rules:

- No mandatory fleet-wide permanent shared secret may exist in any 0.3 design.
- Credentials are never logged, never embedded in reports, and never derivable from node IDs.
- Credential issuance, rotation, and revocation are audited events with operator attribution.

## Implementation prerequisites

Two security boundaries must be designed separately before implementation. What carries over from the v0.2 model is the fail-closed live smoke methodology — a positive control plus denial cases as the acceptance bar — not a mechanical reuse of browser header checks on machine traffic.

1. **Registry machine API** (node-to-Hub: enrollment completion, heartbeat, report upload, signed rotation): credential binding to the stable node ID, replay protection, rate limiting, strict node scoping (a credential authorizes exactly its own node), and its own denial-case smoke matrix. There is no capability advertisement surface (RFC-0009) and no key expiry in v0.3 (revocation and rotation only).
2. **Browser management API** (operator-facing Hub UI): the v0.2 browser trust requirements apply here — Origin and Sec-Fetch-Site checks, CSRF protection, and identity-header spoofing denial, exactly as the live authorization smoke suite exercises them.

## Upgrade-guard integration

The v0.2 authorization smoke suite is the acceptance template for the registry surface too: any node-registry endpoint designed by this RFC must be exercisable by the same live smoke methodology (positive control, unauthenticated denial, invalid-credential denial, cross-origin denial, cross-site denial, forged-assertion denial) before fleet code ships. Compatibility reports are uploaded by the node over its authenticated registry session; the report itself remains the sanitized v0.2 artifact and carries no credentials.

## Resolved questions (P2 sweep, 2026-08-30)

- **Credential format and storage on resource-constrained nodes** — CLOSED: Ed25519 keypair; the node private key never leaves the node; the Hub stores only public keys (RFC-0005 D3, RFC-0006). The one-way-symmetric "hashed secret at Hub, verifier at node" form is abandoned.
- **Lifecycle of the per-node Hub service identities** — CLOSED: Ed25519 key direction fixed (Hub private key never leaves the Hub; node holds only the Hub public key); states provisioned → active → rotating → revoked; issuance/activation deferred to v0.4 (RFC-0008).
- **Overlap-window defaults for rotation in headless deployments** — CLOSED: node credential rotation overlap default 24h (1–168h configurable; RFC-0006); Hub identity rotation overlap default 14 days (1–30 configurable; RFC-0008) to tolerate weekly-online headless deployments.
- **Rate limiting and lockout behavior for the registration surface** — CLOSED: fixed defaults — heartbeat 1/s (burst 3), report upload 10/min, enrollment/reenroll attempts per token 10, token minting 20/h, per-IP 120/min; body size limits per route; transactional nonce reservation into `seen_nonces` with 24h retention (RFC-0006).
- **Capability advertisement mechanism** — CLOSED: no `update-capabilities` endpoint; capabilities are derived at the Hub from the latest uploaded compatibility report, single source of truth (RFC-0009).

## Remaining open questions

None for v0.3. Hub-to-node execution/session flows and their identity activation belong to the v0.4 milestone (RFC-0008 activation), and reverse-connected device pairing to v0.5; both are out of scope here.
