# ADR-0044：Round 提案、行动与裁定权威账本

- 状态：Accepted
- 日期：2026-08-23
- Extends：ADR-0023、ADR-0024、ADR-0039

## 背景

World Event Log 已能重建提交后的世界状态，但旧实现只在 Event 中保存参与者终态摘要和简化的 `action.resolved`。经校验 Proposal、完整 ActionRequest、稳定排序键、Candidate 前后 Hash、规则轨迹 Hash 与 entropy refs 没有一份和 World Commit 同事务、受 Bundle Hash 保护的耐久记录。因此，事件结果虽可重放，却不能完整解释“哪些候选参加了本轮，以及 Kernel 为什么得到该裁定”。

实施规格列出的 `round_participants`、`round_proposals`、`action_requests`、`resolutions` 和 `failures` 是逻辑所有权要求，不强制每个实体必须使用独立物理表。若拆成多张可独立更新的表，反而会增加同步事实源和部分写入风险。

## 决定

1. 每个由 `RoundCoordinator` 提交的 transaction 生成一个 versioned `round_authority` 文档。它逻辑包含：
   - Player、Agent 和 Director 的 participant 终态；
   - modelCallId、contextHash、profileVersion、budgetDecisionId、responseHash、proposalId 与 proposalHash；
   - 经校验的完整 ActionRequest 及实际稳定 `orderKey`；
   - 每个 Resolution 的 status、reason、candidateHashBefore/After、ruleTraceHash、entropyRefs 和 conflictingActionId；
   - Round 边界与 finalCandidateHash。
2. `round_authority` 与 Event、Tick、Head、Outbox、`round_commits` 在同一 `BEGIN IMMEDIATE` transaction 中提交。它不是 Event Projection，也不允许脱离 World Commit 单独更新。
3. Authority 文档使用 `world-round-authority` 域计算 Hash。`authorityHash` 同时进入 commit request Hash 和 `world-round-bundle` Hash；同 transactionId 的不同 Authority 必须返回 `IDEMPOTENCY_KEY_CONFLICT`。
4. `round_commits.authority_hash IS NULL` 仅代表 migration 前的合法历史 transaction 或不经过正式 Coordinator 的底层兼容 fixture。新的生产 Round 必须携带 Authority。
5. fork 通过有效 Event 边界决定 Authority 可见性：只有 transaction 的 Event 在子 Branch 的 inherited history 中有效时，Authority 才可读取。父 Branch fork 点后的记录不得泄漏。
6. World schema 升至 11。逻辑权威格式升至 `dshworld-authority/v5`，包含 `round_authority` 与 `round_commits.authority_hash`。导入器继续接受 v4：验证原始 v4 Bundle Hash 后，只为旧 commit 补 `authority_hash = NULL` 和空 Authority 表，不伪造历史裁定。
7. Authority 内容、绑定或 Hash 分歧属于 `BUNDLE_HASH_MISMATCH`；读取、完整性验证和逻辑导入均 fail-closed。

## 后果

- Provider 原始 Prompt/Response 仍不落权威库；保留的是稳定 Hash、契约化 Proposal/Action 和终态，符合最小披露边界。
- 世界状态继续只由 Event Reducer 重建；Authority 解释并约束一次提交，但不成为第二套可变世界状态。
- Replay、restart、fork、export/import 可以核对同一裁定，不会重新调用非确定 Provider。
- 未来扩充 ActorOrdinal、initiative 或 DeterministicEntropy 时通过 Authority `schemaVersion` 演进，不改写 v1 历史。

## 验证

- Coordinator 测试核对成功、失败、预算耗尽和 schema-invalid participant 的终态，以及完整 Action/Resolution 账本；重启幂等读取的 Authority bytes 与 Hash 不变。
- Store 测试覆盖 Authority 内容分歧、删除、篡改、Bundle 绑定和 fork future canary。
- 逻辑传输测试覆盖 v5 round-trip、篡改/缺失拒绝和 v4 兼容升级。
- OS 子进程在 Event insert 后、COMMIT 前和 COMMIT 后被强制终止；恢复后 Authority 与 Event/Outbox 同为全无或全有。
