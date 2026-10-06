# 冻结规格来源

> 此目录保留历史决策／冻结规格的原结构和编号，不自动构成当前重构约束。当前实现首选 [current 架构](../current/architecture/README.md)，完成度见 [项目状态](../current/PROJECT-STATE.md)。
`implementation-v0.2.md` 是父目录 `2026-08-21_实施规格-Harness-Cordis-World-V0.2-report.md` 的逐字节副本。

| 属性 | 值 |
|---|---|
| 冻结日期 | 2026-08-22 |
| SHA-256 | `8e0c8fa13e6279e266ab18010ef50976d6277839c67ee57fd7682bd787afe4eb` |
| 用途 | Phase 0 实现和 ADR 的上位契约 |

验证命令：

```powershell
Get-FileHash -Algorithm SHA256 docs/spec/implementation-v0.2.md
```

## 通用内容路线

[通用内容与真实运行架构总纲](general-content-architecture-v0.1.md)冻结 Phase 7～11 的长期方向；[Phase 7 实施规格：最小通用内容闭环](phase-7-implementation-v0.2.md)交付最小 Pack、酒馆社交、通用交互和角色 Memory 隔离，已发布私有源码 `v0.2.0`。

[Phase 8 实施规格：可重建角色心智与多 Scene 上下文](phase-8-implementation-v0.1.md)冻结 `0.3.0` 候选范围：Basic v1 主观状态、Scene v2、Cognitive Memory v2、Character/Director Context、Checkpoint、缓存布局、Scripted Provider 调用边界与“雨夜同行”试金石。该范围已完成本机门槛，证据见 [Phase 8 完成报告](../archive/phase-7-9c/2026-08-29_阶段报告-Harness-Cordis-World-Phase-8-report.md)。真实 API Key、Runtime Author、Agent 接管玩家和自定义插件均不属于 Phase 8。

[Phase 8.1 加固规格](phase-8.1-hardening-v0.1.md)以 `v0.3.0` 为不可变基线，关闭参与者刺激与 Director 权限、跨平台排序、Session 死信连续性及派生持久化缺口，目标候选为 `0.3.1`；它不扩展 Phase 9 能力。

[Phase 9 实施规格：有界自主 Reaction Cycle](phase-9-implementation-v0.1.md)以 `v0.3.1` 为正式基线，把 P0 原型收敛为有界多 wave、稳定预算、可抢占、可恢复且可审计的 NPC 连续反应。[ADR-0077](../adr/ADR-0077-bounded-autonomous-reaction-cycle.md)已冻结正式方向；生产实现开始前仍必须完成 Phase 8.2 / 8.3 门禁。

Phase 8.2 正确性门禁与 Phase 8.3 固定数据性能基线现已关闭，证据见 [Phase 8.2 / 8.3 实施门禁收口报告](../archive/phase-7-9c/2026-08-31_Phase-8.2-8.3实施门禁收口报告.md)。Phase 9A 开工前仍须完成 v15 → v16、logical v5 → v6、四库恢复和玩家抢占矩阵评审。

上述数据库与抢占评审现已通过，正式四表 Schema、Logical v6 envelope、四库 Set Manifest 和线性化矩阵见 [Phase 9A 数据迁移、恢复集合与玩家抢占评审](../archive/phase-7-9c/2026-08-31_Phase-9A迁移恢复与抢占评审.md)。该评审授权按 9A → 9B → 9C 顺序实施，不授权直接复制 ADR-0076 原型两表。

这些文档扩展但不改写上述 V0.2 冻结规格；冲突由 Accepted ADR 的 supersedes/extends 关系处理。Phase 8 对长期总纲的实施时点调整及实施前边界收口见 ADR-0064～0068。

## 有界行动组

有界行动组的独立规格见 [有界行动组 V0.1](bounded-action-groups-v0.1.md) 与 [ADR-0085](../adr/ADR-0085-bounded-action-groups.md)：新世界显式启用两步顺序动作和逐步闭合表现，工程门禁已通过，真实模型试玩待验。

## 对象交互

对象交互的第一阶段见 [对象交互 V0.1](object-interactions-v0.1.md) 与 [ADR-0086](../adr/ADR-0086-object-interactions.md)：新世界通过对象目录提供拿取、放下和递交选项；工程门禁通过，任意条件/效果 DSL 与角色回应型交互尚未实现。

## 角色交互与玩家即时成立

[角色交互与玩家即时成立 V0.1](character-interactions-v0.1.md)与 [ADR-0087](../adr/ADR-0087-player-immediate-character-interactions.md)提出候选 Manifest v9：人工玩家可以在硬世界约束内先建立可解除的角色关系，目标通过同轮 ReactionView 和后续 Reaction Cycle 自主反制；自然语言先形成耐久、闭合的 PlayerSubmission，原始叙述不直接获得世界事实权威。当前为 Draft/Proposed，不授权实现或迁移。

## Memory 独立演进工作流

[记忆模块策略演进规划](../archive/memory-evolution/2026-09-06_规划-记忆模块策略演进.md)与[记忆模块实施规格](memory-evolution-implementation-v0.1.md)以 `a2cc212` 为调研基线，规划 M0～M4：包内职责拆分、长历史评测、版本化多路召回、经历来源分组与恢复验收。当前为 Proposed，尚未实施；不占用现有 Phase 编号，不修改 Accepted ADR 或旧 Manifest 行为。
