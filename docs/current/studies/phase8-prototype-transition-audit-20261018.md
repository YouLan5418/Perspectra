# Phase 8 到自由叙述原型：保留、替换与未收口部分

调查日期：2026-10-18，收尾复核日期：2026-10-19。调查对象是 `codex/tavern-card-slice` 工作树，调查基点为 `7a141c0`，包含开始前已有的未提交内容，不将结论直接等同于 main 或 test3 发行包。以下调查与脚本追踪完成时尚未修改生产源码；后续实施单独记录。调查及前两步清理没有调用真实模型；第三、四步在新建合成包和数据目录中调用了真实模型，均未读取历史试玩库。

最终范围：保留空 NPC 装配清理和旧 NPC 执行退役。第三步初始心理呈现曾实现，但补做改前对照后发现行动选择退化迹象，已撤回源码、专属测试与夹具，见文末对照及收尾记录；它不属于当前已交付能力。前半部分是改动前证据，已删除源码可从调查基点 `7a141c0` 读取。宿主目录整理、Source／摘要解耦及更稳妥的初始心理呈现仍未完成。

## 先从角色互动看问题

玩家说“请把钥匙拿起来”，现在的 NPC 会自己选择执行拿取，得到已提交结果，再说“拿到了”。这一段已经由新单角色处理路径负责。可是玩家输入的接收和提交仍经过旧 `WorldApplication / RoundCoordinator`，后者还装配 Phase 8 的上下文与认知基础设施。

所以当前确实存在新旧机制交织：**角色决策和反应调度已经换了；玩家提交与世界底座复用旧实现；部分旧组件仍被装配但不参与当前 NPC 决策；部分旧能力只保留了读取或独立 API。** 这些情况需要分别判断，不能统一算作没做完，也不能统一当作可删除代码。

## 为什么会留下这些东西

| 时点 | 可核对记录 | 对当前结构的影响 |
| --- | --- | --- |
| 2026-08-29 | [Phase 8 完成报告](../../archive/phase-7-9c/2026-08-29_阶段报告-Harness-Cordis-World-Phase-8-report.md) | 当时交付的是结构化认知、Reflection、可重建 Context、调用生命周期、场景与权限等整套机制。本机 Fixture 通过；报告明确真实模型 API 未启用。 |
| 后续至 2026-09-15 | Phase 9 调度、表现与创作者交互继续演进；`e682c5c` 是 9 月 15 日提交 | 当前原型实际继承了 Phase 8、Phase 9 和 v10 交互抽象，并非从 Phase 8 原始代码直接起步。 |
| 2026-09-19 的方向记录 | [原型契约](../prototype-contract.md)、[基线说明](../baseline.md) | 选取 `e682c5c`，没有从空目录重写。基线明确说“这不是最小运行时”，旧 Receipt、Hash 和耐久调度仍在，按实际阻碍逐步拆除。 |
| 2026-09-22～23 | `c0d7231`、`4741c66`；[G1/G2 记录](../../archive/prototype-g1-g4/PROTOTYPE-G1-G2-ACCEPTANCE.md) | 新的自由表达、单角色执行与结果续写接入默认网页；实现重点是让角色互动闭环先工作。 |
| 2026-09-23～25 | `9d88d3d` 发起盘点，`67f1b43` 记录收口；[G4 审计](../../archive/reviews/PROTOTYPE-G4-ARCHITECTURE-AUDIT.md) | 做了 35 个清理切片，删除旧网页、simulation、operations、旧编译器与版本分流。G4 主动把旧 Context、调用账本、Reflection、耐久 Reaction 等列为暂缓项；archive / logical transfer / snapshot API 按当时用户要求保留。 |
| 此后至当前 | [当前代码路线](../architecture/code-walkthrough.md)、[记忆说明](../architecture/cognition-memory.md) | Launcher、活动、Core 长期记忆、故事节点、重新生成等继续沿现有宿主演进。未重新统一旧装配和新 NPC 路径。 |

这里应区分两件事：旧机制中的许多实现当时已经完成，但后来不再属于默认玩法；原型替代也没有承诺把继承代码全部重写。G4 的“收口”表示当次删除范围结束，不能解释成全仓已经变成最小原型。

## 调查时每一类遗留的状态（实施前）

| 部分 | 源码事实 | 当前判断与影响 |
| --- | --- | --- |
| 世界事实、权限、交互裁定 | 新旧路径都使用 WorldStore、CharacterViewBuilder、SceneDecisionService、Rulebook 和原子提交 | **仍在使用的底座。** 保护位置、物品、授权观察与一致提交，不属于闲置遗留。 |
| 玩家输入与 RoundCoordinator | 网页宿主用 WorldApplication.submitText 提交玩家输入，普通输入成功后才启动新的 NPC 激活 | **仍在使用。** 旧 Coordinator 同时容纳玩家提交与旧 NPC 批处理，不能整文件删除。 |
| 旧 NPC Round / Reaction 调度 | 当前宿主设置 `externalCharacterActivations: true`，没有传入旧 participants / reactionParticipants；旧 Worker 的装配条件被该选项排除 | **默认入口已绕开，源码和 API 保留。** 实际 NPC 调度由 PrototypeCharacterTurn 和 runPrototypeActivations 完成，后者也已支持动态调度。 |
| Phase8ContextPipeline、Checkpoint、Context Receipt | WorldApplication 的分支装配仍按 Manifest 的 agent-context 插件创建它们，未依据 externalCharacterActivations 跳过；真正的 prepare 调用位于旧 participant 路径 | **有装配、当前 NPC 不消费。** 有建库和资源装配成本，但不能据此声称当前角色请求具备旧 Context 的精确重建能力。尚未测量这部分耗时。 |
| 旧 Provider Call / Quality | 同样在 WorldApplication 中创建并传给 Coordinator，实际 NPC 模型请求由当前宿主回调调用 | **旧 NPC 调用账本未覆盖新角色路径。** 当前请求检查器和创作者调用记录是另一路诊断，不能把两者混成同一套恢复或质量退避机制。 |
| 七类结构化主观状态与 Reflection | 编译器可以生成初始认知事件；PrototypeCharacterTurn 每次读取 CognitionProjectionRebuilder。旧 ReflectionPolicyValidator.evaluate 接在 Coordinator 的 participant 输出上，新决策协议只提供 perform / publish / abstain 及有条件的 recall | **读入保留，旧模型更新回路未接入新 NPC 协议。** 作者初始目标、态度等仍有价值，但不能宣称它们会由旧 Reflection 在正常游玩中持续更新。角色仍可通过历史和 Core 认识形成主观变化，不能由此推断角色完全不会成长。 |
| 原生 Memory 与 Core | Core 模式不给 PrototypeCharacterTurn 传原生 prepareStimulus / recall；但 PlaytestMemoryCore 从同一 memory.sqlite 的 cognitive_memory_v2_sources 读取授权来源，调用 catchUpReceipt | **两套用途交织，不能整包废弃。** 原生召回在 Core 角色路径上关闭；授权 Source 捕获仍被 Core 复用。原生模式也仍是显式支持入口。 |
| 原生 Cognitive Job / L1 Summary | Coordinator 装配 cognitiveMemory，并在启动和玩家提交后 processCognitiveJobs；捕获过程仍保存原生 Source、Summary、Receipt | **Core 模式仍实际运行的继承工作。** 可调查 Source 捕获和原生摘要是否需要继续绑定，但不能直接删除任务或 memory.sqlite。未证明存在可感知性能损失。 |
| Director 与 Presenter | WorldApplication 仍创建 BranchDirectorComponent；当前宿主没有注册 director participant。组件同时持有 Presenter，后者由独立 renderPending API 使用 | **当前 NPC 玩法没有 Director 模型控制。** 保留装配不等于导演能力已接入；Presenter 也不等于前端情景舞台。 |
| archive / logical transfer / snapshot | WorldApplication 仍公开这些接口；故事节点与末端重新生成主要使用 desktop 的副本、备份和恢复代码 | **当时有意保留的接口。** G4 已记录保留理由，不是忘记删除；当前故事功能的存在也不证明这些旧 API 都是它的必经路径。 |
| 旧协议类型、注册名称与测试 | 仍有 SubmitActionsV2～V6 类型、phase8 命名和旧 profile；当前新 NPC 不走 submit_actions/v7，旧 Coordinator / Scheduler 才使用其校验器 | **一部分是历史类型，一部分是仍被复用的格式身份。** 文件叫 phase8、字段叫 V2，并不能证明当前支持旧版本，也不能作为直接删除依据。 |
| 生产宿主所在目录 | package.json 的 experience:web、Launcher 构建与游戏启动仍指向 tests/experiments/playtest-web-entry.ts | **实验宿主已承担正式运行职责，目录没有收口。** tests/experiments 与 experiments 内既有历史实验也有当前必需代码，不能按目录整批清除。 |

主要源码：

- [宿主装配与激活](../../../tests/experiments/playtest-frozen-runtime.ts)：WorldApplication 的选项、角色请求回调、#activateCharacters。
- [WorldApplication](../../../packages/application/src/world-application.ts)：WorldBranchComponentFactory.create、externalCharacterActivations、分支组件和保留 API。
- [RoundCoordinator](../../../packages/application/src/round-coordinator.ts)：processCognitiveJobs、participant 模型处理、Reflection 与提交。
- [新角色循环](../../../packages/application/src/prototype-character-turn.ts)、[新调度](../../../packages/application/src/prototype-activation-cycle.ts)：实际 NPC 决策与结果提交。
- 旧 `packages/application/src/context-pipeline.ts`、`reaction-scheduler.ts`（第二步已删除，见 Git 调查基点）。
- [Core 桥](../../../tests/experiments/playtest-memory-core.ts)：#snapshot、授权 Source 查询与 catchUpReceipt。
- [角色请求协议](../../../packages/provider-chat/src/prototype-turn.ts)、[认知初始事件编译](../../../packages/world-pack/src/compiler.ts)、旧 `packages/agents/src/reflection.ts`（第二步已删除）。

## 用运行追踪验证“装配但没用”和“确实还在运行”

Evidence E1：读取上述源码和当前入口调用关系。

Evidence E2：在两个全新数据目录中分别启动当前 prototype-g1 小世界，发送一次 `/act speak {"text":"大家好。"}`。本机 HTTP 夹具按角色先返回一次 publish、之后 abstain；Core 组注入空 Delivery 的脚本 runner，不运行 Python、E5 或真实模型，不触发长期整理。诊断 wrapper 只计数并原样转调方法。

| 指标 | 原生模式 | Core 模式（脚本空 Delivery） |
| --- | --- | --- |
| 完成情况 | 无 error，正常结束 | 无 error，正常结束 |
| NPC 模型夹具调用 | 3 | 3 |
| Phase8ContextPipeline.prepare / prepareReaction | 0 / 0 | 0 / 0 |
| ReflectionPolicyValidator.evaluate | 0 | 0 |
| CognitiveMemoryService.processPending（含启动） | 5 | 5 |
| CognitiveMemoryService.prepareStimulus | 3 | 0 |
| CognitiveMemoryService.catchUpReceipt（含启动） | 9 | 9 |
| context_receipts / continuity_checkpoints / provider_calls 行数 | 0 / 0 / 0 | 0 / 0 / 0 |
| world_reaction_cycles / world_reaction_jobs 行数 | 0 / 0 | 0 / 0 |
| world_cognitive_jobs 行数 | 6 | 6 |
| cognitive_memory_v2_sources / summaries 行数 | 12 / 3 | 12 / 3 |
| cognitive_memory_v2_recall_receipts 行数 | 3 | 0 |

Finding F1（E1、E2）：旧 Context、旧 NPC 调用账本、旧 Reflection 与耐久 Reaction 在这个现行角色回合中没有执行记录；原生认知任务和来源捕获确实还在运行。Core 跳过了原生召回，没有跳过原生授权来源层。

Path P1：后续若做减法，优先核对 WorldApplication 的装配条件和玩家提交需要的最小部分；保留当前 Source 的权限和来源校验。此次证据不足以支持整包删 agents、memory、store，或重写数据库。

这是一条短场景机械追踪，不证明所有活动、自然语言输入、旧 API、长局或发布版本都具有相同行数；processPending 次数也不能解释为五次 LLM 调用。这些工作主要是本地存储和投影。没有做性能对照，不将“仍在运行”自动定性为性能瓶颈。

本机复现产物（临时诊断，不进入运行时或默认测试）：

```powershell
node --import tsx .tmp/phase8-prototype-audit/trace.mjs
Get-Content .tmp/phase8-prototype-audit/result.json
```

脚本和结果位于本工作树 `.tmp/phase8-prototype-audit/`，不纳入此次文档交付。脚本依赖调查时的旧服务，第二步删除后不能直接在现行源码运行；复核旧追踪需使用调查基点。没有这些临时产物的其他 checkout，可沿 E1 的 Git 源码位置复核静态结论；上表不是跨环境性能基准。

## 文档为什么也容易造成“停在半途”的感觉

Evidence E3：[原型契约](../prototype-contract.md) 顶部仍保留 Proposed、首次交付未实现等起始文字，后面又追加多轮进展，末段还保留旧的 G0～G4 未通过状态；[G1/G2 记录](../../archive/prototype-g1-g4/PROTOTYPE-G1-G2-ACCEPTANCE.md) 仍列 G2-1 格式修正待办。

Evidence E4：当前 PrototypeCharacterTurn 已提供 reserveFormatRetry，宿主调用 [decideActivityFormat](../../../tests/experiments/pack-activity.ts) 在预算内进行格式修正；[当前架构入口](../architecture/README.md) 已解释新的实际调用链与发行范围。

Finding F2（E3、E4）：一些历史“未完成”只是记录没有跟随实现收口，不能继续作为当前待办；另一些确实是更新回路或默认入口没接上。仅按旧清单补功能，会误把已经改道的设计重新装回当前运行时。有界非法输出诊断的完整 G2 验收本次未逐项复核，不在此宣布通过。

Path P2：现行能力以当前架构和源码为主；契约保留方向及历史证据，但应把起始状态、后续进展和现状分开。G4 历史报告保留当时的决定，不通过改写它宣称后来已完成。

## 本轮确定的处理边界

2026-10-18，按用户“先确定”进入取舍设计。本节保留当时确定的收敛方案，**空装配清理与旧 NPC 执行退役保留；初始心理呈现尝试因对照结果已撤回**，具体见文末。不要求逐项恢复 Phase 8，也不以清空历史代码为目标。

### 角色心理：保留内容，退出通用状态机目标

例如创作者设定“她起初对玩家有戒心，想先弄清自己为什么来到这里”。这是人物起点。一起生活后，角色可以依据自己的经历变得亲近，也可以继续怀疑；开局的戒心字段不能成为程序永远宣告“她现在仍然戒备”的依据。角色昨天说“明天给你做饭”，应保留说过这句话的经历；这不自动证明承诺已兑现，也不强迫她第二天执行。

采用以下边界，不增加新的数据层或 Schema：

| 内容 | 处理决定 | 明确不承诺的能力 |
| --- | --- | --- |
| 性格、价值倾向、说话方式 | 保留作者人设，用于长期扮演 | 不从一次模型情绪波动自动改写永久人设 |
| 初始信念、关系态度、情绪、矛盾、目标、承诺、未解问题 | 保留作者可表达这些内容的能力；已有 cognition 数据与权限读取先保留。后续模型呈现应明确其初始设定性质，结合新经历理解 | 不把种子中的 active、强度、优先级当成一直有效的当前心理裁定；不要求作者填写七套状态 |
| 游玩中形成的认识、偏好、关系感受和重要承诺 | 由授权经历、近期上下文及现有长期记忆延续；模型决定如何理解和行动 | 不恢复每轮七类心理写回、独立 Reflection 模型调用、心理 Receipt 或固定关系分数；记忆形成的认识也不保证总能被正确整理和召回 |
| 瞬时情绪、犹豫、姿态、即时意图 | 允许自然表达；重要表达按现有受众成为经历 | 不要求每个细节进入持久状态或后台整理 |
| 玩法明确追踪的任务、关系资格、同意或约定标志 | 继续通过既有活动、交互、规则和事件更新；例如任务是否交付、是否建立受控接触关系 | 不把“她觉得我们很亲近”转换成机制关系，也不从 Core 的推断直接改变任务和权限 |

因此，**保留目标作为行动动机；退出“平台自动维护通用七类心理状态”的当前建设目标；旧 Reflection 不作为等待补接的产品欠账。** 旧结构化记录先保留用于已有内容与事件读取，但不再围绕它扩展动态心理系统。若后续明确玩法需要追踪某项目标的完成，使用该玩法已有机制，不先建立通用 Goal 引擎。

这里确定的是旧心理字段应承担的职责：从看起来会持续自动更新的状态，收敛为作者初始材料。第三步曾尝试具体呈现，但第四步对照后已撤回；这项职责取舍没有被取消，现行呈现的限制仍保留。不能靠增加一句提示就宣称角色变化和记忆延续已经验收。

### 旧路径：一个 NPC 主循环，保留共享提交能力

| 部分 | 决定 | 后续实施边界 |
| --- | --- | --- |
| PrototypeCharacterTurn、runPrototypeActivations、现有动态调度与自主机会 | 保留为当前 NPC 主路径 | 活动与普通场景可以有不同策略和预算，仍复用现有执行、授权与提交机制 |
| WorldApplication、RoundCoordinator 的玩家输入与提交部分 | 保留 | 不因它们包含旧 NPC 逻辑就整类删除，不预先重做宿主框架 |
| 旧批量 NPC participant、ReactionScheduler / Worker、Director 模型路径 | 退出当前产品支持范围，列为后续切除对象 | 保留现行 Creator 交互扩展能力。切除前处理实际实验消费者及仍有价值的断言，不维护双 NPC 协议 |
| 旧 Context Pipeline、Checkpoint、Context Receipt、NPC Provider Call / Quality、Reflection | 随旧 NPC 路径退出；默认玩家提交不应再为空 NPC 管线装配它们 | 玩家意图解释自身的校验、调用处理和晚到响应边界继续保留，不能因为同库或同名 provider 就一并删除 |
| 耐久 Reaction Cycle / Job 及旧 DTO | 先切断旧调度接线，再按实际引用清理 | 当前存档中已有事件的读取、当前玩家输入任务与原子提交不随它们退役；不在未盘点数据前删表或删事件解释器 |
| 当前创作者请求与调用记录 | 保留 | 本机诊断继续走现有宿主权限；不恢复完整精确请求重建、外部调用精确恢复或旧质量退避作为默认承诺 |

保留公开交互、规则和宿主插件扩展能力，不等于继续支持已经退出玩法的整套 NPC 调度。外部接口的存在本身不足以让两套角色运行时永久共存。

### 记忆：Source 继续复用，原生模式继续可用

Core 是正常游玩默认路径，原生模式继续作为显式可选入口。两者共用现有授权来源捕获和校验，不增加第二套 Source 存储或新记忆服务接口。

本轮**不拆 Cognitive Job、L1 Summary 与捕获的绑定**。它们仍在运行，Source 又被 Core 实际消费；尚无耗时证据支持此时改动。后续若证实未被消费的摘要或重复工作影响等待，再局部拆开生成条件，同时保留角色、分支、事件前缀和来源校验。无需为完成旧 NPC 清理顺带重写 Memory。

### 其他遗留：明确保留，避免顺势扩张

- 世界事件、权限视图、Rulebook、交互扩展、短事务和原子提交继续保留，构成各条玩法共享的事实边界。
- archive / logical transfer / snapshot 独立 API 延续当时明确保留的决定，此轮不删除、不扩大，也不将未验收 API 宣传为故事节点功能。Presenter 先按现有独立展示消费者处理，不与 Director 模型同时删除。
- tests/experiments 内正在运行的网页宿主属于生产代码。迁目录单独延期；先消除行为分叉，不借整理目录重建一层 Host 框架。
- 旧版本类型、Golden 与测试仅在没有当前消费者、且仍有价值的权限和提交断言得到保留后清理。仍被当前世界格式引用的名称、ID 和类型不为“去 Phase8 化”重命名。

### 补充证据与实施顺序

Evidence E5：按各包 worldpack.source.json 的 sourceSchemaVersion 和 cognitionFiles 扫描当前 v5 示例。[官方包](../../../examples/world-packs/model-girls-official/cognition.json)七类主观状态数量均为 0（仍有初始观察）；[晚宴包](../../../examples/world-packs/model-girls-dinner/cognition.json)有 4 个初始目标，其他六类为 0；character-autonomy、dynamic-scheduling、通信等示例主要使用初始目标。ai-girls-awaken-v10 和 ai-girls-hosted-guess 仍各有完整七类材料。

Finding F3（E1、E5）：当前作者能力确实使用初始目标，不应一起砍掉；这份样例分布也不足以证明没有七类字段时真实体验必然足够好。可确定的是，没有证据要求为了旧完整心理模型补回通用动态更新回路。

Evidence E6：调查基点的 `tests/experiments/v10-provider-gate.ts` 注册旧 participants 与 reactionParticipants，是真正的实验调用者；第二步已将它退出可执行入口。[World Pack CLI](../../../packages/world-pack/src/creator-cli.ts)仍实例化 WorldApplication 用于 activate，不能删除共享应用入口。

Finding F4（E1、E6）：旧 NPC 路径属于默认产品外的实验消费者范围，不属于全仓无调用代码。退役是本轮的设计取舍，实施时应将有用的协议诊断迁到当前入口，或明确归档该实验，不能靠忽略引用完成删除。

Path P3：若进入实施，先在**不改变模型 Context、存档格式与玩家结果**的条件下，收紧 WorldApplication 的空 NPC 装配；下一步处理旧 NPC 实验消费者并切除旧调度与协议；然后单独调整初始心理材料的模型呈现和说明。Source、存储格式、保留 API 和目录迁移不捆绑进入第一步。

验证按实际改动选择：第一步核对玩家输入、授权 Source、NPC 执行续写、观察隔离及已有故事节点路径；切旧逻辑时保留其仍有诊断价值的断言；改心理 Context 时另做有初始目标和初始情绪的真实模型连续试玩。不能把更少的装配或测试通过表述为角色已经更自然。

接受的限制是：当前没有程序保证所有主观状态都持续结构化更新；重要承诺和目标可能被模型遗忘或整理遗漏；瞬时心理不保证跨重启精确恢复。它们应以真实体验证据决定是否需要后续改进，不以完整 Phase 8 实现作为完成原型的前置条件。

取舍设计阶段只补充了处理边界和源码证据，未新增玩法机制、未删除旧能力、未修改存档。未验收叙事自然度、长局表现、Python Core 质量、旧保留 API 或发行包。

## 第一步实施记录：跳过空 NPC 装配（已被第二步替代）

2026-10-18，用户确认执行后完成。本步仅修改 [WorldBranchComponentFactory.create](../../../packages/application/src/world-application.ts) 的装配条件：Manifest 启用 Context 且存在显式 Round 参与者或应用内 Reaction Worker 时，才创建 Phase8ContextPipeline 及旧 NPC Provider Call／Quality。CognitiveMemoryService、启动及提交后的认知任务继续装配和执行。

没有注册旧参与者、并由外部单角色循环处理 NPC 的网页宿主，现在跳过这些对象及其 Context 连接。它仍会通过 PlayerIntentWorker 按需打开 context.sqlite，专门保存玩家输入解释的调用记录；同库也会创建现有表结构。因此不以该文件或旧表存在与否判断默认 NPC 管线是否在运行，也不迁移或清空已有数据库。

Evidence E7：[player-only-assembly.test.ts](../../../tests/prototype/player-only-assembly.test.ts) 的最小回归在修改前失败：挂载玩家分支就创建了未使用的 context.sqlite。修改后该用例通过，且玩家发言能幂等提交、授权 Source 中出现新发言，没有创建耐久 Reaction Cycle。另两项验证显式 Round 参与者仍可收到请求并留下 Context Receipt 和已提交调用记录；仅注册 Reaction 消费者时原 Worker 仍能正常挂载并返回 idle。本步保留后两类旧消费者，供下一步迁移或归档，并未宣布它们已经退役完成。

Finding F5（E7）：跳过的是没有消费者的旧 NPC 对象，不是共享的记忆捕获、玩家提交或现有旧接口；无需新增开关、协议、存储或兼容路径。

Path P4：下一步按既定边界处理旧 NPC 实验消费者和调用链，再切除旧调度与协议。心理 Context 呈现、Source／摘要绑定、独立备份接口与目录迁移不捆绑在本步。

本步验证：

- `corepack pnpm@11.7.0 typecheck` 通过。
- `corepack pnpm@11.7.0 lint` 通过。
- 相关回归共 8 个文件、128 项通过：player-only-assembly、g1-combination、perform-continuation、scene-decision、raw-history-delivery、player-source-evidence、playtest-memory-core、story-nodes。它们覆盖当前提交与幂等、私语与移动观察边界、物品执行续写、原生授权来源、Core 桥及故事节点恢复与分享；Core 使用脚本 runner，不是 Python／E5 或真实模型质量验收。
- 当前架构和本报告的本地链接检查通过。

没有修改模型 Context、角色协议、裁定或事务提交，也未修改存档格式。未运行全仓测试、硬崩溃套件、真实模型试玩或发行构建；本步不能证明角色更自然或有可感知的加速。

## 第二步实施：退役旧 NPC 执行，保留玩家提交与来源

2026-10-18，按用户“好，开始吧”实施。玩家说“请把伞给我”时，仍先提交玩家输入，再由当前单角色循环决定是否交接；交接由已安装的交互定义和规则裁定，成功后角色才续写结果。本步删除的是另一套不再服务默认玩法的 NPC 执行与装配，不增加新的角色协议或记忆层。

| 范围 | 实际处理 |
| --- | --- |
| WorldApplication／RoundCoordinator | 移除 participants、reactionParticipants、externalCharacterActivations 及旧 NPC／Director 调用；Coordinator 仅提交玩家行动，保留输入任务、幂等、权限、裁定、授权观察与原子提交。分支 Presentation 组件保留确定性 Presenter，Cordis 服务名暂留。 |
| 旧 NPC 服务 | 删除 ReactionScheduler／Worker、Context Pipeline、Context／Receipt／Checkpoint、Reflection、旧模型预算与调用／质量退避服务及专属测试；移除相应导出和 provider 接口。 |
| agents 包和存储 | 保留玩家意图调用记录、ContextDatabase 连接和历史玩家输入中的 manifestation 解析；不删共享表、不迁移存档，不删旧世界事件、Authority 和 Reaction 数据读取。 |
| 当前模型适配 | 删除旧 propose／submit_actions/v7 请求生成；当前 perform 工具直接生成授权 move／interact 参数 Schema，不再先生成旧 action group 再提取。消息、提示和参数内容保持一致。 |
| 记忆及保留 API | 授权 Source、Cognitive Job／L1 Summary、Core 和显式原生模式继续运行。archive／logical transfer／snapshot 独立 API 保留；心理材料模型呈现及宿主目录没有调整。 |
| 遗留未完成调度 | 保留读取和显式取消请求。取消仍只写 stop_requested，当前不再有旧 Worker 完成结算；运行时拒绝恢复旧 Reaction Cycle，也拒绝在其未结束时提交新的玩家行动。不自动补跑模型、伪造结算或抹掉旧数据；若确有这类迁移对象，需单独确定处理。 |

旧 `tests/experiments/v10-provider-gate.ts` 已退出现行可执行入口，它依赖整套已退役的 participant／Reaction 协议。需要研究当时请求和诊断时，从调查基点读取：

```powershell
git show 7a141c0:tests/experiments/v10-provider-gate.ts
```

该记录保留可恢复来源，不承诺旧脚本能在当前运行时启动。当前请求和执行诊断继续使用现有单角色入口与创作者调用记录。

Evidence E8：[player-only-assembly.test.ts](../../../tests/prototype/player-only-assembly.test.ts)验证无旧 NPC 资源的玩家提交、授权来源、幂等、重开后历史读取，以及真实旧 Cycle 记录可读但未完成工作被拒绝；也验证维护前完成已受理玩家工作与交付、退出维护后继续提交，遇旧 Cycle 则拒绝进入维护。[interaction-package-turn.test.ts](../../../tests/prototype/interaction-package-turn.test.ts)将原旧 NPC 集成测试中的规则与绑定断言迁到当前角色：先提交玩家请求，再让 NPC 按实际授权选项拿取伞、裁定成功后发表、只发生一次物品归属变化，并对照裁定使用的 definitionSetHash。当前 NPC Authority 保持其已有最小形状，没有为了旧测试新添玩家 Authority v6 元数据。

Evidence E9：传输适配测试改用现行 decide 调用，保留鉴权、错误、解析、超时／取消及本机格式边界；wire 测试直接检查目标枚举、交互绑定与参数限制。临时 before／after 对照对 10 组角色请求逐项比较消息、提示和工具 Schema，内容一致。旧专属协议测试删除，不再以旧 v7 校验器作为当前表达验收；叙事测试改查现行表达片段和权威规则边界。

Finding F6（E8、E9）：当前 NPC 只保留现行单角色决策路径，共享玩家提交、事实裁定与授权记忆来源仍可独立运行。没有因清理而补回旧心理写回、精确请求恢复或双协议兼容。

本步验证结果见下方最终核对记录。自动化使用脚本模型和测试临时数据，没有调用真实模型、运行 Python／E5 质量验收、读取历史试玩库、制作发行包或提交 Git。更自然的角色互动、更低等待和长局记忆质量均不由本步自动化证明。

Path P5：下一步单独调整七类初始心理材料在模型 Context 中的呈现，明确它们是作者起点，再用含初始目标、情绪与后续经历的真实模型连续试玩验证。Source／摘要解耦与宿主迁目录仍按既定边界延期。

### 第二步最终核对

- `corepack pnpm@11.7.0 typecheck`、`corepack pnpm@11.7.0 lint` 通过。
- `corepack pnpm@11.7.0 test --maxWorkers=1`：69 个文件、586 项通过，包括原型玩法、记忆来源、故事节点、末端回合及强制中断恢复用例。这是当前原型默认套件，不是全部历史测试。
- `corepack pnpm@11.7.0 test:related packages/application/src packages/agents/src packages/provider-chat/src packages/runtime-cordis/src tests/player-intent.integration.test.ts tests/interaction-pack.integration.test.ts --maxWorkers=1`：23 个文件、99 项通过，补充提交协调、玩家解释、传输、生命周期和交互扩展验证。
- `player-only-assembly.test.ts` 单独复核 4 项通过，包含维护排空与旧未完成 Cycle 拒绝路径；`interaction-package-turn.test.ts` 已包含在默认套件中。
- `node scripts/docs/check-links.mjs` 通过：12 页、373 个本地链接，模块地图完整；本报告另检查 26 个本地链接通过。
- 10 组当前模型请求改前／改后对照一致；没有新增当前 NPC Context 字段或改变调用提示。

首次全套运行时仍在改源码，导致运行时身份保护报“代码已改变”，沙箱也拒绝硬终止用例的 taskkill；这些失败未通过修改断言或跳过用例处理。上述最终结果来自行为代码收束后、允许终止测试自建子进程的环境。测试只操作新建临时目录；没有扫描或迁移历史用户存档。

## 第三步实验记录：初始心理材料的模型呈现（已撤回）

本节保存当时实现与短试玩的历史证据。它们没有完成改前对照；后续对照发现退化迹象，相关源码与专属测试已经撤回，不能将本节描述当作当前实现。现状以第四步收尾记录为准。

2026-10-18，按用户“行继续吧”实施。作者写“她开局焦虑，想先拿到桌上的钥匙”，后来钥匙已经交到玩家手上；本步让开局材料明确作为人物起点交付，避免程序把未写回的 active、焦虑强度和优先级包装成实时心理裁定。没有新增心理模型、状态机、结构化写回、数据库或协议版本。

### 改了什么

仅修改 [characterRequestText](../../../packages/provider-chat/src/character-context-text.ts) 的最终模型呈现与既有上下文说明。宿主内部 request.context.cognition、作者 cognitionFiles、投影、规则、Source、Core 档案与原生记忆查询条件均保留。

| 交付内容 | 最终模型文本中的处理 |
| --- | --- |
| 作者七类初始材料 | 按既有 value.source.sourceKind 的 worldpack-claim／goal／relationship／affect／tension／commitment／open-loop 的 v2 来源识别，进入 context.initialCognition。内容、来源性质、初始状态和数值保留，但明确表示起点。 |
| 其他已有认知 | 进入 context.recordedCognition；包含历史 Reflection、作者声明初始事实形成的认知等，不误标为心理种子，不承诺实时更新。 |
| 空材料 | 省略空章节，旧的模型文本 context.cognition 不再发送。没有保留双格式兼容分支。 |
| 人设、经历与事实 | 人设继续用于扮演；角色依据本人授权经历和记忆理解变化。初始目标仍可成为动机，初始承诺可能是自我打算，是否说过或兑现以实际经历为据；受控事实仍经 Action／Rulebook／Event。 |

这两个名称替代原先来源未区分的模型 cognition 呈现，不是新增一套认知存储。它们也不保证模型一定合理理解每一次变化，程序没有开始替角色判定感情或目标状态。

Evidence E10（撤回前）：当时的 character-context-text.test.ts 增补用例覆盖七类种子、历史记录和初始事实分流、元数据去除、空章节及原请求不变。专属 `tests/prototype/initial-cognition.test.ts` 与 `tests/fixtures/initial-cognition-pack.ts` 编译真实世界、提交玩家请求，让 NPC 实际拿取钥匙并续写，检查私密材料、保管与原始认知事件。这些增补用例和专属文件已随实验撤回；临时备份位于 .tmp/phase8-comparison/withdrawn，不是当前测试入口。

### 指定模型与真实 Core 试玩

使用用户授权的 OpenCode Key，先由模型列表接口确认 `deepseek-v4.1-flash` 可用，再用同一模型执行角色决策和 Core 整理。Key 仅从环境读取，不进入源码、报告或运行参数；两组新实验目录的凭证扫描均未检出 Key。临时本机转发仅用于给 OpenCode Go 请求附上稳定的 x-opencode-session，不代表生产宿主已经增加 OpenCode 专用接入。

Evidence E11：[脱敏轨迹及核对数据](initial-cognition-playtest-20261018.json)包含两组各 8 回合的输入、角色表达与权威保管变化。每组都使用全新合成包和数据目录、真实 Python／E5 Core，6 回合后手动整理两个角色的长期档案，关闭并重开后继续 2 回合。没有读取历史玩家存档。

| 场景 | 角色调用／Core 调用 | 权威事实与可见行为 |
| --- | --- | --- |
| 公开对话 | 19／6 | 留守者先拿钥匙，第 4 回合实际交给玩家；同行者承认钥匙已不在桌上，没有照着初始目标继续从桌面拿。重开后能回忆由留守者交接。 |
| 定向对话（最终提示版本） | 10／6 | 同行者第 2 回合实际拿取、第 3 回合交给玩家，均裁定成功后续写。第 6 回合承认钥匙本身已处理完，转而关心用途与其他线索；重开后正确回忆“我拿了，后来给了你”。留守者只述说自己观察到的两次交接，没有复述私下对话。 |

合计 16 回合、29 次角色调用、12 次 Core 调用；41 次请求均 HTTP 200，未出现角色 JSON 解析失败，4 份角色档案安装成功，两组事件完整性检查通过。两组私有暗号均未进入另一角色请求。全程初始目标仍为 active、初始焦虑仍为 850，七类认知事件和原始材料没有改写；可见行为能依据后续事实调整，不依赖程序自动标记目标完成或调低情绪。

公开组在最终补充“初始自我承诺不证明已经说给别人”的说明前运行，定向组使用最终说明。两组是不同受众场景，不是受控的改前／改后 A/B；不能据此声称所有自然度收益都由本次呈现调整造成。没有压低初始材料权重或写回心理状态来制造通过结果。

Finding F7（E10、E11）：初始作者材料仍能牵引人物动机，但不再由模型文本的外层结构宣称它是实时心理快照。此短场景中，角色可以承认保管变化、停止重复拿取，且在 Core 整理和重开后延续自身经历；这不等于长期人物成长或态度变化已全面验收。

Finding F8（E11）：语义一致性仍有限制。公开组第 3 回合留守者只 publish“交给你”，没有执行 give，权威保管到第 4 回合才改变；这是叙事提前声称结果的体验失败，不能因数据库未变而算通过。还出现重复追问钥匙用途、反复强调自主权等表现。它们没有通过新增心理写回、语义分类器或强制行为策略处理，本轮不宣布自由叙事一致性已解决。

### 验证和复核

- 最终 `corepack pnpm@11.7.0 typecheck`、`corepack pnpm@11.7.0 lint` 通过。
- 最终相关回归 15 个文件、160 项通过：provider-chat 包、initial-cognition、local-prototype-turn-call、g1-combination、playtest-memory-core、raw-history-delivery、model-presets、perform-continuation、scene-decision、cross-scene-core-memory。覆盖最终模型文本、预设、供应商适配、执行续写、Core 交付与观察隔离。
- 当前架构及本报告的本地链接检查通过，模块地图完整。
- 本步没有修改事务、进程中断或恢复边界，没有重新运行硬崩溃或全仓历史套件。第二步的原型全套结果保留为当时证据，不冒充第三步的全套结果。
- 当时真实试玩由 writeInitialCognitionPack 创建合成包，使用独立目录、同模型、memoryCore=true、单波与每角色一次激活、最大 4 次 NPC 调用；按脱敏轨迹输入分别使用公开表达和 direct，第 6 回合后手动整理、重开，再继续。该专属测试与夹具现已撤回，保存的实验包及临时备份仅用于研究复核，不是现行产品入口。不要复用原存档或把叙述当成已交接证据。
- 本机临时驱动与完整请求位于 .tmp/initial-cognition-20261018；没有纳入生产宿主或默认测试。报告中的脱敏轨迹随源码保留。未制作发行包，未提交 Git。

Path P6（当时结论，已被第四步修正）：第三步短试玩不足以说明改动没有引入退化；完成改前对照后再确定交付范围。不把这些体验问题重新展开成通用七类心理状态机。

## 第四步收尾：改前对照与撤回第三步

用户确认“先做同场景对照，再准备提交”后，补做[配对轨迹与固定上下文复放](phase8-cognition-comparison-20261018.json)。结果不支持将第三步直接作为无退化改动交付，因此撤回它，最终只保留前两步旧 NPC 执行清理。

### 对照如何隔离改动

将同一份当前运行时临时打包为两个版本，只把 character-context-text.ts 替换为调查基点 `7a141c0` 的内容或第三步内容。223 个依赖路径一致、工具 Schema 一致，玩家提交、规则、记忆与调度使用相同代码。该对照隔离的是心理呈现变化，不是把整套旧 NPC 执行重新装回运行时。

两边使用同一合成包、相同初始认知、相同 8 条公开输入、单波／每角色一次激活／最多 4 次 NPC 调用、temperature=0 及固定调度随机种子；各自在全新目录运行，使用 OpenCode 的 deepseek-v4.1-flash 和真实 Python／E5 Core，第 6 回合后整理档案、重开并续话。串行调度用于减少本次对照中的并发分叉，不修改生产默认调度。模型在相同采样参数下仍可能波动，此实验不估计总体失败率。

两组各 18 次角色调用和 6 次 Core 调用，HTTP 均成功，各安装两份档案，完整性检查通过，未检出另一角色的私有暗号。改前第 3 回合实际交接；第三步版本第 3 回合只发表“给你”，第 4 回合才交接，出现应进一步核对的差异。

### 相同上下文复放与取舍

取上述两组第 3 回合同行者的上下文，在同一个已知保管前缀下分别用两种呈现调用模型。用原呈现重新序列化后与捕获输入逐项相等，Schema 相同；交换调用次序，每个上下文重复 3 次。此处只观察返回选择，不向世界提交结果。

| 对照 | 选择 perform／总调用数 | 解释 |
| --- | --- | --- |
| 改前 vs 原第三步 | 5/6 vs 0/6 | 第三步出现明显的“只表达、不当场操作”倾向，并有 publish 中直接声称钥匙已归玩家保管的样例。 |
| 改前 vs 精简说明 | 4/6 vs 3/6 | 精简有所恢复，但小样本不足以确认已消除影响。 |
| 保留原 cognition 布局，仅给初始记录加标记 | 1/6 | 更小的结构替代也没有稳定恢复该场景的行动选择，未写入生产。 |

另外 8 次有界说明文本对照同样未形成可靠的交付依据，具体结果保留在证据中。没有继续扩大提示修补矩阵，也没有增加强制行动、语义分类器、模型审查阶段或心理状态机。

选择 publish 本身不是失败：角色可以拒绝、询问或只表达；这里关注的是实际交接请求的回应，以及在未执行时声称已交接的叙事问题。改前也能返回类似表达，因此问题本来就可能出现；但原第三步加重了这种倾向，不能据此保证它与改动无关。已有问题不构成接受新退化的理由。

### 最终保留与撤回

- 保留第一、二步：玩家提交及授权 Source 不变，删除旧 NPC participant／Reaction／Context／Reflection／调用服务与专属旧协议测试，保留世界历史、共享表结构、玩家意图调用、Presenter 和已明确保留的独立 API。
- 将 character-context-text.ts 与其测试逐字恢复到改前版本；删除第三步新增的 initial-cognition.test.ts 与 initial-cognition-pack.ts，避免留下未使用的专属测试和夹具。模型仍发送原有 cognition，不能宣称初始材料呈现问题已解决。
- 第三步的原始轨迹与本次对照作为研究证据保留；当前架构、原型契约及作者指南撤去已落地的错误表述。本地备份与临时驱动留在 .tmp，均不进入运行时或提交范围。
- 对最终保留版本再核对 10 组请求，消息、系统说明与工具 Schema 均与旧 NPC 清理前一致。类型检查和 lint 通过，相关包／玩家／交互回归 23 个文件、99 项通过；原型默认全套最终结果见后续交付核对。

初始材料的职责取舍仍保留为设计方向；它的具体模型呈现尚待更稳妥的方案。本轮不同时迁移宿主目录或拆 Source／摘要。此前“第三步完成”只基于短试玩与自动化，缺少改前对照，结论过早；本节修正该结论，而不改写旧实验结果。

### 最终交付核对（2026-10-19）

为排除其他任务同时修改源码的干扰，从固定提交 `992f4b56f35970cc0a85a6e4ae05034c9735f6f1` 导出临时副本，只覆盖本轮 65 个文件（31 个修改、5 个新增、29 个删除）。该提交已包含其他任务提交的状态事件登记；其他任务尚未提交的研究和探针改动没有带入。依赖复用已安装的外部包，工作区包与运行时代码来自副本；Python／E5 使用明确的本机安装路径。没有改变原工作树、索引、分支或远端来完成隔离。

- 固定副本原型默认套件：69 个文件、587 项全部通过，用时 342.52 秒。包括活动、故事节点导出／导入、权限来源、事务与硬终止恢复测试。
- 固定副本相关包及玩家／交互回归：23 个文件、99 项全部通过。
- 固定副本类型检查、lint 通过；当前文档及副本文档导航检查均通过：12 页、373 个本地链接，模块地图完整。本报告另核对全部本地链接。
- 第三步撤回后的 10 组模型请求与旧 NPC 清理前一致；心理呈现源码及原有测试无 Git 内容差异，专属测试与夹具已删除。

此前在共享工作树运行完整套件时，活动测试遇到“运行代码已改变”，期间另一个任务确实提交了内核源码；另有一项故事节点测试只报告了泛化的 Core 初始化失败。固定副本在明确配置 Python／E5 后，两组测试均通过。初始化失败没有保留足以确定原始根因的诊断，因此只确认本次隔离验证未复现，不把它归因为已证明的某个原因。没有通过放宽断言、跳过用例或改写世界数据取得通过。

上述核对完成后，65 个文件已作为 `68980de` 提交到 `codex/tavern-card-slice`；该次交付未合并 `main`、未推送。临时快照、模型完整请求、试玩目录和撤回备份不在范围内。真实模型对照仅支持撤回第三步的取舍，不证明长期角色体验已全面验收；未制作发行包，未扫描、迁移历史存档。旧未完成 Reaction Cycle 的恢复、宿主目录整理、Source／摘要解耦与初始心理呈现仍是明确保留的限制或后续工作。

### 与状态系统整合的合并前审查（2026-10-19）

在独立工作树中以本地 `main` 的 `a9caca9` 为基点整合 `68980de`，排除原工作树未提交的酒馆卡研究、探针及其他文件。仅认知记忆、运行时两处文档的开头发生冲突，保留状态系统现行说明并补入旧 NPC 链路退役说明；源码自动合并。

复核玩家 FIFO、幂等重放、Rulebook 裁定、原子提交、观察受众、授权 Source 捕获、玩家意图专用调用记录，以及 Cordis 组件释放。当前 NPC 仍由单角色路径执行；旧批量服务没有残留调用。未发现需要修改生产逻辑的合并阻碍。

独立比较 28 组请求（无选项、移动、单个／多个交互、结构化参数，以及首次／续写、记忆、先表达再行动等组合）：清理前后消息、系统说明和工具 Schema 在 JSON 序列化后逐字一致。这只验证所列输入下的请求等价性，本次没有重新调用真实模型或验收长期体验。

新工作树按 Windows `core.autocrlf=true` 检出后，状态测试的回合钩子移除、定义替换因只接受 LF 而失败。此问题来自 `main` 既有夹具；本次让 `status-market-no-hook.ts`、`pack-status-runtime.test.ts` 的钩子正则同时识别 LF／CRLF，并在 `pack-status.test.ts` 读取夹具时统一换行，以支持原有跨行字符串替换。保留全部断言与失败检查。测试工具使用独立的 esbuild／Python 可执行文件副本及既有 E5 资产，避免旧可执行文件的低完整性标签干扰；未调整原目录权限，工具副本不进入提交。

合并前验证结果：

- 整合后的原型全量覆盖 71 个文件、638 项，包含状态系统、故事节点、尾轮切换、权限隔离和进程中断恢复。配置工具并修复钩子夹具后的全量运行耗时 405.52 秒，70 个文件通过，只有上述状态解析夹具的跨行替换仍失败；统一换行后，该文件 14 项单独复跑全部通过。其他 70 个文件不依赖该文件的局部夹具读取，未重复运行整套。
- 定向回归 11 个文件、40 项通过，覆盖协调器、分支管理、Provider、消息与工具 Schema、角色上下文、Cordis 生命周期，以及玩家输入／包内交互集成。
- 最终类型检查、Lint、文档导航通过（12 页、381 个本地链接，模块地图完整）；LF／CRLF 两种钩子夹具变体检查通过，暂存差异检查通过。
- 28 组请求等价对照通过。本次未重新做真实模型连续试玩、Launcher 原生点击验收或发行打包；保留上述长期体验与旧未完成 Cycle 的限制。
