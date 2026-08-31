# 冻结规格来源

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

[Phase 8 实施规格：可重建角色心智与多 Scene 上下文](phase-8-implementation-v0.1.md)冻结 `0.3.0` 候选范围：Basic v1 主观状态、Scene v2、Cognitive Memory v2、Character/Director Context、Checkpoint、缓存布局、Scripted Provider 调用边界与“雨夜同行”试金石。该范围已完成本机门槛，证据见 [Phase 8 完成报告](../2026-08-29_阶段报告-Harness-Cordis-World-Phase-8-report.md)。真实 API Key、Runtime Author、Agent 接管玩家和自定义插件均不属于 Phase 8。

[Phase 8.1 加固规格](phase-8.1-hardening-v0.1.md)以 `v0.3.0` 为不可变基线，关闭参与者刺激与 Director 权限、跨平台排序、Session 死信连续性及派生持久化缺口，目标候选为 `0.3.1`；它不扩展 Phase 9 能力。

[Phase 9 实施规格：有界自主 Reaction Cycle](phase-9-implementation-v0.1.md)以 `v0.3.1` 为正式基线，把 P0 原型收敛为有界多 wave、稳定预算、可抢占、可恢复且可审计的 NPC 连续反应。[ADR-0077](../adr/ADR-0077-bounded-autonomous-reaction-cycle.md)已冻结正式方向；生产实现开始前仍必须完成 Phase 8.2 / 8.3 门禁。

Phase 8.2 正确性门禁与 Phase 8.3 固定数据性能基线现已关闭，证据见 [Phase 8.2 / 8.3 实施门禁收口报告](../2026-08-31_Phase-8.2-8.3实施门禁收口报告.md)。Phase 9A 开工前仍须完成 v15 → v16、logical v5 → v6、四库恢复和玩家抢占矩阵评审。

这些文档扩展但不改写上述 V0.2 冻结规格；冲突由 Accepted ADR 的 supersedes/extends 关系处理。Phase 8 对长期总纲的实施时点调整及实施前边界收口见 ADR-0064～0068。
