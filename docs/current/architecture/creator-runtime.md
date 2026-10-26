# 当前创作者运行时

2026-10-26 双入口：例如澄请求设备确认后只增加本人次数，作者随包分发 `plugins.json` 和规则模块，本地 Cordis 插件注册 `ctx.capabilities`。模块组合进既有 PackStatus，候选与执行继续重查权限；异步完成后才校验结果并沿现有事件事务提交，queued 只确认排队。[实现记录](../studies/2026-10-26_dual-plugin-entrypoints.md)和[作者指南](../guides/dual-plugin-entrypoints.md)说明目录、世界绑定、角色请求、取消与未知结果暂停。源码、模拟模型和构建入口验证不代表真实体验或发行包验收。

RPG Maker 方向暂停继续扩展自研 RPG Core 战斗规则。[桥接骨架](../../../examples/rpg-maker/README.md)通过同一入口提供有限队员视图与公共事件白名单；MZ 可请求绑定 NPC 运行原有角色回合。外部观察须由包内规则选择是否提交，不直接变成世界真值。仍没有实际 MZ 工程、合法战斗技能输入或配对存档；含外部写能力时禁用节点和回退。下方自研规则实验保留当时验收范围。

2026-10-26 RPG Core 实验：例如澄选择火球后，守卫和浮游机按确定性规则反击，两个敌人只作为战斗单位存在。共享算法在 [examples/rpg-core](../../../examples/rpg-core/generate.mjs)，作者编辑战斗数据后运行生成器，得到普通的 `scripts/activities/battle.js`，随包发布并受资产锁保护；运行时只走下方原有的包内活动路径，不加载插件、不新增数据库、角色协议或提交路径。最初版本由 Cordis 插件在开局生成脚本，同日已删除。群攻、中毒、奖励事务、重启以及“发布脚本与资料一致”已由模拟服务测试验证；真实模型、浏览器体验与发行包未验收，完整限制见[实验记录](../studies/2026-10-26_cordis-rpg-core-prototype.md)。

2026-10-26 包内 RPG 实验：例如玩家施放火球后，同伴和守卫依次提交技能，再由包内规则结算胜败。[遗迹守卫包](../../../examples/world-packs/rpg-turn-battle/README.md)只用现有状态脚本和活动脚本完成 2v1 回合战斗，未修改宿主。活动进度与 HP / MP / 药水 / 金币沿同一事务提交；默认 NPC 由 `simulate` 提供策略，也可将同伴切换到模型决策。相关宿主自动化已验证，模型模式只使用模拟服务；真实模型策略、浏览器体验和发行包尚未验收。机制范围与限制见[评估记录](../studies/2026-10-26_gameplay-rpg-report.md)。这证明可信包内编程可以组合现有机制，不代表静态交互 JSON 自动具备战斗效果。

2026-10-24 创作资源：仓库的 [perspectra-creator](../../../skills/perspectra-creator/SKILL.md) 通过 [CLI 构建函数](../../../scripts/build/build-worldpack-cli.mjs)复制到程序的同名 skills 目录，整合原创世界包、旧 tavern-to-perspectra 的静态卡片提取／容量分析及迁移流程、原生预设创作与模板。脚手架使用随包 Node，卡片提取使用随包 Python；不执行原卡脚本，不依赖旧 Skill 或仓库。它不增加运行时插件或预装试玩包。[Skill 检查脚本](../../../scripts/release/verify-creator-skill.mjs)在独立环境验证脚手架、防覆盖、文档示例、合成 PNG／JSON 卡的数据保留，以及原生预设模板和非法字段／宏拒绝；真实迁移作品与角色体验仍需单独验收。

预设创作可让同行者少写总结、保留自己的语气；不会授予其读取信件秘密的权限。CLI 进程新增 `preset validate <file> [--pack]`，直接复用 [rolePreset](../../../packages/provider-chat/src/preset.ts) 和[预设库导入](../../../packages/provider-chat/src/preset-library.ts)校验；包推荐模式只接受裸 RolePreset，预设库模式支持交换格式。它只检查字段、宏与正则语法，不执行文本替换、不写入预设库、不证明风格效果。世界包 validate 仍不自动加载预设扩展，需分别检查；详见[预设创作](../../../skills/perspectra-creator/references/presets.md)。

2026-10-24 创作校验入口：例如作者修改同行者拿钥匙的作品后，可在程序目录调用 `worldpack.cmd validate <源目录>`，让创作 Skill 读取退出码及 JSON 诊断。便携构建复用 [CLI 进程入口](../../../packages/world-pack/process/cli-entry.ts)和[构建函数](../../../scripts/build/build-worldpack-cli.mjs)，随包 Node 与 jieba-wasm 执行，不依赖创作者的源码环境；`--version` 给出程序与格式版本，`--help` 说明范围。CLI 不执行玩法脚本或启动完整宿主；`test` 仅编译适配，不执行声明断言。独立目录、空 PATH、中文和空格路径以及错误码已由[隔离检查](../../../scripts/release/verify-worldpack-cli.mjs)覆盖；这次不涉及角色协议，也未据此声称真实模型体验或完整发行包通过。操作见[创作指南](../guides/world-pack-authoring.md#6-校验与试玩)。

2026-10-22 核对：例如留守者自主去拿钥匙，包内 `scripts/status.js` 的作者模板提供 `status:take`，`autonomy.json` 再允许它在本次机会使用这一操作。活动 policy 同样用 `status:take`／`status:drop`／`status:give` 引用拿、放、给；这些操作不再由基础交互包安装。模板、目标筛选和执行复查见[物品操作](../guides/activity-and-variables.md#对物品做的操作2026-10-22当前源码)。下方示例已按现行 ID 更新，带日期的旧试玩结果不等于新模板已完成同样验收。

2026-10-21 宿主整理：当前实现位于 `desktop/host`。例如创作者查看角色体力时，检查响应的 `statusTruth` 返回已提交状态真值，控制台“状态”页读取同一字段；旧 `variables` 字段已移除。它是宿主认证后的只读能力，玩家公开接口仍按既有权限过滤，不因更名扩大可读范围。活动自己的 public/private/internal 变量保持原含义。模型请求、Context、调度与状态裁定规则没有因目录整理改写；源码和构建验证不代表新的真实模型体验验收。

2026-10-19 知识条件扩展：例如同行者在前室、眼前能确认钥匙且本次刺激来自玩家时，才交付钥匙背景。`when` 继续使用 JSON Schema，保留 public／self／characters 的已知值条件，另可检查接收者、当前位置、授权场景、当前／旧物品、本人活动、刺激与 knownStatus 的 current。活动授权视图增加稳定 activityKey；不读取隐藏世界真值，也不新增状态副本或自动事件链。字段与示例见[世界设定指南](../guides/world-knowledge.md#按场景物品活动与本次刺激筛选)。[Core／DeepSeek 真实试玩](../studies/knowledge-conditions-deepseek-playtest-20261019.md)的 39 次请求交付均符合预期，角色查看钱包前后分别使用过时／有效材料；这是短样本，来源表达仍有扩写，发行包未重建。

2026-10-19：作者可以用 `scripts/status.js` 声明金钱、HP、游戏时间这类常驻状态，以及带 JSON Schema 的对象、数组，例如按任务 ID 保存阶段和记录。操作 policy 按行动者已知状态决定哪些选项出现，执行前重查；知识条目的 when 用 Schema 判断同一份已知状态。实际变化仍由 resolve 或每轮钩子裁定，不自动启动递归事件链。真实值只在世界事件里，每个角色和玩家只知道告知过自己的值；活动 resolve 也可以在返回中附带 `status` 变化，并收到第六个参数 truth；状态和操作可用 `activities` 收窄到指定活动。它替代已删除的包变量。完整契约、上限与已知限制见[活动与状态指南](../guides/activity-and-variables.md#3-状态2026-10-19当前源码)，样例见[集市钱袋](../../../examples/world-packs/status-market/README.md)。源码与自动测试已接通，未做真实模型试玩，发行包未重建。

2026-10-18：例如花房角色依据人设、预设、记忆和对话历史改变对玩家的看法，不另设好感度或信任分数。最初切片的关系数值、面板及门槛已撤销；变量优先承载玩法明确追踪的客观变化，沿已有活动、交互及规则维护。源包仍可登记 `knowledge.json`，由 [PackKnowledge](../../../desktop/host/pack-knowledge.ts) 按权限和关键词交付背景设定，不占用活动。配置和预算见[作者指南](../guides/world-knowledge.md)。移除分数后已做离线验证，真实模型未重跑，发行包未更新。

创作者观测接口见[调试接口](../creator-debug-api.md)：例如钥匙从同行者交给留守者，可以查询保管与地点历史、实际观察受众、对应行动参数和裁定，再检查角色当次使用的预设与上下文。2026-10-15 已接通事件历史和可重启读取的私有调用记录，继续沿用宿主权限；仅查询不会触发作者脚本、召回或模型调用。

同一天补齐了第一版[创作者控制台](../creator-debug-api.md#创作者控制台)：2026-10-17 起改为由 Launcher“打开创作者页面”在系统浏览器打开的独立页面（[入口](../../../apps/launcher/src/creator/main.ts)，只在游戏运行时可用，“模型请求”视图取代原请求探查对话框），左侧是游戏／故事线／角色导航，中间是「对话」连续阅读与「轨迹」紧凑表格，右侧是按对象变化的详情面板；世界总览、角色、物品、状态和活动共用同一套列表框架。它只做读取与合并：`apps/launcher/src/creator` 下的 [store.ts](../../../apps/launcher/src/creator/store.ts) 负责分页、轮询去重与选择状态，[model.ts](../../../apps/launcher/src/creator/model.ts) 把已提交事件与私有记录合成一条轨迹，[source.ts](../../../apps/launcher/src/creator/source.ts) 用页面令牌同源读取 `/api/creator-*`，没有令牌时使用浏览器 Mock 样例。合并规则不超出接口已有的证据：未读到正文的记录只显示「已记录」，失败与未发表内容默认收在「显示处理过程」之后。真实运行实例、长会话容量与发行包仍未验收。

> [跨场景短信实验样例](../studies/cross-scene-communication-20261010.md)允许声明媒介名称和有向联系人；[电话实验](../studies/cross-scene-phone-20261010.md)进一步支持自主接听与持续连接，但仅独立实验入口加载。2026-10-25 起包内放 `communication.json`（媒介名称与有向联系人，登记在 `assetFiles`）即在默认宿主启用短信，`model-girls-sweet-days` 是第一个开启的包；电话、活动期间收发短信仍未接入默认宿主；改名为托梦不会自动实现睡眠条件或匿名来源。

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
| 活动触发 | 可写 `{"activityKey":"default","operation":"guess"}`，只匹配实际玩家活动操作 |
| everyPlayerTurns | 每累计多少个符合条件的玩家提交触发一次，1–100；失败、重复请求、NPC 行动和活动开始/重试/暂停/恢复/放弃不计数 |
| opportunities | 作者请求的自主激活次数，1–100；实际取启动器机会限制与此值的较小值 |
| interactions | 此次自主激活可尝试的交互定义 ID 白名单，空列表仅保留表达和区域内移动 |
| locationIds | 可自主处理与移动的已声明地点；角色当前不在范围内则本次不给机会 |
| targetIds | 可选的受控目标 ID 白名单；限定直接目标及裁定返回的非自身角色/实体/关系绑定，不扩大原有可见性 |

玩家点“静观”（让这一轮过去）时，不论 triggers 怎么写，都算一次符合条件的玩家回合：例如 triggers 只写了“拿起钥匙”的角色，玩家静观时也会按 everyPlayerTurns 的节奏得到机会。静观本身不产生任何可观察的内容，所以角色拿到的新刺激为空，只能凭自己的目标和处境行动。静观要求包有状态脚本（轮次记在那里），活动进行中不提供。

同一玩家事务即使匹配多个条件也只计一次。宿主从完整已提交事件及现有行动记录推导次数，不使用世界 tick，不另存计数器；节点、分叉与末端候选随同一事件前缀恢复。取消、沉默、预算未覆盖的机会不补发、不积攒，不恢复未提交队列。

默认每个自主机会最多一次受控操作及结果续写；有调用余量时可主动召回补问。作者交互和区域限制同时过滤 affordances 并在 Rulebook 裁定时检查，不能靠直接模型参数绕过；声明也不能凭空提供未注册的交互或包内操作。自定义交互中的所有业务语义仍由其实现负责，运行时不解析自由文字来证明目标已完成。

启动器按游戏包保存独立资源上限，下次启动生效：每角色 1 次自主机会、全部自主角色 3 次模型调用、后续反应 1 波/4 次调用，自主及后续共用 60 秒。机会设 0 关闭自主唤醒，反应波次设 0 关闭后续连锁；模型请求与单角色时限继续复用既有设置。召回、格式修正、stale 重算和结果续写都占用所属调用预算，Core 记忆 Utility 沿用自身预算。

动态条件满足时，普通观察者与到期关键角色同时进入待派发队列；最多两个在途激活，场外最多一个，当前场景优先。派发时排除相同地点及同一角色；在途移动合流后，已提交结果续写继续，过期视图重算。关键角色的普通根回应合并到自主机会，刺激仍来自自己的授权观察。自主行动提交后即可为其他授权观察者派发有界反应，不等待所有自主机会结束；普通与后续反应沿用本回合已有激活计数，到期角色不因这段连锁增加自主次数。普通、自主及后续反应分别限制调用数。普通回应已就绪时可合并自主观察，避免重复调用；后续只剩自主来源的观察则使用自主后续预算。普通截止不取消独立自主机会，反之亦然；玩家取消/暂停停止全部未提交计算。

当前主动 Activity 优先拥有参与者调度，自主调度跳过这些参与者；非参与者仍可因声明的玩家活动操作自主处理，不获得活动私有上下文。没有活动参与者排程或 `publicationAudit` 且未启用 `--serial-scheduling` 时（2026-10-19 起不再检查变量脚本），自主机会复用上述动态队列及其公平优先级；其他入口保留普通、自主、后续反应的分段处理。多角色预算不足时不保证全部轮到，场外任务仍逐个执行。独立测量控制 stagedAutonomy 可保留旧分段方式，未加入 Launcher 设置。源码与实测见[接入记录](../studies/autonomy-dynamic-dispatch-20261011.md)。尚不支持动态脚本触发、自动目标完成判定、墙钟自治或后台常驻。

实现：[包声明与许可](../../../desktop/host/pack-autonomy.ts)、[宿主](../../../desktop/host/world-runtime.ts)、[启动器参数](../../../desktop/play-settings.ts)。自动回归见[自主调度测试](../../../tests/scenarios/character-autonomy.test.ts)，真实模型情况见[实验记录](../studies/character-autonomy-20261011.md)。本分支源码能力不代表发行包已更新。

Interaction 定义和绑定提供玩法可选行为，规则负责重要状态的资格与结果。角色与地点定义不等于运行中当前位置；运行时通过提交事件和当前 view 获得状态。创作者仅在当前玩法明确追踪的机制中增加状态约束，不必结构化所有叙事细节。

## 包内活动

例如作者可以固定与同行者猜数字，也可以让玩家选择邀请留守者约会；被邀请者自己通过操作接受或拒绝。当前活动桥位于实验宿主。可信本地脚本声明 title、operations，以及固定 npcIds 或动态 participants（player-select、人数与可选候选白名单），可选 opening 作为玩家看到的开场文案（参与者仍收到固定开场行）；initialize 收到本次实际选定的 npcIds，policy 决定各主体表达／操作许可，resolve 同步裁定，schedule / onOutcome 返回 wait 或请求该场参与者处理。可选 simulate(request) 为该角色提供局部固定演出决策，null 表示调用真实模型；仅替换响应来源，不改变授权上下文、预设输出处理、格式校验、Rulebook、事务提交或观察分发。

每场最多 8 个 NPC，玩家身份由宿主绑定，开始时参与者须存在且属于玩家当前授权场景；动态名单开始后固定，暂停与恢复保留同一名单。状态 public 只在参与者间共享，private 仅给对应角色，internal 不进入角色视图；脚本不能直接写世界或调用模型。活动结果按参与者或 self 投递，非参与者不获得活动视图、许可限制或活动调度资格，仍按普通交流和行动的观察权限知情。结果范围 self 只限制结果收件人，不能补救把秘密写进 public 的错误。接口例子和旁观者边界见[活动指南](../guides/activity-and-variables.md)。

每次活动输入最多串行 4 次角色激活、每次最多 2 次决策机会，主动 recall 可追加一次补问；最多 12 次模型调用，活动链 90 秒。预算耗尽或失败保留已提交状态，允许显式重试或逃生，不精确恢复未提交机会。

`ai-girls-hosted-guess` 展示主持角色私有答案与多 NPC 有界链；默认能力限制不替角色决定情绪、策略和台词；作者显式声明的固定演出可通过 simulate 提供同格式决策。完整活动结果附带身份／阶段元数据以形成授权经历，但 Core 整理仍须显式开启，默认网页仍原生记忆。

2026-10-24 创作边界澄清：例如作者可以在送礼后写入角色专属的心动印象，引导接下来的反应，也可以显式编排剧情与固定演出。尊重角色主体性不要求每个游戏包都采用完全自主的感情发展；作者可以用已有状态与活动机制影响角色，仍须遵守信息接收范围，以及位置、物品等权威事实的正式提交规则。[屋檐下的心动日程](../../../examples/world-packs/model-girls-sweet-days/README.md)保留这种引导，弱化部分绝对结论；这些包内选择不构成引擎对其他作者的限制。

## 创作入口与限制

先看[字段手册](../guides/world-pack-authoring.md)、[试玩步骤](../guides/creator-playtest.md)和[自定义网页](../guides/web-ui.md)。`frontend/` 使用显式 manifest 和 iframe 公共玩家接口，只改展示，不改变世界包编译身份；未提供时使用官方默认模板。新实验使用独立数据目录。

Launcher 游戏库（2026-10-16）界面配色由全局设置的主题色决定（樱色默认，另有灯火、月夜、森林；保存在 launcher.json 的 preferences.palette，经 PERSPECTRA_PALETTE 传给游戏进程）（2026-10-22 起主题色设置已删除：官方舞台和宿主外壳改为黑白、跟随系统；启动器保留原默认配色；旧 launcher.json 里的 palette 读取时忽略、下次保存时去掉。），以世界包封面作为首屏：在包根目录放 `cover.webp`、`cover.png` 或 `cover.jpg`（≤4 MB，建议 16:9 横图、主体偏右，左下留给标题），[launcher-core](../../../desktop/launcher-core.ts) 载入或启动时读取，经单独的 `pack-cover` 请求交给页面，不随 2.5 秒快照轮询重复传输；简介取 `world.json` 的 `description`。封面不进入编译产物，也不改变包 Hash。缺少封面时启动器按标题首字生成排版封面。（2026-10-17 改版后封面铺满整个窗口，“游玩准备”与折叠的“引擎与创作者工具”已由本局抽屉取代，见[首轮真实 Core 接入](../launcher-core-integration.md)顶部说明。）已用浏览器 Mock 与 `launcher-core` 测试核对；Tauri 真机窗口与发行包未验收。

实现：[活动桥](../../../desktop/host/pack-activity.ts)、[活动选择](../../../desktop/host/pack-activities.ts)、[World Pack 工具](../../../packages/world-pack)、[主持示例](../../../examples/world-packs/ai-girls-hosted-guess)。当前不承诺任意玩法零宿主改动、多活动并行或不可信脚本沙箱。短冒烟不等于长试玩验收。

### 多个独立玩法，一次运行一个（2026-10-10）

例如玩家暂停猜数字、讨论周末计划、再回来继续猜：assetFiles 可登记 scripts/activities/guess.js 与 scripts/activities/weekend.js，每场各有状态、参与者和操作。它替代原先整个包只能使用一套活动的约束，没有新增并行调度。原 scripts/activity.js 作为 default 活动继续使用。

2026-10-21：例如回报巡查后弭弗在场，就自动开始“名单”剧情。活动脚本可写可选的 `autoStart(truth, world, previous)`，返回 `when` 布尔数组（全真才满足，长度即条件数目）、可选 `npcIds` 与只给玩家的 `notice`（替换玩家看到的固定开场行，参与者仍收到固定行）。[宿主](../../../desktop/host/world-runtime.ts)在被接受的玩家回合依次完成角色反应和 `onRoundEnd` 后检查一次；没有活动运行时，条件数目最多的候选开始，平局从本轮随机记录中抽取，重新生成按记录回放。开始复用玩家开始路径，事件带 `source: 'auto'`、action.resolved 为 `sourceRole: 'director'`，不计玩家回合；每轮至多一场，不连锁。脚本或开始校验失败不提交，记 `debug.autoStartError`。2026-10-24 起，写了 `autoStart` 的活动只在条件全部满足时列出手动“开始”，[活动桥](../../../desktop/host/pack-activity.ts)对手动开始请求按同一条件重查；暂停后的继续不受影响。活动仍不能移动角色。作者接口见[活动指南](../guides/activity-and-variables.md#按条件自动开始2026-10-21当前源码)；自动测试已覆盖，另有一次 8 回合 DeepSeek 短试玩确认了触发时机、提示投递与轮次计数，发行包未重建。

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
