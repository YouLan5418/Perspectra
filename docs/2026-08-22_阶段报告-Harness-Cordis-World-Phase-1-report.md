# Harness / Cordis World V0 Phase 1 阶段报告

> 日期：2026-08-22
> 状态：本机 Phase 1 门槛通过
> 基线：`docs/spec/implementation-v0.2.md`
> 平台：Windows，Node 24.14.1，pnpm 11.7.0

## 1. 结论

Phase 1 已形成不依赖 Agent、模型或网络的权威玩家回合链路。声明式 WorldSpec 经严格编译后生成稳定 Manifest 与 Genesis Plan，WorldStore 在 Tick 0 原子激活；玩家输入经授权、耐久 Inbox、Branch FIFO、Writer fencing 和 speak/move Rulebook 提交为 Event、Tick、Head 与 Outbox。相同输入在普通重试、进程重启以及“World COMMIT 已完成但 Inbox 尚未完成”的窗口中均恢复为同一 Bundle Hash。

## 2. 交付面

| 单元 | 公共入口 | 已实现不变量 |
|---|---|---|
| Store Migration | `openMigratedDatabase` | 连续、前向、事务化迁移；World Schema v4 |
| Writer Lease | `WriterLeaseService.acquire/renew/release` | 数据库持久 Lease、单调 fencing token、过期/旧 token fail-closed |
| Round Inbox | `RoundInbox.enqueue/claimNext/complete` | idempotency key 绑定 input hash、Branch FIFO、较高 fencing token 接管 |
| WorldSpec | `WorldSpecCompiler.compile` | 未知字段拒绝、引用验证、精确插件版本、稳定排序与域隔离 Hash |
| Genesis | `WorldBootstrap.activate` | Manifest、Genesis Event、Round Commit 与 Head 在 Tick 0 原子写入 |
| Kernel | `WorldKernel.submitPlayerInput` | PlayerBinding 授权、无 Agent speak/move、受理后拒绝仍推进 Tick |

## 3. Evidence

| ID | Evidence | 结果 |
|---|---|---|
| E-P1-001 | `corepack pnpm@11.7.0 check` | 退出码 0；类型、Lint、Coverage、P0、P1、Crash 全通过 |
| E-P1-002 | Coverage 汇总 | 782/782 statements、400/400 branches、154/154 functions、686/686 lines |
| E-P1-003 | `tests/p1.integration.test.ts` | 无 Agent 玩家消息提交、重试、完整事件 Hash 重放与重启一致 |
| E-P1-004 | `packages/kernel/src/world-kernel.test.ts` | 授权、结构准入、speak、move、领域拒绝、提交后恢复全部通过 |
| E-P1-005 | `packages/store-sqlite/src/store.test.ts` | Migration、Lease、fencing、Inbox FIFO、接管与结果幂等全部通过 |
| E-P1-006 | `tests/crash.test.ts` | Phase 0 的 6 项真实子进程硬终止矩阵保持通过 |

## 4. Findings

| ID | Finding | Evidence |
|---|---|---|
| F-P1-001 | 进程内 Slot token 不能代替数据库 Lease；提交必须校验持久 fencing token。 | E-P1-005 |
| F-P1-002 | Genesis 必须是独立 Tick 0 行政事务，不能借用普通 `commitRound` 并误增 Tick。 | E-P1-004、E-P1-005 |
| F-P1-003 | 崩溃恢复必须冻结原 transaction 的 base head/tick；用当前 Head 重算会造成 request hash 分歧。 | E-P1-004 |
| F-P1-004 | Inbox 完成记录与 World COMMIT 不跨库宣称 exactly-once；确定性 transaction ID 与 Store 幂等负责恢复窗口。 | E-P1-003、E-P1-004 |
| F-P1-005 | 授权和结构错误在 Inbox 前拒绝且不推进 Tick；领域拒绝在受理后形成 Event 并推进 Tick。 | E-P1-004 |

## 5. Finding Paths

### 5.1 数据库 Writer fencing

- target: 阻止旧 Kernel 在 Lease 丢失后提交
- preconditions: Branch 已获取过 Writer Lease
- action: `WorldKernel` 获取数据库 Lease，并把 fencing token 传入 `WorldStore.commitRound`
- evidence: E-P1-005
- finding: F-P1-001
- verification: 缺失、过期或错误 token 均返回 `WRITER_LEASE_LOST`；新 Lease token 单调增加
- residual_risks: V0 尚未实现跨进程 Lease 心跳守护；当前每次 drain 前重新 acquire

### 5.2 Tick 0 Genesis

- target: 确保首次激活可重放且不消耗玩家 Tick
- preconditions: WorldSpec 通过严格 Schema、引用与版本验证
- action: 编译稳定 Manifest/Genesis Hash，在单一 SQLite 事务写入 Manifest、Branch、Genesis Events、Round Commit 与 Head
- evidence: E-P1-003、E-P1-004
- finding: F-P1-002
- verification: 首次返回 `activated`，重启后返回 `already_active`，Tick 始终为 0，Bundle Hash 相同
- residual_risks: Phase 1 只提供内建 rulebook/plugin 描述，不装载第三方语义插件

### 5.3 COMMIT 后、Inbox 完成前恢复

- target: 恢复 World 已提交但调用方尚未记录 Inbox result 的玩家回合
- preconditions: transaction ID 由 address、inboxSeq、idempotencyKey 与 inputHash 确定性派生
- action: 重启后用 `roundBase(transactionId)` 冻结原 base head/tick，在相同 as-of 历史上重建请求
- evidence: E-P1-004
- finding: F-P1-003、F-P1-004
- verification: Store 返回 `already_committed`，Inbox 随后完成，Head 不重复前进且结果 Hash 相同
- residual_risks: Session Outbox Worker 与 Dead Letter 在 Phase 2 实现

### 5.4 玩家准入与领域拒绝

- target: 区分“不应进入世界”的输入和“进入世界但行动失败”的输入
- preconditions: Manifest 含唯一 PlayerBinding
- action: 先校验请求结构和 principal，再入 Inbox；Rulebook 对不可达 move 或未知 action 生成 `action.rejected`
- evidence: E-P1-003、E-P1-004
- finding: F-P1-005
- verification: 未授权/非法结构保持 Head 不变；受理后的拒绝增加一个 Tick
- residual_risks: Phase 1 未提供用户文本 CLI 解析层，调用方直接提交结构化 speak/move action

## 6. 验收映射

| Phase 1 门槛 | 结果 | Evidence |
|---|---|---|
| 无 Agent 玩家消息可提交 | 通过 | E-P1-003、E-P1-004 |
| 相同输入幂等重试 | 通过 | E-P1-003 |
| 完整事件重放 Hash 一致 | 通过 | E-P1-003 |
| 重启后 Bundle Hash 一致 | 通过 | E-P1-003、E-P1-004 |
| 每个生产文件四项覆盖率 100% | 通过 | E-P1-002 |
| Phase 0 原子性与硬崩溃回归 | 通过 | E-P1-001、E-P1-006 |

## 7. 未闭合门槛

GitHub Actions 的 Windows/Ubuntu × Node 22.19/24 四组矩阵仍只配置未执行，因为仓库没有远程。Phase 2 的 Visibility/CharacterView、FIFO Outbox Worker、Critical Dead Letter 与 Deterministic Presenter 尚未实现，不应从 Phase 1 API 推断这些能力已经存在。
