# 当前创作者运行时

2026-10-19 知识条件扩展：例如同行者在前室、眼前能确认钥匙且本次刺激来自玩家时，才交付钥匙背景。`when` 继续使用 JSON Schema，保留 public／self／characters 的已知值条件，另可检查接收者、当前位置、授权场景、当前／旧物品、本人活动、刺激与 knownStatus 的 current。活动授权视图增加稳定 activityKey；不读取隐藏世界真值，也不新增状态副本或自动事件链。字段与示例见[世界设定指南](../guides/world-knowledge.md#按场景物品活动与本次刺激筛选)。[Core／DeepSeek 真实试玩](../studies/knowledge-conditions-deepseek-playtest-20261019.md)的 39 次请求交付均符合预期，角色查看钱包前后分别使用过时／有效材料；这是短样本，来源表达仍有扩写，发行包未重建。

2026-10-19：作者可以用 `scripts/status.js` 声明金钱、HP、游戏时间这类常驻状态，以及带 JSON Schema 的对象、数组，例如按任务 ID 保存阶段和记录。操作 policy 按行动者已知状态决定哪些选项出现，执行前重查；知识条目的 when 用 Schema 判断同一份已知状态。实际变化仍由 resolve 或每轮钩子裁定，不自动启动递归事件链。真实值只在世界事件里，每个角色和玩家只知道告知过自己的值；活动 resolve 也可以在返回中附带 `status` 变化，并收到第六个参数 truth；状态和操作可用 `activities` 收窄到指定活动。它替代已删除的包变量。完整契约、上限与已知限制见[活动与状态指南](../guides/activity-and-variables.md#3-状态2026-10-19当前源码)，样例见[集市钱袋](../../../examples/world-packs/status-market/README.md)。源码与自动测试已接通，未做真实模型试玩，发行包未重建。

2026-10-18：例如花房角色依据人设、预设、记忆和对话历史改变对玩家的看法，不另设好感度或信任分数。最初切片的关系数值、面板及门槛已撤销；变量优先承载玩法明确追踪的客观变化，沿已有活动、交互及规则维护。源包仍可登记 `knowledge.json`，由 [PackKnowledge](../../../tests/experiments/pack-knowledge.ts) 按权限和关键词交付背景设定，不占用活动。配置和预算见[作者指南](../guides/world-knowledge.md)。移除分数后已做离线验证，真实模型未重跑，发行包未更新。

创作者观测接口见[调试接口](../creator-debug-api.md)：例如钥匙从同行者交给留守者，可以查询保管与地点历史、实际观察受众、对应行动参数和裁定，再检查角色当次使用的预设与上下文。2026-10-15 已接通事件历史和可重启读取的私有调用记录，继续沿用宿主权限；仅查询不会触发作者脚本、召回或模型调用。

同一天补齐了第一版[创作者控制台](../creator-debug-api.md#创作者控制台)：2026-10-17 起改为由 Launcher“打开创作者页面”在系统浏览器打开的独立页面（[入口](../../../apps/launcher/src/creator/main.ts)，只在游戏运行时可用，“模型请求”视图取代原请求探查对话框），左侧是游戏／故事线／角色导航，中间是「对话」连续阅读与「轨迹」紧凑表格，右侧是按对象变化的详情面板；世界总览、角色、物品、变量和活动共用同一套列表框架。它只做读取与合并：`apps/launcher/src/creator` 下的 [store.ts](../../../apps/launcher/src/creator/store.ts) 负责分页、轮询去重与选择状态，[model.ts](../../../apps/launcher/src/creator/model.ts) 把已提交事件与私有记录合成一条轨迹，[source.ts](../../../apps/launcher/src/creator/source.ts) 用页面令牌同源读取 `/api/creator-*`，没有令牌时使用浏览器 Mock 样例。合并规则不超出接口已有的证据：未读到正文的记录只显示「已记录」，失败与未发表内容默认收在「显示处理过程」之后。真实运行实例、长会话容量与发行包仍未验收。

> [跨场景短信实验样例](../studies/cross-scene-communication-20261010.md)允许声明媒介名称和有向联系人；[电话实验](../studies/cross-scene-phone-20261010.md)进一步支持自主接听与持续连接，但仅独立实验入口加载。默认网页、活动脚本与 Launcher 尚未安装此能力；改名为托梦不会自动实现睡眠条件或匿名来源。

> [活动与通信组合实验](../studies/cross-scene-activity-20261010.md)已用活动现有 `interactions` 白名单裁定通信：允许时可以收发与接听，禁止时直接提交也不能绕过；默认宿主尚未安装这套组合规则。

World Pack 用于定义人物、地点、物品、认知、场景、叙事与 Interaction。当前网页接受 `worldpack-source/v5` 源目录，以宿主已安装能力编译；旧格式不会自动回退到旧运行时。可参考 `ai-girls-awaken-v10`、`prototype-g1` 和 `hand-in-hand`。

## 关键角色自主行动（2026-10-11，实验分支）

例如玩家与同行者在前室说话，独自在后室的留守者也可以整理自己的安排，决定移动后再参加讨论。唤醒只提供处理机会，不会把前室发言或私语传给场外角色。目标复用角色自身 cognition/goals，表达、沉默、操作与结果续写仍由同一个 Character Turn 处理。

世界包在 `worldpack.source.json` 的 `assetFiles` 登记 `autonomy.json`，宿主按已编译资源摘要读取声明；没有登记就不加载。不增加包格式版本或独立活动，也不执行新的作者脚本。最小样例见[character-autonomy](../../../examples/world-packs/character-autonomy/README.md)。

```json
{
  "characters": [{
    "characterId": "character:friend",
    "triggers": [{"actionType": "move"}, {"actionType": "interact", "definitionId": "base:take"}],
    "everyPlayerTurns": 2,
    "opportunities": 1,
    "interactions": ["base:take"],
    "locationIds": ["location:front-room", "location:back-room"],
    "targetIds": ["entity:brass-key"]
  }]
}
```

| 字段 | 含义 |
| --- | --- |
| characters | 最多 8 个不重复的已声明 NPC，不可包含玩家 |
| triggers | 匹配成功提交的 speak/move/interact；interact 可按 definitionId 限定。多个条件为“或” |
| 活动触发 | 可写 `{"activityKey":"default","operation":"guess"}`，只匹配实际玩家活动操作 |
| everyPlayerTurns | 每累计多少个符合条件的玩家提交触发一次，1–100；失败、重复请求、NPC 行动和活动开始/重试/暂停/恢复/放弃不计数 |
| opportunities | 作者请求的自主激活次数，1–100；实际取启动器机会限制与此值的较小值 |
| interactions | 此次自主激活可尝试的交互定义 ID 白名单，空列表仅保留表达和区域内移动 |
| locationIds | 可自主处理与移动的已声明地点；角色当前不在范围内则本次不给机会 |
| targetIds | 可选的受控目标 ID 白名单；限定直接目标及裁定返回的非自身角色/实体/关系绑定，不扩大原有可见性 |

同一玩家事务即使匹配多个条件也只计一次。宿主从完整已提交事件及现有行动记录推导次数，不使用世界 tick，不另存计数器；节点、分叉与末端候选随同一事件前缀恢复。取消、沉默、预算未覆盖的机会不补发、不积攒，不恢复未提交队列。

默认每个自主机会最多一次受控操作及结果续写；有调用余量时可主动召回补问。作者交互和区域限制同时过滤 affordances 并在 Rulebook 裁定时检查，不能靠直接模型参数绕过；声明也不能赋予宿主未安装的交互能力。自定义交互中的所有业务语义仍由其实现负责，运行时不解析自由文字来证明目标已完成。

启动器按游戏包保存独立资源上限，下次启动生效：每角色 1 次自主机会、全部自主角色 3 次模型调用、后续反应 1 波/4 次调用，自主及后续共用 60 秒。机会设 0 关闭自主唤醒，反应波次设 0 关闭后续连锁；模型请求与单角色时限继续复用既有设置。召回、格式修正、stale 重算和结果续写都占用所属调用预算，Core 记忆 Utility 沿用自身预算。

动态条件满足时，普通观察者与到期关键角色同时进入待派发队列；最多两个在途激活，场外最多一个，当前场景优先。派发时排除相同地点及同一角色；在途移动合流后，已提交结果续写继续，过期视图重算。关键角色的普通根回应合并到自主机会，刺激仍来自自己的授权观察。自主行动提交后即可为其他授权观察者派发有界反应，不等待所有自主机会结束；普通与后续反应沿用本回合已有激活计数，到期角色不因这段连锁增加自主次数。普通、自主及后续反应分别限制调用数。普通回应已就绪时可合并自主观察，避免重复调用；后续只剩自主来源的观察则使用自主后续预算。普通截止不取消独立自主机会，反之亦然；玩家取消/暂停停止全部未提交计算。

当前主动 Activity 优先拥有参与者调度，自主调度跳过这些参与者；非参与者仍可因声明的玩家活动操作自主处理，不获得活动私有上下文。没有活动参与者排程或 `publicationAudit` 且未启用 `--serial-scheduling` 时（2026-10-19 起不再检查变量脚本），自主机会复用上述动态队列及其公平优先级；其他入口保留普通、自主、后续反应的分段处理。多角色预算不足时不保证全部轮到，场外任务仍逐个执行。独立测量控制 stagedAutonomy 可保留旧分段方式，未加入 Launcher 设置。源码与实测见[接入记录](../studies/autonomy-dynamic-dispatch-20261011.md)。尚不支持动态脚本触发、自动目标完成判定、墙钟自治或后台常驻。

实现：[包声明与许可](../../../tests/experiments/pack-autonomy.ts)、[宿主](../../../tests/experiments/playtest-frozen-runtime.ts)、[启动器参数](../../../desktop/play-settings.ts)。自动回归见[自主调度测试](../../../tests/prototype/character-autonomy.test.ts)，真实模型情况见[实验记录](../studies/character-autonomy-20261011.md)。本分支源码能力不代表发行包已更新。

Interaction 定义和绑定提供玩法可选行为，规则负责重要状态的资格与结果。角色与地点定义不等于运行中当前位置；运行时通过提交事件和当前 view 获得状态。创作者仅在当前玩法明确追踪的机制中增加状态约束，不必结构化所有叙事细节。

## 包内活动

例如作者可以固定与同行者猜数字，也可以让玩家选择邀请留守者约会；被邀请者自己通过操作接受或拒绝。当前活动桥位于实验宿主。可信本地脚本声明 title、operations，以及固定 npcIds 或动态 participants（player-select、人数与可选候选白名单）；initialize 收到本次实际选定的 npcIds，policy 决定各主体表达／操作许可，resolve 同步裁定，schedule / onOutcome 返回 wait 或请求该场参与者处理。可选 simulate(request) 为该角色提供局部固定演出决策，null 表示调用真实模型；仅替换响应来源，不改变授权上下文、预设输出处理、格式校验、Rulebook、事务提交或观察分发。

每场最多 8 个 NPC，玩家身份由宿主绑定，开始时参与者须存在且属于玩家当前授权场景；动态名单开始后固定，暂停与恢复保留同一名单。状态 public 只在参与者间共享，private 仅给对应角色，internal 不进入角色视图；脚本不能直接写世界或调用模型。活动结果按参与者或 self 投递，非参与者不获得活动视图、许可限制或活动调度资格，仍按普通交流和行动的观察权限知情。结果范围 self 只限制结果收件人，不能补救把秘密写进 public 的错误。接口例子和旁观者边界见[活动指南](../guides/activity-and-variables.md)。

每次活动输入最多串行 4 次角色激活、每次最多 2 次决策机会，主动 recall 可追加一次补问；最多 12 次模型调用，活动链 90 秒。预算耗尽或失败保留已提交状态，允许显式重试或逃生，不精确恢复未提交机会。

`ai-girls-hosted-guess` 展示主持角色私有答案与多 NPC 有界链；默认能力限制不替角色决定情绪、策略和台词；作者显式声明的固定演出可通过 simulate 提供同格式决策。完整活动结果附带身份／阶段元数据以形成授权经历，但 Core 整理仍须显式开启，默认网页仍原生记忆。

## 创作入口与限制

先看[字段手册](../guides/world-pack-authoring.md)、[试玩步骤](../guides/creator-playtest.md)和[自定义网页](../guides/web-ui.md)。`frontend/` 使用显式 manifest 和 iframe 公共玩家接口，只改展示，不改变世界包编译身份；未提供时使用官方默认模板。新实验使用独立数据目录。

Launcher 游戏库（2026-10-16）界面配色由全局设置的主题色决定（樱色默认，另有灯火、月夜、森林；保存在 launcher.json 的 preferences.palette，经 PERSPECTRA_PALETTE 传给游戏进程），以世界包封面作为首屏：在包根目录放 `cover.webp`、`cover.png` 或 `cover.jpg`（≤4 MB，建议 16:9 横图、主体偏右，左下留给标题），[launcher-core](../../../desktop/launcher-core.ts) 载入或启动时读取，经单独的 `pack-cover` 请求交给页面，不随 2.5 秒快照轮询重复传输；简介取 `world.json` 的 `description`。封面不进入编译产物，也不改变包 Hash。缺少封面时启动器按标题首字生成排版封面。（2026-10-17 改版后封面铺满整个窗口，“游玩准备”与折叠的“引擎与创作者工具”已由本局抽屉取代，见[首轮真实 Core 接入](../launcher-core-integration.md)顶部说明。）已用浏览器 Mock 与 `launcher-core` 测试核对；Tauri 真机窗口与发行包未验收。

实现：[活动桥](../../../tests/experiments/pack-activity.ts)、[活动选择](../../../tests/experiments/pack-activities.ts)、[World Pack 工具](../../../packages/world-pack)、[主持示例](../../../examples/world-packs/ai-girls-hosted-guess)。当前不承诺任意玩法零宿主改动、多活动并行或不可信脚本沙箱。短冒烟不等于长试玩验收。

### 多个独立玩法，一次运行一个（2026-10-10）

例如玩家暂停猜数字、讨论周末计划、再回来继续猜：assetFiles 可登记 scripts/activities/guess.js 与 scripts/activities/weekend.js，每场各有状态、参与者和操作。它替代原先整个包只能使用一套活动的约束，没有新增并行调度。原 scripts/activity.js 作为 default 活动继续使用。

PackActivities 选择唯一正在运行的 PackActivity，只向该活动交付角色请求、许可和调度；没有 active 时使用普通规则。活动事件以 activityKey 区分，暂停保留进度并关闭 active，旧操作因身份／revision 或非 active 被拒绝。开始／继续在写入租约内检查没有另一 active；状态、玩家管理观察和世界 tick 同事务提交。继续使用当前授权 world 检查作者 resume 条件；没有 hook 时要求同场。暂停／恢复不改真实世界位置或物品，不续跑未提交计算。放弃暂停进度和前台逃生保留已提交经历，其他暂停活动不变。

完整节点通过原世界数据库保存全部活动进度。作者 hook、公开 SDK 字段及操作步骤见[活动指南](../guides/activity-and-variables.md#多活动选择与暂停2026-10-10当前源码)，样例见[多活动包](../../../examples/world-packs/multiple-activities/README.md)。测试覆盖切换、隔离、条件拒绝、事务失败及分叉；真实模型体验与既有便携包包含情况另行报告。


### 2026-10-07：活动格式失败的有界修正

活动角色调用按 Core 的严格决策 schema 校验，本机发送端继续复用既有扁平 schema 适配。格式非法时只自动修正一次；能够唯一识别模型已选决策及交互选项时，修正请求使用该分支和选项，避免网关展开联合字段。固定数字在修正 wire schema 中用相等的 minimum/maximum 表达，以规避本机 numeric const 调用中多次得到字符串输出的现象（未分析网关内部实现）；Core 仍使用原始 schema 校验，不转换模型字段、不删除混合表达。

格式修正不增加受控动作预算。返回后继续现有世界高水位、活动版本、权限及事务校验。两次均非法保留原轮次，格式失败与服务失败分别显示；重试和逃生仍可用。此实现仅覆盖活动调用，不表示通用 G2 格式修正全部完成。

## 官方同居试玩包的最小补齐

例如玩家点击序章的“继续”，当前节点是“……什么情况？这里不是我家吗？”，这句话会成为正式玩家公开表达，而不是只写进前端对白框。`resolve` 可返回 `playerExpression: { text }`，宿主只允许玩家活动操作使用，按当前表达许可及原有 speak Rulebook 校验，将表达、授权观察和活动进度放在同一事务中。脚本来源保存在活动事件的 `scriptedPlayerExpression.source`，不投递给角色观察或公共 SDK。默认没有该字段的活动行为不变。也可返回 `playerExpression: { narration }` 提交旁白；操作定义的 `quick: true` 让玩家在行动菜单一键开始并执行该操作，见[活动与状态指南](../guides/activity-and-variables.md)。

NPC 固定台词发表时，可选 `onPublished(state, actorId, expression)` 返回新的 game，或 null。宿主仅在活动中的参与角色发表合法 speak 时调用，将发表与进度更新原子提交；提交失败不会跳过该句。该 hook 是同步裁定，不直接发言、调用模型或启动独立引擎。

`initialize` 另收到玩家授权的 `world` 和 `previous`（玩家自己的上次活动视图或 null）；`resolve` 第五参数是当前行动主体授权的 `world`。它包含 locationId、当前可观察角色 characterIds、items.current / lastObserved，使用同一事件前缀与已有可见物品投影，不提供全世界库存。条件不满足可返回唯一字段 `rejectReason`（非空、最多 2000 字符），不提交活动变更。

[官方包](../../../examples/world-packs/model-girls-official/README.md) 使用这些入口完成 112 条序章表达，其中 5 条为玩家中性问题。最后请求收留后活动结束，后续输入走真实模型。生活活动只提交开场种子；米饭制作另由已有交互扩展机制裁定。自动实验核对完整表达与零角色 provider 调用；后续本机 Gemini 已完成拒绝、正式料理、私密交流、蛋糕目击和归档后回访的短场景验收，见 [真实记录](../../../examples/world-packs/model-girls-official/LIVE-VALIDATION.md)。默认反应时间截止及未覆盖组合仍明确保留。

### 完整序章的脚本输入限额（2026-10-09）

从 Launcher 开启 Core 记忆运行官方序章时，第 100 句的正常角色授权请求为 66,124 个 JSON 字符，超过原来的 65,536 输入上限，导致固定输出不能发表。现在仅 simulate 的完整角色上下文输入允许最多 1 MiB JSON 字符；其他脚本调用和所有返回值仍限制 65,536 字符，脚本执行仍限制 100 ms。超过上限继续失败，不截断认知、不扩大读取权限，不推进未发表的游标。模拟输出仍经过正常表达校验与提交。

### 固定序章的活动状态读取（2026-10-10）

例如同一句固定对白在准备、格式校验和提交后刷新中多次读取活动状态，宿主现在先核对当前世界提交序号，只读取 `activity.updated` 事件，并复用同一前缀下已验证的状态。每次返回独立副本；新事件提交后重新读取，失败提交不会提前更新活动游标。复用范围限于当前 PackActivity 实例，不缓存角色授权上下文或模型决策，不在候选世界之间共享状态。

这是源码接通的性能优化；现有 test3 便携包尚未更新。普通角色视图与已安装记忆档案仍走原有读取／来源校验路径，未引入持久化缓存或新增数据库。

完整 112 条序章及同节点重复测量见[性能实测](../studies/prologue-performance-20261010.md)，包含自动验证范围与未完成的真实模型试玩。
