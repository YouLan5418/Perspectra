# Phase 9B Qwen 交接说明

> **交接已完成：** 本文的三个剩余单元已经由提交 `982012d`、`01b5859` 与 `a1aa750` 关闭，不再作为当前待办。最终行为、验证结果和 Phase 9C 边界见[Phase 9B 完成报告](2026-09-02_阶段报告-Harness-Cordis-World-Phase-9B-report.md)。

> **接手起点：** `phase9b/bounded-multi-wave` 与 `qwen` 应共同指向本文所在提交。开始工作前必须确认已跟踪工作树干净；`.idea/`、`.workbuddy/`、`coverage-detail/` 和现有未跟踪审查报告属于用户本地材料，不得加入提交。
>
> **当前状态：** 有界多 wave 的权威存储、Scheduler、Root Round 接线、自动恢复和运维 worker 已完成。Phase 9B 尚未结束；剩余范围仅为 Reaction 通知、Presentation 因果链、阶段报告收口，不进入 Phase 9C。

## 接手后先做什么

在仓库根目录执行：

```powershell
git branch --show-current
git status --short
git log --oneline -8
corepack pnpm@11.7.0 check
```

预期结果：

- 当前分支为 `qwen`；
- `qwen` 与 `phase9b/bounded-multi-wave` 指向同一提交；
- 除用户原有未跟踪文件外，没有已跟踪改动；
- `pnpm check` 完整通过。

## 已完成边界

| 能力 | 已实现行为 | 关键位置 |
| --- | --- | --- |
| Manifest 能力门 | 只有 Manifest v5 的显式 `responsive/v1` 启用 Reaction；旧 Manifest 行为与 Hash 不变 | `packages/kernel/src/world-spec.ts`、ADR-0078 |
| Phase 8 契约继承 | Manifest v5 继续使用 Context v2、Scene v2、Cognitive Memory 与 ProviderCall 边界 | `packages/kernel/src/world-bootstrap.ts`、`packages/application/src/context-pipeline.ts` |
| Root Round 接线 | Root Round 的 Observation 与首个 Cycle/Jobs 在同一 World 事务提交 | `packages/application/src/round-coordinator.ts`、`packages/store-sqlite/src/world-store.ts` |
| 多 wave Scheduler | 同 wave 冻结并行提案，wave 间串行；最多 3 waves、8 calls、每角色 2 calls、每次最多一个 `speak@1` | `packages/application/src/reaction-scheduler.ts`、`reaction-worker.ts` |
| 抢占与 FIFO | 旧 Cycle 收口后才处理下一条玩家输入；不会插入半个 wave，也不会恢复被抢占 Cycle | `packages/application/src/world-application.ts` |
| Provider 生命周期 | prepared、dispatch、response、validated、commit 全部复用 Phase 8 append-once 账本；歧义调用不自动重发 | `packages/application/src/reaction-scheduler.ts` |
| 启动恢复 | Host 启动扫描未完成 Root Round 和 active/stop-requested Cycle；worker wake 为 level-triggered 且可合并 | `packages/operations/src/rpc.ts` |
| 失败可观测性 | Reaction worker 失败进入独立 Metric 与 `reaction.worker.failed` Audit；可重试错误有界重唤醒 | `packages/operations/src/metrics.ts`、`packages/store-sqlite/src/branch-administration.ts` |
| API | `reaction.get/list/cancel/process` 已接入本地 JSON-RPC | `packages/operations/src/rpc.ts` |
| 确定性 | Job、Stimulus、地址和 settlement 重建统一使用世界 UTF-16 排序；健康库不会因 SQLite BINARY 顺序误报分歧 | `packages/store-sqlite/src/reaction-cycle.ts`、`world-store.ts` |

本轮收口提交：

```text
4a71a51 fix(kernel): carry phase 8 contracts into manifest v5
cb5d67a feat(application): run bounded multi-wave reaction cycles
4c7e670 feat(operations): recover and observe reaction workers
```

## 剩余实施范围

只完成以下三个单元，每个单元相关测试通过后独立提交。

### 1. 发布非权威 Reaction 通知

最小通知闭集：

- `reaction.started`；
- `reaction.round_committed`；
- `reaction.completed`。

每条通知至少携带可用的 `WorldAddress`、`cycleId`、`rootRoundId`；wave 提交通知还应携带 `wave` 与 `roundId`。通知是可重复、可乱序、可丢失的提示，不能成为调度输入或权威状态。消费者必须能通过 `reaction.get/list` 重新同步。

推荐从 `ReactionDrainResult.waves` 生成 `round_committed/completed`，不要根据 Provider 返回时序发送通知，也不要在 Tx B 提交前流式暴露提案。自动 round worker、启动恢复和显式 `reaction.process` 三条入口应复用同一通知投影函数。

### 2. 补齐 Presentation 因果链

最终用户看到的连续 NPC 反应必须属于同一 Root Cycle，而不是伪装成多条玩家回合。展示记录需要能追溯：

```text
rootRoundId -> cycleId -> wave -> reactionRoundId -> authoritative action/event
```

硬边界：

- wave 只能在世界事务提交后整批展示；
- 展示顺序使用 Authority 中的稳定 Action 顺序；
- 不输出未裁决 Proposal、私有 Character Context、Memory 或作者真相；
- Presentation 只能读取耐久权威记录，不能触发下一 wave；
- 达到预算/波数上限时，普通视图使用自然语言安静提示，调试视图保留 terminal reason、预算和 Authority 引用。

应补一个端到端断言：Alice wave 1 发言、Bob wave 2 回应，二者共享同一 `rootRoundId/cycleId`，但拥有不同 `wave/roundId`，重启后仍可得到相同展示顺序与 Hash。

### 3. 收口 Phase 9B 文档

更新以下文档中已经过时的“尚未自动接线”表述：

- `docs/2026-09-01_阶段报告-Harness-Cordis-World-Phase-9B-progress-report.md`；
- `docs/2026-09-01_阶段报告-Harness-Cordis-World-Phase-9B-scheduler-report.md`；
- `docs/README.md`。

最终报告必须明确区分：

- Phase 9B 已完成：单次玩家输入触发至少两 wave、抢占、恢复、通知、Presentation；
- Phase 9C 才处理：跨 Branch 公平性/背压、行政边界、Pack 创作入口、真实磁盘迁移和 Release Closure；
- 真实 API Key 不属于 Phase 9 完成条件。

## 不要改变的设计

- 不修改 Accepted ADR 原义；方向变化必须新增 superseding ADR。
- 不把 Reaction 做成同一个 World Tick 内的微步；每个 Reaction Round 仍提交独立 Tick 和事件事实。
- 不伪造 playerAction；Reaction Round 继续是 NPC-only Round。
- 不让模型输出越过 Validator/Rulebook 直接成为世界事实。
- 不用墙钟重新推导已经耐久化的终止原因。
- 不为通知或 Presentation 新建第二事实源。
- 不扩大 `responsive/v1` 的 3/8/2 预算，也不增加 `speak@1` 之外的 Reaction Action。
- 不提前实现 Phase 9C、真实网络 Provider、Harness Bridge 或 TencentDB。

## 验收门槛

至少增加以下测试：

1. 一次玩家输入产生 `started -> round_committed(wave 1) -> round_committed(wave 2) -> completed` 的可去重通知信息；
2. 通知订阅者抛异常、通知重复或丢失不影响 Cycle 终态；
3. 自动 worker、启动恢复和 `reaction.process` 产生等价通知字段；
4. Presentation 只展示已提交 Action，并保留完整 Cycle 因果链；
5. 重启、同键重放和玩家抢占不重复 Provider 世界效果；
6. 旧 Manifest v1～v4 不产生 Reaction 通知或 Reaction Presentation。

交付前运行：

```powershell
corepack pnpm@11.7.0 check
git diff --check
git status --short
```

生产文件继续保持逐文件 statements、branches、functions、lines 四项 100%；高风险提交窗口继续使用真实子进程硬终止测试。

## Evidence → Finding → Path

### Evidence

| ID | 观察 | 来源 | 复现 |
| --- | --- | --- | --- |
| E-001 | Manifest v5、Root/Cycle、多 wave、抢占和恢复实现已进入当前分支 | 本文列出的 3 个提交及其父提交 | `git log --oneline -12` |
| E-002 | 74 个测试文件、787 项 coverage 测试通过，四项覆盖率均为 100% | 2026-09-02 本机验证 | `corepack pnpm@11.7.0 test:coverage` |
| E-003 | P0～P6、Phase 8 性能和 29 项子进程硬崩溃测试通过 | 2026-09-02 本机验证 | `corepack pnpm@11.7.0 check` |
| E-004 | Phase 9 规格仍要求三类通知和连续反应 Presentation | `docs/spec/phase-9-implementation-v0.1.md` §19～§20、§23 | 阅读对应章节 |

### Findings

| ID | 结论 | 证据 | 置信度 |
| --- | --- | --- | --- |
| F-001 | Phase 9B 的权威运行闭环和最终用户两 wave 退出条件已经由正式路径验证 | E-001、E-002、E-003 | 高 |
| F-002 | Phase 9B 尚不能关闭，因为通知和 Presentation 是规格内交付且尚未形成完整产品证据 | E-004 | 高 |
| F-003 | 下一步不需要扩 Schema 或重写 Scheduler，应只在既有耐久结果上补非权威投影和阶段文档 | E-001、E-004 | 高 |

### Path

P-001（从当前分支到 Phase 9B 完成）：

1. 从已提交的 Cycle/Wave 结果生成可丢失通知，不改变世界事实——E-001、E-004 / F-002；
2. 用 Authority 和耐久 Event/Outbox 构建连续反应 Presentation 因果链——E-004 / F-002；
3. 完成通知、隐私、重启、抢占端到端矩阵并运行完整门槛——E-002、E-003 / F-001；
4. 更新阶段报告并将 Phase 9B 标记完成，随后再单独规划 Phase 9C——E-004 / F-003。

残余风险：dispatch 后崩溃的外部模型调用仍只能保证世界效果 at-most-once，不能宣称外部计费 exactly-once；该边界已由 ADR-0077 接受，通知和 Presentation 不得掩盖它。
