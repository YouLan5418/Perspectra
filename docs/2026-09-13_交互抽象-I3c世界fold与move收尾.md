# 交互抽象 I3-c 世界 fold 与 move 收尾实施记录

| 属性 | 值 |
|---|---|
| 日期 | 2026-09-13 |
| 工作树 / 分支 | harness-cordis-world-v0-merged / fix/step-cue-normalization |
| 上位规格 | [交互定义实施契约](spec/interaction-definition-v0.1.md) §4 |
| 实施方案 | [V0.2 §8.1、§8.2](2026-09-13_方案-交互抽象与按需交互包-v0.2-report.md) |
| 实施基线 | I3-b `3f8e721` |
| 状态 | 世界 fold 与 `end-on-move` 落地；应用层接线待 I4 |

## 1. 本轮实现

I3-b 的 fold 只能随交互动作运行，而**唯一能触发关系收尾的是 move——它不是交互**。这一轮把 fold 从"某个定义的 fold"提升为"世界的 fold"。

| 模块 | 实现 |
|---|---|
| [contracts/interaction-definition.ts](../packages/contracts/src/interaction-definition.ts) | `InteractionLifecycleContext`（`{ host, events }`）；处理器签名由 `(context, events)` 改为 `(context)` |
| [interaction-runtime/registry.ts](../packages/interaction-runtime/src/registry.ts) | `#fold()` 抽出共用；`#lifecyclePlan(refs)` 改为按引用集合取闭包；新增公开的 `fold(host, events)`；世界计划在构造时由全部启用定义的 `lifecycleRefs` 取并集 |
| [interactions-basic/basic.ts](../packages/interactions-basic/src/basic.ts) | `contact:end-on-move`（相位 `relation-end`）；`base:end-contact` 引用它 |

**为什么改处理器签名**：`move` 没有交互定义、没有绑定、没有角色，而 `InteractionExecutionContext` 四者俱全。若沿用它，世界 fold 就得伪造一个定义与绑定才能调用处理器——那是把"能跑"伪装成"接上了"。改成只带 `host` 与当前候选事件，处理器就同时适用于两条路径。

**世界 fold 的计划是并集。** 每个处理器从快照自行判断是否适用，而不是由运行时按动作类型选择——运行时因此不需要知道任何关系语义。

## 2. `contact:end-on-move`

参与者任一方离开对方可达范围（不同地点、无共同 Scene）或不再 active 时，产生**单个** `character.relation-ended`，`reason` 取 `participant_moved` 或 `participant_unavailable`。事件名与 reason 取值都沿用冻结的关系事件词汇。

它读取关系的 `initiatorId`/`targetId` 与角色状态，**不按 relationKind 分支**；而"什么算可达"由它在基础包里自己定义——运行时始终不知道 `hand_hold` 是什么，这正是规格"不得由 Kernel 识别 hand_hold"的落点。

读不懂的关系（参与者 id 不是字符串、对方不在快照里、角色没有 Scene 列表）一律按"不可达"处理并结束，而不是猜。

## 3. 验证范围

新增 4 项（接触套件 11 → 15，交互用例合计 90）：

- move 之后（post-move 快照）fold 产生恰好一个结束事件，字段与 reason 精确匹配。
- 仍在同一地点与 Scene 时 fold 无输出；没有关系时也无输出。
- 参与者不再 active → `participant_unavailable`。
- 世界地址不匹配、授权集合含快照外目标 → fold 拒绝。
- 读不懂的关系（非字符串参与者 id、对方缺席、无 Scene 列表）各自按不可达收尾。

## 4. 仍未完成

| 项 | 状态 |
|---|---|
| **应用层在 move 之后调用 `fold()`** | **未接线**，属 I4（Application/Round 组合根） |
| `rulebook.ts` 里 move 直接调用 `endCharacterRelations` | **未改**。"move 无具体接触名分支"仍不成立——旧 v9 路径按冻结规则不得改动，新路径的替代尚未接入 |
| §6.2 退出选项优先保留与容量失败 | 未实现 |
| Host 侧把表现转成观察事实 | 未接入 |
| Manifest v10 绑定、`interact@2`、Round Authority 6 | 未接入 |

**I3 Gate 状态：** 关系收尾的**机制**已经齐全且被验证（相位计划、世界 fold、`end-on-move`），但它的**唯一生产触发者**是应用层 move 之后的调用，那一步没有做。因此 Gate 里"move 无具体接触名分支"依旧不成立，**I3 未关闭**。

## 5. Evidence → Finding → Path

E1：I3-b 的 fold 需要 `InteractionExecutionContext`，而 move 没有定义与绑定。F1：世界 fold 会被迫伪造定义，使"接上了"名不副实。P1：处理器上下文收窄为 `{ host, events }`，两条路径共用。
E2：规格 §8.2 要求 move 之后由"已启用关系定义"处理失效。F2：没有世界级计划时，move 无从选择处理器。P2：世界计划是全部启用定义 `lifecycleRefs` 的并集，处理器自行判断适用性。
E3：规格 §4 要求"不得由 Kernel 识别 hand_hold"。F3：若运行时按 relationKind 分支就违反了它。P3：语义留在基础包的处理器里，运行时只执行相位、闭包与预算。
E4：应用层接线属 I4。F4：本轮若声称 I3 完成会掩盖这一步。P4：如实记录，Gate 保持未关闭。

## 6. 工程验收结果

`corepack pnpm@11.7.0 check` 退出码 0。全量逐文件 statements/branches/functions/lines 均 100%。
报告合计 statements 12373/12373、branches 8691/8691、functions 2458/2458、lines 10517/10517。
lint 仅剩既有 `grouped-runtime.test.ts:25` 的 optional chaining warning。未调用真实模型；无新增持久化窗口。
