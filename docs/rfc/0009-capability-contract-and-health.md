# RFC 0009: Capability contract v1 and health semantics (decided)

Status: Accepted (2026-08-30). Terminal capability advertisement rules; heartbeat cadence and health/event semantics fixed.

## Capability contract v1

A capability is `{ name, version: 1, evidence }` where `evidence` names a compatibility-report check that must be `pass` in the node's latest report. Unknown capabilities are ignored, never fatal. **A capability is advertised only when its evidence exists; no evidence → the capability is absent (claiming it would be a bug).**

| Capability | Evidence (all must be `pass` in the latest report) | Notes |
| --- | --- | --- |
| `sessions.resume` | `sessionResume` | — |
| `settings.remote` | `settingsRead` + `settingsNoopWrite` + `authorizationSmoke` | — |
| `web.routes` | `runtimeReadiness` + `webPluginRoutes` | — |
| `terminal.pty` | **not advertisable in v0.3** | No automated PTY runtime evidence exists (`terminalPtty` is `not_run`; the fence result `terminalFence` is authorization evidence only and must not be treated as PTY runtime evidence). Advertisable only when an automated PTY runtime check with passing evidence exists. |
| `agents.run` | **not advertisable in v0.3** | No automated streaming runtime evidence exists (`longLivedTransport` is `not_run`). Advertisable only when such an automated check passes. |

Evidence rules:

- The evidence must come from the node's latest uploaded compatibility report; reports older than the node's current revision make the capabilities `stale` (withheld from the active set until refreshed).
- No third-party plugin name, version, or path may appear in capability names, evidence mapping, or tests (ADR-0001).

## Health semantics

Per-node composite health record (RFC-0004 dimensions), fixed value domains:

| Dimension | Values |
| --- | --- |
| `reachable` | `ok` / `unreachable` / `unknown` (transport) |
| `authenticated` | `ok` / `revoked` / `expired` / `unknown` |
| `dshHealthy` | `ok` / `degraded` / `unknown` |
| `orbitCompatible` | `pass` / `fail` / `stale` / `unknown` |
| `capabilities` | active set; `stale` marker when evidence is stale |
| `lastSeen` | ISO timestamp + source |

- `unknown` is explicit and default; never "compatible by default".
- `stale` for `orbitCompatible` when the latest report predates the node's current revision (or the report is older than the staleness window below).
- A failed dimension never hides the others; partial health is recorded.
- Health transitions are events (state history), not just the latest state.

## Event history and heartbeat cadence

- **Heartbeat cadence (fixed)**: default 60s, operator-configurable 30–300s per node/policy.
- **Missed-heartbeat thresholds**: 3 consecutive missed beats → `reachable: unreachable`; 24h without contact → `reachable: unknown` + operator alert flag.
- **Event history**: every state transition and every compatibility-report upload is an event `{ at, nodeId, dimension, from, to, source }`; retention 90 days, daily rollups after 7 days (rollup keeps first/last per dimension per day + counts).
- **Capability/settings change events**: capability set changes and credential rotations are events too (audit).

## v0.3 scope note (from the roadmap)

Endpoint routing, reverse connection, multi-node sessions, and fleet execution remain later milestones; the Hub in v0.3 stores and serves this evidence for operator management (RFC-0007) and the future routing UI.