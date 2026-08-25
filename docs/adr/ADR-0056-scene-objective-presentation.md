# ADR-0056：Scene v2、Objective 分类与确定性呈现

- 状态：Accepted
- 日期：2026-08-25
- Extends：ADR-0033、ADR-0051
- Supersedes：ADR-0051 中新 Manifest 全局唯一 active Scene 的限制；存量 Scene policy v1 保持原义
- 上位契约：[通用内容架构总纲 §8](../spec/general-content-architecture-v0.1.md#8-scene目标与可见性)、[§10](../spec/general-content-architecture-v0.1.md#10-presentation-与内容边界)

## 背景

酒馆、旅途和多角色世界需要同时存在互不重叠的活动场景，而 V0/Demo 的单 active Scene 足以验收但不足以表达分队、离场和背景场景。目标与呈现也必须区分角色主观状态、作者编排和玩家 UI，避免把“完成任务”或叙述文本变成隐式世界效果。

## 决定

1. SceneDefinition 是可复用来源模板，SceneInstance 是耐久世界实体。存量 policy v1 不变；新 Pack 使用 `scene-decision/v2`。
2. v2 允许多个 active Scene，但同一 Character 最多属于一个 active Scene，每个 PlayerSlot 恰有一个 focal Scene。违反约束是 Projection invariant 并 quarantine。
3. SceneDecision 由耐久 Scene/Location/Visibility/Lifecycle Projection 与独立 Runtime Availability 计算观察者、可调度参与者和 Action 结果可见范围。
4. AUTONOMY_OFF 下非 focal Scene 不自动运行，但可保持 active 并接收获授权 Observation/cognitive job。Scene transition 使用注册确定性条件，不能任意修改其他世界状态。
5. CharacterGoal、ScenarioObjective、PlayerObjective 和 AcceptanceAssertion 是四种不同类型。Scenario/Player Objective 均可省略；开放世界无需胜利条件。
6. Objective 状态变化必须事件化并有来源。完成 Objective 不直接触发其他世界突变，Scene/世界变化使用独立 Action/Event。
7. PresentationProfile 是确定性、版本化的模板/本地化/素材配置。Presenter 只能消费授权 Presentation Input，不能读取 author truth、其他角色私有状态或 raw Memory。
8. 正式对白不得被 Presenter 改写语义；内部 Affect 只有经授权外显后才能呈现。Phase 7 不启用独立 LLM Narrator。

## 后果

- 旅途分队、角色离场和多个静止背景 Scene 可在不修改 Kernel 的前提下表达。
- Scene 决断同时成为 Agent 调度和 Observation 可见性的权威派生输入。
- 目标不会被误当成角色认知或隐藏规则引擎，Presentation 也不会成为第二事实源。
- AcceptanceAssertion 只属于 Testkit，不进入 World、Context 或玩家界面。

## 验证

- 分场、合流、离场、不可见 Action、同轮 Scene 变化、重启和 fork as-of 全覆盖。
- 同一角色多 active Scene 触发 quarantine，存量 v1 World 原字节运行。
- 零 Objective 的酒馆合法；Objective 完成不产生未声明副作用。
- Presentation 越权模板编译失败，玩家/Observer 输出不含 NPC 私有 Claim、Affect 或 Memory。
