# ADR-0058：PlayerSlot、Agent Controller 与角色限域 Observer

- 状态：Accepted
- 日期：2026-08-25
- Extends：ADR-0023、ADR-0030、ADR-0039、ADR-0041、ADR-0047
- Supersedes：新 Pack 中“玩家角色只能由人类直接提交 Action”的隐含限制；manual 仍为默认
- 上位契约：[Phase 7 实施规格 §7](../spec/phase-7-implementation-v0.1.md#7-playerslotcontroller-与-observer)

## 背景

用户希望允许 Agent 接管玩家角色，同时自己作为 Observer 只观察当前角色。若把 Observer 当作者全知视角，会破坏角色隐私；若 Agent 在后台持续运行，会改变 TURN_DRIVEN；若控制切换不进入耐久账本，重放和 fencing 无法判断某轮由谁控制。

## 决定

1. Character、Controller 和 Observer 是三个独立概念。PlayerSlot 在激活时绑定一个本机 Principal 和一个玩家 Character，支持 fixed、bounded customization 与 blank-slate 入口。
2. 控制模式固定为 `manual | agent_controlled`，manual 为默认。`CharacterControlBinding`、`ObserverBinding` 和单调 `controlEpoch` 耐久保存；每个 Round Authority 绑定 mode/epoch/controller class。
3. agent-controlled 模式中，人类 Observer 只读取绑定 Character 的获授权 View、Presentation、self state 和 Health；不得读取其他角色私有状态、author truth、raw Store、raw Memory、模型 Prompt/Response 或 chain-of-thought，也不能切换镜头。
4. Observer 只可执行 continue/pause/status/view/health/take-control/stop。每次 `/continue` 恰好触发一个 Round/Tick；`/continue N` 串行运行并在任何失败或屏障停止。无后台 autoplay。
5. 玩家角色 Agent 只获得绑定角色 capability 和 focal Scene。Agent abstain、timeout、failure、预算耗尽或非法输出使用注册 `core:wait@1` 回退；准确记录 terminal/Health，不伪造对白、Observation、Proposal 或 Memory。
6. manual/agent-controlled 切换只允许在 Round 边界且无 pending/claimed Round，经过 admission barrier、append-once ledger、Audit 和 controlEpoch 递增；切换不推进 Tick。
7. Phase 7 不提供 assisted mode、Observer 提示注入、多玩家、任意 runtime role switch 或后台世界推进。

## 后果

- 同一角色可以在人工扮演和 Agent 自主行动之间安全切换，且历史可判断每轮控制来源。
- Observer 模式保持角色限域体验，不退化为作者/管理员全知面。
- TURN_DRIVEN 仍成立；Agent 自主性由显式 continue 次数控制。
- Agent 故障不阻塞世界进度，也不会用伪造对白掩盖降级。

## 验证

- Observer 对 NPC View、private Memory、author preview、camera switch 和原始模型记录的请求全部 `OBSERVER_FORBIDDEN`。
- 控制切换覆盖 pending/claimed 屏障、epoch 冲突、重启、双实例 fencing 和幂等重放。
- `/continue` 每次恰好一 Tick；`/continue N` 有序停止；committed Round 不重新调用玩家 Agent。
- `core:wait@1` 覆盖 abstain、timeout、failure、budget 和 invalid output，且零伪造 Observation/Memory。
