# 插件优先运行时阶段 4：规则接缝与内部拆分 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让开发者能给所有世界加全局规则，并把玩法代码按职责移出 `world-runtime.ts`，行为和模型请求都不变。

**Architecture:** 新增可叠加的 `ctx.rules`，包在核心规则外面，玩家和角色的行动都经过它。玩法模块留在宿主内，由一个内部组合对象持有，轮次、输入、投影和创作者查询拆到各自的文件。不做 `ctx.gameplay`，也不建 `official-gameplay`。

**Tech Stack:** TypeScript strict、ESM、显式 `.ts` 导入、Cordis 4.0.1、vitest。

**Spec:** [插件优先运行时](../specs/2026-11-02-plugin-first-runtime-design.md) 第 6.4、6.5 节，以及用户选定方案 B 的[摸底记录](../../current/studies/2026-11-plugin-first-phase-4-survey.md)。方案 B 取代了 6.5 节的 `ctx.gameplay`。

## 这一阶段能得到什么

例如开发者想让“上锁的房间”在所有世界里都进不去：写一个规则插件，拒绝走向那个房间的行动，并把它从可选目的地里去掉。玩家和角色都受约束，世界事实不会记录这次移动。

**预计成本。** `world-runtime.ts` 从 2,254 行减到约 1,500 行。这只是移动代码，每个任务都要保持行为不变。前几个阶段的行数估计都偏乐观，以实际为准。

## 读代码发现的一点

核心规则现在有多个独立实例：`WorldApplication` 默认建一个（玩家输入），`#coreRules()` 一个（角色），`PackActivity` 和 `PackActivities` 各自再建。只包 `#rulebooks` 的话，插件只约束角色，玩家走得进上锁的房间。所以 Task 1 要把这些地方都改成用同一个规则来源。

## Global Constraints

- 官方组合下，模型请求和玩家转录与基线逐字一致；有差异必须能解释并写进 ledger。
- 规则结果只能产出主干认识的事件，提交仍走 `RoundCoordinator`，插件不能直接写入世界。
- 只有 `desktop/official-bundle.ts` 能 import `packages/official-*`，边界脚本检查。
- 宿主 API 升到 `1.4`。
- 每个任务都要通过 `corepack pnpm@11.7.0 check` 和 `corepack pnpm@11.7.0 launcher:check`，**都通过后才提交**。
- 拆分只移动代码：不改文案、不改顺序、不顺手修别的问题。发现问题记进 ledger。
- 不移动 `pack-*.ts` 的文件位置，也不改世界包脚本接口。
- 新实验使用新数据目录，`D:/worlds` 只读。在本机运行 Core 时，`TEMP`、`TMP` 和数据目录都放到仓库 `.tmp` 下，`HCW_HINDSIGHT_ONNX_DIR` 指向 `runtime/models/e5-small`。
- 真实试玩用本机 8045、`gemini-3.8-flash`、思考强度 low。

## 有意接受的限制

- **规则是同步的。** 现有规则接口就是同步的，插件不能在裁定时调用模型或网络。需要异步的用现有 `ctx.capabilities`。
- **不做 `ctx.gameplay`。** 第三方不能替换整个活动或状态系统。
- **规则应当是确定的。** 重新生成和回放依赖这一点，宿主不检查，写在指南里。
- **自主预算** `#modelCallBudget` 随自主行动移到新文件，不进 `official-scheduler`。设计说它随官方自主调度移入，但自主调度依赖玩法，留在宿主内。

## Review Focus

1. 规则插件在活动进行时：拒绝玩家和角色的行动，活动本身的规则和轮次不被破坏。（Task 1）
2. 规则插件的 `resolve` 抛错：这一轮失败并提示插件 ID，已提交内容保留，下一轮可以继续；玩家自己的输入得到明确提示。（Task 1）
3. 官方组合下，新增的规则包装层没有改变 `interactionTrace`、`manifestation` 等字段，节点、回放和重新生成照常。（Task 1）
4. 拆分后，暂停、打断、逃生、关闭发生在活动轮次或自主行动中途时，行为和之前相同。（Task 3）
5. 重新生成和恢复时，玩法状态按实例隔离，新的内部组合对象不跨世界实例共享。（Task 2）

---

### Task 1: 规则接缝 `ctx.rules`

**Files:**
- Create: `desktop/host/rule-layers.ts`、`tests/host/rules-seam.test.ts`
- Modify: `packages/plugin-sdk/src/index.ts`、`packages/plugin-sdk/package.json`、`desktop/host-plugins.ts`、`desktop/host-plugin-manifest.ts`、`desktop/official-bundle.ts`、`desktop/host/world-runtime.ts`、`desktop/host/pack-activity.ts`、`desktop/host/pack-activities.ts`、`desktop/host/tail-runtime.ts`、`apps/launcher/src/components/PluginSettingsBlock.vue`

**Interfaces:**
- Produces（`plugin-sdk`，类型来自 `kernel`，只用 `import type`）：

```ts
export type { RulebookResolutionContext as RuleContext, RulebookResolution as RuleResolution, ActionAffordance } from '@harness-world/kernel'

/** One layer of rules around the official ones. Rules decide synchronously and must be deterministic. */
export interface RulesInstance {
  resolve?(context: RuleContext, next: (context: RuleContext) => RuleResolution): RuleResolution
  affordances?(
    context: Omit<RuleContext, 'action' | 'actionId'>,
    next: (context: Omit<RuleContext, 'action' | 'actionId'>) => readonly ActionAffordance[],
  ): readonly ActionAffordance[]
  close?(): void | Promise<void>
}
/** `ctx.rules`: any number of layers, the first registered outermost. */
export interface RulesApi {
  register(provider: SeamProvider<RulesInstance>): () => void
  readonly providers: readonly SeamProvider<RulesInstance>[]
}
```

- `HostSeams` 增加 `rules?: readonly SeamProvider<RulesInstance>[]`。
- `rule-layers.ts` 导出 `layeredCoreRules(layers: () => readonly RulesInstance[], report: ReportPluginFailure-like): RulebookRegistry`：包住 `createCoreRulebookRegistry`，每次调用时才读取 `layers()`，所以可以在插件打开前传给 `WorldApplication`。
- `PackActivity`、`PackActivities` 的 `load` 增加 `coreRules: RulebookRegistry`，替换内部的 `createCoreRulebookRegistry`。

- [ ] **Step 1: 记录基线**

沿用 scratchpad 的 `decision-probe.mts`，再加上：`status-market` 场景；甜蜜日程走自动序章（`autoStart` 后按序章操作）；狼人杀推进到角色发言。输出请求和转录。

Run: 在当前 HEAD 跑两次并比较。
Expected: 两次逐字相同，每个场景都有请求或转录。狼人杀如果仍发不出请求，记进 ledger，并靠场景测试覆盖。

- [ ] **Step 2: 写失败测试 `tests/host/rules-seam.test.ts`**

```ts
it('refuses a character move through a rule layer', ...)               // 角色回答 move 到上锁房间，世界没有 character.moved
it('refuses a player move through the same layer', ...)                // /act move 被拒，提示原因，位置不变
it('binds inside a running activity too', ...)                         // scripted-performance 或狼人杀进行时，同一规则仍生效
it('removes an option through affordances', ...)                       // 玩家可选目的地和角色请求的 affordances 都没有上锁房间
it('applies layers in load order, the first outermost', ...)
it('fails the round and names the plugin when a layer throws', ...)    // 玩家输入保留，下一轮可继续，日志有错误
it('closes open layers when a later one cannot open', ...)             // 世界不打开，错误带插件 ID
it('refuses to regenerate after the rule layers changed', ...)
it('leaves resolutions untouched with no layers', ...)                 // 结果含 interactionTrace 时对象内容不变
```

Run: `node node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/host/rules-seam.test.ts`
Expected: FAIL，`plugins.rules` 没有生效。

- [ ] **Step 3: 实现**

在 `WorldHostCore` 构造函数里建一个规则注册表并传给 `WorldApplication`，`#coreRules()` 返回它；`#openRules` 在 `#openLlm` 之后依次打开，失败时关闭已打开的并抛错。层抛错时沿用 `#reportPlugin` 记录。`create` 里 `PackActivities.load` 传入同一注册表。指纹增加 `ruleProviders`。`SERVICES` 和启动器文案加 `rules`（“增加世界规则”），`HOST_API_VERSION` 升到 `1.4`。

- [ ] **Step 4: 运行测试和基线对比**

Run: 接缝测试；`corepack pnpm@11.7.0 test:related tests/host/pack-activity.test.ts tests/host/pack-status-activity.test.ts`；探针。
Expected: 全部通过；请求和转录逐字相同。

- [ ] **Step 5: 全量检查通过后提交**

```bash
corepack pnpm@11.7.0 check && corepack pnpm@11.7.0 launcher:check && git add -A packages desktop tests apps/launcher/src pnpm-lock.yaml && git commit -m "feat: let plugins layer rules around the official ones"
```

### Task 2: 玩法组合对象

**Files:**
- Create: `desktop/host/world-gameplay.ts`
- Modify: `desktop/host/world-runtime.ts`

**Interfaces:**
- Consumes: Task 1 的规则注册表。
- Produces: `class WorldGameplay`，每个 `WorldHostCore` 一个。持有 `activity`、`status`、`autonomy`、`communication`、`knowledge`、`modules`。
  - `static load(input): Promise<WorldGameplay>`：`create` 里的玩法装配。
  - `rulebooks(worldPath): RulebookRegistry`：`#rulebooks`。
  - `decisionContext(request): CharacterTurnRequest`：`#decide` 里的状态和知识。
  - `turnOptions(path, autonomous)`：`#turnFactory` 里 `projectContext`、`validateDecision`、`executionResult`、`resolveAction` 这些选项。

- [ ] **Step 1: 移动代码**

宿主字段换成 `#gameplay`，调用点写成 `this.#gameplay.activity`。不改逻辑、不改顺序。

- [ ] **Step 2: 验证**

Run: `corepack pnpm@11.7.0 exec tsc --noEmit -p tsconfig.json`；探针；`tests/scenarios/model-girls-werewolf.test.ts`、`model-girls-sweet-days.test.ts`、`official-demo.test.ts`。
Expected: 全部通过；请求和转录逐字相同。

- [ ] **Step 3: 全量检查通过后提交**

```bash
corepack pnpm@11.7.0 check && corepack pnpm@11.7.0 launcher:check && git add -A desktop tests && git commit -m "refactor: gather the host's gameplay modules in one object"
```

### Task 3: 轮次和提示

**Files:**
- Create: `desktop/host/activity-round.ts`、`desktop/host/autonomy-round.ts`、`desktop/host/round-notices.ts`
- Modify: `desktop/host/world-runtime.ts`

**Interfaces:**
- Consumes: Task 2 的 `WorldGameplay`。
- Produces:
  - `runActivityChain(input): Promise<{ notice?: string; error: boolean }>`：`#runActivityChain`。
  - `runAutonomousRound(input): Promise<{ cycle; reason: string }>`：`#activateAutonomous`。预算对象由调用方传入，`spendCall` 读同一个对象。
  - `reactionNotice`、`autonomyNotice`、`playerResolutionNotice`：纯函数，返回提示文字。

- [ ] **Step 1: 移动代码，逐项对照**

入参只放它们实际用到的值。暂停、打断的判断通过传入的 `isStopped()` 读取当前状态，不能在开始时复制。

- [ ] **Step 2: 验证**

Run: 探针；`tests/scenarios/character-autonomy.test.ts`、`tests/host/pack-activity.test.ts`、`tests/host/scheduler-seam.test.ts`。
Expected: 全部通过；请求和转录逐字相同。

- [ ] **Step 3: 全量检查通过后提交**

```bash
corepack pnpm@11.7.0 check && corepack pnpm@11.7.0 launcher:check && git add -A desktop tests && git commit -m "refactor: move activity and autonomy rounds out of the world runtime"
```

### Task 4: 输入、投影和创作者查询

**Files:**
- Create: `desktop/host/player-input.ts`、`desktop/host/gameplay-projection.ts`、`desktop/host/creator-queries.ts`
- Modify: `desktop/host/world-runtime.ts`

**Interfaces:**
- Consumes: Task 2 的 `WorldGameplay`。
- Produces:
  - `routePlayerInput(input): Promise<InputOutcome>`：`#commitInput` 里按活动、短信、状态分发的部分。
  - `projectGameplay(input): GameplayProjection`：`#refresh` 里状态栏、活动视图、可用操作和短信的部分，宿主只负责赋值。
  - `creatorInspection(input)`、`creatorHistory(input)`：`world-runtime.ts` 里的同名方法只留一行转发。

- [ ] **Step 1: 移动代码**

- [ ] **Step 2: 验证**

Run: 探针；`tests/host/creator-observability.test.ts`、`tests/host/pack-status-runtime.test.ts`、`tests/scenarios/cross-scene-communication.test.ts`、`tests/host/frontend-api.test.ts`。
Expected: 全部通过；请求和转录逐字相同。

- [ ] **Step 3: 全量检查通过后提交**

```bash
corepack pnpm@11.7.0 check && corepack pnpm@11.7.0 launcher:check && git add -A desktop tests && git commit -m "refactor: move input routing, projection and creator queries out"
```

### Task 5: 示例、试玩与文档

**Files:**
- Create: `examples/host-plugins/locked-room.mjs`、`locked-room.plugin.json`、`docs/current/studies/2026-11-plugin-first-phase-4.md`
- Modify: `docs/current/guides/host-plugin-authoring.md`、`docs/current/host-plugins.md`、`docs/current/architecture/modules.md`、`runtime.md`、`code-walkthrough.md`、`desktop/host/README.md`、`docs/superpowers/specs/2026-11-02-plugin-first-runtime-design.md`（第 6.4、6.5 节加注）

**Interfaces:** 无。

- [ ] **Step 1: 示例插件**

`locked-room.mjs` 配置一个 `locationId`，拒绝走向它的 `move`，并把它从 `destinations` 里去掉。用测试经真实加载器加载一次。

- [ ] **Step 2: 真实模型试玩**

`main` 和本分支对比：`dynamic-scheduling` 的 Core 8 轮；甜蜜日程走自动序章和之后的几轮；狼人杀一局；状态市场短局。本分支再加一局 `locked-room`：角色和玩家都想进上锁的房间，看角色怎样回应被拒，有没有在对白里当作已经进去了。

- [ ] **Step 3: 更新文档并写阶段记录**

先给角色例子，再讲接缝。记录 `world-runtime.ts` 行数、对比结果、未验证内容，以及阶段 5 的判断。

Run: `node scripts/docs/check-links.mjs`
Expected: 断链不超过 102，新增文件无断链。

- [ ] **Step 4: 全量检查通过后提交**

```bash
corepack pnpm@11.7.0 check && corepack pnpm@11.7.0 launcher:check && git add -A docs examples/host-plugins desktop/host/README.md && git commit -m "docs: record plugin-first phase 4 results"
```

**不要自动进入阶段 5。**
