# Launcher 按角色模型交付与验收

日期：2026-10-17。工作分支：`feat/launcher-model-connections`，当天已合并进 main（`46562fb`）并推送；未重建发行包。

例如让 Claude 使用强模型、其他角色使用 Flash：在实例模型弹窗设置默认模型，为 Claude 取消“跟随默认”，另选连接和模型。记忆整理可以跟随该角色决策，也可以另选。这次实际用两种协议完成了决策路由和四角色长期档案整理，没有使用 Ollama 或读取用户凭据。

## 交付范围

接续[Part B 交接](../../superpowers/handoffs/2026-10-17-launcher-model-connections-part-b.md)的三个提交：`060fa93` 按角色决策、`0e6dc65` 按角色记忆、`cfd4b05` 实例配置界面。补齐模型协议、Launcher 接入、玩家指南与运行时说明，并修正记忆章节原来“每会话一个 worker”的描述。

额外修复 `a49d870`：Anthropic local 路径复用既有扁平决策 Schema，避免兼容网关把根 `oneOf` 处理为只有第一个 `abstain` 分支。没有增加协议、模型审查或重试层；Google 保留原 Schema，Host 仍按原始角色协议及 Rulebook 检查输出。

## 实测环境与步骤

- 从独立 worktree 启动真实 `LauncherCore`，依次调用 `connection-save → load → create → configure → start`，开启请求检查器；没有经过本轮未改动的 Tauri 凭据管理器。
- 游戏包为 `examples/world-packs/model-girls-official`。默认连接为 `http://127.0.0.1:8045/v1/chat/completions`、`gemini-3.8-flash`、思考低；Claude 覆盖为 `http://127.0.0.1:8045/v1/messages`、`claude-sonnet-4-6`、思考关闭。记忆均跟随各角色决策模型，不传决策思考档位。
- 交接里的主仓库 Python 和 E5 路径当前已不存在，原目录联接也已失效。改为只读复用本机 `Perspectra Portable 验收/候选包/runtime` 的 Python 与 E5，通过 `HCW_HINDSIGHT_PYTHON`、`HCW_HINDSIGHT_ONNX_DIR` 指定；Core 代码仍使用本分支源码。
- 所有世界和日志写入 worktree `.tmp/` 新目录，没有修改历史试玩数据。验收脚本留在忽略目录 `.tmp/accept-scripts/`，不随源码提交。

复验操作：添加上述两条连接，配置角色覆盖，开始游戏并发言“大家好，我叫小林。明天晚饭我想做番茄炒蛋，Claude，你有什么建议？”。观察各角色真实请求，再在游戏工具中触发后台整理；等待结束，检查 `memory-core/background-builds.jsonl`、`utility-attempts-*.jsonl` 和角色档案。最后继续发言，核对整理后请求路由仍正确。

这只是同一网关的两个协议入口，并非两家独立服务商；网关声明的模型标识不能证明实际上游身份。

## 证据与结论

| 证据 | 发现 | 对应实现或检查 |
| --- | --- | --- |
| 修复前真实 Claude 请求返回 `abstain`；同一请求仅更换为既有扁平 Schema 后返回 `publish`，均 HTTP 200 | 支持根 `oneOf` 的网关兼容问题判断 | `local-prototype-turn-call.ts` 与运行时角色协议选择 |
| 最小回归修复前失败、修复后通过；新世界中 Claude 实际发表番茄炒蛋建议 | 修复已改善可见回应，不只是请求参数改变 | `model-presets.test.ts` 的按角色路由用例；`.tmp/accept-scripts/schema-ab.json`、`final-turn1.json` |
| 请求检查器按角色记录模型和请求体 | Claude 用 Anthropic 请求，其余三个角色用 OpenAI 兼容请求 | `.tmp/accept-scripts/final-inspector.json` |
| 四个角色各三个 Utility 阶段，12 次请求均 HTTP 200，四份档案安装成功 | 记忆路由和完整整理已在真实模型路径跑通 | 下表及 `background-builds.jsonl` 的 `installed` / `idle` |

最终验收数据目录：`.tmp/accept-gpt-final-20261017/instances/fa3f62f7-3f4a-4771-82e9-0cd2d51bafee`。

| 角色 | 决策模型 | Retain / Group / Consolidate 的 requestedModel | 档案 |
| --- | --- | --- | --- |
| Claude | claude-sonnet-4-6 | 全部 claude-sonnet-4-6 | installed，前缀 68 |
| DeepSeek | gemini-3.8-flash | 全部 gemini-3.8-flash | installed，前缀 68 |
| GLM | gemini-3.8-flash | 全部 gemini-3.8-flash | installed，前缀 68 |
| GPT | gemini-3.8-flash | 全部 gemini-3.8-flash | installed，前缀 68 |

本次后台整理共 176873 ms，`completed=4`、`failed=0`。Claude 三阶段 HTTP 耗时约 118944 / 12132 / 39908 ms；其余角色整份 Build 约 22–26 秒。这里是单次轨迹，不证明稳定延迟或整理质量。

整理后继续第二轮对话，Claude 正常回答此前菜品及采购准备，并参与后续交流；四角色请求仍使用各自的模型，均 HTTP 200。召回追踪进入 Core 路径。由于近期原文重叠仍在，不能把这次回答当作脱离短期上下文的长期记忆盲测。证据在 `.tmp/accept-scripts/final-turn2.json`、`final-inspector2.json` 及实例 `memory-core/recall-trace.jsonl`。

较早的验收目录 `.tmp/accept-gpt-20261017b` 中，Claude 两次 Retain 返回未正确转义内嵌引号的 JSON，均被现有解析拒绝，其他三角色档案成功。没有修改 Python JSON 解析或增加自动重试来掩盖这些失败；最终新轨迹的成功不消除供应商输出偶发不合法的限制。

## Key 检查

最终实例给两条连接分别注入随机生成的非秘密测试 Key，经过真实 `start → 环境变量 → 决策及 Python 记忆请求` 路径；这些不是用户凭据，值只保存在验收驱动进程内存，没有打印或写入脚本。

两轮对话和整理完成后，先停止游戏以刷新 SQLite，再递归读取整个 Launcher 验收根目录内全部 93 个文件的原始字节（含索引、SQLite、故事节点、日志、档案），搜索两份测试值，结果为 `sentinels=2, files=93, matches=[]`。结果保存于 `.tmp/accept-scripts/final-key-scan.json`，不含测试值。这验证该条路径的非空 Key 未落盘，不声称对任意供应商回显作出穷尽证明。按角色 runner 和 Key 隔离另有现有单元回归。

验收游戏、Python worker 及本轮驱动服务已停止；私有模型记录和世界数据保留在忽略目录，没有纳入提交。

## 自动验证与边界

| 检查 | 本轮结果 |
| --- | --- |
| `corepack pnpm@11.7.0 check`，修复后最终运行 | 类型检查、Lint、62 文件 / 544 项全部通过 |
| `corepack pnpm@11.7.0 launcher:check` | Vue 类型检查、4 文件 / 30 项全部通过 |
| 模型路由、原生 HTTP、扁平 Schema、受控行动续写相关测试 | 4 文件 / 79 项通过；随后完整 check 再通过 |
| `node scripts/docs/check-links.mjs` | 本地链接与模块地图通过 |

第一次在沙箱默认环境执行 `check` 时失败 19 项：1 项缺 Python，18 项硬中断测试无法执行 `taskkill`。指定已存在的 Python，并允许测试清理自己的子进程后，完整检查通过；没有跳过用例或修改断言。

本轮未重跑 Rust 测试和原生 Tauri 窗口、凭据跨重启验证，也未跑包含全部历史测试的 `test:related`。界面保存与回显沿用交接方的 Mock 实际操作证据；本轮真实验收由 LauncherCore 和本机 HTTP 驱动。没有验收官方 Anthropic / Google 直连、长会话记忆质量或干净机器安装。

每种记忆配置可能加载独立 E5 编码器，接受内存叠加；请求检查器仍主要靠模型名区分连接，同名模型不能仅靠该名称判断地址。角色仍可自主沉默，修复没有强迫每轮回应。
