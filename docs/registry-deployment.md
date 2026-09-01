# Registry deployment and operations (v0.3, SOP Stage 6)

This stage connects Hub, Node, Gateway and DSH for real. The
automated multi-node E2E (`test/registry-multinode-e2e.test.mjs`)
exercises the lifecycle on loopback; the mounted drill uses Docker
containers, persistent SQLite, real Caddy, real DSH startup, and private
machine ingress. This document describes the mounted deployment shape and
its restart/failure drills.

## Topology

```text
Operator browser --HTTPS :8443--> Caddy
                                      │ shared Hub network namespace
                                      ├── browser paths -> Hub 127.0.0.1:5445
                                      └── /api/v1/* -> 403 (not proxied)

DSH Node A --bridge--> registry-hub:5446 machine-ingress
DSH Node B --bridge--> registry-hub:5446 machine-ingress
                                      │ same Hub network namespace
                                      └──> Hub 127.0.0.1:5445
```

- The Hub listens on loopback only; any non-loopback bind refuses startup
  (fail closed, P2-05 closure).
- The Hub publishes `127.0.0.1:5445` for the private host-side backend and
  `127.0.0.1:8443` for the mounted drill gateway. It does not publish the
  machine-ingress port.
- Caddy shares the Hub container's network namespace. It terminates TLS,
  authenticates the operator, and injects the assertion
  (`X-DSH-Authenticated-Proxy`) and opaque operator principal
  (`X-DSH-Operator-Id`) only after authentication. Client-supplied values are
  replaced by the gateway; browser Cookie / Origin / Sec-Fetch-Site headers
  pass through for RFC-0007 checks.
- The gateway refuses `/api/v1/*` with 403. Node traffic does not cross the
  browser gateway or a public edge.
- The `machine-ingress` sidecar listens privately on port 5446 in the shared
  Hub namespace and forwards only to `127.0.0.1:5445`. It accepts only the
  fixed `/api/v1/enroll`, `/api/v1/heartbeat`, `/api/v1/report-upload`,
  `/api/v1/credential-rotate`, and `/api/v1/reenroll` routes, and rejects
  query strings before any upstream request. DSH A and DSH B use independent
  bridge namespaces and resolve `registry-hub` on the compose network.
- Enrollment tokens and Ed25519 signatures therefore stay on the private
  machine path and never cross the public TLS browser surface.
- Example artifacts: `docker-registry/compose.example.yaml`,
  `docker-registry/Caddyfile.example`. The mounted drill artifacts are
  `docker-registry/drill.compose.yaml` and `docker-registry/drill.Caddyfile`.

## Startup and shutdown

- Hub: `node bin/dsh-orbit-hub.mjs` (env per `docs/registry-mvp.md`).
  Startup runs an immediate maintenance pass, then ticks every 30s.
- Node: `node bin/dsh-orbit-node.mjs run` (env per
  `docs/node-registry-client.md`); the daemon survives Hub outages and
  retries with backoff until the Hub returns.
- Shutdown is graceful on SIGINT/SIGTERM for both processes. The mounted
  drill uses an owned PID sidecar for each detached Node daemon and verifies
  `/proc/<pid>/cmdline` before sending SIGTERM; it does not use `pkill -f`.

## Restart drills

1. **Hub restart**: the registry DB is a persistent SQLite/WAL file; nodes
   do not re-enroll — identities and bindings survive, and the next heartbeat
   resumes; `registryContact` returns to `fresh`.
2. **Node restart**: same state file, same nodeId/keyId, no re-enrollment
   (verified by the child-process E2E and the intended mounted drill step).
3. **Gateway restart**: the Hub stays up; the browser path re-serves after
   the gateway returns (no Hub state involved); a node that was mid-request
   simply retries with backoff.
4. **Network failure**: a disconnected node ages `stale` after three missed
   beats, then `lost` after 24 hours without contact and raises the
   `contact-lost` alert; other nodes are untouched; reconnect restores
   `fresh` automatically.

## Multi-node isolation contract

The required Stage 6 scenario asserts:

- Node A and Node B both enroll, heartbeat `fresh`, upload reports, and derive
  Hub-authoritative capabilities.
- Gateway restart does not change Hub or Node health state.
- A disconnects and progresses through `stale` to the real 24-hour `lost`
  threshold while B stays `fresh` with capabilities intact and without A's
  alert state.
- A reconnects to `fresh` and clears its contact alert; B remains untouched.
- Delete A revokes its keys and keeps the tombstone; A's machine request is
  denied and its local state becomes `revoked`.
- Explicit tombstone-bound reenrollment restores the same nodeId with a new
  key; B remains healthy throughout.

Loopback and in-process gateway tests cover this contract in
`registry-multinode-e2e.test.mjs` and `registry-gateway-e2e.test.mjs`. The
mounted deployment attestation is separate and may not substitute those tests
for real container/browser evidence.

## Gate B status

The current mounted execution is **incomplete and remains at Review Gate B
HOLD**. It proved real Caddy validation, the TLS mount, gateway 401/403
admission behavior, persistent Hub/SQLite startup, real DSH A/B health,
private enrollment, report upload, Hub-derived capabilities,
`lastHeartbeatAt`, gateway restart recovery, and a clean PID-managed A stop.
After the stop, the driver timed out while polling for A `stale`; a direct
post-run inspection observed A `stale` and B still `fresh`, but this is not a
complete Stage 6 result. The run did not reach the required real 24-hour
`lost`, reconnect, delete/denial, reenrollment, or final B-isolation checks.

The browser backend also rejected the mounted drill's explicit self-signed
certificate with `ERR_CERT_AUTHORITY_INVALID` before rendering the UI. Curl
or Node HTTPS requests with certificate verification disabled are not browser
walkthrough evidence. Gate B must not be closed until a browser-trusted
certificate path and a complete mounted lifecycle are both proven without
weakening the frozen TLS or health semantics.

## Known follow-ups (Stage 7 scope, not authorized)

- backup/restore drill, DB migration drills, corruption handling, and
  retention drills (Stage 7);
- final release/attestation after Gate B passes (Stage 8).

Stage 7 is not started by this document or by the current mounted run.
