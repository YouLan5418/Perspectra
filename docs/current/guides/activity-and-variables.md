# 创作者：活动与状态

2026-10-26：可用[包内插件模块](dual-plugin-entrypoints.md)组合现有状态与操作，并声明所需的本地 Cordis 异步能力。规则仍通过同一状态／交互裁定，活动 policy 继续限制模块操作；外部只确认排队时不修改数值。它补充原脚本入口，不要求重写活动或状态文件。

2026-10-26 新增[包内回合战斗示例](../../../examples/world-packs/rpg-turn-battle/README.md)：玩家与同伴轮流攻击守卫，支持 HP / MP、治疗、防御、药水与胜败奖励；只新增包内容，未修改宿主。完整宿主自动化通过，真实模型与浏览器体验未验收，边界见[评估记录](../studies/2026-10-26_gameplay-rpg-report.md)。

2026-10-22 核对：例如角色拿起保温杯后把它交给同伴，拿／放／给由包内作者脚本定义；本节更新了目标物品、候选筛选、物品结果和调试入口。旧日期的活动与状态验收保留当时范围，不代表当前物品模板已重验。

当前玩法桥由实验宿主加载可信本地脚本。先复制 [launcher-demo](../../../examples/world-packs/launcher-demo) 或 [主持猜数字示例](../../../examples/world-packs/ai-girls-hosted-guess)，逐步修改并真实试玩。完整运行时边界见 [创作者运行时](../architecture/creator-runtime.md)。

## 1. 文件和信任范围

`worldpack.source.json` 的 assetFiles 必须登记 `scripts/activity.js`、`scripts/status.js` 或独立活动 `scripts/activities/<标识>.js`；仅把脚本放进目录不代表启用。独立活动标识为小写字母开头、后接小写字母／数字／连字符，最长 41 字符。固定入口的标识是 default，不能再登记同名独立活动。加载时核对编译资产内容和包内路径。脚本使用同步 JSON 输入/输出，执行时间和数据大小有界，不能把异步模型调用或任意数据库对象当成参数。

**这是可信作者的后端扩展，不是不可信脚本安全沙箱。** 浏览器社区前端的 iframe 与授权只约束前端，不为整个恶意游戏包提供安全保证。只加载可信来源的后端脚本，不放模型密钥或私有运行日志。

## 2. 活动生命周期

固定入口为 `globalThis.activityScript`。定义和 hook 的完整形式以 [演示脚本](../../../examples/world-packs/launcher-demo/scripts/activity.js) 与 [当前活动桥](../../../desktop/host/pack-activity.ts) 为准。

| 部分 | 职责 |
| --- | --- |
| definition | title、operations，以及固定 npcIds 或动态 participants；声明操作 ID、标签、是否消耗回合及参数 schema。可选 `opening`（1–500 字符）是从玩家视角写的开场文案，例如“同伴把骰子推到你面前。”：开始时玩家看到这句，而不是固定的“〈标题〉开始。”；参与者仍收到固定开场行，`opening` 不进入任何角色上下文 |
| initialize | 根据宿主提供的玩家和 NPC 身份生成初始状态 |
| policy | 限定当前角色可用的发言、叙事、移动、交互和活动操作 |
| resolve | 对操作参数同步裁定，返回新状态和结果描述 |
| schedule / onOutcome | 等待，或给已声明角色一次处理机会；不直接发布或执行角色输出。两者收到**完整**活动状态（含 internal 和所有人的 private），可以按隐藏的回合决定叫醒谁；输出只有这一次激活，不会进入任何视图 |
| simulate（可选） | 为当前角色返回与模型相同格式的决策，或返回 null 继续调用模型 |
| resume（可选） | 依据玩家自己的候选恢复视图和当前授权 world 检查继续条件；null 接受，`{ rejectReason: "原因" }` 拒绝 |
| autoStart（可选） | 每个玩家回合结束时判断是否自动开始这场活动，见[按条件自动开始](#按条件自动开始2026-10-21当前源码) |

操作 schema 为明确属性的对象，不接受额外字段；活动身份/版本由宿主提供，不能在属性中重定义 activityId、revision。每场最多 8 个 NPC、16 个操作，开始时参与者必须存在且属于玩家当前授权场景。start、retry、suspend、resume、abandon 为宿主保留操作名。不同活动可复用其他操作名。

### 固定角色与玩家选人

例如作者可以固定一次剧情约会的对象，也可以让玩家选择邀请谁。同一脚本的 definition 二选一：

```js
// 固定角色：开始请求没有参数。
{ title: '约会', npcIds: ['character:companion'], operations: [/* ... */] }
// 玩家选人：min/max 计算 NPC 人数，不包括自动加入的玩家。
{ title: '约会邀请', participants: { mode: 'player-select', min: 1, max: 1 }, operations: [/* ... */] }
// 可选 candidates 白名单；不提供时允许当前授权场景中所有非玩家 NPC。
{ title: '邀约', participants: { mode: 'player-select', min: 1, max: 2,
  candidates: ['character:companion', 'character:friend'] }, operations: [/* ... */] }
```

动态开始请求使用 `parameters: { npcIds: ['character:friend'] }`。宿主在写入前重新校验人数（1 至 8）、重复对象、作者白名单、角色存在性、非玩家身份和当前场景授权。initialize 的 npcIds 是这次实际选中的名单；state.participants 保存玩家和选定 NPC，之后不动态增减，暂停和恢复保留同一名单。调度、许可、模拟响应与私有变量归属均按这次名单检查。

选择对象不等于获得对方同意。[约会邀请示例](../../../examples/world-packs/multiple-activities/scripts/activities/invite.js) 先进入 invited 阶段，由目标 NPC 执行 respond 接受或拒绝；玩家不能代替目标回应。接受才进入 date，仍不会自动移动或执行出行。作者可以用同样方式声明其他邀请流程，不新增 Core 动作类型。

### 非参与者怎样知情

例如邀请留守者时，同行者不因在同一房间就拿到邀请的活动视图。活动 public 是“参与者共享”，不是全世界公开；private 只给对应参与者，internal 不进角色视图。活动开始与操作结果按参与者或 self 投递，暂停／继续／放弃管理提示只给玩家。非参与者没有活动操作、活动许可限制或活动调度资格。

参与者原有授权 Context 仍然保留：活动不会把旁观者从世界中抹掉，角色仍可知道当前有权看见的在场人物和已收到的公开观察，但不能读取旁观者的私有信息。加入活动增加本场的授权玩法视图，不扩张对整个世界的知情范围。

实际对白和普通行动仍遵守已有观察范围：scene_public 给当前有权观察的角色完整内容；direct 只给指定对象；private 的旁观者只知发生交流；self 只给自己。参与者公开说“我接受邀请”，旁观者可以从对白得知接受，不能把活动隔离理解成禁止听见公开表达。真实移动、物品转移仍走普通规则与授权观察。当前活动链只调度参与者，不因旁观者收到公开对白就自动给其插入一次反应；其下次获得处理机会时可以依据已收到的观察回应。尚未增加观众订阅或旁观者自动插话机制。

### 多活动选择与暂停（2026-10-10，当前源码）

例如暂停调查、去玩猜数字，再回来继续调查：每个脚本保留自己最近一次进度，一次只运行一个。必须先暂停或结束当前活动，才能开始／继续另一场；不会自动嵌套切换。宿主在当前角色处理完成后才接受暂停，模型等待期间仍可用原有逃生按钮中止。

暂停保留原阶段、轮次、换手和全部玩法状态，同时解除该活动的许可与调度；不会在后台推进，不精确续跑未提交的模型计算。继续前重新读取当前玩家授权事实，未提供 resume 时要求参与 NPC 与玩家同场；提供 hook 后由作者检查玩法条件，不能据此绕过普通行动和世界权限。hook 只检查条件，不修改进度，不接收其他角色 private、internal、数据库或凭证。拒绝或提交失败保留原暂停进度。恢复不会还原人物位置或物品归属。

resume 的 view 已恢复 active 与此前 turn，但尚未提交，也尚未重新施加许可；这是待接受的候选状态，不表示活动已经恢复。

活动状态仍沿 activity.updated 提交，事件中的 activityKey 区分脚本；正在运行的活动由各自最新状态推导，最多一个 active。暂停另保留宿主 suspendedTurn，恢复时还原换手；它不是作者 game 字段。完整节点、分叉和候选世界都随世界事件保留全部活动进度，不新增数据库或活动存档文件。

玩家可以放弃指定暂停进度，保留已提交经历，之后重新开始该玩法。逃生只中止当前正在运行的活动，不清除其他暂停活动。暂停／继续／放弃的管理提示只投递给玩家，不能把另一场的秘密交给当前角色。

参照 [多活动示例](../../../examples/world-packs/multiple-activities/README.md)。宿主面板支持各活动选择，公共 SDK 通过当前版本绑定的 perform 选项提供开始／暂停／继续／放弃。view.activities 只含标识、标题、active、suspended、phase、public。retry 是再次请求当前角色处理，与恢复暂停活动的 resume 不同。

自动化覆盖独立进度、秘密隔离、旧操作拒绝、条件失败、暂停提交失败及完整节点分叉。2026-10-10 使用 8046 的 gemini-3.8-flash 完成“猜数字 → 暂停 → 周末讨论 → 恢复猜数字”短链，两场都有真实角色操作提交，恢复身份、公开进度和换手一致；未验证恢复后的下一轮模型回应、前端人工操作或长期试玩。记录、服务失败情况和复跑命令见[示例说明](../../../examples/world-packs/multiple-activities/README.md)。源码能力尚未重新打包进已有便携发行包。

### 按条件自动开始（2026-10-21，当前源码）

例如玩家回报巡查后，作者希望弭弗来谈名单的事：这一幕必须发生，不能等玩家想起去点“开始”。活动脚本可以写可选的 `autoStart`：

```js
autoStart(truth, world, previous) {
  const stage = truth?.public.patrol?.valley?.stage
  return {
    when: [
      ['还没发生过', previous === null],
      ['已经回报巡查', stage === 'done' || stage === 'claimed'],
      ['弭弗在玩家身边', world.characterIds.includes('character:c11')],
    ],
    notice: '弭弗朝你走了过来。',                        // 可选
  }
}
```

- **参数：** `truth` 是状态真实值（没有状态脚本时为 null），只在宿主内使用；`world` 是**玩家**当前授权事实（locationId、characterIds、items），格式同 resolve 第五参数；`previous` 是这场活动上次的玩家视图，从未开始过时为 null。
- **返回：** `null` 表示不检查；否则返回对象。`when` 为 1–32 项条件，全部为 true 才满足，数组长度就是条件数目。每项可以是布尔值，也可以是 `[标签, 布尔值]`，标签为 1–80 字符，两种写法可以混用；标签不影响是否满足，只是给这条条件起个名字，包透视会逐条显示标签和当前真假（没写标签的条件只显示真假）。建议都写上标签，排查“为什么没触发”时一眼就能看出卡在哪一条。玩家选人活动必须给 `npcIds`，固定参与者活动不能给。`notice`（1–500 字符）是自动开始专用的开场提示，用法同定义里的 `opening`：玩家只看到这一条开场行，不会连着出现两条系统行；参与者仍收到固定开场行。玩家开场行的优先级为 `notice` → `opening` → 固定的“〈标题〉开始。”。
- **何时检查：** 一个被接受的玩家回合结束时，依次经过在场角色反应、`onRoundEnd`，最后检查自动开始。幂等重试、NPC 行动、逃生或暂停 NPC 期间都不检查。有活动正在运行时不检查；暂停中的活动不参与（继续仍由玩家决定）。
- **选哪一场：** 条件全部满足的候选中，条件数目最多的开始；数目相同时随机选一个。每轮最多开始一场，本轮新开始的活动不会在同一轮触发下一场。随机值和活动初始化的随机数记录在同一序列里，重新生成这一轮时按记录回放。
- **怎样开始：** 与玩家点“开始”走同一条路径：参与者数量、白名单和同场校验不变，开局按参与者投递，参与者按活动 schedule 获得处理机会。开始事件带 `source: 'auto'`，对应的 action.resolved 为 `sourceRole: 'director'`，不计入玩家回合，`onRoundEnd` 的轮次不额外递增。
- **失败：** 脚本抛错、超时、返回格式不对，或宿主拒绝开始（例如参与者不在场），都不提交任何内容，原因记在调试信息 `debug.autoStartError`，不重试；下一轮条件仍满足时再试，没有触发队列。
- **手动开始也看同一组条件（2026-10-24，当前源码）：** 例如深夜冰箱事件写了“深夜、在厨房、DeepSeek 在场”，清晨时菜单里就没有“开始 深夜冰箱的偷吃抓包”。写了 `autoStart` 的活动，只有 `when` 全部为 true 时才列出“开始”；直接提交开始请求也会按同样条件重查，不满足就拒绝，什么都不提交。暂停后的“继续 / 放弃”不受影响。条件里有 `previous === null` 的活动，开始过一次后就不会再出现手动入口；想允许暂缓后重开，要换成自己的状态标记。没写 `autoStart` 的活动和以前一样随时可开始。hook 抛错时入口隐藏，手动提交会返回该错误。
- **只发生一次**由作者控制：把 `previous === null` 列为条件，或检查自己的状态标记。“执行了某种交互”由那个交互的 resolve 写一个状态标记，条件只看状态。

不能做的：活动不能移动角色，所以“某人突然出现”只能等角色自己经移动规则过来，或者把条件写成“玩家走到了那个人身边”；不打断、不自动暂停正在运行的活动；不演出玩家不在场的剧情。开场建议给出情境，让参与者自己反应；必须写死的关键台词再用 simulate。

[自动测试](../../../tests/scenarios/activity-auto-start.test.ts)覆盖条件满足与不满足、只开始一次、条件数目优先、平局随机及重新生成回放、运行中不检查、非法返回与宿主拒绝不提交、提示只给玩家、轮次不增加。2026-10-21 在本机终末地试玩包（未纳入版本控制）用 deepseek-v4.1-flash 跑了一次 8 回合短试玩：在谷地回报时弭弗不在场，没有开始；回到方兴衢的移动回合结束后自动开始，提示只给玩家，弭弗按情境先开口，轮次 1–8 无额外递增，没有 autoStartError。同场非参与者能听到弭弗的公开发言并回应，但听不到玩家在活动中对弭弗说的话。观察到一处叙事偏差：弭弗把玩家完成的巡查说成“我亲自看过”。这是单次短样本，不证明长期体验；发行包未重建。设计记录见[自动开始设计](../../superpowers/specs/2026-10-20-activity-auto-start-design.md)。

状态分为：

角色的授权活动视图额外带 `activityKey`（单活动缺省为 default，多活动使用配置 key），便于[知识条件](world-knowledge.md#按场景物品活动与本次刺激筛选)识别活动；`id` 仍是每次活动的实例 ID。game.private 只含该角色自己的部分，不因此开放其他参与者的私有状态或 internal。

| 字段 | 可见范围 |
| --- | --- |
| public | 活动参与者共同可见 |
| private | 只交付对应角色的部分；玩家自己的那一份也进入玩家视图（PlayerView 的 `activity.private`），默认舞台在活动卡片里标“只有你知道” |
| internal | 程序内部裁定材料，不进入角色视图 |
| active / phase / turn / round | 活动控制状态，按当前脚本契约生成；**每个参与者都看得到**，所以隐藏回合（比如狼人杀夜里谁醒着）不能写在 turn 里，见下文 |

猜数字的答案可以留在 internal，若主持角色需要知道答案则写进该角色 private。

隐藏回合的做法见[狼人杀实验包](../../../examples/world-packs/model-girls-werewolf/scripts/activities/werewolf.js)：夜里公开的 turn 停在一个整夜不变的中性座位，真正的行动者记在 internal，并在本人 private 里标“轮到你”；policy 读这个标记，夜间操作声明不消耗回合（requiresTurn: false），resolve 自己核对是否轮到；schedule 读 internal 叫醒对的人。宿主的活动 revision 仍会随每次操作增加，模型可据此推断有几次操作；公共 PlayerView 的 `responders` 也仍列出正在处理的角色（默认舞台只显示“正在回复”，不显示名字），玩家用开发者工具或社区前端可以读到。这两点包内无法隐藏。不要先把秘密写进 public，再试图用结果收件人 self 补救；操作 description 也应检查是否泄密。

Activity 收紧局部玩法许可；默认由模型决定扮演内容，作者也可显式提供局部固定演出输出。活动状态沿 activity.updated 提交；位置和物品仍走已有规则路径。宿主限定角色调用次数和链路耗时；耗尽或失败保留已提交结果，玩家可重试或逃生，未提交机会不保证精确恢复。

宿主提供开始、退出与恢复控制；公共前端也可使用当前版本绑定的开始／恢复选项及无需额外参数的活动选项。SDK 不提供活动管理私有接口，不能直接读内部答案或执行后台脚本。

### 可选固定演出输出

可信作者可实现同步 `simulate(request)`。宿主仍按 schedule 激活已声明 NPC，构建该角色的授权 Context、Memory 与已知状态并准备预设，随后以脚本返回值替代一次模型响应。脚本只收到当前角色的 request（context、continuation、canPerform、canRecall，以及已有的执行结果或 recallEvidence）；不收到完整活动状态、其他角色 private、internal、凭证或数据库句柄。没有 hook 或明确返回 `null` 时调用真实模型；返回 `abstain` 表示角色弃权，不等于使用模型。hook 每次在新脚本上下文中执行，不依靠脚本全局变量保存进度。

返回值继续经过现有预设输出处理、严格决策格式校验、活动许可、世界高水位检查、Rulebook、原子事件提交与观察分发；共享原有激活、动作与耗时预算。`perform` 不得混入对白；行动提交后的下一次 request 会带实际 result，作者须依据成功或拒绝选择后续 `publish` 或 `abstain`。格式错误沿用有界格式修正，使用同一个模拟响应再次校验，不自动切换到模型；脚本失败或超时也不回退到模型。模拟响应不会计作实际 provider 调用。

正常活动结束操作的最后一次续写也支持模拟，其身份来自已有执行结果元数据；后续普通互动恢复模型。结束后已解除活动许可，最后续写和普通模型一样采用正常角色表达权限。退出或逃生不触发额外固定演出。开启 Core 记忆整理、模型预设处理或实验发布复核时，那些独立模型任务仍按原机制运行；已有发布复核的角色修正请求也会再次选择 simulate 或模型响应；simulate 只替换当前角色的决策响应，不是全宿主断网开关。

示例：[雨夜来信](../../../examples/world-packs/scripted-performance/scripts/activity.js)。开场两名角色依次通过 `perform → 实际结果 → publish` 演出，等待玩家 `choose` 的 hear / leave 选择，再播放对应结尾。阶段保存在已有活动状态中；本次链路失败不继续调度下一名角色，不新增协议或演出状态机。自由对白不被自动解析为分支选择，需要执行已声明的 choose 操作。

独立无模型实验：`node --import tsx tests/experiments/scripted-performance.ts`。默认创建新的 `.tmp/scripted-performance-<时间戳>` 数据目录，保存两个分支的转录、事件和 summary；模型地址故意不可用，任何误调用都会导致实验失败。人工试玩可将 `examples/world-packs/scripted-performance` 作为源包导入并创建新实例，开始活动，选择回应后恢复自由互动。

## 3. 状态（2026-10-19，当前源码）

2026-10-24 创作边界澄清：作者也可以用角色专属状态引导心情或剧情。例如收到礼物后记下“对这份关照有些在意”，随后让角色结合人设与经历表达；作者同样可以明确编排更强的反应。完全自主的感情发展是创作选项，不是所有世界包的硬要求。此类状态要按作者意图限制知情范围，不能把一间房里的秘密写入全员始终可知的公共键，也不能用感情文案代替正式物品转移或移动。

例如玩家钱袋里有 100。同行者趁人多执行“偷窃”，作者脚本裁定成功：真实余额变成 70，结果只告诉同行者。玩家的状态栏和角色上下文仍是 100，但立刻标为“上次确认”（current=false）：玩家知道钱袋有了变化，却不知道现在是多少、是谁动的。执行“查看钱包”或付账后，才看到 70。旁边的留守者从头到尾不知道两人的余额。完整样例见 [集市钱袋](../../../examples/world-packs/status-market/README.md)。

状态是作者用代码声明、经过裁定的常驻客观值：金钱、HP、游戏时间、剧情阶段等。真实值只以 `status.updated` 世界事件提交，和对话、行动走同一次原子提交；每个观察者（NPC 与玩家相同）只知道告知过自己的值。它替代了已退役的包变量（`scripts/variables.js`、`pack-variables.json`、`/vars` 已删除）。实现在 [状态桥](../../../desktop/host/pack-status.ts)，设计见[状态栏设计](../../superpowers/specs/2026-10-18-status-bar-design.md)。

### 作者写什么

在 assetFiles 登记 `scripts/status.js`，入口为 `globalThis.statusScript`：

| 部分 | 职责 |
| --- | --- |
| definition.statuses | 每项 `{ key, label, type, owner, schema?, alwaysKnown?, activities?, playerTruth?, bar? }`。type 为 `number`／`string`／`boolean`／`object`／`array`／`null`；对象、数组必须声明同类型 JSON Schema，其他类型可选；owner 为 `public`（全世界一份）或 `character`（包里每个角色各一份，包括玩家和尚未登场的角色）；`alwaysKnown: true` 表示所有人始终知道真实值；`playerTruth: true` 表示把这个状态所有归属者的真实值交给玩家前端（见下文“显示”），不影响任何角色知道什么；`bar: true` 表示钉在玩家的状态栏（建议 2–4 项，例如时间、余额），没钉的已知状态仍在默认舞台的“状态”抽屉里，PlayerView 的 `statusBar` 每项多一个 `pinned: true` 标记，只影响显示 |
| definition.operations | 每项 `{ id, label, schema, targets?, characterParameters?, actors?, activities? }`。schema 必须是封闭对象；`targets` 列出作用的物品，label 可写 `{item}`；`characterParameters` 列出指向角色的字符串参数，宿主在调用 resolve 前检查该角色存在且在行动者当前授权场景内；`actors` 为 `player`／`npc`／`any`（默认） |
| initialize(characterIds) | 返回 `{ public, characters, reveals? }`，必须恰好包含声明的状态。新世界首次打开时提交为初始事件；角色私有状态默认告知归属者，公共状态除非 alwaysKnown 否则不告知任何人 |
| resolve(truth, actorId, operationId, parameters, world, targetId) | 裁定一次操作。truth 是真实值，只在宿主内使用，不进入任何角色视图；world 与活动 resolve 的第五参数相同；第六参数为目标物品 ID，无物品目标时为 null |
| policy(known, actorId, place)（可选） | 返回 `{ operations: ['操作ID', ...], targets?: { 操作ID: [物品ID, ...] } }`，根据已知状态筛选操作，并可用行动者手里／脚下的物品收窄目标；省略或返回 null 表示不额外筛选。只读，不提交效果 |
| onRoundEnd(truth, round)（可选） | 每次玩家输入被受理、本轮角色反应结束后调用一次，返回 `null` 或 `{ changes, reveals }` |

resolve 返回两种结果之一：

- `{ rejectReason }`：操作根本不成立（参数不对、目标不对）。什么都不提交，也不告知任何值。
- `{ changes, reveals, description, audience, items? }`：被接受的结果。changes 是 `{ holderId, key, value }`（公共状态 holderId 为 null）；description 是结果文字；audience 为 `'self'`、`'scene'` 或 `{ characters: [...] }`；可选 items 是物品外观／去向结果，见下文。

**失败不等于拒绝。** 余额不足、偷窃被发现这类玩法失败，应作为被接受的结果返回：changes 为空或只含部分变化，照常带上 reveals 和 description，角色才能通过失败得知真实值。

reveals 每项只写 `{ observerId, holderId, key }`，**不写值**；宿主按本次结果之后的真实值填入，作者无法告知一个编造的值。本次改变了行动者自己的状态时，新值自动告知行动者，不必写 reveal；别人引起的变化（例如被偷）不会自动告知归属者。reveals 和 audience 只能指向行动者本人或其当前授权场景内的角色。

### 对象、数组与条件操作

例如委托记录为 `{ market: { stage: 'done', notes: ['领取委托', '完成演示流程'] } }`。作者可用对象记录按稳定 ID 索引的任务，用数组保存清单；嵌套内容由 `schema` 检查类型、必填字段、枚举和长度。数字沿用世界事件的安全整数格式。字符串未声明 schema 时仍限 200 字符，需要长文本可显式声明更大的 maxLength，但仍受单值上限约束。

```js
{ key: 'quests', label: '委托记录', type: 'object', owner: 'character', schema: {
  type: 'object', additionalProperties: {
    type: 'object', required: ['stage', 'notes'], additionalProperties: false,
    properties: {
      stage: { type: 'string', enum: ['active', 'done', 'claimed'] },
      notes: { type: 'array', items: { type: 'string' }, maxItems: 16 }
    }
  }
} }
```

变化仍用 `{ holderId, key, value }` **整体替换该键**，不解析模型的 JSON Patch。resolve 每次收到最新 truth，作者据此构建新值，避免拿模型提供的旧对象覆盖其他变化。一次结果中任何值不符合 schema 或范围，整次操作不提交；活动附带的状态也使用相同校验。reveal 告知该键的整个对象，不能单独隐藏其中某个子字段；公开目标与隐藏结局条件应拆成不同状态键。

可选 policy 收到 `{ public, self, characters }`：公共已知值、本人已知值，以及其他角色已被告知给自己的值。未知的键不出现，已有值可能只是上次确认；它不包含全局 truth、其他角色的私密上下文或模型输出。

```js
policy(known) {
  const stage = known.self.quests?.market?.stage
  return { operations: ['check-purse', ...(stage === 'done' ? ['claim-reward'] : [])] }
}
```

这里“完成后才出现领奖选项”与“实际允许领奖”分开检查：宿主在生成玩家／NPC 候选时调用 policy，执行前再次用最新已知状态检查，旧选项或伪造请求不能绕过。policy 抛错或返回非法结果时，生成候选这一步只对该角色隐藏全部状态操作，会话和 NPC 回合照常进行，错误按角色记在 `debug.statusPolicyError`，该角色的 policy 下次成功时清除；执行操作时 policy 失败仍按作者错误抛出，什么都不提交。resolve 仍须检查最新 truth 中确实完成且尚未领奖，并一次提交加钱和 claimed 标志。状态、操作的活动范围及活动自身 policy 继续有效。

状态本身只做条件筛选：领奖等变化仍由显式操作／活动裁定或每轮钩子提交，不自动决定 NPC 是否行动。唯一的自动衔接是玩家回合结束后按条件开始一场活动（[按条件自动开始](#按条件自动开始2026-10-21当前源码)），每轮至多一步，不形成递归事件链。知识条目可用 `when` JSON Schema 按同一份已知状态筛选，见[世界设定指南](world-knowledge.md#按已知状态筛选)。完整的领取、完成、领奖和条件知识样例见[集市脚本](../../../examples/world-packs/status-market/scripts/status.js)。

### 对物品做的操作（2026-10-22，当前源码）

例如角色想拿起钥匙，再交给同伴：作者使用[物品规则模板](../../../examples/templates/item-rules.js)，在自己包的 `scripts/status.js` 顶部用 `ITEM_RULES` 列出可拿、可放、可给的物品。模板中的 `itemOperations` 并入 definition.operations，`itemTargets` 并入 policy 的目标筛选，resolve 对 take／drop／give 调用 `resolveItem`；完整接法可看[官方包脚本](../../../examples/world-packs/model-girls-official/scripts/status.js)。所有 v5 示例包已采用这一写法，宿主不再内置拿／放／给规则。

料理也用同一接口。例如厨房有生米和电饭煲，作者可以声明“煮饭”，成功后把同一物品改为熟饭。以下为脚本中的操作与 resolve 结果片段，不是一次真实模型验收记录：

```js
// definition.operations 中的一项。
{ id: 'cook-rice', label: '用电饭煲煮一锅白米饭', targets: ['entity:rice-batch'],
  schema: { type: 'object', additionalProperties: false, properties: {} } }
// resolve(truth, actorId, operationId, parameters, world, targetId) 内，条件检查通过后：
return { changes: [], reveals: [], items: [{ entityId: targetId, kind: 'cooked-rice' }],
  description: '这一份米与水已煮成一锅白米饭；原食材不再可用。', audience: 'scene' }
```

- `targets` 列出操作作用于哪些已登记物品。每件行动者自己拿着、或放在所在位置地上的物品各给一个选项（别人手里的物品不提供，免得泄露谁拿着什么）；选项名里写 `{item}` 会替换成物品名，例如 `拿起{item}` 显示为“拿起保温杯”，不写时列了多件物品才在后面加“· 物品名”；`resolve` 第六个参数是这件物品的 ID。不写 `targets` 的操作仍作用于行动者本人，第六个参数为 null。
- 结果可多写 `items`，至多 8 项 `{ entityId, kind?, to? }`：`kind` 是物品新的外观（1–500 字），只改 kind 时留在原处或原持有者手里；`to` 是 `{ holderId }`（行动者或同场角色）或 `{ locationId }`（只能是行动者所在位置），整次结果至多移动一件物品。物品必须够得着。宿主写成 `entity.upsert` 与 `entity.transferred`，和本次行动的对白、状态变化及观察原子提交；授权目击者记下新的持有者。任何一项不合法就整次结果都不提交，按作者错误处理。玩家同回合附带表达的先后提交仍见[Interaction](../architecture/interaction.md)，不因此变为一个事务。
- 物品外观对看得见它的人可见：拿着的、在你所在位置的物品，你看到当前样子；后进房间的人也能看到。“有人知道、有人不知道”的事实仍用状态和告知。
- 条件判断用第五个参数 `world.items.current`（行动者当前能确认的物品，含 kind、holderId、locationId）。条件不满足时返回 `rejectReason`。行动者在下一次调用里看到这句理由，宿主还会补上物品现状，例如“杯盖没拧紧。这次没有执行，保温杯仍在你手里。”；只补行动者本来就看得到的（在自己手里，或在自己所在位置），别人拿着时不补。理由写清现在的情况；如果暗示了办法（“得先拧好盖子”），最好真有对应的操作，否则角色会一再叙述自己解决了它再重试。
- 只给满足已声明条件的目标：`policy(known, actorId, place)` 的第三个参数是 `{ locationId, items }`，`items` 给出行动者拿着或脚下的物品现状（entityId、kind、holderId、locationId），也包括未列为操作目标的工具，例如电饭煲；不含别人手里的物品。返回值可多写 `targets: { 操作ID: [物品ID] }`，只能收窄该操作已声明的目标；空数组隐藏该操作的全部物品选项。执行时宿主用最新输入再检查，伪造或失效请求不能绕过。模板据此只对地上物品提供拿起，只对自己持有的物品提供放下／交给；官方包和晚宴包还筛选料理／修理条件。policy 没有检查的条件仍须在 resolve 中检查，不能把“出现选项”当成成功保证。
- 模板的“交给”每件物品只提供一个选项，以 `characterParameters: ['recipientId']` 和参数 schema 声明“交给谁”，不按接收者展开选项。宿主要求接收者在当前授权场景中，模板再拒绝交给自己。
- 玩家调试命令写作 `/status <操作>@<物品ID> <JSON 参数>`，例如 `/status take@entity:brass-key {}`、`/status drop@entity:brass-key {}`、`/status give@entity:brass-key {"recipientId":"character:companion"}`。须以包内实际物品和角色 ID 为准；`/take`、`/give`、`/drop` 已删除。活动 policy 与 `autonomy.json` 用 `status:take`／`status:drop`／`status:give` 等定义 ID 引用操作。
- 这取代了内置拿／放／给，以及核心里的煮饭、吃饭、修理、三种做菜；`home.ts`、`dinner.ts` 已删除。宿主基础规则只保留牵手／松手。见[晚宴规则](../../../examples/world-packs/model-girls-dinner-v2/scripts/status.js)与[分阶段设计记录](../../superpowers/specs/2026-10-22-author-item-rules-design.md)。旧版物品规则只在[测试夹具](../../../tests/fixtures/item-custody-package.ts)中保留，宿主不安装它，不能作为作者继续使用旧定义的入口。

### 作者物品规则的验证范围

以下真实模型结果沿用本次提供的验收记录；本次文档同步只核对源码和测试场景，没有运行测试或调用模型。

- **源码已接通：** 目标选项、policy 筛选、执行复查、作者 resolve、物品事件和授权观察。所有 v5 示例包的物品规则都来自各自脚本；没有据此确认发行包已重建。
- **自动测试：** 已核对[模板测试](../../../tests/host/status-market-items.test.ts)包含候选切换、参数化交给、目击者获知新持有人和伪造未提供目标被拒绝；[宿主测试](../../../tests/host/pack-status-runtime.test.ts)包含改外观时保留持有人、NPC 执行、够不着时拒绝和非法移动整次不提交。本次文档同步未运行这些测试，不报告新的通过数量。
- **此次真实模型验收：** DeepSeek 跑过《赔罪晚宴》A 路线，出现 NPC 自选做菜、修灶台被作者理由拒绝；hidden-cure-next D2 中竞争者用作者模板拿取并交出摘要，但交给的是玩家而非伊蕾，仅一次样本。这不证明接收对象选择、官方同居包新版煮饭、玩家“说加做”或长期玩法体验已验收。

### 谁怎样提出操作

- NPC：已声明且允许其执行的操作作为 `interact` 候选出现在角色 affordances 中，模型通过 perform 提出（bindingId `status`，definitionRef `status:<操作ID>`），经 Rulebook 裁定后与其他事件一起提交。被拒绝时只有该 NPC 收到带拒绝原因的执行结果，不告知任何值。叙事文本不改变任何状态。
- 玩家：每个允许的操作都出现在默认舞台和 SDK 的 view.actions 中（`kind: interact`；无物品目标时 `target.kind: self`，有物品目标时为 `item`）。有参数的操作带 `argumentSchema`，默认舞台据此生成表单：`characterParameters` 列出的参数以 `characterArguments` 进入视图，是当前场景角色下拉框，数字、布尔、枚举和字符串各有输入框；schema 里写 `title` 可替换字段名显示。例如“购买”填 20 后提交，或在“把钥匙交给”的表单中选择接收者；输入框里已有一句话时，它会和操作作为同一回合提交（见[当前 Interaction](../architecture/interaction.md)）。宿主按与 NPC 相同的规则裁定，被拒绝时提示原因且不提交。无物品目标时 `/status <操作ID> <JSON 参数>` 仍可用于创作者调试，物品目标须加 `@<物品ID>`。
- 角色上下文新增 `knownStatus`（该角色已知的值）和 `knownStatusNote` 提示。只要真实值在观察者上次确认之后被任何事件改过，这一项就立刻变成 `current: false`：观察者知道“有变化”，但不知道新值，也不知道是谁、因为什么改的。从未被告知的状态完全不出现，而不是显示为空。

### 与活动的配合

- 活动 resolve 收到第六个参数 truth（没有状态脚本时为 null），可以在返回值中附加 `status: { changes, reveals }`，与 `activity.updated` 同一次提交。告知规则与操作相同，行动者自己的变化同样自动告知。
- 状态声明加 `activities: ['duel']` 后，只有这些活动的 resolve，或在这些活动中执行的 status.js 操作才能改它；其他来源（包括每轮钩子）一旦改动它，宿主按作者错误处理（校验抛错，不是 rejectReason 式的玩法拒绝），整次结果什么都不提交。读取不受限制：战斗外仍显示“上次确认”的 HP。
- 操作加 `activities: [...]` 后，只在该活动运行且行动者是参与者时出现和可执行。活动运行期间，状态操作和其他交互一样须列入活动 policy 的 interactions（例如 `'status:drink-potion'`）。

### 每轮钩子

onRoundEnd 拿到真实值和轮次，拿不到角色上下文或模型输出；结果作为本轮最后一个 `status.updated` 提交。轮次从 1 开始，按已提交的玩家回合计算：钩子返回 null 或失败不阻止下一轮递增；同一输入的幂等重放和活动的 NPC 重试不新增轮次；快捷活动的开始与执行合算一轮；一句话连同一个行动的回合（两次提交）也只算一轮，为了之后仍能这样计数，这类回合即使钩子返回 null 或失败，也会提交一条不含任何变化的 `status.updated` 轮次记录（`source: { kind: "round", round }`），状态值不变。玩家点“静观”时也算一轮：钩子照常运行（例如游戏时间推进），这一轮总会提交一条轮次记录，并带 `source.pause: true`（钩子返回 null 或失败时同样只记录轮次、不含变化）；钩子本身不知道这一轮是静观。它没有行动者和场景，所以 reveals 只能告知被改状态的归属者本人；alwaysKnown 的状态（如游戏时间）不需要告知。不产生对白，不额外调度角色。钩子失败或超时时，本轮已提交内容保留、状态不变，错误记在宿主调试信息的 `debug.statusRoundError`，不重试。末端重新生成会连同这一轮一起重演。

### 显示、存档与上限

- 玩家：PlayerView 新增 `statusBar`，每项 `{ key, label, holderId, holderName?, value, current, self? }`，value 可为结构化 JSON，只含玩家已知值；`self: true` 按 holderId 标出玩家自己的状态。默认舞台在世界标题下按归属者分组显示，玩家自己的一组标为“你”，过期值标“上次确认”，对象和数组显示为 JSON，超过 120 个字符时截断并加“…”（SDK 中仍是完整值）。社区前端通过 SDK 读到同一字段。
- 真实值（2026-10-19）：作者给某个状态写 `playerTruth: true` 后，PlayerView 另有 `statusTruth`，每项 `{ key, label, holderId, holderName?, value, self? }`，含该状态所有归属者的当前真实值（例如怪物的真实 HP，或所有人的真实余额）。显不显示、怎样显示由前端决定，默认舞台不使用它。没有声明的状态，真实值不会发到浏览器；一旦声明，玩家用开发者工具就能看到，所以只给愿意公开的状态打开。它只进玩家视图，不进任何角色（包括 NPC）的上下文，也不改变 `statusBar` 的“已知值”语义。
- 创作者：调试接口的 `statusTruth` 显示全部真实状态值。
- 存档：状态只在世界事件里，故事节点、分叉、末端重新生成随事件一起回滚，没有独立状态文件。
- 上限：状态定义 64 个、操作 32 个，每个状态值最多 16 KiB、嵌套深度 16、4096 个值节点，每次结果 changes 和 reveals 各 64 条；状态脚本与活动脚本源码各 256 KiB（2026-10-26 由 64 KiB 放宽；与包内插件模块拼合后的状态脚本合计也不超过 256 KiB），单次调用 100 ms，输入输出各 1 MiB。角色状态会按每个包角色各建一份；所有状态值合计（含每个角色的那份）不能超过 512 KiB，超出的结果按作者错误整体拒绝、什么都不提交，以免之后每次脚本调用都因输入过长而失败。操作 ID 不能用 start、retry、suspend、resume、abandon。

### 已验证与已知限制

源码已接通默认网页宿主；自动测试覆盖拒绝不提交、同事务提交、失主拿不到新值（只看到上次确认的旧值）、上次确认与重新确认、alwaysKnown 一致、分叉与重新生成回滚、Ollama 与本地 OpenAI 两种协议下私有值不进入其他角色请求、活动范围与每轮钩子规则。[无模型离线实验](../../../tests/experiments/status-market-offline.ts)驱动集市样例的偷窃、查看钱包、购买和时间推进。2026-10-19 用 OpenCode DeepSeek 与 Core 记忆做过一次 14 轮[真实试玩](../studies/status-market-deepseek-playtest-20261019.md)：认知隔离、NPC 自选状态操作、重复领奖拦截和台词与裁定结果一致都有样本证据；但那次没有发生偷窃，失主是否会凭空编出被偷金额或嫌疑人仍未验收，并观察到明显的表现重复；发行包未重建。

有意接受的限制：

1. 角色的 knownStatus 不在过期重算（stale）的比较内容里。角色思考期间另一角色改了状态，它的台词可能提到刚变的旧值；权威事实仍一致，操作总在最新前缀上重新裁定。
2. 默认舞台的表单只覆盖常见 schema（角色、数字、布尔、枚举、字符串）；嵌套对象或数组退回为 JSON 文本框。
3. 活动运行中 `/status` 被状态规则拒绝时显示该拒绝原因；被活动 policy 或其他规则拒绝时仍只显示对应的通用提示。
4. 状态脚本不能跨场景告知（银行通知等）。角色之间的跨场景短信由包内 `communication.json` 开启，见[世界包编写](world-pack-authoring.md#5-扩展玩法和界面)；它只投递正文，不改状态。
5. `status.updated` 登记进全局事件清单，改变了所有世界的 manifest，**所有旧存档**打开时都会报错，需要新建存档；不提供迁移。
6. `current:false` 是确定性信号：真实值一变，归属者马上看到“上次确认”。对“暗中偷窃”这类玩法，目前会让失主察觉到“有变化”（不含金额和来源）；想完全隐藏就要等后续设计，现在无法由作者关闭。
7. policy 可按已知状态筛选操作，并按行动者手里／脚下物品筛选目标；当前仍不能提供“从别人手里拿走指定物品”的候选。resolve 仍须检查本次真实条件，不满足时返回 rejectReason。状态变化不会自动引出下一次变化；唯一的自动衔接是每轮至多一次的活动自动开始。也不从叙事解析状态变化。

## 4. 试玩要求

校验包后创建新实例：检查开始条件、每个操作的合法/非法参数、轮转、结束、模型失败后的重试与逃生。分别让参与者知道不同秘密，检查角色上下文、结果描述和公开页面是否泄漏。再保存完整节点、改变状态并分叉，确认活动与状态回到节点时刻。

自动化结构检查不证明自然度，也不能证明自由文本永不违背裁定。遇到玩法需求超出现有宿主支持，先记录具体体验缺口，不把任意新 JSON 字段当成已实现规则。

## 5. 序章和条件生活事件

[官方序章脚本](../../../examples/world-packs/model-girls-official/scripts/activity.js) 是新增能力的完整示例：

- initialize 的 `world` 为玩家当前授权场景；`previous` 为上次活动的玩家视图，用于继续已有序章或进入生活菜单。
- resolve 的第五参数 `world` 为操作主体当前授权事实，包含 locationId、characterIds 与 items.current / lastObserved。lastObserved 仅是目击记录，不能当作当前归属。
- resolve 返回 `playerExpression: { text }` 可在明确玩家选择的操作中同步提交公开玩家表达；不能用于 NPC 代替玩家行动。普通活动仍可只返回 game、description、audience。
- 也可返回 `playerExpression: { narration }`，以玩家名下的旁白提交，例如赔罪晚宴的“过了 5 分钟，墙上的钟指向 16:05。”，不替玩家说台词。在场角色照常观察到它。
- 操作定义可加 `quick: true`。例如晚宴时钟的“等 5 分钟”直接出现在玩家行动菜单里，点一下即可：宿主先开始活动，再执行该操作，分成两次普通提交；开始不计入自主触发，操作照常计入。玩家只做了一个动作，所以这次开始不写开场行（2026-10-25 起），记录里只出现操作本身的结果，例如“时间流逝，来到了午后”，不再多一条“〈标题〉开始。”。声明了快捷操作的活动不再显示“开始”入口。仅适用于只有玩家参与、没有参与者选择、操作没有参数的活动；操作仍须被开始后的 policy 允许，否则拒绝并保留已开始的活动，玩家可在卡片里关闭。
- resolve 返回 `{ rejectReason: "条件说明" }` 会拒绝操作且不提交；不能与成功字段混用。
- 可选 onPublished(state, actorId, expression) 返回 game 或 null。角色发表和游标推进同事务，不要在先前操作中提前跳过尚未发表的台词。

公共 SDK 的 view.activity 只包含 title、active、phase、public。无额外参数的活动操作及绑定当前版本的开始／恢复节点选项进入 view.actions，可用普通 perform；不能伪造参数、读取 internal/private 或调用任意管理脚本。有额外输入参数的活动操作仍用宿主表单，退出、逃生和管理功能仍在宿主。

快进和跳过须逐项执行同一正式路径，只压缩展示时间，不能省略角色经历。完整无角色模型序章实验：`node --import tsx tests/experiments/official-prologue-offline.ts`，新建独立 .tmp 数据，检查 112 条表达、5 条玩家输入、最后收留问题和自由交接。此实验不证明后续真实模型或长期记忆体验。
