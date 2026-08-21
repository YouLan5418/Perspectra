# ADR-0023：玩家绑定、玩家先行和 Round FIFO

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §5](../spec/implementation-v0.2.md#5-玩家输入roundtick-和活性)

## 决策

一个本地用户绑定一个玩家角色。每条受理且非重复的玩家世界输入独立形成一个 Round 和一个 Tick；同 Branch 按 Inbox 顺序严格 FIFO。玩家 Action 固定在 phase 0，NPC 和 Director 基于玩家候选状态在 phase 1 提案。普通文本逐字成为 `character.speak`，不经过模型改写。

## 结果

重试依赖耐久 idempotency key；领域拒绝仍消耗已受理回合。Phase 0 的 `WorldSimulation` 固定玩家 Action 在提案 Action 之前，并验证重启后同一输入返回同一 Bundle Hash。
