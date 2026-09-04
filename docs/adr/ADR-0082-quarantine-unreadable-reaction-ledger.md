# ADR-0082：损坏的 Reaction 账本不得阻止紧急隔离

- 状态：Accepted
- 日期：2026-09-05
- Supersedes（局部）：[ADR-0079](ADR-0079-host-fair-scheduling-backpressure-administrative-stop.md) §4 对 quarantine 无条件终态化 Cycle 的要求。
- 不变：健康账本仍在同一隔离事务内终态化；World/Authority/Manifest/Registry Hash 和版本不变。

## 决定

隔离用于阻止不可信状态继续写入，不以所有待隔离账本健康为前提。

1. 在任何 Reaction 更新前，先只读校验完整 Cycle/Wave/Job Bundle。
2. 校验成功：沿用 ADR-0079，把 Cycle 标记 `quarantined`、未执行 Job 标记不可用、撤销 Writer Lease；同一事务完成。
3. Bundle 无法读取或验证：保留 Reaction 原始行与 Hash，**不得重算并覆盖损坏 Hash，也不得声称 Cycle 已终态化**。结果和 `branch.quarantined` 审计必须含 `unresolvedReactionCycle: true`，`quarantinedCycleId` 为 null、`terminalizedJobCount` 为 0。
4. 此时 Branch 仍在同一事务中置 quarantined/draining，撤销 Writer Lease、终止尚未提交的玩家 Round、记录失败台账。迟到 Provider 不能提交；调度器不得领取该 Branch。
5. 只读预检之外的更新/CAS/提交失败仍向上传播并回滚，不以这条例外吞掉写入失败。数据库本身无法完成隔离事务时，不宣称隔离成功。
6. 恢复仍必须通过完整权威校验；未修复的损坏 Bundle 不能恢复。已有隔离响应幂等返回不等于校验通过。此决定不提供手工 SQL 修复入口，也不扩展备份权限。

## 证据 → 结论 → 路径

- E-001：P9C.3 的 `quarantineReactionCycleInTransaction` 原先直接调用 `readActiveReactionCycle`，Hash 分歧会抛错并使整个 Branch 隔离回滚。
- F-001（E-001）：紧急屏障依赖了它需要防护的账本，损坏会阻止撤销 Writer Lease。
- P-001：只读预检 → 健康则终态化，损坏则原样保留并显式报告 → 同事务封锁 Branch → 恢复重新完整校验。

回归位于 `packages/store-sqlite/src/reaction-cycle.test.ts`：分别损坏 Cycle、Wave、Job Hash 和 Hash 格式，验证封锁成功、Reaction 行不变、Lease 被撤销、恢复失败；既有 CAS 回滚与隔离前后子进程硬终止测试继续保留。
