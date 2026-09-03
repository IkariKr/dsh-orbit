# RFC 0008: Per-node Hub service identity lifecycle (design, rev. 4)

Status: Core identity direction/lifecycle accepted (2026-08-30). The v0.4 activation profile added in rev. 4 is **Proposed for the v0.4 architecture review**. v0.3 still generates no Hub→Node key material of any kind.

## Key direction (fixed)

- When the Hub needs to authenticate itself to a node, it generates a per-node Ed25519 keypair.
- The **Hub private key never leaves the Hub**; the node stores only Hub **public keys** for that node.
- There is no symmetric fleet-wide verifier and no Hub-wide master route identity.

## Identity object

In v0.4, one Hub identity belongs to one node:

- label: `hub_ik_<keyId>`;
- Ed25519 keypair generated Hub-side;
- bound to one RFC-0001 `nodeId`;
- unusable against any other node;
- private key retained only by the Hub;
- public key set persisted by the node.

The identity is a generic Orbit service identity. Individual Orbit protocols define what they sign:

- RFC-0010 browser route admission uses `ORBIT-ROUTE-V1` so HTTP bodies and WebSocket streams remain streaming;
- a future Orbit-owned control request may define another explicit signing label after architecture review.

Do not reuse `ORBIT-MACHINE-V1` mechanically for browser routing. RFC-0006 includes a body hash and is designed for small Node→Hub machine API requests; making it authenticate arbitrary routed browser bodies would force unnecessary buffering.

## Lifecycle states

`provisioned → active → rotating → revoked` (terminal).

- **provisioned**: keypair generated Hub-side; the node has not yet durably acknowledged the public key.
- **active**: the node has durably acknowledged the current Hub public key and route admission may use its matching private key.
- **rotating**: a next keypair exists and an overlap window is in progress. Both acknowledged public keys may verify traffic during the overlap.
- **revoked**: terminal at the Hub for that key. Node deletion immediately prevents the Hub from using the identity or routing to the node. The node disables local route acceptance when it observes its node credential has been revoked; v0.4 does not pretend it can synchronously mutate an offline node.

Default rotation overlap is 14 days, operator-configurable 1–30 days. The overlap clock begins only after the node has durably acknowledged the next public key; an offline node therefore does not create a half-completed timed rotation. Suspected compromise uses immediate revocation, not the graceful rotation path. Rotation is per node; there is no fleet-wide re-key.

## v0.4 activation profile (proposed)

v0.4 fixes public-key handover to **Node-pull**. The Hub does not need an authenticated inbound route to an unprovisioned node merely to deliver the public key that will later authenticate Hub→Node routing.

The existing authenticated Node→Hub heartbeat channel carries only the small synchronization facts needed for this lifecycle:

- a heartbeat response may include the Hub route public keys the node should trust for its own `nodeId`: `keyId`, public key, lifecycle state, and overlap end when relevant;
- the node validates and persists the returned public-key set **before** acknowledging it;
- a later heartbeat request reports the Hub route key IDs currently persisted by the node;
- the Hub moves `provisioned → active` only after it observes acknowledgment of the current key;
- during rotation, the Hub returns current + next public keys and does not use the next private key for new route proofs until the node has acknowledged it;
- acknowledgment starts the configured overlap; the old key remains accepted through that overlap and is then revoked;
- node deletion/revocation removes route eligibility and Hub signing authority immediately at the Hub even if the node is offline;
- when a node heartbeat receives the existing `401 revoked` result, the Node enters its persisted REVOKED state and disables its route ingress from accepting Hub route proofs until explicit reenrollment restores the node.

This heartbeat extension is deliberately **not a general Hub command queue**. It synchronizes public identity material and acknowledgments only. v0.5 reverse connection and later fleet commands must define their own explicit transport rather than smuggling execution through heartbeat responses.

## Crash-safety

- A node must never acknowledge a Hub route key that is not durably stored.
- A lost heartbeat response is harmless: the Hub can return the same public key material again.
- A Hub restart must retain the same active private key identity from durable state.
- A node restart must retain its accepted Hub public-key set, but a persisted REVOKED node state keeps route ingress disabled.
- No private Hub key ever crosses the wire.

## Rules

- No two nodes share a Hub identity.
- No Hub-wide master route identity exists.
- Rotation/revocation are independent per node.
- All lifecycle transitions are audited; operator-initiated transitions retain operator attribution.
- Node side stores public material only.
- DSH never receives or interprets the Hub private key or Orbit route proof.

## Acceptance

- A node rejects a proof from another node's Hub identity.
- `provisioned` identity is not used for routing before durable node acknowledgment.
- Hub restart retains its active identity.
- Node restart retains trusted public material.
- Rotation overlap accepts current + next only as specified; old fails after overlap.
- Node deletion prevents new Hub routing immediately; when the Node observes `401 revoked`, its route ingress rejects the previously accepted Hub key as well.
- Lost/repeated heartbeat synchronization is idempotent and cannot create a third accidental key.
- The heartbeat extension contains no arbitrary command/execution payload.

## Change notes

### rev. 3 → rev. 4

- Fixed v0.4 public-key handover to Node-pull over the existing authenticated heartbeat channel.
- Added durable-before-ack activation and rotation synchronization.
- Split service identity from protocol signing labels: RFC-0010 uses streaming-compatible `ORBIT-ROUTE-V1` rather than forcing RFC-0006 body-hash semantics onto browser traffic.
- Explicitly prohibited turning heartbeat key synchronization into a general Hub command channel.

### rev. 2 → rev. 3

- Removed the earlier idea that v0.3 would provision Hub→Node identity material.
- Fixed v0.3 to generate nothing Hub-side; issuance and activation begin only with v0.4.
