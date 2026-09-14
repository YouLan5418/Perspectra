# ADR-0096：反应依据策略与响应式 v2

- 状态：Accepted（用户于 2026-09-14 裁定：效果落在谁身上谁算 `direct`；档案由世界选择；失败默认可观察；证据落库）
- 日期：2026-09-14
- Extends：[ADR-0093](ADR-0093-interaction-definition-abstraction.md)（交互定义抽象）
- 上位规格：[交互定义实施契约 §5、§7](../spec/interaction-definition-v0.1.md)
- 关联：[ADR-0095](ADR-0095-relation-class-binding.md)（关系类绑定）、[ADR-0088](ADR-0088-versioned-keyword-recall.md)（关闭开关属世界内容的原则）

## 背景

规格 §5 要求反应候选带一份固定证据：`sourceEventRef`、`observationId`、`observerCharacterId`、`actionId`、定义引用或专用入口身份、`roleClass`；`roleClass ∈ {self, direct, addressee, witness}`；且**仅观察到失败尝试的旁观者不得被标为效果 `direct`**。规格还要求新 `responsive/v2` 按 `direct → addressee → witness` 再按角色 ID、来源事件序、jobId 排序，同时旧 `responsive/v1` 的候选顺序与预算哈希逐字节保留。

实现前核查发现两件事：

1. `roleClass`、`reaction-evidence` 在生产代码里**零命中**——这半边是空白，不是部分完成。
2. "失败尝试产生刺激"这条**初稿写错了**：协调器的观察/刺激循环没有 `accepted` 守卫，失败**今天就已经**产生观察与刺激，只是硬编码、无开关。

## 决定

1. **`direct` 从定义的受锁策略读，不从事件里猜。** 定义指名一个注册、锁住的 `interaction-reaction-evidence/v1` 策略，列出**受影响的角色槽**；Host 把槽解析到实际角色，并核对那条角色有对应的耐久 Observation。空列表是真实答案（`take`/`drop` 里唯一角色是 actor，而 actor 在任何槽被查之前已是 `self`）。**否决**"扫事件里像角色 ID 的字段"——那是无类型启发式，规则不落在任何已声明的地方。
2. **受影响槽必须是角色类且是已声明角色**，否则激活失败。效果不可能落在实体身上。
3. **失败不落在任何人身上。** 只有成功的动作才有"效果落在谁身上"，这正是规格那句"仅观察到失败尝试的旁观者不得标为 direct"的另一面。失败默认可观察（与今天的硬编码行为一致），由世界声明的观察策略可关；**关闭只抑制知情范围，事实层照常写入 `action.rejected`**。
4. **档案由世界选择**：`reaction.json` 的 `profile` 编译进 Manifest，`responsive/v2` 与 `responsive/v1` 并存。符合 ADR-0088："停用必须是世界内容/Manifest 的显式选择，不是运行时 Host 开关"。
5. **证据落库**：刺激行增加可空列 `evidence_json`，进入 `stimulusEntryHash`；World SQLite 18 → 19 一次迁移。v1 行存 NULL，字节与条目哈希不变。
6. **分类器在 Root Round 与 Reaction Round 共用**——否则 wave 2 的刺激会是 wave 1 的特例。

## 后果

- 反应依据成为**耐久事实**：读一条刺激就能说出"为什么这个角色被加权、以什么身份"，不必重算。
- 采样顺序的差异是**行为差异**：v2 世界先触及效果落在其身的角色。
- 代价：一次数据库结构迁移（一列）与哨兵数字 18 → 19；`interactionPackageHash` 因新增策略组件而第四次变更（仓库内无外部钉子）。
- 被否决的替代：把证据作为纯派生视图（没有读者时等于没实现）；把 v2 固定绑给 v10（世界失去选择权，且把版本与档案绑成一件事）。

## 验证边界

- 分类：四个类各自的判据，含"actor 优先为 `self`"与"被点名但未落地不算 `direct`"。
- 证据：定义裁决的动作记定义锁，`speak`/`move` 记动作身份；`observerCharacterId`/`actionId` 逐条核对。
- 顺序：`direct` 在 `witness` 之前，同类按角色 ID；比较器是**具名导出**并单测——单元素列表不会调用排序器，内联闭包会变成只等到第二个角色出现才跑的未测代码。
- 回归：v1 世界的刺激行 `evidence_json` 为 NULL、条目哈希不变；v9 回合的 Authority 仍为 5。
- 端到端：一个真实世界包声明 `responsive/v2`，两个非玩家角色分别以 `direct` 与 `witness` 入候选。
