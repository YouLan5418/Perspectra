# ADR-0029：Snapshot、Retention 与 Session Compaction

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §17](../spec/implementation-v0.2.md#17-snapshotretention-与数据增长)

## 决策

Snapshot 是可丢弃派生加速物，不替代 WorldLog。一个 Snapshot Bundle 的 Header 和所有必需 Unit 必须对应同一 asOfSeq；缺失或损坏任一 Unit 时丢弃整个 Bundle。V0 不自动截断 WorldLog。Session Summary 必须带来源范围和 Hash，不能形成 Claim 或 Memory Capture。

## 结果

Phase 4 已实现 Session Compaction。Phase 5 已实现独立 Snapshot Store：每个 Bundle 的 Unit Hash 与同一 asOfSeq 绑定，损坏时 fail-closed；Retention 只把旧派生 Snapshot 标记为 retired，不删除 WorldLog、Session Event 或投递账本。
