# 创作者字段：状态、活动和世界进程

例如玩家把钥匙交给同伴：`status.js` 声明可以对哪些物品执行操作，规则返回变化候选，宿主检查持有关系和受众后提交。若作者希望第四回合厨房停电，则可另用世界事件；想让事件在合适的时候出现，可以交给节奏脚本挑选。以下是当前源码中这些入口的字段索引；[共同玩法脚本](creator-fields-gameplay-sdk.md)是另一套可组合入口，RPG／TRPG 配置见[玩法模式字段](creator-fields-modes.md)，包内插件模块见[扩展字段](creator-fields-extensions.md)。

本文以 `main` 的源码为准，描述普通世界包作者能写什么，不把回调收到的只读上下文当成需要填写的配置。**必填**指对应对象出现时必须写；**可选**不代表该机制自动启用。字段表中的长度是源码检查使用的字符串长度。固定外层对象若标明封闭，未知字段会被拒绝；状态值、活动的自定义数据及 JSON Schema 的属性按作者自己的 schema 或对应规则处理。写入世界事实的数据须符合 [World JSON](../../../packages/sdk/src/contracts/world-json.ts)：普通 JSON 对象／数组，数值为安全整数且不能是负零，不允许循环、未配对代理字符等。配置本身允许小数的地方会特别说明。

## 文件和启用方式

在 `worldpack.source.json` 的 `assetFiles` 登记相应文件，并显式选择插件。入口路径和加载条件如下：

| 内容 | 包内入口 | 需要选择 | 说明 |
| --- | --- | --- | --- |
| 状态和物品操作 | `scripts/status.js` | `pack-scripts` | `globalThis.statusScript`；只认此固定路径 |
| 活动 | `scripts/activity.js` 或 `scripts/activities/<key>.js` | `pack-scripts` | 前者 key 为 `default`；后者 key 小写字母开头、后接小写字母／数字／连字符，最多 41 字符；不能和其他活动重名 |
| 骰子 | 活动 `resolve` 中的 `rollDice` | `official-dice` | 不自动启用；调用写法见下文 |
| 节奏 | `scripts/pacing.js` | `official-pacing` | `globalThis.pacingScript`；节拍需要状态机制 |
| 自主机会 | `autonomy.json`，可用插件选择的 `config` 改路径 | `official-autonomy` | 非脚本配置 |
| 世界事件 | `world-events.json` | `official-world-events` | 当前事件生产路径要求这个固定文件名；规则写入须指向包内基础公共布尔状态 |

状态、活动和节奏脚本各不超过 256 KiB，回调同步执行，单次限时 100 ms。状态调用输入／输出各限 1 MiB 字节；活动常规调用输入／输出限 65,536 字符，`simulate` 输入限 1,048,576 字符；节奏输入限 1,048,576 字符、输出限 65,536 字符。这里的字符串长度按 JavaScript 的 UTF-16 码元计。脚本是可信本地代码，作者应提供有限 JSON，不能使用异步模型调用或数据库句柄。启用插件和登记文件还须符合包组合及宿主实际选择；具体入口见[状态加载](../../../apps/host/src/runtime/status-source.ts)、[活动加载](../../../apps/host/src/runtime/activity-source.ts)、[节奏加载](../../../apps/host/src/runtime/pacing-source.ts)和[插件组合](../../../packages/world-pack/src/composition.ts)。

## 状态脚本 `scripts/status.js`

入口对象需要 `definition`、`initialize` 和 `resolve`；`policy`、`onRoundEnd` 可省略。运行时在独立调用上下文执行它们，不应靠全局变量保存进度。[示例](../../../examples/world-packs/status-market/scripts/status.js) · [状态校验](../../../packages/core/src/application/status-state.ts)

### `definition`

外层封闭，必填 `statuses` 和 `operations` 数组，允许为空。作者脚本与启用模块合并后，最多有 64 个状态字段和 128 个状态操作。

| `statuses[]` 字段 | 必填 | 类型、默认值与限制 |
| --- | --- | --- |
| `key` | 是 | 唯一标识，`^[a-z][a-z0-9-]{0,40}$` |
| `label` | 是 | 非空白字符串，最多 80 字符 |
| `type` | 是 | `number`、`string`、`boolean`、`object`、`array`、`null` |
| `owner` | 是 | `public` 为全世界一份；`character` 为每个包角色各一份 |
| `schema` | 条件 | JSON Schema；`object`／`array` 必填，其他类型可省略。顶层 `type` 须与声明一致；省略的字符串默认 `maxLength: 200`，其他默认 `{type}` |
| `alwaysKnown` | 否 | 布尔，默认 `false`；为真时所有合格观察者知道当前值 |
| `activities` | 否 | 不重复字符串列表；指定后只有所列活动的结果或活动内状态操作能改变该状态。空列表意味着初始化后没有活动能改它 |
| `locations` | 否 | 非空、不重复的包内地点 ID 列表；限制观察者当前位置，不限制状态本身改变或 `playerTruth` |
| `playerTruth` | 否 | 布尔，默认 `false`；为真时真实值发给玩家前端，不进入角色上下文 |
| `bar` | 否 | 布尔，默认 `false`；为真时将已知值固定到玩家状态栏 |

每项状态声明封闭。单个状态值最多 16 KiB、嵌套深度 16、4096 个值节点；所有角色和公共状态值合计最多 512 KiB。对象或数组内是否接受额外字段由作者的 `schema` 决定；每次更改整项替换，不是 JSON Patch。一次告知覆盖整个键，秘密应拆成不同状态键。

| `operations[]` 字段 | 必填 | 类型、默认值与限制 |
| --- | --- | --- |
| `id` | 是 | 唯一，格式同状态 `key`；不能是 `start`、`retry`、`suspend`、`resume`、`abandon`。角色交互 ID 为 `status:<id>` |
| `label` | 是 | 非空白，最多 80 字符；可用 `{item}` 代入目标物品名称 |
| `schema` | 是 | AJV 严格模式 JSON Schema，顶层 `type: 'object'` 且 `additionalProperties: false`；参数必填与否由 schema 的 `required` 决定 |
| `characterParameters` | 否 | 不重复的参数名列表，默认 `[]`；各项须是 `schema.properties` 中的字符串属性，提交时角色必须存在并在行动者授权场景 |
| `actors` | 否 | `player`、`npc`、`any`；默认 `any` |
| `activities` | 否 | 不重复的活动 key 列表；存在时只允许对应活动的参与者在活动中执行 |
| `targets` | 否 | 非空、不重复的包内物品 ID 列表；不写时操作目标为行动者本人，写出后每件够得着的物品形成一个候选 |

每项操作声明封闭。常规目标候选只列行动者持有或脚下的物品；执行和结果的可达性复核还会考虑授权同场角色持有的物品，因此不要把候选过滤理解成对同场持有物的一律禁止。具体取放条件应在作者规则中表达。若活动正在运行，活动 `policy.interactions` 也要允许相应 `status:<id>`。

### 回调参数和返回值

| 回调 | 何时必需 | 输入：宿主提供，不写入配置 | 作者返回 |
| --- | --- | --- | --- |
| `initialize(characterIds)` | 必需 | 所有包角色 ID，包括玩家 | `{ public, characters, reveals? }`；外层封闭，`public` 恰好含所有 `owner: 'public'` 的键；`characters` 恰好有每个角色 ID，各自恰好含所有 `owner: 'character'` 的键。角色初值自动告知本人；`reveals` 每项为下述告知格式 |
| `policy(known, actorId, place)` | 可选 | `known` 是本角色已知的 `{public, self, characters}`，值可能已过期；`place` 是 `{locationId, items}`，只含本人持有或脚下可及物品 | `null` 或 `{operations, targets?}`。不写／`null` 表示全部已声明操作；`operations` 为不重复 ID 列表；`targets` 是操作 ID 到不重复物品 ID 列表的映射，只能收窄已声明的 `targets` |
| `resolve(truth, actorId, operationId, parameters, world, targetId, external)` | 必需 | `truth` 是 `{public, characters}` 真值；`world` 是行动者授权视图；`targetId` 为物品 ID 或 `null`；`external` 是能力桥结果，仅适用于相关模块能力，不是任意网络句柄 | `{rejectReason}` 或下面的接受结果 |
| `onRoundEnd(truth, round)` | 可选 | 状态真值和当前轮次 | `null` 或封闭 `{changes, reveals}`；只可告知本次被修改的角色状态的归属者本人，不能更改仅限活动的状态 |

`resolve` 拒绝对象仅含 `rejectReason`：非空白、最多 2000 字符，不提交变化。接受结果是封闭对象：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `changes` | 是 | 最多 64 项 `{holderId, key, value}`；公共状态 `holderId: null`，角色状态用角色 ID；值按声明 schema 校验 |
| `reveals` | 是 | 最多 64 项 `{observerId, holderId, key}`，不写 value；宿主填本次变化后的真实值。操作可告知本人及当前授权场景中的人；自身状态变化自动告知行动者 |
| `description` | 是 | 结果文字，最多 2000 字符 |
| `audience` | 是 | `self`、`scene` 或封闭 `{characters: [角色 ID]}`；指定角色须在当前授权场景 |
| `items` | 否 | 物品变化数组，见下一节 |
| `sceneReaction` | 否 | 仅玩家状态操作可写 `false`，抑制仅由此结果引发的即时同场反应 |

`world` 的 `locationId`、`arrivedAtSeq`、`characterIds`、`items.current`／`items.lastObserved` 是运行时输入；`lastObserved` 不保证是当前持有事实。状态操作结果及告知不合法时整次候选不提交。[运行时视图](../../../packages/core/src/application/world-view.ts) · [操作校验](../../../packages/core/src/application/status-operations.ts)

### `items` 物品变化

每项封闭 `{entityId, kind?, to?}`。`entityId` 是已有物品；`kind` 为非空白、最多 500 字符的新外观；`to` 二选一 `{holderId: 角色ID}` 或 `{locationId: 地点ID}`。状态操作一次最多 8 项且至多移动一件：物品须可达，接收者为行动者或同场角色，放下只能放在行动者当前位置。活动结果最多 16 项，允许移动多件已有物品到任何已声明角色／地点，不作可达性检查，但仍校验实际持有关系和参与者移动；两种结果都原子提交。[校验实现](../../../packages/core/src/application/item-effects.ts) · [拿／放／给模板](../../../examples/templates/item-rules.js)

## 活动脚本

在编辑器的活动图里，每个 `choices[]` 选项必填 `condition`，默认是 `{"kind":"always"}`。生成的活动脚本会按图检查这些条件。普通脚本也可以自行实现 `policy` 与 `resolve`。

| 单项或组合 | 条件对象必填字段 | 候选和值 |
| --- | --- | --- |
| 始终可选 | `kind: "always"` | 单独使用 |
| 在场或持有 | `kind: "present" / "held"`、`ref` | 包内角色 ID 或物品 ID |
| 变量相等 | `kind: "world" / "local"`、`ref`、`value` | 当前可读的世界或本活动变量键，以及符合声明的布尔值、安全整数、文字或枚举值 |
| 全部或任一 | `kind: "all" / "any"`、`conditions` | 至少两项具体条件，同一组可混用在场、持有和变量相等 |

试玩请求的 `take` 和 `world` 都是选填。省略时按包内开局进入活动。见[编辑和试玩步骤](activity-editor.md#让展开便笺同时检查物品和灯光)。

`globalThis.activityScript` 的基本钩子为 `definition`、`initialize`、`policy`、`resolve`、`schedule`、`onOutcome`。可选钩子为 `canStart`、`autoStart`、`resume`、`simulate`、`onPublished`；不需要用模拟脚本替代模型。[示例](../../../examples/world-packs/launcher-demo/scripts/activity.js) · [活动字段校验](../../../packages/core/src/application/activity-state.ts) · [返回校验](../../../packages/core/src/application/activity-projection.ts)

### `definition`

外层必填 `title`、`operations` 以及 `npcIds` 或 `participants` 恰好之一。可选字段包括 `opening`、`handoff`、`readsScene`、`readsStatus`。

| 字段 | 必填 | 类型、默认值与限制 |
| --- | --- | --- |
| `title` | 是 | 字符串，最多 80 字符 |
| `npcIds` | 二选一 | 不重复 NPC ID 列表，最多 8 个，不包括玩家；可为空 |
| `participants` | 二选一 | 封闭 `{mode: 'player-select', min, max, candidates?}`；`min`、`max` 是 1–8 整数且 `min ≤ max`；`candidates` 为不重复 NPC ID 白名单，省略时不额外限名单。开始时还须存在且与玩家在同一授权场景 |
| `operations` | 是 | 最多 16 项，允许为空，见下表 |
| `opening` | 否 | 非空白、最多 500 字符的玩家开场；不进入 NPC 上下文 |
| `handoff` | 否 | 封闭 `{phase, finish, target, label}`；在指定阶段将当前活动收尾后接另一活动，详见下表 |
| `readsStatus` | 否 | 布尔值，省略时关闭。开启后，`policy` 可以从 `scoped.knownPublic` 读取执行者已知的公共值。未获知的键省略。 |
| `readsScene` | 否 | 布尔值，省略时关闭。开启后，`policy` 的 `scoped.scene` 附带执行者可见的角色和本人持有的物品。 |

每个 `operations[]` 是封闭 `{id, label, requiresTurn, schema, quick?}`：`id` 格式同状态操作且不得使用五个宿主管理名；`label` 是字符串；`requiresTurn` 必填布尔；`schema` 是顶层 `type: 'object'`、`additionalProperties: false` 的 AJV schema，不能声明宿主保留参数 `activityId`、`revision`；`quick` 默认 `false`，为真只适用于无 NPC、无动态选人、无参数的操作。

`handoff.phase` 为非空白、最多 80 字符的收尾阶段；`finish` 是已声明、非 `escape`、非快捷且允许空参数的操作；`target` 是另一活动 key；`label` 非空白、最多 80 字符。目标活动和参与者仍须在点击时满足开始条件。

### 活动数据、回调和结果

`initialize` 返回及 `resolve`／`onPublished` 更新的 `game` 均为封闭对象：

| `game` 字段 | 必填 | 说明 |
| --- | --- | --- |
| `active` | 是 | 布尔；结束设为 `false` |
| `phase` | 是 | 阶段字符串，最多 80 字符 |
| `turn` | 是 | 活动中须是参与者 ID；非活动中必须为 `null` |
| `round` | 是 | 不小于 1 的安全整数 |
| `public` | 是 | 作者自定义对象，所有参与者可见 |
| `private` | 是 | 以每位参与者 ID 为键且恰好覆盖全部参与者，每个值为对象；本人只看到自己的值 |
| `internal` | 是 | 作者自定义对象，普通参与者视图看不到 |

整个 `game` 经 World JSON 检查后最多 65,536 字符。完整状态另有宿主管理的 `id`、`revision`、`participants`，暂停时可能有 `suspendedTurn`，这些不是在 `game` 中自行填写的字段。

| 钩子 | 必填 | 输入：由宿主提供 | 返回 |
| --- | --- | --- | --- |
| `initialize({playerId, npcIds, world, previous, truth})` | 是 | `previous` 为玩家的上次活动视图或 `null`；`truth` 为公共及本次参与者角色状态真值或 `null` | 上述 `game`；此钩子的 `Math.random()` 使用受控记录随机源 |
| `policy(scoped, actorId)` | 是 | 参与者共享数据、执行者自己的 private。启用 `readsScene` 后，`scoped.scene.characterIds` 为可见角色，`scoped.scene.heldEntityIds` 为本人持有的物品。启用 `readsStatus` 后可读 `scoped.knownPublic`。 | 封闭 `{speech, speechChoices, narration, move, interactions, operations}`；`speech` 为 `free`／`none`／`choices`，`narration`、`move` 为布尔，其余为不重复字符串列表；`operations` 须已声明 |
| `resolve(state, actorId, operation, parameters, world, truth)` | 是 | 完整活动状态、角色、已校验参数、该角色授权世界视图、状态真值或 `null`；`world.participantHeldItems` 另含同场参与者实际持有物 | 拒绝或接受对象，见下表 |
| `schedule(state)` | 是 | 完整活动状态，包括 internal 和全部 private | `{kind: 'wait'}`，或 `{kind: 'activate', characterId}`；被激活者须为当前活动的 NPC 参与者 |
| `onOutcome(result, state)` | 是 | 一次角色处理结果及完整活动状态 | 与 `schedule` 同格式；只是提供下一次机会 |
| `canStart(world)` | 否 | 玩家授权世界视图 | 布尔；只控制开始资格，不自动开始 |
| `resume(scoped, world)` | 否 | 恢复候选的玩家活动视图和玩家授权世界视图 | `null` 接受，或封闭 `{rejectReason}` 拒绝；省略时要求参与 NPC 与玩家同场 |
| `autoStart(truth, world, previous)` | 否 | 全部状态真值或 `null`、玩家授权世界、上次玩家活动视图或 `null` | `null` 或下面的自动开始对象 |
| `simulate(request)` | 否 | 当前角色获准读取的决策请求 | 返回 `null` 时继续调用模型。固定演出的返回字段见下表。 |
| `onPublished(state, actorId, publication)` | 否 | 参与者成功发言后的完整活动状态和发言数据，后者可能为 `null` | `null` 或更新后的完整 `game` |

`resolve` 拒绝为封闭 `{rejectReason}`，非空白、最多 2000 字符。接受结果封闭：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `game` | 是 | 新的完整 `game`，所有参与者 private 键仍须齐全 |
| `description` | 是 | 字符串，最多 2000 字符 |
| `audience` | 是 | `participants` 或 `self`，决定结果文字受众 |
| `status` | 否 | 封闭 `{changes, reveals}`，格式同状态操作；与活动更新一起提交 |
| `moves` | 否 | 最多 8 项封闭 `{characterId, locationId}`，只能移动本场参与者到包内地点 |
| `items` | 否 | 最多 16 项，格式见物品变化节 |
| `privateNotes` | 否 | 最多 8 个 `参与者ID: 文字`；每条非空白、最多 2000 字符，只投递本人 |
| `playerExpression` | 否 | 仅玩家执行操作时可用；封闭 `{text}` 或 `{narration}`，非空白、最多 2000 字符，仍须符合活动表达许可 |

`autoStart` 对象封闭，必填 `when`，可选 `notice`、`sceneNotice`；动态选人活动还**必须**写 `npcIds`，固定 NPC 活动不能写。`when` 为 1–32 项布尔或 `[标签, 布尔]`，标签 1–80 字符，全部为真才合格；两种提示各为非空白、最多 500 字符。`notice` 给玩家，`sceneNotice` 给同场观察者。未交由节奏管理的合格活动按条件数量最多优先，同数时随机选一个。

固定演出可返回以下决策对象。表达与可尝试的操作仍受本步权限限制。[决策 Schema](../../../packages/providers/src/chat/character-turn-call.ts) · [固定演出实例](../../../examples/world-packs/scripted-performance/scripts/activity.js)

| `simulate` 返回分支 | 必填 | 选填或条件 |
| --- | --- | --- |
| 弃权 | `decision: "abstain"` | 无其他字段。 |
| 发表 | `decision: "publish"`、非空 `segments` | 可填 `scope` 和 `addresseeIds`。选择 `direct/private` 必须指定非空受众，选择 `scene_public/self` 时受众留空或省略。 |
| `segments[]` | `type`、`text` | `type` 取本步允许的 `speech` 或 `narration`。舞台声明了该角色的表情时可选填 `expression`。 |
| 执行操作 | `decision: "perform"`、`actionType`、`parameters` | 具体参数取当前提供的候选。仅当本次请求允许行动前表达时，可附 `before`，内含必填 `segments`，受众字段同发表。 |

若没有 `canStart`，旧活动的手动开始也沿用 `autoStart` 的条件：明确返回条件未满足会挡住手动开始；没有自动开始候选则不因此挡住。提供 `canStart` 时，手动资格以它的布尔结果为准，自动开始还要满足 `autoStart`。

活动 `resolve` 中若选择 `official-dice`，可用 `rollDice('1d20+2')`；返回 `{expression, dice, modifier, total}`。骰数 1–20（可省略）、面数 2–1000、修正绝对值至多 1000，不能有前导零或写 `+0`／`-0`；只在本次 `resolve` 同步调用期间有效。随机值会记录并用于重放，见[骰子实现](../../../packages/plugins/src/dice/dice.ts)。

## 剧情节奏 `scripts/pacing.js`

`globalThis.pacingScript` 包含 `definition`，以及在声明节拍时必需的 `beats` 对象；`definition.beats` 与 `beats` 中的 key 必须一一对应。[解析器](../../../packages/plugins/src/pacing/definition.ts) · [完整示例](../../../examples/world-packs/model-girls-sweet-days/scripts/pacing.js) · [节奏指南](story-pacing.md)

| `definition` 字段 | 必填 | 限制／默认 |
| --- | --- | --- |
| `cycleRounds` | 是 | 2–100000 整数 |
| `chance` | 是 | 0–1 的有限数，可为小数 |
| `cooldownRounds` | 是 | 封闭 `{low, medium, high}`，每项 0–100000 整数 |
| `recoveryRounds` | 是 | 0–100000 整数 |
| `repeatAfterRounds` | 否 | 0–100000 整数，默认 0；同一活动或节拍的默认重复间隔 |
| `stagnation` | 否 | 封闭 `{afterRounds, progress, maxChance, maxTensionBoost}`；`afterRounds` 1–100000，`progress` 封闭 `{statuses, activities}` 两项均为字符串数组；`maxChance`、`maxTensionBoost` 为 0–1，且前者不小于 `chance` |
| `activities` | 否 | 对象，键为活动 key，值为封闭 `{intensity, repeatAfterRounds?}`；强度为 `low`／`medium`／`high`，单项间隔为 0–100000，覆盖默认值 |
| `beats` | 否 | 对象，键为节拍 key，值和 `activities` 相同 |
| `events` | 否 | 对象，键为 `paced` 世界事件规则 ID，值只含必填 `{intensity}`，不能写单项重复间隔 |

每个 `beats[key]` 要实现 `when(truth, world)` 和 `apply(truth, world)`。输入是状态真值和玩家授权世界（额外有各角色位置 `places`），不是需要填入包清单的字段。`when` 返回与活动自动开始相同的 1–32 项条件数组。`apply` 返回封闭对象，以下字段均可省略：`changes`、`reveals` 默认 `[]`，格式同状态脚本；`notice`、`sceneNotice` 各为非空白、最多 500 字符；`stimuli` 默认 `[]`，最多 8 项封闭 `{characterId, kind, text}`，对象须是活跃 NPC，`kind` 为 `perception`／`thought`，`text` 非空白且最多 500 字符。`apply` 的 `Math.random()` 使用记录随机；节拍不能直接移动角色或物品。节奏管理活动仍需活动的 `autoStart` 条件满足；每个合格周期最多选一项，未交由节奏管理的自动活动优先。

## 自主 `autonomy.json`

「角色自主机会」工作台可在新包启用并填写以下各项，也会按已有包所选的配置路径回写。触发活动、操作、角色、地点和物品都有候选。[设置自主机会](world-workbench.md#给角色设置主动行动的机会)

根对象封闭且必填 `characters` 数组，最多 8 个角色，角色不能重复。每项封闭：

| `characters[]` 字段 | 必填 | 限制 |
| --- | --- | --- |
| `characterId` | 是 | 已声明的 NPC，不能是玩家 |
| `triggers` | 是 | 1–32 项，格式见下表 |
| `everyPlayerTurns` | 是 | 1–100 整数；没有单项频率的触发共享此频率 |
| `opportunities` | 是 | 1–100 整数；给角色的机会数仍受核心实际预算约束 |
| `interactions` | 是 | 不重复的交互 ID 列表，可为空；自主时允许尝试的交互。可引用已安装交互定义、`experiment:message`，或符合机制命名格式的 `activity:<操作>`／`status:<操作>` |
| `locationIds` | 是 | 非空、不重复的包内地点 ID 列表；自主移动的起点和目的地均须在列表内 |
| `targetIds` | 否 | 不重复的包内角色或物品 ID 列表；省略时不额外限制目标，空列表则不允许任何目标交互 |

触发项二选一且均为封闭对象：

| 形式 | 必填 | 可选与条件 |
| --- | --- | --- |
| 普通行动 | `{actionType}` | `actionType` 为 `speak`／`move`／`interact`；仅 `interact` 可写 `definitionId`，须为已安装交互定义、`experiment:message` 或符合 `activity:<操作>`／`status:<操作>` 命名格式；`everyPlayerTurns` 可覆盖单项频率，1–100 |
| 活动操作 | `{activityKey, operation}` | key 与操作名须为小写格式；操作不能是 `start`、`retry`、`suspend`、`resume`、`abandon`；可写单项 `everyPlayerTurns` |

配置解析时对 `activity:`／`status:` 和短信 ID 的检查不证明相应操作已安装，实际可用性仍取决于当前包和运行时。单项写了频率的触发分别计数；其余触发及玩家静观共享角色级频率，同一玩家事务只计一次。

自主机会只让角色依据自身认知决定行动或弃权，不预写台词；行动仍需通过正常权限和场景规则。角色的普通 `speak` 不受 `locationIds` 限制；`interact` 受 `interactions` 和可选 `targetIds` 限制。[解析器](../../../packages/providers/src/scheduler/autonomy-policy.ts) · [示例](../../../examples/world-packs/character-autonomy/autonomy.json)

## 世界事件 `world-events.json`

根对象封闭：`rules` 必填，最多 32 项；`grants` 可选，默认 `[]`，最多 64 项。所有规则 ID 不重复。当前官方插件读取此文件并提出规则 ID；具体执行仍由宿主核对。[解析器](../../../packages/sdk/src/world-events.ts) · [示例](../../../examples/world-packs/model-girls-sweet-days/world-events.json) · [事件语义](../architecture/world-events.md)

| `rules[]` 字段 | 必填 | 限制／默认 |
| --- | --- | --- |
| `id` | 是 | `^[a-z][a-z0-9.:-]{0,95}$`，规则内唯一 |
| `type` | 是 | 版本化事件类型 `^[a-z][a-z0-9.-]{0,63}@[1-9][0-9]{0,3}$`，例如 `power.outage@1` |
| `round` | 二选一 | 不小于 1 的安全整数；达到此玩家回合后可发生 |
| `when` | 二选一 | 封闭 `{crossesPackTime: {dayKey, slotKey, slots, at: {day, slot}}}`；不与 `round` 共存，也不能用于 `paced` |
| `location` | 是 | 包内地点 ID，作为默认同场见证地点 |
| `observation` | 是 | 非空白、最多 512 字符的观察文字 |
| `set` | 是 | 封闭 `{key, value}`；`key` 为 ID 格式，`value` 为布尔；只能写包基础状态脚本声明的公共布尔状态 |
| `audience` | 否 | 默认 `scene`；也可为 `global`、封闭 `{holds: 物品ID}`，或 `{anyOf: [上述项]}`，1–4 项。`holds` 使用包内物品 ID |
| `trigger` | 否 | `hard` 或 `paced`；默认 `hard`。`paced` 须在节奏 `events` 中声明才会被选择 |
| `duringActivity` | 否 | 仅 `paced` 可写布尔，默认 `false`；为真才允许活动占位期间参与抽选 |
| `wakeCharacters` | 否 | 1–8 个不重复的包内 NPC ID；仅实际获得本次观察者可获一次有预算的处理机会 |
| `sceneNotices` | 否 | 仅日历规则且默认／显式 `scene` 受众可写，最多 4 组，见下文 |

日历 `dayKey`、`slotKey` 为不同的状态 ID；`slots` 为最多 32 个不重复的非空白字符串，每项最多 64 字符；`at.day` 为非负安全整数，`at.slot` 须是 `slots` 中一项。它使用包声明的公共数值日和字符串时段，跨过阈值时触发。

每个 `sceneNotices[]` 封闭 `{locations, text?, fromOperation?}`：`locations` 为 1–16 个包内地点，与主地点和其他组不重复；`text` 非空白、最多 512 字符，省略沿用 `observation`；`fromOperation` 为可选操作 ID，进一步限制观察的来源。规则即使没有见证者仍可写入状态；观察不自动赋予未获授权角色知识。

每个 `grants[]` 封闭 `{plugin, type, mode, effect?}`：`plugin` 为插件 ID，`type` 为上述版本化类型，`mode` 为 `live`／`durable`；仅 `durable` 可选 `effect: {key, value}`，格式与 `set` 相同。`plugin/type/mode` 组合不能重复；插件还须在包中选择、已安装并获运行许可，授权本身不会产生订阅。

## 核对范围

字段依据当前解析器与执行入口整理；旧指南可提供玩法解释，但历史验收不代表本次重新试玩。`worldpack validate` 能检查包结构及部分已选插件配置，状态／活动脚本钩子的实际结果还需要打开世界、推演并按角色分别检查可见信息。此页不等于真实模型体验、发行包或第三方插件兼容性验收。
