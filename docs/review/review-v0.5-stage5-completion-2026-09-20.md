# DSH Orbit v0.5 Stage 5 完工报告

日期：2026-09-21
报告类型：Stage 5 construction completion report，Round 1 与 Round 2 findings remediated，提交 Independent Round 3 review；书面状态：**ROUND 2 REMEDIATION VERIFIED / REVIEW REQUESTED**

> 本报告对照 `docs/rfc/0012-reverse-connected-nodes.md` 和
> `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md` 编写。
> 本报告不是 Gate C GO，不是 candidate freeze，也不授权 Stage 8 mounted evidence。
> Stage 5 本地施工验证完成后停止施工，等待独立 review。

## 1. Review target 与授权边界

- Repository/worktree：`dsh-orbit-v05-stage1`
- Branch：`chore/v0.5-stage2-public-machine-ingress`
- Accepted Stage 0 design baseline：`5738c0ce6a4ec11bee62f9cfae44dd6463816768`（Gate A GO 记录于 `402d899`）
- Gate B 已授权 Stage 5 开始：`docs/review/review-v0.5-gate-b-2026-09-20.md`，Stage 1–4 accepted construction HEAD 为 `9edc70faecae20e73258a42ecb78c0c7347edc35`
- Current committed HEAD：`d9490aca1d33f3b093dc9da7733434bc4d817c5d`
- Same-name remote ref：`d9490aca1d33f3b093dc9da7733434bc4d817c5d`
- `HEAD...origin/chore/v0.5-stage2-public-machine-ingress` divergence：`0 0`
- Local upstream：**未配置**（`git rev-parse @{u}` 返回 no upstream）
- Worktree：**dirty**；产品代码和 Stage 5 测试存在未提交修改/新增文件
- Candidate freeze：**未执行**
- Gate C：**NOT REACHED**；Stage 6 和 Stage 7 尚未完成，因此尚未到达 Gate C 前置条件
- Stage 8：**未开始，且在 Gate C GO 前禁止开始**

## 2. 本阶段目标

SOP Stage 5 的目标是：

> Make reverse mode a first-class transport underneath the existing selector/route model.

本阶段严格保持 RFC-0012 invariant boundary：

- `routeMode = direct | reverse`，无 `auto`；
- reverse 只是 RFC-0010 route authority 下的一种 transport；
- 每个 reverse flow 仍验证现有 `ORBIT-ROUTE-V1` proof；
- 一条 control connection + bounded data-channel pool；
- 一个 channel 只承载一个 flow，不做 multiplex；
- direct/reverse 不自动 failover；
- control channel 不变成 command queue；
- 不公开 `/api/v1/enroll`；
- 不关闭 TLS hostname/SAN verification；
- 不新增第二套路由 authority、selector 或 DSH compatibility profile 系统；
- 不扩展到 v0.6/v0.7 generic tunnel、service mesh、remote shell、fleet RPC 或自动 failover。

## 3. Stage 5 实现结果

### 3.1 Reverse HTTP/WebSocket route integration

已实现并在当前测试中验证：

- `evaluateRouteEligibility()` 同时支持 direct/reverse explicit mode；
- reverse eligibility 使用当前 ready session generation 的非破坏性 pool predicate：至少一个已注册 channel 才进入 route eligibility；busy channel 不会被当作不可达，具体 flow assignment 进入 `acquireChannel()`，无 idle capacity 时最多等待 2 秒，超时才返回 `reverse-capacity` 503；零 registered channel 则 fail closed 为 `reverse-capacity`；
- direct snapshot 只含 `routeTargetOrigin`；
- reverse snapshot 只含 `reverseSessionId`；
- route snapshot 在 flow 建立时冻结，mode/metadata 后续变化只影响新 flow；
- HTTP 与 WebSocket dispatch 共用同一 eligibility evaluator；
- reverse mode 忽略 stored direct target；
- direct mode 即使 reverse session online 仍只走 direct；
- reverse outage 不回退到 stored direct target；
- direct outage 不回退到 reverse；
- selector/bookmark authority 仍为确定性的 `n-<node-id>.<route-domain>`；
- selector read model 在 server side 计算 eligibility，不在 browser 端重新推导；
- reverse mode 的 displayed `health.reachable` 与 live reverse session `routeReady` 使用同一权威状态源，`registryContact` 保持独立。

主要文件：

- `src/registry/route-proxy.mjs`
- `src/registry/server.mjs`
- `src/registry/selector-view.mjs`
- `src/registry/registry.mjs`

### 3.2 Reverse WebSocket parity

已实现并验证：

- reverse WebSocket `101 Switching Protocols`；
- 101 后双向 opaque bytes；
- text、binary、ping/pong；
- 512 KiB payload；
- Origin、subprotocol、合法 Cookie、Authorization 保留；
- route proof、gateway assertion、management credentials、Hub session cookie 剥离；
- duplicate `Set-Cookie` 保留，并逐字段删除 `Domain=`；
- 401/403/500 non-101 response status/header/body transparency；
- split non-101 response body 在 response-end 前不会提前关闭 public socket；
- browser close、downstream close、node delete 都会终止对应 flow；
- channel 只有在完整 teardown 后才回到 idle；
- reverse WebSocket tracker 在正常 close、rejection、non-101 response 后恢复。

主要文件：

- `src/registry/reverse-channel.mjs`
- `src/node/reverse-channels.mjs`
- `src/registry/route-proxy.mjs`

### 3.3 D7 bounded transport remediation

已实现并验证：

- 64 KiB frame split；
- 512 KiB soft mark；
- 256 KiB resume threshold；
- 2 MiB hard cap；
- 30 秒 no-progress stall；
- Hub reverse WebSocket browser→node 与 node→browser 两方向 queue accounting；
- Node upgraded WebSocket path 的 channel/DSH 双向 queue accounting；
- Node ordinary reverse HTTP request body 到 DSH 的 bounded queue、drain pause/resume、hard-cap、stall handling；
- browser response `res.write()` backpressure：在 `write()` 返回 false 时等待 `drain`，不继续消费 reverse body；
- reverse HTTP/WebSocket browser abort 在 capacity wait、request streaming、response head 等阶段都能终止 flow；
- aborted flow 不做 transparent retry。

相关测试：

- `test/v05-stage4-d7-bounds.test.mjs`
- `test/v05-stage4-reverse-channels.test.mjs`
- `test/v05-stage5-live-reverse-route.test.mjs`

### 3.4 Generation、capacity、malformed protocol 和 lifecycle cleanup

已实现并验证：

- capacity waiter 超时从 waiter set 移除；
- waiter 绑定 captured `sessionId`；
- session takeover/close 会取消对应 generation 的 waiters；
- idle channel claim 按 session generation 过滤；
- stale session channel 不得重新 idle；
- malformed authenticated `OPEN` 在触碰 DSH 前 fail closed；
- `requestId` 匹配防止 late abort 影响 reused channel；
- delete lifecycle hook 关闭 reverse sessions、channels 和 active browser flows；
- credential overlap expiry 在 DB transaction commit 后按 `{ nodeId, keyId }` 精确关闭旧 key 的 reverse session、data channels 和 active browser flows，新 key session/channel 不误关；
- 每个 reverse data channel 保存完成升级认证的 `keyId`，旧 key revoke 独立关闭精确匹配的 data channels，不依赖 control-session generation；
- Hub restart 不恢复 phantom online reverse session。

相关文件：

- `src/registry/reverse-channel.mjs`
- `src/registry/reverse-session.mjs`
- `src/registry/registry.mjs`
- `src/registry/server.mjs`
- `src/node/reverse-channels.mjs`

## 4. SOP Stage 5 automated tests 对照

| SOP requirement | Evidence | Status |
|---|---|---|
| WebSocket 101 through reverse node | `test/v05-stage5-live-reverse-route.test.mjs` reverse route case | PASS |
| text/binary/ping-pong | same live test | PASS |
| >=512 KiB payload | same live test, 512 KiB binary | PASS |
| subprotocol/header preservation | same live test | PASS |
| non-101 401/403/500 transparency | same live test + Stage 4 WebSocket suite | PASS |
| split non-101 body delivery | `/ws-split-401` delayed-body regression in live test | PASS |
| browser close cleans reverse flow | live reverse route and downstream-close tests | PASS |
| downstream close cleans browser flow | `Stage 5 reverse downstream close...` | PASS |
| channel idle only after complete teardown | live teardown assertions | PASS |
| reverse A never reaches B | mixed topology test | PASS |
| direct route regression | `stage4-websocket-routing.test.mjs` + mixed topology | PASS |
| reverse route ignores stored direct target | route-mode contract + mixed topology | PASS |
| direct route ignores online reverse session | route-mode contract + mixed topology | PASS |
| explicit mode switch affects new flows only | mixed topology test | PASS |
| existing flow keeps immutable snapshot | mixed topology test | PASS |
| node delete aborts active flow | active delete test | PASS |
| selector/bookmark authority unchanged | selector API/E2E + route-mode contract | PASS |
| capacity waiter timeout cleanup | `test/v05-stage4-reverse-channels.test.mjs` | PASS |
| route dispatch waits for channel arrival | `test/v05-stage5-live-reverse-route.test.mjs` HTTP + WebSocket waiter cases | PASS |
| route dispatch returns capacity only after bounded timeout | `test/v05-stage5-live-reverse-route.test.mjs` | PASS |
| reverse selector reachable matches live route readiness | route-mode contract + mixed live topology | PASS |
| generation-bound waiter takeover | `capacity waiters are generation-bound...` | PASS |
| credential overlap revoke closes active reverse flow | `test/v05-stage5-live-reverse-route.test.mjs` + reverse session unit | PASS |
| mixed control/data credential revoke closes exact old-key data channel | `test/v05-stage5-live-reverse-route.test.mjs` + `test/v05-stage4-reverse-channels.test.mjs` | PASS |
| reverse D9 pool predicate is non-destructive and generation-bound | route-mode contract + live route test | PASS |
| malformed OPEN fail closed | `malformed authenticated OPEN...` | PASS |
| browser abort before response headers | `Stage 5 browser abort before reverse response headers...` | PASS |
| tracker recovery after non-101 | tracker test explicitly opens `/ws-401` and checks count recovery | PASS |

## 5. Required live evidence 对照

SOP 要求同时运行：Node A direct、Node B reverse，并证明 HTTP/WebSocket isolation、A 故障不影响 B、B reverse disconnect fail-closed 且 A 仍健康。

当前 live test：`test/v05-stage5-live-reverse-route.test.mjs`

已验证：

- Node A direct 与 Node B reverse 同时在线；
- 两个 selector row 使用各自确定性 authority；
- A/B HTTP flow 返回各自 fixture；
- A/B WebSocket flow 返回各自 fixture；
- A direct mode 不使用 online reverse session；
- B reverse mode 不使用 stored direct target；
- A→reverse mode switch 只影响 new flows，已建立 direct flow 保持 direct；
- B→direct mode switch 只影响 new flows，已建立 reverse flow 保持 reverse；
- 禁用 A 的 direct ingress 后，A 返回 503，B browser-flow 数量不增加；
- 停止 B reverse client 后，B HTTP/WebSocket 503，A 仍返回 200；
- B selector reason 显示 `reverse-offline`；
- delete active reverse WebSocket 后 session/channel/flow 清理。

本地 live evidence status：**PASS（test fixture / in-process Hub + spawned reverse client coverage）**。

这不是 SOP Stage 8 mounted production evidence；mounted evidence 仍未授权、未执行。

## 6. Verification commands 与结果

### Focused v0.5 matrix

执行：

```text
node --test \
  test/v05-stage3-live-reverse.test.mjs \
  test/v05-stage3-reverse-control.test.mjs \
  test/v05-stage4-d7-bounds.test.mjs \
  test/v05-stage4-live-reverse-http.test.mjs \
  test/v05-stage4-reverse-channels.test.mjs \
  test/stage4-websocket-routing.test.mjs \
  test/stage5-selector-api.test.mjs \
  test/stage5-live-selector-e2e.test.mjs \
  test/v05-stage5-live-reverse-route.test.mjs \
  test/v05-stage5-route-mode-contract.test.mjs
```

结果：

- tests：61
- pass：61
- fail：0
- skipped：0

Round 2 remediation regression set：

- tests：61
- pass：61
- fail：0
- skipped：0

其中新增 mixed control/data credential overlap、精确 old-key data-channel teardown、new-key channel preservation、revoked old-key data upgrade denial，以及 D9 generation-bound non-destructive pool predicate。

### Full repository check

执行：

```text
npm run check
```

结果：

- public-tree validation：PASS
- tests：470
- pass：465
- fail：0
- skipped：5

### Diff / branch checks

```text
git diff --check: exit 0
git rev-parse HEAD: d9490aca1d33f3b093dc9da7733434bc4d817c5d
git ls-remote origin/chore/v0.5-stage2-public-machine-ingress:
  d9490aca1d33f3b093dc9da7733434bc4d817c5d
git rev-list --left-right --count HEAD...origin/...: 0 0
```

`git diff --check` 输出有 `reverse-channel.mjs` CRLF→LF warning，但不是 failure。

## 7. Scope / security / residue self-audit

### Scope

当前修改集中于：

- reverse channel manager / node pool；
- route proxy transport adapter；
- shared selector eligibility/read model；
- registry delete/credential-revocation lifecycle hooks；
- Stage 4/5 focused tests。

未发现 generic tunnel、multiplex、service mesh、remote shell、自动 failover、新 route authority 或新 selector architecture。

### Security boundary

- TLS verification path 保留；未加入 `skipVerify`、`rejectUnauthorized: false` 或 trust bypass；
- `/api/v1/enroll` 未公开；
- machine paths 仍与 per-node browser route authority 隔离；
- route proof 在 reverse flow 中继续验证；
- management credentials、gateway assertions、route proof headers 不到达 DSH；
- 合法 browser Cookie、Authorization、Origin、subprotocol 保留。

### Residue / secrets

- 当前 residue scan 未发现 `.log`、`.tmp`、`.pem`、`.key`、`.crt`、`.p12`、`.pfx` 临时文件；
- secret-like name scan 只匹配既有 `.env.example`，未发现新增 secret artifact；
- 这只是当前 worktree 自审，不替代 Stage 7 candidate-bound public-tree/secrets scan。

### P0/P1/P2 self-review

- P0：0 个已知未解决项；
- P1：Round 2 新增的 D10 data-channel credential identity 缺失已修复：Hub 从完成认证的 `auth.key.key_id` 注册 channel，channel 持久保存 `{ nodeId, keyId, sessionId }`，revocation 独立按 exact `{ nodeId, keyId }` 关闭 data channel，并通过 mixed control/data overlap live regression；Round 1 及更早 P1 均保持已修复并回归通过；
- P2：Round 2 D9 pool-availability clarity 已按实现选项闭合：增加当前 generation 的非破坏性 registered-channel predicate，明确 busy channel 仍进入 bounded assignment wait，zero registered channel 才 fail closed；该选择未修改原始 RFC/Review provenance，仍需 Independent Round 3 review 确认；其余 Stage 6/7/Gate C/mounted qualification 项仍未执行。

上述为 construction self-audit，不是独立 Gate C authorization。

## 8. NOT_EXECUTED / 未授权事项

以下事项明确保持 `NOT_EXECUTED`，不得在本报告中解释为 PASS：

1. Stage 6 authenticated operator route-mode mutation API；
2. Stage 6 operator-driven credential rotation/reconnect lifecycle and reenroll qualification; Stage 5 overlap-expiry immediate revoke teardown is implemented and locally verified, but the complete Stage 6 lifecycle remains NOT_EXECUTED；
3. Stage 6 reenroll same node ID + fresh Hub route identity live evidence；
4. Stage 7 full hardening qualification matrix；
5. RFC-0012 D14 exact 48-field candidate-bound matrix final report；
6. candidate SHA freeze；
7. candidate-bound evidence artifacts；
8. clean worktree candidate state；
9. branch tracking/upstream configuration；
10. Gate C independent review GO；
11. mounted/browser external Stage 5 acceptance；
12. Stage 8 canonical topology mounted TLS/gateway/production evidence；
13. production unknown-CA/wrong-SAN acceptance；
14. real slow-reader runtime qualification beyond the automated bounded fixtures；
15. full credential rotation/revocation live teardown matrix。

## 9. Gate disposition

### Stage 5 local construction disposition

**PASS — Round 2 remediation implementation/test verification complete; Independent Round 3 review required.**

Round 2 disposition:

- P1-1 data-channel credential identity/revocation: **CLOSED locally**. Every Hub data upgrade passes the authenticated `auth.key.key_id`; every `ReverseChannel` stores `keyId`; post-commit credential revocation closes exact matching channels independently of control-session generation. Mixed `control=K_new / data=K_old` overlap, active-flow teardown, new-key preservation, old-key data-upgrade denial, node/key isolation, and idempotence are covered.
- P2 D9 pool-availability clarity: **CLOSED locally via implementation option 1**. `hasChannelForSession(nodeId, reverseSessionId)` is a non-destructive current-generation predicate. It does not inspect or consume idle capacity: busy channels remain selector-eligible and concrete assignment waits up to the bounded interval; zero registered channels fail closed as `reverse-capacity`. This choice is recorded here and awaits Independent Round 3 review; the original RFC and Round 2 provenance remain unchanged.

### Gate C disposition

**NOT REACHED — Stage 6 and Stage 7 are incomplete.**

理由：

- SOP 顺序要求 `Stage 5 → Stage 6 → Stage 7 hardening/candidate freeze → Gate C → Stage 8`；
- 当前 worktree dirty，尚未形成唯一 candidate SHA；
- branch 没有 configured upstream；
- 还未满足 SOP candidate freeze 的 clean/pushed/local=remote 前置条件；
- Stage 6 operator lifecycle、reenroll qualification、Stage 7 hardening 和 exact 48-field candidate-bound evidence 尚未完成；
- 因此 Gate C 不是 HOLD review decision，而是尚未到达的治理阶段；
- mounted evidence 只能在 Gate C GO 后开始。

### Required next review action

请 reviewer 针对本报告所指向的**当前 exact worktree**重新检查：

1. `git diff 5738c0c..HEAD` 以及所有未提交修改；
2. Stage 5 D7 双向 backpressure/stall 和 ordinary HTTP body response backpressure；
3. session-bound capacity waiter / takeover cancellation；
4. HTTP/WS concrete flow capacity waiter：arrival within 2s and timeout-to-503；
5. reverse selector displayed reachable 与 live route readiness 一致，registryContact 独立；
6. credential overlap expiry 按旧 key 精确关闭 control session、data channel、active flow，新 key 不误关；
7. mixed `control=K_new / data=K_old` overlap 与 exact-key data teardown；
8. revoked old key 新 reverse control/data upgrade denial；
9. D9 current-generation non-destructive registered-channel predicate，busy wait 与 zero-channel fail-closed 语义；
10. non-101 delayed body、browser abort、tracker recovery；
11. no fallback、immutable snapshot、direct regression、header/cookie sanitation；
12. SOP Stage 5 scope 与 no 0.6/0.7 expansion；
13. current full test result：470 / 465 / 0 / 5；
14. 明确返回 Stage 5 Round 3 review conclusion，并列出 NOT_EXECUTED；Gate C 当前应保持 `NOT REACHED`。

在独立 review 返回并授权前：

- 不提交/冻结 candidate；
- 不开始 Stage 6；
- 不开始 Stage 8 mounted evidence；
- 不宣称 Gate C GO。

**报告完成后停止施工，等待 Independent Stage 5 Review Round 3。**
