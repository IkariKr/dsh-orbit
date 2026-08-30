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