# 用包内规则扩展玩法

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
- resolve(truth, actorId, operationId, parameters, world, targetId) 重查规则；返回 `{ changes, reveals, description, audience, items? }`，或仅返回 `{ rejectReason }`。audience 为 'self'、'scene' 或 `{ characters: [...] }`。
- onRoundEnd(truth, round) 可选，每个玩家回合结束后调用一次，返回 null 或 `{ changes, reveals }`，适合推进游戏时间。

changes 是 `{ holderId, key, value }`，整体替换该键（公共状态 holderId 为 null）；reveals 只写 observerId/holderId/key，值由宿主填入，作者无法告知编造的值。行动者改了自己的状态会自动知道新值；别人引起的变化（比如被偷）不会自动告知失主，失主只看到该值变成“上次确认”。余额不足、偷窃被发现这类玩法失败应作为被接受的结果返回，带上 reveals 和 description；rejectReason 只用于操作根本不成立。仅将明确公开的值设 alwaysKnown；playerTruth 是主动交给玩家前端的真值，不会自动公开给 NPC。所有脚本均为作者可信代码，不应访问凭证或复制宿主内部实现。

## 活动

有局部回合、参与者或胜负的小游戏才用活动：单场写 `scripts/activity.js`，多场写 `scripts/activities/<标识>.js`，都登记进 assetFiles。多场各自保留进度，一次只运行一场，玩家可以暂停一场去玩另一场。脚本定义 `globalThis.activityScript`：

- definition：`{ title, npcIds | participants, operations, opening? }`。npcIds 固定参与者；`participants: { mode: 'player-select', min, max, candidates? }` 让玩家选人（1–8 个 NPC）。operations 每项 `{ id, label, requiresTurn, schema, quick? }`，最多 16 项；start、retry、suspend、resume、abandon 为保留名。opening 是 1–500 字的玩家开场文案。
- initialize、policy、resolve：生成初始状态、限定当前角色可用的操作、同步裁定操作。resolve 也可以附带状态变化，或返回 `playerExpression: { text }`／`{ narration }` 在玩家明确选择的操作中提交公开发言或旁白。
- schedule / onOutcome：等待，或给一个已声明角色一次处理机会；它们收到完整活动状态（含 internal 和所有人的 private），输出只有这一次激活，不进入任何视图。
- 可选：autoStart(truth, world, previous) 在玩家回合结束时按 `when` 布尔数组全部为真自动开始，写了它的活动手动开始也要满足同一组条件；`quick: true` 让仅有玩家、无参数的操作一键开始并执行；simulate 返回固定演出替代一次模型响应；resume 检查暂停后能否继续。

可见范围：public 是参与者共享，不是全世界公开；private 每人只拿到自己的一份，玩家那份会显示在玩家的活动卡片上；internal 不进任何角色视图。active、phase、turn、round 每个参与者都看得到，所以隐藏回合（比如夜里轮到谁）不能写在 turn 里：公开 turn 停在一个不变的中性值，真实行动者记在 internal，并在本人 private 里标“轮到你”，相关操作 `requiresTurn: false`，resolve 自己核对，schedule 读 internal 叫醒对的人。这样做只让其他角色不知道轮到谁；默认舞台只显示“正在回复”，但公共 PlayerView 的 `responders` 仍列出正在处理的角色，活动 revision 也随夜间操作增加，所以不要对玩家宣称接口层面已隐藏。活动不能移动角色、不会自动暂停正在运行的活动，也不替角色决定是否接受邀请或怎样行动。

细节以目标程序附带的同版本说明或可运行源包为准；字段对不上时用 Launcher 新实例实际加载检查，不猜字段声称已接通。

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

跨场景短信（实验）在 assetFiles 登记 `communication.json`：`{ "medium": "短信", "contacts": { "character:player": ["character:a"], "character:a": ["character:player"] } }`。联系人是有向许可，不等于在场；收信人只知道对方这样说，不获得对方房间的视野。想让角色自主时也能发，在 autonomy 的 interactions 加 `experiment:message`。电话尚未接入。

## 插件、预设和界面

`plugins.json` + `plugins/*.js` 是包内插件模块，可以声明需要玩家在 Launcher 启用的本地 Cordis 能力；必需能力缺失时世界打不开并写明缺少什么，可选能力缺失时只隐藏相应操作。包不能自动安装原生代码，用户没要求时不引入。

model-preset.json、role-presets.json 和 frontend/ 是宿主独立读取的扩展；CLI 编译不等于它们已有效。默认沿用官方舞台；只想换风格时在 frontend/ 放 theme.css（从本 Skill 的 `assets/theme.css` 复制，模板逐项标注了每个变量和区域选择器的作用）、portraits/、backgrounds/ 和 stage.json（取景、表情差分、姿势），立绘和背景按 ID 去掉前缀命名，例如 `character:companion` → `portraits/companion.png`。确需整页界面时仅使用公共玩家数据，静态前端不得含角色秘密或 Key。不把模型预设当作规则或权限的替代品。

验收至少覆盖：正确条件下出现选项、条件失效时被拒绝、成功后状态与观察一致、未授权角色没有获得秘密。数据库一致与叙事一致分别检查；未调用真实模型时不能宣布后者通过。
