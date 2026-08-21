# ADR-0029：Snapshot、Retention 与 Session Compaction

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §17](../spec/implementation-v0.2.md#17-snapshotretention-与数据增长)

## 决策

Snapshot 是可丢弃派生加速物，不替代 WorldLog。一个 Snapshot Bundle 的 Header 和所有必需 Unit 必须对应同一 asOfSeq；缺失或损坏任一 Unit 时丢弃整个 Bundle。V0 不自动截断 WorldLog。Session Summary 必须带来源范围和 Hash，不能形成 Claim 或 Memory Capture。

## 结果

Phase 4 已实现 Session Compaction：摘要绑定 Session、连续 delivery 范围、来源 Observation ID、World Seq 边界和 contentHash，且不删除或改写原始 Session Event。Snapshot 与 Retention 留待 Phase 5；保留策略只能删除明确可重建的派生数据。
