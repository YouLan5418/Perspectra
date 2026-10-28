# 模型接口协议

日期：2026-10-28。角色决策调用统一经由 [pi-ai](https://github.com/earendil-works/pi)（`@earendil-works/pi-ai` 1.4.0，锁定版本）发出，支持 OpenAI 兼容、Anthropic Messages 和 Google Gemini Developer API；按角色选择决策和记忆整理模型。旧的 `local` / `--deepseek` / `--ollama` 三个入口已删除，DeepSeek、Ollama 只是普通地址。设计与取舍见[统一 Provider 适配器设计](../superpowers/specs/2026-10-27-unified-provider-adapter-design.md)。自动测试已覆盖三种协议；真实模型试玩范围见文末验证。

## 配置

例如让普通角色使用 Flash、重要角色 Claude 使用更强模型：先添加两条连接，在实例“模型 → 修改”设置默认决策模型，再在“按角色单独设置”取消 Claude 的“跟随默认”，选择另一连接和模型。记忆整理默认跟随该角色的决策模型；取消对应勾选后可单独选择。保存并重新启动生效，游戏详情显示“另有 N 个角色单独配置”。模型选择不支持角色组；角色组仍只用于预设。

Launcher 设置窗口（右上角 ⚙）的“模型接口”管理多条模型连接，每条连接记住名称、协议和完整接口地址，可以“查看模型”列出该接口当前可用的模型；本局抽屉的“模型”页从这些连接里选模型，不再重填协议和地址。API Key 按连接存入 Windows 凭据管理器，重启 Launcher 后仍在；它不写入 `launcher.json`、实例配置或分享文件，只在列模型、测试连接和启动游戏时由桌面壳读取并随请求传给 Node 后端。“测试连接”与游戏走同一条 pi-ai 流式通道，所以也能发现接口不支持流式的问题。

列模型的地址由完整请求地址推导：OpenAI 兼容把末尾 `/chat/completions` 换成 `/models`；Anthropic 把 `/messages` 换成 `/models` 并跟随分页；Google 取 `/models/模型:generateContent` 前的 `/models` 并只保留支持 `generateContent` 的模型。网关不提供列表时会提示失败，仍可直接输入模型标识。

| 协议 | 完整请求地址示例 | pi-ai API | 认证 |
| --- | --- | --- | --- |
| OpenAI 兼容 | `https://服务地址/v1/chat/completions` | `openai-completions` | Bearer |
| Anthropic Messages | `https://api.anthropic.com/v1/messages` | `anthropic-messages` | x-api-key |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/models/模型标识:generateContent` | `google-generative-ai` | x-goog-api-key |

DeepSeek 官方填 `https://api.deepseek.com/chat/completions`（OpenAI 兼容）或 `https://api.deepseek.com/anthropic/v1/messages`（Anthropic）；Ollama 填 `http://127.0.0.1:11434/v1/chat/completions`。pi-ai 需要 SDK 式的基础地址，适配层按协议去掉末尾操作路径；Anthropic 须以 `/v1/messages` 结尾，保存连接时就拒绝其他路径，避免保存成功后才在调用时失败。Google 的实际 URL 模型段以模型标识字段为准；地址中不允许 API Key 查询参数。Google 只支持 Developer API 的 API Key 认证，没有接入 Vertex AI / OAuth；Google 协议的连接必须填写 Key。

源码网页入口不读取 Launcher 配置，由环境变量拼出一个默认目标：`PERSPECTRA_MODEL_ENDPOINT`（完整地址）、`PERSPECTRA_MODEL`、可选 `PERSPECTRA_MODEL_PROTOCOL=openai|anthropic|google`（默认 openai）、`PERSPECTRA_MODEL_API_KEY`、`PERSPECTRA_THINKING_LEVEL`。地址或模型缺失时直接报错，不再回退到内置默认地址。Launcher 启动游戏时只传 `PERSPECTRA_ROLE_MODELS`（全部解析后的目标，不含 Key）与 `PERSPECTRA_MODEL_KEYS`（仅被引用到的连接 Key），游戏进程读取后立即从环境删除 Key。

## 模型能力声明

思考档位等能力由 pi-ai 内置目录提供，不让用户手填。按模型 ID 查目录，分两层：

- 能力层只要 ID 匹配就继承：是否支持思考、哪些档位不可用、上下文与输出上限。网关上用 OpenAI 协议接的 Gemini 3 仍不能选“关闭”；DeepSeek Flash 目录不提供“中”。同 ID 多条时优先声明了档位的条目。
- 线格式层（思考参数格式、max tokens 字段等兼容开关）只在协议一致且主机相同时继承，例如 `api.deepseek.com` 上的 DeepSeek 模型按 `deepseek` 思考格式发送。

目录里没有的 ID（网关私有名、别名）按保守默认：四档都可选、不设兼容声明。Launcher 的思考选项按声明置灰；保存与启动时再校验一次，已保存但不再支持的档位会在启动时提示重新选择。

## 调用边界

- 复用现有 ChatCall、授权角色上下文和决策 Schema。适配器只转换请求与响应；perform 仍经过 Host / Rulebook / Event 提交。
- OpenAI 兼容和 Anthropic 协议使用扁平决策 Schema，避免兼容网关把根 `oneOf` 只解释为首个 `abstain` 分支；Google 使用原 Schema。Host 仍按原始角色协议检查输出。
- pi-ai 只支持 `auto` / `none` 工具选择。适配层在请求发出前补回原有行为：OpenAI 兼容强制调用 `submit_actions`（DeepSeek 思考格式开启思考时改为 auto）；Anthropic 用 auto 并在系统提示要求使用该工具；Google 用 ANY 并限定函数名。只接受一次指定工具调用，或交给 Host 验证的 JSON 正文。
- 未设置思考强度时请求不含任何思考字段（包括 OpenRouter 的 `reasoning`；pi-ai 默认会写入“关闭”，适配层剥掉），唯一例外是 DeepSeek 思考格式的角色决策沿用 `thinking: disabled`。显式“关闭”由 pi-ai 按协议发送；OpenAI 兼容模型没有声明关闭映射时，适配层补默认 `off: none`，使普通兼容接口收到 `reasoning_effort: none`，目录里的禁用档位与供应商映射仍优先。低、中、高交给 pi-ai 换算，开启思考时输出上限至少提到 8192 / 16384 / 32768。
- 没有继承到兼容声明的地址，按改造前的请求形状发送：OpenAI 兼容保留 system 角色和位置、用 `max_tokens`、不发 `store`；Anthropic 不发 eager 工具流；三种协议都不加提示缓存标记。
- pi-ai 总是流式请求（OpenAI 兼容带 `stream_options.include_usage`）。接口返回非 SSE 时明确报“未返回流式响应”；`max_tokens` 截断、多工具、错工具名、空响应和取消均失败，`maxRetries` 为 0，不隐式重试。
- OpenAI 兼容与 Anthropic 请求拒绝跟随重定向，避免 Key 随跳转发往其他主机；pi-ai 的 Google 实现不能注入请求函数，这一防护对 Google 协议不生效，是已知限制。工具参数不是合法 JSON 时，模型原文交给 Host 校验与检查器，不当作空对象。OpenAI 兼容协议下，后置的 system 预设节点在 DeepSeek 等目录内模型上同样保持原位。
- Anthropic 总是走 SDK 的 beta 客户端（请求地址带 `?beta=true` 并附 beta 头），这一点无法关闭。
- Core 记忆的 Python utility_llm 仍自己发请求（未经 pi-ai），使用该角色生效的记忆模型、协议、地址和连接 Key；未覆盖的角色沿用实例默认记忆选择；角色单独选择决策模型且未指定记忆模型时，记忆跟随该角色决策。决策思考强度不传给记忆 Utility。
- 请求检查器记录 pi-ai 最终发出的请求体（Google 为 SDK 参数形状），按转换前消息保留来源标签；响应为 pi-ai 组装后的文本、工具调用、思考摘要与用量，不再是供应商原始 JSON。检查器不接收认证头。

## 预设与已接受限制

system/developer 预设节点在 OpenAI 兼容协议下保持原位置；原生协议汇集为系统指令，before/afterContext 位置不再代表交错会话位置。原生请求必须以 user 结束；末尾 assistant 预填明确报错。

OpenAI 兼容协议的 topP、penalty 与 stop 原样传递；Anthropic 传 topP 与 stop，设置 penalty 时明确拒绝，开启思考时去掉 temperature / top_p；Google 映射到 generationConfig。不同模型可能进一步限制这些参数，建议首次连接使用空采样参数的预设。

发行包体积：后端包 `playtest.mjs` 由约 1.8 MB 增至约 6.3 MB（pi-ai 带入 OpenAI、Anthropic、Google GenAI SDK；未打入 Bedrock）。pi-ai 升级可能改变目录声明或请求形状，视为需要真实模型复验的变更。连接测试只验证文本响应，不证明完整 Schema 被供应商接受。

## 验证

2026-10-27 自动化：本机流式模拟供应商覆盖三种协议的请求字段（强制工具、采样、思考字段、输出上限、认证头与无 Key）、响应提取、截断、非流式、HTTP 失败、取消与检查器；三种协议都跑通取钥匙 → 放回 → 续写，检查两次受控事实提交与最终保管状态。全量回归 1507 项通过。

2026-10-27 真实模型：DeepSeek 官方 OpenAI 兼容（思考未设与低）及 Anthropic 兼容地址各 3 轮短场景全部成功，请求字段与事实提交符合预期，Key 未落盘，见[实测记录](studies/unified-provider-playtest-20261027.md)。

2026-10-28 审查修复的回归范围：本地模拟请求验证未知 OpenAI 兼容模型显式关闭、OpenRouter 未设与关闭的区别、非法工具参数原文同时进入 Host 与检查器，以及保存连接时拒绝不支持的 Anthropic 路径。这轮修复未调用真实模型或重建发行包，不扩展前述真实体验验收范围。

尚未验证：8045 网关 Claude + Gemini 的改造前后对比、Ollama 小模型工具调用稳定性、经 Launcher 的 Core 记忆整理，以及较长游玩中角色表现是否退化。2026-10-17 的旧实现验收记录见[按角色模型研究](studies/launcher-role-models-20261017.md)与 [DeepSeek Anthropic 实测](studies/deepseek-anthropic-20261008.md)，不代表当前实现。

协议依据：[Anthropic 工具](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)、[Anthropic API 使用](https://platform.claude.com/docs/en/claude_api_primer)、[Google generateContent](https://ai.google.dev/api/generate-content)。
