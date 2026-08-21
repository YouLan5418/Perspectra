# 架构决策记录

以下 ADR 状态均为 Accepted。实现若需要改变决定，新增 ADR 并标记 supersedes，不修改历史决定的含义。

| ADR | 主题 | Phase 0 落点 |
|---|---|---|
| [0023](ADR-0023-player-round-fifo.md) | 玩家绑定、玩家先行和 Round FIFO | 无模型闭环验证玩家 Action 排在首位 |
| [0024](ADR-0024-agent-context-submit-actions.md) | Agent Context 与 submit_actions | Provider 可替换和最多两个 Action |
| [0025](ADR-0025-canonical-world-json.md) | Canonical World JSON 和 Hash | 已实现并有 Golden 测试 |
| [0026](ADR-0026-worldspec-manifest-genesis.md) | WorldSpec、Manifest、Genesis | Registry/Hash 契约已锁定 |
| [0027](ADR-0027-session-delivery.md) | Session FIFO 与原子幂等 | 已实现 Adapter 和崩溃矩阵 |
| [0028](ADR-0028-event-projection-versioning.md) | Event/Projection 版本 | v1 Envelope 与重建契约已锁定 |
| [0029](ADR-0029-snapshot-retention-compaction.md) | Snapshot、Retention、Compaction | Session Compaction 已实现；Snapshot/Retention 待 Phase 5 |
| [0030](ADR-0030-principal-world-address.md) | Principal、WorldAddress、最小权限 | 所有入口使用完整品牌地址 |
| [0031](ADR-0031-telemetry-health-audit.md) | Telemetry、Health、Audit | 仅锁定非权威边界 |
| [0032](ADR-0032-model-profile-budget.md) | Model Profile 与 Budget | Phase 0 禁用模型 |
| [0033](ADR-0033-character-lifecycle.md) | 角色生命周期与运行可用性 | 类型边界保留，后续实现 |
| [0034](ADR-0034-contract-registries.md) | Event/Action/Contract Registry | 已实现冻结 Registry |
| [0035](ADR-0035-knowledge-memory.md) | Knowledge 与 Memory | Local FTS5、as-of 防火墙与认知规则已实现 |
| [0036](ADR-0036-admin-branch.md) | 行政 Barrier 与 Branch | 已验证最小 forkSeq，不提供管理面 |
| [0037](ADR-0037-operations-platform.md) | 运维接口与平台基线 | Node/pnpm/SQLite/CI 已固定 |
