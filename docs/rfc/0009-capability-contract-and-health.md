# RFC 0009: Capability contract v1 and health semantics (decided, rev. 2)

Status: Accepted (2026-08-30), rev. 2 after architecture review P1 closure.

## Capability contract v1

A capability is `{ name, version: 1 }` derived **deterministically by the Hub from the node's latest uploaded compatibility report** (single source of truth; there is no node-side capability advertisement endpoint and no capability truth carried in heartbeats). Evidence rules:

- Every capability name maps to report checks that must all be `pass` in the latest report.
- `terminal.pty` and `agents.run` are **not advertisable in v0.3** (no automated PTY/streaming runtime evidence exists; the fence result is authorization evidence only).
- A report older than the node's current revision makes the capabilities `stale` (withheld until refreshed).
- No third-party plugin name, version, or path in capability names, evidence mapping, or tests (ADR-0001).

| Capability | Report evidence required |
| --- | --- |
| `sessions.resume` | `sessionResume` |
| `settings.remote` | `settingsRead` + `settingsNoopWrite` + `authorizationSmoke` |
| `web.routes` | `runtimeReadiness` + `webPluginRoutes` |
| `terminal.pty` | **not advertisable in v0.3** |
| `agents.run` | **not advertisable in v0.3** |

## Health semantics

Per-node composite record. **`reachable` is never modified by Node→Hub heartbeats**: with no Hub→node active probe in v0.3, `reachable` remains `unknown` (real transport reachability belongs to the later endpoint work). Heartbeats maintain a separate dimension:

| Dimension | Values |
| --- | --- |
| `registryContact` | `fresh` / `stale` / `lost` / `unknown` — driven only by Node→Hub heartbeats (see cadence) |
| `authenticated` | `ok` / `revoked` / `expired` / `unknown` — key verification state |
| `dshHealthy` | `ok` / `degraded` / `unknown` — from the latest report data |
| `orbitCompatible` | `pass` / `fail` / `stale` / `unknown` — from the latest report |
| `capabilities` | active set; `stale` marker when evidence is stale |
| `lastSeen` | ISO timestamp + source (heartbeat / report upload) |
| `reachable` | `unknown` in v0.3 (no active probe); later milestone: `ok` / `unreachable` / `unknown` |

- `unknown` is explicit and default; never "compatible by default".
- A failed dimension never hides others; partial health recorded.
- Transitions are events.

## Heartbeat cadence and event history (fixed)

- **Cadence**: default 60s, operator-configurable 30–300s per node/policy.
- **registryContact thresholds**: 3 consecutive missed beats → `stale`; 24h without contact → `lost` + operator alert flag. These only move `registryContact`, never `reachable`.
- **Event history**: every transition and every report upload is an event `{ at, nodeId, dimension, from, to, source }`; retention 90 days, daily rollups after 7 days.

## Deletion and history retention (fixed)

- Operator delete: keys revoked immediately; the record becomes a tombstone (nodeId, deletedAt, reason).
- Compatibility reports, health events, and audit records are **kept** for their defined retention (90 days; audit 365 days) — no undefined cascade delete.
- Re-registration semantics per RFC-0005 D5.