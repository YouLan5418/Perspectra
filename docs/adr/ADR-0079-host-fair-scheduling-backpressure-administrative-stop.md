# ADR-0079：Host 公平调度、背压与行政停止语义

- 状态：Accepted
- 日期：2026-09-02
- 上位目标：[Phase 9 实施规格](../spec/phase-9-implementation-v0.1.md) §17～§18、§22；[Phase 9C 实施规划](../2026-09-02_实施计划-Harness-Cordis-World-Phase-9C.md)
- Extends：ADR-0031（Telemetry、Health、Audit）、ADR-0036（行政 Barrier 与 Branch）、ADR-0074（确定性世界文本顺序）、ADR-0077（有界自主 Reaction Cycle）、ADR-0078（Reaction Policy 版本门）
- Supersedes（局部）：ADR-0076 原型中“每 Branch 一个 worker 自行排空该 Branch”的调度设想；任何把进程内队列、wake 提示或 Metric 当作工作事实来源的实现

> **边界警告：** 公平调度只决定“何时执行”，不改变任一 Branch 内的权威顺序、Hash、预算或终态裁决。wake 提示可以丢失、重复或乱序；耐久表永远是唯一工作事实来源。若某个公平性目标只能通过改变 Branch 内执行结果达成，该目标无效。

## 背景

Phase 9B 已经交付单 Branch 内的有界多 wave 权威语义：Root Round 与首个 Cycle 在同一 World 事务提交、同 wave 冻结并行、wave 间串行、玩家可以在 wave 边界抢占、启动扫描可以恢复 active/stop_requested Cycle。

但 Host 侧仍然是“一个 Branch 一个 worker，循环排空该 Branch 的全部工作”：

- `packages/operations/src/rpc.ts:150-157` 维护 `#roundWorkers` / `#reactionWorkers` 两个 per-address Promise map，没有全局并发上限；
- `packages/operations/src/rpc.ts:519-562` 与 `:564-600` 的 kick 函数在微任务里 `while (true)` 排空该 address 的全部请求；
- `packages/application/src/world-application.ts:689-700` 的 `processAcceptedRounds` 同样是循环排空；
- `packages/operations/src/rpc.ts:189-196` 的 `close()` 无限等待所有 worker 排空，没有关闭预算。

由此产生三个不可接受的长期运行性质：

1. **饥饿**：一个持续 runnable 的热 Branch 可以无限占用 Host，其他 Branch 得不到执行机会；
2. **背压不可证明**：worker 数与 wake key 数随活跃 Branch 无界增长，溢出行为没有定义；
3. **行政边界缺口**：`enterMaintenance`（`packages/store-sqlite/src/branch-administration.ts:76-97`）、`archive`（同文件 `:122`、`:228-258`）、`forkBranch`（`packages/store-sqlite/src/world-store.ts:885-962`）与 `applyBranchQuarantine`（`packages/store-sqlite/src/quarantine.ts:84-168`）都只检查 Writer Lease、Round 与 critical Outbox，从不查询 `world_reaction_cycles` / `world_reaction_jobs`，因此可能在 Cycle 仍会写入世界事实时改变 Branch 状态。

## 决定

### 1. 一个量子（quantum）是最小调度单位

应用层提供单步能力：

```ts
processNextBranchWork(address: WorldAddress, correlationId: string): Promise<BranchWorkStep>
```

一次调用最多完成一个耐久量子，返回固定闭集：

| `status` | 含义 | 必要字段 |
| --- | --- | --- |
| `reaction_wave` | 推进 active/stop_requested Cycle 恰好一个 wave | `cycleId`、`wave`、`roundId`、`terminalReason`（可为 null）、`actionCount` |
| `player_round` | 处理恰好一个已受理玩家 Root Round | `roundId`、`transactionId`、`openedCycleId`（可为 null） |
| `idle` | 该 Branch 当前没有可执行的耐久工作 | `address` |

优先级固定：先 Cycle，后玩家 Round。旧 Cycle 未进入终态前不得处理下一条玩家 Round；玩家输入只请求在当前 wave 边界停止旧 Cycle（沿用 ADR-0077 与 Phase 9B 实现）。

量子内部不得再循环。“排空一个 Branch”只能由 Scheduler 通过多次量子调用组合出来，因此任何一次调度决策的代价都是有界的。

量子沿用既有事务边界，不新增事实来源：`reaction_wave` 就是一次 `ReactionScheduler.runCurrentWave()`（`packages/application/src/reaction-scheduler.ts:191-298`），`player_round` 就是一次 `RoundCoordinator.processNextAccepted()`（`packages/application/src/round-coordinator.ts:412-428`）。终态化继续搭载在最后一个 wave 的同一 World 事务上，不引入独立的“终态化事务”。

### 2. Host 级 `BranchWorkScheduler`

新增 Host 级调度器，替换 per-Branch worker map：

1. `wake(address, reason)` 是**可丢失、可合并、可乱序**的提示。同一个 `worldAddressKey` 的多次 wake 合并为一个 ready 条目；`reason` 只用于日志与 Metric，不参与调度裁决。
2. 同一个 `WorldAddress` 同时最多一个量子在执行。
3. ready 集合按 `worldAddressKey` 的 UTF-16 code unit 顺序（ADR-0074 的 `compareWorldText`）建立稳定起点，再以 round-robin 轮转；被选中的 Branch 执行一个量子后，若仍有工作则排到队尾。
4. 默认 `maxConcurrentBranches = 4`，本机配置允许 1～32。该配置与 `rescanIntervalMs` 一样**不进入 Manifest、Genesis 或任何世界 Hash**，与 `leaseTtlMs` 同类（`packages/operations/src/host-config.ts:16-28`、`:100-104`）。
5. 最多保留 1024 个驻留 wake key。达到上限时**只置 `rescanRequired`**，不把 wake 内容写成第二事实源，也不为了保留提示而扩大驻留集合。
6. 启动扫描与周期性耐久扫描（默认 `rescanIntervalMs = 1000`，本机配置 100～60000）必须能在所有 wake 丢失后恢复全部工作。扫描来源仍是耐久查询：`RoundInbox.unfinishedAddresses()`（`packages/store-sqlite/src/round-inbox.ts:389-402`）与 `WorldStore.activeReactionCycleAddresses()`（`packages/store-sqlite/src/world-store.ts:1228-1241`）。
7. 耐久扫描返回的是**集合**，其 SQL 排序不是权威顺序；稳定顺序一律由 Scheduler 用 `compareWorldText(worldAddressKey(...))` 施加。

公平性的可验证定义：

> 在所有 ready Branch 持续 runnable、且没有锁冲突或 Provider 超时的条件下，N 个 ready Branch 各执行一次量子之前，任何 Branch 不得执行第二次。

公平性测试必须以该定义为断言，而不是以“看起来轮转了”为断言。

### 3. 关闭与恢复

graceful shutdown 固定为五步，顺序不得调换：

1. 停止接收新的 worker kick：`wake` 在关闭中不再产生新调度；
2. 不再领取新量子或新 ProviderCall；
3. 等待已冻结 wave 到其有效 deadline，并完成正在进行的短事务；
4. 释放 Host 持有的 Writer Lease 与 `instance.lock`；
5. 未完成工作留在耐久状态，由下一次启动扫描恢复。

关闭等待有硬预算 `shutdownTimeoutMs`（默认 35000，本机配置 1000～300000），默认值取 Reaction Cycle deadline（`REACTION_CYCLE_DEADLINE_MS = 30_000`，`packages/application/src/round-coordinator.ts:88-91`）加一个调度裕量。超时后 Host 停止等待并继续释放资源；被放弃的量子按硬终止路径处理，只依赖 fencing、append-once 与启动扫描恢复。

关闭**不修改** Branch admission，也**不伪造** Cycle terminal reason。硬终止仍然由 fencing token、ProviderCall append-once 与启动扫描负责，graceful shutdown 只是让常见路径不必走恢复。

### 4. 行政操作与 active Cycle 的矩阵

| 操作 | active / stop_requested Cycle 时的行为 | 完成条件 |
| --- | --- | --- |
| 玩家抢占 | 沿用 Phase 9B：写 `stop_requested(player_preempted)`，当前 wave 收口后终止 | 旧 Cycle terminal 后处理玩家 FIFO |
| graceful shutdown | 不新领工作；已冻结 wave 按有效 deadline 收口 | 剩余耐久工作由重启扫描接管 |
| maintenance | 先关闭 admission，并请求 `administrative_stop`；不启动下一 wave | 无 unfinished Round、无 active Cycle、无有效 Writer Lease、无 critical inflight delivery |
| archive | 返回可重试错误，不自动取消 Cycle | Cycle terminal 且既有 archive barrier 全部满足 |
| fork | 返回可重试错误 | fork 点没有活跃 Cycle；子分支不继承 live Job、Lease 或 Provider 责任 |
| quarantine | 最高优先级；在隔离事务内把 Cycle 标为 `quarantined`，未执行 Job 终态化并撤销 fence | 不等待 Provider；任何迟到结果都不能提交世界事实 |

补充约束：

- 行政终止原因必须落在既有闭集内（`packages/contracts/src/reaction-cycle.ts:12-22` 已包含 `administrative_stop` 与 `quarantined`），并进入耐久账本；不得新增只存在于进程内的终止状态。
- `archive` / `fork` 的拒绝必须是**可重试**错误，语义为“等 Cycle 终态后再试”，不得静默取消 Cycle，也不得为了成功而放宽 barrier。
- `quarantine` 优先于“当前 wave 可以收口”的普通规则：一旦不能证明 Hash、fence 或 head 完整性，不得为了保留模型输出而提交世界事实。被 quarantine 撤销 fence 的 Job 即使 Provider 迟到返回，也不能再提交。
- maintenance 恢复不会自动复活旧 Cycle；操作者恢复 Branch 后，只处理仍合法的玩家 FIFO 或新刺激。
- Scheduler 必须把行政状态视为调度输入：非 `runtime_phase='active'` 的 Branch 不领取新量子。

### 5. 可观测性与隐私

只增加**固定基数**指标，沿用 `packages/operations/src/metrics.ts:3-23` 的既有形态（零初始化的扁平 `Record`，权威状态永不依赖计数）：

- Cycle started / completed，terminal reason 闭集计数；
- waves、calls、accepted actions、reserved / used tokens 总数；
- Provider ambiguous、lease recovery、fence rejection、head mismatch；
- runnable / active Branch 数、wake overflow 与 rescan 次数、最老等待时长；
- 量子结果分布（`reaction_wave` / `player_round` / `idle`）与关闭超时次数。

不得把 `worldId`、`branchId`、`characterId`、Prompt 或正文作为 label。需要定位某个 Branch 时使用有权限的 `reaction.get` / `reaction.list` 与 Audit，不通过高基数 Metric 泄漏地址。

Health 提供进程级 degraded 判定与固定原因码；调度器状态（ready 深度、`rescanRequired`、in-flight 数）进入 Health，而不是进入世界事实。

通知仍然是非权威提示：可重复、乱序或丢失，不用于 Scheduler 决策，也不参与 Release 完整性校验。

## 结果

- 热 Branch 无法饿死其他 Branch；全局并发有硬上限，背压可证明。
- wake 全部丢失时，工作由耐久扫描恢复，不会丢失也不会重复执行。
- 行政操作不再留下语义不明的 active Cycle；quarantine 有了明确的 Cycle/Job/fence 处置。
- 关闭有预算，不会无限挂起，也不伪造终态。
- 代价：Host 调度层变厚，量子边界必须被测试固定；单 Branch 的“一口气排空”便利消失，端到端延迟由多次调度组成。

## 证据链

### Evidence

- E-001：`packages/operations/src/rpc.ts:150-157`、`:519-600` 显示 per-Branch worker map 与 `while (true)` 排空，没有并发上限。
- E-002：`packages/application/src/world-application.ts:689-700` 与 `packages/application/src/reaction-worker.ts:23-37` 显示应用层同样以“排空”为最小单位。
- E-003：`packages/application/src/round-coordinator.ts:412-428` 已经存在单量子原语 `processNextAccepted`，`packages/application/src/reaction-scheduler.ts:191-298` 的 `runCurrentWave` 已经是一个 wave 的完整事务边界。
- E-004：`packages/store-sqlite/src/branch-administration.ts:76-97`、`:228-258`、`packages/store-sqlite/src/world-store.ts:885-962`、`packages/store-sqlite/src/quarantine.ts:84-168` 均未查询任何 `world_reaction_*` 表。
- E-005：`packages/contracts/src/reaction-cycle.ts:12-22` 的终止原因闭集已包含 `administrative_stop` 与 `quarantined`，但当前没有生产者。
- E-006：`packages/store-sqlite/src/round-inbox.ts:389-402` 使用 SQLite BINARY 顺序，`packages/store-sqlite/src/world-store.ts:1228-1241` 使用 UTF-16 排序，两个扫描来源顺序不一致。

### Finding

- F-001：单量子原语已经存在于应用层，缺的是“不要循环”的调度层，因此公平性可以在不触碰权威语义的前提下实现（E-003 / E-001、E-002）。
- F-002：行政边界缺口的根因是 barrier 检查没有把 Cycle 纳入耐久前置条件，而不是 Cycle 状态机不完整（E-004 / E-005）。
- F-003：扫描顺序不一致本身不破坏权威性，但会让“稳定起点”不可复现，因此顺序必须由 Scheduler 统一施加（E-006）。

### Path

1. 先在应用层暴露单量子 API，并让既有排空入口改由量子组合实现；
2. 再在 Host 层加入 `BranchWorkScheduler`，用公平性定义、wake 丢失与并发上限测试固定行为；
3. 然后把 maintenance / archive / fork / quarantine 的 Cycle 前置条件写进各自 barrier，并补竞态与事务崩溃点测试；
4. 最后补固定基数 Metric 与 Health 原因码，并给出有预算的 graceful shutdown。
