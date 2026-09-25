# DSH Orbit v0.6 Stage 2 Gate 2 复审（针对上一轮 Review 意见的修复提交）

- Date: 2026-09-26
- Gate: Gate 2 Review（Stage 2 — Hub Read Model & Devices/Nodes View）复审
- Decision: **PASS WITH NON-BLOCKING FINDINGS**（P0 = 0, P1 = 0, P2 = 0, P3 = 1）
- Reviewed HEAD: `1a14a8dcc149304c234271cc0dd3532f444bd51e`
- Branch: `chore/v0.6-stage2-devices-and-nodes`
- Parent / baseline: `4b288bb`（上一轮 Gate 2 审查对象），上游 `e884131`（Stage 1 Gate 1 PASS）
- Worktree: clean（`git status --porcelain` 为空）；`git diff --check 4b288bb..1a14a8d` clean
- 受控文档:
  - `docs/rfc/0013-multi-node-sessions-and-target-scope.md`（D2, D3, M24 matrix fields 1 / 20 / 23）
  - `docs/sop/v0.6-multi-node-sessions-multistage-sop.md`（Stage 2）
  - `docs/review/2026-09-26-v06-stage2-devices-and-nodes-4b288bb.md`（上一轮 Gate 2 审查报告）

## Review Scope

本次复审针对提交 `1a14a8d`（"address Gate 2 review findings on overview flow, fallback and displayName scoping"），即上一轮 Gate 2 报告 3 项非阻断 Finding（1×P2 + 2×P3）的修复，以及该修复引入的回归风险。审查范围：

- `ui/app.mjs` — `loadNodes` 由 `/hub/nodes` + `/hub/overview` 并行双请求改为 overview 优先、失败回退 `/hub/nodes`；`activeSessions` 回退构造。
- `ui/view-model.mjs` — `mapOverview` 在 `activeSessions` 缺失或非对象时返回 `null`。
- `docs/rfc/0013-multi-node-sessions-and-target-scope.md` — D2 / D3 的 `displayName` 表述与示例 payload 调整。
- `test/v06-stage2-devices-and-nodes.test.mjs` — app-level fake fetch 改为覆盖 `/hub/overview`，并新增回退用例。
- 附带 `docs/review/2026-09-26-v06-stage2-devices-and-nodes-4b288bb.md`（上一轮报告归档，未覆盖历史）。

服务端 `GET /hub/overview` / `GET /hub/nodes` handler（`src/registry/server.mjs:708`）为 Stage 1 既有代码，本次仅作依赖复核，不重新裁定。

## 上一轮 Finding 的关闭核验

### P2（displayName 需求与生产路径偏差）— 已解决

`docs/rfc/0013-multi-node-sessions-and-target-scope.md:82,86` 现明确：D2 以截断 ID 作为目标标识（`target: node_<truncated>…`），仅在"扩展读模型提供可选 `displayName`"时格式化为 `target: <displayName> (<truncatedId>)`；D3 明确 `displayName` 人工别名管理延后至 v0.7，v0.6 使用规范 node ID，并已从示例 payload（`:88-108`）移除 `displayName`。规范与生产读模型（`managementNodeSummary` 不产出 `displayName`，实测 `GET /hub/overview` 节点对象无该键）表述一致。

`test/v06-stage2-devices-and-nodes.test.mjs:108-113` 保留的合成 `displayName` 断言，现在验证的是 RFC 已声明的"可选扩展"分支，不再构成对 D3 必需能力的虚假信心，可接受。

### P3（loadNodes 冗余请求 + 死回退）— 已解决

`ui/app.mjs:271-283` 改为 overview 优先、异常回退 `/hub/nodes`。实测成功路径仅请求 `["/hub/session","/hub/overview"]`（不再并行双打）。`ui/view-model.mjs:125-138` 的 `mapOverview` 在 `activeSessions` 缺失或非对象时返回 `null`，与 `mapNodeList`（`:116-121`）语义一致；实测 `mapOverview({nodes:[]})` → `activeSessions: null`，`mapOverview({nodes:[],activeSessions:'x'})` → `null`，`{totalFlows,distinctNodes}` 正常映射。

### P3（app-level 未覆盖 overview 成功路径）— 已解决

`test/v06-stage2-devices-and-nodes.test.mjs:141` 的首个 app-level 用例现 stub `/hub/overview` 并断言 `#overview-summary`，真实走通 `app.mjs` → `/hub/overview` → `mapOverview`；其余用例同时 stub 两个端点；新增 `:410` 用例验证 overview 404 时回退 `/hub/nodes` 并渲染 `1 enrolled` / `1 flows across 1 active nodes`。该用例在移除回退逻辑后必然失败，具备实际约束力。

## Findings

### [P3] RFC-0013 D3 示例 payload 仍含实现不产出的 `routeAuthority` 字段

`docs/rfc/0013-multi-node-sessions-and-target-scope.md:96,104`

本次提交的目标之一是"消除 D3 规范与读模型实现之间的表述偏差"，并已从 D3 示例 payload 移除 `displayName`，但同一示例仍逐节点列出 `"routeAuthority": "n-…dsh-orbit.test:8547"`。实测管理读模型不产出该字段：`GET /hub/nodes` 与 `GET /hub/overview` 共用 `src/registry/server.mjs:708` handler，返回 `managementNodeList()`（`managementNodeSummary` 仅 spread `registry.toNodeSummary(row)`），实启 Hub 探针确认 overview 节点对象键集合为 `nodeId,state,mintedAt,tombstonedAt,tombstoneReason,routeTarget,hubRouteKeys,routeMode,health,runtimeIdentity,reversePresence,reverseRouteReady,reverseReason,activeFlows,lastReverseTransition`，不含 `routeAuthority`。UI 也不消费该字段（路由 URL 由 `POST /hub/actions/node` 返回，`src/registry/server.mjs:776-781`）。

触发条件：任何依据 RFC-0013 D3 示例实现管理读模型消费方（v0.7 fleet inventory 或外部工具）的开发者。实际影响：契约示例与实现不符，可能误判 `/hub/nodes` 会提供路由权威。影响面限于文档，无运行时或功能影响，且为上一轮未点出的既有偏差，不阻断 Gate 2。

最小修复方向：从 D3 示例移除 `routeAuthority`（若该字段确属 selector 读模型而非 management 读模型），或补齐规范说明该字段的来源。

## Verification

实际执行（均为只读 / 测试）：

- `git status --porcelain` → 空；`git diff --check 4b288bb..1a14a8d` → clean。
- `node --test test/v06-stage2-devices-and-nodes.test.mjs` → 8/8 pass（含新增回退用例）。
- `node --test`（全量）→ 527 tests，521 pass，0 fail，6 skipped（skip 与上一轮同为既有 6 项）。
- `node --test test/ui-dom.test.mjs test/ui-view-model.test.mjs test/ui-selector-view-model.test.mjs` → 23/23 pass（app.mjs 真实 Hub 路径未回归）。
- `node scripts/check-public-tree.mjs` → passed；`npm run check` → 通过。
- 手动探针（instrumented `createRegistryUi`）：
  - overview 成功路径仅请求 `["/hub/session","/hub/overview"]`，`#overview-summary` 正常渲染（确认冗余请求已消除）。
  - overview 返回 500 → 回退 `/hub/nodes`，summary 正常渲染。
  - overview 401 `no-session` → 回退 `/hub/nodes`（亦 401）→ `refreshSession` → 重试 overview 成功（会话恢复路径未被破坏，仅多一次请求）。
  - overview 200 但缺 `nodes` 数组 → 显示 "no nodes registered yet"（无异常抛出）。
  - `mapOverview` 边界：`{}`/`[]` → `{0,0}`；`'x'`/`5` → `null`。
- 实启 Hub 探针：`GET /hub/overview` 返回节点无 `displayName`、无 `routeAuthority`；`activeSessions` 为 `{totalFlows,distinctNodes}`（确认 Finding P3 与 P2 关闭依据）。

未执行（本 Gate 范围外）：mounted 双节点实跑、浏览器内真实交互（Stage 3+ / Gate B/C 范围）。

## Residual Risks

- `ui/app.mjs:278-281` 的 `body?.activeSessions` 回退构造在 `mapOverview` 已对非对象返回 `null` 后，仅在 `body.activeSessions` 为 truthy 非对象原始值（如字符串、非零数字）时才可能触发，属近乎不可达的防御分支；服务端不会产生此类载荷，无现实触发条件，仅属冗余代码。
- overview 返回 200 但 body 缺 `nodes` 时不再回退 `/hub/nodes`，UI 显示空列表。由于两个端点共用同一 handler，实际无法出现该分歧；仅在服务端返回部分/损坏响应时可见，无现实触发路径。
- 会话过期时 overview 先 401、再回退 `/hub/nodes` 又 401，随后才刷新会话，较原先多一次无效请求（仅 401 路径），无功能影响。
- 持续性 `sessionRequired` 且 re-bootstrap 成功时，`loadNodes` / `scopedOpenNode` / `scopedRefreshNode` 的重试无深度上限（`ui/app.mjs:286,436,453`），需 cookie/session 错配触发，为既有模式，非本次引入。

## Gate

**PASS WITH NON-BLOCKING FINDINGS**（P0 = 0, P1 = 0, P2 = 0, P3 = 1）。

上一轮 1×P2 + 2×P3 三项 Finding 均已彻底解决并有实测证据；本次仅新增 1 项纯文档级 P3（RFC 示例残留 `routeAuthority`），不影响运行时、读模型或 UI 行为，不阻断 Gate 2。

## Review Report

`D:/App/01_Ai/CodeX/dsh-orbit-v05-formal-candidate/docs/review/2026-09-26-v06-stage2-gate2-rereview-1a14a8d.md`
