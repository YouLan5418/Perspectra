# RPG 玩法：rpg.json

## 使用工作台命令

用 `editor mode-candidates <包> <请求.json>` 查询字段可引用的已定义记录，例如 `{"mode":"rpg","path":["skills","0","effects","0","status"]}` 返回可施加的战斗状态。查询属性消耗字典可用 `{"mode":"rpg","path":["skills","0","cost"],"dictionary":true}`。选填 `config` 可从刚新增的草稿状态、技能或资源中选用。写回仍通过 `rpg-save` 校验整个配置。

Codex、Claude Code 和 DSH 都可使用 `worldpack editor` 的同一组命令。所有请求文件均为 UTF-8 JSON。

| 命令 | 请求与返回 |
| --- | --- |
| `gameplay <源包>` | 读取启用玩法、配置文件路径、原始配置、正式字段声明、角色和场景候选、RPG 活动与专属页面绑定。 |
| `rpg-enable <源包> <请求.json>` | 传 `{"location":"location:start"}` 在已有地点生成首场遭遇，已有配置则校验后接入。 |
| `rpg-save <源包> <请求.json>` | 从 `gameplay` 取 `file` 和 `config`。提交 `{file,base,config}`，`base` 为读取的原文对象，`config` 为仅修改所需字段的副本。冲突时重新读取并合并。 |
| `rpg-play <源包> <请求.json>` | 传 `location`，按需传 `scenes` 和 `turns`。先省略操作取得当前候选，再用返回的名称、目标和操作键组装步骤。 |
| `rpg-preview <源包> <请求.json>` | 传相同地点和角色起点，输出本地交互试玩地址。 |
| `item-uses <源包> <请求.json>` | 传 `{id}`，读取物品用途、起始地点、脚本操作和 `actions.allowed`。 |
| `rpg-item-play <源包> <请求.json>` | 消耗品传 `{"kind":"consumable","id":"entity:potion-2","initial":{"hp":15}}`，检查 `values`、`spent`、`reason`。装备传 `{"kind":"equipment","id":"entity:iron-sword","location":"location:ruin-1","skill":"strike"}`，检查 `without`、`withGear`、`difference`。槽位候选从 `gameplay.slots` 读取，通过 `rpg-save` 保存物品效果与角色槽位。 |
| `item-actions-save <源包> <请求.json>` | 传 `{id,base,allowed}`。从 `actions.allowed` 取 base，提交含 take、drop、give 三个布尔值的 allowed。支持官方物品模板，自定义状态脚本通过源码编辑。 |
| `rpg-exit-play <源包> <请求.json>` | 试玩本图掉落钥匙的出口。传 `{"location":"location:ruin-1","to":"location:ruin-2","scenes":{"character:cheng":"scene:ruin-1"}}`，核对 `passed` 与每步 `checks`。 |
| `rpg-cue-candidates <源包> <请求.json>` | 提供地图 `location` 和已选的 `when,characterId,skill`，取得当前适用的触发时机、非玩家角色、已学技能和敌人。用 `gameplay.activities[].cues` 查看流程和源行号，修改 `config.maps[].scripted` 后用 `rpg-save` 保存。 |
| `rpg-cue-play <源包> <请求.json>` | 例如 `{"location":"location:ruin-1","index":1}`。可传 `expected` 为刚保存的源行。检查 `played`，以及 `history` 中该行的实际阶段、出手回合、技能结算和发言；未完整触发时读取 `reason`。 |

遗迹守卫的一步试玩请求为 `{"location":"location:ruin-1","scenes":{"character:cheng":"scene:ruin-1"},"turns":[{"operation":"skill","arguments":{"skill":"火球术","target":"遗迹守卫"}}]}`。核对 `initial.status`、`steps[].results` 和 `steps[].after.status`，再用 `worldpack editor export <源包> <新目录>` 导出并重开。

本页说明官方 RPG 机制：作者在包里写一份 `rpg.json`，宿主打开世界时生成战斗、队伍与每张地图的副本活动。核对对象是随目标程序提供的 official-rpg 1；先用目标程序的 `worldpack.cmd validate` 检查，旧程序不认识 `rpg.json` 时会拒绝。

**验证范围（2026-11-08）**：源码已接通；自动测试覆盖配置校验、生成的状态与活动、锁门与随行、认知隔离和存档摘要，`validate` 能校验 `rpg.json`；示例包 `hill-ruins` 的三份推演通过。**没有用真实模型试玩过**：澄会不会愿意入队、固定演出读起来是否自然、战斗节奏好不好，都还没有实测，交付前要真人试玩。

## 1. 先看一段互动

玩家在客厅对澄说：“陪我去屋后的遗迹看看吧。”澄自己决定入队（她的选项里有“加入队伍”，只能她自己选）。玩家走向遗迹一层，澄随行。到达时旁白出现：“石廊潮湿阴冷……”守卫喊“擅入者，止步”，作者写好的澄先说“小心，它的护甲很硬！”并放出火球，守卫生命 50 → 36，然后轮到玩家。玩家选“使用技能 → 火球术 → 遗迹守卫”，澄在自己的回合再来一发，玩家补上一刀，守卫倒下，铁钥匙掉在地上。玩家拿起钥匙，再用钥匙打开铁门，二层木箱里还有一瓶药水。玩家回家睡一觉，生命回满；留在客厅的阿茹只看见他们出门，直到玩家开口讲，才知道遗迹里发生了什么。

这里哪些是程序裁定的，哪些是角色自己的：伤害、生命、钥匙掉落、锁门、传送回家由程序按 `rpg.json` 裁定；澄是否入队、战斗里没写死时她用什么技能、说什么，由她自己决定；阿茹不在场，只收到“玩家和澄离开了客厅”。

## 2. 接入

1. 在 `worldpack.source.json` 的 `assetFiles` 登记 `rpg.json`。同时登记物品规则脚本（`scripts/status.js` 里用 `assets/status-items.js` 的拿起、放下、交给模板）：宝箱和掉落物都靠它拿起。
2. `rpg.json` 里每个角色、地点、物品 ID 必须是包里已有的。写错会报出字段路径。
3. 不要在包里再写叫 `rpg` 的模块，或叫 `rpg-map-<地点>` 的活动：宿主生成它们，重名会拒绝。
4. 宿主生成的内容不写回包目录。生成内容的摘要记在存档里；程序升级后若生成结果变了，旧存档打开时会失败并写出新旧两个摘要，用新存档即可。

打开世界后可见的内容：状态 `rpg-<属性键>`、`rpg-<属性键>-max`、`rpg-equipment`、`rpg-party`；角色的状态操作 `status:rpg-rest`、`rpg-use`、`rpg-equip`、`rpg-unequip`、`rpg-join`、`rpg-leave`；每张配置了的地图一个活动 `rpg-map-<地点ID去掉 location: 前缀>`，进入时自动开始。

## 3. 字段

以下以示例包 `hill-ruins` 的 `rpg.json` 为例。所有对象不认识的字段都会报错并写出路径。数值都是 0 到 100000 的整数。

### plugin
`{ "plugin": { "id": "official-rpg", "version": "1" } }`，固定写法。

### stats：属性
```json
{ "key": "hp", "label": "生命", "locations": ["location:ruin-1", "location:ruin-2"] }
```
- `key`：小写字母开头，只含小写字母、数字、连字符，至多 33 字符；最多 31 项。有敌人的地图需要名为 `hp` 的属性，它是战斗中的生命。
- `label`：显示名，至多 36 字。
- `locations`：可选。写了就只在这些地点显示这项属性；**只影响谁看得见，不禁止在别处修改**（所以在家睡觉能回血）。`hill-ruins` 把生命和魔力只显示在遗迹里，在家时状态栏没有它们。

### characters：战斗角色
```json
"character:cheng": { "stats": { "hp": 30, "mp": 12 }, "attack": 0, "defense": 1, "speed": 20, "skills": ["strike","fire","heal"], "slots": ["weapon"] }
```
- 键必须是包里的角色。`stats` 要写全每一项属性，是初值也是上限。`attack` `defense` `speed` 必填。`skills` 是技能 ID，`slots` 是装备位名称。
- 玩家和同伴都要写在这里。除玩家（`party.leader`）外，**这里写的所有角色都是“同行 NPC”**，见限制。

### skills：技能
`{ "id","name","kind":"damage"|"heal","scope":"one"|"all","power","cost":{"mp":3} }`。
- 伤害 = max(1, 技能 power + 施放者 attack − 目标 defense)；治疗直接回复 power，不超过上限。`scope: all` 作用于所有存活的一方。`cost` 的键是属性，不够时不能用。
- 战斗里玩家用的是技能 `name` 和目标显示名。

### equipment：装备
`"entity:iron-sword": { "slot": "weapon", "attack": 3 }`，可加 `defense` `speed`（默认 0）。物品要在角色手里并装备到有对应 `slots` 的位置，战斗才计入加成。装备和卸下是状态操作 `status:rpg-equip` / `rpg-unequip`。

### consumables：消耗品
`"entity:potion": { "restore": { "hp": 20 } }`。使用 `status:rpg-use`，恢复不超过上限；每件只能用一次，用后物品名字后加“（已用完）”。药水是物品，同样靠拿起、给出转手。

### rest：休息
`{ "label": "睡一觉", "locations": ["location:bedroom"], "restore": "full" }`：在这些地点出现这个选项，把自己的所有属性恢复到上限。`restore` 目前只有 `full`。

### enemies：敌人
```json
"golem": { "name": "遗迹守卫", "hp": 50, "attack": 1, "defense": 2, "speed": 10, "skills": ["strike"],
  "strategy": "lowest-hp", "lines": { "encounter": "擅入者，止步。", "defeated": "石廊……终究还是被打开了……" } }
```
- 敌人不是角色，不调用模型，只存在于战斗数据里。`strategy`：`lowest-hp` 打生命最低的我方，`random` 随机，默认 `lowest-hp`。
- `lines.encounter` 在战斗开始时说，`defeated` 在被打倒时说。这是作者写死的敌方台词。
- 同一张地图里同种敌人写两次，第二只自动叫 `遗迹守卫2`。

### vault
存放掉落物的地点（`hill-ruins` 用一个宝库）。有 `drops` 的地图必须配置 `vault`，掉落物一开始必须放在 vault 里。vault 不会出现在任何人的可去地点里，走过去也会被拒绝，所以掉落物不会在战斗前被拿走。

### maps：每张地图一场活动
```json
{ "locationId": "location:ruin-1",
  "narration": { "first": "…", "again": "…" },
  "enemies": ["golem"], "engage": "on-enter", "drops": ["entity:iron-key"],
  "exits": [{ "to": "location:ruin-2", "requires": { "holds": "entity:iron-key" }, "lockedReason": "铁门锁着，需要钥匙。" }],
  "scripted": [ … ] }
```
- `narration.first`：第一次到达时的旁白；`again`：再次到达时的旁白，不写就重复 `first`。旁白在到达时发给在场的人。
- `enemies`：这张地图的敌人 ID（见 `enemies`）。没有敌人的地图只有旁白和固定演出，开始即结束。
- `engage`：`on-enter`（默认）到达即开战；`optional` 先进入待命，玩家选“开战”或“离开”。
- `drops`：胜利后从 vault 落到本地图地面的物品。每件只能是一处的掉落。胜利会记为“已清理”，之后再来既没有战斗也不再掉落。
- `chest`：宝箱，见限制：它就是一件一开始放在本地图地面上的物品，用包自己的“拿起”取走。
- `exits`：出口条件。`to` 是目的地；`requires.holds` 是开这扇门的钥匙；`lockedReason` 是被拒绝时给玩家看的理由（缺省“这条路现在走不通。”）。同一目的地只写一个出口。没写出口的路照常通行。
  - 带钥匙的门一开始锁着。拿着钥匙的人在这张地图上可以“用{钥匙}开锁”（`status:rpg-unlock`），玩家和同行角色都能用。开锁后门变成已开（公共状态 `rpg-unlocked`），之后谁都能过，钥匙不消耗。只拿着钥匙不开锁，门仍然锁着。

### scripted：写死的演出
```json
{ "when": "encounter", "characterId": "character:cheng", "say": "小心，它的护甲很硬！", "skill": "fire", "target": "golem" }
```
- `when`：`enter` 第一次到达时（旁白后）；`encounter` 战斗开始（敌人开口后）；`turn` 某一轮该角色的回合，必须同时写 `round`（从 1 起）；`enemy-defeated` 敌人全部倒下后。后三种需要地图有敌人。
- `say`：她说的话；`skill` + `target`（敌人 ID）：她放的技能，只能用于 `encounter` 和 `turn`，且她得有这项技能。`say` 和 `skill` 至少写一个。
- 效果：写死的技能按规则裁定，和别的行动一样提交；话在技能之后说。**写死的演出是作者的选择，不是角色的选择**；这是为了让关键场面确定，别滥用。没写演出的回合，同伴由她自己（模型）决定。

### defeat、retreat
- `defeat`: `{ "to": "location:living-room", "restore": { "hp": 1 } }`：队伍全部倒下时，在场的参与者被送到 `to`，并把 `restore` 里的属性设为这些值（醒来时大家都回到了客厅）。不写 `defeat` 则全灭后留在原地，生命为 0，需要先恢复生命才能重新开战。
- `retreat`: `stay`（默认）撤退后留在原地；`back` 撤退也送回 `defeat.to`（不套用 `restore`），需要先写 `defeat`。只有玩家能选“撤退”。

### party：队伍

有队友需要在剧情中告别时，出发前核对实际队伍名单；玩家移动会带走同地的队员。退场后的行动范围和返程验收见[角色退场](gameplay.md#角色退场)。

`{ "leader": "character:player", "lockDuringBattle": true }`。启用队伍后必填 `leader`，队长与可入队的成员都来自 `config.characters`。同场成员可自行加入并随行。`lockDuringBattle` 选填，默认 true，设为 false 允许参战成员离队。

用 `gameplay` 读取包内候选和 `file`，用 `rpg-save` 提交 `file,base,config`。随后执行 `worldpack editor rpg-journey-play <源包> <请求.json>`。

| 目标 | 请求 | 核对输出 |
| --- | --- | --- |
| 卧室休息 | `{"kind":"rest","location":"location:bedroom"}` | `available` 为真时查看各属性的 `before/after/max`。也可以选择非休息点检查操作是否隐藏。 |
| 战败返回 | `{"kind":"defeat","location":"location:ruin-1"}` | 在有敌人的地图上低生命开局并防御，核对 `phase`、`destination`、`participants` 的实际地点和属性。 |
| 撤退 | `{"kind":"retreat","location":"location:ruin-1"}` | 核对 `fled` 阶段、实际落点和撤退前后的属性。 |
| 入队、随行和离队 | `{"kind":"party","member":"character:cheng","from":"location:living-room","to":"location:bedroom"}` | 选另一名 RPG 角色和两个有场景的普通地点，核对 `joined/followed/left/stayed`。 |

## 4. 战斗怎么算

- 一场战斗按速度排顺序（`speed` 大的先）。第一轮我方先动；比所有我方都快的敌人从第二轮开始动。装备的速度加成不影响顺序。
- 轮到玩家：使用技能、防御（下一次受击伤害减半，向上取整）、撤退。同伴按写死的演出，或由她自己决定。敌人按 `strategy` 行动。
- 倒下的人跳过回合；我方全部倒下就是失败，敌人全部倒下就是胜利。
- 战斗中角色只知道自己所在地图的战斗经过；不在场的人（比如留在家里的阿茹）不会收到战斗结果。

## 5. 限制与注意

- 第一版不做等级与经验、格子地图、商店、RPG Maker 桥接。
- **一个宝箱只装一件物品。** 宝箱就是一件放在本地图地面上的物品，用包自己的“拿起”取走，不是新的容器。
- **地图内容要等“同行的人”都在场才开始。** 同行 NPC 就是 `rpg.json` `characters` 里除玩家外的所有角色。其中任何一人不在这张地图，这张地图的旁白和战斗都不会开始，也不报错。所以示例包里的阿茹没有写进 `characters`。
- **队伍**：只有角色自己能加入；离开所在地的成员不再随行；存下来的队伍名单要到下一次 RPG 操作时才更新，显示可能滞后；她在清理之前回到队长身边，就仍算在队里，不用重新加入。
- **随行发生在队长自己走动时**：没有活动进行时，队长走到哪，和她站在一起的队员跟到哪；在包自己的允许移动的活动里也一样。RPG 地图活动进行中禁止移动，队长走不了，队员也不动；战败或撤退把参与者一起送走，是活动结果，不是随行。
- **战斗参与者是 `characters` 里配置的同行 NPC**，不是后来加入的任何人。不在 `characters` 里的角色入队后会随行，但战斗里没有她的回合，“战斗中不能离队”也锁不住她。
- **写死的演出**：照写的执行；写死的技能她负担不起（魔力不够等）时，退回由她自己决定，并在战斗记录里留一条说明；话在技能之后说；如果写死的技能直接让战斗以失败或撤退收场，这句话就丢掉了。**写死的演出可能和角色当时知道的事矛盾**（比如她不该知道这个敌人的弱点），必须真人试玩检查，程序不判断。
- **锁着的出口仍然列在可去的地点里**，走过去才被拒绝并显示作者写的理由。
- 存档会固定生成的规则。程序升级或改 `rpg.json`（包括出口、锁门理由、队长）导致生成内容变化后，旧存档打开会失败。新建的故事节点及其分享文件也携带摘要，导入或续玩时会校验。缺少可读摘要的旧节点或直接打开的存档，首次打开时按当前内容记录。
- 每张地图的活动脚本合计受 256 KiB 限制；超出在校验阶段报错。
- 同种敌人的第二只叫“名字2”；战斗里的提示超过 500 字会被截断。
- 战斗按同场参战者实际持有且穿戴的装备计算加成。伤害技能可写 `element: "fire"`，并用 `inflicts` 引用 `combatStatuses` 中的状态。状态配置 `name`、`turns`、`damage`、`element: "fire"`。在持有者有效行动后扣血、减少剩余回合，同名状态刷新持续时间。装备的 `resistances.fire` 为 0–75 的整数百分比，影响直接与持续火焰伤害。技能消耗排除生命，敌方技能消耗留空。
- 战斗中玩家只能做活动给的操作；包自己的拿起、放下、交给在战斗阶段之外可用。物品操作 ID 若不是模板的 take、drop、give，在短暂的地图阶段内会被暂时挡住。

## 6. 校验与推演

- `worldpack.cmd validate '<源目录>'`：检查 `rpg.json`，包括字段名、引用的角色、地点、物品、敌人、技能，以及掉落、宝箱、出口规则。
- `worldpack.cmd editor gameplay '<源目录>'` 读取 RPG 配置及生成的地图活动键。
- `worldpack.cmd simulate '<源目录>' '<脚本>.json'`：推演。常用写法：用 `npcPlans` 让同伴 `{ "kind": "perform", "interact": "status:rpg-join" }`；用 `{ "activity": "rpg-map-ruin-1", "operation": "skill", "parameters": { "skill": "火球术", "target": "遗迹守卫" } }` 走玩家的战斗回合；用 `start.status.characters` 改初始生命来造出失败场景；用 `knows` / `doesNotKnow` 检查阿茹有没有收到战斗内容。推演里同伴的战斗回合用不了 `npcPlans` 指定技能，用 `scripted` 的 `turn` 演出让它确定。
- 推演不是试玩：桩模型不说真话，同伴会不会入队、战斗读起来是否自然，都要真实模型试玩。

## 7. 示例

`hill-ruins` 是这套机制的验收包：山脚小屋、两层遗迹、铁钥匙和宝箱，同伴澄和留在家里的阿茹。照它的 `rpg.json` 复制改写最快；它的推演脚本在 `scenarios/` 下：通关并回家睡觉、战败回家、阿茹不知道战斗细节。
