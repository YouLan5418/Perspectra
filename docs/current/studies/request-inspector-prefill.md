# 实际请求 Inspector 与 Prefill 验证报告

日期：2026-10-07。范围：实现真实角色请求检查器，探测当前本机网关的 Prefill 行为；不扩展酒馆兼容。

## 一、结论

真实请求 Inspector 已接入 Launcher 与角色调用链，可用于检查轻预设到底改变了哪条消息、请求角色和上下文体积。它读取 Provider 发送前的最终请求，不读取其他角色未授权材料，不改动模型请求或 Core 决策路径。

当前网关接受末尾 assistant 消息，但测试未证明预填充语义。普通文本前缀未延续，JSON 前缀也未延续。因此本轮不开放正式 Prefill 配置。assistant 提示节点继续作为普通消息使用，不能当成稳定的模型起手保证。

## 二、已实现

| 内容 | 当前行为 |
| --- | --- |
| 真实请求 | 捕获参数覆盖、附加提示与预设展开后的实际 JSON body，包括 tools/tool_choice |
| 消息来源 | Core 固定契约、每个预设节点、授权上下文；最终顺序与 role 可见 |
| 宏对照 | 节点原文和最终文本可对照；变量仍按每个角色请求独立创建 |
| 上下文 | 展示最终渲染的角色、刺激、记忆、认知、场景、观察、物品与能力等分项 |
| token | 消息/上下文/工具/请求 JSON 的估算，与服务返回 usage 分开 |
| 调用状态 | 角色、继续处理标记、模型、时间、耗时、pending/ok/failed |
| 生命周期 | 默认关闭，内存保留最近 4 次；关闭采集、退出运行时清空；超限明确省略正文 |
| 权限 | 受保护宿主 API；Frontend API 无检查器；不进入 PlayerView、存档或普通调试状态 |

使用：启动实例 → Launcher「实际模型请求 → 查看」→「启用采集」→ 游戏内互动 →「刷新」。关闭窗口不停止采集；停止采集请点击「关闭采集并清空」。

## 三、真实模型验证

网关：`http://127.0.0.1:8046/v1/chat/completions`；模型：`gemini-3.7-flash`。使用 prototype-g1、新目录 `.tmp/request-inspector-20261007/world`，两轮输入、两名角色，共 4 次真实调用，均完成且游戏无错误。

| 调用 | 角色 | 实际输入 usage | 请求 JSON 估算 |
| --- | --- | ---: | ---: |
| 1 | companion | 2642 | 3359 |
| 2 | friend | 2652 | 3358 |
| 3 | companion | 3186 | 4025 |
| 4 | friend | 3213 | 4052 |

四次请求均显示 system Core → system 自然口语节点 → user 授权上下文；节点宏均已展开，工具定义存在。上下文包含 character/stimulus/memories/cognition/scene/observations/selfObservations/claims/goals/items/affordances。实际对白能回答场景与个人偏好，发布结尾标签被清理，玩家展示规则仍有效。

上述 token 估算明显高于服务返回输入数，说明二者不可混用；网关 total 含额外计数，报告不把 total 等同于可见输入输出之和。这是两轮功能验证，不是长期角色自然度、记忆质量或所有模型验收。未启用长期记忆维护压力场景。

证据：`.tmp/request-inspector-20261007/result.json` 仅保留试玩结果与检查元数据摘要，未导出完整私有请求。

## 四、Prefill 探测

使用无私密材料的短问候测试。每组比较无前缀基线与末尾 assistant 前缀；关闭流式，temperature=0。共两组、8 次调用：第一组仅简短问候；第二组对工具调用明确要求提交 publish/speech JSON。

| 第二组 | 基线 | 带末尾 assistant 前缀 | 观察 |
| --- | --- | --- | --- |
| 普通文本 | HTTP 200，完整问候 | HTTP 200，完整问候 | 「起手标记：」未延续 |
| 强制工具+明确协议 | HTTP 200，有效工具 JSON | HTTP 200，有效工具 JSON | `{"decision":"publish","speech":"起手标记：` 未延续，speech 为新的完整问候 |

第一组单靠 tool_choice 的普通问候请求返回了普通文本，提示当前网关不能仅凭 HTTP 成功或工具配置推定协议已强制。真实项目依然需要现有协议和 Core 校验。

结论仅针对这次端点、模型和请求形态：末尾 assistant 可被接受，不足以证明它会作为待续文本。无法据此断定所有模型都不支持 Prefill，也未探测厂商专有续写字段。未来如接入 Prefill，必须验证具体 Provider 的续写语义与 publish/perform/abstain 协议，不应通过预填充预先替角色选择 decision。

证据：`.tmp/request-inspector-20261007/prefill-result.json` 与 `prefill-protocol-result.json`。

## 五、自动化与界面验证

- `corepack pnpm@11.7.0 check`：类型、Lint 通过；34 个文件、237 项测试通过。
- 新增 5 项回归：默认关闭/容量/副本/清空、最终 body 与实际 transport 一致、宏来源和 usage、失败不复制错误正文、正文超限、宿主授权与 Frontend API 不暴露（部分合并在单项测试中）。
- 最终增加退出清空与限定授权上下文拆分后，类型检查及相关 2 文件、14 项测试再次通过。
- `launcher:check`：类型与既有 9 项测试通过；`launcher:build` 成功。
- 真实 Launcher/Core 子进程联通：默认关闭 → 启用 → 读取 → 关闭清空，均成功。新目录 `.tmp/request-inspector-launch-20261007`。
- Playwright 浏览器使用合成请求测试 Inspector 启用、节点原文、展开文本、记忆分项、完整 JSON 和关闭清空。截图：`output/playwright/request-inspector-verified.png`。浏览器界面使用原生桥替身；未重新构建或实测 Tauri 原生窗口。

## 六、有意识接受的限制

检查器目前只有最近 4 次调用，超限正文不保留，没有私有内容文件导出。仅采集角色调用，不采集意图解释、记忆维护调用。上下文分项反映压缩后的最终发送内容，不是存储层全部原文；没有逐条正则执行轨迹或输出清理检查器。传输 ok 不等于 Core 已接受决策。

historyDepth、命名预设库、导入导出与条件节点本轮未实现；当前上下文仍是单个授权区域，下一步需要先定义历史轮次与插入位置，再决定是否拆分。检查器现已能为这些后续选择提供真实请求证据。
