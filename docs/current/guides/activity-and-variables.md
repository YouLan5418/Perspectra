# 创作者：活动与包变量

当前玩法桥由实验宿主加载可信本地脚本。先复制 [launcher-demo](../../../examples/world-packs/launcher-demo) 或 [主持猜数字示例](../../../examples/world-packs/ai-girls-hosted-guess)，逐步修改并真实试玩。完整运行时边界见 [创作者运行时](../architecture/creator-runtime.md)。

## 1. 文件和信任范围

`worldpack.source.json` 的 assetFiles 必须登记 `scripts/activity.js`、`scripts/variables.js` 或独立活动 `scripts/activities/<标识>.js`；仅把脚本放进目录不代表启用。独立活动标识为小写字母开头、后接小写字母／数字／连字符，最长 41 字符。固定入口的标识是 default，不能再登记同名独立活动。加载时核对编译资产内容和包内路径。脚本使用同步 JSON 输入/输出，执行时间和数据大小有界，不能把异步模型调用或任意数据库对象当成参数。

**这是可信作者的后端扩展，不是不可信脚本安全沙箱。** 浏览器社区前端的 iframe 与授权只约束前端，不为整个恶意游戏包提供安全保证。只加载可信来源的后端脚本，不放模型密钥或私有运行日志。

## 2. 活动生命周期

固定入口为 `globalThis.activityScript`。定义和 hook 的完整形式以 [演示脚本](../../../examples/world-packs/launcher-demo/scripts/activity.js) 与 [当前活动桥](../../../tests/experiments/pack-activity.ts) 为准。

| 部分 | 职责 |
| --- | --- |
| definition | title、operations，以及固定 npcIds 或动态 participants；声明操作 ID、标签、是否消耗回合及参数 schema |
| initialize | 根据宿主提供的玩家和 NPC 身份生成初始状态 |
| policy | 限定当前角色可用的发言、叙事、移动、交互和活动操作 |
| resolve | 对操作参数同步裁定，返回新状态和结果描述 |
| schedule / onOutcome | 等待，或给已声明角色一次处理机会；不直接发布或执行角色输出 |
| simulate（可选） | 为当前角色返回与模型相同格式的决策，或返回 null 继续调用模型 |
| resume（可选） | 依据玩家自己的候选恢复视图和当前授权 world 检查继续条件；null 接受，`{ rejectReason: "原因" }` 拒绝 |

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

状态分为：

| 字段 | 可见范围 |
| --- | --- |
| public | 活动参与者共同可见 |
| private | 只交付对应角色的部分 |
| internal | 程序内部裁定材料，不进入角色视图 |
| active / phase / turn / round | 活动控制状态，按当前脚本契约生成 |

猜数字的答案可以留在 internal，若主持角色需要知道答案则写进该角色 private。不要先把秘密写进 public，再试图用结果收件人 self 补救；操作 description 也应检查是否泄密。

Activity 收紧局部玩法许可；默认由模型决定扮演内容，作者也可显式提供局部固定演出输出。活动状态沿 activity.updated 提交；位置和物品仍走已有规则路径。宿主限定角色调用次数和链路耗时；耗尽或失败保留已提交结果，玩家可重试或逃生，未提交机会不保证精确恢复。

宿主提供开始、退出与恢复控制；公共前端也可使用当前版本绑定的开始／恢复选项及无需额外参数的活动选项。SDK 不提供活动管理私有接口，不能直接读内部答案或执行后台脚本。

### 可选固定演出输出

可信作者可实现同步 `simulate(request)`。宿主仍按 schedule 激活已声明 NPC，构建该角色的授权 Context、Memory 与包变量并准备预设，随后以脚本返回值替代一次模型响应。脚本只收到当前角色的 request（context、continuation、canPerform、canRecall，以及已有的执行结果或 recallEvidence）；不收到完整活动状态、其他角色 private、internal、凭证或数据库句柄。没有 hook 或明确返回 `null` 时调用真实模型；返回 `abstain` 表示角色弃权，不等于使用模型。hook 每次在新脚本上下文中执行，不依靠脚本全局变量保存进度。

返回值继续经过现有预设输出处理、严格决策格式校验、活动许可、世界高水位检查、Rulebook、原子事件提交与观察分发；共享原有激活、动作与耗时预算。`perform` 不得混入对白；行动提交后的下一次 request 会带实际 result，作者须依据成功或拒绝选择后续 `publish` 或 `abstain`。格式错误沿用有界格式修正，使用同一个模拟响应再次校验，不自动切换到模型；脚本失败或超时也不回退到模型。模拟响应不会计作实际 provider 调用。

正常活动结束操作的最后一次续写也支持模拟，其身份来自已有执行结果元数据；后续普通互动恢复模型。结束后已解除活动许可，最后续写和普通模型一样采用正常角色表达权限。退出或逃生不触发额外固定演出。开启 Core 记忆整理、模型预设处理或实验发布复核时，那些独立模型任务仍按原机制运行；已有发布复核的角色修正请求也会再次选择 simulate 或模型响应；simulate 只替换当前角色的决策响应，不是全宿主断网开关。

示例：[雨夜来信](../../../examples/world-packs/scripted-performance/scripts/activity.js)。开场两名角色依次通过 `perform → 实际结果 → publish` 演出，等待玩家 `choose` 的 hear / leave 选择，再播放对应结尾。阶段保存在已有活动状态中；本次链路失败不继续调度下一名角色，不新增协议或演出状态机。自由对白不被自动解析为分支选择，需要执行已声明的 choose 操作。

独立无模型实验：`node --import tsx tests/experiments/scripted-performance.ts`。默认创建新的 `.tmp/scripted-performance-<时间戳>` 数据目录，保存两个分支的转录、事件和 summary；模型地址故意不可用，任何误调用都会导致实验失败。人工试玩可将 `examples/world-packs/scripted-performance` 作为源包导入并创建新实例，开始活动，选择回应后恢复自由互动。

## 3. 包变量

固定入口为 `globalThis.packScript`，提供 initialize、getVariables、applyPatch。参照 [演示变量脚本](../../../examples/world-packs/launcher-demo/scripts/variables.js) 与 [变量桥](../../../tests/experiments/pack-variables.ts)。

initialize 为各角色返回 public 和 private；所有角色初始化出的公共部分须一致。getVariables / applyPatch 接收公共值及当前角色自己的私有值，不能通过普通变量接口读取别人的 private。

变量适合玩法明确维护的计数、标签和角色私有值。脚本的补丁规则由示例实现：演示允许对已声明路径做 test / replace，不支持任意新增字段。不要假定所有作者脚本都有同一套补丁语义，更不要用变量冒充已经裁定的移动或物品转移。

变量保存在实例 `pack-variables.json`，绑定当前包内容。它是现有独立文件，不是 World Event Log 的通用事实事务；完整节点保存会一并保留变量。当前公共玩家 SDK 没有任意变量读写接口，不能把调试接口当成创作者前端 API。

## 4. 试玩要求

校验包后创建新实例：检查开始条件、每个操作的合法/非法参数、轮转、结束、模型失败后的重试与逃生。分别让参与者知道不同秘密，检查角色上下文、结果描述和公开页面是否泄漏。再保存完整节点、改变状态并分叉，确认活动与变量回到节点时刻。

自动化结构检查不证明自然度，也不能证明自由文本永不违背裁定。遇到玩法需求超出现有宿主支持，先记录具体体验缺口，不把任意新 JSON 字段当成已实现规则。

## 5. 序章和条件生活事件

[官方序章脚本](../../../examples/world-packs/model-girls-official/scripts/activity.js) 是新增能力的完整示例：

- initialize 的 `world` 为玩家当前授权场景；`previous` 为上次活动的玩家视图，用于继续已有序章或进入生活菜单。
- resolve 的第五参数 `world` 为操作主体当前授权事实，包含 locationId、characterIds 与 items.current / lastObserved。lastObserved 仅是目击记录，不能当作当前归属。
- resolve 返回 `playerExpression: { text }` 可在明确玩家选择的操作中同步提交公开玩家表达；不能用于 NPC 代替玩家行动。普通活动仍可只返回 game、description、audience。
- resolve 返回 `{ rejectReason: "条件说明" }` 会拒绝操作且不提交；不能与成功字段混用。
- 可选 onPublished(state, actorId, expression) 返回 game 或 null。角色发表和游标推进同事务，不要在先前操作中提前跳过尚未发表的台词。

公共 SDK 的 view.activity 只包含 title、active、phase、public。无额外参数的活动操作及绑定当前版本的开始／恢复节点选项进入 view.actions，可用普通 perform；不能伪造参数、读取 internal/private 或调用任意管理脚本。有额外输入参数的活动操作仍用宿主表单，退出、逃生和管理功能仍在宿主。

快进和跳过须逐项执行同一正式路径，只压缩展示时间，不能省略角色经历。完整无角色模型序章实验：`node --import tsx tests/experiments/official-demo.ts`，新建独立 .tmp 数据，检查 112 条表达、5 条玩家输入、最后收留问题和自由交接。此实验不证明后续真实模型或长期记忆体验。
