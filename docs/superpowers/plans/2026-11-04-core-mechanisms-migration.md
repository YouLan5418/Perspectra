# 核心、Cordis 机制与脚本玩法迁移计划

日期：2026-11-04。探查基线：`a924513e`，分支 `fix/activity-notice-and-revision`。依据[统一规范](../../current/architecture/plugin-standard.md)。状态：**M0～M4 已实施，M5～M7 待实施**。本计划保留探查基线时的源码判断；当前成果与测试证据见[M0／M1 记录](../../current/studies/2026-11-core-migration-m01.md)、[M2 记录](../../current/studies/2026-11-core-migration-m2.md)、[M3 记录](../../current/studies/2026-11-core-migration-m3.md)与[M4 记录](../../current/studies/2026-11-core-migration-m4.md)。未注明完成的目录与能力仍为实施目标。

例如料理比赛和 RPG 战斗可以共同使用状态、活动与交互机制，各自提供脚本规则；核心只确认调用者、授权范围和合法效果，并保存完整事实。移除这些玩法和非必要算法后，仍留下能管理实体、事件、权限、通用状态和提交的最小运行时。

## 1. 探查结论

当前主要问题不是缺少更多替换槽位，而是机制算法、脚本适配、通用权限检查与提交职责仍混在一起。不能把全部 `pack-*` 原样搬进官方插件，再把其宿主参数全部公开。优先复用阶段 0～11 的服务、角色执行能力和存储，不重建插件框架。

本次阅读了下面列出的装配、规则、存储和脚本路径，以及相关测试夹具／断言；未运行全量测试、真实模型或完整发行验证，也没有生成全仓静态依赖图。行数仅说明探查基线的规模，不作为迁移进度或拆包指标。

| 源码证据 | 已确认的耦合／可复用点 | 迁移判断 |
| --- | --- | --- |
| [world-runtime.ts](../../../desktop/host/world-runtime.ts)，1941 行，create、构造函数、endPlayerRound、turnFactory | 同时持有模型、游戏包编译、具体玩法、角色激活、节点与玩家投影；固定地装配 PackModules 和基础交互包 | 保留宿主运行／交付，逐项退出具体机制选择与玩法调用 |
| [world-gameplay.ts](../../../desktop/host/world-gameplay.ts)，185 行 | 聚合状态、活动、通信、知识、自主；固定 `builtin:speak-move` 包装链；statusContext 自己打开数据库 | 过渡装配点，不升级为包含全部方法的公共 ctx.gameplay |
| [pack-status.ts](https://github.com/YouLan5418/Perspectra/blob/a924513e/desktop/host/pack-status.ts)，1326 行，adjudicate、itemEvents、commitRound、apply、endRound | Schema、VM、规则、物品合法性、观察与独立写租约／提交在同一类；活动通过 activityEvent 复用状态变化 | 先区分核心检查与效果提交，再抽状态脚本机制；不能直接移动整类 |
| [pack-activity.ts](https://github.com/YouLan5418/Perspectra/blob/a924513e/desktop/host/pack-activity.ts)，1525 行，apply、state、rulebooks、autoStartCandidate | 活动协议、public／private／internal、参与者、规则、VM、存储与开始／暂停等提交混合 | 活动计算迁机制，提交与授权边界留核心；旧脚本语义先保持 |
| [pack-activities.ts](https://github.com/YouLan5418/Perspectra/blob/a924513e/desktop/host/pack-activities.ts)，379 行 | 资产发现、前台活动选择、快照缓存、自动开始和默认核心规则回退 | 活动目录／选择迁机制；默认规则与数据读取改为显式注入 |
| [pack-communication.ts](../../../desktop/host/pack-communication.ts)，308 行，resolve、perform | 联系人规则和消息表达与玩家绑定检查、写租约、commitRound 混合 | 通信业务迁机制；收发授权与提交仍由核心能力执行 |
| [pack-knowledge.ts](https://github.com/YouLan5418/Perspectra/blob/40666bfa/desktop/host/pack-knowledge.ts)，141 行，parse、select | 读取包资产、选择设定材料；条件明确使用授权 context；依赖 pack-status 的 knownStatusView | 适合作为低风险首个迁移样本，先抽纯授权视图转换，避免拖入整个状态模块 |
| [pack-autonomy.ts](../../../desktop/host/pack-autonomy.ts)，311 行 | 作者配置、到期机会与操作限制；认识状态／活动／短信操作名称 | 配置与合法选项迁机制，机会策略继续复用 scheduler；不再写另一套调度循环 |
| [pack-modules.ts](../../../desktop/host/pack-modules.ts)，332 行 | 已有包内声明与同步脚本；statusSource 拼接基础状态与模块源码；异步 prepare 只拿已知值与 actorWorldView | 保留作者入口，分离装载／纯脚本适配和原生能力桥，不重造脚本协议 |
| [CharacterTurn](../../../packages/application/src/character-turn.ts)，852 行；[RoundCoordinator](../../../packages/application/src/round-coordinator.ts)，1092 行 | 两条实际提交路径：角色循环能力与玩家回合；包含最新前缀、租约、规则和观察处理 | 都要保护；不能只迁 NPC 而遗留玩家／活动／短信专用写库路径 |
| [WorldApplication](../../../packages/application/src/world-application.ts)，1066 行；[rulebook-registry](../../../packages/kernel/src/rulebook-registry.ts) | application 隐式安装 createBasicInteractionPackage；内核有可注入 RulebookRegistry，但默认注册 builtin:speak-move | 默认玩法选择移到组合；复用已有注入点，不先升级世界格式 |
| [official-bundle](../../../desktop/official-bundle.ts)、[host-plugins](../../../desktop/host-plugins.ts)、[runtime-cordis](../../../packages/runtime-cordis/src/runtime.ts) | 已有公共注册、默认顺序、依赖就绪和分支 Cordis 生命周期；进程服务与分支资源分属不同生命周期 | 延续已有框架，不增加第二容器，不强行合并两个根 |
| [world-store](../../../packages/store-sqlite/src/world-store.ts) 的 assertManifestEvents／commitRound；[CharacterView](../../../packages/store-sqlite/src/character-view.ts)、[授权记忆来源](../../../packages/memory/src/authorized-sources.ts) | 当前写入要求 v10 Manifest 和登记事件；视图／记忆主要消费授权观察 | 保留核心准入与来源，不把任意插件事件开放当作迁移前置 |
| [plugin-sdk](../../../packages/plugin-sdk/src/index.ts) 与 package.json | SDK 同时依赖 Cordis、kernel、frontend，混合作者类型和原生能力；不是纯脚本接口 | 后期按契约拆分公开导出，先确定消费者再定子路径；不先建另一份 SDK |
| [tail-storage](../../../desktop/tail-storage.ts)、[story-nodes](../../../desktop/story-nodes.ts) | snapshotTail、restoreTail 已支持 plugins/ 文件；故事节点 NODE_FILES 仍为固定列表，另有记忆快照路径 | 不能笼统说插件文件完全不支持，也不能宣称分支／分享已统一支持 |

## 2. 目标归属与目录

| 归属 | 内容 | 预期位置／处理 |
| --- | --- | --- |
| 核心 | 实体身份、登记事件、授权视图与观察、通用状态事实检查、执行者身份、原子提交、写租约、存档与分支一致性 | 先保留现有 contracts／application／store-sqlite／runtime-cordis 中对应职责；kernel 只保留通用规则契约和必要世界检查，不按包名整体认定纯核心 |
| 内部机制 | 状态脚本、活动、通信、知识、自主配置，以及现有调度／角色循环／记忆／模型实现 | 使用 Cordis 服务、inject、effect 和每世界实例；候选位置为 official-status、official-activities、official-communication、official-knowledge；自主优先考察并入现有 official-scheduler 的配置适配，必要时才独立包 |
| 外部玩法 | 料理、市场、战斗、狼人杀、日常剧情的规则和流程 | 沿用世界包 plugins/、scripts/ 及其公开声明格式；可复用作者工具继续生成这些资产 |
| 内容 | 人物、地点、物品、文本、事件池、美术和具体玩法配置 | 世界包及现有资源编译流程 |
| 适配与默认组合 | 资产锁定读取、桌面／HTTP、凭证、前端、创作者透视、官方选配 | desktop、Launcher、world-pack；不把这些交付方式混入机制算法或最小核心 |

这些新包名是候选职责名，不是一次性创建清单。一个机制可包含多个内聚文件；同一源码中也可能有核心和机制两部分。外部包脚本不使用 Cordis；原生宿主扩展仍是单独的可信适配入口。

## 3. 拆分时必须保持的接口边界

### 3.1 读取、计算与提交

逐个拆现有方法，不先设计万能 executionPlan 或通用 ctx.gameplay：

1. 核心绑定 address、actor、当前前缀、生命周期信号，构造所需授权输入。
2. 机制执行配置解析、policy、resolve、schedule 等纯计算；可信裁定所需真值与角色可见材料分别传递。
3. 复用现有 RulebookResolution／操作结果形状表达所需效果，先保留当前登记事件和作者脚本协议。
4. 核心复核写入资格、受众、位置／物品等必要不变量，生成或复查观察，再短事务原子提交。
5. 已提交结果保留；取消／过期输出丢弃。异步原生调用与模型计算不占 SQLite 长事务。

机制不能获得 WorldStore、数据库路径或任意 commitRound 回调作为公共接口。资产交付使用验证过的内容描述／读取能力，不能把 CompiledWorldPack 和整个宿主当成每个服务都必须理解的参数。

### 3.2 不把“通用状态基础迁移”变成暂停功能实施

本轮后续迁移只整理当前 statusScript／packPlugin 已有声明、Schema、值与 reveal 检查、status.updated 和已有操作。不会开放任意 Cordis 插件注册新状态、建立新命名空间协议或扩展自定义事件类型。必要校验进入核心边界，作者状态操作仍由机制提供。

剧情导演及通用外部插件状态声明继续暂停。插件私有文件与外部副作用的完整快照体系也不是本次机制拆分的前置项目。

## 4. 分批顺序

每批是独立可审查提交；批内可进一步拆小提交。顺序表示依赖，不承诺天数。源码移动必须与生产调用切换、旧路径删除一起交付，不能长期保留两条实现。

| 批次 | 具体交付 | 依赖／风险 | 结束条件 |
| --- | --- | --- | --- |
| M0：基线与契约清单 | 固定请求／结果基线；按统一模板记录首批机制输入、状态、权限和生命周期；区分包依赖、服务依赖、执行顺序 | 不改行为，低 | 重复运行可比较；文档有实际消费者与源码入口；失败项有可复现记录 |
| M1：知识机制试点＋最小核心探针 | 抽纯 knownStatusView 依赖；将知识选择接入 Cordis 机制；尝试无模型／无具体玩法启动，列出确切阻塞 | 依赖 M0，较低；不接触提交 | 设定选择及私有边界保持；宿主不直接调用 PackKnowledge；探针明确成功范围和缺口，不冒充完整最小核心 |
| M2：核心执行边界与显式默认装配 | 从现有玩法提交方法中先提取主干侧执行职责；拆出不依赖模型／Core 的最小装配入口；基础交互包改由默认组合显式提供 | 依赖 M1；高，影响启动和提交 | 核心可无具体官方玩法管理实体、事件与授权；生产默认包显式装配后仍可玩；写租约／过期／原子性回归通过 |
| M3：状态与包内模块机制 | 先内部拆分 PackStatus，再接 Cordis；PackModules 消费状态机制及原生能力桥；删除旧私有调用 | 依赖 M2；高，活动也复用状态 | 玩家与 NPC、物品效果、onRoundEnd、模块结果都走核心执行；通用状态事实属于核心，现有脚本规则属于机制；不新增外部状态注册 |
| M4：活动机制 | 拆活动计算与实际提交；迁活动集合／前台选择；复用状态机制与现有 scheduler 活动机会桥 | 依赖 M3；高，暂停／恢复／随机／授权 | 活动生命周期、私有信息、一次回合计数、自动开场与回放不变；不另建活动调度器 |
| M5：通信与自主配置 | 通信 resolve 与联系人条件迁机制、发送提交归核心；自主到期／限制适配接机制，机会仍交给 scheduler | 通信依赖 M2／M3，自主依赖 M4；中高 | 不可达与未授权收件人被拒；不会获得远端物理权限；普通／自主／活动调度均可组合 |
| M6：作者接口与目录收口 | 公共 SDK 按机制组织契约；区分脚本入口与原生适配；默认 RP 组合显式声明依赖；宿主与透视改用机制查询 | 依赖前述接口已被真实消费者使用；中 | 两种不同脚本玩法复用同一机制，无私有源码导入；旧 pack-* 生产实现退出；构建与发行资产路径更新 |
| M7：最小运行时与完整组合验收 | 验证无非必要官方能力的核心、默认 RP、狼人杀、RPG、状态市场及原生能力示例 | 依赖 M2～M6；验证风险高 | 核心六项边界成立；不同玩法只靠选配机制与脚本；真实模型和发布验证分别报告 |

## 5. 各批的实施切口

### M0：固定基线，不顺便修全仓

- 复跑 [plugin-seams-baseline](../../../tests/experiments/plugin-seams-baseline.ts) 两次形成新基线，保持受众、私有字段、操作参数与错误，不只比较最终文本。
- 补入当前脚本市场操作、活动状态联动、跨场景通信和双入口能力场景；零模型请求只标为脚本／结果比较。
- 以[阶段 11 记录](../../current/studies/2026-11-plugin-first-phase-11.md)为历史参考。本轮计划没有复跑其 1735 通过、4 失败、4 跳过的结果，实施时重新建立基线。
- 先为 M1／M2 写契约，后面的接口随实际拆分细化，不一次承诺几十个公共方法。

### M1：以知识选择验证机制形状

- 将 PackKnowledge.parse／select 与包资产读取分开。保留 document audience、关键词、预算及授权条件的现有语义。
- 抽取 knownStatusView 的纯数据转换，供状态与知识共用，禁止知识包运行时导入 pack-status。
- 提供每世界知识服务实例，经公开方法接入既有 official-contexts 的知识步骤。宿主不再把闭包固定指向 PackKnowledge；同一授权读取也可被替代步骤使用。
- 用 split-knowledge 与 decision-seam 等已有用例验收“不见他人私有状态／设定”，而不只测注册成功。
- 用当前 WorldApplication／WorldBootstrap／WorldStore 和最小编译夹具做启动探针：区分“WorldStore 本身不需要模型”与“网页游戏入口无需默认插件”这两件事。

### M2：先有核心执行，后搬重模块

- 列出角色 CharacterTurn、玩家 RoundCoordinator、PackStatus 的初始化／apply／endRound、PackActivity.apply／escape、CrossSceneCommunication.perform 的写入与观察路径。
- 从这些具体方法拆离租约、最新前缀、取消与失效判断、actor／受众核验、原子提交。保留必要操作差异，不通过一层万能回调掩盖业务校验。
- 物品的可达性、唯一去向与事实合法性不能随 #itemEvents 整体交给外部脚本；状态 reveal 的授权核验也必须仍受核心控制。
- WorldApplication 的 DEFAULT_INTERACTION_PACKAGES 与宿主 rule-layers 的固定基础交互装配改为入口显式提供；复用已存在的 rulebooks／interactionPackages 注入点。
- 最小入口与网页／Launcher 默认入口分别装配。最小入口不要求 models、Python、预设、舞台或具体内容包；默认入口的错误提示和必需依赖仍保持。
- 当前 Store 要求 v10 Manifest、注册事件，基础规则名称与交互闭合也有约束。先用 M1 探针确认空或最小交互目录是否能满足当前格式；若不能，先记录最小放宽范围和数据需求，再定格式处理，不能直接跳过校验或预设升级新版本。
- M1 探针发现：空交互目录可被 activate 提交，但读取时被 packages 的最小数量约束拒绝。M2 先统一激活／挂载校验和空选择语义，再验证无具体玩法；不得跳过校验。显式选择测试交互包时已可无模型／Python 打开、授权读取和重开；agent-context 仍要求授权来源 SQLite。
- M2 已完成上述校验统一、显式安装和即时执行拆分；保留 NPC／收件箱各自准入路径，新增共享核心即时提交及物品效果检查。空选择的无模型／记忆入口与验证限制见 M2 记录，不能提前认定 M3～M7 已验收。
- 不把 kernel、application 整包搬成插件，也不以“关闭默认插件”掩盖仍被静态导入的玩法实现。

### M3：迁现有状态能力

- 先拆 PackStatus 的资产／VM 适配、声明校验、truth／known 投影、policy／adjudicate、item／reveal 核验、宿主执行。先跑原路径回归，再接 Cordis。
- ensureInitial、apply、endRound 使用 M2 的核心执行路径；机制返回经验证的操作结果，不打开 WorldStore 自行提交。
- 保留 initialize 一次、onRoundEnd 每个有效玩家回合一次、静观和快捷活动的计数；保持状态与对应物品／观察原子提交。
- PackModules.statusSource 的源码拼接先作为现有格式适配保留，分离出明确的解析与调用边界；不在迁移中顺手增加模块自己的回合钩子或异步脚本协议。
- execute／resolveAction 保留 prepare 只见授权值、结果暂存、queued 不算 completed、外部结果未知停止和 committed／failed 的清理语义。

M3 实际切分：核心 StatusState 保留声明、值、告知和授权投影；official-status 通过 Cordis 解释脚本、组合包内模块；StatusRuntime 与 PackModules 只准备合法输入和执行结果。旧 pack-status.ts 及宿主模块 VM 已删除，验证范围见 M3 记录。

### M4：迁活动，不把活动对象变成宿主接口

- activity 的 state／game 校验、脚本操作、schedule／onOutcome、policy、活动规则包装属于机制；活动开始等执行仍走核心绑定的能力。
- 先处理 PackStatus.activityEvent 与活动 resolve 的耦合：使用已注册状态操作／结果校验，不能在两个新包间循环依赖，也不能重复维护一份状态真值。
- 从 PackActivities 抽出资产目录与机制选择，核心规则由组合提供，删除 createInstalledInteractionPackages 的内部回退。
- 保持状态轮末后才检查自动开始、每轮最多一场、已有前台活动不被打断、暂停进度保留；继续用现有随机记录与重生路径。
- 当前自动开始的候选选择语义保持，不趁此加入剧情导演。

M4 实际切分：official-activities 通过 Cordis 解释活动脚本并提供前台／自动开始选择；宿主只提供锁定文本、授权输入、候选和已记录随机数。核心 ActivityStateRules 保留参与者、public／private／internal 形状与授权投影，这是不可替换的事实与隐私边界；原计划将 state／game 校验整体归机制的表述据此收窄。ActivityRuntime／ActivitiesRuntime 继续负责绑定执行、前缀缓存、活动状态与状态规则的合法组合，不向插件暴露整类。旧两个 pack-activity 文件与隐式默认规则回退已删除，详见 M4 记录。

### M5：迁通信及自主配置

- 通信的联系人、消息参数、规则与文案迁到内部机制；真实发送者、收件权限、观察和提交由核心复核。不得用 narration 或私聊地址绕过远程通信授权。
- 自主配置保留 everyPlayerTurns、triggers、机会数和允许操作语义；纯配置读取和限制形成机制，调度预算、顺序与续写仍消费现有 scheduler／characterLoop。
- 操作标识如 experiment:message、activity:、status: 的识别集中在相关适配／契约，逐步退出核心通用执行路径，不能散落为各层的隐式分支。

### M6：统一作者面与装配

- SDK 拆分的第一步是现有类型按机制归属和导出分组；只有实际脚本打包消费者需要时才建立子路径，不提前发布 npm 或升级主版本。
- 每个内部机制都有 Cordis 注册／inject／effect、每世界 open／close，以及同一份契约文档；不能只导出一个工厂就宣称完成内部插件化。
- scripts/status.js、scripts/activities/*.js、knowledge.json、autonomy.json 和 plugins.json 保持各自已发布含义；先统一身份、输入权限、错误、生命周期说明，不把所有文件强行改成一种 hook。
- WorldGameplay 逐项收缩并最终退出具体机制装配；可保留职责明确的宿主适配器，不保留与新机制并行的旧生产实现。
- 创作者查询、包透视、player-input／gameplay-projection、world-pack CLI 和发布脚本逐个换成公开契约；同一机制在游戏和透视里不能形成两份规则。
- 随实际依赖调整[生产边界检查](../../../scripts/check-host-boundaries.mjs)和[对应测试](../../../tests/host/boundaries.test.ts)：核心不导入具体官方机制，机制不运行时导入宿主／数据库私有实现，脚本不依赖原生 SDK。不能为了把旧类移进 official-* 而直接放宽禁止项；例外必须说明真实职责并缩小到具体能力。
- examples/world-packs 承载玩法和内容，examples/host-plugins 承载原生适配示例。迁移已存在源码时同步改相关测试、Skill 和导航，不强制建立尚无装载需求的新安装目录。
- 将默认基础交互、模型、记忆、活动等组成明确的默认 RP 组合；核心入口不再自动补具体玩法。必要机制缺失时明确失败，可选机制停用后不补回。

### M7：按目标验收，不按包数验收

最小核心不加载官方模型、Core 记忆、默认 RP 或具体活动脚本，验证实体／事件／授权／通用状态操作及保存分支；非法调用者、非法效果、失效前缀与取消后提交必须拒绝。物理位置和物品归属仍来自已提交事实。

默认 RP、狼人杀与 RPG 分别使用同一组公开机制。不能靠给核心重新塞一个“测试专用玩法分支”通过最小验收，也不能把会话能显示当成所有玩法已经可组合。

## 6. 验证清单

以下为实施时应运行的检查，本次计划没有执行：

| 风险／改动 | 主要现有验证入口 | 需要确认的行为 |
| --- | --- | --- |
| 读取与认知隔离 | [observation-session](../../../tests/integration/observation-session.test.ts)、[split-knowledge](../../../tests/scenarios/split-knowledge.test.ts)、[decision-seam](../../../tests/host/decision-seam.test.ts) | 未授权私语、状态和设定不会进入另一角色请求 |
| 状态与物品 | [pack-status-runtime](../../../tests/host/pack-status-runtime.test.ts)、[status-market-items](../../../tests/host/status-market-items.test.ts) | 无效嵌套变化整体拒绝、非法物品去向不提交、reward 一次、已知值／真值分离 |
| 活动与状态组合 | [pack-status-activity](../../../tests/host/pack-status-activity.test.ts)、[activity-auto-start](../../../tests/scenarios/activity-auto-start.test.ts)、[pack-activities](../../../tests/host/pack-activities.test.ts) | 同一玩家回合计数、参与者合法性、暂停／恢复、自动开始与随机回放 |
| 通信 | [cross-scene-communication](../../../tests/scenarios/cross-scene-communication.test.ts) | 消息与观察一起提交、未知联系人拒绝、不授予远端物理资格 |
| 原生能力／脚本组合 | [dual-plugins](../../../tests/scenarios/dual-plugins.test.ts)、[capability-plugin-entry](../../../tests/host/capability-plugin-entry.test.ts) | prepare 授权输入、调用者绑定、queued／completed、取消与资源清理 |
| 自主与角色执行 | [character-autonomy](../../../tests/scenarios/character-autonomy.test.ts)、[dynamic-scheduling](../../../tests/scenarios/dynamic-scheduling.test.ts)、[character-loop-execution](../../../tests/scenarios/character-loop-execution.test.ts) | 机会、时限、过期重算、已提交操作不重复、晚到结果不发布 |
| RPG 真实消费者 | [rpg-core-activity](../../../tests/scenarios/rpg-core-activity.test.ts)、狼人杀包及甜蜜日程包 | 不改脚本即可经迁后机制运行；不能只用一个演示操作证明所有玩法组合 |
| 存档与环境 | [tail-round](../../../tests/host/tail-round.test.ts)、[story-nodes](../../../tests/desktop/story-nodes.test.ts)、[plugin-set](../../../tests/host/plugin-set.test.ts) | 对应分支状态、独立实例、模块变化提示与旧候选拒绝；文件和世界状态分别检查 |
| 构建与交付 | [desktop-launch](../../../tests/desktop/desktop-launch.test.ts)、[entry-layout](../../../tests/host/entry-layout.test.ts) | 源码、构建和隔离目录入口；外部原生插件正确共享 Cordis |

普通批次运行类型、Lint、格式与相关测试；交付前运行 check、launcher:check、docs 链接检查及受影响的后端构建。权限／提交批次补对应失败注入，只有真实改变事务／恢复边界时追加必要硬中断测试，不为全覆盖增加崩溃矩阵。

角色 Context、Memory、调度或活动行为变化需要同场景真实模型对照，记录重复、等待、静默、事实与叙事分叉。没有凭证时明确保留体验未验收，不把桩模型结果写成体验通过。Windows／Python 环境问题应单独复现记录，不通过跳过或放宽断言获得全绿。

## 7. 存档、接口与回退

- 优先保留当前事件类型、Schema 和脚本含义。改变文件位置并不要求升级世界格式；确实破坏外部 API 时按兼容面调整 hostApi，不按批次编号升版本。
- 迁移世界事实检查时，已有数据只读或先做副本实验；不修改 D:/worlds 历史数据，不自动迁移已有用户世界。
- 普通插件私有文件目前“末端快照可复制／恢复”与“故事节点固定清单”并不一致。不得把文件复制等同于有裁定的世界状态。新迁机制继续以既有世界事件或既有记忆快照为事实／档案路径；依赖额外文件时先证明当前保存链覆盖，否则不能宣称该组合支持分支与分享。
- 每批冻结源码再做对照；先提交内部拆分和机械不变量验证，再开放接口，最后切换生产调用并删除旧实现。提交粒度可更小，但不能将尚未验收的下一批混入。
- 回退代码及默认组合，不回滚已提交世界事实，不把某插件缺失当作应该恢复其他插件的数据。若实验证明需要改变存档结构，先明确迁移对象、范围与一次性处理方式，不能临时叠兼容层。

## 8. 第一批可直接执行的任务与停止条件

建议实施从 **M0＋M1** 开始：固定基线、记录知识机制契约、抽纯授权状态视图转换、迁知识机制，并做最小核心启动探针。它能验证新规范是否真的让依赖更清楚，又暂不改变事务边界。

本批若出现下列情况，应停止扩大迁移并修正切法：

- 为让知识机制工作，必须暴露整个 WorldGameplay 或 WorldStore。
- 替代设定步骤需要另一角色真值，或出现重复 memory.project／状态注入。
- 最小入口探针只能通过绕过事件／Manifest 校验启动。
- 新旧模型请求差异无法解释，或真实试玩出现明显回归。

原计划编写时仅完成探查；当前 M0～M3 的实际范围见开头记录，之后批次尚未实施，也不解除[两项暂缓需求](../../current/architecture/plugin-layering-direction.md#4-已记录暂不实现的两个需求)。旧“插件优先阶段 0～11”保留为历史实施记录；之后迁移按本计划和统一规范核对，不重复执行已完成阶段。
