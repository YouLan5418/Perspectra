# Core 工具调用耗时与并发排查

角色仅需要记住短信暗号，Core 却在整理少量经历时等待数分钟。此次定位保留 8046 / gemini-3.8-flash，复用已授权的单角色来源；不改世界事实或网关配置。低思考仅在独立探针进程启用。

## 已确认的问题

Core 的 [utility_request](../../../experiments/activity-memory/core_bridge.py) 对 OpenAI 兼容入口统一发送 `thinking: {type: disabled}`。普通角色 Provider 已有 Gemini 型号的思考强度映射，但 Python Core 未使用它。此请求对本机 Gemini 网关没有实现关闭思考。

只读网关配置与实际 request_logs 表明：本机 thinking_budget.control_source 是 gateway，flash_tiered=-1。没有 reasoning_effort 的 Core 请求映射为 gemini-3.8-flash-tiered，上游 thinkingBudget=-1、includeThoughts=true，maxOutputTokens=65536。客户端发送的 max_tokens=2500 并未成为实际输出上限。不能把客户端参数已发送或已有单测通过当作服务端预算生效。

原 3 组实验合计 22 次 HTTP 尝试：12 次返回、10 次超时。超时全部发生在等待响应头，未进入响应 JSON 解析或 E5 编码；成功响应正文读取通常仅 0.12–0.20 ms。成功请求生成了 819–9299 个思考 token，即使可见输出只有百余 token，也需等待较长的上游生成。客户端元数据不能单独区分网关排队和上游生成；高思考的配置漂移已经直接确认，不能将全部超时只归因于这一项而排除网关其他因素。

固定 120 秒、三次尝试、2 秒与 4 秒间隔解释了约 367 秒的失败构建。延长超时或增加重试会延长等待，不能纠正思考预算映射。

## 同输入实测

[传输探针](../../../tests/experiments/core-utility-timing-probe.py)从同一份真实授权归档产生 813 字符的 Retain 输入，只改变思考字段，使用既有 JSON 解析方式。最终有效样本为 `output/experiments/core-timing-probe-20261010-02/report.json`。

| 调用条件 | 客户端耗时 | 结果 |
| --- | --- | --- |
| reasoning_effort=low，串行 | 3.77 秒 | 有效 atoms JSON |
| reasoning_effort=low，双并发之一 | 3.76 秒 | 有效 atoms JSON |
| reasoning_effort=low，双并发之二 | 4.21 秒 | 有效 atoms JSON |
| 原 thinking.disabled，客户端串行 | 60.02 秒 | 等待响应头超时 |

网关实际将 low 请求映射为 gemini-3.8-flash-low，thinkingBudget=1024；maxOutputTokens 仍为 65536。low 确实控制了思考层级，仍不能宣称客户端输出上限生效。旧参数的 60 秒超时只是此诊断探针的有界等待，产品原预算仍为 120 秒。第一次探针直接 json.loads(text)，没有使用 Core 既有的 Markdown 外壳处理，误报了低思考响应解析失败；最终探针已使用同一解析方式，此早期样本不计协议失败。

[完整构建探针](../../../tests/experiments/core-utility-build-probe.py)只在自身进程把 Core 请求切到 low，实际完成 Retain → Group → Consolidate → E5 索引，约 17.43 秒得到 4 个 Atom、2 个 Episode、2 个 Observation、8 个索引单元。既有来源与归档验证全部通过，没有伪造模型结果。报告位于 `output/experiments/core-low-build-probe-20261010-01/report.json`。这证明该单角色样本可以完整构建，不等于多角色长会话或全部节点分享已验收。

## 并发条件与边界

[Core 宿主](../../../tests/experiments/playtest-memory-core.ts)默认 roleConcurrency=2，[Python Retain](../../../experiments/activity-memory/core_bridge.py)默认 retainConcurrency=2。当每角色有多个批次时，单实例可同时发出最多 4 个 Retain HTTP 请求；Group 与 Consolidate 每角色顺序执行。这些限制按实例／进程管理，没有共享的网关总限额，普通角色请求也不在这个 Core 限额中。

上一轮实验由本次调查者重叠启动了多个宿主，汇总已记录的 Core 请求实际峰值为 4。不能把这一组结果解释为“默认单实例双并发必然失败”。本轮双并发低思考小样本通过，说明降低到串行不是当前首要修正；没有证明高并发不会排队，也没有验证客户端超时后网关一定取消上游工作。

## 建议与交付范围

先对 Gemini 的 Core 工具调用明确发送低思考，独立于角色思考设置，并按实际后端协议选择字段；保留当前来源验证、JSON 校验、事务边界及超时策略。随后用原短信／电话节点脚本重测完整整理，再根据网关同时承载的实际负载决定是否限制后台并发。输出上限还应单独核对网关映射，不靠客户端 max_tokens 假定已经限制。

排查阶段只增加诊断脚本与记录，网关未更改。原日志只读；报告仅输出计时、预算、状态和用量，不记录凭证、账号或模型私有思考。Python 探针实际执行成功，文档链接检查通过。普通宿主的 Core 传输也使用同一 Python 路径，因此参数问题影响范围不限于跨场景通信。

## 按用户要求接入 low 与一次超时回退

当前 utility_request 对 Gemini 的 OpenAI 兼容请求发送 reasoning_effort=low，不同时发送 thinking.disabled。仅当首次 HTTP 尝试直接 TimeoutError 或 URLError 包装 TimeoutError 时，保留原输入、输出预算、JSON 格式与凭证，移除 reasoning_effort，改用 thinking.disabled，等待既有 2 秒间隔后重试一次。第二次失败不再请求；HTTP 错误、连接拒绝或 JSON 错误不触发这条回退。单次 120 秒预算保持原值。

DeepSeek 的关闭思考请求与其他模型、原生协议的既有重试不变。不会改角色思考设置、网关配置、授权验证或世界事务。回退发送 disabled 是用户指定的尝试策略，不能据此声称本机网关真正关闭了 Gemini 思考。

[桥回归](../../../experiments/activity-memory/test_core_bridge.py)28 项通过，包括两种超时形式、两次请求上限、换参后原证据一致、非超时失败不回退、DeepSeek 保持原参数和已有 JSON／来源校验。24 项宿主／Core 集成测试通过，类型、Lint 和文档检查通过。使用 8046 / gemini-3.8-flash 串行重跑了[短信与电话完整 Core 节点流程](cross-scene-core-memory-20261010.md)，两者均通过；节点回退与分享后实际 Core Delivery 交付青灯，活动一致、原未来独立。真实请求未触发回退，换参路径由模拟超时测试验收；未重跑全仓检查或重新制作发行包。
