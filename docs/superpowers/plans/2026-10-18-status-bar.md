# 状态栏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用作者脚本 `scripts/status.js` 声明、经裁定修改、按观察者认知交付的常驻状态，取代包变量。

**Architecture:** 状态真实值以新事件 `status.updated` 存入 World Event Log，读取时从事件折叠出真实值和每个观察者的已知值（照 `characterVisibleItems` 的做法）。NPC 的状态操作通过包装 RulebookResolver 进入现有的裁定和提交路径（照 `PackActivities.rulebooks`）。玩家操作、开局初值和每轮钩子由宿主用 `WorldStore.commitRound` 直接提交（照 `PackActivity.apply` / `escape`）。活动的 `resolve` 可以附带状态变化。

**Tech Stack:** TypeScript strict / ESM，`node:vm`，Ajv（沿用活动操作的 schema 校验），Vitest，SQLite（`@harness-world/store-sqlite`）。

**Spec:** [docs/superpowers/specs/2026-10-18-status-bar-design.md](../specs/2026-10-18-status-bar-design.md)

## Global Constraints

- ESM、TypeScript strict、本地导入写显式 `.ts`；遵守 AGENTS.md。
- 不新增数据库，不新增独立状态文件；状态只存在 `world.sqlite` 的事件里。
- 作者脚本沿用活动脚本的约束：`node:vm`，`codeGeneration:{strings:false,wasm:false}`，同步 JSON 输入输出，单次调用 100 ms 超时，脚本最大 64 KiB，输入和输出各最大 64 KiB；必须登记为编译资产，并核对内容哈希和包内路径。
- 上限：状态声明最多 64 个，操作最多 32 个，字符串值最长 200 字符，每次结果的 changes 和 reveals 各最多 64 条。
- 值类型只有 `number`（有限数）、`string`、`boolean`。
- **用户已确认旧存档不兼容**：`status.updated` 登记进全局事件清单，会改变所有世界的 manifest 哈希，旧存档打开时报错是预期行为。不写任何迁移或兼容分支。
- 叙事文本不得改变状态；模型只能通过 perform 提出已声明的操作。
- 告知和结果接收者只能是行动者本人，或行动者当前授权场景（`SceneDecisionService` 的 `observerIds`）内的角色；每轮钩子只能告知被改状态的归属者本人。
- 交付时更新当前架构文档和作者指南，运行 `node scripts/docs/check-links.mjs`。

## Review Focus

1. 偷窃之后，失主在没有任何观察的情况下，上下文或状态栏里出现了新余额 → 失主看到的仍是旧值，并标为 `current:false`。（Task 3）
2. 角色在候选行动生成之后、提交之前离开了场景，然后才被当作操作目标 → `resolve` 之前按提交前缀重新校验，操作被拒绝，什么都不提交。（Task 3）
3. 末端重新生成之后，状态栏显示的是被丢弃那一轮的值 → 显示所选候选结果的值；每轮钩子随这一轮重新执行一次，不会多加一次。（Task 4）
4. `onRoundEnd` 抛出异常或超时 → 本轮已提交的对话保留，状态不变，也不重试。（Task 4）
5. 被限定在战斗里的 HP，在战斗外被普通操作改动 → 整次操作被拒绝，什么都不提交。（Task 5）

---

### Task 1: 登记 `status.updated` 事件类型

**Files:**
- Modify: `packages/kernel/src/world-spec.ts:505-517`（`characterInteractionManifestRegistries`）
- Test: `packages/kernel/src/world-spec.test.ts`（新建）

**Interfaces:**
- Produces：事件类型名 `'status.updated'`，`eventVersion: 1`，后续所有任务都使用它。

- [ ] **Step 1：写失败测试** `it('registers status.updated for character worlds')`：`characterInteractionManifestRegistries().events.definitions.map(d => d.name)` 包含 `'status.updated'` 和 `'activity.updated'`。
- [ ] **Step 2：运行确认失败** `npx vitest run packages/kernel/src/world-spec.test.ts`，预期 FAIL。
- [ ] **Step 3：实现** 在清单数组里紧跟 `'activity.updated'` 加上 `'status.updated'`。
- [ ] **Step 4：跑全量** `corepack pnpm@11.7.0 test`。如果有测试固定了 manifest 或 world 哈希（例如 `882c03b` 冻结的拓扑契约），把它们更新为新值，并在提交说明里写明原因：新增事件类型，旧存档不兼容，用户已确认。不得为通过测试而让新类型可选。
- [ ] **Step 5：提交** `feat(kernel): register status.updated event type`

### Task 2: `PackStatus` 核心：定义解析、真实值与已知值

**Files:**
- Create: `tests/experiments/pack-status.ts`
- Create: `tests/prototype/fixtures/status-market.js`（测试用作者脚本，Task 3–7 共用）
- Test: `tests/prototype/pack-status.test.ts`

**Interfaces:**
- Produces（`pack-status.ts` 导出）：
  - `type StatusValue = number | string | boolean`
  - `interface StatusChange { holderId: string | null; key: string; value: StatusValue }`
  - `interface StatusReveal { observerId: string; holderId: string | null; key: string; value: StatusValue }`
  - `type StatusSource = { kind: 'initial' } | { kind: 'operation'; operation: string; actorId: string } | { kind: 'activity'; activityKey: string; actorId: string } | { kind: 'round'; round: number }`
  - `interface StatusEventData { source: StatusSource; changes: StatusChange[]; reveals: StatusReveal[] }`
  - `interface StatusTruth { public: Record<string, StatusValue>; characters: Record<string, Record<string, StatusValue>> }`
  - `interface KnownStatus { key: string; label: string; holderId: string | null; value: StatusValue; current: boolean }`
  - `class PackStatus`：
    - `static load(packPath: string, pack: CompiledWorldPackV5): PackStatus | undefined`：包里没有登记 `scripts/status.js` 时返回 `undefined`；
    - `static parse(source: string, pack: CompiledWorldPackV5): PackStatus`；
    - `readonly statuses`、`readonly operations`（已解析的声明）；
    - `truth(events: readonly RulebookEvent[]): StatusTruth`；
    - `known(events: readonly RulebookEvent[], observerId: string): KnownStatus[]`；
    - `initialEvent(): WorldEventDraft`；
    - `validate(events, data: StatusEventData, sceneIds: readonly string[]): void`：不合法时抛错。
- 作者脚本契约 `globalThis.statusScript`：
  - `definition = { statuses: [{ key, label, type, owner: 'public' | 'character', alwaysKnown?: boolean, activities?: string[] }], operations: [{ id, label, schema, characterParameters?: string[], actors?: 'player' | 'npc' | 'any', activities?: string[] }] }`；
  - `initialize(characterIds: string[]) → { public, characters, reveals? }`；
  - `resolve(truth, actorId, operationId, parameters, world) → { rejectReason } | { changes, reveals, description, audience }`，其中 `audience` 为 `'self' | 'scene' | { characters: string[] }`；
  - 可选 `onRoundEnd(truth, { round }) → null | { changes, reveals }`。
- 规则（照写进实现）：
  - `owner:'public'` 的 `holderId` 为 `null`；`owner:'character'` 时，包里每个声明角色（包括玩家和尚未登场的角色）各有一份。
  - 状态键 `/^[a-z][a-z0-9-]{0,40}$/`，操作 ID 规则相同；操作 ID 不得与活动保留名冲突。
  - `initialEvent` 的 reveals：每个角色私有状态告知其归属者，再加上 `initialize` 额外返回的 reveals。
  - `known` 的规则：
    - `alwaysKnown` 的状态：每个观察者都得到真实值，`current: true`。
    - 其他状态：取最后一条 `observerId` 匹配的 reveal，记它所在事件的序号为 i。若 i 之后该 `(holderId, key)` 又有 change，则 `current: false`，否则 `current: true`。没有任何 reveal 时省略这一项。
  - `validate` 的规则：key 已声明；值的类型匹配；`holderId` 与 owner 匹配；`observerId` 属于 `sceneIds`。

- [ ] **Step 1：写夹具** `status-market.js`：
  - 状态：`money`（number，character）、`time`（number，public，alwaysKnown）、`hp`（number，character，`activities:['duel']`）。
  - 操作：`buy {price:integer}`；`steal {targetId}`，`characterParameters:['targetId']`，`actors:'npc'`；`check-purse {}`；`set-time {value:integer}`，`actors:'player'`，供测试推进状态；`drink-potion {}`，`activities:['duel']`。
  - `buy`：余额不足时返回被接受的结果，changes 为空，reveals 告知行动者真实余额，description 为"余额不足"。
  - `steal`：转移 30，只告知行动者。
  - `onRoundEnd`：`time += 10`。
  - `initialize`：每人 `money:100`、`hp:20`，`time:0`。
- [ ] **Step 2：写失败测试**
  - `parses the market fixture and rejects unknown keys, bad types and duplicate ids`；
  - `folds truth from initial and later events`；
  - `owner learns initial private values; others see nothing`；
  - `a theft leaves the victim with the old value marked current:false`：手工构造 initial 事件，加一条只 reveal 给小偷的 steal 事件；断言失主得到 `{key:'money',value:100,current:false}`，小偷得到自己的 130、`current:true`；
  - `alwaysKnown time is visible to everyone without reveals`；
  - `validate rejects a reveal to an observer outside the scene`。
- [ ] **Step 3：运行确认失败** `npx vitest run tests/prototype/pack-status.test.ts`。
- [ ] **Step 4：实现 `pack-status.ts`**。脚本加载和执行照 `pack-variables.ts` 的 `load` / `#call`（哈希、包内路径、vm 选项）。`known` 和 `truth` 都是对事件数组的纯函数，不访问存储。
- [ ] **Step 5：运行通过**，同一命令。
- [ ] **Step 6：提交** `feat(status): parse status scripts and derive truth and known values`

### Task 3: NPC 操作路径、上下文交付与开局提交

**Files:**
- Modify: `tests/experiments/pack-status.ts`（增加 resolver 和开局提交）
- Modify: `tests/experiments/playtest-frozen-runtime.ts`：加载处，即 `PackVariables.load` 旁边；`#activateCharacters` 里构造 rulebooks 的位置（约 840 行）；`request.context` 注入处，即 `knowledge` 旁边（约 377 行）；`executionResult` 传入处（约 855 行）
- Modify: `packages/provider-chat/src/character-context-text.ts`（`characterContextNote` 增加一句说明）
- Test: `tests/prototype/pack-status-runtime.test.ts`

**Interfaces:**
- Consumes：Task 2 的 `PackStatus`、`StatusEventData`、`KnownStatus`。
- Produces：
  - `PackStatus.resolver(base: RulebookResolver, worldPath: string, address: WorldAddress, playerId: string): RulebookResolver`：
    - `affordances` 在 base 的基础上追加该角色可用的状态操作。格式和活动操作一样：`{label, targetRef:{kind:'character',id:actor}, bindingId:'status', definitionRef:{id:'status:'+op, version:1}, arguments:{}, argumentSchema}`。
    - `resolve` 拦截 `definitionRef.id` 以 `status:` 开头的操作，其余交给 base。
  - `PackStatus.executionResult(input): ReturnType<typeof characterExecutionResult> | undefined`：只处理 `status:` 开头的操作，其余返回 `undefined`。
  - `PackStatus.ensureInitial(worldPath, address, playerId): Promise<void>`：世界里还没有任何 `status.updated` 时，用 `commitRound` 提交初始事件（照 `PackActivity.escape`）；已有则什么都不做。
  - 角色上下文字段：`context.knownStatus: KnownStatus[]`，并附 `knownStatusNote: '这是你上次确认的状态值；current=false 表示之后可能已经改变，你并不知道现在的值。'`。
- `resolve` 的步骤：
  1. 用 Ajv 校验参数；
  2. 若操作声明了 `actors`，校验行动者身份；
  3. `characterParameters` 里的角色必须存在，并且在行动者的 `observerIds` 里（按提交前缀用 `SceneDecisionService.decideFromEvents` 计算）；
  4. 调用作者 `resolve`，第五个参数 `world` 和 `PackActivity.#worldView` 相同；
  5. `rejectReason` 直接抛错，不提交；
  6. 被接受时，把"行动者自己的状态改变"自动追加为给行动者的 reveal，执行 `validate`，然后返回 `{status:'accepted', events:[status.updated], observationScope}`。`audience` 的映射：`'self'` 对应只给行动者，`'scene'` 对应 `scope:'scene_public'`，`{characters}` 对应 `scope:'direct'` 加 `recipientIds`。
- 接线：
  - 运行时构造 resolver 链：core → status → activities（`this.#activity?.rulebooks(statusResolver)`）→ autonomy。
  - `executionResult` 的顺序：status → activity → 默认。

- [ ] **Step 1：写失败测试**（模拟 HTTP，Ollama 和 local 两条协议都跑，照 `pack-story-slice.test.ts` 的服务器写法）：
  - `an NPC theft commits one status.updated and only the thief learns the new balances`：模拟模型让同行者 perform `status:steal {targetId:玩家}`。断言：真实值玩家 70、小偷 130；玩家的 `knownStatus` 里 money 为 100、`current:false`；另一名 NPC 的请求文本里不含 130 和 70。
  - `a target that left the scene is rejected without any commit`：在 resolve 前把目标移出场景，断言 head 没有前进。
  - `narration claiming a theft changes nothing`：模型只 publish "他偷走了钱袋"，断言没有新增 `status.updated`。
  - `initial event is committed once on first open and not again on reopen`。
- [ ] **Step 2：运行确认失败** `npx vitest run tests/prototype/pack-status-runtime.test.ts`。
- [ ] **Step 3：实现** `resolver`、`executionResult`、`ensureInitial`，以及运行时接线。在 `FrozenWorldRuntimeCore.create` 里，`activate` 之后调用 `ensureInitial`。
- [ ] **Step 4：运行通过**，并跑 `corepack pnpm@11.7.0 typecheck`。
- [ ] **Step 5：提交** `feat(status): adjudicate NPC status operations and deliver known values`

### Task 4: 玩家操作、每轮钩子与回滚

**Files:**
- Modify: `tests/experiments/pack-status.ts`（`apply`、`endRound`）
- Modify: `tests/experiments/playtest-frozen-runtime.ts`：`submit` 里增加 `/status ` 分支，位置照原 `/vars `；`submit` 成功分支、`/status` 分支和 `activityAction`（`changed` 为真时）在 `#activateCharacters` 之后调用 `endRound`
- Modify: `tests/experiments/playtest-tail-runtime.ts:153-172`（`perform` 把 `status:` 交互转成 `/status` 文本）
- Test: `tests/prototype/pack-status-runtime.test.ts`（追加）

**Interfaces:**
- Consumes：Task 3 的 resolver 规则（这里复用同一个内部裁定函数，不复制一份）。
- Produces：
  - 玩家命令 `/status <operationId> <JSON 参数>`。经由 TailRoundRuntime 记录成文本输入，所以重新生成时会重放。
  - `PackStatus.apply(worldPath, address, playerId, operation: string, parameters: WorldJsonObject, requestId: string): Promise<void>`：用 `commitRound` 提交 `status.updated`、观察事件和 `action.resolved`（照 `PackActivity.apply` 末段）。
  - `PackStatus.endRound(worldPath, address): Promise<{ ok: boolean }>`：
    - 没有 `onRoundEnd` 或返回 `null` 时不提交；
    - 否则以 `source:{kind:'round', round:n}` 提交，n 为已有 round 来源事件数加 1；
    - 只允许改未限定活动的状态，reveals 只能给归属者本人；
    - 异常或超时时 `ok:false`，不提交，运行时把失败写进 `debug.statusRoundError`，不重试。
  - `TailRoundRuntime.perform`：`definitionRef.id` 以 `status:` 开头时，调用 `submit('/status ' + op + ' ' + JSON.stringify(arguments))`。

- [ ] **Step 1：写失败测试**
  - `player buy with too little money is accepted, spends nothing and reveals the true balance`：先让 NPC 偷走，再让玩家 `/status buy {"price":90}`；断言玩家 known money 为 70、`current:true`，真实值不变。
  - `an invalid parameter rejects without commit`：`/status buy {"price":"x"}`，断言 head 不变。
  - `onRoundEnd advances time once per accepted player input`：三次发言后 time 为 30；被拒绝的输入不推进。
  - `a throwing onRoundEnd keeps the round and leaves status unchanged`：用夹具变体，断言对话已提交、time 不变、`debug.statusRoundError` 存在。
  - `tail regeneration replays the round once and shows the selected candidate's values`：time 不会多加一次。
  - `story node fork restores status to the node`：保存节点，改变状态，从节点分叉，断言回到节点时的值。
- [ ] **Step 2：运行确认失败**，同一测试文件。
- [ ] **Step 3：实现** `apply`、`endRound`、运行时分支，以及 tail runtime 映射。
- [ ] **Step 4：运行通过**，并跑 `npx vitest run tests/prototype/tail-round.test.ts tests/prototype/story-nodes.test.ts`。此时这两个测试仍用 `/vars`，应保持通过。
- [ ] **Step 5：提交** `feat(status): player status operations and round-end hook`

### Task 5: 活动联动与适用范围

**Files:**
- Modify: `tests/experiments/pack-activity.ts`：`#resolve` 里活动操作分支的 `exact(resolved, ...)` 处（约 397 行）；`load` / 构造函数增加可选的 `status`
- Modify: `tests/experiments/pack-activities.ts:15-27`（`load` 透传 `status`）
- Modify: `tests/experiments/pack-status.ts`（范围检查；带 `activities` 的操作按前台活动过滤）
- Test: `tests/prototype/pack-status-activity.test.ts`

**Interfaces:**
- Consumes：Task 2 的 `validate`、`truth`；`activityProgress(events)`（已从 `pack-activity.ts` 导出）。
- Produces：
  - 活动 `resolve` 增加第六个参数 `truth: StatusTruth | null`，结果可选带 `status: { changes, reveals }`。宿主把它转成一条 `source:{kind:'activity', activityKey, actorId}` 的 `status.updated`，和 `activity.updated` 放在同一个 `events` 数组里。
  - 范围规则：带 `activities` 的状态，只接受 `source.kind === 'activity'` 并且 `activityKey` 在清单里的变化；其他任何来源改它，整次操作抛错、不提交。
  - 带 `activities` 的操作：只有前台活动的 key 在清单里、并且行动者是参与者时，才出现在 affordances 里并能执行。活动 `policy.interactions` 仍需要列出 `status:<op>`，否则被活动过滤掉（设计第 9 节第 4 条）。

- [ ] **Step 1：写失败测试**，夹具加一个 `duel` 活动，其操作 `attack` 让目标 hp 减 5，并告知双方：
  - `duel attack commits activity and status in one transaction`：两个事件属于同一个 `transactionId`。
  - `hp cannot change outside duel`：玩家用 `/status` 调用一个试图改 hp 的操作（夹具里加 `cheat-hp`），断言被拒绝、head 不变。
  - `drink-potion is offered only during duel to participants`：活动外的 affordances 里没有它；活动中参与者有、非参与者没有。
  - `after duel ends hp keeps its last value and is shown as last confirmed to bystanders`。
- [ ] **Step 2：运行确认失败** `npx vitest run tests/prototype/pack-status-activity.test.ts`。
- [ ] **Step 3：实现**。
- [ ] **Step 4：运行通过**，并跑 `npx vitest run tests/prototype/pack-activity.test.ts tests/prototype/pack-activities.test.ts`。
- [ ] **Step 5：提交** `feat(status): let activities change scoped status values`

### Task 6: 玩家状态栏、SDK 与创作者调试

**Files:**
- Modify: `tests/experiments/playtest-server.ts:37`（`PlaytestState` 增加 `statusBar?: KnownStatus[]`，暂时保留 `packVariables`，到 Task 7 再删）
- Modify: `tests/experiments/playtest-frozen-runtime.ts`：`state()`，约 536 行；创作者快照的 `variables`，约 188 行
- Modify: `packages/frontend/src/player-view.ts`（`PlayerView.statusBar`、`projectPlayerView`、`playerViewPatch` 的字段列表）
- Modify: `packages/frontend/src/default-template.ts`（状态栏面板；`status:` 操作归入 `items` 分组）
- Test: `tests/prototype/frontend-api.test.ts`（PlayerView 与补丁）、`tests/prototype/frontend-reading.test.ts`（默认舞台脚本 `DEFAULT_SCRIPT` 的渲染）

**Interfaces:**
- Consumes：`PackStatus.known(events, playerId)`、`PackStatus.truth(events)`。
- Produces：
  - `PlayerView.statusBar?: { key: string; label: string; holderId: string | null; holderName?: string; value: number | string | boolean; current: boolean }[]`。注意 `PlayerView.status` 已经被占用（表示 ready / busy），新字段必须叫 `statusBar`。
  - 创作者快照的 `variables` 改为 `{ public: truth.public, characters: truth.characters }`，与旧结构相同，所以创作者页面无需修改。

- [ ] **Step 1：写失败测试**
  - `player view carries only the player's known status, never truth`：构造失窃状态，断言 PlayerView 序列化后不含小偷的余额，玩家的 money 是 100、`current:false`。
  - `statusBar changes appear in playerViewPatch`。
  - 舞台测试：面板渲染出 label 和值；`current:false` 时显示"上次确认"字样。
- [ ] **Step 2：运行确认失败**。
- [ ] **Step 3：实现**。面板沿用现有的场景和活动卡片样式，不新增主题变量。
- [ ] **Step 4：运行通过**，并跑 `cd apps/launcher && npx vitest run` 确认创作者页面没有回归。
- [ ] **Step 5：提交** `feat(status): show the player's known status in the stage and SDK`

### Task 7: 退役包变量

**Files:**
- Delete: `tests/experiments/pack-variables.ts`、`tests/prototype/pack-variables.test.ts`，以及 `examples/world-packs/{ai-girls-awaken-v10,ai-girls-hosted-guess,launcher-demo,scripted-performance}/scripts/variables.js`
- Modify:
  - `tests/experiments/playtest-frozen-runtime.ts`：删除 `#variables` 和 `/vars`；删除所有 `this.#variables===undefined` 的调度门槛，约在 846、848、851、904、995 行，让这些路径恢复成不带变量时的行为。
  - `tests/experiments/playtest-tail-runtime.ts:147`（删除 `/vars`）
  - `tests/experiments/playtest-server.ts:37`（删除 `packVariables`）
  - `desktop/story-nodes.ts:16,61`、`desktop/story-share.ts:11,16,108`、`desktop/tail-storage.ts:100,111,125`、`desktop/tail-runtime-identity.ts`：从文件清单中删除 `pack-variables.json` 和 `pack-variables.ts`，加入 `tests/experiments/pack-status.ts`。
  - 上面 4 个示例包的 `worldpack.source.json`：从 `assetFiles` 中删除 `scripts/variables.js`。
  - 迁移 `tests/prototype/{story-nodes,storyline-crash,tail-round}.test.ts`：改用 Task 2 的夹具，用 `/status set-time {"value":N}` 替代 `/vars`，断言改读 `statusBar` 的 time。
  - `tests/prototype/{pack-activity,pack-activities,frontend-api,playtest-memory-core}.test.ts`、`packages/provider-chat/src/character-context-text.test.ts`、`packages/world-pack/src/compiler-v5.test.ts`：删除或替换与包变量相关的断言和夹具。

- [ ] **Step 1：完成删除和迁移**。`git grep -n "PackVariables\|pack-variables\|packVariables\|/vars \|variables\.js"` 只应剩下 `docs/current/studies/` 下的历史研究文档。
- [ ] **Step 2：运行** `corepack pnpm@11.7.0 typecheck && corepack pnpm@11.7.0 lint && corepack pnpm@11.7.0 test`，全部通过。
- [ ] **Step 3：补一条动态调度回归**：带 `status.js` 的包在动态调度下仍能并发计算两个场景的 NPC。断言 activation 记录中有并发派发，参考 `dynamic-scheduling` 的现有测试写法。
- [ ] **Step 4：提交** `refactor: retire package variables in favour of status`

### Task 8: 示例包、文档与试玩准备

**Files:**
- Create: `examples/world-packs/status-market/`：从 `prototype-g1` 复制；`scripts/status.js` 基于 Task 2 的夹具，去掉测试专用的 `set-time` 和 `cheat-hp`；加 `README.md`
- Modify: `docs/current/guides/activity-and-variables.md`（第 3 节重写为"状态"）、`docs/current/guides/world-pack-authoring.md`、`docs/current/storylines.md`、`docs/current/frontend-v1.md`（`statusBar` 字段）、`docs/current/architecture/{runtime,creator-runtime,interaction,cognition-memory}.md`（各加一段 2026-10 日期说明）、`docs/current/studies/tavern-card-port-capability-20261018.md`（顶部说明状态栏已承接 MVU 客观值）
- Create: `tests/experiments/status-market-offline.ts`：无模型实验，脚本化地驱动购买、偷窃、查看钱包和每轮推进时间，输出到新的 `.tmp/status-market-<时间戳>`

- [ ] **Step 1：写示例包和离线实验**，运行 `node --import tsx tests/experiments/status-market-offline.ts`。预期 summary 中失主偷窃后 money 显示 `current:false`，查看钱袋后为 `current:true`，time 每轮加 10。
- [ ] **Step 2：更新文档**，运行 `node scripts/docs/check-links.mjs`，预期通过。
- [ ] **Step 3：全量检查** `corepack pnpm@11.7.0 check`。
- [ ] **Step 4：提交** `docs: author guide and example for status`
- [ ] **Step 5：真实模型试玩**。这一步需要用户另外授权模型调用和数据外发，执行者不得自行运行。准备好命令（走 Core，新建 `.tmp` 数据目录），并在交付说明里写明"真实试玩未做"。
