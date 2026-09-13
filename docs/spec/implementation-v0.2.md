# Harness / Cordis 世界模拟项目 V0.2 实现收敛规格

> 文档版本：1.0.0  
> 日期：2026-08-21  
> 状态：实现前最终收敛基线  
> 上游架构：V0 技术设计 1.1.0（外部文档 `2026-08-21_技术设计-Harness-Cordis-World-V0-report.md`）  
> 源码调研：Harness / Cordis 源码调研报告（外部文档 `2026-08-21_源码调研-Harness-Cordis-report.md`）  
> 外部复核输入：其他模型意见汇总（外部文档 `2026-08-21_其他模型意见汇总.md`）  
> 调研源码：<code>deepseek-harness-dsh-v0.1.1-rc.1</code>

> 上游输入可见性：上面列出的上游架构、源码调研与外部复核输入三份文档，加上被「V0 技术设计 1.1.0」引用为架构上下文的《项目上下文与架构决策说明（修订版）》，以及调研源码目录，全部位于本仓库之外的机器目录，**从未纳入版本控制**。因此这里只记文件名、不提供仓库内链接；证据表中的 E-007～E-009 以这些外部文件为准，复核时需另行取得。上游设计稿是否入库不由本文决定，此处只如实记录现状。

> 实现警告：本文是设计和实现契约，不表示代码已经完成。当前没有执行 WorldStore 压测、Session 原子幂等 Adapter 原型、TencentDB 契约测试、跨平台 Golden Hash、子进程崩溃矩阵或真实模型成本基准。任何 P0 验证失败都必须先修订 ADR，不能用弱化不变量的方式绕过。

> 一致性警告：WorldStore、SessionStore、Memory Provider 和 Model Provider 不共享事务。V0 的端到端承诺分别是：世界事实单库原子提交；Session 至少一次投递加消费端原子幂等；Memory fail-closed 来源校验；模型输出只作为提案。系统不宣称跨存储分布式 exactly-once。

## 1. 文档定位与优先级

本文整合外部复核后逐项确认的设计，并对尚未讨论的 Agent、Memory、行政并发、Branch、备份、JSON-RPC 和平台问题直接定案。实现时按以下优先级解释：

~~~text
Accepted ADR
→ 本文
→ V0 技术设计 1.1.0
→ 项目上下文与架构决策说明（修订版）
→ 源码调研报告
~~~

若本文与 V0 技术设计 1.1.0 冲突，以本文为准；没有被本文修改的 1.1.0 条款继续有效。本文不修改 Harness/Cordis 源码，也不创建文中规划的 ADR 文件。优先级链中除 Accepted ADR 与本文之外的三份文档都在仓库外，无法从本仓库点开或校验版本（见文首「上游输入可见性」）。

V0.2 在本文中仍然表示 V0 的设计收敛版本，不代表对外发布的产品版本。

## 2. 最终决策摘要

| ID | 决策 |
|---|---|
| D-001 | Cordis 根作用域注册无世界状态的 WorldRuntimeRegistry；每个活动 Branch 使用独立 BranchRuntimeSlot |
| D-002 | WorldAddress 固定为 tenantId、worldId、branchId；所有入口显式路由 |
| D-003 | 单用户绑定单玩家角色；普通文本原样成为 character.speak，结构化命令产生其他行动 |
| D-004 | 玩家行动先行，NPC 和 Director 在同一 Round 中基于玩家候选状态反应 |
| D-005 | 每条受理的玩家世界输入独立形成一个 Round 和一个 Tick；每 Branch 严格 FIFO，不组批 |
| D-006 | 提案集合按终态或 deadline 关闭；迟到响应永不进入已经冻结的集合 |
| D-007 | 每个 NPC 每轮一次模型调用，必须一次性返回 abstain 或最多两个 ActionRequest |
| D-008 | 行动按 phase、规则优先级、initiative、actorOrdinal、proposalOrdinal、actionId 串行裁决 |
| D-009 | Observation 由 Kernel 确定性生成，与来源事件原子提交；叙事渲染是非权威提交后能力 |
| D-010 | Canonical World JSON 只允许合法 Unicode、布尔、null、safe integer、数组和普通对象 |
| D-011 | Hash 使用版本化结构 Envelope，不进行裸字符串拼接 |
| D-012 | WorldDraft、WorldSpec、CompiledWorldManifest 和 GenesisPlan 分层；Genesis 在 Tick 0 原子提交 |
| D-013 | WorldEvent 永久不可变；表示升级走 Upcast，语义修正走补偿 Event |
| D-014 | Snapshot 只加速恢复；V0 不截断 WorldLog、幂等键或投递账本 |
| D-015 | 不同 Session 并行投递，同一 Session 使用连续 delivery seq 严格 FIFO |
| D-016 | SessionStore 必须原子提交 delivery inbox、Observation 和 cursor；Critical dead letter 不得跳过 |
| D-017 | KnowledgeClaim 只能由确定性 KnowledgeRule、Genesis/Admin Seed 或受规则验证的 reflect Action 改变 |
| D-018 | Memory 只从已提交授权来源捕获；recall 使用文本加结构过滤并强制本地 as-of 来源闭包校验 |
| D-019 | Session Compaction 只改变模型上下文选择，不删除原始 Session，也不生成知识事实 |
| D-020 | Director Scheduler 与 Provider 分离；Noop、Rule、Scripted、LLM 实现可替换 |
| D-021 | Model Budget 先按稳定参与者顺序预留，再并行调用；耗尽只使参与者缺席或确定性降级 |
| D-022 | 角色领域生命周期与 Agent Runtime 可用性分离；死亡和离场不删除历史 |
| D-023 | V0 是本机、单租户、单可信操作员系统；JSON-RPC 只允许本机访问 |
| D-024 | 每个 Manifest 包含闭合 Event/Action/Projection/Rule Registry；未知类型 fail-closed |
| D-025 | 行政操作先关闭入站 Gate，再排空已受理 Round；普通 fork 不等待 Session Outbox 排空 |
| D-026 | V0 Branch 只支持 fork 和 archive；不支持 merge、rebase、cherry-pick 或物理删除 |
| D-027 | Backup 是部署级 SQLite 一致副本；Export 是不含 Secret 的可移植逻辑包 |
| D-028 | JSON-RPC 的 Round 提交总是返回异步受理结果；CLI wait 只是客户端便利行为 |
| D-029 | 平台基线为 Node 22.19.x 或 24+、pnpm 11.7、ESM 和 Node 内置 node:sqlite |
| D-030 | Telemetry 非权威；关键安全、迁移和恢复操作写本地耐久审计 |

## 3. V0 范围与非目标

V0 实现：

- 单进程、单租户、本地可信操作员；
- 每 Branch 单 Writer、SQLite WorldStore、TURN_DRIVEN 时间；
- 单玩家角色、多个 NPC、可选 Director；
- Scene、Location、Observation、KnowledgeClaim、Goal 和角色生命周期；
- Local Memory，外部 TencentDB Provider 可选；
- CLI、Headless、JSON-RPC、本地备份和逻辑导出；
- Snapshot、fork、archive、maintenance、quarantine；
- 无模型 Scripted/Rule 运行路径和完整确定性测试。

V0 明确不实现：

- REALTIME_DAEMON 和 FRACTAL 时间；
- 多用户协作、互联网认证、远程 JSON-RPC；
- Branch merge、rebase、cherry-pick 和物理删除；
- 分布式事务、跨节点 Writer 共识；
- 自动截断 WorldLog；
- Cordis Plugin 沙箱；
- 复杂内容审核平台；
- 任意浮点世界状态；
- 一个用户同时控制多个玩家角色；
- 跨世界迁移同一 Character；
- Web 管理后台。

## 4. 收敛后的运行架构

~~~mermaid
flowchart LR
    user[本地用户] --> shell[CLI / Headless / JSON-RPC]
    shell --> app[World Application]
    app --> registry[WorldRuntimeRegistry]
    registry --> slot[BranchRuntimeSlot]
    slot --> kernel[World Kernel]
    slot --> agents[Harness NPC Agents]
    slot --> director[Director Scheduler]
    kernel --> rules[Rulebook]
    kernel --> store[(SQLite WorldStore)]
    store --> projection[Projection Bundle]
    projection --> views[CharacterView]
    store --> outbox[World Outbox]
    outbox --> session[(SessionStore)]
    outbox --> memory[Memory Capability]
    outbox --> presentation[Presentation]
    agents --> router[Model Router]
    director --> router
    router --> llm[Harness LLM Runtime]
    memory --> local[(Local Memory)]
    memory -. optional .-> tencent[TencentDB]
    cordis[Cordis Context / Fiber / Effect] --- registry
    cordis --- slot
~~~

WorldRuntimeRegistry 以 WorldAddress 为键：

~~~typescript
interface WorldAddress {
  tenantId: TenantId
  worldId: WorldId
  branchId: WorldBranchId
}

interface BranchRuntimeSlot {
  address: WorldAddress
  childContext: Context
  kernel: WorldKernel
  store: WorldStore
  writerQueue: SerialQueue
  fencingToken: number
  state: 'loading' | 'ready' | 'draining' | 'maintenance' | 'closed'
}
~~~

根 Context 不注册有状态 WorldKernel/WorldStore。Registry 对同一地址的并发 acquire 去重；Slot Service/Listener 注册在 child Fiber，dispose 时整体清理。事件派发携带 WorldAddress，不能假定 Cordis 全局总线自动隔离作用域。

## 5. 玩家输入与 InteractionRound

玩家身份固定分层：

~~~text
Principal
→ PlayerBinding
→ PlayerCharacter

NPC Character
→ CharacterAgent
~~~

玩家角色拥有 Session 和 Observation，但不运行自主 Agent。Director 不得替玩家行动。

~~~typescript
type PlayerInput =
  | { kind: 'say'; text: string }
  | { kind: 'action'; actionType: string; parameters: WorldJsonValue }
~~~

普通文本原样写入 <code>character.speak</code>；<code>/do</code>、CLI 命令或 UI Affordance 产生结构化 Action。V0 不使用 LLM 自动解释玩家行动。

### 5.1 Round 最终时序

~~~mermaid
sequenceDiagram
    actor User as 玩家
    participant App as World Application
    participant Registry as Runtime Registry
    participant Kernel as World Kernel
    participant Agents as NPC/Director
    participant Store as WorldStore
    participant Outbox as Outbox

    User->>App: PlayerInput + idempotencyKey
    App->>Store: 原子写 Round Inbox / inboxSeq
    App->>Registry: acquire WorldAddress
    Registry-->>App: ready BranchRuntimeSlot
    App->>Kernel: 玩家 ActionRequest
    Kernel->>Kernel: 纯裁决得到候选 S1
    Kernel->>Kernel: 生成 Provisional Observation
    par 稳定预算预留后并行提案
        App->>Agents: ReactionView(S1)
        Agents-->>App: ProposalOutcome
    end
    App->>App: deadline 或全部终态后冻结集合
    App->>Kernel: 冻结提案
    Kernel->>Kernel: 稳定排序、串行裁决、最终 Observation
    Kernel->>Store: 原子提交 Resolution/Event/Tick/Outbox
    Store-->>App: WorldCommit
    Store-->>Outbox: pending deliveries
    App-->>User: committed RoundPresentation
~~~

每 Branch 只运行一个 Round；其余消息按 SQLite 分配的 <code>inboxSeq</code> FIFO 排队，不组批。队列满时在受理前返回 <code>ROUND_QUEUE_FULL</code>，不推进 Tick。

提案参与者必须进入 proposed、abstained、failed、timed_out 或 unavailable 之一。deadline 后冻结；迟到响应仅写审计。模型失败不阻止玩家事务，Store/Schema/Reducer/Invariant 错误阻止提交。

## 6. Agent 上下文与 submit_actions 协议

### 6.1 信任分区和上下文顺序

Agent Context 由 ContextAssembler 在同一 <code>asOfWorldSeq</code> 组装，顺序固定：

~~~text
1. Trusted Agent Contract
2. Scoped Character Capability
3. Current CharacterView
4. Current ReactionView
5. Active CharacterGoal
6. Verified Memory Recall
7. Session Compaction Summary + Recent Tail
8. ActionAffordance 和 Tool Schema
~~~

1、2、8 属于控制区；3～7 是数据区。Memory、Session、Observation 和玩家文本即使包含“忽略系统指令”也只能作为引用数据，不能改变 Tool、权限或输出 Schema。

~~~typescript
interface AgentTurnInput {
  schemaVersion: 1
  address: WorldAddress
  roundId: InteractionRoundId
  characterId: CharacterId
  asOfWorldSeq: number
  manifestHash: string
  contextHash: string

  characterView: CharacterView
  reactionView: ReactionView
  goals: CharacterGoalView[]
  recalledMemories: RecalledMemory[]
  sessionContext: SessionContextView
  affordances: ActionAffordance[]
}
~~~

### 6.2 单次 Tool 协议

每个 NPC 每轮最多一次模型调用。模型必须恰好一次返回 <code>submit_actions</code>：

~~~typescript
interface SubmitActionsInput {
  schemaVersion: 1
  decision: 'act' | 'abstain'
  actions: Array<{
    actionType: string
    actionVersion: number
    parameters: WorldJsonValue
  }>
  abstainReason?: string
}
~~~

V0 每次最多两个 ActionRequest，满足“说话加一个物理行动”的常见需求。同一响应中的顺序成为 <code>proposalOrdinal</code>。超过两个、重复 Tool Call、无 Tool、自由文本替代 Tool 或 Schema 非法都使参与者 <code>failed:invalid-proposal</code>；默认不进行第二次模型修复调用。

Provider 支持强制 Tool Choice 时强制调用；不支持时使用严格 JSON Schema Adapter。<code>abstain</code> 必须 actions 为空；<code>act</code> 必须包含一至两个 Action。ActionAffordance 只是建议，Kernel 仍在最新 Candidate 上重验授权和前置条件。

模型输出先规范化并计算 responseHash，再生成稳定 ProposalId/ActionId。ID 分配按 participant 稳定顺序和 proposalOrdinal，不能按响应到达时间。

### 6.3 Agent 失败与记录

ProposalAttempt 保存 modelCallId、contextHash、profileVersion、budgetDecisionId、responseHash 和终态，不默认保存完整 Prompt/Response。ActionRequest 是最终世界输入；历史重放不调用 Agent。

最小安全上下文超过模型窗口时先按冻结的裁剪优先级放弃非必需内容：第四级 Recall 与低相关历史摘要在前，第三级完整 InteractionBlock 与 Scene 次要细节在后。每次放弃以 <code>budget_trimmed</code> 记入 ContextReceipt，原始来源永久保留。只有第一、二级必需内容本身就超限时才返回 <code>CONTEXT_WINDOW_EXCEEDED</code>，该 NPC 本轮 unavailable。

## 7. 行动排序、冲突和原子性

排序键固定为：

~~~typescript
interface ActionOrderKey {
  roundPhase: 0 | 1
  rulePriority: number
  initiativeScore: number
  actorOrdinal: number
  proposalOrdinal: number
  actionId: ActionId
}
~~~

比较顺序为 phase 升序、priority 升序、initiative 降序、actorOrdinal 升序、proposalOrdinal 升序、actionId 字节序。玩家是 phase 0，NPC/Director 是 phase 1。priority/initiative 由锁定 Rulebook 计算，调用者不能声明。

ActorOrdinal 在创建时分配且永不复用；Genesis 按稳定 ID 排序，运行期 Actor 使用单调序号。fork 继承已有序号。

每个行动在当前 Candidate 上重新检查授权、前置条件和约束。预期资源冲突产生 rejected Resolution，Candidate 不变，后续行动继续。例如两人取同一物品时，第一个 accepted，第二个 <code>ITEM_NOT_AVAILABLE</code>。

一个 Action 的多个 EventDraft 在临时子 Candidate 上整体应用；全部 Schema、Projection 和 Invariant 通过才采用。预期领域拒绝只拒绝 Action；Event Schema、Reducer 或 Invariant 错误终止 Round 并 quarantine。

需要随机时使用具名 DeterministicEntropy：

~~~text
worldSeed + branchLineageHash + roundId + actionId + ruleId + drawName
~~~

不使用顺序随机流。Resolution 保存 orderKey、candidateHashBefore/After、规则轨迹 Hash、entropy refs 和可选 conflictingActionId。

## 8. Observation 与 Presentation

Observation 在 Kernel 内确定性生成：

~~~text
客观 EventDraft
→ Candidate Projection
→ Self Observation
→ Scene/Location Visibility
→ 感官和遮挡
→ Knowledge/Privacy 裁剪
→ ObservationDraft
→ 认知 Projection
~~~

~~~typescript
interface ObservationCreatedData {
  schemaVersion: 1
  observationId: ObservationId
  observerId: CharacterId
  perceivedAtTick: number
  sceneId?: SceneId
  modality: 'visual' | 'auditory' | 'tactile' | 'social' | 'system' | 'internal'
  content: ObservationContent
  sourceRefs: WorldSourceRef[]
  salience: 'background' | 'normal' | 'important' | 'critical'
  visibilityPolicyVersion: number
  contentHash: string
}
~~~

行动者始终收到经过裁剪的结果，但不自动知道隐藏失败原因。Resolution 可以作为 Observation Source，因此 rejected Action 也能产生自我反馈。

玩家候选 S1 使用同一 Generator 生成 Provisional Observation，供 NPC ReactionView 使用；正式提交前重新校验 <code>roundId + draftOrdinal + contentHash</code>，确保模型看到的内容和提交内容一致。

Presentation 分两层：

- Deterministic Presenter 使用模板，立即可用；
- 可选 LLM Renderer 只润色已授权 Observation，提交后异步执行。

LLM Presentation 不进入 Rulebook、Projection、Knowledge 或 NPC Agent 上下文。缓存键由 Observation contentHash、renderer profile version、locale 和 style 组成。失败时返回基础文本，不使 Branch degraded。

## 9. WorldSpec、Manifest 与 Genesis

~~~text
WorldDraft（可编辑）
→ WorldSpec（声明式输入）
→ CompiledWorldManifest（锁定执行契约）
→ GenesisPlan（稳定事件计划）
→ Genesis Transaction（Tick 0）
~~~

WorldSpec 至少包含 metadata、TURN_DRIVEN time policy、player policy、runtime policy、插件、Rulebook、Location、Entity、Character、Scene、Goal 和初始 Claim。它不得保存 Secret、函数、绝对路径或可执行代码。

编译执行：严格 Schema、插件 allowlist 和精确版本解析、引用图校验、Action/Event/Projection/Rule Registry 冻结、ID 稳定化、Hash 配置锁定、Genesis 事件生成、内存 Projection 预演和全部 Invariant。

Compiled Manifest 保存 specHash、genesisPlanHash、Canonical/Hash Version、精确插件绑定、Rulebook、各 Registry Hash 和语义 Runtime Policy。运行时不重新解释原始 WorldSpec。

Genesis 顺序固定：

~~~text
world.created
→ world.manifest-locked
→ Location / Entity / Character
→ Scene Membership
→ Goal / KnowledgeClaim
→ Initial Observation
→ world.lifecycle-changed(active)
~~~

同类 Seed 按稳定 ID 排序。Genesis 是一个行政事务，Tick 前后均为 0，不产生 <code>world.tick-advanced</code>。激活使用 activationKey 和 specHash 幂等；active 后不得重跑 Genesis。

## 10. Canonical JSON、Hash 与版本

WorldJsonValue 只允许 null、boolean、合法 Unicode string、safe integer、数组和普通对象。禁止小数、负零、NaN、Infinity、BigInt、Date、Map、Set、undefined、函数和循环引用；语义小数使用 mantissa/scale 定点结构。

Canonical Profile <code>world-json/v1</code> 递归按 UTF-16 code unit 排序对象键，保留数组顺序，使用 UTF-8、无 BOM、无空白并拒绝非法值。自由文本不偷偷做 Unicode 规范化。

Projection Unit 和 Bundle 都哈希完整类型 Envelope：

~~~typescript
interface ProjectionBundleHashEnvelope {
  kind: 'world-projection-bundle'
  hashVersion: 1
  asOfWorldSeq: number
  tick: number
  manifestHash: string
  units: Array<{
    projectionName: string
    projectionStateVersion: number
    unitHash: string
  }>
}
~~~

Unit 先按 name、stateVersion 排序，再对 Canonical Bytes 计算 SHA-256；输出固定为小写 <code>sha256:</code> 前缀。Bundle Hash、Snapshot Artifact Hash、Event Chain Hash、requestHash 和 contentHash 分开定义。

WorldEvent 原始 Envelope 永不改写。同一 eventType/eventVersion Schema 冻结；表示变化使用逐版本纯 Upcaster，语义修正使用补偿 Event。Upcaster 不访问状态、网络、模型、Memory、时钟或随机数。

Projection stateVersion 不兼容时，优先使用经过验证的 Snapshot Upgrader，否则丢弃派生状态并从 Event 重放。Snapshot Header 与全部 Unit 对应同一 asOfSeq；任一必需 Unit 缺失或损坏，V0 丢弃整个 Bundle。

Rulebook 只在 maintenance 创建新 Manifest Epoch；历史 Event 不重新裁决。旧 forkSeq 继承当时 Manifest。运行时无法加载旧 Manifest 时拒绝 fork/load，不使用新 Manifest 猜测。

## 11. KnowledgeClaim 与 Memory

### 11.1 Claim 形成规则

Observation 不自动等同于 KnowledgeClaim。Claim 只有三种合法来源：

1. Genesis/Admin Seed；
2. 确定性 KnowledgeRule 根据已提交 Observation 产生；
3. Character Agent 提交 <code>character.reflect</code> Action，由 Rulebook 验证来源和权限后产生。

LLM 不能直接调用 Claim Store。<code>character.reflect</code> 可以形成错误信念，但必须引用该角色实际拥有的 Observation/Claim；它不能引用隐藏 WorldEvent。沟通默认只产生“某人说过 P”的 Claim，不把 P 自动标记为真。

Claim 变化使用 created、revised、retracted、superseded Event。独立查询表是带 validFromSeq/validToSeq 的时态 Projection；CharacterView 在同一 asOfSeq 组合 Claim、Observation、Goal、Scene 和 Visibility。

### 11.2 Memory Capture

Memory 是派生召回层，只从以下已提交授权来源 capture：

- Observation；
- active KnowledgeClaim；
- CharacterGoal；
- 由角色本人产生并已提交的对白/行动结果。

不从模型原始响应、Presentation 润色、Session Summary 或普通 Prompt 自动捕获。Capture 通过独立 Outbox 异步、幂等执行，key 为 character scope、source refs、contentHash、extractor profile version。

### 11.3 Recall 查询

V0 使用文本加结构过滤的混合契约：

~~~typescript
interface MemoryRecallRequest {
  address: WorldAddress
  characterId: CharacterId
  asOfWorldSeq: number
  text: string
  filters: {
    kinds?: string[]
    sceneIds?: SceneId[]
    goalIds?: CharacterGoalId[]
    minSalience?: string
  }
  limit: number
}
~~~

Provider 可以用 FTS、向量或混合检索产生候选，但本地 Wrapper 必须验证 namespace、Mapping、contentHash、完整传递来源和 <code>maxSourceSeq <= asOfWorldSeq</code>，再按固定分数组合重排。来源缺失时省略结果，不退回未过滤结果。

Local Provider 是 V0 必需实现，至少支持 SQLite FTS5；向量索引可选。TencentDB 只能作为 Provider 或源码参考，未固定审阅 commit 和许可证记录前默认禁用。外部排序不决定知识权限。

<code>forget()</code> 只删除派生 Memory；不删除 WorldEvent、Observation 或 Claim。<code>reconcile()</code> 从已验证来源重新生成 Mapping/Record。Memory 返回项标记为不可信召回数据，不能包含新的系统指令。

## 12. Session、Outbox 与 Compaction

World Outbox 至少一次投递；同一 Session 使用连续 <code>sessionDeliverySeq</code>。Worker 只能领取该 Session 最早未完成项，不同 Session 可以并行。

Session Adapter 在一个本地事务中验证 cursor、插入 <code>session_delivery_inbox</code>、追加 Observation 并推进 cursor。旧 seq 命中相同 deliveryId/payloadHash 返回 already_applied；同 seq 不同 Hash 是 divergence，立即 quarantine。

重试使用 1、2、4、8、16、30 秒并保持 30 秒上限；默认 maxAttempts 12、maxAge 10 分钟。临时错误重试，完整性错误立即 quarantine。重试耗尽进入 dead_letter 并使 Branch degraded；Critical 项不能人工跳过，只能修复重投或重建 Session。

慢 NPC Session 使该 NPC <code>unavailable:session_lag</code>，不阻塞世界。Player Session 不运行 Agent，当前客户端直接使用 WorldCommit Presentation。

Session Compaction 只生成带 source delivery range、Observation IDs、min/max WorldSeq 和 contentHash 的 Summary。原始 Session append-only 日志在 V0 不物理删除；模型输入使用 Summary、Recent Tail 和当前 CharacterView。Summary 不是 Claim/Memory，不能作为 Memory Capture 来源。

## 13. 时间、角色生命周期与 Branch

V0 只实现 TURN_DRIVEN，激活后锁定。每个已受理且非重复的玩家世界输入产生一个 Round 和一个 Tick；无效传输、未授权请求、行政事务、Genesis、fork 不推进 Tick。领域 rejected Action 已经消耗世界回合，因此仍推进 Tick。

角色领域状态为 active、incapacitated、dead、departed；运行可用性为 provisioning、ready、session_lag、model_unavailable、budget_unavailable、offline、disabled。二者不互相伪装。运行时产生的状态都是临时的，尝试成功即自动回到 <code>ready</code>：<code>session_lag</code> 与 <code>budget_unavailable</code> 每一轮重新尝试（模型预算账本按轮与按波重建，一轮没抢到额度不代表下一轮）；<code>model_unavailable</code> 与 <code>provider_output_invalid</code> 只在质量退避允许时重试，且提供方失败、超时与非法输出计入同一退避，避免持续故障的提供方被每轮重复调用。只有 Host 设定的 provisioning、offline、disabled 持续拦住调度。

创建、生命周期变化、复活和离场全部事件化。死亡不删除 Character、Session、Memory 或 PlayerBinding；普通行动由 Affordance 拒绝。新 NPC 提交后异步 Provision Session，ready 前存在于世界但不参与模型提案。用户断开不是世界事件。

### 13.1 Branch 决策

V0 只支持 fork 和 archive：

- 不支持 merge、rebase、cherry-pick；
- 不物理删除 Branch；
- BranchId 在 World 内永久唯一且不可复用，displayName 可以重复；
- 父 Branch archive 后子 Branch 可以继续运行；
- 父前缀、Manifest 和 fork 锚点永久保留；
- 最大逻辑祖先深度为 8，超过时拒绝新 fork，未来由独立 materialization ADR 解决；
- 子 Branch Export 包含完整逻辑父前缀，不要求目标系统已有父 Branch。

fork 必须位于 transaction.lastSeq，重建完整 Projection/Snapshot Bundle，并创建全新 Session/Memory namespace。普通 fork 不等待父 Session Outbox 排空，因为 WorldLog 是权威；只有实验性 exact Session fork 要求 Session/Outbox 稳定，V0 默认不使用 exact fork。

## 14. 行政操作与 Round 并发

行政请求不插入普通世界行动排序，而是建立 Admission Barrier：

~~~mermaid
stateDiagram-v2
    [*] --> Active
    Active --> Draining: admin request
    Draining --> Draining: finish accepted FIFO rounds
    Draining --> Maintenance: maintenance barrier reached
    Draining --> Forking: fork barrier reached
    Draining --> Archiving: archive barrier reached
    Maintenance --> Active: validation passed
    Maintenance --> Quarantined: migration or replay failed
    Forking --> Active: child committed
    Archiving --> Archived: critical delivery settled
    Active --> Quarantined: integrity failure
    Quarantined --> Maintenance: controlled recovery
~~~

行政请求受理后立即关闭新玩家输入 Gate；已经进入 Round Inbox 的消息继续 FIFO 执行，当前模型调用等待终态或原 deadline，不为普通行政请求强制取消。Barrier 到达后释放未开始的参与者资源并冻结 Head。

不同操作条件：

| 操作 | 必需条件 |
|---|---|
| normal fork | 无 active/queued Round；Head 完整；Projection 可重建；不要求 Session Outbox 清空 |
| maintenance | 无 Round；无 inflight Session delivery；涉及 Session Schema 时 Critical Outbox 必须 settled |
| archive | 无 Round；无 inflight；Critical Outbox delivered 或已通过 Session 重建解决 |
| emergency quarantine | 立即关闭 Gate；未提交 Round 中止且无 Tick；保留诊断数据 |

maintenance 失败时不能直接恢复 active；必须回滚到已验证 Schema/Manifest，或保持 quarantined。Writer Lease 在整个 drain/maintenance 中由同一 fencing owner 持有；完成后递增 epoch 再重新开放 Gate。

## 15. Director、Model Router 与预算

Director 在玩家候选 S1 生成后与 NPC 并行提案。Scheduler 是确定性纯逻辑，Provider 为 Noop、RuleBased、Scripted 或 LLM。DirectorAuthorization 显式列出 actor、scene 和 action type；Kernel 在 Provider 返回后再次验证。Director 不能直接写世界、推进 Tick、替玩家行动或修改其他角色私有 Goal/Claim。

历史重放、Snapshot 恢复和 Branch 重建不调用 DirectorProvider；只应用已提交 Action/Resolution/Event。

Model Profile 版本化定义 Provider 候选、隐私等级、上下文/输出上限和允许的 fallback。Fallback 只能使用预先批准且隐私等级不降低的候选。

预算调用先按 participant type、actorOrdinal、purpose、modelCallId 稳定预留，再并行执行。金额使用整数 micros。character-action 预算不足使 NPC unavailable；Director 降级 Rule/Noop；Observation Render 使用基础模板；Memory/Summary 延迟。

Provider 请求进入未知计费窗口且不支持 idempotency key 时，Reservation 标记 unknown 并保守占用上限，不盲目重试。模型原始 Prompt/Response 默认不落日志，只保存 Hash、Profile、Token、费用和终态。

## 16. 安全、权限与最小内容策略

V0 本机身份类型为 local-user、character-agent、director、system-worker。模型不是 Principal，只继承调用方最小 Capability。

World Owner、PlayerBinding 和 ActionAuthorization 在 Round Inbox 之前验证；未授权请求不写 Inbox、不推进 Tick。Character Agent Handle 固化 WorldAddress 和 characterId，不能指定其他 actor、读取其他 CharacterView 或访问 WorldStore。Outbox Worker 只能消费已提交任务和写 Receipt。

JSON-RPC 默认使用 stdio、Windows Named Pipe、Unix Domain Socket 或 127.0.0.1；禁止 0.0.0.0。开放远程网络前必须另建 Authentication ADR。

WorldSpec 是不可信数据：严格限制大小、深度、字符串、实体数量和引用图；不能安装 Plugin、执行脚本或读取任意路径。Cordis Plugin 是可信部署代码，不是沙箱；只能从宿主 allowlist 加载。

Secret 只由宿主 SecretProvider 解析。WorldSpec/Manifest/Event/Session/Memory/Error/Export/日志只能保存 ProfileRef/SecretRef，不能保存真实值。

内容策略不建设语义审核平台。强制执行 Schema、合法 Unicode、长度/深度、Tool allowlist、权限和输出转义；可选 ContentPolicy 默认 allow。character.speak、Memory 和模型文本始终作为数据，不能被执行为代码或提升为系统指令。

## 17. WorldStore、Snapshot 与数据保留

WorldStore 使用独立 SQLite 数据库，初始 PRAGMA 为 foreign_keys ON、WAL、synchronous FULL、busy_timeout 5000。规则、LLM、Memory 和 Presentation 调用全部在 World Transaction 外。

Snapshot 在尾部达到 10,000 Event、64 MiB，或 fork/maintenance/archive 前触发。异步 Worker 固定已提交 asOfSeq，写 building Header/Units，校验 Unit/Bundle Hash 和全部 Invariant 后原子标记 ready。恢复只使用最新兼容 ready Snapshot。

保留最近三个兼容 Snapshot，并永久保留 Manifest Epoch、fork、archive 和 backup 锚点。V0 不删除 WorldEvent、Transaction、Resolution、Manifest、Round Idempotency、Outbox、Receipt 或 Session Delivery Ledger。可清理 View Cache、失效 Presentation、无引用旧 Snapshot、building/invalid Snapshot 和临时模型流片段。

WAL checkpoint、quick_check、incremental vacuum 和派生数据清理由独立运维 Worker 完成，不进入活动 World Transaction。

## 18. Backup、Export、Import 与 Restore

### 18.1 Backup

Backup 是同一部署的灾难恢复副本，不用于跨实例合并。V0 Backup 建立行政 Barrier，停止新入站并排空已受理 Round；冻结 World Head，等待 inflight SQLite 写结束和 Critical Session delivery settled，然后分别使用 SQLite 一致备份机制复制：

~~~text
worlds.sqlite
sessions.sqlite
memory.sqlite
audit.sqlite
deployment-config-sanitized.json
backup-manifest.json
checksums.sha256
~~~

多个数据库不是同一个原子快照，<code>backup-manifest.json</code> 必须记录每个 Branch Head、每个 Session cursor、Outbox 状态和每个文件 Hash；Restore 用这些水位验证跨库关系。Secret 和外部 Provider Token 永不进入 Backup。

Backup 状态为 building、ready、invalid；只有全部文件 Hash、SQLite quick_check 和 Head/cursor 关系通过后标记 ready。Migration、Manifest 升级和 Restore 前必须先创建 ready Backup。

### 18.2 Export

Export 是可移植 <code>.dshworld</code> 逻辑包，默认 authority-only：

~~~text
export-manifest.json
authority/events.ndjson
authority/transactions.ndjson
authority/resolutions.ndjson
manifests/<hash>.json
schemas/<registry-hash>.json
lineage/branches.json
snapshots/              optional
sessions/               optional
memory/                 optional
checksums.sha256
~~~

导出子 Branch 时展开完整逻辑父前缀，目标不需要已有父世界。Session/Memory 默认不导出；启用时仍按角色权限和来源校验。Presentation、Telemetry、Secret 和普通日志不导出。

V0 Import 保留 worldId/eventId/branchId；目标存在同 worldId 时拒绝，不做 ID 重写，因为重写会破坏 Event/Source/Hash。导入后将本地 WorldOwnership 重新绑定到当前 local-user，并写审计记录；ProfileRef 不存在时 Branch 保持 maintenance，不能静默替换 Provider。

### 18.3 Restore

Restore 只允许进程离线或全局 maintenance：验证 Archive/Backup Hash、SQLite quick_check、数据库 Schema、Manifest 可用性、Event Chain、Snapshot Bundle 和 Session cursor；成功后递增 Writer fencing epoch，重新处理 pending Outbox，再开放 Runtime Registry。Restore 不和现有数据合并。

## 19. CLI、Headless 与 JSON-RPC

JSON-RPC 2.0 是稳定边界。方法分组：

| 组 | 方法 |
|---|---|
| read | world.list/get、branch.get、character.view、round.get、health.get |
| play | round.submit、round.cancel-queued |
| authoring | world.compile、world.activate |
| admin | maintenance.enter/exit、branch.fork/archive、snapshot.create/list |
| recovery | outbox.list/retry、quarantine.explain/recover、backup/restore |
| portability | world.export/import |

<code>round.submit</code> 总是快速返回：

~~~typescript
interface RoundAcceptedResult {
  roundId: InteractionRoundId
  idempotencyKey: string
  inboxSeq: number
  status: 'queued' | 'processing' | 'committed'
}
~~~

CLI 的 <code>--wait</code> 只轮询/订阅 round.get，不改变服务器语义。客户端断线后通过 idempotencyKey 或 roundId 恢复结果。

通知包括 round.committed、presentation.ready、health.changed、outbox.dead-lettered 和 branch.quarantined。通知可能丢失，客户端必须能用查询恢复；通知不是事实源。

只允许取消尚为 queued 的 Round。preparing 之后不接受用户取消；行政 emergency quarantine 可以中止未提交 Round。取消 queued Round 不推进 Tick并保留 Inbox 审计。

JSON-RPC Error 使用 ErrorEnvelope 的 code/data，协议层 code 只区分 parse、invalid request、method not found、invalid params 和 internal；领域 code 放在 data.errorCode，避免客户端依赖不稳定负数。

## 20. 平台、数据目录与配置

源码实际基线为 ESM、pnpm 11.7.0，Node engine <code>^22.19.0 || >=24.0.0</code>。V0 发布矩阵：

- Node 22.19.x 为首选稳定运行时；
- Node 24+ 为兼容 CI；
- pnpm 11.7.0；
- Windows 11 x64 为主要开发/验收平台；
- Linux x64 为阻断 CI 平台；
- macOS 为尽力兼容，不是 V0 发布门槛。

SQLite 使用 Node 内置 <code>node:sqlite</code> DatabaseSync，与现有 Harness SQLite 包一致；不引入 better-sqlite3/libsql。WorldStore 使用短事务和单 Writer Queue；若基准显示同步调用阻塞超标，再在不改变 Store API 的前提下移入 Worker Thread。

数据库只允许本地磁盘，不支持 SMB/NFS/同步盘目录。建议数据布局：

~~~text
data/
  worlds.sqlite
  sessions.sqlite
  memory.sqlite
  audit.sqlite
  instance.lock
backups/
exports/
logs/
config/
  cordis.yml
  world-host.yml
~~~

配置优先级为 CLI 参数、环境变量、world-host.yml、默认值。Secret 环境变量或 OS Secret Provider 高于配置引用，但不得被序列化。WorldSpec 使用 JSON-compatible 数据，不使用 YAML 隐式类型作为权威输入。

实例锁包含 pid、instanceId、startedAt 和随机 fencing nonce；发现旧锁时先验证进程存活和 SQLite Writer Lease，不能只按文件存在拒绝，也不能自动删除未验证锁。

所有审计时间存 ISO 8601 UTC 毫秒，延迟使用 MonotonicClock，世界时间只用 Tick。

## 21. 可观测性与健康

结构化日志传播 correlationId、WorldAddress、roundId、transactionId、actionId、deliveryId、modelCallId；默认只记录内容 Hash 和大小，不记录 Secret、完整 Prompt/Response、Memory 或对白原文。

核心指标覆盖 Round queue/phase duration、Tick commit、SQLite busy/commit、Projection replay/hash/invariant、Snapshot tail/build、Outbox depth/oldest/dead letter、Session lag/divergence、Model Token/费用/失败和 Memory as-of 拒绝。worldId、branchId、sessionId 等高基数字段进入日志/Trace/Health API，不作为全局时序 Label。

Health 分 process、branch、capability。Branch 为 healthy、degraded、quarantined，并分别报告 readyForRead、readyForWrite、readyForAgentCalls。Bundle Hash mismatch、WorldLog 损坏、Projection Invariant 和 Session divergence 立即 quarantine；Memory、LLM Renderer、普通 Provider 失败通常 degraded。

World 激活、PlayerBinding、fork/archive、maintenance、Manifest、Migration、Backup/Restore、quarantine 和 dead-letter 人工操作写 append-only <code>world_audit_log</code>。普通 Telemetry 导出失败不影响 Round；关键审计先落本地。

~~~typescript
interface WorldAuditRecord {
  auditId: string
  occurredAt: string
  principalId: PrincipalId
  operation: string
  targetRefs: string[]
  correlationId: string
  beforeHash?: string
  afterHash?: string
  result: 'succeeded' | 'failed'
  errorCode?: string
}
~~~

Audit 记录不保存 Secret 或任意正文；普通缓存清理不得删除。

## 22. ErrorEnvelope 与错误目录

~~~typescript
interface ErrorEnvelope {
  schemaVersion: 1
  errorId: string
  errorCode: string
  category: 'admission' | 'domain' | 'runtime' | 'persistence' | 'integrity' | 'provider' | 'admin'
  message: string
  retryable: boolean
  correlationId: string
  address?: WorldAddress
  roundId?: InteractionRoundId
  details?: WorldJsonValue
  causedByErrorId?: string
}
~~~

V0 核心 code：

| Category | Codes |
|---|---|
| admission | INVALID_REQUEST、UNAUTHORIZED、IDEMPOTENCY_KEY_CONFLICT、ROUND_QUEUE_FULL、BRANCH_DRAINING |
| domain | ACTION_REJECTED、CHARACTER_CANNOT_ACT、ACTION_NOT_AFFORDED、ITEM_NOT_AVAILABLE、TARGET_OUT_OF_RANGE |
| runtime | RUNTIME_NOT_READY、WRITER_LEASE_LOST、PARTICIPANT_TIMEOUT、CONTEXT_WINDOW_EXCEEDED |
| persistence | WORLDSTORE_BUSY、WORLD_COMMIT_FAILED、SESSION_DELIVERY_OUT_OF_ORDER、DELIVERY_RETRY_EXHAUSTED |
| integrity | EVENT_VERSION_UNSUPPORTED、MANIFEST_RUNTIME_UNAVAILABLE、BUNDLE_HASH_MISMATCH、PROJECTION_INVARIANT_FAILED、SESSION_DELIVERY_DIVERGED |
| provider | MODEL_BUDGET_EXHAUSTED、MODEL_PROVIDER_FAILED、MODEL_SCHEMA_INVALID、MEMORY_SOURCE_UNVERIFIED |
| admin | BRANCH_DEPTH_LIMIT、BACKUP_INVALID、IMPORT_ID_CONFLICT、RESTORE_VALIDATION_FAILED |

领域 rejected Resolution 不是系统 Error；只有传输、运行、完整性或行政失败返回 ErrorEnvelope。完整性错误一律 retryable false，除非经过受控恢复流程。

## 23. 存储所有权与核心表

WorldStore 拥有：worlds、world_drafts、world_branches、world_manifests、manifest_epochs、round_inbox、round_participants、round_proposals、transactions、action_requests、resolutions、events、heads、outbox、delivery_receipts、snapshots、snapshot_units、writer_leases、failures。

SessionStore 拥有 Session Event Log、session_delivery_inbox、session_delivery_cursor 和 compaction_summary。MemoryStore 拥有 records、source_mapping、capture_jobs、reconcile_jobs。AuditStore 拥有 audit_log、model_call_audit、budget_reservations 和 operational migrations。

跨 Store 只通过稳定 ID、Hash、水位和 Outbox 连接；不建立跨数据库外键，也不假装共享事务。

## 24. 测试与实现门槛

### 24.1 P0 原型门槛

进入完整领域开发前必须完成六个最小原型：

1. Cordis 两个 Branch child Context 的 Service/Listener/Dispose 隔离；
2. SQLite Session Adapter 的 appendIfAbsent 原子事务和硬崩溃恢复；
3. Canonical World JSON 在 Windows/Linux、Node 22/24 的 Golden Hash；
4. WorldStore Event/Tick/Outbox 单事务在 COMMIT 前后硬终止的恢复；
5. forkSeq 的 Observation/Claim/Goal/Visibility 重建与未来 canary；
6. Noop/Rule/Scripted Director 和 Scripted Agent 的完全无模型闭环。

任一失败时停止扩展功能，先修改相应 ADR/Contract；不得用内存去重、跳过 Invariant、降低 synchronous、放宽 as-of 或允许跨 Branch Listener 泄漏来通过演示。

### 24.2 测试层级

~~~text
Canonical/Schema/Upcaster
→ Rule/Reducer/KnowledgeRule
→ Kernel/Candidate/Conflict
→ SQLite/Session Adapter/Recovery
→ Runtime Registry/Round Queue
→ Scripted Agent/Director/Memory
→ CLI/JSON-RPC/Backup/Import
→ Reference/Stress/Fault Matrix
~~~

WorldTestRuntime 替换 Clock、ID、Entropy、Model、Director、Memory、Fault 和临时 SQLite，但使用与生产相同的 Domain Plugin、Kernel、Projection 和 Store Schema。

### 24.3 必测不变量

- 一条受理玩家输入只推进一个 Tick，重复 key 不推进第二次；
- 玩家原文不被模型改写，未授权 actor 不建立 Round；
- 消息并发到达仍按 inboxSeq FIFO；
- deadline 后迟到 Proposal 不改变 Bundle Hash；
- Participant 返回顺序变化不改变排序和结果；
- 同一资源冲突只接受排序在前的合法 Action；
- 多 Event Action 不产生部分提交；
- Provisional Observation 与最终 contentHash 相同；
- Actor Self Observation 不泄露隐藏失败原因；
- Session commit 后 receipt 前崩溃不重复 Observation；
- 同 Session 不乱序，不同 Session 可并行；
- Critical dead letter 阻止该 Agent 而不回滚世界；
- Memory 缺 Mapping、Hash 不符、任一来源晚于 asOf 时不返回；
- Session Summary 不进入 Claim/Memory Capture；
- v1 Event Upcast 后可重放，原始 Event Hash 不变；
- Snapshot Unit 缺失时不拼接 Bundle；
- Live、Full Replay、Snapshot Replay、Restart Hash 相同；
- 子 Branch 无父未来 Event、Observation、Claim、Memory canary；
- 同 Branch 并发 acquire 只有一个 ready Slot，旧 fencing token 被拒；
- maintenance Barrier 不丢失已受理 Round；
- Backup/Export Hash 损坏时 Restore/Import fail-closed；
- Node 22/24 和 Windows/Linux Golden Fixture 一致；
- 无模型、无网络、Local Memory 模式完成完整场景。

### 24.4 故障点

稳定 FaultInjector 至少支持：

~~~text
round.after-inbox-insert
round.after-participant-freeze
store.after-event-insert
store.before-commit
store.after-commit
runtime.before-state-adopt
session-delivery.after-inbox-insert
session-delivery.after-observation-append
session-delivery.after-commit
outbox.before-receipt
outbox.after-receipt
snapshot.after-unit-write
snapshot.before-ready
branch.after-metadata
maintenance.after-barrier
backup.after-database-copy
import.after-authority-validate
memory.after-provider-call
model.after-provider-send
~~~

高风险点同时使用进程内 SimulatedCrash 和子进程硬终止。测试不得只抛普通异常模拟断电窗口。

## 25. 推荐实现顺序

### 25.1 Phase 0：契约和原型

- 创建 ADR-0023～ADR-0037；
- WorldJson、ID、Error、Event/Action/Projection Registry Schema；
- 六个 P0 原型；
- Golden Fixture 和 Crash Harness。

验收：所有 P0 原型通过，Session Adapter 不再 blocked。

### 25.2 Phase 1：权威最小闭环

- WorldStore、Migration、Writer Lease；
- Runtime Registry、Branch Slot、Round Inbox；
- WorldSpec Compiler、Genesis；
- PlayerBinding、玩家 speak/action；
- Rulebook、Candidate、Tick、Bundle Hash。

验收：无 Agent 的一条玩家消息可提交、重放、重启并得到同一 Hash。

### 25.3 Phase 2：Observation 和 Session

- Scene/Visibility/Self Observation；
- Knowledge/Goal 时态 Projection；
- Session appendIfAbsent、FIFO Outbox、dead letter；
- Deterministic Presentation；
- CharacterView。

验收：多角色 canary 无泄漏，Session Crash Matrix 全部通过。

### 25.4 Phase 3：Agent 和 Director

- ContextAssembler、submit_actions；
- Scripted/Rule Agent；
- Harness LLM Bridge、Model Profile/Budget；
- Director Scheduler 和四种 Provider；
- LLM Replay。

验收：模型失败/超时/预算耗尽不阻塞玩家 Round，无模型场景仍完整运行。

### 25.5 Phase 4：Memory 和长期上下文

- Local Memory FTS5、Mapping、as-of；
- KnowledgeRule 和 character.reflect；
- Session Compaction；
- TencentDB Provider 仅在固定 commit/许可证和契约测试完成后启用。

验收：未来信息、跨 Branch、跨角色、Summary 二次捕获 canary 全部被拒绝。

### 25.6 Phase 5：Branch 和运维

- fork/archive/maintenance Barrier；
- Snapshot/Retention；
- Backup/Export/Import/Restore；
- CLI/JSON-RPC/Notifications；
- Health、Audit、Metrics、Trace；
- Reference/Stress 基准。

验收：fork、硬崩溃、迁移、恢复和导入导出端到端通过。

## 26. ADR 收敛计划

ADR-0000～ADR-0022 沿用 V0 技术设计的规划。新增：

| ID | 主题 |
|---|---|
| ADR-0023 | 玩家绑定、玩家先行和 Round FIFO |
| ADR-0024 | Agent ContextAssembler 与 submit_actions |
| ADR-0025 | Canonical World JSON 和 Hash Envelope |
| ADR-0026 | WorldSpec、Compiled Manifest 与 Genesis |
| ADR-0027 | Session FIFO、原子幂等和 Critical Dead Letter |
| ADR-0028 | Event Upcast、Projection/Snapshot Version |
| ADR-0029 | Snapshot、Retention 与 Session Compaction |
| ADR-0030 | 本地 Principal、WorldAddress 与最小权限 |
| ADR-0031 | Telemetry、Health 和耐久 Audit |
| ADR-0032 | Model Profile、Budget Reservation 与降级 |
| ADR-0033 | Character Lifecycle 与 Runtime Availability |
| ADR-0034 | Event/Action/Contract Registry |
| ADR-0035 | KnowledgeRule、Memory Capture/Recall/Forget |
| ADR-0036 | 行政 Barrier、Branch 生命周期与深度限制 |
| ADR-0037 | Backup、Export/Import、JSON-RPC 与平台基线 |

ADR Accepted 后不得直接修改同一决定；改变方向创建新 ADR supersede。Schema/DDL 放 Spec，测试引用 ADR ID 和 Contract Version。

## 27. Evidence → Finding → Path

### 27.1 Evidence

| ID | 不可变观察 | 来源 |
|---|---|---|
| E-001 | Cordis Context 支持 extend/isolate，服务查找按隔离 Symbol 解析 | <code>vendor/cordis/src/context.ts:90-124</code>、<code>reflect.ts:237-304</code> |
| E-002 | Cordis Listener 只有在派发 thisArg 提供 filter 时按作用域过滤，global 可绕过 | <code>vendor/cordis/src/events.ts:111-174</code> |
| E-003 | Cordis Service/Listener/effect 跟随所属 Fiber 生命周期清理 | <code>vendor/cordis/src/service.ts</code>、<code>events.ts</code>、<code>fiber.ts</code> |
| E-004 | Session Persistence appendBatch 只保证连续 seq 和耐久批量追加，没有外部 deliveryId 原子幂等参数 | <code>packages/session/session-persistence/src/coordinator.ts:178-184,662-709</code> |
| E-005 | Harness Session SQLite Backend 使用 Node 内置 node:sqlite DatabaseSync | <code>packages/session/session-persistence-sqlite/src/schema.ts</code>、<code>store.ts</code> |
| E-006 | 源码根 package 固定 pnpm 11.7.0，Node engine 为 22.19 或 24+，项目使用 ESM | <code>deepseek-harness-dsh-v0.1.1-rc.1/package.json</code> |
| E-007 | Harness 已有 Provider/Adapter、LLM Replay、CLI/Headless/JSON-RPC 和 SQLite 能力 | 源码调研报告、<code>packages/*</code>、<code>apps/*</code> |
| E-008 | 外部复核集中指出玩家路径、Round 活性、Observation、Hash、WorldSpec、投递顺序和演进缺口 | <code>2026-08-21_其他模型意见汇总.md</code>（仓库外） |
| E-009 | V0 技术设计已确立 WorldLog 权威、单 Writer、TURN_DRIVEN、时态 Projection 和 Memory 非权威边界 | <code>2026-08-21_技术设计-Harness-Cordis-World-V0-report.md</code>（仓库外） |

### 27.2 Findings

| ID | 结论 | Evidence |
|---|---|---|
| F-001 | Cordis 可承载 Branch 子作用域，但必须使用显式 WorldAddress、Registry 和正确的 Listener dispatch carrier | E-001、E-002、E-003 |
| F-002 | 现有 Session API 不能直接满足业务恰好一次，必须增加 SQLite 原子 appendIfAbsent Adapter | E-004、E-005 |
| F-003 | WorldStore 采用 Node 内置 SQLite 能与 Harness 平台基线一致，避免增加原生第三方驱动 | E-005、E-006 |
| F-004 | 现有 Harness Shell、Provider 和测试设施可复用，但世界权威闭环、Agent 协议和运维契约必须独立实现 | E-007、E-009 |
| F-005 | 外部复核不要求推翻核心架构，主要要求补齐交互闭环、确定性编码、配置、演进与运营边界 | E-008、E-009 |
| F-006 | 本文的 D-001～D-030 使剩余设计从开放问题收敛为可验证实现契约 | E-001～E-009、F-001～F-005 |

### 27.3 Paths

Path P-001：玩家消息成为同轮 NPC 可响应的世界事实。

~~~text
PlayerBinding 授权
→ Round Inbox 幂等受理
→ 玩家 Action 得到候选 S1
→ 确定性 Provisional Observation
→ Agent Context + submit_actions
→ deadline 冻结集合
→ 稳定串行裁决
→ Event/Observation/Tick/Outbox 原子提交
→ Session FIFO 幂等投递
~~~

关联 Evidence：E-001～E-004、E-007、E-009。  
关联 Finding：F-001、F-002、F-004、F-006。

Path P-002：Session commit 后 receipt 前崩溃收敛。

~~~text
SessionStore 原子提交 inbox + Observation + cursor
→ Worker 在 WorldStore receipt 前崩溃
→ Outbox lease 到期
→ 重投相同 deliveryId/sessionDeliverySeq/payloadHash
→ Session 返回 already_applied
→ WorldStore 补写 receipt 和 delivered
~~~

关联 Evidence：E-004、E-005。  
关联 Finding：F-002、F-003。

Path P-003：从持久化历史恢复或创建子 Branch。

~~~text
验证 Event Chain 和 Manifest Epoch
→ 选择兼容 ready Snapshot
→ 重放尾部并 Upcast 旧 Event
→ 重建 Observation/Claim/Goal/Visibility Projection
→ 校验 Bundle Hash 和未来 canary
→ 恢复 Head 或固化子 Branch 初始 Bundle
→ 创建新 Session/Memory namespace
~~~

关联 Evidence：E-007、E-009。  
关联 Finding：F-004、F-005、F-006。

## 28. 术语表

| 术语 | 定义 |
|---|---|
| WorldAddress | tenantId、worldId、branchId 的完整路由地址 |
| BranchRuntimeSlot | 一个活动 Branch 的 Kernel、Store、Queue 和 child Context 容器 |
| Writer Lease | 跨进程写权限租约；fencing token 阻止旧 Writer |
| InteractionRound | 一条受理玩家世界输入触发的完整裁决与提交单元 |
| Tick | TURN_DRIVEN 世界时间；每个有效 Round 推进一次 |
| Candidate State | 尚未提交、由纯 Reducer 计算的本轮候选 Projection |
| Manifest | 锁定插件、Schema、Rule、Hash 和语义 Policy 的执行清单 |
| Manifest Epoch | Branch 中某个 Manifest 生效的连续 seq 区间 |
| WorldEvent | 已提交、不可变、可重放的世界或认知事实 |
| Projection | 从 Event 纯 Fold 得到的派生状态 |
| Observation | 某角色实际被允许感知到的结构化认知事件 |
| KnowledgeClaim | 某角色当前相信的命题，可能错误 |
| CharacterView | 指定 asOfSeq 下授权 Projection 与 Recall 的组合输入 |
| ReactionView | 玩家候选行动后、正式提交前供 NPC 同轮反应的临时授权视图 |
| ActionAffordance | CharacterView 中可尝试 Action 的提示，不是授权凭证 |
| Outbox | 与 World Transaction 原子入队的提交后副作用账本 |
| Receipt | 发送端已观察到消费成功的记录，不替代消费端幂等 |
| SessionDeliverySeq | 单个 Session 的连续关键投递序号 |
| Snapshot Bundle | 同一 asOfSeq 的完整 Projection Unit 集及其 Bundle Hash |
| asOfWorldSeq | View、Memory、Projection 或 Snapshot 所对应的最大世界序号 |
| Principal | 发起操作的本地用户、Agent、Director 或 Worker 身份 |
| Capability | 绑定作用域和权限的最小操作 Handle |
| quarantine | 发现完整性风险后禁止新世界写入的运行状态 |

## 29. 只读复核命令

~~~powershell
# $root 视本机实际布局而定：它同时容纳本仓库、调研源码与仓库外的上游文档
$root = 'D:\DeepSeek Harness'
$src = Join-Path $root 'deepseek-harness-dsh-v0.1.1-rc.1'
# $doc 指向仓库内的权威文件；仓库外那份《实施规格》是它入库前的原件，已不再单独维护
$doc = Join-Path $root 'harness-cordis-world-v0\docs\spec\implementation-v0.2.md'

Get-Content -LiteralPath (Join-Path $src 'package.json') -Raw -Encoding UTF8
Select-String -Path "$src\vendor\cordis\src\context.ts","$src\vendor\cordis\src\reflect.ts","$src\vendor\cordis\src\events.ts" -Pattern 'isolate\(|symbols\.isolate|Context\.filter|global'
Select-String -Path "$src\packages\session\session-persistence\src\*.ts" -Pattern 'appendBatch|deliveryId|appendIfAbsent|idempot'
Select-String -Path "$src\packages\session\session-persistence-sqlite\src\*.ts" -Pattern 'node:sqlite|DatabaseSync'
Select-String -LiteralPath $doc -Pattern '^## |^### |D-0|ADR-0|E-0|F-0|Path P-'
~~~

## 30. 收敛结论

本文关闭了外部复核和后续讨论中的架构开放项。剩余工作均为代码、Schema、DDL、ADR、Fixture、契约测试和基准验证，不再需要通过未定义行为推进实现。

若经验验证失败，处理方式已经确定：P0 原型失败先修订 ADR；外部 Provider 不满足契约时禁用并使用 Local/Noop；旧版本无法安全读取时 fail-closed；完整性失败 quarantine；性能不足先优化派生路径，不削弱 WorldLog、原子提交、Session 幂等、as-of、Hash 或权限不变量。

本文没有修改 <code>deepseek-harness-dsh-v0.1.1-rc.1</code> 源码、V0 技术设计 1.1.0 或其他项目文档。
