# 当前创作者运行时

潮位涨到 3 时，「代投便笺」才进入门廊差事的抽取范围。作者在「遭遇与委托表」选作品已有的世界变量、比较方式和值，能够按地点、玩家见证过的事件与剩余次数预览每行概率和原因。浏览器和外部 agent 调用同一编辑命令，保存的草稿在试玩或导出时与规则一起生成。正式宿主使用同一候选判定，以原生活动保存接受和交付进度，把奖励和本次结算一起提交。节拍事件由原节拍器选择，候选只查询已提交的个人见证。[制包字段与示例](../../../skills/perspectra-creator/references/gameplay.md#遭遇与委托表) · [候选判定与结算](../../../apps/host/src/runtime/encounter-tables.ts)

玩家寄养两只伙伴后，柜员能根据自己收到的两张回执回答领取时间。共同玩法脚本按观察者投影操作结果，玩家舞台只读玩家自己的投影。作者可在「日常交互」按操作选择场景回应、只给回执或指定可回应的 NPC。配置保存在源包清单的 `scripts.gameplay.responders`，编辑器保存、CLI 校验和正式宿主使用相同的操作及角色引用。独立发生的世界事件和自主机会仍按原规则调度。[创作示例](../../../skills/perspectra-creator/references/gameplay.md#在柜台连续办事和交谈)

玩家查完候船簿，可以先问在场角色靠岸信号，再决定是否留位。活动等待玩家且允许自由对白时，宿主从这次已提交发言的观察中找到实际听众，通过场景调度给他们表达或沉默的机会。参与者沿用自己的活动视图和表达许可。这个回应机会只允许表达，候船簿继续等玩家选择。[活动与状态](../guides/activity-and-variables.md#等待选择时与角色交谈) · [宿主调度](../../../apps/host/src/runtime/world-runtime.ts)

停电后同伴听见了雷声，远处的角色可能只收到另一段通知。作者在试玩监控的「世界事件与节拍」展开停电规则，可以逐人读通知原文、看谁获安排唤醒和谁已完成处理。宿主用同一事务里的发生 ID 对齐观察，用所选分支的提交记录恢复唤醒进度和插件回执。节拍器另外保留当前实例最近 16 次结算时实际用过的候选、条件和选择理由，作者可以直接点候选查对应的事件规则。[事件运行时](../../../apps/host/src/runtime/world-events.ts) · [节奏运行时](../../../apps/host/src/runtime/pacing-runtime.ts) · [监控页](../../../apps/launcher/src/creator/WorldEventsView.vue)

澄跟队长去了卧室，退队后又自己回到客厅。作者在试玩时间线点这两次移动，能分别看到「RPG 队伍跟随」和「角色自己发起移动」。调试接口按移动事件之前的已提交记录读取随行队员名单和名单序号，队长单独担任带队者。移动的产生方在裁定时记录规则，活动另记活动键、操作和结算阶段。旧记录缺少规则时显示未记录。玩家和角色观察沿用各自可见的来去方向。[事件历史](../../../apps/host/src/runtime/creator-history.ts) · [移动详情](../../../apps/launcher/src/creator/DetailPanel.vue)

作者在包编辑器里将「门廊」改为「回廊」，保存后可用 `worldpack editor records <源目录>` 读取同一条地点记录。启动器在游戏启动和运行期间暂停源包编辑。[创作工作台](../guides/world-workbench.md) · [编辑服务](../../../apps/host/src/editor/server.ts)

作者在已有 128 个状态操作的包里再增加一次交接，`worldpack validate` 会报告组合后的 129 项、上限和来源。CLI 的 `validate/compile/test`、工作台源包预检和配置保存共用这项检查。它读取已启用的包内状态脚本、模块与官方 RPG 配置，复用开档的状态定义校验；纯校验不会运行第三方内容生成器，替换状态服务的作品仍需按所选宿主试玩。[作者校验](../../../apps/host/src/pack-validation.ts) · [角色退场与玩法示例](../../../skills/perspectra-creator/references/gameplay.md#角色退场)

试玩时，作者可在创作者控制台「状态」里核对已加载的操作数、适用角色和玩家最近一次候选。「世界总览」显示最近一次剧情节奏判定。两项都从宿主读已有数据，打开页面不执行许可脚本，也不推进剧情。随试玩宿主分发的独立工具包需要包含控制台网页及其脚本和样式。[调试接口与覆盖清单](../creator-debug-api.md#需求覆盖与接受的限制)

作者在「玩家开局」选择角色后，包编辑命令在源包写锁内同步玩家槽与角色控制方式。界面按玩家槽标记角色。开局有地点的启用场景与参与角色初始地点的冲突，按同一规则在编辑草稿和 CLI 记录列表中显示。[记录读写](../../../apps/host/src/editor/world-records.ts) · [开局字段](../../../packages/world-pack/src/editor-fields.ts)

作者在客厅的地点页勾选开局参与者时，工作台在源包写锁内重新核对这个地点绑定的未关闭场景，再写入场景的状态与成员。多个未关闭场景会使普通移动无法选定目标。编辑器和 CLI 报告同一组绑定冲突，作者可以从总览、地点或场景跳到每条配置。[地点开局表单](../../../apps/launcher/src/creator/LocationOpening.vue) · [移动时选择场景](../../../packages/core/src/application/scene-decision.ts)

作者给客厅添加物品、替换背景，或给阿林编辑人设、初始认知、通讯和立绘时，可在当前记录的详情区切换。各分区复用原有记录、开局设置、通讯与舞台命令。工作台从记录接口读取清单中已启用的插件，以此显示角色的可用玩法分区。[工作台](../../../apps/launcher/src/creator/WorldWorkbench.vue) · [地点物品](../../../apps/launcher/src/creator/LocationItems.vue)

玩家拿到开信刀后，能在「读便笺」选择「展开便笺」。正式包编辑器从总览进入活动画布，分组、成员与节点坐标随草稿保存，导出时单列在源包的 `creator-layouts/` 目录中。单独移动节点会保留相同的运行脚本。Host 仍按原有选项合同裁定。网页和外部 CLI 的 `activity-references` 使用同一引用索引，按活动、选项、组合条件成员及本地变量作用域定位。[图数据](../../../apps/host/src/editor/activity-graph.ts) · [引用索引](../../../apps/host/src/editor/activity-references.ts) · [活动编辑器](../guides/activity-editor.md)

地图活动里的玩家可以与同伴同行，到指定地点后独自存放物品。专属页面按目的地匹配当下宿主提供的移动选项；门锁与跟随沿用普通移动规则。图条件依据行动者自己的实际地点、当前可观察的同场成员，以及官方 RPG 已向该角色公开的队伍名单。独处要求在场成员中只有行动者本人，未知场景不会满足独处。角色感知范围以外的信息不会因这些条件而公开。[地图按钮](../guides/activity-stages.md) · [交付条件](../guides/activity-editor.md)

玩家可以在门廊选择作者命名的「倾听门外动静」，执行后由包内脚本给行动者一条观察。「日常交互」和外部 CLI 读取清单的 `scripts.gameplay`，直接编辑同一个 CommonJS 文件。加入草稿只生成作者指定的一个操作。保存时在临时副本检查脚本并打开新档，验证通过后按原入口和配置写回。试玩从独立新档的玩家舞台进入，候选和裁定走运行时已有的操作路径。[创作步骤](../guides/world-workbench.md#只添加作品需要的日常交互) · [脚本读写和校验](../../../apps/host/src/editor/interaction-script.ts) · [运行时加载](../../../packages/providers/src/activities/gameplay-script.ts)

门廊停电时，作者可以为隔壁写一条不同的观察。事件表单从作品读取日历、地点、持有物和唤醒角色，按已启用的状态脚本与模块列出通知来源操作。表单和 CLI 保存同一种事件声明，经 SDK 解析后导出，接收者仍由正式事件运行时判定。[世界事件表单](../guides/world-workbench.md#选择世界事件的触发与观察范围) · [候选与反向引用](../../../apps/host/src/editor/event-options.ts)

阿林在开场露出笑容时，工作台把她的初始表情连到本角色的表情记录，拼合图贴片按所选图片的行列提供格子。浏览器和 CLI 共用素材路径、候选与编辑命令。保存使用默认舞台解析器核对几何范围和图片引用，导出再对已生成的活动核对开场操作。美术与布局用于呈现，玩家的合法活动操作仍由宿主提供。[舞台表单](../guides/world-workbench.md#给角色配立绘和初始表情) · [舞台配置读写](../../../apps/host/src/editor/stage.ts)

作者可以从独立工作台创建玩家、同行者和同场开局，再通过正式 Host 用一轮对白验证。工作台按清单列出的文件读取基础记录，修改时根据稳定 ID 和字段原值写回对应记录；角色新增后的默认认知、记忆沿用编译器规则。浏览器和无头命令共用字段和候选，同一工作区的保存通过短时文件锁串行处理。当前表单、外部创作 CLI、限定范围的反向引用和真实开局用法见[整包创作工作台](../guides/world-workbench.md)。

阿林知道柜号，玩家不知道。作者把阿林选为事实受众后，编译器在她的开局判断中写入命题。观察、判断等初始认知也按角色装入。工作台和 CLI 复用同一套字段声明、引用候选与保存操作，在临时副本通过正式包校验后再写入清单指定的源文件。[开局表单与 CLI](../guides/world-workbench.md#设置谁在开局就知道一件事) · [源文件读写](../../../apps/host/src/editor/world-setup.ts)

玩家可给异地的阿林发信，能否收到她主动发来的信由相反方向的联系人记录决定。「角色通讯录」让作者从两端勾选同一组有向联系人。新包启用官方通信只创建空通讯录。保存和导出使用角色 ID 及正式通信规则校验关系，玩家收发仍走 Host 的消息入口。[通讯录工作台](../guides/world-workbench.md#设置单向或双向通讯录) · [配置读写](../../../apps/host/src/editor/communication.ts)

玩家在门廊说话，可以让在另一房间的阿林获得自主处理机会。工作台从正式活动定义、玩法与状态操作以及已保存活动图读取候选，经官方自主策略解析后保存。开局由 Host 分派机会并检查角色允许执行的行动。相关测试检查了异地角色实际收到一次自主请求，并核对请求里的对白可见性。[自主机会表单](../guides/world-workbench.md#给角色设置主动行动的机会) · [配置与候选](../../../apps/host/src/editor/autonomy.ts)

玩家向遗迹守卫施放火球时，魔力和生命的变化都由官方 RPG 插件裁定。工作台与外部 Agent 使用同一套玩法配置和保存命令，保留包内实际配置路径。开启 RPG 会登记其官方依赖，保存会用正式导出校验候选配置。无头试玩从实际可用操作提交，交互试玩打开相同 Host 的玩家舞台。见[玩法工作台](../guides/world-workbench.md#配置和试玩一场-rpg-遭遇)、[配置与保存](../../../apps/host/src/editor/rpg.ts)和[试玩](../../../apps/host/src/editor/rpg-play.ts)。

玩家搜查门廊时，流程图和专属页面都按同一活动操作读取最新精力。选项的 `ruling` 可用表单定义消耗或引用包内 JavaScript。成功后，扣费、结果赋值与活动进度走现有活动提交路径。编辑器和 CLI 共用声明、读取及保存入口。导出把引用的函数编入活动，裁定源文件可单独修改。见[操作裁定](../guides/activity-editor.md#给选项添加裁定)、[声明校验](../../../apps/host/src/editor/adjudication.ts)和[裁定代码生成](../../../apps/host/src/editor/adjudication-code.ts)。

门廊断电后，只有阿林有机会从世界书得知备用灯的位置。投放使用官方知识选择器，依次检查角色受众、该角色已知上下文上的条件、关键词和预算。作者工作台将文档元数据、Markdown 与投放配置合为一条记录，两端按字段保存。对照试玩把同一句发言送入独立新档，读取该步脚本化模型传输实际收到的知识条目，结果只含角色和命中情况。实现见[知识编辑与导出](../../../apps/host/src/editor/knowledge.ts)、[投放对照试玩](../../../apps/host/src/editor/knowledge-play.ts)和[运行时选择器](../../../packages/providers/src/knowledge/selection.ts)。

市集委托条目能从原生 `self.quests.market.stage` 条件读回记录键和枚举。工作台和外部 CLI 通过同一字段目录选择角色、地点、物品、已知状态、活动变量和本次刺激。组合条件导出为知识插件原有的对象 Schema，活动变量附带所属活动键，每一项比较都要求路径存在。受众和条件仍在角色请求的已授权视图上计算。实现见[字段目录](../../../apps/host/src/editor/knowledge-fields.ts)和[条件读写](../../../packages/world-pack/src/editor-knowledge.ts)。

门廊断电以后，读信活动可以收起「在灯下继续读」选项。带有世界变量条件的生成脚本显式声明 `readsStatus`，Host 和核心在选项策略中只投影该行动者已经知道的公共值。共享、私有和内部的活动变量各自使用现有活动状态分区。世界变量赋值通过已有的活动状态结果与进度一起裁定。事件试玩从已提交回合的发生记录读取规则键和唤醒名单，再按同一事务和发生 ID 对照个人观察。规则草稿和标准源包之间的转换见[规则源文件处理](../../../apps/host/src/editor/rule-source.ts)，保存与引用检查见[规则编辑命令](../../../apps/host/src/editor/rules.ts)。

在门廊向阿林求助时，活动可以按当前玩家的可见角色提供选项。显式设置 `readsScene: true` 的活动，其 `policy` 同时取得执行者可见的角色 ID 和本人持有的物品 ID。Host 展示选项与核心提交前的复核共用这套投影。独立编辑器和无头 CLI 共享活动图、条件候选、三方合并保存和导出入口。试玩用正式 Host 和临时存档验证活动。操作与适用范围见[活动编辑器](../guides/activity-editor.md)，实现见[编辑命令](../../../apps/host/src/editor/commands.ts)和[活动策略输入](../../../packages/core/src/application/activity-state.ts)。

2026-11-17 核对：以重构后的 main `97d4dcde` 为基线，普通观察与通用唤醒机会合并时优先普通预算；后台竞争时减少可选调用预留，最后一次普通调用仅允许表达。玩家操作提交通过请求自身的回调确认，前端按 actionId 解除提交锁，复用统一视图字段清单；核心硬预算、权限和周期结算判定保留。例子、测试与真实模型短测见[主干调度优化](../studies/2026-11-17-main-scheduling-responsiveness.md)。


2026-11-15 B8：默认动作分组／参数表单、通用控件、授权只读面板与 Launcher 源包配置编辑已接通，三组独立复验及主代理验收通过。详见 [展示与配置指南](../guides/gameplay-presentation.md)和 [B8 记录](../../superpowers/plans/2026-11-15-composable-engine-b8-presentation.md)。停在 B8，不进入 B9；以下历史批次说明保留当时证据。

2026-11-15 B7：游戏包显式 plugins、可选 services 硬要求、共同 gameplay 脚本和独立配置校验已接通，三组独立复验全部 PASS，主代理已完成 B7 验收。证据和边界见 [B7 记录](../../superpowers/plans/2026-11-15-composable-engine-b7-packs.md)。保留 v5 内容布局，当时默认展示与作者界面留 B8；其最新状态见页首。


## 官方原生玩法接入（2026-11-15，B6 九项修正已通过独立复验）

例如同伴在地图战斗中使用技能，实际执行的是所属 GameplayDefinition 注册的 Handler；RPG 锁门和金库访问走 restrictions，随行移动走单层 afterAction。TRPG 主持人的暗骰及笔记仍只形成指定接收者的观察。Host 把已有状态／活动操作信封转换为公共操作 ID；注册前由 bindNativeGameplay 绑定当前世界选中的 State／Activity Provider。唯一 Handler 调用所选实例生成候选，核心复核权限、状态和原子提交，不绕过替换实现调用生成时捕获的官方计算。源码接通与测试证据见 [B6 记录](../../superpowers/plans/2026-11-15-composable-engine-b6-rpg-trpg.md)，原阶段审查已完成，本次九项修正见[复核记录](../../superpowers/plans/2026-11-15-composable-engine-b6-followup.md)，已通过三组新的独立复验；不代表真实模型或发行验收。

[nativeGameplay](../../../packages/sdk/src/native-gameplay.ts)把动态配置中的纯状态／活动计算展开为共同定义、参数 Schema 和操作。活动 behavior 保留初始化、policy、调度、自动开始、发布后计算和恢复条件，正式 resolve 只在 operations 中注册。status-result／activity-result 是核心识别的提案数据；公共执行器用已有解析器归一化，再与普通效果共同检查所属状态、冲突归并、活动身份／阶段、可信物理范围和受众。发布后派生与原表达属于同一个候选提交。 所选状态实例负责初始化、policy 与 resolve；所选活动实例负责初始化、policy、resolve、schedule、发布后计算等既有能力。状态结果按声明归属过滤初值，后续候选仍由核心作共同校验。 当 State Provider 同时处理基础脚本与原生玩法时，宿主以 projectKnownStatus 提供该调用者完整授权的 known view，复制冻结后交给 policy；Handler truth 和模块状态投影仍只含所属状态。

WorldApplication 默认绑定同一事实前缀的物理视图，角色输入不包含他人认知或私有状态。裁定只获得模块自有状态真值；候选按已知数据收窄。需要队伍位移或指定实体掉落的定义显式声明 physicalEffects，核心仍验证最终效果。公开 startActivity 给每次开始分配新身份并绑定玩家与 NPC；resume 复核恢复钩子或共址条件。骰子能力只在当前调用期间有效。包清单与共同脚本装配由 B7 接通，默认 UI 由 B8 接通。

状态操作的 status 绑定指向本地 action，所属 statusPolicy 保留角色资格、动作声明与纯 policy。核心复用 StatusState、knownStatusView、admitStatusOperation 和 parseStatusOffers 检查执行者、当前已知许可、活动、角色参数、物品目标与可达性；policy 的 place 只包含自身或地面的可达物品，不借裁定真值生成许可。公开 executePlayer 的可选 targetId 单独表达物品目标，不混入参数 Schema。公共开始在同一快照复核已注册 autoStart 条件，条件不满足时不调用初始化或消耗其随机数。

手动开始、暂停、恢复、放弃活动均执行一次单层 afterAction，读取同一主结果候选快照，主效果与派生一起校验提交；派生失败不留下半次生命周期变化。自动开始属于 onCycleEnd 结算，强制 escape 保留既有例外。通用正式操作在 Handler 之前核验目标资格，并将 targetRef.id 传入 Handler.targetId；不合法目标不会调用业务处理器。TRPG 公开内容只可引用公开地点，仍被公开内容引用的地点也不能直接改为私有。

搜证示例的 offer 始终列出当前授权地点，精力为零时仍可见搜查候选，尝试后由 resolve 返回 INSUFFICIENT_ENERGY；这样保留明确的资源拒绝码。私有线索等候选仍负责过滤未授权目标，不能通过执行 Handler 后再验证目标来取得业务说明。

## 原生玩法定义（2026-11-13，B4 已通过独立审查）

例如搜查候选直接指向当前地点，查看线索候选指向已知线索。offer.targetId 保留为受控目标；B8 起 ui.targetKind 只承担展示分类，实际 targetRef.kind 由身份推导，正式入口使用与候选相同的受限材料复核目标；不能通过替换或撤销后的目标执行。示例状态统一以 `clues` 作为声明键和读字段，使用默认所属投影与核心行动者告知，避免手工名称映射。必要的其他接收者告知仍须显式声明，不能据此向旁观者暴露完整状态。

例如角色搜查档案室后，本人获得线索，同房人只看到翻找，房外人不收到材料。[搜证定义](../../../packages/sdk/src/gameplay.example.ts)现在实际通过公共引擎、真实 CharacterTurn 和原子提交运行，不再只验证作者类型。当前原生集成覆盖搜证、跨模块计算、派生冲突、最终伤害／倒地、活动私有材料、所属周期结算和生命周期；真实模型、默认界面、游戏包装载与发行包尚未验收。

引擎消费端用 [WorldApplication.createGameplayRuntime](../../../packages/core/src/application/world-application.ts)绑定已有 scope、分支与执行引擎，再 register(definition, config, context?) 并等待 initialize()。作者定义只依赖 SDK；注册、执行与受众检查在 [gameplay-runtime](../../../packages/core/src/application/gameplay-runtime.ts)。装配后不追加定义，Context 释放时撤销所属注册；实例关闭使旧计算方法和执行入口失效。已有 WorldApplication 玩家入口与受控角色回合自动消费所属分支的原生规则。

initializeState 明确返回现有 StatusTruth 的 public／characters，替代 B1 未绑定归属的扁平初值。声明状态时必须有初值，无状态模块可省略。恢复已有值时检查声明和 Schema，不用初始化覆盖不匹配的事实。projectState 的候选输入只含该角色已知且属于本模块的状态；裁定消费所属真值。角色上下文和新鲜度检查同时纳入授权的原生材料。

公开方法用同一 defineOperation 类型声明并放进 methods，主操作通过 compute(method, parameters) 调用。方法只贡献所属效果，使用当前计算快照，回调返回后能力失效。所有 afterAction 读取相同主结果候选，一层收集后统一检查；冲突需要所属模块 combineChanges 明确归并，最终不变量仍须成立。故障或冲突使整步未提交效果一起丢弃。

用途和参数 Schema 随合法候选交给通用决策模板。操作及活动结果先按接收者投影，再经对应结果 Schema 和格式化；默认只给行动者完整业务结果，目击者得到基础动作说明。格式化失败只留脱敏告警。活动仍使用既有 ActivityStateRules、private／internal 隔离和暂停／恢复／放弃／退出逻辑。原生 onCycleEnd 只收到所属状态，经 B3 内部适配结算，不接收全量世界快照；status.updated 的 cycle 来源不计为玩家轮次。

包内脚本和清单已在 B7 接通（见页首），默认面板／表单留 B8，旧官方业务迁移按 B5／B6 进行，不能把本切片写成已在全部入口发行。源码及独立验收状态见 [B4 记录](../../superpowers/plans/2026-11-13-composable-engine-b4-gameplay.md)。

2026-11-05 M5：例如后室同伴收到玩家短信后，自主处理自己的目标。通信选项与消息计算由 ctx.communication 提供，自主配置、触发频率和许可由 ctx.autonomy 提供；两者不直接提交事件。CommunicationRules 与执行适配绑定真实收发者，AutonomyRuntime 提取交易摘要并检查声明范围，机会继续交现有 scheduler／characterLoop。源码与验证边界见[M5 记录](../studies/2026-11-core-migration-m5.md)。

2026-11-05 M4：例如猜数字与 RPG 战斗共用活动机制，各自保留包内脚本。`ctx.activities` 选择独立的解释器与候选策略；宿主 ActivityRuntime／ActivitiesRuntime 只准备授权输入并调用核心执行。参与者、private／internal 隔离、前台唯一性和随机回放继续受检查。旧活动 VM 已迁至 official-activities；源码、自动验证与体验限制见[M4 记录](../studies/2026-11-core-migration-m4.md)。

2026-11-05 M3：状态／包内模块脚本格式不变，脚本解释及组合迁入官方 Cordis 状态机制；核心检查初始值、变化、告知与物品。prepare 只见授权数据，原生异步执行仍归宿主能力桥，queued 不代表已完成。见[M3 记录](../studies/2026-11-core-migration-m3.md)。

2026-11-04 M2：状态、活动和通信脚本的格式与规则含义保持；宿主把其合法结果交给核心即时提交，玩家绑定、取消、最新前缀和原子提交集中处理。物品可达性与去向检查进入 application，状态 reveal 检查仍保留在宿主侧，后续再拆 Cordis 机制。见[M2 记录](../studies/2026-11-core-migration-m2.md)。

2026-11-03 插件依赖：例如世界包要靠 `locked-room` 才讲得通，可以在清单写 `requiresPlugins`，缺插件时启动器开局前拒绝并列全原因。它和 `plugins.json` 的 `capabilities.required` 并存：前者说需要某个插件，后者说需要某种能力。写法见[插件能替换什么](../guides/plugin-seams.md#世界包依赖插件时)。

2026-10-29 补充核对活动调度、玩家私有视图与创作资源版本边界。例如夜里轮到预言家，可信活动调度可读取真实行动者，其他角色只拿到各自授权视图；玩家能看到自己抽到的身份。下面按现行实现区分这些入口，未重新执行真实模型、浏览器或发行包验收。

2026-10-26 双入口：例如澄请求设备确认后只增加本人次数，作者随包分发 `plugins.json` 和规则模块，本地 Cordis 插件注册 `ctx.capabilities`。模块组合进既有 PackStatus，候选与执行继续重查权限；异步完成后才校验结果并沿现有事件事务提交，queued 只确认排队。[实现记录](../studies/2026-10-26_dual-plugin-entrypoints.md)和[作者指南](../guides/dual-plugin-entrypoints.md)说明目录、世界绑定、角色请求、取消与未知结果暂停。源码、模拟模型和构建入口验证不代表真实体验或发行包验收。

RPG Maker 方向暂停继续扩展自研 RPG Core 战斗规则。[桥接骨架](../../../examples/rpg-maker/README.md)通过同一入口提供有限队员视图与公共事件白名单；MZ 可请求绑定 NPC 运行原有角色回合。外部观察须由包内规则选择是否提交，不直接变成世界真值。仍没有实际 MZ 工程、合法战斗技能输入或配对存档；含外部写能力时禁用节点和回退。下方自研规则实验保留当时验收范围。

2026-10-26 RPG Core 实验：例如澄选择火球后，守卫和浮游机按确定性规则反击，两个敌人只作为战斗单位存在。共享算法在 [examples/rpg-core](../../../examples/rpg-core/generate.mjs)，作者编辑战斗数据后运行生成器，得到普通的 `scripts/activities/battle.js`，随包发布并受资产锁保护；运行时只走下方原有的包内活动路径，不加载插件、不新增数据库、角色协议或提交路径。最初版本由 Cordis 插件在开局生成脚本，同日已删除。群攻、中毒、奖励事务、重启以及“发布脚本与资料一致”已由模拟服务测试验证；真实模型、浏览器体验与发行包未验收，完整限制见[实验记录](../studies/2026-10-26_cordis-rpg-core-prototype.md)。

2026-10-26 包内 RPG 实验：例如玩家施放火球后，同伴和守卫依次提交技能，再由包内规则结算胜败。[遗迹守卫包](../../../examples/world-packs/rpg-turn-battle/README.md)只用现有状态脚本和活动脚本完成 2v1 回合战斗，未修改宿主。活动进度与 HP / MP / 药水 / 金币沿同一事务提交；默认 NPC 由 `simulate` 提供策略，也可将同伴切换到模型决策。相关宿主自动化已验证，模型模式只使用模拟服务；真实模型策略、浏览器体验和发行包尚未验收。机制范围与限制见[评估记录](../studies/2026-10-26_gameplay-rpg-report.md)。这证明可信包内编程可以组合现有机制，不代表静态交互 JSON 自动具备战斗效果。

2026-10-24 创作资源：仓库的 [perspectra-creator](../../../skills/perspectra-creator/SKILL.md) 通过 [CLI 构建函数](../../../scripts/build/build-worldpack-cli.mjs)复制到程序的同名 skills 目录，整合原创世界包、旧 tavern-to-perspectra 的静态卡片提取／容量分析及迁移流程、原生预设创作与模板。脚手架使用随包 Node，卡片提取使用随包 Python；不执行原卡脚本，不依赖旧 Skill 或仓库。它不增加运行时插件或预装试玩包。[Skill 检查脚本](../../../scripts/release/verify-creator-skill.mjs)在独立环境验证脚手架、防覆盖、文档示例、合成 PNG／JSON 卡的数据保留，以及原生预设模板和非法字段／宏拒绝；真实迁移作品与角色体验仍需单独验收。

例如阿林和小余同属「门廊来客」，给阿林单独写一个角色提示后，作者可在[整包创作工作台](../guides/world-workbench.md)的同场试玩中比较两人的实际请求。[预设编辑命令](../../../apps/host/src/editor/presets.ts)读写包推荐、专属与组预设的作者草稿，保存、导出和 Launcher 分配共同校验成员资格。[角色请求对照](../../../apps/host/src/editor/preset-play.ts)从导出快照启动正式 Host，使用本地固定响应并读取实际请求检查记录，按角色返回预设来源、生成参数及展开的预设消息。实例预设与全局设置由 Launcher 管理。

预设创作可让同行者少写总结、保留自己的语气；不会授予其读取信件秘密的权限。CLI 进程新增 `preset validate <file> [--pack]`，直接复用 [rolePreset](../../../packages/providers/src/chat/preset.ts) 和[预设库导入](../../../packages/providers/src/chat/preset-library.ts)校验；包推荐模式只接受裸 RolePreset，预设库模式支持交换格式。它只检查字段、宏与正则语法，不执行文本替换、不写入预设库、不证明风格效果。世界包 validate 仍不自动加载预设扩展，需分别检查；详见[预设创作](../../../skills/perspectra-creator/references/presets.md)。

2026-10-24 创作校验入口：例如作者修改同行者拿钥匙的作品后，可在程序目录调用 `worldpack.cmd validate <源目录>`，让创作 Skill 读取退出码及 JSON 诊断。便携构建复用 [CLI 进程入口](../../../apps/host/src/cli/worldpack.ts)和[构建函数](../../../scripts/build/build-worldpack-cli.mjs)，随包 Node 与 jieba-wasm 执行，不依赖创作者的源码环境；`--version` 给出程序与格式版本，`--help` 说明范围。B7 起 CLI 执行所选定义的元数据及纯配置校验，包内共同定义在 VM 中读取；不执行玩法行动或启动完整宿主；`test` 仅编译适配，不执行声明断言。独立目录、空 PATH、中文和空格路径以及错误码已由[隔离检查](../../../scripts/release/verify-worldpack-cli.mjs)覆盖；这次不涉及角色协议，也未据此声称真实模型体验或完整发行包通过。操作见[创作指南](../guides/world-pack-authoring.md#6-校验与试玩)。

2026-10-22 核对：例如留守者自主去拿钥匙，包内 `scripts/status.js` 的作者模板提供 `status:take`，`autonomy.json` 再允许它在本次机会使用这一操作。活动 policy 同样用 `status:take`／`status:drop`／`status:give` 引用拿、放、给；这些操作不再由基础交互包安装。模板、目标筛选和执行复查见[物品操作](../guides/activity-and-variables.md#对物品做的操作2026-10-22当前源码)。下方示例已按现行 ID 更新，带日期的旧试玩结果不等于新模板已完成同样验收。

2026-10-21 宿主整理：当前实现位于 `apps/host/src/runtime`。例如创作者查看角色体力时，检查响应的 `statusTruth` 返回已提交状态真值，控制台“状态”页读取同一字段；旧 `variables` 字段已移除。它是宿主认证后的只读能力，玩家公开接口仍按既有权限过滤，不因更名扩大可读范围。活动自己的 public/private/internal 变量保持原含义。模型请求、Context、调度与状态裁定规则没有因目录整理改写；源码和构建验证不代表新的真实模型体验验收。

2026-10-19 知识条件扩展：例如同行者在前室、眼前能确认钥匙且本次刺激来自玩家时，才交付钥匙背景。`when` 继续使用 JSON Schema，保留 public／self／characters 的已知值条件，另可检查接收者、当前位置、授权场景、当前／旧物品、本人活动、刺激与 knownStatus 的 current。活动授权视图增加稳定 activityKey；不读取隐藏世界真值，也不新增状态副本或自动事件链。字段与示例见[世界设定指南](../guides/world-knowledge.md#按场景物品活动与本次刺激筛选)。[Core／DeepSeek 真实试玩](../studies/knowledge-conditions-deepseek-playtest-20261019.md)的 39 次请求交付均符合预期，角色查看钱包前后分别使用过时／有效材料；这是短样本，来源表达仍有扩写，发行包未重建。

2026-10-19：作者可以用 `scripts/status.js` 声明金钱、HP、游戏时间这类常驻状态，以及带 JSON Schema 的对象、数组，例如按任务 ID 保存阶段和记录。操作 policy 按行动者已知状态决定哪些选项出现，执行前重查；知识条目的 when 用 Schema 判断同一份已知状态。实际变化仍由 resolve 或每轮钩子裁定，不自动启动递归事件链。真实值只在世界事件里，每个角色和玩家只知道告知过自己的值；活动 resolve 也可以在返回中附带 `status` 变化，并收到第六个参数 truth；状态和操作可用 `activities` 收窄到指定活动。它替代已删除的包变量。完整契约、上限与已知限制见[活动与状态指南](../guides/activity-and-variables.md#3-状态2026-10-19当前源码)，样例见[集市钱袋](../../../examples/world-packs/status-market/README.md)。源码与自动测试已接通，未做真实模型试玩，发行包未重建。

2026-10-18：例如花房角色依据人设、预设、记忆和对话历史改变对玩家的看法，不另设好感度或信任分数。最初切片的关系数值、面板及门槛已撤销；变量优先承载玩法明确追踪的客观变化，沿已有活动、交互及规则维护。源包仍可登记 `knowledge.json`，由 [KnowledgeSelection](../../../packages/providers/src/knowledge/selection.ts) 按权限和关键词交付背景设定，不占用活动。配置和预算见[作者指南](../guides/world-knowledge.md)。移除分数后已做离线验证，真实模型未重跑，发行包未更新。

创作者观测接口见[调试接口](../creator-debug-api.md)：例如钥匙从同行者交给留守者，可以查询保管与地点历史、实际观察受众、对应行动参数和裁定，再检查角色当次使用的预设与上下文。2026-10-15 已接通事件历史和可重启读取的私有调用记录，继续沿用宿主权限；仅查询不会触发作者脚本、召回或模型调用。

同一天补齐了第一版[创作者控制台](../creator-debug-api.md#创作者控制台)：2026-10-17 起改为由 Launcher“打开创作者页面”在系统浏览器打开的独立页面（[入口](../../../apps/launcher/src/creator/main.ts)，只在游戏运行时可用，“模型请求”视图取代原请求探查对话框），左侧是游戏／故事线／角色导航，中间是「对话」连续阅读与「轨迹」紧凑表格，右侧是按对象变化的详情面板；世界总览、角色、物品、状态和活动共用同一套列表框架。它只做读取与合并：`apps/launcher/src/creator` 下的 [store.ts](../../../apps/launcher/src/creator/store.ts) 负责分页、轮询去重与选择状态，[model.ts](../../../apps/launcher/src/creator/model.ts) 把已提交事件与私有记录合成一条轨迹，[source.ts](../../../apps/launcher/src/creator/source.ts) 用页面令牌同源读取 `/api/creator-*`，没有令牌时使用浏览器 Mock 样例。合并规则不超出接口已有的证据：未读到正文的记录只显示「已记录」，失败与未发表内容默认收在「显示处理过程」之后。真实运行实例、长会话容量与发行包仍未验收。2026-10-30 新增「运行时间线」：同一份轨迹按角色与系统泳道横向排开，只按 actionId、transactionId、decisionId、eventRefs、participantId 画关联，见[运行时间线](../creator-debug-api.md#运行时间线)；同日修正创作者快照的物品名取自最近一次写明 name 的 upsert，creator-meta 增加包内地点名，创作者页暗色改为中性近黑底。

> [跨场景短信实验样例](../studies/cross-scene-communication-20261010.md)允许声明媒介名称和有向联系人；[电话实验](../studies/cross-scene-phone-20261010.md)进一步支持自主接听与持续连接，但仅独立实验入口加载。2026-10-25 曾按包内文件启用；B7 起须显式选择 official-communication，并登记其 communication.json 资产，才在默认宿主启用短信，`model-girls-sweet-days` 是第一个开启的包；电话、活动期间收发短信仍未接入默认宿主；改名为托梦不会自动实现睡眠条件或匿名来源。

> [活动与通信组合实验](../studies/cross-scene-activity-20261010.md)已用活动现有 `interactions` 白名单裁定通信：允许时可以收发与接听，禁止时直接提交也不能绕过；默认宿主尚未安装这套组合规则。

World Pack 用于定义人物、地点、物品、认知、场景、叙事与 Interaction。当前网页接受 `worldpack-source/v5` 源目录，以宿主已安装能力编译；旧格式不会自动回退到旧运行时。可参考 `ai-girls-awaken-v10`、`prototype-g1` 和 `hand-in-hand`。

## 关键角色自主行动（2026-10-11，实验分支）

例如玩家与同行者在前室说话，独自在后室的留守者也可以整理自己的安排，决定移动后再参加讨论。唤醒只提供处理机会，不会把前室发言或私语传给场外角色。目标复用角色自身 cognition/goals，表达、沉默、操作与结果续写仍由同一个 Character Turn 处理。

世界包在 `worldpack.source.json` 的 `assetFiles` 登记 `autonomy.json`，宿主按已编译资源摘要读取声明；没有登记就不加载。不增加包格式版本或独立活动，也不执行新的作者脚本。最小样例见[character-autonomy](../../../examples/world-packs/character-autonomy/README.md)。

```json
{
  "characters": [{
    "characterId": "character:friend",
    "triggers": [{"actionType": "move"}, {"actionType": "interact", "definitionId": "status:take"}],
    "everyPlayerTurns": 2,
    "opportunities": 1,
    "interactions": ["status:take"],
    "locationIds": ["location:front-room", "location:back-room"],
    "targetIds": ["entity:brass-key"]
  }]
}
```

| 字段 | 含义 |
| --- | --- |
| characters | 最多 8 个不重复的已声明 NPC，不可包含玩家 |
| triggers | 匹配成功提交的 speak/move/interact；interact 可按 definitionId 限定。多个条件为“或” |
| triggers[].everyPlayerTurns | 可选，1–100。写了的条件单独计数，例如移动每 3 次才给一次机会；没写的条件与静观合用角色的 everyPlayerTurns。任一组到点即给机会 |
| 活动触发 | 可写 `{"activityKey":"default","operation":"guess"}`，只匹配实际玩家活动操作 |
| everyPlayerTurns | 每累计多少个符合条件的玩家提交触发一次，1–100；失败、重复请求、NPC 行动和活动开始/重试/暂停/恢复/放弃不计数 |
| opportunities | 作者请求的自主激活次数，1–100；实际取启动器机会限制与此值的较小值 |
| interactions | 此次自主激活可尝试的交互定义 ID 白名单，空列表仅保留表达和区域内移动 |
| locationIds | 可自主处理与移动的已声明地点；角色当前不在范围内则本次不给机会 |
| targetIds | 可选的受控目标 ID 白名单；限定直接目标及裁定返回的非自身角色/实体/关系绑定，不扩大原有可见性 |

玩家点“静观”（让这一轮过去）时，不论 triggers 怎么写，都算一次符合条件的玩家回合：例如 triggers 只写了“拿起钥匙”的角色，玩家静观时也会按 everyPlayerTurns 的节奏得到机会。静观本身不产生任何可观察的内容，所以角色拿到的新刺激为空，只能凭自己的目标和处境行动。静观要求包有状态脚本（轮次记在那里），活动进行中不提供。

同一玩家事务在同一计数组里即使匹配多个条件也只计一次；单独计数的条件各算各的。宿主从完整已提交事件及现有行动记录推导次数，不使用世界 tick，不另存计数器；节点、分叉与末端候选随同一事件前缀恢复。取消、沉默、预算未覆盖的机会不补发、不积攒，不恢复未提交队列。

默认每个自主机会最多一次受控操作及结果续写；有调用余量时可主动召回补问。作者交互和区域限制同时过滤 affordances 并在 Rulebook 裁定时检查，不能靠直接模型参数绕过；声明也不能凭空提供未注册的交互或包内操作。自定义交互中的所有业务语义仍由其实现负责，运行时不解析自由文字来证明目标已完成。

启动器按游戏包保存独立资源上限，下次启动生效：每角色 1 次自主机会、全部自主角色 3 次模型调用、后续反应 1 波/4 次调用，自主及后续共用 60 秒。机会设 0 关闭自主唤醒，反应波次设 0 关闭后续连锁；模型请求与单角色时限继续复用既有设置。召回、格式修正、stale 重算和结果续写都占用所属调用预算，Core 记忆 Utility 沿用自身预算。

动态条件满足时，普通观察者与到期关键角色同时进入待派发队列；最多两个在途激活，场外最多一个，当前场景优先。派发时排除相同地点及同一角色；在途移动合流后，已提交结果续写继续，过期视图重算。普通观察优先使用普通预算，并吸收重合的一次唤醒机会，同时交付显式授权刺激；普通预算不足时仍可使用独立机会。自主行动提交后即可为其他授权观察者派发有界反应，不等待所有自主机会结束；普通与后续反应沿用本回合已有激活计数，到期角色不因这段连锁增加自主次数。普通、自主及后续反应分别限制调用数。机会结束不会删除更新的未消费观察，后续自主来源观察使用自主后续预算。普通截止不取消独立自主机会，也不删除它仍有效的显式刺激，反之亦然；玩家取消/暂停停止全部未提交计算。

当前主动 Activity 优先拥有参与者调度，自主调度跳过这些参与者；非参与者仍可因声明的玩家活动操作自主处理，不获得活动私有上下文。没有活动参与者排程或声明 `serial` 的决策实现，且未启用 `--serial-scheduling` 时（2026-10-19 起不再检查变量脚本），自主机会复用上述动态队列及其公平优先级；其他入口保留普通、自主、后续反应的分段处理。多角色预算不足时不保证全部轮到，场外任务仍逐个执行。独立测量控制 stagedAutonomy 可保留旧分段方式，未加入 Launcher 设置。源码与实测见[接入记录](../studies/autonomy-dynamic-dispatch-20261011.md)。尚不支持动态脚本触发、自动目标完成判定、墙钟自治或后台常驻。

实现：[自主解析与策略](../../../packages/providers/src/scheduler/autonomy-policy.ts)、[授权与执行适配](../../../apps/host/src/runtime/autonomy-runtime.ts)、[宿主](../../../apps/host/src/runtime/world-runtime.ts)、[启动器参数](../../../apps/host/src/play-settings.ts)。自动回归见[自主调度测试](../../../tests/scenarios/character-autonomy.test.ts)，真实模型情况见[实验记录](../studies/character-autonomy-20261011.md)。本分支源码能力不代表发行包已更新。

Interaction 定义和绑定提供玩法可选行为，规则负责重要状态的资格与结果。角色与地点定义不等于运行中当前位置；运行时通过提交事件和当前 view 获得状态。创作者仅在当前玩法明确追踪的机制中增加状态约束，不必结构化所有叙事细节。

## 包内活动

例如，玩家拿着开信刀且门廊有电时可以展开便笺。低代码活动将「全部满足」或「满足任一项」保存为一层 `all` 或 `any`。成员可引用在场角色、持有物品、可读世界变量、共享或当前行动者的活动变量。流程图和外部 Agent CLI 使用相同的图与保存校验。生成脚本用玩家视图过滤可选操作，正式执行再以实际场景、持有者和规则状态裁定。物品与变量的反向引用可定位到具体成员。活动试玩可以指定条件中公共变量的开局值，并执行包里已有的拾取操作。见[活动编译](../../../apps/host/src/editor/activity-graph.ts)和[三组试玩起点](../guides/activity-editor.md#让展开便笺同时检查物品和灯光)。

例如作者可以固定与同行者猜数字，也可以让玩家选择邀请留守者约会；被邀请者自己通过操作接受或拒绝。当前活动桥位于实验宿主。可信本地脚本声明 title、operations，以及固定 npcIds 或动态 participants（player-select、人数与可选候选白名单），可选 opening 作为玩家看到的开场文案（参与者仍收到固定开场行）；initialize 收到本次实际选定的 npcIds，policy 决定各主体表达／操作许可，resolve 同步裁定。`schedule(state)` 与 `onOutcome(result, state)` 接收完整已提交活动状态，包括 internal 和所有参与者的 private，只返回 wait 或一次参与角色激活，不把这些输入传给角色或前端。policy、resume 仍读取对应主体的授权视图。可选 simulate(request) 只接收本次角色的授权请求，为该角色提供局部固定演出决策，null 表示调用真实模型；不因此获得完整活动状态，仅替换响应来源，不改变预设输出处理、格式校验、Rulebook、事务提交或观察分发。源码见[活动桥](../../../apps/host/src/runtime/activity-runtime.ts)。

每场最多 8 个 NPC，玩家身份由宿主绑定，开始时参与者须存在且属于玩家当前授权场景；动态名单开始后固定，暂停与恢复保留同一名单。状态 public 只在参与者间共享，private 仅给对应角色，internal 不进入角色视图；脚本不能直接写世界或调用模型。活动结果按参与者或 self 投递，非参与者不获得活动视图、许可限制或活动调度资格，仍按普通交流和行动的观察权限知情。结果范围 self 只限制结果收件人，不能补救把秘密写进 public 的错误。接口例子和旁观者边界见[活动指南](../guides/activity-and-variables.md)。

玩家也是活动参与者：公共 PlayerView 的 activity.private 和 activities[].private 只投影玩家自己的记录，默认舞台显示可呈现字段并标“只有你知道”。隐藏行动者应放在 internal 和本人 private；默认舞台虽不点名处理者，公共 responders 仍可暴露场内处理者名字，revision 仍暴露操作次数。这些是当前接受的限制，不代表已完成对玩家的隐藏回合隔离。

每次活动输入最多串行 4 次角色激活、每次最多 2 次决策机会，主动 recall 可追加一次补问；最多 12 次模型调用，活动链 90 秒。预算耗尽或失败保留已提交状态，允许显式重试或逃生，不精确恢复未提交机会。

`ai-girls-hosted-guess` 展示主持角色私有答案与多 NPC 有界链；默认能力限制不替角色决定情绪、策略和台词；作者显式声明的固定演出可通过 simulate 提供同格式决策。完整活动结果附带身份／阶段元数据以形成授权经历。当前源码网页与 Launcher 默认使用 Core 记忆，缺少 Python/E5 时明确失败；后台整理仍需显式启动，未整理时长期交付为空。只有显式 `--memory-none` 才不用长期记忆，这只用于离线开发，见[启动参数](../../../apps/host/src/runtime/launch-arguments.ts)与[创作者试玩](../guides/creator-playtest.md)。

2026-10-24 创作边界澄清：例如作者可以在送礼后写入角色专属的心动印象，引导接下来的反应，也可以显式编排剧情与固定演出。尊重角色主体性不要求每个游戏包都采用完全自主的感情发展；作者可以用已有状态与活动机制影响角色，仍须遵守信息接收范围，以及位置、物品等权威事实的正式提交规则。[屋檐下的心动日程](../../../examples/world-packs/model-girls-sweet-days/README.md)保留这种引导，弱化部分绝对结论；这些包内选择不构成引擎对其他作者的限制。

## 离线推演与编辑器试玩

作者可用 `worldpack simulate <源目录> <剧本.json>` 验证活动触发与结果。Host 读取当前草稿，在临时副本中启动正式运行时，用脚本模型执行步骤。结果包含动作裁定、状态变化与各角色收到的观察，剧本断言失败时退出码为 2。[剧本执行](../../../apps/host/src/simulation/scenario.ts) · [临时副本与运行时](../../../apps/host/src/simulation/simulation.ts)

2026-11-22 源码新增 `worldpack accept <导出目录> <清单.json> [--only <用例ID> ...]`。例如验收门廊空手不能拆信，先用玩家的正式候选检查开信操作，再在有刀新档检查实际裁定。清单对导出内容取临时副本，每个剧本在独立 Host 新档执行同一套场景断言；交接报告只投影必验 ID、执行状态和输入身份。全跑且必验项都有证据才可交付。[验收入口](../../../apps/host/src/simulation/acceptance.ts) · [创作者用法](../../../skills/perspectra-creator/references/gameplay.md#交付验收)


编辑器的活动流程图、规则与 RPG 配置还可在对应表单试玩。角色对白与表现仍需用真实模型验收。[活动编辑](../guides/activity-editor.md) · [工作台](../guides/world-workbench.md)

物品记录可以直接查看一把钥匙在哪张地图掉落、哪个出口需要它，并跳转到相应配置。工作台和 CLI 共用[物品用途查询](../../../apps/host/src/editor/item-uses.ts)和[物品操作保存](../../../apps/host/src/editor/item-actions.ts)。[掉落与通行试玩](../../../apps/host/src/editor/rpg-exit-play.ts)在导出的临时包内经过玩家实际可用的战斗、拿起、开锁和移动入口，并核对拒绝原因和抵达地点。

二层宝箱药水可从物品记录选择恢复属性，装备从包内已有槽位选择，角色记录可就地创建槽位。保存仍使用现有 RPG 配置路径和冲突校验。药水试玩用推演的临时起始数值核对真实拾取、恢复和用尽状态，装备对照从玩家技能那次提交读取目标生命。见[工作台操作](../guides/world-workbench.md#给宝箱药水配置恢复效果)和[物品试玩](../../../apps/host/src/editor/rpg-item-play.ts)。

玩家在卧室休息、战败回家或和澄同行时，工作台与 CLI 均从同一份 RPG 源配置读取规则。两端的试玩在临时包内通过 Host 操作执行，核对状态属性、活动结束阶段、参与者位置和队伍名单。见[配置与操作](../guides/world-workbench.md#设置卧室休息战败回家和同伴随行)和[试玩实现](../../../apps/host/src/editor/rpg-journey-play.ts)。

澄在第二轮说「再来一发」并施放火球时，地图编辑器、活动流程图和 CLI 都从同一份 `maps[].scripted` 推导节点与字段候选。试玩用提交前的活动版本确定出手回合，以活动结算和角色公开发言分别验证技能和台词。官方战斗裁定可按当前作者演出所指的技能与敌人 ID 区分同名记录。见[演出试玩](../../../apps/host/src/editor/rpg-cue-play.ts)和[操作示例](../guides/world-workbench.md#把澄的第二次火球移到第-2-轮)。

## RPG 玩法（2026-11-08，分支 feat/rpg-plugin）

例如作者在包里写一份 `rpg.json`：遗迹一层有守卫、铁门需要钥匙，澄是同伴。玩家进入遗迹时，宿主已经为这张地图生成了一场活动，澄随队长走进来，战斗伤害、掉落和锁门由程序裁定，留在家里的阿茹收不到战斗内容。

官方机制包 [official-rpg](../../../packages/plugins/src/rpg) 由清单 plugins 选择，读取锁定的 rpg.json（或显式 config 路径），展开原生状态、地图活动、限制与派生定义。必须同时显式选择 official-dice。Host 的 [pack-content.ts](../../../apps/host/src/runtime/pack-content.ts) 负责通用装载，规则由共同执行边界裁定。存档用 gameplayData 的插件身份及数据版本检查兼容，代码／配置摘要仅用于尾部候选环境比较；分享和读档继续核对实际状态。详见 [B6 记录](../../superpowers/plans/2026-11-15-composable-engine-b6-rpg-trpg.md)与 [B7 记录](../../superpowers/plans/2026-11-15-composable-engine-b7-packs.md)。未把源码和自动化结果视作真实模型或发行验收。

2026-11-08 建立的 ctx.content 接缝继续使用。B7 将内容发现改为按 plugins 显式选择，不再根据根目录 JSON 中的 plugin 字段自动装载。所选插件需已安装、版本匹配并被允许执行；未选择的玩法不会因配置文件存在而启动。纯校验由声明式 Schema 和注入的 validateConfig 执行，不调用 generate；宿主打开时才展开原生定义并检查重复注册。第三方元数据传入开档、尾轮、分享与推演预检，避免后续入口遗失同一选择。

## 跑团玩法（2026-11-09，分支 feat/rpg-plugin）

例如作者在包里写一份 `trpg.json`：玩家请阿茹当主持人，选剧本《雨夜古宅》。阿茹自己决定接不接；接下后，玩家说“撬开书房的门”，阿茹要求一次敏捷检定，程序掷出的点数只发给玩家和阿茹，澄只知道有过检定；没参加的梅看不到活动结果和点数，但 AI 参与者在局内说的话按普通发言公开，她听得见。

官方玩法包 [official-trpg](../../../packages/plugins/src/trpg) 经 `ctx.content` 读取 `trpg.json`（需登记在 `assetFiles`），在清单显式选择 official-trpg 与 official-dice 后，展开键为 trpg 的原生活动，复用上一节的组合校验和数据版本检查。点数来自 `ctx.dice`（[official-dice](../../../packages/plugins/src/dice)）：活动脚本在 `resolve` 里调用宿主注入的 `rollDice`，取数记入活动目录每轮的随机记录，所以回看、分支、重新生成都重放同一点数。点数通过活动结果的 `privateNotes` 只作为指定参与者的观察提交。主持人的裁定质量靠模型，程序只保证点数可信、可见范围正确。作者说明见[跑团玩法](../guides/trpg.md)，验收包是 [rainy-manor](../../../examples/world-packs/rainy-manor/README.md)。源码已接通并有宿主自动测试；2026-11-09 有一次 GLM-5.3-Flash 的脚本化试玩（[记录](../studies/2026-11-09-rainy-manor-playtest.md)），未做真人试玩或发行包验收。

## 创作入口与限制

在已有遗迹包里，作者可给一项技能添加护盾和净化。在新世界里，同一套字段控件也可以建跑团剧本，把一封信放进已登记的剧本地点。控件读取官方插件的配置声明来显示必填、选填、枚举、对象、列表及可切换的效果类型。实际保存依次校验完整包、检查源文件是否已被外部修改并写回。浏览器和 CLI 读取同一份角色、技能、状态、地点候选。相关实现见[字段候选](../../../packages/world-pack/src/editor-config.ts)、[配置保存](../../../apps/host/src/editor/mode-source.ts)及[跑团入口](../../../apps/host/src/editor/trpg.ts)。

先看[字段手册](../guides/world-pack-authoring.md)、[试玩步骤](../guides/creator-playtest.md)和[自定义网页](../guides/web-ui.md)。`frontend/` 含 index.html 时须带 manifest.json，使用 iframe 公共玩家接口；只放主题、美术、舞台配置或活动页面资源时沿用默认前端。`frontend/activity-pages.json` 可按活动键绑定本地 HTML 和可选 CSS。活动进行时 Host 在独立的禁脚本 iframe 内显示它，向声明式标记填入玩家可见字段与当前活动选项。工作台和 CLI 共用绑定、候选、导入与预览入口。每个已命名元素可按当前 PlayerView 的标量、物品、操作或阶段做条件展示。宿主在视图变化时更新可见性、CSS 类与本地图片，并把已绑定按钮接到现有 perform 路径。见[活动专属舞台](../guides/activity-stages.md)。未提供时使用官方默认模板。这些前端资源不改变世界包编译身份；新实验使用独立数据目录。

随包 Skill 与宿主应按同一次构建使用。产品 0.3.1、源格式 v5 和编译器 0.5.0 相同，也不能证明完整活动状态调度等 10-28 新增能力可用；应核对 build-info 与当次验收记录。仓库文档和 Skill 的更新不会修改已发布的 candidate4，所需随包文档与构建步骤见[构建说明](../../../scripts/release/BUILD.md)。

Launcher 游戏库（2026-10-16）界面配色由全局设置的主题色决定（樱色默认，另有灯火、月夜、森林；保存在 launcher.json 的 preferences.palette，经 PERSPECTRA_PALETTE 传给游戏进程）（2026-10-22 起主题色设置已删除：官方舞台和宿主外壳改为黑白、跟随系统；启动器保留原默认配色；旧 launcher.json 里的 palette 读取时忽略、下次保存时去掉。），以世界包封面作为首屏：在包根目录放 `cover.webp`、`cover.png` 或 `cover.jpg`（≤4 MB，建议 16:9 横图、主体偏右，左下留给标题），[launcher-core](../../../apps/launcher/backend/core.ts) 载入或启动时读取，经单独的 `pack-cover` 请求交给页面，不随 2.5 秒快照轮询重复传输；简介取 `world.json` 的 `description`。封面不进入编译产物，也不改变包 Hash。缺少封面时启动器按标题首字生成排版封面。（2026-10-17 改版后封面铺满整个窗口，“游玩准备”与折叠的“引擎与创作者工具”已由本局抽屉取代，见[首轮真实 Core 接入](../launcher-core-integration.md)顶部说明。）已用浏览器 Mock 与 `launcher-core` 测试核对；Tauri 真机窗口与发行包未验收。

实现：[活动桥](../../../apps/host/src/runtime/activity-runtime.ts)、[活动选择](../../../apps/host/src/runtime/activities-runtime.ts)、[World Pack 工具](../../../packages/world-pack)、[主持示例](../../../examples/world-packs/ai-girls-hosted-guess)。当前不承诺任意玩法零宿主改动、多活动并行或不可信脚本沙箱。短冒烟不等于长试玩验收。

### 多个独立玩法，一次运行一个（2026-10-10）

例如玩家暂停猜数字、讨论周末计划、再回来继续猜：assetFiles 可登记 scripts/activities/guess.js 与 scripts/activities/weekend.js，每场各有状态、参与者和操作。它替代原先整个包只能使用一套活动的约束，没有新增并行调度。原 scripts/activity.js 作为 default 活动继续使用。

2026-10-21：例如回报巡查后弭弗在场，就自动开始“名单”剧情。活动脚本可写可选的 `autoStart(truth, world, previous)`，返回 `when` 布尔数组（全真才满足，长度即条件数目）、可选 `npcIds` 与只给玩家的 `notice`（替换玩家看到的固定开场行，参与者仍收到固定行）。[宿主](../../../apps/host/src/runtime/world-runtime.ts)在被接受的玩家回合依次完成角色反应和 `onRoundEnd` 后检查一次；没有活动运行时，条件数目最多的候选开始，平局从本轮随机记录中抽取，重新生成按记录回放。开始复用玩家开始路径，事件带 `source: 'auto'`、action.resolved 为 `sourceRole: 'director'`，不计玩家回合；每轮至多一场，不连锁。脚本或开始校验失败不提交，记 `debug.autoStartError`。2026-10-24 起，写了 `autoStart` 的活动只在条件全部满足时列出手动“开始”，[活动桥](../../../apps/host/src/runtime/activity-runtime.ts)对手动开始请求按同一条件重查；暂停后的继续不受影响。活动仍不能移动角色。作者接口见[活动指南](../guides/activity-and-variables.md#按条件自动开始2026-10-21当前源码)；自动测试已覆盖，另有一次 8 回合 DeepSeek 短试玩确认了触发时机、提示投递与轮次计数，发行包未重建。

包内 JS 活动现在也可以单独声明 `canStart(world)`。此时手动开始只检查该资格和宿主原有约束，自动开始另需 `autoStart` 提名；上文的共用条件适用于未声明 `canStart` 的包。

ActivitiesRuntime 选择唯一正在运行的 ActivityRuntime，只向该活动交付角色请求、许可和调度；没有 active 时使用普通规则。活动事件以 activityKey 区分，暂停保留进度并关闭 active，旧操作因身份／revision 或非 active 被拒绝。开始／继续在写入租约内检查没有另一 active；状态、玩家管理观察和世界 tick 同事务提交。继续使用当前授权 world 检查作者 resume 条件；没有 hook 时要求同场。暂停／恢复不改真实世界位置或物品，不续跑未提交计算。放弃暂停进度和前台逃生保留已提交经历，其他暂停活动不变。

完整节点通过原世界数据库保存全部活动进度。作者 hook、公开 SDK 字段及操作步骤见[活动指南](../guides/activity-and-variables.md#多活动选择与暂停2026-10-10当前源码)，样例见[多活动包](../../../examples/world-packs/multiple-activities/README.md)。测试覆盖切换、隔离、条件拒绝、事务失败及分叉；真实模型体验与既有便携包包含情况另行报告。


### 2026-10-07：活动格式失败的有界修正

活动角色调用按 Core 的严格决策 schema 校验，本机发送端继续复用既有扁平 schema 适配。格式非法时只自动修正一次；能够唯一识别模型已选决策及交互选项时，修正请求使用该分支和选项，避免网关展开联合字段。固定数字在修正 wire schema 中用相等的 minimum/maximum 表达，以规避本机 numeric const 调用中多次得到字符串输出的现象（未分析网关内部实现）；Core 仍使用原始 schema 校验，不转换模型字段、不删除混合表达。

格式修正不增加受控动作预算。返回后继续现有世界高水位、活动版本、权限及事务校验。两次均非法保留原轮次，格式失败与服务失败分别显示；重试和逃生仍可用。此实现仅覆盖活动调用，不表示通用 G2 格式修正全部完成。

## 官方同居试玩包的最小补齐

例如玩家点击序章的“继续”，当前节点是“……什么情况？这里不是我家吗？”，这句话会成为正式玩家公开表达，而不是只写进前端对白框。`resolve` 可返回 `playerExpression: { text }`，宿主只允许玩家活动操作使用，按当前表达许可及原有 speak Rulebook 校验，将表达、授权观察和活动进度放在同一事务中。脚本来源保存在活动事件的 `scriptedPlayerExpression.source`，不投递给角色观察或公共 SDK。默认没有该字段的活动行为不变。也可返回 `playerExpression: { narration }` 提交旁白；操作定义的 `quick: true` 让玩家在行动菜单一键开始并执行该操作，见[活动与状态指南](../guides/activity-and-variables.md)。

NPC 固定台词发表时，可选 `onPublished(state, actorId, expression)` 返回新的 game，或 null。宿主仅在活动中的参与角色发表合法 speak 时调用，将发表与进度更新原子提交；提交失败不会跳过该句。该 hook 是同步裁定，不直接发言、调用模型或启动独立引擎。

`initialize` 另收到玩家授权的 `world`、`previous`（玩家自己的上次活动视图或 null）和同一事件前缀的 `truth`（公共状态与本次参与者的角色状态，无状态机制时为 null）。例如 RPG 根据当前生命安排首回合。`resolve` 的第五参数 `world` 包含当前行动主体授权的位置、最近移动序号、可观察角色与可见物品。可信活动裁定额外收到同一事件前缀的 `participantHeldItems`，仅列出同场参与者持有的物品 ID 和持有者 ID。例如队友没目睹玩家穿上护甲，规则仍按当前持有事实计算抗性。宿主只把这份数据传给 `resolve`，角色与前端接收活动的授权结果视图。条件不满足可返回唯一字段 `rejectReason`（非空、最多 2000 字符），不提交活动变更。 [活动桥](../../../apps/host/src/runtime/activity-runtime.ts)

[官方包](../../../examples/world-packs/model-girls-official/README.md) 使用这些入口完成 112 条序章表达，其中 5 条为玩家中性问题。最后请求收留后活动结束，后续输入走真实模型。生活活动只提交开场种子；米饭制作另由已有交互扩展机制裁定。自动实验核对完整表达与零角色 provider 调用；后续本机 Gemini 已完成拒绝、正式料理、私密交流、蛋糕目击和归档后回访的短场景验收，见 [真实记录](../../../examples/world-packs/model-girls-official/LIVE-VALIDATION.md)。默认反应时间截止及未覆盖组合仍明确保留。

### 完整序章的脚本输入限额（2026-10-09）

从 Launcher 开启 Core 记忆运行官方序章时，第 100 句的正常角色授权请求为 66,124 个 JSON 字符，超过原来的 65,536 输入上限，导致固定输出不能发表。现在仅 simulate 的完整角色上下文输入允许最多 1 MiB JSON 字符；其他脚本调用和所有返回值仍限制 65,536 字符，脚本执行仍限制 100 ms。超过上限继续失败，不截断认知、不扩大读取权限，不推进未发表的游标。模拟输出仍经过正常表达校验与提交。

### 活动状态读取与连接复用（2026-10-30）

例如同一句固定对白在准备、格式校验和提交后刷新中多次读取活动状态，宿主的 ActivitiesRuntime 现在复用一个世界库连接与一份活动进度缓存，替代活动目录和各 ActivityRuntime 分别打开数据库、回读活动历史。每次读取仍核对最新世界头；首次读取既有活动事件，之后只查询上一提交序号之后的 `activity.updated`，每个活动只保留最新完整状态。所有返回值仍是独立副本；失败提交不会提前推进缓存。

缓存和连接只属于当前活动目录，在 WorldHostCore 关闭时释放；节点恢复、重新生成和候选切换建立独立实例，不跨实例复用。规则裁定继续使用传入的正式事件前缀，不从缓存写入世界。单独构造的 ActivityRuntime 保留原来的局部读取方式。角色授权上下文、模型决策和运行可用性没有加入跨调用缓存。

第二轮在脚本加载时探测是否声明 autoStart；没有 hook 的固定名单活动不再为菜单和自动开始准备世界历史，动态选人仍读取授权场景，声明了 hook 的条件仍按当前状态重新计算，不缓存条件结果。玩家刷新可以把已经读取的同一前缀交给活动菜单，共用该次刷新内的授权世界投影；如果目录头已改变，则重新读取。该复用不会跨回合缓存角色视图或扩大 script 的信息接收范围。

这是源码优化，尚未重建发行包；首次恢复、完整世界视图和记忆来源仍有历史读取成本。测量与验证范围见[首轮活动性能记录](../studies/2026-10-30_sqlite-activity-performance-report.md)与[第二轮读取记录](../studies/2026-10-30_sqlite-activity-performance-round2-report.md)。原有序章实验见[历史性能实测](../studies/prologue-performance-20261010.md)；其数字不代表本次改动的性能或验收范围。


## B9 无头推演接线（2026-11-15）

玩家搜查后精力减少、线索进入自己的面板，同房澄仅看到翻找。`worldpack simulate <source> <scenario.json>` 调用 `runScenario`；`LensSimulation` 通过 `WorldHostRuntime.create/perform/submit` 接到 `WorldApplication.createExecutionEngine` 与正式周期。`ScriptedModel` 仅实现现有 `llmTransport`，保留官方预设与 Default DecisionService 授权组装；这条路径不启动 HTTP 模型桩、不读取真实模型凭据。

结果包含逐步真实裁定、角色观察、实际模型输入和玩家玩法投影。状态回放直接读临时 SQLite 的已提交事件，包含共同玩法状态；候选缺失和正式拒绝分开处理。`fault` 匹配实际插件故障，状态断言检查失败后未提交的效果；`contextExcludes` 必须有实际请求才可通过。全部输出属于作者诊断，不回流角色共享上下文。

[搜证示例](../../../examples/world-packs/investigation/README.md)包含显式启用、实现和三步剧本。计时与实际验证见 [B9 记录](../../superpowers/plans/2026-11-15-composable-engine-b9-simulation.md)；实际 HTTP 桩仍留在旧测试支持文件，不在无头推演执行路径中。没有实施 B10 包迁移或 B11 真实模型／发行验收。


## B11：作者定义在真实模型中的消费（2026-11-16）

例如给澄一个“先削弱守卫架势”的目标，她会从自己的技能效果说明里选择压制或破甲击，裁定结果确认后再发表。RPG 使用已有的原生 `projectState`，由共同 GameplayRuntime 将授权结果放入决策上下文；没有改通用 Prompt 模板，也不把技能定义重复写进持久活动状态。作者数值、护盾和持续效果均有真实模型实际操作，完整长局质量另行验收。

活动桥在投影模型候选时，保留上游许可过滤后的原始选项及参数 Schema，只能收窄，不能按活动 policy 重新生成已被剔除的动作。同居示例为角色显式声明其实际使用的 attack／magic／heal／guard／vote 许可。没有恢复默认全部放行。B10 包迁移已集成；当前自动化、真实模型与便携入口结果见 [B11 记录](../../superpowers/plans/2026-11-16-composable-engine-b11-acceptance.md)。
