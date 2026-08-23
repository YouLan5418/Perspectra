# ADR-0046：Round Authority 的可重算顺序与本地调用身份

- 状态：Accepted
- 日期：2026-08-23
- Extends：ADR-0044

## 背景

Authority v1 保存了实际全局裁定顺序，却把全局 ordinal 写进名为 `proposalOrdinal` 的字段。一个参与者提交多项 Action 且提案顺序与裁定顺序不同时，无法从账本恢复原 Proposal，因此也无法独立重算 `proposalHash`。同时，`modelCallId` 与 `budgetDecisionId` 看起来像外部 Model Replay / Budget Store 的外键，但当前无模型路径并未写入这些外部记录。

## 决定

1. 新提交的 Authority 文档升为 `schemaVersion: 2`；v1 历史字节与 Hash 不改写。
2. 每个 Action 顶层保存参与者原 Proposal 内的 `proposalOrdinal`。`orderKey` 只保存真实参与全局排序的字段，并显式加入 `roleRank`；按 `proposalOrdinal` 排序即可恢复原 Proposal，按 `orderKey` 可恢复实际裁定顺序。
3. 将未接线的 `modelCallId` / `budgetDecisionId` 改名为 Authority 自身的 `providerInvocationId` / `budgetEvaluationId`。它们是同轮关联身份，不是外部 Store 外键。
4. `modelReplayRecordHash` 与 `budgetReservationRecordHash` 显式为 `null`，表示没有对应的外部耐久记录。未来只有在同一调用确实写入并验证外部记录时才允许填入 Hash。

## 后果

- 多 Action Proposal、全局裁定顺序和 `proposalHash` 可以彼此独立核对。
- Agent 与 Director 的先后关系不再隐含在实现 comparator 中。
- 审计读取方不会把合成关联 ID 误当成可查询的 Model Replay 或预算凭证。

## 验证

- 集成测试使用原顺序 `action:z, action:a` 的两 Action Proposal，确认裁定顺序为 `a, z`，同时由 `proposalOrdinal` 恢复原顺序并重算出相同 `proposalHash`。
- Player、Agent、Director 的持久化 `roleRank` 与实际 comparator 一致；外部记录 Hash 在未接线时明确为 `null`。
