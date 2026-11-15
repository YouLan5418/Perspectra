# 目录与模块地图

2026-11-15 B8：默认动作分组／参数表单、通用控件、授权只读面板与 Launcher 源包配置编辑已接通，三组独立复验及主代理验收通过。详见 [展示与配置指南](../guides/gameplay-presentation.md)和 [B8 记录](../../superpowers/plans/2026-11-15-composable-engine-b8-presentation.md)。停在 B8，不进入 B9；以下历史批次说明保留当时证据。

2026-11-15 B7：游戏包显式 plugins、可选 services 硬要求、共同 gameplay 脚本和独立配置校验已接通，三组独立复验全部 PASS，主代理已完成 B7 验收。证据和边界见 [B7 记录](../../superpowers/plans/2026-11-15-composable-engine-b7-packs.md)。保留 v5 内容布局，当时默认展示与作者界面留 B8；其最新状态见页首。

B8 未新增软件包。application/gameplay-presentation 校验授权展示；frontend/gameplay-widgets 消费两种只读面板与通用控件；desktop/pack-config 复用纯校验并保存已声明源包配置，Launcher 的 PackConfigEditor 提供有限表单／JSON 编辑。

B7 未新增软件包。world-pack/composition 负责清单与注入校验；official-activities 增加共同定义 VM 执行器；plugin-sdk 的 ContentGenerator 提供配置 Schema／纯校验契约。desktop/official-pack-metadata 是不启动 Host 的官方校验组合，pack-validation 负责安装允许状态，由 CLI、Launcher 和 Web 开档共同使用。world-pack 库不反向导入具体实现。


2026-11-15 后续复核：发现并修正九项接通缺口，详见[本轮记录](../../superpowers/plans/2026-11-15-composable-engine-b6-followup.md)。此前 PASS 为当时证据；本轮九项及复审发现的三处残留均已修复，三位新的独立 GPT-6.1 Sol 最终复验全部 PASS，12 项独立探针通过。保持在 B6，不进入 B7。

2026-11-13 B4：未新增包。application 的 [gameplay-runtime](../../../packages/application/src/gameplay-runtime.ts)负责原生注册、所属投影、限制与处理器、共同快照派生和受控效果；WorldApplication 把规则接到现有玩家／角色入口，CharacterTurn 将原生授权材料纳入上下文与新鲜度。plugin-sdk 补齐公开计算、限制和活动结果投影类型，contracts 标识独立周期状态来源，provider-chat 消费合法候选用途。源码与定向回归已接通并通过独立审查，见 [B4 记录](../../superpowers/plans/2026-11-13-composable-engine-b4-gameplay.md)。

2026-11-11，用户确认[可组合引擎定稿](composable-engine.md)。本文继续描述当前真实目录，参考布局和后续迁移见[规范入口](plugin-standard.md)及[分批计划](../../superpowers/plans/2026-11-11-composable-engine-refactor.md)。目前仍使用下表的 packages 和 desktop 入口，真实移动、合并与职责变更在相应批次后更新。

2026-11-12 B1：未新增包。contracts 新增公开世界、规则与表现数据契约；kernel／frontend 保留算法并重导出同一类型。plugin-sdk 新增强类型玩法定义与正式结果，移除对 kernel／frontend 的依赖。application 新增仅负责 AJV 参数／结果校验的 gameplay-contract，尚未接通注册、执行或 UI。详见 [B1 记录](../../superpowers/plans/2026-11-12-composable-engine-b1-contract.md)。

2026-11-12 B2 复核修正：通用插件调用保护从 desktop/host/plugin-runtime 移入 runtime-cordis/plugin-call，旧入口重导出同一实现，application 得以识别同一 PluginFault 并保留核心异常来源。RoundInbox 复用既有 failed 状态完成未提交的故障请求，不写世界拒绝事件。未新增包，本次独立收口复审已通过。

2026-11-12 B3：未新增包。application 新增绑定实例／分支的 execution-engine、实际调度驱动 scheduler-execution 与数值 execution-observation，CharacterTurn 报告真实提交进度。Host 的场景、活动、自主和角色请求统一消费其请求额度；official-llm／provider-chat 提供实际发送与 HTTP 尝试观测。源码已接通，独立审查状态见 [B3 记录](../../superpowers/plans/2026-11-12-composable-engine-b3-execution.md)。

2026-11-08 骰子（分支 feat/rpg-plugin）：新增 [official-dice](../../../packages/official-dice)，通过 ctx.dice 让活动脚本在 resolve 里用 `rollDice` 掷骰，点数取自活动目录每轮的随机记录；取舍见[记录](../../superpowers/specs/2026-11-08-trpg-decisions.md)。

2026-11-08 内容接缝（分支 feat/rpg-plugin）：未新增包。plugin-sdk 新增 `ctx.content`（内容生成插件），替代 official-bundle 里的 RPG 专用槽位；desktop/host 的 rpg-pack.ts 换成通用的 pack-content.ts，world-pack 新增 pack-content.ts 供宿主和 `worldpack validate` 共用配置读取；队伍随行判定 `movedAlongWith` 从活动宿主移入 application 的 move-effects。

2026-11-05 起伏器：新增 [official-pacing](../../../packages/official-pacing)，通过 ctx.pacing 解释世界包的 scripts/pacing.js 并决定这一轮是否发生节拍或事件。

2026-11-05 下沉：未新增包。application 新增 immediate-action、world-view、status-operations、activity-lifecycle、activity-projection；desktop/host/activity-world 已移入 world-view，适配器保留绑定与执行。见[下沉记录](../studies/2026-11-host-adapter-sinking.md)。

2026-11-05 M7：未新增包。application 的 item-effects 新增 assertPhysicalEffects，供即时回合和规则插件层使用；机制失败的错误类别由宿主 gameplay-services 统一保留。见[M7 记录](../studies/2026-11-core-migration-m7.md)。

2026-11-05 M6：plugin-sdk 按职责拆成内部模块并保留根导出；WorldAdapters 只投影规则和上下文，原 WorldGameplay 装配已退出。默认 RP 位于 assembleRoleplay，显式组合的缺席机制不补回。见[共同契约](mechanism-contracts.md)与[M6 记录](../studies/2026-11-core-migration-m6.md)。

2026-11-05 M5：新增 [official-communication](../../../packages/official-communication) 计算消息与选项；自主配置、频率与许可并入已有 official-scheduler，经独立 ctx.autonomy 注册。核心 CommunicationRules／autonomy-state 保留身份与权限边界，宿主负责执行和交易摘要。见[M5 记录](../studies/2026-11-core-migration-m5.md)。

2026-11-05 M4：新增 [official-activities](../../../packages/official-activities)，通过 ctx.activities 解释活动脚本、选择前台与自动开始候选。核心 [ActivityStateRules](../../../packages/application/src/activity-state.ts)保留参与者与私有状态校验；宿主 activity-source／activity-world／ActivityRuntime／ActivitiesRuntime 负责资产、授权读取和执行适配。旧 pack-activity.ts／pack-activities.ts 已删除，见[M4 记录](../studies/2026-11-core-migration-m4.md)。

2026-11-05 M3：新增 official-status，负责既有状态与包内模块解释；核心 application 新增 StatusState，保留声明／值／告知核验及授权投影。宿主 status-source 负责资产，status-runtime 负责执行适配，PackModules 不再执行 VM。旧 pack-status.ts 已删除，见[M3 记录](../studies/2026-11-core-migration-m3.md)。

2026-11-04 M2：未新增包。application 移除 interactions-basic 依赖，接收显式安装；新增核心即时回合执行与物品效果检查，供宿主状态、活动和通信复用。默认交互由桌面组合及 CLI 进程入口提供；空选择最小运行与失败路径见[M2 记录](../studies/2026-11-core-migration-m2.md)。

2026-11-04 M1：知识选择迁为 Cordis `knowledge` 服务，新增 official-knowledge；宿主只验证资产并提供数据描述。已知状态的纯转换函数抽入 contracts，知识机制不再运行时依赖 pack-status。最小核心探针及实际限制见[M0／M1 记录](../studies/2026-11-core-migration-m01.md)。

2026-11-04 阶段 10：新增 official-character-loop，替代 CharacterTurn 内固定的次数与续写策略。主干保留授权请求与受控执行；官方与第三方都使用 plugin-sdk 的角色激活能力。

2026-11-04 阶段 9：未新增包。official-llm 复用独立预设解析，并增加发送适配器包装；plugin-sdk 的同一 llm 槽位可注册完整通道或发送实例，装载器和 Launcher 共用互斥规则。

2026-11-04 阶段 8：新增 [official-contexts](../../../packages/official-contexts)，将记忆投影、近期执行证据、已知状态、设定与表情扩充注册为同一决策接缝的官方步骤。授权基础上下文、活动许可与提交仍属主干。

2026-11-04 核对调度职责：未新增包。`official-scheduler` 现负责普通、整合／分段自主及活动的机会策略；宿主辅助文件只准备机会与合法执行桥。其他条目的历史核对范围保留。

2026-11-03 阶段 5：未新增包。`desktop/plugin-requirements.ts` 检查世界包声明的插件，`desktop/host/plugin-set.ts` 记录存档实际生效的模块，`apps/launcher` 的插件页改为卡片式并列出模块。见[记录](../studies/2026-11-plugin-first-phase-5.md)。

2026-11-03 核对：`desktop/host` 的文件分工见[宿主说明](../../../desktop/host/README.md)，玩法模块由 `world-gameplay.ts` 持有，核心规则来源在 `rule-layers.ts`。

2026-11-02 核对记忆相关条目：`memory` 只保留授权来源捕获，Core 移到官方插件包，原生召回已删除。

核对日期：2026-10-22。本次追加核对物品规则移至作者脚本后的职责与入口；此前宿主迁移、Core 资源和前端适配核对保留，其他机制的验证限制仍见对应章节。目录位置是导航线索，不代表其中的全部代码都由当前入口运行。从入口沿 import 和调用向下查；导出清单不等于调用清单。

2026-10-24 补充根目录创作 Skill 及程序分发入口；没有新增 packages 包或宿主插件。离线程序验收和未通过门禁见[本轮记录](../studies/program-package-creator-skill-20261024.md)。

2026-10-30 核对分支资源交接：application 的 yieldWriter 只交还写租约，保留已经挂载的 Store、收件箱、投递与记忆组件；恢复时重新取得租约并同步授权记忆任务。正式 release 和实例关闭仍交给 runtime-cordis 的 Fiber 清理全部组件。没有新增包或连接池，细节与验证限制见[分支复用记录](../studies/2026-10-30_branch-runtime-reuse-report.md)。

同日补充单步读取：store-sqlite 提供由宿主操作启用的临时事件前缀复用，CharacterViewBuilder 复用相同不可变前缀的授权视图副本。没有新增包或持久化投影，候选哈希保留原算法，范围与未完成目标见[单步前缀记录](../studies/2026-10-30_event-prefix-reuse-report.md)。

2026-10-24 BGM 补充：现有 `desktop/host-plugins.ts` 提供可信插件曲库与选曲服务，`frontend` 包增加 BGM 类型和跟随阅读的播放器，未新增包；接口和示例见[宿主插件制作指南](../guides/host-plugin-authoring.md)。上段“没有新增宿主插件”仅描述程序分发工作，不包含本次新增的可选 BGM 示例。

例如角色拿起工具箱、修好灶台，先由包内 `scripts/status.js` 提出物品结果，再由宿主检查并提交；这些玩法不在基础交互包里。脚本接口见[受控交互](controlled-interaction.md)，标准拿／放／给写法见[作者模板](../../../examples/templates/item-rules.js)。

## 1. 先看这些目录

| 目录 | 负责什么 | 推荐先读 |
| --- | --- | --- |
| [apps/launcher](../../../apps/launcher) | Vue 启动器、Tauri 桌面外壳，以及在系统浏览器打开的创作者页面（独立 Vite 入口） | [界面状态](../../../apps/launcher/src/stores/launcher.ts)、[主界面](../../../apps/launcher/src/components/LauncherShell.vue)、[桌面请求](../../../apps/launcher/src/services/desktop.ts)、[创作者页面](../../../apps/launcher/src/creator/main.ts)、[Rust 桥](../../../apps/launcher/src-tauri/src/main.rs) |
| [desktop](../../../desktop) | Launcher 的 Node 后端、实例数据、模型连接、预设、故事节点，以及游戏宿主的可选 Cordis 插件装载 | [LauncherCore](../../../desktop/launcher-core.ts)、[模型连接](../../../desktop/model-connections.ts)、[宿主插件](../../../desktop/host-plugins.ts)、[Node 入口](../../../desktop/launcher-entry.ts) |
| [desktop/host](../../../desktop/host) | 当前网页宿主、HTTP、角色装配、Core 记忆和创作者接口 | [宿主说明](../../../desktop/host/README.md)、[网页入口](../../../desktop/host/web-entry.ts)、[实际宿主](../../../desktop/host/world-runtime.ts) |
| [tests/support](../../../tests/support) | 默认回归与研究驱动共用的场景装配、夹具和崩溃子进程 | [说明](../../../tests/support/README.md)、[跨场景装配](../../../tests/support/cross-scene-runtime.ts) |
| [tests/experiments](../../../tests/experiments) | 研究驱动和真实模型探针；生产代码与默认回归都不依赖此目录 | [受控调度对照](../../../tests/experiments/dynamic-scheduling.ts) |
| [experiments](../../../experiments) | 历史工具、冻结证据、数据和报告；默认 Python Core 已迁出 | [实验索引](../../../experiments/README.md)、[历史 JEV 脚本](../../../experiments/jev-narrative-auditor/scripts/README.md) |
| [examples/world-packs](../../../examples/world-packs) | 可运行世界包和创作样例 | [Launcher 示例](../../../examples/world-packs/launcher-demo/worldpack.source.json) |
| [tests/host](../../../tests/host) | 默认回归：游戏宿主的模块、HTTP 与前端接口、末端回合和崩溃恢复 | [宿主边界](../../../tests/host/boundaries.test.ts)、[末端回合](../../../tests/host/tail-round.test.ts) |
| [desktop/lens](../../../desktop/lens) | 包透视：读世界包源目录生成只读的作者设置视图，在临时副本和 SQLite 上经公共执行周期及进程内脚本模型传输推演，保存“已看过”快照、对比点、待改清单，并提供 `lens` 命令行 | [视图](../../../desktop/lens/view.ts)、[推演](../../../desktop/lens/simulation.ts)、[脚本](../../../desktop/lens/scenario.ts)、[存储](../../../desktop/lens/store.ts)、[CLI](../../../desktop/lens/cli.ts)、[会话](../../../desktop/lens/session.ts)；窗口在 [apps/launcher/src/lens](../../../apps/launcher/src/lens)；作者指南见[包透视](../guides/pack-lens.md)；[server.ts](../../../desktop/lens/server.ts) 是透视页面的本机服务，Launcher 和 `lens serve` 共用 |
| [tests/desktop](../../../tests/desktop) | 默认回归：Launcher 后端、模型连接、预设和故事节点 | [LauncherCore](../../../tests/desktop/launcher-core.test.ts) |
| [tests/scenarios](../../../tests/scenarios) | 默认回归：跨包的玩法与角色行为 | [角色执行结果](../../../tests/scenarios/character-execution-result.test.ts)、[原始经历交付](../../../tests/scenarios/raw-history-delivery.test.ts) |
| [tests/integration](../../../tests/integration) | 默认回归：世界包、交互路径与存储的跨包集成 | [交互路径](../../../tests/integration/interaction-path.test.ts) |
| [scripts/release](../../../scripts/release) | 便携包构建、资产收集与发行检查 | [构建说明](../../../scripts/release/BUILD.md) |
| [skills/perspectra-creator](../../../skills/perspectra-creator) | 随程序分发的世界包创作、酒馆卡静态提取／迁移及原生预设创作工具；运行时不执行 Skill | [Skill 入口](../../../skills/perspectra-creator/SKILL.md)、[生成器](../../../skills/perspectra-creator/scripts/create-world.mjs)、[预设](../../../skills/perspectra-creator/references/presets.md) |
| [docs/current](..) | 当前说明、操作指南和研究结论 | [架构入口](README.md) |
| [docs/archive](../../archive) | 历史方案与过程证据 | 需要解释旧设计时再读 |

## 2. packages 各自做什么

覆盖当前 packages 的直接子目录。这里描述职责，不承诺所有导出都已完成当前体验验收。

| 包 | 通俗职责 | 阅读起点与注意事项 |
| --- | --- | --- |
| [contracts](../../../packages/contracts) | 共用数据类型、ID、动作与事件约定 | [ID](../../../packages/contracts/src/ids.ts)、[表达片段](../../../packages/contracts/src/expression.ts)；定义形状，不执行模型 |
| [application](../../../packages/application) | 连接玩家输入、角色处理和世界执行 | [单角色处理](../../../packages/application/src/character-turn.ts)、[调度回合](../../../packages/application/src/scheduler-round.ts)、[有界调度](../../../packages/official-scheduler/src/index.ts)、[WorldApplication](../../../packages/application/src/world-application.ts)（宿主只用其游玩方法；创作者与调试读取在 [`read`](../../../packages/application/src/world-read-queries.ts)，备份、分叉、维护与隔离恢复在 [`admin`](../../../packages/application/src/world-administration.ts)）；[StatusState](../../../packages/application/src/status-state.ts)维护既有状态事实与授权投影；[原生玩法](../../../packages/application/src/gameplay-runtime.ts)绑定注册、限制、派生及所属效果；[即时执行](../../../packages/application/src/world-round-execution.ts)供状态／活动／通信宿主适配复用，[物品效果](../../../packages/application/src/item-effects.ts)负责合法物品变化；[RoundCoordinator](../../../packages/application/src/round-coordinator.ts) 是玩家行动的裁定与提交入口，旧 NPC Round／Reaction 执行已退役 |
| [official-contexts](../../../packages/official-contexts) | 官方决策扩充、有序组合与交付步骤的记忆窗口声明；同 ID 替换、显式顺序停用 | [实现](../../../packages/official-contexts/src/index.ts)，通过公开 contextSources 读取授权投影 |
| [official-communication](../../../packages/official-communication) | 已声明通信的消息参数、选项、文本计算与指引 | [机制](../../../packages/official-communication/src/index.ts)；核心 [CommunicationRules](../../../packages/application/src/communication-state.ts)核验联系人、信封与投递事实，宿主绑定执行 |
| [official-activities](../../../packages/official-activities) | 活动脚本同步计算及前台／自动开始选择 | [机制](../../../packages/official-activities/src/index.ts)；核心 ActivityStateRules 校验，宿主执行与随机记录不下放 |
| [official-dice](../../../packages/official-dice) | 骰子机制（分支 feat/rpg-plugin，未做真实模型试玩）：解析 `NdM+K` 表达式（个数 1–20 或省略，面数 2–1000，修正 ±1000），每颗骰子用一个记录下的随机数；另有纯函数检定 `check` | [实现](../../../packages/official-dice/src/dice.ts)；以 `officialDiceProvider` 经 `ctx.dice` 或 [official-bundle](../../../desktop/official-bundle.ts) 的默认 `dice` 进入组合，[活动桥](../../../desktop/host/activity-runtime.ts)在每次 resolve 里借给脚本 |
| [official-status](../../../packages/official-status) | 状态和包内模块的同步脚本解释，返回候选数据 | [解释器](../../../packages/official-status/src/index.ts)、[源码组合](../../../packages/official-status/src/modules.ts)；核心 [StatusState](../../../packages/application/src/status-state.ts)校验声明、值和告知，宿主能力桥执行原生请求 |
| [official-knowledge](../../../packages/official-knowledge) | 作者设定的受众、条件、关键词和整条预算选择 | [选择器](../../../packages/official-knowledge/src/selection.ts)、[Provider](../../../packages/official-knowledge/src/index.ts)；资产校验由宿主 [knowledge-source](../../../desktop/host/knowledge-source.ts) 负责 |
| [official-character-loop](../../../packages/official-character-loop) | 官方单角色执行策略：行动／表达续写、次数和发言修正 | [实现](../../../packages/official-character-loop/src/index.ts)只使用公开激活能力；[CharacterTurn](../../../packages/application/src/character-turn.ts)保留授权、规则、受众与原子提交 |
| [official-rpg](../../../packages/official-rpg) | 解析 rpg.json 并展开原生 GameplayDefinition：背包／消耗／装备／解锁／队伍状态、每张地图的探索与战斗活动；限制合取保护锁门和金库，单层 afterAction 派生随行移动。实际操作由公共 GameplayRuntime 裁定，效果复用共同状态、物品、位置与观察校验。存档按 gameplayData 数据契约检查，配置／代码摘要另用于尾部候选比较 | [内容定义](../../../packages/official-rpg/src/content.ts)、[状态计算](../../../packages/official-rpg/src/status-module.ts)、[地图活动](../../../packages/official-rpg/src/map-activity.ts)；经 ctx.content／[默认组合](../../../desktop/official-bundle.ts)加载。B6 已通过独立复审，未做本轮真实模型试玩 |
| [official-trpg](../../../packages/official-trpg) | 解析 trpg.json 并展开原生活动与正式操作；主持人邀请、角色卡、检定、笔记、全桌发布和聚光灯调度由所属注册定义计算，公共执行器校验并原子提交。检定使用所选 dice 及记录下的随机数；暗骰和主持人笔记保持指定受众，internal 不进入角色上下文 | [内容定义](../../../packages/official-trpg/src/content.ts)、[活动计算](../../../packages/official-trpg/src/activity.ts)、[宿主回归](../../../tests/host/trpg-activity.test.ts)；B6 已通过独立复审。本轮未重新真实模型试玩，历史[庄园试玩](../studies/2026-11-09-rainy-manor-playtest.md)只证明当时版本 |
| [official-scheduler](../../../packages/official-scheduler) | 官方机会分配、串行／动态并发、期限和策略预算；消费公开唤醒候选，所有来源调用同一 turn | [实现](../../../packages/official-scheduler/src/index.ts)；[机会账目](../../../packages/official-scheduler/src/opportunity-round.ts)只在此包内，不是核心专用执行轨道。只依赖 contracts／plugin-sdk，自主策略见 [autonomy-policy](../../../packages/official-scheduler/src/autonomy-policy.ts)，经 ctx.autonomy 独立选择后提供提名，附加唤醒源经 `ctx.scheduler.registerWakeup` 叠加，调度仍经 ctx.scheduler |
| [kernel](../../../packages/kernel) | 世界规则、行动裁定、场景事实读取与启动 | [规则注册](../../../packages/kernel/src/rulebook-registry.ts)、[世界启动](../../../packages/kernel/src/world-bootstrap.ts)；不负责角色写台词，也不承担提交流程 |
| [store-sqlite](../../../packages/store-sqlite) | 事件存取、原子提交、角色视图和相关持久化 | [WorldStore](../../../packages/store-sqlite/src/world-store.ts)、[CharacterViewBuilder](../../../packages/store-sqlite/src/character-view.ts) |
| [official-llm](../../../packages/official-llm) | 官方模型通道：玩家预设、按角色选模型、网关格式和请求记录 | [实现](../../../packages/official-llm/src/index.ts)；玩家可用插件替换，替换后没有预设 |
| [official-jev-audit](../../../packages/official-jev-audit) | 可选的 JEV 审计实验，作为决策实现接入，默认不启用 | [入口](../../../packages/official-jev-audit/src/index.ts)；`--jev-shadow` 启用影子审计 |
| [memory](../../../packages/memory) | 从角色授权观察捕获长期记忆来源；属于主干，不可替换 | [授权来源](../../../packages/memory/src/authorized-sources.ts)、[表结构与迁移](../../../packages/memory/src/memory-schema.ts) |
| [official-memory-core](../../../packages/official-memory-core) | 官方长期记忆：Python Core 的检索、整理和交付 | [说明](../../../packages/official-memory-core/README.md)、[适配器](../../../packages/official-memory-core/src/core-memory.ts)；只依赖公开接口，由 [desktop/official-bundle.ts](../../../desktop/official-bundle.ts) 接入，玩家可用插件替换 |
| [official-memory-none](../../../packages/official-memory-none) | 不提供长期记忆，只用于离线开发和测试 | [实现](../../../packages/official-memory-none/src/index.ts)；`--memory-none` 启用 |
| [provider-chat](../../../packages/provider-chat) | 角色决策请求、经 pi-ai 的三协议调用、连接缓存适配与 SDK 用量、模型能力声明、预设和请求检查 | [角色协议](../../../packages/provider-chat/src/character-turn-call.ts)、[调用适配](../../../packages/provider-chat/src/provider.ts)、[模型声明](../../../packages/provider-chat/src/pi-model.ts)、[上下文文本](../../../packages/provider-chat/src/character-context-text.ts)、[合法动作说明](../../../packages/provider-chat/src/character-action-explanations.ts) |
| [world-pack](../../../packages/world-pack) | 检查和编译作者的世界包 | [编译器](../../../packages/world-pack/src/compiler.ts)、[命令入口](../../../packages/world-pack/process/cli-entry.ts)、[包配置生成内容的读取](../../../packages/world-pack/src/pack-content.ts)；源包与 Manifest 版本不是同一个数字 |
| [interaction-runtime](../../../packages/interaction-runtime) | 注册交互能力、校验定义与结果 | [注册](../../../packages/interaction-runtime/src/registry.ts)、[校验](../../../packages/interaction-runtime/src/validation.ts) |
| [interactions-basic](../../../packages/interactions-basic) | 牵手与松手的内置规则 | [基础定义](../../../packages/interactions-basic/src/basic.ts)仅有 `base:hold-hand`、`base:end-contact`，须由世界包显式绑定。拿／放／给与料理／修理由各包 `scripts/status.js` 定义，经[状态桥](../../../desktop/host/status-runtime.ts)裁定；旧物品规则与 home.ts、dinner.ts 已删除（2026-10-22） |
| [frontend](../../../packages/frontend) | 公共玩家视图、客户端接口、默认情景舞台、本地阅读进度与可选语音／BGM 服务契约 | [公共数据](../../../packages/frontend/src/player-view.ts)、[客户端](../../../packages/frontend/src/client.ts)、[默认模板](../../../packages/frontend/src/default-template.ts)、[阅读游标](../../../packages/frontend/src/reading-playback.ts)、[语音接口](../../../packages/frontend/src/speech.ts)、[BGM 接口](../../../packages/frontend/src/bgm.ts)与[播放器](../../../packages/frontend/src/bgm-playback.ts) |
| [plugin-sdk](../../../packages/plugin-sdk) | Cordis 宿主插件可依赖的服务类型、可替换模块的接缝类型、宿主 API 版本，以及插件清单与配置字段的格式 | [根导出](../../../packages/plugin-sdk/src/index.ts)、[世界能力](../../../packages/plugin-sdk/src/world.ts)、[注册与清单](../../../packages/plugin-sdk/src/host.ts)、[包配置生成内容](../../../packages/plugin-sdk/src/content.ts)、[版本](../../../packages/plugin-sdk/src/version.ts)，其余分组见[共同契约](mechanism-contracts.md)；宿主的 [host-plugins.ts](../../../desktop/host-plugins.ts)、[host-capabilities.ts](../../../desktop/host-capabilities.ts) 实现这些接口。只有类型和版本比较，没有运行时服务；尚未发布到 npm |
| [agents](../../../packages/agents) | 玩家意图调用记录、共用库连接与历史玩家输入解析 | [导出入口](../../../packages/agents/src/index.ts)、[玩家调用记录](../../../packages/agents/src/player-intent-call.ts)、[连接](../../../packages/agents/src/context-database.ts)；旧 NPC Context、Reflection 和调用服务已移除，NPC 主循环在 application |
| [presentation](../../../packages/presentation) | 把授权观察转成确定性的展示文本 | [Presenter](../../../packages/presentation/src/presenter.ts)；不是 Vue 界面或 NPC 决策器 |
| [runtime-cordis](../../../packages/runtime-cordis) | Cordis 注册、分支资源与隔离实例生命周期 | [运行时](../../../packages/runtime-cordis/src/runtime.ts)、[实例作用域](../../../packages/runtime-cordis/src/instance-scope.ts)；先了解游戏流程再读资源管理 |
| [testkit](../../../packages/testkit) | 测试构造与辅助工具 | [测试工具](../../../packages/testkit/src/testkit.ts)；不是玩家运行入口 |

B1 后的依赖阅读顺序是：[contracts 世界结构](../../../packages/contracts/src/world-spec.ts)、[规则数据](../../../packages/contracts/src/rulebook.ts)与[表现数据](../../../packages/contracts/src/presentation.ts)提供纯类型；kernel 与 frontend 消费并重导出对应类型，同时保留各自算法；[plugin-sdk 玩法定义](../../../packages/plugin-sdk/src/gameplay.ts)依赖 contracts；[application 玩法 Schema 边界](../../../packages/application/src/gameplay-contract.ts)消费 SDK 定义，但只做参数／结果校验和复制。

## 3. 根据问题找文件

| 要改或排查什么 | 先查哪里 | 再查哪里 |
| --- | --- | --- |
| Launcher 按钮、列表与设置 | apps/launcher 组件与 store | desktop/launcher-core.ts 与 Rust 桥 |
| 创作者页面的对话、轨迹、运行时间线、模型请求与详情 | apps/launcher/src/creator/store.ts、model.ts、timeline.ts、TimelineView.vue、source.ts | desktop/host/creator-inspection.ts、creator-history.ts、creator-records.ts；页面静态托管见 creator-assets.ts |
| 模型连接、Key 与按角色模型 | desktop/model-connections.ts、apps/launcher 的 ModelSettingsDialog / ModelPicker | Rust 桥读取凭据；游戏进程启动时按角色构造决策与记忆调用 |
| 游戏内对白与状态显示 | frontend/default-template.ts、player-transcript.ts | http-server.ts；社区模板另查包内 frontend/ |
| 角色知道了秘密 | character-view.ts、character-turn.ts | authorized-sources.ts 的来源、当前记忆实现的交付（默认 core-memory.ts） |
| 模型格式错误 | provider-chat/character-turn-call.ts、official-llm/src/gateway-turn-call.ts、当前是否启用了第三方模型通道 | character-turn.ts；活动另查 activity-runtime.ts |
| 移动或物品操作被拒绝 | kernel 裁定与交互定义 | 世界包绑定、当前视图、实际参数 |
| 角色重复回应或没回应 | official-scheduler/src/index.ts、当前是否启用了第三方调度器 | 官方预算、授权刺激与活动合法参与者桥 |
| 长期记忆遗漏或整理慢 | official-memory-core 的 core-memory.ts、python-worker.ts，当前是否启用了第三方记忆 | experiments/activity-memory 与 hindsight-core |
| 节点、分叉与分享 | desktop/story-nodes.ts、story-share.ts | LauncherCore 与节点记忆快照恢复 |
| 末端回合重新生成 | tail-runtime.ts、desktop/tail-storage.ts | 宿主世界版本与后台任务取消 |

入口可在[代码路线](code-walkthrough.md)中点击。历史 ADR 与旧测试可解释文件为什么存在，不能独立证明它仍是当前必经路径。
