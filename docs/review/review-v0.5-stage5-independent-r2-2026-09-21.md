# DSH Orbit v0.5 Stage 5 Independent Review — Round 2

Date: 2026-09-21

Review type: **Independent Stage 5 implementation review, Round 2**

Review target:

- Worktree: `D:\App\01_Ai\CodeX\dsh-orbit-v05-stage1`
- Branch: `chore/v0.5-stage2-public-machine-ingress`
- Accepted Stage 0 design baseline: `5738c0ce6a4ec11bee62f9cfae44dd6463816768`
- Gate A GO record: `402d8995d225346679d514edb4b42208a5c773cc`
- Accepted Stage 1–4 construction HEAD: `9edc70faecae20e73258a42ecb78c0c7347edc35`
- Gate B GO record / current committed HEAD: `d9490aca1d33f3b093dc9da7733434bc4d817c5d`
- Round 1 independent review: `docs/review/review-v0.5-stage5-independent-r1-2026-09-21.md`
- Construction completion/remediation report: `docs/review/review-v0.5-stage5-completion-2026-09-20.md`
- Controlling design: `docs/rfc/0012-reverse-connected-nodes.md`
- Controlling SOP: `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md`

## Round 2 verdict

**HOLD / CHANGES REQUESTED**

```text
Round 1 findings:
P1-1 capacity-wait bypass:            CLOSED
P1-2 reverse reachable contradiction: CLOSED
P1-3 control-session revoke teardown: CLOSED
P2-1 Gate C wording:                  CLOSED

New Round 2 findings:
P0 = 0
P1 = 1
P2 = 1

Stage 5 independent acceptance: HOLD
Stage 6 construction: NOT AUTHORIZED by this review
Candidate freeze: NOT AUTHORIZED
Gate C: NOT REACHED
Stage 8 mounted evidence: NOT AUTHORIZED
```

The Round 1 remediation is real and materially correct. The current suite is green and the previously reported behaviors are now covered at the route level. However, RFC-0012 D10 contains a stricter credential-revocation invariant than the remediation currently implements: **every control and data connection must record the node key ID that authenticated its upgrade**. Control sessions do; data channels currently do not. Consequently, a data channel authenticated with a revoked key can survive when its bound current control session was authenticated with another still-valid key.

This is a protocol/security lifecycle defect, not a test-count issue.

---

# 1. Fresh independent verification

## 1.1 Lineage / worktree

Verified current committed state:

```text
HEAD   d9490aca1d33f3b093dc9da7733434bc4d817c5d
remote d9490aca1d33f3b093dc9da7733434bc4d817c5d
divergence 0 / 0
```

Stage 5 remains an intentionally dirty worktree. No candidate has been frozen.

The product/test delta remains uncommitted on top of the Gate B GO record, consistent with the contractor report.

## 1.2 Exact focused Stage 3–5 matrix

Fresh independent execution of the report's exact 10-suite command:

```text
tests    59
pass     59
fail     0
skipped  0
```

Result independently matches the remediation report.

## 1.3 Full repository check

Fresh independent `npm run check`:

```text
tests    468
pass     463
fail     0
skipped  5
exit     0
```

Also independently verified:

```text
git diff --check: PASS
public-tree validation: PASS
ignored data/secrets residue: 0
new insecure TLS bypass scan: no match
new Windows Root-store mutation scan: no match
obvious generic tunnel/service-mesh/auto-failover scope scan: no match
```

The CRLF→LF message for `src/registry/reverse-channel.mjs` remains a Git normalization warning, not a diff-check failure.

---

# 2. Round 1 remediation review

## R1 P1-1 — real route dispatch bypassed the bounded capacity waiter

**CLOSED**

The immediate `idleChannels().length < 1 => ineligible` route-dispatch gate is gone.

Current behavior:

- `evaluateRouteEligibility()` freezes one current reverse-session snapshot;
- it does not consume an idle channel;
- HTTP and WebSocket concrete dispatch reach `ReverseChannelManager.acquireChannel()`;
- `acquireChannel()` waits up to `capacityWaitMs`;
- waiters are bound to the captured `reverseSessionId`;
- takeover closes/cancels the old generation;
- timeout produces `reverse-capacity`;
- no direct/sibling fallback is introduced.

Fresh route-level tests independently passed:

- HTTP zero-idle → channel becomes idle → request succeeds;
- WebSocket zero-idle → channel becomes idle → 101 succeeds;
- HTTP zero-idle → bounded timeout → 503;
- old-generation waiter cancellation.

The Round 1 capacity-bypass defect is closed.

## R1 P1-2 — selector/read model could show eligible while reachable=unreachable

**CLOSED**

`buildSelectorNodeRow()` now projects reverse-mode `health.reachable` from the same live reverse-session readiness snapshot used by route eligibility:

```text
reverseRouteReady=true  -> reachable=ok
reverseRouteReady=false -> reachable=unreachable
```

Direct mode still reads the persisted RFC-0010 direct-probe dimension.

`registryContact` remains independently heartbeat-derived.

Fresh tests independently confirmed:

- reverse online + ready → selector eligible + reachable ok;
- reverse online + not ready → selector ineligible + reachable unreachable;
- reverse session loss → reverse offline + reachable unreachable;
- direct mode remains direct-only;
- registryContact is not moved by reverse readiness.

The Round 1 read-model contradiction is closed.

## R1 P1-3 — revoked old control-session key did not close runtime session/flow

**CLOSED for the control-session case reviewed in Round 1**

The Registry maintenance path now collects node credentials that transition to revoked, commits the database transaction, then invokes:

```text
runtimeLifecycleHooks.onNodeCredentialRevoked
```

The Hub wires that to:

```text
reverseSessions.closeSessionsForCredential(nodeId, keyId)
```

and closes channels for the returned reverse-session generations.

Fresh tests independently confirmed:

- old key remains valid during the normal overlap;
- overlap expiry revokes old key;
- an active reverse WebSocket on the old-key control generation closes;
- the current/new key reconnects;
- a newly attempted reverse control upgrade signed by the revoked old key is denied.

This closes the **control-session** defect identified in Round 1.

A stricter D10 data-channel problem remains and is the new P1 below.

## R1 P2-1 — Gate C wording

**CLOSED**

The completion report now correctly states:

```text
Gate C = NOT REACHED
```

and preserves the SOP order:

```text
Stage 5 -> Stage 6 -> Stage 7/candidate freeze -> Gate C -> Stage 8
```

No premature Gate C or mounted authorization is claimed.

---

# 3. New Round 2 finding

## P1-1 — Data channels do not record their authenticating node key, so credential revocation is not complete

**Severity: P1**

RFC-0012 D10 is explicit:

> Each control/data connection records the node key ID that authenticated its upgrade.

and:

> when a node key becomes revoked, any reverse control session authenticated with that key is closed; all associated data channels are closed.

The current implementation satisfies this for **control sessions** but not for **data channels**.

### Current control-session path

`src/registry/server.mjs` authenticates the reverse control upgrade and passes:

```text
keyId: auth.key.key_id
```

into `reverseSessions.registerUpgrade(...)`.

`ReverseSession` persists that `keyId`, and `closeSessionsForCredential(nodeId, keyId)` can therefore invalidate matching control generations.

This part is correct.

### Current data-channel path

The same Hub handler authenticates a reverse data-channel upgrade and also has:

```text
auth.key.key_id
```

available.

But the subsequent registration is currently:

```text
reverseChannels.registerChannel({
  nodeId,
  sessionId,
  socket,
  secWebSocketKey
})
```

The authenticating `keyId` is discarded.

`ReverseChannelManager.registerChannel()` does not accept a key ID, and `ReverseChannel` has no `keyId` field.

Independent mechanical inspection/reproduction:

```text
registerChannel accepts keyId: false
channel.keyId: undefined
closeChannelsForCredential: undefined
```

### Why the existing revocation test does not cover this

The new live test uses an old-key **control session**. When that old control key expires:

```text
closeSessionsForCredential(oldKey)
  -> closes old control session
  -> onSessionClosed closes every channel bound to that old session
```

That proves the Round 1 scenario, but it does not prove D10's per-data-connection credential lifecycle.

RFC D5 permits each data channel to authenticate independently with any **currently accepted** node credential while binding to the current ready reverse session. The server currently enforces:

```text
channel nodeId == current session nodeId
channel sessionId == current reverseSessionId
channel machine key is currently accepted
```

It does **not** require:

```text
channel auth key == control-session auth key
```

Therefore this legal overlap sequence exists:

```text
1. K_old and K_new are both accepted during rotation overlap.
2. Current control session is authenticated with K_new.
3. A data channel binds to that current session but authenticates with K_old.
4. K_old reaches overlap expiry and becomes revoked.
5. onNodeCredentialRevoked(nodeId, K_old) runs.
6. closeSessionsForCredential() sees current control key = K_new.
7. It returns no matching current session ID.
8. The data channel authenticated with K_old cannot be identified, because
   ReverseChannel never stored K_old.
9. The revoked-key data channel remains registered/usable until some unrelated
   channel/session teardown.
```

This violates the exact D10 connection-level revocation invariant.

It also means the implementation currently relies on the official node client's usual credential sequencing rather than enforcing the wire protocol at the Hub boundary. The RFC intentionally does not allow that assumption.

### Required remediation

Do not solve this by weakening D10.

Preferred minimal fix:

1. Pass `auth.key.key_id` into `reverseChannels.registerChannel()`.
2. Store it on every `ReverseChannel`.
3. Add an exact-key runtime invalidation seam such as:
   `closeChannelsForCredential(nodeId, keyId, reason)`.
4. On `onNodeCredentialRevoked`:
   - close control/pending sessions authenticated with that key;
   - independently close every data channel authenticated with that key;
   - leave control/data connections authenticated with other still-valid keys intact.
5. Preserve the existing session-generation close behavior. Credential close and generation close should both be idempotent.

Do **not** merely require data-channel key == control-session key unless RFC-0012 is explicitly amended through architecture review. The accepted D5/D10 design models them as independently machine-authenticated connections.

Required regression tests:

```text
A. overlap: control=K_new, channel=K_old -> accepted while K_old valid
B. revoke K_old -> K_old channel closes immediately
C. K_new control remains current
D. K_new-authenticated channels remain open
E. active browser flow on K_old channel aborts immediately
F. new K_old channel upgrade is denied after revocation
G. pending/current control generations authenticated with K_old still close
H. node/key isolation: revoking node A/K_old never closes node B or A/K_new channels
```

Until this is closed, Stage 5 cannot claim complete credential-revocation semantics.

---

# 4. Residual P2 — RFC D9 pool-availability wording is still not mechanically represented

**Severity: P2 / design-contract clarity**

Round 1 correctly rejected the old implementation where an instantaneous zero-idle snapshot caused immediate 503 and bypassed the 2-second assignment waiter.

The remediation now goes to the other extreme:

```text
evaluateRouteEligibility(...)
  -> deliberately ignores reverseChannels
  -> "void reverseChannels"
```

This correctly preserves the bounded flow-assignment waiter, but canonical RFC-0012 D9 still literally says reverse eligibility requires:

> at least one data channel is available: eligibility uses a non-destructive pool-availability predicate

The current implementation has no such predicate at all.

The practical ambiguous case is:

```text
control session = online
routeReady = true
registered current-generation data channels = 0
```

Current selector/read model can still report route eligible/Open, and a concrete request then waits up to 2 seconds before failing `reverse-capacity`.

The implementation is fail-closed and bounded, so this is not classified as P1 in this round. But the RFC and implementation are no longer mechanically identical.

### Required disposition before candidate freeze

Choose one and record it explicitly:

1. **Implement** a non-destructive pool-availability predicate whose semantics do not reintroduce the Round 1 immediate-idle bug; or
2. **Architecture-review/amend D9** to state that reverse control readiness establishes selector eligibility and data-channel availability is exclusively a flow-assignment concern with the bounded 2-second waiter.

Do not silently leave `void reverseChannels` as the long-term interpretation of a canonical D9 requirement.

Because D1–D15 are frozen design decisions, changing the normative meaning of D9 requires the documented architecture-governance path.

This P2 does not by itself expand product scope and does not invalidate the verified capacity-wait remediation.

---

# 5. Items accepted in Round 2

Subject to the P1 above, the following Stage 5 areas are independently accepted:

- reverse HTTP dispatch reaches the bounded capacity waiter;
- reverse WebSocket dispatch reaches the bounded capacity waiter;
- bounded timeout produces same-node fail-closed 503;
- waiter is reverse-session-generation-bound;
- selector evaluation does not consume a channel;
- reverse `reachable` projection is coherent with live route readiness;
- `registryContact` remains independent;
- explicit `routeMode=direct|reverse`, no auto;
- no direct↔reverse automatic fallback;
- no sibling-node fallback;
- immutable transport snapshot for established flows;
- reverse WebSocket 101 parity;
- text/binary/ping-pong and 512 KiB payload;
- Origin/subprotocol/browser Cookie/Authorization preservation;
- management/route/gateway credential stripping before DSH;
- reverse Set-Cookie Domain stripping;
- non-101 401/403/500 transparency;
- split non-101 response body;
- browser pre-response abort cleanup;
- downstream-close cleanup;
- WebSocket tracker limits/recovery;
- D7 bounded response/request handling covered by focused tests;
- delete closes current reverse session/channels/active flow;
- old control-session credential overlap expiry teardown;
- revoked key cannot establish a new control session;
- direct v0.4 route/WebSocket regression remains green;
- public machine surface/TLS boundaries remain unchanged;
- no generic tunnel/service mesh/automatic failover scope expansion found.

---

# 6. Required remediation order

Keep the worktree in Stage 5 remediation. Do not start Stage 6 yet.

1. **P1-1: bind credential identity to every reverse data channel**
   - persist channel `keyId`;
   - close channels by exact revoked node credential;
   - add mixed-key overlap tests.

2. Fresh regression:
   - exact 59-test focused Stage 3–5 matrix;
   - new mixed-key channel revocation tests;
   - `npm run check`;
   - `git diff --check`;
   - public-tree;
   - residue/security/scope scans.

3. Resolve/record the D9 P2:
   - implementation predicate, or
   - explicit architecture clarification.

4. Update the completion report with Round 2 remediation without deleting Round 1 history.

5. Stop for **Independent Stage 5 Review Round 3**.

---

# 7. NOT_EXECUTED / not authorized

Still not executed or accepted by this review:

- Stage 6 authenticated operator route-mode mutation;
- complete Stage 6 operator credential rotation/immediate-revoke UI/API lifecycle;
- Stage 6 reenroll same-node-ID + fresh Hub route identity qualification;
- Stage 6 UI/read-model operator workflow;
- Stage 7 hardening qualification;
- exact frozen candidate-bound 48-field matrix;
- candidate freeze;
- Gate C Candidate Review;
- Stage 8 canonical mounted topology;
- candidate-bound 7-artifact evidence set;
- evidence-only closure;
- v0.5 Independent Final Review;
- tag/release publication;
- production promotion;
- DNS cutover.

---

## Formal disposition

```text
Independent Stage 5 Review Round 2

Round 1:
3 x P1 CLOSED
1 x P2 CLOSED

Round 2:
P0 = 0
P1 = 1
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
