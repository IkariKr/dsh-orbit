# DSH Orbit v0.5 Stage 5 Independent Review — Round 3

Date: 2026-09-22

Review type: **Independent Stage 5 implementation review, Round 3**

Review target:

- Worktree: `D:\App\01_Ai\CodeX\dsh-orbit-v05-stage1`
- Branch: `chore/v0.5-stage2-public-machine-ingress`
- Accepted Stage 0 design baseline: `5738c0ce6a4ec11bee62f9cfae44dd6463816768`
- Gate A GO record: `402d8995d225346679d514edb4b42208a5c773cc`
- Accepted Stage 1–4 construction HEAD: `9edc70faecae20e73258a42ecb78c0c7347edc35`
- Gate B GO record: `d9490aca1d33f3b093dc9da7733434bc4d817c5d`
- **Current committed HEAD under review: `c1fd3cc66f7c686df26c72276591da16387ec48f`**
- Round 1 independent review: `docs/review/review-v0.5-stage5-independent-r1-2026-09-21.md`
- Round 2 independent review: `docs/review/review-v0.5-stage5-independent-r2-2026-09-21.md`
- Construction completion/remediation report: `docs/review/review-v0.5-stage5-completion-2026-09-20.md`
- Controlling design: `docs/rfc/0012-reverse-connected-nodes.md`
- Controlling SOP: `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md`

## Round 3 verdict

**PASS / ACCEPTED**

```text
Round 1 findings (r2-verified):
P1-1 capacity-wait bypass:            CLOSED (re-verified)
P1-2 reverse reachable contradiction: CLOSED (re-verified)
P1-3 control-session revoke teardown: CLOSED (re-verified)
P2-1 Gate C wording:                  CLOSED (re-verified)

Round 2 findings:
P1-1 data-channel credential identity: CLOSED
P2-1 D9 pool-availability predicate:   CLOSED

New Round 3 findings:
P0 = 0
P1 = 0
P2 = 0

Stage 5 independent acceptance: PASS
Stage 6 construction: AUTHORIZED (SOP order preserved; Stage 6 may begin)
Candidate freeze: NOT AUTHORIZED by this review
Gate C: NOT REACHED
Stage 8 mounted evidence: NOT AUTHORIZED
```

Round 2 HOLD is resolved. The exact-key data-channel revocation seam is
implemented at every layer it was missing, and the D9 pool-availability
contract is now mechanically represented by a non-destructive
generation-bound predicate rather than by an absence. Both were verified by
fresh full-suite execution and by independent seam-level probes written for
this round. No new P0/P1/P2 findings were identified.

---

## 1. Lineage / worktree

Verified current committed state:

```text
HEAD   c1fd3cc66f7c686df26c72276591da16387ec48f
remote c1fd3cc66f7c686df26c72276591da16387ec48f
divergence 0 / 0
worktree: clean (no staged, modified, or untracked files after review probes removed)
```

Stage 5 is no longer a dirty worktree: the entire product/test/report delta
sitting atop the Gate B record is now committed at `c1fd3cc`. This is still
**not** a frozen candidate — the SOP freeze preconditions (clean pushed
single candidate, Stage 7 hardening, 48-field candidate-bound matrix) are
not met — but the review input is now a fixed SHA rather than an
intentionally dirty tree, which is a material hygiene improvement since
Round 2.

Verified commit ancestry: `c1fd3cc` → `d9490ac` (Gate B GO) → `9edc70f`
(Stage 1–4 accepted) → `402d899` (Gate A GO) → `5738c0c` (design). The
`d9490ac..c1fd3cc` delta is exactly: Stage 5 product code
(`reverse-channel.mjs`, `reverse-session.mjs`, `route-proxy.mjs`,
`selector-view.mjs`, `server.mjs`, `registry.mjs`, node-side
`reverse-channels.mjs`), Stage 5 tests, the completion report, and the
Round 1/2 review records.

## 2. Fresh verification executed

### 2.1 Focused Stage 3–5 matrix (exact command from the completion report)

```text
tests    61
pass     61
fail     0
skipped  0
```

Matches the report exactly.

### 2.2 Full repository check

```text
npm run check
tests    470
pass     465
fail     0
skipped  5
exit     0
```

Matches the report exactly (465/5 = 470).

### 2.3 Hygiene / scope / security

```text
git diff --check (d9490ac..c1fd3cc): exit 0
public-tree validation: PASS (inside npm run check)
new insecure-TLS bypass scan (rejectUnauthorized/skipVerify/trust bypass): no match
new OS Root-store mutation scan (addstore/reg add): no match
generic tunnel / service mesh / automatic failover / remote shell scope scan: no match
residue check after review probes: 0 files (probe removed, tree back to HEAD state)
```

## 3. Round 2 P1-1 review — data channels now record their authenticating key

**CLOSED**

The exact remediation called for in Round 2 is present:

1. `src/registry/server.mjs` passes `auth.key.key_id` into
   `reverseChannels.registerChannel({ nodeId, keyId, sessionId, socket, ... })`
   for every data-channel upgrade (same source as the control upgrade).
2. `ReverseChannel` persists `this.keyId` for its lifetime.
3. `ReverseChannelManager.closeChannelsForCredential(nodeId, keyId, reason)`
   closes exactly the channels authenticated with that key and returns their
   ids; it is connection-scoped, not generation-scoped.
4. `ReverseSessionManager.closeSessionsForCredential(nodeId, keyId)` closes
   the current and pending sessions authenticated with that key and returns
   their session ids.
5. `registry.maintenance()` collects keys revoked by rotation-overlap expiry
   inside the DB transaction and fires
   `runtimeLifecycleHooks.onNodeCredentialRevoked({ nodeId, keyId, reason })`
   only after the transaction commits.
6. The Hub wires the hook to session close + exact-key channel close + per
   returned session-id channel close. All three paths are idempotent
   (`closed` flags guard double-close).

The legal mixed-key sequence from the Round 2 finding is closed:

```text
1. K_old and K_new accepted during overlap.                  (registry overlap)
2. Current control session authenticated with K_new.         (server registerUpgrade)
3. Data channel binds to that session but authenticates K_old.
4. K_old revoked by maintenance expiry.
5. onNodeCredentialRevoked(nodeId, K_old) fires post-commit.
6. closeSessionsForCredential sees current key K_new -> no match, K_new session survives.
7. closeChannelsForCredential(nodeId, K_old) closes the K_old data channel and its active browser flow.
```

The RFC D10 invariant (“every control/data connection records the node key ID
that authenticated its upgrade”; revoked key → matching sessions and channels
closed; node reconnects with its current key) is satisfied by construction at
the Hub boundary and no longer relies on the official node client’s credential
sequencing.

### Independent verification

In addition to reading the wiring, this round executed seven independent
seam-level probes written from first principles against the real managers
(not copied from the repo’s own tests). All passed:

- exact-key channel close closes only the K_old channel; K_new channels and
  other-node channels survive; double-close is a no-op;
- `closeSessionsForCredential` closes current + pending sessions authenticated
  with the revoked key only; a pending K_new session is untouched; the
  onSessionClosed callback receives the revoked reason;
- `closeChannelsForCredential`/`closeSessionsForCredential` are idempotent;
- maintenance fires the revoked hook exactly once for the expired key with the
  exact `{ nodeId, keyId, reason: "rotation-overlap-ended" }` triplet and does
  not re-fire on the next maintenance run.

### Round 2 required regression tests A–H

Covered by `test/v05-stage5-live-reverse-route.test.mjs`:

- A overlap control=K_new / data=K_old accepted → “mixed-key … revocation” (A)
- B revoke K_old → K_old channel closes immediately → same test
- C K_new control remains current → asserted post-revoke
- D K_new channels remain open → asserted post-revoke
- E active browser flow on K_old channel aborts immediately → browser socket
  close asserted after `registry.maintenance()`
- F new K_old data-channel upgrade denied after revocation → raw signed
  upgrade returns 401
- G pending/current control generations authenticated with K_old still close →
  “revoked old key cannot open a new reverse control session”
- H node/key isolation → K_new preservation asserted; manager close paths are
  keyed per nodeId, so other nodes cannot match (also covered by the mixed
  topology isolation test)

## 4. Round 2 P2-1 review — D9 pool availability is now mechanically represented

**CLOSED**

Round 2 left a P2: canonical D9 required “at least one data channel is
available: eligibility uses a non-destructive pool-availability predicate”,
while the round-1-remediated code had `void reverseChannels` — no predicate.

The remediated implementation chooses and records option 1 from the Round 2
disposition:

- `ReverseChannelManager.hasChannelForSession(nodeId, sessionId)` is a
  non-destructive, generation-bound predicate: it reports whether the current
  generation has **any registered** (non-closed) channel, regardless of
  idle/busy state.
- `evaluateRouteEligibility()` reverse branch requires it: zero registered
  channels → `eligible:false / reverse-capacity` (fail closed); one or more
  registered channels (even all busy) → eligible, and concrete flow assignment
  owns the bounded 2 s wait via `acquireChannel()`.

This does not reintroduce the Round 1 immediate-idle bug: idle count is never
consulted for eligibility; busy channels keep the node eligible and the
assignment waiter absorbs transient zero-idle windows. The choice is recorded
explicitly in the completion report §9, and the original RFC/Review provenance
is unchanged.

Independent seam probes passed:

- `hasChannelForSession` false with no channels, true with a busy channel,
  false after close, generation-bound (s1 ≠ s2);
- acquireChannel with zero channels waits ≥ the configured bound then throws
  `ReverseCapacityError` (never immediate);
- a channel registered mid-wait for the **same** session satisfies the waiter;
  a channel for a **different** session does not;
- takeover cancels old-generation waiters with `reverse-session-stale` and a
  new-generation waiter survives an old-generation takeover.

## 5. Round 1 items re-verified (no regression)

- HTTP and WebSocket reverse dispatch both reach `acquireChannel()` through
  `proxyReverseHttpRequest` / `proxyReverseWebSocketUpgrade`; eligibility does
  not consume a channel;
- selector `health.reachable` in reverse mode projects from the same
  `reverseSessionInfo.routeReady` source as eligibility (`ok` iff online AND
  routeReady); `registryContact` stays heartbeat-derived; direct mode keeps the
  RFC-0010 probe dimension;
- revoked old control key teardown, new-key reconnect, delete teardown,
  generation-bound waiter takeover — all green in the fresh suite;
- Gate C status wording remains `NOT REACHED` throughout the completion report.

## 6. Observations for the record (non-blocking)

1. The completion report’s “Current committed HEAD: `d9490ac`” and “no
   upstream configured” lines are now stale — the report predates
   `c1fd3cc`, which committed the work and the branch now tracks
   `origin/chore/v0.5-stage2-public-machine-ingress` at 0/0. The next
   Stage 6 material should restate the review target as `c1fd3cc`.
2. `resolveIdleWaiters()` satisfies one matching waiter per idle/registration
   event, so under a burst of concurrent flows the remaining waiters rely on
   subsequent idle events or the 2 s bound. This is consistent with the
   one-flow-per-channel model and D5; noted only to document the
   concurrency shape.
3. The server hook closes channels for the returned revoked session ids in
   addition to the `onSessionClosed` callback path; redundant but idempotent,
   and it keeps injected session managers (tests) correct without the hook.

None of these affect the Round 3 disposition.

## 7. NOT_EXECUTED / not authorized by this review

Unchanged from Round 2; still explicitly not executed or accepted:

- Stage 6 authenticated operator route-mode mutation;
- complete Stage 6 operator credential rotation/immediate-revoke UI/API lifecycle;
- Stage 6 reenroll same-node-ID + fresh Hub route identity qualification;
- Stage 6 UI/read-model operator workflow;
- Stage 7 hardening qualification matrix;
- exact frozen candidate-bound RFC-0012 D14 48-field matrix;
- candidate SHA freeze;
- clean/pushed candidate state;
- Gate C Candidate Review;
- Stage 8 canonical mounted topology / candidate-bound seven-artifact evidence;
- mounted/browser external Stage 5 acceptance;
- v0.5 Independent Final Review;
- tag/release publication;
- production promotion / DNS cutover.

## 8. Required next actions (recommended order)

1. Record this Round 3 review record (commit under the same branch).
2. Begin **Stage 6** operator lifecycle work per the SOP; Stage 6 is now
   authorized by this review.
3. Schedule **Gate C** only after Stage 6 and Stage 7 hardening with a frozen,
   pushed, identical local/remote candidate SHA and the 48-field matrix.
4. Do not begin Stage 8 mounted evidence before Gate C GO.

---

## Formal disposition

```text
Independent Stage 5 Review Round 3

Round 1:
3 x P1 CLOSED
1 x P2 CLOSED

Round 2:
1 x P1 CLOSED
1 x P2 CLOSED

Round 3:
P0 = 0
P1 = 0
P2 = 0

VERDICT:
PASS / ACCEPTED

Stage 5 accepted:
YES

Stage 6 authorized by this review:
YES

Candidate freeze:
NO (NOT AUTHORIZED)

Gate C:
NOT REACHED

Stage 8:
NOT AUTHORIZED
```