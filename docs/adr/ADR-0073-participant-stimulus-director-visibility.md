# ADR-0073：参与者刺激裁剪与 Director 可见性闭环

- 状态：Accepted
- 日期：2026-08-29
- Extends：ADR-0064、ADR-0066、ADR-0068、ADR-0070
- 上位契约：[Phase 8.1 加固规格 §2](../spec/phase-8.1-hardening-v0.1.md#2-角色刺激与-director-权限闭环)

## 背景

`v0.3.0` 虽然在动作提交后按 Scene audience 生成不同 Observation，但参与者调用发生在正式裁定前：完整玩家 Action 被作为 stimulus 和 Memory query 输入交给所有已调度 NPC；Director 又按事件类型收集所有 Scene 的全部 `character.speak`。这使正确的提交后观察边界没有覆盖提交前 Provider 输入。

## 决定

1. 玩家 Action 在参与者调用前由同一 Rulebook、同一事件前缀进行一次无副作用基础裁定，取得最大观察范围；后续正式玩家裁定复用该结果。
2. Character Provider 的刺激按动作时刻 audience 分成 full、occurrence-only 和 none。full 保留原 ActionRequest；occurrence-only 使用 ADR-0070 的固定发生级字段；none 使用不含原 actor/action/content/recipient 的上下文占位。
3. 裁剪必须先于 Recall query、Cognitive Context、ContextAssembler、Renderer 和参与者 candidate Hash。无权内容不得通过 query、Hash 或 source metadata 间接出现。
4. Director 只接收当前 focal Scene 中 `scene_public` 或明确 `director_visible` 的内容。权限与 Scene 过滤必须在候选、计数和聚合前完成。
5. Directive target 的 source ref 必须证明该 target 当前属于 focal Scene；缺少准确来源时 Context 构建 fail-closed。
6. Agent 调度读取 `schedulableCharacterIds`；Director 调度读取 `directorEligible`，不再把 Director eligibility 等同于某个 NPC actor 的 Scene membership。

## 后果

- 动作提交前和提交后共用同一 Scene 可见性语义。
- 私密玩家输入不会通过 Prompt、Memory Recall 或 Hash oracle 进入旁观角色。
- Director 不再是跨 Scene 或私密对白的读取后门。
- 公开刺激保持原字节；只有此前未正确裁剪的上下文产生新 Hash。

## 验证

四种 scope、角色身份、跨 Scene、Memory query、Director bytes、source refs、重启和同键重放组成独立 canary matrix。测试 oracle 不复用生产裁剪助手构造 expected。

