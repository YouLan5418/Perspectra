# ADR-0062：Pack 公开对白进入角色观察与 Memory

- 状态：Accepted
- 日期：2026-08-25
- Extends：ADR-0052、ADR-0059、ADR-0060
- 上位契约：[Phase 7 实施规格 §8](../spec/phase-7-implementation-v0.2.md#8-酒馆社交参考-pack)

## 背景

Core v2 已能权威提交 `character.speak`，但旧 Observation 兼容路径只在悬疑 Rulebook v4 中携带公开对白正文。对 Pack Manifest v3 而言，这会让在场角色只知道“某人执行了 speak”，却不能记住“某人说过 P”，无法验证交流记忆与命题真假的边界。

## 决定

1. Manifest v3 的已接受 `character.speak` 结果把公开的 `{ characterId, text }` 放入同 Scene 可见角色的 `observation.upsert.content.speech`。
2. Observation 仍由 Scene 的观察者与可见性决断逐角色生成；不在 Scene 或不可见的角色不会收到正文。
3. Memory 只捕获这条已提交 Observation，并记录其 source mapping；公开对白不会自动生成“P 为真”的 Claim。
4. 旧 Manifest v1/v2 的 Observation、Authority 和 Hash 字节保持不变。既有悬疑 v4 行为保持不变。
5. 此能力属于通用 Application 观察接线，不把酒馆词汇或题材规则写入 Kernel。

## 后果

- Alice 可以记住“Bob 说过 P”，但不能因此获得 P 的真值 Claim。
- 玩家 Session 只接收自己已获授权的 Observation，不会因此得到 Bob 的私有 Claim 或 Memory。
- 同一公开对白可由 Event 前缀重建，并接受 Branch/as-of 隔离。

## 验证

- 酒馆多轮 E2E 证明 Alice 的 Observation/Memory 含 Bob 的公开原话，而 Claim 不含该命题。
- 角色离场后不再获得后续对白；fork 子分支不包含 forkSeq 之后的原话。
- 旧 v1/v2 Golden、悬疑 v3/v4 生命周期和 P0～P6 回归保持通过。
