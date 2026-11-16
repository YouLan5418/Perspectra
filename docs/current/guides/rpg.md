# 创作者：RPG 玩法

2026-11-08 当前源码（分支 `feat/rpg-plugin`）：官方 RPG 机制 [official-rpg](../../../packages/plugins/src/rpg) 按世界包里的 `rpg.json` 生成战斗、队伍与每张地图的副本活动。验证范围分开看：

- **源码已接通**：配置校验、状态模块、地图活动、锁门与队伍随行、宿主载入与存档摘要、包透视与 `worldpack validate`。
- **自动测试范围**：上述各项都有单元测试或真实宿主测试，见第 7 节；验收包的三份推演通过。
- **真实体验验收**：已有山脚遗迹的 GLM 试玩记录。灼烧、抗火和无固定技能的战斗仍待真实互动验收。 [试玩记录](../studies/2026-11-08-hill-ruins-glm-playtest.md)
- **发行包**：未重建，随程序发行的是否包含此机制以发行说明为准。

## 1. 一个例子

玩家在客厅对澄说：“陪我去屋后的遗迹看看吧。”澄自己决定入队（她的选项里有“加入队伍”，只有她本人能选）。玩家走进遗迹一层，澄随行。到达时旁白出现：“石廊潮湿阴冷……”守卫喊“擅入者，止步”。作者写好的演出让澄说“小心，它的护甲很硬！”并放出火球，守卫生命 50 → 36，然后轮到玩家。玩家选“使用技能”，火球术，目标遗迹守卫。澄在自己的回合再来一发，玩家补上一刀，守卫倒下，铁钥匙落在地上。玩家拿起钥匙，铁门打开；二层有一个木箱，里面是一瓶药水。玩家回家，在卧室睡一觉，生命回满。留在客厅的阿茹只看见他们出门，直到玩家开口讲，才知道遗迹里发生了什么。

哪些由程序裁定，哪些由角色决定：伤害、生命、钥匙掉落、锁门、战败传送回家由程序按 `rpg.json` 裁定；澄是否入队、没写死时她用什么技能、说什么，由她自己决定；阿茹不在场，只收到“玩家和澄离开了客厅”。作者写死的演出（上面的火球和那句话）是作者的选择，写进 `rpg.json` 的 `scripted`，程序照做。

完整的可运行例子是[山脚遗迹](../../../examples/world-packs/hill-ruins/README.md)，下面所有字段都以它的 [rpg.json](../../../examples/world-packs/hill-ruins/rpg.json) 为例。

## 2. 它怎么接入

- 在 `worldpack.source.json` 的 `assetFiles` 里登记 `rpg.json`，同时登记[物品规则脚本](activity-and-variables.md)（`scripts/status.js`，用 Skill 的 `status-items.js` 模板）：宝箱和掉落物都靠包自己的“拿起”取走。
- 宿主在打开世界时读 `rpg.json`，生成一个状态模块（模块 ID `rpg`）、一个规则层，以及每张地图一个活动 `rpg-map-<地点ID去掉 location: 前缀>`。生成的内容不写回包目录。代码入口：[生成器](../../../packages/plugins/src/rpg/content.ts)（经 `ctx.content` 注册，宿主用通用的[包内容载入](../../../apps/host/src/runtime/pack-content.ts)）、[配置解析](../../../packages/plugins/src/rpg/config.ts)、[状态模块](../../../packages/plugins/src/rpg/status-module.ts)、[地图活动](../../../packages/plugins/src/rpg/map-activity.ts)、[规则层](../../../packages/plugins/src/rpg/rules.ts)；取舍见[决策记录](../../superpowers/specs/2026-11-08-rpg-plugin-decisions.md)。
- 包里不能再有叫 `rpg` 的模块或叫 `rpg-map-*` 的活动，重名会拒绝。
- 程序没有 RPG 机制，或版本不同，包在世界创建前就失败：“这个包的 rpg.json 需要插件 official-rpg 1，当前组合没有提供”；版本不同时是“rpg.json 需要插件 official-rpg 2，当前程序提供 official-rpg 1”。
- 没有 `rpg.json` 的包行为不变。

玩家看到的状态和操作：`rpg-<属性键>`（当前值）、`rpg-<属性键>-max`（上限）、`rpg-equipment`、`rpg-party`；状态操作 `status:rpg-rest`、`rpg-use`、`rpg-equip`、`rpg-unequip`、`rpg-join`、`rpg-leave`；战斗中的活动操作“使用技能”“防御”“撤退”，`engage: optional` 的地图在待命阶段另有“开战”“离开”。

## 3. 字段手册

所有对象里不认识的字段都会报错并写出路径。数值是 0 到 100000 的整数。每个字段都写出示例包里的值。

### plugin
`{ "id": "official-rpg", "version": "1" }`，固定写法。

### stats：属性
```json
{ "key": "hp", "label": "生命", "locations": ["location:ruin-1", "location:ruin-2"] }
```
- `key`：小写字母开头，只含小写字母、数字、连字符，至多 33 字符；最多 31 项。有敌人的地图必须有名为 `hp` 的属性，它是战斗中的生命。
- `label`：显示名，至多 36 字。
- `locations`：可选，写了就只在这些地点显示。**只决定谁看得见，不禁止在别处修改**，所以在家睡觉能回血。山脚遗迹把生命和魔力只显示在遗迹里，在家时状态栏没有它们（用包透视的状态栏核对过）。

### characters：战斗角色
```json
"character:cheng": { "stats": { "hp": 30, "mp": 12 }, "attack": 0, "defense": 1, "speed": 20,
                     "skills": ["strike", "fire", "heal"], "slots": ["weapon"] }
```
键必须是包里已有的角色。`stats` 要写全每一项属性，既是初值也是上限；`attack`、`defense`、`speed` 必填；`skills` 是技能 ID；`slots` 是装备位名称。玩家和同伴都写在这里。**除玩家以外，这里写的所有角色都是“同行 NPC”**，见第 6 节。

### skills：技能（唯一格式）
```json
{ "id": "fire", "name": "火球术", "target": "opponent", "scope": "one", "cost": { "mp": 3 },
  "effects": [{ "kind": "damage", "amount": 16, "element": "fire" }, { "kind": "status", "status": "burn" }] }
```
- `target` 必填，按施法者相对关系解释：`opponent` 对手、`ally` 同侧、`self` 本人。必须在场存活；没有复活行为。`scope` 为 `one`（默认）或 `all`，self 即使 all 也只影响本人。
- `effects` 必须有 1–8 项，按声明顺序对目标结算。费用在验证当前候选、角色技能、目标和资源后只扣一次，不按目标数或效果数重复扣。纯治疗没有受伤目标时拒绝；净化无负面状态仍是可施放的有效行动。
- 玩家、同伴和敌人共享同一个效果解释器。敌人按配置顺序选第一个有合法目标的技能，沿用最低生命/随机目标策略；敌人没有世界统计资源池，禁止带 cost 的技能；可使用本批活动内 resourceCost。随机目标使用核心记录的骰子 `roll`，不使用 Math.random 或按修订号伪随机。
- 已删除技能顶层 `kind/power/element/inflicts` 和绝对目标 `party/enemy`。旧配置不能加载；迁移说明见下文。

### equipment：装备
```json
"entity:iron-sword": { "slot": "weapon", "attack": 3 }
```
可加 `defense`、`speed`（默认 0）。物品在角色手里并装备到她有的 `slots` 里才计入加成；装备和卸下是状态操作。速度加成不影响出手顺序。

装备可声明 `"resistances": { "fire": 20 }`，表示 20% 火焰抗性。单件允许 0–75 的整数百分比，有效装备相加后最多按 75% 结算。

### combatStatuses 与结算时机

```json
{
  "burn": { "name": "燃烧", "turns": 3, "timing": "after-action", "polarity": "negative", "tick": { "kind": "damage", "amount": 3, "element": "fire" } },
  "fracture": { "name": "破甲", "turns": 3, "timing": "after-action", "polarity": "negative", "modifiers": { "defense": -3 } },
  "focus": { "name": "振奋", "turns": 2, "timing": "round-end", "polarity": "positive", "modifiers": { "attack": 3 } }
}
```

每状态须有 name、turns（1–99）、timing、polarity，以及 tick 或 modifiers（可同时有）。最多 32 个定义。tick 支持正数 amount（1–9999）的 damage/heal；伤害可指定已有 fire 元素，不指定则无元素，治疗不带元素。修正限于 attack、defense、fireResistance，单项整数 -1000…1000。

`after-action` 在持有者有效行动后结算，燃烧默认示例仍用它；防御算有效行动，拒绝、发言、阅读和切视图不算。`round-end` 在固定出手序列完整循环、下一轮开始前结算；按单位列表和状态施加顺序处理。给自己新加的状态也参加当次对应阶段，没有随机持续时间。各状态在自己的阶段先 tick 后减次数；同一单位阶段末统一移除归零状态，因此同阶段的属性修正在该单位周期结算完成前仍有效。轮末结算阶段处理所有在场存活单位，然后检查胜败；不把它伪装成严格同时发生的数学运算。

同单位同 ID 重施只刷新次数，保持施加顺序，不叠层；不同 ID 的属性修正相加。生命归零清理该单位状态/盾，胜败、撤退清空战斗状态。离场单位在下一次有效规则快照移除其状态；不会因为纯 UI 阅读提交清理事件。

### 持续效果与护盾

可组合的一次性效果如下。配置和可运行场景见[MV 启发式实验](../../../examples/rpg-mv/README.md)。

| 效果 | 声明 | 行为 |
| --- | --- | --- |
| 伤害 | `{ "kind":"damage", "amount":8 }` | amount 是基础威力；按同一伤害流水线结算 |
| 治疗 | `{ "kind":"heal", "amount":5 }` | 恢复至 HP 上限，不复活 |
| 状态 | `{ "kind":"status", "status":"fracture" }` | 引用状态定义，立即进入属性修正，因此能影响同技能后续伤害 |
| 护盾 | `{ "kind":"shield", "amount":12, "turns":2 }` | 每单位一个盾，新值完整替换吸收量和持续次数，不叠加 |
| 净化 | `{ "kind":"cleanse", "polarity":"negative" }` | 立即移除目标所有负面状态，保留正面状态和护盾；被移除状态不会在行动末再 tick |

集中属性计算为角色基础＋当前有效装备＋状态平坦修正；攻击/防御限制 0…9999，火抗 0…75。每个效果重新读取当前修正，因此“破甲→伤害”和“伤害→破甲”确有不同。直接伤害：max(1, amount+攻击−防御) → 火抗向下取整（最低1）→ 一次性防御减半向上取整 → 护盾吸收 → 溢出扣 HP。DoT：amount → 火抗（最低1）→ 护盾，不使用基础攻防、不消耗一次性防御。没有命中、暴击、浮动、反射或反击。

护盾在 HP 扣除前吸收，归零破盾；持有者自施当次不扣盾时长，此后每次有效行动在周期状态后扣一次，到零作废。别人施加从持有者下一次行动开始扣，含自动敌方行动。新自施盾可立即吸收自己行动末的 DoT。状态与护盾是不同生命周期，不因净化自动解除护盾。

### 破坏性迁移（本批不兼容旧版）

官方 RPG 持久数据版本提升为 3，只支持 `[3]`；旧版本存档不保证重开，不提供自动迁移或兼容分支。插件标识和包声明版本仍为 official-rpg / 1；这里的 3 是持久数据版本。

1. 旧技能 `{kind:"damage",power:P,element:E,inflicts:S}` 改为 `target:"opponent", effects:[{kind:"damage",amount:P,element:E},{kind:"status",status:S}]`，不存在的可选字段不要填写；治疗改为 ally＋heal 效果。
2. 上一批 effect 技能删除顶层 kind，绝对 party/enemy 改为施法者相对 ally/opponent（敌方技能注意反转），自身专用技能用 self。
3. 旧状态 damage/element 改为 tick；补齐明确 timing、polarity。燃烧用 after-action/negative，再生用 after-action/positive。
4. 当前官方 hill-ruins、测试包、效果例子、实例夹具与当前作者文档已迁移。历史研究文档与独立脚本原型不作为新官方格式入口。

全屏仅显示已授权状态名、剩余次数及其时机、护盾量；规则和费用仍在 Host/核心提交。单人浏览器与多人无头正式路径分开验收；未修前批多人浏览器租约竞争，不代表 Windows 或真实模型验收。

### consumables：消耗品
```json
"entity:potion": { "restore": { "hp": 20 } }
```
`status:rpg-use` 使用，恢复不超过上限。每件只能用一次，用后名字后面加“（已用完）”。

### rest：休息
```json
{ "label": "睡一觉", "locations": ["location:bedroom"], "restore": "full" }
```
在这些地点出现这个选项，把自己的所有属性恢复到上限。`restore` 目前只有 `full`。

### enemies：敌人
```json
"golem": { "name": "遗迹守卫", "hp": 50, "attack": 1, "defense": 2, "speed": 10, "skills": ["strike"],
           "strategy": "lowest-hp",
           "lines": { "encounter": "擅入者，止步。此处不许外人通过。", "defeated": "石廊……终究还是被打开了……" } }
```
- 敌人不是角色，不调用模型，只存在于战斗数据里。台词是作者写死的，不是模型生成。
- `strategy`：`lowest-hp`（默认）打生命最低的我方，`random` 随机。
- `lines.encounter` 战斗开始时说，`lines.defeated` 被打倒时说（可不写）。
- 同一张地图里同种敌人列两次，第二只自动叫“遗迹守卫2”。

### vault
`"vault": "location:vault"`：存放掉落物的地点。有 `drops` 的地图必须配置；掉落物一开始必须在 vault 里，且不能是两张地图的共同掉落。vault 不会出现在任何人的可去地点里，走过去也会被拒绝，所以掉落物不会在战斗前被拿走。

### maps：地图
```json
{ "locationId": "location:ruin-1",
  "narration": { "first": "你们踏进遗迹一层……", "again": "石廊里只剩守卫散落的碎石……" },
  "enemies": ["golem"], "engage": "on-enter", "drops": ["entity:iron-key"],
  "exits": [{ "to": "location:ruin-2", "requires": { "holds": "entity:iron-key" }, "lockedReason": "铁门锁着，需要钥匙。" }],
  "scripted": [ … ] }
```
- `narration.first` 第一次到达，`again` 再次到达（不写就重复 `first`）；到达时发给在场的人。
- `enemies`：敌人 ID 列表。没有敌人的地图只有旁白和演出，开始即结束。
- `engage`：`on-enter`（默认）到达即开战；`optional` 先进入待命，玩家选“开战”或“离开”。
- `drops`：胜利后从 vault 落到本地图地面。胜利记为“已清理”，之后再来没有战斗，也不再掉落。
- `chest`：一件一开始放在本地图地面上的物品，用包自己的“拿起”取走（见第 6 节）。
- `exits`：`to` 目的地；`requires.holds` 是开这扇门的钥匙；`lockedReason` 被拒绝时给玩家的理由，缺省“这条路现在走不通。”。同一目的地只写一个出口。没写的路照常通行。
  - 带钥匙的门一开始锁着。拿着钥匙的人站在这张地图上，会多一个“用{钥匙}开锁”（`status:rpg-unlock`），玩家和同行角色都能用。开锁后门变成已开，记在公共状态 `rpg-unlocked`，之后谁都能过，钥匙不消耗。只拿着钥匙不开锁，门仍然锁着。
  - 例如澄捡起了铁钥匙：玩家走向铁门会被拒绝；澄用钥匙开锁后，玩家不拿钥匙也能过去，队伍照常跟随。

### scripted：写死的演出
```json
{ "when": "encounter", "characterId": "character:cheng", "say": "小心，它的护甲很硬！", "skill": "fire", "target": "golem" }
```
- `when`：`enter` 第一次到达（旁白之后）；`encounter` 战斗开始（敌人开口之后）；`turn` 某一轮该角色的回合，必须同时写 `round`（从 1 起）；`enemy-defeated` 敌人全部倒下后。后三种要求地图有敌人。
- `say`：她说的话；`skill` + `target`（敌人 ID）：她用的技能，只能用于 `encounter` 与 `turn`，且她必须有这项技能。至少写 `say` 或 `skill`。
- 山脚遗迹用了三处：二层的 `enter`（澄说一句话），一层的 `encounter`（话加火球），以及一层第 1 轮的 `turn`（再来一发）。最后一处让推演里澄的回合是确定的。

### defeat、retreat、party
```json
"defeat": { "to": "location:living-room", "restore": { "hp": 1 } },
"retreat": "stay",
"party": { "leader": "character:player", "lockDuringBattle": true }
```
- `defeat`：我方全部倒下时，在场参与者被送到 `to`，并把 `restore` 里的属性设为这些值。有敌人的包应该写。
- `retreat`：`stay`（默认）撤退后留在原地；`back` 同样送回 `defeat.to`，但不套用 `restore`，需要先写 `defeat`。只有玩家能选“撤退”。
- `party.leader`：队长，就是玩家。同伴自己选“加入队伍”入队，入队后队长走到哪她跟到哪。`lockDuringBattle` 默认 true，战斗中不能离队；写 false 则战斗中允许离队。

## 4. 战斗怎么算

- 按速度排出手顺序。第一轮我方先动；比所有我方都快的敌人从第二轮开始动。
- 玩家：使用技能、防御（下次受击伤害减半，向上取整）、撤退。同伴：有写死的演出就照做，否则由她自己决定。敌人按 `strategy` 行动。
- 倒下的人跳过回合，包括开战时的首回合。进图时队伍已经无人能战斗，遇敌会直接结束。开战后我方全部倒下就是失败，敌人全部倒下就是胜利。
- 战斗经过只发给这张地图上的人。不在场的角色（比如留在家里的阿茹）不会收到战斗结果；战败时回家的人里，她只看见他们出现，别的不知道。
- 活动里的生命、魔力以状态为准，活动自己不另存一份。

## 5. 检查你写的

- `worldpack.cmd validate '<源目录>'`：检查字段名、引用的角色/地点/物品/敌人/技能，以及掉落、宝箱、出口规则；生成的地图活动脚本合计不超过 256 KiB，超出在校验阶段报错。
- [包透视](pack-lens.md)：多一个“RPG”分类，列出角色、敌人、装备、消耗品、每张地图与出口条件，生成的地图活动指向 `rpg.json`。
- 在仓库根目录运行 `node --import tsx tests/experiments/hill-ruins-combat-effects.ts`。把打印出的新目录载入 Launcher，拿起并装备客厅里的抗火护甲，邀请澄同行，再去遗迹一层。这个实验配置关闭了遗迹一层的固定技能。
- 推演：`lens simulate '<源目录>' <脚本>.json`。山脚遗迹的三份脚本在 `.perspectra-lens/scenarios/`。常用写法：`npcPlans` 让澄 `{ "kind": "perform", "interact": "status:rpg-join" }`；`{ "activity": "rpg-map-ruin-1", "operation": "skill", "parameters": { "skill": "火球术", "target": "遗迹守卫" } }` 走玩家的战斗回合；`start.status.characters` 改初始生命造出失败场景；`knows` / `doesNotKnow` 检查阿茹有没有收到战斗内容。推演里同伴的战斗回合不能用 `npcPlans` 指定技能，用 `scripted` 的 `turn` 演出让它确定。推演不是试玩。

## 6. 已知限制

第一版不做的：

- 没有等级与经验、格子地图、商店，没有 RPG Maker 桥接。

使用时要知道的：

- **一个宝箱只装一件物品。** 宝箱就是一件放在本地图地面上的物品，用包自己的“拿起”取走，不是新的容器。
- **地图内容要等同行的人都在场才开始。** 同行 NPC 就是 `rpg.json` `characters` 里除玩家以外的角色。其中任何一人不在这张地图，这张地图的旁白和战斗都不会开始，也不报错。所以示例里的阿茹不写进 `characters`。
- **队伍**：只有角色自己能加入；离开的成员不再随行；存下来的队伍名单要到下一次 RPG 操作时才更新，显示可能滞后；她在清理之前回到队长身边，就仍算在队里，不用重新加入。
- **随行发生在队长自己走动时**：没有活动进行时，队长走到哪，和她站在一起的队员跟到哪；在包自己的允许移动的活动里也一样。RPG 地图活动进行中禁止移动，队长走不了，队员也就不动；战败或撤退把参与者一起送走，是活动结果，不是随行。
- **战斗参与者是 `characters` 里配置的同行 NPC**，不是后来加入的任何人。不在 `characters` 里的角色入队后会随行，但战斗里没有她的回合，“战斗中不能离队”也锁不住她。
- **写死的演出**：写死的技能和话照写的执行；技能她负担不起（魔力不够等）时，退回由她自己决定，并在战斗记录里留一条说明；话在技能之后说，不在之前；如果写死的技能直接让战斗以失败或撤退收场，这句话就丢掉了。**写死的演出可能和角色当时知道的事矛盾**，程序不判断，必须真人试玩检查。
- **锁着的出口仍然列在可去的地点里**，走过去才被拒绝并显示作者写的理由。
- **存档会固定生成的规则**：程序升级后若生成的 RPG 内容变了，旧存档打开会失败并写出新旧两个摘要。改 `rpg.json`（包括只有规则层读的出口、锁门理由和队长）也会改变这个摘要，不能续玩旧存档，请用新存档。
- 摘要记在数据目录的 `plugin-set.json`，新建的故事节点及其分享文件也携带这份记录。旧节点或直接打开的存档没有可读摘要时，首次打开按当前内容记录。
- 没有 `defeat` 的包，全灭后生命为 0 并留在原地，需要先恢复生命才能重新开战。
- 战斗里的提示超过 500 字会被截断。
- 战斗裁定按同场参战者实际持有且穿戴的装备计算加成。角色仍只收到有权查看的装备信息与战斗结果。
- 战斗阶段之外，活动只放行物品操作 take、drop、give（物品模板的名字）与 `rpg-*`；包里用了别的物品操作 ID 时，它们在地图的短暂阶段里被暂时挡住。
- 一场战斗里，写死的技能在战斗一开始就用不了时，那条说明会晚一步出现。

## 7. 验证了什么，没验证什么

- 自动测试：[config.test.ts](../../../packages/plugins/src/rpg/config.test.ts)、[status-module.test.ts](../../../packages/plugins/src/rpg/status-module.test.ts)、[map-activity.test.ts](../../../packages/plugins/src/rpg/map-activity.test.ts)；真实宿主：`tests/host/rpg-map-activity.test.ts`、`rpg-perform-path.test.ts`、`rpg-party.test.ts`、`rpg-pack.test.ts`、`lens-rpg.test.ts`、`rpg-story-share.test.ts`。
- 验收包：[山脚遗迹](../../../examples/world-packs/hill-ruins/README.md) 的三份推演通过（通关并回家睡觉、战败回家、阿茹不知道战斗细节）。
- **未验证**：真实模型下的同伴入队意愿、演出自然度、战斗节奏、一局下来的体验；Launcher 窗口与默认舞台上的实际观感；发行包。这些属于下一步手动试玩。

## 作者声明的活动内数值

现在可用 battleValues 声明共享值、单位属性和独立资源，例如暴雨降低火球威力、受击增加怒气、消耗怒气发动技能、架势归零施加破防。配置、边界、时序和复制例子见[战斗数值指南](../../../examples/rpg-values/README.md)。所有结果仍由官方 RPG 活动裁定，默认和专属舞台读取同一授权投影；没有跨活动写回或隐藏数值模式。此批持久数据版本 3，仅接受 3，旧存档不兼容。
