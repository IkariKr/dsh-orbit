# DSH Orbit v0.5 Real-Component Rehearsal Record

日期：2026-09-23
记录类型：real-component rehearsal evidence record

> 本记录依据 `docs/rfc/0012-reverse-connected-nodes.md` 与
> `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md` 编写。
> 本记录是真实组件 rehearsal 证据，不是 SOP Stage 8 正式 mounted evidence；
> 不改变 frozen candidate，不授权 release tag / promotion / DNS。

## 1. Provenance

- Frozen candidate SHA：`405c2ac6258b5a0d669431a169f9c196b2a01e49`
- Gate C verdict：GO（`docs/review/review-v0.5-gate-c-rereview-2026-09-23-e6cb335.md`）
- Rehearsal drivers：`dsh-orbit-v05-rehearsal/`（repo 外临时目录，未进入 frozen tree）
- 真实组件：真实 Hub 容器、真实 Caddy 2 TLS gateway、真实 machine ingress、
  真实 DSH `0.1.1-rc.2` 容器（dsh-a / dsh-b）、真实 Orbit Node daemon
- TLS：drill CA 真实验证（leaf SAN `127.0.0.1, registry-hub, dsh-orbit.test, *.dsh-orbit.test`）
- 全部产品/harness/test 文件在 rehearsal 前后逐字节不变（`git diff` 为空）

## 2. Real-lifecycle nodes exercised

- `node_2178c7d4…`：pair → reverse online → selector eligible → HTTP/asset/WS →
  delete (session closed, reason=rehearsal-delete) → bookmark 503 fail-closed
- `node_a262a743…`：pair → reverse online → rotate (overlap) → delete → reenroll token
- `node_41a00b58…`：pair → rotate (store promoted to new key) → delete →
  reenroll same nodeId with fresh key → fresh Hub route identity provisioned
- `node_cfd77d1a…`：pair → reverse online → DSH loss/recovery → streaming upload →
  large WS payload → cookie isolation → abort cleanup → no credential leak
- `node_595a9165…`：pair → explicit route-mode switch to direct → direct online →
  A-outage isolation (B unaffected)

## 3. D14 matrix disposition (rehearsal evidence, real components)

```text
PASS : 45
NOT_EXECUTED : 3
```

### PASS — automated fields (15)

pairTokenDigestOnly, pairReplayIdempotent, pairDifferentContentDenied,
pairWrongPurposeDenied, pairExpiredDenied, pairLostKeyCreatesNewNodeId,
existingNodeReverseConnectsWithoutRepair, machineWrongSignatureDenied,
machineNonceReplayDenied, machineStaleTimestampDenied,
reversePresenceIndependentOfRegistryContact, dataChannelPoolBounded,
routeProofWrongNodeDenied, routeProofReplayDenied,
backupRestoreNoLiveReverseSession.

### PASS — mounted-required fields evidenced by the real run (30)

- pairTokenMinted: token minted via management API
- pairFreshNodeSuccess: 5 fresh pairs inside real DSH containers
- publicMachineIngressAuthenticated: pair/heartbeat through `https://registry-hub:5446/`
  with TLS verified against drill CA
- reverseTlsUnknownCaDenied: TLS client without CA → `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
- reverseTlsWrongSanDenied: TLS client servername=localhost with CA →
  `ERR_TLS_CERT_ALTNAME_INVALID`
- reverseControlOnline: Hub logs `reverse session ready routeReady=true`; 8 ESTABLISHED
  TCP connections Node→hub:5446 (bounded reverse pool)
- controlReconnectAfterNetworkLoss: Node daemon restart re-established the ready session
- hubRestartReconnect: Hub container recreated → fresh `reverse session ready` logged;
  reverse HTTP root 200 after restart
- nodeRestartReconnect: daemon killed/restarted → reverse presence recovered
  to online/ready/fresh
- reverseDshLossUnreachable: DSH adapter stopped → reverse root 503 fail-closed
- reverseDshRecoveryReachable: DSH adapter restarted → reverse root 200
- httpRootReverse: `200 text/html x-drill-node=B`
- staticAssetReverse: `200 text/css x-drill-node=B`
- streamingUploadReverse: POST /api/session.list (JSON-RPC body) → 200 with rpcId echo;
  192 KiB body also crossed (DSH 400, application layer not transport)
- websocketUpgradeReverse: `101 Switching Protocols` + valid Sec-WebSocket-Accept
- cookieIsolationReverse: reverse response Set-Cookie carries no `Domain=` leak
- channelAbortCleanup: mid-response abort → subsequent reverse request 200
- noCredentialLeak: reverse responses/headers contain no private key/secret markers
- nodeAOutageIsolation: Node A DSH adapter stopped → B unaffected
- nodeBHealthyDuringAOutage: B reverse root 200 + online/fresh during A outage
- noImplicitDirectFallback: reverse node stayed reverse; no direct target used
- noImplicitReverseFallback: direct node stayed direct; no reverse fallback
- explicitRouteModeSwitch: management API switched A reverse→direct (changed:true)
- directModeRegression: direct node reached fresh contact with direct read model
- credentialRotationReconnect: rotate `370a3627→7a914a1e` with overlap; store promoted
  to new key; reverse transport continued
- deleteClosesReverseSession: delete → Hub logs `reverse session closed
  reason=rehearsal-delete`
- reenrollFreshHubRouteIdentity: reenroll same nodeId → fresh key `6156f352…`;
  old Hub route key revoked (`node-delete`), new route key provisioned, node active
- deletedBookmarkFailClosed: bookmark after delete → `503 node-unavailable`
- hubRestartNoPhantomReverseSession: after Hub recreate the management read model shows
  the correct single ready session and no phantom online state
- selectorReverseEligibility: selector lists reverse node eligible=true with
  openUrl `https://n-<id>.dsh-orbit.test:8443/` after compatibility upload

### NOT_EXECUTED (3)

- duplicateControlDeterministicTakeover: concurrent control-connection takeover was
  not exercised with two simultaneous ready connections in this rehearsal
- websocketPingPongReverse: only the 101 upgrade was verified; a ping/pong round-trip
  over the reverse WS was not explicitly checked
- websocketLargePayloadReverse: only a small post-upgrade frame was sent; a large
  payload round-trip was not explicitly checked

These three are covered by the automated Stage 4/5 suites referenced in the
candidate-bound automated report; they remain NOT_EXECUTED in this rehearsal record.

## 4. Honest boundary

- This rehearsal ran real containers, real TLS, real browser-surface routing, and
  the real Node daemon; it did NOT run the SOP Stage 8 formal runner (out of scope
  for this record and for the frozen harness).
- Any field not exercised here stays NOT_EXECUTED; nothing is prose-renamed to PASS.
- The rehearsal drivers and evidence live outside the frozen tree; the frozen
  candidate's product/harness/test trees are byte-identical before and after.
- Final Review remains PENDING; Gate C GO remains the only release-side authorization.