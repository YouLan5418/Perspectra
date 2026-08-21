# ADR-0036：行政 Barrier、Branch 生命周期与深度限制

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §16](../spec/implementation-v0.2.md#16-行政并发与-admission-barrier)

## 决策

行政操作先关闭 Admission Gate，再排空已受理 Round。V0 Branch 只支持 fork 和 archive，最大深度 8；不支持 merge、rebase、cherry-pick、物理删除。fork 继承 forkSeq 之前的 Event、Tick 和 Manifest，不能读取父未来。

## 结果

Phase 5 已实现耐久 Admission Barrier、不可逆 archive 标记、fork 行政入口、同 tenant/world 约束和最大深度 8。子 Branch 递归继承父 Manifest 与 forkSeq 有效历史；future canary、损坏父链和超深分支均 fail-closed。没有 merge、rebase、cherry-pick 或物理删除。
