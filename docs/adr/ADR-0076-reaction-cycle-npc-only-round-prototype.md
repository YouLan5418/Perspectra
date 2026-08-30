# ADR-0076：Reaction Cycle 与 NPC-only Round 原型

- 状态：Proposed（P0 原型证据已通过，尚未成为正式运行时契约）
- 日期：2026-08-30
- 分支：`prototype/reaction-cycle-p0`

## 背景

当前 `TURN_DRIVEN` 管线把一条玩家输入、一项 phase-0 玩家 Action、若干 phase-1 NPC/Director 提案和一个 Tick 绑定为一个 Round。该设计保证了确定性与玩家 FIFO，但 NPC 只能在下一条玩家输入到来时回应上一轮 NPC 的发言，无法形成受控的自动连续反应。

不能把模型生成的 NPC 发言伪装成 phase-0 发起 Action，也不能用进程内循环绕过 Round、Authority、WorldStore、fencing 和崩溃恢复。

## 原型决断

1. 新增 `Reaction Cycle` 作为“一条已受理玩家 Round 所开启的有限延续窗口”。Cycle 不进入玩家 `RoundInbox`。
2. 新增判别明确的 NPC-only Reaction Round。它没有 `playerAction`；所有 Provider 输出仍是 phase-1 Proposal，经过 Rulebook 裁定后才能成为 World Event。
3. Reaction Job 只能引用同一个 World commit 内的 `observation.upsert` ordinal。WorldStore 在计算出 Event seq/hash 后，将 Observation、Cycle 与 Job 放入同一 `BEGIN IMMEDIATE` 事务。
4. 使用两层 FIFO：玩家输入仍按 `inboxSeq` 受理，但 Branch 存在 active Cycle 时，`RoundInbox.claimNext` 不得执行下一项玩家工作。Cycle 达到耐久终态后才释放玩家 FIFO。
5. 每个 Reaction Round 推进一个 Tick。玩家输入可开启包含后续 Tick 的有限 Cycle；重放读取耐久 Round/Cycle 终态，不按墙钟重新推断。
6. P0 仅允许一波、每角色最多一次调用、每 Proposal 最多一个 `speak@1` Action。调用上限从耐久 Job 集合推导，不维护可漂移的内存计数器。
7. Cycle 终止原因必须耐久化为 `completed`、`call_limit` 或 `provider_terminal`。Reaction World commit 与 Job/Cycle 终态在同一事务完成。
8. Writer fencing 可接管旧的 claimed Job；COMMIT 后重放不得再次产生 World Effect。
9. active Cycle 是 fork/archive 屏障。否则 fork 会继承刺激 Observation 却丢失延续责任，archive 会产生无法再取得 Writer Lease 的永久未完成工作。
10. 逻辑权威导出原型升为 `dshworld-authority/v6`，保存 Cycle/Job，并把导出时的 claimed Job 归一化为 pending；v4/v5 受控升级为空 Reaction 账本。

## 与既有决断的关系

若该提案升格为 Accepted，需要显式 supersede：

- 实施规格 D-004 的“玩家必为每个 Round 的 phase 0 发起者”；
- D-005/ADR-0023 的“一条玩家输入只对应一个 Round/Tick”；
- D-007 的“每个 NPC 每个玩家 Round 一次调用”在 Cycle 内的计数范围。

保留不变：玩家 Inbox FIFO、模型输出只可成为 Proposal、Rulebook 唯一裁定、World Event Log 唯一权威、SQLite 原子提交、Authority 可重建、as-of/角色权限、Writer fencing。

## P0 通过门槛

- 酒馆公开 Observation 可让 Bob 在 NPC-only Round 自动回应；Authority 中没有合成玩家 Action。
- 私有 Observation 未授予 Bob 时，不创建 Bob Job，也不调用 Bob Provider。
- Cycle 调用预算按稳定角色顺序截断，未执行 Job 以 `skipped` 终结，结束原因为 `call_limit`。
- active Cycle 阻止下一条玩家 Inbox、fork 与 archive。
- 子进程在 `reaction.after-job-insert`、`reaction.before-round-submit`、`store.after-commit` 被硬终止后，分别得到完整回滚、可恢复执行和 exactly-once World Effect。
- 物理备份与逻辑导出/导入均保存或安全归一化 Reaction 恢复责任。

## 尚未接受的部分

P0 不证明以下内容，正式实施前不得把它们描述为完成：

- 尚未接入 `WorldApplication` 的正式组合根、启动扫描、RPC/CLI 或 Manifest `reactionPolicy`；
- 尚未复用 Phase 8 `ContextReceipt → ProviderCallIntent → append-once result` 全链，因此不保证 dispatch 后的外部 API 不重复计费；
- 尚未实现第二波及后续波、Director Reaction、非 `speak` Action、Scene 切换后的重新决断；
- 尚未定义 Cycle 查询 API、Health/Metric/Audit 完整面和六类 Drill；
- World schema v16 与 logical v6 仅存在于原型分支，不构成主线兼容承诺。

## 升格条件

只有在新的正式 Phase 9 实施规格明确 Manifest 能力门、Provider 生命周期复用、启动恢复、Cycle API、Scene/Memory 上下文及完整故障矩阵后，才能将本 ADR 改为 Accepted。若需要放宽事务、Hash、as-of、权限或 fencing 不变量，停止实现并提出新的 superseding ADR。
