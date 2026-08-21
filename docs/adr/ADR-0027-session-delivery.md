# ADR-0027：Session FIFO、原子幂等和 Critical Dead Letter

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §12](../spec/implementation-v0.2.md#12-sessionoutbox-与-compaction)

## 决策

World Outbox 至少一次投递，同一 Session 只处理最早未完成项。消费端在一个本地 SQLite 事务中写 `session_delivery_inbox`、追加 Observation 并推进 cursor。相同 seq/deliveryId/payloadHash 返回 `already_applied`；任一绑定分歧立即返回 `SESSION_DELIVERY_DIVERGED`。

## 结果

系统不宣称跨 WorldStore/SessionStore exactly-once。Phase 2 已实现 Session 连续 delivery seq、发送端 Receipt、消费端 `appendIfAbsent`、失败重试和 Critical Dead Letter 阻塞。Session COMMIT 后结果丢失与 Receipt COMMIT 前后均有恢复测试；重复投递不重复 Observation。
