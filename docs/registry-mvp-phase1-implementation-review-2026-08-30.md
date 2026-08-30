# v0.3 Registry MVP 第一阶段实现 Review

日期：2026-08-30  
审计对象：`1b0ec0f` (`feat(registry): v0.3 Registry MVP — SQLite/WAL persistence, Ed25519 machine API, enrollment/reenroll, capability/health derivation, browser management`)  
基线设计：`1c9a12c` v0.3 architecture final closure 及 RFC-0005 / 0006 / 0007 / 0009  
Review 结论：**HOLD，不进入下一阶段实现**

## 1. Executive summary

本轮 Registry MVP 已经实现了主体骨架，而且基础代码质量明显高于一般首版：SQLite/WAL、Ed25519 machine authentication、enrollment / re-enrollment、credential rotation、Hub-side capability derivation、browser session / CSRF、operator principal 等核心路径均已落地，新增测试数量也较多。

现有完整测试结果：

```text
npm run check

159 tests
158 pass
1 environment skip
0 fail

git diff --check
PASS
```

但是，独立实现审计和运行时探针发现：当前测试主要覆盖 happy path、即时失败和静态协议约束，对 **时间流逝、乱序消息、后台 maintenance、认证后限流、Browser bootstrap trust** 等 control-plane 关键场景覆盖不足。

当前没有发现需要推翻 v0.3 架构的 P0，冻结 RFC 仍然成立；但存在多项 P1，其中部分会直接导致生产 Registry 长期给出错误健康状态、错误兼容状态或偏离冻结的 replay / browser trust contract。因此本轮不能验收通过。

**本轮修复原则：修实现和测试，不修改冻结 RFC，不扩展 v0.4/v0.5，不引入第三方插件逻辑。**

---

## 2. 审计范围与方法

本轮检查范围包括：

- `src/registry/sqlite.mjs`
- `src/registry/crypto.mjs`
- `src/registry/protocol.mjs`
- `src/registry/registry.mjs`
- `src/registry/capabilities.mjs`
- `src/registry/server.mjs`
- `bin/dsh-orbit-hub.mjs`
- `test/registry-*.test.mjs`
- `test/helpers/registry-fixture.mjs`
- `docs/registry-mvp.md`
- 冻结 RFC 0005 / 0006 / 0007 / 0009

除阅读实现和运行现有测试外，本轮额外执行了独立运行时探针，覆盖：

1. `Registry.maintenance()` 实际调用；
2. heartbeat 后 4 分钟和 25 小时的 `registryContact` aging；
3. report 上传 8 天后的 compatibility/capability aging；
4. heartbeat runtime rev-B 后再上传旧 report rev-A 的乱序场景；
5. authenticated heartbeat 触发 429 后对应 nonce 是否已持久化；
6. stale capability 是否真的 withheld；
7. enrollment token TTL 越界值；
8. Browser same-host wrong-scheme Origin；
9. `/hub/session` cross-site bootstrap。

这些探针发现的问题均为当前 `npm run check` 未覆盖的实际行为，而不是纯代码风格意见。

---

## 3. 已通过部分

以下部分本轮可以视为方向正确，不要求重构：

| 范围 | 结论 | 说明 |
| --- | --- | --- |
| SQLite/WAL 基础 schema | PASS | table set 与 RFC-0005 基本一致，启用 WAL、foreign_keys、busy_timeout |
| `BEGIN IMMEDIATE` 基础事务封装 | PASS | 可正常 rollback / commit |
| Ed25519 wire encoding | PASS | raw public key、signature、PKCS8 private key 流程一致 |
| keyId derivation | PASS | SHA-256(raw pubkey) first 16 bytes |
| `ORBIT-MACHINE-V1` signing string | PASS | raw-body hash、固定 path、无 query canonicalization |
| `X-Orbit-*` machine headers | PASS | transport contract 已落地 |
| enrollment token digest-only persistence | PASS | plaintext 只在 mint 返回路径存在 |
| ordinary enrollment idempotency | PASS | exact replay 可返回同一结果 |
| `ORBIT-REENROLL-V1` 主体 | PASS | historical-key possession proof 已实现 |
| revoked historical key isolation | PASS | historical key 只用于 reenroll proof，不恢复 machine 权限 |
| credential rotation 主体 | PASS | old key 签名、新 key overlap |
| capability evidence table | PASS | v0.3 不 claim `terminal.pty` / `agents.run` |
| third-party plugin boundary | PASS | Registry 新代码未引入第三方插件耦合 |
| v0.4 / v0.5 scope boundary | PASS | 未提前实现 routing / reverse connection / fleet execution |

这些部分应尽量保持稳定，本轮 remediation 不应借机重写。

---

# 4. P1 blockers

## P1-01 `Registry.maintenance()` 首次运行即抛 `ReferenceError`

### 现象

`src/registry/registry.mjs` 的 `maintenance()` 使用：

```text
EVENT_RETENTION_MS
AUDIT_RETENTION_MS
```

但模块顶部没有从 `protocol.mjs` 导入这两个常量。

独立调用 `registry.maintenance()` 会直接抛：

```text
ReferenceError: EVENT_RETENTION_MS is not defined
```

### 生产影响

`bin/dsh-orbit-hub.mjs` 每 15 分钟执行：

```text
registry.maintenance()
```

当前行为会变成：

```text
Hub 正常启动
  -> 15 分钟后 maintenance
  -> ReferenceError
  -> catch + log
  -> maintenance 整轮未执行
  -> 后续每 15 分钟持续失败
```

这意味着 nonce purge、event/audit retention、enrollment result retention、rotation overlap expiry 等维护逻辑在生产中实际上不可用。

### Required fix

- 导入缺失常量；
- 新增 `maintenance()` 独立测试；
- 测试必须覆盖真实 maintenance 行为，而不是只测试底层 helper；
- 至少覆盖 nonce purge、event/audit retention、enrollment-results retention、rotation old-key revocation。

### Acceptance

```text
registry.maintenance()
-> no throw
-> each retention class processed correctly
-> expired rotation key becomes revoked
```

---

## P1-02 `registryContact` 不会在节点断线后自动 aging

### Frozen contract

RFC-0009：

```text
heartbeat default 60s
3 consecutive missed beats -> stale
24h without contact -> lost
```

### 当前实现问题

`stale/lost` 判断只存在于 `transitionRegistryContact()`，而该函数只在新的 heartbeat 到来时被调用。

节点真正失联后，不再有 heartbeat，状态也就没有任何推进器。

### 独立探针

在一次成功 heartbeat 后推进测试时钟：

```text
T0 + 4 min  -> registryContact = fresh
T0 + 25h    -> registryContact = fresh
```

均不符合 RFC。

### 影响

Hub 可以把已经失联一天以上的节点永久显示为 `fresh`。这会直接破坏 Registry 作为 fleet control plane 的健康判断可信度。

### Required fix

建议由 maintenance 对 active nodes 做确定性 aging：

```text
last contact <= 3 * cadence   -> fresh
> 3 missed beats              -> stale
> 24h                         -> lost
```

状态变化必须记录 transition event。

RFC 还定义了 `lost + operator alert flag`，当前 schema/实现没有实际 alert flag，需要一并落实或明确其最小持久化形式。

### Acceptance

至少新增 deterministic clock tests：

```text
heartbeat at T0
T0 + 179s  -> fresh
T0 + 181s  -> stale
T0 + 24h+  -> lost
reachable  -> remains unknown
```

并验证 event 只在状态实际改变时写入。

---

## P1-03 7 天 compatibility report staleness 未实现

### Frozen contract

RFC-0009：report 只有在以下条件同时满足时才 fresh：

```text
uploaded within 7 days
AND
identity tuple matches latest heartbeat runtime identity
```

### 当前实现

`protocol.mjs` 定义了：

```text
REPORT_STALENESS_MS = 7 days
```

但当前实现没有任何代码使用该常量。

### 独立探针

上传 PASS report 后推进 8 天：

```text
orbitCompatible   = pass
capabilitiesStale = false
capabilities      = 3 active entries
```

### 影响

数月前甚至更早的 compatibility evidence 可能被永久当作当前节点的有效证据。

### Required fix

maintenance 或读取/derive 层必须实现 report-age aging：

```text
latest report older than 7d
-> orbitCompatible = stale
-> capabilities stale/withheld
-> dshHealthy = unknown if RFC fresh-report condition不满足
```

不要只在内存返回层临时改 label，持久状态与 event history 必须保持一致。

### Acceptance

```text
T0 report PASS
T0 + 6d23h -> still fresh
T0 + 7d+   -> stale
active capabilities withheld
fresh report -> restored deterministically
```

---

## P1-04 `capabilitiesStale=true` 时旧 capability 仍作为 active set 返回

### 当前行为

identity mismatch 后：

```text
orbitCompatible   = stale
capabilitiesStale = true
```

但 `health.capabilities` 仍然返回旧的：

```text
sessions.resume
settings.remote
web.routes
```

独立探针确认：

```text
stale true [ 'sessions.resume', 'settings.remote', 'web.routes' ]
```

### 问题

RFC 的语义是 **withheld**，不是“旧集合继续作为 active set，只额外打一个 stale flag”。

当前测试名称写着：

```text
capabilities withheld until a fresh report
```

但测试只断言 `capabilitiesStale === true`，没有断言 active capability array 为空，因此测试没有验证名字所宣称的行为。

### Required fix

建议：

```text
fresh evidence -> health.capabilities = active derived set
stale evidence -> health.capabilities = []
```

若未来 UI 需要展示历史能力，可独立提供 historical/stale evidence 字段，不要混入 active capabilities。

### Acceptance

补充明确断言：

```text
identity mismatch / report age stale
-> capabilitiesStale = true
-> health.capabilities = []
```

---

## P1-05 旧 report 可以覆盖较新的 heartbeat runtime identity

### Frozen authority model

设计阶段已经明确：

```text
heartbeat -> current runtime identity
report    -> evidence attached to an identity tuple
```

report 不应反向声明 Node 当前正在运行哪个 revision。

### 当前实现

`uploadReport()` 写 report 后，又执行：

```text
UPDATE nodes SET
  orbit_version = report...
  orbit_revision = report...
  dsh_version = report...
  compatibility_profile = report...
```

这使 report 获得了覆盖 current runtime identity 的权限。

### 独立乱序探针

步骤：

```text
1. heartbeat -> current runtime = rev-B
2. upload old report -> report identity = rev-A
```

当前结果：

```text
runtimeIdentity.rev = rev-A
orbitCompatible     = pass
capabilitiesStale   = false
capabilities        = active
```

也就是说延迟到达的旧 report 能把 Node “洗回兼容”。

### Required fix

- heartbeat 是 current runtime identity 的 authority；
- report upload 只保存 report identity tuple；
- report 到达时与当前 runtime identity 比较；
- mismatch 时 report 可以进入历史记录，但不能覆盖 current runtime；
- mismatch 结果必须 `orbitCompatible=stale` + active capabilities withheld。

如果 Node 尚未产生过 heartbeat，可定义 report 是否允许初始化 runtime identity，但必须遵守冻结 RFC 的 authority 语义并通过测试明确，不允许隐式摇摆。

### Acceptance

```text
heartbeat rev-B
report rev-A
-> nodes.runtime remains rev-B
-> report stored as history
-> orbitCompatible stale
-> capabilities withheld
```

以及：

```text
fresh report rev-B
-> pass / capabilities restored
```

---

## P1-06 authenticated machine rate limit 在 nonce reservation 之前执行

### Frozen contract

RFC-0006 已固定：

```text
key valid
signature valid
timestamp valid
-> reserve nonce
-> business logic
```

并明确 authenticated request 后续即使：

```text
4xx
429
5xx
```

nonce 也已经被消费。

### 当前实现

`server.mjs` 的 heartbeat/report rate limit 发生在 `registry.authenticateMachine()` 之前。

### 独立探针

发送合法签名 heartbeat：

```text
1 -> 200
2 -> 200
3 -> 200
4 -> 429
```

随后检查第 4 个请求 nonce：

```text
seen_nonces rows = 0
```

证明合法签名请求触发 429 后 nonce 没有被 reservation。

### 影响

同一已认证签名包未来仍可能再次被提交，偏离冻结的 replay contract。

### Required fix

需要区分两层 rate limiting：

1. cheap pre-auth abuse guard，可在签名验证前做，用于阻止明显 DoS；
2. authenticated protocol rate limit，必须发生在 successful authentication + nonce reservation 之后。

不要让“防滥用限流”和“协议级业务限流”共用一个顺序语义。

### Acceptance

新增测试：

```text
valid signature + fresh nonce
-> protocol-level 429
-> nonce row MUST exist
-> same signed request replay -> 401 replay
```

未认证垃圾请求不应因此大量写 `seen_nonces`。

---

## P1-07 `hub.nodes.delete` 未实现冻结 RFC 的 confirmation/idempotency contract

### Frozen contract

RFC-0007 acceptance matrix：

```text
delete without confirmation semantics (idempotency key)
-> denied
```

### 当前实现

当前 delete 只要求：

```text
session
CSRF
reason
```

现有测试甚至直接：

```json
{ "reason": "retired" }
```

并期待 `200`。

### 影响

实现和测试一起偏离冻结 Browser API contract。 destructive operation 无 request identity，网络重试也没有幂等返回语义。

### Required fix

固定 delete request identity，例如：

```json
{
  "requestId": "...",
  "reason": "..."
}
```

或明确 header contract。

要求：

- 缺 requestId / confirmation -> deny；
- 首次成功 -> tombstone + revoke + audit；
- exact replay -> 返回同一结果；
- same requestId + different target/content -> deny；
- 不允许第二次请求简单落成 `already-tombstoned 409` 来代替 idempotency。

### Acceptance

必须增加 duplicate-delete / mismatch tests。

---

## P1-08 enrollment token TTL 没有 1–60 分钟边界

### Frozen contract

RFC-0005：

```text
default 10 min
operator configurable 1–60 min
```

### 当前实现

`ttlSeconds` 未做范围和 integer 校验，直接参与 expiresAt 计算。

### 独立探针

以下值均被接受：

```text
-1
0
3601
31536000
```

最后一个会产生约一年有效 token。

### 影响

原本设计成 short-lived bootstrap credential 的 enrollment token 可以被配置成长效入网凭证。

### Required fix

固定：

```text
integer
60 <= ttlSeconds <= 3600
default = 600
```

undefined 使用默认值，NaN/float/负数/0/3601/超大值全部 fail closed。

### Acceptance

边界测试至少：

```text
59 denied
60 allowed
600 allowed
3600 allowed
3601 denied
-1 denied
0 denied
float denied
NaN-like input denied
```

---

## P1-09 Browser Origin 只比较 host，没有比较 scheme

### Frozen contract

RFC-0007：

```text
Origin, when present, must match request host AND scheme
```

### 当前实现

`browserTrust()` 只执行：

```text
new URL(origin).host === request.headers.host
```

没有 scheme 对比。

### 独立探针

对 HTTP Hub：

```text
request URL: http://same-host
Origin:      https://same-host
```

当前返回：

```text
200
```

### Required fix

必须建立可信 external scheme 语义。

在生产 TLS gateway 场景，Hub 不能盲目信任客户端自带 `X-Forwarded-Proto`，应由受信 gateway strip+inject，或由部署显式配置 public scheme。

Browser trust 应使用：

```text
trusted external scheme + expected host
```

和 Origin 做完整比较。

### Acceptance

增加：

```text
same host + same scheme -> allowed
same host + wrong scheme -> denied
wrong host -> denied
malformed Origin -> denied
```

---

## P1-10 `/hub/session` bootstrap 绕过 Origin / Sec-Fetch-Site 检查

### 当前实现

`handleBrowserRequest()` 对：

```text
POST /hub/session
```

在调用 `browserTrust()` 之前直接创建 session。

因此 session bootstrap 没有执行：

```text
Origin validation
Sec-Fetch-Site cross-site denial
```

### 独立探针

发送：

```text
POST /hub/session
valid gateway assertion
valid injected principal
Origin: https://evil.example
Sec-Fetch-Site: cross-site
```

当前结果：

```text
200
session + csrf token issued
```

### 影响

这直接偏离 RFC-0007 的 browser trust chain。即使攻击者未必能读取 CSRF token，login/session bootstrap 本身也不应成为跨站例外。

### Required fix

把 browser trust 的无 session 部分拆开，例如：

```text
validateGatewayAdmission()
validateOriginAndFetchSite()
bootstrapSession()
```

session bootstrap 只是不要求 existing session / CSRF，不应跳过 Origin / Sec-Fetch-Site。

### Acceptance

新增：

```text
cross-site bootstrap -> 403
mismatched-origin bootstrap -> 403
same-origin gateway-admitted bootstrap -> 200
```

---

# 5. P2 findings

## P2-01 session bootstrap/logout 的 session mutation 与 audit 不在同一 transaction

RFC-0005 D7 固定：

```text
session bootstrap/logout:
browser_sessions mutation + audit row
-> one transaction
```

当前 `bootstrapSession()` 与 `endSession()` 分别先修改 session，再独立 `recordAudit()`。

需要用同一个 `BEGIN IMMEDIATE` 包裹，避免 session 已成功但 audit 丢失，或相反。

---

## P2-02 RFC-0009 的 7 天后 event daily rollup 未实现

当前 maintenance 只有 90 天 purge，没有：

```text
daily rollups after 7 days
```

如果本阶段明确要完成 RFC-0009 全部 event-history contract，应补实现和测试。

若施工方认为 rollup 可延后，必须作为明确 design deviation 提交，而不能静默遗漏。当前建议直接实现，避免 reopening RFC。

---

## P2-03 `hub.tokens.list` 文档语义与实现不一致

RFC/文档描述偏向 active enrollment tokens，但当前 `listTokens()` 返回：

```text
active
expired
consumed
```

全部 metadata。

安全上没有泄露 plaintext/digest，但 API 语义需要固定：

- 如果 endpoint 定义为 active list，应过滤；
- 如果定义为 token history，应改名/改文档并提供 status。

不要让 UI 自行猜 `expiresAt/consumedAt`。

---

## P2-04 package version 仍是 `0.2.6`

当前 Registry 已经是 v0.3 implementation，但 `package.json` 仍：

```text
version: 0.2.6
```

开发分支阶段暂可接受，但在任何 v0.3 candidate/release/production smoke 前必须改成正确版本，否则 runtime/report identity 会产生混淆。

---

## P2-05 production listener / TLS termination 需要 fail-closed gate

当前 Hub 使用 `node:http`，默认：

```text
127.0.0.1:5445
```

默认 loopback 是合理的，但 `DSH_ORBIT_HUB_LISTEN` 可以配置为非 loopback。

Machine security contract 要求 TLS 1.2+。如果 TLS 在 gateway terminate，Hub 应明确只接受受信 private listener 部署。

建议 production acceptance 前实现：

```text
non-loopback listen
+ no explicit trusted TLS-termination/private-network mode
-> refuse startup
```

或者 Hub 自身提供 HTTPS。

本项不是当前 phase 的首要 P1，但必须进入 production gate，不能让可配置的 plain HTTP public bind 悄悄成为正式部署方式。

---

# 6. 测试覆盖缺口总结

当前测试数量很多，但以下测试类型明显不足：

### 6.1 时间流逝

必须补：

```text
4min contact stale
25h contact lost
8d report stale
session idle/absolute expiry
retention cleanup
rotation maintenance expiry
```

### 6.2 乱序消息

必须补：

```text
heartbeat rev-B -> delayed report rev-A
fresh report rev-B -> restores capability
old report arrival must not overwrite current runtime identity
```

### 6.3 周期后台任务

必须直接测试：

```text
registry.maintenance()
```

而不是假设定时器背后的函数可以运行。

### 6.4 Frozen acceptance matrix 的负向条目

当前至少缺：

```text
delete without idempotency confirmation -> denied
same-host wrong-scheme Origin -> denied
cross-site /hub/session bootstrap -> denied
authenticated 429 -> nonce consumed
TTL out of range -> denied
stale capability array -> empty
```

---

# 7. 建议整改顺序

不要并行大改。建议按以下顺序降低回归风险：

## Batch A: maintenance + time aging

1. 修 `EVENT_RETENTION_MS` / `AUDIT_RETENTION_MS` import；
2. maintenance unit/integration tests；
3. registryContact stale/lost aging；
4. report 7-day stale aging；
5. stale capability withholding；
6. event transition tests。

## Batch B: runtime/report authority

1. 明确 nodes runtime identity 只由 heartbeat authoritative 更新；
2. report upload 不覆盖 current runtime；
3. mismatched report 存 history 但 stale；
4. delayed report integration tests。

## Batch C: protocol/security deviations

1. authenticated rate-limit after nonce reservation；
2. delete idempotency/confirmation；
3. enrollment TTL bounds；
4. Origin host+scheme；
5. `/hub/session` bootstrap Origin/Sec-Fetch-Site。

## Batch D: transaction / retention polish

1. session+audit atomic transaction；
2. event rollup；
3. token list semantics；
4. production listener/TLS fail-closed preflight。

修复期间禁止：

```text
修改 frozen RFC 来迁就现有代码
实现 v0.4 routing
实现 v0.5 reverse connection
增加第三方插件兼容逻辑
顺手重构已通过的 crypto/enrollment 主体
```

---

# 8. 下一轮 Review 必须提供的验收证据

施工方再次申请 review 时，请至少附：

1. remediation commit SHA；
2. `git status -sb`；
3. `npm run check` 完整结果；
4. `git diff --check`；
5. 新增测试列表；
6. 以下独立场景的测试名称或输出：

```text
maintenance runs without throw
4min -> registryContact stale
25h -> registryContact lost
8d -> report stale + capabilities withheld
heartbeat rev-B + report rev-A -> runtime remains rev-B
valid signed request receives 429 -> nonce already consumed
replay same signed 429 request -> replay denied
delete without requestId -> denied
duplicate delete requestId -> idempotent same result
TTL 59/3601 -> denied; 60/3600 -> allowed
same-host wrong-scheme Origin -> denied
cross-site /hub/session bootstrap -> denied
session mutation + audit are atomic
```

如果上述关键场景没有进入自动测试，即使人工探针暂时通过，也不建议验收。

---

# 9. Final verdict

```text
Architecture:        APPROVED / FROZEN
Implementation:      NOT ACCEPTED
Registry MVP phase:  HOLD
P0:                  0
P1:                  10
P2:                  5
Existing tests:      158 pass / 1 environment skip / 0 fail
Coverage verdict:    insufficient for time/order/maintenance/browser-bootstrap semantics
```

主体实现值得保留，不需要推倒重来。当前问题高度集中在 control-plane 最容易被普通单元测试遗漏的三个维度：

```text
time passage
message ordering
background maintenance
```

以及两处 Browser/API 冻结契约没有被完整兑现。

**下一阶段不要继续加功能。先用一轮 focused remediation 把上述 P1 全部关闭，再申请 Registry MVP 第二轮实现 Review。**
