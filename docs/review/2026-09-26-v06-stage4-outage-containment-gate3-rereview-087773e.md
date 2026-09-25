# Review Report — v0.6 Stage 4 (Outage Containment & Negative Security) — Gate 3 Re-Review

- Date: 2026-09-26
- Reviewer: independent code/architecture review (Gate 3 re-review)
- Workspace: `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate`
- Branch: `chore/v0.6-stage4-outage-containment`
- Reviewed commit (HEAD): `087773e` — "fix(security): sanitize Set-Cookie domain whitespace variants and harden cookie jar and replay denial verification"
- Prior reviewed commit: `5dfa32c` (Gate 3 REVISE)
- Baseline (Stage 3 Gate B PASS): `3e56cf0` (confirmed ancestor of `087773e`)
- Authorization lineage: `6748495` (V06-CONSTRUCTION-20260925-A1) confirmed ancestor of `087773e`
- Verdict: **PASS** (P0=0, P1=0, P2=0)

---

## Review Scope

### Changed files (diff `3e56cf0..087773e`)

| File | Δ | Nature |
| --- | --- | --- |
| `src/registry/route-proxy.mjs` | +6 / -3 | P1 fix: `sanitizeSingleCookie` now trims each attribute and drops any `^domain\s*(=|$)` match |
| `test/v06-stage4-outage-containment.test.mjs` | +848 (new) | P2 fix (real-jar isolation + counter-factual) and P3 fix (live ingress 1e / live reverse OPEN 1f) |
| `docs/review/2026-09-26-v06-stage4-outage-containment-gate3-5dfa32c.md` | +141 (new) | Prior Gate 3 REVISE report (documentation) |

The fix commit is narrowly scoped: one production helper plus its tests. No `bin/**`, `ui/**`, gateway config, or unrelated source was touched. `git diff --check` is clean for both `3e56cf0..087773e` and `5dfa32c..087773e`. Working tree is clean; no untracked residue.

### Contract surfaces examined

1. **RFC-0010 D7 / RFC-0013 D1** — strict per-node host-only cookie isolation (all `Domain` attribute forms erased on every egress path).
2. **RFC-0010 D5 / RFC-0013 D1** — deterministic route authority, ORBIT-ROUTE-V1 hop-by-hop signing, cross-node replay denial at live ingress and reverse-channel open.
3. **SOP `docs/sop/v0.6-multi-node-sessions-multistage-sop.md`** §3 Stage 4 (Gate 3), §5 stop-work matrix (cross-node cookie sharing = security blocker).
4. **M24 matrix** rows #10 (`cookieJarIsolationConcurrent`), #16 (`reverseChannelPoolIndependence`), #17 (`routeProofWrongNodeCrossDenied`), #18 (`noSilentCrossNodeFailover`), #20 (`multiNodeFlowTrackerAccurate`).

### Method

Read the real diff, the full test file, and the production code the tests exercise (`route-proxy.mjs` `sanitizeSetCookieHeader`/`sanitizeSingleCookie` and its six call sites; `route-auth.mjs` `verifyRouteRequest`; `src/node/route-ingress.mjs` `handleRequest`/`forwardToDsh`; `src/node/reverse-channels.mjs` `onChannelOpen`/`closeChannel`/`serializeResponseHeaders`; `src/registry/reverse-channel.mjs` `responsePairs`; `protocol.mjs` `computeRouteAuthority`). Executed the focused suite, a 10× stability loop, the related Stage 2/3/4 suites, the full `npm run check`, the public-tree check, ancestry/whitespace/hygiene checks, and targeted empirical probes of the sanitizer plus an independent reproduction of the old-vs-new jar detection power.

---

## Findings

No P0, P1, P2, or P3 findings.

### Prior findings — closure verification

**P1 (previous) — `sanitizeSetCookieHeader` did not strip whitespace-form `Domain` attributes.** CLOSED.

`src/registry/route-proxy.mjs:271-281` now reads:

```js
function sanitizeSingleCookie(cookieStr) {
  if (typeof cookieStr !== "string") return cookieStr;
  // Split cookie attributes by semicolon; RFC 6265 §5.2 attribute parsing
  const parts = cookieStr.split(";");
  const filtered = parts.filter((part, index) => {
    if (index === 0) return true;
    const trimmed = part.trim();
    return !/^domain\s*(=|$)/i.test(trimmed);
  });
  return filtered.join(";");
}
```

Independently reproduced in this review (executed against the shipped module):

| Input | Output | Verdict |
| --- | --- | --- |
| `sid=SECRET; Domain=.x; Path=/` | `sid=SECRET; Path=/` | stripped |
| `sid=SECRET; Domain = .x; Path=/` | `sid=SECRET; Path=/` | stripped |
| `sid=SECRET; Domain\t= .x; Path=/` | `sid=SECRET; Path=/` | stripped |
| `sid=SECRET; domain   =example; Secure` | `sid=SECRET; Secure` | stripped |
| `sid=SECRET; Domain; HttpOnly` | `sid=SECRET; HttpOnly` | stripped |
| `sid=SECRET; domain=; Path=/` | `sid=SECRET; Path=/` | stripped |
| `sid=SECRET; DOMAIN =foo; SameSite=Strict` | `sid=SECRET; SameSite=Strict` | stripped |
| `sid=SECRET; Domain\v= .x; Path=/` | `sid=SECRET; Path=/` | stripped |
| `sid=SECRET; Domain\f= .x; Path=/` | `sid=SECRET; Path=/` | stripped |
| `sid=SECRET; Domain\u00a0= .x; Path=/` | `sid=SECRET; Path=/` | stripped |
| `domain=val; Domain = .sub.example.com; Path=/` | `domain=val; Path=/` | cookie named `domain` preserved; attribute stripped |
| `a=1; domainfoo=bar; Path=/` | unchanged | look-alike not over-stripped |
| `a=1; subdomain=x; Path=/` | unchanged | look-alike not over-stripped |
| `a=1; DomainPath=x; Path=/` | unchanged | look-alike not over-stripped |

The regex `^domain\s*(=|$)` matches the RFC 6265 §5.2 attribute-name form (name trimmed, case-insensitive, whitespace allowed before `=` or as a bare attribute) while the `index === 0` guard keeps the always-required `name=value` pair (so a cookie literally named `domain` survives). All six egress call sites share the helper (`route-proxy.mjs:640,963,1015`; `route-ingress.mjs:508,555`; `reverse-channel.mjs:106`; `reverse-channels.mjs:61`), so the closure is uniform.

**P2 (previous) — cookie-isolation test was tautological.** CLOSED.

The test now parses the *actual* sanitized `Set-Cookie` wire headers end-to-end (from both Node A direct and Node B reverse responses through the Hub), loads them into a `BrowserCookieJar` simulator (`test/v06-stage4-outage-containment.test.mjs:373-431`), asserts every stored cookie has `isHostOnly === true` (lines 658-660), and derives the outgoing `cookie` header from `jar.getCookieHeader(host)` per node. It no longer hand-injects a cookie header, so the `doesNotMatch` assertions are no longer trivially satisfied.

The counter-factual (lines 704-707) is real, not decorative. I independently reproduced the jar's detection power against the old vs. new sanitizer using the same three fixture headers the test now sends (`Domain = .x`, `Domain\t= .x`, `domain   = .x`):

```
OLD sanitizer -> isHostOnly: [false, false, false] -> would leak: session_direct-a, pref_direct-a, flag_direct-a
NEW sanitizer -> isHostOnly: [true,  true,  true ] -> would leak: (none)
```

i.e. with the pre-fix sanitizer this test fails, and with the fix it passes — it genuinely guards the P1 regression.

**P3 (previous) — cross-node replay cases only tested the library.** CLOSED.

- Case 1e (lines 543-576) starts a live `RouteIngress` for Node B and posts Node A's valid proof over real HTTP to Node B's ingress port, asserting `401` with `error.code === "node-mismatch"`, and posts the tampered (Node-B-node-id / Node-A-signature) proof, asserting `401` with `error.code === "unknown-key"`. This matches the production path: `route-ingress.mjs:233-247` returns `authResult.status` with `error.code`, and `verifyRouteRequest` yields `node-mismatch` (line 139-141) and `unknown-key` (line 143-146) respectively.
- Case 1f (lines 578-605) drives the online `ReverseChannelPool.onChannelOpen` with Node A's proof (authority = Node B, proof nodeId = Node A), asserting `sendClose(1008)` and an `abort` message with `code === "node-mismatch"`. This matches `reverse-channels.mjs:360-376` (`authResult.code` → abort → `sendClose(1008, "proof-denied")`).

---

## Verification

All checks below were executed in this review.

| Check | Command | Result |
| --- | --- | --- |
| Focused Stage 4 suite | `node --test test/v06-stage4-outage-containment.test.mjs` | 6 tests, 6 pass, 0 fail |
| Stage 4 stability | 10 consecutive runs of the focused suite | 10/10 pass, 0 fail |
| Related suites | `node --test test/stage2-hub-route-identity.test.mjs test/stage4-websocket-routing.test.mjs test/stage3-concurrent-routing.test.mjs` | 22 tests, 22 pass, 0 fail |
| Full suite (regression) | `npm run check` | 539 tests, 533 pass, 0 fail, 6 skipped; exit 0 |
| Public-tree check | `node scripts/check-public-tree.mjs` | "Public-tree validation passed.", exit 0 |
| Whitespace | `git diff --check 3e56cf0..087773e`; `git diff --check 5dfa32c..087773e` | clean |
| Worktree hygiene | `git status --porcelain`; `git ls-files --others --exclude-standard` | clean; no untracked residue |
| Ancestry | `git merge-base --is-ancestor 3e56cf0 087773e`; `... 6748495 087773e` | both OK |
| Sanitizer probe | direct `sanitizeSetCookieHeader` on canonical, whitespace, tab, `\v`, `\f`, `\u00a0`, casing, bare, empty, and look-alike inputs | all Domain variants stripped; look-alikes preserved; `domain`-named cookie preserved |
| Jar detection power | old vs. new sanitizer fed through the test's jar parser on the three fixture headers | OLD leaks all three (non-host-only); NEW leaks none |
| Skipped tests identified | `grep` on `test/*.mjs` | 6 skips are pre-existing (`snapshot-contract.test.mjs:56`, `v05-stage7-contract-gaps.test.mjs:481`), unrelated to this change |

Note: a bare `node --test test/` invocation errors on this Node build (`MODULE_NOT_FOUND` for the `test` path argument); this is an invocation artifact, not a test failure. The project's own `npm run check` (bare `node --test`) is the correct entry point and passes with exit 0.

Read-only reasoning additionally re-confirmed for this range: `onChannelOpen` denial branches run before any `channel.socket` use and `closeChannel` early-returns for the mock channel (not in the pool's channel set), so Case 1f is crash-free; `verifyRouteRequest` reserves the nonce only after successful authentication (so rejected proofs cannot poison the nonce cache); no cross-node failover or channel sharing path was introduced.

---

## Residual Risks

- The cookie-isolation evidence uses an in-process `BrowserCookieJar` simulator, not a real browser cookie store. The simulator's attribute parser is a faithful RFC 6265 §5.2 subset, and the counter-factual proves it is live, but browser-vendor quirks remain outside this test's reach. Browser-level cross-authority behavior on the real route domain is **unverified** here and is a mounted concern for Stage 6 (M24 #10 is a `mounted` field).
- Case 1f invokes `ReverseChannelPool.onChannelOpen` directly with a mock channel rather than pushing a real `{"type":"open"}` frame over the WebSocket wire. The production denial logic exercised is identical (the same method `onChannelText` dispatches to), but the frame-parsing/dispatch layer itself is not traversed by this case. Non-blocking.
- The Stage 4 outage tests remain single-process integration substitutes; they do not cover true container/process crash semantics, OS-level socket teardown, or Hub restart. M24 mounted rows (#12–#15, #19) remain NOT_EXECUTED until Stage 6.
- The "Node A outage while Node B streams" test exercises only 20 small echo frames; sustained high-throughput / large-payload streaming during an outage is not stressed (M24 #9/#12 remain Stage 6).
- `test/v06-stage4-outage-containment.test.mjs:843` reaches into `hub.reverseChannels.channels` internals; a future pool refactor would break the test rather than the product.

---

## Gate

**PASS**

Rationale: the fix commit is a clean, narrowly scoped change that closes all three prior Gate 3 findings. P1: the sanitizer now strips every RFC 6265 §5.2 whitespace/casing/bare/empty `Domain` variant while preserving the cookie's own `name=value` pair and not over-stripping look-alike attributes — verified by direct probe of the shipped module. P2: the cookie-isolation test now parses real end-to-end `Set-Cookie` headers into a jar, asserts strict host-only storage, and includes a counter-factual whose detection power I independently reproduced (old sanitizer fails, new passes). P3: live Node B ingress and live reverse-channel-open denial are now exercised and match the production denial codes. Full suite `npm run check` passes (539 tests, 0 fail, exit 0), the focused suite is stable 10/10, ancestry, hygiene, whitespace, and public-tree checks are clean, and no new P0/P1/P2/P3 issue was found. No cross-node failover, channel sharing, or fail-open path was identified.

Non-blocking residual risks (browser-level cookie behavior and true mounted/container-crash semantics) are explicitly deferred to Stage 6 per SOP and do not block Gate 3.

---

## Review Report

Path: `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate\docs\review\2026-09-26-v06-stage4-outage-containment-gate3-rereview-087773e.md`
