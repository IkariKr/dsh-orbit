# DSH Orbit v0.3 configuration reference

This reference consolidates the configuration already defined by the v0.3
Registry MVP and the deployment examples. It does not add configuration or
change any RFC contract. See [`docs/sop/v0.3-operator-sop.md`](sop/v0.3-operator-sop.md)
for procedures and [`docs/registry-mvp.md`](registry-mvp.md) for the authoritative
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
| `DSH_ORBIT_HUB_ROTATION_OVERLAP_H` | no | `24` | Credential overlap in hours, bounded by the frozen Registry contract. |

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
public repository. Never place private keys, plaintext tokens, CSRF values,
proxy secrets, or storage credentials in release evidence. The generic DSH
snapshot contract in [`docs/snapshot-rollback.md`](snapshot-rollback.md) is
separate from Registry SQLite backup/restore; use the dedicated Registry
runbook for Registry files.
