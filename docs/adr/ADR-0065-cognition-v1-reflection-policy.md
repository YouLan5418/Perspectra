# ADR-0065：Basic v1 主观状态、Reflection 与确定性心理策略

- 状态：Accepted
- 日期：2026-08-26
- Extends：ADR-0035、ADR-0055
- Supersedes：ADR-0055 中“关系只能以普通 Claim/题材插件表达”的收窄；继续保留 Kernel 不用通用心理公式解释关系的边界
- 上位契约：[Phase 8 实施规格 §5～6](../spec/phase-8-implementation-v0.1.md#5-basic-v1-主观状态)

## 背景

Phase 7 已证明 Claim、初始 Goal 和角色 Memory 隔离，但无法事件化表达“信任能力却怀疑诚实”、并存情绪、未解决矛盾、承诺与对话开放事项。若只把这些内容写入 Portrayal，它们不能 as-of 重建；若用统一情绪加减分解释事件，又会把一种心理学假设固化为 Kernel 行为。

## 决定

1. Phase 8 注册版本化 Basic v1 词汇和时态主观状态 Projection：SubjectiveClaim、CharacterGoal、RelationshipAttitude、AffectEpisode、InnerTension、Commitment、OpenLoop。awareness 基础词汇为 conscious、partially_conscious、unrecognized，各状态可收窄允许集合。它们是角色私有认知，不是外部世界事实或 Capability。
2. Claim stance 固定为 believed、suspected、doubted、denied；未知表示缺少 Claim。Claim 不支持 unrecognized awareness，同一角色/命题同时最多一个 active Claim。
3. Relationship type 固定为 affection、trust、distrust、respect、dependence、obligation、resentment、fear、envy、rivalry。关系有方向、可按 facet 并存，不归一化、不自动镜像、不计算总好感。
4. Affect type 固定为 joy、sadness、anger、fear、anxiety、shame、guilt、relief、hope、disgust、pride、loneliness、surprise、curiosity。多个 Episode 可并存，内部状态只有经行动/观察外显后才对他人可见。
5. InnerTension 包含 2～4 个 Pole，tendency 为 pursue、avoid、preserve、change、express、conceal。Kernel 不计算胜者，采取符合一极的行动不自动解决冲突。
6. Goal 状态为 active、blocked、completed、abandoned、failed；registered Goal 可由权威条件完成，narrative Goal 只能受控主观更新。父 Goal 只组织，不自动分解或传播。
7. Commitment 状态为 active、fulfilled、breached、released、renounced；OpenLoop kind 为 question、request、offer、decision_pending、follow_up，状态为 open、answered、resolved、dismissed、expired。answered 不等于 resolved。
8. `submit_actions/v2` 允许一个可选 Reflection Batch；通过协议验证后规范化为 `character.reflect@1`。Reflection 只能修改 actor 自己、必须引用本次 ContextReceipt 授权来源、受数量/幅度/awareness/文本/active 容量限制，并整批原子接受或拒绝。
9. 模型不能创建新的 unrecognized 状态，不能使用同轮尚未裁定结果，不能写其他角色心理、Memory、Scene、实体或 Capability。错误 narrative Claim 可以存在，但不能影响外部权威规则。
10. 确定性 Cognitive Policy 只做 Genesis、registered Goal/Commitment 结果、明确 speech act 的 OpenLoop 和 Tick/来源结构维护。不内置自然语言情感分析或“事件→统一情绪/关系分数”公式。
11. 认知更新阶段固定在全部外部 Action 与动作时刻 Observation 之后；顺序为 Reflection、注册结果 Policy、Tick 维护。所有变化带来源、Policy 版本、Candidate/前后 Hash 和 Receipt，从下一轮进入 Context。

## 后果

- 创作者可以表达复杂甚至矛盾的心理，而不把心理状态变成外部事实或单一数值人格。
- 同一客观事件可让不同角色通过独立 Reflection 得到不同反应，Kernel 不替角色做心理解释。
- 明确词汇让 Pack、Projection、Context 和 Golden 可冻结；未来自定义词汇仍需受信任插件和新 ADR。
- 模型格式或认知提案错误不会阻塞合法外部行动；存储/来源/Hash 分歧仍 fail-closed。

## 验证

- 所有状态在 restart、full replay、snapshot、fork as-of 中 Hash 一致且不跨角色/Branch。
- trust:competence 与 distrust:honesty、多个 Affect 和多 Pole Tension 可同时 active。
- Reflection 跨角色、future source、超幅、超容量、终态重写和部分 Batch 全部拒绝。
- 自然语言中出现情绪词不会自动改变 Affect/Relationship；只有注册 Policy 或合法 Reflection 产生事件。
- “X 说 P”、角色相信 P 和 P 的权威真假始终是不同来源链。
