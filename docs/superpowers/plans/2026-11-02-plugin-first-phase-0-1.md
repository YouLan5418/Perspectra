# 插件优先运行时：阶段 0 与阶段 1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让第三方插件能替换官方调度器，官方调度也走同一接缝，且只用官方插件时行为不变。

**Architecture:** 插件在进程启动时向 `ctx.scheduler` 注册 Provider，空缺由官方组合包填补；每个世界实例调用 `Provider.open` 得到调度器实例。宿主把回合能力封装成 `SchedulerRound`，调度器只按序号指定观察。提交、过期检查和写租约仍在主干。

**Tech Stack:** TypeScript strict、ESM、Cordis 4.0.1、Vitest、Node 24 `module.registerHooks`。

**Spec:** `docs/superpowers/specs/2026-11-02-plugin-first-runtime-design.md`

**范围：** 只含设计第 7 节的阶段 0、1。阶段 1 结束后是设计规定的决策点，后续阶段依据实际成本另写计划，路线见文末。

## 前置条件

- 当前 `feat/lens-standalone` 有未提交的透视改动和较多未跟踪文件。开工前由用户决定如何提交或合并。本计划从处理后的 `main` 新建分支 `feat/plugin-first`，不夹带这些改动。
- 真实模型步骤需要用户本机已配置的模型连接。不记录凭证。

## Global Constraints

- 只用官方插件时角色体验不退化；自动测试通过不算体验通过。
- 第三方插件不做沙箱；玩家设置的调用上限对它只作建议，宿主不做总量拦截。官方调度器继续遵守上限。
- 事件日志和原子提交不可替换。过期检查和写租约留在 `CharacterTurn`。
- 活动进行中的调度（`#runActivityChain`）不交给 `ctx.scheduler`。
- 第一版不升级 Cordis，不引入插件市场、npm 发布和校验目录。
- 宿主和 `application` 不得 import `packages/official-*`，唯一例外是默认组合包入口 `desktop/official-bundle.ts`。
- `packages/official-*` 运行时只依赖 `contracts`，类型可依赖 `plugin-sdk`。
- 新包需同时登记 `tsconfig.json` 的 `paths` 和 `vitest.config.ts` 的 `alias`。
- 按 `AGENTS.md`：不为通过旧测试保留旧路径；不写无实际价值的穷举测试；交付时如实说明未验证的内容。

## Review Focus

1. 第三方调度器抛错：玩家输入和已提交行动保留，玩家看到提示，下一轮可继续。（Task 5）
2. 第三方调度器返回非法结果或未知 `terminalReason`：按“本轮已结束”处理，不崩溃。（Task 5）
3. 调度器把别的角色的观察序号传给 `turn`：拒绝，模型请求中不出现该内容。（Task 4）
4. 第三方 `Provider.open` 失败：回退官方调度并提示，世界照常打开。（Task 5）
5. 存档用过第三方调度器后移除插件，再次打开：回到官方调度，世界事实不变。（Task 6）

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `packages/plugin-sdk/src/index.ts` | 增加 `SeamProvider`、`WorldServices`、`Scheduler*` 类型和 `SchedulerSlotApi` |
| `desktop/plugin-resolve.ts`（新） | 让插件的 `@deepseek-ai/cordis` 解析到宿主这一份 |
| `desktop/host-plugins.ts` | 增加 `SchedulerSlot` 服务；加载后填补官方实现 |
| `desktop/official-bundle.ts`（新） | 默认组合包入口，第一版只含调度器 |
| `packages/official-scheduler/`（新） | 从 `activation-cycle.ts` 迁入的串行和动态算法 |
| `packages/application/src/scheduler-round.ts`（新） | `createSchedulerRound`：由 store 和 turn 构造 `SchedulerRound` |
| `packages/application/src/activation-cycle.ts` | 删除 |
| `desktop/host/world-runtime.ts` | 打开和关闭调度器实例，经接缝调用，处理插件异常 |
| `examples/host-plugins/impulsive-scheduler.mjs`（新） | 第三方示例 |

---

### Task 1: 更新项目约定

**Files:**
- Modify: `AGENTS.md`（第 2、3、4、5 节）
- Modify: `docs/current/prototype-contract.md`（约第 86–87 行的非目标表及相关段落）
- Modify: `docs/current/vision.md`

**Interfaces:** 无。

- [ ] **Step 1: 修改 `AGENTS.md`**

第 2 节注明插件化运行时已获用户批准，并链接设计文档，其余“不主动引入”的约束不变。第 4 节注明有界执行是官方调度器的保证。第 3、5 节增加一句：这些不变量由主干和官方插件保证，启用第三方插件后取决于插件作者。

- [ ] **Step 2: 修改契约和愿景**

把“通用插件平台”从非目标中移除，并写明第 3 节已定决策。只改冲突的内容。

- [ ] **Step 3: 检查链接并提交**

Run: `node scripts/docs/check-links.mjs`
Expected: 无断链。

```bash
git add AGENTS.md docs/current/prototype-contract.md docs/current/vision.md
git commit -m "docs: adopt the plugin-first runtime direction"
```

### Task 2: 记录调度基线

**Files:** 不改代码。输出在已被忽略的 `output/` 目录。

**Interfaces:** 无。

- [ ] **Step 1: 运行受控对比并保存结果**

Run: `node --import tsx tests/experiments/dynamic-scheduling.ts`
Expected: 输出写入 `output/dynamic-scheduling/comparison-*`。记下目录名。

- [ ] **Step 2: 请用户用真实模型试玩并记录**

需要用户本机的模型连接。用同一模型试玩 `model-girls-sweet-days` 和 `model-girls-werewolf` 各约 10 回合，在创作者页面导出或记录对白节奏、抢话和沉默情况，存到 `output/plugin-first-baseline/`。用户暂时无法进行时，要在交付说明中写明“无真实模型基线”，不得声称体验无退化。

- [ ] **Step 3: 记录基线状态**

Run: `corepack pnpm@11.7.0 check`
Expected: 全部通过。如有既有失败，把失败清单记到 `output/plugin-first-baseline/check-before.txt`，后续只比较新增失败。

### Task 3: 接缝框架与 Cordis 解析

**Files:**
- Create: `desktop/plugin-resolve.ts`, `desktop/official-bundle.ts`
- Modify: `packages/plugin-sdk/src/index.ts`, `desktop/host-plugins.ts`, `desktop/host-plugin-manifest.ts:5`, `apps/launcher/src/components/PluginSettingsBlock.vue:14`
- Test: `tests/desktop/host-plugins.test.ts`, `tests/host/capability-plugin-entry.test.ts`

**Interfaces:**
- Produces（`plugin-sdk`）：
  - `HOST_API_VERSION = '1.1'`
  - `interface SeamProvider<Instance> { readonly id: string; readonly version: string; open(world: WorldServices, signal: AbortSignal): Promise<Instance> }`
  - `interface WorldServices { readonly address: WorldAddress; readonly worldVersion: string; readonly dataDirectory: string; readonly world: WorldReader }`
  - `interface WorldReader { readEvents(afterSeq: number, throughSeq: number, types?: readonly string[]): readonly WorldJsonObject[]; characterObservations(characterId: CharacterId, throughSeq: number): readonly WorldJsonObject[] }`
  - 设计第 6.1 节的 `SchedulerInstance`、`SchedulerRound`、`SchedulerObservation`、`SchedulerTurnOptions`
  - `interface SchedulerTurnResult { readonly status: 'published' | 'abstained' | 'budget_exhausted' | 'interrupted' | 'inactive' | 'stale' | 'failed'; readonly calls: number; readonly asOfWorldSeq?: number; readonly performResult?: WorldJsonObject; readonly failure?: 'provider_failed' | 'invalid_output' | 'preset_failed' }`
  - `interface ActivationLimits { readonly maximumWaves: number; readonly maximumNpcCalls: number; readonly maximumCallsPerCharacter: number; readonly reactionDeadlineSeconds?: number }`
  - `interface AutonomyOpportunities { readonly roles: readonly { characterId: CharacterId; opportunities: number }[]; readonly maximumNpcCalls: number; readonly deadlineSeconds: number; readonly reactionLimits: ActivationLimits }`
  - `interface SchedulerActivation { readonly characterId: CharacterId; readonly result: SchedulerTurnResult }`
  - `interface SchedulerCycle { readonly calls: number; readonly wave: number; readonly terminalReason: string; readonly activations: readonly SchedulerActivation[] }`
  - `interface SchedulerResult extends SchedulerCycle { readonly autonomy?: { readonly activations: readonly SchedulerActivation[]; readonly autonomousCalls: number; readonly reactionCalls: number; readonly reactions: SchedulerCycle; readonly terminalReason: string } }`
  - `interface SchedulerSlotApi { register(provider: SeamProvider<SchedulerInstance>): () => void; readonly current: SeamProvider<SchedulerInstance> | undefined }`，加入 `HostServices` 的 `scheduler`
- Produces（`desktop/plugin-resolve.ts`）：`installPluginResolver(): void`，多次调用只生效一次
- Produces（`desktop/official-bundle.ts`）：`interface HostSeams { readonly scheduler: SeamProvider<SchedulerInstance> }`；`officialSeams(): HostSeams`
- Produces（`host-plugins.ts`）：`HostPlugins` 增加 `readonly seams: HostSeams`

- [ ] **Step 1: 写失败测试（`tests/desktop/host-plugins.test.ts`）**

把插件文件写到 `os.tmpdir()` 下的 `mkdtemp` 目录，那里解析不到仓库的 `node_modules`。

```ts
it('fills an empty scheduler seam with the official provider', async () => {
  const plugins = await loadHostPlugins([])
  expect(plugins.seams.scheduler.id).toBe('official-scheduler')
  await plugins.close()
})
it('lets a player plugin take the scheduler seam and skips a second one', async () => {
  const first = await writePlugin('first', schedulerPluginSource('first'))
  const second = await writePlugin('second', schedulerPluginSource('second'))
  const plugins = await loadHostPlugins([enabled('first', first), enabled('second', second)])
  expect(plugins.seams.scheduler.id).toBe('first')
  expect(plugins.skipped).toEqual([{ id: 'second', reason: 'apply' }])
  await plugins.close()
})
it('hands a plugin outside the repository the same Cordis the host runs', async () => {
  const path = await writePlugin('classy', `
    import { Service } from '@deepseek-ai/cordis'
    export const hostApi = '1.1'
    class Marker extends Service { constructor(ctx) { super(ctx, 'marker') } }
    export default function (ctx) { new Marker(ctx); ctx.scheduler.register({ id: 'classy', version: '1.0.0', open: async () => ({ run: async () => ({ calls: 0, wave: 0, terminalReason: 'quiescent', activations: [] }) }) }) }
  `)
  const plugins = await loadHostPlugins([enabled('classy', path)])
  expect(plugins.skipped).toEqual([])
  expect(plugins.seams.scheduler.id).toBe('classy')
  await plugins.close()
})
```

`writePlugin`、`schedulerPluginSource`、`enabled` 是测试内的本地辅助函数。

- [ ] **Step 2: 确认失败**

Run: `corepack pnpm@11.7.0 test:related tests/desktop/host-plugins.test.ts`
Expected: FAIL，`seams` 未定义。

- [ ] **Step 3: 实现类型和服务**

`SchedulerSlot extends Service`，服务名 `scheduler`，重复注册时抛错（现有 `apply` 流程会撤销并跳过该插件），注册通过返回的注销函数撤销。`loadHostPlugins` 循环结束后：`seams = { scheduler: slot.current ?? officialSeams().scheduler }`。`desktop/host-plugin-manifest.ts` 的 `SERVICES` 增加 `'scheduler'`，Launcher 显示为“替换角色调度”。此任务里 `officialSeams` 的调度器实例可先直接抛 `not wired`，Task 4 完成后替换，且 Task 4 之前不接入宿主。

- [ ] **Step 4: 实现 `installPluginResolver`**

在 `loadHostPlugins` 导入插件之前调用。用 `module.registerHooks` 的 `resolve` 钩子拦截 `@deepseek-ai/cordis`，返回 `shortCircuit: true` 和一个 `data:text/javascript` URL。该模块从 `globalThis[Symbol.for('perspectra.cordis')]` 重新导出宿主的 Cordis，导出名由 `Object.keys(cordis)` 生成。其他模块名走默认解析。

- [ ] **Step 5: 在打包入口验证**

在 `tests/host/capability-plugin-entry.test.ts` 的 `source` 和 `built` 两种布局中，增加启用 Step 1 的 `classy` 插件（写到 `os.tmpdir()`），断言启动成功且 `skippedPlugins` 为空。

Run: `corepack pnpm@11.7.0 test:related tests/desktop/host-plugins.test.ts tests/host/capability-plugin-entry.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/plugin-sdk desktop/plugin-resolve.ts desktop/official-bundle.ts desktop/host-plugins.ts desktop/host-plugin-manifest.ts apps/launcher/src/components/PluginSettingsBlock.vue tests/desktop/host-plugins.test.ts tests/host/capability-plugin-entry.test.ts
git commit -m "feat: add the scheduler seam and host Cordis resolution for plugins"
```

### Task 4: 抽出官方调度器

**Files:**
- Create: `packages/official-scheduler/package.json`, `packages/official-scheduler/src/index.ts`
- Create: `packages/application/src/scheduler-round.ts`
- Delete: `packages/application/src/activation-cycle.ts`
- Modify: `packages/application/src/index.ts:10`, `tsconfig.json`, `vitest.config.ts`, `desktop/official-bundle.ts`, `desktop/host/world-runtime.ts`, `scripts/check-host-boundaries.mjs`
- Modify: `tests/scenarios/activation-tuning.test.ts`, `tests/scenarios/dynamic-scheduling.test.ts`, `tests/support/cross-scene-runtime.ts`, `tests/experiments/cross-scene-activity-live.ts`
- Create: `tests/support/run-activations.ts`
- Test: `tests/scenarios/scheduler-round.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `Scheduler*` 类型
- Produces（`official-scheduler`）：`officialSchedulerProvider: SeamProvider<SchedulerInstance>`（`id: 'official-scheduler'`）；`runOfficialSchedule(round: SchedulerRound, options?: { maximumConcurrent?: number; strictCallBudget?: boolean }): Promise<SchedulerResult>`
- Produces（`application`）：
  ```ts
  interface SchedulerRoundInput {
    store: WorldStore; address: WorldAddress; turn: ActivationTurn; afterSeq: number
    characterIds: readonly CharacterId[]; signal: AbortSignal; limits: ActivationLimits; allowConcurrent: boolean
    presentCharacterIds?: () => readonly CharacterId[]
    locationId?: (id: CharacterId) => string | null
    initialCounts?: ReadonlyMap<CharacterId, number>
    autonomy?: AutonomyOpportunities & { turn: ActivationTurn }
    world: WorldReader
  }
  function createSchedulerRound(input: SchedulerRoundInput): SchedulerRound
  type ActivationTurn = Pick<CharacterTurn, 'run'>
  ```

- [ ] **Step 1: 写失败测试（`tests/scenarios/scheduler-round.test.ts`）**

用 `tests/support` 现有夹具提交两条观察，一条给 A，一条给 B；`turn` 用记录参数的替身。

```ts
it('reports accepted observations from others and marks silent ones', () => {
  const round = createSchedulerRound(input)
  expect(round.observationsSince(0, round.headSeq())).toEqual([
    { seq: spokenSeq, characterId: a, substantive: true },
    { seq: silentSeq, characterId: b, substantive: false },
  ])
})
it('passes the exact observation values to the turn', async () => {
  await round.turn(a, { signal, stimulusSeqs: [spokenSeq], maxCalls: 2 })
  expect(calls[0].stimulus).toEqual([observationValueOf(spokenSeq)])
})
it("refuses another character's observation before any model work", async () => {
  await expect(round.turn(a, { signal, stimulusSeqs: [silentSeq], maxCalls: 2 })).rejects.toThrow(TypeError)
  expect(calls).toEqual([])
})
it('uses the autonomy turn for autonomous opportunities', async () => {
  await round.turn(a, { kind: 'autonomous', signal, stimulusSeqs: [], maxCalls: 2 })
  expect(autonomyCalls).toHaveLength(1)
})
```

`substantive` 的定义沿用现有判断：没有 `speech`，或有非空白 `speech` 片段，或 `addresseeIds` 包含该观察者。

- [ ] **Step 2: 确认失败**

Run: `corepack pnpm@11.7.0 test:related tests/scenarios/scheduler-round.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `createSchedulerRound`**

`observationsSince` 读 `observation.upsert`，按现有条件筛选，并在内部 `Map<seq, value>` 缓存观察值，`turn` 从缓存取值，缓存缺失时读该序号的事件。`turn` 校验每个序号的 `observerId === id`，否则抛 `TypeError`；`signal`、`maxCalls`、`maxModelCalls`、`onCommitted`、`continuationOf` 原样传给 `turn.run`。缺省值：`presentCharacterIds` 返回 `characterIds`，`locationId` 缺省时 `locationOf` 返回 `null`。

- [ ] **Step 4: 迁移算法到 `official-scheduler`**

把串行和动态两段算法原样移入，只替换数据来源，不调整顺序、预留和计数逻辑：

| 原写法 | 新写法 |
| --- | --- |
| `input.store.head(...).headSeq` | `round.headSeq()` |
| 读事件并判断 `status`、自身行动 | `round.observationsSince(cursor, head)` |
| `speech` 判断 | `!root && !observation.substantive` |
| 队列元素 `{ seq, value, ... }` | `{ seq, ... }`，`turn` 传 `stimulusSeqs` |
| `input.locationId` 存在时走动态 | `round.allowConcurrent` |
| `input.autonomy.turn.run` | `round.turn(id, { kind: 'autonomous', ... })` |

`Math.random` 的使用位置和次数不变，因为现有受控测试固定了它。`officialSchedulerProvider.open` 返回的实例，其 `run(round)` 调用 `runOfficialSchedule(round, { strictCallBudget: true })`。

- [ ] **Step 5: 宿主改用新函数**

`world-runtime.ts` 的两处 `runCharacterActivations` 暂时改为 `runOfficialSchedule(createSchedulerRound({...}), { strictCallBudget: true })`。`runOfficialSchedule` 经 `desktop/official-bundle.ts` 临时转出，以符合边界检查，Task 5 删除这个转出。`allowConcurrent` 取现有 `dynamic` 条件。删除 `activation-cycle.ts` 及其导出。Task 5 再改为经接缝调用。`world` 的实现放在 `desktop/host/world-reader.ts`：每次调用开关一个 `WorldStore`，`characterObservations` 用 `CharacterViewBuilder.rebuildAt`。

- [ ] **Step 6: 迁移现有测试**

新增 `tests/support/run-activations.ts`，导出与旧 `runCharacterActivations` 入参一致的 `runActivations(input)`，内部用 `createSchedulerRound` 和 `runOfficialSchedule`。旧 `locationId` 存在时 `allowConcurrent: true`；`limits` 缺省用 `{ maximumWaves: 3, maximumNpcCalls: 8, maximumCallsPerCharacter: 2 }`；透传 `maximumConcurrent` 和 `strictCallBudget`。旧测试只替换函数名和 import，**断言不改**。若某断言必须改，先弄清是否是行为变化，并在提交说明中写明。

- [ ] **Step 7: 增加边界检查**

`scripts/check-host-boundaries.mjs`：`desktop/` 和 `packages/application/` 中除 `desktop/official-bundle.ts` 外，禁止 import `official-*`；`packages/official-*` 禁止 import `application`、`store-sqlite`、`kernel` 和 `desktop/`（类型除外）。

- [ ] **Step 8: 全量验证**

Run: `corepack pnpm@11.7.0 check`
Expected: 相对 Task 2 记录没有新增失败。

Run: `node --import tsx tests/experiments/dynamic-scheduling.ts`
Expected: 串行和动态的调用顺序、并发峰值与 Task 2 的对比结果一致。

- [ ] **Step 9: 提交**

```bash
git add packages/official-scheduler packages/application desktop tsconfig.json vitest.config.ts scripts/check-host-boundaries.mjs tests/scenarios tests/support tests/experiments/cross-scene-activity-live.ts
git commit -m "refactor: move the activation algorithm into the official scheduler"
```

### Task 5: 宿主经接缝调度

**Files:**
- Modify: `desktop/host/world-runtime.ts`（`WorldHostOptions`、`create`、`#runSceneReactions`、`#activateAutonomous`、`close`）, `desktop/host/web-entry.ts:94-100`, `desktop/lens/simulation.ts`
- Create: `desktop/host/scheduler-result.ts`
- Test: `tests/host/scheduler-seam.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `HostSeams`、`officialSeams()`；Task 4 的 `createSchedulerRound`
- Produces: `WorldHostOptions.plugins?: HostSeams`，缺省 `officialSeams()`
- Produces: `normalizeSchedulerResult(value: unknown): SchedulerResult`，非法结果返回 `{ calls: 0, wave: 0, terminalReason: 'plugin_invalid', activations: [] }`

- [ ] **Step 1: 写失败测试（`tests/host/scheduler-seam.test.ts`）**

沿用 `tests/host/tail-round.test.ts` 的 `fakeModels`、`createChatServer` 和 `WorldHostRuntime.create` 写法，通过 `plugins` 传入替身 Provider。

```ts
it('runs the configured scheduler instead of the official one', ...)
  // 替身只让角色 B 处理；A 没有模型调用，B 有
it('keeps player input and continues the next round when the scheduler throws', ...)
  // state.error === true；notice 包含“调度器插件”；转录保留玩家输入；第二次 submit 成功
it('treats an invalid result as a finished round', ...)
  // run 返回 { nope: true }：不抛错，notice 为现有“本轮角色处理已结束”
it('falls back to the official scheduler when open fails', ...)
  // open 抛错：世界打开，notice 包含“已改用官方调度”，角色仍有回应
it('opens a separate instance for each regeneration candidate and closes it', ...)
  // regenerate 后 opened === 2；关闭后 closed === opened
it('aborts the round signal on pause', ...)
  // run 等待 signal；pause 后 run 结束
```

- [ ] **Step 2: 确认失败**

Run: `corepack pnpm@11.7.0 test:related tests/host/scheduler-seam.test.ts`
Expected: FAIL，`plugins` 未生效。

- [ ] **Step 3: 接入宿主**

- `create` 中 `open`，失败时打印错误、记下提示并改用 `officialSeams().scheduler`。
- `close` 中调用 `instance.close?.()`。
- `#runSceneReactions` 和 `#activateAutonomous` 的反应波都经 `#scheduler.run(createSchedulerRound(...))`，结果过 `normalizeSchedulerResult`。
- 非取消类异常：打印到标准错误，设 `#error = true`，`#notice` 写“调度器插件出错，本轮角色反应已停止；玩家输入保留，可以继续行动。”，返回空结果，不再上抛。
- 官方调度器的 `strictCallBudget` 和 `#modelCallBudget` 仍生效。`#modelCallBudget` 检查在 `#decide`，第一版保留，只由官方自主路径设置，第三方路径不设置。
- 不改 `#runActivityChain`。

- [ ] **Step 4: 接入入口和透视**

`web-entry.ts` 传 `plugins: hostPlugins.seams`。`TailRoundRuntime` 的 `factory` 已透传 options，确认候选也收到。`desktop/lens/simulation.ts` 使用缺省值，不改行为。

- [ ] **Step 5: 验证**

Run: `corepack pnpm@11.7.0 test:related tests/host/scheduler-seam.test.ts tests/host/tail-round.test.ts tests/host/lens-simulation.test.ts tests/scenarios/dynamic-scheduling.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add desktop tests/host/scheduler-seam.test.ts
git commit -m "feat: schedule character reactions through the scheduler seam"
```

### Task 6: 第三方示例与文档

**Files:**
- Create: `examples/host-plugins/impulsive-scheduler.mjs`, `examples/host-plugins/impulsive-scheduler.plugin.json`
- Modify: `examples/host-plugins/*.mjs`（无需改 `hostApi`，`1.0` 仍兼容，确认即可）
- Modify: `docs/current/host-plugins.md`, `docs/current/guides/host-plugin-authoring.md`, `docs/current/architecture/modules.md`, `docs/current/architecture/runtime.md`, `docs/current/architecture/code-walkthrough.md`
- Test: `tests/host/scheduler-seam.test.ts`

**Interfaces:**
- Consumes: Task 3、4 的公开接口。示例只能用这些接口，**不得** import 仓库内部文件。
- Produces: 配置项 `priority`（`string`，逗号分隔的角色 ID）

- [ ] **Step 1: 写失败测试**

```ts
it('lets the example plugin put impatient characters first', ...)
  // 通过 loadHostPlugins 加载示例；priority 为 B；A、B 同时听见；首个模型调用属于 B
it('reopens a save without the plugin under the official scheduler', ...)
  // 用示例玩一轮后关闭；不带插件重开：事件头不变，转录相同，下一轮走官方调度
```

- [ ] **Step 2: 确认失败**

Run: `corepack pnpm@11.7.0 test:related tests/host/scheduler-seam.test.ts`
Expected: FAIL，示例不存在。

- [ ] **Step 3: 实现示例**

约 50 行的串行调度：`hostApi = '1.1'`；循环取 `observationsSince`，只处理 `substantive`；优先级内的角色先于其他角色；遵守 `round.limits`；遇到 `failed`、`interrupted` 或 `signal.aborted` 时结束。清单 `services: ['scheduler']`。注释要说明遵守上限是示例作者的选择，宿主不强制。

- [ ] **Step 4: 确认通过**

Run: `corepack pnpm@11.7.0 test:related tests/host/scheduler-seam.test.ts`
Expected: PASS。

- [ ] **Step 5: 更新文档**

- 插件指南增加“替换调度器”一节，先给角色抢话的例子，再讲接口。写清可用写法（`ctx` 或 `import { Service }`）、上限只作建议、认知隔离取决于插件作者。
- 模块地图增加 `official-scheduler`，更新 `application` 和 `plugin-sdk` 的职责；代码路线和运行时把 `runCharacterActivations` 改为新路径。

Run: `node scripts/docs/check-links.mjs`
Expected: 无断链，模块地图覆盖新包。

- [ ] **Step 6: 提交**

```bash
git add examples/host-plugins docs/current tests/host/scheduler-seam.test.ts
git commit -m "feat: add an example third-party scheduler plugin"
```

### Task 7: 验收与决策点

**Files:**
- Create: `docs/current/studies/2026-11-plugin-first-phase-1.md`

**Interfaces:** 无。

- [ ] **Step 1: 全量检查**

Run: `corepack pnpm@11.7.0 check`
Expected: 相对 Task 2 没有新增失败。

Run: `corepack pnpm@11.7.0 launcher:check`
Expected: PASS。

- [ ] **Step 2: 请用户真实试玩**

与 Task 2 相同的世界包和模型，先用官方调度，再启用 `impulsive-scheduler`。对比对白节奏、抢话、沉默和跑题。同时确认：Launcher 能添加示例插件，插件页显示“替换角色调度”，移除后回到官方调度。

- [ ] **Step 3: 写阶段记录**

记录：实际改动和删减的行数；`world-runtime.ts` 变化；接口是否够用；未验证的内容（如发行包未重建）；后续阶段的工作量判断。

- [ ] **Step 4: 提交并与用户复核**

```bash
git add docs/current/studies/2026-11-plugin-first-phase-1.md
git commit -m "docs: record plugin-first phase 1 results"
```

依据记录和用户确认后续切法，再写下一阶段计划。**不要自动进入阶段 2。**

---

## 后续路线（决策点后另写计划）

| 阶段 | 内容 | 开工前必须先查清 |
| --- | --- | --- |
| 2 记忆 | 拆 `packages/memory`；Core 走 `ctx.memory`；删原生召回；`official-memory-none` | `capture`、`catchUp`、`processPending` 对召回表的依赖；`memory.json` 和 `cognitiveMemoryVersion` 的去留 |
| 3 决策管道 | `character/context`、`character/decide`；`official-llm`；JEV 改插件；确认后删玩家意图路径 | 模型请求逐项对比的方法；透视桩模型如何注入 |
| 4 规则与玩法 | `ctx.rules`；`pack-*` 收拢到 `official-gameplay` | `#activity`、`#status` 全部调用点摸底，并和用户确认切法 |
| 5 收尾 | `requiresPlugins`、Launcher 选配和校验、`plugin-set.json`、插件数据目录、插件私有记录、插件路由、SDK 文档、`SAFETY` 说明 | 存储和哈希能否接受 `plugin:` 事件 |
