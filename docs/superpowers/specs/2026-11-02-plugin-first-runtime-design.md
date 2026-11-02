# 插件优先运行时设计

状态：待用户审阅。日期：2026-11-02。代码基线：`feat/lens-standalone` 工作区。本文只描述目标，尚未实施。

## 1. 一个例子

一位开发者觉得官方调度器太“轮流发言”，想让性格急躁的角色更常抢话。他写一个 `.mjs` 插件，向 `ctx.scheduler` 注册自己的调度器。玩家在 Launcher 里添加这个文件，把调度器从“官方默认”换成它，然后开始游戏。

这一轮谁先说、并发多少、几波停，全由他的插件决定。角色说什么仍由模型决定；行动仍走规则裁定；已提交的世界事实仍写进事件日志。玩家卸载插件后，同一个存档继续能开，只是之后回到官方调度。

今天做不到这件事：`world-runtime.ts` 直接 import 并调用 `runCharacterActivations`，调度、记忆、规则、玩法都写死在宿主里。

## 2. 目的与范围

### 为什么做

项目将开源，创作者和开发者生态是重点。开发者应当能换掉官方模块，而不只是在旁边挂语音和 BGM。官方实现也走同一套接缝，这样接缝是否够用，官方代码会最先发现。

### 目标（第一版）

1. 切开游戏进程内部，尤其是宿主和 `application`，让它们通过服务名调用可替换模块。
2. 官方实现打包成默认组合包，玩家不做任何选择时直接可玩。
3. 玩家在 Launcher 中选配插件。
4. Core 成为默认记忆插件，删除原生记忆的召回与整理。
5. 世界包可以声明依赖的插件和版本，Launcher 校验时列出缺失和版本不符。
6. 一个第三方调度器示例插件，证明替换真的走得通。

### 不做

- 插件市场、索引、自动下载依赖插件。
- 沙箱或权限审批。插件是可信代码。
- 把 Python Core 改写成 TypeScript。
- 发布到 npm；`plugin-sdk` 先随仓库提供。
- Launcher 的其他改版。
- DSH 的大量校验脚本、生成目录、格式迁移边和插件市场基础设施。
- 迁移旧存档。

### 失败标准

下面任何一条成立，即使代码切完也算失败：

- 只用官方插件时，真实模型试玩的角色体验明显退化。
- 只用官方插件时，角色越权知道了不该知道的信息，或未裁定的重要状态变化成为事实。
- 接缝只是把 `world-runtime.ts` 的内部细节原样搬成公开接口，第三方写一个调度器仍要读懂宿主内部。
- 新增的抽象比切掉的耦合还多，修改一个玩法要跨更多文件。

## 3. 已定决策（来自用户）

| 决策 | 内容 |
| --- | --- |
| 信任模型 | 插件在宿主进程内运行，不做沙箱。改坏了由作者和选用它的玩家负责 |
| 选配入口 | 玩家在 Launcher 里选，类似 DSH 的插件页 |
| 不可替换 | 事件日志和原子提交 |
| 可替换 | 调度器、规则裁定等，包括官方实现 |
| 模型调用预算 | 玩家设置的上限只作为建议传给插件，宿主不硬性兜底。玩家安装插件即视为信任作者 |
| 记忆 | Core 替换原生记忆 |
| 世界包依赖 | 可声明插件和版本；缺必需项不启动并列出问题；可选依赖只提示 |
| 存档 | 世界事实写主干能读懂的通用事件，卸载插件后仍成立。插件私有记录走 `plugin:` 命名空间，读不懂就保留并跳过。换可替换模块时允许打开并提示。存档记录当时的插件和版本 |
| 第一版范围 | 至少切好游戏进程内部，尤其是宿主和 `application` |
| 落地方式 | 在现有仓库逐个接缝迁移，不新建仓库重写 |
| 兼容 | 旧存档不迁移，旧数据只读 |

## 4. 代码现状（已核对）

- **`WorldHostCore` 是总装配。** `world-runtime.ts` 共 2,255 行，直接 import 约 35 个模块。其中 `#activity` 出现 52 次、`#status` 40 次、`#memoryCore` 30 次、`#communication` 16 次、`#autonomy` 14 次。
- **角色决策管道写死在一个方法里。** `#decide`（第 600 行起）依次做记忆投影、状态、设定、表情、预设、模型调用、输出处理、格式重试和审计。
- **规则已经是一条链。** `#rulebooks` 依次组合 core、短信、状态和活动。`CharacterTurn` 和 `WorldApplication` 已接受注入的 `rulebooks`。
- **调度有三段。** 活动链 `#runActivityChain`、场景反应 `runCharacterActivations`、自主补充 `#activateAutonomous`。后两者共用调度函数。
- **`stimulus` 由调度方计算。** 三段各算一份，算法不同。第三方若照搬，可以传入任意观察。
- **运行时不止一个实例。** `TailRoundRuntime` 通过 `factory` 反复创建 `WorldHostCore`：恢复、分支和重新生成候选都会新建。插件却只在进程启动时加载一次。
- **现有 `CapabilityProvider.open(world, config)` 已经是“进程级注册、每世界打开”的模式。**
- **Core 依赖原生记忆的一部分。** `CoreMemoryAdapter.#snapshot` 用 `CognitiveMemoryService.catchUpReceipt` 补齐来源，再用 SQL 直接读 `cognitive_memory_v2_sources`。`RoundCoordinator` 也通过 `cognitiveMemory.processPending` 驱动。**所以不能整包删除 `packages/memory`。**
- **包透视依赖原生记忆。** `desktop/lens/simulation.ts` 以 `memoryCore: false` 启动，好让推演不需要 Python。
- **Cordis 4.0.1 已提供所需能力。** `Service`、`effect`、`emit`、`serial`、`bail`、`waterfall` 都有。DSH 用的是 4.0.6-alpha.1，第一版不升级。
- **当前有两个 Cordis 根。** `WorldApplication.#root` 管分支生命周期，`loadHostPlugins` 的根管宿主插件。

## 5. 目标结构

```text
Launcher ── 选配、校验依赖 ──┐
                             ▼
游戏进程
  插件根 Context
    ├─ 玩家选用的插件（先加载）
    └─ 官方默认组合包（填补空缺的接缝）
         │ 每个接缝注册一个 Provider
         ▼
  世界会话（每个世界实例一个，由原 WorldHostCore 缩减而来）
    ├─ 按顺序调用 ctx.scheduler / ctx.memory / ctx.rules / ctx.llm / ...
    └─ 主干：事件日志、原子提交、授权视图、权限和写租约
```

### 主干（不可替换）

| 模块 | 来自 |
| --- | --- |
| 数据契约 | `contracts` |
| 事件日志、原子提交、写租约 | `store-sqlite` |
| 授权视图、授权记忆来源 | `store-sqlite` 的 `CharacterViewBuilder`，以及从 `packages/memory` 拆出的来源捕获 |
| 回合提交入口 | `application` 的 `RoundCoordinator`、`action-observations.ts` |
| 插件装载、接缝注册 | `host-plugins.ts`、`runtime-cordis`、`plugin-sdk` |
| 玩家读取入口 | HTTP 里的玩家投影和授权检查 |

`WorldApplication` 的分支 Cordis 根保持内部使用，第一版不和插件根合并，它管的是分支资源，不是可替换模块。

### 接缝（可替换）

| 服务 | 第一版的官方实现 | 来自 | 阶段 |
| --- | --- | --- | --- |
| `ctx.scheduler` | `official-scheduler` | `activation-cycle.ts` | 1 |
| `ctx.memory` | `official-memory-core`；测试和透视用 `official-memory-none` | `desktop/host/memory` | 2 |
| `ctx.llm` | `official-llm` | `provider-chat`、`role-providers.ts`、`gateway-turn-call.ts` | 3 |
| 决策事件 `character/context`、`character/decide` | 由各官方插件监听 | `#decide` | 3 |
| `ctx.rules` | `official-rules` | `kernel`、`interaction-runtime`、`interactions-basic` | 4 |
| `ctx.gameplay` | `official-gameplay` | `desktop/host/pack-*.ts` | 4 |
| 舞台 | `frontend` 默认模板加现有社区模板机制 | 不变 | 5 |
| `ctx.frontendServices`、`capabilities`、`playerFeed` | 现有 | 不变 | 已有 |

官方包放在 `packages/official-*`，符合现有 `packages/*` 工作区规则。宿主只依赖接缝类型和默认组合包入口，不直接 import 具体实现。`scripts/check-host-boundaries.mjs` 增加这条检查。

### 接缝的统一形状

沿用现有 `CapabilityProvider`，不新造概念：

```ts
interface SeamProvider<Instance> {
  readonly id: string
  readonly version: string
  /** 每个世界实例调用一次，包括重新生成候选和分支。 */
  open(world: WorldServices, signal: AbortSignal): Promise<Instance>
}
```

- 插件写法和 DSH 一致：简单插件只用 `ctx` 和 `import type`；需要定义 Service 的插件可以 `import { Service } from '@deepseek-ai/cordis'`，版本作为 peer 依赖由宿主提供，不自带一份。Perspectra 的插件可以放在任意路径，裸模块名默认解析不到宿主的副本，后端打包又会把 Cordis 打进 bundle。所以阶段 0 用 Node 模块解析钩子，把插件对 `@deepseek-ai/cordis` 的 import 指向宿主当前运行的这一份，源码和打包两种启动方式相同，也不用改打包配置。
- 每个接缝只有一个生效的 Provider。第三方插件和官方实现注册方式相同。
- 装载顺序：玩家插件先加载，再用官方默认组合包填补仍为空的接缝。
- 第三方插件加载失败时跳过它，由官方实现补上，并显示现有的跳过提示。**如果世界包把它声明为必需，则不启动。**
- 两个玩家插件抢同一接缝时，后者按现有“重复注册”规则跳过，原因为 `apply`。
- 进程关闭时释放；每个世界实例的资源由 `Instance.close()` 释放。

`WorldServices` 是主干提供给插件的入口：

```ts
interface WorldServices {
  readonly address: WorldAddress
  readonly worldVersion: string
  /** 插件自己的数据目录：<实例数据>/plugins/<插件 ID>/ */
  readonly dataDirectory: string
  readonly playSettings: PlaySettings
  /** 只读：事件和任一角色的授权视图。 */
  readonly world: WorldReader
  /** 追加插件私有记录，不改变世界事实。 */
  appendPluginRecord(type: `plugin:${string}`, data: WorldJsonObject): void
}
```

### 权力边界

| 能力 | 第三方插件 |
| --- | --- |
| 读所有事件和任意角色的授权视图 | 可以。这是有意开放的特权读，可能写出越权的插件 |
| 替换调度、规则、记忆、模型调用 | 可以 |
| 改写任何角色的上下文和模型输出 | 可以，通过决策事件 |
| 改变世界事实 | 只能通过规则结果和回合提交入口 |
| 直接写 `world.sqlite` | 不提供接口，不支持。代码层面无法阻止，这是信任模型的已知限制 |

宣传口径要准确：**认知隔离和事实一致性，是主干和官方插件的保证；启用第三方插件后，取决于插件作者。** 启动器显示当前启用了哪些非官方模块。

## 6. 各接缝

### 6.1 `ctx.scheduler`

只取代“谁在什么时候获得处理机会”。接口去掉 `store` 和 `stimulus`：

```ts
interface SchedulerInstance {
  run(round: SchedulerRound): Promise<SchedulerResult>
  close?(): void
}

interface SchedulerObservation {
  readonly seq: number
  readonly characterId: CharacterId
  /** false 表示对这个观察者只是无言表现，非根刺激时官方调度会忽略它。 */
  readonly substantive: boolean
}

interface SchedulerRound {
  readonly characterIds: readonly CharacterId[]
  readonly afterSeq: number
  readonly signal: AbortSignal
  readonly limits: ActivationLimits
  /** false 时当前玩法要求逐个处理，官方调度走串行路径。 */
  readonly allowConcurrent: boolean
  readonly initialCounts?: ReadonlyMap<CharacterId, number>
  readonly autonomy?: AutonomyOpportunities
  readonly world: WorldReader
  headSeq(): number
  /** 由宿主筛选：已接受且不是观察者自己的行动。 */
  observationsSince(afterSeq: number, throughSeq: number): readonly SchedulerObservation[]
  presentCharacterIds(): readonly CharacterId[]
  locationOf(id: CharacterId): string | null
  /** 让角色处理一次。调度器只按序号指定观察，内容由宿主取出，序号必须属于该角色。 */
  turn(id: CharacterId, options: SchedulerTurnOptions): Promise<SchedulerTurnResult>
}

interface SchedulerTurnOptions {
  readonly kind?: 'reaction' | 'autonomous'
  readonly signal: AbortSignal
  readonly stimulusSeqs: readonly number[]
  readonly maxCalls: 1 | 2 | 3
  readonly maxModelCalls?: number
  readonly onCommitted?: (asOfWorldSeq: number, headSeq: number) => void
  /** 过期重算时接续已提交的行动，不重复执行它。 */
  readonly continuationOf?: { actionId: string; afterSeq?: number; action: { actionType: string; parameters: WorldJsonValue } }
}
```

宿主仍负责提交前的过期检查和写租约，因为这些在 `CharacterTurn` 内部。插件决定并发，官方实现保留现有的串行和动态两条路径。现有动态调度依赖按序号跟踪已消费的观察、`onCommitted` 和 `continuationOf`，所以这些都保留在接口里；第三方可以不用。

活动进行中的调度（`#runActivityChain`）属于玩法，由 `ctx.gameplay` 决定，**不交给 `ctx.scheduler`**。活动的 `schedule()` 是世界包作者定义的玩法规则，玩家换调度器不应破坏狼人杀的顺序。

`SchedulerResult` 保留 `terminalReason` 和 `activations`，宿主用它们生成现有的玩家提示。未知的 `terminalReason` 统一显示“本轮已结束”。

为保持官方行为不变，`activation-cycle.ts` 里读事件的筛选（排除自己的行动、判断是否只有无言表现）移到宿主的 `observationsSince`；根刺激、波次和计数仍由官方调度器判断。自主角色：集成路径通过 `round.autonomy` 交给调度器；`#activateAutonomous` 的分段路径第一版留在宿主，其中的反应波改为调用 `ctx.scheduler`。

切分时给 `WorldHostOptions` 增加 `plugins`，缺省为官方组合。包透视和测试用它传入 `official-memory-none` 和桩模型，不走 Launcher 或进程环境变量。

### 6.2 `ctx.memory`

接口直接来自 `WorldHostCore` 现有的 30 处调用，不重新设计：

```ts
interface MemoryInstance {
  project(request: CharacterTurnRequest, signal: AbortSignal): Promise<CharacterTurnRequest>
  observeContext(request: CharacterTurnRequest, text: string): void
  recordDecision(request: CharacterTurnRequest, raw: unknown): void
  shortTermAfterSeq?(actor: CharacterId): number
  startPending(): void
  cancelBackground(): void
  waitForBackground(): Promise<void>
  backgroundState?(): MemoryBackgroundState
  refresh?(characters: readonly CharacterId[]): void
  snapshot(characters: readonly CharacterId[]): Promise<WorldJsonObject>   // 节点保存
  restore(snapshot: WorldJsonObject, characters: readonly CharacterId[]): Promise<void>
  inspect?(character: CharacterId, offset: number, limit: number): MemoryInspection
  hold?(): void
  release?(): void
  close(): Promise<void>
}
```

**拆分 `packages/memory`：**

- **留在主干：** 授权来源的捕获和读取，即 `capture`、`catchUp`、`processPending`、`cognitive_memory_v2_sources`，并提供 `world.authorizedSources(characterId, asOfSeq)`。`CoreMemoryAdapter` 改用它，不再写 SQL。
- **删除：** 关键词召回、召回诊断、摘要、原生投影，`CharacterTurn` 的 `options.memory`、`prepareStimulus` 和 `canRecall` 路径，`world-read-queries` 的召回方法，`--memory-native` 启动参数，分词器依赖（确认无其他使用者后）。
- **实施前要逐项核对：** `local-memory.ts` 有 1,729 行，上述切分是按方法名判断的。如果来源捕获依赖某些召回表，就在第 2 阶段第一步先摸清。世界包的 `memory.json`、清单里的 `contextEnabled` 和 `cognitiveMemoryVersion` 校验也要一并判断去留。

**`official-memory-none`** 是什么都不记的实现，给离线测试和包透视用，不再需要 Python。对依赖召回效果的测试，改为测试 Core 或删除。

Python 目录和 `python-paths.ts`、发行脚本的路径随 `official-memory-core` 移动。

2026-11-02 实施前修正：

- 方法名沿用 `CoreMemoryAdapter`（`snapshotAliases`、`snapshotArchives`、`restoreArchives`、`inspect` 等），除 `project` 外都是可选的；上面的接口草稿以[阶段 2 计划](../plans/2026-11-02-plugin-first-phase-2-memory.md)为准。
- Core 需要模型凭据，而第三方插件不能拿到，所以 `coreMemoryProvider` 由入口带配置组装，`WorldServices` 不含模型信息。`WorldServices` 增加 `instanceDirectory`，Core 的文件留在实例目录，节点和重新生成的复制逻辑不变。
- 第三方记忆插件 `open` 失败时世界不打开，不回退。记忆有持久数据，悄悄换实现会让角色失忆，这一点和调度器不同。
- 已有的 `memory.sqlite` 通过一次迁移丢弃原生表，来源行和哈希不变，已有存档和 Core 档案继续可用。

记忆数据不迁移：换记忆插件后，旧插件目录保留但不读取。新插件从授权来源重建。启动器明确提示“记忆插件已更换”。

### 6.3 决策管道与 `ctx.llm`

`#decide` 拆成两个事件：

- **`character/context`（waterfall）：** 插件依次为请求增加内容。官方监听器按现有顺序注册：记忆、最近执行证据、状态、设定、表情。
- **`character/decide`（waterfall，环绕）：** 包裹“准备预设 → 调用模型 → 处理输出 → 格式重试”。JEV 审计改成一个可选插件，放在这里。发布审计目前会强制串行，这个条件改为由审计插件声明。

`ctx.llm` 提供 `decide(characterId, call, signal)` 和角色模型信息。按角色选模型、预设和 `requestInspector` 留在 `official-llm` 内。

调用预算的归属：`round.limits` 把玩家设置的上限作为建议传给调度器，`turn` 的 `maxModelCalls` 由调度器自己决定，宿主不做总量拦截。官方调度器继续遵守现有上限，有界执行是官方实现的保证。现有的 `#modelCallBudget` 随官方自主调度移入 `official-scheduler`。宿主只在暂停、插话和关闭时中止 `signal`。

`#projectContext`、`validateDecision` 和 `executionResult` 这些 `CharacterTurn` 选项由 `ctx.gameplay` 提供。

### 6.4 `ctx.rules`

把 `#rulebooks` 的固定链改成服务：`resolve(context) → Rulebook`。官方实现保留 core → 短信 → 状态 → 活动的顺序。第三方可以包一层或整体替换。规则的产出仍交给 `RoundCoordinator` 提交。

这也是“世界事实必须是通用事件”的落点：规则结果只能产出主干认识的事件类型。第一版不开放“插件自定义世界事实事件类型”。需要记自定义状态的，用现有 `status.updated` 或插件私有记录。

### 6.5 `ctx.gameplay`

把 `pack-activities`、`pack-activity`、`pack-status`、`pack-autonomy`、`pack-communication`、`pack-knowledge`、`pack-modules` 收拢到 `official-gameplay`。宿主只调用一组生命周期方法（开局、提交前、提交后、玩家操作、活动链、投影）。具体方法名在第 4 阶段根据实际调用点确定。

这是最难的一块，也是**第一版最可能调整范围的地方**。`#activity` 和 `#status` 的调用散布在整个宿主里，且都有调校过的行为。第 4 阶段先做摸底，再和用户确认切法。

世界包格式和包内脚本接口在这一阶段不变。

### 6.6 舞台与 HTTP

玩家投影和授权检查留在主干，继续用现有社区模板机制替换舞台。第一版只新增一项：插件可以注册 `/plugins/<插件 ID>/` 下的路由。

### 6.7 世界包依赖与存档

- **插件清单：** 增加稳定的 `id`。玩家当前手填的 ID 改为默认取清单中的值。无清单的插件仍可加载，但不能满足依赖。
- **世界包声明：** `worldpack.source.json` 增加 `requiresPlugins: [{ id, version, optional? }]`，版本用 semver 范围。
- **校验：** Launcher 启动前读取，不执行插件代码，一次列全缺失和不符的项目。游戏进程启动时再查一次。
- **能力依赖：** `plugins.json` 里现有的 `capabilities.required` 保留。它声明“需要某能力”，新字段声明“需要某插件”，两者并存。
- **存档记录：** 实例目录写 `plugin-set.json`，记录当时生效的接缝和插件版本。打开时不同就提示，不阻止。
- **Launcher 选配：** 在现有插件设置页增加一块“模块”，逐个接缝显示当前生效的实现（官方默认或某插件）。启用了能提供该接缝的插件时，玩家可以在这里选择。
- **插件数据目录：** `story-nodes.ts`、`story-share.ts`、`tail-storage.ts` 目前写死了要复制的数据库文件。它们要改为同时处理 `plugins/<插件 ID>/`，否则节点、分叉和重新生成会丢失插件数据。记忆继续通过 `snapshot` 和 `restore` 保存，分享文件的范围不扩大。
- **插件私有记录：** 写入事件日志的 `plugin:<插件 ID>/<记录名>` 事件，带可忽略标记。不进入角色视图和模型上下文。节点和分叉因为复制事件日志而自动携带。第 1 阶段先确认 `store-sqlite` 和哈希校验能接受这种事件；如果没有实际插件需要它，**推迟到第 5 阶段再加**。

## 7. 实施顺序

每个阶段结束时游戏都能玩，每个阶段单独提交，并把宿主减掉的部分移出 `world-runtime.ts`。

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| 0 准备 | 修改 `AGENTS.md`、原型契约；记录真实模型基线；搭接缝框架和默认组合包；宿主 API 按新增服务升到 1.1（出现破坏性变化时再升 2.0） | 官方行为不变，现有检查通过 |
| 1 调度器 | 抽出 `official-scheduler`；写第三方示例插件 | 示例插件替换后可玩；官方调度真实模型试玩无退化 |
| **决策点** | 根据第 1 阶段的实际成本，和用户复核后续切法 | |
| 2 记忆 | 拆分 `packages/memory`；Core 改走接缝；删除原生召回；透视和离线测试换 `official-memory-none` | 权限回归通过；Core 真实试玩无退化；透视无需 Python |
| 3 决策管道 | 拆 `#decide`；抽 `official-llm`；JEV 改可选插件 | 模型请求内容与基线逐项对比一致 |
| 4 规则与玩法 | 摸底后切 `#rulebooks` 和 `pack-*` | 狼人杀、甜蜜日程、状态市场场景回归通过；真实试玩无退化 |
| 5 收尾 | 世界包依赖、Launcher 选配和校验、存档记录、插件路由、SDK 文档 | 缺插件时 Launcher 列全问题；卸载插件后存档可开 |

阶段 5 的 Launcher 部分和前面的阶段互不依赖，可以提前并行做。

## 8. 验证

| 风险 | 验证方式 |
| --- | --- |
| 权限隔离退化 | 现有角色视图、私有观察、跨场景回归；新增“官方组合下模型请求不含他人私有内容”的对比 |
| 事实一致性 | 现有事务和活动回归；卸载插件后重开存档的集成测试 |
| 角色体验退化 | 阶段 1～4 分别用真实模型试玩，和阶段 0 基线对比。**自动测试通过不算体验通过** |
| 模型请求漂移 | 用 `requestInspector` 记录同一场景的请求，切换前后逐项比较（阶段 3 重点） |
| 多实例 | 重新生成候选、分支、恢复时，每个 Provider 都能正确 `open` 和 `close` |
| 打包后插件可加载 | 用打包后的后端加载放在任意路径的外部 `.mjs`，分别验证只用 `ctx` 的函数插件，以及 `import { Service } from '@deepseek-ai/cordis'` 的类插件，并确认两者和宿主用的是同一份 Cordis |
| 插件故障 | 第三方调度器抛错或返回非法结果时，玩家能看到提示，世界事实不受影响 |

现有测试和包中约 10 个文件直接构造 `WorldApplication`，`tests/` 下约 22 个文件提到 Core 记忆选项，这些测试会随阶段调整。按 `AGENTS.md`，不为通过旧测试保留旧路径。

## 9. 文档同步

- `AGENTS.md`：第 2 节增加“插件化已获批准”的例外；第 3、5 节写明主干保证和第三方插件的分界。
- `docs/current/prototype-contract.md`、`vision.md`：同步新定位。
- 每阶段更新 `docs/current/architecture` 的受影响章节和模块地图，运行 `node scripts/docs/check-links.mjs`。
- `docs/current/host-plugins.md` 和插件制作指南改写成面向外部开发者的入口；新增 `SAFETY` 说明，写清信任模型。

## 10. 待确认

这两项都有默认做法，不影响开工。

1. **JEV 审计是否还要保留？** 我默认改成可选插件。如果已不再使用，直接删除更简单。
2. **玩家意图路径是否一起删除？** 记录显示已停用。我默认在第 3 阶段确认没有世界包依赖后删除 `player-intent-worker.ts` 和 `agents` 包的相关部分。

## 11. 已知限制

- 第三方插件可以破坏隔离和体验，宿主无法阻止。
- 第三方调度器可能超出玩家设置的调用上限，造成额外模型费用。它如果忽略取消信号并一直不返回，这一轮会卡住，玩家只能重启游戏。这些都按已接受的信任模型处理。
- 换调度器可能让某些世界包的体验变差，而世界包作者未必测过。作者可以把依赖声明为必需，但第一版没有“禁止替换某接缝”的声明。
- 插件读取特权接口写出的越权行为，不算主干缺陷。
- Core 成为必需依赖后，正式游玩需要 Python 和 E5，开源用户的开发环境门槛更高；缺失时直接报错，没有轻量退路。
- 官方接口在第一版后仍可能变动，第一版不承诺长期稳定；通过 `hostApi` 版本明确不兼容。
- 工作量目前无法精确估算，第 1 阶段后的决策点会用实际数据校准。

## 12. 由实施者决定

- `packages/official-*` 的具体命名和拆分粒度。
- 接缝类型放在 `plugin-sdk` 的文件组织方式。
- semver 比较用现有依赖还是引入 `semver` 包（`node_modules` 中已有，需在 `package.json` 声明）。
- `WorldServices`、`WorldReader` 的具体方法，以实际需要为准，宁少勿多。
- `WorldHostCore` 拆分后的文件划分。
