# RFC 0004: Node health model (decided; synced 2026-08-30)

Status: Accepted (2026-08-29) for the v0.3 architecture. **Synced 2026-08-30 to the final 0005–0009 decisions**: `reachable` stays `unknown` without a probe, `authenticated` drops `expired`, capabilities derive from reports, `orbitCompatible` staleness is driven by heartbeat runtime identity, and `registryContact` is a separate dimension.
Target milestone: 0.3 (node identity and registry)
Depends on: 0001-node-identity, 0002-node-capabilities, 0003-node-authentication; v0.2.0 compatibility evidence

## Context

`online: true/false` cannot answer the questions a fleet operator actually has. A node can be reachable but unauthorized (revoked credential), authenticated but running an unsupported DSH build, or fully healthy but missing a capability the operator wants. v0.2 production experience shows each of these states occurring independently: a healthy DSH container behind a broken gateway, a reachable node with a drifted source layout, a candidate that builds but fails authorization.

## Proposal

Node health is a composite record, reported per node and timestamped. The authoritative dimension set, value domains, and deterministic mappings are fixed in **RFC-0009**; this RFC keeps the model rationale and the operator-facing rules.

| Dimension | Values (v0.3 final) | Source |
| --- | --- | --- |
| `registryContact` | `fresh` / `stale` / `lost` / `unknown` | Node→Hub heartbeats only (cadence in RFC-0009) |
| `reachable` | `unknown` in v0.3 | **no Hub→node probe exists**; never modified by heartbeats; later milestone: `ok` / `unreachable` / `unknown` |
| `authenticated` | `ok` / `revoked` / `unknown` | registry key verification (0003/0006); no `expired` in v0.3 — no key expiry, revocation/rotation only |
| `dshHealthy` | `ok` / `degraded` / `unknown` | deterministic mapping from latest report `runtimeReadiness` + `settingsRead` (RFC-0009) |
| `orbitCompatible` | `pass` / `fail` / `stale` / `unknown` | latest v0.2 compatibility report; `stale` when the report's identity tuple mismatches the heartbeat runtime identity or the report is older than the staleness window (RFC-0009) |
| `capabilities` | the derived set (0002) with per-capability evidence status | **Hub-side derivation from the latest report only** — no node advertisement (RFC-0009) |
| `lastSeen` | timestamp + source (heartbeat, report upload) | registry |

Rules:

- No single boolean summarizes health. UI surfaces show the dimensions; aggregate badges, if any, must be derived deterministically from them and documented as such.
- `unknown` is an explicit state: a node that never uploaded a compatibility report is not "compatible by default".
- A failed dimension never blocks the others from being reported; the registry records partial health.
- Health transitions are events, not just state, so the Hub can surface "orbitCompatible degraded from pass to fail" as a reviewable history.
- Commands and setting mutations always require an explicit node target scope regardless of health; healthy nodes are not implicitly grouped into any operation.

## Upgrade-guard integration

`orbitCompatible` is the v0.2 compatibility report, attached to the stable node ID (0001), surfaced through capabilities (0002), and uploaded over the authenticated registry session (0003). The watcher's classification (supported/unknown) feeds the same field: a node reporting a DSH version classified `unknown` by the upstream watcher shows `orbitCompatible: unknown` with the watcher artifact reference, prompting the documented manual review path rather than a silent pass.

## Resolved questions (synced 2026-08-30)

- **Observation cadence and who initiates** — CLOSED for v0.3: Node→Hub heartbeat, default 60s (30–300s configurable); `registryContact` thresholds 3 missed beats → `stale`, 24h → `lost` + alert flag. Hub→Node probing (and the 0.5 reverse-connection question) is out of v0.3 (RFC-0009).
- **Retention and aggregation of health event history** — CLOSED: events retained 90 days with daily rollups after 7 days (RFC-0009).
- **Whether `dshHealthy` subsumes long-lived-transport checks** — CLOSED: no; the deterministic mapping uses `runtimeReadiness` + `settingsRead` only. Long-lived-transport checks stay `not_run` evidence and do not influence `dshHealthy` in v0.3.
- **Alerting policy** — DEFERRED: out of v0.3 scope; only the `lost` alert flag is defined. Notification policy is a later milestone.

## Remaining open questions

None for v0.3.
