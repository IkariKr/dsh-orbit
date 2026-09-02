# Registry MVP (v0.3)

Implementation of the frozen v0.3 registry architecture: `docs/rfc/0005`
(node enrollment and registry persistence), `docs/rfc/0006` (registry
machine API), `docs/rfc/0007` (browser management API), `docs/rfc/0009`
(capability contract and health). Scope is fixed to the MVP:
**no** endpoint routing, reverse connection, multi-node sessions, fleet
execution, or third-party plugin coupling (ADR-0001).

## Layout

- `src/registry/protocol.mjs` — wire formats, fixed limits, signing-string builder.
- `src/registry/crypto.mjs` — Ed25519 + SHA-256 primitives (raw 32-byte/64-byte keys, lowercase hex; keyId = first 16 bytes of SHA-256(public key)).
- `src/registry/sqlite.mjs` — SQLite/WAL store (RFC-0005 D7 table set: `nodes`, `node_keys`, `enrollment_tokens`, `enrollment_results`, `seen_nonces`, `reports`, `events`, `audit`, `browser_sessions`), `BEGIN IMMEDIATE` transactions.
- `src/registry/capabilities.mjs` — capability contract v1 and `dshHealthy` deterministic mappings.
- `src/registry/registry.mjs` — domain service: enrollment, re-enrollment (`ORBIT-REENROLL-V1` possession proof), heartbeat, report upload, rotation, deletion, sessions, maintenance.
- `src/registry/server.mjs` — HTTP transport: machine routes, browser routes, query-string ban, body limits, rate limits, gateway admission, principal, CSRF/origin.
- `bin/dsh-orbit-hub.mjs` — hub entrypoint.

## Running the hub

```sh
export DSH_ORBIT_HUB_DB=/data/orbit/registry.db
export DSH_ORBIT_HUB_GATEWAY_SECRET=<per-deployment secret injected by the gateway>
export DSH_ORBIT_HUB_OPERATOR_PRINCIPAL=operator
node bin/dsh-orbit-hub.mjs
```

The gateway-held assertion secret follows the v0.2 `X-DSH-Authenticated-Proxy`
pattern: the gateway injects it after its own authentication, browsers never
see it, and a client-supplied assertion is denied. Alternatively set
`DSH_ORBIT_HUB_LAN_BOUNDARY_ONLY=1` for a strict gateway-only loopback
listener. The operator principal is either the single declared principal or a
gateway-injected opaque `X-DSH-Operator-Id`; client-supplied principal-shaped
headers are stripped at admission.

Other environment:

- `DSH_ORBIT_HUB_TRUSTED_SCHEME` (`http` default, `https`) — the trusted
  external scheme used by the browser Origin check (scheme AND host must
  match). `X-Forwarded-Proto` is never trusted.
- Non-loopback listens are **refused unconditionally**: the machine surface
  (enrollment tokens, Ed25519 signatures) must never ride a public plain-HTTP
  bind; TLS terminates at the deployment gateway and the hub stays on the
  private backend (round-2 P2).

## Registry semantics

- **Contact authority**: `registryContact` is strictly heartbeat-driven. The
  heartbeat updates a dedicated `lastHeartbeatAt`; a report upload updates
  only the generic `lastSeen` — it never moves `registryContact` and never
  clears the `contact-lost` alert flag. Aging: `fresh` → `stale` after 3
  consecutive missed beats → `lost` after 24h (with the alert flag until the
  next heartbeat).
- **Maintenance cadence**: the hub runs `maintenance()` every 30 seconds and
  once immediately at startup (the default 3×60s stale threshold and the 24h
  lost threshold are only reachable at that cadence).
- **Deterministic ordering**: the latest report resolves by
  `(uploaded_at DESC, id DESC)` so same-millisecond uploads never depend on
  clock ambiguity.
- **Report retention**: reports live 90 days. When the last report of a node
  is purged, its derived state returns to explicit unknown (compatibility,
  `dshHealthy`) with capabilities cleared. An aged report (7 days) moves ANY
  outcome — pass or fail — to `stale`; the last verdict stays visible in
  `latestReport.compatibility`. Every upload, including identical re-uploads,
  writes a `report` event.
- **Event rollups** are strictly idempotent: summary rows are excluded from
  further rollups and inserted only when absent; each summary's final value is
  the last event of that day/dimension by `(at DESC, id DESC)`, never a
  string-max of values.
- **Schema v2→v3 migration**: heartbeat-sourced `last_seen` backfills
  `last_heartbeat_at` (so startup maintenance ages old nodes correctly);
  every other old contact claim fails closed to `registryContact = unknown`.
- **Session expiry** is audited exactly once per session (absolute TTL or
  idle expiry), in the same maintenance transaction.
- **Runtime identity authority**: heartbeats own `nodes` current runtime
  identity; a report never overwrites it. A report whose identity tuple
  differs from the current heartbeat identity is stored as history and the
  node's compatibility is withheld (`orbitCompatible: stale`, active
  capabilities `[]`) until a matching report arrives. The first report after
  enrollment may initialize the runtime identity before any heartbeat.
- **Capability withholding**: `health.capabilities` is the ACTIVE set and is
  empty whenever evidence is stale; the stored derived set is exposed
  separately as `health.capabilityEvidence`.
- **Destructive delete confirmation**: `hub.nodes.delete` requires
  `{ requestId, reason }` (requestId = 32 lowercase hex, globally unique).
  Exact replays return the same result; reusing a requestId for different
  content/target is denied.
- **Token TTL bounds**: `ttlSeconds` must be an integer 60–3600 (default
  600); anything else fails closed.
- **Token list**: `hub.tokens.list` is token history; every entry carries an
  explicit `status` (`active` / `expired` / `consumed`) and never exposes a
  digest or plaintext.

## Release runbooks

- [Configuration reference](configuration-reference.md)
- [Operator SOP](sop/v0.3-operator-sop.md)
- [Node enrollment SOP](sop/v0.3-node-enrollment-sop.md)
- [Registry backup/restore SOP](sop/v0.3-registry-backup-restore-sop.md)
- [Troubleshooting](troubleshooting.md)

## Verification

- `npm run check` runs the full suite including the registry acceptance
  matrices (positive control plus every denial case: replay, timestamp skew,
  revoked/unknown keys, purpose mismatch, possession-proof failures, CSRF,
  origin, cross-site, forged assertion, query strings, body limits, rate
  limits).
- Requires Node `>= 22.5` with `node:sqlite` (`node:sqlite` is built in;
  no native dependencies).

## Design-deviation policy

The v0.3 RFCs are frozen. If implementation discovers a requirement that
cannot be met, the deviation is proposed explicitly as a design deviation —
never silently changed in code.