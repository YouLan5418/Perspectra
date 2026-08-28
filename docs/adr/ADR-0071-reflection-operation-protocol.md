# ADR-0071：Reflection Operation 与确定性限制的精确协议

- 状态：Accepted
- 日期：2026-08-28
- Extends：ADR-0065、ADR-0068
- 上位契约：[Phase 8 实施规格 §6](../spec/phase-8-implementation-v0.1.md#6-reflection-与确定性-cognitive-policy)

## 背景

Phase 8 已冻结 Reflection 的权限、原子性、幅度和容量边界，但没有定义 `ReflectionOperation` 的精确字段，也没有给叙事内容的固定字节上限。若由 Provider 直接提交 `source` 或完整认知事件，它可以伪造来源；若不同调用点自行选择限制，Manifest 锁定的策略又不可重建。

## 决定

1. `submit_actions/v2` 的每个 Reflection Operation 精确包含 `operationId`、`kind`、`recordId`、`expectedStateHash`、`basisRefs` 和候选 `value`。模型不得提交 `characterId`、`source` 或顶层 `basisRefs` 到候选 `value`。
2. `expectedStateHash` 使用 `character-cognition-record-state/v1` 域，只绑定 kind、recordId、actor 和当前 value；新建记录必须为 `null`。同一 Batch 不得重复修改同一记录。
3. `basisRefs` 必须逐项精确存在于当前 `ContextReceipt.includedSourceRefs`；宿主在接受后以 ContextReceipt 自身生成 `source`，模型不能自报来源。
4. standard Reflection Profile 固定为：每轮最多 4 项、每种状态最多新建 2 条 active 记录、intensity/priority 单轮最多变化 200 permille、单项叙事内容最多 4096 UTF-8 bytes、整批最多 16384 UTF-8 bytes。该 Profile 进入 `cognitive-policy-registry/v1` Hash。
5. 校验先在不可变 CharacterCognitionView 上构造完整最终候选，再检查所有限制。结果生成 `cognitive-policy-receipt/v1`；拒绝也生成确定性 Receipt，但不产生 `character.reflect@1` Event。合法外部 Action 不受 Reflection 拒绝影响。

## 后果

- Provider 只能提议主观状态候选，来源、actor 与提交事件仍由宿主控制。
- 乐观状态 Hash 能阻止使用过期 Context 修改已变化的认知记录。
- Profile 数字成为 Manifest 可锁定的正式契约，未来变更必须新增 Profile/version，不能静默调整。
