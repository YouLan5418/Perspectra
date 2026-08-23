# ADR-0052：耐久认知工作与非 Round 受理记录

- 状态：Accepted
- 日期：2026-08-23
- Extends：ADR-0023、ADR-0031、ADR-0035、ADR-0041、ADR-0051

## 背景

Memory 是派生状态，但“哪些已提交世界事实尚未进入角色 Memory”不能只保存在进程内或 Memory 数据库中。否则 World Commit 后、Memory catch-up 前的硬终止会永久遗漏认知工作。另一方面，clarification 不应建立 Round 或推进 Tick，但如果完全不留耐久记录，同一幂等键在重启后可能被重新解释为不同结果，也缺少可审计的准入证据。

## 决定

1. `world_cognitive_jobs` 属于 World Store 的恢复账本。每个 job 由 transaction、character 与最终 as-of seq 确定，并在 `commitRound` 的权威事务内与 Event、Outbox、Round Commit 和 Head 一起写入。
2. cognitive worker 先校验 job hash，再按角色/Branch/as-of 重建派生 Memory，最后以当前 Writer Lease 的 owner 与 fencing token 回写 completed/failed。进程在派生写入和回执之间终止时允许安全重做。
3. 完整性错误由 worker 原样上抛并进入 quarantine 边界；普通 Memory 故障记录 failed，玩家已提交的 Round 不回滚。挂载和下一次调用都会重新排空未完成工作。
4. quarantine recovery 先验证 World 前缀，再清空并重建该 Branch 的派生 Memory namespace。启用了 Context v2 的 Manifest 若恢复入口没有 `memoryPath`，必须返回 `RECOVERY_VALIDATION_FAILED`。
5. `round_clarifications` 是独立的非世界事实受理账本。它按 address + idempotencyKey append-once，绑定 input/result hash，并在同一事务写 `round.clarified` branch audit；它不进入 Round Inbox、Event Log、Tick 或 Authority。
6. 同键同输入返回原结果；同键异输入返回 `IDEMPOTENCY_KEY_CONFLICT`；存储结果 Hash 分歧返回 `BUNDLE_HASH_MISMATCH`。解释器规则后来发生变化也不得把既有 clarification 重解释成 Round。

## 后果

- World Commit 后的崩溃不会遗失角色认知追平责任。
- Memory 仍是派生库，不成为第二世界事实源；恢复权威始终来自 World Event/Projection 前缀。
- clarification 保持“无 Tick”的产品语义，同时具备跨进程幂等与审计可观察性。
- World Schema 升至 v13：v12 引入 `world_cognitive_jobs`，v13 引入 `round_clarifications`；迁移只新增表，不重写历史 Event、Manifest 或 Hash。

## 验证

- COMMIT 前故障不留下 cognitive job；COMMIT 后故障由新进程恢复，角色 Memory 水位追平且 job 终态可验证。
- job 缺失、Hash 分歧、错误 fencing token、completed 回退和完整性 catch-up 均 fail-closed。
- Memory namespace 损坏可在 quarantine recovery 中由 World 前缀重建；缺少 Memory 配置不能假恢复。
- clarification 覆盖首次写入、跨调用重放、输入冲突、结果篡改、Audit 以及“同键后来变成普通对白”仍返回原 clarification。
