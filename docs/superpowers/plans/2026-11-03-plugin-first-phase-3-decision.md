# 插件优先运行时阶段 3：决策管道与模型调用 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让开发者能换掉角色调用的模型通道，也能在角色决策前后插入自己的处理，官方组合下发给模型的请求保持不变。

**Architecture:** 新增两个接缝。`ctx.llm` 只有一个实现，负责把一次角色决策变成模型调用；官方实现 `official-llm` 带着预设、按角色选模型和请求记录。`ctx.decisions` 可以叠加多个实现，给请求加内容或环绕整个决策。JEV 审计改成其中一个官方可选实现。

**Tech Stack:** TypeScript strict、ESM、显式 `.ts` 导入、Cordis 4.0.1、vitest。

**Spec:** [插件优先运行时](../specs/2026-11-02-plugin-first-runtime-design.md) 第 6.3 节。

## 这一阶段能得到什么

例如开发者想让角色走自己的本地模型：只写一个 `send`，收到宿主准备好的消息和输出格式，返回模型的回答。又如开发者想在角色开口前加一段“今天的天气”：注册一个决策实现，给请求加一个字段。

**先说清楚成本。** 阶段 1 的记录说“拆 `#decide` 才会明显减少 `world-runtime.ts`”，这个判断偏乐观。`#decide` 只有约 140 行，状态、知识、活动模拟这几步依赖 `#status`、`#activity`，要到阶段 4 才能移走。这一阶段预计把 `world-runtime.ts` 从 2,267 行减到约 2,100 行，主要收益是开放能力。总装配真正变小还要靠阶段 4。

## 与设计不同的一处（请确认）

设计写的是 Cordis 事件 `character/context`、`character/decide`。核对 Cordis 4.0.1 后，我建议改成 `ctx.decisions.register(provider)`：

| | Cordis 事件 | `ctx.decisions`（建议） |
| --- | --- | --- |
| 传给下一层的请求 | `next()` 不接受参数，只能改共享对象 | `next(request)` |
| 审计改写后重新决策 | 第二次 `next()` 会跳过后面的监听器 | 可以多次调用 |
| 多个世界实例并存 | 事件是进程级的，插件要自己按世界区分状态 | 每个实例 `open` 一次，和调度器、记忆相同 |
| 实例结束时释放资源 | 没有对应时机 | `close` |

这样全部接缝是同一种形状，也符合设计里“沿用 `CapabilityProvider`，不新造概念”。代价是插件不能用 `ctx.on` 这种写法。

## Global Constraints

- 官方组合下，模型请求内容与基线逐项一致；有差异必须能解释并写进 ledger。
- 第三方插件拿不到模型凭据；`WorldServices` 不含模型配置。
- 只有 `desktop/official-bundle.ts` 能 import `packages/official-*`，边界脚本检查。
- 宿主 API 升到 `1.3`。
- `WorldHostOptions` 的 `models`、`preset`、`presetMapping` 等保留，由默认组合包读取；不改动现有测试的调用方式。
- 状态、知识、活动模拟、自主预算 `#modelCallBudget` 留在宿主，阶段 4 再处理。
- 新实验使用新数据目录，`D:/worlds` 只读。在本机运行 Core 时，`TEMP`、`TMP` 和数据目录都放到仓库 `.tmp` 下。
- 真实试玩用本机 8045、`gemini-3.8-flash`、思考强度 low。

## 有意接受的限制

- **Core 不走 `ctx.llm`。** Core 的整理由 Python 调用模型，换模型通道不影响它。
- **换掉 LLM 后没有预设。** 预设的提示词和输出规则属于官方实现，第三方收到的是不带预设的默认消息。
- **仍然要配模型连接。** 启动入口和 Launcher 的连接检查不变，只装第三方 LLM 也要填一个连接。
- **创作者页只显示 `requests` 接口收到的记录。** 第三方不写，就看不到请求详情。
- **玩家意图解释器** 已停用，只保持能编译和原有测试通过：第三方 LLM 没有 `dispatch` 时，声明该路径的世界会报错。

## Review Focus

1. 第三方 LLM 的 `send` 抛错或超时：这一轮失败并提示，已提交内容保留，下一轮可以继续。（Task 1）
2. 第三方 LLM 返回非 JSON 或不合格式的内容：走现有格式重试，再失败时不执行任何操作，不会发布半截内容。（Task 1）
3. 决策实现返回任意内容：回答仍要经过 `CharacterTurn` 校验，决策实现不能直接提交世界事实。（Task 2）
4. 重新生成、恢复和节点打开时，所有决策实现都能正确 `open` 和 `close`，一个 `open` 失败不会留下已打开的其他实例。（Task 2）
5. 去掉 JEV 后，没有启用审计时，`continueAfterPublish`、`beforeActionExpression`、动态并发的开关和之前相同。（Task 3）

---

### Task 1: 模型通道接缝 `ctx.llm`

**Files:**
- Create: `packages/official-llm/{package.json,tsconfig.json,src/index.ts}`
- Move: `desktop/host/role-providers.ts`、`desktop/host/gateway-turn-call.ts` 到 `packages/official-llm/src/`
- Modify: `packages/plugin-sdk/src/index.ts`、`desktop/host-plugins.ts`、`desktop/official-bundle.ts`、`desktop/host/world-runtime.ts`、`desktop/host/tail-runtime.ts`、`desktop/host/web-entry.ts`、`scripts/check-host-boundaries.mjs`
- Create: `tests/host/llm-seam.test.ts`，以及仓库外的基线探针（见 Step 1）

**Interfaces:**
- Produces（`plugin-sdk`）：

```ts
/** One model call: the messages to send and the JSON Schema the answer must meet. Hand it back unchanged in
 * `send`; the host's calls carry an extra inspection field for the request log. */
export interface LlmCall {
  readonly messages: readonly { readonly role: string; readonly content: string }[]
  readonly schema: WorldJsonObject
}
export interface LlmInstance {
  /** Send one call and return the parsed answer. The host validates it and retries once on bad format. */
  send(characterId: string, call: LlmCall, request: MemoryRequest, signal: AbortSignal): Promise<unknown>
  /** Replace the default prompt for this decision. Without it the host's default call is sent as is. */
  prepare?(characterId: string, request: MemoryRequest, signal: AbortSignal): Promise<LlmCall>
  /** Extra text that counts against the character's context budget, such as a preset prompt. */
  promptText?(characterId: string): string
  /** Reshape what the player reads, such as preset display rules. */
  display?<T>(view: T): Promise<T>
  dispatch?(request: WorldJsonValue, profile: WorldJsonObject, signal: AbortSignal): Promise<WorldJsonValue>
  close?(): void | Promise<void>
}
/** `ctx.llm`: replaces how characters reach a model. */
export interface LlmSlotApi {
  register(provider: SeamProvider<LlmInstance>): () => void
  readonly current: SeamProvider<LlmInstance> | undefined
}
```

- `WorldServices` 增加 `readonly characterIds: readonly CharacterId[]` 和 `readonly requests: LlmRequestLog`。`LlmRequestLog` 是 `RequestInspector` 中 provider 实际使用的 `begin`、`finish` 的结构类型，不含凭据。
- Produces（`official-bundle`）：`assembleOfficialLlm(options: ModelOptions & { onCall; onRoleCall }): SeamProvider<LlmInstance>`。`HostSeams` 增加 `llm?`。
- 宿主字段：`#llm: LlmInstance`，`#openLlm()` 在 `#openMemory()` 之前运行。

- [ ] **Step 1: 记录基线**

在 scratchpad 写 `decision-probe.mts`，扩展上一阶段的 `request-probe.mts`，用假模型逐字记录请求（清洗 UUID、哈希、decisionId）。场景：`dynamic-scheduling`（默认预设）；带 `preset` 和 `presetMapping`；一个角色用 google 协议；`model-girls-sweet-days`（状态和知识）；`model-girls-werewolf`（活动和脚本模拟）；带 `stageExpressions`。

Run: 在当前 HEAD 运行，保存为 `baseline.json`。
Expected: 每个场景都有请求，连续两次运行的结果逐字相同。不相同就先把不稳定的部分清洗掉。

- [ ] **Step 2: 写失败测试 `tests/host/llm-seam.test.ts`**

```ts
it('sends the default call through a third-party model channel', ...)     // send 收到 messages 和 schema，回答成为对白；原模型服务器 0 次请求
it('keeps player input when send throws and continues next round', ...)   // 错误提示，transcript 有玩家输入，下一轮可用
it('retries once on an invalid answer, then executes nothing', ...)       // send 被调用 2 次，世界 head 不含角色发布
it('refuses to open the world when the model channel cannot open', ...)   // 错误带插件 ID，不回退官方
it('uses prepare when the channel provides it', ...)
it('gives a model channel no model configuration', ...)                   // Object.keys(services) 不含 models；characterIds 正确
it('refuses to regenerate after the model channel changed', ...)
```

Run: `node node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/host/llm-seam.test.ts`
Expected: FAIL，`plugins.llm` 没有生效，请求仍到原服务器。

- [ ] **Step 3: 实现接缝和 `official-llm`**

`officialLlm` 的 `open` 调用移过来的 `createRoleProviders`；`prepare` 是现在 `#decide` 里的 `prepare`（`presetContext`、`presetCall`、`gatewayTurnCall`）；`send` 是 `roleProvider.decide` 加 `presetOutput`；`promptText` 返回预设 prompt；`display` 包 `presetDisplay`；`dispatch` 走 `shared`。预设名称（玩家名、角色名、场景名）从 `context` 和 `WorldServices` 取得，确实不够时给 `assembleOfficialLlm` 传入。

宿主的 `#decide` 里，默认调用用 `characterTurnCall(request)`；调用前仍扣 `#modelCallBudget`；`simulated` 仍绕过 `send`。`#openLlm` 默认用 `assembleOfficialLlm(this.#options)`。`onCall`、`onRoleCall` 继续更新 `#providerCalls`、`#lastCall`、`#roleCalls`。`tail-runtime` 的环境指纹加 `llmProvider: { id, version }`。`SeamProvider` 不必加第二个类型参数。

- [ ] **Step 4: 运行测试和基线对比**

Run: 接缝测试；`corepack pnpm@11.7.0 test:related tests/host/core-memory.test.ts tests/host/pack-activity.test.ts`；再跑 `decision-probe.mts` 并与 `baseline.json` 比较。
Expected: 全部通过；请求逐字相同。

- [ ] **Step 5: 提交**

```bash
git add -A packages/official-llm packages/plugin-sdk desktop scripts tests pnpm-lock.yaml
git commit -m "feat: route character model calls through a replaceable seam"
```

### Task 2: 决策实现 `ctx.decisions`

**Files:**
- Create: `desktop/host/character-decision.ts`、`tests/host/decision-seam.test.ts`
- Modify: `packages/plugin-sdk/src/index.ts`、`desktop/host-plugins.ts`、`desktop/official-bundle.ts`、`desktop/host/world-runtime.ts`、`desktop/host/tail-runtime.ts`

**Interfaces:**
- Consumes: Task 1 的 `LlmInstance`。
- Produces（`plugin-sdk`）：

```ts
export interface DecisionInstance {
  /** Add to what this character knows before it decides. Runs after the host's own steps. */
  context?(request: MemoryRequest, signal: AbortSignal): Promise<MemoryRequest>
  /** Wrap the whole decision. May call `next` several times, or not at all. */
  decide?(request: MemoryRequest, next: (request: MemoryRequest) => Promise<unknown>, signal: AbortSignal): Promise<unknown>
  /** The host runs one character at a time and turns off follow-up publication while this is true. */
  readonly serial?: boolean
  committed?(headSeq: number): void
  debug?(): WorldJsonObject
  close?(): void | Promise<void>
}
/** `ctx.decisions`: any number of implementations, applied in load order. */
export interface DecisionsApi {
  register(provider: SeamProvider<DecisionInstance>): () => void
  readonly providers: readonly SeamProvider<DecisionInstance>[]
}
```

- `HostSeams` 增加 `decisions?: readonly SeamProvider<DecisionInstance>[]`。
- `character-decision.ts` 导出 `runDecision(input): Promise<unknown>`，收纳 `prepare`、格式重试、`observeContext`、trace、`recordDecision`、环绕链。宿主的 `#decide` 只保留记忆投影、状态、知识、表情和活动模拟这些依赖实例状态的步骤。

- [ ] **Step 1: 写失败测试 `tests/host/decision-seam.test.ts`**

```ts
it('adds to the context a character decides on, in load order', ...)      // 两个实现，字段都到达模型，后者看得到前者的字段
it('wraps the decision and can decide again with a revised request', ...) // next 调用两次，模型请求 2 次，返回第二次的结果
it('can answer without calling the model', ...)                           // 不调用 next，模型 0 次；答案仍经 CharacterTurn 校验，非法答案不提交
it('fails the round when a decision implementation throws', ...)          // 玩家输入保留，下一轮可继续
it('closes the instances already open when a later one cannot open', ...) // 世界不打开，错误带插件 ID，前一个 close 被调用
it('opens and closes implementations for each regeneration candidate', ...)
it('schedules serially while an implementation declares serial', ...)     // 同一轮的模型调用互不重叠；continueAfterPublish 不生效
it('reports commits and debug state', ...)                                // committed 收到递增的 headSeq，debug 出现在 state.debug
```

Run: `node node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/host/decision-seam.test.ts`
Expected: FAIL，`plugins.decisions` 没有生效。

- [ ] **Step 2: 实现**

`#openDecisions` 依次打开，有失败就关闭已打开的并抛错（错误带 ID）。`context` 在宿主步骤之后、`#roleCalls.delete` 之前依次运行。环绕链从后往前组合，最内层是 `runDecision` 的核心。关闭世界时倒序 `close`，失败只记日志。

新增私有 `get #serialDecisions()`，暂时与 `publicationAudit === undefined` 的判断并存，Task 3 删除后者。

- [ ] **Step 3: 运行测试和基线对比**

Run: 接缝测试；`corepack pnpm@11.7.0 test:related tests/host/jev-intervention-runtime.test.ts tests/host/pack-activity.test.ts`；基线探针。
Expected: 全部通过；请求逐字相同。

- [ ] **Step 4: 提交**

```bash
git add -A packages/plugin-sdk desktop tests
git commit -m "feat: let plugins extend and wrap character decisions"
```

### Task 3: JEV 审计改成可选实现

**Files:**
- Create: `packages/official-jev-audit/{package.json,tsconfig.json,src/index.ts}`
- Move: `desktop/host/jev-publication-intervention.ts`、`jev-shadow.ts`、`jev-shadow-window.ts`、`jev-shadow-claims-client.ts` 到该包
- Modify: `desktop/host/world-runtime.ts`、`desktop/host/tail-runtime.ts`、`desktop/host/web-entry.ts`、`desktop/official-bundle.ts`、`tests/host/jev-intervention-runtime.test.ts` 和其他引用这些文件的测试

**Interfaces:**
- Consumes: Task 2 的 `DecisionInstance`、`SeamProvider`。
- Produces（`official-bundle`）：`jevPublicationAudit(options: InterventionOptions): SeamProvider<DecisionInstance>`（`serial: true`）、`jevShadowAudit(options: ShadowOptions): SeamProvider<DecisionInstance>`（用 `committed`、`debug`、`close`）。
- 删除 `WorldHostOptions.publicationAudit`、`shadowAudit`。`--jev-shadow` 参数保留，由入口组装后放进 `plugins.decisions`。

- [ ] **Step 1: 改测试调用方式**

`jev-intervention-runtime.test.ts` 等改成通过 `plugins.decisions` 传入，断言不动。再加一条：`--jev-shadow` 组装后，`state.debug.shadowAudit` 仍然存在。

Run: 这些测试。
Expected: FAIL，新的 provider 还不存在。

- [ ] **Step 2: 移动并实现**

审计的 `decide` 环绕：先 `next(request)`，再读历史做审计，修订时再次 `next(revised)`。读历史用 `world.world.readEvents`。这会让修订也走格式重试和记忆记录，比现在多，属于有意变化，写进 ledger。入口读取 `OPENROUTER_JEV_KEY` 后立刻从环境中删除，并加测试，这样插件读不到。

宿主里 `publicationAudit === undefined` 的 5 处判断，全部换成 `!this.#serialDecisions`。

- [ ] **Step 3: 运行测试和基线对比**

Run: `corepack pnpm@11.7.0 check`；`node scripts/check-host-boundaries.mjs`；基线探针。
Expected: 全部通过；请求逐字相同。

- [ ] **Step 4: 提交**

```bash
git add -A packages/official-jev-audit desktop tests pnpm-lock.yaml
git commit -m "refactor: make JEV audit an optional decision implementation"
```

### Task 4: 示例、文档与验收

**Files:**
- Create: `examples/host-plugins/echo-llm.mjs`、`echo-llm.plugin.json`、`docs/current/studies/2026-11-plugin-first-phase-3.md`
- Modify: `docs/current/guides/host-plugin-authoring.md`、`docs/current/host-plugins.md`、`docs/current/architecture/modules.md`、`runtime.md`、`cognition-memory.md`（如涉及）、`scripts/release` 中的包列表（如需要）、设计文档第 6.3 节

**Interfaces:** 无。

- [ ] **Step 1: 示例插件**

`echo-llm.mjs` 只有 `send`：把 `call` 转发到配置的 OpenAI 兼容地址。用它在 8045 上走一次真实试玩，确认文档示例能经插件加载器跑通，这是阶段 2 审查指出的缺口。

- [ ] **Step 2: 真实模型试玩**

本机 8045，`gemini-3.8-flash`，low。`main` 和本分支各跑 `dynamic-scheduling` 的 8 轮 Core 试玩，再各跑一次 `model-girls-sweet-days` 短局和 `model-girls-werewolf` 短局（阶段 1、2 都没验证过这两个包）。比较对白、调用次数、耗时和记忆条数。

- [ ] **Step 3: 更新文档并写阶段记录**

先给角色例子，再讲接缝。记录 `world-runtime.ts` 行数、请求对比结果、未验证内容和对阶段 4 的判断。

Run: `node scripts/docs/check-links.mjs`
Expected: 断链不超过 102，新增文件无断链，模块地图覆盖新包。

- [ ] **Step 4: 提交**

```bash
git add -A docs examples/host-plugins scripts
git commit -m "docs: record plugin-first phase 3 results"
```

**不要自动进入阶段 4。** 阶段 4 先摸底，再和用户确认切法。
