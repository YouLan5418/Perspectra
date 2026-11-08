# 跑团活动与骰子机制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 世界包登记 `trpg.json`，玩家就能开一局由 AI 主持的跑团。掷骰由可替换的 `ctx.dice` 机制提供，结果记录在事件里，可以重放；点数只让该知道的人看到，并进入他们的记忆。

**Architecture：**
- 核心扩展两处：
  - 活动 `resolve` 也能拿到宿主记录的随机数，通过 `ctx.dice` 掷骰，复用每轮的随机记录；
  - 活动结果可带 `privateNotes`，只进入指定参与者的观察。
- 新增两个插件：
  - 内部机制插件 `official-dice`，注册 `ctx.dice`；
  - 玩法插件 `official-trpg`，经 `ctx.content` 读 `trpg.json`，生成一场跑团活动。
- 宿主不出现跑团或骰子的专有代码。

**Tech Stack：** TypeScript strict、ESM、显式 `.ts` 导入、vitest、node:vm 作者脚本、Cordis、SQLite 事件存储。

**Spec：** [docs/superpowers/specs/2026-11-08-trpg-activity-design.md](../specs/2026-11-08-trpg-activity-design.md)

## Global Constraints

- 分支 `feat/rpg-plugin`。工作区里还有一批未提交的 RPG 战斗效果改动，是另一位作者的。每个任务只 `git add` 自己改的文件，不提交、不还原那些改动，也不动 `.claude/launch.json`。
- 只产出核心认识的事件，不新增 eventType。
- 模型输出只能提出操作，由活动脚本检查后提交。主持人碰不到主世界状态。
- 宿主（`desktop/host/**`）不出现 trpg、dice 的专有代码。官方插件只由 `desktop/official-bundle.ts` 引入（`node scripts/check-host-boundaries.mjs`）。
- 活动的现有限制照旧：
  - 单次钩子 100 ms；
  - 脚本输出 64 KiB；
  - 参与者开局时确定；
  - 操作参数最外层是封闭对象；
  - `audience` 只能是 `participants` 或 `self`。
- 掷骰复用 `ActivitiesRuntime` 每轮的随机记录：回看、分支、末端重新生成都重放出同样的点数。
- 没有 `trpg.json` 的包、现有活动、现有 RPG 行为都不变。
- 每个任务都运行 `corepack pnpm@11.7.0 typecheck` 和本任务列出的测试；改到共享运行时代码的任务，提交前还要跑一次 `corepack pnpm@11.7.0 check`。
- 改到 `docs/current` 时运行 `node scripts/docs/check-links.mjs`。

## Review Focus

1. **主持人宣布的结算和点数不符。** 程序不纠正这一点，但点数必须如实记录、按范围可见。Task 4 的测试要锁定：结算文字不会改动点数记录。
2. **玩家在主持人还没接受时就提出行动，或主持人拒绝后被重新邀请。** 应当拒绝那次行动，或回到筹备阶段，不能卡死。测试在 Task 4。
3. **暗骰的点数出现在公开描述或其他参与者的观察里。** 测试在 Task 4（视图）和 Task 5（记忆）。
4. **主持人把数值改出上下限，或改了模板里没有的数值项。** 应当拒绝，并给出原因。测试在 Task 4。
5. **一局结束后，主持人的操作仍被提供，或者仍能执行。** 测试在 Task 4。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `docs/superpowers/specs/2026-11-08-trpg-decisions.md`（新） | 取舍记录：`ctx.dice` 的形态，以及它替代了什么 |
| `packages/plugin-sdk/src/dice.ts`（新） | `DiceRoll`、`DiceInstance`、`DiceSlotApi` 类型 |
| `packages/plugin-sdk/src/activities.ts` | `resolve` 增加可选参数 `roll` |
| `packages/official-dice/`（新包） | 解析骰子表达式、掷骰、检定，以及 `officialDiceProvider` |
| `packages/official-activities/src/index.ts` | `resolve` 时把 `roll` 作为脚本全局 `rollDice` 提供 |
| `desktop/host/activity-runtime.ts`、`desktop/host/activities-runtime.ts` | 用本轮随机记录和 `ctx.dice` 构造 `roll` |
| `desktop/host-plugins.ts`、`packages/plugin-sdk/src/host.ts`、`desktop/official-bundle.ts` | 注册 `ctx.dice` 槽位，默认 `officialDiceProvider` |
| `packages/application/src/activity-projection.ts`、`desktop/host/activity-runtime.ts` | 活动结果的 `privateNotes` |
| `packages/official-trpg/`（新包） | `trpg.json` 校验、`officialTrpgContent` 生成器、`runtime/trpg.js` 活动脚本 |
| `examples/world-packs/rainy-manor/`（新） | 验收包 |
| `docs/current/guides/trpg.md`（新）、`skills/perspectra-creator/references/trpg.md`（新） | 作者文档 |

---

### Task 1：`ctx.dice` 与 `resolve` 里的记录随机数

**Files:**
- Create: `docs/superpowers/specs/2026-11-08-trpg-decisions.md`
- Create: `packages/plugin-sdk/src/dice.ts`；在 `packages/plugin-sdk/src/index.ts` 导出
- Create: `packages/official-dice/package.json`、`src/index.ts`、`src/dice.ts`、`src/dice.test.ts`（照 `packages/official-pacing` 的结构，并像 Task 1 of RPG 那样在根 `tsconfig.json`、`vitest.config.ts` 加别名）
- Modify: `packages/plugin-sdk/src/activities.ts:18-25`、`packages/plugin-sdk/src/host.ts`、`desktop/host-plugins.ts`（照 `PacingSlot` 加一个 `DiceSlot`）、`desktop/official-bundle.ts`（`HostSeams.dice`、`composeWorldSeams`、`installOfficialBundle`）、`packages/official-activities/src/index.ts`、`desktop/host/activity-runtime.ts`、`desktop/host/activities-runtime.ts`
- Test: `tests/host/activity-dice.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // packages/plugin-sdk/src/dice.ts
  export interface DiceRoll { expression: string; dice: number[]; modifier: number; total: number }
  export interface DiceInstance { roll(expression: string, random: () => number): DiceRoll }
  export interface DiceSlotApi { register(provider: SeamProvider<DiceInstance>): () => void; readonly current: SeamProvider<DiceInstance> | undefined }
  // packages/plugin-sdk/src/activities.ts：resolve 增加第七个可选参数
  resolve(state, actorId, operation, parameters, world, truth, roll?: (expression: string) => DiceRoll): unknown
  // packages/official-dice/src/index.ts
  export const officialDiceProvider: SeamProvider<DiceInstance>   // id 'official-dice', version '1'
  export function parseDice(expression: string): { count: number; sides: number; modifier: number }  // 'd20' | '1d20+2' | '2d6-1' | 'd100'；count 1–20，sides 2–1000，修正 ±1000
  export function check(roll: DiceRoll, difficulty: number): { success: boolean; margin: number }  // success = total >= difficulty
  ```
- 活动脚本在 `resolve` 里可以调用全局函数 `rollDice(expression)`，返回 `DiceRoll`。不在 `resolve` 里调用，或表达式非法，都抛出 TypeError，整次结果不提交。

- [ ] **Step 1：写取舍记录。** 记下四条决定，每条写明它替代了什么：
  - `ctx.dice` 是单实现的可替换槽位，和 `ctx.pacing` 同一模式。
  - 随机来源是活动目录每轮的记录（`ActivityBindings.randomSource`），不另建存储。
  - 脚本通过注入的 `rollDice` 调用掷骰，替代脚本自己用 `Math.random`；后者在 `resolve` 里不被记录。
  - 检定 `check` 是纯函数。
- [ ] **Step 2：写失败的测试。**
  - `packages/official-dice/src/dice.test.ts`：`parseDice` 能接受和应拒绝的输入；用固定随机序列 `[0.5, 0.0]` 掷 `2d6+1`，得到 `dice [4, 1]`、`total 6`；`check` 在相等时成功。
  - `tests/host/activity-dice.test.ts`：
    - 测试包的活动脚本在 `resolve` 里调用 `rollDice('1d20')`，把结果写进 `public`。断言点数在 1–20 之间，并且等于本轮随机记录换算出的值。
    - 用同一份随机记录重放（`beginRoundRandom(values)`）得到同样的点数。
    - 在 `policy` 里调用 `rollDice` 会失败。
- [ ] **Step 3：运行，确认失败。**
- [ ] **Step 4：实现。** `ActivityScript.resolve` 把 `roll` 作为 vm 全局 `rollDice` 注入，做法与 `initialize` 注入 `__initialRandom` 相同，调用结束后失效。`ActivityRuntime` 构造 `roll = expression => dice.roll(expression, bindings.randomSource)`；`dice` 取自组合里的 `ctx.dice`，没有时取 `officialDiceProvider`。
- [ ] **Step 5：运行测试和** `tests/host/pack-activity.test.ts`、`tests/host/activities-seam.test.ts`，然后运行 `corepack pnpm@11.7.0 check`，预期全部通过。
- [ ] **Step 6：在 `docs/current/guides/activity-and-variables.md` 的活动一节加一段 `rollDice`。** 先给例子，写明会重放。在 `docs/current/architecture/modules.md` 登记 `official-dice`。
- [ ] **Step 7：提交。** `git commit -m "feat: activities roll recorded dice through ctx.dice"`

---

### Task 2：活动结果的 `privateNotes`

**Files:**
- Modify: `packages/application/src/activity-projection.ts`（`parseActivityOperationResult` 的 `exact` 列表和校验）、`desktop/host/activity-runtime.ts`（提交观察的位置，约 557 行）
- Test: `packages/application/src/activity-projection.test.ts`、`tests/host/activity-private-notes.test.ts`

**Interfaces:**
- Produces：活动 `resolve` 可选返回 `privateNotes: { [characterId: string]: string }`：
  - 至多 8 条，每条 1–2000 字；
  - 键必须是本次活动的参与者；
  - 每条只作为该角色的一条观察提交（形状同 `activityOutcomeObservations`，`resultDescription` 为这条文字，`observationId` 为 `${actionId}:note:${characterId}`）；
  - 与 `activity.updated` 原子提交。

- [ ] **Step 1：写失败的测试。**
  - `it('a private note reaches only the named participants and is remembered by them')`：三人活动，结果带 `{ [A]: '你掷出 9', [HOST]: '玩家掷出 9' }`。断言 A 和 HOST 的视图里有这两条，第三名参与者和局外角色都没有。
  - `it('a note for a non-participant is refused and nothing commits')`
  - `it('activities without privateNotes commit exactly as before')`：与现有某个活动测试的事件逐条对比。
- [ ] **Step 2：运行，确认失败。**
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行测试、`tests/host/pack-activity.test.ts` 和 `corepack pnpm@11.7.0 check`。**
- [ ] **Step 5：在活动指南里补一段 `privateNotes`。**
- [ ] **Step 6：提交。** `git commit -m "feat: activity results can carry notes for named participants"`

---

### Task 3：`trpg.json` 校验与生成器骨架

**Files:**
- Create: `packages/official-trpg/package.json`、`src/index.ts`、`src/config.ts`、`src/content.ts`、`src/config.test.ts`、`src/fixtures/rainy-manor.trpg.json`
- Modify: `desktop/official-bundle.ts`（默认内容生成器加上 `officialTrpgContent`）、`packages/world-pack/process/cli-entry.ts`、`docs/current/architecture/modules.md`

**Interfaces:**
- Consumes: `ContentGenerator`、`ContentPackFacts`（`packages/plugin-sdk/src/content.ts`）。
- Produces:
  ```ts
  export interface TrpgConfig {
    plugin: { id: 'official-trpg'; version: '1' }
    sheet: { stats: { key: string; label: string; max: number }[]; skills: { key: string; label: string; modifier: number }[]; dice: string }
    characters?: Record<string, { stats?: Record<string, number>; skills?: Record<string, number> }>
    hosts?: string[]
    scenarios?: { id: string; title: string; opening: string; truth: string; endings: string[];
      content: { kind: 'place' | 'item' | 'npc'; name: string; description: string; location?: string; public: boolean }[] }[]
    themes?: string[]
  }
  export function parseTrpgConfig(value: unknown, pack: ContentPackFacts): TrpgConfig  // 出错时 TypeError，消息以 JSON 路径开头
  export const officialTrpgContent: ContentGenerator  // configFile 'trpg.json'，id 'official-trpg'，version '1'；生成一个 key 为 'trpg' 的活动
  ```
- 本任务的 `generate` 先返回一个只有筹备阶段的活动，Task 4 补全。
- 字段规则：
  - `sheet.dice` 必须能被 `parseDice` 解析。由于官方插件之间不互相导入，这条校验用正则 `^(\d{0,2})d(\d{1,4})([+-]\d{1,4})?$` 实现，并在取舍记录里写明。
  - `stats` 1–8 项，`skills` 1–12 项，`key` 用小写字母和连字符。
  - `hosts`、`characters` 的键必须是包内的非玩家角色。
  - `scenarios` 与 `themes` 都可以省略。都省略时，只能由玩家开局时自己填题目。

- [ ] **Step 1：写失败的测试。**
  - 基准配置 `rainy-manor.trpg.json` 能通过；
  - 引用了不存在的角色或主持人时，报出 JSON 路径；
  - 骰子写法非法时报错；
  - 有 `trpg.json` 的包会生成 `trpg` 活动，没有这个文件的包不受影响。
- [ ] **Step 2–4：实现、运行，并跑 `node scripts/check-host-boundaries.mjs`。**
- [ ] **Step 5：提交。** `git commit -m "feat: official-trpg validates trpg.json and generates the TRPG activity"`

---

### Task 4：跑团活动脚本（筹备、邀请、行动、检定、主持人操作、结束）

**Files:**
- Create: `packages/official-trpg/src/runtime/trpg.js`（生成器按原始字节拼接，并在末尾追加 `install(<config>)`）
- Create: `tests/fixtures/trpg-pack/`（玩家、`character:aru`、`character:cheng`、`character:mei` 在同一场景，`trpg.json` 用基准配置）
- Test: `tests/host/trpg-activity.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `rollDice`，Task 2 的 `privateNotes`，Task 3 的 `TrpgConfig`。
- Produces：活动 `trpg` 的定义。
  - `participants: { mode: 'player-select', min: 1, max: 8 }`
  - `game.phase`：`setup` → `invited` → `playing` → `ended`
  - `public`：`hostId`、`title`、`opening`、`notes`（公开笔记）、`content`（公开的局内内容）、`sheets`（每人一张）、`pending`（待处理的行动）、`lastResult`
  - `private[hostId]`：`notes`（私密笔记）、`secret`（剧本的真相和结局）、`hiddenContent`、`rolls`（所有点数）
  - `private[其他参与者]`：`rolls`（自己的点数）

  操作如下：

  | id | 谁可以用 | 何时 | 参数 |
  | --- | --- | --- | --- |
  | `setup` | 玩家 | `setup` | `{ hostId, scenario?, theme? }`，`scenario` 与 `theme` 恰好一个；`theme` 可以是 `themes` 里的一项，也可以是自填文字 |
  | `respond` | 主持人 | `invited` | `{ accept: boolean }`；拒绝回到 `setup` |
  | `propose` | 非主持人参与者 | `playing` | `{ text }`，进入 `pending` |
  | `check` | 主持人 | `playing` | `{ targetId, skill, difficulty, hidden }`；`hidden` 时 `targetId` 可以省略 |
  | `announce` | 主持人 | `playing` | `{ text }`；清空它处理的那条 `pending` |
  | `note` | 主持人 | `playing` | `{ scope: 'public' \| 'private', text, mode: 'append' \| 'replace' }` |
  | `set-stat` | 主持人 | `playing` | `{ targetId, stat, value }` |
  | `content` | 主持人 | `playing` | `{ kind, name, description, location?, public, id? }`，带 `id` 时是修改 |
  | `end` | 主持人或玩家 | 结束前任何阶段 | `{ ending? }` |

  所有主持人操作 `requiresTurn: false`，只在 `policy` 里对主持人开放。`setup` 选的主持人必须在本次参与者里，并且如果配置了 `hosts`，还必须在 `hosts` 名单里。公开笔记和私密笔记各自最多 6000 字；超出时 `note` 被拒绝，理由提示主持人用 `replace` 改写整理。

  `check` 的结算：`rollDice(sheet.dice)`，加上该技能的修正（取角色覆盖值，否则取模板默认值），对比 `difficulty`。
  - **公开描述**：“<名字>进行了一次<技能>检定”。暗骰不出现在公开描述里，也不出现在 `public`。
  - **`privateNotes`**：给 `targetId` 和主持人，文字“<名字>的<技能>检定：<dice>+<修正>=<总值>，难度<难度>，<成功/失败>”。暗骰只给主持人。
  - **`private.rolls`**：同时记进主持人和目标各自的记录。

  调度：每当有人 `propose` 或说话之后，主持人获得一次机会。照 `examples/world-packs/ai-girls-hosted-guess/scripts/activity.js` 的主持模式实现。

- [ ] **Step 1：写失败的测试**（真实宿主运行时，主持人和参与者由测试桩扮演）：
  - `it('the player picks a host and a theme, the host accepts, and the opening is public')`
  - `it('a declined invitation returns to setup and the player can pick someone else')`
  - `it('a proposal before the host accepted is refused and nothing commits')`
  - `it('a check shows its total only to the target and the host, and the others see that a check happened')`：用 `CharacterViewBuilder` 断言三方各自看到的内容。
  - `it('a hidden roll leaves no trace for anyone but the host')`
  - `it('the host announcing an outcome does not change any recorded roll')`
  - `it('set-stat refuses unknown stats and values outside 0..max')`
  - `it('a note that would pass 6000 characters is refused with the reason')`
  - `it('host operations are offered only to the host, and none after end')`
  - `it('nothing the host does changes a main-world status or item')`：对比开局前后的主世界状态与物品事件。
  - `it('regenerating the last round replays the same roll')`
- [ ] **Step 2：运行，确认失败。**
- [ ] **Step 3：实现 `runtime/trpg.js`。** `setup` 选剧本时，把剧本内容按 `public` 字段分进 `public.content` 与 `private[host].hiddenContent`，`truth` 和 `endings` 写进 `private[host].secret`。只有题目时，`secret` 为空，提示主持人先写私密笔记。
- [ ] **Step 4：运行测试、`corepack pnpm@11.7.0 check`。**
- [ ] **Step 5：提交。** `git commit -m "feat: the TRPG activity: setup, invitation, proposals, checks and host tools"`

---

### Task 5：记忆、透视与验收包

**Files:**
- Create: `examples/world-packs/rainy-manor/`（从 `tests/fixtures/trpg-pack/` 复制并写实内容：一个剧本《雨夜古宅》、两个题目、三名 AI 角色的人设）、`examples/world-packs/rainy-manor/.perspectra-lens/scenarios/*.json`（用 `git add -f`）
- Test: `tests/host/trpg-memory.test.ts`

- [ ] **Step 1：写失败的测试。**
  - `it('after the game, participants remember the outcome as part of the TRPG activity and only the roller and host remember the total')`：断言观察里带活动标识（`resultMetadata.activity`），并且 `privateNotes` 只在两人的观察里。
  - `it('a character who did not take part has no observation of the game')`
- [ ] **Step 2–3：实现**（预计只需要组合现有能力）并运行。
- [ ] **Step 4：写三份推演脚本。** 有剧本的一局、题目的一局、暗骰与可见范围。都用 `knows` / `doesNotKnow`，并且都必须 `passed: true`。
- [ ] **Step 5：`corepack pnpm@11.7.0 worldpack validate examples/world-packs/rainy-manor` 退出码 0。**
- [ ] **Step 6：提交。** `git commit -m "feat: rainy-manor TRPG example pack with lens scenarios"`

---

### Task 6：作者文档

**Files:**
- Create: `docs/current/guides/trpg.md`、`skills/perspectra-creator/references/trpg.md`
- Modify: `skills/perspectra-creator/SKILL.md`、`docs/current/guides/README.md`、`docs/current/architecture/creator-runtime.md`

- [ ] **Step 1：写文档。** 先给第 1 节那样的互动例子，再逐字段解释 `trpg.json`。写明这些限制：
  - 主持人的裁定质量靠模型，程序只保证点数可信、可见范围正确；
  - 笔记长度受活动大小限制；
  - 第一版没有战斗回合，没有跨局角色卡，局内 NPC 由主持人代言；
  - 重新生成不会重掷。
- [ ] **Step 2：`node scripts/docs/check-links.mjs`。**
- [ ] **Step 3：提交。** `git commit -m "docs: TRPG author guide"`

---

### Task 7：真实模型试玩（人工）

- [ ] **Step 1：** 仿照 `tests/experiments/hill-ruins-live.ts` 写 `tests/experiments/rainy-manor-live.ts`，经本机网关用 GLM-5.3-Flash 跑两局：一局有剧本，一局用题目。
- [ ] **Step 2：** 结果写进 `docs/current/studies/2026-11-xx-rainy-manor-playtest.md`，重点看：
  - 主持人有没有忘记掷骰；
  - 宣布的结果和点数是否一致；
  - 参与者有没有自主提出行动；
  - 回到主世界后，角色是否把局内事件说成“游戏里”。

  源码已接通、自动测试、真实体验、发行包，四项分开写。
- [ ] **Step 3：提交。**
