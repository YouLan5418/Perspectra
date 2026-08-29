# ADR-0072：Location 绑定 Scene 的确定性迁移

- 状态：Accepted
- 日期：2026-08-29
- Extends：ADR-0066
- 上位契约：[Phase 8 实施规格 §7、§15](../spec/phase-8-implementation-v0.1.md#7-scene-decision-v2)

## 背景

ADR-0066 已确定 Scene 与 Location 分离，并要求动作时刻按耐久事件前缀重算观察边界，但没有规定通用 `move` 如何触发 Scene 成员迁移。若参考内容在 Demo 代码里手写离场、入场或场景切换，Scene 就不再是创作者可声明的通用内容；若读取时直接按 Location 推断 Scene，又会形成第二事实源。

## 决定

1. 只有 Manifest v4 且 `scene-decision/v2` 的已接受通用 `move` 才触发本策略；旧 Manifest、Scene v1 和 Rulebook Golden 保持不变。
2. 目标 Location 可以对应零个或一个未关闭 Scene。对应多个未关闭 Scene 属于 `PROJECTION_INVARIANT_FAILED`，必须 fail-closed；系统不得任选其一。
3. 迁移完全从当前已验证事件前缀推导，并把 `scene.member_left`、必要的 `scene.closed`、必要的 `scene.activated` 和 `scene.member_joined` 追加到同一次 World Commit。读取端仍只重放 Scene Event，不根据当前 Location 临时猜测成员关系。
4. 角色离开某 Scene 后，若该 Scene 已无其他成员，则关闭它；角色进入 `created` 目标 Scene 时先激活再加入。移动到没有绑定 Scene 的 Location 时允许进入零 focal Scene。
5. 同轮参与者集合仍在 Round 开始时冻结；Scene 迁移只改变该动作之后的观察范围，并从下一轮开始改变 Agent 调度。
6. 本策略属于 Core Scene v2 行为，不含“旅行”“调查”“结案”等题材语义。Pack 只声明 Scene、Location 和初始成员，不提交任意迁移事件或脚本。

## 后果

- 创作者可以仅通过内容声明多地点 Scene，通用 `move` 即可形成可重放的离场、合流与下一轮调度变化。
- Location 继续表达物理位置，Scene Event 继续是互动边界的唯一耐久事实；两者不会在读取时混成隐式状态。
- 同一 Location 需要多个并行 Scene、嵌套 Scene 或自定义迁移规则时，必须等待受信任扩展机制，不能靠模糊匹配实现。

## 验证

- `scene-decision.test.ts` 覆盖离开、空场关闭、目标激活/加入、同 Scene 空操作、零目标 Scene、歧义目标和旧版本拒绝。
- `rainy-road-pack.test.ts` 覆盖三名角色同轮从路边避雨处迁移到站台，下一轮 Alice/Bob 恢复可调度，restart、fork 与 Hash 保持稳定。
