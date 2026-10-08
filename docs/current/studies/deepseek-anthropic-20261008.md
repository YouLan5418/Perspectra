# DeepSeek Anthropic 兼容协议实测

日期：2026-10-08。用户授权读取用户级 `DEEPSEEK_API_KEY`，调用其指定的 `https://api.deepseek.com/anthropic`。仅在子进程环境和认证头中使用密钥，没有输出或保存凭证。

| 配置 | 值 |
| --- | --- |
| 协议 | anthropic |
| 完整请求地址 | `https://api.deepseek.com/anthropic/v1/messages` |
| 请求模型 | `deepseek-flash` |
| 初次响应模型 | `deepseek-flash` |
| 世界 | 当前 prototype-g1，新 `.tmp/deepseek-anthropic-probe/world-1791450380859` 目录 |

## 实际结果

1. 角色请求：当前 `prototypeTurnCall` 的完整决策 Schema 被接口接受，HTTP 200。返回 thinking + tool_use，适配器只提取工具决策。角色合法 publish：“你好。还不错，挺精神的。你呢？”耗时 1112 ms；输入 1229、输出 124 token；检查器映射一致。
2. 实际运行时：玩家请求同行者保管黄铜钥匙。两次真实角色调用完成 perform → 规则接受 → publish，耗时 3753 ms，无运行时错误。seq26 仅一次 `entity.transferred`，钥匙最终 holderId 为 `character:companion`、locationId 为 null；seq35 续写“拿到了。黄铜钥匙在我这儿。”。一次反应波、限制后续重复激活；未进入长会话。
3. Python Core utility：通过现有 `utility_llm` 原生请求路径，合成证据返回并成功解析 `{"atoms":[]}`，耗时 707 ms。这是请求与 JSON 解析验证，不是实际记忆提取质量验收。运行时的第 2 项使用 native 记忆模式，未把它声称为完整 Core 整理验收。

没有为该兼容服务增加专用协议分支；本轮实测无需修改生产代码。Google 原生接口、Anthropic 官方 Claude 模型、多轮记忆整理和连续角色体验仍未验收。DeepSeek 的兼容行为不能代表 Claude 的全部能力和参数限制。

无凭证摘要：`.tmp/deepseek-anthropic-probe/character-summary.json`、`runtime-summary.json`、`memory-summary.json`。原始供应商信封与思考正文未落盘。

完整请求路径与模型依据：[DeepSeek 官方 Anthropic 兼容文档](https://api-docs.deepseek.com/guides/anthropic_api/)。
