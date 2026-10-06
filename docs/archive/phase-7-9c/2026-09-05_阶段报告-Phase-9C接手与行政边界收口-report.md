# Phase 9C 接手与行政边界收口报告

> **结论：Qwen 已提交的 P9C.0～P9C.2 得以保留，本轮接手并完成其未提交的 P9C.3。本机完整验收通过；不代表整个 Phase 9C 或 0.4.0 发布已经完成。**
>
> 本轮在 `qwen` 分支工作，不合并模型实验分支，不推送、不创建 Tag。损坏的 Reaction 账本只能被隔离，不能靠重算 Hash 自动“修好”。

## 1. 接手位置

| 项目 | 状态 |
| --- | --- |
| 接手基线 | `a1116f1`，`qwen` |
| P9C.0 决策和基线 | `ebf35d4`，已有 ADR-0079～0081 与真实 v15 基线报告 |
| P9C.1 调度 | `434b0bd`，已有有界单步调度、公平轮转与耐久扫描 |
| P9C.2 关闭和指标 | `a1116f1`，已有有预算的关闭与调度指标 |
| 接手时未完成内容 | 10 个已跟踪文件的 P9C.3 改动；没有丢弃或重置这些改动 |
| 独立模型实验 | `experiment/ollama-qwen35-4b` 留在独立 worktree，仍为 `d73e908` |

P9C.0～2 的历史交付记录沿用原提交。本轮复跑包含其测试的完整门槛，没有把“复跑通过”表述为对其所有代码重新独立审查。

## 2. 本轮完成了什么

| 场景 | 现在的行为 | 验证 |
| --- | --- | --- |
| 维护期间已有反应周期 | 关闭入口，请求行政停止，让已冻结的一波收口，不再启动下一波 | 真实应用路径、Provider 等待交错 |
| 维护期间多条玩家消息排队 | 一条玩家 Round 与其 Cycle 交替处理，不批量创建互相冲突的周期 | 两条排队输入、三个 Cycle 全部终态 |
| 维护开始时 Root 还在生成 | 等待该 Root 提交，补写新 Cycle 的停止请求；不调用后续反应 Provider | 门闩控制 Root Provider 的测试 |
| 归档或分叉遇到活跃 Cycle | 返回可重试错误，不偷偷取消 Cycle，也不释放正在使用的 Writer | Provider 未返回时执行行政调用 |
| 行政排空中刚创建 Cycle | 暂停排空，等周期结束后重试，不继续提交下一条 Root | 两条排队输入的归档重试链路 |
| Cycle 已完成后分叉/归档 | 正常完成，子分支不继承 live Cycle/Job | 结束后分叉、查询子分支、归档父分支 |
| 健康账本的紧急隔离 | 同事务封锁 Branch、终态化 Cycle/Job、删除 Writer Lease；不等待 Provider | 存储测试、迟到结果拒绝、导出与受控恢复 |
| Reaction 账本自身损坏 | 原样保留证据，仍封锁 Branch 和撤销写权限；明确报告未能终态化 | Cycle/Wave/Job Hash 分歧及畸形 Hash 四种测试 |
| 隔离提交前/后硬崩溃 | 新连接只能看到完整旧状态或完整隔离状态 | 2 个新增子进程硬终止用例 |

另外修复了 Qwen 未完成测试中的 `fixtureReactionCommitRequest` 缺失导入，以及维护入口遗漏的 critical inflight delivery 检查。

### 对损坏账本的明确例外

[ADR-0082](../../adr/ADR-0082-quarantine-unreadable-reaction-ledger.md) 局部取代 ADR-0079 的“隔离时无条件终态化 Cycle”要求：

- 只有通过只读完整性校验的 Bundle 才允许终态更新。
- 无法读取或验证时，结果和审计写 `unresolvedReactionCycle: true`；不把损坏数据包装成健康终态。
- 写入/CAS/提交失败仍回滚，不被只读预检的例外吞掉。
- 未解决的损坏不能通过恢复校验。这不是新增修库接口，也不自动恢复坏账本。

健康路径的 `closed_without_dispatch` 是既有 Wave 状态词汇；本轮没有伪造 Provider 调用记录。已经发出的外部请求可能仍返回，该状态不能解读为“外部服务一定没收到请求”。能保证的是隔离后它不能提交世界事实。

## 3. 验证证据

环境：Windows、Node `v24.14.1`、pnpm `11.7.0`。在仓库根目录运行：

```powershell
$env:pnpm_config_verify_deps_before_run = 'false'
corepack pnpm@11.7.0 check
```

该环境变量仅禁止 pnpm 在运行脚本前自动重新安装依赖，不跳过任何项目验收步骤；锁文件和依赖未修改。

最终运行覆盖代码提交 `e570be7` 的文件内容，退出码 **0**：

- TypeScript、Oxlint 通过。
- 常规/覆盖率测试：**75 个文件、826 项通过**。
- 生产代码逐文件 statements / branches / functions / lines：**全部 100%**。
- P0～P6 集成门槛：全部通过。
- P8 性能门槛：3 项通过。
- 独立硬崩溃测试：**31 项通过**，包含本轮新增的隔离提交前后两个窗口。

这些是本机证据；本轮未执行远程四格 CI。

### Evidence → Finding → Path

| Evidence | 实际观察与可复现入口 | Finding | Path |
| --- | --- | --- | --- |
| E-001 | 接手后的首次 `check` 因 crash fixture 未导入而在 TypeScript 阶段失败 | F-001：工作停在未完成状态，不可直接提交 | 补齐导入，再跑真实硬终止测试 |
| E-002 | 多排队输入回归最初触发 `UNIQUE constraint failed: world_reaction_cycles.address_key`；修复后通过 | F-002：批量 drain 不能跨过新建 Cycle | 单 Root → 收口其 Cycle → 下一 Root；见 `tests/reaction-e2e.test.ts` |
| E-003 | Provider 门闩测试：维护可收口，隔离后迟到 `LATE_CANARY` 没有进入 World Event Log | F-003：行政操作必须区分普通停止和紧急隔离 | 早期屏障 + Writer 生命周期保护 + 同事务 fence；同一 E2E 文件 |
| E-004 | 损坏 Cycle/Wave/Job 后执行隔离：原始行保持相同，Lease 消失，恢复失败 | F-004：隔离不能依赖损坏账本健康 | ADR-0082 的只读预检与显式未解决诊断；`reaction-cycle.test.ts` |
| E-005 | 最终完整 `check` 退出 0，826 项测试、四项 100%、31 项硬终止通过 | F-005：P9C.3 达到本机门槛，不代表发布门槛 | 保留小提交，再进入 P9C.4～7 |

单独复现核心交错用例：

```powershell
corepack pnpm@11.7.0 exec vitest run tests/reaction-e2e.test.ts packages/store-sqlite/src/reaction-cycle.test.ts packages/store-sqlite/src/branch-administration.test.ts
corepack pnpm@11.7.0 test:crash
```

E-002 的红灯是修复前的观察；当前回归用例应通过，不应再复现该错误。没有保存或提交真实模型响应、API Key 或运行数据库。

## 4. 本地提交与后续接手点

| 提交 | 内容 |
| --- | --- |
| `212a93e` | Store 行政屏障、Cycle 隔离、ADR-0082、存储与硬崩溃测试 |
| `e570be7` | 应用层维护收口、归档/分叉早期拒绝、排空顺序与跨模块交错测试 |

本报告及索引独立文档提交。既有 `.idea/`、`.workbuddy/`、`coverage-detail/` 和用户审查报告未修改、未暂存。已跟踪代码没有遗留未提交改动；不能把仍含这些用户未跟踪文件的目录称为完全干净。

下一单元是 **P9C.4：让创作者通过正式 Pack v3 文件启用现有反应能力**。按 [实施规划](2026-09-02_实施计划-Harness-Cordis-World-Phase-9C.md) 和 ADR-0080，保留 v1/v2 Golden，增加显式 reaction policy 与最小 `responsive-social` 验收，不增加新玩法。

其后仍有：

1. **P9C.5**：五库一致备份/恢复集合、真实 v15→v16 迁移验证。旧基线已生成不等于恢复能力已实现。
2. **P9C.6**：长历史、多分支、并发与故障两档验收；本轮的局部行政测试不能替代整个压力矩阵。
3. **P9C.7**：创作者手册、Release Closure 与候选版本；远程推送、四格 CI、Tag 仍按用户授权顺序处理。

真实模型实验说明现有管线已经能运行，但不自动证明角色体验优于现有聊天产品。其接入和体验结论继续保留在实验分支；不借本次交接把实验适配器自动提升成正式 Provider。
