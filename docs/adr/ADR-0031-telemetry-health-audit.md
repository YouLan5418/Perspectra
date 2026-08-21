# ADR-0031：Telemetry、Health 和耐久 Audit

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §21](../spec/implementation-v0.2.md#21-可观测性与健康)

## 决策

Telemetry 是非权威派生信号，失败不能改变 Round。世界激活、绑定、分支、maintenance、Manifest、迁移、备份恢复、quarantine 和人工 dead-letter 操作必须先写本地耐久 Audit。日志默认只记录 ID、Hash 和大小，不记录 Secret、完整 Prompt、Memory 或对白正文。

## 结果

Phase 0 只保留 correlationId 和稳定错误字段，不实现正式 Health/Audit Store。Phase 5 实现时高基数字段进入日志或 Trace，不进入全局指标 Label。
