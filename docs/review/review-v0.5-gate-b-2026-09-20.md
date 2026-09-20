# DSH Orbit v0.5 Gate B Review — Reverse Transport / Security Review (Stages 1–4)

Date: 2026-09-20

Review target:

- Branch: `chore/v0.5-stage2-public-machine-ingress` (linear: Stage 1 `045d3e3` → Stage 2 `2733571` → Stage 3 `ee8e84e` → Stage 4 `9dc12d5`)
- Accepted Stage 0 design baseline: `5738c0ce6a4ec11bee62f9cfae44dd6463816768` (Gate A GO `402d899`)
- Review scope: `git diff 5738c0c..9dc12d5` (24 files, +5549/−31)
- Remote state at review: `9dc12d5100f3b3c7a1058e3f36bc10086c77ff51` (local=remote, divergence 0/0)
- Gate: Gate B — reverse transport/security review (SOP: STOP after Stage 4)

## Round 1 verdict: HOLD (P0: 1, P1: 2, P2: 5)

The review independently verified the eight Gate B inspection items. Passing: pairing/public ingress attack surface (rate limits, digest-only tokens, exact gateway allowlist mechanically asserted, enroll never public), control generation/takeover, channel pool bounds, ORBIT-ROUTE-V1 library-level reuse, no-general-tunnel invariant, and migration/regression impact (full check 444/439/0/5, direct mode green).

Findings:

- **[P0-1]** D7 backpressure was ineffective in the node→hub response direction: the hub drained the channel socket eagerly into an unbounded `Flow.bodyQueue`, so TCP backpressure never reached the node and the 2 MiB hard cap could never trigger. Hub memory grew with the full response size (OOM vector for large/slow flows once wired into the route proxy).
- **[P1-1]** The Stage 4 channel pool was never wired into the real node runtime (`ReverseChannelPool` imported but not instantiated; `ReverseClient` received no `channelPool` and shared no nonce cache) — reverse HTTP could not flow through a real node, and the D6.1 shared-cache invariant had no runtime instantiation. Spawn-level Stage 4 live evidence was absent.
- **[P1-2]** `https` was referenced without import in `reverse-client.mjs` and `reverse-channels.mjs` — an https DSH target (a supported configuration) would crash the node process via unhandled rejection.
- **[P2-1..6]** Debug log leftover in production code; pong-timeout detection granularity (20–40s worst case instead of the fixed 10s); session-message pool bounds not connected to manager configuration; hub-side OPEN header sanitation not implemented (cookie/assertion could reach DSH once wired into Stage 5); `requestId` entropy below the D6.1 128-bit spec.

## Remediation: `9edc70faecae20e73258a42ecb78c0c7347edc35`

- **P0-1**: receive-side bounds added to `Flow` (queuedBytes accounting, soft-mark `socket.pause()`, resume below 256 KiB, 2 MiB hard cap → `flow-overrun`, 30s no-consumption stall → `flow-stall`; aborted flows fail closed, never retried). New numeric D7 tests (`test/v05-stage4-d7-bounds.test.mjs`) inject small limits and drive all three abort paths with exact error codes.
- **P1-1**: the CLI now constructs `ReverseChannelPool` sharing the SAME `sharedRouteNonceCache` instance as the route ingress (with the disabled-ingress semantics documented) and passes it as `ReverseClient.channelPool`. New spawn-level live evidence (`test/v05-stage4-live-reverse-http.test.mjs`): a real node daemon serves DSH root/API/static, a 256 KiB streaming upload, and a 4-flow concurrent burst across 4 distinct channels with pool recovery.
- **P1-2**: `https` imported in both files.
- **P2-1..5**: debug log removed; pong deadline is a per-ping one-shot 10s timer; pool bounds flow from the channel manager through the session manager into the session message; OPEN header sanitation (RFC-0010 parity: `x-orbit-*`, `x-dsh-*`, cookie, authorization, connection, proxy-*) implemented in `executeReverseHttp` with an assertion test; `requestId` is 128-bit random hex.
- **Author-found concurrency defect** (beyond the review): `acquireChannel` had an await gap between claiming and marking busy, allowing concurrent flows to receive the same channel (violating 1 channel = 1 flow). Fixed with a synchronous atomic claim (`claimIdleChannel`); the burst evidence asserts 4 concurrent flows land on 4 distinct channels. The pool replenisher also now counts `connecting` channels, preventing a connection storm during handshakes.

## Round 2 verdict: **GO** (P0: 0, P1: 0, P2: 2)

Independent re-review verified the full remediation diff (`9dc12d5..9edc70f`, 8 files +787/−31), re-ran the six v0.5 suites and the full check (448 tests, 443 pass, 0 fail, 5 skipped), and confirmed the invariant set unchanged (no route-proxy/selector changes; Stage 5 boundary preserved).

Residual non-blocking items carried into Stage 5 as prerequisites:

1. **P2-1**: response-direction stall currently aborts on ANY non-zero queued data stalled 30s — stricter than D7's "while above the soft mark". Fix by limiting the stall check to `queuedBytes >= softMarkBytes` (or fix both directions and record the chosen semantics).
2. **P2-2**: the response half of matrix field 31 (`cookieIsolationReverse`) — the reverse response adapter must apply `sanitizeSetCookieHeader` (the existing route-proxy helper) with assertion tests, before Stage 5 lands.

## Gate B disposition

- P0 = 0 / P1 = 0: yes (round 2).
- Non-blocking P2 items are recorded and tracked as Stage 5 prerequisites.

**Gate B GO — Stage 1–4 construction HEAD accepted: `9edc70faecae20e73258a42ecb78c0c7347edc35`. Stage 5 (WebSocket parity + RFC-0010 route integration) is authorized to begin with the two prerequisites above.**
