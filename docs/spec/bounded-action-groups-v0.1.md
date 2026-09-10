# 有界行动组 V0.1 实施规格

| 属性 | 值 |
|---|---|
| ADR | [ADR-0085](../adr/ADR-0085-bounded-action-groups.md) |
| 状态 | 已实现；2026-09-10 完整工程检查通过，真实模型试玩待验 |
| 协议 | submit_actions/v4、Manifest v7、Round Authority v4 |
| 持久化 | World Schema v17、Logical Authority v7 |

## 1. 输入协议

```json
{
  "schemaVersion": 4,
  "decision": "act",
  "actions": [
    {
      "actionId": "move:first", "actorId": "character:alice",
      "actionType": "move", "actionVersion": 1,
      "parameters": { "locationId": "location:kitchen" },
      "manifestation": { "independent": ["frown"], "onSuccess": ["slow_walk"] }
    },
    {
      "actionId": "speech:second", "actorId": "character:alice",
      "actionType": "speak", "actionVersion": 1,
      "parameters": { "text": "原来你在这里。" },
      "manifestation": { "independent": [], "onSuccess": ["quiet_voice"] }
    }
  ]
}
```

Actor 必须匹配 Host 授权；动作类型同时受参与者授权与组词汇限制。`actions` 零至两项，act 与非空数组对应；abstain 与空数组对应。Action ID 不改变组内顺序。Reflection 沿用现有独立权限和预算，不是组内第三个动作。

## 2. 表现词汇与不变量

初始词汇：smile、frown、nod、shake_head、avert_gaze、quiet_voice、trembling_voice、slow_walk。

- independent 表示本次尝试中独立成立的自我表现，不能包含声音或步态。
- onSuccess 仅在对应动作 accepted 时发生；quiet_voice/trembling_voice 绑定 speak，slow_walk 绑定 move。
- 组内跳过的步骤不发生任何表现，包括其 independent。
- 不接受自由 description、外观伤口、持有关系或其他角色的反应。未知表现使该 Provider 输出 schema-invalid，默认不重试。
- 坐标、视野和物品能力均由正式规则定义，表现不得授予效果。

## 3. 裁定与观察

组排序键由首步确定，组内按 proposalOrdinal。每一步在当前候选事件前缀上裁定，成功 move 追加 Scene transition。后续 speak 使用更新后的 Scene audience。拒绝停止剩余步骤，accepted prefix 保留；skipped 在 Authority 明确记录，自我 Observation 提供失败反馈，不广播到其他角色。

根轮和 Reaction 使用相同组规则；Reaction 每 wave 仍只有一次模型决策，不能根据组内新信息生成第二步。对其他角色的刺激按现有观察者候选合并，调用预算不变。

## 4. 激活与使用

新建 expressive-social Pack，然后编译，最后显式启用：

```powershell
corepack pnpm@11.7.0 worldpack init --profile expressive-social ./examples/action-group-demo
corepack pnpm@11.7.0 worldpack compile ./examples/action-group-demo --out ./examples/action-group-demo.worldpack.json
corepack pnpm@11.7.0 worldpack activate ./examples/action-group-demo.worldpack.json --data-dir ./action-group-runtime --action-groups
```

激活创建世界；Provider 仍由 Host 绑定，并需消费 v4 Tool 契约、返回 v4 输出。未带开关的 v4 Pack 继续生成 Manifest v6。人工玩家仍为单 Action 入口；v7 不接受旧自由文本表现输入。

## 5. 阶段验收

1. 协议：零/一/两步、反向 ID、非法动作组合、未授权角色、表现前置条件、旧版协议拒绝隐式升级。
2. 执行：move→speak 与 speak→move、物品竞争、失败停止、部分成功、组不可插入、逐步 Scene 可见性、自我 skipped 反馈。
3. 恢复：重复受理不增加效果、Provider durable response 恢复、World COMMIT 前后硬终止、Cycle 上限与 Manifest 一致、v16/v6 历史兼容。
4. 交付：逐文件四项 100% 覆盖率及 `corepack pnpm@11.7.0 check` 全绿。

## 6. Evidence → Finding → Path

以协议单测、Coordinator/Scheduler 场景测试、迁移及导入导出、真实子进程终止测试作为证据。未通过的门禁必须保留为未完成，不得降低覆盖率、放宽 Hash 或将普通异常冒充硬终止。

2026-09-10 执行 `corepack pnpm@11.7.0 check`，退出码 0：类型、lint、945 项覆盖率测试、P0～P6 集成、3 项性能测试和 36 项硬终止测试通过；生产 src 逐文件四项覆盖率均满足 100% 门禁。

| Evidence | Finding | Path |
|---|---|---|
| `packages/agents/src/submit-actions-v4.test.ts` | 非法组合与自由表现无法进入新协议 | 保持闭合协议，扩词需明确版本与规则 |
| `packages/application/src/round-coordinator.test.ts`、`reaction-scheduler.test.ts` | 移动后发言、先说后移动失败、抢同一物品、失败跳过均按组裁定 | 根轮和反应轮共用组语义 |
| `tests/action-group.integration.test.ts` | 实际 Application 的 Context、Memory、反应与导入导出可闭环 | 已修复导入校验遗漏 Reaction settlement hash 的问题 |
| `tests/crash.test.ts`、`tests/workers/action-group-crash-worker.ts` | 提交前后硬终止恢复不会重复执行组内效果 | 保持整个 Round 原子提交与耐久 Provider response 恢复 |
| `packages/store-sqlite/src/logical-transfer.test.ts` | 有数据的 v16 升级及旧逻辑格式兼容通过 | 旧世界不自动启用新动作语义 |

以上为脚本 Provider 的工程验证；尚未证明真实模型在长期游玩中的组合选择、闭合表现自然度与失败理解质量。真实模型验收应使用新世界与 v4 Provider，分别游玩进门后说话、离场告别、多人争抢物品和移动被拒绝场景，并检查事件、各角色观察及后续记忆的一致性。
