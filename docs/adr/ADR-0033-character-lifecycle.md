# ADR-0033：Character Lifecycle 与 Runtime Availability

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §13](../spec/implementation-v0.2.md#13-时间角色生命周期与-branch)

## 决策

角色领域状态固定为 active、incapacitated、dead、departed；Agent 运行可用性固定为 provisioning、ready、session_lag、model_unavailable、budget_unavailable、offline、disabled。两类状态独立，死亡或离场不删除历史。

## 结果

Phase 0 的最小模拟不实现完整生命周期状态机。Phase 1 以后 Rulebook 决定领域状态，运行时服务只报告可用性，二者不得相互伪装。
