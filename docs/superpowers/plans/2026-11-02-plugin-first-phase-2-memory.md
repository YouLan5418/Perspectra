# 插件优先运行时：阶段 2（记忆）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 记忆走 `ctx.memory` 接缝，Core 成为默认记忆插件，删除原生召回与整理，授权来源捕获留在主干。

**Architecture:** 宿主只认 `MemoryInstance`。Core 移入 `packages/official-memory-core`，由入口带着模型配置组装后交给宿主，第三方插件拿不到这些配置。`packages/memory` 缩减为授权来源捕获，已有存档通过一次迁移丢弃原生表，来源行和哈希不变，Core 档案继续有效。

**Tech Stack:** TypeScript strict、ESM、Cordis 4.0.1、node:sqlite、Vitest；Python Core 不改。

**Spec:** `docs/superpowers/specs/2026-11-02-plugin-first-runtime-design.md`（第 6.2 节）

## Global Constraints

- 只用官方插件时，Core 路径发给模型的请求不变；授权来源行的内容和 `source_hash` 不变。
- 第三方插件拿不到模型凭据和 Core 的配置。
- 删除的是原生召回；不改 Python 代码，不把 Core 改写成 TypeScript。
- 宿主和 `application` 不得 import `packages/official-*`，唯一例外是 `desktop/official-bundle.ts`。
- 按 `AGENTS.md`：不为旧测试保留旧路径。只测原生召回的测试直接删除；同时覆盖其他行为的测试要保留那部分行为。
- 真实模型试玩是阶段完成标准，自动测试通过不算体验通过。
- 插件 `dataDirectory` 由插件负责创建；阶段 1 的暂缓小问题不在本阶段处理。

## Review Focus

1. 用旧版本写过的 `memory.sqlite` 打开：迁移后来源和 Core 档案仍有效，世界照常打开，不触发整理重建。（Task 3）
2. 第三方记忆插件 `project` 抛错：这一轮角色处理失败并提示，已提交内容保留，下一轮可继续。（Task 1）
3. 第三方记忆插件 `open` 失败：世界不打开，错误说明是哪个插件，不会悄悄换成别的记忆。（Task 1）
4. 用 `official-memory-none` 或第三方记忆保存节点、恢复和重新生成：不报“需要 Core 记忆”以外的错误，世界事实不变。（Task 1）
5. 第三方插件启用时，`WorldServices` 和进程环境里读不到模型 Key。（Task 1）

---

## 已查清的事实

- Core 模式下 `CharacterTurn` 不收 `memory`，所以 `prepareStimulus`、`recall`、`canRecall` 都是死路径。`gatewayTurnCall` 和 `characterTurnCall` 只在 `canRecall === true` 时才加 `recall`，删除它们不改变 Core 路径的请求。
- Core 只用 `catchUpReceipt` 加 `cognitive_memory_v2_sources` 的 5 列。`RoundCoordinator.processCognitiveJobs` 用 `processPending` 驱动同一捕获，`world-administration` 的隔离恢复用 `rebuildBranch`。
- `recallMemory`、`diagnoseMemoryRecall` 除测试外没有调用方。
- 透视和多数宿主测试走 `memoryCore` 缺省的原生路径，换成无记忆时要逐个看断言。
- `story-share.ts` 直接构造 `CoreMemoryAdapter`；`story-nodes.ts`、`tail-storage.ts` 写死了 `memory.sqlite` 等文件名。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `packages/plugin-sdk/src/index.ts` | `MemoryInstance`、`MemorySlotApi`；`WorldServices.instanceDirectory`、`world.authorizedSources` |
| `packages/official-memory-none/`（新） | 什么都不记的实现 |
| `packages/official-memory-core/`（新） | 从 `desktop/host/memory` 移入，含 `python/` |
| `packages/memory/` | 缩减为授权来源捕获 |
| `desktop/official-bundle.ts` | 组装官方记忆，转出分享导入所需的 Core 函数 |
| `desktop/host/world-runtime.ts` | `#memoryCore` 换成 `#memory`，删除原生分支 |
| `packages/application/src/character-turn.ts` 等 | 删除 `memory` 选项和 recall 决策 |

---

### Task 1: 接缝（原生路径暂时保留）

**Files:**
- Create: `packages/official-memory-none/package.json`, `packages/official-memory-none/src/index.ts`, `desktop/host/memory/core-provider.ts`
- Modify: `packages/plugin-sdk/src/index.ts`, `desktop/host-plugins.ts`, `desktop/host-plugin-manifest.ts`, `apps/launcher/src/components/PluginSettingsBlock.vue`, `desktop/official-bundle.ts`, `desktop/host/world-runtime.ts`, `desktop/host/web-entry.ts`, `desktop/story-nodes.ts`（如有依赖）, `tsconfig.json`, `vitest.config.ts`
- Test: `tests/host/memory-seam.test.ts`, `tests/desktop/host-plugins.test.ts`

**Interfaces:**
- Produces（`plugin-sdk`，`HOST_API_VERSION = '1.2'`）：

  ```ts
  interface MemoryInstance {
    project(request: CharacterTurnRequestLike, signal: AbortSignal): Promise<CharacterTurnRequestLike>
    observeContext?(request: CharacterTurnRequestLike, promptText: string): void
    recordDecision?(request: CharacterTurnRequestLike, response: unknown): void
    shortTermAfterSeq?(characterId: CharacterId): number
    startPending?(): void
    cancelBackground?(): void
    waitForBackground?(): Promise<void>
    backgroundState?(): WorldJsonObject
    startRefresh?(characterIds: readonly CharacterId[]): void
    inspect?(characterId: string, offset: number, limit: number): WorldJsonObject | undefined
    snapshotAliases?(characterIds: readonly CharacterId[]): WorldJsonObject
    snapshotArchives?(characterIds: readonly CharacterId[]): WorldJsonObject
    restoreArchives?(archives: WorldJsonObject, characterIds: readonly CharacterId[]): void
    holdInstallation?(): void
    releaseInstallation?(): void
    close?(): void | Promise<void>
  }
  interface MemorySlotApi { register(provider: SeamProvider<MemoryInstance>): () => void; readonly current: SeamProvider<MemoryInstance> | undefined }
  ```

  `CharacterTurnRequestLike` 是 `{ context: WorldJsonObject; decisionId?: string } & WorldJsonObject` 风格的结构类型，`CharacterTurnRequest` 必须可赋值给它。`WorldServices` 增加 `readonly instanceDirectory: string`。方法名沿用 `CoreMemoryAdapter`，不重新设计。
- Produces（`official-bundle.ts`）：`HostSeams` 增加 `readonly memory?: SeamProvider<MemoryInstance>`；`officialSeams()` 不含记忆。
- Produces（`official-memory-none`）：`officialMemoryNoneProvider`，`id: 'official-memory-none'`，`project` 原样返回请求。
- Produces（`desktop/host/memory/core-provider.ts`）：`coreMemoryProvider(options: CoreProviderOptions): SeamProvider<MemoryInstance>`，`CoreProviderOptions` 取自 `WorldHostOptions` 现有的 `models`、`memoryCoreRun`、`memoryCoreBuildRun`、`memoryCoreRunners`、`memoryBuildConcurrency`、`memoryContextBudget`，以及 `playSettings`。
- Produces（`host-plugins.ts`）：`loadHostPlugins(settings, secrets?, defaults?: { memory?: SeamProvider<MemoryInstance> })`；`seams.memory = slot.current ?? defaults?.memory`。

- [ ] **Step 1: 写失败测试（`tests/host/memory-seam.test.ts`）**

```ts
it('calls the configured memory provider around each decision and closes it', ...)
  // project 给 context 加 marker；模型收到的请求含 marker；runtime.close 后 close 被调用
it('opens a separate instance for each regeneration candidate', ...)
it('uses the recent window when a provider has no shortTermAfterSeq', ...)
it('fails the turn but keeps player input when project throws, and continues next round', ...)
  // state.error === true；转录保留玩家输入；project 恢复后第二次 submit 成功
it('refuses to open the world when a third-party memory provider cannot open', ...)
  // WorldHostRuntime.create 拒绝，错误含插件 id
it('saves and restores a node without Core archives under a provider lacking them', ...)
it('gives a third-party provider no model configuration', ...)
  // JSON.stringify(Object.keys(services)) 不含 models；环境变量 PERSPECTRA_ROLE_MODELS 由入口保持现状，此测试只查 services
```

在 `tests/desktop/host-plugins.test.ts` 增加：插件占用 `ctx.memory` 时 `seams.memory.id` 为插件；未占用时为 `defaults.memory`；第二个占用者按 `apply` 跳过。

- [ ] **Step 2: 确认失败**

Run: `corepack pnpm@11.7.0 test:related tests/host/memory-seam.test.ts tests/desktop/host-plugins.test.ts`
Expected: FAIL，`plugins.memory` 未生效，`ctx.memory` 未定义。

- [ ] **Step 3: 实现**

- `MemorySlot` 仿照 `SchedulerSlot`。`SERVICES` 加 `'memory'`，Launcher 显示“替换角色记忆”。
- `core-provider.ts` 把 `world-runtime.ts` 第 538–568 行的构造移入 `open`。数据目录用 `world.instanceDirectory`，`versionValid` 由实例内部的 closing 标记决定。`close` 同时关闭 `coreRunnerGroups`。
- 宿主：`#memoryCore: CoreMemoryAdapter | undefined` 改为 `#memory: MemoryInstance | undefined`，全部调用加 `?.`。`inspectArchive` 改名调用 `inspect`；创作者快照的 `mode` 用 provider id 判断：`official-memory-core` 显示 `core`，其他显示 `native`（Task 2 再改）。
- `WorldHostOptions` 删除 `memoryCore*`、`memoryBuildConcurrency`、`memoryContextBudget`；测试和入口改传 `plugins: { memory: coreMemoryProvider({...}) }`。`plugins.memory` 缺省时仍走原生路径。
- `open` 失败：第三方抛出 `new Error('记忆插件 <id> 无法打开：…')`，世界不打开。这和调度器不同：记忆有持久数据，悄悄换实现会让角色失忆。
- `web-entry.ts`：`launch.memoryCore` 时构造 `coreMemoryProvider` 传入 `loadHostPlugins` 的 `defaults`。

- [ ] **Step 4: 确认通过并全量检查**

Run: `corepack pnpm@11.7.0 check`
Expected: 全部通过；`tests/host/core-memory.test.ts`、`tests/scenarios/cross-scene-core-memory.test.ts` 只改构造方式，断言不变。

- [ ] **Step 5: 提交**

```bash
git add docs/current/studies/2026-11-plugin-first-phase-1.md packages desktop apps/launcher/src/components/PluginSettingsBlock.vue tsconfig.json vitest.config.ts pnpm-lock.yaml tests
git commit -m "feat: route character memory through a replaceable seam"
```

### Task 2: 删除原生召回

**Files:**
- Modify: `packages/application/src/character-turn.ts`, `world-read-queries.ts`, `packages/provider-chat/src/character-turn-call.ts`, `character-context-text.ts`, `desktop/host/gateway-turn-call.ts`, `desktop/host/memory/core-memory.ts`, `desktop/host/creator-records.ts`, `desktop/host/world-runtime.ts`, `desktop/host/launch-arguments.ts`, `desktop/host/web-entry.ts`, `desktop/lens/simulation.ts`, `apps/launcher/src/creator/*`（`mode` 与 `recall` 记录）
- Delete: `tests/scenarios/active-recall.test.ts`, `tests/integration/local-memory-recall.test.ts`；只驱动原生召回的 `tests/experiments/*`（`active-recall-drive.ts`、`native-memory-baseline.ts` 及类型检查报错且无其他用途的）
- Modify tests: `tests/scenarios/character-autonomy.test.ts`, `perform-continuation.test.ts`, `player-source-evidence.test.ts`, `speech-delivery.test.ts`, `tests/host/pack-activity.test.ts`, `lens-simulation.test.ts`, `launch-arguments.test.ts`, `entry-layout.test.ts`, `capability-plugin-entry.test.ts`, `tests/desktop/desktop-launch.test.ts`, `tests/support/cross-scene-runtime.ts`, `notice-board-fixture.ts`

**Interfaces:**
- Consumes: Task 1 的 `officialMemoryNoneProvider`（经 `official-bundle.ts` 转出）。
- Produces: `--memory-none` 启动参数取代 `--memory-native`；`LaunchArguments.memory: 'core' | 'none'`；`WorldHostOptions.plugins.memory` 缺省即 `official-memory-none`。

- [ ] **Step 1: 写失败测试**

在 `tests/host/launch-arguments.test.ts`：

```ts
it('rejects the removed native memory flag', () => {
  expect(() => parseLaunchArguments(['--memory-native', ...required])).toThrow()
})
it('selects no memory with --memory-none', () => {
  expect(parseLaunchArguments(['--memory-none', ...required]).memory).toBe('none')
})
```

在 `tests/host/core-memory.test.ts` 增加：`it('offers no recall decision to the model', ...)`，断言模型收到的 schema 不含 `recall`，即使调用了 `#decide`。

- [ ] **Step 2: 确认失败**

Run: `corepack pnpm@11.7.0 test:related tests/host/launch-arguments.test.ts`
Expected: FAIL，`--memory-native` 仍被接受。

- [ ] **Step 3: 删除**

- `CharacterTurn`：去掉 `options.memory`、`prepareStimulus`、`olderMemories`、`canRecall`、`decision === 'recall'` 整段、`onRecallShadow`、`RecallShadowObservation`。`recentSourceSeqs` 若无其他使用者一并删除。
- `provider-chat`、`gateway-turn-call`：去掉 `canRecall`、`recallEvidence` 和 `recall` schema 分支。
- `core-memory.ts`：去掉 `recallEvidence` 分支。Python 的 `recall` 操作是 Core 自己的自动召回，不动。
- `world-read-queries`：删除 `recallMemory`、`diagnoseMemoryRecall`。
- `world-runtime.ts`：删除 `#activateCharacters` 里的 `CognitiveMemoryService`、`memoryShadow`。
- `creator-records` 的 `'recall'` 种类：旧记录要能读，所以读取端保留，写入端删除。创作者快照 `mode` 改为 `'core' | 'none'`，同步 Launcher 类型和文案。
- 测试：只测召回的文件删除；其他测试去掉 `memory:` 传参。某断言依赖 `memoryRecall` 出现在上下文里时，删该断言，并在提交说明写明。

- [ ] **Step 4: 确认请求不变**

用 `tests/host/core-memory.test.ts` 现有夹具，在 Task 2 前后各导出一次发给模型的请求 JSON（含 schema），比较逐字相同。这是本任务最重要的验证。

Run: `corepack pnpm@11.7.0 check`
Expected: 全部通过。

Run: `corepack pnpm@11.7.0 launcher:check`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A packages desktop apps/launcher/src tests
git commit -m "refactor: remove native memory recall"
```

### Task 3: 缩减 `packages/memory`

**Files:**
- Modify: `packages/memory/src/local-memory.ts`, `cognitive-context.ts`, `memory-schema.ts`, `index.ts`, `packages/application/src/world-application.ts`, `world-administration.ts`, `round-coordinator.ts`
- Delete: `packages/memory/src/hybrid-tokenizer.ts`, `ngram-tokenizer.ts`, `memory-summaries.ts`, `cognition.ts`（确认无使用者）及其测试；`cognitive-memory-keyword.test.ts`、`local-memory.test.ts` 中的召回用例
- Test: `tests/integration/authorized-sources.test.ts`

**Interfaces:**
- Produces（`packages/memory`）：`class AuthorizedSourceStore`，`constructor(path: string, store: WorldStore)`；`catchUp(address, characterId, asOfWorldSeq, correlationId, heartbeat?): CognitiveMemoryReceipt`；`sources(address, characterId, throughSeq): readonly AuthorizedSource[]`；`processPending(...)`、`rebuildBranch(...)`（签名不变）；`close()`。
- Produces：`AuthorizedSource { sourceId; sourceHash; epistemicKind; sourceSeq; text }`，加入 `plugin-sdk`；`WorldReader.authorizedSources(characterId, throughSeq)`。

- [ ] **Step 1: 先固定来源（在改动前的代码上）**

写 `tests/integration/authorized-sources.test.ts`，用 `cross-scene-runtime` 夹具提交若干观察、主观判断和目标，读 `cognitive_memory_v2_sources` 全部行，与仓库内的快照比较。此时用 `CognitiveMemoryService` 生成并提交快照，测试应 PASS。这是不变量，不是 RED。

```ts
it('keeps every authorized source row and hash stable', ...)
it('never lists a source the character could not observe', ...)
```

- [ ] **Step 2: 写失败测试**

```ts
it('reads a memory database written by the previous version', ...)
  // 用当前 schema 建库后写入来源和全文索引，再打开：来源行不变，fts/terms/summaries/recall_receipts/memory_* 表已删除
it('leaves a Core archive valid after the migration', ...)
  // 迁移前后 CoreMemoryAdapter.#validate 接受同一档案，不触发重建
```

Run: `corepack pnpm@11.7.0 test:related tests/integration/authorized-sources.test.ts`
Expected: 这两条 FAIL，`AuthorizedSourceStore` 不存在。

- [ ] **Step 3: 缩减**

- 保留 `catchUpV2`、`#observationCandidates`、`#captureV2Candidate`、`orderedSources`、namespaces、sources、receipts、cognitive jobs。
- 哈希算法、字段顺序和 `memoryEpoch` 不改。`capturedMemoryIds` 仍按原样写入 receipt。
- 删除 v1 的 `reconcile`、`capture`、`recall`、`forget`，FTS、terms、dictionary、summaries、recall receipts，以及 tokenizer。
- `memory-schema.ts` 追加一次迁移：`DROP TABLE` 上述表及 v1 的 `memory_*`。保留前面的迁移，老库能走完。
- `CognitiveMemoryService` 改名 `AuthorizedSourceStore` 并删去 `version` 参数；`world-application` 的 `recallTokenizer`、`recallDictionary` 选项删除。
- 确认 `jieba-wasm` 没有其他使用者后，从 `package.json`、`--external:jieba-wasm`、`build-portable.mjs`、`build-worldpack-cli.mjs`、`capability-plugin-entry.test.ts` 中移除。
- `RECALL_KEYWORD_TOKENIZER_ID` 等 contracts 类型只删确认无人使用的。
- `manifest.cognitiveMemoryVersion` 保留，它是已编译世界的一部分。

- [ ] **Step 4: 确认通过**

Run: `corepack pnpm@11.7.0 check`
Expected: 全部通过，来源快照未变。

- [ ] **Step 5: 提交**

```bash
git add -A packages desktop scripts package.json pnpm-lock.yaml tests
git commit -m "refactor: reduce the memory package to authorized source capture"
```

### Task 4: Core 成为官方包

**Files:**
- Move: `desktop/host/memory/*` → `packages/official-memory-core/src/`，`desktop/host/memory/python` → `packages/official-memory-core/python`
- Modify: `desktop/official-bundle.ts`, `desktop/story-share.ts`, `desktop/launcher-core.ts`, `desktop/tail-runtime-identity.ts`, `desktop/host/world-reader.ts`, `desktop/host/web-entry.ts`, `scripts/build/copy-memory-runtime.mjs`, `scripts/release/build-portable.mjs`, `scripts/release/verify-core-layout.mjs`, `scripts/release/BUILD.md`, `scripts/check-host-boundaries.mjs`, `.gitignore`（如有路径）, `tsconfig.json`, `vitest.config.ts`

**Interfaces:**
- Consumes: Task 3 的 `world.authorizedSources`。
- Produces（`official-memory-core`）：`coreMemoryProvider`、`corePythonExecutable`、`corePythonRoot`、`importCoreArchives(directory, address, node, actors): Promise<void>`（分享导入用，内部构造不调用模型的实例）。
- Produces（`official-bundle.ts`）：转出上述四个，宿主和 `desktop/*` 只从这里取。

- [ ] **Step 1: 写失败测试**

在 `scripts/check-host-boundaries.mjs` 的约束下：把 `official-memory-core` 加入“运行时不得 import `store-sqlite`、`application`、`kernel`”的检查。

Run: `node scripts/check-host-boundaries.mjs`
Expected: 移动后失败，指出 `core-memory.ts` 仍依赖 `WorldStore`。

- [ ] **Step 2: 移动并改走公开接口**

`#snapshot` 改用 `world.authorizedSources`，`head` 和 `tick` 从 `WorldReader` 取（需要时增加 `head(): { headSeq; tick }` 和 `eventTicks(throughSeq)`）。来源文本和哈希必须与之前相同。`CharacterTurnRequest` 用 `import type`，或换成 SDK 的结构类型。

- [ ] **Step 3: 更新路径并验证打包**

Run: `corepack pnpm@11.7.0 check`
Expected: 全部通过。

Run: `node scripts/release/verify-core-layout.mjs`
Expected: 通过。依赖本机 Python/E5，环境缺失时在记录中写明未运行。

Run: `corepack pnpm@11.7.0 desktop:build`
Expected: 成功，产物加载 Core 路径正确。

- [ ] **Step 4: 提交**

```bash
git add -A packages/official-memory-core desktop scripts .gitignore tsconfig.json vitest.config.ts
git commit -m "refactor: make Core the official memory package"
```

### Task 5: 文档与验收

**Files:**
- Modify: `docs/current/architecture/cognition-memory.md`, `modules.md`, `runtime.md`, `creator-runtime.md`, `getting-started.md`, `README.md`, `docs/current/guides/creator-playtest.md`, `local-runbook.md`, `host-plugin-authoring.md`, `docs/current/host-plugins.md`, `desktop/host/memory/README.md`（随移动）
- Create: `docs/current/studies/2026-11-plugin-first-phase-2.md`

**Interfaces:** 无。

- [ ] **Step 1: 更新文档**

先给角色例子，再讲接缝。写清：`--memory-none` 只用于离线开发和测试，角色没有长期记忆；正式游玩需要 Python 和 E5，缺失时直接报错。模块地图加两个官方包，改 `memory` 职责。

Run: `node scripts/docs/check-links.mjs`
Expected: 断链数不超过 97，新增文件无断链，模块地图覆盖新包。

- [ ] **Step 2: 真实模型试玩**

本机 8045，`gemini-3.8-flash`，思考强度 low。用阶段 1 的试玩脚本，改走 `coreMemoryProvider`。同一世界包跑 `main`（`--memory-core`）和本分支，多玩到触发整理。比较请求上下文里的记忆内容、对白和耗时。Python/E5 不可用时，记录原因，并把此项列为未验证。

- [ ] **Step 3: 写阶段记录并提交**

记录行数变化（`packages/memory`、`world-runtime.ts`）、未验证内容、对阶段 3 的判断。

```bash
git add -A docs packages/official-memory-core
git commit -m "docs: record plugin-first phase 2 results"
```

**不要自动进入阶段 3。**
