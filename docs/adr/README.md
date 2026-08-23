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
| [0029](ADR-0029-snapshot-retention-compaction.md) | Snapshot、Retention、Compaction | Compaction 与派生 Snapshot/Retention 已实现 |
| [0030](ADR-0030-principal-world-address.md) | Principal、WorldAddress、最小权限 | 所有入口使用完整品牌地址 |
| [0031](ADR-0031-telemetry-health-audit.md) | Telemetry、Health、Audit | Health、固定基数 Metrics 与耐久 Audit 已实现 |
| [0032](ADR-0032-model-profile-budget.md) | Model Profile 与 Budget | Phase 0 禁用模型 |
| [0033](ADR-0033-character-lifecycle.md) | 角色生命周期与运行可用性 | 类型边界保留，后续实现 |
| [0034](ADR-0034-contract-registries.md) | Event/Action/Contract Registry | 已实现冻结 Registry |
| [0035](ADR-0035-knowledge-memory.md) | Knowledge 与 Memory | Local FTS5、as-of 防火墙与认知规则已实现 |
| [0036](ADR-0036-admin-branch.md) | 行政 Barrier 与 Branch | Barrier、archive、深度限制与 Manifest 继承已实现 |
| [0037](ADR-0037-operations-platform.md) | 运维接口与平台基线 | 本机 Backup/Transfer/CLI/JSON-RPC 已实现 |
| [0038](ADR-0038-concurrency-authority-hardening.md) | 并发领取、权威来源与一致性传输加固 | 已实现跨 Worker CAS、可信来源和传输闭环 |
| [0039](ADR-0039-application-round-composition.md) | WorldApplication、真实 Branch 组件与统一 Round 协调 | Phase 6 组合根与生产路径 |
| [0040](ADR-0040-phase6-recovery-application-authority.md) | 非确定参与者恢复、实例权威与应用边界 | Phase 6 独立审查加固 |
| [0041](ADR-0041-async-round-headless.md) | 异步 Round 受理、耐久状态与本机 Headless 循环 | Release Closure 异步协议单元 |
| [0042](ADR-0042-stored-manifest-runtime-compatibility.md) | 存量 Manifest 的只读运行时兼容 | V1 世界原字节不变并可由当前组合根执行 |
| [0043](ADR-0043-durable-round-recovery-driver.md) | 耐久 Round 的宿主恢复驱动 | 启动扫描、显式排空、可观测重试和 Headless 有序关闭 |
| [0044](ADR-0044-round-authority-ledger.md) | Round 提案、行动与裁定权威账本 | 同事务 Authority、Bundle Hash 绑定、fork 与传输闭环 |
| [0045](ADR-0045-investigation-entity-rule.md) | 调查物品的版本化取得规则 | Rulebook v2 的 take/entity.taken 与竞争重裁决 |
| [0046](ADR-0046-round-authority-reconstructible-order.md) | Round Authority 的可重算顺序与本地调用身份 | Proposal 原序、真实 roleRank 与外部记录缺席语义 |
| [0047](ADR-0047-principal-scoped-character-view.md) | 玩家 CharacterView 的 PrincipalBinding 授权 | RPC/CLI 只允许读取绑定角色，作者调试能力不外露 |
