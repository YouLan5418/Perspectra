# ADR-0033：Character Lifecycle 与 Runtime Availability

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §13](../spec/implementation-v0.2.md#13-时间角色生命周期与-branch)

## 决策

角色领域状态固定为 active、incapacitated、dead、departed；Agent 运行可用性固定为 provisioning、ready、session_lag、model_unavailable、budget_unavailable、offline、disabled。两类状态独立，死亡或离场不删除历史。

## 结果

当前 V0 已将领域生命周期写入版本化 Event、CharacterView 与 Rulebook 行动资格判断；死亡、失能和离场不会删除历史。`CharacterRuntimeAvailabilityService` 独立保存 provisioning、ready 与各类降级状态，Scene 调度、Agent eligibility 和 Health 消费该状态，但它不进入 World Event 或世界 Hash。两类状态不得相互伪装。
