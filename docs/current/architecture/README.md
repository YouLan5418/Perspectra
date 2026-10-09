# 当前代码技术文档

这套文档解释当前目录的实际代码，面向有一点 Agent 基础的读者。Perspectra 是玩家推动的多角色扮演原型：模型决定角色怎么回应，程序维护授权信息和已裁定的重要状态。部分代码仍使用 Cordis World 名称。

## 推荐阅读顺序

| 顺序 | 你会理解什么 | 文档 |
| --- | --- | --- |
| 1 | 用角色互动例子认识上下文、行动、事件和记忆 | [入门：从一次互动理解代码](getting-started.md) |
| 2 | 每个目录与包负责什么，遇到问题去哪里找 | [目录与模块地图](modules.md) |
| 3 | 从玩家输入一路找到模型调用、规则、提交和显示 | [一次输入的代码路线](code-walkthrough.md) |
| 4 | 修改代码时怎样保持解释同步 | [文档维护规则](maintenance.md) |

读前三篇即可建立代码全貌，不必先读完 ADR。源码链接便于继续深入；这里没有逐函数 API 清单。

## 按问题深入

| 阅读问题 | 入口 |
| --- | --- |
| 一次输入怎样运行、什么时候停止 | [运行时](runtime.md) |
| 自由表达与重要状态如何共存 | [Interaction](interaction.md) |
| 原生记忆与 Core 记忆有什么不同 | [认知与记忆](cognition-memory.md) |
| 特定玩法怎样限制行为 | [受控交互](controlled-interaction.md) |
| 创作者怎样定义世界与活动 | [创作者运行时](creator-runtime.md) |
| 怎样重新生成最近一回合 | [末端回合重新生成](../tail-round-regeneration.md) |
| 节点、分叉和分享怎样工作 | [故事线](../storylines.md) |
| 游戏页面怎样获授权 | [前端授权](../frontend-authorization.md) |
| 角色专属和角色组预设如何应用 | [预设说明](../model-presets.md) |
| 模型服务如何接入 | [模型接口协议](../model-protocols.md) |
| 怎样启动桌面与游戏 | [Launcher 接入](../launcher-core-integration.md)、[当前指南](../guides/README.md) |

## 怎样理解这些说明

入门与代码路线核对日期：2026-10-08。当前源码支持桌面管理、系统浏览器游戏页、故事节点与分叉、单节点文件分享，以及末端回合重新生成；test3 已包含这些变更、官方试玩包、思考强度与节点记忆快照，构建验证范围见[便携记录](../studies/launcher-portable-test3-20261009.md)。

直接源码网页默认原生记忆，--memory-core 才启用 Python Core；Launcher 后端启用 Core。模型接口支持 OpenAI 兼容、Anthropic Messages 和 Google Gemini 原生协议，接入范围见专题文档。

专题页中的实测数字只代表对应配置与日期。源码、测试和真实体验分别核对；[项目状态](../PROJECT-STATE.md)中的提交、分支及阶段记录也不能替代实时 Git 状态。

代码变化时同步更新受影响章节，并运行：

~~~powershell
node scripts/docs/check-links.mjs
~~~

这个检查发现本地断链和模块地图遗漏，正文含义仍需读代码核对。历史设计见 [archive](../../archive/README.md)、[ADR](../../adr/README.md)和 [spec](../../spec/README.md)。
