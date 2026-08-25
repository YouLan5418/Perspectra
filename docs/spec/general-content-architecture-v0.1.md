# Harness / Cordis World 通用内容与真实运行架构总纲

- 状态：Accepted architecture target；不是单一 Phase 的交付清单
- 规格版本：`general-content-architecture/v0.1`
- 日期：2026-08-25
- 覆盖阶段：Phase 7～11
- 兼容基线：私有源码 [`v0.1.0`](../../CHANGELOG.md)
- 前置规格：[V0.2 冻结实施规格](implementation-v0.2.md)
- 首个交付规格：[Phase 7 实施规格：最小通用内容闭环](phase-7-implementation-v0.2.md)
- 对应 ADR：[ADR-0054](../adr/ADR-0054-world-pack-source-compiler-versioning.md)～[ADR-0059](../adr/ADR-0059-agent-participation-memory-provider.md)

> 本文冻结 Phase 7～11 的长期架构方向，不表示这些能力需要在一个 Phase 内完成，也不表示任何一项已经实现。`v0.1.0` Tag、既有 v1～v4 Manifest、Event、Authority 和 Golden Hash 均不可移动、重解释或回写。每个 Phase 只按自己的实施规格验收。

## 1. 文档定位与优先级

本总纲把 V0 已验证的世界事实、角色认知、分支、恢复与本机运行边界，逐步扩展成可由创作者定义多题材内容的通用运行时。悬疑 Demo 继续作为高强度回归试金石，但不再定义产品方向；酒馆社交与旅途同行将在不同 Phase 进入参考矩阵。

后续 Phase 内部冲突按以下顺序处理：

1. Accepted ADR；
2. 本规格；
3. V0.2 冻结实施规格中未被新 ADR supersede 的条款；
4. 各 Phase 的实施规格与 2026-08-24 范围形成计划；
5. 阶段报告与讨论记录。

发现实现必须改变 Accepted ADR、Canonical/Hash、世界事实权威、as-of、权限或事务原子性时，必须停止对应单元并新增 superseding ADR。不得修改旧 ADR 来制造表面一致。

## 2. 目标、完成定义与非目标

总体路线必须逐步证明：

1. 创作者不修改 Kernel、Store 或 Application，即可定义角色、地点、Scene、主观认知、目标、情绪、呈现和受控扩展引用；
2. 同一运行时可承载开放式社交、旅途探索和悬疑回归，题材语义不会渗回 Kernel；
3. Character、Controller、Observer 三个概念分离，既支持人工扮演，也支持 Agent 接管玩家角色而人类仅观察该角色；
4. 真实 Harness Provider 即使失败、重启或重放，也只能提交 Proposal，不能直接写世界事实；
5. Local Memory、Scene 决断、连续交互和降级恢复成为正式应用路径，而不是 Demo 内的旁路。

以下不属于本总纲覆盖的 Phase 7～11：

- GUI、Web、远程监听、多用户、认证、计费、素材市场或插件市场；
- 酒馆角色卡格式兼容、World Pack 继承、运行中热更新或跨世界角色迁移；
- 通用规则 DSL、任意脚本、宏、任意事件注入或不受信任插件沙箱；
- 自动剧情规划器、自动任务分解器、独立 LLM Narrator；
- REALTIME_DAEMON、FRACTAL 时间、多玩家或后台无限自动推进；
- TencentDB Memory、远程 Memory、未固定版本和许可证的 Harness 内部接口；
- 新增悬疑谜题、证据种类或结案机制。

## 3. 不得放宽的系统不变量

| 不变量 | 总体架构要求 |
|---|---|
| 世界事实 | 只有已提交 World Event Log 是权威；Pack、Memory、Presentation、模型响应和作者文本都不是事实源 |
| 模型权限 | Agent、Director 和未来 Narrator 只产生 Proposal；全部 Action 仍经过 Validator、Capability、Rulebook 和 Resolution |
| 角色认知 | 不知道等于缺少 Claim；错误认知是第一等 Claim；“X 说 P”只证明说话事件，不证明 P |
| Memory | 只召回已提交、获授权、来源可验证且不晚于 as-of 水位的内容；跨角色、跨 Branch、未来来源 fail-closed |
| 场景可见性 | Observation 按 Scene、位置、生命周期、可见性与主体分别生成；不得把作者全知投影当角色视图 |
| 内容信任 | Pack 是不受信任数据，不是代码；不得包含 Secret、系统权限、可执行脚本、网络端点或外部路径 |
| 重放 | 已提交 Round 重放 Authority/Replay，不重新解释输入、不重新召回 Memory、不重新调用模型 |
| 版本 | 激活锁定 Pack、Manifest、Genesis、插件、Context、Scene、Presentation 与 Compiler 版本和 Hash |
| 时间 | 总体路线仍默认 `TURN_DRIVEN`；无用户或获授权 Author/Controller 触发时世界不推进 |
| 发布 | `v0.1.0` 保持原义；任何后续 Phase 失败都不能通过更新旧 Golden 或移动 Tag 绕过 |

## 4. 运行架构与所有权

总体架构的数据流固定为：

```text
World Pack source directory
  -> strict loader and diagnostics
  -> WorldPackCompiler
  -> immutable worldpack.json envelope
  -> existing WorldSpecCompiler / plugin registries
  -> CompiledWorldManifest + GenesisPlan
  -> WorldBootstrap activation
  -> WorldApplication
       -> PlayerInputInterpreter / Agent Controller / AuthorCommand
       -> Round Inbox and participant freeze
       -> ContextAssembler + Memory + SceneDecision
       -> Provider proposals
       -> Validator + Rulebook resolution
       -> atomic World commit + Outbox + cognitive jobs + Authority
       -> authorized CharacterView and deterministic Presentation
```

所有权按下表固定：

| 数据 | 权威所有者 | 是否进入世界 Hash | 可否重建 |
|---|---|---:|---:|
| Pack source | 创作者工作区 | 否 | 不适用 |
| compiled `worldpack.json` | Pack Compiler | 是，作为 packHash 输入 | 可由同一 source/compiler 重编译 |
| Manifest、Genesis、Event、Resolution | World Store | 是 | 是 |
| Character Claim/Goal/Affect/Scene 状态 | World Event + Projection | 是 | 是 |
| Runtime Availability | Host runtime store | 否 | 由运行状态恢复 |
| Memory L0/L1 | Local Memory store | 否 | 由获授权 World 前缀重建 |
| Presentation | Presenter | 否 | 由授权 Presentation Input 重建 |
| Model request/response metadata | Replay/Audit store | Hash 与终态受保护，原文默认不保存 | 按策略 |
| Secret、API key、endpoint | Host Secret Provider | 否 | 不得进入 Pack、World、Audit 或 Export |

## 5. World Pack 来源、编译与版本

### 5.1 来源目录

创作者编辑的是一个目录，不是单个巨型 JSON。根文件固定为 `worldpack.source.json`，由它显式列出全部结构化文件、Markdown 和可选素材；禁止 glob、隐式递归和目录外引用。

```text
my-world/
├── worldpack.source.json
├── world.json
├── characters/
│   ├── alice.json
│   └── bob.json
├── locations.json
├── scenes.json
├── player-slots.json
├── presentation.json
├── text/
│   ├── alice-portrayal.zh-CN.md
│   └── opening.zh-CN.md
├── assets/
│   └── tavern-map.png
└── assertions/
    └── social-boundaries.json
```

根清单的最小形状为：

```json
{
  "sourceSchemaVersion": "worldpack-source/v1",
  "packId": "pack:tavern-social",
  "packVersion": "1.0.0",
  "worldFile": "world.json",
  "characterFiles": ["characters/alice.json", "characters/bob.json"],
  "locationFiles": ["locations.json"],
  "sceneFiles": ["scenes.json"],
  "playerSlotFiles": ["player-slots.json"],
  "presentationFiles": ["presentation.json"],
  "markdownFiles": ["text/alice-portrayal.zh-CN.md", "text/opening.zh-CN.md"],
  "assetFiles": ["assets/tavern-map.png"],
  "assertionFiles": ["assertions/social-boundaries.json"]
}
```

路径必须使用 `/`、为相对路径、无 `.`/`..`/驱动器/UNC/符号链接逃逸，大小写碰撞在所有平台均拒绝。JSON 使用严格 World JSON 子集；Markdown 为 UTF-8，先把 CRLF 归一化为 LF，再验证 Unicode，禁止孤立代理项，不做 Unicode NFC/NFD 归一化。素材是不透明的 presentation-only 内容，以字节 SHA-256 寻址。

默认 `worldpack-limits/v1`：最多 512 个显式文件、总计 16 MiB、单个 JSON 1 MiB、单个 Markdown 256 KiB、单个素材 8 MiB；最多 256 个 CharacterDefinition、64 个 CharacterTemplate、512 个 Location、256 个 SceneDefinition、64 个初始 SceneInstance、2048 个 Entity。Compiler Profile 必须锁定这些限制，Host 可以选择更小但不能在同一 profile 下静默放宽。

### 5.2 编译产物

编译结果是一个 Canonical JSON-compatible 的不可变 `worldpack.json` envelope：

```json
{
  "compiledSchemaVersion": "worldpack/v1",
  "packId": "pack:tavern-social",
  "packVersion": "1.0.0",
  "packHash": "sha256:...",
  "compiler": {
    "id": "harness-world-pack-compiler",
    "version": "0.2.0",
    "contractVersion": "worldpack-compiler/v1",
    "canonicalJsonVersion": "world-json/v1",
    "limitsProfile": "worldpack-limits/v1"
  },
  "pluginLocks": [],
  "content": {},
  "assets": [],
  "acceptanceAssertions": []
}
```

`packId + packVersion` 只用于人类管理；`packHash` 才是内容身份。同一 `packId + packVersion` 对应不同 `packHash` 必须返回 `PACK_VERSION_DIVERGED`。激活后的世界只读取 compiled envelope 和 Manifest，不再读取 source 目录。

编译顺序固定为：加载根清单、解析并验证路径、读取并规范化文件、严格 Schema、引用图、唯一性与循环检查、插件与版本解析、默认值物化、稳定排序、生成 acceptance plan、Canonical 编码、计算 packHash、适配 WorldSpec、编译 Manifest 和 Genesis。

### 5.3 最小 Pack 与默认值

最小 Pack 只要求：

- `packId`、`packVersion`、世界显示名和 `TURN_DRIVEN` core profile；
- 一个 PlayerSlot；
- 至少一个 Character、一个 Location 和一个包含玩家角色的 Scene；
- 精确 Core Rulebook、Scene Decision、Context 和 Presentation profile。

Character 来源只强制 `characterId` 与 `displayName`；进入初始 active Scene 时必须能解析 `locationId`。其余 Claim、Goal、Affect、InnerTension、Memory profile、Director、Scene transition 和 objectives 均可省略。省略后由 Compiler 物化为冻结默认值：lifecycle=`active`、agent participation=`disabled`、runtime availability=`disabled`、空私有认知、无自动 Director、确定性纯文本 Presentation、无自动 Scene transition。

CLI 脚手架提供 `minimal`、`social`、`advanced` 三种 source scaffold；它们只是生成不同数量的显式字段，不改变 Schema 或运行语义。

## 6. 角色、秘密、关系与复杂心理

### 6.1 CharacterDefinition

CharacterDefinition 分为六个区域：

| 区域 | 内容 | 权威落点 |
|---|---|---|
| identity | id、显示名、称谓、外观、模板身份 | Manifest / Genesis |
| genesis | 初始位置、lifecycle、公开关系事实 | Genesis Event |
| cognition | 初始 Observation、Claim、Goal | 角色私有 Event / Projection |
| portrayal | 说话风格、背景叙述、affectStyle | Context 的低优先级描述 |
| capabilities | 精确注册的 capability 和 action alias | Manifest Registry |
| runtime | participation、logical model/memory profile | Host-resolved policy |

自由文本不能充当系统提示、权限、能力、规则或事实。客观事实必须编译为 Genesis/Event；主观认知必须编译为某角色的 Claim/Goal/Observation。关系分为客观世界关系事件和角色各自的主观关系 Claim，两者不得自动互相同步。

### 6.2 秘密与错误认知

Secret 的作者语法由一条权威命题和 `initialAudience` 组成。Compiler 必须把 audience 展开为每个角色独立、带 source ref 的初始 Claim；未列入 audience 的角色没有该 Claim。缺少 Claim 表示未知，不生成 `unknown` 占位事实。

错误认知使用普通 Claim 表示，推荐结构：

```json
{
  "claimId": "claim:bob-believes-alice-left",
  "ownerCharacterId": "character:bob",
  "proposition": {
    "predicate": "character.location",
    "arguments": ["character:alice", "location:road"]
  },
  "stance": "believed",
  "confidencePermille": 700,
  "visibility": "private",
  "sourceRefs": ["observation:bob-heard-rumor"]
}
```

`stance` 固定为 `believed | suspected | denied`，confidence 为 0～1000 整数。需要参与 Rulebook 的 proposition 必须使用注册 predicate；自由叙事命题只能进入 portrayal 或不可裁定的叙述字段。

### 6.3 Goal、Affect 与 InnerTension

CharacterGoal 是角色主观状态，不是外部事实证明：

```json
{
  "goalId": "goal:bob-hide-letter",
  "ownerCharacterId": "character:bob",
  "status": "active",
  "priorityPermille": 850,
  "awareness": "conscious",
  "visibility": "private",
  "targetRefs": ["entity:letter"],
  "sourceRefs": ["claim:bob-knows-letter"],
  "completionPolicyRef": "core:goal/manual@1"
}
```

状态固定为 `active | blocked | completed | abandoned | failed`；awareness 为 `conscious | partially_conscious | unrecognized`。父 Goal 只用于组织，不自动传播状态、分解任务或调用规划器。Goal 的确定性完成或受控作者完成都必须有来源；完成一个 Goal 不改变其他角色的 Claim。

情绪由稳定的 `affectStyle`、事件化的当前 Affect 和结构化 InnerTension 组成。多个 Affect 可同时存在且无需归一化：

```json
{
  "affectId": "affect:bob-fear-exposure",
  "ownerCharacterId": "character:bob",
  "affectType": "fear",
  "intensityPermille": 780,
  "targetRefs": ["character:alice"],
  "causeRefs": ["claim:bob-suspects-alice-knows"],
  "awareness": "partially_conscious",
  "visibility": "private"
}
```

```json
{
  "tensionId": "tension:bob-protect-and-confess",
  "ownerCharacterId": "character:bob",
  "label": "想保护 Alice，同时又想坦白",
  "goalRefs": ["goal:bob-protect-alice", "goal:bob-confess"],
  "claimRefs": [],
  "affectRefs": ["affect:bob-fear-exposure"],
  "awareness": "partially_conscious"
}
```

InnerTension 进入 Context，但不是 Rulebook 权威输入，除非一个精确注册的题材插件显式声明它。内部情绪与外显行为分离：其他角色只能通过获授权 Observation 得知表达，不能读取 Affect。`unrecognized` 的心理状态可被 Agent 作为角色刻画上下文使用，但不能伪装成角色自知的 Claim。

Kernel 只冻结结构，不定义通用心理学本体。Pack 选择精确版本的 affect vocabulary 与可选 policy；`TURN_DRIVEN` 下 Affect 只由 Tick、Event 或注册 policy 更新，不依赖真实时钟衰减。

### 6.4 唯一角色与角色模板

CharacterDefinition 可标记 `instantiation: unique | template`。unique 在同一 World 最多一个实例；template 可产生多个独立实例。每个实例必须拥有独立 CharacterId、lifecycle、Scene、Observation、Claim、Goal、Affect、Memory namespace、Session 和 Runtime Availability。

模板参数只允许预编译 Schema 中的名称、称谓、外观和已列举 variant；不能通过参数增加 capability、secret、初始物品或任意 prompt。永久角色只能由 Genesis、受控 Runtime Author 或可信 spawn policy 创建，Agent/Director Proposal 不能自由创建永久角色。派生 Claim/Goal/Affect ID 必须由 templateId、instanceId 和 source local id 确定性生成。

## 7. PlayerSlot、Controller 与 Observer

PlayerSlot 将用户 Principal 与玩家 Character 分离。Pack 可以提供多个候选 Slot，但本架构覆盖的单个 World 激活时只能绑定一个本机玩家 Principal。

PlayerSlot 支持：固定主角、受限自定义主角和 blank-slate 玩家。允许自定义显示名、称谓、外观、portrayal、自我概念、预编译背景 variant 和初始主观 Goal；不允许自定义 capability、初始物品、位置、Secret、系统提示或 model profile。自由背景文本只属于 portrayal/self-concept，不成为世界事实。

控制关系以耐久非世界事实账本表示：

```text
CharacterControlBinding(address, characterId, mode, controllerRef, controlEpoch)
ObserverBinding(address, principalId, characterId, controlEpoch)
```

`mode` 固定为 `manual | agent_controlled`。每个 Round Authority 绑定 control mode、controlEpoch 和 controller class，防止控制切换后重放歧义。

在 `manual` 模式，Principal 提交文本或命令。在 `agent_controlled` 模式，人类成为同一角色的 Observer，只能发送 `/continue`、`/continue N`、`/pause`、`/status`、`/view`、`/health`、`/take-control` 和 `/stop`。Observer 只能读取该角色获授权的 CharacterView、Presentation、self state 和运行健康；不能读取其他角色私有视图、作者真相、Raw Store、Director 状态、私有 Memory、原始模型 Prompt/Response 或 chain-of-thought，也不能切换镜头到 NPC。

每次 `/continue` 只触发一个耐久 Round 和一个 Tick：先由玩家角色 Agent 提案，再按冻结的 Scene/participation 策略调度 NPC 与 Director。`/continue N` 串行执行最多 N 轮，任一失败、quarantine、pause、terminal case 或健康屏障立即停止。本架构不提供后台 autoplay。

新增通用 `core:wait@1` 作为玩家角色 Agent abstain、timeout、failure、预算耗尽或非法输出时的确定性回退。它提交一个无世界状态变化的合法 Action Resolution，推进该 Round 的 Tick，准确记录参与者 terminal 和 Health；不得伪造对白、Observation、Proposal 或 Memory。

manual 与 agent-controlled 切换只允许在 Round 边界且无 pending/claimed Round 时进行。切换经过 admission barrier、append-once control ledger、Audit 和单调递增 `controlEpoch`，不推进 Tick。只有当前绑定 Principal 可 `take-control`；Admin 只能通过显式恢复命令处理失效绑定。

## 8. Scene、目标与可见性

### 8.1 SceneDefinition 与 SceneInstance

SceneDefinition 是可复用来源模板；SceneInstance 是耐久世界实体。Definition 可定义参与资格、位置集合、可见性 policy、允许 action filter、presentation override 和注册 transition 条件，但不能直接代表当前 active 状态。

存量 Scene policy v1 保持“一个玩家 focal Scene 与历史静态参与者语义”。新 Pack 使用 `scene-decision/v2`：World 可有多个 active Scene，但同一 Character 同时最多属于一个 active Scene，每个 PlayerSlot 必须恰有一个 focal active Scene。违反该约束属于 Projection invariant，分支立即 quarantine。

`SceneDecisionService.decide(address, playerCharacterId, asOfSeq)` 返回：

- 玩家唯一 focal Scene；
- 各 active Scene 的成员和当前观察者；
- 玩家 Round 可调度的 NPC/Director 候选；
- 每个 Action 结果对各角色的可见范围；
- 对应 source seq、policy version 和 decision hash。

不在 Scene、非 active lifecycle 或 runtime unavailable 的 NPC 不被调用。`AUTONOMY_OFF` 时，非 focal active Scene 保持存在但不自动产生 Round；它们仍可接收由权威事件导致且获授权的 Observation/cognitive job。

Scene transition 只使用精确注册、确定性的 condition/trigger type。Transition 只能改变 Scene 实例状态和成员关系；其他世界变化必须通过独立 Action/Resolution/Event 表达。Scene 在同一 Round 内改变时，后续 action 使用事件前缀重算可见性和参与资格。

### 8.2 Objective 分类

以下四类不得混用：

| 类型 | 所有者 | 是否角色主观 | 是否默认展示 |
|---|---|---:|---:|
| CharacterGoal | Character | 是 | 仅按 visibility |
| ScenarioObjective | Author/Orchestration | 否 | 否 |
| PlayerObjective | Player UI | 否 | 是 |
| AcceptanceAssertion | Testkit | 否 | 永不进入运行时世界 |

ScenarioObjective 可省略，开放式酒馆可以没有“胜利条件”。其状态为 `inactive | active | blocked | completed | failed | cancelled`，只能由注册确定性 policy 或受控 AuthorCommand 改变，并带证据来源。Objective 完成不能直接突变其他世界状态；如需结束 Scene，必须生成独立 Scene transition。本架构不实现自动剧情规划和任务分解。

## 9. Action、插件与创作者扩展

创作者可以：启用已注册 Action、定义 alias/固定参数/解释器短语/Presentation 模板、给 Character 分配已注册 capability、在 Scene 中收窄 affordance。最终权威 Action 始终是 Manifest 中精确注册的 `actionType + version`。

新增硬语义必须由受信任插件完整提供：Schema、Validator、Capability、Affordance、Resolver、Event Registry、Reducer、Observation policy 和 Presentation input schema。Pack 只引用精确 plugin id、SemVer 和 registry hash；Host allowlist 必须显式允许。缺失、版本漂移或 hash 分歧返回 `PLUGIN_NOT_REGISTERED`/`REGISTRY_HASH_MISMATCH`，禁止最近版本回退和自动下载。

本架构不提供通用 guard/effect DSL、宏、任意 Event 名称或任意 JSON effect。插件代码由 Host 安装和审核，Pack 仍是不受信任数据。

通用 `PlayerInputInterpreter` 规则保持：普通非空文本产生 `speak`；`/move <locationId>`、`/take <entityId>` 产生通用 Action；`/act <actionType> <canonical-json>` 只允许当前 Affordance 中注册的 Action。未知命令、缺参和歧义返回耐久 clarification，不建立 Round、不推进 Tick。题材 Interpreter 只能优先解析明确题材语法，其余输入回落通用解释器。

## 10. Presentation 与内容边界

Creator 可定义版本化 `PresentationProfile`：确定性模板、Scene override、本地化字符串和内容寻址素材。Presenter 只能读取已授权 Presentation Input；模板引用 Secret、其他角色私有 Claim/Affect、raw Memory、author truth 或不存在字段时在编译期失败。

正式已提交的角色对白不得被 Presenter 改写语义。内部 Affect 只有经 Action 或 Observation 外显后才可呈现给其他角色。Narrative scope 固定为：

- `player_limited`：默认，只呈现绑定玩家角色可知内容；
- `scene_public`：呈现当前 Scene 中公开且可观察内容；
- `character_limited`：仅指定角色自我界面；
- `author_preview`：独立能力，仅创作测试入口可用，生产玩家/Observer 不可用。

本架构覆盖期内 Presenter 是纯确定性组件，不调用 LLM。保留未来 `NarrativeProviderPort`，但不得在 Phase 7～11 启用。

内容治理只做结构、资源、权限和安全限制，不做主题或价值观语义审核。Pack 可声明 `contentDescriptor`、warnings 和 tags，Host 可安装默认 Noop 的 policy hook。运行时必须转义终端 ANSI/控制字符和不安全 Markdown；`authorOnly` 是可见性边界，不是加密。API key、Secret、endpoint 和真实用户数据不得写入 Pack。

## 11. Runtime Author

角色分为 Pack Author、Runtime Author、Player 和 Admin。Runtime Author 只调用精确注册的 AuthorCommand，可实例化预编译 Scene/CharacterTemplate、改变 lifecycle/Goal/ScenarioObjective、触发注册环境变化和设置未来轮次的 Agent participation/runtime availability。

AuthorCommand 必须经过 capability、Schema、Rulebook/author policy、Event/Authority/Audit；不能直接操作 SQLite、Projection、Memory，不能任意 emit Event，也不能注入未编译 CharacterDefinition。AuthorCommand 增加 Event seq，但默认不推进玩家 Tick。Player、Author、Admin 的 stdio RPC capability 必须分离。

## 12. Agent 参与、Memory 与真实 Provider

### 12.1 参与调度

Character 存在不等于每轮调用模型。新 Manifest 锁定版本化 participation policy，支持：

- `focal`：玩家 focal Scene 中的优先候选；
- `reactive`：满足注册触发条件时参与；
- `rule_only`：只走确定性规则，不调用模型；
- `silent`：不提案，但接收获授权 Observation 与 cognitive job；
- `disabled`：不参与且默认 runtime availability disabled。

Scene、lifecycle、runtime availability、policy 和预算共同生成候选集。Host 有硬上限；超限时按 policy priority、role rank、CharacterId 进行 locale-independent 稳定选择。参与者集合、顺序、预算决定和 terminal 必须在调用前后写入 Round Authority。Director 每轮最多 0～1 次调用。

Runtime Author 可从未来 Round 起提升或降低 participation，必须耐久、审计且不改变 lifecycle。silent/background Character 的 Memory 仍按获授权事件追平。

### 12.2 Cognitive Memory

初始知识必须编译为 Observation、Claim、Goal 或 Affect，禁止 Pack 直接写 Memory row。Creator 只选择逻辑 Memory Profile：recall 上限、salience、attention topics、Goal/Affect bias、L1 summary policy 和频率。

L0 是带精确 source refs 的原始获授权记忆，强制启用且不可因“遗忘”删除世界来源。L1 是来源链接的派生摘要，可关闭；本架构覆盖期默认只允许 deterministic/scripted summary。若未来用模型生成 L1，必须保存 context/request/response/result hash 并支持 replay。L2/L3 自动抽象不在 Phase 7～11。

Memory profile 不能改变 namespace、角色/Branch 隔离、as-of 防火墙、source mapping 或“summary 不能创造新事实”。Forget 只移除可重建派生项，不删除 World source。Provider 调用前必须保证该角色 Memory 水位不落后于所需 as-of Head，否则该参与者以 `memory_catchup_failed` 降级，玩家 Round 仍可提交。

### 12.3 ContextAssembler v2

Context v2 稳定顺序固定为：

1. runtime boundary 与 capability；
2. WorldAddress、Round、Tick 和 as-of 水位；
3. 当前 CharacterView；
4. focal SceneDecision；
5. active Goal；
6. Affect 与 InnerTension；
7. 已验证 Memory recall；
8. 玩家候选 Action 或 Controller trigger；
9. 当前 Affordance；
10. portrayal，自由文本永远位于最低权限层。

每个参与者独立保存 contextHash、memory source refs、recall result hash、profile hash、budget decision 和 terminal。portrayal 中的 prompt injection 只是角色文本，不能覆盖前述 runtime boundary、事实、权限或 Rulebook。

### 12.4 Harness Provider

Creator 只选择 logical model profile；Host 映射实际 provider、model、预算、隐私、timeout 和 fallback。Pack 不得包含 endpoint 或 Secret。

真实 Harness 接入必须位于现有 `HarnessAgentPort` 后的独立 Bridge，默认关闭，不复制或引用只读 Harness 源码内部路径。只有固定公开版本、许可证和契约测试都满足时才可启用；否则保留禁用能力并记录阻塞证据，不阻塞 Scripted/Rule/Noop 路径。

默认不持久化原始 Prompt、Response 或 chain-of-thought，只保存 canonical request/context/response hash、logical/host profile、预算、时延和 terminal。合法模型输出仍必须经过 `submit_actions` 验证和 Rulebook；失败、超时、预算耗尽或非法输出只降级该参与者。已提交 Round 重放禁止再次调用 Provider。

## 13. 创作者与本机交互工作流

本架构先提供 CLI 和可复用 API，未来 GUI 只能调用同一 Compiler/Application Port：

```text
worldpack init --profile minimal|social|advanced <dir>
worldpack validate <dir>
worldpack compile <dir> --out <worldpack.json>
worldpack inspect <worldpack.json>
worldpack diff <old.json> <new.json>
worldpack format <dir>
worldpack doctor <dir>
worldpack test <dir>
worldpack activate <worldpack.json> --data-dir <dir>
```

诊断统一包含 `severity`、`code`、`file`、`jsonPointer`、`message` 和可选 `suggestion`。Error 阻止编译/激活；Warning 不改变产物 Hash。`format` 只做语法和稳定排序，不做语义 autofix。`test` 使用临时 SQLite、Scripted/Rule/Noop Provider 且禁止网络。

通用连续 stdio shell 必须允许在同一持久 World 上反复提交普通文本和命令，查询自身 View、Round、Health 和恢复提示；不得暴露 author preview、NPC 私有 Memory 或 Store handle。

## 14. 参考内容与验收主题

总体路线最终至少维护三个参考 Pack：

| Pack | 用途 | 禁止依赖 |
|---|---|---|
| 酒馆社交 | 多人对白、私密动机、传闻、关系、情绪、角色进出 Scene、连续 Memory | culprit/evidence/accuse/结案规则 |
| 旅途同行 | 位置切换、物品、离队、多 active Scene、Goal、Affect、fork 选择 | 调查 Resolver |
| 悬疑回归 | 秘密、错误命题、知识隔离、future canary、旧 v3/v4 兼容、降级 | 新增谜题玩法 |

前两个 Pack 首先使用 Scripted/Rule/Noop Provider，确保无模型路径完整。真实 Provider 首次只接入酒馆社交，用于验证开放式对白，不得成为 Pack Compiler 或运行时正确性的前提。

每个 Pack 的 `assertions/` 只供 Testkit 使用，不进入 Manifest、Genesis、Event、Agent Context 或 Presentation。例如“Bob 的秘密不得出现在 Alice recall”是测试断言，不是世界内可见规则。

## 15. API 与错误目录

总体路线首批公共接口：

```typescript
interface WorldPackCompiler {
  compile(sourceDirectory: string, options: CompileOptions): Promise<CompiledWorldPack>;
}

interface SceneDecisionService {
  decide(address: WorldAddress, playerCharacterId: CharacterId, asOfSeq: number): SceneDecision;
}

interface PlayerInputInterpreter {
  interpret(request: InterpretPlayerInputRequest): InterpretedAction | ClarificationResult;
}

interface CharacterControlService {
  switchMode(request: SwitchCharacterControlRequest): CharacterControlBinding;
  continue(request: ContinueControlledCharacterRequest): Promise<RoundAcceptedResult>;
}

interface AuthorCommandService {
  submit(request: AuthorCommandRequest): Promise<AuthorCommandResult>;
}
```

新增错误至少包括：

| Code | 重试 | 含义 |
|---|---:|---|
| `PACK_SOURCE_INVALID` | 否 | source Schema、Unicode、路径或限制不合法 |
| `PACK_REFERENCE_INVALID` | 否 | 引用缺失、跨类型或循环 |
| `PACK_VERSION_DIVERGED` | 否 | 同 id/version 对应不同 hash |
| `PLUGIN_NOT_REGISTERED` | 否 | 精确插件未安装或未 allowlist |
| `REGISTRY_HASH_MISMATCH` | 否 | 插件 Registry 与 Pack 锁不一致 |
| `SCENE_MEMBERSHIP_INVARIANT` | 否 | 角色同时属于多个 active Scene 等完整性错误，触发 quarantine |
| `CONTROL_EPOCH_CONFLICT` | 可 | 控制切换或 Round 使用过期 epoch |
| `CONTROL_SWITCH_BLOCKED` | 可 | 存在 pending/claimed Round 或 admission barrier |
| `OBSERVER_FORBIDDEN` | 否 | Observer 请求越出绑定 Character 权限 |
| `AUTHOR_COMMAND_FORBIDDEN` | 否 | AuthorCommand 未注册或 capability 不足 |

所有错误继续使用既有 `ErrorEnvelope`，不得输出裸堆栈、Secret 或私有内容。

## 16. 兼容、升级与 Diff

旧 v1～v4 Manifest、悬疑 Event、Resolution、Authority、Registry 和 Hash 保持逐字节不变。v3/v4 的 Rulebook 生命周期继续服从 ADR-0050。旧 Scene policy v1 与 Context v1 仍按历史语义挂载，不自动升级到多 Scene、复杂 Affect 或 Context v2。

本架构不支持运行中 World 换 Pack。Pack source 变更后必须产生新 `packHash`；preview/test 使用临时 World，production update 创建新 World。`worldpack diff` 只分类：presentation-only、content-compatible、genesis-changing、registry/plugin-changing、unsupported；它不执行迁移。

未来若需要维护窗口内 Manifest epoch migration，必须另立 ADR，保留旧 Event 原字节、定义 Upcaster 和恢复矩阵。本架构不允许通过 fork 替换 Pack，也不允许 pack inheritance。

## 17. 阶段拆分与实施顺序

每个 Phase 继续按“契约与 Store → 领域行为 → 集成/故障测试 → 文档证据”拆分最小提交：

| Phase | 只回答的核心问题 | 主要范围 | 明确推迟 |
|---|---|---|---|
| 7 | 不改 Kernel 能否做出非悬疑酒馆世界 | 最小 Pack v1、最小 Character、现有 Scene policy、通用连续交互、酒馆 Pack、角色 Memory 隔离 | Scene v2、复杂心理运行策略、第三方插件、Agent 接管、真实 Provider |
| 8 | 多 Scene 与复杂主观状态是否仍可重建 | Scene v2、旅途 Pack、Goal/Affect/InnerTension 动态策略、Objective | Runtime Author、Player Agent Controller、真实 Provider |
| 9 | 创作者能否安全扩展题材与运行内容 | CharacterTemplate、受信任插件锁、Action alias、PresentationProfile、Runtime Author | 不受信任插件沙箱、真实 Provider |
| 10 | Agent 能否安全接管玩家角色 | PlayerSlot 扩展、Control/Observer ledger、`core:wait@1`、participation policy | 后台 autoplay、多玩家 |
| 11 | 真实模型能否服从既有权威边界 | Context v2 完整 profile、Memory L1、Harness Bridge、真实 Provider replay/degradation | TencentDB、LLM Narrator、远程服务 |

各 Phase 只以自己的正式实施规格作为完成清单；后续 ADR 已 Accepted 不等于前一 Phase 必须提前实现。

任何单元无法保持原子性、Hash、as-of、权限或确定性时停止该单元；不相关且不依赖该阻塞的单元可继续。

## 18. 总体测试与发布门槛

### 18.1 Compiler 与内容

- source 文件顺序、CRLF/LF、Windows/Linux 路径表现产生精确相同 canonical bytes 和 packHash；
- 非法 Unicode、路径逃逸、大小写碰撞、未知字段、引用缺失、循环、超限、插件漂移全部 fail-closed；
- minimal/social/advanced scaffold 均能 validate/compile/test；
- 同 id/version 异 hash 被拒绝，激活世界不再读取 source 目录；
- Presentation 模板越权引用在编译期失败。

### 18.2 认知、Scene 与控制

- Alice、Bob、玩家对相同查询得到不同 Claim/Memory；秘密和 false belief 不串线；
- “Bob 说 P”只产生来源化交流记忆，不自动生成 P 的真值 Claim；
- 多个矛盾 Affect/Goal/Tension 可同时重建，内部状态不泄漏到他人 View；
- Scene v2 覆盖分场、合流、离场、不可见动作、同轮 Scene 变化、fork as-of 和多 Scene invariant quarantine；
- manual 与 agent-controlled 切换覆盖 epoch 冲突、pending Round 屏障、重启和双实例 fencing；
- Observer 只能读取绑定角色；所有 camera switch、NPC view、raw Memory、author preview 请求被拒绝；
- `/continue N` 串行且可停止，Agent 失败使用 `core:wait`，每次只推进一个 Tick。

### 18.3 Provider、Memory 与降级

- 不同角色拥有独立 contextHash、memory refs 与 recall hash；
- future、跨 Branch、跨角色、Summary 二次捕获全部拒绝；
- participant 集合和顺序确定，silent/background 角色不调用模型但 Memory 追平；
- Provider error、timeout、budget exhausted、invalid output、Memory catch-up failure 和 Session dead letter 不阻塞玩家 Round；
- 同键重放 Provider 调用为零；硬终止后恢复使用耐久 Authority/Replay；
- Prompt/Response 原文默认不落盘，Export/Audit 不含 Secret。

### 18.4 回归与发布

- `v0.1.0` 全部 Golden、P0～P6、258+ tests 和 18+ hard-crash tests 保持通过；
- v3/v4 悬疑生命周期矩阵与 Hash 全等；
- 酒馆和旅途各完成多轮、重启、fork、Memory、Scene、Presentation 和 stdio E2E；
- 所有生产文件逐文件 statements/branches/functions/lines 100%；
- Windows/Ubuntu × Node 22.19/24 clean install 和 `corepack pnpm@11.7.0 check` 全绿；
- 每个 Phase 完成自身 requirement→test evidence、兼容表、runbook 和 clean worktree 后，才可提议对应候选版本；Tag、Release 和推送仍需用户授权。

## 19. Evidence → Finding → Path

### 19.1 Evidence

| Evidence | 已确认事实 |
|---|---|
| V0.2 冻结规格与 ADR-0023～0053 | Event 权威、模型提案、Memory as-of、Scene/Runtime Availability、stdio 与本机发布边界已存在 |
| ADR-0050～0052 与悬疑纠偏报告 | 调查玩法已移出 Kernel；Memory、Scene、通用交互和降级已进入正式 Application 路径 |
| 本轮产品讨论 | 已接受角色秘密/错误认知/关系、复杂心理、Scene v2、Pack、插件、目标、Presentation、Runtime Author、PlayerSlot 和 Observer 控制边界 |
| `v0.1.0` Release Closure | 四格 CI、Golden、崩溃测试和私有源码发布基线可作为不可回归门槛 |

### 19.2 Findings

1. 悬疑可以继续验证知识隔离，但不能代表开放式创作产品；必须加入不依赖调查语义的参考 Pack。
2. 创作者表达力应主要来自严格数据模型、可选字段、模板和受信任插件，而不是把自由文本变成规则或脚本。
3. 复杂心理可以表达为并存的 Claim、Goal、Affect 和 InnerTension，但它们仍是角色主观状态，不能成为绕过 Rulebook 的世界事实。
4. Agent 接管玩家角色不会要求“后台世界”；Controller/Observer 分离和每次 `/continue` 一 Tick 可保持 TURN_DRIVEN、权限与重放不变量。
5. 真实 Provider 应排在无模型 Pack、Scene、Memory 和控制路径之后，避免用模型掩盖通用架构缺口。

### 19.3 Path

实现路径固定为：先冻结 Pack 与角色/Scene/控制契约，再构建两个非悬疑 Pack和 CLI 工作流，最后接入真实 Harness Provider。每一步均用旧悬疑 Golden、跨角色 Memory、fork future canary、Observer 权限和 hard-crash 测试共同守门。

## 20. 收敛结论

总体产品方向是“可信、可重放、可由创作者定义的多角色世界运行时”，不是悬疑游戏内核，也不是任意脚本平台。创作者最终获得足够宽的角色、心理、关系、Scene、目标、呈现和受控扩展空间；Kernel 继续只负责版本化契约、权威裁定、权限、事务、重放和恢复。

本总纲与 ADR-0054～0059 共同构成 Phase 7～11 的长期架构基线。Phase 7 的实际完成边界以独立的最小通用内容闭环规格为准，后续 Phase 也必须各自新增窄范围实施规格。
