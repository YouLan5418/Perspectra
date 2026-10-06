# 当前 Interaction

当前原型允许自由对白和外显叙述；移动、物品归属和包明确追踪的机制状态通过受控行为提交。二者共同构成角色互动，不要求把眼神、姿态和所有细微动作变成结构化事实。

## 表达与行动

自由文本表达角色的说法、姿态或意图，不独立证明重要状态变化。玩家普通自然语言不会自动执行移动、取物或交接；当前玩家受控操作使用 `/act` 或网页提供的当前选项。

`perform` 承担表现输出，`move` 是位置变化，`take` 等来自可用基础交互。是否提供某个行为取决于 World Pack 声明、当前绑定和宿主已安装的能力；AI Girls 原包没有可用物品交互定义，不能从基础包存在 take 推断每个世界都能取物。

声明式 Interaction 描述可选能力、绑定与参数。模型选择并提出动作，Action / Rulebook 检查当前资格、存在性、位置与重要状态约束，接受后通过 Event 提交。世界事件日志是已提交权威事实的来源；模型生成文本和主观记忆不能代替它。

## 当前自由度与限制

普通场景尽可能自由表达。活动可以显式收窄对白、外显表现、移动与交互能力，见[受控交互](controlled-interaction.md)。扩展玩法先复用交互定义和可信包内脚本，不把题材动作全部加入 core 枚举。

程序没有直接修改物品归属，不代表叙事一致性已经通过。真实试玩仍有自由叙述虚构受控事实、私语送达等问题；其他角色相信未提交转移也属于体验失败，不能把任意自然语言永不越权当成已证明保证。

依据：[现行原型契约](../prototype-contract.md)、[World Pack 手册](../guides/world-pack-authoring.md)、[G1/G2 验收](../../archive/prototype-g1-g4/PROTOTYPE-G1-G2-ACCEPTANCE.md)、[Gemini 试玩](../../archive/prototype-g1-g4/PROTOTYPE-GEMINI-PLAYTEST-2026-09-28.md)。代码：[交互执行包](../../../packages/interaction-runtime)、[基础交互](../../../packages/interactions-basic)、[Character Turn](../../../packages/application/src/prototype-character-turn.ts)。
