# Review Report — v0.6 Stage 4 (Outage Containment & Negative Security) — Gate 3

- Date: 2026-09-26
- Reviewer: independent code/architecture review (Gate 3)
- Workspace: `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate`
- Branch: `chore/v0.6-stage4-outage-containment`
- Reviewed commit (HEAD): `5dfa32c` — "test(security): add cross-node replay denial, cookie isolation, and outage containment tests (Stage 4)"
- Baseline (Stage 3 Gate B PASS): `3e56cf0` (confirmed ancestor of `5dfa32c`)
- Authorization lineage: `6748495` (V06-CONSTRUCTION-20260925-A1) confirmed ancestor of `5dfa32c`
- Verdict: **REVISE** (SOP vocabulary: PASS / REVISE / BLOCK)

---

## Review Scope

### Changed files (diff `3e56cf0..5dfa32c`)

| File | Δ | Nature |
| --- | --- | --- |
| `test/v06-stage4-outage-containment.test.mjs` | +668 (new) | 5 integration tests (replay denial, cookie isolation, outage containment, reverse disconnect, bounded resources) |

The Stage 4 commit is **test-only**: no `src/**`, `bin/**`, `ui/**`, or gateway config was touched. `git diff --check 3e56cf0..5dfa32c` is clean. The working tree is clean; no untracked probe/debug residue remains (the `test/zz-probe-multiframe.mjs` residue flagged at Gate B is gone).

### Contract surfaces examined

1. **RFC-0010 D5 / RFC-0013 D1** — deterministic route authority, ORBIT-ROUTE-V1 hop-by-hop signing, cross-node replay denial.
2. **RFC-0010 D7 / RFC-0013 D1** — strict per-node host-only cookie isolation (`Domain` attribute erasure).
3. **RFC-0013 D4/D5** — failure containment, zero cross-node failover, per-node channel-pool partitioning.
4. **SOP `docs/sop/v0.6-multi-node-sessions-multistage-sop.md`** §3 Stage 4 (Gate 3), §5 stop-work matrix (cross-node cookie sharing = security blocker).
5. **M24 matrix** rows #10 (`cookieJarIsolationConcurrent`), #12/#13/#14 (`nodeAOutage…`), #16 (`reverseChannelPoolIndependence`), #17 (`routeProofWrongNodeCrossDenied`), #18 (`noSilentCrossNodeFailover`), #20 (`multiNodeFlowTrackerAccurate`).

### Method

Read the real diff, the new test file in full, and the production code it exercises (`route-proxy.mjs` `sanitizeSetCookieHeader`/`sanitizeClientHeaders`/`proxyHttpRequest`/`proxyReverse*`, `route-auth.mjs` `verifyRouteRequest`, `reverse-channel.mjs` `executeReverse*`/`Flow`, `src/node/reverse-channels.mjs` `onChannelOpen`, `src/node/route-ingress.mjs`, `flow-tracker.mjs`, `server.mjs` routing/eligibility). Ran the focused suite, a 15× stability loop, the full `npm run check`, the public-tree check, ancestry checks, whitespace check, and targeted empirical probes of the cookie sanitizer against a live HTTP server + a real browser.

---

## Findings

### [P1] `sanitizeSetCookieHeader` does not strip whitespace-form `Domain` attributes — host-only isolation is bypassable

`src/registry/route-proxy.mjs:271-279`

```js
function sanitizeSingleCookie(cookieStr) {
  const parts = cookieStr.split(";");
  const filtered = parts.filter((part) => {
    const trimmed = part.trim();
    return !trimmed.toLowerCase().startsWith("domain=");
  });
  return filtered.join(";");
}
```

- **Trigger**: any downstream `Set-Cookie` whose Domain attribute carries whitespace before `=`, e.g. `sid=SECRET; Domain = .v06-security.example; Path=/` or `sid=SECRET; Domain\t=.v06-security.example; Path=/`.
- **Observed** (executed in this review):

  | Input | Output |
  | --- | --- |
  | `sid=SECRET; Domain=.v06-security.example; Path=/` | `sid=SECRET; Path=/` (stripped) |
  | `sid=SECRET; Domain = .v06-security.example; Path=/` | `sid=SECRET; Domain = .v06-security.example; Path=/` (**not stripped**) |
  | `sid=SECRET; Domain\t=.v06-security.example; Path=/` | unchanged (**not stripped**) |

- **Why it matters**: RFC 6265 §5.2 parses each Set-Cookie attribute by splitting on the first `=` and **trimming leading/trailing whitespace from the attribute name**, so `Domain = .x` is a legitimate `Domain` attribute for every compliant user agent. I confirmed with a spec-compliant cookie engine (libcurl) that a cookie set on `a.lvh.me` as `Domain = .lvh.me` is stored as a domain cookie and is subsequently sent to `b.lvh.me` (`{"host":"b.lvh.me:8802","cookie":"leakCookie=SECRET_A"}`). Direct Firefox confirmation was blocked by the environment's HTTP proxy (it returned 502 for the `lvh.me` hosts), so browser-level honoring is **unverified here**; the RFC text and the compliant-engine result both indicate it is honored.
- **Impact**: a compromised or merely non-canonical node DSH can emit a `Domain`-scoped cookie for the shared parent `.routeDomain`. That cookie is then attached by the browser to *every other node's* route authority, defeating the RFC-0013 D1 host-only isolation invariant and enabling cross-node credential leakage / session confusion — exactly the class of failure Gate 3 is chartered to prove impossible, and which SOP §5 lists as a security blocker. The same helper is used on all three egress paths (`route-proxy.mjs:638,961,1013`, `reverse-channel.mjs:106`, `src/node/reverse-channels.mjs:61`, `src/node/route-ingress.mjs:508,555`), so the gap is uniform.
- **Minimal fix**: parse each attribute as `name [WS] = [WS] value` and drop it when the *name* (trimmed, lowercased) equals `domain`, e.g. match `^domain\s*=` after trimming; or split on the first `=` per attribute rather than requiring an exact `domain=` prefix.

### [P2] The cookie-isolation test is tautological and does not prove cross-node isolation

`test/v06-stage4-outage-containment.test.mjs:501-527`

The "browser origin cookie isolation" step hand-injects a `cookie` header per node and asserts the fixture echoes it back:

```js
const inspectA = await requestHttp({ ..., host: env.authA, path: "/inspect-cookies",
  headers: { cookie: "session_direct-a=secret_direct-a; pref_direct-a=dark" } });
...
assert.match(dataA.cookieHeader, /session_direct-a=secret_direct-a/);
assert.doesNotMatch(dataA.cookieHeader, /session_reverse-b/);
```

- **Why it is not evidence**: no cookie jar exists. The test never lets the browser (or any jar) decide which cookies to attach; it supplies Node A's cookie to Node A and Node B's cookie to Node B, then asserts the value arrived. `doesNotMatch(/session_reverse-b/)` passes **trivially** because the request only ever carried Node A's cookie. The same test would pass even if the Hub blindly forwarded any `Cookie` header to any node, so it cannot detect the isolation regression it purports to guard.
- **Impact**: M24 field #10 `cookieJarIsolationConcurrent` and the task claim "模拟浏览器请求验证…杜绝跨节点凭据窃取" are not substantiated by this test. Combined with Finding P1, the negative-security evidence for cookie isolation is effectively absent.
- **Minimal fix**: either (a) drive a real jar (e.g. persist `Set-Cookie` from a Node A response and re-send it on a Node B request, asserting the server sees no Node A cookie — which is only meaningful with the sanitizer fixed), or (b) at minimum add a unit assertion that a whitespace-variant `Domain` is stripped, plus a cross-authority test proving a Node-A-scoped cookie value never reaches Node B.

### [P3] Cross-node replay cases 1a–1c test the library, not Node B's live ingress/reverse OPEN path

`test/v06-stage4-outage-containment.test.mjs:393-450`

Cases 1a–1c call `verifyRouteRequest(...)` directly with a hand-rolled `getPublicKey`. They validate the shared verifier function in isolation; they do not exercise Node B's actual `RouteIngress.handleRequest` or the reverse transport's `ReverseChannelPool.onChannelOpen` proof check (`src/node/reverse-channels.mjs:352-376`), which is the realistic path a foreign proof would travel. Case 1d does hit a live ingress over HTTP, but only re-uses the same tampered header set. No Stage 4 test submits a Node-A-signed proof through Node B's live ingress or reverse channel and asserts the on-wire `401 node-mismatch` / `authority-mismatch` / `unknown-key` denial.

- **Impact**: the "cross-node replay denial" claim rests on a unit-level check. The end-to-end denial is partially covered by pre-existing tests (`test/stage2-hub-route-identity.test.mjs:366`, `test/stage4-websocket-routing.test.mjs:523`), so the risk is a coverage/attribution gap rather than a live defect.
- **Minimal fix**: add one end-to-end case that pushes a Node-A proof into Node B's live ingress (and, ideally, a foreign proof into a reverse channel OPEN) and asserts the deployed denial.

---

## Verification

All checks below were executed in this review.

| Check | Command | Result |
| --- | --- | --- |
| Focused Stage 4 suite | `node --test test/v06-stage4-outage-containment.test.mjs` | 5 tests, 5 pass, 0 fail |
| Stage 4 stability | 15 consecutive runs of the focused suite | 15/15 runs pass, 0 fail |
| Full suite (regression) | `npm run check` | 538 tests, 532 pass, 0 fail, 6 skipped; exit 0 |
| Public-tree check | `node scripts/check-public-tree.mjs` | "Public-tree validation passed.", exit 0 |
| Whitespace | `git diff --check 3e56cf0..5dfa32c` | clean |
| Worktree hygiene | `git status --porcelain` / `git ls-files --others --exclude-standard` | clean; no untracked residue |
| Ancestry | `git merge-base --is-ancestor 3e56cf0 5dfa32c`; `... 6748495 5dfa32c` | both OK |
| Cookie sanitizer probe | direct `sanitizeSetCookieHeader` on canonical vs whitespace/tab variants | canonical stripped; `Domain =` / `Domain\t=` **not** stripped |
| Compliant-engine behavior | live HTTP server + libcurl jar: `Domain = .lvh.me` set on `a.lvh.me`, read on `b.lvh.me` | cookie leaked cross-subdomain (`leakCookie=SECRET_A`) |
| Browser behavior | Firefox (via firefox-devtools MCP) against `lvh.me` hosts | **unverified** — environment HTTP proxy returned 502 for those hosts |

Read-only reasoning additionally confirmed: per-node channel partitioning (`reverse-channel.mjs:551-552`, `channels`/`idleWaiters` keyed by `nodeId`); no cross-node failover (`server.mjs:350-372`/`1173-1199` dispatch to exactly one `snapshot.nodeId`; ineligibility returns 503 `node-unavailable`); fail-closed capacity (`ReverseCapacityError` → 503); flow-tracker accounting is per-node and idempotent (`flow-tracker.mjs`).

Not executed / not claimed: any mounted two-node live run, container crash/restart drills, or browser-jar cross-node leakage on the real route domain (Stage 6 mounted fields per SOP). The outage tests here are in-process integration substitutes, not mounted evidence.

---

## Residual Risks

- **Browser-level cookie behavior is unverified** (Finding P1). The environment proxy blocked browser access to the `lvh.me`/`nip.io` test hosts, so the P1 severity rests on RFC 6265 parsing semantics plus a compliant-engine (libcurl) reproduction. If a specific browser were shown to reject `Domain = value`, P1 would downgrade to P2; the sanitizer gap itself is real regardless.
- The Stage 4 outage tests run in a single process; they do not cover true container/process crash semantics, OS-level socket teardown, or Hub restart (M24 #12–#15, #19 are **mounted** and remain NOT_EXECUTED until Stage 6).
- The "Node A outage while Node B streams" test exercises only 20 small echo frames; it does not stress sustained high-throughput or large-payload streaming during the outage. M24 #9/#12 remain to be proven at Stage 6.
- `test/v06-stage4-outage-containment.test.mjs:664` reaches into `hub.reverseChannels.channels` internals; a future refactor of the pool's internal shape would break the test rather than the product.

---

## Gate

**REVISE**

Rationale: the Stage 4 commit is a clean, focused, test-only change; all 5 new tests pass and are stable (15/15), the full 538-test suite and public-tree check pass with no regression, ancestry and hygiene are clean, and the outage-containment / flow-tracker / no-failover behaviors hold on inspection and under the new tests. However, Gate 3's negative-security mandate is not met: (1) the host-only cookie invariant is bypassable through whitespace-form `Domain` attributes in `sanitizeSetCookieHeader` (P1) — a direct violation of an invariant the SOP classifies as a security blocker; and (2) the cookie-isolation test that is supposed to prove that invariant is tautological and cannot detect the regression (P2). These must be resolved before Gate 3 can pass. No P0 was found and no cross-node failover, channel sharing, or fail-open routing path was identified.

Required before re-review: fix the sanitizer (P1) and replace/strengthen the cookie-isolation evidence (P2); P3 is non-blocking but recommended.

---

## Review Report

Path: `D:\App\01_Ai\CodeX\dsh-orbit-v05-formal-candidate\docs\review\2026-09-26-v06-stage4-outage-containment-gate3-5dfa32c.md`
