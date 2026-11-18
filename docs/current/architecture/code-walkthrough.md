# 一次输入的代码路线

2026-11-17 核对：以重构后的 main `97d4dcde` 为基线，普通观察与通用唤醒机会合并时优先普通预算；后台竞争时减少可选调用预留，最后一次普通调用仅允许表达。玩家操作提交通过请求自身的回调确认，前端按 actionId 解除提交锁，复用统一视图字段清单；核心硬预算、权限和周期结算判定保留。例子、测试与真实模型短测见[主干调度优化](../studies/2026-11-17-main-scheduling-responsiveness.md)。


2026-11-15 B10：包职责与应用目录已收敛，完整图见 [迁移记录](../../superpowers/plans/2026-11-15-composable-engine-b10-packages.md)。对照 B9 提交 `76d818dc` 阅读时，旧 `desktop/` 对应 `apps/host/src/`，旧 Launcher 管理文件对应 `apps/launcher/backend/`，旧 application 对应 `packages/core/src/application/`。

搜证的最短阅读路线：

1. [worldpack CLI](../../../apps/host/src/cli/worldpack.ts) 的 `simulate` 分支解析场景并调用 [runScenario](../../../apps/host/src/lens/scenario.ts)。
2. [LensSimulation](../../../apps/host/src/lens/simulation.ts) 创建隔离目录和 SQLite，经 [WorldHostRuntime](../../../apps/host/src/runtime/world-runtime.ts) 装配正式引擎；[ScriptedModel](../../../packages/providers/src/scripted-model/index.ts) 只替换发送，授权组装仍由正式 DecisionService 完成。
3. [execution-engine](../../../packages/core/src/application/execution-engine.ts) 执行周期，[gameplay-runtime](../../../packages/core/src/application/gameplay-runtime.ts) 合取限制、选择处理器，[RoundCoordinator](../../../packages/core/src/application/round-coordinator.ts) 经 Store 原子提交事实。
4. 回到 Lens 的 `events`、`perceived`、`modelInputs` 和玩家 `gameplay`，再读 `scenario.check` 与 [搜证回归](../../../tests/host/lens-simulation.test.ts)，区分事实、角色授权观察和玩家面板。

静态分析另从 [buildLensView](../../../packages/world-pack/src/lens/view.ts) 进入：它接收结构化只读开场信息，不导入 Host；动态装配、故障与行为断言保留在 Host。


2026-11-05 M5：例如后室同伴收到玩家短信后，自主处理自己的目标。通信选项与消息计算由 ctx.communication 提供，自主配置、触发频率和许可由 ctx.autonomy 提供；两者不直接提交事件。CommunicationRules 与执行适配绑定真实收发者，AutonomyRuntime 提取交易摘要并检查声明范围，机会继续交现有 scheduler／characterLoop。源码与验证边界见[M5 记录](../studies/2026-11-core-migration-m5.md)。

2026-11-05 M4：例如猜数字与 RPG 战斗共用活动机制，各自保留包内脚本。`ctx.activities` 选择独立的解释器与候选策略；宿主 ActivityRuntime／ActivitiesRuntime 只准备授权输入并调用核心执行。参与者、private／internal 隔离、前台唯一性和随机回放继续受检查。旧活动 VM 已迁至 official-activities；源码、自动验证与体验限制见[M4 记录](../studies/2026-11-core-migration-m4.md)。

2026-11-04 M2：核心 WorldApplication 的交互安装列表省略时为空，默认桌面组合负责显式提供。状态、活动、通信的即时回合经 [executeWorldRound](../../../packages/core/src/application/world-round-execution.ts)统一提交；NPC 与玩家收件箱路径保持各自准入和观察处理。见[M2 记录](../studies/2026-11-core-migration-m2.md)。

2026-11-04 模型发送接缝：替换角色发送时从 `ctx.llm.registerTransport` 进入 host-plugins 的同一单例槽位，world-runtime 打开适配器后装配官方包装。prepare 仍经 presetContext/presetCall，send 经 transportSend 后执行 presetOutput，玩家读取经 presetDisplay。完整通道替换不被包装；Core 不走该适配器，详见[阶段 9](../studies/2026-11-plugin-first-phase-9.md)。

核对日期：2026-10-22。本次补充物品操作的包内脚本装配；此前入口与宿主迁移核对保留，其他体验验证范围沿用各节记录。建议先读[入门说明](getting-started.md)。下面是关键控制点，省略底层辅助调用；看具体分支时再顺着源码展开。

## 1. 从哪里启动

package.json 的 experience:web 指向 [web-entry.ts](../../../apps/host/src/runtime/web-entry.ts)。它读取参数与包，创建 WorldHostRuntime 和本机 HTTP 服务。

桌面路径为：Vue Launcher → Tauri 请求桥 → Node LauncherCore → 网页宿主子进程 → 系统浏览器游戏页。对应 [desktop.ts](../../../apps/launcher/src/services/desktop.ts)、[main.rs](../../../apps/launcher/src-tauri/src/main.rs)、[launcher-entry.ts](../../../apps/launcher/backend/entry.ts)、[launcher-core.ts](../../../apps/launcher/backend/core.ts)。Launcher 管理实例和进程，具体游戏仍由网页宿主运行。游戏运行时，同一个网页宿主还托管只读的创作者页面（/creator），由 Launcher 交给系统浏览器打开，见[创作者调试接口](../creator-debug-api.md)。旧 Electron 入口已于 2026-10-21 删除。

## 2. 世界包如何成为可运行世界

[宿主](../../../apps/host/src/runtime/world-runtime.ts)检查源目录为 worldpack-source/v5，调用 [compileWorldPackSource](../../../packages/world-pack/src/compiler.ts)，用已安装的基础交互能力编译并适配世界。角色处理代码检查激活后的运行时 Manifest 为 v10。源包 v5 和 Manifest v10 描述不同层次，不是版本冲突。

例如角色要把钥匙交给同伴，拿取与交给来自这个包已登记的 `scripts/status.js`，不在基础交互定义里。宿主加载[状态桥](../../../apps/host/src/runtime/status-runtime.ts)，按作者操作与 policy 提供 `status:take`／`status:give` 等候选，执行时重查并裁定物品结果；牵手与松手也由世界包的 `scripts/gameplay.cjs` 提供。完整调用和验证边界见[运行时](runtime.md)与[物品指南](../guides/activity-and-variables.md#作者物品规则的验证范围)。

宿主组合 WorldApplication、模型适配、预设及可选 Core 桥。设定里的初始位置用于启动；之后的位置从当前事件前缀的视图读取。“前缀”就是截至某条已提交事件的世界记录，避免混用不同时间的状态。

WorldApplication 负责玩家提交和授权记忆来源捕获；RoundCoordinator 是玩家行动的提交入口，负责排队、裁定、生成观察与 Authority 并提交。2026-10-18 已切除旧 NPC participant、Reaction Worker、Context Pipeline、Reflection、Checkpoint 和 NPC Provider Call／Quality；NPC 统一由下述单角色路径处理。玩家输入解释自己的调用记录仍按需使用 context.sqlite，保留原有库结构和历史事件读取，不能仅凭文件或旧表存在判断旧管线仍在运行。Cordis 的展示服务名已改为 worldPresentation，组件只持有确定性的 Presenter，不调用 Director 模型。

## 3. 输入如何到达提交路径

| 位置 | 看什么 | 为什么 |
| --- | --- | --- |
| [http-server.ts](../../../apps/host/src/runtime/http-server.ts) | 玩家 API、请求校验、busy 与 actionId | 页面请求不能直接写库 |
| [tail-runtime.ts](../../../apps/host/src/runtime/tail-runtime.ts) | 正式玩家回合、完整起点与候选选择 | WorldHostRuntime 由 TailRoundRuntime 包装实际游戏 Core |
| [world-runtime.ts](../../../apps/host/src/runtime/world-runtime.ts)、[player-input.ts](../../../apps/host/src/runtime/player-input.ts) | WorldHostCore.submit；活动、短信和状态命令的分发 | 普通表达、明确操作、活动输入走不同分支 |
| [world-application.ts](../../../packages/core/src/application/world-application.ts) | 玩家输入与世界应用组合 | 宿主复用裁定和提交机制 |
| [round-coordinator.ts](../../../packages/core/src/application/round-coordinator.ts)、[world-store.ts](../../../packages/core/src/store/world-store.ts) | 玩家行动裁定、观察生成与事务提交 | 重要状态在这里成为已提交事实 |
| [action-observations.ts](../../../packages/core/src/application/action-observations.ts) | 受众 → 观察事件与玩家投递 | 玩家与 NPC 两条提交路径共用，谁看到什么只在这里拼装 |

普通场景提交玩家输入后，宿主刷新视图并调用 #activateCharacters。活动输入先检查活动策略，不能把普通场景分支套到所有活动上。

例如玩家行动提交后交给 NPC 续写，宿主用 WorldApplication.yieldWriter 归还当前写租约，保留分支组件；NPC 自己取得租约提交。后续应用读取恢复原实例的写租约并同步未完成的授权记忆任务，避免每个阶段重新挂载。手动存档、逃生、维护与关闭仍完整释放资源；常规末端备份只要求已经结算并交还写租约。实现与验证范围见[分支复用记录](../studies/2026-10-30_branch-runtime-reuse-report.md)。

NPC 处理途中玩家也可以插话，规则见下一节末尾。

例如序章一步先读活动、再处理角色、最后结算与刷新，turn／activityAction／requestCharacter 用 WorldStore.withEventReadCache 包住自身等待链：相同提交前缀只解析一次，写入后补读尾部，完成或失败后清空。角色仍按本人权限投影，候选哈希仍按原规则计算。实现、单步快照的限制与实测见[单步前缀记录](../studies/2026-10-30_event-prefix-reuse-report.md)。

## 4. NPC 如何获得处理机会

2026-11-04 补充：普通反应、自主及活动机会均经过同一调度接缝。整合或分段的选择也在官方实现内；宿主保留合法执行与结果桥。下面描述的是官方调度器。宿主现在经 `ctx.scheduler` 接缝调用它，[createSchedulerRound](../../../packages/core/src/application/scheduler-round.ts) 为每轮准备调度器能用的操作，第三方插件可以替换它，见[插件指南](../guides/host-plugin-authoring.md#替换角色调度器)。

先看一个例子：玩家在客厅说“谁看见我的钥匙了？”。客厅里的 A、B 听见了，厨房里的 C 没听见。[runOfficialSchedule](../../../packages/providers/src/scheduler/index.ts) 看到新提交的观察，给 A、B 各一次处理机会。A 回答“在桌上”，这句话又成了 B 的新观察，B 可能再回应一次——这就是“下一波”。到没人有新东西要处理，或者次数、时间用完，这一轮就停下。

**上限。** 默认 3 波、8 次模型调用、每个角色最多 2 次激活。源码网页默认整轮 30 秒（[runtime-tuning.ts](../../../apps/host/src/runtime/runtime-tuning.ts)），Launcher 默认 120 秒（[游玩设置](../../../apps/host/src/play-settings.ts)），都能在启动配置里改。“一次激活”可能包含行动结果出来后的续写调用，所以不等于“一次模型请求”。活动有自己独立的链和预算，见[创作者运行时](creator-runtime.md)。

**并发（动态调度）。** 普通场景下，最多同时有两个角色在等模型返回，其中最多一个在玩家场景之外；同一地点、同一角色不会同时跑两份。谁先跑按这个顺序排：玩家所在场景优先，其次是重算次数少的、已完成次数少的，同级随机。模型思考时不占写锁；结果出来后排队逐个提交，提交前检查这个角色看到的东西（视图、场景成员、可见物品、可选操作）有没有变。变了就算“过期”（stale），丢掉这次结果重算一次；再过期就停止这个角色本轮。别的角色提交了无关事件，不会让它过期。

以下情况不走并发，改为逐个串行：启动时加了 `--serial-scheduling`、活动正在指定参与者、或启用了发布审计（2026-10-19 起包变量已退役，不再是串行条件）。细节和边界见[动态调度实验](../studies/dynamic-scheduling-20261011.md)。

**角色自主行动。** 世界包可以声明某些角色到时间会主动做点什么。[AutonomyRuntime](../../../apps/host/src/runtime/autonomy-runtime.ts) 在玩家成功提交后提取交易摘要，交给 [AutonomyPolicy](../../../packages/providers/src/scheduler/autonomy-policy.ts) 计算谁“到点了”，再复核合法角色与范围，把机会和普通反应交给同一个 runOfficialSchedule，共用并发和提交队列，但调用预算和时限分开算。被唤醒只是多一次处理机会，不会让角色多知道任何东西。实现见[接入记录](../studies/autonomy-dynamic-dispatch-20261011.md)，作者怎么声明见[创作者运行时](creator-runtime.md#关键角色自主行动2026-10-11实验分支)。

**玩家插话。** 玩家输入提交后，宿主在允许打断时按本次 actionId 给出 `inputProgress`，默认舞台匹配后解除提交锁。场内 NPC 处理中可继续说话，仍遵守阅读限制；行动按钮要求 ready/error。只剩场外角色时，公开视图为 ready，可以继续发言或行动。[TailRoundRuntime](../../../apps/host/src/runtime/tail-runtime.ts) 取消旧回合尚未提交的计算，已提交事实保留。场内处理者列在 `responders`，默认舞台只显示处理提示、不点名；活动期间不开放插话。见[运行时](runtime.md)。

角色随时可以放弃。调度只决定“给不给一次机会”，从不替角色写台词或定情绪。

## 5. 角色拿到什么、返回什么

[CharacterTurn](../../../packages/core/src/application/character-turn.ts)准备当前角色视图、场景、认知、授权观察、自身表达与可尝试操作。[CharacterViewBuilder](../../../packages/core/src/store/character-view.ts)按角色和事件前缀重建信息。[上下文文本](../../../packages/providers/src/chat/character-context-text.ts)负责模型侧可读呈现，预设参与请求和输出处理。

长期记忆经 `ctx.memory` 接缝接入，官方实现是 Core：[CoreMemoryAdapter](../../../packages/memory-core/src/core-memory.ts)投影请求，经 [Node worker](../../../packages/memory-core/src/node/worker-client.ts)调用记忆实现。Core 的 Retain／Group／Consolidate 是提炼、分组和形成认识，不是世界裁定。详见[认知与记忆](cognition-memory.md)。

调用格式见 [character-turn-call.ts](../../../packages/providers/src/chat/character-turn-call.ts)，OpenAI 兼容与 Anthropic 协议的扁平 Schema 见 [gateway-turn-call.ts](../../../packages/providers/src/llm/gateway-turn-call.ts)，实际发送经 [provider.ts](../../../packages/providers/src/chat/provider.ts) 交给 pi-ai。合法 JSON 仍需检查协议与行动资格。

这是当前 publish 的决策格式示例，不是玩家命令：

~~~json
{
  "decision": "publish",
  "segments": [
    { "type": "speech", "text": "先别走。" },
    { "type": "narration", "text": "她抬起头，声音放轻。" }
  ]
}
~~~

片段顺序、受众与长度检查见[Interaction](interaction.md)。表情无需额外编码成世界状态。

## 6. 结果如何回到角色和页面

perform 请求经过 Rulebook；[character-execution-result.ts](../../../packages/core/src/application/character-execution-result.ts)把实际结果给角色，供它继续表达，不能用请求文本代替执行结果。

提交完成后，宿主 onCommitted 更新玩家授权投影。[player-transcript.ts](../../../apps/host/src/runtime/player-transcript.ts)整理转录；[PlayerView](../../../packages/frontend/src/player-view.ts)定义公共数据。页面轮询已提交内容，当前没有逐 token 草稿流。新观察可能引发下一波。

在默认舞台，从地点标题和对白旁的快捷入口可打开地点面板；「行动」也按地点、物品、交流、活动等意图列出操作，并可按玩家可见的名称查找。编辑、阅读或处理中只保留「行动」入口。索引保留最后一个已读批次的选项，未读时可查阅，提交前检查当前选项 ID，再交回同一宿主 perform。当前 PlayerView 没有通用的可公开拒绝原因字段，前端仅显示自身能够确认的执行门禁和已投影的选项约束。

例如一次买入已经提交、对白还没读到购买结果时，顶部状态和展开后的详情仍显示已读批次的余额。默认舞台优先常驻作者钉住的玩家或全局数值，详情还列出已授权的状态和只读玩法面板。它们共用一份已读快照，处理期间或尚有未读时保留可确认的内容；被撤回的条目可立即隐藏。当前投影未提供字段对应的叙事行，因此读完整批后统一刷新。另一个「正在回复」提示仍显示实时处理状态。

一次操作的响应也可能在提交后丢失。默认舞台对有明确未执行依据的返回提供核对或重选，过期选项不会被重放。未知时保留草稿与接收范围，「检查结果」只刷新授权视图；只有原请求的明确返回或相同 actionId 的已提交进度才解除待确认。当前进度只在宿主公开的处理窗口内可见，记录、余额或时间变化本身无法确认原请求。

购买、拾取等状态操作的成功响应有请求身份。默认舞台用一处确认展示固定的宿主回执，并在读完已提交的内容后按请求 ID 通知一次。重复读取同一视图不会再发送一条通知。转录行按自身序号展示，即使正文相同也各自保留。当前公开视图没有让通知、转录行和余额字段共享的因果键，不能将这三类信息自动认作同一事件。

失败不一定代表整回合没发生：玩家输入可能已提交，NPC 行动也可能已完成，只是后续表达失败。排查要看事件与宿主通知。

## 7. 按需展开的分支

| 分支 | 说明 | 代码与详细文档 |
| --- | --- | --- |
| 包内活动 | 独立玩法选择、暂停／继续、策略、操作、结果与参与者调度 | [ActivitiesRuntime](../../../apps/host/src/runtime/activities-runtime.ts)、[ActivityRuntime](../../../apps/host/src/runtime/activity-runtime.ts)、[受控交互](controlled-interaction.md) |
| 预设 | 实例默认、角色组、专属与请求／输出／显示处理 | [preset-runtime.ts](../../../packages/providers/src/chat/preset-runtime.ts)、[预设说明](../model-presets.md) |
| 社区前端 | 默认沙箱，授权后受信任模式；公共玩家接口 | [授权实现](../../../apps/host/src/frontend-authorization.ts)、[资产服务](../../../apps/host/src/runtime/frontend-server.ts)、[授权说明](../frontend-authorization.md) |
| 故事线 | 完整节点、独立分叉与单节点文件分享 | [story-nodes.ts](../../../apps/host/src/story-nodes.ts)、[story-share.ts](../../../apps/host/src/story-share.ts)、[使用边界](../storylines.md) |
| 动态角色调度与插话 | 跨地点有限并发、串行事实提交、角色视图过期检查及玩家中断 | [动态调度实验](../studies/dynamic-scheduling-20261011.md)、[官方调度器](../../../packages/providers/src/scheduler/index.ts)、[对照驱动](../../../tests/experiments/dynamic-scheduling.ts)、[样例包](../../../examples/world-packs/dynamic-scheduling/README.md) |
| 末端重新生成 | 完整起点、隔离重演与候选选择 | [TailRoundRuntime](../../../apps/host/src/runtime/tail-runtime.ts)、[tail-storage.ts](../../../apps/host/src/tail-storage.ts)、[详细说明](../tail-round-regeneration.md) |

## 8. 解释基于什么

| Evidence（依据） | Finding（判断） | Path（阅读或验证方式） |
| --- | --- | --- |
| package.json 与 LauncherCore 的启动代码 | 当前游戏宿主位于 apps/host/src/host，研究驱动不再承担默认入口 | 沿入口阅读，Mock 与真实运行分别验证 |
| 宿主、CharacterTurn、有界调度 | 玩家提交后触发角色处理，角色可以放弃 | 查执行结果与调度回归，体验另做真实试玩 |
| WorldStore、CharacterViewBuilder、记忆投影 | 已提交状态、授权信息、角色认识各有职责 | 权限与提交查相关测试，叙事一致性查连续回合 |

本次梳理核对源码关系，没有新增真实模型试玩。历史测试和性能数字请读相应报告，不当成本次重新验证。
