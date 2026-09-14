# 架构决策记录

除表内明确标为 Proposed 的研究决断外，以下 ADR 状态均为 Accepted。实现若需要改变决定，新增 ADR 并标记 supersedes，不修改历史决定的含义。

| ADR | 主题 | 当前落点 |
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
| [0033](ADR-0033-character-lifecycle.md) | 角色生命周期与运行可用性 | 领域生命周期进入 Event/View/Rulebook，运行可用性保持独立运维状态 |
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
| [0048](ADR-0048-hybrid-investigation-actions.md) | 混合文本输入与版本化调查 Action | Rulebook v3、证据能力过滤和多轮结案闭环 |
| [0049](ADR-0049-investigation-v4-trust-boundaries.md) | 调查 v4 的证据身份与作者真相边界 | Manifest 派生目录、作者种子、终局屏障与玩家可见对白 |
| [0050](ADR-0050-rulebook-registry-mystery-boundary.md) | Rulebook 注册与悬疑试金石边界 | Core 仅含通用规则，调查 Resolver 由 Demo 显式注册且 Golden 全等 |
| [0051](ADR-0051-demo-cognition-scene-interaction-degradation.md) | Demo 的认知、Scene、通用交互与降级闭环 | 四项文档欠账进入正式 Application 路径并由悬疑场景验收 |
| [0052](ADR-0052-durable-cognitive-work-and-clarification.md) | 耐久认知工作与非 Round 受理记录 | World 事务内 cognitive job、fenced worker 与可审计 clarification |
| [0053](ADR-0053-private-v0-local-release-boundary.md) | 私有源码 V0 的本机发布边界 | 0.1.0、stdio、Host 所有权、Outbox 退避与外部证据边界 |
| [0054](ADR-0054-world-pack-source-compiler-versioning.md) | World Pack 来源、编译、信任与版本 | Phase 7 先实现最小 Pack；插件扩展留到 Phase 9 |
| [0055](ADR-0055-character-cognition-affect-goal.md) | 角色认知、关系、Goal 与复杂心理 | Phase 7 只实现 Claim/初始 Goal；动态 Affect/Tension 留到 Phase 8 |
| [0056](ADR-0056-scene-objective-presentation.md) | Scene v2、Objective 分类与确定性呈现 | Phase 8 实现；Phase 7 继续使用现有单 Scene policy |
| [0057](ADR-0057-creator-extension-runtime-author.md) | 创作者 Action 扩展、插件锁与 Runtime Author | Phase 9 实现；Phase 7 Pack 只允许现有 Core profile |
| [0058](ADR-0058-player-slot-control-observer.md) | PlayerSlot、Agent Controller 与角色限域 Observer | Phase 10 实现；Phase 7 玩家保持 manual |
| [0059](ADR-0059-agent-participation-memory-provider.md) | Agent 参与调度、Memory Profile 与真实 Provider | Phase 7 复用 Local Memory；完整调度与真实 Provider 分配到 Phase 10～11 |
| [0060](ADR-0060-content-pack-manifest-provenance.md) | 内容包 Manifest 来源绑定与 Genesis 接入 | 旧 Manifest 不变；Pack 世界用 v3 锁定来源并通过既有认知事件激活 |
| [0061](ADR-0061-world-pack-entity-source-closure.md) | World Pack 通用实体来源闭环 | 实体由显式来源文件编译并继续交给 Core take 裁定 |
| [0062](ADR-0062-pack-public-speech-observation.md) | Pack 公开对白进入角色观察与 Memory | Manifest v3 的同 Scene 角色可记住公开原话但不自动获得真值 Claim |
| [0063](ADR-0063-pack-runtime-capability-and-v1-closure.md) | Pack 运行能力与 v1 格式收口 | 行为能力不再借用 Schema 版本；冻结 Pack v1 与创作者错误契约 |
| [0064](ADR-0064-context-v2-cache-provider-boundary.md) | Context v2、前缀缓存与 Provider 调用边界 | Phase 8 前移可重建 Context/Renderer/Receipt；真实网络仍留 Phase 11 |
| [0065](ADR-0065-cognition-v1-reflection-policy.md) | Basic v1 主观状态、Reflection 与确定性心理策略 | 冻结关系/情绪/冲突/目标/承诺词汇和来源化认知变化 |
| [0066](ADR-0066-scene-v2-director-observation.md) | Scene v2、动作时刻观察与限域 Director | 多 Scene、零或一 focal Scene、逐动作可见性与防全知泄漏 |
| [0067](ADR-0067-cognitive-memory-worldpack-v2.md) | Cognitive Memory v2、World Pack v2 与旅途试金石 | v1 字节冻结；v2 来源、水位、Recall 和“雨夜同行”验收 |
| [0068](ADR-0068-phase8-context-summary-signal-quality-closure.md) | Phase 8 摘要、上下文 Hash、信号与 Provider 质量边界 | L1 唯一摘要、双 Hash 成员、私密信号防火墙与确定性质量降级 |
| [0069](ADR-0069-worldpack-v2-source-file-shapes.md) | World Pack v2 作者源文件形状 | Character、Cognition、Scene、Memory 与 Document 的精确输入形状 |
| [0070](ADR-0070-phase8a-cognition-scene-visibility-closure.md) | Phase 8A 认知词汇与 Scene 观察范围收口 | Goal objective 读取校验、direct/private 旁观语义与 occurrence-only 脱敏 |
| [0071](ADR-0071-reflection-operation-protocol.md) | Reflection Operation 与确定性限制的精确协议 | 冻结 optimistic state、来源补入、字节/幅度/容量限制和 Policy Receipt |
| [0072](ADR-0072-location-bound-scene-transition.md) | Location 绑定 Scene 的确定性迁移 | Scene v2 的通用 move 在同一 World Commit 追加离场、关闭、激活与加入事件 |
| [0073](ADR-0073-participant-stimulus-director-visibility.md) | 参与者刺激裁剪与 Director 可见性闭环 | 提交前刺激、Recall、Director 与动作时刻 Scene audience 使用同一最小权限边界 |
| [0074](ADR-0074-deterministic-world-text-order.md) | 确定性世界文本顺序 | 所有权威及 Hash 相关排序统一使用 UTF-16 code unit 比较器 |
| [0075](ADR-0075-session-dead-letter-sequence-continuity.md) | Session 死信序号连续性 | 任一已分配序号的 dead letter 阻塞同 Session 后续投递直至原序重试成功 |
| [0076](ADR-0076-reaction-cycle-npc-only-round-prototype.md) | Reaction Cycle 与 NPC-only Round 原型 | **Proposed**；P0 证明耐久两层 FIFO 与硬崩溃恢复，尚未成为正式运行时契约 |
| [0077](ADR-0077-bounded-autonomous-reaction-cycle.md) | 有界自主 Reaction Cycle 与 NPC-only Round | 正式方向已冻结；Phase 9A/9B 已落地权威骨架与有界多 wave，Phase 9C 收口运行闭环 |
| [0078](ADR-0078-reaction-policy-manifest-version-gate.md) | Reaction Policy 的 Manifest 版本门 | Manifest v1～v4 恒为 disabled；只有严格校验的 v5 可显式启用 responsive/v1 |
| [0079](ADR-0079-host-fair-scheduling-backpressure-administrative-stop.md) | Host 公平调度、背压与行政停止语义 | 一个 Branch 一个量子；wake 可丢失并由耐久扫描恢复；行政操作纳入 active Cycle |
| [0080](ADR-0080-world-pack-v3-reaction-policy-creator-entry.md) | World Pack v3 与 Reaction Policy 创作者入口 | v1/v2 字节与 Hash 冻结；只有 v3 必填 reactionFile 能编译出 Manifest v5 |
| [0081](ADR-0081-deployment-backup-restore-set.md) | 多库部署备份与恢复集合 | 五库制品、部署静默屏障、双向水位校验与只恢复到全新空目录 |
| [0082](ADR-0082-quarantine-unreadable-reaction-ledger.md) | 损坏 Reaction 账本的紧急隔离 | 保留损坏证据但仍封锁 Branch；不伪造 Cycle 终态，恢复必须重新校验 |
| [0083](ADR-0083-manifestation-observable-expression.md) | 角色外显表现、观察传播与可见状态 | submit_actions/v3 显式启用；表现独立裁定后进入 Event、Observation、Memory 与可见状态 |
| [0084](ADR-0084-player-manifestation-input.md) | 玩家自然语言外显表现输入 | 人工玩家可在唯一 Action 旁提交同构表现；翻译器不可信且不得绕过 Authority |
| [0085](ADR-0085-bounded-action-groups.md) | 有界顺序行动组与逐步表现 | Manifest v7 显式启用最多两步、连续裁定、失败停止与闭合表现；旧协议保持原语义 |
| [0086](ADR-0086-object-interactions.md) | 对象声明的物品交互 | Manifest v8、submit_actions/v5 与显式对象目录；拿取、放下、递交均确定性重验 |
| [0087](ADR-0087-player-immediate-character-interactions.md) | 玩家受限即时成立权与角色关系交互 | **Accepted**；Manifest v9 以 Host 派生权威、可解除 hand_hold 和耐久玩家解释验证“先成立、后反应”，按 C0～C4 门禁实施 |
| [0088](ADR-0088-versioned-keyword-recall.md) | 版本化关键词召回与中文切分 | **Proposed**；以版本化二/三元切分与“命中任一词元”取代整段相同，专有名词词典只加权不参与索引且可按世界停用，排序与词典均限定 namespace/as-of 前缀，旧版本不原地替换 |
| [0089](ADR-0089-tokenizer-runtime-dependency.md) | 记忆检索引入分词器运行时依赖 | **Proposed**；锁定 `jieba-wasm` 精确版本并只用已验证接口，选 WASM 以保跨平台同一制品，分词器只是可替换版本件，二元继续当召回下限 |
| [0090](ADR-0090-structural-recall-clues.md) | 结构化线索召回（在场人物与未完成事项） | **Proposed**；线索只来自场景权威成员与角色自己的认知，只扩候选与加权、不改权限，线索为空时与纯关键词路径逐字节相同 |
| [0091](ADR-0091-summary-digest-in-context.md) | 把经历摘要正文接进角色上下文 | **Accepted**；摘要正文随连续性段给模型，只取 Tail 起点之前、从最近往前受档位预算约束；不生成第二套摘要，但 supersede ADR-0068 中"Checkpoint 段不含经历正文"的边界 |
| [0092](ADR-0092-epoch-snapshot-append-only-history.md) | Epoch 快照与只追加的第二层 | **Proposed**；基线冻结、其后事件只追加，第二层预算为档位请求预算的一半、越界才整体前移一次；`recentInteractionBlocks` 数值不变但含义变为"重建时保留多少块" |
| [0093](ADR-0093-interaction-definition-abstraction.md) | 交互定义抽象、按需交互包与目标自声明 | **Accepted**；2026-09-13 用户明确确认，首批迁移已有五类动作，v10 先交互；I0 Gate 关闭，I1～I5 按阶段验收 |
| [0094](ADR-0094-communication-scenes-and-propagation.md) | 通信 Scene 与跨边界传播 | **Proposed**；物理与通信成员隔离，按媒介授权观察，统一反应预算；方向已确认，具体契约与工程门禁待完成 |
| [0095](ADR-0095-relation-class-binding.md) | 关系目标按类绑定 | **Accepted**；`kind: relation` 绑定的 id 指名创建该类关系的定义，不指名实例；实例由来源 Action 在运行期派生。2026-09-14 用户裁定，见 [缺口记录](../2026-09-14_交互抽象-I4b前置-关系目标绑定缺口.md) |
