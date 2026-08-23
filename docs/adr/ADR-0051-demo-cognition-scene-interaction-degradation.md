# ADR-0051：Demo 的认知、Scene、通用交互与降级闭环

- 状态：Accepted
- 日期：2026-08-23
- Extends：ADR-0024、ADR-0031、ADR-0033、ADR-0035、ADR-0039、ADR-0050

## 背景

ADR-0050 已明确悬疑是架构试金石，而不是 Kernel 的产品方向。调查 Resolver 搬回 Demo 后，悬疑场景应继续验证最初的四项横向能力：角色认知隔离、Scene 权威调度、题材无关的连续交互，以及参与者失败时玩家 Round 仍可恢复地前进。

这些能力必须进入正式 `WorldApplication` 路径；仅在 Scenario 中伪造结果，不能证明将来替代酒馆时仍可承载其他题材。

## 决定

1. 新悬疑 Manifest 以插件契约锁定 `builtin:agent-context@2.0.0` 与 `builtin:scene-decision@1.0.0`。没有插件的存量 v3/v4 Manifest 继续按历史 Context/静态参与者语义运行，权威 Hash 不变。
2. World Commit 为受影响角色写入耐久 cognitive job。角色下一次 Provider 调用或显式 recall 前，必须按 CharacterView 的精确 as-of 水位完成 reconcile；只 capture 已提交 Observation、Claim、Goal。跨角色、跨 Branch、未来与 Summary 来源继续 fail-closed。
3. Context v2 按稳定顺序绑定 CharacterView、SceneDecision、Memory recall、玩家 Action 与 Capability；每个参与者分别保存 contextHash、Memory source refs 与 recall result hash。已提交 Round 重放 Authority，不重新检索 Memory。
4. `SceneDecisionService` 只从耐久 Scene/Location/Visibility/Lifecycle Projection 与非权威 Runtime Availability 决定唯一 active Scene、观察者和可调度角色。多 active Scene 是完整性错误；不可见、离场或 unavailable 角色不被调用。
5. `PlayerInputInterpreter` 是题材无关的候选 Action 适配器：普通非空文本为 `speak`，显式 `/move`、`/take`、`/act` 受当前 Affordance 限制。clarification 不进入 Inbox、不推进 Tick。悬疑解释器只优先处理明确调查语法，其余输入回落通用解释器。
6. Provider error、timeout、budget exhaustion、Memory catch-up failure 与 Session dead letter 都必须让玩家事实提交保持可恢复。参与者 terminal 写入 Round Authority/Event/Audit；Runtime Availability 与固定基数 Metric 反映降级，但不进入世界 Hash。恢复 Availability 或重试 dead letter 后，下一轮重新参与。
7. Provider timeout 使用独立 `provider_timeout` terminal，不再与普通 `provider_failed` 混同。Session dead letter 的状态变更与 `outbox.dead-lettered` Audit 在同一 SQLite 事务内完成。

## 后果

- Demo 的新增价值来自对通用架构的压力测试，而不是继续增加谜题规则。
- 角色可见事实、长期记忆和运行可用性保持三个独立边界；运行故障不会被写成角色知识。
- continuous shell 与 drill CLI 是本机验收入口，不是创作者 SDK、World Pack 或最终 GUI。
- cognitive worker 采用耐久 job + 调用前追平；当前不需要常驻后台线程，也不会因进程重启丢失待处理水位。

## 验证

- v3/v4 Golden Resolution、Event、Bundle、Authority、Manifest/Registry Hash 全等。
- Alice、Bob、侦探与玩家对相同查询得到不同 recall，fork 的父分支 future canary 不进入子分支。
- Scene 切换、离场、Visibility、Availability、同轮变化、重启和 fork as-of 均有测试。
- 通用文本、命令、clarification 和同一进程连续 shell 均走正式 Application/Inbox/Rulebook/Authority。
- 六种 Drill 都验证 Tick 前进、terminal、Audit、Metric、Health、零调用重放与恢复后的下一轮参与。
