# 内部机制与外部玩法的共同契约

核对日期：2026-11-05，M7。API 仍为 2.8，不改变脚本、事件、世界库或角色输出格式。

例如料理活动中的角色尝试拿锅：活动机制决定当前允许哪些操作，状态／交互机制计算候选结果；核心重查真实执行者、可见范围、锅的位置与归属后才提交。作者可以更换活动规则或组合不同脚本，不能靠一句旁白或机制返回值直接写入世界事实。

## 1. 层与入口

| 所属层 | 写在哪里 | 可以依赖什么 |
| --- | --- | --- |
| 核心 | contracts／application／kernel／store-sqlite 中的身份、授权、状态检查与提交 | 公共数据和执行契约；不依赖具体官方机制或宿主适配 |
| 内部机制 | official-*；官方自主策略与调度同在 official-scheduler 包但分开注册 | 公开 contracts 与 plugin-sdk；可信原生插件使用 Cordis 服务 |
| 外部玩法 | 世界包 scripts/、plugins/、JSON 声明 | 已有作者 hook、授权数据与候选格式；不导入 Cordis／原生 SDK |
| 内容 | 人物、世界、事件池、美术与玩法配置 | 世界包格式；不靠内容文本授予重要事实 |
| 宿主与默认组合 | desktop 入口、执行适配与 official-bundle | 明确选择机制和玩法；准备输入、管理资源，不复制机制算法 |

[SDK 根入口](../../../packages/plugin-sdk/src/index.ts)保持不变。其内部按 world、scheduler、character-loop、memory、llm、rules、decisions、knowledge、status、activities、communication、autonomy、capabilities、frontend、player-feed、host 和 version 分组。包 exports 仍只有根入口，没有新增子路径、npm 发布或另一套脚本 SDK。

## 2. 注册、身份与生命周期

原生机制以公开 Provider 的 id／version／可选公开 identity 标识，通过 `ctx.effect(() => ctx.<service>.register(provider))` 注册。单例槽位不能重复占用；decisions 与 rules 按既有顺序叠加。Cordis inject 只说明服务就绪关系；包 requiresPlugins、决策步骤顺序、世界打开次序各管一件事，不合并成另一个依赖系统。

进程级注册由 Cordis effect 清理。Provider.open 每世界／候选独立创建实例，close 释放该实例资源；不要把一局状态放在模块顶层或跨世界共享。数据目录和 WorldReader 属于既有可信原生接口，不能把接口的窄输入误称为恶意代码沙箱。普通世界包脚本没有这些能力。

候选比较包含所选机制的 ID／version／公开 identity、真实交互安装目录与代码／包环境。公开 identity 不放凭证；宿主不会猜测未声明的配置变化。节点、分享和外部插件文件仍各自遵守已有范围，不表示已实现任意插件持久状态。

## 3. 各机制的输入与边界

| 服务／源码契约 | 计算输入与返回 | 核心或宿主保留的检查 |
| --- | --- | --- |
| [scheduler](../../../packages/plugin-sdk/src/scheduler.ts) | 普通／自主／活动机会与受控 turn 能力，返回调度结果 | 真实角色、授权请求、提交；官方负责有界预算，可信第三方预算沿既有建议语义 |
| [characterLoop](../../../packages/plugin-sdk/src/character-loop.ts) | 当前激活的 prepare／decide／submit 能力 | 不允许伪造 actor、前缀或受众；续写真实结果，能力结束后失效 |
| [memory](../../../packages/plugin-sdk/src/memory.ts) | 授权角色请求，返回记忆投影；可声明实际记忆窗口 | 角色经验来源与结果投影；文件快照沿已有记忆协议 |
| [llm](../../../packages/plugin-sdk/src/llm.ts) | 最终授权请求与模型调用；完整通道或发送适配二选一 | 凭证由入口配置；输出仍经格式、许可与规则检查，失败不改投其他模型 |
| [rules](../../../packages/plugin-sdk/src/rules.ts) | 基础规则层的前缀、行动与 next | 提案只能含核心认识的事实，与已提交托管或位置矛盾的效果按插件出错拒绝；真实提交仍由核心负责 |
| [decisions](../../../packages/plugin-sdk/src/decisions.ts) | 授权上下文扩充或决策包装 | 最终角色输出和行动照常复核；公开 ContextSources 调用所选机制 |
| [knowledge](../../../packages/plugin-sdk/src/knowledge.ts) | 当前角色授权 Context，选择作者材料 | 官方保持文档受众与条件范围；缺席时不扩充，不用全量真值代替 |
| [status](../../../packages/plugin-sdk/src/status.ts) | policy／prepareModule 只见已知值；可信 resolve／轮末可见 truth，返回候选 | 声明、Schema、归属、告知、物品与真实执行者；异步原生执行和结果未知留宿主 |
| [activities](../../../packages/plugin-sdk/src/activities.ts) | policy／simulate 使用角色作用域；可信规则和调度可见完整活动状态；选择只见摘要 | private／internal 隔离、参与者、唯一前台、合法开始、开始／暂停／恢复／放弃／逃生的状态迁移、随机记录、状态联动和原子提交 |
| [communication](../../../packages/plugin-sdk/src/communication.ts) | 已授权联系人摘要、真实 actor／recipient／text，返回消息候选 | 信封和手动请求绑定、生命周期、收件权限、实际发送者与观察事实；不授予远端物理资格 |
| [autonomy](../../../packages/plugin-sdk/src/autonomy.ts) | 已提交交易摘要计算到期角色；许可钩子收窄行动 | 声明身份、范围、机会、实际地点和效果；继续消费同一 scheduler／characterLoop |

基础服务另见 [capabilities](../../../packages/plugin-sdk/src/capabilities.ts)、[frontend](../../../packages/plugin-sdk/src/frontend.ts)、[player-feed](../../../packages/plugin-sdk/src/player-feed.ts)：原生能力、纯前端表达和玩家可见订阅分开，不把它们的返回混成世界事实。

计算接口的同步／异步性质保持各自契约，不强行统一 hook。知识、状态、活动、通信和自主的只读查询／候选计算不获得数据库提交回调。异步模型、记忆、角色能力和原生会话仍走对应接口。新增效果必须由核心认识并裁定，不能任意新增事件绕过提交。

## 4. 外部作者格式保持

| 文件 | 职责与状态来源 |
| --- | --- |
| scripts/status.js | 状态声明、初始化、许可、操作与原有轮末；status.updated 保存正式变化 |
| plugins.json／plugins/*.js | 包内模块声明及同步钩子；原生异步调用仍经能力桥，不新增模块轮末或异步 JS 协议 |
| scripts/activity.js／scripts/activities/*.js | 活动规则、public／private／internal、选择和调度；activity.updated 保存进度 |
| knowledge.json／作者文档 | 受众、情境条件和材料预算；选择不等于角色已亲历 |
| communication.json | 已声明联系人与媒介，实际消息和观察沿已有事件提交 |
| autonomy.json | 触发、频率、机会及地点／目标限制；从提交事件重算，不新增持久队列 |

详细作者格式见[活动与状态指南](../guides/activity-and-variables.md)、[原生插件指南](../guides/host-plugin-authoring.md)。各格式可以组合，不要求把 JSON 和所有脚本改成一种万能 hook。

## 5. 默认组合与显式停用

[assembleRoleplay](../../../desktop/official-bundle.ts)是桌面入口明确选择的默认 RP 安装，包含交互实现、机制、模型装配器和原有调度失败回退。`WorldHostRuntime.create` 未提供 composition 时选择此组合；`WorldHostCore.create` 必须接收完整 composition，不补玩法。

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

选中模型、记忆、状态、活动、知识、通信、自主和角色循环打开失败明确拒绝；不悄悄换解释器。调度失败回退是组合显式选择的策略，自定义组合未提供 fallbackScheduler 时不补官方实现。计算异常按实际 Provider 归因，非法候选不提交；先前已成功的玩家行动或活动开始仍成立，不能用失败回滚已发布的事实。

源码、自动化、真实模型体验与完整发行分别记录。M6 的证据见[M6 记录](../studies/2026-11-core-migration-m6.md)，整体验收及其限制见[M7 记录](../studies/2026-11-core-migration-m7.md)。剧情导演和通用外部插件持久状态继续暂停。
