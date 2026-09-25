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

v0.4 remains limited to **server-reachable** registered nodes. The accepted construction contract is [RFC-0010](rfc/0010-node-endpoint-and-routing.md), [RFC-0011](rfc/0011-browser-node-selection.md), and the [multistage SOP](sop/v0.4-endpoint-selector-multistage-sop.md). The `v0.4.0-rc.2` release-closing evidence closure (`9891ab858a9c953a211978580910efcc2158bcd7`, evidence phase E8.7) passed independent Final Review on 2026-09-19: v0.4 Stage 8 is CLOSED and v0.4 engineering acceptance is PASS (see `docs/release-attestations/v0.4-stage8-final-review-2026-09-19.md`). Tag/release, production promotion, and DNS cutover each remain separately authorized.

- one familiar selector entry point for multiple registered DSH nodes;
- explicit node selection by navigation to a deterministic per-node route authority under the Orbit wildcard route domain;
- one operator-approved route target per node, with Hub-derived reachability;
- transparent HTTP and WebSocket routing to the selected node without DSH path-prefix rewriting;
- node status, compatibility, and capability display;
- fail-closed target preservation: a failed node route never automatically falls back to another node.

DSH-specific authentication remains behind the node-local compatibility seam. The Hub selector/router must not freeze DSH cookie names, launch-token details, private RPC inventory, or frontend implementation.

## 0.5: reverse-connected nodes

Construction is authorized by `V05-CONSTRUCTION-20260919-A1`
(`docs/release-attestations/v0.5-construction-authorization-2026-09-19.md`),
built on the accepted v0.4 closure `9891ab858a9c953a211978580910efcc2158bcd7`.
The construction design package is [RFC-0012](rfc/0012-reverse-connected-nodes.md)
and the [v0.5 multistage SOP](sop/v0.5-reverse-connected-nodes-multistage-sop.md).
v0.5 engineering acceptance is CLOSED (Final Review PASS, 48/48 D14 reverse-acceptance matrix PASS, release closure `bfcc541d84f3fc5fb3bb14fa54100276e41816ba`, release tag `v0.5.0-rc.1`, see `docs/release-attestations/v0.5-stage8-final-review-2026-09-24.md`). Tag/release, production promotion, and DNS cutover each remain separately authorized.

- outbound node-to-hub connection for devices behind NAT or restrictive networks (the only place reverse connection is designed);
- pairing and device authorization (distinct from 0.3 enrollment: 0.3 enrolls server-reachable nodes, 0.5 pairs NAT-restricted devices);
- reconnect and presence handling without requiring a public endpoint per device.

Frozen scope for 0.5 construction:

- **MUST**: an RFC-first reverse-connection design record (outbound channel, pairing, device authorization) before product construction; the three bullets above; candidate-freeze compliance with fresh candidate-bound evidence; operator SOP and reference documentation.
- **SHOULD**: minimal presence/status surfacing in the existing selector UI so reverse-paired nodes are first-class in current views; heartbeat/presence integration with the existing contact-aging model; deployment and troubleshooting documentation for NAT-restricted deployments.
- **OUT OF SCOPE**: a new route authority system beyond RFC-0010; a new selector system beyond RFC-0011; a new DSH compatibility profile without a designed RFC and compliance with the DSH baseline promotion policy; unrelated UI refactor; unrelated runtime refactor; multi-node sessions and fleet workflows (0.6 / 0.7); tag/release, production promotion, and DNS cutover without separate authorization.

## 0.6: multi-node sessions

Construction is authorized by `V06-CONSTRUCTION-20260925-A1`
(`docs/release-attestations/v0.6-construction-authorization-2026-09-25.md`),
built on the accepted v0.5 closure `bfcc541d84f3fc5fb3bb14fa54100276e41816ba`.
The construction design package is [RFC-0013](rfc/0013-multi-node-sessions-and-target-scope.md)
and the [v0.6 multistage SOP](sop/v0.6-multi-node-sessions-multistage-sop.md).
v0.6 engineering acceptance is CLOSED (Final Review PASS, 24/24 M24 multi-node acceptance matrix PASS, release closure `6ef5c5118ddd69f580afd6c7e9d911de068d2f2a`, release tag `v0.6.0-rc.1`, see `docs/release-attestations/v0.6-stage6-final-review-2026-09-26.md`). Production promotion and DNS cutover each remain separately authorized.

- concurrent connections to multiple selected nodes;
- clear target scope in the UI;
- per-node session isolation;
- no implicit broadcast execution.

Frozen scope for 0.6 construction:

- **MUST**: an RFC-first design record for multi-node sessions and target scoping (RFC-0013) before product construction; concurrent connections to multiple selected nodes across direct and reverse transports; clear and unambiguous target scope in the UI; strict per-node session and cookie isolation; strict prohibition against implicit broadcast execution or silent failover; candidate-freeze compliance with fresh candidate-bound evidence; operator SOP and reference documentation.
- **SHOULD**: first-class Devices and Nodes view in the authenticated operator surface per UX reference recommendations (`docs/ux/dsh-remote-mobile.md`); per-node session visibility and connection state tracking; graceful handling of concurrent node disconnects or reachability degradation.
- **OUT OF SCOPE**: fleet workflows and scheduled multi-node command execution (roadmap 0.7); a new route authority system beyond RFC-0010; a new selector system beyond RFC-0011; a new DSH compatibility profile without a designed RFC and compliance with the DSH baseline promotion policy; unrelated UI refactor; unrelated runtime refactor; tag or release creation/mutation without separate authorization; production promotion; DNS cutover.

## 0.7: fleet workflows

Construction is authorized by `V07-CONSTRUCTION-20260926-A1`
(`docs/release-attestations/v0.7-construction-authorization-2026-09-26.md`),
built on the accepted v0.6 closure `6ef5c5118ddd69f580afd6c7e9d911de068d2f2a`.
The construction design package is RFC-0014
and the v0.7 multistage SOP.
RFC-0014 must receive Stage 0 / Gate A Architecture Review GO before v0.7 product runtime construction begins.

- explicit tasks targeting selected nodes;
- capability-aware scheduling;
- aggregated results;
- auditability of target selection and execution scope.

Frozen scope for 0.7 construction:

- **MUST**: an RFC-first design record for fleet workflows and capability-aware scheduling (RFC-0014) before product construction; explicit tasks targeting selected registered nodes with strict target selection validation; capability-aware scheduling matching required capabilities against registered node capabilities; aggregated execution results, status summaries, and per-node result collection without silent drop; auditability of target selection, execution scope, operator identity, and job timeline; candidate-freeze rule compliance and fresh candidate-bound evidence for the v0.7 release candidate; operator documentation (SOP) and architecture/API reference updates for fleet workflows.
- **SHOULD**: first-class Fleet Workflows panel in the authenticated operator surface; real-time execution progress tracking across target nodes without full-page reloads; graceful handling of target node disconnection or outage during job execution.
- **OUT OF SCOPE**: a new route authority system beyond RFC-0010; a new selector system beyond RFC-0011; a new DSH compatibility profile without a designed RFC and compliance with the DSH baseline promotion policy; unrelated UI refactor; unrelated runtime refactor; tag or release creation/mutation without separate authorization; production promotion; DNS cutover.

## Design constraints

The Hub should remain a control plane. DSH remains the execution runtime on each node.

Fleet features should prefer Hub-derived capabilities over version-specific UI branches. Operations that can execute commands or mutate settings across multiple nodes must require an explicit target scope.
