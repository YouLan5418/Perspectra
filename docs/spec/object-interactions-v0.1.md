# 对象交互 V0.1 实施规格

| 属性 | 值 |
|---|---|
| 决策 | [ADR-0086](../adr/ADR-0086-object-interactions.md) |
| 状态 | 第一阶段已实现，2026-09-10 工程检查通过；真实模型试玩待验 |
| 世界 / 模型协议 | Manifest v8 / submit_actions/v5 |
| 目录协议 | object-interactions/v1 |
| 持久化 | 复用 World Schema v17、Logical Authority v7、Round Authority v4 |

## 1. 第一阶段范围

对象绑定交互定义，交互通过统一 `interact` 提交。创作者可选择支持的操作、自定义交互 ID 与显示名称、绑定已有物品。首版执行模板为 take/drop/give；不是任意条件或效果组合 DSL。目录最多 128 个定义和 4096 个对象绑定，ID 与名称最长 128 字符，未知字段、重复 ID、未知操作与悬空绑定均拒绝。

core 命名空间保留给同名操作；自定义交互使用自有命名空间，例如 `travel:collect-tickets`。命名与文案不会改变操作的前置条件和效果。操作作用于目标物品，give 的收件角色属于参数；首版不能将角色作为 interact 的 targetId。

## 2. 创作者入口

可复用示例 [possession-interactions.json](../../examples/world-packs/possession-interactions.json)。其中目标 `entity:ticket-bundle` 存在于 expressive-social 脚手架。

```powershell
corepack pnpm@11.7.0 worldpack init --profile expressive-social ./examples/interaction-demo
corepack pnpm@11.7.0 worldpack compile ./examples/interaction-demo --out ./examples/interaction-demo.worldpack.json
corepack pnpm@11.7.0 worldpack activate ./examples/interaction-demo.worldpack.json --data-dir ./interaction-runtime --interactions ./examples/world-packs/possession-interactions.json
```

目录是激活时输入的独立文件，规范化后进入 Manifest 和 specHash；不会改变已编译 Pack 的字节和 Hash。运行中的世界不重新读取目录。改目录后需使用新世界或新空运行目录，不提供活动世界的原地迁移。Provider 仍由 Host 绑定，需要授权 `interact` 并返回 v5 输出。

## 3. 模型输入与输出

Context 的 `affordances` 中，interact 项携带 `interactions` 数组，每项包含 targetId、interactionId、arguments 和 label。这些选项从耐久事件前缀重建，并参与 Context Hash。自己持有的物品、同地点无人持有的物品才能提供选项；其他角色的持有物不公开。递交候选进一步按当前 Scene 观察范围裁剪。

```json
{
  "schemaVersion": 5,
  "decision": "act",
  "actions": [
    {
      "actionId": "step:1",
      "actorId": "character:alice",
      "actionType": "interact",
      "actionVersion": 1,
      "parameters": {
        "targetId": "entity:ticket-bundle",
        "interactionId": "core:give",
        "arguments": { "recipientId": "character:bob" }
      }
    },
    {
      "actionId": "step:2",
      "actorId": "character:alice",
      "actionType": "speak",
      "actionVersion": 1,
      "parameters": { "text": "票据交给你保管。" }
    }
  ]
}
```

take/drop 的 arguments 必须是空对象，give 必须只含 recipientId。新协议不允许顶层 take；v4 也不接受 interact。人工玩家仍提交单个正式 Action，可使用 interact。

## 4. 裁定与不变量

| 操作 | 前置条件 | 成功效果 |
|---|---|---|
| take | 行动者 active；物品无人持有且同地点 | 物品由行动者持有 |
| drop | 行动者 active 且持有物品 | 物品位于行动者当前位置 |
| give | 行动者 active 且持有物品；收件者不同、active、同地点 | 持有者改为收件者 |

选项只是当前可尝试的提案，不预留物品。执行时按最新候选前缀重验，成功产生 entity.transferred，写入完整前后位置和持有状态。重建必须核对事件前缀和目的状态的互斥性。give 不声明收件者同意、承诺或作出反应；需要接受的邀请留待第二阶段。

每组最多一次 speak 和一次 move/interact。单个 interact 只产生一次持有状态迁移，不能封装多个物理操作。失败停止后续步骤，仅给行动者反馈；此前成功步骤保留。Group/Round 的持久化和幂等边界沿用 ADR-0085。

## 5. 游玩场景

| 场景 | 实际行为 |
|---|---|
| 两人同时选择拿同一物品 | 稳定顺序中的先成功者拿到；后者失败，其后续发言跳过 |
| 先说“给你”再递交，但对方已离开 | 发言保留；递交失败，物品仍在自己手中 |
| 先递交再说“交给你了” | 递交成功才继续说话 |
| 放下后别人拿起 | 两次独立交互；物品状态依次从自己持有、在地点、别人持有 |
| 修改目录名称为“喝掉”但 operation 为 drop | 仍只放下，不消耗物品；创作者应使用与效果一致的文案 |
| 执行中进程被终止 | COMMIT 前没有部分组效果；COMMIT 后恢复不会重复转移 |

## 6. 验收与恢复

2026-09-10 `corepack pnpm@11.7.0 check` 退出码 0：952 项覆盖率测试、生产 src 逐文件四项 100% 覆盖率、P0～P6 集成、3 项性能和 39 项子进程硬终止测试通过。覆盖 Scene 外同地点收件人裁剪、目录重复键及 UTF-8 拒绝，并验证仓库目录示例可实际激活、自定义交互 ID 按绑定规则执行。

| Evidence | Finding | Path |
|---|---|---|
| `packages/kernel/src/interactions.test.ts` | 完整持有循环、物品竞争、过期条件和损坏前缀均有确定性结果 | 保持闭合效果执行 |
| `tests/interaction.integration.test.ts` | 根轮、反应轮、Context、Memory、幂等与导入导出闭环通过 | 新世界显式启用 |
| `packages/world-pack/src/creator-cli.test.ts` | 目录激活严格校验；旧 Pack 拒绝误启用 | 创作者目录纳入 Manifest Hash |
| `tests/crash.test.ts` | 新增三个 v5 交互组硬终止窗口通过 | 沿用耐久 Provider response 恢复，不重发模型调用 |

SQL 无新增列；Reaction 的既有 allowed_action_types_json 保存 v8 的 speak@1/move@1/interact@1，与 Manifest 在提交和调度时核对。旧世界保持旧动作集合，旧逻辑导入不自动启用新交互。备份恢复应使用能理解 Manifest v8 的程序版本。

## 7. 后续边界

条件/效果组合、对象状态开关、消耗品和插件执行器尚未实现。角色交互的请求、接受、拒绝、过期与离场失效属于第二阶段，不允许在当前事务或行动组内等待对方模型。真实模型长期选择质量与创作者命名自然度仍需试玩验证。
