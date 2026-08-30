# RFC 0002: Node capability advertisement (decided; synced 2026-08-30)

Status: Accepted (2026-08-29) for the v0.3 architecture. **Synced 2026-08-30 to the final 0005–0009 decisions**: this RFC establishes the capability namespaces and the evidence-first rule; advertisement mechanics are superseded by RFC-0009 (Hub-side derivation, no advertisement transport).
Target milestone: 0.3 (node identity and registry)
Depends on: 0001-node-identity; v0.2.0 compatibility evidence

## Context

The Hub UI must decide what it can do with each node. Keying UI branches to DSH version numbers breaks the moment two nodes run different DSH builds with different plugin sets, and it duplicates the compatibility knowledge that v0.2 already records as evidence. DSH versions describe the runtime; features actually available depend on plugins, native bindings (the `node-pty` history is the concrete example), and Orbit version.

## Proposal

Nodes advertise **capabilities**: named, versioned feature assertions, not version numbers.

Namespaces (initial, non-exhaustive):

```text
sessions.resume      resumable persistent sessions with model re-selection
settings.remote      privileged settings read/write through the authenticated proxy path
terminal.pty         PTY-backed terminal sessions (subject to the node's terminal authorization rules)
agents.run           agent execution with streaming output
```

Rules:

- A capability entry is `{ name, version, evidence }`. `version` is the capability contract version, not the DSH version.
- **Unknown capabilities are ignored, never fatal**: a Hub that does not know a capability renders nothing for it; a Hub that knows it but the node does not advertise disables the corresponding UI.
- A capability assertion without supporting evidence must not be advertised. Evidence means: the check named by the capability has a recorded `pass` in the node's latest v0.2 compatibility report (for `terminal.pty`, an automated check once one exists; until then the capability cannot be claimed by an automated run).
- **Advertisement is Hub-side derivation, not node announcement (final)**: capabilities are recomputed at the Hub from the latest uploaded compatibility report; there is no advertisement payload in registration or heartbeat, and no `update-capabilities` endpoint (RFC-0009). A capability that loses its evidence disappears without deleting the node.
- No implicit broadcast: capability queries are per-node; "run on all nodes with capability X" is an explicit Hub-side selection that must be confirmed (target scope, see 0004 and the roadmap constraint).

## Implementation prerequisites

Evidence-first is a hard rule for implementation: capabilities such as `terminal.pty` and `agents.run` must never be advertised without a corresponding passing runtime check in the node's compatibility evidence. Until automated checks exist for a capability, that capability cannot be claimed by an automated run.

## Upgrade-guard integration

Capabilities consume v0.2 compatibility reports directly: the report's named checks map onto capability namespaces (`settingsRead`/`settingsNoopWrite`/`authorizationSmoke` → `settings.remote`, `sessionResume` → `sessions.resume`, `webPluginRoutes`/`runtimeReadiness` → baseline web capability). A node upgrade produces a fresh report; capabilities are recomputed from it. The Hub therefore has exactly one compatibility model — the report — instead of a parallel version-to-feature table.

## Resolved questions (synced 2026-08-30)

- **Exact capability contract versions and stability promises** — CLOSED: capability contract v1 (`{ name, version: 1 }`) with the evidence table fixed in RFC-0009.
- **Capability advertisement transport** — CLOSED: no advertisement transport exists; capabilities are derived Hub-side from the latest uploaded compatibility report (RFC-0009). The pre-0.4 "registration payload vs. heartbeat" question is moot.
- **Partially-passing evidence granularity** — CLOSED: evidence mapping is all-required-checks-pass per capability name (RFC-0009); a failing check withholds the capability (no granular partial claims in v0.3).
- **Localization of capability names in the Hub UI** — CLOSED: out of v0.3 scope; capability names are stable ASCII identifiers, UI labels are a display concern.

## Remaining open questions

None for v0.3. Capability granularity refinement and any additional namespaces belong to later milestones.
