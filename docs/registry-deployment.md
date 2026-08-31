# Registry deployment and operations (v0.3, SOP Stage 6)

This stage connects Hub, Node, Gateway and DSH for real. The
automated multi-node E2E (`test/registry-multinode-e2e.test.mjs`)
exercises the whole lifecycle on loopback; this document covers the
mounted deployment shape and the restart/failure drills.

## Topology

```text
Operator browser ──TLS── Caddy (gateway) ──loopback── Hub :5445
                                                         │
Node A (DSH deploy) ──HUB machine API (private)──────────┤
Node B (DSH deploy) ──HUB machine API (private)──────────┘
```

- The Hub listens on loopback only; any non-loopback bind refuses
  startup (fail closed, P2-05 closure).
- The browser path terminates TLS at the gateway; the gateway
  authenticates the operator and injects the assertion
  (`X-DSH-Authenticated-Proxy`) and the opaque operator principal
  (`X-DSH-Operator-Id`), stripping client-supplied values first.
- The machine path stays on the private listener: enrollment tokens
  and Ed25519 signatures never cross a public plain-HTTP edge.
- Example artifacts: `docker-registry/compose.example.yaml`,
  `docker-registry/Caddyfile.example`.

## Startup and shutdown

- Hub: `node bin/dsh-orbit-hub.mjs` (env per `docs/registry-mvp.md`).
  Startup runs an immediate maintenance pass, then ticks every 30s.
- Node: `node bin/dsh-orbit-node.mjs run` (env per
  `docs/node-registry-client.md`); the daemon survives Hub outages and
  retries with backoff until the Hub returns.
- Shutdown is graceful on SIGINT/SIGTERM for both processes.

## Restart drills

1. **Hub restart**: the registry DB is a persistent SQLite/WAL file;
   nodes re-enroll? No — identities and bindings survive, and the next
   heartbeat resumes; `registryContact` returns to `fresh`.
2. **Node restart**: same state file, same nodeId/keyId, no
   re-enrollment (verified by the child-process E2E and this stage's
   Node B restart recovery step).
3. **Gateway restart**: the hub stays up; the browser path re-serves
   after the gateway returns (no hub state involved); a node that was
   mid-request simply retries with backoff.
4. **Network failure**: a disconnected node ages `stale` (3 missed
   beats) then `lost` (+ `contact-lost` alert); other nodes are
   untouched; reconnect restores `fresh` automatically.

## Multi-node isolation (verified)

`registry-multinode-e2e.test.mjs` asserts on a real loopback
deployment with a persistent DB:

- Node A and Node B both enroll, heartbeat `fresh`, upload reports,
  derive capabilities.
- Hub restart on the same port + DB: both identities survive, both
  recover.
- A disconnects → A `stale` then `lost` while B stays `fresh` with
  capabilities intact and no alert flags; B's event history contains
  only B's own transitions.
- A reconnects → `fresh`, alert cleared, B untouched.
- Delete A → A's machine requests denied; B healthy.
- Reenroll A → same nodeId + new key, active again; exactly two active
  nodes at the end; B healthy throughout.

## Known follow-ups (Stage 7 scope, not implemented here)

- backup/restore drill, DB migration drills, corruption handling,
  retention drills (Stage 7);
- the final release/attestation (Stage 8).
## Gate B closure notes

- The gateway example now runs a REAL authentication gate: nothing is
  injected before the operator authenticates; client-supplied
  assertion/principal headers are stripped first; the browser's own
  Cookie / Origin / Sec-Fetch-Site pass through (the hub's RFC-0007
  checks depend on them); the machine surface (`/api/v1/*`) is refused
  at the gateway with 403 — the docs and the config agree.
- The Hub runs from a pinned image (`docker-registry/Dockerfile`,
  `node:22.14.0-bookworm-slim`, zero deps) and publishes ONLY to the
  host loopback; the gateway runs on the host/`network_mode: host` and
  reaches the hub through that same loopback. The frozen listener
  policy (loopback-only plain-HTTP private backend) is never relaxed.
- `test/registry-gateway-e2e.test.mjs` executes the whole topology with
  a real TLS-terminating gateway: unauthenticated refused, forged
  internal headers stripped, browser headers pass through, machine
  denied, a gateway restart drill (browser down → Hub/nodes untouched
  → recover), and the two-node outage/delete/reenroll scenario via the
  correct ingress paths. Evidence: `docs/release-attestations/
  v0.3-stage6-e2e.md`.
