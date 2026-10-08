# 当前 Interaction

当前原型允许自由对白和外显叙述；移动、物品归属和包明确追踪的机制状态通过受控行为提交。二者共同构成角色互动，不要求把眼神、姿态和所有细微动作变成结构化事实。

## 表达与行动

自由文本表达角色的说法、姿态或意图，不独立证明重要状态变化。玩家普通自然语言不会自动执行移动、取物或交接；当前玩家受控操作使用 `/act` 或网页提供的当前选项。

`perform` 承担表现输出，`move` 是位置变化，`take` 等来自可用基础交互。是否提供某个行为取决于 World Pack 声明、当前绑定和宿主已安装的能力；AI Girls 原包没有可用物品交互定义，不能从基础包存在 take 推断每个世界都能取物。

声明式 Interaction 描述可选能力、绑定与参数。模型选择并提出动作，Action / Rulebook 检查当前资格、存在性、位置与重要状态约束，接受后通过 Event 提交。世界事件日志是已提交权威事实的来源；模型生成文本和主观记忆不能代替它。

## 有序角色表达

2026-10-08 起，Character 的 `publish` 使用 `segments` 替代独立的 `speech/narration` 字段。例如：

```json
{"decision":"publish","segments":[{"type":"speech","text":"你真的要走？"},{"type":"narration","text":"她停顿了一下。"},{"type":"speech","text":"等雨停吧。"},{"type":"narration","text":"声音放轻。"}]}
```

片段按数组顺序发布，可交替、重复同类型，或只含一种类型。每段必须有非空白文本；所有 text 合计最多 2000 个 UTF-16 单位。整个序列共用可选 `addresseeIds`，仍为一次 `speak` 裁定、一次原子提交和一个 tick；发布后结束本次激活。不能在片段间插入受控执行或分别指定受众，受控交互仍须先执行并获得结果。

事件、授权观察、自观察、记忆 Source 与玩家公开视图保留片段顺序。记忆仍将其记为角色发表的内容，不证明叙述中的受控结果。预设 output/history/display 规则逐片段按 speech 或 narration 类型处理；显示规则只修改投影副本。

活动仍可关闭对白或叙述；固定原文选项模式一次发布最多一个 speech 片段，可由许可的 narration 包围，避免把多个选项组合成一次新对白。普通场景没有这一限制。

玩家公共输入仍使用 `text` 与可选 `narration`，不要求玩家编写片段数组。角色的旧双字段模型输出不再接受；当前玩家双字段事件及已保存表达仍由同一发布读取函数呈现，没有数据库迁移或协议版本升级。

本轮验证：默认 `corepack pnpm@11.7.0 check` 的类型、Lint、38 文件 293 项通过；随后局部完善自观察预设处理及空显示片段，相关 35 项与额外上下文／展示／宿主 32 项通过，类型与 Lint 再次通过。回归覆盖四段交替表达、两个模型 Schema、单次提交、受众隔离、原生及 Core Source 顺序、活动许可和总长度边界。

真实模型验证：初次默认端口 8045 拒绝连接；按用户提供的 `127.0.0.1:8046` 使用 `gemini-3.7-flash` 与 prototype-g1，在新 `.tmp/ordered-expression-live-1791441609114/` 目录完成两轮输入。第一轮同行者实际发布 speech → narration → speech → narration，第二轮发布 narration → speech → narration → speech；事件与玩家 transcript 均保留类型、原文及顺序。共 6 次模型调用、3 次发布和 1 次弃权。第二轮两次取钥匙尝试均被 `INVALID_INTERACTION_PARAMETERS` 拒绝（最终请求的 definitionRef.version 为字符串 `"1"`），没有物品转移事件；角色收到拒绝后继续表达，没有宣称取得钥匙。因此已验证交替表达及拒绝后的续写，未验证成功执行交互后的续写，也不代表长期试玩或任意叙事越权均已验收。证据见该目录 `evidence.json` 与 `world.sqlite`。本轮未重建桌面发行包，未修改默认服务端口。

## 当前自由度与限制

普通场景尽可能自由表达。活动可以显式收窄对白、外显表现、移动与交互能力，见[受控交互](controlled-interaction.md)。扩展玩法先复用交互定义和可信包内脚本，不把题材动作全部加入 core 枚举。

程序没有直接修改物品归属，不代表叙事一致性已经通过。真实试玩仍有自由叙述虚构受控事实、私语送达等问题；其他角色相信未提交转移也属于体验失败，不能把任意自然语言永不越权当成已证明保证。

依据：[现行原型契约](../prototype-contract.md)、[World Pack 手册](../guides/world-pack-authoring.md)、[G1/G2 验收](../../archive/prototype-g1-g4/PROTOTYPE-G1-G2-ACCEPTANCE.md)、[Gemini 试玩](../../archive/prototype-g1-g4/PROTOTYPE-GEMINI-PLAYTEST-2026-09-28.md)。代码：[交互执行包](../../../packages/interaction-runtime)、[基础交互](../../../packages/interactions-basic)、[Character Turn](../../../packages/application/src/prototype-character-turn.ts)。
