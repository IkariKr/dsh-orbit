# v0.6 Stage 5 Candidate Freeze & Automated Qualification — Gate C Review

日期：2026-09-26
审查范围（Scope）：v0.6 Stage 5 Candidate Freeze & Automated Qualification（Gate C）
工作区：`dsh-orbit-v05-formal-candidate`
分支：`chore/v0.6-stage5-candidate-freeze`
被审 HEAD：`5a6fc1039e2a9aa3d622994985e6288b1964d79c`
冻结候选 SHA（Frozen Candidate SHA）：`e6a96eff2df7090b71f41e6c13335a0b607ebcf8`
审查者：独立 Gate C Code Reviewer（只读审查，除本报告外未修改任何文件）

---

## Review Scope

本次审查针对 v0.6 Stage 5 候选冻结与自动化资格认证（Gate C），核对以下契约：

1. Candidate Freeze Invariant：冻结候选 `e6a96eff` 具备完整 v0.6 特性；`5a6fc10` 仅含 `docs/review/` 记录，未触碰 `src/`、`ui/`、`bin/`、`test/`；工作区清洁、local=remote、`git diff --check` clean。
2. RFC-0013 M24 候选绑定自动化报告：精确 24 字段、7 automated 全 `PASS`、17 mounted 保持 `NOT_EXECUTED`、结论 `AUTOMATED_PASS_MOUNTED_PENDING`、候选 SHA 绑定正确、共享校验器返回 `true`、无凭据泄漏。
3. 全量回归 `npm run check` 与 public-tree 检查无回归。

实际被审变更：
- `e6a96eff`（候选）：`scripts/v06-multinode-acceptance-matrix.mjs`（+61/-1）、`test/v06-governance-contract.test.mjs`（+42）。
- `5a6fc10`（冻结提交）：仅新增 `docs/review/review-v0.6-candidate-freeze-and-gate-c-audit-e6a96eff.md`、`docs/review/v06-m24-automated-qualification-e6a96eff2df7090b71f41e6c13335a0b607ebcf8.json`。

---

## Findings

### [P2] 冻结记录引用的测试计数与冻结候选 SHA 不符（实际对应父提交 7409d02）

`docs/review/review-v0.6-candidate-freeze-and-gate-c-audit-e6a96eff.md:23-24`

该记录在标题「Pre-freeze verification completed against the frozen candidate SHA」下声明：

- `npm run check`：539 tests / 533 passed / 0 failed / 6 skipped；
- 聚焦套件 `test/v06-*.test.mjs`：36 tests / 36 passed。

实测（在候选 SHA `e6a96eff` 上）：
- `npm run check`：**540 tests / 534 passed / 0 failed / 6 skipped**，public-tree PASS；
- 聚焦 v06 套件：**37 tests / 37 passed / 0 failed / 0 skipped**。

差异来源可确定：`e6a96eff` 相对其父提交 `7409d02` 新增了 1 个测试（`test/v06-governance-contract.test.mjs` 的「M24 candidate-bound automated qualification report generation and validation」）。在父提交 `7409d02` 上复现得到恰好 539/533 与 36/36。即：记录中数字对应的是**候选的父提交**，而非其自称的冻结候选 SHA。

影响：这是 Gate C 冻结记录中的一项事实性 attestation 不准确（测试总数被少报 1，且明确绑定到错误的 revision），削弱了「对冻结候选 SHA 完成验证」这一声明的可追溯性。触发条件：任何按记录核对冻结候选验证证据的人都会发现数字对不上。最小修复方向：将两处计数更正为针对 `e6a96eff` 的 540/534/0/6 与 37/37/0/0，或明确标注该行验证实际执行于 `7409d02`。注意：这不改变结论——候选本身在全量回归下确为 0 fail，仅属记录精度问题。

### [P2] 资格认证报告 `executedAt`/`runId` 为未来时间戳，与所在提交时间矛盾

`docs/review/v06-m24-automated-qualification-e6a96eff2df7090b71f41e6c13335a0b607ebcf8.json:9-10`

- `runId`: `v06-automated-e6a96eff2df7-20260926180000`
- `executedAt`: `2026-09-26T18:00:00.000Z`

该报告由冻结提交 `5a6fc10` 引入，提交时间为 `2026-09-26T03:23:08+08:00` = `2026-09-25T19:23:08Z`。报告的 `executedAt` 比其自身所在提交晚约 **22.6 小时**（`2026-09-26T18:00:00Z` 为未来时间）。同时 `executedAt` 为整点、`runId` 后缀为整点 `20260926180000`，与候选提交中新增生成器 `generateCandidateBoundAutomatedReport()` 使用 `new Date().toISOString()` / `Date.now()` 的输出特征不符。

影响：作为「Candidate-Bound Automated Report」，其执行时间字段本身不可信（晚于记录提交时刻），属证据完整性（temporal provenance）缺陷。触发条件：任何核对报告时间线与 git 提交时间线的审计。最小修复方向：以真实执行时间戳（≤ 提交时间）重新生成或更正 `executedAt`/`runId`。

### [P3] `validateCandidateBoundReport` 未将 `report.scope` 与请求 `scope` 做绑定校验

`scripts/v06-multinode-acceptance-matrix.mjs:116-135`

`report.scope` 仅被检查是否为 `"automated"|"mounted"` 之一（第 127 行），但从未与调用方传入的 `scope` 参数比对。实测：将报告 `scope` 篡改为 `"mounted"` 后，以 `{ candidateSha, scope: "automated" }` 调用仍返回 `true`。矩阵状态校验由调用方 `scope` 驱动，故实质结论仍受调用方控制，影响有限。修复方向：`report.scope` 必须等于请求 `scope`，否则 fail closed。该缺陷在 v0.5 对应校验器中同样存在（`scripts/v05-reverse-acceptance-matrix.mjs:204`），非本次引入的回归。

### [P3] 默认 `requirePass=false`，`scope:"automated"` 校验不强制 7 个 automated 字段为 PASS

`scripts/v06-multinode-acceptance-matrix.mjs:116,133`

`validateCandidateBoundReport` 默认 `requirePass=false`，因此 `scope:"automated"` 下**不会**强制 automated 字段为 `PASS`。实测：将报告 7 个 automated 字段全部改为 `NOT_EXECUTED` 后，`{ candidateSha, scope:"automated" }` 仍返回 `true`；同理 `summary` 被伪造为任意值也不被校验。这意味着该「资格认证校验器」本身并不保证「7 个 automated 字段 PASS」这一资格结论。任务要求的调用式 `validateCandidateBoundReport(report, { candidateSha, scope:"automated" })` 确返回 `true`（已实测），且提交的工件本身 7 字段确为 PASS，故不构成对本次工件的证伪；但与 v0.5 校验器相同的这一宽松默认，使校验器不足以单独支撑资格声明。修复方向：资格认证路径应默认 `requirePass=true` 或对 automated 字段单独强制 PASS。

### [P3] 报告生成器输出 schema 与已提交工件 schema 不一致；已提交 JSON 未被任何测试机械再校验

`scripts/v06-multinode-acceptance-matrix.mjs:147-164`

生成器 `generateCandidateBoundAutomatedReport()` 输出键为 `{version, candidateSha, runId, generatedAt, scope, summary, matrix}`，而实际提交的工件键为 `{schemaVersion, kind, scope, result, candidateSha, candidateFrozen, branch, runId, executedAt, matrix, fieldEvidence}`。二者不匹配，且全仓库检索显示该生成器**从未**被用于产出已提交工件（仅被测试以内存 dummy 调用）。此外，已提交 JSON 未被任何测试加载校验（`grep` 确认无 `*.mjs` 读取该文件），亦与 v0.5 先例一致。

影响：文档层面易被误读为「工件由该生成器机械产出」，实际工件为手工编写、含生成器不产出的 `fieldEvidence`/`result`/`candidateFrozen` 等字段，且这些字段不进入任何校验路径；提交的 JSON 与候选 SHA 的绑定不存在 CI 级守卫。修复方向：使生成器产出与工件一致的 schema（含 `fieldEvidence`），或明确生成器仅用于测试夹具；并考虑增加一条测试，对 `docs/review/` 下候选绑定 JSON 实际运行校验器。

---

## Verification

以下检查均在本工作区实际执行：

1. **工作区/分支**：`git status --porcelain` 空；`git status --ignored --porcelain` 空（无 ignored 残留）；分支 `chore/v0.6-stage5-candidate-freeze`；HEAD `5a6fc10`。
2. **local=remote**：`git rev-list --left-right --count HEAD...@{u}` = `0 0`；`@{u}` = `5a6fc1039e2a9aa3d622994985e6288b1964d79c` = HEAD。`origin/chore/v0.6-stage5-candidate-freeze` 含候选 SHA。
3. **`git diff --check`**：clean。
4. **冻结提交内容边界**：`git show 5a6fc10 --name-only` 仅 `docs/review/` 两文件；`git diff --name-status e6a96ef 5a6fc10` 仅两个 `A`（新增），无 `src/`、`ui/`、`bin/`、`test/` 变更。确认 `5a6fc10` 仅含冻结确认记录与资格认证报告。
5. **祖先关系**：`e6a96eff` 是 `5a6fc10` 的祖先；`7409d02` 是 `e6a96eff` 的祖先；`bfcc541d…` 与 `6748495…` 均为 HEAD 祖先。`e6a96eff^` = `7409d02`，`5a6fc10^` = `e6a96eff`。
6. **候选特性完整性**：`git log e6a96eff -- src/ ui/ bin/` 显示 Stage 1（`3519f71`/`928c466`）、Stage 2（`bba8e7d`/`4b288bb`/`1a14a8d`）、Stage 3（`0f055b2`/`3e56cf0`）、Stage 4（`5dfa32c`/`087773e`）均在候选祖先内；候选树含 `ui/app.mjs`、`ui/view-model.mjs`、`src/registry/flow-tracker.mjs`、`src/node/route-ingress.mjs` 等。
7. **M24 报告结构**：`matrix` 键数 = 24；`M24_AUTOMATED_FIELDS` = 7、`M24_MOUNTED_REQUIRED_FIELDS` = 17；矩阵中 `PASS` = 7、`NOT_EXECUTED` = 17；`matrix` 与 `fieldEvidence` 状态 0 处不一致；`fieldEvidence` 键数 = 24。
8. **共享校验器**：`validateCandidateBoundReport(report, { candidateSha: "e6a96eff…", scope: "automated" })` 返回 **`true`**。
9. **证据引用真实性**：对 `fieldEvidence` 中每一条引用，程序化核对文件存在且测试名精确出现在对应测试文件中，问题数 = **0**。
10. **无凭据泄漏**：对 JSON 与冻结文档 grep `private|secret|token|cookie|password|api_key|bearer|BEGIN … PRIVATE KEY`，仅命中字段名 `cookieJarIsolationConcurrent` 及描述性文字，无真实凭据/私钥/会话材料。
11. **全量回归**：`npm run check`（public-tree + `node --test`）= **540 tests / 534 pass / 0 fail / 6 skipped**，public-tree validation passed。6 skipped 均为既有环境条件跳过（如 `DSH_ACCEPTANCE_ROOT` 未配置），非本次变更引入。
12. **revision 对照**：候选 `e6a96eff` 实测 540/534/0/6；父提交 `7409d02` 实测 539/533/0/6；聚焦 v06 套件候选 37/37/0/0、父提交 36/36/0/0（用于定位 Finding 1）。
13. **产品代码未引入 harness 依赖**：`grep v06-multinode-acceptance-matrix src/ ui/ bin/` 无命中（脚本头注释「Product runtime must not import this module」成立）。

**未验证**：未执行任何 mounted 实机证据（17 个 mounted 字段按设计保持 `NOT_EXECUTED`，属 Stage 6 范围）；未验证报告 `executedAt` 所声称的真实运行环境（无运行日志留档）。

---

## Residual Risks

- 已提交的候选绑定 JSON 与候选 SHA 的绑定仅靠一次性人工执行校验器维持，无 CI 级守卫；未来若工件被改动而无人重跑校验器，无法自动发现（v0.5 先例相同）。
- `fieldEvidence`、`summary`、`result`、`candidateFrozen` 等字段不进入任何校验路径，其内容正确性依赖人工审查（本次已人工核对通过）。
- 报告时间戳不可信（见 Finding 2），故无法从工件本身确认自动化资格运行的真实时刻；结论正确性依赖对测试套件的独立重跑（本次已重跑）。
- 17 个 mounted 字段的真实系统行为未在本次 Gate C 中验证，需 Stage 6 mounted live evidence 覆盖。
- 未验证 `report.scope` 篡改在真实流水线中的可利用性（本次仅以内存构造证明校验器不绑定该字段）。

---

## Gate

**PASS WITH NON-BLOCKING FINDINGS**

对应用户词汇：**GO**（可进入 Stage 6 mounted live evidence）。

依据：Candidate Freeze Invariant 成立（`5a6fc10` 仅含 `docs/review/` 记录，未触碰产品/测试代码；工作区清洁、local=remote 0/0、`git diff --check` clean）；候选 SHA `e6a96eff` 具备完整 v0.6 Stage 1–4 特性与契约；M24 报告精确 24 字段、7 automated PASS / 17 mounted NOT_EXECUTED、结论 `AUTOMATED_PASS_MOUNTED_PENDING`、候选 SHA 绑定正确、共享校验器返回 `true`、无凭据泄漏；全量回归 `npm run check` 0 fail 无回归。全部 Finding 为 P2/P3，均为文档/证据精度与校验器严格性问题，不阻断 Gate C，建议在进入 Stage 6 前顺带修正 Finding 1 与 Finding 2 以保持冻结记录的可追溯性。

---

## Review Report

`docs/review/2026-09-26-v06-stage5-candidate-freeze-gatec-5a6fc10.md`
