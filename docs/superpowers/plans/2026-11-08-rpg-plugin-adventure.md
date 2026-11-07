# RPG 插件与小型冒险包 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 作者写一份 `rpg.json`，就能得到数值、技能、装备、敌人、队伍和文字副本，并配一个从家到副本再回家的冒险包作为验收。

**Architecture：**
- 新包 `packages/official-rpg` 校验 `rpg.json`，把它与随插件分发的共享规则合成为现有机制能加载的内容：一个状态模块，以及每张地图一场活动。它还注册一个规则层，负责锁门和队伍随行。
- 宿主在打开世界时载入这些生成内容，并把生成内容的摘要记进世界，用来保证存档一致。
- 核心只做三处扩展：
  - 状态可按地点限定显示；
  - 一次结算里任何角色的移动，都得到场景转换和移动观察；
  - 活动结果可以移动角色，并一次移动多件物品。

**Tech Stack：** TypeScript strict、ESM、显式 `.ts` 导入、vitest、node:vm 作者脚本、Cordis、SQLite 事件存储。

**Spec：** [docs/superpowers/specs/2026-11-08-rpg-plugin-adventure-design.md](../specs/2026-11-08-rpg-plugin-adventure-design.md)

## Global Constraints

- 全部在分支 `feat/rpg-plugin` 上。
- 原则：作者没写的地方由角色决定；作者明确写下的演出照做，并照常走规则裁定和事件提交。
- 只产出核心认识的事件，不新增 eventType。
- 数值借现有状态机制保存，不另建存储。
- 背包就是物品归属，不另存一份。
- 脚本限制照旧：单次 hook 100 ms，状态脚本合计与活动脚本各 256 KiB，状态定义 64 个，操作 32 个，状态值合计 512 KiB，模块状态键以 `<模块ID>-` 开头。超出时在校验阶段报错。
- 必需插件缺失，或生成内容摘要与世界记录不一致时，世界打开前失败，报错写明缺什么或哪里不一致。
- 没有 `rpg.json` 的包行为不变。
- 每个任务完成时运行 `corepack pnpm@11.7.0 typecheck` 和该任务列出的测试。
- 涉及 `docs/current` 的改动，运行 `node scripts/docs/check-links.mjs`。

## Review Focus

1. 作者把同一个角色写进两张地图的固定演出，或在她魔力不足时写死技能：应按规则拒绝并告诉作者原因，不卡死战斗。测试在 Task 6。
2. 战败传送时有队员不在战斗地图上（比如中途离队了）：只传送活动参与者，不在场的人位置不变、看不到战斗细节。测试在 Task 6。
3. 已有存档在插件升级后打开：生成内容摘要不一致时明确报错，不静默换规则。测试在 Task 8。
4. 队长移动时某队员在别处：她不随行，也不再算在队里。测试在 Task 7。
5. `rpg.json` 引用了包里不存在的角色、地点或物品：校验报出 JSON 路径和缺失的 ID，世界不会打开到一半才失败。测试在 Task 5。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `docs/superpowers/specs/2026-11-08-rpg-plugin-decisions.md` | Task 1 的取舍记录 |
| `packages/application/src/status-state.ts` | 状态声明新增 `locations`，`known()` 按观察者所在地点过滤 |
| `packages/application/src/move-effects.ts`（新） | 为一次结算里的每条 `character.moved` 生成场景转换和观察对象 |
| `packages/application/src/immediate-action.ts`、`round-coordinator.ts`、`character-turn.ts` | 改用 `move-effects.ts`，不再只处理行动者 |
| `packages/application/src/activity-projection.ts` | 活动结果可带 `moves`、`items` |
| `desktop/host/activity-runtime.ts` | 把 `moves`、`items` 转成事件，与 `activity.updated` 同一次提交 |
| `packages/official-rpg/`（新包） | `config.ts` 校验；`status-module.ts`、`map-activity.ts` 生成；`runtime/*.js` 共享规则；`rules.ts` 锁门与随行；`index.ts` 是 Cordis 入口 |
| `desktop/host/rpg-pack.ts`（新） | 读 `rpg.json`，调用生成，交给活动源与包模块，计算并核对摘要 |
| `desktop/host/activity-source.ts`、`pack-modules.ts`、`world-runtime.ts` | 接入生成内容 |
| `desktop/official-bundle.ts` | 安装 official-rpg |
| `desktop/lens/view.ts` | 透视显示 RPG 数据 |
| `examples/world-packs/hill-ruins/`（新） | 验收包 |
| `skills/perspectra-creator/references/rpg.md`（新）、`docs/current/guides/rpg.md`（新） | 作者文档 |

---

### Task 1：取舍记录与包骨架

**Files:**
- Create: `docs/superpowers/specs/2026-11-08-rpg-plugin-decisions.md`
- Create: `packages/official-rpg/package.json`、`tsconfig.json`、`src/index.ts`，照 `packages/official-pacing` 的结构
- Modify: `docs/current/architecture/modules.md`

**Interfaces:**
- Produces: workspace 包 `@harness-world/official-rpg`，导出 `OFFICIAL_RPG_ID = 'official-rpg'` 与 `OFFICIAL_RPG_VERSION = '1'`

- [ ] **Step 1：写取舍记录。** 只记下面四条决定及理由，每条注明它替代了什么：
  1. 形态：随程序的 Cordis 机制包，在世界打开时生成脚本。理由是活动源本来就是脚本源码，状态模块已经能拼进状态脚本，不需要新的提交路径。替代：10-26 的作者端生成器 `examples/rpg-core/generate.mjs`。
  2. 随行接缝：用 `ctx.rules` 的 resolve 中间件，在队长的移动被接受后追加队员的 `character.moved`；场景转换由 Task 3 统一处理。替代：牵手的移动后生命周期规则（它只能结束关系，不能移动人）。
  3. 状态 `locations` 只影响“谁看得见”，不禁止改动。理由是在家睡觉回血需要在家里改生命。
  4. 地图剧情、固定演出与战斗合并成每张地图一场活动：进入时自动开始，开场旁白用活动现有的 `notice` / `sceneNotice`。理由是一次只能运行一场活动。
- [ ] **Step 2：建包骨架**，并在模块地图里登记一行职责。
- [ ] **Step 3：验证。** 运行 `corepack pnpm@11.7.0 typecheck` 和 `node scripts/docs/check-links.mjs`，预期无错误。
- [ ] **Step 4：提交。** `git commit -m "docs: record RPG plugin decisions and add the official-rpg package"`

---

### Task 2：状态按地点限定显示

**Files:**
- Modify: `packages/application/src/status-state.ts:132-160`（声明解析）与 `:259`（`known`）
- Test: `packages/application/src/status-state.test.ts`（没有则新建）

**Interfaces:**
- Produces: 状态声明可选字段 `locations: string[]`（非空、元素唯一）。`known(events, observerId)` 只返回 `locations` 为空，或包含观察者当前地点的状态；观察者当前地点取自事件中她最新的 `character.moved`，没有则取初始地点。

- [ ] **Step 1：写失败的测试。**
  - `it('a status limited to dungeon locations is not known at home')`：声明 `{ key:'rpg-hp', owner:'character', locations:['location:ruin-1'] }`，观察者在 `location:home`。断言 `known()` 不含 `rpg-hp`；移到 `location:ruin-1` 后包含，值不变。
  - `it('rejects an empty or duplicate locations list')`：断言抛出 TypeError，消息包含 `locations`。
- [ ] **Step 2：运行测试，确认失败。** `corepack pnpm@11.7.0 exec vitest run packages/application/src/status-state.test.ts`
- [ ] **Step 3：实现。** 在 `exact()` 的可选字段里加入 `'locations'` 并校验；`known()` 末尾按地点过滤。改动、reveal、`playerTruth` 都不受影响。
- [ ] **Step 4：运行测试和** `tests/host/pack-status*.test.ts`，预期全部通过。
- [ ] **Step 5：更新文档。** 在 `docs/current/guides/activity-and-variables.md` 的状态字段表里加 `locations` 一项。
- [ ] **Step 6：提交。** `git commit -m "feat: let a status show only at declared locations"`

---

### Task 3：一次结算里每个移动都得到场景转换和观察

**Files:**
- Create: `packages/application/src/move-effects.ts`
- Modify: `packages/application/src/immediate-action.ts:36-60`、`round-coordinator.ts:457,498,686`、`character-turn.ts:615-625`
- Test: `packages/application/src/move-effects.test.ts`、`tests/host/immediate-action.test.ts`（补用例）

**Interfaces:**
- Produces:

```ts
export function moveEffects(input: {
  scene: SceneDecisionService
  address: WorldAddress
  events: readonly RulebookEvent[]
  headSeq: number
  drafts: readonly WorldEventDraft[]
}): { transitions: WorldEventDraft[]; moved: { characterId: CharacterId; fromLocationId: string; toLocationId: string }[] }
```

  它对 `drafts` 中每条 `character.moved` 依次调用 `scene.transitionForMove`，每次的前缀包含前面已生成的转换。三处调用点改用它，不再只看行动者。观察沿用 `immediate-action.ts` 的 `movementRoute` 思路：对每个被移动者，留下的人看到她离开，到达处的人看到她到来。

- [ ] **Step 1：写失败的测试。**
  - `it('gives a scene transition to every moved character, not only the actor')`：一次结算里有行动者和另一角色两条 `character.moved`。断言两人各有 `scene.member_left` 与 `scene.member_joined`（或 `scene.activated`）。
  - `it('those left behind see each mover leave and those at the destination see her arrive')`：断言两人的离开、到达观察都存在，且落在正确的观察者视图里。可用 `CharacterViewBuilder` 读取。
- [ ] **Step 2：运行测试，确认失败。**
- [ ] **Step 3：实现 `moveEffects`，并替换三处调用点。** 只有行动者移动时，行为必须与现在完全一致。
- [ ] **Step 4：运行** `corepack pnpm@11.7.0 test`（全部），预期全部通过。现有移动测试不应有任何改动。
- [ ] **Step 5：提交。** `git commit -m "feat: scene transitions and observations for every move in a resolution"`

---

### Task 4：活动结果可以移动角色与多件物品

**Files:**
- Modify: `packages/application/src/activity-projection.ts:105-135`
- Modify: `desktop/host/activity-runtime.ts:312-385`
- Modify: `packages/application/src/item-effects.ts`（复用物品校验，放宽上限）
- Test: `packages/application/src/activity-projection.test.ts`、`tests/host/pack-activity.test.ts`

**Interfaces:**
- Produces：活动 resolve 的可选返回字段：
  - `moves: { characterId: string; locationId: string }[]`：最多 8 项；`characterId` 必须是活动参与者，`locationId` 必须是包内地点。
  - `items: { entityId: string; to: { holderId: string } | { locationId: string }; kind?: string }[]`：最多 16 项。与状态操作的 `items` 不同，这里不要求物品够得着、目标不限于行动者所在位置，因为它是作者规则的结果。
  
  它们与 `activity.updated` 同一次提交，移动交给 Task 3 的 `moveEffects`。

- [ ] **Step 1：写失败的测试。**
  - `it('an activity result moves its participants and items in one commit')`：用测试夹具活动返回两人的 `moves` 和三件 `items`。断言事件里有两条 `character.moved`、三条 `entity.transferred`、对应场景转换，且都在同一次提交里。
  - `it('rejects moving a non-participant or to an unknown location')`：断言整次不提交，错误包含 ID。
  - `it('a moved participant left behind sees nothing of the activity afterwards')`：断言传送后，留在原地的非参与者视图里没有之后的 `activity.updated`。
- [ ] **Step 2：运行测试，确认失败。**
- [ ] **Step 3：实现。** 先在 `parseActivityOperationResult` 的 `exact` 里加入 `moves`、`items` 并校验形状；再在 activity-runtime 里生成 `character.moved`（字段与基础移动规则相同）和物品事件，并接到 `moveEffects`。
- [ ] **Step 4：运行测试和** `tests/host/pack-activity.test.ts`、`tests/host/activity-*.test.ts`，预期全部通过。
- [ ] **Step 5：文档。** 在 `docs/current/guides/activity-and-variables.md` 的活动一节加一段，说明 `moves` / `items` 及其上限。
- [ ] **Step 6：提交。** `git commit -m "feat: activity results can move participants and several items"`

---

### Task 5：`rpg.json` 校验与状态模块生成

**Files:**
- Create: `packages/official-rpg/src/config.ts`、`src/status-module.ts`、`src/runtime/status-rules.js`
- Test: `packages/official-rpg/src/config.test.ts`、`src/status-module.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RpgConfig { /* 字段见下方 Step 1 的完整示例 */ }
export function parseRpgConfig(value: unknown, pack: { characterIds: string[]; locationIds: string[]; entityIds: string[] }): RpgConfig
export function generateStatusModule(config: RpgConfig): { declaration: object; source: string }
```

  `parseRpgConfig` 出错时抛出 TypeError，消息以 JSON 路径开头，如 `maps[1].exits[0].to：未知地点 location:x`。模块 ID 固定为 `rpg`，操作 ID 为 `rest`、`use`、`equip`、`unequip`，状态键为 `rpg-<key>`、`rpg-<key>-max`、`rpg-equipment`。

- [ ] **Step 1：写失败的测试。** 以下面这份配置为基准（它也是验收包的初稿），配置的写法由本任务确定：

```json
{
  "plugin": { "id": "official-rpg", "version": "1" },
  "stats": [
    { "key": "hp", "label": "生命", "locations": ["location:ruin-1", "location:ruin-2"] },
    { "key": "mp", "label": "魔力", "locations": ["location:ruin-1", "location:ruin-2"] }
  ],
  "characters": {
    "character:player": { "stats": { "hp": 40, "mp": 8 }, "attack": 2, "defense": 1, "speed": 30, "skills": ["strike", "fire", "heal"], "slots": ["weapon"] },
    "character:cheng": { "stats": { "hp": 30, "mp": 12 }, "attack": 0, "defense": 1, "speed": 20, "skills": ["strike", "fire", "heal"], "slots": ["weapon"] }
  },
  "skills": [
    { "id": "strike", "name": "普通攻击", "kind": "damage", "scope": "one", "power": 8, "cost": {} },
    { "id": "fire", "name": "火球术", "kind": "damage", "scope": "one", "power": 16, "cost": { "mp": 3 } },
    { "id": "heal", "name": "治疗术", "kind": "heal", "scope": "one", "power": 14, "cost": { "mp": 3 } }
  ],
  "equipment": { "entity:iron-sword": { "slot": "weapon", "attack": 3 } },
  "consumables": { "entity:potion": { "restore": { "hp": 20 } } },
  "rest": { "label": "睡一觉", "locations": ["location:bedroom"], "restore": "full" },
  "enemies": {
    "golem": { "name": "遗迹守卫", "hp": 50, "attack": 1, "defense": 2, "speed": 10, "skills": ["strike"], "strategy": "lowest-hp",
      "lines": { "encounter": "擅入者，止步。", "defeated": "你们……终究还是来了。" } }
  },
  "vault": "location:vault",
  "maps": [
    { "locationId": "location:ruin-1", "narration": { "first": "潮湿的石廊，尽头有一扇铁门。", "again": "石廊里只剩守卫的残骸。" },
      "enemies": ["golem"], "engage": "on-enter", "drops": ["entity:iron-key"],
      "exits": [{ "to": "location:ruin-2", "requires": { "holds": "entity:iron-key" }, "lockedReason": "铁门锁着，需要钥匙。" }],
      "scripted": [{ "when": "encounter", "characterId": "character:cheng", "say": "小心，它的护甲很硬！", "skill": "fire", "target": "golem" }] },
    { "locationId": "location:ruin-2", "narration": { "first": "第二层很安静，角落里有一个木箱。" }, "chest": "entity:potion-2",
      "scripted": [{ "when": "enter", "characterId": "character:cheng", "say": "这里好像没人来过。" }] }
  ],
  "defeat": { "to": "location:home", "restore": { "hp": 1 } },
  "retreat": "stay",
  "party": { "leader": "character:player", "lockDuringBattle": true }
}
```

  测试：
  - `it('accepts the reference config')`
  - `it('names the path and the missing id for unknown references')`：分别改坏角色、地点、物品、技能、敌人 ID，断言消息以对应路径开头并包含该 ID。
  - `it('rejects a config whose generated statuses or operations exceed the host limits')`
  - `it('rest restores to max only where declared; use applies a consumable the actor holds; equip requires holding the item and a matching slot')`：用 `node:vm` 执行生成源码中的 `resolve`，就像 `tests/host/pack-status-runtime.test.ts` 那样。断言返回的 `changes`，以及不满足条件时的 `rejectReason`。
- [ ] **Step 2：运行测试，确认失败。** `corepack pnpm@11.7.0 exec vitest run packages/official-rpg`
- [ ] **Step 3：实现。**
  - `parseRpgConfig`：手写校验，风格同 `desktop/lens/scenario.ts` 的 `only` / `fail`。
  - `generateStatusModule`：输出 `globalThis.packPlugin = ...` 源码，方式是把 `runtime/status-rules.js` 的原始字节，加上 `install(<config JSON>)` 调用；生成器按原始字节拼接，不用 `Function#toString`。
  - 装备只记 `{ slot: entityId }`，不检查之后的转移；Task 6 在战斗结算时检查物品是否还在手里。
- [ ] **Step 4：运行测试，预期通过。**
- [ ] **Step 5：提交。** `git commit -m "feat: validate rpg.json and generate the RPG status module"`

---

### Task 6：每张地图一场活动：旁白、固定演出、战斗、掉落、战败

**Files:**
- Create: `packages/official-rpg/src/map-activity.ts`、`src/runtime/map-battle.js`（从 `examples/rpg-core/battle-runtime.js` 迁入并扩展）
- Test: `packages/official-rpg/src/map-activity.test.ts`；`tests/host/rpg-map-activity.test.ts`（真实宿主运行时）

**Interfaces:**
- Consumes: Task 4 的 `moves` / `items`；Task 5 的 `RpgConfig` 与状态键名。
- Produces: `generateMapActivities(config: RpgConfig): { key: string; source: string }[]`，key 为 `rpg-map-<地点ID去掉 location: 前缀>`，每张地图一场活动：
  - `autoStart`：玩家进入该地点即开始。`first` / `again` 旁白放进活动开始时的 `notice`（只给玩家）和 `sceneNotice`（同场所有人）。
  - 阶段依次为：进入时的固定演出（`scripted.when = 'enter'`）、遇敌（`engage: 'on-enter'` 立即开战；`'optional'` 时提供“开战”操作）、战斗回合，最后结束。无敌人、无演出的地图只播旁白，开始后立即结束。
  - `simulate(request)`：按当前阶段与 `scripted` 返回作者写死的回应。`scripted.when` 取 `enter`、`encounter`、`turn`（她的某一次出手回合，用 `round` 指定第几轮）、`enemy-defeated` 四种值。指定了技能时，先返回 `perform` 使用技能操作；拿到执行结果的跟进请求时，再 `publish` 台词。原因是活动里 `canExpressBeforeAction` 为 false，不能附 `before`。只写台词时，直接 `publish`。技能不可用时不写死，回落到模型，同时在活动的 `lastResult` 里写明“写死的技能不可用：原因”。没写死的时机返回 `null`，交给模型。
  - 宝箱：`chest` 物品开局放在 `vault`；地图活动提供“打开宝箱”操作，用 `items` 把它移到开箱者手里，只能开一次。
  - 战斗结算时读取 `rpg-equipment`，只计入当时仍在本人手里的装备。胜利时把 `drops` 从 `vault` 用 `items` 移到该地图的地上。战败时用 `moves` 把全部参与者移到 `defeat.to`，并按 `defeat.restore` 改数值。数值的改动走活动 `status` 字段。
  - 敌人台词放进活动更新的描述文字，标明是敌人说的，不作为角色发言。

- [ ] **Step 1：写失败的测试**（在 `tests/host/rpg-map-activity.test.ts`，用 Task 8 之前的临时接线：测试直接把生成的源码写进临时包的 `scripts/activities/` 和 `plugins/`）：
  - `it('entering ruin-1 shows the first narration and starts the battle; re-entering shows the again text')`
  - `it('a scripted encounter line makes Cheng cast fire with her line, and a scripted skill she cannot afford falls back to the model with the reason recorded')`：魔力设为 0 时断言走了模型（桩模型被调用），且 `lastResult` 包含“不可用”。
  - `it('victory drops the iron key on the floor and anyone can pick it up')`
  - `it('the ruin-2 chest gives the potion to whoever opens it, once')`
  - `it('defeat moves every participant home with hp 1; a party member who had left stays where she is and sees no battle detail')`：用 `CharacterViewBuilder` 断言后者没有战斗观察。
  - `it('an item given away mid-dungeon no longer adds its attack')`
- [ ] **Step 2：运行测试，确认失败。**
- [ ] **Step 3：实现生成器与共享规则。** 单个生成脚本必须小于 256 KiB；超出时在 `parseRpgConfig` 阶段报错。
- [ ] **Step 4：运行测试，预期通过；并运行** `tests/host/pack-activity.test.ts`。
- [ ] **Step 5：提交。** `git commit -m "feat: generate one RPG activity per map with narration, scripted lines and battle"`

---

### Task 7：锁门与队伍随行

**Files:**
- Create: `packages/official-rpg/src/rules.ts`
- Modify: `packages/official-rpg/src/status-module.ts`（队伍操作 `join`、`leave`，公共状态 `rpg-party`）
- Test: `tests/host/rpg-party.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `moveEffects`（自动生效，因为随行的 `character.moved` 位于同一结算里）。
- Produces: `createRpgRules(config: RpgConfig): SeamProvider<RulesInstance>`。
  - `affordances`：去往未满足条件出口的移动目的地仍然列出（玩家能看到门），但执行时被拒绝。
  - `resolve`：移动目的地是 `exits[].to` 且条件不满足时，返回 rejected，理由为 `lockedReason`。队长的移动被接受后，为与队长同一地点的每个队员追加 `character.moved`，字段与基础移动规则一致。“在队”定义为：名字在 `rpg-party` 中，并且与队长同处一地。不同处的人不随行，在队伍显示和角色上下文里也不算在队；她回到队长身边时，需要重新 `join`，原因是 `join` 会把她写回列表，而离开时会被清掉，见下一条。清理发生在她下一次执行任何 RPG 状态操作，或队长下一次移动时：由状态模块在 `resolve` 里顺带把不同处的名字移出列表。规则层不写状态。战斗活动进行中且 `lockDuringBattle` 时，`leave` 被拒绝。
  - 入队由角色自己执行 `status:rpg-join`（目标是队长）；队长不能替别人入队。

- [ ] **Step 1：写失败的测试。**
  - `it('the iron door refuses passage with the author reason until the player holds the key')`
  - `it('Cheng joins only through her own action; the player has no join operation targeting her')`
  - `it('when the player moves, Cheng follows in the same commit and Ah-Ru at home sees both leave')`
  - `it('a member who is elsewhere when the leader moves does not follow and no longer counts as in the party')`
  - `it('leave is refused during a battle when lockDuringBattle is set, and allowed after')`
- [ ] **Step 2：运行测试，确认失败。**
- [ ] **Step 3：实现规则层与队伍操作。** 按上面“在队”的定义实现，并把这条定义补进 Task 1 的取舍记录。
- [ ] **Step 4：运行测试，预期通过；并运行** `corepack pnpm@11.7.0 test`。
- [ ] **Step 5：提交。** `git commit -m "feat: RPG locked exits and party follow"`

---

### Task 8：宿主接线与存档一致性

**Files:**
- Create: `desktop/host/rpg-pack.ts`
- Modify: `desktop/host/activity-source.ts`、`desktop/host/pack-modules.ts`、`desktop/host/world-runtime.ts:542` 附近、`desktop/official-bundle.ts`
- Test: `tests/host/rpg-pack.test.ts`

**Interfaces:**
- Consumes: Tasks 5–7 的生成函数与 `createRpgRules`。
- Produces: `loadRpgContent(packPath: string, pack: CompiledWorldPackV5): { activities: { key: string; source: string }[]; module: { declaration: object; source: string }; rules: SeamProvider<RulesInstance>; contentHash: string } | undefined`，只在 `rpg.json` 登记于 `assetFiles` 时返回。读取文件走 `lockedPackAsset`。`contentHash` 是全部生成源码的 sha256，在新世界创建时记进世界清单；打开已有世界时比较，不一致就报错“RPG 插件生成的规则与存档不一致（存档 x，当前 y）”。`plugin.id` / `plugin.version` 与 `OFFICIAL_RPG_ID` / `OFFICIAL_RPG_VERSION` 不符时，报错写明需要的版本。

- [ ] **Step 1：写失败的测试。**
  - `it('a pack without rpg.json opens exactly as before')`：与 main 上同一个包的初始事件对比。
  - `it('a pack with rpg.json gets the generated activities, status module and rules')`
  - `it('opening a saved world whose generated content changed fails with both hashes')`：两次打开之间改一个技能数值。
  - `it('a pack asking for another plugin version fails before the world opens')`
- [ ] **Step 2：运行测试，确认失败。**
- [ ] **Step 3：实现接线。** 活动源与包模块各加一个“额外条目”参数，不改它们对包内文件的校验。
- [ ] **Step 4：运行** `corepack pnpm@11.7.0 test`，预期全部通过。
- [ ] **Step 5：提交。** `git commit -m "feat: load rpg.json into a world and pin its generated rules"`

---

### Task 9：透视与校验

**Files:**
- Modify: `desktop/lens/view.ts`（新分类 `rpg`：角色数值、技能、装备、敌人、地图与出口条件）
- Modify: `packages/world-pack/src/creator-cli.ts`（`validate` 在有 `rpg.json` 时调用 `parseRpgConfig`）
- Test: `tests/host/lens-view.test.ts`、`packages/world-pack/src/creator-cli.test.ts`

- [ ] **Step 1：写失败的测试。**
  - `it('lens view lists RPG characters, enemies and map exits with their conditions')`
  - `it('validate reports an rpg.json error with its JSON path')`
  - `it('a lens scenario can fight the ruin-1 battle and expect Ah-Ru at home not to know the golem fell')`：用 `knows` / `doesNotKnow`。
- [ ] **Step 2–4：实现，运行测试，预期通过。**
- [ ] **Step 5：提交。** `git commit -m "feat: lens and validate understand rpg.json"`

---

### Task 10：验收包与作者文档

**Files:**
- Create: `examples/world-packs/hill-ruins/`（由 Skill 脚手架生成后修改）
  - 地点：家（客厅、卧室）、`location:ruin-1`、`location:ruin-2`、`location:vault`
  - 角色：玩家、队友澄、留在家里的阿茹（用来检查认知）
  - 物品：铁钥匙、铁剑、两瓶药水
  - 文件：`rpg.json` 即 Task 5 的配置；`scripts/status.js` 用物品模板写拿、放、给；`.perspectra-lens/scenarios/` 下放三份推演脚本
- Create: `skills/perspectra-creator/references/rpg.md`、`docs/current/guides/rpg.md`
- Modify: `skills/perspectra-creator/SKILL.md`（加入口）、`docs/current/guides/README.md`、`docs/current/architecture/creator-runtime.md`

- [ ] **Step 1：建包，并运行三份推演。**
  - 推演一：从家入队，到副本，打赢，拿钥匙，开门，回家睡觉回血。期望 `rpg-hp` 回满，且在家时状态栏不出现 `rpg-hp`。
  - 推演二：战败，传送回家，生命为 1。
  - 推演三：阿茹不知道战斗细节。

  三份都必须 `passed: true`，退出码为 0。
- [ ] **Step 2：写作者文档。** 先给一段玩家与角色的互动例子，再逐字段解释 `rpg.json`。写明这些限制：
  - 第一版不做等级、经验、格子地图、商店；
  - 一个宝箱只装一件物品；
  - 写死演出可能和角色的认知矛盾，需要试玩检查。
- [ ] **Step 3：运行检查。**
  - `worldpack validate examples/world-packs/hill-ruins` 退出码为 0；
  - `node scripts/docs/check-links.mjs`；
  - `corepack pnpm@11.7.0 check`。
- [ ] **Step 4：提交。** `git commit -m "feat: hill-ruins adventure pack and RPG author guide"`

---

### Task 11：真实模型试玩（人工）

- [ ] **Step 1：试玩。** 在新数据目录用真实模型跑一局：家 → 邀请澄 → 副本两层 → 回家。记录在 `docs/current/studies/2026-11-xx-hill-ruins-playtest.md`，重点写：
  - 澄是否自然地选技能、有没有自己的态度；
  - 随行是否让人觉得她被拖着走；
  - 写死台词和她当时的认知是否矛盾；
  - 阿茹是否表现出知道战斗细节。
- [ ] **Step 2：区分验证范围。** 在文档的验证状态里，把“源码已接通”“自动测试”“真实体验”“发行包”分开写，不把测试通过写成体验已验收。
- [ ] **Step 3：提交试玩记录。**
