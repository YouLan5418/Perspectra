# 宿主适配器下沉方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `desktop/host` 里不依赖桌面的校验、状态迁移和观察构造下沉到核心，让宿主适配器只剩绑定与执行，且世界事实和角色请求不变。

**Architecture:** 按方法归类：不变量和候选校验进 `packages/application` 的纯函数，脚本解释继续留在 `official-*`，身份绑定、资源、外部能力留在宿主。不新增包、事件、存档格式和 Provider 方法。

**Tech Stack:** TypeScript strict、ESM 显式 `.ts` 导入、Vitest、现有 `executeWorldRound`。

**Spec:** 本文第 1～3 节。依据[统一规范](../../current/architecture/plugin-standard.md)和[M7 记录](../../current/studies/2026-11-core-migration-m7.md)。

状态：待用户确认，尚未实施。

## 1. 这件事值不值得做

例如玩家在活动中移动，现在走 `ActivityRuntime.worldAction`；角色移动走 `CharacterTurn`。后者通过 `actionObservations` 告诉目击者“从哪来、到哪去”，前者自己拼观察，代码里没有 `movement` 这一段。同一件事有两份写法，见证者知道的内容就可能不一样。下沉主要解决这类重复。

| 问题 | 现状证据 | 不解决的后果 |
| --- | --- | --- |
| 观察构造重复 | `actionObservations` 注释要求两条路径共用；`StatusRuntime.apply`、`ActivityRuntime.#observations`、`worldAction`、`CommunicationRuntime.perform` 各写一份 | 目击者认知可能分叉，属于产品优先级第 3 项。**活动中移动缺 movement 只是读代码发现，Task 1 先复现** |
| 适配器里的逻辑测不到 | 校验混在带 WorldStore 的方法里，最小核心验收只能绕过它们 | 非法候选的拒绝规则只能靠重型场景测试 |
| 活动路径有一份只给测试用的实现 | `ActivityRuntime` 自带随机序列和本地读取，生产环境总被 `ActivitiesRuntime` 覆盖 | 测试走的路径和生产不同 |
| 打开机制的代码重复 | `world-runtime.ts` 五个 `#openX` 结构相近 | 每加一项检查要改五处 |

**不会带来的：** 玩家看得到的新能力。除了 Task 1 可能修掉的认知问题，这是一次可维护性整理。到目前为止，没有试玩反馈指出适配器造成体验问题，也没有第二个入口或第三方活动机制在等它。所以任务按价值排序，做完任何一个都能停。

## 2. 下沉到哪里

逐个方法核对了依赖：适配器对桌面专属代码的依赖只有 `host-capabilities`（状态的外部能力）和 `pack-modules` 的类型，其余只依赖 application、kernel、store-sqlite。所以技术上不难，难点是归属。

| 代码 | 现在位置 | 去向 | 理由 |
| --- | --- | --- | --- |
| 玩家即时行动的观察与受众 | activity-runtime、status-runtime | 核心 | 这就是认知边界，不该有多份 |
| `actorWorldView`、`ActivityWorld` | activity-world | 核心 | 只依赖核心，是授权视图 |
| 状态许可和操作结果的解析、准入、轮次计数 | status-runtime | 核心 | 全是对机制候选的校验，无脚本 |
| 活动开始、暂停、恢复、放弃、逃生的状态迁移 | activity-runtime `apply`、`escape` | 核心 | 见下面的决策 |
| 活动选项、行动过滤、结果解析、调度校验 | activity-runtime | 核心 | 执行机制返回的 policy，属于检查 |
| 脚本解释、前台选择、自动开始选择 | official-activities | 不动 | 已经在机制里 |
| `executeWorldRound` 的调用、Store 与租约、外部能力、随机数记录 | 宿主 | 不动 | 这是绑定和资源，是宿主的本职 |
| 通信 177 行、自主 213 行、知识 22 行 | 宿主 | 不动 | 已经够薄，继续拆得不偿失；通信的观察在 Task 2 顺带统一 |

### 决策：活动生命周期放核心，不开放给机制替换

这是本方案最大的取舍，需要你确认。

| | A. 放核心（推荐） | B. 交给机制 |
| --- | --- | --- |
| 做法 | 纯函数放 application，脚本钩子不变 | `ActivitiesInstance` 新增 `transition`、`options`、`view`，官方实现搬进 official-activities |
| 宿主变薄 | 是 | 是 |
| official-activities | 仍约 115 行 | 约 500 行 |
| 能否换掉整个活动系统 | 不能，只能换脚本解释和选择策略 | 能，例如没有暂停概念的活动 |
| 风险 | 核心多了活动语义 | 第三方实现可能破坏“暂停不丢进度”；公共契约变大，核心要多一层校验 |

推荐 A 的理由：`activity.updated`、唯一前台、参与者合法性已经在核心（M4 的决定），生命周期是同一个事实的迁移规则；逃生按钮必须不受作者脚本影响；目前没有任何玩法需要另一套生命周期。AGENTS 要求没有实际需求时不新增抽象接口。

选 A 意味着：**机制会继续保持薄，这是有意的。** 第 6 张图里问题在于宿主厚，不在于机制薄。如果你的预期就是“换一个包换掉整个活动系统”，请选 B；B 可以在 A 完成后再做，Task 4、5 的纯函数正好是它的起点，不会白做。不管选哪个，逃生都留在核心。

### 明确不做

- 不新建包。移动文件本身不算分层。
- 不拆 `world-runtime.ts` 的其余部分。71 处 `#gameplay` 调用是另一件事，只做 Task 6。
- 不处理 application 对 plugin-sdk 的类型依赖。没有实际危害。
- 不改作者脚本格式、事件形状、存档和 HOST API 版本。
- 剧情导演和通用外部插件持久状态继续暂停。

## 3. 预期结果

以下行数是按方法范围估算的，不作为验收门槛。

| 文件 | 现在 | 预计 |
| --- | --- | --- |
| `activity-runtime.ts` | 1141 | 约 400 |
| `status-runtime.ts` | 689 | 约 330 |
| `world-runtime.ts` | 2191 | 约 2050 |
| application 新增 | 0 | 约 800 |

宿主合计少约 1200 行。总量差额来自删掉重复，核心会变大，最小核心的打包测试继续保证其中没有官方机制。

## Global Constraints

- 校验基线：`node --import tsx tests/experiments/plugin-seams-baseline.ts compare .tmp/migration-m7/baseline-a020632.json`。已知 `autonomy-integrated` 仅有并发请求顺序差异。任何其他差异都必须逐条解释，只有“目击者多知道了本该知道的事实”才接受，不修改基线迁就。
- 默认检查：`corepack pnpm@11.7.0 check`，当前 190 文件、1818 项全过。
- 核心不导入 `desktop/`、`official-*`、`interactions-basic`；机制不接触 WorldStore 和 commitRound。
- 不吞错误：`TypeError`／`RangeError` 继续表示拒绝本次请求。
- `D:/worlds` 只读，新实验用新目录。凭证不进日志。

## Review Focus

1. 同一 requestId 重试：状态操作、活动操作、活动中发言都不能重复执行或改变内容。→ Task 2、4 各加用例。
2. 等待外部能力时世界关闭或前缀变化：结果丢弃，外部效果不重做。→ Task 2。
3. 已有存档继续玩：事件形状不变，迁移前产生的 `activity.updated` 和 `status.updated` 能折叠。→ Task 4 固定事件形状的快照测试。
4. 重生回合的随机重放：删除活动内自带随机后，发牌和自动开始要和原回合一致。→ Task 5。
5. 快捷操作两次提交只算一轮，静观算一轮，多段输入算一轮。→ Task 3。

---

### Task 1：钉住现状，复现观察分叉

**Files:**
- Create: `tests/host/immediate-observation-parity.test.ts`
- Modify: `scripts/check-host-boundaries.mjs`、`tests/host/boundaries.test.ts`

**Interfaces:**
- Produces: 一份记录即时路径观察内容的测试，后续任务不许改变其中已通过的断言。

- [ ] **Step 1: 写测试 `activity move tells witnesses the route like an ordinary move`**

用包内 `policy.move = true` 的最小活动脚本，玩家在活动中 `/act move`。断言：出发场景的目击者观察含 `movement.fromLocationId`，到达场景的目击者含 `movement.toLocationId`，与非活动状态下同一移动的观察内容一致。

- [ ] **Step 2: 运行并记录结果**

Run: `npx vitest run --config vitest.config.ts tests/host/immediate-observation-parity.test.ts`
预期失败。如果通过，说明分叉不存在，把第 1 节那一行改成“已排除”，重新评估 Task 2 的优先级并告诉用户。

- [ ] **Step 3: 增加静态边界**

`desktop/` 下出现 `.commitRound(` 即报错（当前已经没有调用，只是没有强制）。在 boundaries 测试里加反例。

- [ ] **Step 4: 提交**

失败的用例先标 `it.fails`，Task 2 改回 `it`。提交信息 `test: pin immediate action observations`。

### Task 2：统一即时行动的观察

**Files:**
- Create: `packages/application/src/immediate-action.ts`、`packages/application/src/immediate-action.test.ts`
- Move: `desktop/host/activity-world.ts` → `packages/application/src/world-view.ts`
- Modify: `packages/application/src/action-observations.ts`、`desktop/host/activity-runtime.ts`、`desktop/host/status-runtime.ts`、`desktop/host/communication-runtime.ts`

**Interfaces:**
- Produces:
  - `actorWorldView`、`readActivityWorld`、`activityWorldFromEvents`、`ActivityWorld`，签名不变；`truth` 的参数收窄为 `{ truth(events): StatusTruth } | undefined`。
  - `immediateActionDrafts(input: { scene: SceneDecisionService; address: WorldAddress; manifest: CompiledWorldManifest; events: readonly RulebookEvent[]; headSeq: number; actorId: CharacterId; actionId: string; roundId: InteractionRoundId; action: { actionType: string; parameters: WorldJsonObject }; result: RulebookResolution; description: string }): WorldEventDraft[]`，返回规则事件、移动的场景迁移、观察和 `action.resolved`。
  - `actionObservations` 增加可选 `observationId?: (observerId: CharacterId) => string`，让即时路径保留现有 ID 格式 `${actionId}:${observerId}`。

- [ ] **Step 1: 写单测**：`immediateActionDrafts` 对 direct、scene_public、private 受众的观察接收者正确；occurrence-only 只知道发生过；移动含路线；物品转移含 `interaction`。
- [ ] **Step 2: 确认失败**，函数尚不存在。
- [ ] **Step 3: 实现**，内部调用 `actionObservations` 和 `movementRoute`，不再手拼。
- [ ] **Step 4: 切换** `worldAction` 和 `StatusRuntime.apply`。`perform` 的发件人观察同样改用它。
- [ ] **Step 5: 加重试和取消用例**（Review Focus 1、2）。
- [ ] **Step 6: 把 Task 1 的 `it.fails` 改回 `it`，运行相关测试**

Run: `npx vitest run --config vitest.config.ts tests/host/immediate-observation-parity.test.ts tests/host/pack-activities.test.ts tests/host/pack-status-runtime.test.ts tests/scenarios/cross-scene-communication.test.ts tests/host/status-market-items.test.ts`

- [ ] **Step 7: 运行基线比较**，把差异逐条写进提交说明。观察多了 `actionId` 字段时，核对角色请求里的变化是否只有新增事实。
- [ ] **Step 8: 提交** `refactor: share immediate action observations in the core`。

### Task 3：状态校验下沉

**Files:**
- Create: `packages/application/src/status-operations.ts`、`packages/application/src/status-operations.test.ts`
- Modify: `desktop/host/status-runtime.ts`

**Interfaces:**
- Produces:
  - `parseStatusOffers(result: unknown, operations: readonly StatusOperation[]): StatusOffers`
  - `admitStatusOperation(input: { operations; offers; operationId; targetId; parameters; actorId; playerId; activityKey; sceneIds; characterIds; validArguments }): { op: StatusOperation } | { rejected: string }`
  - `parseStatusOperationResult(value: unknown): { rejected: string } | { changes; reveals; description; audience; items? }`
  - `statusOperationChoices(input: { operations; offers; activityKey; actorId; playerId; isReachable(entityId): boolean; entityName(entityId): string }): WorldJsonObject[]`
  - `statusRoundNumber(events, turnStartSeq: number, pause: boolean): { round: number; turnCommits: number }`
- 留在宿主：`externalActions`、`CAPABILITY_PENDING`、`executeWorldRound` 调用、`resolver` 包装。

- [ ] **Step 1: 写纯函数测试**，不打开数据库：未声明操作、许可列出未声明物品、拒绝原因不含任何状态值、结果多余字段报错；`statusRoundNumber` 覆盖快捷操作、静观、多段输入和钩子失败后的计数（Review Focus 5）。
- [ ] **Step 2: 确认失败。**
- [ ] **Step 3: 按原语义搬入，文案和错误类别不变。**
- [ ] **Step 4: 运行**

Run: `npx vitest run --config vitest.config.ts tests/host/pack-status.test.ts tests/host/pack-status-runtime.test.ts tests/host/status-seam.test.ts tests/host/status-market-items.test.ts tests/scenarios/dual-plugins.test.ts tests/scenarios/rpg-turn-battle.test.ts`

- [ ] **Step 5: 基线比较应无新增差异，提交** `refactor: move status candidate checks into the core`。

### Task 4：活动生命周期下沉

**Files:**
- Create: `packages/application/src/activity-lifecycle.ts`、`packages/application/src/activity-lifecycle.test.ts`
- Modify: `desktop/host/activity-runtime.ts`

**Interfaces:**
- Produces（都不读库、不调用脚本）：
  - `checkActivityRequest(state, id, revision, actorId): asserts state is ActivityState`
  - `startedActivity(input: { id: string; participants: string[]; game: ActivityGame }): ActivityState`
  - `suspendedActivity(state): ActivityState`、`abandonedActivity(state): ActivityState`、`resumedActivity(state): ActivityState`、`escapedActivity(state): ActivityState`
  - `activityUpdatedEvent(input: { key; state; description; actorId; actionId; operation }): WorldEventDraft`
  - `activityOutcomeObservations(input: { state; description; actorId; actionId; observerIds; operation }): WorldEventDraft[]`
  - `activityResultMetadata(state, operation): WorldJsonObject`
- 留在宿主：调用 `initialize` 和 `resume` 钩子、场景校验、随机数、`executeWorldRound`。

- [ ] **Step 1: 写测试**：暂停后 `turn` 记入 `suspendedTurn` 且进度不变；恢复还原轮次；放弃保留已提交经历；逃生不接收脚本结果；每次 revision 加一。另固定 `activity.updated` 的事件形状快照（Review Focus 3）。
- [ ] **Step 2: 确认失败。**
- [ ] **Step 3: 搬入后让 `apply`、`escape` 调用它们**，描述文案由调用方传入或保持原文。
- [ ] **Step 4: 加同 requestId 重试用例（Review Focus 1），运行**

Run: `npx vitest run --config vitest.config.ts tests/host/pack-activities.test.ts tests/host/pack-activity.test.ts tests/host/activities-seam.test.ts tests/host/pack-status-activity.test.ts tests/scenarios/activity-auto-start.test.ts tests/scenarios/model-girls-werewolf.test.ts`

- [ ] **Step 5: 基线比较无新增差异，提交** `refactor: move activity lifecycle transitions into the core`。

### Task 5：活动检查下沉，删除测试专用路径

**Files:**
- Create: `packages/application/src/activity-projection.ts`、`packages/application/src/activity-projection.test.ts`
- Modify: `desktop/host/activity-runtime.ts`、`desktop/host/activities-runtime.ts`、`tests/support/activity-runtime.ts`

**Interfaces:**
- Produces:
  - `activityOperationOptions(state, policy, operations, actorId): WorldJsonObject[]`
  - `filterActivityAffordances(base, policy, options, canPerform): ActionAffordance[]`
  - `checkActivityExpression(policy, parameters): void`
  - `parseActivityOperationResult(value, rules: ActivityStateRules, state): { rejected: string } | { next: ActivityState; description; audience; status?; playerExpression? }`
  - `parseActivityPlan(value, state, playerId): string | undefined`
- Changes: `ActivityRuntime` 构造函数必须接收 `{ randomSource, readCurrent, signal }`，删除自带的随机序列和本地读取。`activityFromSource` 测试辅助显式提供它们。

- [ ] **Step 1: 写测试**：`policy` 只收到 scoped 数据；选项遵守 `requiresTurn`；非参与者不能操作；调度请求玩家或非参与者时拒绝；resolve 的 `rejectReason` 不提交。
- [ ] **Step 2: 确认失败。**
- [ ] **Step 3: 搬入并切换调用。**
- [ ] **Step 4: 加重生随机重放用例（Review Focus 4），运行**

Run: `npx vitest run --config vitest.config.ts tests/host/tail-round.test.ts tests/host/pack-activities.test.ts tests/host/activities-seam.test.ts tests/scenarios/activity-auto-start.test.ts tests/scenarios/rpg-core-activity.test.ts tests/scenarios/gameplay-composition-acceptance.test.ts`

- [ ] **Step 5: 基线比较无新增差异，提交** `refactor: move activity checks into the core`。

### Task 6：统一打开机制

**Files:**
- Modify: `desktop/host/world-runtime.ts`、`desktop/host/gameplay-services.ts`

**Interfaces:**
- Produces: `#openMechanism<T>(input: { name: keyof HostSeams; label: string; source: Record<string, unknown>; declared: boolean; guard(instance: unknown): T }): Promise<T | undefined>`；`guardedStatus(instance, hasSource, id, report)` 从 `#openStatus` 移到 gameplay-services。

- [ ] **Step 1: 确认现有用例覆盖**“资产缺机制报错”“打开失败文案”“校验失败时已打开的实例被关闭”。`tests/host/world-composition.test.ts` 缺哪项就先补哪项。
- [ ] **Step 2: 替换** communication、autonomy、activities、status、knowledge 五个方法。错误文案保持 `${label}机制 ${id} 无法打开：…`。
- [ ] **Step 3: 运行** `npx vitest run --config vitest.config.ts tests/host/world-composition.test.ts tests/host/status-seam.test.ts tests/host/activities-seam.test.ts tests/host/communication-autonomy-seams.test.ts tests/host/knowledge-seam.test.ts`
- [ ] **Step 4: 提交** `refactor: open selected mechanisms through one path`。

### Task 7：整体验收与文档

**Files:**
- Create: `docs/current/studies/2026-11-host-adapter-sinking.md`
- Modify: `docs/current/architecture/modules.md`、`docs/current/architecture/plugin-standard.md`、`docs/current/architecture/mechanism-contracts.md`、`desktop/host/README.md`

- [ ] **Step 1:** `corepack pnpm@11.7.0 check` 和 `corepack pnpm@11.7.0 launcher:check`。预期全过。
- [ ] **Step 2:** 基线比较，逐条记录差异。
- [ ] **Step 3:** 真实模型复跑：`M7_ONLY=roleplay,market,rpg,werewolf` 运行 `tests/experiments/m7-composition-live.ts`，写到新目录，和 `.tmp/migration-m7/live-1`、`live-2` 对照阅读，重点看活动中移动后的目击者说法。
- [ ] **Step 4:** 重新测量行数，更新架构图第 6 张。记录哪些估算没有达到。
- [ ] **Step 5:** 同步文档并运行 `node scripts/docs/check-links.mjs`，确认没有新增断链。提交 `docs: record host adapter sinking`。

## 什么时候停

- Task 1 证明没有分叉，且你不打算再动架构：只留 Task 1 的测试和边界检查。
- 只想修认知和测试问题：做完 Task 1～3。
- 基线或真实试玩出现解释不了的差异：停下，不继续后面的任务。
- 想要可替换的活动系统：在 Task 5 之后另写方案 B 的设计，不混进本计划。
