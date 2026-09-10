# ADR-0085：有界顺序行动组与逐步表现

- 状态：Accepted（2026-09-09 用户授权实施；验收见实施规格）
- 日期：2026-09-09
- Supersedes（局部）：ADR-0046 的组内 Action ID 排序、ADR-0077 的单次 speak 限制、ADR-0083 的唯一 Action 表现绑定
- Extends：ADR-0072、ADR-0074、ADR-0084

## 背景

单 Action 限制不能表达“移动后发言”。自由表现描述又可能声明未裁定的移动，使位置事实与 Observation/Memory 分裂。直接开放长 Action 数组则会扩大不可插入区间，并允许模型提前使用行动后才获得的信息。

## 决定

1. 新世界通过 Manifest v7 的 `actionGroupPolicy.version = bounded-action-group/v1` 显式启用 `submit_actions/v4`。Manifest v2～v6、submit_actions/v1～v3 保持旧语义，不根据 Provider 输出隐式升级。
2. 每个 Character Provider 调用最多两个顺序 Action；合法类型为 speak@1、move@1、take@1。两步时必须恰好一次 speak 和一次 move 或 take，允许两种顺序；abstain 必须零步。现有 Root Reflection 继续独立处理，Reaction Reflection 仍为零。
3. 行动组在全局队列中占据一个位置，以第一步的旧排序键定位；同组按 proposalOrdinal 执行。组内不插入其他角色，不调用模型、不重新调度，不等待异步 I/O。Director 与人工玩家继续沿用现有输入入口。
4. 每一步基于之前已接受的候选事件重裁定。第一步拒绝后，后续步骤记为 skipped / PREVIOUS_ACTION_REJECTED，不调用领域规则、不产生成功表现。先成功的步骤不会因后续领域拒绝撤回。整个 Round 的 Authority/Event/Head/Outbox 仍原子提交。
5. Action 观察范围逐步计算。移动后首先应用 Scene membership 事件，再计算后续发言范围；未执行步骤只给行动者自我反馈，不刺激其他角色。既有每观察者候选合并保持不变，不为每一步增加 Provider 调用。
6. 模型提案仍基于同一冻结上下文。行动组不提供新知识：进入未知房间、阅读新内容之后才可决定的行为，必须等待后续正式调用。
7. v4 的每步可带 `manifestation: { independent, onSuccess }`。两数组使用闭合表现码，共最多八项且不重复；声音只能在成功 speak 中，步态只能在成功 move 中。原始文本不能进入新版 Manifestation Fact。初始目录只覆盖瞬时自我表现，不支持持久姿态、外观效果、对象接触或 Pack 自定义目录。
8. 新版基础文案由已接受表现码确定性生成，再走既有已授权 Observation / Presenter / Memory 管线。所有表现均不授予位置、视野、持有或内部心理事实。v7 暂不接收旧式人工玩家自由文本 manifestation；玩家单 Action 入口保持可用。
9. Reaction 调用预算保持 3 waves / 8 calls / 每角色 2 calls，不因 Action 数量增加而改变。Cycle 耐久记录有效上限 2 与闭合 Action 类型集合，并校验与 Manifest 相符。

## 迁移与恢复

- World SQLite v16 → v17 只添加 nullable `action_group_max_actions`，值只能是 2。v16 的 max_actions_per_call=1 列与 CHECK 保留，表示旧 responsive 基础配置；非空扩展列覆盖有效动作上限。旧行扩展为 NULL，旧 Cycle 内容及 Hash 不变，不重建父表或触发级联删除。
- Logical Authority v7 显式传输扩展列；v6 导入补 NULL，v4/v5 沿用旧升级路径。旧导出不得携带扩展字段。
- 新行动组 Round Authority 使用 schemaVersion 4，保存原始组绑定、逐步裁定及可重算组排序键。历史 Authority 不改写。
- 新建世界可通过 `worldpack activate ... --action-groups` 启用；不提供活动世界的原地语义迁移。
- Provider dispatch 歧义不重发；已耐久 validated 输出按 v4 校验恢复，已提交 Round 按原子账本重建。

## 代价与非目标

最多两步构成不可插入区间。“说再见后立刻离开”不能在组内被其他角色挽留；希望等待回复时，只提交发言。复杂抢夺、攻击中断、连续物理操作、房间内精确站位、实时运动与自由文案审核不在本次范围内。

## Evidence → Finding → Path

- Evidence：RoundCoordinator / ReactionScheduler 原来逐 Action ID 排序；manifestation 绑定唯一动作，Cycle 的 SQL 约束固定 max_actions_per_call=1。
- Finding：需要同时版本化协议、候选执行、表现绑定和耐久 Cycle，不能仅将模型 Schema 的 maxItems 改成 2。
- Path：闭合协议 → 分组排序与逐步裁定 → Scene/Observation → Cycle/传输迁移 → 重启与硬终止矩阵 → 完整 check。
