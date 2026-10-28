# 统一模型 Provider 适配器设计

日期：2026-10-27。状态：已定稿（用户 2026-10-27 确认）。

## 1. 为什么做

现在一次模型调用最终发到哪里、按什么格式发，要同时读两套配置才能弄清楚：

- Launcher 的"模型连接"（[model-connections.ts](../../../desktop/model-connections.ts)）：连接 = 名称 + 协议 + 完整地址，Key 在 Windows 凭据管理器；实例可按角色选决策/记忆模型。
- 游戏进程的旧入口（[launch-arguments.ts](../../../desktop/host/launch-arguments.ts)、[web-entry.ts](../../../desktop/host/web-entry.ts)）：`provider: 'local' | 'deepseek' | 'ollama'`，各读一组环境变量，默认模型写死在 [provider-defaults.ts](../../../desktop/provider-defaults.ts)。`local` 其实是"通用接口入口"，不是本机。

由此带来的具体困惑：

- 很多行为挂在入口名上而不是协议上：只有 `local` 能用 Core 记忆、按角色模型、原生协议、压平决策 Schema；默认超时按 `ollama` 特判；只有 `ollama` 用 `format` 结构化输出。
- 默认决策目标传了两遍：`HCW_LOCAL_*` 环境变量一份，`PERSPECTRA_ROLE_MODELS.default.decision` 一份（游戏进程实际丢弃后者）。
- 用模型名猜行为：`model.includes('deepseek')` 决定思考参数和 `tool_choice`，正则 `gemini-3+` 决定能否关思考。网关上的模型别名会猜错。
- [provider-chat](../../../packages/provider-chat/src/provider.ts) 自己维护三种协议的请求构造和响应提取。

DeepSeek Harness（`deepseek-ai/deepseek-harness` 的 `dsh-llm-pi-ai`）采用了 Pi（`@earendil-works/pi-ai`）的做法：调用目标是显式的 provider + model；provider 声明协议、地址、凭据；模型能力（思考档位、输出上限）与兼容差异（思考参数格式、max tokens 字段）由声明决定，不靠猜。本设计把 Perspectra 的 Node 侧模型调用规范到同样的结构上，并直接使用 pi-ai。

**目标是可读性和一致性**：任何人看代码或配置，能直接回答"这个角色这一轮调用发去哪个地址、哪个模型、什么协议、带什么思考参数"。

## 2. 目标、非目标、反目标

目标：

1. Node 侧角色决策调用经由 pi-ai 发出；删除 provider-chat 里自写的协议转换和按模型名的判断。
2. 只有一种调用目标：连接（provider）+ 模型 + 可选思考强度。`local` / `--deepseek` / `--ollama` 三个入口取消。
3. 游戏进程只从一条路径接收模型配置；去掉 `HCW_LOCAL_*` 与 `PERSPECTRA_ROLE_MODELS` 的重复传递。
4. 原先挂在入口名上的行为改为由协议或模型声明决定。
5. 模型能力声明由 pi-ai 内置目录（上游）提供，用户不手填。

非目标：

- 不改 Python Core 记忆的请求实现（用户决定）。它继续自己发请求，只是读同一份解析后的目标。
- 不做给玩家看的流式输出；拿到完整结果即可。
- 不接 OAuth、Bedrock、Vertex、Azure 等需要额外认证形态的服务。
- 不改角色输出协议、决策 Schema 的语义、Rulebook / Event 提交路径、权限与认知隔离边界。
- 不新增用户可编辑的"模型声明 / 兼容开关"表单。

反目标（技术上能跑但算失败）：

- 角色表现退化（发言变少、格式失败率上升、更多 abstain），即便测试全过。
- 新旧两套配置继续并存，或留下"兼容旧入口"的分支，让读代码的人仍要理解两套。
- Key 出现在数据目录、日志、请求检查器或传给不该拿到它的进程。
- 为了套用 pi-ai 而把它的完整模型 / compat schema 暴露成 Perspectra 配置。

## 3. 用户已决定的部分

- 使用 pi-ai（`@earendil-works/pi-ai`，MIT，当前 1.4.0），前提是适配；调研结论见第 6 节。
- Python 记忆整理继续自己发请求。
- 模型能力声明"让上游带过来"：来自 pi-ai 内置目录，不让用户手填。

## 4. 设计

### 4.1 连接（存储形态不变）

Launcher 已存的连接 `{ id, name, protocol, endpoint }` 与按连接存在凭据管理器的 Key **保持原样，不迁移**。理由：Python 记忆需要完整请求地址；列模型、测试连接现有逻辑都基于它；声明从目录在运行时查得，不需要落盘。

协议名到 pi-ai API 的固定映射：

| Perspectra `protocol` | pi-ai `api` |
| --- | --- |
| `openai` | `openai-completions` |
| `anthropic` | `anthropic-messages` |
| `google` | `google-generative-ai` |

pi-ai 的 `baseUrl` 由完整地址推导（SDK 风格的基础地址，会由 SDK 自己补操作路径）：OpenAI 去掉末尾 `/chat/completions`；Anthropic 去掉末尾 `/v1/messages`（例如 `https://api.deepseek.com/anthropic/v1/messages` → `https://api.deepseek.com/anthropic`）；Google 去掉 `/models/模型:generateContent`。推导规则需要用每种协议的真实 SDK 行为验证（见 4.7），不能只凭字符串约定。

### 4.2 模型声明：从 pi-ai 目录查

调用时为每个目标构造一个 pi-ai `Model`：

1. 按模型 ID 在 pi-ai 内置目录中查找，**不要求 API 一致**（最常用的形态是 8045 网关用 openai 协议接 Gemini / Claude，目录里这些条目是 google / anthropic API）。【我的决定】分两层继承：
   - 能力层，只要 ID 匹配就继承：`reasoning`、各思考档位是否受支持（`thinkingLevelMap` 中为 `null` 的档位视为不支持）、`contextWindow`、`maxTokens`、`input`。这样网关上的 Gemini 3 仍然在保存时拒绝"关闭思考"，与现在的正则行为一致。
   - 线格式层，只有 API 一致、且目录 provider 的 baseUrl 主机与连接地址主机相同时才继承：`compat`、`thinkingLevelMap` 的具体映射值。否则不设 `compat`，由 pi-ai 按 baseUrl 自动探测。这样网关上的 Claude 不会套用官方主机的兼容声明。
   - 同一 ID 有多个目录条目时，优先 API 一致的，其次按 pi-ai 目录顺序取第一个。
2. 找不到（自定义网关上的私有 ID、别名）时用保守默认：`reasoning: true`、不设 `thinkingLevelMap`（各档按协议默认）、不设 `compat`（由 pi-ai 按 baseUrl 自动探测）、`input: ['text']`。【我的决定：自定义网关是用户最常用的形态，默认不限制思考档位，失败交给供应商报错并在请求检查器可见。】
3. 无论哪种，`baseUrl`、`api`、`id` 总以连接和所选模型为准，目录只提供能力与兼容声明。

Launcher 的思考强度选项按该声明过滤（等价于 DSH 的 `getSupportedThinkingLevels`）；保存实例模型配置时用同一函数校验，取代 [thinking.ts](../../../packages/provider-chat/src/thinking.ts) 中的 Gemini 正则。Perspectra 继续只暴露 `off / low / medium / high` 四档。

**思考档位换算交给 pi-ai**（用户"让上游带过来"的延伸）：档位到各协议字段的换算、Anthropic 的思考预算、DeepSeek 的 effort 映射、Gemini 3 / 旧 Gemini 的字段选择，一律用 pi-ai 的 `thinkingLevelMap` 与默认预算，删除 [thinking.ts](../../../packages/provider-chat/src/thinking.ts) 的自定义数值。开启思考时输出上限至少提到 8192 / 16384 / 32768 的现有规则保留（这是 Perspectra 对"思考吃掉输出预算导致决策被截断"的防护，不属于协议换算），作为传给 pi-ai 的 `maxTokens`。请求因此会变化，靠第 5 节真实试玩对比验收。

**已保存配置在新规则下不合法**（例如存过的思考档位现在声明为不支持）：【我的决定】沿用现有"连接被删除"的处理方式。加载时只做形状检查，Launcher 照常打开；启动游戏或保存时校验，失败则给出明确提示，要求在模型配置中重新选择。不静默丢弃，也不阻止打开 Launcher。

### 4.3 运行时目标：单一路径

- `modelEnvironment()` 只输出 `PERSPECTRA_ROLE_MODELS`（解析后的默认层与按角色目标，不含 Key）和 `PERSPECTRA_MODEL_KEYS`（仅被引用到的连接 Key）。删除 `HCW_LOCAL_MODEL / ENDPOINT / API_KEY / HCW_MODEL_PROTOCOL / HCW_THINKING_LEVEL` 这组输出。
- `runtimeRoleModels()` 读出完整的默认决策目标（现在被丢弃的 `default.decision`），游戏进程只从这里取默认目标。
- `ModelOptions.provider`、`utilityEndpoint`、`PROVIDER_DEFAULTS` 删除。`createRoleProviders` 只接收解析后的目标集合。
- 玩家意图理解已确定不再启用（用户 2026-10-27 确认），本次不为它做任何适配、配置或验证；`dispatch` 路径只需随共享实现继续编译通过，不单独处理。
- Python worker 仍按目标接收 `HCW_LOCAL_MODEL / ENDPOINT / PROTOCOL / API_KEY`（[python-worker.ts:207](../../../desktop/host/memory/python-worker.ts:207)），这是 Node → Python 的内部接口，本次不改名。

源码网页入口（开发者直接跑 `web-entry.ts`、实验脚本）：【我的决定】没有 `PERSPECTRA_ROLE_MODELS` 时，从一组新命名的环境变量拼出一个默认目标：`PERSPECTRA_MODEL_PROTOCOL`（默认 `openai`）、`PERSPECTRA_MODEL_ENDPOINT`、`PERSPECTRA_MODEL`、`PERSPECTRA_MODEL_API_KEY`、可选 `PERSPECTRA_THINKING_LEVEL`。地址或模型缺失时直接报错并列出这些变量名，不再静默回退到 `127.0.0.1:8045` / `gemini-3.7-flash`。`--deepseek`、`--ollama` 删除；DeepSeek 即 `openai` 协议 + `https://api.deepseek.com/chat/completions`；Ollama 即 `openai` 协议 + `http://127.0.0.1:11434/v1/chat/completions`。

### 4.4 provider-chat：内部改用 pi-ai

`createChatProvider` 对外接口（`decide` / `dispatch`、`ChatCallObservation`、`ChatTransportError`、请求检查器 begin/finish）保持不变，世界和 Host 不感知替换。内部：

- 把 `ChatCall.messages` 转成 pi-ai `Context`（system/developer → systemPrompt 或系统消息，按 pi-ai 规则放置；user/assistant 保序），决策 Schema 作为唯一 `Tool`。
- 调用 pi-ai 的非流式便捷入口（`completeSimple` 或等价），传 `signal`、`apiKey`、`timeoutMs`、`maxTokens`、`temperature`、`reasoning`；pi-ai 自身重试设为零，保持"不隐式重试"。
- 从返回的 `AssistantMessage` 取唯一的 `toolCall` 参数；没有工具调用时取非 thinking 文本并尝试 JSON 解析，与现在 `payloadOf` / `nativePayload` 语义一致（多工具、错工具名、空响应、截断 → 失败；散文原样交给世界校验）。
- **强制调用决策工具**：pi-ai 的 `toolChoice` 只有 `auto | none`。【我的决定】保留现有请求语义以免角色表现变化：OpenAI 兼容协议在 `onPayload` 中写入 `tool_choice: {type:'function', function:{name}}`；开启思考且模型声明的思考格式为 `deepseek` 时改为 `auto`（对应现有 `model.includes('deepseek')` 判断，但改由声明决定）；Anthropic 保持现有 `auto`；Google 保持现有 `ANY` + 限定函数名。
- **预设采样参数**：OpenAI 兼容协议用 `samplingParams` 传 `top_p / frequency_penalty / presence_penalty / stop`；Anthropic 的 `top_p / stop_sequences` 与 Google 的 `generationConfig.topP / stopSequences / penalty` 经 `onPayload` 写入。Anthropic 设置 penalty 继续明确拒绝。开启思考时 Anthropic 删除 temperature / top_p 的现有规则保留。
- **Ollama `format` 风格删除**：Ollama 走 OpenAI 兼容接口 + 工具调用。
- **未设思考强度时**：pi-ai 1.4.0 在不传 `reasoning` 时会主动写入"关闭思考"（Anthropic `thinking:{type:'disabled'}`、Google 关闭配置、`deepseek` 格式 `thinking disabled`）。【我的决定】"未设"等于"不发任何思考字段"，保持现状：在 `onPayload` 里剥掉 pi-ai 写入的关闭字段。理由：Gemini 3 不能关闭思考，按 pi-ai 默认行为发送会让未设档位的 Gemini 3 角色调用被拒；Anthropic / Google 现在未设时也什么都不发。唯一例外是现有行为本身：OpenAI 兼容协议、目录声明为 `deepseek` 思考格式的角色决策调用，现在会发 `thinking:{type:'disabled'}`，这一项保留。其他 OpenAI 兼容端点不再收到这个非标准字段。
- **请求检查器**：请求体取自 `onPayload` 收到的最终 payload（与实际发出一致）；响应改为记录 pi-ai 组装后的 `AssistantMessage`（含用量、停止原因，不含思考正文）。检查器不接收认证头的现有约束不变。

### 4.5 原先挂在入口名上的行为

| 行为 | 现在 | 之后 |
| --- | --- | --- |
| 压平决策 Schema（`gatewayTurnCall`） | `provider==='local'` 且非 google | 协议为 `openai` 或 `anthropic` |
| 默认超时 | Ollama 120s，其余 60s；有游玩设置时按设置 | 一律按游玩设置；无设置时 60s |
| 结构化输出方式 | Ollama 用 `format`，其余工具 | 一律工具 |
| Core 记忆可用性 | 仅 `local` | 任意目标 |
| 按角色模型、原生协议 | 仅 `local` | 任意目标 |

Launcher 实际只走 `local`，所以对玩家来说前四行行为不变。

### 4.6 Python 记忆

[core_bridge.py](../../../desktop/host/memory/python/bridge/core_bridge.py) 的 `utility_request` 继续按协议自己发请求，输入仍是每个目标的协议、完整地址、模型、Key。本次不改 Python 代码。已知限制：Python 侧不享受 pi-ai 的目录声明与兼容探测；记忆整理不传思考强度（与现状相同）。

### 4.7 依赖与发行

- 新增依赖 `@earendil-works/pi-ai`，锁定精确版本。它会带入 OpenAI、Anthropic、Google GenAI、AWS Bedrock SDK；协议实现按需加载，只导入 `openai-completions`、`anthropic-messages`、`google-generative-ai` 三个 lazy 入口和目录查询入口，不导入聚合入口。
- 便携发行包会变大，需要实测增量并在交付中写明；若某个 SDK（如 Bedrock）仍被打进包且可排除，由构建配置排除。
- pi-ai 升级可能改变目录声明或请求形状。锁版本，升级视为需要真实模型复验的变更。

## 5. 验证

自动化：

- 每种协议用本机 HTTP 模拟供应商（沿用 [native-provider-runtime.test.ts](../../../tests/host/native-provider-runtime.test.ts) 的方式，经 pi-ai 的 `fetch` 注入）验证：请求体关键字段（模型、工具、强制工具、采样参数、思考参数）、响应提取、多工具/错工具名/空响应/截断失败、取消、超时。
- baseUrl 推导：三种协议各至少一个真实形态地址（含 DeepSeek Anthropic 兼容地址、带路径前缀的代理）断言最终请求 URL。
- 目录查找：已知模型继承能力层声明；API 不一致或主机不同则不继承 compat；未知 ID 走保守默认；Gemini 3 在 openai 与 google 两种协议下，"关闭思考"都在保存时被拒；已保存的不合法档位在启动时给出明确提示。
- 未设思考强度：三种协议的请求体都不含思考字段（DeepSeek 格式的决策调用除外）。
- 模型配置单一路径：`modelEnvironment` 不再输出 `HCW_LOCAL_*`；Key 只出现在 `PERSPECTRA_MODEL_KEYS`，且游戏进程读取后从环境删除（现有行为）；数据目录与检查器记录中不出现测试 Key。
- 现有请求检查器、取钥匙 → 放回 → 续写的受控事实提交测试继续通过。
- `corepack pnpm@11.7.0 check`。

真实体验（必须，测试通过不能替代）：

- Launcher 启动一局，本机 8045 网关上 Claude（anthropic 协议）+ Gemini（openai 协议）按角色分配，跑若干轮，对比替换前后：角色是否正常发言/行动、格式失败与 abstain 比例、请求检查器内容是否可读、记忆整理是否照常。
- DeepSeek 官方 OpenAI 兼容地址开启与关闭思考各跑一次短场景。
- Ollama 若本机可用，验证小模型工具调用是否稳定；不可用则在交付中写明未验证。

## 6. 适配性调研结论（2026-10-27）

pi-ai 1.4.0 提供 `openai-completions` / `anthropic-messages` / `google-generative-ai`；`Model` 携带 `reasoning`、`thinkingLevelMap`、`compat`（含 `thinkingFormat`、`maxTokensField`、`supportsReasoningEffort` 等）；请求选项有 `signal`、`apiKey`、`timeoutMs`、`fetch`、`headers`、`onPayload`、`samplingParams`（仅 OpenAI 兼容）；`complete` / `completeSimple` 非流式入口；内置目录可按 provider 查模型。需要绕行的：`toolChoice` 仅 `auto | none`；Anthropic / Google 无通用 stop / topP 选项；默认流式，原始响应 JSON 不再整段可得。Node 要求 ≥22.19，与本仓库一致。DSH 的 `dsh-llm-pi-ai` 在生产中使用它，并以"每次请求只有一次可见供应商请求、重试在外层"的方式使用，与本项目"不隐式重试"一致。

## 7. 交给实现者决定的部分

- pi-ai 适配代码放在 `packages/provider-chat` 内还是拆出新文件，以及类型如何组织。
- 消息到 pi-ai `Context` 的具体转换细节（在满足"system 汇集、以 user 结尾的原生协议约束、来源标签保留"的前提下）。
- 列模型（`listModels`）继续用现有实现还是改用 pi-ai 的发现能力；默认保留现有实现。
- 历史实验脚本：`tests/experiments/` 下仍在用的脚本改为新环境变量；`experiments/jev-narrative-auditor/scripts/` 属历史实验，可不改，在文档中注明已不能直接运行。
- 文档同步：[model-protocols.md](../../current/model-protocols.md)、[runtime.md](../../current/architecture/runtime.md)、[local-runbook.md](../../current/guides/local-runbook.md)、[creator-playtest.md](../../current/guides/creator-playtest.md)、模块地图，按 AGENTS.md 第 9 节执行并运行 `node scripts/docs/check-links.mjs`。

## 8. 已接受的限制

- Python 记忆不经 pi-ai，协议实现仍有两份（Node 由 pi-ai，Python 自写）。
- 未知模型 ID 的能力声明是猜测性默认，可能允许供应商实际不支持的思考档位；失败可见、不静默。
- 依赖 pi-ai 的演进节奏；升级需复验。
- 请求检查器不再展示供应商原始响应 JSON。
