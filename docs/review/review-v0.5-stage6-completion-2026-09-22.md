# DSH Orbit v0.5 Stage 6 完工报告

日期：2026-09-22
报告类型：Stage 6 construction completion report；Stage 6 implementation complete，等待独立 Stage 6 review。

> 本报告对照 `docs/rfc/0012-reverse-connected-nodes.md` 与
> `docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md` 编写。
> 本报告不是 candidate freeze，不是 Gate C GO，也不授权 Stage 8 mounted evidence。

## 1. Review target 与治理边界

- Worktree：`dsh-orbit-v05-stage1`
- Branch：`chore/v0.5-stage2-public-machine-ingress`
- Accepted Stage 5 baseline：`809bb8fbc5c6b0edad3eeb999b747debc0ed094c`
- Stage 5 Independent Round 3：`docs/review/review-v0.5-stage5-independent-r3-2026-09-22.md`
- Stage 5 Round 3 disposition：**PASS / ACCEPTED**
- Stage 6 construction：**AUTHORIZED**
- Current Stage 6 worktree：完成本地施工验证，待 commit/push 后交付独立 review
- Candidate freeze：**NOT AUTHORIZED / NOT EXECUTED**
- Gate C：**NOT REACHED**
- Stage 7：**NOT STARTED**
- Stage 8 mounted evidence：**NOT AUTHORIZED / NOT EXECUTED**

本阶段未改变以下不可变边界：

- `routeMode = direct | reverse`，没有 `auto`；
- reverse 仍是 RFC-0010 route authority 下的 transport；
- 每个 flow 仍由 `ORBIT-ROUTE-V1` 保护；
- reverse 仍是一条 control connection + bounded data-channel pool；
- 一个 channel 只承载一个 flow，无 multiplex；
- direct/reverse 不自动 failover；
- control channel 不承载 command queue；
- `/api/v1/enroll` 没有被公开；
- TLS hostname/SAN 验证没有被关闭；
- 没有新增 route authority、selector architecture、DSH compatibility profile、generic tunnel、VPN、service mesh、remote shell 或 fleet RPC。

## 2. Stage 6 实现结果

### 2.1 Operator route-mode lifecycle

已实现并验证：

- `Registry.setRouteMode()` 只接受 `direct` / `reverse`；
- tombstoned node 拒绝 route-mode mutation；
- same-mode mutation 幂等返回 `changed: false`；
- mutation 通过已有 browser gateway admission、session、CSRF、Origin/Sec-Fetch-Site 约束；
- operator audit action 为 `hub.nodes.route-mode`；
- route transition event dimension 为 `route_mode`；
- mutation 在事务内重新读取当前 node row，避免 stale pre-transaction mode/state；
- management node summary/detail 暴露持久化 `routeMode`。

主要文件：

- `src/registry/registry.mjs`
- `src/registry/server.mjs`
- `test/registry-admin-api.test.mjs`

### 2.2 Existing enrolled Node dynamic mode synchronization

已实现并验证：

- authenticated heartbeat response 返回当前 Hub `routeMode`；
- NodeClient 只在成功 authenticated heartbeat 后接受并持久化 `direct|reverse`；
- invalid response mode（例如 `auto`）fail closed，不写入本地 store；
- heartbeat failure 不会改变本地 route mode；
- enrollment 明确持久化 `routeMode: direct`；
- canonical `hubBaseUrl` 始终保留，不因 mode switch rebinding/repair；
- daemon 启动时只为 active reverse store 建立已有 `ReverseClient` + `ReverseChannelPool`；
- direct→reverse 仅在 authenticated heartbeat 成功后启动 reverse transport；
- reverse→direct 仅在 authenticated heartbeat 成功后停止 reverse transport；
- reverse live session/channel state 不写入 node store；
- 没有 direct↔reverse automatic request failover。

主要文件：

- `src/node/client.mjs`
- `bin/dsh-orbit-node.mjs`
- `test/v05-stage6-node-route-mode.test.mjs`

### 2.3 Credential rotation and reverse reconnect

已实现并验证：

- existing node credential rotation 仍复用 signed `/api/v1/credential-rotate`；
- overlap 期间旧/新 key 语义保持 RFC-0006；
- reverse control session/data channel 按其实际认证 key 关闭；
- 当前 key 可重新建立 reverse control session；
- Stage 6 lifecycle test 验证 NodeClient rotate、持久化新 key 和 current-key reverse reconnect。

主要文件/测试：

- `test/v05-stage6-lifecycle.test.mjs`
- `test/v05-stage5-live-reverse-route.test.mjs`
- `src/registry/reverse-session.mjs`
- `src/registry/reverse-channel.mjs`
- `src/registry/server.mjs`
- `src/registry/registry.mjs`

### 2.4 Delete and bookmark fail-closed

已实现并验证：

- authenticated management delete tombstones node；
- delete lifecycle hook 立即关闭 reverse control session、channels 和 active flow；
- tombstoned deterministic bookmark 不会 fallback 到 stored direct target，返回 `503 node-unavailable`；
- management detail 显示 tombstoned + reverse offline/unavailable 状态。

主要测试：

- `test/v05-stage6-lifecycle.test.mjs`
- `test/v05-stage5-live-reverse-route.test.mjs`

### 2.5 Same-node reenrollment and fresh Hub route identity

已实现并验证：

- same-node-ID reenrollment 仍是唯一 tombstone recovery path；
- success transaction 内调用既有 `ensureHubRouteKey()`，原子 provision fresh Hub route identity；
- deleted-era Hub route key 保持 revoked，旧 `ORBIT-ROUTE-V1` proof 失败；
- new route key 首先通过 authenticated heartbeat 以 public-only trust material 交付；
- heartbeat ACK 后 new route key 变为 active，new proof 成功；
- routeMode 保留为 reverse；
- reenroll response 不携带 private route key；
- exact reenroll replay 不重复 provision。

主要测试：

- `test/registry-reenroll.test.mjs`
- `test/stage2-hub-route-identity.test.mjs`

### 2.6 Management and selector UI/read model

已实现并验证：

- pair-purpose token 通过既有 `/hub/tokens` mutation mint；
- pair token plaintext 只在 mint response 的一次性 block 中显示；
- token list 只显示 metadata，不显示 plaintext/digest；
- node detail 支持 explicit direct/reverse selector + save；
- tombstoned detail 禁用 mode/route-target controls；
- management read model 暴露 server-provided：`routeMode`、`reversePresence`、`reverseRouteReady`、`reverseReason`、`lastReverseTransition`；
- reverse lifecycle projection 为 process-memory only，不持久化 session/channel；
- projection 不暴露 session ID、key ID、signature、socket 或 credential；
- selector UI 只展示 server-provided route mode/presence/reason，不在 browser 推导 eligibility；
- deterministic Open URL 和 server-side eligibility 语义不变；
- 无 multi-node execute/control surface。

主要文件：

- `src/registry/server.mjs`
- `src/registry/reverse-session.mjs`
- `ui/index.html`
- `ui/app.mjs`
- `ui/view-model.mjs`
- `ui/selector/view-model.mjs`
- `test/ui-dom.test.mjs`
- `test/ui-view-model.test.mjs`
- `test/ui-selector-view-model.test.mjs`
- `test/v05-stage6-management-observability.test.mjs`

## 3. SOP Stage 6 automated tests 对照

| Requirement | Evidence | Status |
|---|---|---|
| plaintext pair token shown once | `test/ui-dom.test.mjs` | PASS |
| pair list never exposes plaintext/digest | `test/ui-dom.test.mjs`, registry token tests | PASS |
| pair mint uses CSRF/operator-attributed existing mutation | `test/ui-dom.test.mjs`, `test/registry-admin-api.test.mjs` | PASS |
| bound pair token / wrong purpose / tombstone recovery denial | existing pairing/enrollment tests | PASS |
| explicit route-mode mutation and audit | `test/registry-admin-api.test.mjs` | PASS |
| stale-row route-mode race recheck | `test/registry-admin-api.test.mjs` | PASS |
| Node direct→reverse / reverse→direct sync | `test/v05-stage6-node-route-mode.test.mjs` | PASS |
| invalid `auto` mode rejected and not persisted | `test/v05-stage6-node-route-mode.test.mjs` | PASS |
| canonical hub binding retained | `test/v05-stage6-node-route-mode.test.mjs` | PASS |
| credential rotation overlap/current-key reconnect | `test/v05-stage6-lifecycle.test.mjs`, Stage 5 live matrix | PASS |
| delete closes reverse session and bookmark fails closed | `test/v05-stage6-lifecycle.test.mjs` | PASS |
| fresh Hub route identity after reenroll | `test/registry-reenroll.test.mjs` | PASS |
| old route proof denied / new proof accepted | `test/registry-reenroll.test.mjs` | PASS |
| UI displays route mode/presence without client eligibility derivation | UI and observability tests | PASS |
| no multi-node execute/control surface | existing scope/governance tests + diff audit | PASS |

## 4. Required live evidence disposition

Stage 6-specific local live/in-process evidence is present for:

- online reverse credential rotation and current-key recovery (`test/v05-stage6-lifecycle.test.mjs` plus Stage 5 live reverse rotation matrix);
- authenticated delete during active reverse control/browser route lifecycle and bookmark fail-closed (`test/v05-stage6-lifecycle.test.mjs` plus Stage 5 active-flow delete);
- same-node reenrollment with fresh Hub route identity, old proof denial, heartbeat trust sync, and retained reverse mode (`test/registry-reenroll.test.mjs`).

This is **local automated/live fixture evidence**, not candidate-bound Stage 8 mounted production evidence.

## 5. Verification results

### Stage 6 focused matrix

```text
node --test \
  test/v05-stage5-route-mode-contract.test.mjs \
  test/v05-stage5-live-reverse-route.test.mjs \
  test/v05-stage6-node-route-mode.test.mjs \
  test/v05-stage6-lifecycle.test.mjs \
  test/v05-stage6-management-observability.test.mjs

25 passed / 0 failed / 0 skipped
```

Additional focused regressions:

```text
node --test test/registry-reenroll.test.mjs
9 passed / 0 failed / 0 skipped

node --test test/node-client-machines.test.mjs test/node-client-e2e.test.mjs test/node-client-response-loss.test.mjs
20 passed / 0 failed / 0 skipped

node --test test/registry-admin-api.test.mjs test/ui-dom.test.mjs test/ui-selector-view-model.test.mjs test/ui-view-model.test.mjs
57 passed / 0 failed / 0 skipped
```

### Full repository verification

```text
npm run check
public-tree validation: PASS
tests: 484
pass: 479
fail: 0
skipped: 5
exit: 0
```

The five skips are existing environment/platform-gated cases (Windows/POSIX permission behavior or unavailable external DSH acceptance); no test failed.

### Hygiene and scope audit

- `git diff --check`: PASS
- public-tree validation: PASS
- exact local/remote SHA before this Stage 6 commit: `809bb8f` accepted Stage 5 baseline, divergence `0/0`
- changed files are limited to Node runtime, Registry route-mode/reenroll/reverse observability, operator/selector UI, and Stage 6 tests
- no new persistent reverse session/channel tables
- no plaintext token/digest in list or report surfaces
- no new public `/api/v1/enroll`
- no insecure TLS bypass, Root-store mutation, generic tunnel, multiplex, failover, or operator credential-rotation API
- secret scan findings are pre-existing fixtures/documentation only; no new Stage 6 credential residue was introduced

## 6. NOT_EXECUTED / outside this gate

The following remain explicitly **NOT_EXECUTED** and are not being relabeled PASS:

- Stage 7 hardening and candidate freeze;
- exact frozen 48-field candidate matrix and candidate-bound evidence manifest;
- Gate C independent candidate review;
- Stage 8 mounted production evidence;
- external production reverse-node rotation/delete/reenroll run against a frozen candidate;
- release tag, promotion, or publication.

## 7. Self-review disposition

```text
P0 = 0
P1 = 0
P2 = 0 known blocking findings

Stage 6 implementation: COMPLETE — locally verified
Stage 6 independent review: NOT YET RUN
Stage 7: NOT STARTED
Candidate freeze: NOT AUTHORIZED
Gate C: NOT REACHED
Stage 8: NOT AUTHORIZED
```

施工到此停止，等待独立 Stage 6 review。不得在该 review 之前继续 Stage 7、candidate freeze、Gate C 或 Stage 8。
