# 目录与模块地图

核对日期：2026-10-22。本次追加核对物品规则移至作者脚本后的职责与入口；此前宿主迁移、Core 资源和前端适配核对保留，其他机制的验证限制仍见对应章节。目录位置是导航线索，不代表其中的全部代码都由当前入口运行。从入口沿 import 和调用向下查；导出清单不等于调用清单。

2026-10-24 补充根目录创作 Skill 及程序分发入口；没有新增 packages 包或宿主插件。离线程序验收和未通过门禁见[本轮记录](../studies/program-package-creator-skill-20261024.md)。

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
| [application](../../../packages/application) | 连接玩家输入、角色处理和世界执行 | [单角色处理](../../../packages/application/src/character-turn.ts)、[有界调度](../../../packages/application/src/activation-cycle.ts)、[WorldApplication](../../../packages/application/src/world-application.ts)（宿主只用其游玩方法；创作者与调试读取在 [`read`](../../../packages/application/src/world-read-queries.ts)，备份、分叉、维护与隔离恢复在 [`admin`](../../../packages/application/src/world-administration.ts)）；[RoundCoordinator](../../../packages/application/src/round-coordinator.ts) 是玩家行动的裁定与提交入口，旧 NPC Round／Reaction 执行已退役 |
| [kernel](../../../packages/kernel) | 世界规则、行动裁定、场景事实读取与启动 | [规则注册](../../../packages/kernel/src/rulebook-registry.ts)、[世界启动](../../../packages/kernel/src/world-bootstrap.ts)；不负责角色写台词，也不承担提交流程 |
| [store-sqlite](../../../packages/store-sqlite) | 事件存取、原子提交、角色视图和相关持久化 | [WorldStore](../../../packages/store-sqlite/src/world-store.ts)、[CharacterViewBuilder](../../../packages/store-sqlite/src/character-view.ts) |
| [memory](../../../packages/memory) | 原生角色记忆与认知上下文 | [上下文服务](../../../packages/memory/src/cognitive-context.ts)、[本地记忆](../../../packages/memory/src/local-memory.ts)；Python Core 不在此包 |
| [provider-chat](../../../packages/provider-chat) | 角色决策请求、经 pi-ai 的三协议调用、模型能力声明、预设和请求检查 | [角色协议](../../../packages/provider-chat/src/character-turn-call.ts)、[调用适配](../../../packages/provider-chat/src/provider.ts)、[模型声明](../../../packages/provider-chat/src/pi-model.ts)、[上下文文本](../../../packages/provider-chat/src/character-context-text.ts) |
| [world-pack](../../../packages/world-pack) | 检查和编译作者的世界包 | [编译器](../../../packages/world-pack/src/compiler.ts)、[命令入口](../../../packages/world-pack/process/cli-entry.ts)；源包与 Manifest 版本不是同一个数字 |
| [interaction-runtime](../../../packages/interaction-runtime) | 注册交互能力、校验定义与结果 | [注册](../../../packages/interaction-runtime/src/registry.ts)、[校验](../../../packages/interaction-runtime/src/validation.ts) |
| [interactions-basic](../../../packages/interactions-basic) | 牵手与松手的内置规则 | [基础定义](../../../packages/interactions-basic/src/basic.ts)仅有 `base:hold-hand`、`base:end-contact`，须由世界包显式绑定。拿／放／给与料理／修理由各包 `scripts/status.js` 定义，经[状态桥](../../../desktop/host/pack-status.ts)裁定；旧物品规则与 home.ts、dinner.ts 已删除（2026-10-22） |
| [frontend](../../../packages/frontend) | 公共玩家视图、客户端接口、默认情景舞台、本地阅读进度与可选语音／BGM 服务契约 | [公共数据](../../../packages/frontend/src/player-view.ts)、[客户端](../../../packages/frontend/src/client.ts)、[默认模板](../../../packages/frontend/src/default-template.ts)、[阅读游标](../../../packages/frontend/src/reading-playback.ts)、[语音接口](../../../packages/frontend/src/speech.ts)、[BGM 接口](../../../packages/frontend/src/bgm.ts)与[播放器](../../../packages/frontend/src/bgm-playback.ts) |
| [plugin-sdk](../../../packages/plugin-sdk) | Cordis 宿主插件可依赖的服务类型、宿主 API 版本，以及插件清单与配置字段的格式 | [类型与版本](../../../packages/plugin-sdk/src/index.ts)；宿主的 [host-plugins.ts](../../../desktop/host-plugins.ts)、[host-capabilities.ts](../../../desktop/host-capabilities.ts) 实现这些接口。只有类型和版本比较，没有运行时服务；尚未发布到 npm |
| [agents](../../../packages/agents) | 玩家意图调用记录、共用库连接与历史玩家输入解析 | [导出入口](../../../packages/agents/src/index.ts)、[玩家调用记录](../../../packages/agents/src/player-intent-call.ts)、[连接](../../../packages/agents/src/context-database.ts)；旧 NPC Context、Reflection 和调用服务已移除，NPC 主循环在 application |
| [presentation](../../../packages/presentation) | 把授权观察转成确定性的展示文本 | [Presenter](../../../packages/presentation/src/presenter.ts)；不是 Vue 界面或 NPC 决策器 |
| [runtime-cordis](../../../packages/runtime-cordis) | Cordis 注册与分支资源生命周期 | [运行时](../../../packages/runtime-cordis/src/runtime.ts)；先了解游戏流程再读资源管理 |
| [testkit](../../../packages/testkit) | 测试构造与辅助工具 | [测试工具](../../../packages/testkit/src/testkit.ts)；不是玩家运行入口 |

## 3. 根据问题找文件

| 要改或排查什么 | 先查哪里 | 再查哪里 |
| --- | --- | --- |
| Launcher 按钮、列表与设置 | apps/launcher 组件与 store | desktop/launcher-core.ts 与 Rust 桥 |
| 创作者页面的对话、轨迹、运行时间线、模型请求与详情 | apps/launcher/src/creator/store.ts、model.ts、timeline.ts、TimelineView.vue、source.ts | desktop/host/creator-inspection.ts、creator-history.ts、creator-records.ts；页面静态托管见 creator-assets.ts |
| 模型连接、Key 与按角色模型 | desktop/model-connections.ts、apps/launcher 的 ModelSettingsDialog / ModelPicker | Rust 桥读取凭据；游戏进程启动时按角色构造决策与记忆调用 |
| 游戏内对白与状态显示 | frontend/default-template.ts、player-transcript.ts | http-server.ts；社区模板另查包内 frontend/ |
| 角色知道了秘密 | character-view.ts、character-turn.ts | 原生记忆或 core-memory.ts 的来源和交付 |
| 模型格式错误 | provider-chat/character-turn-call.ts、gateway-turn-call.ts | character-turn.ts；活动另查 pack-activity.ts |
| 移动或物品操作被拒绝 | kernel 裁定与交互定义 | 世界包绑定、当前视图、实际参数 |
| 角色重复回应或没回应 | activation-cycle.ts | 宿主预算、刺激与活动调度 |
| 长期记忆遗漏或整理慢 | core-memory.ts、python-worker.ts | experiments/activity-memory 与 hindsight-core |
| 节点、分叉与分享 | desktop/story-nodes.ts、story-share.ts | LauncherCore 与节点记忆快照恢复 |
| 末端回合重新生成 | tail-runtime.ts、desktop/tail-storage.ts | 宿主世界版本与后台任务取消 |

入口可在[代码路线](code-walkthrough.md)中点击。历史 ADR 与旧测试可解释文件为什么存在，不能独立证明它仍是当前必经路径。
