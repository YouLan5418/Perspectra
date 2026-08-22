# ADR-0039：WorldApplication、真实 Branch 组件与统一 Round 协调

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §4～§7、§14、§19、§25.4](../spec/implementation-v0.2.md)
- 相关决定：ADR-0023、ADR-0024、ADR-0027、ADR-0032、ADR-0036、ADR-0038

## 背景

Phase 0～5 分别证明了 Cordis 隔离、玩家 Kernel、Agent/Director、Session、Memory 和运维原语，但真实 Branch Slot 仍注册 Probe，玩家 Kernel 与 Agent/Director 仍是分离管线。本地 RPC 也只覆盖行政最小集。因此“各组件测试通过”尚不能等价为冻结规格的最终运行架构已经闭合。

## 决策

1. 新增组合根 `WorldApplication`。它可以依赖 Runtime、Kernel、Agents、Store、Presentation 和 Memory；底层包不得反向依赖 Application。
2. `runtime-cordis` 只定义生命周期与隔离协议，通过 `BranchComponentFactory` 注入真实组件，不直接依赖 Kernel 或 Store，避免包循环。
3. Kernel 不再依赖具体 `BranchRuntimeSlot`，只依赖最小 `RoundExecutionLane`。Application 将 Slot 的 FIFO lane 注入 Kernel。
4. `RoundCoordinator` 是 InteractionRound 的唯一生产协调者：先产生玩家候选 S1，再调用获授权参与者，冻结终态集合，稳定排序并在纯 Candidate 上逐条裁决，最后调用一次 `commitRound`。
5. Agent/Director 的失败是参与者终态，不是世界提交失败；Store、Schema、Reducer、Invariant 和授权分歧仍 fail-closed。
6. 行政操作由 `BranchOperationCoordinator` 编排 Gate、Drain 和 Store 原语；不得要求调用方自行拼接一个不具原子语义的命令序列。
7. JSON-RPC/CLI 依赖 Application Port，不直接打开多个有状态 Store 来复制业务流程。

## 结果

Phase 0 Probe 仅保留在 test fixture。生产 Branch Fiber 的 dispose 将关闭 Kernel Lease、Store/Inbox/Session worker 等 branch-owned 资源。包依赖方向保持单向，完整本机路径可以用 Scripted Provider 测试而不需要 Harness 或网络。
