# 当前代码技术文档

2026-11-18 独立世界事件的作者声明、角色观察、Cordis 消费和分支恢复见[世界事件](world-events.md)。

2026-11-16 B11：8025 DeepSeek Flash 已真实使用 RPG 技能、持续效果及作者数值；修复技能认知材料缺失、活动候选重新放宽及浏览器刷新抢写租约。默认检查 264 文件／2476 项、Launcher 103 项通过，隔离便携入口和实际浏览器回合通过。范围、独立复审及未验收的原生窗口／干净机器／长局见 [B11 记录](../../superpowers/plans/2026-11-16-composable-engine-b11-acceptance.md)。

2026-11-15 B10：`@perspectra/*` 包与 Host／Launcher 入口迁移见[模块地图](modules.md)、[代码路线](code-walkthrough.md)及[B10 验收记录](../../superpowers/plans/2026-11-15-composable-engine-b10-packages.md)。以下旧批次条目只表示各自当时范围。

2026-11-15 B8：默认动作分组／参数表单、通用控件、授权只读面板与 Launcher 源包配置编辑已接通，三组独立复验及主代理验收通过。详见 [展示与配置指南](../guides/gameplay-presentation.md)和 [B8 记录](../../superpowers/plans/2026-11-15-composable-engine-b8-presentation.md)。停在 B8，不进入 B9；以下历史批次说明保留当时证据。

2026-11-15 B7：游戏包显式 plugins、可选 services 硬要求、共同 gameplay 脚本和独立配置校验已接通，三组独立复验全部 PASS，主代理已完成 B7 验收。证据和边界见 [B7 记录](../../superpowers/plans/2026-11-15-composable-engine-b7-packs.md)。保留 v5 内容布局，当时默认展示与作者界面留 B8；其最新状态见页首。


2026-11-15 后续复核：发现并修正九项接通缺口，详见[本轮记录](../../superpowers/plans/2026-11-15-composable-engine-b6-followup.md)。此前 PASS 为当时证据；本轮九项及复审发现的三处残留均已修复，三位新的独立 GPT-6.1 Sol 最终复验全部 PASS，12 项独立探针通过。保持在 B6，不进入 B7。

2026-11-15：B6 已通过独立 GPT‑6.1 Sol 收口复审。官方 RPG／TRPG 通过实例所属 GameplayRuntime 注册状态、活动与操作；锁门／金库限制及随行派生进入公共规则，状态与活动开始的真实准入在共同入口复核。恢复与分享在写入前只读校验兼容记录、实际值与阶段。最后独立 11 项探针及 5 文件 88 项回归通过，其他证据见 [B6 记录](../../superpowers/plans/2026-11-15-composable-engine-b6-rpg-trpg.md)。按用户要求停在 B6，不进入 B7；真实模型、GUI 与发行验收未做。

2026-11-13 B5 待独立审查：公开唤醒提名、统一角色执行与许可、依已知状态收窄联系人、公共周期提交 status／pacing 已接通。Host 135 项与公共执行 88 项等定向回归通过，尚未放行；源码职责和后续包迁移边界见 [B5 记录](../../superpowers/plans/2026-11-13-composable-engine-b5-services.md)及[运行时](runtime.md)。

2026-11-13：B3 已通过独立复审。B4 的原生注册、限制与处理器、所属效果、同快照派生、周期钩子和授权结果源码已接通并通过独立审查。先读[创作者运行时](creator-runtime.md)，阶段证据见 [B4 记录](../../superpowers/plans/2026-11-13-composable-engine-b4-gameplay.md)。包清单、默认 UI、真实模型和发行范围不提前算完成。

2026-11-11 架构定稿已确认。后续施工遵循[核心与插件规范](plugin-standard.md)及完整的[可组合游戏引擎架构](composable-engine.md)，批次、依赖和验收见[分批重构实施计划](../../superpowers/plans/2026-11-11-composable-engine-refactor.md)。核心硬预算、实例 Fiber、共同作者定义、onCycleEnd、原生状态、通用展示和无头推演属于本轮目标。以下源码迁移记录保留各自日期与验证范围。

2026-11-12：B2 经用户指出规则故障与取消诊断差距后修正，并通过独立收口审查。B3 的公共分支资源装配、实际调度驱动、硬预算与系统刺激周期源码已接通，已通过 B3 独立复审；核心内部结算适配器与 B4 作者钩子注册分别说明，见[运行时](runtime.md)与[B3 记录](../../superpowers/plans/2026-11-12-composable-engine-b3-execution.md)。

2026-11-05 下沉：玩家即时行动的观察、状态校验、活动生命周期和活动检查移入 application；活动中移动的目击者现在能得到路线。机制接口与作者格式不变，见[下沉记录](../studies/2026-11-host-adapter-sinking.md)。

2026-11-05 M7：核心拒绝与已提交事实矛盾的物品和位置效果；最小核心、默认 RP、狼人杀、RPG、状态市场和原生能力组合已有验收场景。真实模型与发行验证及其限制见[M7 记录](../studies/2026-11-core-migration-m7.md)。

2026-11-05 M6：SDK 按机制分组、根入口不变；默认 RP 显式组合，核心不补玩法，透视起点与分享预检使用所选状态机制。统一入口见[机制契约](mechanism-contracts.md)，验证见[M6 记录](../studies/2026-11-core-migration-m6.md)。

2026-11-05 M5：通信计算已迁入 official-communication；自主配置、计数与许可已并入 official-scheduler，分别通过 ctx.communication／ctx.autonomy 替换，核心仍复核发送者、收件权限与行动范围。见[M5 记录](../studies/2026-11-core-migration-m5.md)。

2026-11-05 M4：活动脚本与选择策略已迁为 Cordis `ctx.activities`，核心保留参与者／私有状态检查，宿主保留随机记录、授权读取和执行适配，见[M4 记录](../studies/2026-11-core-migration-m4.md)。

2026-11-05 M3：状态脚本与包内模块解释已迁为 Cordis `ctx.status`；StatusState 在核心检查值、归属、告知并生成授权投影，StatusRuntime 与 PackModules 负责宿主执行和原生能力桥。旧 pack-status.ts 已删除，实际边界和验证见[M3 记录](../studies/2026-11-core-migration-m3.md)。

2026-11-04 M2：空交互目录的激活／读取不一致已修复；WorldApplication 去除隐式玩法安装，状态／活动／通信共享核心即时提交，物品效果检查迁入 application。最小无模型入口及验证范围见[M2 记录](../studies/2026-11-core-migration-m2.md)。

2026-11-04 M0／M1：知识选择已迁为 Cordis 内部机制；当时最小核心探针发现空交互目录存在激活与挂载校验不一致（已于 M2 修复），尚未达到无具体玩法的最小运行时目标。基线、知识接口与验证范围见[本轮记录](../studies/2026-11-core-migration-m01.md)。

后续开发通过[核心与插件规范](plugin-standard.md)进入定稿。原生插件状态注册已纳入实施，剧情节奏已有代码，范围变化见[分层与范围记录](plugin-layering-direction.md)。M0～M7 对应下述历史迁移，当前目标的接通状态以新实施计划记录为准。

源码探查后的[分批迁移计划](../../superpowers/plans/2026-11-04-core-mechanisms-migration.md)列出了具体耦合、目标归属、M0～M7 顺序和验收入口；M0～M7 已接通。

2026-11-04：阶段 11 已集中默认组合和服务打开顺序，补齐缺失／循环等待的服务诊断；玩法迁移按实际替代需求保留，见[阶段记录](../studies/2026-11-plugin-first-phase-11.md)。

2026-11-04：阶段 10 将单角色循环策略开放为 `ctx.characterLoop`，官方与第三方使用同一组授权执行能力。入口与提交边界见[运行时](runtime.md)，验证限制见[阶段记录](../studies/2026-11-plugin-first-phase-10.md)。

这套文档解释当前目录的实际代码，面向有一点 Agent 基础的读者。Perspectra 是玩家推动的多角色扮演原型：模型决定角色怎么回应，程序维护授权信息和已裁定的重要状态。部分代码仍使用 Cordis World 名称。

## 推荐阅读顺序

| 顺序 | 你会理解什么 | 文档 |
| --- | --- | --- |
| 1 | 用角色互动例子认识上下文、行动、事件和记忆 | [入门：从一次互动理解代码](getting-started.md) |
| 2 | 每个目录与包负责什么，遇到问题去哪里找 | [目录与模块地图](modules.md) |
| 3 | 从玩家输入一路找到模型调用、规则、提交和显示 | [一次输入的代码路线](code-walkthrough.md) |
| 4 | 修改代码时怎样保持解释同步 | [文档维护规则](maintenance.md) |

读前三篇即可建立代码全貌，不必先读完 ADR。源码链接便于继续深入；这里没有逐函数 API 清单。

## 按问题深入

| 阅读问题 | 入口 |
| --- | --- |
| 新架构采用什么边界、下一批做什么 | [核心与插件规范](plugin-standard.md)、[完整定稿](composable-engine.md)、[施工计划](../../superpowers/plans/2026-11-11-composable-engine-refactor.md) |
| 一次输入怎样运行、什么时候停止 | [运行时](runtime.md) |
| 分支组件和历史怎样复用，缓存何时失效、维护时注意什么 | [运行时缓存设计](runtime-caches.md) |
| 自由表达与重要状态如何共存 | [Interaction](interaction.md) |
| 角色怎样记住经历、长期记忆怎样替换 | [认知与记忆](cognition-memory.md) |
| 特定玩法怎样限制行为 | [受控交互](controlled-interaction.md) |
| 各协议与数据库当前是哪个版本、旧值怎么处理 | [协议与存储版本](versions.md) |
| 创作者怎样定义世界与活动 | [创作者运行时](creator-runtime.md) |
| 如何按权限交付设定、区分角色态度与客观变量 | [世界设定](../guides/world-knowledge.md) |
| 创作者怎样检查位置、物品、私有上下文与记忆 | [创作者调试接口](../creator-debug-api.md)（浏览器里的只读创作者页面） |
| 怎样重新生成最近一回合 | [末端回合重新生成](../tail-round-regeneration.md) |
| 节点、分叉和分享怎样工作 | [故事线](../storylines.md) |
| 游戏页面怎样获授权 | [前端授权](../frontend-authorization.md) |
| 默认舞台怎样播放对白和活动 | [默认情景舞台](../frontend-stage.md) |
| 启动器怎样选择 Cordis 宿主插件、注册语音与 BGM 服务 | [宿主插件](../host-plugins.md)、[插件制作指南](../guides/host-plugin-authoring.md) |
| 第三方插件能替换哪些模块，世界包怎样依赖插件 | [插件能替换什么](../guides/plugin-seams.md) |
| 创作者用前端插件能做到什么、还缺什么 | [前端表现插件的能力边界](../studies/frontend-plugin-capability-boundary.md) |
| 角色专属和角色组预设如何应用 | [预设说明](../model-presets.md) |
| 模型服务如何接入 | [模型接口协议](../model-protocols.md) |
| 怎样启动桌面与游戏 | [Launcher 接入](../launcher-core-integration.md)、[当前指南](../guides/README.md) |
| Launcher 的模型连接与按角色模型 | [模型接口协议](../model-protocols.md)、[运行时](runtime.md) |

## 怎样理解这些说明

2026-10-24 发行／创作补充：本轮已生成不附试玩包的本地程序候选，随包 CLI 与 [perspectra-creator Skill](../../../skills/perspectra-creator/SKILL.md)支持无源码创作。宿主／离线编码、测试失败与未验收范围见[本轮记录](../studies/program-package-creator-skill-20261024.md)；这不表示所有专题页的旧试玩证据已经更新。

本页核对日期：2026-10-18。入门、模块地图和代码路线的核对日期分别写在各自页首。

当前源码能做的事：桌面 Launcher 管理世界包和实例，游戏在系统浏览器里运行；支持故事节点、分叉和单节点文件分享，末端回合重新生成，多条模型连接与按角色选模型，以及只读的浏览器创作者页面。便携包 test3 只含 2026-10-09 之前的部分，哪些新功能不在包里见[项目状态](../PROJECT-STATE.md)。

两个容易混的“Core”：源码网页和 Launcher 启动的游戏默认都用 Python 长期记忆（Core 记忆），缺少 Python/E5 时直接报错；只有显式加 --memory-none 才不用长期记忆，这只用于离线开发。“Launcher Core”则是桌面管理后端，和记忆无关。

专题页里的实测数字只代表当时的配置和日期。源码是否接通、自动测试覆盖什么、真实试玩是否通过，要分开看；文档中提到的提交号也不能代替实时 Git 状态。

代码变化时同步更新受影响章节，并运行：

~~~powershell
node scripts/docs/check-links.mjs
~~~

这个检查发现本地断链和模块地图遗漏，正文含义仍需读代码核对。历史设计见 [archive](../../archive/README.md)、[ADR](../../adr/README.md)和 [spec](../../spec/README.md)。
