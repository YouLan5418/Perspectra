# 剧情起伏器实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让作者用 `scripts/pacing.js` 声明节拍，在节奏控制下触发事件、变动数值、向角色投递察觉或念头，并让在场角色知道自动事件的内容。

**Architecture:** 新增 Cordis 机制 `ctx.pacing`（`official-pacing`）解释脚本并做选择；校验和事件构造是 application 的纯函数；宿主的 `PacingRuntime` 只绑定输入和调用 `executeWorldRound`。节奏决策从事件日志计算，不新增存储。

**Tech Stack:** TypeScript strict、ESM 显式 `.ts` 导入、Vitest、Cordis、node:vm。

**Spec:** [剧情起伏器设计](../specs/2026-11-05-story-pacing-design.md)。

状态：待用户确认，尚未实施。在新分支 `feat/story-pacing` 上做，Task 1 开始时一起提交设计与本计划。

## Global Constraints

- 没有 `scripts/pacing.js` 时行为不变：`node --import tsx tests/experiments/plugin-seams-baseline.ts record <新文件>` 与 `.tmp/migration-m7/baseline-a020632.json` 比较，除 `autonomy-integrated` 的并发请求顺序外必须相同。
- 官方机制运行时只依赖 `plugin-sdk` 和 `contracts`，拿不到 Store 或提交回调。
- 不新增事件类型、存档字段、数据库。不做通用外部插件持久状态。
- 刺激只有 `perception`、`thought` 两种，不支持指令。
- 不为文字加语义分类器。
- 脚本和活动脚本一样同步运行，无 Node 导入、无模型调用。
- `TypeError`／`RangeError` 表示拒绝或作者错误，继续保留错误类别。
- `D:/worlds` 只读。凭证不进日志。
- 默认检查 `corepack pnpm@11.7.0 check`，每个任务结束前全过。

## Review Focus

1. 玩家回合数在快捷操作、静观、多段输入下算错，导致冷却和相位漂移。→ Task 2 测试。
2. 活动进行中、暂停、逃生或世界关闭时节拍仍然发生。→ Task 5 测试：这些情况下不评估、不提交。
3. 单个节拍的 `when` 抛错拖垮整轮或卡住世界。→ Task 6 测试：只排除该节拍，记录原因，下一轮照常。
4. 重新生成时节拍或随机数与原回合不同。→ Task 7 测试。
5. 刺激文字经别的路径泄露给其他角色或玩家。→ Task 6 测试：断言别的角色的模型请求和玩家视图不含该文字。

---

### Task 1：在场角色知道自动事件内容

**Files:**
- Modify: `packages/application/src/activity-state.ts`、`packages/application/src/activity-lifecycle.ts`、`desktop/host/activities-runtime.ts`、`desktop/host/activity-runtime.ts`
- Create: `tests/host/auto-start-scene-notice.test.ts`
- Modify 文档：`docs/current/guides/activity-and-variables.md`、`skills/perspectra-creator/references/gameplay.md`

**Interfaces:**
- Produces: `parseActivityAutoStart` 的返回增加 `sceneNotice?: string`；`ActivityRuntime.apply` 第二参数变为 `{ notice?: string; sceneNotice?: string }`。

- [ ] **Step 1: 建分支并提交设计和计划。**
- [ ] **Step 2: 写失败测试。** 用 `cross-scene-activity` 副本，同场再放一个非参与者。断言：参与者和旁观者观察 `resultDescription` 为 sceneNotice；旁观者观察没有 `resultMetadata`；不在场者没有观察；玩家优先读 notice，没有 notice 和 opening 时读 sceneNotice；不写 sceneNotice 时结果和现状一致；模型请求含这段文字。超过 500 字报错。
- [ ] **Step 3: 确认失败。** `npx vitest run --config vitest.config.ts tests/host/auto-start-scene-notice.test.ts`
- [ ] **Step 4: 实现。** 字段校验同 `notice`。旁观者用 `SceneDecisionService.audienceForAction` 的 scene_public，减去参与者和玩家，基于开始前前缀。
- [ ] **Step 5: 核对呈现。** 打印一次发给旁观者的请求，确认文字不会被读成玩家做的事。如果会，观察加上 `eventNotice` 这类无行动者的字段，并记录这个决定。
- [ ] **Step 6: 运行** 上述测试、`tests/scenarios/activity-auto-start.test.ts`、`tests/host/pack-activities.test.ts`，以及基线比较。
- [ ] **Step 7: 提交** `feat: tell those present what an automatic event was`。

### Task 2：共用回合计数

**Files:**
- Create: `packages/contracts/src/round-count.ts`、`packages/contracts/src/round-count.test.ts`
- Modify: `packages/contracts/src/index.ts`、`packages/application/src/status-operations.ts`、`packages/application/src/status-operations.test.ts`

**Interfaces:**
- Produces: `playerRoundNumber(events: readonly RoundCountEvent[], turnStartSeq: number, pause: boolean): { round: number; turnCommits: number }`，`RoundCountEvent` 含 `seq`、`transactionId`、`eventType`、`data`。`statusRoundNumber` 从 application 删除，调用方改用它。

- [ ] **Step 1:** 把 `status-operations.test.ts` 里的轮次用例搬到 `round-count.test.ts`，再加“静观算一轮”“钩子失败后的轮次仍计入”（Review Focus 1）。确认失败。
- [ ] **Step 2:** 移动实现，语义不变。
- [ ] **Step 3:** 运行 `round-count.test.ts`、`status-operations.test.ts`、`tests/host/pack-status-runtime.test.ts`、`tests/host/pack-status-activity.test.ts`。
- [ ] **Step 4: 提交** `refactor: share player round counting through contracts`。

### Task 3：`ctx.pacing` 骨架

**Files:**
- Create: `packages/plugin-sdk/src/pacing.ts`、`packages/official-pacing/package.json`、`packages/official-pacing/src/index.ts`、`packages/official-pacing/src/definition.ts`、`desktop/host/pacing-source.ts`、`tests/host/pacing-seam.test.ts`
- Modify: `packages/plugin-sdk/src/index.ts`、`packages/plugin-sdk/src/host.ts`、`packages/plugin-sdk/src/world.ts`、`packages/plugin-sdk/src/version.ts`、`desktop/host-plugins.ts`、`desktop/host-plugin-manifest.ts`、`desktop/official-bundle.ts`、`desktop/host/plugin-set.ts`、`desktop/host/world-runtime.ts`、`desktop/host/gameplay-services.ts`、`apps/launcher/src/stores/modules.ts`、`apps/launcher/src/components/PluginSettingsBlock.vue`、`tsconfig.json`、`vitest.config.ts`、`docs/current/architecture/modules.md`

沿用 `ctx.autonomy` 的全部接法（`PacingSlot`、`installOfficialBundle`、`composeWorldSeams`、`officialWorldOrder`，放在 activities 之后）。

**Interfaces:**
- Produces:

```ts
export type PacingIntensity = 'low' | 'medium' | 'high'
export interface PacingSource { readonly script: string }
export interface PacingCandidate {
  readonly kind: 'activity' | 'beat'
  readonly key: string
}
export interface PacingHistory {
  readonly round: number
  readonly fired: readonly { readonly kind: 'activity' | 'beat'; readonly key: string; readonly round: number }[]
  readonly statusChanges: readonly { readonly key: string; readonly round: number }[]
  readonly activityEnds: readonly { readonly key: string; readonly round: number }[]
}
export type PacingChoice =
  | { readonly kind: 'activity' | 'beat'; readonly key: string; readonly reason: WorldJsonObject }
  | { readonly kind: 'none'; readonly reason: WorldJsonObject }
export interface PacingInstance {
  readonly definition: unknown
  /** 受管理的活动键；未列入的活动不经过 choose。 */
  readonly managedActivities: readonly string[]
  readonly beats: readonly string[]
  checks(beatId: string, input: { truth: StatusTruth; world: WorldJsonObject }): unknown
  choose(input: {
    candidates: readonly PacingCandidate[]
    history: PacingHistory
    random: () => number
  }): PacingChoice
  apply(beatId: string, input: { truth: StatusTruth; world: WorldJsonObject }, random: () => number): unknown
  close?(): void | Promise<void>
}
export interface PacingSlotApi {
  register(provider: SeamProvider<PacingInstance>): () => void
  readonly current: SeamProvider<PacingInstance> | undefined
}
```

- `WorldServices.pacingSource?: PacingSource`；`HOST_API_VERSION` 改为 `'2.9'`。
- `guardedPacing(instance, hasSource, id, report)` 在 gameplay-services，复制输入输出并保留错误类别。

- [ ] **Step 1: 写失败测试。** 没有脚本时世界正常打开；有脚本但省略机制时报 `世界声明的 pacing 需要对应机制`；替代 Provider 被调用且关闭；配置错误（未知字段、未声明活动、强度非法、`cycleRounds` 小于 2、概率越界、节拍声明和实现对不上）打开时报错并指明字段；世界包有节拍但没有状态声明时报错。
- [ ] **Step 2: 确认失败。** `npx vitest run --config vitest.config.ts tests/host/pacing-seam.test.ts`
- [ ] **Step 3: 实现接线。** `definition.ts` 解析 `pacingScript.definition`，配置形状见设计 4.1。VM 调用沿用 `official-activities` 的 `#call` 做法，`apply` 用和 `initialize` 相同的方式把 `Math.random` 接到传入的 random。`choose` 这一步先固定返回 `{ kind: 'none', reason: {} }`。运行 `corepack pnpm@11.7.0 install --offline` 链接新包。
- [ ] **Step 4: 运行** `pacing-seam.test.ts`、`tests/host/world-composition.test.ts`、`tests/host/boundaries.test.ts`、`tests/host/plugin-set.test.ts`，以及 Launcher 类型检查和基线比较。
- [ ] **Step 5: 提交** `feat: add the pacing mechanism service`。

### Task 4：选择算法

**Files:**
- Create: `packages/official-pacing/src/choose.ts`、`packages/official-pacing/src/choose.test.ts`
- Modify: `packages/official-pacing/src/index.ts`

**Interfaces:**
- Produces: `choosePaced(definition: PacingDefinition, input: { candidates; history; random }): PacingChoice`。`reason` 含 `round`、`tension`、`stagnation`、`chance`、`why`（`cooling`、`not-this-round`、`recovering`、`no-candidates`、`chosen`）。

- [ ] **Step 1: 写失败测试**，公式见设计 4.3，全部用固定随机序列：
  - 冷却内不发生，也不抽随机数；冷却由上次事件的强度决定。
  - 随机数大于等于 `p` 时不发生。
  - 恢复期内去掉 high，只剩 high 时不发生。
  - 相位最高时 high 权重最大，最低时 low 权重最大，每项不低于 0.05。
  - 无进展超过 `afterRounds` 后概率和紧张度上升，到顶不再升；声明的状态变化或活动结束会清零。
  - 相同输入得到相同结果，随机数抽取次数固定。
  - 分布模拟：10000 轮种子随机，断言冷却从未被违反，并把间隔和强度比例记入测试注释，不当作体验证据。
- [ ] **Step 2: 确认失败。** `npx vitest run --config vitest.config.ts packages/official-pacing/src/choose.test.ts`
- [ ] **Step 3: 实现纯函数。** 不读库，不用 Date，不用 `Math.random`。
- [ ] **Step 4: 运行并提交** `feat: choose paced events from committed history`。

### Task 5：把节奏接进回合，先管活动

**Files:**
- Create: `packages/application/src/pacing-state.ts`、`packages/application/src/pacing-state.test.ts`、`desktop/host/pacing-runtime.ts`、`tests/scenarios/pacing-activities.test.ts`
- Modify: `packages/application/src/index.ts`、`desktop/host/activities-runtime.ts`、`desktop/host/world-adapters.ts`、`desktop/host/world-runtime.ts`、`desktop/host/creator-queries.ts`、`desktop/lens/simulation.ts`

**Interfaces:**
- Produces:
  - `pacingHistory(events, turnStartSeq, pause, progress: { statuses: readonly string[]; activities: readonly string[] }): PacingHistory`，在 application。回合数用 `playerRoundNumber`。
  - `ActivitiesRuntime.autoStartCandidates()`：返回现有评估的候选；`ActivitiesRuntime.startAuto(key)`：开始指定候选；`ActivitiesRuntime.drawRandom()`：回合随机序列。现有 `autoStart()` 由这三者组成。
  - `PacingRuntime.endOfRound(): Promise<{ started: boolean; reactAfterSeq?: number }>`：见下。

**流程（替代 `#autoStartActivity` 中对 `activity.autoStart()` 的调用；没有 pacing 脚本时走原路径）：**

1. 活动在前台、暂停、逃生、关闭、外部结果未知时直接返回（Review Focus 2）。
2. 取活动候选。有未受管理的：调 `autoStart()` 原逻辑，结束。
3. 其余候选交 `pacing.choose`。选中活动就 `startAuto`，其后沿用现有“参与者回应”。
4. 决策说明存进 `lastDecision`，进创作者查询和透视，不进玩家视图。

- [ ] **Step 1: 写失败测试。** `pacingHistory` 的计数和来源；两个受管理活动同时满足时只开始一个；冷却内不开始且没有新事件；未受管理的活动不受冷却影响，优先开始；手动开始不受冷却限制；活动进行中、暂停、逃生后不评估（Review Focus 2）；创作者查询能看到原因，`state()` 和角色请求看不到。
- [ ] **Step 2: 确认失败。**
- [ ] **Step 3: 实现。** 无 `pacing.js` 的世界不走新逻辑。
- [ ] **Step 4: 运行** 新测试、`tests/scenarios/activity-auto-start.test.ts`、`tests/host/pack-activities.test.ts`、`tests/host/creator-inspection.test.ts`、基线比较。
- [ ] **Step 5: 提交** `feat: pace automatic activities`。

### Task 6：节拍：数值、文字、刺激

**Files:**
- Modify: `packages/application/src/pacing-state.ts`、`packages/application/src/pacing-state.test.ts`、`packages/application/src/status-state.ts`、`packages/contracts/src/status.ts`、`packages/official-pacing/src/index.ts`、`desktop/host/pacing-runtime.ts`、`desktop/host/world-runtime.ts`
- Create: `tests/scenarios/pacing-beats.test.ts`

**Interfaces:**
- Produces:
  - `StatusSource` 增加 `{ kind: 'beat'; beatId: string }`。`StatusState.beatResult(events, beatId, changes, reveals): StatusEventData`，告知对象要求是已声明角色。
  - `beatDrafts(input: { manifest; events; status: StatusEventData; beatId: string; actionId: string; notice?: string; sceneNotice?: string; stimuli: readonly BeatStimulus[]; sceneAudience: readonly string[]; playerId: string }): WorldEventDraft[]`。
  - `BeatStimulus = { characterId: string; kind: 'perception' | 'thought'; text: string }`，由 `parseBeatResult(value, characterIds, playerId)` 校验。
  - `perception` 的观察：`{ observerId, epistemicKind: 'direct_observation', content: { perceived: text } }`；`thought`：`{ observerId, epistemicKind: 'subjective_inference', content: { innerThought: text } }`。观察 ID 为 `${actionId}:stimulus:${index}`。
- `world` 输入是玩家视角加 `places: Record<characterId, locationId | null>`。

**提交：** `executeWorldRound`，无 actorId（系统回合），owner 为 `pacing:${headSeq}:${beatId}`，authority `{ source: 'pacing-beat', beatId, status: 'accepted' }`。提交后把 `#rootBeforeSeq` 设为提交前的 head，再调 `#activateCharacters(false)`，所以只有这次的观察会唤醒角色。

- [ ] **Step 1: 写失败测试：**
  - 节拍提交状态变化、文字和刺激，tick 只进一次，`status.updated` 来源是 beat。
  - 非法数值：整个节拍不提交，观察也没有（原子性）。
  - 未声明、已离场的角色或玩家作为刺激对象：整个节拍不提交，原因记录。
  - 超过 8 条、文字为空或超过 500 字被拒绝。
  - 只能由指定活动改变的状态被拒绝。
  - 刺激只进被点名角色的观察；其他角色的模型请求和玩家视图不含该文字（Review Focus 5）。
  - 收到刺激的角色得到一次机会，可以 abstain；不在场也能收到，但没有获得移动或物品权限。
  - `thought` 进入记忆来源时分类是 `subjective_inference`，`perception` 是 `direct_observation`。
  - 某节拍 `when` 或 `apply` 抛错：只排除这个节拍，这轮不提交，记录原因，下一轮照常（Review Focus 3）。
  - 没有变化的节拍也留下 `status.updated`，并计入冷却。
  - 活动脚本的 `previous` 和状态轮次计数不受节拍影响。
- [ ] **Step 2: 确认失败。** `npx vitest run --config vitest.config.ts tests/scenarios/pacing-beats.test.ts packages/application/src/pacing-state.test.ts`
- [ ] **Step 3: 实现。** 候选里加入 `when` 全部满足的节拍；检查格式复用 `parseActivityAutoStart` 的条件解析（`when` 部分抽成共用函数）。
- [ ] **Step 4: 核对呈现。** 打印一次收到两种刺激的模型请求，确认念头读起来是她自己的想法，察觉读起来是她看到的事。需要时补一段固定说明，经 `projectContext` 加入。记录最终文字。
- [ ] **Step 5: 运行** 新测试、`tests/host/pack-status-runtime.test.ts`、`tests/scenarios/split-knowledge.test.ts`、基线比较。
- [ ] **Step 6: 提交** `feat: let beats change values and stimulate characters`。

### Task 7：存档、分支、重新生成

**Files:**
- Create: `tests/host/pacing-branches.test.ts`

- [ ] **Step 1: 写测试：** 相同前缀下重新生成回合，节拍选择和数值与原回合相同（Review Focus 4）；从节点恢复后冷却和相位不变；两条分支之后各走各的；Core 记忆模式下，节拍回合重生后记忆来源一致；透视推演能看到决策原因，并用同一组合。
- [ ] **Step 2: 运行。** 这些用例若直接通过，也要各做一次反向确认：临时把随机改成 `Math.random`，确认重新生成用例会失败，再改回。失败则按 systematic-debugging 修。
- [ ] **Step 3: 提交** `test: pin pacing across saves, branches and regeneration`。

### Task 8：甜蜜日程内容和作者文档

**Files:**
- Create: `examples/world-packs/model-girls-sweet-days/scripts/pacing.js`、`docs/current/guides/story-pacing.md`
- Modify: `examples/world-packs/model-girls-sweet-days/worldpack.source.json`、`examples/world-packs/model-girls-sweet-days/scripts/status.js`（如需新状态）、`skills/perspectra-creator/references/gameplay.md`、`skills/perspectra-creator/SKILL.md`、`AGENTS.md`、`docs/current/architecture/plugin-layering-direction.md`、`docs/current/architecture/mechanism-contracts.md`、`docs/current/architecture/plugin-standard.md`、`docs/current/architecture/README.md`、`docs/current/architecture/modules.md`

- [ ] **Step 1: 内容。** 给 `midnight-fridge`、`secret-notebook`、`blackout-comfort`、`jealousy-moment` 标强度；序章和结局不列入。新增 3–5 个可重复节拍（我起草，用户润色）。文字只写发生了什么和她察觉到什么。
- [ ] **Step 2: 测试。** `tests/scenarios/model-girls-sweet-days.test.ts` 加用例：包能打开，节拍能在固定随机下发生，序章仍然先发生。
- [ ] **Step 3: 作者指南。** 例子先行，写清三件事：怎么写察觉和念头，不要写指令（给正反例），以及节奏只调节供应、不保证体验。
- [ ] **Step 4: AGENTS。** 第 4 节补一句：作者的察觉和念头属于世界包内容，不是调度器行为；不得用它规定角色的行动或台词。
- [ ] **Step 5: 暂缓页。** 剧情导演标记已实施并链接记录；持久状态继续暂缓，并写明起伏器不依赖它。运行 `node scripts/docs/check-links.mjs`，确认没有新增断链。
- [ ] **Step 6: 提交** `feat: pace the sweet days pack and document story pacing`。

### Task 9：真实对照与记录

**Files:**
- Create: `tests/experiments/pacing-compare-live.ts`、`docs/current/studies/2026-11-story-pacing.md`

**Interfaces:**
- `pacing-compare-live.ts` 用同一组约 30 句玩家输入跑甜蜜日程，节奏开启和关闭各两次（关闭时用不带 `pacing.js` 的包副本）。每次写转录和统计到新目录：事件次数和间隔、最长无事件回合、强度序列、收到刺激后的回应。

- [ ] **Step 1: 全量检查。** `corepack pnpm@11.7.0 check`、`corepack pnpm@11.7.0 launcher:check`、后端构建、`node scripts/release/verify-worldpack-cli.mjs`、基线比较。
- [ ] **Step 2: 真实对照。** gemini-3.8-flash，经本机 8045 网关。网关不可用就如实记录未运行，不用桩模型代替。
- [ ] **Step 3: 读转录并写记录。** 如实写：高强度是否扎堆、角色是否知道事件内容、回应是否照本宣科、念头有没有被说成事实、自然度和重复感。区分测试通过和体验结论。
- [ ] **Step 4: 提交** `docs: record story pacing comparison`。
- [ ] **Step 5: 交给用户。** 给出转录路径和观察，由用户决定是否在甜蜜日程上默认启用、机制是否保留、公式怎么调。不自行合并。

## 什么时候停

- Task 1 可以单独合并。只想修认知问题，就停在这里。
- Task 1 的 Step 5 或 Task 6 的 Step 4 发现呈现有问题且修不好：停下问用户。
- 基线或测试出现解释不了的差异：停下。
- 真实对照没有明显改善：不默认启用，由用户决定机制去留。
