# 统一模型 Provider 适配器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Node 侧角色决策调用统一经由 pi-ai 发出，调用目标只有"连接 + 模型 + 思考强度"一种，删除 `local / deepseek / ollama` 入口、重复的环境变量路径和按模型名的猜测。

**Architecture:** `packages/provider-chat` 内新增 pi-ai 模型构造（目录查找 + baseUrl 推导）并把 `createChatProvider` 的发送实现换成 pi-ai 的 lazy 协议入口；对外的 `decide / dispatch / ChatCallObservation / RequestInspector` 接口不变。Launcher 只通过 `PERSPECTRA_ROLE_MODELS` + `PERSPECTRA_MODEL_KEYS` 传递解析后的目标，Host 的 `WorldHostOptions` 用一个 `models: RuntimeRoleModels` 取代 `provider / protocol / model / apiKey / utilityEndpoint / thinkingLevel / roleModels`。Python 记忆代码不动。

**Tech Stack:** TypeScript strict（ESM，显式 `.ts` 本地导入）、`@earendil-works/pi-ai@1.4.0`、vitest、Vue 3（Launcher）、esbuild（发行打包）。

**Spec:** [docs/superpowers/specs/2026-10-27-unified-provider-adapter-design.md](../specs/2026-10-27-unified-provider-adapter-design.md)

## Global Constraints

- 依赖精确锁定 `"@earendil-works/pi-ai": "1.4.0"`，只导入 `@earendil-works/pi-ai/api/openai-completions.lazy`、`.../api/anthropic-messages.lazy`、`.../api/google-generative-ai.lazy`、`@earendil-works/pi-ai/providers/all`（目录）、`@earendil-works/pi-ai/utils/transcript`（`normalizeContext`）及类型；禁止导入聚合入口 `@earendil-works/pi-ai`（类型导入除外）。
- 协议映射固定：`openai → openai-completions`，`anthropic → anthropic-messages`，`google → google-generative-ai`。
- 不隐式重试：pi-ai 选项一律 `maxRetries: 0`。
- Key 只经 `apiKey` 选项传入；无 Key 的连接请求中不得出现 `authorization` / `x-api-key` / `x-goog-api-key` 头。Key 不得出现在数据目录、检查器记录、错误消息中。
- 思考强度仍只暴露 `off / low / medium / high`。未设 = 不发任何思考字段；显式 `off` = 由 pi-ai 发关闭字段；`low/medium/high` = pi-ai `reasoning` 同名档位。例外：OpenAI 兼容协议、模型为 DeepSeek 思考格式的角色决策调用在未设时发 `thinking:{type:'disabled'}`。
- 开启思考时 `maxTokens = max(当前上限, {low: 8192, medium: 16384, high: 32768}[level])`。
- 不改 Python 记忆代码；`python-worker.ts` 传给 Python 的 `HCW_LOCAL_MODEL / ENDPOINT / PROTOCOL / API_KEY` 不改名。
- 玩家意图理解已停用：`dispatch` 只需随共享实现编译通过，不为它写新测试。
- 源码入口环境变量：`PERSPECTRA_MODEL_PROTOCOL`（默认 `openai`）、`PERSPECTRA_MODEL_ENDPOINT`、`PERSPECTRA_MODEL`、`PERSPECTRA_MODEL_API_KEY`、`PERSPECTRA_THINKING_LEVEL`。缺地址或模型时报错 `未配置模型：请设置 PERSPECTRA_MODEL_ENDPOINT 与 PERSPECTRA_MODEL，或由 Launcher 启动。`
- 默认调用超时：有游玩设置时 `modelTimeoutSeconds * 1000`，否则 `60_000`。
- 用户可见文案用中文；沿用现有错误文案风格。
- `D:/worlds` 历史数据只读；真实试玩使用新数据目录。

## Review Focus

1. **网关不支持流式或 `stream_options`**：pi-ai 总是流式（`stream: true` + `stream_options.include_usage`）。8045 网关或 Ollama 若不支持，玩家会看到每轮失败。期望：失败消息说明"接口不支持流式响应"，而不是笼统的 transport 错误。→ Task 3 加测试（模拟服务器返回非 SSE 的 JSON 时，错误消息含"流式"）。
2. **输出被截断**（`stopReason === 'length'`）：流式拼出的半截工具参数可能被 partial-json 修补成"看似合法"的对象并被当成决策。期望：一律以 `模型输出超过 token 上限。` 失败。→ Task 3 加测试（三协议各一）。
3. **pi-ai 把 user 消息内容改成 parts 数组**：检查器的 `messages` 和来源标签依赖转换前的消息顺序。期望：检查器仍按转换前消息展示来源。→ Task 3 加测试（检查器记录的 messages 与 `ChatCall.messages` 一一对应）。
4. **已保存的 Gemini 3 实例配置 `thinkingLevel: 'off'`**：新规则下非法。期望：Launcher 能打开，启动时提示重新选择。→ Task 4 加测试。
5. **无 Key 的本机网关**：pi-ai OpenAI 实现无 Key 会抛 `No API key for provider`。期望：照常调用且不带认证头。→ Task 3 加测试。

---

### Task 1: pi-ai 依赖与模型声明构造

**Files:**
- Modify: `packages/provider-chat/package.json`（加依赖）、根 `pnpm-lock.yaml`（安装产生）
- Create: `packages/provider-chat/src/pi-model.ts`
- Create: `packages/provider-chat/src/pi-model.test.ts`
- Modify: `packages/provider-chat/src/index.ts`（导出新函数）

**Interfaces:**
- Produces（`pi-model.ts`，从 `index.ts` 导出）：
  - `export interface ModelTarget { readonly protocol: ProviderProtocol; readonly endpoint: URL; readonly model: string }`
  - `export function piBaseUrl(endpoint: URL, protocol: ProviderProtocol): string`
  - `export function piModel(target: ModelTarget): Model<Api>`（pi-ai 类型）
  - `export function supportedThinkingLevels(target: ModelTarget): ThinkingLevel[]`（顺序 `off, low, medium, high` 的子集）
  - `export function usesDeepSeekThinking(model: Model<Api>): boolean`

- [ ] **Step 1: 安装依赖**

Run: `corepack pnpm@11.7.0 --filter @harness-world/provider-chat add @earendil-works/pi-ai@1.4.0 --save-exact`
Expected: `packages/provider-chat/package.json` 出现 `"@earendil-works/pi-ai": "1.4.0"`。

- [ ] **Step 2: 写失败测试 `pi-model.test.ts`**

```ts
describe('piBaseUrl', () => {
  it.each([
    ['openai', 'https://api.deepseek.com/chat/completions', 'https://api.deepseek.com'],
    ['openai', 'http://127.0.0.1:8045/v1/chat/completions', 'http://127.0.0.1:8045/v1'],
    ['anthropic', 'https://api.anthropic.com/v1/messages', 'https://api.anthropic.com'],
    ['anthropic', 'https://api.deepseek.com/anthropic/v1/messages', 'https://api.deepseek.com/anthropic'],
    ['google', 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent', 'https://generativelanguage.googleapis.com/v1beta'],
  ] as const)('%s %s', (protocol, endpoint, base) => expect(piBaseUrl(new URL(endpoint), protocol)).toBe(base))
  it('refuses an anthropic address that does not end in /v1/messages', () =>
    expect(() => piBaseUrl(new URL('https://x.test/messages'), 'anthropic')).toThrow('/v1/messages'))
})
describe('piModel', () => {
  it('keeps the connection address, protocol and model id whatever the catalog says', () => {
    const m = piModel({ protocol: 'openai', endpoint: new URL('http://127.0.0.1:8045/v1/chat/completions'), model: 'gemini-3-flash-preview' })
    expect([m.api, m.baseUrl, m.id]).toEqual(['openai-completions', 'http://127.0.0.1:8045/v1', 'gemini-3-flash-preview'])
    expect(m.compat).toBeUndefined() // different API and host: wire-format layer not inherited
  })
  it('inherits compat when API and host match the catalog entry', () => {
    const m = piModel({ protocol: 'openai', endpoint: new URL('https://api.deepseek.com/chat/completions'), model: '<a deepseek id present in the pi-ai 1.4.0 catalog>' })
    expect(usesDeepSeekThinking(m)).toBe(true)
  })
  it('gives an unknown id the conservative default', () => {
    const m = piModel({ protocol: 'openai', endpoint: new URL('http://127.0.0.1:1/v1/chat/completions'), model: 'fixture' })
    expect([m.reasoning, m.thinkingLevelMap, m.compat, m.input]).toEqual([true, undefined, undefined, ['text']])
  })
})
describe('supportedThinkingLevels', () => {
  it('drops off for Gemini 3 under both openai and google protocols', () => {
    for (const [protocol, endpoint] of [['openai', 'http://127.0.0.1:8045/v1/chat/completions'], ['google', 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent']] as const)
      expect(supportedThinkingLevels({ protocol, endpoint: new URL(endpoint), model: '<a gemini-3 id in the catalog>' })).not.toContain('off')
  })
  it('offers all four for an unknown id', () =>
    expect(supportedThinkingLevels({ protocol: 'openai', endpoint: new URL('http://127.0.0.1:1/v1/chat/completions'), model: 'fixture' })).toEqual(['off', 'low', 'medium', 'high']))
})
```

占位 `<...>` 由实现者用 `getAllBuiltinModels('deepseek')` / `getAllBuiltinModels('google')` 在 1.4.0 目录中挑一个真实 ID 填入（Gemini 3 的条目须在目录里把 `off` 标为 `null`）。

- [ ] **Step 3: 运行，确认失败**

Run: `corepack pnpm@11.7.0 exec vitest run packages/provider-chat/src/pi-model.test.ts`
Expected: FAIL，`pi-model.ts` 不存在。

- [ ] **Step 4: 实现 `pi-model.ts`**

- `piBaseUrl`：openai 去掉末尾 `/chat/completions`；anthropic 去掉末尾 `/v1/messages`（不以它结尾则抛 `Anthropic 接口须以 /v1/messages 结尾。`）；google 去掉 `/models/[^/]+:generateContent`。结果去掉末尾 `/`。
- `piModel`：按设计 4.2 两层继承。目录来源用 `getBuiltinProviders()` + `getAllBuiltinModels(p)` 过滤 chat 模型；同 ID 多条时优先 API 一致，其次目录顺序第一个。能力层：`reasoning`、`thinkingLevelMap` 中为 `null` 的键、`contextWindow`、`maxTokens`、`input`；线格式层（API 一致且主机相同）：`compat` 与 `thinkingLevelMap` 原值。未命中：`reasoning: true`、`contextWindow: 1_000_000`、`maxTokens: 128_000`、`input: ['text']`、`cost` 全 0。`provider` 字段填连接主机名。
- `supportedThinkingLevels`：`reasoning === false` → `['off']`；否则从四档中去掉 `thinkingLevelMap` 里为 `null` 的。
- `usesDeepSeekThinking`：`model.compat?.thinkingFormat === 'deepseek'`。
- 在 `index.ts` 导出四个函数和 `ModelTarget` 类型。

- [ ] **Step 5: 运行，确认通过**

Run: `corepack pnpm@11.7.0 exec vitest run packages/provider-chat/src/pi-model.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/provider-chat/package.json pnpm-lock.yaml packages/provider-chat/src/pi-model.ts packages/provider-chat/src/pi-model.test.ts packages/provider-chat/src/index.ts
git commit -m "feat(provider-chat): build pi-ai model declarations from the catalog"
```

---

### Task 2: 测试用模拟供应商

**Files:**
- Create: `tests/support/fake-provider.ts`
- Create: `tests/support/fake-provider.test.ts`

**Interfaces:**
- Produces：
  - `export interface FakeProviderCall { readonly path: string; readonly headers: Record<string, string>; readonly body: Record<string, unknown>; readonly userText: string }`（`userText` = 最后一条 user 消息的纯文本，兼容字符串与 parts 数组，以及 Anthropic / Google 的形状）
  - `export type FakeAnswer = { readonly tool?: unknown; readonly text?: string; readonly stop?: 'length'; readonly status?: number; readonly plainJson?: boolean }`
  - `export async function startFakeProvider(protocol: ProviderProtocol, answer: (call: FakeProviderCall) => FakeAnswer | Promise<FakeAnswer>): Promise<{ endpoint: string; calls: FakeProviderCall[]; close(): Promise<void> }>`
    - `endpoint` 为完整请求地址：openai `http://127.0.0.1:P/v1/chat/completions`，anthropic `http://127.0.0.1:P/v1/messages`，google `http://127.0.0.1:P/v1beta/models/fixture:generateContent`。
    - 按协议输出 SSE：openai `chat.completion.chunk` + `[DONE]`；anthropic `message_start / content_block_* / message_delta / message_stop`；google `streamGenerateContent?alt=sse` 的 `data:` 行。`tool` 输出为名为 `submit_actions` 的一次工具调用，`text` 输出为文本；`stop: 'length'` 写对应协议的截断原因；`status` 非 200 时回该状态和一段文本；`plainJson: true` 时返回非 SSE 的普通 JSON（用于 Review Focus 1）。
  - `export function fakeModels(endpoint: string, protocol?: ProviderProtocol): RuntimeRoleModels`（Task 4 定义的类型；默认 `openai`，model `fixture`，无 Key，decision 与 memory 同一目标，`characters: {}`）

- [ ] **Step 1: 写失败测试 `fake-provider.test.ts`**：对三协议各启动一次，直接用 pi-ai lazy 入口 + `piModel` 发一条带工具的请求，断言 `stopReason === 'toolUse'`、工具参数等于 `answer().tool`、`calls[0].userText` 等于发送的 user 文本。

- [ ] **Step 2: 运行确认失败**：`corepack pnpm@11.7.0 exec vitest run tests/support/fake-provider.test.ts`，FAIL（模块不存在）。

- [ ] **Step 3: 实现 `fake-provider.ts`**（`node:http`，监听 `127.0.0.1:0`）。`fakeModels` 暂时依赖 Task 4 的类型：本任务先在文件内声明同形状的本地类型，Task 4 完成后改为导入。

- [ ] **Step 4: 运行确认通过**：同上命令，PASS。

- [ ] **Step 5: 提交**

```bash
git add tests/support/fake-provider.ts tests/support/fake-provider.test.ts
git commit -m "test: add a streaming fake provider for the three protocols"
```

---

### Task 3: `createChatProvider` 改用 pi-ai

**Files:**
- Modify: `packages/provider-chat/src/provider.ts`（重写发送部分）
- Modify: `packages/provider-chat/src/protocol.ts`（只保留 `ProviderProtocol`、`providerProtocol`、`providerHeaders`；删除 `providerEndpoint`、`nativeMessages`、`nativePayload`）
- Modify: `packages/provider-chat/src/thinking.ts`（只保留 `ThinkingLevel`、`thinkingLevel`；删除 `thinkingRequest`）
- Modify: `packages/provider-chat/src/index.ts`
- Modify: `packages/provider-chat/src/provider.test.ts`、`native.test.ts`、`thinking.test.ts`（改为基于 `startFakeProvider` 断言服务器收到的 JSON）
- Modify: `desktop/launcher-core.ts:660-704`（`test-model` 改用 `testTextCall`）
- Modify: `tests/desktop/model-presets.test.ts:92` 及 `tests/experiments/*.ts` 中的 `createChatProvider` 调用（去掉 `style`，补 `protocol`）

**Interfaces:**
- Consumes：Task 1 的 `piModel`、`usesDeepSeekThinking`；Task 2 的 `startFakeProvider`。
- Produces：
  - `ChatProviderOptions` 变为：`{ protocol: ProviderProtocol; endpoint: URL; model: string; apiKey?: string; timeoutMs?: number; preset?: RolePreset; temperature?: number; maxOutputTokens?: number; toolName?: string; thinkingLevel?: ThinkingLevel; fetch?: typeof globalThis.fetch; inspector?: RequestInspector; presetOrigin?: PresetOrigin; onCall?: (o: ChatCallObservation) => void }`（删除 `style`、`thinking`；`protocol` 改为必填；`fetch` 对 google 不传）
  - `ChatStyle` 类型删除。
  - `export async function testTextCall(target: ModelTarget, apiKey: string | undefined, signal: AbortSignal): Promise<string>`（发"请只回复 OK。这是连接测试，不包含游戏内容。"，`maxTokens: 128`，返回非思考文本；空文本抛 `模型接口未返回有效文本。`）

- [ ] **Step 1: 改写测试**（每条断言针对模拟服务器收到的 `body`）：
  - `forces the decision tool on openai`：`body.tool_choice` 等于 `{type:'function', function:{name:'submit_actions'}}`，`body.tools[0].function.parameters` 等于 `call.schema`，`body.max_tokens === 512`（以服务器实际字段名为准；若 pi-ai 发 `max_completion_tokens` 则断言它），`headers.authorization === 'Bearer secret-value'`，`JSON.stringify(body)` 不含 `secret-value`。
  - `keyless connection sends no auth header`：openai、anthropic、google 三协议无 `apiKey` 时 `headers` 不含 `authorization` / `x-api-key` / `x-goog-api-key`，调用成功（Review Focus 5）。
  - `unset thinking sends no thinking fields`：三协议 body 不含 `thinking`、`reasoning_effort`、`enable_thinking`、`generationConfig.thinkingConfig`。
  - `deepseek-format decision with unset thinking disables it`：模拟服务器无法冒充 `api.deepseek.com` 主机，因此直接单测 Step 3 的 `thinkingPayload`：传入 `usesDeepSeekThinking` 为真的模型（Task 1 测试里同一个目录 ID + `https://api.deepseek.com/chat/completions`）、`level` 未设、`kind: 'character'`，断言结果含 `thinking:{type:'disabled'}`；`kind: 'intent'` 时不含。
  - `explicit off sends the protocol's disable`：anthropic body `thinking.type === 'disabled'`。
  - `low raises max tokens to 8192`：openai body 输出上限字段 ≥ 8192。
  - `anthropic keeps auto tool choice; google keeps ANY with the tool name`：anthropic `body.tool_choice.type === 'auto'`；google `body.toolConfig.functionCallingConfig` 等于 `{mode:'ANY', allowedFunctionNames:['submit_actions']}`。
  - `preset sampling`：openai body 含 `top_p / frequency_penalty / presence_penalty / stop`；anthropic 含 `top_p`、`stop_sequences`，设 penalty 抛 `Anthropic 不支持 frequencyPenalty / presencePenalty`；google `generationConfig` 含 `topP / stopSequences`。anthropic 开启思考时 body 无 `temperature`、`top_p`。
  - `prose answer is returned as the model stated it`；`multiple tools / wrong tool name / empty answer fail`；`length stop fails with 模型输出超过 token 上限。`（三协议，Review Focus 2）；`non-SSE answer fails with a message containing 流式`（Review Focus 1）；`HTTP 401 fails with ChatTransportError, observation.httpStatus === 401 and the endpoint's text in the message`（openai、anthropic；google 断言 `status: 'failed'`）；`aborted signal → inspector failure 'cancelled'`。
  - `inspector records the final payload and the pre-conversion messages`：`snapshot().requests[0].body` 含 `tools`，`messages.length === call.messages.length` 且来源标签对应（Review Focus 3）；`usage.inputTokens` 有值。
  - `testTextCall returns the text`：三协议。

- [ ] **Step 2: 运行确认失败**：`corepack pnpm@11.7.0 exec vitest run packages/provider-chat`，FAIL。

- [ ] **Step 3: 实现**
  - 协议入口表：`{ openai: openAICompletionsApi, anthropic: anthropicMessagesApi, google: googleGenerativeAIApi }`（lazy 工厂，模块级缓存）。
  - `ChatCall.messages` → pi-ai `Context`：system / developer 汇集为 `systemPrompt`（`\n\n` 连接，按原顺序）；user / assistant 保序；原生协议仍要求以 user 结尾，否则抛现有文案 `原生协议请求须以 user 消息结束；请调整末尾 assistant 预设节点。`（openai 不要求）。决策 Schema 作为唯一 `Tool { name: toolName, description, parameters: schema }`。经 `normalizeContext` 后交给 `api.streamSimple(model, context, options)`，`await stream.result()`。
  - 选项：`apiKey`（无 Key 时传 `headers` 抑制默认认证头，具体写法以通过"无认证头"测试为准）、`signal`（`AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`）、`timeoutMs`、`maxRetries: 0`、`maxTokens`、`temperature`（预设 > 选项 > `0.3`；anthropic 未设则不传）、`reasoning`（仅 `low/medium/high`）、`samplingParams`（仅 openai）、`fetch`（google 不传）、`onPayload`。
  - `export function thinkingPayload(model: Model<Api>, protocol: ProviderProtocol, payload: Record<string, unknown>, level: ThinkingLevel | undefined, kind: 'character' | 'intent'): Record<string, unknown>`：未设时剥除 pi-ai 写入的思考字段（openai：`thinking`、`reasoning_effort`、`enable_thinking`、`chat_template_kwargs`；anthropic：`thinking`；google：`config.thinkingConfig`），例外为 openai + `usesDeepSeekThinking` + `kind === 'character'` → `thinking:{type:'disabled'}`。
  - `onPayload` 依次：`thinkingPayload` → 强制工具（openai：`tool_choice` 指定函数；若 `level` 为 low/medium/high 且 `usesDeepSeekThinking` 则 `'auto'`；anthropic：`tool_choice:{type:'auto', disable_parallel_tool_use:true}` 并在 system 末尾追加 `请使用 submit_actions 工具返回本次决策；不要执行其他工具。`；google：`toolConfig.functionCallingConfig = {mode:'ANY', allowedFunctionNames:[toolName]}`）→ 原生采样参数写入 → 开启思考的 anthropic 删除 `temperature / top_p` → `inspector.begin(payload, inspection, messages, model)`。
  - 结果：`stopReason === 'length'` → `ChatTransportError('模型输出超过 token 上限。')`；`'aborted'` / `'error'` → 抛 `ChatTransportError`（消息带 `errorMessage`，HTTP 错误带状态码与端点文本前 512 字符）；工具调用恰好一次且名字匹配 → 返回其 `arguments`；有工具调用但不满足 → `模型须返回一次指定工具调用。`；否则非 thinking 文本：空 → `模型接口未返回有效文本。`，可 JSON 解析则返回对象，否则返回原文。
  - HTTP 状态：openai / anthropic 用包装后的 `fetch` 记录响应状态；google 从 `errorMessage` 中解析状态码，解析不到则不填。非 SSE 响应（content-type 不是 `text/event-stream`）在包装 fetch 中改写为 `ChatTransportError('模型接口未返回流式响应（SSE）；请确认接口支持 stream。')`；google 依赖其报错文本，测试只要求 openai / anthropic。
  - 检查器 `finish` 的 response 传组装后的 `AssistantMessage` 去掉 thinking 块；把 `usage.input / output` 映射为检查器可读的 `{ input_tokens, output_tokens }`。
  - `ChatCallObservation` 语义不变。
  - `launcher-core.ts` 的 `test-model`：改为调用 `testTextCall`，保留现有 401/403/429 文案（从 `ChatTransportError` 的状态码判断）。
  - 删除 `protocol.ts` 与 `thinking.ts` 中被替代的函数及其导出；`listModels` 继续用 `providerHeaders`。

- [ ] **Step 4: 运行确认通过**：`corepack pnpm@11.7.0 exec vitest run packages/provider-chat tests/support/fake-provider.test.ts`，PASS；`corepack pnpm@11.7.0 typecheck` 此时允许 desktop/host 与测试报错（Task 4/5 修复），但 `packages/provider-chat` 内无错。

- [ ] **Step 5: 提交**

```bash
git add packages/provider-chat desktop/launcher-core.ts tests/desktop/model-presets.test.ts tests/experiments
git commit -m "feat(provider-chat): send character decisions through pi-ai"
```

---

### Task 4: 模型配置单一路径与思考档位校验

**Files:**
- Modify: `desktop/model-connections.ts`
- Modify: `desktop/launcher-core.ts`（`start` 校验、新操作 `thinking-levels`）
- Modify: `tests/desktop/model-connections.test.ts`、`tests/desktop/launcher-core.test.ts`
- Modify: `tests/support/fake-provider.ts`（`fakeModels` 改为导入 `RuntimeRoleModels`）

**Interfaces:**
- Consumes：Task 1 的 `supportedThinkingLevels`。
- Produces：
  - `export interface RuntimeModel { readonly protocol: ProviderProtocol; readonly endpoint: string; readonly model: string; readonly thinkingLevel?: ThinkingLevel; readonly apiKey?: string }`（不变）
  - `export interface RuntimeRole { readonly decision: RuntimeModel; readonly memory: RuntimeModel }`
  - `export interface RuntimeRoleModels { readonly default: RuntimeRole; readonly characters: Readonly<Record<string, RuntimeRole>> }`（取代原 `memory?` 顶层字段）
  - `modelEnvironment(models, connections, apiKeys): { PERSPECTRA_ROLE_MODELS: string; PERSPECTRA_MODEL_KEYS: string }`
  - `runtimeRoleModels(roles: unknown, apiKeys: unknown): RuntimeRoleModels`（读出 `default.decision`）
  - `export function environmentRoleModels(env: Readonly<Record<string, string | undefined>>): RuntimeRoleModels`（读 `PERSPECTRA_MODEL_*`，缺失时抛 Global Constraints 中的文案；decision 与 memory 同一目标；思考强度只给 decision）
  - `instanceModels(...)` 校验思考档位：不在 `supportedThinkingLevels` 内则抛 `所选模型不支持该思考强度，请在模型配置中重新选择。`
  - Launcher 操作 `{ operation: 'thinking-levels', connectionId: string, model: string } → { levels: ThinkingLevel[] }`

- [ ] **Step 1: 写失败测试**
  - `model-connections.test.ts`：`modelEnvironment` 返回的键恰为 `['PERSPECTRA_ROLE_MODELS', 'PERSPECTRA_MODEL_KEYS']`；`runtimeRoleModels(JSON.parse(env.PERSPECTRA_ROLE_MODELS), JSON.parse(env.PERSPECTRA_MODEL_KEYS)).default.decision` 等于默认决策目标（含 Key 与思考强度）；未被引用的连接 Key 不在 `PERSPECTRA_MODEL_KEYS`；`environmentRoleModels({})` 抛 `未配置模型`；`environmentRoleModels({ PERSPECTRA_MODEL_ENDPOINT: 'http://127.0.0.1:1/v1/chat/completions', PERSPECTRA_MODEL: 'fixture' }).default.decision.protocol === 'openai'`；Gemini 3 目录 ID + `thinkingLevel: 'off'` 时 `instanceModels` 抛 `不支持该思考强度`（openai 与 google 连接各一）。
  - `launcher-core.test.ts`：已保存实例的 `models` 里 Gemini 3 + `off`，`snapshot` 正常、`start` 抛 `不支持该思考强度`（Review Focus 4）；`thinking-levels` 对未知模型返回四档、对 Gemini 3 不含 `off`。

- [ ] **Step 2: 运行确认失败**：`corepack pnpm@11.7.0 exec vitest run tests/desktop/model-connections.test.ts tests/desktop/launcher-core.test.ts`，FAIL。

- [ ] **Step 3: 实现**：按 Interfaces 修改；`start` 在 `modelEnvironment` 前调用 `instanceModels(instance.models, this.#index.connections, characterIds)`；`launcher-core` 启动子进程时删除 `HCW_THINKING_LEVEL: undefined`，改为把 `HCW_LOCAL_MODEL / ENDPOINT / API_KEY / HCW_MODEL_PROTOCOL / HCW_THINKING_LEVEL` 均置 `undefined`（防止 Launcher 自身环境泄入）。`resolveRoleModels` 不变。

- [ ] **Step 4: 运行确认通过**：同上命令，PASS。

- [ ] **Step 5: 提交**

```bash
git add desktop/model-connections.ts desktop/launcher-core.ts tests/desktop tests/support/fake-provider.ts
git commit -m "feat(launcher): pass resolved model targets through one path"
```

---

### Task 5: Host 只接收解析后的目标

**Files:**
- Delete: `desktop/provider-defaults.ts`
- Modify: `desktop/host/launch-arguments.ts`（删除 `provider`、`--deepseek`、`--ollama`，以及"非 local 须 --memory-native"的检查）
- Modify: `desktop/host/web-entry.ts:31-61,115-185,272`
- Modify: `desktop/host/role-providers.ts`
- Modify: `desktop/host/world-runtime.ts:421-530,642,951-954`
- Modify: `desktop/host/tail-runtime.ts:198-216`
- Modify: `tests/host/launch-arguments.test.ts`、`tests/host/native-provider-runtime.test.ts`、`tests/host/world-runtime.test.ts`、`tests/host/core-memory.test.ts`、`tests/desktop/desktop-launch.test.ts`、`tests/host/capability-plugin-entry.test.ts`、`tests/support/tail-crash-worker.ts`、`tests/support/storyline-crash-worker.ts`

**Interfaces:**
- Consumes：Task 3 的 `ChatProviderOptions`；Task 4 的 `RuntimeRoleModels`、`runtimeRoleModels`、`environmentRoleModels`；Task 2 的 `fakeModels`、`startFakeProvider`。
- Produces：
  - `ModelOptions` 变为 `{ readonly models: RuntimeRoleModels; readonly preset?: RolePreset; readonly presetBaseSource?: PresetBaseSource; readonly presetMapping?: RolePresetMapping; readonly timeoutMs?: number; readonly playSettings?: PlaySettings }`
  - `RoleProviders` 字段不变；其中 `intentModel` 固定等于默认决策模型（意图理解已停用，不新增配置），`protocol` / `endpoint` 取默认决策目标。
  - `HostLaunchArguments` 删除 `provider`。

- [ ] **Step 1: 改测试**
  - `launch-arguments.test.ts`：`--deepseek` / `--ollama` 报 `unsupported host argument`；不再要求 `--memory-native` 搭配。
  - `native-provider-runtime.test.ts`：循环扩展为 `['openai', 'anthropic', 'google']`，服务器改用 `startFakeProvider`，选项为 `{ models: fakeModels(endpoint, protocol) }`；其余断言（3 次调用、钥匙放回、两次 `entity.transferred`、最终无人持有）不变。
  - `world-runtime.test.ts`：按角色模型用例改用 `models.characters`；新增"openai 协议使用压平 Schema（`gatewayTurnCall`），google 不使用"；新增"无游玩设置时超时为 60_000"。
  - `core-memory.test.ts`：默认记忆目标来自 `models.default.memory`。
  - `desktop-launch.test.ts`：Launcher 启动子进程的环境不含 `HCW_LOCAL_*`。

- [ ] **Step 2: 运行确认失败**：`corepack pnpm@11.7.0 exec vitest run tests/host/launch-arguments.test.ts tests/host/native-provider-runtime.test.ts tests/host/world-runtime.test.ts tests/host/core-memory.test.ts tests/desktop/desktop-launch.test.ts`，FAIL。

- [ ] **Step 3: 实现**
  - `web-entry.ts`：`models = process.env.PERSPECTRA_ROLE_MODELS ? runtimeRoleModels(...) : environmentRoleModels(process.env)`；读取后 `delete process.env.PERSPECTRA_MODEL_KEYS` 与 `PERSPECTRA_MODEL_API_KEY`；启动日志改为 `模型：${protocol} ${model} @ ${endpoint 主机}`，不打印 Key。
  - `role-providers.ts`：默认 provider 与每个角色 provider 都由 `RuntimeModel` 构造 `createChatProvider({ protocol, endpoint: new URL(endpoint), model, thinkingLevel, apiKey, ... })`；未在 `characters` 中的角色用 `models.default.decision`；校验 `characters` 的 ID 属于本包（保留现有文案）；超时按 Global Constraints。
  - `world-runtime.ts`：删除 `#provider` 与 `provider !== 'local'` 检查；Core 记忆默认目标为 `options.models.default.memory`，按角色为 `options.models.characters[id].memory`；压平 Schema 判断改为 `this.#models.protocols.get(characterId) !== 'google'`；状态快照里的 `provider` 字段改为默认决策目标的 `protocol`。
  - `tail-runtime.ts`：记录项去掉 `provider / utilityEndpoint`，改记默认决策目标的 `protocol / model / endpoint`（无 Key）。

- [ ] **Step 4: 运行确认通过**：同上命令，PASS。

- [ ] **Step 5: 提交**

```bash
git add desktop tests/host tests/desktop tests/support
git commit -m "refactor(host): take resolved model targets instead of provider entry names"
```

---

### Task 6: 迁移其余测试的模拟服务器

**Files:**
- Modify: 所有仍用 `provider: 'ollama' | 'local' | 'deepseek'` 或 `utilityEndpoint` 的测试，清单由 `grep -rln "provider: '\(ollama\|local\|deepseek\)'\|utilityEndpoint" tests` 给出（约 40 个，包括 `tests/scenarios/*`、`tests/host/pack-*`、`jev-*`、`status-market-items`、`model-presets`）。

**Interfaces:**
- Consumes：Task 2 的 `startFakeProvider`、`fakeModels`；Task 5 的 `ModelOptions`。

- [ ] **Step 1: 逐文件替换**：内联的 `createServer` 模型模拟改为 `startFakeProvider('openai', call => ({ tool: decide(JSON.parse(call.userText)) }))`；`provider / model / utilityEndpoint / apiKey` 改为 `models: fakeModels(server.endpoint)`；读请求 `body.format` 的断言改为读 `body.tools[0].function.parameters`（压平后的 Schema，断言内容按实际改写）。不改任何场景的世界断言。

- [ ] **Step 2: 运行全部包内测试**：`corepack pnpm@11.7.0 test`，Expected: PASS。失败时只允许修改模拟层与 Schema 形状断言；世界结果断言失败视为回归，停下来报告。

- [ ] **Step 3: 提交**

```bash
git add tests
git commit -m "test: drive scenarios through the streaming fake provider"
```

---

### Task 7: Launcher 思考档位按声明过滤

**Files:**
- Modify: `apps/launcher/src/model-choices.ts`（删除 `geminiRequired`）
- Modify: `apps/launcher/src/components/ThinkingOptions.vue`、`apps/launcher/src/components/ModelConfigDialog.vue`
- Modify: `apps/launcher/src/services/desktop.ts`（加 `thinkingLevels`）
- Modify: `apps/launcher/src/mock.ts`（浏览器预览的模拟实现）
- Modify: `apps/launcher/src/model-choices.test.ts`

**Interfaces:**
- Consumes：Task 4 的 `thinking-levels` 操作。
- Produces：`export async function thinkingLevels(connectionId: string, model: string): Promise<ThinkingLevel[]>`；`ThinkingOptions` 新 prop `levels: readonly ThinkingLevel[]`（替代 `model`），不在其中的按钮 `disabled`。

- [ ] **Step 1: 写失败测试**（`model-choices.test.ts`）：草稿默认思考强度取 `levels[0]`（Gemini 3 为 `low`，未知模型为 `off`），当前值不在 `levels` 内时被改为 `levels[0]`。把这一逻辑放进纯函数 `export function fitThinkingLevel(value: ThinkingLevel, levels: readonly ThinkingLevel[]): ThinkingLevel`。

- [ ] **Step 2: 运行确认失败**：`corepack pnpm@11.7.0 launcher:check`，FAIL。

- [ ] **Step 3: 实现**：模型选择变化时调用 `thinkingLevels` 并用 `fitThinkingLevel` 修正草稿；请求失败时按四档全开处理，不阻塞对话框。

- [ ] **Step 4: 运行确认通过**：`corepack pnpm@11.7.0 launcher:check`，PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/launcher/src
git commit -m "feat(launcher): offer only the thinking levels the model declares"
```

---

### Task 8: 文档、脚本与发行体积

**Files:**
- Modify: `docs/current/model-protocols.md`（重写"配置"与"源码网页入口"段落，删除 `local` 说明，写入 pi-ai、目录声明、未设思考强度规则、流式要求与已接受限制）
- Modify: `docs/current/architecture/runtime.md`、`docs/current/guides/local-runbook.md`、`docs/current/guides/creator-playtest.md`（`--deepseek` / `--ollama` / `HCW_LOCAL_*` 改为 `PERSPECTRA_MODEL_*`）
- Modify: `docs/current/architecture/modules.md`（`provider-chat` 职责改为"经 pi-ai 的角色决策适配"）
- Modify: `tests/experiments/stage-expression-playtest.ts`、`combined-turn-playtest.ts`、`prototype-g3-run.ts` 及 Task 3 已触及的实验脚本中的入口参数
- Modify: `experiments/jev-narrative-auditor/README` 或同目录说明文件：加一行"这些脚本依赖已删除的 `--deepseek` 入口，不能直接运行"

- [ ] **Step 1: 更新上述文档与脚本。**
- [ ] **Step 2: 链接检查**：`node scripts/docs/check-links.mjs`，Expected: 无错误。
- [ ] **Step 3: 发行体积**：在改动前的提交（`git stash` 或另一工作树）与当前各运行一次 `corepack pnpm@11.7.0 desktop:build`，记录 `dist/backend/playtest.mjs` 大小；确认产物中不含 `@aws-sdk/client-bedrock-runtime`（`grep -c "BedrockRuntime" dist/backend/playtest.mjs` 为 0，否则调整导入直到为 0）。把两次大小写入 `docs/current/model-protocols.md` 的验证段落。
- [ ] **Step 4: 全量检查**：`corepack pnpm@11.7.0 check`，Expected: PASS。
- [ ] **Step 5: 提交**

```bash
git add docs tests/experiments experiments
git commit -m "docs: describe the unified provider adapter"
```

---

### Task 9: 真实模型试玩验收（手动，不可省略）

**Files:**
- Create: `docs/current/studies/unified-provider-playtest-20261027.md`（日期按实际）

- [ ] **Step 1: 基线**：在改动前的提交上用 Launcher 启动一局（新数据目录），8045 网关：一个角色用 Claude（anthropic 协议），其余用 Gemini（openai 协议），跑 8 轮固定玩家输入，导出请求检查器记录与对话。
- [ ] **Step 2: 新实现**：同一包、同一输入、新数据目录再跑 8 轮。
- [ ] **Step 3: 对比并记录**：每个角色的发言/行动轮数、格式失败与 abstain 次数、记忆整理是否完成、检查器请求体是否可读、有无流式相关失败。
- [ ] **Step 4: DeepSeek 官方**：`https://api.deepseek.com/chat/completions`，思考强度未设与 `low` 各跑 3 轮短场景。
- [ ] **Step 5: Ollama**：本机可用则跑 3 轮并记录工具调用是否稳定；不可用则在记录中写明未验证。
- [ ] **Step 6: 检查 Key**：在两次新数据目录中搜索所用 Key 的前 8 个字符，Expected: 无命中。
- [ ] **Step 7: 提交记录**

```bash
git add docs/current/studies
git commit -m "docs: record the unified provider playtest"
```

若 Step 3 显示角色表现明显退化，停止并向用户报告，不合并。
