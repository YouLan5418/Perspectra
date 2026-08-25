# ADR-0055：角色认知、关系、Goal 与复杂心理

- 状态：Accepted
- 日期：2026-08-25
- Extends：ADR-0033、ADR-0035
- Supersedes：旧决策说明中把 Goal 与关系收窄为简单 value 的 V0 裁剪
- 上位契约：[通用内容架构总纲 §6](../spec/general-content-architecture-v0.1.md#6-角色秘密关系与复杂心理)

## 背景

创作者需要表达秘密、错误认知、复杂关系、矛盾动机和情绪，但这些内容若只作为自由 prompt，无法重建、隔离或参与确定性规则；若把统一信任值、情绪值或心理学本体写入 Kernel，又会把某种题材模型固化为产品语义。

## 决定

1. CharacterDefinition 分为 identity、genesis、cognition、portrayal、capabilities 和 runtime。客观事实进入 Genesis/Event；主观内容进入每角色独立 Observation、Claim、Goal、Affect 或 InnerTension。
2. Secret 是权威命题加初始 audience 的作者语法，Compiler 将其展开为带来源的角色独立 Claim。未在 audience 中表示没有 Claim；未知不是一个自动生成的事实。
3. 错误认知是第一等 Claim。规则相关 proposition 必须使用注册 predicate；“X 说 P”只产生交流 Observation/Memory，不证明 P。
4. 关系分为客观关系事实和各角色主观关系 Claim/Goal，不自动同步。Kernel 不定义通用 trust/affection 数值；需要时由精确插件提供。
5. CharacterGoal 是主观、事件化状态，包含 status、priority、awareness、visibility、target/source refs、可选 parent 和 completion policy。父子只组织，不自动传播或规划。
6. 复杂心理由稳定 `affectStyle`、多个并存的事件化 Affect 和结构化 InnerTension 表达。强度不归一化；内部状态与外显 Observation 分离。
7. Kernel 冻结结构但不冻结通用心理词汇。Pack 选择版本化 affect vocabulary/policy；TURN_DRIVEN 下变化只由 Tick、Event 或注册 policy 驱动。
8. CharacterDefinition 可为 unique 或 template。每个模板实例拥有独立身份、认知、Memory、Session、Scene、lifecycle 和 availability；参数只能使用预编译 Schema/variant。

## 后果

- 同一客观事件可让不同角色形成不同甚至矛盾的认知，而不破坏世界事实唯一性。
- 角色可以表现“想保护某人又想坦白”等矛盾心理，但 InnerTension 不能绕过 Rulebook 直接产生世界效果。
- 丰富字段是最大表达能力而非必填清单；Compiler 将安全默认值完全物化。
- 题材插件可以增加词汇和确定性 policy，但不能把模型输出提升为事实。

## 验证

- 秘密、false belief、关系 Claim、Goal、Affect 和 Tension 均按角色/Branch/as-of 重建且不串线。
- 多个相反 Affect/Goal 可并存；其他角色只能看到获授权的外显 Observation。
- “说过 P”与“P 为真”在 Claim、Memory 和 Context 中保持不同来源。
- template 多实例的 ID、Projection、Memory namespace 和 fork 行为独立且确定。
