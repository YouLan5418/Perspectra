# 用包内规则扩展玩法

## B7 显式组合与共同脚本（源码）

列入 assetFiles 只说明它是资产，不会自动启用玩法。添加或删除玩法时同步修改 worldpack.source.json 的 plugins；无需填满 services。

| 内容 | plugins 声明 |
| --- | --- |
| rpg.json | official-rpg 与 official-dice |
| trpg.json | official-trpg 与 official-dice |
| autonomy.json | official-autonomy |
| communication.json | official-communication |
| scripts/pacing.js | official-pacing |
| 旧 status.js、plugins.json、活动脚本 | pack-scripts；使用骰子再加 official-dice |

例如增加 "plugins": { "official-rpg": {}, "official-dice": {} }。精确版本和配置路径可写成 "official-rpg": { "version": "1", "config": "configs/rpg.json" }，config 路径也要列入 assetFiles。configSchema 公开结构，validateConfig 检查实体引用及跨字段条件，错误会阻止开档。

新玩法可声明 "scripts": { "gameplay": { "entry": "scripts/gameplay.cjs", "config": { "energy": 1 } } }。自包含脚本以 module.exports 导出 SDK 的 ContentGameplay；状态、操作、用途、参数 Schema 与结果投影和原生定义相同。entry 列入 assetFiles，不自动扫描未声明脚本。源码单文件示例在 examples/gameplay/investigation.cjs，默认控件与面板接入留 B8。

services 只在确实要求特定 Provider 时填写，如 "services": { "scheduler": "my-grid-scheduler" }；冲突会中止启动。LLM 通道、记忆实现和凭据通常交玩家管理。

静态 CLI／Launcher 预检不启动 Provider，遇到 services 时明确报告尚待宿主选型校验（CLI 为 runtimeValidation: pending-host-selection），不把静态合法当作运行环境已满足。正式开档按实际所选 Provider ID 校验，包括默认 LLM 入口。

共同脚本仅支持同步定义与有限 JSON 数据：不支持 async／await、动态 import、Promise、WebAssembly、Atomics 或异步内置 API，不提供时钟和未记录随机。函数留在 VM 中，每次调用上限 100 ms；脚本及单次跨界数据上限 1 MiB。配置文件读取上限也统一为 1 MiB；TRPG 加入玩家及名称后的活动配置另限 256 KiB，纯校验与正式开档一致。需要外部资源的实现使用已被用户信任的原生插件。

第三方生成器默认把原始配置交给共同定义；若生成器已在闭包内展开配置，可返回 gameplayConfig 显式指定定义收到的配置（官方 RPG／TRPG 使用空对象）。正式打开与读档预检遵循同一规则。

原生插件须先安装并允许执行，包只能选择已有插件。第三方导出 packPlugin 供纯校验；源码 CLI validate／compile／test 可追加 --plugins settings.json。这里描述源码能力，不代表旧发行版支持。


2026-11-05 M6 源码契约：内部机制使用 Cordis，普通世界包继续使用下列 JSON／脚本 hook，不导入原生 plugin-sdk 或宿主私有代码。scripts/status.js、plugins.json、活动、知识、通信和自主的作者格式保持；核心复核权限、重要状态和提交。此条只说明当前源码层次，不扩大下文既有程序版本与真实体验的验收范围。

例如同行者想把钥匙交给玩家：对白可以表达意愿，物品归属必须由规则裁定。只在这件物品确实影响玩法时登记它；普通目光、姿态和语气不用增加状态键。

## 物品操作

1. 在 entities.json 添加物品，例如 `{ "entityId": "entity:key", "name": "钥匙", "kind": "key", "locationId": "location:start" }`。
2. 将本 Skill 的 `assets/status-items.js` 复制为作品的 `scripts/status.js`，把顶部 ITEM_RULES 中需要允许的 take/drop/give 数组改成该物品 ID。
3. 在 worldpack.source.json 的 assetFiles 加 `scripts/status.js`，用目标 CLI 校验，再载入新实例。

模板定义的是作者可修改的 `status:take`、`status:drop`、`status:give`。policy 按行动者知道的当前物品筛选选项；resolve 在执行前重查，宿主继续检查可达、去向和单一持有者，再提交物品事件。不要恢复已删除的 `base:take/drop/give`，也不要让普通状态值保存第二份物品归属。

模板操作分别有固定参数 schema；give 的 `recipientId` 通过 characterParameters 声明为角色参数，目标物品由选项绑定，resolve 第六参数接收 targetId。扩展烹饪／修理等操作时自行声明参数与规则，正确返回拒绝原因或经过裁定的结果，不能仅凭叙述完成动作。

## 常驻客观状态

金钱、HP、游戏时间或明确追踪的任务可以使用同一 `scripts/status.js`。它定义 `globalThis.statusScript`：

- definition.statuses 每项 `{ key, label, type, owner, schema?, alwaysKnown?, playerTruth?, bar?, activities? }`，最多 64 项。type 为 number/string/boolean/object/array/null，object 和 array 必须带同类型 JSON Schema；owner 为 public（全世界一份）或 character（每个角色一份，含玩家）。`bar: true` 钉到玩家状态栏，建议 2–4 项；`activities: ['标识']` 限定只有这些活动能改它。
- definition.operations 每项 `{ id, label, schema, targets?, characterParameters?, actors?, activities? }`，最多 32 项；schema 是封闭对象。targets 列出作用的物品，label 可写 `{item}` 替换成物品名；actors 为 player/npc/any。
- initialize(characterIds) 返回 `{ public, characters, reveals? }`，恰好包含声明的状态，characters 列出全部角色。角色私有状态默认告知本人，公共状态除非 alwaysKnown 否则谁也不知道。
- policy(known, actorId, place) 可选，返回 `{ operations: [...], targets?: { 操作ID: [物品ID] } }`；known 是 `{ public, self, characters }` 已知值，place 是 `{ locationId, items }`。选项可见不代表执行必定成功。
- 活动的 autoStart 可返回可选 `sceneNotice`（1–500 字），写给在场所有人；`notice` 只给玩家。不写时其他角色不知道事件内容，只知道活动开始了。
- resolve(truth, actorId, operationId, parameters, world, targetId) 重查规则；返回 `{ changes, reveals, description, audience, items?, sceneReaction? }`，或仅返回 `{ rejectReason }`。audience 为 'self'、'scene' 或 `{ characters: [...] }`；行动者总能收到自己的结果，所以空列表等于 'self'，列出别人时行动者也会收到。
- 玩家状态操作获准提交时可在该次结果上返回 `sceneReaction: false`。宿主照常提交状态、按 `audience` 投递描述，并保留在获准角色的经历里。官方调度器不会仅因这条观察安排即时同场回应。同一输入里的发言、其他操作和作者另行安排的自主机会仍按原规则处理。省略字段沿用原行为。
- onRoundEnd(truth, round) 可选，每个玩家回合结束后调用一次，返回 null 或 `{ changes, reveals }`，适合推进游戏时间。

changes 是 `{ holderId, key, value }`，整体替换该键（公共状态 holderId 为 null）；reveals 只写 observerId/holderId/key，值由宿主填入，作者无法告知编造的值。行动者改了自己的状态会自动知道新值；别人引起的变化（比如被偷）不会自动告知失主，失主只看到该值变成“上次确认”。余额不足、偷窃被发现这类玩法失败应作为被接受的结果返回，带上 reveals 和 description；rejectReason 只用于操作根本不成立。仅将明确公开的值设 alwaysKnown；playerTruth 是主动交给玩家前端的真值，不会自动公开给 NPC。所有脚本均为作者可信代码，不应访问凭证或复制宿主内部实现。

## 活动

有局部回合、参与者或胜负的小游戏才用活动：单场写 `scripts/activity.js`，多场写 `scripts/activities/<标识>.js`，都登记进 assetFiles。多场各自保留进度，一次只运行一场，玩家可以暂停一场去玩另一场。脚本定义 `globalThis.activityScript`：

- definition：`{ title, npcIds | participants, operations, opening? }`。npcIds 固定参与者；`participants: { mode: 'player-select', min, max, candidates? }` 让玩家选人（1–8 个 NPC）。operations 每项 `{ id, label, requiresTurn, schema, quick? }`，最多 16 项；start、retry、suspend、resume、abandon 为保留名。opening 是 1–500 字的玩家开场文案。
- initialize、policy、resolve：生成初始状态、限定当前角色可用的操作、同步裁定操作。resolve 也可以附带状态变化，或返回 `playerExpression: { text }`／`{ narration }` 在玩家明确选择的操作中提交公开发言或旁白。
- schedule / onOutcome：等待，或给一个已声明角色一次处理机会；它们收到完整活动状态（含 internal 和所有人的 private），输出只有这一次激活，不进入任何视图。
- 包内活动脚本可声明同步纯函数 `canStart(world): boolean`。它只读玩家视角，供入口展示和提交时复核。只声明它不会自动开始；同时声明 autoStart 时，自动开始还须获得提名。返回 false 时不公开原因。
- 可选：autoStart(truth, world, previous) 在玩家回合结束时按 `when` 全部为真自动开始（每项是布尔值，或 `[标签, 布尔值]`，如 `['时段是深夜', truth?.public?.slot === '深夜']`；标签 1–80 字符，只给包透视显示条件名，不影响判定，建议都写），没有单独声明资格时，手动开始沿用同一组条件；`quick: true` 让仅有玩家、无参数的操作一键开始并执行；simulate 返回固定演出替代一次模型响应；resume 检查暂停后能否继续。

可见范围：public 是参与者共享，不是全世界公开；private 每人只拿到自己的一份，玩家那份会显示在玩家的活动卡片上；internal 不进任何角色视图。active、phase、turn、round 每个参与者都看得到，所以隐藏回合（比如夜里轮到谁）不能写在 turn 里：公开 turn 停在一个不变的中性值，真实行动者记在 internal，并在本人 private 里标“轮到你”，相关操作 `requiresTurn: false`，resolve 自己核对，schedule 读 internal 叫醒对的人。这样做只让其他角色不知道轮到谁；默认舞台只显示“正在回复”，但公共 PlayerView 的 `responders` 仍列出正在处理的角色，活动 revision 也随夜间操作增加，所以不要对玩家宣称接口层面已隐藏。活动不能移动角色、不会自动暂停正在运行的活动，也不替角色决定是否接受邀请或怎样行动。

细节以目标程序附带的同版本说明或可运行源包为准；字段对不上时用 Launcher 新实例实际加载检查，不猜字段声称已接通。

## 剧情节奏

想控制事件疏密、让小事随时发生时，写 `scripts/pacing.js` 并登记进 assetFiles，定义 `globalThis.pacingScript = { definition, beats }`。definition 含 cycleRounds、chance、cooldownRounds（low/medium/high）、recoveryRounds，可选 repeatAfterRounds、stagnation、activities、beats；每个活动或节拍写 `{ intensity, repeatAfterRounds? }`。可重复的节拍一定要设再次间隔，否则同一件事会反复出现，角色的回应也会越来越像念台词。未列入 activities 的活动照旧按 autoStart 发生并优先，序章和结局不要交给节奏。一轮最多发生一件事，手动开始不受冷却限制。

节拍 `{ when(truth, world), apply(truth, world) }`：when 的格式同 autoStart 的条件，不要用随机；apply 返回 changes、reveals、notice（给玩家）、sceneNotice（给在场的人）、stimuli（只给被点名的角色）。world 比玩家视角多一张 places（每个角色的位置）。写了节拍的包必须有状态声明。节拍不能移动角色或物品。

stimuli 每条 `{ characterId, kind: 'perception' | 'thought', text }`，最多 8 条，每条 1–500 字，对象不能是玩家。只写她察觉到什么、想起什么，不写她该怎么做：“你看见门缝里那张催租单”，不要写“请主动向屋主提起房租”。程序不判断文字是不是指令，写成指令角色就会照本宣科。文字不证明状态变化，要改数值写进 changes。察觉要和她的位置相符，用 world.places 判断她在不在场，否则她会记住没发生过的事。

推演结果每步带 `pacing`，`reason.why` 说明这轮为什么发生或没发生。完整说明见当前源码的 docs/current/guides/story-pacing.md。

## 角色自主与短信

玩家不在身边时，可以让角色自己决定要不要行动。在 assetFiles 登记 `autonomy.json`：

```json
{
  "characters": [{
    "characterId": "character:friend",
    "triggers": [{ "actionType": "move" }, { "actionType": "interact", "definitionId": "status:take" }],
    "everyPlayerTurns": 2,
    "opportunities": 1,
    "interactions": ["status:take"],
    "locationIds": ["location:front-room", "location:back-room"],
    "targetIds": ["entity:key"]
  }]
}
```

它只给处理机会：每隔几个玩家回合、在哪些地点、可用哪些操作；不规定角色做什么，也不把别处的对话传给他。

计数只认 triggers 列出的玩家行为，再加上玩家静观；其他说话、移动或失败的行动不计数。玩家完成一次匹配的行为就加一，满 `everyPlayerTurns` 次给她 `opportunities` 次机会。同一次玩家行动即使匹配多个条件也只算一次。

某个条件想单独计，就在这一条里写自己的 `everyPlayerTurns`（1–100）：

```json
"triggers": [
  { "actionType": "interact", "definitionId": "status:work" },
  { "actionType": "move", "everyPlayerTurns": 3 }
],
"everyPlayerTurns": 1
```

上例中打工每次都给机会，移动每 3 次才给一次；移动不混进打工的计数。没写自己间隔的条件和静观共用角色的 `everyPlayerTurns`。改完用 `lens view` 或包透视核对，角色卡会写成“玩家每完成 1 次下列行为，给她 1 次主动机会：……、移动到别处（每 3 次单独计）；玩家静观也算一次”。

跨场景短信（实验）在 assetFiles 登记 `communication.json`：`{ "medium": "短信", "contacts": { "character:player": ["character:a"], "character:a": ["character:player"] } }`。联系人是有向许可，不等于在场；收信人只知道对方这样说，不获得对方房间的视野。想让角色自主时也能发，在 autonomy 的 interactions 加 `experiment:message`。电话尚未接入。

## 插件、预设和界面

`plugins.json` + `plugins/*.js` 是包内插件模块，可以声明需要玩家在 Launcher 启用的本地 Cordis 能力；必需能力缺失时世界打不开并写明缺少什么，可选能力缺失时只隐藏相应操作。包不能自动安装原生代码，用户没要求时不引入。

model-preset.json、role-presets.json 和 frontend/ 是宿主独立读取的扩展；CLI 编译不等于它们已有效。默认沿用官方舞台；只想换风格时在 frontend/ 放 theme.css（从本 Skill 的 `assets/theme.css` 复制，模板逐项标注了每个变量和区域选择器的作用）、portraits/、backgrounds/ 和 stage.json（取景、表情差分、姿势），立绘和背景按 ID 去掉前缀命名，例如 `character:companion` → `portraits/companion.png`。确需整页界面时仅使用公共玩家数据，静态前端不得含角色秘密或 Key。不把模型预设当作规则或权限的替代品。

验收至少覆盖：正确条件下出现选项、条件失效时被拒绝、成功后状态与观察一致、未授权角色没有获得秘密。数据库一致与叙事一致分别检查；未调用真实模型时不能宣布后者通过。

## 包透视与推演脚本

作者想看清包、核对改动或让你“按清单改”时，用 `worldpack.cmd lens`（源码环境用 `node --import tsx apps/host/src/lens/cli.ts`），三条命令都只读：

- `lens view <源目录>`：输出透视结果和相对作者“已看过”基准的改动；
- `lens requests <源目录>`：输出作者待改清单里未关闭的条目（含位置和当时的值）；
- `lens simulate <源目录> <脚本.json>`：用真实宿主运行时加桩模型跑推演脚本。脚本名可写路径，或 `.perspectra-lens/scenarios/` 下的文件名。
- `lens serve <源目录> [--no-open]`：为作者打开透视网页，方便和你的窗口并排看。这条命令会一直运行，先输出一行含 `url` 的 JSON，要放在后台运行；改完包不用重开，页面会提示“包有改动”。页面地址含令牌，只交给作者，不写进交付文档或包里。

推演脚本是 JSON，字段只有这些，写错的字段会报出路径：

~~~json
{
  "title": "傍晚厨房",
  "start": {
    "status": { "public": { "slot": "傍晚" } },
    "scenes": { "character:player": "scene:living-room", "character:deepseek": "scene:kitchen" },
    "skipAutoStart": ["prologue"]
  },
  "npcPlans": {
    "character:deepseek": [
      { "kind": "say", "text": "你怎么来了？" },
      { "kind": "perform", "interact": "status:take", "target": "entity:key" }
    ]
  },
  "steps": [
    { "move": "location:kitchen", "expect": { "started": "midnight-fridge" } },
    { "interact": "status:take", "target": "entity:key", "expect": { "status": { "slot": "傍晚" } } },
    { "activity": "midnight-fridge", "operation": "<活动操作ID>", "parameters": {} },
    { "say": "早上好" },
    { "wait": true }
  ]
}
~~~

- `start` 是另一种开场：`status` 覆盖状态初始值（`public` 与按角色的 `characters`），`scenes` 指定角色（含玩家）在哪个场景，`skipAutoStart` 列出这次不自动开始的活动标识。未知角色、场景会直接报错。
- `npcPlans` 按角色列出她每次获得机会时依次做什么：`{ kind: 'abstain' }`、`{ kind: 'say', text }`，或 `perform` 行动。`perform` 和玩家步骤写法相同：`{ kind: 'perform', move: '地点ID' }`，或 `{ kind: 'perform', interact: '定义ID', target: '目标ID' }`（可加 `arguments`，它补在选项自带的参数上，例如主持人接受邀请写 `{ "kind": "perform", "interact": "activity:respond", "arguments": { "accept": true } }`，活动这一轮的标识由选项带上）；页面复制出的 `{ kind: 'perform', action }` 也可以用。计划用完或没写的角色弃权。
- 一个角色一次机会里能做的受控行动有上限：行动之后的跟进机会，有时只能说话或弃权。这时计划里的下一个行动不会被扔掉，而是留到她下一次机会，并在这一步记一条 `plan` 行说明原因。例如小林计划“拿蛋糕、吃蛋糕”，如果拿完后的跟进机会不能行动，“吃蛋糕”会在她下一次机会执行，也就是通常在下一个玩家回合。计划行动当前不可用（地点不可去、交互不在她的选项里）时，同样记一条 `plan` 行，列出她此刻可用的选项，然后弃权。
- 结果顶层的 `passed` 为 `false`，表示有一步报错或有期望没满足，这时命令退出码为 2（结果仍在 stdout）；退出码 1 才是命令本身失败（stderr）。`unusedNpcPlans` 列出推演结束时每个角色还剩几条计划没用上，通常说明她没有得到你以为的那次机会。
- 每个 step 恰好写一种行动：`say`、`move`（地点 ID）、`interact`（定义 ID，同一交互有多个目标时必须加 `target`，可加 `arguments`）、`activity`（活动标识加 `operation`，可加 `parameters`）、`wait: true`。行动按名字对照当前实际可用的选项，匹配不上时这一步报错并列出可用项，后面的步骤不再执行。
- `expect` 可写 `started`（活动开始了）、`notStarted`、`status`（公共状态写 `"slot"`，角色自己的状态写 `"character:deepseek.mood-note"`），以及 `knows` / `doesNotKnow`：按角色写一句或几句话，检查她到目前为止收到的观察里有没有包含这句话的。例如 `"knows": { "character:ajie": "吃得一干二净" }, "doesNotKnow": { "character:player": "吃得一干二净" }`。
- 每一步的 `perceived` 按角色（含玩家）列出这一步进入她授权视图的观察，就是她的模型实际看到的那份；空列表表示这一步什么也没收到。用它核对信息差：谁在场看见了、谁只看见有人离开、谁什么也不知道。
- `knows` 只查观察，不查世界知识文档、记忆和人设；“她知道”的意思是她收到过包含这句话的观察，不代表模型一定会用上它。

推演只证明规则与触发，不判断角色演得好不好；这些仍要真实模型试玩。写好的脚本可存进作者包的 `.perspectra-lens/scenarios/`，编译只读取清单列出的文件，不会读它。
