# 交互抽象 I4-d（第一片）：模型协议 submit_actions/v6

| 属性 | 值 |
|---|---|
| 日期 | 2026-09-14 |
| 工作树 / 分支 | harness-cordis-world-v0-merged / fix/step-cue-normalization |
| 实施基线 | `3510c18`（I5-c） |
| 上位规格 | [交互定义实施契约](../../spec/interaction-definition-v0.1.md) §7、[V0.3 §10.1](2026-09-14_方案-交互抽象与按需交互包-v0.3-report.md) |
| 状态 | 模型协议接通：**代理能在 v10 世界里提出交互**；反应周期能力随之落地。Authority 6 与恢复仍未做 |

## 1. 为什么它必须先做

在它之前，v10 世界**只能由显式玩家动作驱动**：视图算得出 `interact@2` 的选项，但发给模型的工具契约还是 v5、上下文管线在 v10 上退回 v4 的动作清单、回收答案的校验器还硬性要求 `actionVersion === 1`。链条断在"模型看不到"。I5-d 的"冻结真实模型用例"因此没有可跑的对象。

## 2. 本轮实现

| 模块 | 实现 |
|---|---|
| [contracts/action-group.ts](../../../packages/contracts/src/action-group.ts) | `SubmitActionsV6` 契约 |
| [contracts/reaction-cycle.ts](../../../packages/contracts/src/reaction-cycle.ts) | 周期能力增加 `['speak@1','move@1','interact@2']` 这一档；提供者提案联合类型加入 v6 |
| [agents/submit-actions.ts](../../../packages/agents/src/submit-actions.ts) | `validateV6`；`actions()` 的版本上界；行动组策略按版本产出 v2；`validateV2` 增加 `maximumActionVersion` 供分组协议复用 |
| [agents/context-v2.ts](../../../packages/agents/src/context-v2.ts) | `groupedOutput.tool` 加入 `submit_actions/v6` |
| [application/context-pipeline.ts](../../../packages/application/src/context-pipeline.ts) | `frozenInteractionTool` / `reactionFrozenInteractionTool`（v6、组策略 v2、交互参数形状为 `targetRef/bindingId/definitionRef/arguments`）；工具与 `groupedOutput.tool` 按 Manifest 版本选择；新增 `#afforded()` 作为两个上下文路径共用的"这条协议提供哪些动作、哪个版本"判据 |
| [application/round-coordinator.ts](../../../packages/application/src/round-coordinator.ts) | 校验器选择加 v10；周期草案动作清单改用 `manifestInteractionLabel` |
| [application/reaction-scheduler.ts](../../../packages/application/src/reaction-scheduler.ts) | 参与者能力清单用 `manifestInteractionVerb`；周期策略比对改为"声明必须**恰好等于**本 Manifest 的协议"；校验器选择加 v10 |
| [store-sqlite/reaction-cycle.ts](../../../packages/store-sqlite/src/reaction-cycle.ts) | 周期允许的动作清单加入 `interact@2` 一档（写入与读回两处） |
| [store-sqlite/world-store.ts](../../../packages/store-sqlite/src/world-store.ts) | 提交时按 Manifest 版本比对**精确标签**：v8/v9 要 `interact@1`，v10 要 `interact@2` |
| [kernel/world-spec.ts](../../../packages/kernel/src/world-spec.ts) | `manifestInteractionVerb` / `manifestInteractionLabel` 两个单一事实来源 |

## 3. 顺手关掉的那条缺口

I5-a 把"响应式 v10 世界打不开反应周期"钉成了一条**期望失败**的用例。它现在是**期望成功**：v10 的 Root 回合能开出周期，周期耐久地声明 `['speak@1','move@1','interact@2']`，波形也真的驱动了提供者。

原来那条用例的注释写着"谁修好它谁必须有意改这条期望"——这次就是有意改的。

## 4. 证据

三个用例，落在 `tests/interaction-pack.integration.test.ts`：

1. **模型驱动的角色真的动了手。** 同行者的提供者收到上下文，返回 `schemaVersion: 6` 的提案，其中 `interact` 带 `actionVersion: 2`，参数指向 `binding:umbrella-take` 与 `definitionRef: base:take@1`。结果是 `entity.transferred` 落在同行者身上——这只可能经由冻结路径裁定。
   同一条用例还断言**模型被展示的内容**：`submit_actions/v6`、`interact@2`、以及它必须指名的绑定。因为请求里的 affordance 段是以转义 JSON 字符串嵌在 provider request 里的，那条断言用正则匹配转义形式。
2. **反应波形提供同一批选项。** v10 的反应上下文里同样出现 `binding:umbrella-take` 与 `actionVersion:2`。**把 `#afforded()` 的 v10 分支回退，这条用例当场失败**（`expected ... to contain 'binding:umbrella-take'`）——说明这条判据是承重的，不是装饰。
3. **v6 协议是闭合的。** 直接对校验器断言：`actionVersion: 2` 接受且产出 `bounded-action-group/v2`；`actionVersion: 3` 拒绝；`take` 在 v6 下拒绝（且是在 `take` 被参与者允许的前提下拒绝的，所以拒绝来自协议而不是许可）；`schemaVersion: 5` 拒绝；**v5 仍然拒绝版本 2**，两种协议不能互借步骤。

## 5. Authority 6 与恢复仍未做

| 项 | 说明 |
|---|---|
| **Round Authority 6** | 输入已就位（`RulebookResolution.interactionTrace` 带 `definitionSetHash` / `resolvedRoleBindingsHash` / `ruleTraceHash`），协调器仍写 5。理由与前几轮一致：v6 的内容是"显式角色/定义依据绑定"，与 `responsive/v2`、`reaction-evidence/v1` 同批 |
| **响应式 v2 / 反应依据 v1** | 未做。规格 §5 的新证据结构与排序仍未实现 |
| **恢复** | v10 已有两个子进程硬终止点（I5-c）；Authority 6 的写入与恢复一致性与它同批 |
| 交互步骤上的表现 | 冻结请求带 `performance` 一律拒绝，因为"把被接受的表现转成观察事实"未接线 |
| 容量 fixture | I5-b 剩余 |

**I5-d（冻结真实模型用例）现在不再被协议阻塞**：链路已经通了，缺的是花真实调用去跑并单独报告。那一步需要真实 Provider，属于另一次运行。

## 6. 验证结果

- `corepack pnpm@11.7.0 check` 退出码 0。
- 逐文件 statements / branches / functions / lines 100%，全库汇总 100%；用例 1366 项（本轮 +3）。
- 未使用 `--update`；两个黄金基线字节未动；v6～v9 的 manifestHash 与 genesisHash 不变。
- 一处**行为变化**需要记明：v10 的周期现在声明 `interact@2` 而不是 `interact@1`。因为 v10 之前根本开不出周期，没有存量周期需要迁移。
- lint 仅剩既有 `tests/experiments/grouped-runtime.test.ts:25` warning。

## 7. Evidence → Finding → Path

E1：模型在 v10 上看不到 `interact@2`，代理只能 speak/move。F1：v10 世界的交互对 NPC 等于不存在。P1：工具契约 v6、选项过滤按版本、校验器 v6，三处一起接（§2）。
E2：周期能力声明的版本必须与 Manifest 的寻址版本一致，否则存储层拒绝开周期。F2：只接模型协议会得到"模型能下单、世界开不了轮"。P2：周期能力与提交校验同批落地（§3、§2 表）。
E3：`#afforded()` 的 v10 分支若只是装饰，回退它不会有用例失败。F3：无法区分承重与装饰。P3：反应用例断言波形上下文里的冻结选项，回退即红（§4 第 2 条）。
