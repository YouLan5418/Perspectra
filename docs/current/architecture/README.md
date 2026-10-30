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
| 分支组件和历史怎样复用，缓存何时失效、维护时注意什么 | [运行时缓存设计](runtime-caches.md) |
| 自由表达与重要状态如何共存 | [Interaction](interaction.md) |
| 原生记忆与 Core 记忆有什么不同 | [认知与记忆](cognition-memory.md) |
| 特定玩法怎样限制行为 | [受控交互](controlled-interaction.md) |
| 各协议与数据库当前是哪个版本、旧值怎么处理 | [协议与存储版本](versions.md) |
| 创作者怎样定义世界与活动 | [创作者运行时](creator-runtime.md) |
| 如何按权限交付设定、区分角色态度与客观变量 | [世界设定](../guides/world-knowledge.md) |
| 创作者怎样检查位置、物品、私有上下文与记忆 | [创作者调试接口](../creator-debug-api.md)（浏览器里的只读创作者页面） |
| 怎样重新生成最近一回合 | [末端回合重新生成](../tail-round-regeneration.md) |
| 节点、分叉和分享怎样工作 | [故事线](../storylines.md) |
| 游戏页面怎样获授权 | [前端授权](../frontend-authorization.md) |
| 默认舞台怎样播放对白和活动 | [默认情景舞台](../frontend-stage.md) |
| 启动器怎样选择 Cordis 宿主插件、注册语音与 BGM 服务 | [宿主插件](../host-plugins.md)、[插件制作指南](../guides/host-plugin-authoring.md) |
| 创作者用前端插件能做到什么、还缺什么 | [前端表现插件的能力边界](../studies/frontend-plugin-capability-boundary.md) |
| 角色专属和角色组预设如何应用 | [预设说明](../model-presets.md) |
| 模型服务如何接入 | [模型接口协议](../model-protocols.md) |
| 怎样启动桌面与游戏 | [Launcher 接入](../launcher-core-integration.md)、[当前指南](../guides/README.md) |
| Launcher 的模型连接与按角色模型 | [模型接口协议](../model-protocols.md)、[运行时](runtime.md) |

## 怎样理解这些说明

2026-10-24 发行／创作补充：本轮已生成不附试玩包的本地程序候选，随包 CLI 与 [perspectra-creator Skill](../../../skills/perspectra-creator/SKILL.md)支持无源码创作。宿主／离线编码、测试失败与未验收范围见[本轮记录](../studies/program-package-creator-skill-20261024.md)；这不表示所有专题页的旧试玩证据已经更新。

本页核对日期：2026-10-18。入门、模块地图和代码路线的核对日期分别写在各自页首。

当前源码能做的事：桌面 Launcher 管理世界包和实例，游戏在系统浏览器里运行；支持故事节点、分叉和单节点文件分享，末端回合重新生成，多条模型连接与按角色选模型，以及只读的浏览器创作者页面。便携包 test3 只含 2026-10-09 之前的部分，哪些新功能不在包里见[项目状态](../PROJECT-STATE.md)。

两个容易混的“Core”：源码网页和 Launcher 启动的游戏默认都用 Python 长期记忆（Core 记忆），缺少 Python/E5 时直接报错；只有显式加 --memory-native 才退回原生记忆。“Launcher Core”则是桌面管理后端，和记忆无关。

专题页里的实测数字只代表当时的配置和日期。源码是否接通、自动测试覆盖什么、真实试玩是否通过，要分开看；文档中提到的提交号也不能代替实时 Git 状态。

代码变化时同步更新受影响章节，并运行：

~~~powershell
node scripts/docs/check-links.mjs
~~~

这个检查发现本地断链和模块地图遗漏，正文含义仍需读代码核对。历史设计见 [archive](../../archive/README.md)、[ADR](../../adr/README.md)和 [spec](../../spec/README.md)。
