# ADR-0028：Event Upcast、Projection 与 Snapshot 版本

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §10](../spec/implementation-v0.2.md#10-canonical-jsonhash-与版本)

## 决策

WorldEvent 原始 Envelope 永不改写；同一 eventType/eventVersion 的 Schema 冻结。表示升级使用逐版本纯 Upcaster，语义修正使用补偿 Event。Projection 有独立 stateVersion；不能验证升级时丢弃派生状态并从 Event 重放。

## 结果

Phase 0 固定 eventVersion 1，并用生产 Event Reducer 重建四类时态 Projection。Upcaster 和 Snapshot Bundle 在后续 Phase 实现，但不得访问网络、模型、Memory、时钟或随机数。
