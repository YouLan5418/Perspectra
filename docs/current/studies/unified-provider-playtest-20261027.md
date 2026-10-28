# 统一 Provider 适配器 · DeepSeek 短场景实测

日期：2026-10-27。分支 `feat/unified-provider-adapter`，脚本 [unified-provider-smoke.ts](../../../tests/experiments/unified-provider-smoke.ts)，世界包 prototype-g1，原生记忆，新数据目录 `.tmp/unified-provider-smoke-*`，模型 `deepseek-flash`，使用用户级 DeepSeek Key。

## 做了什么

同一组三句玩家输入（问地点、问钥匙归属、请角色收好钥匙），分别跑三个目标：

| 目标 | 地址 | 思考强度 |
| --- | --- | --- |
| openai-unset | `https://api.deepseek.com/chat/completions` | 未设 |
| openai-low | 同上 | 低 |
| anthropic-unset | `https://api.deepseek.com/anthropic/v1/messages` | 未设 |

## 结果

- 9 轮全部无错误；请求检查器保留的每轮最后 4 次调用都是 HTTP 200、一次 `submit_actions` 工具调用。流式响应、Anthropic 的 `?beta=true` 与 beta 头均被接受。
- 请求字段符合设计：openai-unset 发 `thinking: disabled` 并强制工具；openai-low 发 `thinking: enabled`、`tool_choice: auto`；anthropic-unset 不发思考字段，`tool_choice: auto` 且禁止并行工具。
- 同行者在第一轮拿起钥匙，转交经 Rulebook 提交；留守者此后说“钥匙不在我这儿，是同行者拿走的”，与已提交事实一致，没有出现虚构转移。
- 对白自然、各角色口吻有区别；思考“低”时每轮多 3～4 秒，叙述更细。
- 两个数据目录中搜索 Key 前 8 位，无命中。

## 未覆盖

- 本机 8045 / 8046 网关与 Ollama 当时未运行，Claude（Anthropic 协议）+ Gemini（OpenAI 协议）的改造前后对比、Ollama 小模型工具调用稳定性都没有验证。
- 没有与改造前同输入对比，不能断言角色表现“没有退化”，只能说本次短场景未见明显问题。
- 未经 Launcher 界面启动，未验证 Core 记忆整理与发行包。
