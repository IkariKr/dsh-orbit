# DSH Orbit v0.4 Stage 2 Review — Hub Route Identity / Route Ingress / Reachability

Date: 2026-09-03

Review target:

- Branch: `feat/v0.4-stage2-hub-route-identity`
- Base: `62aee3dca9aa8482e44d5694d3eda3a7481197f7`
- Reviewed implementation HEAD: `a56cc81d2572d95335562a848715c0ffba86034a`
- Remote HEAD at review start: `a56cc81d2572d95335562a848715c0ffba86034a`
- Stage: v0.4 Stage 2 — per-node Hub route identity + route ingress + reachability

## Verdict

**HOLD**

Severity summary:

- P0: 0
- P1: 3
- P2: 3
- P3: 2

The implementation contains substantial correct Stage 2 building blocks: schema v5, per-node Ed25519 Hub route keys, public-only Node trust sets, complete-set validation, ORBIT-ROUTE-V1 primitives, the Stage 2-only readiness component, secret-safe inspection, backup preservation, and a basic reachability state machine. The repository test suite is green.

However, Stage 2 is not construction-complete. The current live test bypasses the production Node/Hub entrypoints, and the production CLIs do not actually wire the route ingress or periodic route probing. More importantly, two frozen security invariants are violated in executable behavior: redirected heartbeat responses can install Hub route trust material, and deleted-era Hub route keys survive Node reenrollment in local trust state. The route ingress also authenticates a constant readiness target rather than the exact incoming RAW_TARGET, so unsigned query bytes are accepted.

Stage 3 must not start until the P1 findings and blocking P2 findings are remediated and independently re-reviewed.

## Independent verification

### Provenance

At review start:

```text
local HEAD  = a56cc81d2572d95335562a848715c0ffba86034a
remote HEAD = a56cc81d2572d95335562a848715c0ffba86034a
```

The implementation diff from the Stage 2 baseline contains 14 files, approximately 1,867 added lines and 17 removed lines.

### Repository gate

Independent run:

```text
npm run check
```

Result:

- tests: 324
- pass: 320
- fail: 0
- skipped: 4 Windows/POSIX environment-specific tests
- public-tree validation: PASS
- `git diff --check`: PASS

A green repository gate therefore does **not** explain the HOLD; the blockers are missing production-path coverage and security/contract defects not exercised by the current tests.

## Findings

### P1-1 — Stage 2 is not wired into the production Hub/Node entrypoints; current “live” evidence bypasses the deployed path

Locations:

- `bin/dsh-orbit-node.mjs`
- `bin/dsh-orbit-hub.mjs`
- `src/registry/scheduler.mjs`
- `test/stage2-live-two-node.test.mjs`

The Stage 2 components exist as library classes/methods, but the production daemons do not activate them:

1. `dsh-orbit-node run` constructs only `NodeClient`; it never constructs/listens a `RouteIngress`.
2. `dsh-orbit-hub` constructs `Registry` without v0.4 route-domain/private-CA configuration.
3. The Hub maintenance scheduler calls only `registry.maintenance()`; `probeAllNodes()` is never scheduled or called by the production Hub.
4. Therefore the required default 60-second route probe cadence does not exist in the actual Hub runtime.

The file named `stage2-live-two-node.test.mjs` does not launch two real `dsh-orbit-node` child processes. It directly:

- calls `registry.heartbeatAuthenticated(...)`, bypassing ORBIT-MACHINE-V1 transport and `NodeClient` trust handling;
- manually constructs `new RouteIngress(...)` instances;
- manually constructs `Registry({ routeDomain, caCertificates })` rather than exercising production Hub configuration.

Impact:

A deployed Stage 2 build using the shipped CLIs cannot satisfy the Stage 2 end state. Node route ingress is absent and `reachable` will not advance under a periodic production probe loop. The current live evidence therefore proves component integration inside one test process, not the required production topology.

Required remediation:

- wire RouteIngress into the Node daemon with explicit Stage 2 configuration (listen host/port, route domain, DSH downstream target, TLS material where applicable);
- wire Hub route domain and operator-managed CA bundle into the Hub runtime;
- add a 60-second asynchronous route-probe scheduler with clean shutdown and no overlapping probe pass;
- replace/augment the current live evidence with actual child-process Hub + two Node daemons using their real heartbeat/key-sync path and real route ingress;
- prove Node and Hub restart, not only Registry DB reopen.

Do not add Stage 3 browser routing while fixing this.

### P1-2 — Heartbeat-delivered Hub trust material is accepted after redirect; optional private CA is not implemented in the real Node transport

Locations:

- `src/node/client.mjs:45-55` (`isTrustedTransport`)
- `src/node/client.mjs` machine `transport()`
- `src/node/client.mjs` heartbeat `hubRouteKeys` handling
- `bin/dsh-orbit-node.mjs`

RFC-0006 / RFC-0008 require Hub route public keys to be accepted only from the **exact persisted canonical `hubBaseUrl`**, with **no redirects**, over verified TLS (or explicit co-located loopback HTTP).

Current behavior checks only the configured base URL’s scheme/hostname. The real fetch uses the default Fetch redirect behavior and the final response URL is never checked. `caCertificates` is stored on `NodeClient` but is not passed to the machine transport, and the shipped Node CLI has no private-CA configuration path.

Independent executable reproduction used a Node bound to loopback Hub A. A returned HTTP 302 to loopback server B; B returned a valid-shaped `hubRouteKeys` set. Current result:

```text
HEARTBEAT_OK=true
PERSISTED_ROUTE_KEY=<key returned by redirected server B>
```

This violates the explicit no-redirect trust-anchor contract.

Impact:

- a redirecting/misconfigured Hub endpoint can move the trust-material response to a different authority while the Node still persists it;
- a Hub using the documented private-CA deployment model cannot use the current shipped Node transport without external/custom fetch injection.

Required remediation:

- machine transport must use `redirect: manual` or an equivalent no-redirect transport and reject every 3xx for trust synchronization;
- validate that the response belongs to the exact canonical configured authority;
- implement verified TLS with platform roots **plus** the optional operator-managed private-CA bundle for the actual Node machine transport;
- cover wrong authority, redirect, invalid certificate, wrong SAN, private-CA positive, and non-loopback plaintext negative cases through NodeClient/CLI-level tests;
- restrict loopback plaintext semantics consistently (`127.0.0.1` / `::1` or an explicitly proven loopback resolution), rather than treating arbitrary `localhost` naming as the security proof.

### P1-3 — Reenrollment reactivates local trust in deleted-era Hub route keys until a later heartbeat replaces the set

Location:

- `src/node/client.mjs` reenrollment success path

When the Node receives `401 revoked`, it persists `state = revoked` but intentionally retains its existing `hubRouteKeys`. That is acceptable while the Node remains revoked because route ingress must deny requests.

On successful reenrollment, however, the current code changes the Node back to `state = active` without clearing `hubRouteKeys`.

Independent executable reproduction:

```text
REENROLL_NODE=node_33333333333333333333333333333333
OLD_HUB_KEY_STILL_TRUSTED=true
```

This conflicts directly with RFC-0008:

- deleted-era Hub route identities remain revoked;
- reenrollment provisions a fresh Hub route identity;
- old route keys must never become trusted route credentials again.

The defect is especially dangerous across a process restart after reenrollment but before the first successful new heartbeat: a newly started route ingress can see the Node as active while the old active Hub public key is still present locally.

Required remediation:

- successful reenrollment must atomically clear the previous `hubRouteKeys` trust set before/while publishing the new active Node identity;
- route ingress must remain unable to authenticate any Hub route proof until a fresh post-reenrollment trust set has been durably pulled;
- if route ingress has an explicit disabled/enabled lifecycle, define reenrollment behavior so it can resume only with the new trust set without reviving old keys;
- add delete → Node observes revoked → reenroll → pre-heartbeat old-key denial → new-key pull/ACK → new-key success tests, including restart between reenroll and first heartbeat.

### P2-1 — Route ingress does not authenticate the exact incoming RAW_TARGET; unsigned query bytes are accepted

Location:

- `src/node/route-ingress.mjs`

The ingress checks only:

```text
fullUrl.pathname === "/_orbit/route-ready"
```

and then calls `verifyRouteRequest()` with the constant:

```text
rawTarget: "/_orbit/route-ready"
```

rather than the exact incoming request target (`req.url`).

Independent reproduction:

1. Sign a valid proof for exact `/_orbit/route-ready`.
2. Send the same proof to `/_orbit/route-ready?unsigned=1`.
3. Current result:

```text
HTTP 200
{"nodeId":"...","ready":true}
```

The query bytes were never covered by ORBIT-ROUTE-V1.

Required remediation:

Stage 2 reserves one **exact** route. Reject a query string outright, or verify against the exact incoming raw target. Add negative tests for query, encoded/normalized variants, and proof/forwarded-target mismatch. The signed bytes and verified bytes must be identical.

### P2-2 — Per-rotation `overlapDays` is reported but ignored; a requested 7-day overlap becomes 14 days

Location:

- `src/registry/registry.mjs` `rotateHubRouteKey()` / `acknowledgeHubRouteKeys()`

`rotateHubRouteKey({ overlapDays })` accepts and audits an `overlapDays` argument, but that value is not persisted with the pending rotation. When the Node acknowledges the next key, `acknowledgeHubRouteKeys()` always computes the deadline from `this.hubRouteOverlapDays`.

Independent reproduction with fixed time `2026-09-03T00:00:00Z`:

```text
rotateHubRouteKey(... overlapDays: 7)
actual overlapUntil = 2026-09-17T00:00:00.000Z
```

That is 14 days, not 7.

Required remediation:

Either remove the per-call override and document configuration-only behavior, or persist and honor the requested validated 1–30-day overlap for that rotation. Tests must assert exact deadline behavior and invalid bounds.

### P2-3 — Hub route-probe private CA option replaces, rather than extends, platform trust roots

Location:

- `src/registry/route-probe.mjs`

When `caCertificates` is configured, the implementation assigns it directly to `https.request({ ca })`. In Node TLS, providing `ca` defines the trust set for that connection rather than appending automatically to the built-in platform/root set.

RFC-0010 requires:

```text
platform trust roots + optional operator-managed Orbit private-CA bundle
```

The current implementation can therefore make ordinary publicly trusted route targets fail as soon as a private-CA bundle is configured for another Node.

Required remediation:

Build the effective CA set as platform roots plus the configured Orbit bundle, or use a process/runtime mechanism whose semantics explicitly append the private bundle. Add a mixed-topology test where one target uses the default public trust set and another uses the private CA while both remain valid.

## P3 findings

### P3-1 — Loopback trust rules are inconsistent between route-target validation and Node key-sync trust

Stage 1 route targets explicitly allow `127.0.0.1` / `::1`. `NodeClient.isTrustedTransport()` currently accepts `127.0.0.1` and `localhost`, but not IPv6 loopback. Align the helper with one documented loopback definition. Do not use a hostname label alone as proof of co-location unless its resolution is constrained.

### P3-2 — Tombstoning does not reset persisted `reachable`

Deleting a currently reachable node revokes route identity and makes the node ineligible, but `nodes.reachable` can retain `ok`. `probeNode()` returns an ephemeral `unknown` for a non-active node without persisting the reset. This is not a routing bypass because node state gates eligibility, but it leaves a misleading health dimension for later selector/operator display. Prefer resetting `reachable = unknown` as part of the delete transaction with an event if the prior value changed.

## Accepted areas

The following Stage 2 work is accepted as directionally/correctly implemented, subject to the blockers above:

- schema v4 → v5 and `hub_route_keys` FK persistence;
- per-node key isolation and public-only Node summary;
- private key excluded from safe inspection/digest while retained in SQLite backup;
- complete `hubRouteKeys` set validation for the four RFC forms;
- provisioned key not used for route signing before ACK;
- Hub key generation is durable and idempotent across repeated heartbeat responses;
- delete immediately revokes Hub-side route keys;
- ORBIT-ROUTE-V1 timestamp uses milliseconds and nonce format is correct;
- provisioned/revoked/unknown route keys fail verification;
- Stage 2 route ingress does not proxy ordinary DSH/browser paths;
- basic `unknown → unreachable / ok` reachability state-machine logic and route-target reset logic;
- route probes do not mutate `registryContact`, `dshHealthy`, compatibility, or capabilities in the reviewed implementation;
- Stage 3 browser HTTP proxy/WebSocket/selector/failover implementation is absent.

## Required remediation gate

Before narrow re-review, the contractor should complete only Stage 2 remediation:

1. wire Stage 2 into the actual Hub/Node daemons and add true child-process two-node evidence;
2. close exact-Hub/no-redirect/private-CA trust handling in NodeClient;
3. clear deleted-era Hub trust on reenrollment and prove old-key denial before fresh synchronization;
4. bind readiness authentication to the exact incoming RAW_TARGET / reject all query variants;
5. fix or remove the misleading per-call rotation overlap override;
6. make private CA additive to platform roots for Hub route probing;
7. add targeted negative/regression tests for all above;
8. run `npm run check`, public-tree validation, and `git diff --check`;
9. push the exact remediation HEAD and STOP.

Do not begin Stage 3.

## Final disposition

**Stage 2 HOLD. Stage 3 NOT AUTHORIZED.**

The implementation has a solid core, but the current completion report overstates deployment readiness. The next action should be a narrow Stage 2 remediation, followed by re-review against the real production Hub/Node process path.
