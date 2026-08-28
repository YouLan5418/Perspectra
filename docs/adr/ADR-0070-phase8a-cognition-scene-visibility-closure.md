# ADR-0070：Phase 8A 认知词汇与 Scene 观察范围收口

- 状态：Accepted
- 日期：2026-08-28
- Extends：ADR-0065、ADR-0066
- 上位契约：[Phase 8 实施规格 §5～7](../spec/phase-8-implementation-v0.1.md#5-basic-v1-主观状态)

## 背景

Phase 8A 独立审查确认了两个需要在 Memory 与 Context 接线前收口的边界。第一，CharacterGoal 的 `objective.kind` 已进入 Basic v1 Registry 和 Genesis 校验，但时态 Projection 读取事件前缀时没有再次按相同词汇校验。第二，Scene v2 已区分 `direct` 与 `private`，但旁观者是否收到发生级观察、发生级观察能否携带自由 `reason` 尚未形成精确的冻结解释。

如果读取端接受未知 Goal objective，未来 Reflection 写入错误值后会形成只能在下游暴露的毒化历史。如果 occurrence-only Observation 保留 Rulebook 的自由原因文本，旁观者可能在看不到动作正文时仍从原因字段获得相同私密信息。

## 决定

1. CharacterGoal 的 `objective.kind` 在编译、Genesis 和 Projection 重建三条边界统一限制为 Basic v1 的 `registered | narrative`。未知值在 Projection 重建时 fail-closed，不自动映射或忽略。
2. `direct` 表示只向 actor 和显式 recipient 交付完整 Observation；其他在场角色不收到 Observation。这适用于不应向旁观者暴露“互动是否发生”的定向动作。
3. `private` 表示 actor 和显式 recipient 获得完整 Observation，其他当时可观察到 actor 的在场角色只获得 occurrence-only Observation。它适用于旁观者能察觉互动发生、但无权知道内容的私语或私密互动。
4. occurrence-only Observation 只保留固定结构：`actionType=private_interaction`、actor、裁定 status 和 `contentVisibility=occurrence_only`。不得包含 speech、参数、target、Rulebook 自由 `reason` 或其他内容派生字段。
5. `scene_public` 继续向 Scene 可见观察者交付完整内容，`self` 继续只向 actor 交付。四种 scope 的语义作为 Scene Decision v2 的冻结契约，后续变化需要新版本和 superseding ADR。

## 后果

- Projection 对 Goal 词汇的验证与已锁定 Registry 保持一致，未知 objective 不会进入 Memory 或 Context。
- `direct` 与 `private` 不再是两个实现者可自由解释的近义词；创作者或 Rulebook 必须根据旁观者是否可感知“发生性”选择 scope。
- occurrence-only 记录可以进入 Memory 捕获和 Context，而不会通过 `reason` 间接泄漏正文。
- 已提交的 Phase 8A Fixture Hash 不变；变化只影响未来生成的 occurrence-only Observation 内容。

## 验证

- 未注册的 `objective.kind` 在 Cognition Projection 重建时被拒绝。
- `direct` 的旁观者集合为空，`private` 的在场旁观者进入 occurrence-only 集合。
- 私密动作即使携带可识别的 reason canary，旁观者 Observation 也不包含该 canary 或 `reason` 字段，recipient 仍能获得完整结果。
