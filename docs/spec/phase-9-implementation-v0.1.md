# Phase 9 实施规格：有界自主 Reaction Cycle

| 属性 | 值 |
|---|---|
| 契约版本 | `phase9/v0.1` |
| 状态 | Accepted implementation target（生产实现受 Phase 8.2 / 8.3 门禁） |
| 日期 | 2026-08-30 |
| 正式基线 | 私有源码 `v0.3.1` / `c2b3141` |
| 原型证据 | 分支 `prototype/reaction-cycle-p0` / ADR-0076 / P0 验证报告 |
| 目标 | 让 NPC 在一次玩家输入之后进行有界、可恢复、可审计的连续反应 |

> **实施门禁：** [ADR-0077](../adr/ADR-0077-bounded-autonomous-reaction-cycle.md) 已正式 supersede D-004、D-005 与 D-007 的相关边界，但不把原型分支直接提升为生产实现。开始修改生产代码前，仍必须先完成 Phase 8.2 正确性收口和 Phase 8.3 性能基线。ADR-0076 继续作为 Proposed 原型证据，不在原地改向。

> **权威警告：** Reaction Cycle 只能调度提案，不能成为第二套世界状态机。World Event Log 仍是唯一世界事实权威；Session、Projection、Memory、Context、Scheduler 和 Telemetry 都不得反写或替代世界事实。

> **恢复警告：** 模型调用一旦可能已发往外部 Provider，就不得因结果不明而自动重发。崩溃恢复必须优先避免重复副作用，并把不能证明安全的调用收敛为耐久终态。

## 1. 本阶段要回答的问题

现有 TURN_DRIVEN 世界把一条玩家输入解析为一个 Round。NPC A 与 NPC B 在同一 Round 内并行读取冻结候选，因此 B 只能在下一 Round 看见 A 的新发言；而下一 Round 又必须由玩家输入触发。这使“旁观世界自行运转”退化成玩家不断发送无意义输入。

Phase 9 引入 **有界自主 Reaction Cycle**：玩家根 Round 提交后，只要出现被授权、可见且尚未消费的 Observation，Host 就可以继续执行若干 NPC-only Reaction Round。每个 Reaction Round 对应一个 wave，多个 wave 串行推进；同一 wave 内 NPC 仍并行读取同一个冻结快照。

```text
Player command
  -> root Round commit
  -> Reaction Cycle open
       -> wave 1: A / B parallel proposals -> one reaction Round commit
       -> wave 2: observers react to wave 1 -> one reaction Round commit
       -> wave 3 or earlier terminal condition
  -> cycle terminal
```

本阶段解决的是“反应节拍不再依赖玩家重复戳世界”，不是让模型无限自治，也不是放宽每次模型调用的表达边界。

## 2. 范围与非范围

| 范围 | Phase 9 结论 |
|---|---|
| 玩家根 Round 后的 NPC 连续反应 | 纳入 |
| 有界多 wave 调度 | 契约一次冻结、实现分阶段交付 |
| 同 wave NPC 并行、wave 间串行 | 纳入 |
| 玩家输入抢占 | 纳入；当前 wave 收口后终止旧 Cycle，不恢复 |
| 每次 NPC 调用最多一个 `speak@1` | 纳入 |
| 稳定预算预留与并行 Provider 调用 | 前置门禁并纳入正式实现 |
| 崩溃恢复、租约、fencing、append-once | 纳入 |
| Context / Memory as-of 一致性 | 纳入 |
| 查询、取消、通知与 Presentation 关联 | 纳入 |
| Director 自主 wave | 不纳入 v1 |
| NPC 每次调用连续多个 Action | 不纳入 v1 |
| 同 wave 内看到其他 NPC 的提案 | 明确禁止 |
| 无界后台世界模拟、墙钟驱动日程 | 不纳入 |
| 真实 Provider 接入与密钥管理 | 独立于本规格；不得阻塞 Scripted Provider 验收 |
| Agent 接管玩家 | 不纳入 |
| 自定义插件扩展 Reaction 语义 | 不纳入 |

Phase 9 v1 只交付 `disabled` 与 `responsive/v1` 两种行为。更长时间的 `observer` 模式必须以新的版本化 Profile 和独立预算重新评审，不能通过提高 `responsive/v1` 上限偷偷引入。

## 3. 上位契约与 ADR 关系

本规格扩展而不改写以下权威文档：

- [冻结实施规格 V0.2](implementation-v0.2.md)；
- [通用内容与真实运行架构总纲](general-content-architecture-v0.1.md)；
- [Phase 8 实施规格](phase-8-implementation-v0.1.md)；
- [Phase 8.1 加固规格](phase-8.1-hardening-v0.1.md)；
- ADR-0038、ADR-0039、ADR-0040、ADR-0043、ADR-0044、ADR-0046、ADR-0064、ADR-0068、ADR-0071～ADR-0077。

[ADR-0077](../adr/ADR-0077-bounded-autonomous-reaction-cycle.md) 正式冻结：

1. NPC-only Reaction Round 的合法来源以及它对 D-004 / D-005 的替代范围；
2. `ActionOrderKey` 在无玩家 Action 时仍为全序的正式定义；
3. D-007 从“每 NPC 每玩家 Round 一次”收敛为“每 NPC 每 Reaction Round 最多一次、每 Cycle 另受总预算限制”；
4. 玩家抢占、Provider 歧义调用和行政操作的终态语义；
5. Schema、Logical Export 与 Backup 的版本升级。

该 ADR 的 Accepted 状态冻结架构方向，但不解除 Phase 8.2 / 8.3 门禁。本文件仍不是在门禁关闭前修改生产代码的授权。

本规格所称的前置门禁不是新增产品范围，而是两组可验证的基线工作：

| 门禁 | 必须关闭的风险 | 通过证据 |
|---|---|---|
| Phase 8.2 正确性收口 | post-commit availability 对账、Context 数据库迁移纪律、ProviderCall append-once 基础、Reaction Round 的正式 `ActionOrderKey` | ADR / migration test / crash reconciliation test 全部通过 |
| Phase 8.3 性能基线 | 长 Event Log 下 Context、Observation 和 Job 候选查询的重复全量扫描；并行调用前的稳定预算规划 | 固定数据集 benchmark、查询计划与回归阈值进入 CI 或发布门禁 |

若这些工作最终以其他版本名交付，门禁的语义和证据要求不变；Phase 编号不是绕过条件。

## 4. 术语与身份

| 术语 | 定义 |
|---|---|
| Root Round | 由玩家命令触发并成功提交的原始 Round |
| Reaction Cycle | 以一个 Root Round 为根、包含零到多个 Reaction Round 的耐久执行单元 |
| Wave | Cycle 内一次冻结参与者集合、并行生成提案并统一提交的步骤 |
| Reaction Round | 不含伪造玩家 Action、由一个 wave 触发的正式世界 Round |
| Reaction Job | 某角色对一组耐久刺激进行一次模型提案的可租约工作项 |
| Stimulus Bundle | 同一角色在同一 wave 中可见、已授权、未消费的 Observation 有序集合 |
| Cycle Budget | Cycle 级调用数、角色调用数、token 和 deadline 上限 |
| Stop Requested | 不再创建下一 wave，但允许当前已冻结 wave 按规则收口的耐久状态 |

身份必须使用品牌类型和完整 `WorldAddress`。建议的稳定主键关系为：

```typescript
type ReactionCycleId = Brand<string, 'ReactionCycleId'>;
type ReactionJobId = Brand<string, 'ReactionJobId'>;

interface ReactionCycleIdentity {
  world: WorldAddress;
  cycleId: ReactionCycleId;
  rootRoundId: RoundId;
  rootHeadSeq: WorldSeq;
  rootHeadHash: WorldHash;
}
```

`cycleId`、`jobId`、wave 编号和刺激 Hash 必须可由耐久输入确定性派生或受数据库唯一约束保护。进程重启不得产生第二个逻辑 Cycle。

## 5. 不变量

以下条件是 Phase 9 的硬边界：

1. 模型输出只能成为提案；Rulebook 是唯一裁决者。
2. World Event Log 是唯一世界事实权威；Cycle 表只记录调度与恢复事实。
3. 同一 branch 同时最多一个未终结 Cycle。
4. 同一 wave 的所有参与者读取同一个 `baseHeadSeq/baseHeadHash`。
5. 同一 wave 的 NPC 互不可见提案；只有 wave 提交后产生的新 Observation 才能触发下一 wave。
6. Reaction Round 不创建伪玩家 Action，不伪造 Session 输入。
7. 每个 NPC 每 wave 最多一次模型调用，每次调用最多提出一个 `speak@1`。
8. Cycle 必须被 wave、调用数、每角色调用数、token 或 deadline 中至少一个硬上限约束。
9. 任何模型可见输入都能由耐久记录按 as-of 重建。
10. SQLite 事务内不得等待 Provider、Memory、网络或其他异步 I/O。
11. Claim、commit、recovery 均执行租约所有权与 fencing 校验。
12. Canonical JSON、Hash 链、as-of、事务原子性与 fail-closed 完整性不得为演示放宽。

## 6. 版本化 Reaction Policy

Pack / World Manifest 必须显式声明版本化策略：

```typescript
type ReactionPolicyV1 =
  | { version: 'reaction-policy/v1'; mode: 'disabled' }
  | {
      version: 'reaction-policy/v1';
      mode: 'responsive';
      profile: 'responsive/v1';
    };
```

`responsive/v1` 的冻结上限为：

| 预算项 | 上限 |
|---|---:|
| `maxWaves` | 3 |
| `maxNpcCalls` | 8 |
| `maxCallsPerCharacter` | 2 |
| `maxActionsPerCall` | 1 |
| `allowedActionTypes` | `speak@1` |

旧 World 或缺少字段的 Manifest 必须迁移为 `disabled`，不得因升级二进制而自动开始自主运行。Host 可以通过运维配置收紧 deadline、并发数和 token 上限；不得在不改变 Profile 版本的前提下扩大上述语义上限。

token 与 deadline 的具体默认值属于 Provider/Host 运行参数，但每次 Cycle 开始时必须把最终有效值冻结为耐久预算快照，确保恢复后不受进程配置漂移影响。

## 7. Cycle 的创建与唯一性

Root Round 的提交事务按以下顺序完成：

1. 提交玩家 Action、Rulebook 派生事件、Observation、Tick 和 Round Authority；
2. 若 policy 为 `responsive/v1`，从本次已提交 Observation 计算首 wave 的候选 Job；
3. 若候选集非空，则在同一事务中写入 Cycle、预算快照和 wave 1 Job；
4. 若候选集为空，不创建空 Cycle；
5. 提交后仅发出 wake hint，耐久 Job 才是工作存在的依据。

数据库必须以 partial unique index 或等价约束保证同一 branch 最多一个 active / stop-requested Cycle。重复提交同一 Root Round 必须命中同一 Cycle 身份，而非创建副本。

## 8. 刺激选择与消费语义

首 wave 的刺激只来自 Root Round 已提交的 authorized Observation；后续 wave 只来自上一 Reaction Round 新提交的 authorized Observation。刺激必须同时满足：

- `observerCharacterId` 与 Job 角色一致；
- Scene、可见性、生命周期和在场条件满足对应 as-of 规则；
- Observation 没有被该角色在本 Cycle 的更早 Job 消费；
- 来源 Round 属于当前 Cycle；
- 默认排除角色对自身 Action 产生的自反 Observation；
- 不以 Session、Projection 或缓存内容替代 Observation。

同一角色同一 wave 的多个 Observation 组成一个 `StimulusBundle`。排序使用稳定的 `(sourceWorldSeq, sourceEventOrdinal, observationOrdinal)` 全序，Canonical JSON 后计算 `stimulusHash`。Job 唯一键至少覆盖：

```text
(worldAddress, cycleId, wave, characterId, stimulusHash)
```

只有 Job 成功 settled 后，刺激才视为被该角色消费。重复恢复相同 Job 必须得到相同 bundle；禁止通过“查询当前最新 Observation”改变已冻结输入。

## 9. Wave 规划、稳定预算与并行调用

每个 wave 分为三个事务外阶段和两个短事务：

```text
Tx A: freeze base head -> select jobs -> stable sort -> reserve budgets -> claim
Outside Tx: build contexts -> invoke providers in parallel -> validate proposals
Tx B: verify fence/head -> Rulebook resolve -> append world records -> settle jobs
After Tx: reconcile availability -> wake next work
```

参与者排序必须是平台无关的字节序全序，不能依赖 locale、SQLite 默认 collation 或 Promise 完成顺序。预算在任何 Provider 调用前按该顺序一次性预留：

1. 先应用 `maxCallsPerCharacter`；
2. 再应用 Cycle 剩余 `maxNpcCalls`；
3. 再应用冻结 token 预算；
4. 获得 reservation 的参与者构成本 wave 不可变集合；
5. 集合内 Provider 调用可并行，提交顺序仍由稳定 `ActionOrderKey` 决定。

同 wave 内某调用失败或少用 token，不得把名额即时转给排序靠后的角色，否则外部时序会改变参与者集合。退款只能增加下一 wave 的可用余额。Cycle 的已用预算必须能从耐久 Job 与 ProviderCall 记录重算；内存计数器只能作为缓存。

## 10. `ActionOrderKey` 前置门禁

现有排序若隐含“必须存在玩家 Action”，则不能直接用于 Reaction Round。正式 ADR 必须定义同时覆盖两类 Round 的全序：

```typescript
type ActionOriginRank = 0 | 1; // player before npc; reaction round has no player row

interface ActionOrderKey {
  phase: number;
  originRank: ActionOriginRank;
  actorIdBytes: Uint8Array;
  actionOrdinal: number;
  canonicalActionHash: string;
}
```

准确字段可由 ADR 调整，但必须满足：无玩家 Action 时仍有全序、跨平台一致、与 Promise 完成顺序无关、重放产生相同结果。这个门禁在 Phase 9A 开始前完成，不允许在 Scheduler 中临时拼接第二套排序。

## 11. Context、Scene 与 Memory 的 as-of 契约

每个 wave 冻结 `baseHeadSeq/baseHeadHash`。所有参与者的模型输入使用同一基点：

- CharacterView 与 SceneView 截止 `baseHeadSeq`；
- StimulusBundle 来自当前 Cycle 且不晚于该基点；
- Cognitive Memory 必须声明已处理到至少 `baseHeadSeq`；
- Provider request 记录 Context manifest、input hash、policy version 与 as-of；
- Context cache key 必须包含 World、branch、character、baseHead、policy 与 stimulusHash。

Memory 落后时不得偷偷使用旧摘要。运行时可在事务外等待有界 catch-up；超过有效 deadline 后，该参与者以 `runtime_unavailable` settle。若所有预留参与者都因此不可用，本 wave 仍按第 14 节提交权威终态，Cycle 随后以 `deadline_reached` 结束。

## 12. Job、租约与状态机

Job 状态机固定为：

```text
pending -> claimed -> settled
    |          |
    |          +-> pending   (仅限明确证明未 dispatch 且租约过期)
    +-> skipped              (冻结前已受终止或预算排除)
```

`settled` 必须附带以下 outcome 之一：

- `proposed`：产生通过结构校验的提案；
- `abstained`：模型明确无 Action；
- `provider_terminal`：调用结果不可安全恢复或 Provider 给出终止错误；
- `runtime_unavailable`：Context / Memory / runtime 未在边界内就绪；
- `rejected`：提案被 Rulebook 拒绝。

Claim 必须记录 `ownerId`、`leaseUntil`、`fenceToken` 和 attempt。续租和提交都必须验证 token。旧 owner 在租约丢失后不得提交，即使仍持有模型结果。

## 13. ProviderCall append-once 与歧义恢复

每次模型调用必须有耐久 `ProviderCall` 身份，并遵循 append-once 语义：

```text
reserved -> dispatching -> responded -> validated -> consumed
                   |
                   +-> terminal_ambiguous
```

- `reserved` 可安全回收，因为尚未 dispatch；
- 进入 `dispatching` 后崩溃且没有耐久响应，恢复器必须标记 `terminal_ambiguous`，不得自动重发；
- `responded` 或 `validated` 的耐久响应可以继续验证或提交；
- 相同 `providerCallId` 不得追加第二个逻辑响应；
- Provider 支持幂等键时仍要传递，但不能用它替代本地 append-once 防线。

提交后的进程崩溃可能导致“世界事实已存在、Job 尚未在调用方观察到完成”。恢复器必须先从 Round Authority / Event Log 对账，再改变 Job；不得仅凭缓存重做 Provider 调用。

## 14. Reaction Round 的权威提交

一个 wave 对应且只对应一个 Reaction Round。该 Round：

- `origin = reaction`，关联 `cycleId/rootRoundId/wave`；
- 没有 player action，也不制造 player Session 输入；
- 对每个参与者最多接收一个 `speak@1` 提案；
- 在 Tx B 中由 Rulebook 重新验证，而不是信任模型侧校验；
- 使用正式 `ActionOrderKey` 排序；
- 原子追加 Action、派生事件、Observation、Participant Authority、Tick 与 Round Authority；
- 恰好推进一个 tick，即使所有参与者 abstain、被拒绝或 provider terminal。

如果首 wave 没有候选 Job，则不创建 Cycle，也不额外推进 tick。如果 wave 已经冻结并发生了实际调度，则必须提交可审计的 Reaction Round；“没有被接受的 Action”不是跳过权威记录的理由。

Tx B 提交时如果 branch head 已偏离 `baseHeadSeq/baseHeadHash`，必须 fail closed。合法的玩家抢占输入此时只进入耐久队列，不直接改写 head；非预期 head 变化视为完整性冲突并进入隔离流程。

## 15. 下一 Wave 与终止判定

Tx B 在提交本 wave 后，使用新提交 Observation 与剩余预算决定下一步：

1. 若 Cycle 为 `stop_requested`，不生成下一 wave；
2. 否则选择未消费的新刺激；
3. 应用角色生命周期、Scene、可见性、自反排除和每角色调用上限；
4. 若候选为空，Cycle 在同一事务中终结；
5. 若达到任何硬上限，Cycle 在同一事务中终结；
6. 否则原子生成下一 wave Job，并更新 Cycle 的当前 wave。

Cycle 的 terminal reason 必须从以下闭集选择：

| 原因 | 语义 |
|---|---|
| `quiescent` | 新 Round 没有可继续传播的刺激 |
| `all_abstained` | 本 wave 所有角色均明确 abstain，且不再继续 |
| `call_limit` | 达到 Cycle 总调用数或每角色调用数上限 |
| `wave_limit` | 达到 `maxWaves` |
| `token_budget_exhausted` | 无法为下一参与者稳定预留 token |
| `deadline_reached` | Cycle 冻结 deadline 到期 |
| `provider_terminal` | Provider 歧义或终止错误使本 Cycle 不宜继续 |
| `player_preempted` | 收到后续玩家输入 |
| `user_cancelled` | 用户显式取消 Cycle |
| `administrative_stop` | 维护、关闭或其他行政停止 |
| `quarantined` | 完整性、Hash、fence 或 head 校验失败 |

`all_abstained` 只在所有预留参与者都明确 abstain 时使用。混合结果中存在歧义或 Provider 终止错误时使用 `provider_terminal`，有效 deadline 已耗尽时使用 `deadline_reached`；其余没有产生新刺激的组合在 Round 提交后使用 `quiescent`。

## 16. 玩家抢占与命令顺序

玩家在 Cycle 运行期间提交的新命令必须先耐久入队，然后原子把当前 Cycle 标记为 `stop_requested(player_preempted)`。执行语义为：

```text
new player command durably queued
  -> current frozen wave may finish and commit
  -> no next wave is created
  -> old cycle completes as player_preempted
  -> queued player command becomes next root Round
```

抢占不取消已经 dispatch 的 Provider 调用，不丢弃已成功收集的当前 wave 结果，也不恢复旧 Cycle。多个玩家命令按 Session / branch 既有耐久 FIFO 规则排序；Reaction Scheduler 不建立第二套用户命令队列。

若命令在 wave freeze 前到达，Scheduler 应观察到 `stop_requested` 并跳过未 claim Job。若 Tx B 正在提交，输入排队等待短事务结束。UI 可以即时显示“已请求停止”，但不得把提示当成 Cycle 已终结。

## 17. 显式取消与行政操作

`reaction.cancel(cycleId)` 只对未终结 Cycle 生效，幂等地写入 `stop_requested(user_cancelled)`。已经冻结的 wave 与玩家抢占采用相同收口策略。

管理操作边界如下：

| 操作 | Cycle active 时的规则 |
|---|---|
| fork | 拒绝；等待终态后重试 |
| archive | 拒绝；不得隐藏仍会写入的 branch |
| maintenance | 禁止新 wave；当前 wave 收口为 `administrative_stop` |
| graceful shutdown | 停止 claim；等待短提交，剩余安全 Job 由租约恢复 |
| quarantine | 立即禁止新提交；未提交 wave 终结为 `quarantined` |
| delete | 继续遵循既有删除前置条件，不以 Reaction API 绕过 |

Quarantine 优先于“当前 wave 可以收口”的普通规则：一旦不能证明 Hash、fence 或 head 完整性，不得为了保留模型输出而提交世界事实。

## 18. Service、Host 与生命周期边界

建议保持现有分层：

- `world-runtime`：Cycle / Job / ProviderCall 耐久状态、事务编排和 Rulebook 提交；
- `context-engine`：按冻结 as-of 构建可重建 Context，不拥有调度状态；
- `memory-service`：提供 checkpoint / catch-up readiness，不反写世界事实；
- `world-application`：组合根、Host worker 生命周期、API 与通知；
- `presentation`：读取权威记录并关联展示，不驱动下一 wave；
- `telemetry`：观察，不参与预算和终止裁决。

Cordis service、effect 和 listener 必须归属于明确 Fiber，并随所属 Fiber 清理。Branch Service 即使运行在 isolate 内，也保留显式 WorldAddress / branch 过滤。Scheduler wakeup 是 level-triggered hint：启动、提交、租约到期或新命令只需唤醒扫描；漏掉 hint 不能永久丢失耐久 Job。

## 19. 对外 API 与通知

Phase 9 v1 最小 API：

```typescript
interface ReactionService {
  get(cycleId: ReactionCycleId): Promise<ReactionCycleView | null>;
  list(world: WorldAddress, query?: ReactionListQuery): Promise<ReactionCycleView[]>;
  cancel(cycleId: ReactionCycleId): Promise<ReactionCycleView>;
}
```

创建 Cycle 不是公开命令；它只能由成功提交的 Root Round 事务产生。API View 至少包含：policy、rootRoundId、status、terminalReason、currentWave、冻结预算、耐久用量、时间戳和最后 Authority 引用。

通知为非权威投影，至少支持：

- `reaction.started`；
- `reaction.round_committed`；
- `reaction.completed`。

通知重复、乱序或丢失不能改变正确性。消费者使用 `(worldAddress, cycleId, wave, roundId)` 去重，并可通过 `get/list` 重新同步。

## 20. Presentation 与最终用户体验

Presentation 必须把连续反应显示为同一因果链，而不是伪装成多条玩家回合：

- 每条消息可追溯到 `rootRoundId/cycleId/wave/roundId`；
- wave 提交后按权威 Action 顺序整批出现；不得按 Provider 返回先后流式泄露未裁决提案；
- Cycle active 时显示轻量“角色正在反应”，但不阻塞玩家输入；
- 玩家输入后显示“将在当前反应轮结束后接入”，终态后立即处理；
- 达到预算上限时以自然的“场景暂时安静下来”表达，不向普通用户暴露内部 token 细节；
- 调试视图保留 terminal reason、预算与 Authority 定位。

目标体验不是追求无限对话，而是让一次玩家刺激能形成 1～3 个有意义的连续节拍，并始终允许玩家夺回控制。

## 21. Schema、Logical Export 与兼容性

正式实现预计把 World Schema 从稳定基线 v15 升至 v16，并把 Logical Export 从 v5 升至 v6；最终编号由 superseding ADR 与迁移实现共同冻结。原型使用的同名版本不能自动视为正式兼容承诺。

迁移至少新增或等价表达：

- `reaction_cycles`；
- `reaction_jobs`；
- `reaction_job_stimuli`；
- `provider_calls` 的 append-once / recovery 字段；
- Reaction Round Authority 的 cycle / wave 关联；
- 必要的 unique、foreign key、claim 扫描与 terminal 查询索引。

迁移规则：

1. 使用 `node:sqlite`、WAL、`synchronous=FULL` 和短 `BEGIN IMMEDIATE`；
2. v15 旧 World 前向迁移后表为空、policy 为 disabled；
3. 迁移前继续执行既有备份纪律；失败回滚且旧库保持可打开；
4. 新 Schema 不得被旧二进制静默降级打开；
5. Logical Export 包含完整 Cycle、Job、刺激、ProviderCall、Authority 与终态；
6. 导入后 Hash、外键、预算重算和 active-cycle 唯一性全部 fail closed 验证。

## 22. 可观测性与隐私

最小指标：

- Cycle 启动数、完成数与 terminal reason 分布；
- 每 Cycle wave、NPC call、accepted Action 与 token 分布；
- Root Round 提交到首 Reaction Round 的延迟；
- wave freeze、Context build、Provider、Rulebook、commit 分段延迟；
- player preemption 等待时间；
- ambiguous ProviderCall、lease recovery、fence rejection、head mismatch 数；
- Context / Memory unavailable 比率；
- 队列深度与 branch 饥饿时间。

日志默认只记录 ID、Hash、计数、状态和耗时。Prompt、模型原文、Memory 正文与角色私有 Observation 不进入普通日志或 metric label。诊断导出继续遵循既有脱敏与权限边界。

## 23. 分阶段实施路线

### Phase 9A：权威骨架与单 wave 产品化

交付：

- superseding ADR Accepted；
- `ActionOrderKey` 与稳定预算预留门禁；
- 正式 Schema migration、Cycle / Job / Stimulus repository；
- Root Round 原子开 Cycle；
- 单 wave Reaction Round，只有 `speak@1`；
- Scripted Provider、Context as-of、Authority 与 Logical Export；
- 崩溃矩阵和启动恢复，但产品配置默认仍 disabled。

退出条件：单 wave 在 crash-before-dispatch、after-dispatch、after-response、before-commit、after-commit 全部得到唯一且可解释的耐久结果。

### Phase 9B：有界多 wave 与抢占

交付：

- 最多 3 waves、8 calls、每角色 2 calls；
- wave 间刺激传播和消费；
- 同 wave 并行 Provider 调用；
- 玩家抢占、显式取消、terminal reason 闭集；
- `reaction.get/list/cancel`、通知与 Presentation；
- `responsive/v1` 可由新建 World 显式启用。

退出条件：双 NPC 能在一次玩家输入后形成至少两 wave 对话，玩家任意时点输入都不会丢失、插入半个 wave 或恢复旧 Cycle。

### Phase 9C：运行闭环与发布收口

交付：

- Host worker 生命周期、branch 公平性和背压；
- maintenance / archive / fork / quarantine 边界；
- 长历史性能、索引和高并发基线；
- 创建器 / Pack policy / 运行手册；
- Release Closure、迁移演练与恢复演练。

退出条件：默认 `responsive/v1` 的延迟、资源和恢复指标达到第 24 节门槛，并完成至少一次真实磁盘迁移与子进程硬终止演练。

## 24. 验收矩阵

### 功能与一致性

- 单 NPC、双 NPC、多 NPC；同 Scene、跨 Scene、角色离场与销毁；
- 无刺激不建 Cycle；有刺激建立唯一 Cycle；
- 同 wave 冻结输入，下一 wave 才看见上一 wave；
- 一个调用零或一个 `speak@1`，多 Action fail closed；
- Rulebook reject、全 abstain、部分 abstain、Provider terminal；
- 精确命中 3 waves、8 calls、每角色 2 calls 的边界；
- 重放、Logical Export / Import、Projection rebuild 结果一致；
- old World 迁移后保持 disabled。

### 并发与恢复

- 两个 worker 竞争同一 Job，只能一个 fence 提交；
- lease 到期前后、进程重启、Host graceful shutdown；
- dispatch 前崩溃可重试，dispatch 后无响应不得重发；
- response 已耐久但未验证、已验证但未提交、已提交但未 reconcile；
- 玩家输入发生在 freeze 前、Provider 期间、Tx B 前后；
- maintenance、cancel、archive、fork 与 quarantine 竞态；
- wake hint 丢失后启动扫描仍能恢复。

### 性能与体验

- 长 Event Log 下 Job 选择和刺激消费查询使用覆盖索引，无全表反复扫描；
- 8 个 NPC call 的 wall time 接近最慢并行调用，而不是调用时长总和；
- SQLite 写锁仅覆盖短事务，Provider 慢调用不持锁；
- player preemption 等待不超过当前 wave 的有效 deadline；
- UI 不泄露未裁决提案，不要求玩家发送占位输入；
- 3-wave 边界结束自然且可解释。

### 工程门槛

生产代码变更必须同步测试，并通过：

```powershell
corepack pnpm@11.7.0 check
```

所有生产包 `src` 保持逐文件 statements、branches、functions、lines 100%。高风险提交窗口必须保留真实子进程硬终止测试；普通 throw / reject 测试不能替代。

## 25. 实施停止条件

出现以下任一情况，当前阶段不得继续扩面：

- superseding ADR 尚未 Accepted；
- `ActionOrderKey` 在 Reaction Round 上不能给出跨平台确定全序；
- 参与者集合受 Promise 完成顺序或 Provider 退款时序影响；
- 模型输入不能由耐久记录按 as-of 重建；
- after-dispatch 崩溃会自动重发；
- 玩家输入可能丢失、越过当前 wave 或与 Reaction Tx 混写；
- Cycle / Job 状态被用于替代 World Event Log 事实；
- 长历史下必须扫描完整 Event Log 才能推进每个 wave；
- 任一完整性检查只能通过放宽 Canonical JSON、Hash、fence 或事务边界来通过。

停止意味着回到当前子阶段修复，不以降低测试、减少恢复点或关闭 fail-closed 规则绕过。

## 26. 证据、结论与实现路径

### Evidence

- [ADR-0076](../adr/ADR-0076-reaction-cycle-npc-only-round-prototype.md)证明 NPC-only Round 可以在不伪造玩家 Action 的前提下进入现有权威提交链；
- [Reaction Cycle P0 原型验证报告](../2026-08-30_Reaction-Cycle-P0原型验证报告.md)记录 Schema v16 / Logical v6、单 wave、租约、恢复与测试结果；
- Phase 8 / 8.1 已提供 Character Context、Scene、Memory、Authority、Checkpoint 与连续性边界；
- 当前原型仍缺多 wave、稳定并行预算、正式 Host worker、玩家抢占、完整 API 和生产迁移承诺。

### Finding

“NPC 自行聊起来”在现有权威架构内可行，但必须被建模为 Root Round 派生的有界、耐久、逐 wave 提交的 Reaction Cycle。直接把原型的单 wave worker 合入主线会把排序、预算、恢复和用户控制风险固化为公共 API。

### Path

ADR-0077 先冻结正式方向；随后完成 Phase 8.2 / 8.3 门禁，再按 9A 的权威骨架、9B 的多 wave 与抢占、9C 的运行闭环交付。每一步只扩大一个可证明边界，并用 Logical Export、崩溃矩阵、长历史基线和最终用户试金石共同验收。

## 27. 完成定义

Phase 9 完成不是“NPC 能连续输出文本”，而是同时满足：

1. 一次玩家输入可以触发 1～3 个正式 Reaction Round；
2. NPC 在下一 wave 正确看见上一 wave 的已提交事实；
3. 玩家无需发送占位输入，且随时可以有界夺回控制；
4. 每次模型调用仍只有零或一个 `speak@1`，所有结果经过 Rulebook；
5. 预算、租约、ProviderCall、Authority、Context 和终态均耐久、可恢复、可导出；
6. 任意崩溃点不产生重复世界事实或不安全的 Provider 重发；
7. 旧 World 行为不变，启用必须显式；
8. 全套质量门槛、性能基线和运行手册通过发布收口。
