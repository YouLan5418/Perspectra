# Harness / Cordis World Phase 8 实施规格：可重建角色心智与多 Scene 上下文

- 状态：Accepted implementation target
- 规格版本：`phase8/v0.1`
- 日期：2026-08-26
- 基线：私有源码 `v0.2.0`
- 目标候选版本：`0.3.0`
- 架构总纲：[通用内容与真实运行架构总纲](general-content-architecture-v0.1.md)
- 前置规格：[Phase 7 最小通用内容闭环](phase-7-implementation-v0.2.md)
- 主要 ADR：[ADR-0064](../adr/ADR-0064-context-v2-cache-provider-boundary.md)～[ADR-0068](../adr/ADR-0068-phase8-context-summary-signal-quality-closure.md)

> 实施警告：本文冻结 Phase 8 的实现边界，但不表示这些能力已经完成。Phase 8 继续使用本地 Scripted/Rule/Noop Provider，不接入真实 API Key、HTTPS Provider 或 Harness 内部接口。任何实现若需要放宽 World Event 权威、Canonical/Hash、as-of、角色权限、SQLite 原子性或重放不变量，必须停止对应单元并新增 superseding ADR。

> 兼容警告：`worldpack-source/v1`、compiled `worldpack/v1`、存量 Manifest v1～v3、Rulebook v1～v4、旧 Context v1、旧 Scene policy v1 及其 Event、Resolution、Authority 和 Golden 字节全部保持原义。Phase 8 新能力只由显式 v2 source、Manifest v4、Context v2 和 Scene Decision v2 启用，不对旧世界做隐式升级。

## 1. 本阶段只回答的问题

Phase 8 只回答：

> 创作者能否仅修改 Pack 内容，让多个角色在多轮互动和 Scene 变化中形成彼此独立的认知、关系与矛盾心理，并让系统在任意历史水位精确重建每个 Agent 实际看到的上下文？

完成时必须同时成立：

1. 角色主观状态是来源化、事件化、可重放的，不是自由 Prompt 中的临时描述；
2. Scene 决定在场、调度和观察边界，同一行动可给不同角色产生不同 Observation；
3. Memory 只从角色自己的已提交来源捕获，下一轮调用前必须追平到要求的 as-of 水位；
4. Character Context、Director Context、Prompt Renderer、预算选择和 Provider 请求均有独立版本与 Hash；
5. 长期连续性通过 Checkpoint 与近期无损 Tail 维持，而不是继承不透明聊天历史；
6. Scripted Prompt Provider 真正消费最终渲染字节，证明未来接真实 Provider 不需要重做上下文边界；
7. 一个不含调查玩法的“雨夜同行”Pack 完成多轮、Scene、Memory、fork、缓存和降级验收。

## 2. 范围与明确推迟

### 2.1 必须实现

| 单元 | Phase 8 交付 |
|---|---|
| Pack | `worldpack-source/v2`、compiled `worldpack/v2`、Manifest v4、严格可选认知与文档来源 |
| Cognition | Basic v1 Claim、Goal、Relationship、Affect、InnerTension、Commitment、Open Loop 词汇与时态 Projection |
| Reflection | `submit_actions/v2` 的可选 Reflection Batch、`character.reflect@1`、来源/幅度/容量验证 |
| Policy | Genesis、注册结果策略、对话连续性和 Tick 维护策略；无自然语言情感打分 |
| Scene | `scene-decision/v2`、created→active→closed、多 active Scene、单角色至多一个 active Scene、动作时刻可见性 |
| Memory | `cognitive-memory/v2` 的耐久 Job、独立水位、四类捕获、确定性 L1、Recall Receipt 和 as-of 防火墙 |
| Context | CharacterControllerContext v2、DirectorPlanningContext v1、Checkpoint、Interaction Tail、ContextReceipt |
| Cache | `character-controller-cache/v1` 固定前缀布局、Segment Hash、最长公共前缀 Golden |
| Budget | compact/standard/deep 逻辑 Profile、Host Model Profile、确定性裁剪和精确/保守 Token Counter |
| Provider | Scripted Prompt Provider 经 ProviderCallIntent/append-once Result/Authority 正式路径运行；真实网络保持禁用 |
| Explain | Admin/Author 的 context explain/rebuild/verify 与受众安全过滤；不生成模型推理解释 |
| Reference | “雨夜同行”非悬疑 Pack、Scripted Provider Fixture、跨角色/Branch/future canary 和降级矩阵 |

### 2.2 明确推迟

| 能力 | 计划阶段 | Phase 8 行为 |
|---|---:|---|
| ScenarioObjective、PlayerObjective 运行策略 | 9 或独立规格 | 类型分类保留，不建表、不建空 RPC；Phase 8 只实现 CharacterGoal |
| CharacterTemplate、Runtime Author、第三方题材插件 | 9 | v2 Pack 仍只引用 Host 内建精确 Registry |
| agent-controlled Player、Observer、Control Epoch | 10 | Player 继续 manual；不提前创建 Observer 接口 |
| 真实 API Key、HTTPS Provider、Harness Bridge | 11 | Scripted/Rule/Noop；网络和 CredentialResolver 生产实现保持禁用 |
| 自定义心理词汇、任意心理公式和规则 DSL | 9 或独立插件规格 | 只允许本文冻结的 Basic v1 词汇和注册 Profile |
| LLM Summary、L2/L3 Memory 抽象 | 11 以后 | L1 只允许确定性、提取式、单层 Summary |
| Director 代写 NPC 对白、独立 LLM Narrator | 不在 Phase 7～11 | 明确拒绝 |
| GUI、Web、多用户、远程监听、后台 autoplay | 不在本阶段 | stdio only、TURN_DRIVEN |
| REALTIME_DAEMON、FRACTAL 时间 | 后续独立规格 | V0 继续 TURN_DRIVEN |
| TencentDB、远程 Memory | 后续独立规格 | Local SQLite FTS5 only |

“推迟”不创建半成品表、空 RPC、不可运行 Adapter 或未被当前组合根消费的接口。

## 3. 权威链、版本轴与兼容

Phase 8 的解释优先级为：

```text
Accepted ADR-0064～0068
→ 本规格
→ ADR-0054～0059 与通用内容总纲中未被 supersede 的条款
→ Phase 7 规格
→ V0.2 冻结实施规格
```

新增版本轴：

| 轴 | Phase 8 值 |
|---|---|
| 项目候选 | `0.3.0` |
| source schema | `worldpack-source/v2` |
| compiled envelope | `worldpack/v2` |
| compiler contract | `worldpack-compiler/v2` |
| compiler 实现候选 | `0.2.0`，独立于项目和 Pack 版本 |
| stored Manifest | schemaVersion `4` |
| Character Context | `character-controller/v2` |
| Director Context | `director-planning/v1` |
| Context Receipt | `context-receipt/v1` |
| Prompt layout | `character-controller-cache/v1` |
| submit tool | `submit_actions/v2` |
| Scene Decision | `scene-decision/v2` |
| Cognitive Memory | `cognitive-memory/v2` |
| Provider quality policy | `provider-quality/v1` |
| cognition vocabulary | `cognition-basic/v1` |
| relationship vocabulary | `relationship-basic/v1` |
| affect vocabulary | `affect-basic/v1` |
| inner tension vocabulary | `inner-tension-basic/v1` |

每个 vocabulary、Profile、Renderer、Tool Schema 和 Registry 都必须在 Manifest 中记录 id、version 和 registry hash。项目版本不得替代任何契约版本。

v1 Pack 继续编译为原 compiled v1/Manifest v3 行为；不能通过当前 Compiler 自动获得 Context v2。v2 Pack 必须新建世界，不支持把已激活 v1 Pack 原地升级为 v2。

Phase 7 Claim 的 `epistemicStatus` 与 Phase 8 Claim 的 `stance` 保持为两个独立版本词汇，禁止自动 upcast 或语义映射。`mistaken` 只允许作为 Author/Test 将主观 Claim 与权威事实比较后的外部判定，不进入角色 Context，也不自动转换为 believed、suspected、doubted 或 denied。

## 4. Round 与认知数据流

Phase 8 保持“一条非重复玩家输入对应一个 Round 和一个 Tick”，并将上下文、模型提案与认知更新收敛为：

```text
durable Round Inbox
→ freeze baseHeadSeq / player candidate / SceneDecision
→ catch up per-character Memory
→ optional safe Director plan
→ freeze CharacterControllerContext per participant
→ render exact ProviderRequest and persist ContextReceipt/CallIntent
→ collect Agent proposals on the same base state
→ stable sequential external action resolution
→ action-moment Observation generation
→ validated Reflection batch
→ registered cognitive outcome policies
→ Tick maintenance policies
→ Event/Tick/Authority/Outbox/CognitiveJob atomic commit
```

所有 Agent 在逻辑上“同时思考”：它们使用相同 `baseHeadSeq`，看不到同轮其他 NPC 的 Proposal。网络或 Scripted Provider 的完成顺序永远不决定行动顺序。

外部行动裁定完成前不应用本轮新心理状态；新 Claim、Affect、Relationship 或 Tension 从下一轮开始进入 Context。参与者集合在 Round 开始时冻结，Scene 中途加入的角色下一轮才参与，离场角色离场后不再观察后续动作。

## 5. Basic v1 主观状态

### 5.1 共通规则

所有主观状态：

- 只属于一个 `characterId` 和完整 WorldAddress；
- 使用稳定品牌 ID、validFromSeq/validToSeq 和 append-only Event；
- 必须引用该角色获授权的 source refs；
- 默认是角色私有状态，公开表达只能通过 Action→Observation；
- 不能授予 Capability、改变 Affordance 或替代外部世界事实；
- 可以错误、矛盾和并存，不做全局归一化；
- `unrecognized` 内容不得携带角色无权知道的作者秘密或其他角色私有事实。

awareness vocabulary 固定为：

```text
conscious | partially_conscious | unrecognized
```

具体状态可以收窄允许集合，例如 Claim 和 Commitment 不允许 `unrecognized`。主观状态默认只对所属角色私有；创作者声明公开表达时仍必须生成 Action/Utterance 和每观察者 Observation，不能直接扩大 Projection 读取权限。

强度、优先级、置信度等均使用 safe integer permille。不存在记录与数值为零不是同一语义；需要 active 强度的结构使用 `1..1000`。

### 5.2 SubjectiveClaim

stance 固定为：

```text
believed | suspected | doubted | denied
```

不提供 `known`、`true`、`false` 或 `unknown`。未知表示没有 active Claim；“知道自己不知道”必须使用有来源的 Open Question 或注册元命题。

一个 Character 对同一 propositionHash 同时最多一个 active Claim。`denied(P)` 不自动产生 `believed(not P)`。Claim 可以是 registered proposition 或 narrative proposition；只有 registered proposition 可被精确规则作为认知前置条件，外部事实仍由权威 Projection 决定。active Claim 的 confidencePermille 为 `0..1000`，表示当前 stance 的主观强度，不是客观概率。

生命周期事件为 adopted、revised、retracted。Claim 不允许 `unrecognized` awareness，避免把不可见秘密藏入潜意识 Claim。

### 5.3 RelationshipAttitude

关系是有方向的 `subject → target` 主观侧面：

```text
affection | trust | distrust | respect | dependence
obligation | resentment | fear | envy | rivalry
```

同一目标可同时存在多个 facet，例如 `trust:competence` 与 `distrust:honesty`。trust/distrust 不互相抵消，也不自动镜像到对方。结构至少包含 typeRef、facetKey、可选 qualifierText、intensityPermille、confidencePermille、awareness、status、source refs 和 seq 水位。

active RelationshipAttitude 的 intensityPermille 为 `1..1000`、confidencePermille 为 `0..1000`，生命周期为 active/resolved。Phase 8 不提供 friendship/love/hate/enemy 或单一“好感度”总分；这些概念由多个侧面组合表达。关系变化事件为 started、adjusted、awareness_changed、resolved。

### 5.4 AffectEpisode

affect type 固定为：

```text
joy | sadness | anger | fear | anxiety | shame | guilt
relief | hope | disgust | pride | loneliness | surprise | curiosity
```

一个角色可同时拥有多个 Affect，同一类型也可因不同 target/cause 并存。AffectEpisode 包含 intensityPermille、awareness、expressionMode、可选 target、必需 cause、duration profile、status 和 seq。

expressionMode 固定为：

```text
concealed | restrained | leaking | overt
```

它只指导角色控制器如何表现，不会让其他角色直接读取 Affect。其他角色必须通过可见行动或 Observation 得知外在表现。

duration 固定为：

```text
momentary | short_lived | sustained | persistent_until_resolved
```

只按 Tick、Event 和注册 Policy 演化，不依赖真实时钟。事件为 started、adjusted、awareness_changed、expression_changed、resolved。

### 5.5 InnerTension

一个 InnerTension 必须包含 2～4 个 Pole。Pole tendency 固定为：

```text
pursue | avoid | preserve | change | express | conceal
```

每个 Pole 包含 impulseText、strengthPermille、awareness 和 basis refs；整个 Tension 另有 pressurePermille、awareness、status 和 source refs。basis 可以引用 Goal、Claim、Relationship、Affect、Commitment、Observation 或 Portrayal drive/principle。

Kernel 不计算哪个 Pole 获胜。采取符合某个 Pole 的行动不会自动解决 Tension。resolutionKind 固定为：

```text
choice_made | integrated | external_condition_changed
source_state_resolved | superseded
```

事件为 opened、adjusted、pole_added、pole_resolved、awareness_changed、resolved。

### 5.6 CharacterGoal

Goal 是角色主观希望达成的状态，不是 ScenarioObjective。objective 分为：

- registered：可由确定性规则验证；
- narrative：只表达主观追求。

状态固定为：

```text
active | blocked | completed | abandoned | failed
```

`blocked` 表示仍想完成但存在障碍；`abandoned` 是主动放弃；`failed` 是已不可实现。active/blocked 可互转，terminal 状态不重新打开；重新追求使用新 Goal 和可选 `supersedesGoalId`。

Goal 包含 priorityPermille、awareness、可选 parentGoalId/targetRefs/blockerRefs 和必需 source refs。父 Goal 只组织，不自动分解、传播状态或调用规划器。普通 narrative Goal 没有通用完成百分比。

### 5.7 Commitment

Commitment 表示角色认为自己应履行的事，不等同于 Goal。origin 固定为：

```text
promise | agreement | accepted_request | duty | self_commitment
```

状态固定为：

```text
active | fulfilled | breached | released | renounced
```

Commitment 只支持 conscious/partially_conscious awareness。角色说出 promise 首先只产生 Utterance；除非注册行动或合法 Reflection 接受该义务，否则不能自动证明其内心形成 Commitment。

其他角色记住的是“X 作出过承诺”的 Communication Memory，不直接读取 X 的私有 Commitment。

### 5.8 OpenLoop

OpenLoop 是角色认为尚未处理完的事项，kind 固定为：

```text
question | request | offer | decision_pending | follow_up
```

状态固定为：

```text
open | answered | resolved | dismissed | expired
```

`answered` 不等于 `resolved`。每个角色拥有独立 OpenLoop；未听见问题的角色不会得到该记录。OpenLoop 是连续性索引，不是新的事实来源。

## 6. Reflection 与确定性 Cognitive Policy

### 6.1 submit_actions/v2

Character Provider 继续只允许一个稳定工具 `submit_actions`。v2 形状为：

```typescript
interface SubmitActionsV2 {
  schemaVersion: 2;
  decision: "act" | "abstain";
  actions: ExternalActionProposal[];
  reflection?: {
    operations: ReflectionOperation[];
  };
}
```

最多两个外部 Action 和一个 Reflection Batch；默认 Reflection Profile 每轮最多四项 operation。Reflection 经协议验证后规范化为一个 `character.reflect@1` 认知提案，不占两个外部行动名额。

### 6.2 Reflection 权限

Reflection 只能修改 actor 自己的 Claim、Goal、Relationship、Affect、InnerTension、Commitment 和 OpenLoop。每项必须引用本次 ContextReceipt 中的授权 `basisRefs`，并带受影响记录的 expected state hash。

模型不能：

- 修改其他角色心理或 Memory；
- 创建、移动或删除世界实体；
- 改变 Scene、Capability、Rulebook 或 Affordance；
- 引用未进入当前 ContextReceipt 的来源；
- 把 narrative proposition 提升为世界事实；
- 创建新的 `unrecognized` 状态；
- 以本轮尚未裁定的行动结果作为来源。

Reflection Batch 原子接受或拒绝；无效 Reflection 不阻止同一 Proposal 中合法的外部 Action。非法模型输出属于不可信 Proposal 失败，不自动 quarantine；WorldStore/source mapping/hash 本身分歧才属于完整性故障。

Provider 质量按 Manifest 锁定的 `provider-quality/v1` 维护耐久连续失败计数。这里的 eligible Tick 指该角色按 Scene、参与策略和非质量类 Runtime Availability 本应被调度的 Tick。连续三次非法 Reflection Batch 后只暂停该参与者的 Reflection 能力四个 eligible Tick，外部 Action 能力继续运行；窗口结束允许一次 Reflection probe，合法 Batch 清零计数。连续三次整个 Provider 响应非法时，参与者进入 `provider_output_invalid` degraded 状态，按 1、2、4、8 eligible Tick 封顶退避 probe；合法完整响应恢复 ready。该路径写入 terminal status、Audit 和 Metric，但不 quarantine 世界。

### 6.3 幅度和容量

默认 standard Reflection Profile：

- 每轮最多四项 operation；
- 同一类型最多创建两条新 active 记录；
- intensity/priority 单轮最大变化 200 permille；
- awareness 每次最多变化一个层级；
- Narrative 单项文本和整个 Batch 均有固定字节上限；
- active 状态不能超过所选 Context Profile 的容量。

创作者只能选择完整注册 Profile，不在 Pack 中覆写内部阈值。

Reflection Profile 限制本轮允许发生的变化，Context Profile 限制接受后的最终 active 状态。Validator 必须先在不可变事件前缀上计算整个 Batch 的最终候选，再同时检查 operation 数、单轮幅度、awareness、文本和目标 Profile 容量；任何一项失败都拒绝整个 Batch，禁止先部分应用或事后裁剪到容量以内。

### 6.4 Cognitive Policy

Phase 8 的确定性 Policy 只负责：

1. Genesis 初始状态；
2. registered Goal/Commitment 的完成、阻塞、违背或解除；
3. 明确 speech act 的 OpenLoop 建立和 answered 标记；
4. Affect duration、终结状态和来源失效等结构维护；
5. 精确注册事件对应的认知候选。

不内置“帮助→信任增加”“拒绝→愤怒增加”“听见 P→相信 P”等通用心理公式，不对自然语言做情感关键词打分。复杂反应主要来自独立 Context 和合法 Reflection。

固定认知阶段顺序为：外部 Action 全部裁定→动作时刻 Observation→Reflection→注册结果 Policy→Tick 维护。确定性 Policy 的版本、输入来源、候选、接受/拒绝原因和前后 Hash 写入 `CognitivePolicyReceipt`。

## 7. Scene Decision v2

### 7.1 生命周期与成员

SceneInstance 生命周期严格为：

```text
created → active → closed
```

closed 后不重开。事件至少包含 scene.created、scene.activated、scene.member_joined、scene.member_left 和 scene.closed。

World 可同时有多个 active Scene；同一 Character 同时最多属于一个 active Scene。Player Character 在 Round 边界允许属于零或一个 active Scene，属于多个时触发 `SCENE_MEMBERSHIP_INVARIANT` 并 quarantine。零 Scene 时只允许当前 Affordance 中的 self/environment/move 类行动，不调度 NPC 或 Director，也不凭空送达对白。

Scene 与 Location 分离：Location 表示物理位置，Scene 表示当前互动与观察边界。Phase 8 不实现嵌套 Scene、跨 Scene 广播、复杂空间声学或后台 Scene autoplay。

### 7.2 调度与同轮变化

`SceneDecisionService.decide` 在 `baseHeadSeq` 返回零或一个 focal Scene、当时成员、可调度 NPC、Director eligibility、可见性策略和 decision hash。NPC 必须同时满足 Scene membership、领域 lifecycle、Runtime Availability 和当前控制/参与策略。

参与者在 Round 开始时冻结。角色中途离场后不再观察后续动作，但已提交 Proposal 仍按稳定顺序裁定；中途加入者可观察加入后的合法事件，但下一轮才被调度。

### 7.3 动作时刻可见性

每个 Action 裁定时根据当前事件前缀重新计算观察者。基础范围为：

```text
scene_public | direct | private | self
```

Rulebook 先给出最大合法范围，Scene Policy 只能收窄不能扩大。同一 Action 可为 actor、target、旁观者生成不同 Observation；未在场角色没有 Observation。私语旁观者最多得到“发生私语”的非内容观察。

## 8. Utterance、交流观察与主观解释

`speak` 至少支持 text、addresseeIds、scope、replyTo 和 declaredSpeechAct。三层必须分离：

```text
authoritative Utterance
→ per-observer Communication Observation
→ optional SubjectiveClaim / Memory / OpenLoop
```

Bob 说 P、P 为真、Alice 相信 P 是三个不同事实。撤回通过新 Utterance 表达，不改写旧发言。最近上下文以完整 InteractionBlock 保存问题/回答、承诺/回应和未闭合事项；历史对白仍由 Event/Observation/Memory 重建。

## 9. Cognitive Memory v2

### 9.1 捕获类型

Phase 8 只捕获四类：

| Memory kind | 已提交来源 | 语义 |
|---|---|---|
| episodic | Observation | 我经历或观察到某事 |
| communication | Communication Observation | 我听见某人说过什么 |
| belief | SubjectiveClaim | 我曾相信、怀疑或否认什么 |
| intention | CharacterGoal | 我曾想做、完成或放弃什么 |

Relationship、Affect、InnerTension、Commitment 和 OpenLoop 的当前状态来自 Projection，长期连续性进入 Checkpoint；Phase 8 不把它们重复捕获成独立 Memory 类型。

epistemic kind 固定区分 direct_observation、observed_action、reported_speech、subjective_inference、self_intention 和 derived_summary。Communication 记录“X 说 P”，不捕获为 P。

### 9.2 Cognitive Job 与水位

World Commit 在同一 WorldStore 事务中为受影响角色写耐久 cognitive job。Memory Worker 只接收 address、characterId 和 asOfSeq，自行从 WorldStore 重建并验证 CharacterView；禁止调用方传入未经回查的 View 或 Source Mapping。

每个 world/branch/character namespace 独立维护：

```text
verifiedThroughSeq
capturedThroughSeq
memoryEpoch
sourceMapHash
```

没有可捕获内容时也生成空 Receipt 并推进 verified 水位。Agent 调用前必须满足 `verifiedThroughSeq >= requiredAsOfSeq`；catch-up 失败时该参与者以 `memory_catchup_failed` 降级，玩家 Round 继续，但禁止使用旧 Memory 冒充当前结果。

Memory 写入使用 source identity/hash 幂等。写入后、Job complete 前崩溃可安全重试；同 source identity 异 hash fail-closed。普通 I/O 故障降级该能力；跨角色、跨 Branch、future source 或 source hash 分歧属于完整性故障。

### 9.3 Recall 与 Summary

Host 构建冻结 `RecallQueryPlan`，固定 tenant/world/branch/character/asOf 作用域；Agent 没有 `memory.search` 工具，也不能提供 namespace。查询信号只来自当前获授权刺激、Scene、自己状态、attention topics、Affordance 和最近观察。

Recall 必须产生 `RecallReceipt`，记录 plan/query/result hash、watermark、selected source refs、稳定 ranking、排除 reason 和算法版本。权限过滤先于候选建立，面向玩家的 Explain 不显示无权候选数量。

L1 只允许确定性提取式 Summary：同角色、同 Branch、明确 source range、保存全部来源 Hash、不引入新命题、不做 summary-of-summary、不再次捕获、不删除 L0。Agent 没有任意 forget 工具；Retention 只改变派生召回资格，World Source 永久保留。

L1 是 Phase 8 唯一的确定性经历摘要算法。Checkpoint 只能引用已经验证的 L1 Summary identity、source range 和 Hash，不能另行生成第二套经历摘要；目标水位没有可用 L1 时只记录来源范围和 Hash，不临时合成自由文本。

## 10. CharacterControllerContext v2

### 10.1 权威来源白名单

ContextAssembler 只能使用：

- 冻结 Manifest 的公开部分；
- 指定角色在同一 as-of 的 CharacterView；
- SceneDecision；
- 已验证 Memory Recall；
- 当前 Round stimulus；
- 当前 Affordances；
- Host 固定安全契约。

禁止进入：作者真相、其他角色私有状态/Memory、秘密目录、raw Store/Event、Director 私有计划、API credential、future/fork 后来源和未验证 Summary。

### 10.2 固定分段与缓存布局

Provider 请求顺序固定为：

| 顺序 | Segment | 变化频率 |
|---|---|---|
| 1 | Host Protocol | 极低 |
| 2 | Controller Class Contract | 极低 |
| 3 | World Public Anchor | Manifest epoch |
| 4 | Character Anchor | Character 定义 |
| 5 | Continuity Checkpoint | 确定性重建点 |
| 6 | Recent Interaction Tail | 每轮追加 |
| 7 | Current Self State | 动态 |
| 8 | Current Scene | 动态 |
| 9 | Verified Recall | 动态 |
| 10 | Current Stimulus | 动态 |
| 11 | Affordances | 动态 |
| 12 | Output Reminder | 固定短段 |

System/Developer 只包含 Host 和 Controller Contract。World、Pack、Portrayal、Memory、玩家文本和所有自由文本都是不可信 JSON 数据叶子，不能提升为控制指令。Markdown 先规范化为安全结构化文本；不依赖代码围栏或自然语言分隔符建立权限。

`CharacterContextBundle + PromptRenderer + ModelProfile = ProviderRequest`。`contextHash` 表示语义上选中了什么，`providerRequestHash` 表示具体 Provider 的精确消息、Tool、模型和采样布局。两者不能混用。

| 成员 | `contextHash` | `providerRequestHash` |
|---|---:|---:|
| 预算后实际选中的 Segment 语义、稳定顺序、规范化值、版本和 source refs | 是 | 通过 `contextHash` 绑定 |
| 精确消息 role/UTF-8 bytes、Renderer、Tool Schema | 否 | 是 |
| Provider、Model、采样参数、Provider 可见分区值 | 否 | 是 |
| API credential、传输 timeout、trace/request id、cache hit、网络重试和计费回执 | 否 | 否 |

Golden 必须用独立 mutation matrix 钉死边界：语义值、source/order 变化必须改变两者；仅 Renderer、Tool Schema、Model、采样或 Provider 可见分区变化只改变 `providerRequestHash`；credential、timeout、追踪 ID 和缓存结果变化不得改变任一 Hash。

### 10.3 Current Self State

Self State 包含当前 Claims、Goals、RelationshipAttitudes、Affects、InnerTensions、Commitments、OpenLoops 和 Runtime Availability，并分成：

- consciousState：角色可明确意识到的内容；
- latentGuidance：仅供角色控制器塑造行为的结构化潜在倾向。

latentGuidance 只允许包含该角色自己的 unrecognized Goal、RelationshipAttitude、Affect 和 InnerTension 的结构化字段。它不能包含 Claim、Memory/Observation 原文、作者秘密、其他角色状态或从无权来源派生的标签，也不进入 Player/Observer/Director Context、Explain 安全面或其他角色 ProviderRequest。它可以影响该角色的表现，但不能自动公开或成为客观事实。

### 10.4 Continuity Checkpoint 与 Tail

Checkpoint 是来源范围、Hash 和版本化的派生连续性基线，包含持续 Claim/Goal/Relationship/Affect/Tension/Commitment/OpenLoop，并按 identity/hash 引用已验证 L1 Summary。它不运行独立摘要算法，也不是世界事实；没有可用 L1 时只保存来源范围和 Hash。旧 Checkpoint 在新版本原子提交前继续有效。

重建只发生在 Round 边界，并由 Tail Block 数、规范化字节、Profile/版本变化、maintenance 或 fork 条件确定，不因每次心理变化重建。Fork 只继承 `asOfSeq <= forkSeq` 的 Checkpoint，否则在子 Branch 的 forkSeq 重建。

Recent Tail 按完整 InteractionBlock 追加，不截断问题/回答、承诺/回应或开放事项。重启和 fork 从耐久 Event、Observation、Authority 重建，不继承 Provider 私有聊天历史。

### 10.5 ContextReceipt 与 Explain

每个参与者保存耐久 ContextReceipt：address、round/participant/controller、base/asOf/tick、manifest/profile/version hashes、View/Scene/Checkpoint/Tail/Recall/Affordance hashes、included source refs、exclusion reason、contextHash 和 providerRequestHash。

`context.explain/rebuild/verify` 只对 Admin/Author 测试能力开放。报告只能解释来源和规则，例如“因 source 超过 as-of 被拒绝”或“因预算删除该 Recall”，不能声称模型为什么采用某信息，也不能输出 chain-of-thought。Player 安全面不得泄露秘密存在、数量或其他角色来源。

## 11. DirectorPlanningContext v1

Director 每次只绑定一个 focal active Scene，不拥有全世界聊天历史或角色 Memory。它可以看到世界公开信息、该 Scene 中 public/director_visible 内容和粗粒度 Dramatic Signals，例如 scene_stalled、open_loop_high_priority、conflict_pressure_high、participant_unavailable。

Dramatic Signal 只能从 focal Scene 的 public Event/Observation、明确 `director_visible` 来源、运行时 Health/Availability，或显式标记为 director-visible 的结构化认知项派生。权限过滤必须先于候选建立、计数、聚合和阈值判断；`character_private`、latentGuidance、raw Memory 与 author_only 来源不能通过数量、布尔值、缺席提示或压力等级间接进入 Director Context。

Director 不能看到 raw private Claim/Affect/Tension、其他 Scene、author_only 或 integrity_only 内容。每轮最多调用一次稳定工具 `submit_director_plan`，只允许：

- 注册 Environment Proposal；
- 无事实正文的抽象 Directive，例如 take_initiative、address_open_loop、attend_to_visible_entity、consider_active_goal、deescalate、maintain_restraint、pause_and_observe。

Directive target 必须已经存在于接收角色自己的授权 Context；Director 不能直接生成 NPC speak、修改心理状态、写 Memory 或把作者真相塞给角色。Directive 只是低权重建议，NPC 可接受或忽略。Director 失败降级 Noop/Rule，不阻止玩家 Round。

## 12. Context 与 Model Profile 预算

Phase 8 冻结三个逻辑 Context Profile：

| 项目 | compact | standard | deep |
|---|---:|---:|---:|
| 最大规范化请求体 | 32 KiB | 96 KiB | 192 KiB |
| Recent InteractionBlock | 4 | 10 | 20 |
| Recall 结果 | 6 | 16 | 32 |
| Checkpoint 活跃认知项 | 12 | 32 | 64 |
| Scene 可见角色/实体 | 16 | 48 | 96 |
| Active Claim | 8 | 16 | 32 |
| Active Goal | 4 | 8 | 16 |
| Relationship Facet | 8 | 16 | 32 |
| Active Affect | 4 | 8 | 12 |
| Active InnerTension | 2 | 4 | 8 |
| Active Commitment | 4 | 8 | 16 |
| Open Loop | 6 | 12 | 24 |

standard 为默认。Profile 不改变权限；deep 只包含更多已授权内容。当前 active 心理核心不静默裁剪：Genesis 超限时编译失败，Reflection 达到上限时拒绝，新旧 Profile 切换需要 maintenance 验证。

裁剪优先级为：

1. 不可删除：Host/Controller、身份与水位、Stimulus、Affordance、Output Contract；
2. 核心：Character Anchor、当前心理、Scene 核心、Checkpoint 必需部分；
3. 近期：完整 InteractionBlock、Scene 次要细节；
4. 长期：Recall 和低相关历史摘要。

Model Profile 由 Host 控制 provider/model/context window/output reserve/safety reserve/token counter/renderer/tool schema/timeout/sampling/cache/`providerUserPartitionPolicyId`；Pack 只能选择 logical profile。`providerUserPartitionPolicyId` 表示 Provider 侧稳定、伪名化的业务 Principal 分区策略，不得直接使用 NPC/Character ID 充当外部用户身份。渲染后使用精确 Token Counter 或注册保守上界再次验证。必需内容或输出预留超限时参与者降级，不截断 JSON 或请求 Provider 自己报错。

Context Profile 与 Model Profile 不兼容时返回 `MODEL_PROFILE_INCOMPATIBLE`，不静默降档。Phase 8 Scripted Provider 使用固定测试 Counter；真实模型 Counter 留到 Phase 11。

## 13. Provider 调用边界

Phase 8 不发送网络请求，但 Scripted Prompt Provider 必须经过与未来真实 Provider 相同的耐久边界：

```text
ContextReceipt
→ exact ProviderRequest
→ ProviderCallIntent(prepared)
→ dispatch_started
→ append-once validated result or terminal
→ Round Authority
→ World Commit reference
```

`modelCallId` 由 address、round、participant、controllerEpoch、contextHash 和 providerRequestHash 确定。状态至少支持 prepared、dispatch_started、response_received、validated、committed、failed_before_dispatch、provider_rejected、timed_out_ambiguous、invalid_response、budget_exhausted 和 discarded_after_quarantine。

Intent 前崩溃可重建；prepared 后未 dispatch 可安全继续；dispatch_started 后无终态属于外部结果不确定，默认不自动重发，除非 Provider 契约明确支持经验证的幂等键。系统只保证世界效果 at-most-once，不宣称外部 API 计费 exactly-once。

默认持久化有效 Tool Call、Canonical Proposal、response/proposal hash、usage/cache/request id/terminal 元数据；不保存 API key、Authorization、chain-of-thought 或额外自由文本，完整 Prompt/Response 只允许默认关闭的短期加密调试 Profile。

Phase 8 不创建未被 Scripted Provider 使用的 CredentialResolver/HTTPS Adapter 空实现。Phase 11 接真实 API 时在此边界增加 CredentialResolver、Provider Adapter、真实 Token Counter 和错误分类。

## 14. World Pack v2

### 14.1 来源目录

正式入口继续沿用现有 `worldpack.source.json`。v2 目录为：

```text
travel-companions/
├── worldpack.source.json
├── world.json
├── characters.json
├── locations.json
├── entities.json
├── scenes.json
├── player-slots.json
├── cognition.json
├── memory.json
├── documents.json
├── presentation.json
├── text/
└── assertions/
```

v2 根清单在 v1 显式文件列表上新增 cognitionFiles、memoryFiles 和 documentFiles；仍禁止 glob、目录外路径、符号链接、大小写碰撞和隐式发现。

### 14.2 最小值与可选字段

v2 Character 核心仍只要求稳定 key/id、displayName 和 controller class；portrayal、初始 Observation/Claim/Goal/Relationship/Affect/Tension/Commitment/OpenLoop 全部可省略。省略表示没有已声明状态，不生成“平均人格”或隐藏默认情绪。

认知文件按角色组织，各数组可省略。创作者使用稳定 local key；Compiler 生成品牌 ID、Genesis source、seq 和 Hash。真正决定语义的字段必须显式填写：Claim stance/confidence、Relationship type/intensity、Affect type/intensity/cause、Tension 的至少两个 Pole 等。安全默认值完全物化并进入 packHash。

| 类型 | 最小必填 | 安全默认 |
|---|---|---|
| Claim | key、proposition、stance、confidence | salience 500、conscious、active |
| Goal | key、objective | priority 500、conscious、active |
| Relationship | key、target、type、facet、intensity | confidence 500、conscious、active |
| Affect | key、type、intensity、cause | conscious、restrained、short_lived、active |
| InnerTension | key、title、pressure、至少两个完整 Pole | active；不补造 Pole 或 basis |
| Commitment | key、content、origin | salience 500、conscious、active |
| OpenLoop | key、kind、summary | salience 500、open |

初始状态的 `basisKeys` 只能引用同一 Pack 中已声明且对该角色合法的 Observation、Claim、Goal、Relationship、Affect、Commitment 或 Portrayal drive/principle。Compiler 必须检测缺失、跨角色越权和循环，并转换为确定性 Genesis source refs；创作者不手写 Event ID、seq 或 source hash。

Runtime Availability 不由 Pack 任意写入。激活组合根根据已注册 Controller/Provider 能力决定 ready/provisioning/degraded；已配置的 Phase 8 Scripted Provider 必须使对应 NPC ready，不能再次硬编码为永久 provisioning。

### 14.3 文档和受众

documents entry 必须声明 usage 和 audience：

```text
public | director_visible | character_private | author_only
```

自由文本永远不成为系统指令。长背景若需进入 Memory，Compiler 将其生成指定角色的 Genesis Observation，再由正式 cognitive job 捕获；禁止直接写 Memory row。author_only 不进入运行时 Provider Context。

### 14.4 编译结果

v2 source 编译为 compiled `worldpack/v2` 和 Manifest v4，锁定全部 vocabulary、Context、Scene、Memory、Policy、Renderer 和 Profile registry hash。旧 v1 格式不增加字段、不改变 expected bytes。`worldpack test` 必须实际使用临时 SQLite 与正式 Application 路径运行 assertions，不能无条件返回 passed。

## 15. “雨夜同行”参考 Pack

参考 Pack 只用通用 speak/move/take/reflect 与 Scene/Memory，不新增 travel、investigation、evidence、accuse 或结案 Action。

初始角色：

- 玩家只知道 Bob 迟到、Alice 不满和队伍需要继续赶路；
- Alice 错误认为 Bob 不负责任，信任其能力但怀疑其诚实，同时有 Anxiety、Resentment 和“质问/维持合作”的 Tension；
- Bob 私下知道自己因帮助受伤陌生人而迟到，对耽误同行有 Guilt，并在“解释/保护陌生人隐私”之间矛盾。

六轮 Golden 流程覆盖：公开追问、Bob 私下对玩家说明、Bob 离开 focal Scene、玩家与 Alice 重新会合、玩家向 Alice 转述、三人取得车票并移动到下一 Scene。

验收重点：

- Bob 私语只给玩家正文，Alice 只观察到私语发生；
- 玩家记住“Bob 声称 P”，Alice 后续听到的是玩家转述，均不自动得到 P 为真；
- Alice 可提高 trust:competence 而保留 distrust:honesty；
- Bob 离开后不被玩家 focal Scene 调度，重入后下一轮恢复；
- Alice、Bob、玩家对“Bob 为什么迟到”得到不同 Recall 与 source chain；
- fork 前后的私语 future canary 不跨 Branch；
- Alice/Bob 的缓存前缀按 Checkpoint/Tail 规则稳定；
- 插入 Provider timeout 或 Memory catch-up failure 时玩家 Round 继续且无伪造 Proposal/Memory。

Scripted Provider 响应是 Testkit Fixture，不进入 Pack Manifest 或世界规则。任何实现若需要角色名分支、旅行专用 Resolver、硬编码迟到原因或专用关系加减分，视为架构失败。

## 16. 公共接口与错误

Phase 8 新增或冻结：

```typescript
interface SceneDecisionService {
  decide(address: WorldAddress, playerCharacterId: CharacterId, asOfSeq: number): SceneDecision;
}

interface CharacterContextAssembler {
  assemble(request: CharacterContextRequest): CharacterContextBundle;
}

interface DirectorContextAssembler {
  assemble(request: DirectorContextRequest): DirectorPlanningContext;
}

interface ContinuityCheckpointService {
  rebuildAt(address: WorldAddress, characterId: CharacterId, asOfSeq: number): CharacterContinuityCheckpoint;
}

interface CognitiveMemoryWorker {
  catchUp(address: WorldAddress, characterId: CharacterId, requiredAsOfSeq: number): CognitiveMemoryReceipt;
}

interface ContextExplainService {
  explain(request: ContextExplainRequest): ContextExplainReport;
  rebuild(request: ContextRebuildRequest): ContextReceipt;
  verify(receiptId: string): ContextVerificationResult;
}
```

新增错误至少包括：

| Code | 重试 | 含义 |
|---|---:|---|
| `COGNITION_VOCABULARY_UNAVAILABLE` | 否 | Manifest 锁定的词汇未注册或 Hash 不符 |
| `COGNITION_STATE_LIMIT` | 否 | Genesis/Reflection 超过 Profile active 容量 |
| `REFLECTION_SOURCE_FORBIDDEN` | 否 | Reflection 引用了未授权来源或其他角色状态 |
| `CONTEXT_SOURCE_UNVERIFIED` | 否 | Context 来源缺失、跨作用域或晚于 as-of |
| `CONTEXT_REBUILD_DIVERGED` | 否 | 同 Receipt/version 重建得到不同 Hash |
| `MEMORY_CATCHUP_FAILED` | 可 | 参与者 Memory 未追上 required as-of |
| `MODEL_PROFILE_INCOMPATIBLE` | 否 | Host Model Profile 无法承载所选逻辑 Context Profile |
| `TOKEN_COUNTER_UNAVAILABLE` | 可 | 没有可证明安全的 Token Counter |
| `OUTPUT_RESERVE_INSUFFICIENT` | 否 | 最小合法 Tool 输出无法容纳 |
| `PROVIDER_CALL_AMBIGUOUS` | 否 | dispatch 后无终态且无可靠幂等恢复契约 |

领域 Reflection 拒绝进入 Authority terminal，不一定返回系统 ErrorEnvelope；完整性错误继续 fail-closed。

## 17. 存储与原子性

WorldStore 新增事件/Projection、Scene 状态、认知状态、Policy Receipt、Cognitive Job 和 Authority 引用，仍与本轮 Event/Tick/Head/Outbox 在同一个短 `BEGIN IMMEDIATE` 事务提交。事务内不得进行 Memory、Provider、Tokenizer 或其他异步调用。

MemoryStore 拥有 source mapping、L0/L1 record、per-character watermark、capture/reconcile receipt。Context/Replay 派生 Store 拥有 Checkpoint、ContextReceipt、ProviderCallIntent 和 append-once Result。跨库只使用稳定 ID、Hash、水位和耐久 Job，不宣称共享事务。

Checkpoint/Memory/Context 派生库损坏可由 World 前缀重建；发现跨角色、跨 Branch 或 future 泄漏时必须停止 Agent 调用并进入受控 validate/rebuild，不允许继续使用可疑派生数据。

## 18. 实施与最小提交顺序

每个单元相关测试通过后独立本地提交：

1. P8.1 `docs: freeze phase 8 context and cognition contracts`
   - 本规格、ADR-0064～0067、索引和兼容表。
2. P8.2 `feat(contracts): add phase 8 vocabularies and context receipts`
   - Basic v1 vocabulary、品牌 ID、Context/Receipt/Hash/Error contracts。
3. P8.3 `feat(world-pack): compile version 2 cognition and scene sources`
   - source/compiled v2、Manifest v4、严格 Schema、Genesis、旧 v1 Golden。
4. P8.4 `feat(cognition): add temporal subjective state projections`
   - Claim/Goal/Relationship/Affect/Tension/Commitment/OpenLoop Event/Reducer/as-of。
5. P8.5 `feat(scene): add scene decision version 2`
   - lifecycle、membership、调度、动作时刻 Observation、quarantine invariant。
6. P8.6 `feat(memory): integrate cognitive memory version 2`
   - Job/watermark/source mapping/capture/recall/summary/fork。
7. P8.7 `feat(context): add continuity checkpoints and cache layout`
   - Character/Director Context、Checkpoint、Tail、Renderer、ContextReceipt、Explain。
8. P8.8 `feat(cognition): validate reflection and deterministic policies`
   - submit_actions/v2、character.reflect、Policy Receipt、同轮认知阶段。
9. P8.9 `feat(provider): persist scripted prompt call lifecycle`
   - Intent/Result/ambiguous recovery、预算/Token Counter、Authority 绑定。
10. P8.10 `feat(content): add travel companions acceptance pack`
    - 多轮 Scene/Memory/关系/矛盾/fork/cache/degradation E2E。
11. P8.11 `test: harden phase 8 crash and compatibility matrix`
    - hard crash、旧世界、Golden、跨平台和 canary 全矩阵。
12. P8.12 `docs: close phase 8 evidence`
    - 创作者说明、requirement→test、CI 证据、阶段报告和 0.3.0 候选说明。

复杂度按三道门收敛，但不合并上述最小提交：

| 门 | 包含单元 | 独立完成条件 |
|---|---|---|
| 8A：权威结构 | P8.2～P8.5 | 契约、Pack v2、时态认知与 Scene 在 restart/fork/as-of/Hash 下独立成立 |
| 8B：可重建输入 | P8.6～P8.7 | Memory、L1/Checkpoint、Context、双 Hash 与缓存隔离独立成立 |
| 8C：行为闭环 | P8.8～P8.11 | Reflection、Provider 质量/崩溃、旅途 Fixture 与全兼容矩阵成立 |

不得在 8A 未稳定时并行接入 Memory/Context，也不得在 8B 未通过精确重建和泄漏 canary 时接入 Provider 行为。P8.12 只负责已通过三道门后的证据收口。

## 19. 测试与验收门槛

### 19.1 精确 Golden 与隔离

- Character Context、Director Context、Checkpoint、Tail、Recall、Receipt、ProviderRequest 和 Explain 使用精确跨平台 UTF-8 bytes/hash Golden；
- secret、latent、director、future、other-world、other-branch、other-character canary 不得出现在未授权 ProviderRequest bytes；
- latentGuidance 的跨角色/Observer/Director/provider bytes canary，以及 private Signal 的 count/boolean/pressure/absence canary 全部为零泄漏；
- 双 Hash mutation matrix 独立改变语义、source/order、Renderer、Tool Schema、Model/采样、Provider 分区、credential、timeout、trace id 和 cache hit，结果符合 §10.2；
- Context test oracle 不复用生产 Assembler 的选择/Hash 助手构造 expected；
- old v1 Pack、Manifest v1～v3、Context v1、Scene policy v1、悬疑 Rulebook v3/v4 Golden 全等。

### 19.2 Cognition 与 Scene

- 同一角色同一 proposition 只有一个 active Claim；错误 Claim 不成为世界事实；
- 并存 trust/distrust、多个 Affect、2～4 Pole Tension、Goal/Commitment/OpenLoop 生命周期可重建；
- Reflection 越权、超幅、跨角色、future source 和部分 Batch 全部拒绝；
- Reflection 在最终候选上同时满足单轮 Profile 与 Context Profile；连续非法 Batch 和完整非法响应达到阈值后按确定性窗口/退避 probe 并可恢复；
- 分场、合流、离场、零 focal Scene、不可见动作、同轮 Scene 变化和 fork as-of 全覆盖；
- 同一角色多个 active Scene 触发 quarantine；
- 新心理状态不影响同轮已冻结 Proposal，只从下一轮进入 Context。

### 19.3 Memory、缓存与 Provider

- Cognitive Job 在 world commit 后可重试，写入后/complete 前硬崩溃不重复 Memory；
- Alice/Bob/玩家 Recall source/result hash 不同，reported speech 不升级为真值；
- future、跨 Branch、跨角色、source divergence、Summary 二次捕获全部 fail-closed；
- shared Host/World prefix、Character branch、Tail append、Checkpoint 单次失效和 profile 分支的最长公共前缀符合 Golden；
- compact/standard/deep 预算稳定，必需内容超限不调用 Provider；
- provider before-dispatch、after-dispatch、after-response、before-world-commit 硬终止恢复符合调用次数和世界 at-most-once；
- “雨夜同行”六轮 Fixture 锁定输入、角色提案和稳定归并顺序；刻意改变独立 Provider 完成顺序不改变 Resolution/Authority Hash；
- 同键重放 Provider 调用为零，完成顺序变化不改变 Resolution/Authority Hash。

### 19.4 发布

- Phase 0～7、P0～P6、所有旧 hard-crash 和悬疑/酒馆 E2E 保持通过；
- 生产文件逐文件 statements/branches/functions/lines 100%；
- 本机 `corepack pnpm@11.7.0 check` 通过；
- Windows/Ubuntu × Node 22.19/24 clean install 完整 check 全绿；
- requirement→test evidence、兼容表、Creator 文档和 clean worktree 完成后才可请求 `0.3.0` Tag；
- Tag、Release 和推送仍需用户授权。

## 20. 停止条件

出现以下任一情况，停止对应单元，不提交失败实现：

- 需要把自由心理文本提升为 Rulebook 权威输入；
- 需要让 Pack 写脚本、任意 Event、Memory row、Prompt control 或 Provider endpoint；
- Context 无法从耐久来源和冻结版本精确重建；
- 为提高缓存命中需要删除权限/水位/来源验证；
- Scene 可见性必须读取其他角色私有状态才能工作；
- Memory catch-up 只能通过使用旧结果或放宽 as-of 完成；
- Scripted Provider 需要绕过 Renderer/CallIntent/Authority 才能运行；
- 旅途 Fixture 需要新增题材 Action 或角色名分支；
- 旧 Pack/Manifest/Event/Authority/Golden 需要更新 expected 才能通过；
- 任一 SQLite 事务需要夹入 Provider、Memory 或其他 await。

不相关且不依赖该阻塞的单元可继续。

## 21. Evidence → Finding → Path

### 21.1 Evidence

| Evidence | 已确认事实 |
|---|---|
| V0.2 冻结规格、ADR-0023～0053 | WorldLog、提案、事务、as-of、Memory 来源和本机运行边界已实现并受测试保护 |
| Phase 7 规格、ADR-0054～0063 与 `v0.2.0` | 创作者仅改内容即可运行非悬疑酒馆，Pack v1、认知隔离和通用交互成立 |
| 通用内容总纲 | Phase 8 应承接多 Scene、复杂主观状态和旅途参考内容，但不得提前实现 Provider/控制/插件 |
| 本轮上下文讨论与独立审查 | 已逐项确认来源白名单、缓存布局、Checkpoint/L1 唯一摘要、双 Hash、latentGuidance、Director Signal、预算、Reflection、词汇和 Provider 质量边界 |

### 21.2 Findings

1. 角色连续性不能依赖不透明聊天历史；必须由 as-of CharacterView、来源化 Memory、Checkpoint 和近期无损 Tail 重建。
2. “复杂心理”需要多个可并存的主观状态，但 Kernel 只验证结构、来源和边界，不用统一心理公式决定行为。
3. Scene 同时是调度、观察和当前上下文边界；位置本身不足以表达谁正在互动。
4. 缓存是性能优化而非正确性来源；语义 Context 与 Provider Request 必须分 Hash，任何 cache miss 都不改变结果。
5. 在真实 API 前先让 Scripted Provider 经精确 Renderer 和耐久调用边界运行，才能避免 Phase 11 用网络模型掩盖架构缺口。

### 21.3 Path

```text
freeze contracts/vocabularies
→ compile v2 Pack and Genesis
→ rebuild temporal cognition and Scene
→ durable Memory catch-up
→ Character/Director Context + Checkpoint/Tail
→ Reflection/Policy
→ Scripted Provider call lifecycle
→ travel Pack E2E
→ crash/cross-platform/compatibility closure
```

## 22. 收敛结论

Phase 8 不试图证明模型能写出最精彩的故事，而是证明角色心智的输入、变化和记忆都有可验证来源，并在多轮、Scene、重启和 fork 后保持独立。悬疑继续作为知识隔离回归，酒馆继续作为通用内容回归，“雨夜同行”只验证 Scene 与复杂主观状态；三者都不能把题材玩法带回 Kernel。

真实 API Key 仍在 Phase 11。完成 Phase 8 后，接入真实 Provider 应只新增网络、凭证、Token Counter 和错误映射，而不改变 Context、Authority、Memory、Rulebook 或世界提交语义。
