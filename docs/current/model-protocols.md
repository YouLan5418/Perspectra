# 模型接口协议

日期：2026-10-08。当前源码已接通 OpenAI 兼容、Anthropic Messages 和 Google Gemini Developer API 的非流式请求。DeepSeek 的 Anthropic 兼容入口已通过短场景真实调用；Anthropic 官方与 Google 原生模型尚未验收。

## 配置

Launcher 的模型设置与实例“模型”弹窗可选择协议。模型设置只影响新实例，已有实例单独修改。API Key 仍仅在 Launcher 会话内保留，并绑定协议和完整接口地址；不写入实例配置或分享文件。

| 协议 | 完整请求地址示例 | 认证 |
| --- | --- | --- |
| OpenAI 兼容 | `https://服务地址/v1/chat/completions` | Bearer |
| Anthropic Messages | `https://api.anthropic.com/v1/messages` | x-api-key |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/models/模型标识:generateContent` | x-goog-api-key |

模型标识填写供应商实际可用的 ID。Google 的实际 URL 模型段以模型标识字段为准；地址中不允许 API Key 查询参数。代理可使用相同操作路径。Google 首轮支持 Developer API 的 API Key 认证，没有接入 Vertex AI / OAuth。

源码网页入口继续使用现有 local 启动方式，通过 `HCW_MODEL_PROTOCOL=openai|anthropic|google` 选择协议；模型、完整地址及密钥仍从 `HCW_LOCAL_MODEL`、`HCW_LOCAL_ENDPOINT`、`HCW_LOCAL_API_KEY` 读取。未设置协议的现有配置按 OpenAI 处理。独立 Ollama / DeepSeek 入口保持其现有协议。

## 调用边界

- 复用现有 ChatCall、授权角色上下文和决策 Schema。供应商适配器只转换 HTTP 请求与响应；perform 仍经过 Host / Rulebook / Event 提交。
- Anthropic 使用 input_schema 工具和 auto 工具选择，避免把 forced tool 支持当作所有模型的前提；只接受一次指定工具调用，或交给 Host 验证的 JSON 正文。
- Google 使用 functionDeclarations.parametersJsonSchema 与 ANY 模式。没有把旧本地 Gemini 网关的 Schema 改写直接套用到原生接口。
- 思考块不作为角色决策。多工具、错误工具名、空响应和 token 截断失败；不增加供应商侧自动执行或隐式重试。
- Core 记忆的 Python utility_llm 使用同一协议、模型、地址和会话密钥。Anthropic 正文要求 JSON，Google 使用 JSON MIME；原有 JSON 检查、授权边界与重试策略继续执行。
- 请求检查器展示实际请求体，同时按转换前消息保留来源标签；原生用量映射到已有输入/输出 token 字段。检查器不接收认证头，不保存思考正文。

## 预设与已接受限制

原生协议将 system/developer 节点按原顺序汇集为系统指令，user/assistant 保持会话顺序，assistant 在 Google 中映射为 model。系统节点的 before/afterContext 位置因此不再代表交错会话位置。原生请求必须以 user 结束；末尾 assistant 预填明确报错，需要用户调整预设。

Anthropic 不支持 frequencyPenalty / presencePenalty，设置时明确拒绝。temperature、topP 和 stop 按原生字段传递；不同模型可能进一步限制这些参数，建议首次连接使用空采样参数的预设。未设置时 Anthropic 不注入 temperature 或 thinking，使用供应商默认值。Google 映射现有采样参数，不模拟供应商不支持的行为。

连接测试只验证文本响应，不证明当前世界的完整 Schema 被供应商接受，也不验证记忆整理与角色自然度。默认 2048 输出 token 对思考模型可能不足，可以提高输出上限；不静默重发。

## 验证

自动化覆盖原生认证头、真实决策 Schema 的请求构造、响应提取、思考隔离、截断、错误工具、取消、配置持久化及请求检查器。两种协议分别通过本机 HTTP 模拟供应商运行取钥匙 → 放回 → 续写，检查两次受控事实提交与最终保管状态。Python 验证原生记忆请求、JSON 解析和截断拒绝。

使用用户授权的用户级 DeepSeek Key，在 `https://api.deepseek.com/anthropic/v1/messages` / `deepseek-flash` 验证当前角色 Schema、perform → 结果 → publish 及 Python Core utility JSON 请求，见[实测记录](studies/deepseek-anthropic-20261008.md)。Anthropic 官方 Claude、Google 原生模型、记忆整理质量及连续角色体验仍未验收。

协议依据：[Anthropic 工具](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)、[Anthropic API 使用](https://platform.claude.com/docs/en/claude_api_primer)、[Google generateContent](https://ai.google.dev/api/generate-content)。
