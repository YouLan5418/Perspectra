# 可组合游戏引擎分批重构实施计划

2026-11-11，根据用户确认的[架构定稿](../../current/architecture/composable-engine.md)制定。规范入口为[核心与插件规范](../../current/architecture/plugin-standard.md)。本文固定施工顺序、范围与验收方式。B0、B1 已通过主代理验收；B2 经用户指出偏离后已修正并通过独立复审；B3 首轮独立审查发现三项缺口及收尾取消缺口，主代理修复后已通过独立复审；B4、B5 已通过独立复审；B6 原阶段及九项复核修正已通过新的独立复验。B7 已完成并通过三组独立复验及主代理验收；B8 已完成三组独立复验及主代理验收；B9、B10 已随远端集成分支同步；B11 的真实模型、浏览器和隔离便携入口验收见 [B11 记录](2026-11-16-composable-engine-b11-acceptance.md)。

## 1. 起点与交付方式

原树静态核对的分支为 `feat/rpg-plugin`，HEAD 为 `18f6a55`。工作树包含 `.claude/launch.json` 修改、未跟踪的玩法测试、插件、草稿和实验输出，因此该提交只标识已提交代码基线。B0 使用独立工作树 `D:/DeepSeek Harness/Perspectra-composable-impl`，分支为 `codex/composable-engine-implementation`，HEAD 仍为 `18f6a558ba2064baddfe28f38eb5e1ed4c555954`；带入材料与排除项见 [B0 基线记录](2026-11-11-composable-engine-b0-baseline.md)。各批开始时重新记录分支、提交与实际差异，已有任务材料按所属范围保留。

例如一个搜证模块，应通过真实游戏入口提供搜查动作、扣除精力、生成授权线索与目击观察，再通过默认舞台和短剧本完成验证。每批交付形成可审查的代码差异、相关检查结果和当前文档更新。

2026-11-16 当前状态：B0–B10 已集成，B11 已完成本轮源码、自动回归、8025 DeepSeek Flash 代表场景及隔离便携入口验收。原生桌面窗口、干净机器和完整长局体验未验收；这些范围与本轮证据分开登记。具体修复、独立审查及限制见 [B11 记录](2026-11-16-composable-engine-b11-acceptance.md)。

## 2. 已确定边界与施工参数

| 已确定事项 | 施工处理 |
| --- | --- |
| 核心硬预算与实例资格 | 激活、并发和期限在实际执行入口校验，周期换界沿用宿主剩余额度 |
| 独立实例根 Fiber | 每个世界、Lens 与候选拥有服务绑定、注册与资源清理 |
| 规则与原子提交 | 限制合取、唯一处理器、共同候选快照上的单层 afterAction |
| 周期与时间 | 输入无关周期，正常完成后 onCycleEnd，世界时间采用现有机制 |
| 有限恢复 | 已提交事实保留，未提交周期后续允许丢弃 |
| 作者定义 | 原生与脚本共享状态、操作、NPC 说明、展示与结果契约 |
| 数据兼容 | 数据兼容声明覆盖持久结构及语义，具体迁移按实际数据对象处理 |
| 工具与前端 | 通用表单、控件、两类只读面板及正式执行链无头推演 |

类型签名在 B1 固定，硬预算计量与默认值在 B3 固定，脚本导出语法和游戏包字段在 B7 固定，表单支持范围在 B8 固定。各参数连同消费者和最小示例写入相应当前文档。改变定稿语义时，随变更同步规范与验收。

## 3. 批次总览

| 批次 | 交付结果 | 前置 | 施工状态 |
| --- | --- | --- | --- |
| B0 | 检查基线、数据范围与可复用验收场景 | 定稿 | 已通过主代理复核 |
| B1 | 轻量公共契约与强类型作者定义 | B0 | 已通过主代理验收 |
| B2 | 装载失败边界、实例 Fiber、故障与取消保护 | B1 | 用户指出偏离后修正，独立 Sol 收口复审通过 |
| B3 | 公共引擎执行、硬预算、执行周期与正式决策结果 | B2 | 修复后通过独立 Sol 审查 |
| B4 | 原生状态与活动注册、操作规则和单层派生 | B3 | 独立 Sol 复审通过 |
| B5 | 通信、自主、节奏及记忆／模型能力对接 | B4 | 独立复审通过，见后续阶段记录 |
| B6 | RPG／TRPG 原生玩法迁移与数据兼容 | B4、B5 | 已通过独立 Sol 收口复审及九项修正复验 |
| B7 | 游戏包显式组合、共同脚本入口和配置校验 | B6 | 通过独立复验及主代理验收，见 [B7 记录](2026-11-15-composable-engine-b7-packs.md) |
| B8 | 默认动作、控件、面板与作者配置界面 | B7 | 已通过独立复验及主代理验收 |
| B9 | 无头推演、搜证创作闭环与分阶段性能记录 | B8 | 已集成，见 [B9 记录](2026-11-15-composable-engine-b9-simulation.md) |
| B10 | 包职责、命名空间、应用目录与构建入口收敛 | B9 | 已集成，见 [B10 记录](2026-11-15-composable-engine-b10-packages.md) |
| B11 | 整体回归、真实试玩、发行构建与接手记录 | B10 | 本轮范围验收通过，见 [B11 记录](2026-11-16-composable-engine-b11-acceptance.md)及其未验收范围 |

此顺序先用现有目录承接职责，目录收敛集中在 B10。发现技术依赖需要前移某项迁移时，记录具体消费者及必要范围。每批完成时登记真正接通的入口，后续批次继续处理其剩余差距。

## 4. B0 检查基线与数据范围

交付一个可以复用的施工起点。执行记录、互动例子、五类机械对照、真实入口和持久对象见 [B0 基线记录](2026-11-11-composable-engine-b0-baseline.md)。

1. 记录实际工作树差异，核对当前游戏、CLI、Launcher 和 Lens 入口。
2. 执行基线类型检查、生产边界检查和涉及本轮机制的代表测试，记录已有失败及环境条件。
3. 登记源码示例包、实际需要保留的用户源包和存档。历史 `D:/worlds` 使用只读方式，新实验指定新数据目录。
4. 选取封闭对话、通信、节奏、RPG 和 TRPG 的现有小场景作为迁移前机械对照。
5. 记录当前 `generatedContent`、插件选择记录、状态和活动数据的真实持久化对象，为 B6／B7 确定迁移方式。

现有基础见[宿主测试](../../../tests/host/world-runtime.test.ts)、[核心即时提交](../../../packages/application/src/world-round-execution.test.ts)、[RPG](../../../tests/host/rpg-perform-path.test.ts)和[TRPG](../../../tests/host/trpg-activity.test.ts)。

验收以可重跑命令、场景路径、结果和必要环境说明为准。实测链接检查基线有 103 条历史源码/导航断链；检查器另行报告 103 项未带入本地的历史产物缺失，两者是独立计数。旧文曾把产物缺失记作 24 项，现以真实日志为准。各批核对新增问题与该断链集合的差异。

## 5. B1 公共契约与自描述定义

主要位置为 contracts、plugin-sdk、kernel 公共规则类型及现有状态／活动结果解析。

1. 把 SDK 当前依赖实现包的公共规则输入输出归入稳定契约，保持 ID、地址和 JSON 类型一致。
2. 固定玩法定义、状态、操作、参数 Schema、offer、resolve、NPC 描述、展示和配置校验的类型关系。
3. 定义结构化业务拒绝、插件故障、预算耗尽与周期终态的调用结果，复用现有正式结果信息。
4. 明确 Provider 替换与多定义注册的数量语义，以及实例打开、关闭和执行资格。
5. 脚本和 JSON 的待校验数据在边界保留运行校验，作者公开接口使用具体类型。

交付可编译的最小玩法定义及现有调用方的类型适配。此时继续使用现有包位置和运行入口。

验收覆盖公共类型独立导入、Schema 与参数结果对应关系，以及现有调用方类型检查。候选与操作结果校验复用已有逻辑，新增测试针对新类型接入可能遗漏的运行时错误。

B1 实际交付见 [轻量公共契约与强类型作者定义记录](2026-11-12-composable-engine-b1-contract.md)。当前接通范围是 contracts 公共类型、SDK 作者定义、application 参数／结果 Schema 校验、最小搜证示例、编译负例和独立导入检查。没有新增 Provider 注册、实例生命周期、执行周期、操作处理器、事件提交或 UI。

## 6. B2 装载、生命周期与故障边界

审阅后的接口、任务写入范围与验收结果见 [B2 施工记录](2026-11-12-composable-engine-b2-lifecycle.md)。Kimi 制定方案，主代理补充真实授权交互、错误来源和协作接口后交由 DeepSeek 实施；源码和故障回归已通过主代理复核。

主要位置为[插件装载](../../../desktop/host-plugins.ts)、[默认组合](../../../desktop/official-bundle.ts)、[机制保护](../../../desktop/host/gameplay-services.ts)、[世界打开与关闭](../../../desktop/host/world-runtime.ts)和[实例运行](../../../packages/runtime-cordis/src/runtime.ts)。

1. 分离进程工厂登记和每实例能力绑定，装载实例根插件并保存其 Fiber。
2. 把包专属注册、监听、任务和 effect 归入实例 Fiber，明确共享资源拥有者。
3. 对显式玩法、显式 Provider 和选定必要能力实行打开失败边界，清理已有部分资源。移除对应默认回填与调度打开失败回退。
4. 把业务拒绝改为结构化结果。插件异常和无效返回值在所属边界归因，核心存储错误保留其真实来源。
5. 在原生导入前核对用户已有允许状态，包含独立配置校验入口。安装、允许和世界启用的入口使用同一记录语义。
6. 补齐输入输出所有权保护、异步取消主动结束等待、迟到结果失效，以及逐项清理抛错或挂起的处理。

验收复用[插件装载测试](../../../tests/desktop/host-plugins.test.ts)、[原生机制测试](../../../tests/host/native-provider-runtime.test.ts)、[调度接缝](../../../tests/host/scheduler-seam.test.ts)和[Cordis 实例测试](../../../packages/runtime-cordis/src/runtime.test.ts)。

补充最小故障场景包括 Provider.open 失败、原生 TypeError、两个实例共享插件代码后关闭 A、忽略取消的 Promise、清理抛错与晚到 open 资源。检查 B 的服务、注册和响应，以及当前操作的真实提交结果。

## 7. B3 公共引擎执行、硬预算与周期

主要位置为 application 的 WorldApplication、CharacterTurn、RoundCoordinator、scheduler-round、world-round-execution，以及宿主 world-runtime 中的执行协调。

1. 收回可复用引擎装配和执行逻辑，提供 Host、测试与 Lens 均可调用的公开入口，运行资源通过参数或已有服务接入。
2. 在正式激活边界原子检查次数、并发和期限。预算归属于宿主请求或会话，多个周期和收尾激活消费同一剩余额度。
3. 在实际模型发送边界记录发送与重试，明确角色决策、后台记忆等任务各自的资源归属和可计量范围。
4. 引入输入无关的执行周期身份和终态。正常完成后提供 onCycleEnd，预算耗尽、取消和故障分别反馈。
5. 保留 perform／publish／abstain、行动已提交后的续写，以及表达失败的部分成功结果。
6. 实例与周期临时状态采用有限恢复范围，已提交事实与世界时间沿用现有机制。

验收复用[调度场景](../../../tests/scenarios/scheduler-round.test.ts)、[角色循环](../../../tests/host/character-loop-seam.test.ts)、[执行结果](../../../tests/scenarios/character-execution-result.test.ts)和[即时提交测试](../../../packages/application/src/world-round-execution.test.ts)。

新增最小场景覆盖并发抢额度、周期反复换界、格式重试计数、无玩家输入启动，以及 perform 成功后 publish 故障或 abstain。关闭后正式执行入口失效，已提交结果保持一致。

## 8. B4 原生状态、活动与规则执行

主要位置为状态／活动 Provider、StatusState、ActivityStateRules、活动生命周期和现有规则装配。

1. 支持在实例作用域原生注册多个状态模块、操作与活动。状态归属、可见性及必要持久化继续通过核心执行。
2. 接通限制合取和唯一操作处理器，重名在装配阶段诊断，正式执行复核全部适用规则。
3. 支持所属模块公开方法组合跨状态效果，同一快照上计算并一起提交。
4. 接通单层 afterAction。对主结果做必要检查、生成共同候选快照、收集派生、检查冲突及最终不变量，再原子提交。
5. 区分主操作内的计算修正与后置派生，验证最终伤害、倒地等状态的一致性。
6. 从自描述定义接入授权 NPC 用途、参数和结果说明，通用决策模板消费这些材料。

交付一个通过公开引擎入口执行的原生搜证模块，验证状态、操作和授权观察。游戏包格式与默认面板在后续批次接入。

验收复用[状态校验](../../../packages/application/src/status-state.test.ts)、[活动生命周期](../../../packages/application/src/activity-lifecycle.test.ts)、[状态机制](../../../tests/host/status-seam.test.ts)和[活动私有材料](../../../tests/host/activity-private-notes.test.ts)。新增场景验证多个派生写同一地址、派生抛错、同房目击及房外隔离。

## 9. B5 通信、自主、节奏、记忆与多模型

主要位置为 official-communication、official-scheduler/autonomy-policy、official-pacing、official-contexts、official-memory-core 和 official-llm 的现有消费者。

1. 通信渠道经公开定义注册，联系人和条件按授权与状态规则计算，观察统一经核心提交。
2. 把机会提名归入 WakeupSource，行动许可归相应限制规则，统一受控激活入口。
3. 把 pacing 候选、正式效果应用与周期结算分别接到对应路径，正常周期的钩子按稳定标识执行。
4. 核对已安装记忆归档、授权来源、前缀及 knownTick 时间语义，保留后台重算与晚到结果检查。
5. 在统一 LLM 入口保留按角色的模型、连接和协议映射，调用统计使用真实发送记录。

验收复用[通信与自主](../../../tests/host/communication-autonomy-seams.test.ts)、[节奏机制](../../../tests/host/pacing-seam.test.ts)、[记忆实现](../../../tests/host/core-memory.test.ts)和[角色上下文](../../../packages/provider-chat/src/character-context-text.test.ts)。

增加可选提名失败后的端侧告警、正常周期结算次数和两个角色分别调用不同连接的最小场景。记忆验证包含授权观察已提交而归档未安装时的恢复，采用控制后台完成时机的测试，按涉及的实际进程边界选择额外中断验证。

## 10. B6 RPG／TRPG 与数据兼容

主要位置为官方 RPG／TRPG 的 config、content、状态和活动实现，以及 host/pack-content 与 plugin-set 的存档检查。

1. 保留现有配置解析和实体引用检查，把生成脚本文本改为注册原生状态、活动和规则。
2. RPG 的背包、战斗、地图和队伍效果按实际共同演化关系组织，TRPG 保留主持人、参与者、检定和私有笔记。
3. 官方消费者通过 B4 公开接口接入，骰子继续使用现有受控随机记录。
4. 定义持久数据兼容声明，覆盖状态含义、活动阶段和必要标识。普通读档按此校验，摘要继续按其实际诊断或候选比较用途处理。
5. 根据 B0 的实际保留对象实施必要的一次性迁移或明确版本边界，记录处理范围。

验收复用[RPG 行动路径](../../../tests/host/rpg-perform-path.test.ts)、[队伍](../../../tests/host/rpg-party.test.ts)、[TRPG 活动](../../../tests/host/trpg-activity.test.ts)、[暗骰与私有笔记](../../../tests/host/activity-private-notes.test.ts)和[插件选择记录](../../../tests/host/plugin-set.test.ts)。

新增最小兼容场景验证文案或兼容逻辑修复可读档、数据语义变更得到清楚诊断，以及同一状态效果与受众在迁移前后符合既定玩法规则。

## 11. B7 游戏包、共同脚本和配置校验

主要位置为 world-pack 的 schema、compiler、pack-content、CLI，宿主包内容读取，providers 脚本适配，以及 Launcher 的包依赖检查。

1. 固定清单字段、插件标识、服务硬要求与轻量脚本入口。普通包省略 services，由内容依赖、玩家设置与公开默认值选定必要能力。
2. 通过 configSchema 和注入的纯校验函数检查配置结构、实体引用及跨字段条件。可执行校验器按原生允许状态导入。
3. 包内脚本导出与原生模块同构的定义，函数在所属执行器调用，元数据与结果经过共同边界。
4. 将现有角色初始材料、记忆种子、知识、资源及作者断言映射到其真实用途；需要保留的内容进入新格式。
5. 迁移代表世界包、模板和随包创作者材料。现有旧解析随其消费者转换后清理，过时 Golden 按已确定新语义更新。
6. 在正常 CLI、Launcher 和游戏打开入口完成显式玩法解析与诊断。

验收检查原生和脚本搜证定义的等价结果、空额外玩法组合、缺失依赖、服务硬要求冲突、未允许原生代码及纯配置校验独立运行。

相关基础见[世界包包目录](../../../packages/world-pack)、[插件依赖](../../../tests/desktop/plugin-requirements.test.ts)、[包内容](../../../tests/host/rpg-pack.test.ts)和[共同包内玩法](../../../tests/scenarios/dual-plugins.test.ts)。

## 12. B8 默认展示与作者界面

主要位置为 frontend/player-view、默认舞台、客户端请求、宿主投影与 HTTP，以及 Launcher 配置表单和创作者页面。

1. 接通通用动作分组和 argumentSchema 表单，明确首批支持字段及授权实体候选。
2. 把 pacing 专用设置路径收敛到 pluginControls，明确端侧、运行偏好和世界机制设置的保存与生效范围。
3. 增加属性表与条目列表 panels，数据从玩家授权投影取得，保持普通文本呈现。
4. 同步完整视图、增量更新、控件请求路由、合法值校验及错误反馈。
5. Launcher 根据 configSchema 渲染支持范围内的配置，静态说明与运行诊断提供配置位置。

验收从正常舞台进入搜查、观察精力与线索列表、修改合法控件。补充新增目标分类可见、非法参数、私有面板隔离与增量更新回归，并做浏览器交互和必要的窄屏检查。

现有基础见[玩家视图](../../../packages/frontend/src/player-view.ts)、[默认舞台](../../../packages/frontend/src/default-template.ts)、[节奏开关测试](../../../tests/host/pacing-toggle.test.ts)和[宿主前端边界](../../../tests/host/boundaries.test.ts)。

## 13. B9 无头推演与完整创作切片

主要位置为 Lens simulation／scenario、公开引擎入口、进程内计划实现与 worldpack 命令装配。

1. 保留动作匹配、NPC 计划和断言，改用 B3 的公开执行入口与进程内计划提供者。
2. 验证正式上下文时使用最窄的脚本模型调用替代，保留 Default DecisionService 的授权组装。
3. 接通目标 simulate 命令、结构化拒绝码、每角色观察、玩家面板与故障断言。
4. 采用隔离临时 SQLite，记录启动、编译、初始化、剧本执行与清理的实际耗时。
5. 完成一个搜证实现文件、显式启用声明和短剧本，在正常 CLI 与舞台均能使用。

验收覆盖精力耗尽、重复证物规则、同房目击、房外隔离、线索私密性和原生／脚本等价。异常测试验证真实提交与授权数据，性能指标依据明确测量范围报告。

复用[Lens 模拟测试](../../../tests/host/lens-simulation.test.ts)、[CLI 测试](../../../tests/host/lens-cli.test.ts)和[RPG 推演](../../../tests/host/lens-rpg.test.ts)，把桩 HTTP 依赖从新的正式无头路径中移出。

## 14. B10 包职责与应用端收敛

2026-11-15 实施与独立审查记录：[B10 包边界与应用入口迁移](2026-11-15-composable-engine-b10-packages.md)。该记录保留当时提交与检查状态。2026-11-16 已同步远端集成提交 8c6a33f0，默认回归限制的本轮处理见 B11 记录。

完成玩法闭环后，再按实际依赖迁移到 `@perspectra/*` 及 Host／Launcher 的参考布局。

1. 汇总已经形成的 SDK、核心、Provider、玩法、工具链与前端职责，决定实际包边界。
2. 迁移目录、公开 exports、workspace 依赖、TypeScript／Vitest／Vite 别名和必要脚本。
3. 拆分 Host 与 Launcher 管理端入口，Lens 静态分析和动态装配分别归位。
4. 保持模型适配、Python 记忆及实验代码的独立加载，整理失去消费者的旧模块。
5. 同批更新真实模块地图、当前代码路线、构建入口和生产边界检查。
6. 接通 Node 后端、玩家舞台、创作者界面、Launcher 以及便携包所需公开导出和资源复制。

验收以实际导入、启动和构建为准。检查单独导入 SDK／RPG 的依赖树、缺少模型和 Python 时的静态校验，以及隔离目录中的运行入口。包数量按验证后的职责收敛。

## 15. B11 整体验收与交付

1. 执行当前默认检查及 Launcher 检查，核对各批新增回归和源码边界。
2. 使用已有允许的模型连接，在新数据目录试玩基础对话、通信、自主、搜证、RPG 和 TRPG 的代表场景。
3. 验证正式行动后续写、拒绝后的叙事、消息认知、主持人私有信息、重复回应与节奏表现。
4. 按实际构建说明生成程序候选，在隔离发行目录检查 CLI、作者类型声明、simulate、舞台、管理端及必要记忆资源。
5. 更新定稿差距表、模块地图和接手说明，记录各项完成证据及有意识接受的限制。

发行检查参考[构建说明](../../../scripts/release/BUILD.md)、[便携包验证](../../../scripts/release/verify-portable.mjs)与[创作者工具验证](../../../scripts/release/verify-creator-skill.mjs)。具体发行或发布动作依据用户的实际交付要求进行。

完成条件是正常入口可用、关键不变量与失败路径有证据、真实角色体验和发行包含范围分别有结论。有限恢复和可信原生同步阻塞等已接受限制保留在交付说明中。

## 16. 检查命令与状态登记

当前命令来自根 package.json 和[基线说明](../../current/baseline.md)。以下是施工时采用的命令形式，源码迁移后同步其真实入口。

```powershell
corepack pnpm@11.7.0 typecheck
node scripts/check-host-boundaries.mjs
corepack pnpm@11.7.0 test:related packages/runtime-cordis/src/runtime.test.ts tests/host/scheduler-seam.test.ts
node scripts/docs/check-links.mjs
```

普通逻辑批次运行类型检查和相关单元／集成测试。权限、提交、生命周期和预算批次验证对应失败路径。前端批次检查视图与真实浏览器，角色协议和上下文变化安排真实模型体验。涉及实际进程中断语义的变更再选择相应中断验证。

整体与发行阶段采用当前项目命令。

```powershell
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 launcher:check
corepack pnpm@11.7.0 desktop:build
corepack pnpm@11.7.0 launcher:build
```

完整回归的 Python／E5 和 Windows 子进程条件沿用基线说明。文档同步单独执行链接检查，旧研究断链与新引入链接问题分别登记。

每批更新本计划的状态、实际修改入口、运行命令与结果、已验证不变量、真实体验范围和剩余差距。一个批次的测试通过记录对应切片，整体验收在 B11 汇总。

### 16.1 B0 执行记录

2026-11-11，B0 在独立工作树执行，未修改生产源码或测试。主代理带入定稿、契约、计划、草稿和入口文档，完成离线依赖安装、typecheck 与宿主边界检查；本阶段新增 [B0 基线记录](2026-11-11-composable-engine-b0-baseline.md)，调查 `worldpack`、`experience:web`、Launcher、Lens、插件选择记录、生成内容摘要、状态、活动、故事节点与分享读写。

批准的 12 个文件以 `--maxWorkers=1` 完成相关测试：12/12 文件、135/135 测试通过，Vitest 汇总耗时 124.08 秒，真实退出码 0。原始输出为 `.tmp/composable-engine/b0/tests.log`。该输出只有整体汇总，没有为每个文件提供独立测试数量，因此本计划不补写推测值。

文档修改后运行 `node scripts/docs/check-links.mjs`，真实退出码仍为 1；前后完整 missing-target 集合均为 103 条，新增 0、移除 0；`Historical local artifacts absent` 独立报告 103 项。真实输出与比较分别保存在 `.tmp/composable-engine/b0/docs-links-after.log`、`docs-links-after-exit.txt` 和 `docs-links-comparison.json`。

本阶段没有真实模型请求，没有运行全仓检查，没有验证真实试玩、GUI 或发行包，也没有读取或写入 `D:/worlds`。主代理已核对原始测试结果、实际入口与持久对象并确认无新增文档断链，B0 通过。B1 按用户指定分工进入细节规划。

### 16.2 B1 执行记录

2026-11-12，B1 采用并行分工完成公共类型迁移、SDK 作者定义和 application 薄校验。contracts 固化 Manifest、Rulebook、表现数据；kernel／frontend 保留算法并重导出同一类型。SDK 新增强类型操作、玩法定义、正式结果及最小搜证示例，不再依赖 kernel／frontend。application 只编译参数／结果 Schema并校验、复制外部 unknown，不执行定义或提交效果。

最终合流检查为：SDK 包级契约 tsc 退出码 0；新增作者／校验测试、独立导入测试及既有 status／activity 测试共 5 文件、24 测试通过，退出码 0；全仓 typecheck 退出码 0；宿主边界退出码 0，覆盖 413 个生产文件；定向 Prettier／oxlint 退出码 0。SDK 离线 frozen install 与相关 kernel world-spec／manifestation 5 测试已由 SDK 代理执行通过。原始日志在 `.tmp/composable-engine/b1/`。

文档链接检查真实退出码为 1；相对 B0 的 missing-target 集合仍为 103 条，新增 0、移除 0。`Historical local artifacts absent` 独立报告 103 项。比较记录见 `.tmp/composable-engine/b1/docs-links-comparison.json`。

当前只接通作者契约与薄校验。B2 实例生命周期、B3 周期执行、B4 原生注册与派生、B7 脚本／包格式、B8 默认 UI 均未接通；现行 status／activities unknown 边界保持不变。主代理已核对真实源码、类型正负例、独立导入闭包、校验测试及文档差异，B1 验收通过，B2 进入细节规划。

### 16.3 B2 执行记录

2026-11-12，Kimi K3.1 Pro 细化方案，主代理审阅协作接口、原生许可、取消与错误来源后，DeepSeek v4.1 flash 分工完成生命周期、装载／界面、宿主接入与真实集成测试。主代理补充预约竞态和核心错误传播回归，修订中保留已提交事实、受众权限和原错误来源。完整写集与证据见 [B2 施工记录](2026-11-12-composable-engine-b2-lifecycle.md)。

scope／应用关闭 4 文件 25 项、装载 5 文件 95 项、Launcher 相关 store 2 文件 38 项、宿主最终集 14 文件 197 项分别通过；主代理最终节奏、RPG、TRPG、生命周期和角色执行代表集 5 文件 74 项通过。以上集合有重叠，不相加。根 typecheck、Lint、全源码格式检查退出码均为 0；边界覆盖 415 个生产文件。根 Lint 有 27 条未改文件警告，本批改动文件无警告。Launcher 类型和离线 frozen install 通过。日志均在 `.tmp/composable-engine/b2/`。

浏览器预览实际验证独立许可／加载选择、保存重开及换路径撤销；它使用 mock 状态，磁盘往返由 LauncherCore 测试证明。没有真实模型、Tauri 或发行验收。文档链接沿用历史基线，没有新增断链。B2 通过主代理验收，B2 独立 Sol 复核四项发现均关闭；B3 按用户最新要求由主代理直接实施、完成后独立 Sol 审查。

### 16.4 B3 实施与独立审查记录（已通过独立复审）

2026-11-12，主代理接通 application 的真实分支资源绑定、公共调度驱动、请求硬预算、系统刺激周期、真实发送计量和部分成功结果。低层 CoreCycleEndHook 只作内部结算适配；B4 作者所属投影与 B5 既有业务迁移仍按原范围实施。源码位置和检查结果见 [B3 施工记录](2026-11-12-composable-engine-b3-execution.md)。

独立 GPT-6.1 Sol 首轮发现实际提交错误被取消吞掉、成功重规划误判中断，以及公共驱动遗漏结算观察收尾三项缺口，B3 未放行。主代理修正这些实现并加入真实 SQLite、公共周期和 Host 交换房间回归，不通过回退目标行为迎合历史断言。原独立探针 6 项在修复版全部通过，正式核心 2 文件 19 项通过；Host 回归与独立复审正在收尾。上述结果不能提前表述为 B3 验收通过。

2026-11-13，继续修复独立复审发现的异步收尾取消等待。最终独立 3 文件 15 项探针通过，并确认真实错误身份、在途占额、迟到能力失效和公共收尾均符合 B3。主代理最终核心 23 项、Host 47 项通过，类型、定向 Lint／格式与 419 个生产边界通过，文档新增断链 0。B3 通过独立审查与主代理验收，B4 进入实施；真实模型、GUI 与发行包尚未验收。

### 16.5 B4 实施记录（独立复审通过）

2026-11-13，主代理完成原生多模块注册、显式状态归属、公开方法与限制合取、唯一处理器、同快照单层派生、所属合并和最终不变量，并接入既有玩家入口与受控角色回合。搜证通过公共引擎执行；活动生命周期与接收者结果投影、原生周期结算和恢复校验均有实际路径。具体类型收口和本地证据见 [B4 记录](2026-11-13-composable-engine-b4-gameplay.md)。

原生及 SDK 最新 4 文件 36 项、计划相关 9 文件 58 项、执行入口回归 8 文件 91 项分别通过，集合有重叠。新独立 Sol Curie 正在按总计划审查，B4 尚未放行，不进入 B5。包／脚本装载、默认 UI、真实模型和发行验收仍按后续批次登记。

2026-11-13 独立复审收口：R1–R7、用户附件 targetId 及目标候选／正式过滤差异均已修复，Curie 最终放行。独立 10 项正确行为探针、8 文件 62 项正式测试、根类型检查通过；主代理 Host／核心执行回归 5 文件 64 项、最后原生 34 项通过，定向 Lint／格式与 420 生产边界通过，文档新增断链 0。此前未通过状态保留为过程记录，以本次结论为准。B4 验收通过，进入 [B5 施工](2026-11-13-composable-engine-b5-services.md)。

### 16.6 B5 实施与收口记录

2026-11-14，主代理完成 B5 通信、自主与唤醒来源、普通周期结算、长期记忆恢复边界和统一逐角色模型通道迁移，并收口独立审查 R1–R4 与草案对照复审项：

- 官方串行／并发调度汇总各分项终态，预算或期限截断不触发 `onCycleEnd` 正常结算；status／pacing 普通结算迁入公共引擎，按内部依赖次序至多执行一次，结算后仅处理新观察而不重复旧提名；静观保留前置时间结算语义。
- 公开 `WakeupSource` 叠加注册贯穿 `WorldExecutionEngine.registerWakeupSource`、`GameplayDefinition.wakeupSources`（随所属 Cordis 子 `Context` 释放）与宿主 `ctx.scheduler.registerWakeup`，同角色提名合并后共用同一 `CharacterTurn`；可选唤醒源与可选自动活动条件仅降级作者故障，已标记的核心回调错误与取消信号原样透传。
- 通信采用公开 `CommunicationDefinition` 与动态 `contacts` 收窄，手动 `/message` 贯穿请求键实现幂等重放且纳入当前执行周期观测，`prepare` 非法结构归属插件 `invalidResult`。
- `GameplayRuntime.resolver().resolve` 对正式入口的过期 `bindingId`、非法参数与失效 `targetRef` 返回结构化拒绝并优先保留作者业务拒绝码，消除非插件 `TypeError` 阻塞 `round_inbox` 的风险。

验证结果：全仓 `tsc --noEmit` 退出码 0；生产边界检查覆盖 421 个生产文件；SDK 契约与导入闭包 4 项、`application` 原生／执行 3 文件 59 项、Host 接缝 7 文件 114 项、`provider-chat` 5 项、场景回归 3 文件 48 项及独立审查 `sol-review` 探针 2 文件 10 项全部通过；改动文件定向 Lint／Prettier 通过，文档链接相对基线新增断链 0。具体说明见 [B5 施工记录](2026-11-13-composable-engine-b5-services.md)。本批未运行真实模型试玩、Tauri GUI 与发行验收；按用户要求在 B5 完成后停下，尚未进入 B6。


### 16.7 B6 实施与独立收口

2026-11-15，官方 RPG／TRPG 配置展开为实际注册的 GameplayDefinition，正式状态／活动 Handler、限制与单层 afterAction 由 B4 公共执行器裁定；骰子继续使用现有受控随机记录，状态／活动效果经共同冲突归并与最终不变量检查后原子提交。共同准入覆盖模块角色、已知 policy、目标和可达性、当前活动许可及作者开始条件。兼容声明由实际定义生成，普通读档／分享在写入前只读检查记录、实际 Schema 和 phase；候选摘要保持其环境比较职责。

独立 GPT‑6.1 Sol Mill 最终 PASS，R1–R3、A1–A3 与 F1/F2 均关闭。最后独立 11 探针、5 文件 88 项正式测试通过；前一独立组 7 文件 116 项及早期 13 文件 161 项通过，集合有重叠不相加。主代理根类型、Lint、格式、425 生产边界通过，文档新增断链 0。完整范围和日志见 [B6 施工记录](2026-11-15-composable-engine-b6-rpg-trpg.md)。未做真实模型／GUI／发行验收，未提交或推送；按用户要求停在 B6，不进入 B7。


### 16.8 B6 九项复核修正

2026-11-15，用户要求修复九项问题后另行独立审查。实现保持 B2–B6 的既有边界：所选 Provider 实际参与官方计算、私有引用保护、核心错误优先级、调度数据隔离与返回校验、通信故障归属、目标传递、手动生命周期派生及投递后展示降级。详见[九项修正记录](2026-11-15-composable-engine-b6-followup.md)。九项及独立复审发现的三处残留均已修复；三组独立复验全部 PASS，12 项独立探针通过。最终根类型、425 生产边界、定向 Lint／格式通过，文档新增断链 0。不进入 B7；未增加强制恢复承诺或改变世界时间。


### 16.9 B7 完成与验收（2026-11-15）

按用户最新要求，以定稿目标而非实施细节为准。保留 v5 内容布局，接通显式 plugins、可选 services 硬要求、共同脚本和注入式配置校验；原生／脚本搜证共用注册、裁定、授权投影和真实 Host 状态提交。三组独立审查发现九项问题，修复及复验遗漏均关闭，最终全部 PASS。主验收 24 文件 427 项、扩展回归 17 文件 248 项通过；保存发布强杀复验 1 项通过。根类型、定向 Lint／格式、429 生产边界通过；文档新增断链 0，既有 103 条缺失报告保留。没有重新执行完整 check，不据此声称全仓或真实体验通过。详见 [B7 记录](2026-11-15-composable-engine-b7-packs.md)。B7 验收完成，停在 B7，不进入 B8；未改变时间推进、未增加强制恢复承诺，未提交、合并或推送。


## B8 实施记录

默认展示、正式控件和作者配置编辑已接通；按目标实施，无新增包／UI 框架／事件总线，不改变世界时间。独立审查和浏览器发现的问题已修复并通过三组独立复验，最终证据见 [B8 记录](2026-11-15-composable-engine-b8-presentation.md)。主验收 21 文件 231 项、Launcher 9 文件 103 项通过，类型／构建／格式／边界通过；文档新增断链 0。B8 已验收，不进入 B9。


## B9 实施与独立验收（2026-11-15）

主代理在云端从 B8 交接提交 `153ca9b34199c4152e6fa67733c5081a6585bb93` 接续。Lens 经正式 Host／公开执行周期运行，以进程内模型传输替代 HTTP 桩，保留 Default DecisionService 授权组装；接通 worldpack simulate、真实状态／裁定拒绝／角色观察／实际上下文／玩家面板／结构化故障断言，提供显式启用的两房间搜证包。

独立 GPT-6.1 Sol 首轮发现 fault JSON 白名单遗漏，最后 NPC 回归发现双层包装重复候选；主代理分别修复并重跑，最终独立 PASS，无剩余阻断。主回归 9 文件 125 项通过，类型、定向 Lint／格式、434 生产边界通过；文档相对本次基线新增断链 0。真实 Linux Chromium 点击搜查后显示精力 1 和私有线索，页面无脚本错误。耗时分段、命令、失败修复过程、独立证据与阅读路线见 [B9 记录](2026-11-15-composable-engine-b9-simulation.md)。

没有调用真实模型或计费接口，没有做 Windows 原生 Tauri、发行或全仓验收；未提交、推送、创建 PR、合并或发布。B9 已验收，改动保留本任务工作树，停在 B9，不进入 B10／B11。
