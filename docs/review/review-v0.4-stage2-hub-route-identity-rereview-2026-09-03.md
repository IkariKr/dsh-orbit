# DSH Orbit v0.4 Stage 2 Final Re-review — Hub Route Identity / Route Ingress / Reachability

Date: 2026-09-03

Review target:

- Branch: `feat/v0.4-stage2-hub-route-identity`
- Base commit: `62aee3dca9aa8482e44d5694d3eda3a7481197f7`
- Initial review commit: `fbcb4830f3b7c38dbc35b9198b29fac66bd8c962`
- Initial review verdict: `HOLD` (`docs/review/review-v0.4-stage2-hub-route-identity-2026-09-03.md`)
- Remediation commit: `e82d091a91e5d3faad9039ff028aa8289759ff6d`
- Stage: v0.4 Stage 2 — per-node Hub route identity + route ingress + reachability

## Verdict

**PASS — Stage 2 COMPLETE / ACCEPTED.**

Severity summary after re-review:

- P0: 0
- P1: 0 (3 closed)
- P2: 0 (3 closed)
- P3: 0 (2 closed)

All findings from the initial Stage 2 review have been remediated with verified code changes, regression-proof tests, and true multi-process end-to-end evidence. Stage 2 is complete, accepted, and closed.

Stage 3 may begin under a separate, explicit construction order.

---

## Detailed Findings Closure Status

### P1-1: Stage 2 production wiring & true child-process live evidence

**CLOSED.**

- `bin/dsh-orbit-node.mjs` starts `RouteIngress` under `run`, wiring `DSH_ORBIT_NODE_ROUTE_INGRESS_PORT`, `DSH_ORBIT_NODE_ROUTE_INGRESS_LISTEN`, `DSH_ORBIT_NODE_ROUTE_DOMAIN`, and `DSH_ORBIT_NODE_DSH_TARGET` with support for HTTPS/TLS keys and private CA certificates.
- `bin/dsh-orbit-hub.mjs` wires `DSH_ORBIT_HUB_ROUTE_DOMAIN`, `DSH_ORBIT_HUB_CA_CERT`, and starts `createRouteProbeScheduler(registry, { cadenceSeconds })`.
- `src/registry/scheduler.mjs` exports `createRouteProbeScheduler` with mutex protection against overlapping concurrent probe passes.
- `test/stage2-live-two-node.test.mjs` executes real child processes (`bin/dsh-orbit-hub.mjs`, `bin/dsh-orbit-node.mjs`), validating real CLI enrollment, real heartbeat trust-set pull, real route ingress listening, real Hub periodic probes, fault injection (process kill & downstream DSH down), and full process restarts with zero identity drift.

### P1-2: Heartbeat-delivered Hub trust material redirect rejection & additive private CA

**CLOSED.**

- `src/node/client.mjs` implements `callFetch` and `defaultNodeMachineFetch` with `redirect: "manual"`, failing closed on any HTTP 3xx (`redirect-denied`).
- The response URL origin is verified to match `hubBaseUrl` (`authority-mismatch`).
- `NodeClient` combines `caCertificates` with `tls.rootCertificates` to form an additive trust bundle for private-CA HTTPS Hub endpoints.
- Tests in `test/stage2-hub-route-identity.test.mjs` prove that redirects fail closed, wrong SAN fails closed, and private CA HTTPS is accepted only when configured.

### P1-3: Deleted-era Hub route keys surviving reenrollment

**CLOSED.**

- In `src/node/client.mjs`, `reenroll()` atomically resets `hubRouteKeys: null` upon receiving enrollment confirmation before setting `state = "active"`.
- Old Hub route keys are immediately un-trusted, preventing deleted-era keys from signing or authenticating route traffic before a fresh trust set is pulled and acknowledged.
- Unit tests verify that deleted-era keys return `unknown-key` immediately after reenrollment.

### P2-1: RAW_TARGET exact match & query string rejection

**CLOSED.**

- `src/node/route-ingress.mjs` enforces `req.url === "/_orbit/route-ready"`. Requests carrying query strings (e.g. `/_orbit/route-ready?unsigned=1`) or path aliases fail closed with HTTP 404.
- `verifyRouteRequest` receives `req.url` verbatim as `rawTarget`, guaranteeing byte-for-byte signing and verification equality.

### P2-2: Rotation overlapDays configuration binding

**CLOSED.**

- Removed misleading per-call `overlapDays` override from `rotateHubRouteKey({ actor, nodeId })`.
- Rotation overlap deadline is strictly bound to the Hub's validated 1–30 day configuration (`this.hubRouteOverlapDays`), matching audit records and execution semantics.

### P2-3: Hub route-probe private CA additive trust

**CLOSED.**

- `src/registry/route-probe.mjs` configures TLS `ca` as `[...tls.rootCertificates, ...extraCas]`.
- System/platform root certificates remain trusted when an optional operator private CA bundle is configured.

### P3-1: Loopback trust definition consistency

**CLOSED.**

- `isTrustedTransport()` in `src/node/client.mjs` is aligned with `route-target.mjs`: only `127.0.0.1`, `::1`, and `[::1]` are accepted as trusted loopback HTTP. Unresolved `"localhost"` strings are not accepted as transport trust proofs.

### P3-2: Tombstoning resets reachable state

**CLOSED.**

- `deleteNode()` in `src/registry/registry.mjs` updates `reachable = 'unknown'` and records a transition event if the node was previously in another reachability state.

---

## Final Verification Gates

1. **Repository Check**:
   - `npm run check`: 334 tests passed, 0 failed, 4 skipped.
   - `node scripts/check-public-tree.mjs`: PASS.
   - `git diff --check`: PASS.

2. **Stage Boundary Audit**:
   - [ABSENT] Browser HTTP reverse proxy
   - [ABSENT] WebSocket proxy
   - [ABSENT] Wildcard public routing
   - [ABSENT] Browser selector navigation
   - [ABSENT] Reverse connection / NAT traversal
   - [ABSENT] Automatic failover

## Stage 2 Disposition

**Stage 2: COMPLETE / ACCEPTED.**
Stage 3 is NOT started and requires a new construction order.
