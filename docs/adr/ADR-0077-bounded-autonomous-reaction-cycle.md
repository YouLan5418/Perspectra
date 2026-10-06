# ADR-0077：有界自主 Reaction Cycle 与 NPC-only Round

- 状态：Accepted（方向已冻结；尚不授权生产实现）
- 日期：2026-08-30
- 上位目标：[Phase 9 实施规格](../spec/phase-9-implementation-v0.1.md)
- 原型证据：[ADR-0076](ADR-0076-reaction-cycle-npc-only-round-prototype.md)与 [P0 验证报告](../archive/phase-7-9c/2026-08-30_Reaction-Cycle-P0原型验证报告.md)
- Extends：ADR-0038、ADR-0039、ADR-0040、ADR-0043、ADR-0044、ADR-0046、ADR-0064、ADR-0068、ADR-0073～ADR-0075
- Supersedes（局部）：实施规格 D-004、D-005、D-007，以及 ADR-0023 中“一条玩家输入恰好对应一个 Round/Tick”的部分

> **实施门禁：** Accepted 只冻结正式方向，不把 ADR-0076 原型提升为生产实现。Phase 8.2 正确性收口与 Phase 8.3 性能基线全部关闭前，ADR-0023 的现有代码路径、Schema 和 API 继续有效，禁止开始 Phase 9 生产代码。

## 背景

当前 TURN_DRIVEN 管线要求玩家 Action 在每个 Round 的 phase 0 先行，NPC 与 Director 在 phase 1 并行回应。该设计保证了玩家 FIFO、冻结候选和确定性裁决，但也导致 NPC 只能在下一条玩家输入到来后看见其他 NPC 已提交的发言。

ADR-0076 的单 wave 原型已经证明：NPC-only Round 不需要伪造玩家 Action；Reaction Job 可以与刺激 Observation 原子创建；租约、fencing、逻辑传输和硬崩溃恢复可以继续使用既有权威链。原型尚未证明多 wave、玩家抢占、稳定预算、ProviderCall 歧义恢复、正式 Host 生命周期和生产迁移，因此不能直接合入主线。

## 决定

### 1. Round 与 Cycle 的权威关系

1. 成功提交的玩家 Root Round 可以按 Manifest 中显式的 `reaction-policy/v1` 创建零或一个 Reaction Cycle。旧 Manifest 和缺少该字段的 World 一律解释为 `disabled`。
2. 一个 Cycle 包含零到三个串行 wave；每个已冻结 wave 恰好对应一个 NPC-only Reaction Round，并恰好推进一个 Tick。
3. Reaction Round 的 `origin` 为 `reaction`，必须耐久关联 `cycleId`、`rootRoundId`、`wave`、`baseHeadSeq` 和 `baseHeadHash`。它不包含玩家 Action，也不创建伪造的玩家 Session 输入。
4. 同一 wave 的 NPC 基于同一冻结 Head 并行提案，互相看不到未提交提案。只有上一 wave 已提交并产生的授权 Observation 才能成为下一 wave 的刺激。
5. 模型输出仍然只是 Proposal。Rulebook 在提交事务中重新验证并裁决；Cycle、Job、Memory、Context、Session 和 Presentation 均不得成为第二套世界事实源。
6. 每个 branch 同时最多一个未终结 Cycle。玩家 Root Round 继续按既有 Inbox FIFO 执行；当前 Cycle 终结后才开始下一条已排队玩家命令。

这只在 `responsive/v1` 的 Root Round 后续范围内局部取代 D-004 与 D-005：玩家仍是每个 Root Round 的先行者，但不再要求每个后续 Reaction Round 都伪造一个玩家发起 Action；一条玩家输入可以形成一个 Root Round 加零到三个 Reaction Round。

### 2. Action 与 Job 的确定性全序

Reaction Scheduler 不建立第二套 Action 排序。有效 Action 继续使用 ADR-0046 已落地的全序：

```text
(roleRank ASC, priority DESC, actorId UTF16 ASC, actionId UTF16 ASC)
```

- `roleRank` 固定为 player=0、agent=1、director=2；Reaction v1 不调度 Director，也没有 player 行，因此合法集合只包含 agent 行。
- `actorId` 与 `actionId` 必须使用 ADR-0074 的 `compareWorldText`，不得依赖 Locale、Promise 完成顺序或 SQLite BINARY collation。
- `actionId` 在同一 Round 内必须唯一；相同排序键但 Canonical Action 不同属于完整性分歧并 fail closed。
- `proposalOrdinal` 继续只用于恢复参与者原 Proposal，不改变全局裁决顺序。

Job 规划与预算预留使用独立的稳定全序：

```text
(wave ASC, characterId UTF16 ASC, stimulusHash ASC, jobId ASC)
```

`stimulusHash` 和 `jobId` 是 ASCII Hash/确定性 ID；所有数据库读取在参与 Hash、领取或预算截断前必须在应用层按上述顺序重排。正式实现不得依赖 ADR-0076 原型中的第二条 World SQLite Writer 连接，Reaction repository 必须共享 WorldStore 的受控连接与事务边界。

### 3. 调用预算与 ProviderCall 生命周期

`responsive/v1` 冻结以下语义上限：

| 边界 | 上限 |
|---|---:|
| Cycle wave | 3 |
| Cycle NPC 调用 | 8 |
| 每角色每 Cycle 调用 | 2 |
| 每角色每 wave 调用 | 1 |
| 每次调用 Action | 1 个 `speak@1` |

这在 Reaction Cycle 范围内局部取代 D-007。Root Round 的既有行为保持不变；Reaction v1 进一步把单次调用从最多两个 Action 收紧为最多一个 `speak@1`。

每个 wave 在任何 Provider dispatch 前，按稳定 Job 顺序一次性冻结参与者集合并预留调用数与最大 token。Provider 少用 token 或提前失败，不得把本 wave 名额转给排序靠后的角色；退款只影响下一 wave。已用预算从耐久 Job 和 ProviderCall 记录重算，内存计数器不具权威性。

Reaction 调用必须复用 ADR-0064 的 `ContextReceipt -> prepared -> dispatch_started -> response_received -> validated -> committed` append-once 链：

| 恢复状态 | 允许动作 |
|---|---|
| `prepared` 且能证明从未 dispatch | 可由新租约安全 dispatch |
| `dispatch_started` 且无耐久响应 | 标记 `timed_out_ambiguous`，不得自动重发 |
| `response_received` / `validated` | 继续验证或提交，不再次调用 Provider |
| `committed` | 从 Round Authority / Event Log 对账并补齐 Job 终态 |
| 其他 terminal | 如实收口，不伪造 Proposal 或 Observation |

Provider 的远端幂等键只能降低外部重复风险，不能替代本地 append-once。系统只保证世界效果 at-most-once，不宣称外部计费 exactly-once。

### 4. 玩家抢占、取消与行政终止

玩家在 active Cycle 期间提交的新命令时，系统必须在同一短事务内耐久入队，并把 Cycle 标记为 `stop_requested(player_preempted)`。已冻结 wave 可以按既有 fence 与 Head 校验收口，但不得生成下一 wave；旧 Cycle 终结后，玩家命令按原 Inbox FIFO 成为下一 Root Round。旧 Cycle 不恢复。

显式取消使用相同机制并记录 `user_cancelled`。maintenance 与 graceful shutdown 停止领取新 Job；可证明安全的未 dispatch Job 由租约恢复，已 dispatch 的歧义调用不得重发。active Cycle 阻止 fork 与 archive。Quarantine 优先级最高：一旦 Hash、Head、fence 或来源完整性不能证明，禁止为了保存模型结果而提交世界事实。

Cycle terminal reason 使用 Phase 9 规格冻结的闭集：`quiescent`、`all_abstained`、`call_limit`、`wave_limit`、`token_budget_exhausted`、`deadline_reached`、`provider_terminal`、`player_preempted`、`user_cancelled`、`administrative_stop`、`quarantined`。deadline 判定结果必须耐久化；重放读取终态，不按当前墙钟重新推导历史结果。

### 5. Context、Memory 与刺激边界

每个 wave 冻结唯一的 `baseHeadSeq/baseHeadHash`。CharacterView、SceneView、Memory 水位、ContextReceipt、StimulusBundle 与 ProviderRequest 必须全部以该 Head 为 as-of 上限。Memory 未追平时只能在事务外进行有界 catch-up；超限后以 `runtime_unavailable` settle，不得偷偷使用旧摘要。

刺激只来自当前 Cycle 上一已提交 Round 为该角色生成的 authorized Observation，按 `(sourceWorldSeq, sourceEventOrdinal, observationOrdinal)` 排序并冻结为 `stimulusHash`。默认排除角色对自身 Action 的自反 Observation。未授权、其他 branch、其他角色、未来水位或未提交提案不得进入 Job、Recall、Context Hash 或 ProviderRequest。

### 6. Schema、传输与备份

正式主线从 World Schema v15 迁移到 v16，从 `dshworld-authority/v5` 迁移到 v6。ADR-0076 原型使用的同名版本不自动获得正式兼容地位；只有 Phase 9A 的 migration、Schema Hash 与 Golden Fixture 才定义正式字节。

v16 至少耐久表达 Cycle、Job、Job-Stimulus、预算快照、租约/fence、stop request、terminal reason 以及 Reaction Round 的 Cycle/Wave Authority 关联。ProviderCall 继续由 Context 数据库拥有，但 World Job 与 Authority 必须保存可验证的调用身份和 Hash 引用。

`dshworld-authority/v6` 必须包含足以恢复和验证的 Cycle、Job、刺激、ProviderCall 关联、Reaction Authority 与终态；导入后重算 Hash、预算、外键、Head 关联和 active-cycle 唯一性。四库一致备份必须把 World 与 Context ProviderCall 水位作为同一恢复集合验证，不能只恢复一侧后把分歧解释为正常重试。

从 v15 迁移的旧 World 得到空 Reaction 表且 policy 为 `disabled`。迁移失败必须原子回滚；旧二进制不得静默降级打开 v16 数据库。

## 保持不变的边界

- Canonical World JSON、Hash 链、World Event Log 唯一权威；
- 玩家普通文本不经模型改写，玩家 Inbox 保持严格 FIFO；
- 模型输出只能成为 Proposal，Rulebook 是唯一裁决者；
- SQLite 短事务内不等待 Provider、Memory、网络或其他异步 I/O；
- Writer Lease、fencing、Head 乐观校验、角色权限、Scene 可见性和 fork as-of；
- 同键重放不重新调用 Provider，不重复产生 World Effect；
- 旧 Manifest 默认禁用自主反应，不因升级二进制改变行为。

## 代价与被拒绝方案

该决定增加 Cycle/Job/ProviderCall 对账、两层执行顺序、多数据库恢复水位和 1～3 个额外 Tick；最坏一次玩家输入会触发八次 NPC Provider 调用。它以明确的成本上限换取无需玩家发送占位消息的连续反应。

以下方案被拒绝：

- 在同一个 Tick 内加入模型微步：会让 Tick 不再对应稳定提交边界，并扩大事务与重放复杂度；
- 把 NPC 发言伪造成下一 Round 的玩家 Action：颠倒确定性输入与模型 Proposal 的信任边界；
- 进程内 Pulse/定时器直接调用 NPC：丢失耐久责任、崩溃恢复与玩家 FIFO；
- 允许同 wave 看见其他 NPC 的未提交提案：把 Provider 完成时序引入世界结果；
- dispatch 歧义后自动重试：可能重复外部副作用和计费。

## 实施授权门禁

本 ADR 的 Accepted 状态只回答“是否采用该方向”。开始 Phase 9 生产实现前必须同时具备：

1. Phase 8.2 正确性收口：post-commit availability 对账、Context 数据库迁移纪律、ProviderCall append-once 基础和 Reaction ActionOrderKey Golden 全绿；
2. Phase 8.3 性能基线：长历史下 Context、Observation 和 Job 选择不反复全量扫描，稳定预算规划具有固定数据集阈值；
3. v15 -> v16、logical v5 -> v6 与四库备份/恢复方案经过 migration 与崩溃矩阵评审；
4. 玩家在 freeze 前、Provider 期间、Tx B 前后输入的抢占矩阵不会丢命令、插入半个 wave 或恢复旧 Cycle；
5. P0 的公开对白、私语隔离、U+10000/U+E000 排序、硬崩溃与 exactly-once World Effect 证据在正式组合根中复现；
6. 生产文件逐文件四项 100% 覆盖，完整 `pnpm check` 与新增真实子进程硬终止测试通过。

## 证据、结论与路径

### Evidence

- E-001：ADR-0076 与 P0 报告证明 NPC-only Round、原子 Job 创建、租约接管、逻辑传输和三个硬终止窗口可行。
- E-002：ADR-0074 及 U+10000/U+E000 回归证明权威排序必须在应用层统一使用 UTF-16 code unit 顺序。
- E-003：ADR-0064 与 ProviderCall 现有测试证明 dispatch 前可安全恢复、dispatch 后歧义不重发、耐久响应可继续消费。

### Finding

- F-001：NPC 连续反应可以在现有权威架构内实现，但正式边界必须是“Root Round 派生的有界、耐久、逐 wave 提交 Cycle”，而不是 Tick 内微步或后台无权威循环。

### Path

1. 本 ADR 先冻结正式方向，再关闭 Phase 8.2/8.3 实施门禁；
2. Phase 9A 只产品化单 wave 权威骨架和完整恢复；
3. Phase 9B 才开放三 wave、并行预算、抢占和 API；
4. Phase 9C 完成 Host、公平性、迁移、性能与发布收口。
