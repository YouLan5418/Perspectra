# Harness / Cordis World Phase 8A 阶段报告

> 当前状态：**Phase 8A 已完成，Phase 8 整体仍在实施中。** 代码暂停在 P8.5 之后、P8.6 之前。Memory v2、可重建 Context、Reflection、Provider 生命周期和“雨夜同行”验收 Pack 尚未实现。

## 1. 报告信息

| 项目 | 内容 |
| --- | --- |
| 报告日期 | 2026-08-28 |
| 冻结发布基线 | `v0.2.0`，提交 `08c9a5f` |
| Phase 8A 实现停点 | `8c1e267 feat(scene): add scene decision version 2` |
| Phase 8 规格 | `phase8/v0.1` |
| 目标候选版本 | `0.3.0`，尚未形成候选或 Tag |
| 当前 Git 状态 | Phase 8A 实现包含 13 个未推送提交；计入本报告提交后，本地 `main` 预计比 `origin/main` 领先 14 个提交 |
| 本机验收环境 | Windows、Node.js 24.14.1、pnpm 11.7.0 |
| 外部集成 | Harness Bridge、TencentDB、真实模型 API 均保持禁用 |
| 运行边界 | 私有源码、stdio only、无远程监听 |

## 2. 阶段结论

Phase 8 已经完成第一道门“权威结构”：项目现在可以显式编译 `worldpack-source/v2`，生成锁定认知、Scene 和 Context 版本的 Manifest v4；也可以仅依赖耐久事件，在任意合法 `asOfSeq` 重建七类角色主观状态和 Scene v2 决断。

这意味着 Phase 8 最危险的基础问题——“角色心理是否会变成不可重放的临时状态”“Scene 调度是否会依赖进程内猜测”“新能力是否会悄悄改变旧世界”——已经得到结构性回答。当前实现仍坚持 World Event Log 唯一权威、角色认知彼此隔离、未来信息不可见、模型只能提出 Proposal，以及旧版本不隐式升级。

但这还不是 Phase 8 完成态。角色的长期 Memory 尚未正式接入，实际发给 Agent 的 Context 还没有通过 Checkpoint、Tail、预算选择与双 Hash 完整重建，Provider 调用的耐久生命周期也尚未落地。因此当前版本能够证明“认知与场景状态可重建”，还不能证明“真实 Agent 在长期多轮运行中看到的完整输入可精确重建”。

## 3. 实施进度

| 单元 | 状态 | 当前结果 |
| --- | --- | --- |
| P8.1 文档冻结 | 已完成 | 冻结 Phase 8 Context、认知、版本和 Provider 边界；补齐 ADR-0064～ADR-0068 等决策 |
| P8.2 契约与 Registry | 已完成 | 新增 Basic v1 认知词汇、Context/Receipt 契约和 Phase 8 Registry |
| P8.3 World Pack v2 | 已完成 | 严格校验、确定性编译、Manifest v4、Genesis 认知与文档种子 |
| P8.4 时态认知 Projection | 已完成 | 七类主观状态可按角色、分支和序号精确重建 |
| P8.5 Scene Decision v2 | 已完成 | Scene 生命周期、成员关系、动作时刻可见性和稳定决断 Hash |
| P8.6 Cognitive Memory v2 | 未开始 | 下一实施单元 |
| P8.7 Context/Checkpoint/缓存 | 未开始 | 等待 Memory 水位和来源账本稳定 |
| P8.8 Reflection/Policy | 未开始 | 不提前创建半成品入口 |
| P8.9 Provider 生命周期 | 未开始 | Scripted Provider 也尚未进入新耐久调用链 |
| P8.10 “雨夜同行”Pack | 未开始 | 最终用于非悬疑、多角色、长期认知验收 |
| P8.11 加固矩阵 | 未开始 | 包括 Phase 8 专属崩溃与完整兼容矩阵 |
| P8.12 证据收口 | 未开始 | 完成三道门后才执行 |

三道阶段门的状态如下：

| 阶段门 | 覆盖单元 | 状态 |
| --- | --- | --- |
| 8A：权威结构 | P8.2～P8.5 | **通过** |
| 8B：可重建输入 | P8.6～P8.7 | 未开始 |
| 8C：行为闭环 | P8.8～P8.11 | 未开始 |

## 4. 已交付能力

### 4.1 显式版本边界

- `worldpack-source/v1`、compiled `worldpack/v1`、Manifest v1～v3、Context v1 和 Scene v1 保持原义。
- 新能力只由显式的 `worldpack-source/v2`、compiled `worldpack/v2`、Manifest v4、Context v2 和 Scene v2 启用。
- 不存在“打开旧世界时自动升级”的隐式路径。
- Manifest v4 锁定认知词汇、Registry、运行能力和对应 Hash；找不到精确实现时必须 fail-closed。
- Phase 7 的 `epistemicStatus` 与 Phase 8 的 `stance` 保持为两套独立词汇，不自动映射。

### 4.2 World Pack v2 与 Genesis

创作者内容现在可以通过严格的 v2 来源目录表达：

- 角色初始 Subjective Claim、Goal、Relationship、Affect、Inner Tension、Commitment 和 Open Loop；
- Scene v2 生命周期与初始成员；
- 版本化认知、Memory、Context 和 Scene 能力声明；
- 普通文档与 `memory_seed` 文档。

编译器会执行严格 JSON、路径边界、引用完整性、版本能力和 Registry Hash 校验，并以确定性顺序生成 Manifest 与 Genesis。`memory_seed` 只生成带来源的 Observation，不直接写 Memory 数据库，从而保留“世界事实提交 → Memory 捕获”的正式边界。

当前 Golden：

| 产物 | Hash |
| --- | --- |
| Manifest | `sha256:c1b69474620182da8ec2c5a18f5a07de68014c2ea1eb61477d79fcbc800d7baf` |
| Genesis | `sha256:d3ef8996d3df35791c68de01fa01f44c598cd67de114495a1fc8c564497c40a1` |

### 4.3 七类角色主观状态

`CognitionProjectionRebuilder` 已能从经过验证的事件前缀重建：

1. Subjective Claim；
2. Character Goal；
3. Relationship Attitude；
4. Affect Episode；
5. Inner Tension；
6. Commitment；
7. Open Loop。

所有记录都带真实 World Event 来源引用和有效序号范围。重建会执行词汇、状态转换、所有权、来源和唯一性校验；同一角色对同一 proposition 同时只能有一个 active Claim。Fork 只继承 `forkSeq` 之前的认知，future canary 不会进入子分支或其他角色视图。

### 4.4 Scene Decision v2

Scene v2 已实现：

- `created → active → closed` 生命周期；
- 角色加入和离开 Scene 的耐久事件；
- 全局可以有多个 active Scene，但同一角色最多属于一个 active Scene；
- 零焦点角色场景合法；
- 参与者在 Round 开始时冻结；
- 每个 Action 的观察者集合按该动作裁定前的事件前缀重新计算；
- `scene_public`、`direct`、`private`、`self` 四类可见范围；
- 私密动作的旁观者只获知“发生过一次不可见互动”，不获得对白正文；
- 决断结果具有稳定 `decisionHash`，可以在 restart、fork 和历史水位下重建。

若同一角色同时进入多个 active Scene，系统返回 `SCENE_MEMBERSHIP_INVARIANT`，应用层按完整性故障隔离分支，而不是选择任意一个 Scene 继续运行。

## 5. 兼容性与架构符合度

| 不变量 | 当前证据 | 结论 |
| --- | --- | --- |
| World Event Log 是唯一世界事实权威 | 认知和 Scene 均从事件前缀重建，无第二事实源 | 保持 |
| 模型输出只能成为 Proposal | Phase 8A 未增加模型直写 Projection 或 Store 的通道 | 保持 |
| 角色认知独立 | 按 owner 重建、跨角色 future canary 与来源校验 | 保持 |
| as-of 隔离 | 重建显式接受 `asOfSeq`，fork 截断测试通过 | 保持 |
| Hash 与版本 fail-closed | Manifest v4、Registry 与决断 Hash 均显式锁定 | 保持 |
| 旧世界不隐式升级 | 新能力只能由 v2/v4 显式选择 | 保持 |
| 外部服务不是权威 | Harness、TencentDB、真实模型仍禁用 | 保持 |

Phase 8A 没有把心理状态实现成一套“通用心理公式”。Kernel 只冻结版本化词汇、来源、状态机和权限边界，不推导“帮助必然增加信任”或“听见 P 就相信 P”。具体心理变化仍应由创作者内容、角色 Proposal 和后续确定性 Policy 共同表达。

## 6. 验证结果

Phase 8A 实现停点 `8c1e267` 已完成两层本机验证：

```powershell
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 test
```

| 门槛 | 结果 |
| --- | --- |
| TypeScript typecheck | 通过 |
| Oxlint | 通过 |
| V8 per-file coverage | 56 个覆盖文件；588 个测试；statements/branches/functions/lines 均 100% |
| P0～P6 集成门槛 | 全部通过 |
| Crash Harness | 18 项真实子进程硬终止测试通过 |
| 完整测试集 | 57 个测试文件、606 个测试全部通过 |

本报告没有重新运行上述长耗时门槛；数据来自实现停点完成 P8.5 后的最近一次完整验收。报告只增加文档，不改变生产代码、Schema、Fixture 或测试。

## 7. 已知审查项

独立审查对 Phase 8A 的总体判定为通过，未发现阻塞级问题；以下事项尚未修复或决断，恢复开发时必须显式处理：

| 优先级 | 事项 | 当前判断 |
| --- | --- | --- |
| P2 | `CharacterGoal.objective.kind` 在 Projection 读取端未对照 `GOAL_OBJECTIVE_KINDS` 校验 | 应在进入 P8.8 前补齐生产校验和回归测试，防止未知目标类型形成毒化历史 |
| P3 | `direct` 动作对非目标在场者是否应产生 occurrence-only Observation | 规格语义仍有解释空间；应先形成明确决定，再改代码或测试 |
| P3 | occurrence-only Observation 仍包含 `resolution.reason` | 需要决定 reason 是否可能携带正文或私密语义；若可能，应改为固定、无内容原因码 |
| 设计债 | 非法认知事件目前主要在 Projection 读取时 fail-closed | Store 仍可保存会在后续重建时触发隔离的事件；写入侧 Schema Gate 是否进入 Phase 8 需单独决断 |
| 性能债 | 认知与 Scene 当前依赖完整事件前缀重放 | 正确性已成立；性能问题应由 P8.7 Checkpoint/Tail 解决，不应提前引入第二事实源 |

这些事项不会否定 8A 的权威结构结论，但第一项属于后续行为接线前的必修复项，另外两项可见性问题属于 Context 泄漏测试开始前的必决断项。

## 8. 尚未交付的能力

当前不能声称已经完成以下能力：

- Cognitive Memory v2 的耐久 Job、水位、capture、recall 和 catch-up；
- L1 Summary 与 Continuity Checkpoint 的统一来源关系；
- CharacterControllerContext v2、DirectorPlanningContext v1 与稳定预算选择；
- `contextHash` 与 `providerRequestHash` 的完整 Golden 和缓存布局；
- Context Explain 与不泄露拒绝候选数量的诊断；
- Reflection 校验和确定性 Cognitive Policy；
- Scripted Provider 的 prepared/dispatch/result/commit 耐久生命周期；
- before-dispatch、after-dispatch、after-response、before-world-commit 的 Phase 8 硬崩溃矩阵；
- “雨夜同行”六轮参考 Pack；
- Phase 8 跨平台 GitHub Actions 证据、`0.3.0` 候选和 Tag；
- 真实 API Key、HTTPS 或 Harness Bridge。后三项按总纲推迟到后续 Phase，不属于当前 Phase 8 实施范围。

## 9. Git 与发布状态

`v0.2.0` 仍是最近一个正式、已完成四格 CI 的发布基线。Phase 8A 的 13 个实现提交尚未推送；计入本报告提交后，本地分支预计领先远端 14 个提交。当前没有 `0.3.0` Tag，也没有 Phase 8 的远端 CI 证据。

关键提交如下：

| 提交 | 内容 |
| --- | --- |
| `e8d2d5d` | 冻结 Phase 8 Context 与认知契约 |
| `dd70879` | 关闭实现前审查中的文档缺口 |
| `8db3112` | 增加认知和 Context 基础契约 |
| `fcae860`～`ab4fba0` | 定义并严格校验 World Pack v2 来源 |
| `4507f53` | 冻结 Phase 8 运行 Registry |
| `efc55d0`～`6eebaa8` | 编译 v2、接受 Manifest v4、生成 Genesis |
| `9f53ada` | 重建七类时态主观状态 |
| `8c1e267` | 增加 Scene Decision v2 |

## 10. 恢复开发入口

下一次恢复时，不应直接跳到 Provider 或参考 Pack。推荐顺序是：

1. 先补齐 `objective.kind` 读取端校验，并对 `direct` 旁观者与 occurrence-only reason 作出明确决定；
2. 实施 P8.6 Cognitive Memory v2，建立耐久 Job、水位、来源映射、capture/recall 和 catch-up；
3. 完成 restart、fork、future canary、跨 Branch/角色 recall 隔离后，再进入 P8.7；
4. P8.7 复用同一套确定性 L1 Summary：Checkpoint 只按 identity/hash 引用，不创建第二套摘要算法；
5. 用 Golden 分开钉死 `contextHash` 的语义边界与 `providerRequestHash` 的精确布局边界；
6. 只有 8B 通过后，才接 Reflection 与 Provider 行为闭环。

## 11. Evidence → Finding → Path

### Evidence

| ID | 不可变观察 | 来源 | 复现方式 |
| --- | --- | --- | --- |
| E-001 | Phase 8A 实现停点为 `8c1e267`，该实现序列比 `origin/main` 多 13 个提交 | Git 历史与状态 | `git log --oneline 08c9a5f..8c1e267` |
| E-002 | Phase 8 规格将 P8.2～P8.5 定义为 Gate 8A | `docs/spec/phase-8-implementation-v0.1.md` §18 | `rg -n "8A：权威结构|P8.2～P8.5" docs/spec/phase-8-implementation-v0.1.md` |
| E-003 | P8.5 后 `pnpm check` 全绿，覆盖率四项 100%，P0～P6 与 18 项 crash 通过 | 最近一次本机验收输出 | `corepack pnpm@11.7.0 check` |
| E-004 | 完整测试集为 57 个文件、606 个测试全部通过 | 最近一次本机验收输出 | `corepack pnpm@11.7.0 test` |
| E-005 | Manifest/Genesis Golden 已由测试锁定 | World Pack v2 测试与 Fixture | `corepack pnpm@11.7.0 vitest run packages/world-pack/src/compiler-v2.test.ts` |

### Findings

| ID | 结论 | 状态 | 证据 |
| --- | --- | --- | --- |
| F-001 | Phase 8A 的契约、Pack v2、时态认知和 Scene v2 已完成且通过本机门槛 | validated | E-001、E-002、E-003、E-004、E-005 |
| F-002 | Phase 8 整体尚未完成，当前停点是 P8.6 之前 | validated | E-001、E-002 |
| F-003 | 当前没有 `0.3.0` 发布或 Phase 8 远端 CI 证据 | validated | E-001 |

### Path

从当前停点达到 Phase 8 完成态的唯一正式路径为：

```text
Phase 8A 已完成
  → 审查项前置闭合
  → P8.6 Memory v2
  → P8.7 Context / Checkpoint / 双 Hash（Gate 8B）
  → P8.8 Reflection / Policy
  → P8.9 Provider 生命周期
  → P8.10 参考 Pack
  → P8.11 加固矩阵（Gate 8C）
  → P8.12 证据收口与 0.3.0 候选
```

任何一步若要求放宽 World Event 权威、Hash、as-of、角色权限或 SQLite 原子性，都必须停止该单元并新增 superseding ADR，不能以更新 Golden 或弱化测试绕过。

## 12. 最终判断

项目目前没有偏离“用悬疑 Demo 验证认知隔离、最终形成可承载多类创作者世界的通用运行时”这一主线。Phase 7 已证明创作者只改内容目录即可运行非悬疑世界；Phase 8A 又把可重建角色心智和多 Scene 决断建立在同一条权威事件链上。

当前最准确的进度描述是：**基础平台和通用内容闭环已发布为 v0.2.0；Phase 8 的权威结构已经完成，长期 Memory 与实际 Agent Context 闭环尚待实施。**
