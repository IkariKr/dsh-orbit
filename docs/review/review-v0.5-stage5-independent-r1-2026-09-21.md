# DSH Orbit v0.5 Stage 5 Independent Review — Round 1

Date: 2026-09-21

Review type: **Independent Stage 5 implementation review, Round 1**

Review target:

- Worktree: `D:\App\01_Ai\CodeX\dsh-orbit-v05-stage1`
- Branch: `chore/v0.5-stage2-public-machine-ingress`
- Accepted Stage 0 design baseline: `5738c0ce6a4ec11bee62f9cfae44dd6463816768`
- Gate A GO record: `402d8995d225346679d514edb4b42208a5c773cc`
- Accepted Stage 1–4 construction HEAD: `9edc70faecae20e73258a42ecb78c0c7347edc35`
- Gate B GO record / current committed HEAD: `d9490aca1d33f3b093dc9da7733434bc4d817c5d`
- Review input: current dirty worktree at `d9490ac`, including all uncommitted Stage 5 product/test changes and `docs/review/review-v0.5-stage5-completion-2026-09-20.md`
- Controlling design: `docs/rfc/0012-reverse-connected-nodes.md`
- Controlling SOP: `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md`

## Round 1 verdict

**HOLD / CHANGES REQUESTED**

```text
P0 = 0
P1 = 3
P2 = 1

Stage 5 implementation acceptance: HOLD
Stage 6 construction: NOT AUTHORIZED by this review
Candidate freeze: NOT AUTHORIZED
Gate C: NOT REACHED
Stage 8 mounted evidence: NOT AUTHORIZED
```

The implementation is materially advanced and the reported green test counts are real. The review independently reproduced the focused Stage 5 suite and the full repository suite with zero failures. However, three required RFC/SOP behaviors are not closed by the current implementation. Two are directly reproducible runtime/read-model contradictions; the third is an explicitly required Stage 5 lifecycle case that is both unimplemented and listed as `NOT_EXECUTED` in the completion report.

This review does **not** reject the Stage 1–4 Gate B acceptance. The findings are in the Stage 5 route integration/lifecycle layer now under review.

---

## 1. Independent verification performed

### 1.1 Lineage / worktree

Verified:

```text
5738c0c  accepted Stage 0 design
402d899  Gate A GO record
...
9edc70f  accepted Stage 1–4 construction HEAD
d9490ac  Gate B GO record / current committed HEAD
          +
          uncommitted Stage 5 implementation/tests/report
```

`d9490ac` differs from `9edc70f` only by the Gate B review record. All Stage 5 runtime changes are currently uncommitted, consistent with the construction report.

Current worktree remains intentionally dirty and is **not** a frozen candidate.

### 1.2 Focused Stage 5 verification

Fresh independent execution:

```text
node --test
  test/v05-stage3-live-reverse.test.mjs
  test/v05-stage3-reverse-control.test.mjs
  test/v05-stage4-d7-bounds.test.mjs
  test/v05-stage4-live-reverse-http.test.mjs
  test/v05-stage4-reverse-channels.test.mjs
  test/stage4-websocket-routing.test.mjs
  test/stage5-selector-api.test.mjs
  test/stage5-live-selector-e2e.test.mjs
  test/v05-stage5-live-reverse-route.test.mjs
  test/v05-stage5-route-mode-contract.test.mjs
```

Result:

```text
tests  50
pass   50
fail   0
skip   0
```

This independently reproduces the completion report.

### 1.3 Full repository verification

Fresh independent `npm run check`:

```text
tests  459
pass   454
fail   0
skip   5
exit   0
```

Public-tree validation passed.

Additional checks:

```text
git diff --check: PASS
public-tree: PASS
ignored data/secrets residue: 0
new insecure-TLS bypass scan: no match
new OS Root-store mutation scan: no match
obvious v0.6/v0.7/service-mesh/automatic-failover scope scan: no match
```

The CRLF→LF message for `src/registry/reverse-channel.mjs` is a Git normalization warning, not a `git diff --check` failure.

---

# 2. Findings

## P1-1 — Real route dispatch bypasses the required 2-second reverse capacity wait

**Severity: P1**

RFC-0012 D9 and SOP Stage 4 deliberately split:

1. non-destructive reverse route eligibility; and
2. concrete flow assignment, where the Hub waits up to 2 seconds for the same node to replenish an idle data channel before returning `503 reverse-capacity`.

The current channel manager implements the bounded waiter correctly. `ReverseChannelManager.acquireChannel()`:

- atomically claims an idle channel when available;
- otherwise installs a generation-bound waiter;
- waits up to `capacityWaitMs`;
- cancels the waiter on session takeover/browser abort;
- only then throws `ReverseCapacityError`.

But the real HTTP/WebSocket route path never reaches that waiter when the pool is temporarily at zero idle channels.

Current `evaluateRouteEligibility()` in `src/registry/route-proxy.mjs` contains:

```text
reverse mode
  -> session online
  -> route ready
  -> idleChannels(nodeId).length < 1
     => eligible:false / reverse-capacity
```

Both HTTP and WebSocket handlers in `src/registry/server.mjs` call this evaluator **before** `proxyReverseHttpRequest()` / `proxyReverseWebSocketUpgrade()`. An ineligible result immediately emits 503, so `acquireChannel()` cannot perform the RFC-mandated bounded wait.

The current Stage 5 contract test mechanically preserves the wrong behavior:

```text
idle = 0
evaluateRouteEligibility(...)
=> reason = reverse-capacity
```

Independent reproduction:

```text
zeroIdleEligibility = {
  eligible: false,
  reason: "reverse-capacity",
  routeMode: "reverse",
  reversePresence: "online"
}
```

### Why this matters

A healthy reverse node whose pool is momentarily fully busy is treated as immediately unavailable even when a matching-session channel becomes idle or is replenished milliseconds later. This defeats the designed same-node 2-second capacity smoothing and changes externally visible routing behavior.

It is not an availability optimization only. The RFC intentionally places capacity waiting at flow assignment so selector/routing eligibility and resource allocation do not race or consume each other.

### Required remediation

Keep route eligibility non-destructive and let the concrete reverse flow own capacity acquisition.

At minimum:

- remove the immediate `idleChannels().length < 1 => ineligible` dispatch gate, or replace it with a non-consuming predicate that does not bypass the bounded waiter;
- HTTP and WebSocket reverse dispatch must reach `acquireChannel(nodeId, { sessionId, ... })` when all non-capacity eligibility conditions pass;
- the exact immutable `reverseSessionId` snapshot must remain bound while waiting;
- session takeover must still cancel the old-generation waiter;
- after 2 seconds without a usable same-generation channel, return `503 reverse-capacity`;
- no direct target or sibling node fallback.

Required regression tests:

1. HTTP: zero idle at eligibility time, same-session channel arrives before timeout → request succeeds;
2. WebSocket: same scenario → upgrade proceeds;
3. no channel before timeout → 503 `reverse-capacity`;
4. session takeover during wait → old wait fails stale, never claims new-generation channel;
5. selector eligibility/read model must not consume a channel.

---

## P1-2 — Reverse selector/read model can say “Open eligible” while `health.reachable = unreachable`

**Severity: P1**

RFC-0012 D8 fixes `reachable` as the Hub's route-transport readiness dimension whose source depends on explicit `routeMode`:

- direct mode: existing RFC-0010 direct probe;
- reverse mode: current authenticated ready reverse session **and** current local route readiness.

The Stage 5 selector/read model is server-authoritative, so it must present one coherent state.

Current implementation splits those facts:

- `evaluateRouteEligibility()` correctly uses live reverse session state for reverse routing;
- `buildSelectorNodeRow()` still exposes `health.reachable: nodeRow.reachable` from the persisted v0.4 direct-probe field.

The reverse session callbacks in `src/registry/server.mjs` currently log `routeReady` changes but do not reconcile the selector's persisted `nodeRow.reachable`.

Independent mechanical reproduction with a reverse node:

```text
runtime:
  reversePresence = online
  routeReady = true
  idle channel = available

persisted nodeRow.reachable = unreachable
```

Current result:

```text
selector.route.eligible       = true
selector.route.reversePresence = online
selector.route.openUrl         = https://n-.../

selector.health.reachable      = unreachable
```

That is an internally contradictory server-authoritative read model.

### Why this matters

The selector can simultaneously tell the operator:

```text
route is eligible / Open is enabled
reachable = unreachable
```

Stage 6 UI would then be forced either to display contradictory health or to invent browser-side reconciliation, which RFC-0011/RFC-0012 explicitly forbid.

### Required remediation

Define one authoritative v0.5 read-model projection for `reachable`.

Acceptable direction:

- direct mode continues to expose the persisted RFC-0010 probe-derived value;
- reverse mode projects `ok` when current ready reverse session + `routeReady=true`;
- reverse mode projects `unreachable` when session is offline or current route readiness is false;
- `registryContact` remains independently heartbeat-derived;
- selector eligibility and displayed health must consume the same reverse readiness source.

If the implementation chooses to persist reverse reachability rather than project it at read time, it must preserve RFC-0009 event/transition semantics and must not let stale process state survive Hub restart.

Required tests:

1. reverse online + routeReady true → `health.reachable = ok`;
2. reverse online + routeReady false → `unreachable`;
3. reverse session loss → `unreachable`;
4. direct mode continues to use direct probe state only;
5. reverse readiness changes do not move `registryContact`;
6. selector route eligibility and health cannot contradict each other for the same read.

---

## P1-3 — Required Stage 5 credential-revocation teardown is not implemented/verified

**Severity: P1**

SOP Stage 5 explicitly requires:

> node delete/revoke aborts active flow immediately

RFC-0012 D10 is more specific for Node credential rotation:

- every reverse control/data connection records the node key ID that authenticated it;
- during overlap, accepted keys may establish sessions;
- once a node key becomes revoked, any reverse control session authenticated with that key is closed;
- associated data channels are closed;
- the node reconnects using its current key.

The current Stage 5 work correctly wires **delete**:

```text
Registry.deleteNode()
  -> runtimeLifecycleHooks.onNodeDeleted
  -> reverseSessions.closeSessionsForNode()
  -> reverseChannels.closeChannelsForNode()
```

and the live test proves deletion tears down an active reverse WebSocket.

But key revocation has no equivalent runtime hook.

`Registry.maintenance()` revokes an old node key at rotation-overlap expiry:

```text
UPDATE node_keys
SET state='revoked' ...
WHERE revoke_after <= now
```

The reverse session already records the authenticating `keyId`, but no current code closes sessions/channels whose recorded key has just become revoked.

The completion report itself lists:

```text
Stage 6 credential rotation / overlap expiry / immediate revoke
对 reverse sessions/channels 的完整生命周期闭合
= NOT_EXECUTED
```

That cannot coexist with “Stage 5 local implementation/test verification = PASS” because the Stage 5 required automated test explicitly includes revoke.

### Why this matters

After the old credential's overlap expires, a reverse control session authenticated with that now-revoked key may remain alive and continue carrying channels/flows until some unrelated disconnect. New authentication is denied correctly, but the already-admitted runtime session is not synchronously invalidated as RFC-0012 requires.

### Required remediation

Wire credential revocation into the runtime lifecycle without over-expanding Stage 6.

At minimum:

- when a node credential transitions to revoked, emit/invoke a runtime lifecycle callback containing `nodeId + keyId + reason`;
- reverse session manager closes current/pending sessions authenticated with that exact revoked key;
- existing session-close machinery closes the associated data channels and active flows;
- sessions authenticated with the still-current/new key remain intact;
- reconnect uses the current valid node key.

Required regression tests:

1. establish reverse control/session using old key;
2. rotate credential, remain inside overlap → old session remains valid;
3. establish/retain a new-key session as appropriate;
4. advance maintenance to overlap expiry;
5. old-key session/channels/active browser flow close immediately;
6. new-key session is not closed merely because old key expired;
7. new reverse connection signed by old key is denied;
8. current key reconnect succeeds.

The broader operator UI and reenroll workflow can remain Stage 6. The actual revoked-key runtime invalidation cannot be deferred because it is already a Stage 5 acceptance requirement and RFC D10 security invariant.

---

## P2-1 — Current report calls Gate C “HOLD”, but Gate C has not been reached

**Severity: P2 / governance wording**

The SOP sequence is:

```text
Stage 5
→ Stage 6
→ Stage 7 hardening + candidate freeze
→ Gate C Candidate Review
→ Stage 8 mounted evidence
```

At the current dirty Stage 5 worktree:

- Stage 6 is not complete;
- Stage 7 has not begun;
- no candidate exists.

Therefore the precise status is:

```text
Gate C = NOT REACHED
candidate freeze = NOT AUTHORIZED / NOT EXECUTED
```

rather than treating the current Stage 5 review as Gate C itself.

The construction report is conservative and does not accidentally authorize later work, so this is not a security defect. The wording should nevertheless be corrected so future reports do not collapse Stage 5 independent review and Gate C into one gate.

---

# 3. Items independently accepted in this round

The HOLD is narrow. The following Stage 5 behavior is substantially supported by code + fresh tests and does not need to be reopened unless remediation touches it:

- direct and reverse use one deterministic RFC-0010 node authority;
- explicit `routeMode=direct|reverse`, no `auto`;
- immutable transport snapshot for an already-open flow;
- reverse mode does not use a stored direct target;
- direct mode does not use an online reverse session;
- no sibling-node fallback;
- reverse WebSocket 101 path;
- text/binary/ping-pong;
- 512 KiB payload;
- Origin/subprotocol/browser Cookie/Authorization preservation;
- Orbit/gateway/management credential stripping before DSH;
- downstream `Set-Cookie Domain` stripping;
- non-101 401/403/500 status/body behavior;
- delayed/split non-101 body;
- browser pre-response abort cleanup;
- downstream close cleanup;
- WebSocket tracker capacity/recovery;
- generation-bound capacity waiter implementation at the channel-manager seam;
- D7 response queue hard cap / soft mark / stall behavior covered by focused tests;
- direct v0.4 WebSocket regression remains green;
- shared Node-side `ORBIT-ROUTE-V1` replay cache remains present;
- delete closes reverse session/channels/active flow;
- no insecure TLS bypass or new OS trust-store mutation found;
- no evidence of v0.6/v0.7/general-tunnel/automatic-failover scope expansion.

---

# 4. Review of the completion report

The contractor report is useful and mostly candid:

- exact committed HEAD/remote state are correct;
- dirty worktree is disclosed;
- candidate is not falsely frozen;
- Stage 8 is not falsely claimed;
- test totals reproduce independently;
- the old Gate B P2 remediation (response stall threshold + reverse Set-Cookie sanitation) is present.

However, the headline:

```text
Stage 5 local implementation/test verification: PASS
```

is not accepted by this independent review because:

1. the real route dispatcher does not honor the bounded 2-second capacity wait;
2. the server-authoritative reverse selector/read model can contradict itself on `reachable`;
3. a required Stage 5 revoke-teardown case is explicitly NOT_EXECUTED and has no current runtime hook.

The correct current disposition is:

```text
Stage 5 tests: GREEN
Stage 5 independent acceptance: HOLD
```

A green existing suite is not sufficient when the suite encodes or omits a required RFC behavior.

---

# 5. Required remediation order

Do not start Stage 6 yet. Keep the worktree in Stage 5 remediation.

Recommended order:

1. **P1-1 capacity ownership**
   - make flow assignment own the 2-second wait;
   - add route-level HTTP + WebSocket transient-capacity tests.

2. **P1-2 coherent reverse reachability projection**
   - choose and document the single authoritative read-model mechanism;
   - add reverse `health.reachable` transition tests.

3. **P1-3 credential revocation runtime invalidation**
   - wire exact key revocation → matching reverse session/channel teardown;
   - add overlap-expiry/current-key isolation tests.

4. Update the Stage 5 completion report:
   - mark Round 1 HOLD findings/remediation;
   - use `Gate C = NOT REACHED`;
   - do not erase the original independent findings.

5. Fresh re-run:
   - focused Stage 3–5 suites;
   - new targeted remediation tests;
   - `npm run check`;
   - `git diff --check`;
   - public-tree;
   - residue/scope/security scans.

Then stop again for **Stage 5 Independent Review Round 2**.

Only after Round 2 returns PASS should Stage 6 begin.

---

# 6. NOT_EXECUTED / not authorized by this review

Still explicitly not executed/accepted:

- Stage 6 operator route-mode mutation surface;
- full Stage 6 rotation/reenroll/UI lifecycle beyond the Stage 5 revocation invariant above;
- Stage 7 hardening matrix;
- exact candidate-bound RFC-0012 48-field final qualification;
- candidate freeze;
- Gate C Candidate Review;
- Stage 8 canonical mounted topology/evidence;
- seven-artifact v0.5 evidence set;
- evidence-only closure;
- v0.5 Independent Final Review;
- tag/release publication;
- production promotion;
- DNS cutover.

---

## Formal disposition

```text
Independent Stage 5 Review Round 1

P0 = 0
P1 = 3
P2 = 1

VERDICT:
HOLD / CHANGES REQUESTED

Stage 5 accepted:
NO

Stage 6 authorized by this review:
NO

Candidate freeze:
NO

Gate C:
NOT REACHED

Stage 8:
NOT AUTHORIZED
```
