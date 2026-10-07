# 当前架构

Perspectra（代码与界面仍使用 Cordis World 名称）是玩家推动的多角色扮演原型：各角色以自己的授权观察、认知和记忆自主行动，关键世界状态由系统裁定提交。

| 阅读问题 | 入口 |
| --- | --- |
| 一次输入怎样运行 | [运行时](runtime.md) |
| 自由表达与世界行为如何共存 | [Interaction](interaction.md) |
| 当前记忆怎样工作 | [认知与记忆](cognition-memory.md) |
| 特定玩法怎样限制行为 | [受控交互](controlled-interaction.md) |
| 创作者怎样定义世界与活动 | [创作者运行时](creator-runtime.md) |

这些页面整理当前实现，不新增设计承诺。默认原生记忆与显式 Core 实验必须分别理解；整体完成度见[当前状态](../PROJECT-STATE.md)。

桌面当前入口见 [Launcher 真实 Core 接入](../launcher-core-integration.md)：Tauri + Vue 已接通 v5 包、独立实例、Core 记忆及系统浏览器游戏页；完整节点与历史分叉后续已接入，见[故事线](../storylines.md)；分享暂未接入。第一阶段 [Mock 交付](../launcher-v1.md) 保留阶段记录，现有 Electron 入口保留。

游戏页面当前通过公共玩家接口与 iframe 沙箱运行；默认模板、包内 frontend/、恶意用例及限制见 [游戏前端最小沙箱实验](../frontend-v1.md)。旧 web/ 不再作为执行入口。

社区前端授权后续已实现内容摘要、双签名记录、Windows 本机密钥、独立来源受信任模式与运行中撤销；角色专属与实例内角色组预设后续已接入（专属 > 组 > 实例默认），见 [预设说明](../model-presets.md)。验收见 [前端授权](../frontend-authorization.md)。
