# Reaction Cycle / NPC-only Round P0 原型验证报告

- 日期：2026-08-30
- 分支：`prototype/reaction-cycle-p0`
- 基线：`c2b3141`（0.3.1 candidate）
- 决断：ADR-0076（Proposed）

## 结论

原型证明了：无需把 NPC 输出伪装成玩家 Action，也无需在一个 Tick 内引入不可审计的“微步”，就能在玩家 Round 提交后执行一个有限、耐久、可恢复的 NPC-only Reaction Round。

世界事实仍然只通过 Rulebook → Event → WorldStore commit 产生；每个 Reaction Round 单独推进一个 Tick。玩家下一条消息可以先被耐久受理，但 active Cycle 结束前不会越过两层 FIFO 执行。

这是一项可行性结论，不是正式 Phase 9 功能完成声明。

## 已实现的原型切面

### 耐久调度

- World schema v16 新增 `world_reaction_cycles` 与 `world_reaction_jobs`。
- 根 Round 通过 event ordinal 引用本次提交内的 Observation；Store 计算出 Event seq/hash 后原子创建 Job。
- Cycle/Job 具有独立 Hash；读取、逻辑导入与篡改测试均 fail-closed。
- Job 支持 pending → claimed → completed/skipped，旧 fencing token 可被新 Writer 接管。
- Reaction commit 原子写入事件、Authority、Round commit、Head、Job 结果与 Cycle 终态。

### NPC-only Round

- 新增 `ReactionProposalContext`，以 `origin.kind = reaction`、Cycle/wave 和已提交 Observation 引用作为刺激。
- Context 中不存在 `playerAction`。
- Provider 仍只产生 Proposal；P0 只接受绑定角色的单个 `speak@1`。
- Authority schemaVersion 3 明确记录 reaction origin，所有 Action orderKey 均为 phase 1。
- Rulebook rejected Action 仍得到确定性 Resolution 与 Tick，不改变候选事实。

### 两层 FIFO 与行政屏障

- active Cycle 时，下一条玩家 Inbox 可以排队但不能 claim。
- Cycle 达到耐久终态后玩家 FIFO 自动恢复。
- active Cycle 阻止 fork 与 archive，避免继承了刺激却丢失反应责任，或归档后留下永久未完成 Job。

### 备份与恢复

- 物理 SQLite backup 自动包含新表。
- logical authority v6 包含 Cycle/Job；claimed Job 导出时归一化为 pending，避免恢复旧进程 owner/token。
- 导入验证 Observation source event、Job Hash、Cycle Hash 和终态一致性。
- v4/v5 导入受控升级为空 Reaction 账本，不伪造历史延续。

## 验收证据

1. 公开对白：Bob 收到已提交 Observation 后自动回应；World Event 中恰好一个 Bob `character.speak`。
2. 私语隔离：只给 Alice 创建 Observation/Job 时，Bob Provider 调用次数为 0，Bob 文本不进入 Event Log。
3. 循环阻断：`maximumNpcCalls = 1` 且有两个 Job 时，只执行 UTF-16 稳定排序后的首项，另一项 skipped，终态为 `call_limit`。
4. Provider 降级：缺失、抛错、越权角色、伪造 participant、多 Action、非 speak 或错误版本均不产生伪造 Action；Cycle 以准确终态关闭。
5. 硬崩溃：
   - `reaction.after-job-insert`：Observation、Round、Cycle、Job 全部回滚；
   - `reaction.before-round-submit`：Job 保持可回收，重启后完成一次 World Effect；
   - `store.after-commit`：World Event 与 Cycle 终态已提交，重启不再次执行。
6. 覆盖：生产文件逐文件 statements/branches/functions/lines 100%。

## 当前代价

- 每个 Reaction Round 都是一个新 Tick 和一次完整 World commit，延迟与模型费用随自动反应次数线性增加。
- active Cycle 会延后玩家下一条已受理消息；这是保持顺序事实的一致性代价。
- P0 的一波上限牺牲了长对话能力，但能先验证停止、隔离、恢复和权限边界。
- logical authority 格式与 World schema 均发生版本演进，因此正式落地主线前必须完成兼容评审。

## 未完成项

- 正式 Manifest `reactionPolicy` 与旧世界默认禁用；
- WorldApplication/WorldHost 启动扫描和 Cycle worker；
- Phase 8 Context/Memory/Scene Decision 接入；
- ProviderCall append-once 生命周期与 dispatch 后不重发策略；
- 多波生成规则、Director、Cycle get/list、Health/Audit/Metric/Drill；
- 跨平台 CI 和长期压力测试。

## 建议

原型结果支持正式立项，但不建议直接合并到主线。下一步应先把 ADR-0076 的 Proposed 结论整理成 Phase 9 的一个独立小阶段：先完成 Manifest 能力门、Provider 生命周期复用和启动恢复，再决定是否开放第二波。若三项任一无法保持现有不变量，应保留本分支作为研究证据而不产品化。
