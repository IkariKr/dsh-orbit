# RFC 0004: Node health model

Status: Accepted (2026-08-29) for the v0.3 architecture
Target milestone: 0.3 (node identity and registry)
Depends on: 0001-node-identity, 0002-node-capabilities, 0003-node-authentication; v0.2.0 compatibility evidence

## Context

`online: true/false` cannot answer the questions a fleet operator actually has. A node can be reachable but unauthorized (expired credential), authenticated but running an unsupported DSH build, or fully healthy but missing a capability the operator wants. v0.2 production experience shows each of these states occurring independently: a healthy DSH container behind a broken gateway, a reachable node with a drifted source layout, a candidate that builds but fails authorization.

## Proposal

Node health is a composite record, reported per node and timestamped:

| Dimension | Values | Source |
| --- | --- | --- |
| `reachable` | boolean + latency observation | Hub transport observation |
| `authenticated` | boolean + reason when false | registry credential validation (0003) |
| `dshHealthy` | boolean | node-reported DSH web readiness and long-lived traffic state |
| `orbitCompatible` | `pass` / `fail` / `stale` / `unknown` | latest v0.2 compatibility report for the node; `stale` when the report predates the current node-reported revision |
| `capabilities` | the advertised set (0002) with per-capability evidence status | node advertisement |
| `lastSeen` | timestamp + source (heartbeat, registration, Hub probe) | registry |

Rules:

- No single boolean summarizes health. UI surfaces show the dimensions; aggregate badges, if any, must be derived deterministically from them and documented as such.
- `unknown` is an explicit state: a node that never uploaded a compatibility report is not "compatible by default".
- A failed dimension never blocks the others from being reported; the registry records partial health.
- Health transitions are events, not just state, so the Hub can surface "orbitCompatible degraded from pass to fail" as a reviewable history.
- Commands and setting mutations always require an explicit node target scope regardless of health; healthy nodes are not implicitly grouped into any operation.

## Upgrade-guard integration

`orbitCompatible` is the v0.2 compatibility report, attached to the stable node ID (0001), surfaced through capabilities (0002), and uploaded over the authenticated registry session (0003). The watcher's classification (supported/unknown) feeds the same field: a node reporting a DSH version classified `unknown` by the upstream watcher shows `orbitCompatible: unknown` with the watcher artifact reference, prompting the documented manual review path rather than a silent pass.

## Unresolved questions

- Observation cadence and who initiates (Hub probe vs. node heartbeat) for NAT-restricted nodes ahead of the 0.5 reverse-connection work.
- Retention and aggregation of health event history.
- Whether `dshHealthy` should subsume automated long-lived-transport checks once they exist (v0.2 marks them `not_run` today).
- Alerting policy: which dimension transitions justify notifications.
