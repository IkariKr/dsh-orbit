# Roadmap

The roadmap is staged so that deployment safety remains independent from later fleet features.

## 0.1: secure remote deployment

- authenticated reverse-proxy access to the DSH configuration plane;
- Docker deployment example;
- Caddy and local Nginx boundary examples;
- explicit compatibility registry;
- build-time and profile-runtime patch verification.

## 0.2: upgrade guard

Shipped in `v0.2.0`:

- candidate build command;
- automated authenticated and negative-auth smoke tests;
- data snapshot hooks;
- compatibility report generation;
- CI checks for newly released DSH versions without automatic production promotion.

## 0.3: node identity, enrollment and registry

Enrollment/bootstrap covers nodes that the Hub can reach directly (server-reachable nodes). It must NOT include reverse connection or NAT traversal — that belongs to 0.5 only.

- stable node identity (Hub-minted, see `docs/rfc/0005-node-enrollment-and-registry.md`);
- one-time enrollment with short-lived single-use tokens and first credential issuance;
- node metadata and health;
- DSH and Orbit version reporting;
- evidence-backed capability derivation (contract v1, `docs/rfc/0009-capability-contract-and-health.md`);
- revocable, rotatable per-node credentials (machine API `docs/rfc/0006-registry-machine-api.md`);
- registry machine API and browser management API with independent acceptance matrices;
- heartbeat and event history.

Explicitly excluded from 0.3: inbound connection acceptance for NAT-restricted devices (reverse connection), device pairing for such devices, endpoint routing to registered nodes, multi-node sessions, and fleet execution — all remain in later milestones.

## 0.4: endpoint selector

v0.4 remains limited to **server-reachable** registered nodes. The proposed construction contract is [RFC-0010](rfc/0010-node-endpoint-and-routing.md), [RFC-0011](rfc/0011-browser-node-selection.md), and the [multistage SOP](sop/v0.4-endpoint-selector-multistage-sop.md). Construction begins only after architecture review accepts them.

- one familiar selector entry point for multiple registered DSH nodes;
- explicit node selection by navigation to a deterministic per-node route authority under the Orbit wildcard route domain;
- one operator-approved route target per node, with Hub-derived reachability;
- transparent HTTP and WebSocket routing to the selected node without DSH path-prefix rewriting;
- node status, compatibility, and capability display;
- fail-closed target preservation: a failed node route never automatically falls back to another node.

DSH-specific authentication remains behind the node-local compatibility seam. The Hub selector/router must not freeze DSH cookie names, launch-token details, private RPC inventory, or frontend implementation.

## 0.5: reverse-connected nodes

- outbound node-to-hub connection for devices behind NAT or restrictive networks (the only place reverse connection is designed);
- pairing and device authorization (distinct from 0.3 enrollment: 0.3 enrolls server-reachable nodes, 0.5 pairs NAT-restricted devices);
- reconnect and presence handling without requiring a public endpoint per device.

## 0.6: multi-node sessions

- concurrent connections to multiple selected nodes;
- clear target scope in the UI;
- per-node session isolation;
- no implicit broadcast execution.

## 0.7: fleet workflows

- explicit tasks targeting selected nodes;
- capability-aware scheduling;
- aggregated results;
- auditability of target selection and execution scope.

## Design constraints

The Hub should remain a control plane. DSH remains the execution runtime on each node.

Fleet features should prefer Hub-derived capabilities over version-specific UI branches. Operations that can execute commands or mutate settings across multiple nodes must require an explicit target scope.
