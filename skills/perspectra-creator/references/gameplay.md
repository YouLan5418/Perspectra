# 用包内规则扩展玩法

## 遭遇与委托表

玩家在门廊查看差事。潮位达到 3 时可以抽到「代投便笺」，亲自听过交班铃后可以交付，领取 7 枚邮戳。潮位、更次、邮戳及交班铃都是这部作品自己定义的内容，另一个包可选完全不同的变量和事件。

直接写 v5 源包时，把配置文件列入 `worldpack.source.json` 的 `assetFiles`，并在已有 `plugins` 中声明 `"official-dice":{"config":"gameplay-tables.json"}`。已给骰子配置文件的包就在该文件中加 `tables`。例如，包内已启用的 `scripts/status.js` 定义了始终公开的数字变量 `tide`、`watch` 和 `stamps`，世界事件定义了 `bell`，可以写：

```json
{
  "tables": [{
    "key": "porch", "title": "门廊差事", "clockKey": "watch",
    "rows": [
      {
        "key": "letter", "kind": "quest", "title": "代投便笺", "location": "location:start",
        "conditions": [{"key":"tide","op":"gte","value":3}],
        "weight": 1, "limit": 2, "duration": 2, "completeEvent": "bell",
        "rewardKey": "stamps", "reward": 7
      },
      {"key":"cat","kind":"encounter","title":"送信猫","weight":3,"text":"一只猫从台阶下探出头来。"}
    ]
  }]
}
```

- 表必填 `key`、`title`、非空 `rows`。候选必填 `key`、`title`、`kind`。其余字段按需填写。表键和行键分别在自己的范围内唯一，以小写字母开头，可用小写字母、数字和连字符，最长 33 个字符。
- `conditions` 中所有条件都满足才入选。字符串、枚举和布尔值支持 `eq`、`ne`，数值还支持 `gt`、`gte`、`lt`、`lte`。变量取自包的基础状态脚本，须始终公开、无地点和活动范围。枚举从变量定义中选；数值和布尔按 JSON 原类型填写。时段、天气、季节或潮位均可由作者自行建模。
- `location` 选包内地点。`event` 要求玩家曾经见证指定世界事件。`completeEvent` 用同一规则判断委托能否交付。节拍事件先加入包的节奏表，再在候选上引用。该引用只检查玩家实际收到的观察。抽表的时机是玩家操作原生活动 `table-<表键>` 中的「抽取候选」。
- `weight` 默认 1，合格行按权重抽一次。上例两行都合格时概率为 1/4 和 3/4。权重是正整数，单表总权重最多 1000。`limit` 按抽中次数累计，放弃、离开或重进都保留已用次数。
- 遭遇抽中即结算，委托要先接受再交付。每张表同一时间可保留一个待接受或已接受的委托。`duration` 表示从接受那一刻起，作者指定的整数计时变量 `clockKey` 可以再前进多少。更次为 3 时接取、期限为 2，最迟更次 5 可以交付，到了 6 可放弃。奖励同时填 `rewardKey` 和正整数 `reward`，指定可写的公共数值变量。物品转移或复杂结算走作品的活动裁定脚本。

编辑器入口为「活动与规则 → 遭遇与委托表」。外部 agent 用 `worldpack editor tables <包目录>` 获取基础配置和引用目录，`tables-save <包目录> <请求.json>` 提交 `{"base":读取时的base,"tables":[...]}`。编辑器保存到 `creator-tables.json` 草稿；`worldpack editor export <包目录> <新目录>` 会一并生成可玩的规则与表，随后对导出目录运行 `worldpack validate`。

用 `worldpack editor tables-preview <包目录> <请求.json>` 预览。上例可传 `{"key":"porch","location":"location:start","values":{"tide":3,"watch":2},"counts":{"letter":0},"events":[]}`。也可把完整未保存的表放在 `table` 字段中。返回每行匹配项、排除原因与有效总权重；预览不会掷骰或消耗次数。验收时分别降低一次潮位、用尽一次出现次数，再在正式活动中跨两次进入完成交付，核对邮戳只发一次。

## 在柜台连续办事和交谈

连续寄养时，每次 `resolve` 提交一份名册变更。用 `npc.projectResult` 为实际经手的角色投影回执，`npc.formatResult` 写出个体名、编号和游戏内领取时间。这样即使柜员当时没有开口，玩家随后问“第一只什么时候领”，她也能按自己收到的记录回答。敏感结果只向获准的角色投影。

在 `worldpack.source.json` 的 `scripts.gameplay.responders` 按操作 ID 配置玩家单独执行后的回应机会。例如 `{"clinic:admit":[],"shop:order":["character:clerk"]}` 表示寄养只显示回执，下单时可由观察到此事的柜员回应。省略某个操作沿用场景调度。玩家另行开口或同时说话并行动时，仍走发言规则。编辑器的「日常交互」可选角色，CLI 的 `interaction-script-save` 可随草稿传同一张 `responders` 表，`validate` 会检查操作和角色引用。

## 用编辑器 CLI 配置自主机会

用 `worldpack editor autonomy <pack>` 读取当前配置、字段声明和活动操作目录，用 `autonomy-enable` 启用空角色列表。添加 NPC 后，用 `mode-candidates` 携带 `{"mode":"autonomy","path":["characters","0","triggers","0","operation"],"config":...}` 获取所选活动的操作。用 `autonomy-save` 带回 `file`、原 `base`、完整新 `config`。活动触发同时引用活动键和操作键。列出角色可尝试的交互和地点，台词和行动由角色决定。

## 用编辑器 CLI 配置联系人

用 `worldpack editor communication <pack>` 读取名单与媒介，`communication-enable <pack> <request.json>`（请求为 `{}`）启用空名单或接入已有文件。`mode-candidates` 的请求如 `{"mode":"communication","path":["contacts","character:player"]}`。`communication-save` 提交读取时的 `file`、原配置 `base` 和新 `config`。在 `contacts` 中将玩家映射到阿林只授权玩家联系阿林。两人都能主动联系时分别填写两个方向。


## B7 显式组合与共同脚本（源码）

写全新的玩法或查可用的 SDK，读[玩法插件与 SDK](gameplay-plugins.md)。附带的搜证示例可以随作品运行，也可以由本机原生插件注册，供多个包选用。

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

新玩法可声明 "scripts": { "gameplay": { "entry": "scripts/gameplay.cjs", "config": { "energy": 1 } } }。自包含脚本以 module.exports 导出 SDK 的 ContentGameplay；状态、操作、用途、参数 Schema 与结果投影和原生定义相同。entry 列入 assetFiles，不自动扫描未声明脚本。可复制随 skill 的[同步玩法示例](../assets/investigation.cjs)，按作品修改声明、候选、裁定和展示。

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

状态操作的 `resolve` 一次至多返回一条带 `to` 的物品变化。例如把「交出封存袋，再拿走蛋糕」分成两次可见的操作，每一步都在新玩家视图里确认物品归属。若下一幕还需要通行证，再为那次领取设置条件。这个限制针对状态操作的 `items`。

## 常驻客观状态

金钱、HP、游戏时间或明确追踪的任务可以使用同一 `scripts/status.js`。它定义 `globalThis.statusScript`：

- definition.statuses 每项 `{ key, label, type, owner, schema?, alwaysKnown?, playerTruth?, bar?, activities? }`，最多 64 项。type 为 number/string/boolean/object/array/null，object 和 array 必须带同类型 JSON Schema；owner 为 public（全世界一份）或 character（每个角色一份，含玩家）。`bar: true` 钉到玩家状态栏，建议 2–4 项；`activities: ['标识']` 限定只有这些活动能改它。
- definition.operations 每项 `{ id, label, schema, targets?, characterParameters?, actors?, activities? }`，schema 是封闭对象。targets 列出作用的物品，label 可写 `{item}` 替换成物品名；actors 为 player/npc/any。
- 官方状态机制将 `scripts/status.js`、已启用的 `plugins.json` 状态模块、官方 RPG 按配置产生的状态声明合并计数。合并后最多有 64 个状态字段和 128 个状态操作。举例说，本章 RPG 只贡献 `rpg-unlock` 时，作者还可声明 127 个操作；启用休息、队伍等功能也会占名额。运行 `worldpack validate <包目录>`，超限时会报告实际总数、上限和来源。若多幕都在「检查线索」，可复用同一个操作，在 policy 和 resolve 中按进度和地点选中本幕的线索。若第三方插件只在宿主启动时生成额外状态模块，或包指定了其他状态服务，最终数量还需用选定宿主开档核对。
- initialize(characterIds) 返回 `{ public, characters, reveals? }`，恰好包含声明的状态，characters 列出全部角色。角色私有状态默认告知本人，公共状态除非 alwaysKnown 否则谁也不知道。
- policy(known, actorId, place) 可选，返回 `{ operations: [...], targets?: { 操作ID: [物品ID] } }`；known 是 `{ public, self, characters }` 已知值，place 是 `{ locationId, items }`。选项可见不代表执行必定成功。
- 活动的 autoStart 可返回可选 `sceneNotice`（1–500 字），写给在场所有人；`notice` 只给玩家。不写时其他角色不知道事件内容，只知道活动开始了。
- resolve(truth, actorId, operationId, parameters, world, targetId) 重查规则；返回 `{ changes, reveals, description, audience, items?, sceneReaction? }`，或仅返回 `{ rejectReason }`。audience 为 'self'、'scene' 或 `{ characters: [...] }`；行动者总能收到自己的结果，所以空列表等于 'self'，列出别人时行动者也会收到。
- 玩家状态操作获准提交时可在该次结果上返回 `sceneReaction: false`。宿主照常提交状态、按 `audience` 投递描述，并保留在获准角色的经历里。官方调度器不会仅因这条观察安排即时同场回应。同一输入里的发言、其他操作和作者另行安排的自主机会仍按原规则处理。省略字段沿用原行为。
- onRoundEnd(truth, round) 可选，每个玩家回合结束后调用一次，返回 null 或 `{ changes, reveals }`，适合推进游戏时间。

changes 是 `{ holderId, key, value }`，整体替换该键（公共状态 holderId 为 null）；reveals 只写 observerId/holderId/key，值由宿主填入，作者无法告知编造的值。行动者改了自己的状态会自动知道新值；别人引起的变化（比如被偷）不会自动告知失主，失主只看到该值变成“上次确认”。余额不足、偷窃被发现这类玩法失败应作为被接受的结果返回，带上 reveals 和 description；rejectReason 只用于操作根本不成立。仅将明确公开的值设 alwaysKnown；playerTruth 是主动交给玩家前端的真值，不会自动公开给 NPC。所有脚本均为作者可信代码，不应访问凭证或复制宿主内部实现。

## 活动

需要保留当前步骤和可选操作的剧情、轮流行动的小游戏，都可以做成活动。单场写 `scripts/activity.js`，多场写 `scripts/activities/<标识>.js`，都登记进 assetFiles。多场各自保留进度，一次只运行一场，玩家可以暂停一场去玩另一场。脚本定义 `globalThis.activityScript`：

- definition：`{ title, npcIds | participants, operations, opening? }`。npcIds 固定参与者；`participants: { mode: 'player-select', min, max, candidates? }` 让玩家选人（1–8 个 NPC）。operations 每项 `{ id, label, requiresTurn, schema, quick? }`，最多 16 项；start、retry、suspend、resume、abandon 为保留名。opening 是 1–500 字的玩家开场文案。
- initialize、policy、resolve：生成初始状态、限定当前角色可用的操作、同步裁定操作。resolve 也可以附带状态变化，或返回 `playerExpression: { text }`／`{ narration }` 在玩家明确选择的操作中提交公开发言或旁白。
- 在活动里判断同场使用 `world.locationId` 和 `world.characterIds`，例如 `world.locationId === "location:start" && world.characterIds.includes("character:companion")`。节拍的全局位置表 `places` 仅在节拍上下文可用。
- 活动的 resolve 要把已声明变量写回包状态时，在正常返回的 game、description、audience 旁加 `status: { changes: [{ holderId: null, key: "asked", value: true }], reveals: [] }`。这里假设状态脚本已声明公共布尔键 asked。需要显式告知某人时在 reveals 中写 observerId、holderId、key。
- schedule / onOutcome：等待，或给一个已声明角色一次处理机会；它们收到完整活动状态（含 internal 和所有人的 private），输出只有这一次激活，不进入任何视图。
- 包内活动脚本可声明同步纯函数 `canStart(world): boolean`。它只读玩家视角，供入口展示和提交时复核。只声明它不会自动开始；同时声明 autoStart 时，自动开始还须获得提名。返回 false 时不公开原因。若手动开始与自动开场要显示同一段剧情，可在 definition.opening 和 autoStart 返回值的 notice 使用同一个开场字符串，并分别试两种入口。
- 可选：autoStart(truth, world, previous) 在玩家回合结束时按 `when` 全部为真自动开始（每项是布尔值，或 `[标签, 布尔值]`，如 `['时段是深夜', truth?.public?.slot === '深夜']`；标签 1–80 字符，用于在推演结果里标识条件，不影响判定，建议都写），没有单独声明资格时，手动开始沿用同一组条件；`quick: true` 让仅有玩家、无参数的操作一键开始并执行；simulate 返回固定演出替代一次模型响应；resume 检查暂停后能否继续。

可见范围：public 是参与者共享，不是全世界公开；private 每人只拿到自己的一份，玩家那份会显示在玩家的活动卡片上；internal 不进任何角色视图。active、phase、turn、round 每个参与者都看得到，所以隐藏回合（比如夜里轮到谁）不能写在 turn 里：公开 turn 停在一个不变的中性值，真实行动者记在 internal，并在本人 private 里标“轮到你”，相关操作 `requiresTurn: false`，resolve 自己核对，schedule 读 internal 叫醒对的人。这样做只让其他角色不知道轮到谁；默认舞台只显示“正在回复”，但公共 PlayerView 的 `responders` 仍列出正在处理的角色，活动 revision 也随夜间操作增加，所以不要对玩家宣称接口层面已隐藏。活动不能移动角色、不会自动暂停正在运行的活动，也不替角色决定是否接受邀请或怎样行动。

细节以目标程序附带的同版本说明或可运行源包为准；字段对不上时用 Launcher 新实例实际加载检查，不猜字段声称已接通。

### 活动发言与剧情选择

例如玩家查完临靠条，可以先问守船人“我该认什么信号？”，聊完再决定留位还是撤签。在玩家这一步的 `policy` 返回值里设置 `speech`，其他许可照常填写。随附的[单人活动模板](../assets/inspect-activity.js)展示了完整的 `policy` 和 `schedule`。

| 作者想让玩家怎么说 | 玩家这一步的设置 | 等待选择时的效果 |
| --- | --- | --- |
| 自由向在场角色提问 | `speech: 'free'`，`speechChoices: []`；`schedule` 返回 `{kind:'wait'}` | 玩家单独发送一句话后，听到原话的角色可按自己的认知回答或沉默。守船人只需在场，无需加入 `npcIds`。 |
| 玩家只能从几句台词中选 | `speech: 'choices'`，在 `speechChoices` 列出原文 | 只能发表列出的台词。若某句代表签约或退出，由对应的活动操作或 `onPublished` 推进剧情。 |
| 本阶段禁止玩家说话 | `speech: 'none'`，`speechChoices: []` | 玩家仍可执行获准的活动操作。`narration` 单独控制动作描写。 |

定向发言只给指定角色原话。私语时，旁人可以知道发生了交谈，只有听到内容的人才有这次接话机会。普通插话只给听众表达的机会，保留活动步骤和选项。带着操作一起提交的台词、纯描写和固定选句都沿用各自的流程。

需要严格控制演出顺序时，在对应阶段用 `choices` 或 `none`，开放提问时再恢复 `free`。单独返回 `wait` 仍允许自由对白的听众接话。若定义了 `onPublished(state, actorId, expression)`，按剧情条件判断何时返回新 `game`，普通闲聊返回 `null`。

当前低代码活动图生成的脚本使用 `speech: 'free'`。选项上的「玩家发言」填写点选后发表的台词。要按阶段切换发言许可，在手写活动脚本的 `policy` 中判断当前阶段。

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

频率决定何时给角色额外处理机会。列入配置的 NPC 在普通对话触发的反应中也使用这些移动、交互和目标范围；说话仍可由她自己决定。

计数只认 triggers 列出的玩家行为，再加上玩家静观；其他说话、移动或失败的行动不计数。玩家完成一次匹配的行为就加一，满 `everyPlayerTurns` 次给她 `opportunities` 次机会。同一次玩家行动即使匹配多个条件也只算一次。

某个条件想单独计，就在这一条里写自己的 `everyPlayerTurns`（1–100）：

```json
"triggers": [
  { "actionType": "interact", "definitionId": "status:work" },
  { "actionType": "move", "everyPlayerTurns": 3 }
],
"everyPlayerTurns": 1
```

上例中打工每次都给机会，移动每 3 次才给一次；移动不混进打工的计数。没写自己间隔的条件和静观共用角色的 `everyPlayerTurns`。改完用 `worldpack editor autonomy <源目录>` 核对机会配置。

跨场景短信（实验）在 assetFiles 登记 `communication.json`：`{ "medium": "短信", "contacts": { "character:player": ["character:a"], "character:a": ["character:player"] } }`。联系人是有向许可，不等于在场；收信人只知道对方这样说，不获得对方房间的视野。想让角色自主时也能发，在 autonomy 的 interactions 加 `experiment:message`。电话尚未接入。

## 角色退场

达妮娅留在站台，玩家独自去柜台取生日蛋糕。把**站台和柜台建成两个地点**，分别配置启用的场景与在场人。玩家离开前，达妮娅仍在站台，能回答有关生日约定的问题。RPG 开锁会把通路对角色开放，仅写告别对白、调低自主频率，或把她从下一幕的开场名单里移走，都不能阻止她随后选择移动。

在 `worldpack.source.json` 的 `plugins` 中启用 `"official-autonomy": {}`，将 `autonomy.json` 登记到 `assetFiles`。假设达妮娅的初始地点为 `location:out`，下面是完整的最小配置。替换成作品实际登记的 ID。

```json
{
  "characters": [{
    "characterId": "character:danya",
    "triggers": [{ "actionType": "move" }],
    "everyPlayerTurns": 100,
    "opportunities": 1,
    "interactions": [],
    "locationIds": ["location:out"]
  }]
}
```

这里真正限制她主动跟随的是 `locationIds`。它从开局起生效，须含她可以活动的地点，最多为 8 名 NPC 配置这类范围。例中她仍能在站台说话；若她还需要操作物品或参加活动，把相应操作加入 `interactions`。若她此前要陪玩家走几站，可把告别前允许的地点全部列入，后续目的地留在列表外。若前后两幕在故事里都叫「车站」，却要允许不同人物活动，可以用站台和柜台两个地点表达这个区别。

- **队伍**。若启用了 RPG 队伍，队长移动会带走已入队且同地的成员。为告别人物保留站台时，确认她已经离队，并核对离队后是否仍可重新加入。只需要守在站台的人物，可像示例一样不向她开放 `status:rpg-join`。
- **回程**。若剧情允许重访，玩家回站台见到她是预期结果；若是最后一面，给返程和旁路设置实际无法满足的通行条件，检查结局地点直达旧站台的移动也被拒。已取得的钥匙和暂时不能去的地点可能仍显示在玩家界面，在当前目标中写明「拿哪件凭证、去哪一站」。
- **留声和知情人**。将后来听到的录音、读到的旧信写明来源。如果剧情要求彻底失联，也要检查双向短信联系人和后续点名她的活动或节拍。状态操作的 `audience` 控制描述投递，`reveals` 告知获准在场的人某项状态的真实值。远方当事人若确实通过信件得知某事，可用仅授权给她、按进度开放的知识文档。分别问当事人和局外人，再核对各自新收到的观察。

**怎么验证**。另开一个站台推演，在 `start` 把后续几道门设为已开，给 `npcPlans` 写入一次明确的跟随尝试，例如 `{"character:danya":[{"kind":"say","text":"我们约好明年做蛋糕。"},{"kind":"perform","move":"location:market"}]}`。玩家先在站台问约定，确认收到她的回答，再当面邀请她去柜台。在计划记录中确认她确实尝试过、找不到柜台这个可去地点，并检查她获准的移动数为零。玩家离开后，在柜台说一句新的辨认短语，用 `expect.doesNotKnow` 检查达妮娅，用 `expect.knows` 检查同场听者（若有）。再从终点实际尝试返程。核对她的移动是否获准、下一幕在场名单、收信人与本轮新发表。真实模型试玩再问一次「你要跟我来吗」；固定模型总是弃权会漏掉这个问题。

## 插件、预设和界面

`plugins.json` + `plugins/*.js` 是包内插件模块，可以声明需要玩家在 Launcher 启用的本地 Cordis 能力；必需能力缺失时世界打不开并写明缺少什么，可选能力缺失时只隐藏相应操作。包不能自动安装原生代码，用户没要求时不引入。

model-preset.json、role-presets.json 和 frontend/ 是宿主独立读取的扩展；CLI 编译不等于它们已有效。默认沿用官方舞台；只想换风格时在 frontend/ 放 theme.css（从本 Skill 的 `assets/theme.css` 复制，模板逐项标注了每个变量和区域选择器的作用）、portraits/、backgrounds/ 和 stage.json（取景、表情差分、姿势），立绘和背景按 ID 去掉前缀命名，例如 `character:companion` → `portraits/companion.png`。确需整页界面时仅使用公共玩家数据，静态前端不得含角色秘密或 Key。不把模型预设当作规则或权限的替代品。

验收至少覆盖：正确条件下出现选项、条件失效时被拒绝、成功后状态与观察一致、未授权角色没有获得秘密。数据库一致与叙事一致分别检查；未调用真实模型时不能宣布后者通过。

## 推演脚本

`worldpack.cmd simulate <源目录> <剧本路径>` 在临时副本中使用真实宿主与脚本模型核对动作和状态。源码入口为 `node --import tsx apps/host/src/cli/worldpack.ts simulate <源目录> <剧本路径>`。

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

手动启动命名活动的第一步可以写 `{"activity":"inspect","operation":"start"}`，随后用相同 activity 配实际选项 ID。在新档分别跑达成和退出两条路径。要核对脚本拒绝或可见性，可在步骤里断言 `"expect":{"resolution":{"status":"accepted"}}`（或 `"status":"rejected"`，可附判定 code）、`expect.error`（匹配该次步骤错误的子串）、`panelsContain/panelsExclude`（玩家玩法面板）或 `contextContains/contextExcludes`（按角色核对实际决策上下文）。先看步骤返回的轨迹，再选与要验证的事实一致的断言。

推演只证明规则与触发，不判断角色演得好不好；这些仍要真实模型试玩。写好的脚本可存进作者包的 `scenarios/`，编译只读取清单列出的文件，不会读它。

## 活动选项的低代码裁定和普通脚本

用 `editor open` 读取活动图和物品、角色、地点及随队角色候选，用 `rule-candidates` 的 `{"activity":"read-note","field":"condition"}` 枚举变量。复用现有选项 ID。要同时检查开信刀和公共布尔变量，把选项的 `condition` 写为 `{"kind":"all","conditions":[{"kind":"held","ref":"entity:opener"},{"kind":"world","ref":"power-on","value":true}]}`。`any` 表示任一项。组合至少两项；始终可选用独立的 `{"kind":"always"}`。

自定义地图可以给活动页按钮绑定 `move:<已有地点ID>`，沿用玩家实际移动和已配置的官方 RPG 队伍随行。任务条件可选 `{"kind":"location","ref":"地点ID"}`、`{"kind":"present","ref":"角色ID"}`、`{"kind":"alone"}`，或从 `partyCharacters` 选 `{"kind":"party","ref":"角色ID"}`（在场且已知随队）。地点和在场条件加 `"negate":true` 表示当前不在。要等玩家交付并离场才结算，用「在指定地点且独处」提交存放标记，再用「已有标记且不在该地」结算。在途故事直接读取这些事实，勿把图鉴里的旅行变量当作角色已经移动。

保存后，分别用 `editor play` 提交 `{"key":"read-note","world":{"power-on":true}}`、`{"key":"read-note","take":["entity:opener"],"world":{"power-on":false}}` 和 `{"key":"read-note","take":["entity:opener"],"world":{"power-on":true},"choice":"open-note"}`。前两次查 `checks[].available`，第三次查执行记录。`take` 会按顺序执行包里的拾取操作。`item-uses` 和 `rule-references` 返回活动、选项和字段，组合成员的 `field` 用从零开始的 `condition/0`、`condition/1` 标识。

先用 `worldpack editor scripts <包目录>` 查看声明。给 `editor ruling-candidates <包目录> <请求.json>` 传活动 `key` 获取当前变量。数值消耗可直接用选项字段 `ruling: {"kind":"cost","target":{"kind":"world","ref":"energy"},"amount":2,"rejectReason":"精力不足。"}`。原有 `condition` 决定出现条件，`effect` 可在成功时为另一个变量赋值。

用 `script-save` 写入 `{key,base,source}`，新建时 `base:null`，更新前用 `script-read` 读取原文。首行示例为 `// @perspectra-rule {"title":"消耗","type":"number","parameters":[{"key":"cost","label":"点数","type":"number","initial":1}]}`。下面写 `export default function(value, parameters) { return value < parameters.cost ? {rejectReason:"精力不足。"} : {value:value-parameters.cost} }`。编辑器把声明的文本、枚举、数值和布尔参数显示为相应控件。调用方在选项里设 `ruling: {"kind":"script","target":{"kind":"world","ref":"energy"},"script":"search-cost","parameters":{"cost":2}}`。用 `editor save` 保存图，`editor play` 验证成功与拒绝，`editor export` 输出带源码的包。

已有手写活动用 `script-read`、`script-save` 并传 `kind:"activity"`，保留原 `globalThis.activityScript` 与操作键。可给 `script-assist` 传 `key,source,provider,prompt` 和可选 `kind`，检查返回的候选源码再保存。

## 用 HTML 和 CSS 做活动页面

使用当前源码工具时，先运行 `worldpack editor activity-pages <源包>` 枚举真实活动键和资源。在 `frontend/activities/` 下编写 HTML、CSS 及引用的包内资源，HTML 可用相对路径链接样式。在 `frontend/activity-pages.json` 以活动键绑定，例如 `{"read-note":{"html":"activities/note.html","css":"activities/note.css"}}`。CSS 选填。用 `data-activity-title`、`data-activity-field="score"` 显示授权字段，用 `<div data-activity-actions></div>` 请求宿主显示当前选项和参数表单。页面禁用作者脚本。需要按活动提交裁定时使用宿主提供的操作。

也可用 `worldpack editor activity-page-import <源包> <请求.json>` 写入 `{path,text}`，用 `activity-page-save` 提交 `{key,base,page}`。修改时 `base` 取上次读取的绑定，新建用 `null`。为页面元素配置行为时，先调用 `activity-page-candidates`，传入 `key`、`html`，需要玩法动态字段时另传 `trial:true` 与试玩 `scenes`。把结果中的 `field` 原样用于 `page.elements[].rules[]` 的 `field`，同时给出 `compare`、标量 `value`、`effect`（`show`、`class` 或 `image`）。每项元素需有 HTML 内的唯一 `id`，按钮可同时填 `operation`。图片可通过 `activity-page-import` 的 `path` 与 `base64` 导入。使用 `activity-page-preview` 和 `{"key":"read-note"}` 打开本地试玩，退出预览后用 `editor export` 导出新目录。

## 交付验收

例如验收门廊空手开信，把以下清单和剧本放在同一个作者工作目录，分别保存为 `acceptance.json` 与 `empty.json`。正式作品使用 `editor export` 导出的完整目录。验收入口直接读取该目录的运行内容，工作区清单和剧本另外保管。

```json
{"cases":[{"id":"empty","scenario":"empty.json","required":["choices"]}]}
```

```json
{"title":"空手看便笺","steps":[{"id":"choices","activity":"read-note","operation":"start","expect":{"started":"read-note","offers":[{"at":"after","operation":"activity:open-note","target":"read-note","present":false}]}}]}
```

`offers` 读取正式玩家选项，时点为本步前 `before` 或本步后 `after`，`target` 可省略。普通交互用定义 ID，移动用 `move` 和地点目标。检查正式玩家裁定可写 `"resolution":{"operation":"investigation:search","status":"rejected","code":"INSUFFICIENT_ENERGY"}`。关联到该操作的本步裁定须唯一。短写交互会先匹配候选；要测试过期操作被正式拒绝，可像搜证剧本那样提交完整的 `action`，在前后两步断言关键状态。活动开始按提交的 start 事件判断。

每个用例的 `required` 列出必验步骤 ID，该步的每个期望都要取得证据并通过。用例与步骤 ID 使用字母、数字、下划线或短横线，以字母或数字开头，最多 80 字符。清单用例下可加 `"requiredPlans":["character:companion"]` 要求该角色在剧本中的整列桩计划都得到消费；若还关心行动结果，另写裁定断言。未标必验的步骤可作准备或探索，意外执行错误仍阻断交付。

运行 `worldpack.cmd accept <导出目录> <清单.json>`；局部回归在末尾加 `--only <用例ID> [更多ID]`。退出 0 表示所选门槛通过，2 表示运行后的验收失败或证据不足，1 表示输入、引擎识别、Host 启动或运行器异常。可解析的清单会按用例返回汇总；清单或筛选本身无效时从 stderr 读错误信封。分享报告只含公共标识、计数、原因码及摘要。步骤下标及失败断言下标从 0 起。需要本机诊断时，在作者控制的目录对该剧本单独运行 `simulate`，其详细输出可含私有上下文。

摘要覆盖实际输入的清单和剧本字节（含开局与桩）、完整导出目录的文件树、编译包、已载入的包内前端和本次 CLI 构建。源码运行记录工作代码与依赖锁、提交及 Node 版本；发行入口记录 CLI bundle 摘要及 Node 版本。报告只证明所列的脚本模型场景，不验证真实服务、另配的模型、未绑定的外部输入或平台运行库。作者可把不同意图分别放在有稳定 ID 的必验步骤，包内 `assertionFiles` 继续由 `worldpack test` 单独报告编译声明。
