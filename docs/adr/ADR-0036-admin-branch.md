# ADR-0036：行政 Barrier、Branch 生命周期与深度限制

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §16](../spec/implementation-v0.2.md#16-行政并发与-admission-barrier)

## 决策

行政操作先关闭 Admission Gate，再排空已受理 Round。V0 Branch 只支持 fork 和 archive，最大深度 8；不支持 merge、rebase、cherry-pick、物理删除。fork 继承 forkSeq 之前的 Event、Tick 和 Manifest，不能读取父未来。

## 结果

Phase 0 只实现最小 `forkBranch` 和有效历史重建，用 future canary 验证 as-of 隔离；不提供行政 API、archive 或 Barrier。Cordis Slot 以完整 Branch 地址隔离并在最后一个 Lease 释放时 Dispose。
