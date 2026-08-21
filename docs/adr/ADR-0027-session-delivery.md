# ADR-0027：Session FIFO、原子幂等和 Critical Dead Letter

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §12](../spec/implementation-v0.2.md#12-sessionoutbox-与-compaction)

## 决策

World Outbox 至少一次投递，同一 Session 只处理最早未完成项。消费端在一个本地 SQLite 事务中写 `session_delivery_inbox`、追加 Observation 并推进 cursor。相同 seq/deliveryId/payloadHash 返回 `already_applied`；任一绑定分歧立即返回 `SESSION_DELIVERY_DIVERGED`。

## 结果

系统不宣称跨 WorldStore/SessionStore exactly-once。Phase 0 Adapter 已验证 COMMIT 前硬终止完全回滚、COMMIT 后硬终止可重试且不重复事件；Dead Letter 调度留到 Phase 2。
