# 官方 RPG 与跑团的创作字段

给阿林设计一场守卫战时，先在 RPG 配置里声明生命、阿林的战斗数值和守卫。要让她主持一场调查，则在 TRPG 配置里写角色卡模板、剧本开场和只有主持人知道的真相。这两份配置都按作品需要启用。

**读表方式**　每行的“必填”针对左列对象。选填数组可以整体省略，一旦添加其中一项，该项的必填字段就要提供。尖括号表示作者命名的键。正式入口先校验 JSON Schema，再执行插件的语义校验。下表记录两层共同接受的写法。[字段总览](creator-fields.md) · [组合校验入口](../../../packages/world-pack/src/composition.ts)

## RPG

在源清单的 `plugins` 选择 `official-rpg`、`official-dice`，把配置文件列入 `assetFiles`。默认文件名是 `rpg.json`，可用 `plugins.official-rpg.config` 指定包内路径。[插件声明](../../../packages/plugins/src/rpg/content.ts) · [遗迹示例](../../../examples/world-packs/hill-ruins/rpg.json)

| 对象 | 必填 | 选填或条件 | 创作含义 |
| --- | --- | --- | --- |
| 文件根 | `plugin`, `stats`, `characters` | `skills`, `combatStatuses`, `battleValues`, `equipment`, `consumables`, `rest`, `enemies`, `vault`, `maps`, `defeat`, `retreat`, `party` | `stats` 是属性列表，`characters` 按包内角色 ID 分组。只有空列表和空对象也能通过配置校验。 |
| `plugin` | `id` 固定为 `official-rpg`，`version` 为字符串 `"1"` | — | 配置对应的插件与版本。 |
| `stats[]` | `key`, `label` | `locations` | 属性键与显示名。可指定在哪些地点显示，填写时至少一个地点。有敌人的地图要求声明键 `hp`。 |
| `characters.<角色ID>` | `stats`, `attack`, `defense`, `speed` | `skills`, `slots`, `battleValues` | `stats` 按属性键填写全部已声明属性值。后三个必填数是攻、防、速。技能 ID 和装备槽名均默认为空列表。 |
| `skills[]` | `id`, `name`, `target`, `effects` | `scope`, `cost`, `resourceCost`, `requires` | 目标是 `ally/opponent/self`；范围 `one/all`，默认 `one`。`effects` 为 1–8 个效果。`cost` 是普通属性消耗，默认空，禁用 `hp`。`resourceCost` 按下表定义的单位资源键填正整数。 |
| `combatStatuses.<状态ID>` | `name`, `turns`, `timing`, `polarity` | **至少一项** `tick`、`modifiers`、`attributeModifiers` | 持续 1–99 次。结算时机 `after-action/round-end`，性质 `positive/negative`。`tick` 选伤害或治疗效果。`attributeModifiers` 按自定义单位属性键填整数修正。 |
| 上项的 `modifiers` | **至少一个**已列键 | `attack`, `defense`, `fireResistance` | 内置攻、防、火抗修正，每项 −1000 到 1000。 |
| `equipment.<物品ID>` | `slot` | `attack`, `defense`, `speed`, `resistances` | 装备槽名。攻防速加成默认 0。填了 `resistances` 就必填 `fire`，取整数 0–75。 |
| `consumables.<物品ID>` | `restore` | — | 按属性键指定各恢复多少。 |
| `rest` | `label`, `locations`, `restore` | — | 休息操作名、至少一个地点，恢复方式固定 `full`。 |
| `enemies.<敌人ID>` | `name`, `hp`, `attack`, `defense`, `speed`, `skills` | `strategy`, `lines`, `battleValues` | 无技能也须填 `skills: []`。引用的技能须没有普通属性消耗。策略 `lowest-hp/random`，默认 `lowest-hp`。 |
| 敌人的 `lines` | — | `encounter`, `defeated` | 遭遇、败北台词。 |
| `maps[]` | `locationId`, `narration` | `enemies`, `engage`, `drops`, `chest`, `exits`, `scripted` | 每个地点最多一张地图。接敌方式 `on-enter/optional`，默认进场接敌。宝箱物品须初始就在本地图。有掉落物时根级 `vault` 必填，掉落物须初始位于该地点且只能分配一次。 |
| 地图的 `narration` | `first` | `again` | 初次进场与再次进场的叙述。 |
| `exits[]` | `to` | `requires`, `lockedReason` | 目的地、通行要求、锁门原因。填 `requires` 就必填 `holds` 物品 ID；同张地图的出口目的地须唯一。 |
| `scripted[]` | `when`, `characterId`，以及 `say`、`skill` 至少一项 | `round`, `target` 有条件 | `when` 为 `enter/encounter/turn/enemy-defeated`。只有 `turn` 必填且允许正整数 `round`。只有 `encounter/turn` 可指定角色已有的 `skill`；选填 `target` 时须同时指定技能，目标须是本地图敌人。 |
| `defeat` | `to`, `restore` | — | 败北去向与按属性键填写的恢复量，允许 `restore: {}`。 |
| 根级 `retreat` | — | `stay/back` | 默认 `stay`。填 `back` 时必须提供 `defeat`。 |
| `party` | `leader` | `lockDuringBattle` | 队长须在本配置的 `characters` 中，战中锁队默认 `true`。 |

### 战斗数值、条件与效果

| 对象或分支 | 必填 | 选填或条件 | 含义 |
| --- | --- | --- | --- |
| 根级 `battleValues` | — | `shared`, `attributes`, `resources` | 三个按自定义键分组的对象，分别定义共享值、单位属性、单位资源，每类最多 16 项。 |
| 各组的 `<键>` | `label`, `initial`, `min`, `max` | 资源独有 `onHpLoss`, `onZeroStatus` | 初值必须介于上下界，资源下界固定 0。资源可配置损血联动与归零时施加的已声明状态。 |
| 单个角色或敌人的 `battleValues` | — | `attributes`, `resources` | 按已有键覆盖单位初值，值必须在该定义的范围内。 |
| 技能 `requires[]` | `value`, `atLeast` | — | 施放门槛；`value` 引用共享值或行动者属性/资源。提供此列表时接受 1–4 项。 |
| 伤害或治疗的 `adjustments[]` | `value`, `multiplier` | — | 数值修正；乘数 −10 到 10，提供时 1–4 项。 |
| 上述两处的 `value` 引用 | `scope`, `key` | 作用域为 `actor/target` 时必填 `kind`，取 `attribute/resource` | `shared` 引用共享键。`target` 只用于效果调整。 |
| `effects[]` 的伤害、治疗 | `kind` 为 `damage/heal`，`amount` | `adjustments`；伤害还可填 `element`, `resistance` | 正整数基础量 1–9999。元素目前支持 `fire`，抗性引用已声明单位属性。战斗状态的 `tick` 同此行。 |
| 施加状态 | `kind: "status"`, `status` | — | 引用 `combatStatuses` 中的状态 ID。 |
| 护盾 | `kind: "shield"`, `amount`, `turns` | — | 护盾量 1–9999，持续 1–99 次。 |
| 净化 | `kind: "cleanse"`, `polarity: "negative"` | — | 清除负面状态。 |
| 改变战斗数值 | `kind: "value"`, `scope`, `key`, `delta` | — | `shared` 写共享值，`actor/target` 写单位资源；改变量须为非零整数。 |

敌人的 `skills` 必填，可使用空数组。装备的 `resistances` 选填，提供时必须填写 `fire`，取 0–75 的整数。工作台和 CLI 返回同一份字段 Schema，运行时也检查这两项。若配置了 `defeat`，正式入口还要求提供 `restore`。[字段 Schema](../../../packages/plugins/src/rpg/config-schema.json) · [跨字段校验](../../../packages/plugins/src/rpg/config.ts) · [数值校验](../../../packages/plugins/src/rpg/value-config.ts) · [地图默认值](../../../packages/plugins/src/rpg/map-activity.ts)

## TRPG 跑团

选用 `official-trpg` 和 `official-dice`，把 `trpg.json` 或指定的配置文件列入资产。角色卡模板决定数值、技能和骰子。没有预写剧本或题目时，玩家可在开团时输入题目。[雨夜庄园示例](../../../packages/plugins/src/trpg/fixtures/rainy-manor.trpg.json)

| 对象 | 必填 | 选填或条件 | 创作含义 |
| --- | --- | --- | --- |
| 文件根 | `plugin`, `sheet` | `characters`, `hosts`, `scenarios`, `themes` | 启用跑团要求世界有玩家角色。宿主从基础包取得玩家 ID 和角色名。 |
| `plugin` | `id: "official-trpg"`, `version: "1"` | — | 插件身份。 |
| `sheet` | `stats`, `skills`, `dice` | — | 1–8 项数值、1–12 项技能；默认检定骰如 `d20`、`2d6+1`。 |
| `sheet.stats[]` | `key`, `label`, `max` | — | 模板键、名称、上限（1–1000）。未覆盖的初值取上限。 |
| `sheet.skills[]` | `key`, `label`, `modifier` | — | 检定技能键、名称、默认修正（−100 到 100）。 |
| `characters.<AI角色ID>` | — | `stats`, `skills` | 用模板键分别覆盖初始数值和技能修正，可只覆盖个别项。 |
| `hosts[]`, `themes[]` | — | 两个列表都选填 | 主持名单填写时为 1–8 个不重复的 AI 角色；省略时参与的 AI 角色均可主持。预设题目填写时为 1–16 个不重复的字符串。 |
| `scenarios[]` | `id`, `title`, `opening`, `truth`, `endings`, `content` | — | 一旦写剧本就填齐这六项。`truth` 和结局由主持人掌握。结局 1–8 条，`content` 允许空数组。 |
| `scenarios[].content[]` | `kind`, `name`, `description`, `public` | `location` | 类型为 `place/item/npc`，同一剧本内名字唯一。位置引用本剧本地点的**名字**。公开条目指定的位置也必须公开。 |

字段和默认值取自 [TRPG Schema](../../../packages/plugins/src/trpg/config-schema.json)、[解析器](../../../packages/plugins/src/trpg/config.ts)和[加载入口](../../../packages/plugins/src/trpg/content.ts)。插件将含角色名和玩家 ID 的最终活动配置限制为 256 KiB。
