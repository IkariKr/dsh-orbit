# DSH Orbit configuration reference

This reference consolidates the accepted v0.3 Registry configuration and the
v0.4 construction-stage additions that have already passed their architecture
contract. v0.4 settings remain subject to the multistage construction gates in
[`docs/sop/v0.4-endpoint-selector-multistage-sop.md`](sop/v0.4-endpoint-selector-multistage-sop.md).
See [`docs/sop/v0.3-operator-sop.md`](sop/v0.3-operator-sop.md) for the stable
v0.3 procedures and [`docs/registry-mvp.md`](registry-mvp.md) for the v0.3
Registry semantics.

## Hub

| Variable | Required | Default | Meaning and constraints |
| --- | --- | --- | --- |
| `DSH_ORBIT_HUB_DB` | no | `./registry.db` | File-backed Registry SQLite database. Keep it on persistent storage. |
| `DSH_ORBIT_HUB_PORT` | no | `5445` | Hub listener port. |
| `DSH_ORBIT_HUB_LISTEN` | no | `127.0.0.1` | Loopback only. Non-loopback binds fail closed. |
| `DSH_ORBIT_HUB_GATEWAY_SECRET` | one of two | unset | Secret injected by the authenticated gateway; never sent by browsers. |
| `DSH_ORBIT_HUB_LAN_BOUNDARY_ONLY` | one of two | `0` | Set to `1` only for the strict loopback boundary alternative. |
| `DSH_ORBIT_HUB_OPERATOR_PRINCIPAL` | no | unset | Fixed principal. If absent, the gateway must inject `X-DSH-Operator-Id`. |
| `DSH_ORBIT_HUB_TRUSTED_SCHEME` | no | `http` | Trusted browser scheme, `http` or `https`; `X-Forwarded-Proto` is not trusted. |
| `DSH_ORBIT_HUB_ROTATION_OVERLAP_H` | no | `24` | Node credential overlap in hours, bounded by the frozen Registry contract. |
| `DSH_ORBIT_HUB_ROUTE_DOMAIN` | no | `localhost` | v0.4 deterministic route domain used to derive `n-<nodeId-hex>.<domain>`. Stage 2 uses it only as protocol data; Stage 3 publishes the wildcard route. Must match the Node route-domain setting. |
| `DSH_ORBIT_HUB_CA_CERT` | no | unset | Additional operator-managed private-CA PEM or PEM file for HTTPS Node route targets. It extends the runtime default trust set; hostname/SAN validation stays enabled. |
| `DSH_ORBIT_HUB_ROUTE_PROBE_CADENCE_SECONDS` | no | `60` | Positive route-readiness probe cadence in seconds. Invalid/zero values fail startup. |
| `DSH_ORBIT_HUB_ROUTE_ROTATION_OVERLAP_DAYS` | no | `14` | Per-node Hub route-key overlap policy, integer 1–30 days. The timer starts only after the Node durably acknowledges the next public key. |
| `DSH_ORBIT_HUB_WS_GLOBAL_LIMIT` | no | `200` | Global concurrent WebSocket connection limit on the Hub, integer 1–100000. Values outside range fail startup closed. |
| `DSH_ORBIT_HUB_WS_PER_NODE_LIMIT` | no | `50` | Per-node concurrent WebSocket connection limit on the Hub, integer 1–10000 (must not exceed global limit). Values outside range fail startup closed. |
| `DSH_ORBIT_HUB_WS_HANDSHAKE_TIMEOUT_MS` | no | `10000` | WebSocket upstream handshake timeout in milliseconds, integer 100–120000 ms (rejects 0, negative, NaN, Infinity). Established WebSocket connections do not have an idle timeout. |

The Hub owns the machine and browser APIs. `/api/v1/*` is a private machine
surface and must not be routed through the browser gateway. See
[`docs/registry-deployment.md`](registry-deployment.md).

## Node

| Variable | Required | Default | Meaning and constraints |
| --- | --- | --- | --- |
| `DSH_ORBIT_NODE_STATE` | no | `./node-state.json` | Atomic local state file; POSIX mode `0600`. |
| `DSH_ORBIT_HUB_URL` | yes | none | Canonical Hub URL. Once enrolled, it must match the persisted binding. |
| `DSH_ORBIT_ENROLL_TOKEN` | for `enroll` | none | One-time plaintext enrollment token; never persisted. |
| `DSH_ORBIT_REENROLL_TOKEN` | for `reenroll` | none | Tombstone-bound operator token; recovery is explicit, never automatic. |
| `DSH_ORBIT_NODE_HEARTBEAT_SECONDS` | no | `60` | Heartbeat cadence, bounded to 30–300 seconds. |
| `DSH_ORBIT_NODE_ORBIT_VERSION` | no | `0.3.0` | Runtime identity reported to the Hub. |
| `DSH_ORBIT_NODE_ORBIT_REVISION` | no | unset | Orbit revision reported to the Hub. |
| `DSH_ORBIT_NODE_DSH_VERSION` | no | empty | DSH version reported to the Hub. |
| `DSH_ORBIT_NODE_DSH_PROFILE` | no | unset | Compatibility profile reported to the Hub. |
| `DSH_ORBIT_NODE_CA_CERT` | no | unset | Additional private-CA PEM or PEM file for HTTPS `DSH_ORBIT_HUB_URL`. It extends normal runtime trust; redirects and hostname/SAN failures remain denied. |
| `DSH_ORBIT_NODE_ROUTE_INGRESS_DISABLED` | no | `0` | Set to `1` to suppress the Stage 2 route ingress. A routable v0.4 Node normally leaves it enabled. |
| `DSH_ORBIT_NODE_ROUTE_INGRESS_PORT` | no | `0` | Route-ingress listen port. `0` requests an ephemeral port for development/tests; production route targets should use an explicit stable port. |
| `DSH_ORBIT_NODE_ROUTE_INGRESS_LISTEN` | no | `127.0.0.1` | Route-ingress listen address. Non-loopback production exposure must be protected by verified TLS according to RFC-0010. |
| `DSH_ORBIT_NODE_ROUTE_DOMAIN` | no | `localhost` | Route domain used to verify `ORBIT-ROUTE-V1`; must exactly match the Hub route-domain configuration. |
| `DSH_ORBIT_NODE_DSH_TARGET` | no | `http://127.0.0.1:3080` | Node-local DSH transport checked by `GET /_orbit/route-ready`. This is liveness only and does not parse DSH APIs. |
| `DSH_ORBIT_NODE_ROUTE_TLS_KEY` / `DSH_ORBIT_NODE_ROUTE_TLS_CERT` | together | unset | Route-ingress TLS private key and certificate, as PEM values or file paths. Configuring only one fails startup. |
| `DSH_ORBIT_NODE_WS_LIMIT` | no | `50` | Maximum concurrent WebSocket connections permitted on the Node route ingress, integer 1–10000. Out-of-range or non-integer values fail startup closed. |
| `DSH_ORBIT_REPORT_FILE` | for `upload-report` | none | Path to a validated compatibility report. |

Commands and state semantics are documented in
[`docs/node-registry-client.md`](node-registry-client.md) and the enrollment
runbook at [`docs/sop/v0.3-node-enrollment-sop.md`](sop/v0.3-node-enrollment-sop.md).

## Gateway and deployment

| Variable | Required | Default | Meaning and constraints |
| --- | --- | --- | --- |
| `DSH_ORBIT_REGISTRY_TAG` | yes | none | Registry deployment image tag. It must be explicitly bound to an RC or release image tag, such as `v0.3.0-rc.1`; if unset, deployment must fail closed. The Stage 6 construction tag `v0.3.0-s6` is not permitted. |

- Terminate TLS at the authenticated gateway.
- Inject the Hub assertion and operator principal only after authentication.
- Preserve browser `Cookie`, `Origin`, and `Sec-Fetch-Site` headers.
- Do not accept client-supplied assertion or principal headers.
- Keep the Hub loopback-only and keep machine ingress private.
- Keep trusted certificate validation enabled.
- For Stage 3 public node routing (`*.routeDomain`), terminate wildcard TLS at the outer gateway, preserve canonical `Host`, strip outer gateway credentials, and deny `/api/v1/*` machine surface.

The example Registry Compose file is
[`docker-registry/compose.example.yaml`](../docker-registry/compose.example.yaml).
The browser UI contract is [`docs/registry-ui.md`](registry-ui.md).

## Stage 7 drill-only controls

These controls are for isolated evidence only and must not be used to shorten
production health thresholds:

| Variable | Meaning |
| --- | --- |
| `DSH_ORBIT_HUB_DRILL_AGING=1` | Enables controlled contact-aging mode. |
| `DSH_ORBIT_HUB_DRILL_AGING_CLOCK` | Node-to-ISO clock map required with drill mode. |
| `DSH_ORBIT_STAGE7_EVIDENCE` | Optional local path for ignored drill evidence. |
| `DSH_ORBIT_STAGE7_KEEP_ROOT=1` | Retains an isolated local drill root for diagnosis. |

## Data and secrets

Keep database, Node state, backups, certificates, and credentials outside the
public repository. From v0.4 Stage 2 onward the Registry DB/WAL/SHM, backup,
restore staging, and quarantine copies are explicitly **secret-bearing** because
they contain per-node Hub route private keys. Never place private keys,
plaintext tokens, CSRF values, proxy secrets, storage credentials, or digests
derived only from private-key bytes in release evidence. The generic DSH
snapshot contract in [`docs/snapshot-rollback.md`](snapshot-rollback.md) is
separate from Registry SQLite backup/restore; use the dedicated Registry
runbook for Registry files.
