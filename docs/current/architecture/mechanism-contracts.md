# 内部机制与外部玩法的共同契约

2026-11-11，目标契约采用[可组合引擎定稿](composable-engine.md)。下文源码表保留 M7 与本轮核对的现行入口，具体 SDK、脚本与默认组合按[分批计划](../../superpowers/plans/2026-11-11-composable-engine-refactor.md)迁移。API 2.8 属于原 M7 记录，实际版本以源码声明为准。

例如料理活动中的角色尝试拿锅：活动机制决定当前允许哪些操作，状态／交互机制计算候选结果；核心重查真实执行者、可见范围、锅的位置与归属后才提交。作者可以更换活动规则或组合不同脚本，不能靠一句旁白或机制返回值直接写入世界事实。

## 定稿契约与当前差距

B8 已接通默认动作、控件、授权面板和源包配置编辑，边界见[展示与配置指南](../guides/gameplay-presentation.md)。B9 无头推演未开始。

2026-11-15，官方 RPG／TRPG 已展开实际 GameplayDefinition 并由所属实例注册，正式操作、限制和后置派生进入共同执行器。结构化状态／活动结果经已有核心解析器进入同一冲突归并与最终校验，受控骰子仍记录真实随机值。普通读档和分享在写入前检查数据兼容及恢复值。B6 已通过独立收口复审，不含 B7 清单／脚本和 B8 展示验收，详见 [B6 记录](../../superpowers/plans/2026-11-15-composable-engine-b6-rpg-trpg.md)。

| 契约 | 现行目标 | 迁移位置 |
| --- | --- | --- |
| 注册 | 共同自描述定义、一个有效能力入口和多个玩法定义 | B1、B4、B7 |
| 作用域 | 实例服务隔离，实例根 Fiber 拥有注册和清理 | B2 |
| 执行 | 公共受控入口、核心硬预算和输入无关执行周期 | B3 |
| 规则 | 限制合取、唯一处理器、单层 afterAction | B4 |
| 周期结算 | 正常完成后 onCycleEnd，各钩子独立原子结算 | B3～B5 |
| 故障 | 结构化业务拒绝，异常与无效返回值报告故障 | B1、B2 |
| 装载 | 显式玩法与必要实现失败时停止打开，先核对原生执行允许状态 | B2、B7 |
| 状态与存档 | 原生状态注册进入范围，数据兼容声明覆盖持久结构和语义 | B4、B6、B7 |
| 决策与记忆 | 保留 perform／publish 部分成功，授权来源和已安装归档边界 | B3、B5 |
| 模型 | 单个能力入口保留按角色的多连接路由 | B3、B5 |
| 展示与推演 | 通用动作、控件、面板和正式执行链的无头剧本 | B8、B9 |
| 恢复 | 保留已提交事实，未提交周期后续允许丢弃 | 所有涉及生命周期与提交的批次 |

下面各节中的 `ctx.status`、`ctx.activities`、规则包装顺序与调度策略参数说明现行实现。B2 已删除调度打开失败回退，生命周期与故障边界通过定向回归，见 [B2 施工记录](../../superpowers/plans/2026-11-12-composable-engine-b2-lifecycle.md)。B3 源码已接通公共执行、请求硬预算、独立结算与部分成功结果；B4 原生玩法注册源码已接通，独立审查通过；官方业务迁移继续留 B5，独立审查状态见 [B3 记录](../../superpowers/plans/2026-11-12-composable-engine-b3-execution.md)。

B2 用户架构复核后的故障收口：规则异常和非法效果报告 PluginFault，当前操作没有世界拒绝事件；affordances 故障停止必要阶段。输入准备或裁定发生明确插件故障后，处理记录终结为 failed，相同输入标识重放故障，不会由后续新输入重新执行。通用调用保护位于 runtime-cordis/plugin-call，取消后的已观察原生故障保留脱敏诊断；核心回调错误保持来源。本次独立收口复审通过，证据见 B2 记录。

## 1. 层与入口

| 所属层 | 写在哪里 | 可以依赖什么 |
| --- | --- | --- |
| 核心 | contracts／application／kernel／store-sqlite 中的身份、授权、状态检查与提交 | 公共数据和执行契约；不依赖具体官方机制或宿主适配 |
| 内部机制 | official-*；官方自主策略与调度同在 official-scheduler 包但分开注册 | 公开 contracts 与 plugin-sdk；可信原生插件使用 Cordis 服务 |
| 外部玩法 | 世界包 scripts/、plugins/、JSON 声明 | 已有作者 hook、授权数据与候选格式；不导入 Cordis／原生 SDK |
| 内容 | 人物、世界、事件池、美术与玩法配置 | 世界包格式；不靠内容文本授予重要事实 |
| 宿主与默认组合 | desktop 入口、执行适配与 official-bundle | 明确选择机制和玩法；准备输入、管理资源，不复制机制算法 |

[SDK 根入口](../../../packages/sdk/src/index.ts)保持不变。其内部按 world、scheduler、character-loop、memory、llm、rules、decisions、knowledge、status、activities、communication、autonomy、capabilities、frontend、player-feed、host、results、gameplay 和 version 分组。rules／frontend 的公共数据来自 contracts；包 exports 仍只有根入口，没有新增子路径、npm 发布或另一套脚本 SDK。

## 2. 注册、身份与生命周期

原生机制以公开 Provider 的 id／version／可选公开 identity 标识，通过 `ctx.effect(() => ctx.<service>.register(provider))` 注册。单例槽位不能重复占用；decisions 与 rules 按既有顺序叠加。Cordis inject 只说明服务就绪关系；包 requiresPlugins、决策步骤顺序、世界打开次序各管一件事，不合并成另一个依赖系统。

进程级注册由 Cordis effect 清理。Provider.open 每世界／候选独立创建实例；WorldApplication 从既有根 Context 派生隔离的实例 Context 和 Fiber，WorldHostCore 通过 scope 打开并持有 Provider。关闭先撤销调用资格，再回收资源；忽略取消的异步计算不继续占用宿主等待，晚到 open 结果单独回收。不要把一局状态放在模块顶层或跨世界共享。数据目录和 WorldReader 属于既有可信原生接口，不能把接口的窄输入误称为恶意代码沙箱。普通世界包脚本没有这些能力。

候选比较包含所选机制的 ID／version／公开 identity、真实交互安装目录与代码／包环境。公开 identity 不放凭证；宿主不会猜测未声明的配置变化。节点、分享和外部插件文件仍各自遵守已有范围，不表示已实现任意插件持久状态。

## 3. 各机制的输入与边界

| 服务／源码契约 | 计算输入与返回 | 核心或宿主保留的检查 |
| --- | --- | --- |
| [scheduler](../../../packages/sdk/src/scheduler.ts) | 单例调度器与 `registerWakeup` 叠加唤醒源、合并候选、活动机会、策略限额与同一受控 turn | 角色与刺激引用归属、整项可选提名校验、核心错误透传、请求硬预算；来源不选择另一套执行器 |
| [characterLoop](../../../packages/sdk/src/character-loop.ts) | 当前激活的 prepare／decide／submit 能力 | 不允许伪造 actor、前缀或受众；续写真实结果，能力结束后失效 |
| [memory](../../../packages/sdk/src/memory.ts) | 授权角色请求，返回记忆投影；可声明实际记忆窗口 | 角色经验来源与结果投影；文件快照沿已有记忆协议 |
| [llm](../../../packages/sdk/src/llm.ts) | 最终授权请求与模型调用；完整通道或发送适配二选一 | 凭证由入口配置；输出仍经格式、许可与规则检查，失败不改投其他模型 |
| [rules](../../../packages/sdk/src/rules.ts) | 基础规则层的前缀、行动与 next | 提案只能含核心认识的事实，与已提交托管或位置矛盾的效果按插件出错拒绝；真实提交仍由核心负责 |
| [gameplay](../../../packages/sdk/src/gameplay.ts) | 强类型操作／公开方法、限制、所属状态与活动、可选 `wakeupSources`、结果投影、afterAction 与 onCycleEnd | B4/B5 的 application/gameplay-runtime 已接通原生注册、结构化拒绝和执行；共同脚本与包清单 B7、通用 UI 和作者配置 B8 已接通 |
| [decisions](../../../packages/sdk/src/decisions.ts) | 授权上下文扩充或决策包装 | 最终角色输出和行动照常复核；公开 ContextSources 调用所选机制 |
| [knowledge](../../../packages/sdk/src/knowledge.ts) | 当前角色授权 Context，选择作者材料 | 官方保持文档受众与条件范围；缺席时不扩充，不用全量真值代替 |
| [status](../../../packages/sdk/src/status.ts) | policy／prepareModule 只见已知值；可信 resolve／轮末可见 truth，返回候选 | 声明、Schema、归属、告知、物品与真实执行者；异步原生执行和结果未知留宿主 |
| [activities](../../../packages/sdk/src/activities.ts) | policy／simulate 使用角色作用域；可信规则和调度可见完整活动状态；选择只见摘要 | private／internal 隔离、参与者、唯一前台、合法开始、开始／暂停／恢复／放弃／逃生的状态迁移、随机记录、状态联动和原子提交 |
| [communication](../../../packages/sdk/src/communication.ts) | 公开定义与已授权联系人；contacts 可用本角色已知状态收窄，prepare 返回投递候选 | 候选和正式路径重查、信封和实际发送者、收件权限与观察原子提交；不授予远端物理资格 |
| [autonomy](../../../packages/sdk/src/autonomy.ts) | 已提交交易摘要计算到期角色；许可钩子收窄行动 | 声明身份、范围、机会、实际地点和效果；继续消费同一 scheduler／characterLoop |

基础服务另见 [capabilities](../../../packages/sdk/src/capabilities.ts)、[frontend](../../../packages/sdk/src/frontend.ts)、[player-feed](../../../packages/sdk/src/player-feed.ts)：原生能力、纯前端表达和玩家可见订阅分开，不把它们的返回混成世界事实。

计算接口的同步／异步性质保持各自契约，不强行统一 hook。知识、状态、活动、通信和自主的只读查询／候选计算不获得数据库提交回调。异步模型、记忆、角色能力和原生会话仍走对应接口。新增效果必须由核心认识并裁定，不能任意新增事件绕过提交。

B1 的最小 Schema 边界见 [gameplay-contract](../../../packages/core/src/application/gameplay-contract.ts)。它只返回未知外部数据的参数／结果解析结果，不调用作者 resolve，也不授予角色资格。最小搜证定义见 [gameplay.example](../../../packages/sdk/src/gameplay.example.ts)，验证范围与未接通批次见 [B1 记录](../../superpowers/plans/2026-11-12-composable-engine-b1-contract.md)。

## 4. 当前外部作者格式

| 文件 | 职责与状态来源 |
| --- | --- |
| scripts/status.js | 状态声明、初始化、许可、操作与原有轮末；status.updated 保存正式变化 |
| plugins.json／plugins/*.js | 包内模块声明及同步钩子；原生异步调用仍经能力桥，不新增模块轮末或异步 JS 协议 |
| scripts/activity.js／scripts/activities/*.js | 活动规则、public／private／internal、选择和调度；activity.updated 保存进度 |
| knowledge.json／作者文档 | 受众、情境条件和材料预算；选择不等于角色已亲历 |
| communication.json | 已声明联系人与媒介，实际消息和观察沿已有事件提交 |
| autonomy.json | 触发、频率、机会及地点／目标限制；从提交事件重算，不新增持久队列 |

当前作者格式见[活动与状态指南](../guides/activity-and-variables.md)、[原生插件指南](../guides/host-plugin-authoring.md)。共同定义及旧内容去向按定稿和 B7 处理，迁移前沿用各入口实际支持的语法与权限。

## 5. 当前默认组合与显式停用

[assembleRoleplay](../../../apps/host/src/official-bundle.ts)是桌面入口明确选择的默认 RP 安装，包含交互实现、机制和模型装配器。`WorldHostRuntime.create` 未提供 composition 时选择此组合；`WorldHostCore.create` 必须接收完整 composition，不补玩法。选定调度器打开失败时停止打开。

显式 composition 的 mechanisms 就是实际选择。省略 knowledge／memory 等可选机制后，回合和重生都不补回默认。包声明了状态、活动、通信或自主资产却省略对应机制，会在激活前报错；scheduler、characterLoop 与模型通道／模型装配器为此宿主的必要能力。WorldApplication 的无具体玩法入口是最小核心，验收见[M7 记录](../studies/2026-11-core-migration-m7.md)。

不要同时传 composition 和 plugins。plugins 是默认 RP 入口的覆盖列表；显式组合在 mechanisms 中选择最终 Provider，决策与规则列表也不再二次填充。示例：

~~~ts
const rp = assembleRoleplay()
const { knowledge, ...mechanisms } = rp.mechanisms
await WorldHostRuntime.create({
  ...options,
  composition: { ...rp, mechanisms },
})
~~~

WorldAdapters 只提供既有执行适配器上的规则和上下文投影，不读取配置、不注册 Provider、不创建机制或补默认。创作者查询只拿到状态真值／活动进度的只读函数。它不是插件的 ctx.gameplay，也不是最小核心的新接口。

## 6. 透视、分享与交付

LensSimulation／LensSession 可接收同一 composition，重启、重载保持选择。状态起点覆盖在所选 Provider 的初始化结果上施加，再走同一 StatusState 检查；透视不另建默认脚本解释器。普通 CLI／Launcher 透视入口明确使用默认 RP，不自动加载用户的任意原生插件和凭证。

故事分享 API 可接收相同 composition，声明预检通过所选状态 Provider.open／close 和核心 StatusState；Launcher 未另传时明确使用默认 RP。预检在一次性快照副本上进行，不改发送者节点。它不执行初始化，不宣称通用插件文件、外部副作用或第三方算法快照均已支持。

world-pack 库仍接收公开安装目录；CLI 进程显式选基础交互，并只做结构验证，不执行游戏 hook。发布脚本打包同一 CLI／Lens 入口，未复制一份状态或活动规则。源码静态检查阻止核心依赖宿主、SDK 导入运行实现、作者脚本导入原生 SDK，也保留官方机制不能依赖宿主／存储实现的边界。

## 7. 失败与验证范围

选中模型、记忆、状态、活动、知识、通信、自主、调度器和角色循环打开失败明确拒绝；默认实现只填未选择的空位。原生异常与无效结果报告插件故障，玩家提示不包含原始异常或私密输入；核心回调中的错误保留原来源。同一宿主实例共享错误来源记录，通过 CharacterTurn 的 propagateDecisionError 越过整条决策链的模型失败兜底，预设、输出与循环的已有分类仍保留。合法业务拒绝继续使用结构化结果。非法候选不提交，先前已成功的玩家行动或活动开始仍成立。

源码、自动化、真实模型体验与完整发行分别记录。M6 的证据见[M6 记录](../studies/2026-11-core-migration-m6.md)，整体验收及其限制见[M7 记录](../studies/2026-11-core-migration-m7.md)。剧情节奏已有实现，原生插件持久状态已纳入本轮计划，进度见[范围记录](plugin-layering-direction.md)。
