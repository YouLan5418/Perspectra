# Harness / Cordis World V0 Phase 6：架构闭合计划

> 日期：2026-08-22
>
> 状态：实施中
>
> 基线：冻结实施规格 V0.2、ADR-0023～ADR-0039

## 1. 目标

Phase 0～5 已验证各层原语及其崩溃、并发和 as-of 不变量。Phase 6 不增加世界内容、远程服务或真实模型，而是把这些原语组合成冻结规格 §4～§7、§14、§19 所描述的单一生产路径：

```text
Local CLI / JSON-RPC
→ WorldApplication
→ WorldRuntimeRegistry / real BranchRuntimeSlot
→ durable Round Inbox
→ player Candidate S1
→ NPC / Director Proposal freeze
→ deterministic ordering and Rulebook resolution
→ one WorldStore commit
→ Outbox / Session / Presentation
```

## 2. 必须闭合的差距

1. Cordis child Context 中的 `BranchProbeService` 仅为 Phase 0 证据，生产 Slot 必须持有真实 Kernel、Store、Agent 和 Director 组件，并由 Fiber dispose 统一释放。
2. 玩家 Kernel 与 Agent/Director 原型仍是两条路径；必须合并为同一个 InteractionRound，不允许 Provider 绕开 Candidate、Rulebook 或 WorldStore。
3. 行政原语尚未形成“关闭 Gate → 排空已受理 FIFO → 执行 fork/archive/backup”的协调状态机。
4. 本机 RPC 仍缺少 world/round/view/outbox/snapshot/backup/transfer 的生产入口与可恢复查询。
5. Reference Application 必须从本机协议入口贯穿 Cordis、Kernel、Session 和 Presentation，并在重启后得到相同 Bundle Hash。

## 3. 实施单元

| 单元 | 交付 | 验收 |
|---|---|---|
| P6-A Runtime Composition | 可注入 `BranchComponentFactory`、真实 branch-owned service handles、Fiber 生命周期 | 两 Branch 的真实组件、Listener、FIFO 和 dispose 不泄漏 |
| P6-B RoundCoordinator | S1、ReactionView、参与者终态冻结、稳定 ActionOrderKey、逐 Action 重裁决、单事务提交 | Scripted NPC/Director 与玩家处于同一 Round；失败/超时不阻塞；重放 Hash 相同 |
| P6-C Administration | `BranchOperationCoordinator` 关闭 Gate、排空、复核 Barrier，再 fork/archive | 新输入被拒绝；已受理 Round 完成；操作后状态可恢复 |
| P6-D WorldApplication | 按 WorldAddress acquire/release Slot；提交和查询 Round；启动 Outbox/Session/Presenter | API 不直接持有全局有状态 Kernel；重启可查询同一结果 |
| P6-E Local Protocol | 扩充 stdio JSON-RPC/CLI 的 world、round、view、outbox、snapshot、backup、transfer 方法 | `round.submit` 快速受理，`round.get` 可恢复；非法权限/参数返回 ErrorEnvelope |
| P6-F Reference Matrix | Scripted 多参与者、父归档后子分支、Session 恢复、COMMIT 窗口与重启 | `pnpm check`、Reference E2E 和 Crash Harness 全通过 |

## 4. 约束

- `WorldStore` 继续是世界事实唯一权威；Cordis Service、Agent、Memory、Presentation 和 Audit 不得成为第二事实源。
- 每 Branch 仍只有一个进程内 FIFO 与一个数据库 Writer Lease；进程内 token 不替代持久 fencing。
- Provider 只能产生 Proposal。所有 Action 在当前 Candidate 上重新校验；预期领域冲突形成 rejected Resolution，结构/Reducer/Invariant 错误终止 Round。
- 事务内不调用 Provider、不等待 Promise、不执行 Cordis dispatch。
- Harness Bridge、TencentDB、远程监听、Branch merge/rebase/cherry-pick 和物理删除仍不在 Phase 6 范围。
- 上游源码目录保持只读。

## 5. 完成门槛

Phase 6 只有在以下条件全部满足后完成：

- 生产路径不再使用 Probe 作为 Kernel/Store/Agent/Director；
- 同轮玩家、Scripted NPC 和 Scripted Director 的 Event/Resolution/Observation/Outbox 可完整重放；
- 模型 unavailable/failed/timed_out 不阻塞玩家 Tick；
- 行政协同器不会丢失已受理 Round，也不会从 archived source 新建 fork；
- 本机 RPC/CLI Reference Application 端到端通过；
- 每个生产文件四项覆盖率保持 100%；
- `corepack pnpm@11.7.0 check` 通过；
- GitHub 四平台矩阵仍作为发布候选外部门槛单独记录。
