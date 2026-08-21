# ADR-0035：KnowledgeRule、Memory Capture、Recall 与 Forget

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §11](../spec/implementation-v0.2.md#11-knowledgeclaim-与-memory)

## 决策

KnowledgeClaim 只能来自 Genesis/Admin Seed、确定性 KnowledgeRule 或经 Rulebook 验证的 `character.reflect`。Memory 是非权威派生召回层，只捕获已提交且获授权的来源。本地 Wrapper 必须验证 namespace、source mapping、contentHash 和 `maxSourceSeq <= asOfWorldSeq`。

## 结果

Phase 0 不实现 Memory。Phase 4 必须先实现本地 SQLite FTS5；TencentDB 在固定审阅 commit、许可证和契约测试前保持禁用。来源缺失时省略结果，不能退回未过滤内容。
