# 角色交互与玩家即时成立 V0.1 实施规格

| 属性 | 值 |
|---|---|
| 决策 | [ADR-0087](../adr/ADR-0087-player-immediate-character-interactions.md) |
| 状态 | Accepted implementation target；C0 真实 Provider 门禁待运行；C1/C2 已落地；C3 耐久运行时与 Host 后台恢复的模型无关闭包已完成，生产 Provider 入口待接；C4 模型无关恢复/迁移、Pack 示例与文档已完成，真实模型长程试玩待运行；发布门禁未关闭 |
| 实施基线 | `codex/player-immediate-character-interactions`；v8 契约修复 `5d6b982`，文档与试玩证据 `26bc98c` |
| 候选世界 / 模型协议 | Manifest v9；submit_actions/v6 仅在 C2 证明 v5 不能保持原语义时引入 |
| 候选目录 / 玩家协议 | interaction-catalog/v2 / player-intent/v1 / player-submission/v2 |
| 持久化切片 | C1/C2：World Schema v17、Logical Authority v7、Round Authority v5；C3：World Schema v18、Logical Authority v8、Context Schema v6 |
| 首个试金石 | 玩家输入“我抓住 Alice 的手”，Alice 同轮选择 release、move、speak 或 abstain |

> **前置门禁进度：** v8 表现 Schema 已在独立提交 `5d6b982` 收口，设计与证据在 `26bc98c` 隔离；完整工程门禁已通过。C0 的版本、DDL 与恢复所有权见 [`2026-09-11_角色交互-C0-Schema-Spike.md`](../2026-09-11_角色交互-C0-Schema-Spike.md)。真实 DeepSeek 20-call 门禁尚未运行，因此 C0 仍未关闭，不得提前进入 C1 生产实现。

> **执行进度补充：** 用户随后要求跳过不可用的 DeepSeek 子进程并继续实施，当前已有 C1 内部实现，详见 [`2026-09-11_角色交互-C1-实施记录.md`](../2026-09-11_角色交互-C1-实施记录.md)。上述前置门禁仍未关闭；此进度不构成 C1 正式验收或 Manifest v9 发布许可。

> **C2 执行进度：** 已接入玩家候选 S1、按参与者裁剪的 Provisional ReactionView、S1 Affordance、ContextReceipt 绑定及提交前完整性校验，详见 [`2026-09-12_角色交互-C2-实施记录.md`](../2026-09-12_角色交互-C2-实施记录.md)。当前显式单 Action 入口复用 `submit_actions/v5`，无需 v6；未引入 C3 玩家双步输入。C0 真实模型门禁与 C4 专项恢复/发布验收仍独立保留。

> **C3 执行进度：** 首个契约切片新增 `PlayerSubmissionV2`、Host 精确 Affordance 绑定、UTF-16 source span 校验和候选结构 Schema，详见 [`2026-09-12_角色交互-C3-契约切片记录.md`](../2026-09-12_角色交互-C3-契约切片记录.md)。尚未接入耐久受理、ProviderCall 或两步玩家 Round；`player-intent/v1` 激活门禁保持关闭，C3 阶段未完成。

> **C3/C4 模型无关收尾（2026-09-12）：** 在原运行时切片上补齐受理时 Manifest/head Authority、启动扫描与 `player_input` 调度 quantum、Logical 输入/Inbox/Commit 闭包、backup/restore、fork/as-of、Snapshot/Full Replay 及 v2 Creator 示例；详见新增的 [`C3/C4 模型无关收尾报告`](../2026-09-12_角色交互-C3C4-模型无关收尾-report.md)。原 [`C3 运行时与 C4 恢复实施记录`](../2026-09-12_角色交互-C3运行时与C4恢复-report.md) 保留为当时基线。生产 Player Intent Provider/Profile 入口、C0 Provider 矩阵和 C4 长程真实模型试玩仍未关闭，因此不声明 Manifest v9 已具备发布资格。

> **术语：** “即时成立”表示无需目标审批、在裁决顺序上先形成玩家候选 S1；不表示零延迟、提前显示或玩家阶段单独 COMMIT。玩家组与 NPC 结果仍由一个 Root Round 原子提交。

## 1. 目标、成功标准与非目标

本阶段交付一个最小但完整的角色关系闭环：人工玩家对显式允许的 NPC 执行 `hold_hand` 时，Rulebook 在硬世界约束通过后立即建立可解除关系；目标不拥有事前 veto，但在同一 Root Round 和后续 Reaction Cycle 中拥有真实的行为选择。

成功不是“模型愿意配合”，而是以下结构性结果同时成立：

1. 玩家无需学习 JSON、特权字段或请求/接受协议；
2. 玩家 Action 仍经过 Rulebook，Event Log 仍是唯一世界事实；
3. 目标可以 release、move、speak 或 abstain，玩家不能声明这些选择；
4. 原文中的越权目标陈述无法进入 Event、Observation 或 Memory；
5. 崩溃、重试、重放、fork 与导入不会改变解释或关系状态；
6. 旧世界、旧协议与旧 Hash 保持原语义。

本阶段明确不实现：

- 任意 guard/effect DSL 或 Pack 脚本；
- NPC 发起的身体接触请求、接受、拒绝或对抗；
- grapple、restrain、push_down、伤害、死亡、传送或持续跟随；
- 左右手、力量、体型、精确站位或实时物理；
- 自由表现文本或由表现建立世界状态；
- 多于一个 speak 加一个世界 Action 的玩家输入；
- 改写 Manifest v1～v8 或活动世界的隐式升级。

## 2. 冻结前必须回答的四项决策

| ID | 决策 | 本草案推荐值 | 未冻结风险 |
|---|---|---|---|
| D-001 | 即时成立权的可信来源 | Host 从 PlayerBinding 派生，不接受输入字段 | 任意 Agent 可伪造玩家权力 |
| D-002 | 首个持续效果 | 仅 `hand_hold`，且任一参与者可 release、move 自动结束 | 直接滑向通用身体状态系统 |
| D-003 | 目标首次反应时点 | 玩家候选 S1 后、同一 Root Round phase 1 | 目标必须等下一 wave，体验慢一拍 |
| D-004 | 自然语言解释耐久边界 | 原文先耐久受理，解释终态后再创建 Round | 同键重试可能得到不同 Action |

ADR-0087 已于 2026-09-11 Accepted，上表四项成为实施约束，不允许由代码默认值改变产品决定。后续若改变方向，必须新增 superseding ADR。

## 3. 候选契约

### 3.1 Rulebook resolution authority

```typescript
interface RulebookResolutionAuthorityV1 extends WorldJsonObject {
  readonly version: 'resolution-authority/v1'
  readonly sourceRole: 'player' | 'agent' | 'director'
  readonly adjudicationMode: 'standard' | 'manual_player_immediate'
}

interface RulebookResolutionContextV2 {
  readonly manifest: CompiledWorldManifestV9
  readonly events: readonly RulebookEvent[]
  readonly characterId: CharacterId
  readonly action: PlayerActionInput
  readonly resolutionAuthority: RulebookResolutionAuthorityV1
}
```

构造规则：

| 来源 | sourceRole | adjudicationMode |
|---|---|---|
| 已授权人工玩家 Root 输入 | player | manual_player_immediate |
| 不使用即时策略的人工玩家 Action | player | standard |
| Character Agent Root/Reaction 提案 | agent | standard |
| Director 提案 | director | standard |

只有上表四种组合合法。`agent/director + manual_player_immediate` 必须在 Host/Authority 边界作为伪造状态拒绝，而不是交给领域 Resolver 降级处理。解析器拒绝 Action parameters 中的 `privileged`、`authorityMode`、`sourceRole` 或等价未知字段。World Pack 只能选择 definition 的允许策略，不能给单次 Action 盖章。

### 3.2 Interaction catalog v2

目录延续 definitions + bindings，但每项显式声明目标类型和闭合 operation：

```json
{
  "version": "interaction-catalog/v2",
  "definitions": [
    {
      "interactionId": "core:hold-hand",
      "label": "牵住对方的手",
      "targetKind": "character",
      "operation": "hold_hand",
      "initiationPolicy": {
        "manualPlayer": "commit_then_react",
        "autonomousCharacter": "forbidden"
      }
    }
  ],
  "bindings": [
    {
      "targetId": "character:alice",
      "interactionIds": ["core:hold-hand"]
    }
  ]
}
```

首版闭合 operation：

| targetKind | operation | 谁可发起 | 成功效果 |
|---|---|---|---|
| entity | take | 沿用 v1 | `entity.transferred` |
| entity | drop | 沿用 v1 | `entity.transferred` |
| entity | give | 沿用 v1 | `entity.transferred` |
| character | hold_hand | 仅 manual player | `character.relation-started` |
| active relation | release_hand | 任一关系参与者 | `character.relation-ended` |

`ActionRequest.parameters.targetId` 的候选目标类型因此扩展为 `entity | character | relation`。其中 `entity` 与 `character` 是 Manifest Catalog 可绑定目标；`relation` 不是作者可声明的静态 binding，而是 Core 根据 active relation 动态生成的运行时目标。

`release_hand` 是由 active relation 动态生成的 Core Affordance，不要求创作者为每个角色重复绑定。自有 interactionId 可以别名到 `hold_hand`，但不能改变 initiationPolicy、关系类型、解除权或观察语义。是否允许创作者关闭某个目标的 hold_hand 由 bindings 决定。

目录限制候选沿用 v1：definitions 最多 128、bindings 最多 4096、ID/label 最长 128、Canonical World JSON、未知字段拒绝、重复及悬空引用拒绝。v2 解析器还必须拒绝：

- character binding 指向未知角色或玩家自身；
- operation 与 targetKind 不匹配；
- `hold_hand` 未使用固定 initiationPolicy；
- `core:` 命名空间与 operation 身份不一致；
- 试图声明 effect、eventType、guard、script、cannotEscape 或自定义 observation scope。

### 3.3 Player submission v2

```typescript
interface PlayerSourceSpanV1 extends WorldJsonObject {
  readonly actionId: ActionId
  readonly startUtf16: number
  readonly endUtf16: number
  readonly text: string
  readonly kind: 'speech' | 'action'
}

interface PlayerSubmissionV2 extends WorldJsonObject {
  readonly version: 'player-submission/v2'
  readonly sourceText: string
  readonly sourceTextHash: WorldHash
  readonly actions: readonly ActionRequest[]
  readonly sourceSpans: readonly PlayerSourceSpanV1[]
  readonly interpretationProfile: string
  readonly interpretationReceiptHash: WorldHash
}
```

`PlayerSubmissionV2` 是 Host 校验并绑定后的耐久结果，不是 Adapter 可直接提交的模型输出。Adapter 先产生不含 actorId、允许使用本次解释局部 action key 的候选；Host 固定 actor、分配最终 ActionId、把每个 span 的 actionId 重写为最终值，并在一次校验边界内形成上面的正式结构。

约束：

- actions 为一至两项；两项必须恰好一次 speak 和一次 move/interact；
- actorId 与最终 ActionId 不由 Adapter 决定，由 Host 在绑定后写入并逐项校验；
- span 使用 JavaScript UTF-16 code unit 索引，`sourceText.slice(startUtf16, endUtf16) === text`；
- span 有序、非重叠、非空，每个 span.actionId 必须精确引用 actions 中的一项；每项 Action 至少有一个 span；
- 原文可包含未映射叙述，但它不进入 action parameters；
- 原始全文只作为输入证据和玩家 transcript，不成为 NPC stimulus；
- 无 Action 的解释进入 clarification，不伪造 speak。

示例：

```text
输入：我抓住 Alice 的手，她没有挣脱。

正式提案：
interact(character:alice, core:hold-hand, {})

不形成事实：
“她没有挣脱”
```

## 4. 玩家解释与受理状态机

自然语言解释不得作为 RoundCoordinator 内的一次临时模型调用。候选状态机：

```text
received
→ prepared
→ dispatch_started
→ response_received
→ validated
→ round_enqueued
→ completed

terminal:
clarification_required
invalid_response
timed_out
timed_out_ambiguous
cancelled
```

耐久责任：

1. `received` 在短事务中绑定 WorldAddress、principalId、idempotencyKey、sourceTextHash 和输入顺序；同键不同原文返回 `IDEMPOTENCY_KEY_CONFLICT`。
2. 调用前保存解释 Profile、Affordance Hash、Manifest Hash、as-of Head 与 ProviderCall 身份。
3. `dispatch_started` 后没有耐久响应时，不自动重发可能计费的外部调用；允许用户明确重试时必须建立新的解释 attempt，并且原受理记录保留。
4. validated 保存精确 PlayerSubmissionV2；Round Inbox 只消费该耐久结果，不再次解释。
5. 同一 Branch 后续输入不得越过较早仍在解释的输入建立 Round。玩家 FIFO 在解释阶段和 Round 阶段都保持。
6. clarification 不推进 Tick；用户补充文本使用新的 idempotency key，并显式关联前一 clarification record。
7. 解释工作不在 World SQLite 事务中等待网络。是否新增 `player_input_jobs` 表、复用已有 ProviderCall 库或建立独立 Store，由 P0 Schema spike 用崩溃矩阵决定。
8. Provider、Profile、单次 Token 预算、截止时间和失败映射必须版本化并遵循 ADR-0032；每个 attempt 最终必须进入可恢复终态，不能永久占住玩家 FIFO。
9. 明确超时且确认未取得响应进入 `timed_out`；dispatch 后结果是否产生不明进入 `timed_out_ambiguous`，不得自动重发。两者都向玩家返回耐久 clarification，并允许在前项终态后使用新的 idempotency key 重试。
10. 生产 `PlayerInputInterpreter` 已有的 `/act interact <canonical-json>`、`/act speak <canonical-json>` 通用结构化入口和 `/move <locationId>` 专用入口不依赖 Player Intent Provider。在 `legacy-speech/v1` 下，普通非命令文本仍直接用于 speak；在 `player-intent/v1` 下，普通文本进入耐久解释，只有 validated PlayerSubmission 中的 speak 才能传播。未来的 `/say`、`/interact` 别名或 UI Affordance 控件需要另行定义和测试，不在本规格中伪装成既有接口。这些输入仍按受理顺序排队，不能越过未终态记录；解释失败也不得自动把原文当成 speak。
11. attempt 进入任一终态后到达的迟响应只写非权威审计，不能把 `clarification_required`、`invalid_response`、`timed_out`、`timed_out_ambiguous` 或 `cancelled` 改回 validated，也不能创建 Round。

Adapter 的模型 Schema 不是 Authority。即使 Provider 强制 JSON Schema，正式 Validator 仍必须核对字段、span、actor、Affordance、Manifest/as-of 和组合约束。

## 5. 角色关系的裁定与事件

### 5.1 hold_hand

输入形状继续使用统一 interact：

```json
{
  "actionType": "interact",
  "parameters": {
    "targetId": "character:alice",
    "interactionId": "core:hold-hand",
    "arguments": {}
  }
}
```

按顺序检查：

1. resolutionAuthority 是可信 manual_player_immediate；
2. actor 与 target 存在、不同且 active；
3. definition/binding/operation 精确匹配；
4. 双方当前 Location 相同，并满足 Scene 可交互边界；
5. 两者之间没有 active `hand_hold`；
6. 当前前缀的所有 relation Event 均可严格重建。

成功 Event 候选：

```json
{
  "eventType": "character.relation-started",
  "eventVersion": 1,
  "data": {
    "relationId": "relation:deterministic-id",
    "relationKind": "hand_hold",
    "initiatorId": "character:player",
    "targetId": "character:alice",
    "interactionId": "core:hold-hand",
    "sourceActionId": "action:player"
  }
}
```

relationId 的生成公式固定为：

```text
deterministicId(
  'relation',
  { version: 'character-relation/v1', address, sourceActionId, relationKind, initiatorId, targetId }
)
```

结果形状为 `relation:<opaque>`。同一 Action 在同一 WorldAddress 重放复用 relationId；关系结束后的新 hold 使用新的 sourceActionId，生成新的 relationId。fork 继承已有 Event 时保留事件中的原 relationId，不使用子 Branch 地址重算；fork 后的新 Action 使用子 Branch WorldAddress。不得使用墙钟、数据库自增值、Provider 返回顺序或当前 relation 数量作为输入。

### 5.2 release_hand 与自动结束

动态 Affordance 指向 relationId，避免同一角色对之间未来出现多种关系时产生歧义：

```json
{
  "actionType": "interact",
  "parameters": {
    "targetId": "relation:deterministic-id",
    "interactionId": "core:release-hand",
    "arguments": {}
  }
}
```

成功 `character.relation-ended@1` 的 reason 闭集：

- `released`
- `participant_moved`
- `participant_unavailable`

同一关系只能结束一次。第三方、已结束关系、未知 relationId、错误 relationKind 和损坏前缀均拒绝；前缀自相矛盾则升级为完整性错误，而不是普通领域 rejected。

relationId 是不透明定位符，不是 capability。只有关系参与者的 Context Affordance 可以枚举 relationId，真正授权来自 Rulebook 对参与者身份的重验。第三方按 Scene policy 最多获得关系发生的观察语义，不获得可提交 `release_hand` 的句柄；猜中 relationId 也不能绕过参与者校验。

成功 move 或 lifecycle change 的 Resolver 必须查询当前 active relations，并在同一 Action Resolution 中追加结束 Event。不得依靠 Context 层自动隐藏或墙钟 TTL 让关系“看起来消失”。

## 6. Root Round 候选时序

当前单 Action 流程只把 playerAction 放入 Provider stimulus，且 Affordance 基于 Root 开始前 history。新版本改为：

```text
读取冻结 Head S0
→ C2 顺序预裁定单个显式玩家 Action；C3 扩展为完整玩家组
→ 得到 provisional events / observations / relation state S1
→ 按 S1 为每个参与者生成最小可见 ReactionView
→ 直接目标看到 relation-started + release Affordance
→ 其他角色按 Scene 只看 full / occurrence-only / none
→ 并行 Provider 调用并冻结 Proposal
→ 玩家组作为 phase 0 原子连续区间重放既有裁定
→ NPC/Director phase 1 在最新 candidate prefix 上裁定
→ Event/Authority/Tick/Outbox/Reaction Job 原子提交
```

关键不变量：

- C2 的单个玩家 Action 在 Provider 调用前完成预裁定；C3 引入两步 PlayerSubmission 后，完整玩家组必须全部预裁定，目标不能只看到第一步；
- 玩家组的最终裁定必须复用或逐字节验证 provisional 结果，不能在 Provider 调用后静默改变；
- 目标的 release Affordance 来自 S1，但 release Action 最终仍在最新候选前缀重验；
- 其他 NPC 不能因 direct target 状态获得其无权看见的细节；
- 同轮 Alice release 时，start 与 end 都进入同一 World Commit，Presentation 按事件顺序呈现；
- Alice abstain、失败或不可用时，玩家合法关系仍提交；
- 后续 Reaction Cycle 只读取正式提交 Observation，不读取 provisional 对象或 Provider Proposal。

失败分类：

| 条件 | 分类 | 处置 |
|---|---|---|
| 同一 S0、同一 Resolution Authority、同一玩家 Action 下 provisional/final Event 或 Hash 不一致 | 完整性失败 | 整轮不提交，进入完整性处置 |
| phase 1 NPC Action 因 phase 0 玩家效果或更早 phase 1 Action 而不再成立 | 正常领域 rejected | 记录确定原因，不回滚玩家成功前缀 |
| Head、Writer Fence 或冻结前缀不再满足提交条件 | 并发/恢复失败 | 按 Writer Lease、Inbox 和恢复契约中止或重试 |

phase 1 NPC 不能先于不可插入的 phase 0 玩家组移动。若玩家 provisional 效果被 NPC 的“先行动”改变，说明排序或隔离不变量已经损坏，不属于正常领域失效。

绑定协议候选：

```typescript
interface ProvisionalEventBindingV1 extends WorldJsonObject {
  readonly actionId: ActionId
  readonly draftOrdinal: number
  readonly contentHash: WorldHash
  readonly event: WorldEventDraft
}

interface PlayerProvisionalResolutionV1 extends WorldJsonObject {
  readonly version: 'player-provisional-resolution/v1'
  readonly address: WorldAddress
  readonly baseHeadSeq: number
  readonly baseHeadHash: WorldHash
  readonly action: ActionRequest
  readonly resolutionAuthority: RulebookResolutionAuthorityV1
  readonly status: 'accepted' | 'rejected'
  readonly reason: string | null
  readonly events: readonly ProvisionalEventBindingV1[]
  readonly observationScope: ObservationScope
  readonly ruleTraceHash: WorldHash
}
```

events 的 draftOrdinal 必须从 0 连续递增；`contentHash = hashWorldJson('player-provisional-event/v1', { actionId, draftOrdinal, event })`。`provisionalResolutionHash = hashWorldJson('player-provisional-resolution/v1', value)`。每个参与者的 ContextReceipt 必须同时绑定该 Hash、裁剪后的 provisional Observation 和由 S1 计算的 affordanceHash。最终 phase 0 复验比较的是这组权威字段，而不是 Provider 请求中的显示文案；任一权威字节漂移均为完整性失败。

## 7. Observation、Context、Memory 与 Presentation

| 消费者 | 允许输入 | 禁止输入 |
|---|---|---|
| NPC Root Context | 按 Scene 裁剪的 provisional effect、S1 Affordance、已授权原文对白 | 未映射玩家叙述、其他角色私密反应 |
| Reaction Context | 已提交的 relation Observation、正式 Affordance、as-of Memory | Root provisional 对象、未提交 Proposal |
| Memory | 已提交 Observation 及可验证来源 | 玩家原始动作叙述、解释模型原文、Authority mode |
| Presentation | 已提交 Action/Event、闭合 Performance、观察者范围 | 未被接受的目标意愿或未来陈述 |
| Authority | 原始已验证 PlayerSubmission、resolutionAuthority、policy trace、Hash | 可变 Projection 或模型推断心理 |

Observation content 至少区分：

- relation_started：谁对谁建立了何种外部关系；
- relation_ended：谁结束、为何结束；
- occurrence_only：只知道发生了受限互动，不含私密内容；
- self rejection：只给行动者的失败原因，不刺激其他角色。

Memory 文案只能陈述可观察行为。例如“玩家牵住了 Alice 的手”是合法经历；“Alice 接受了牵手”只有未来正式 consent Event 存在时才可出现。关系 Event 不自动写 Affect、Goal、Claim、Commitment 或 Relationship cognition。

## 8. 模块改动面

| 优先级 | 文件 / 模块 | 计划改动 | 主要风险 |
|---:|---|---|---|
| P0 | `docs/adr/ADR-0087-*`、本规格 | 冻结产品语义、版本与非目标 | Proposed 被误当作已授权实现 |
| P0 | `packages/contracts` | Resolution Authority、PlayerSubmission、Relation Event/Observation、候选 Round Authority 升级 | Hash 与历史协议漂移 |
| P0 | `packages/kernel/src/world-spec.ts` | Manifest v9、interaction-catalog/v2、Registry Hash、严格解析 | 旧 Manifest 被隐式升级 |
| P0 | `packages/kernel/src/interactions.ts` | 拆分目录解析、Affordance 与闭合 operation resolver；增加关系前缀重建 | 通用 interact 退化为任意效果 DSL |
| P0 | `packages/kernel/src/rulebook.ts`、Registry | 接收可信 Authority；move/lifecycle 联动结束关系；复用 Core Resolver `builtin:speak-move@2`，仅由 Manifest v9 capability gate 开启新语义 | 特权可伪造、历史 @3 被误用或版本 fallback |
| P0 | `packages/application/src/round-coordinator.ts` | 玩家组预裁定、S1、phase 0 组、Authority 与 provisional/final 绑定 | 候选与正式 Event 分歧 |
| P0 | `packages/application/src/context-pipeline.ts` | 用 S1 生成 direct target Affordance，先裁剪再 Recall/Renderer | 提交前隐私泄漏 |
| P1 | `packages/application/src/player-input.ts`、WorldApplication | player-intent/v1 状态机、clarification、Round enqueue | 重试改写、FIFO 旁路、额外延迟 |
| P1 | `packages/store-sqlite` | 解释终态、Authority/Logical 迁移、Crash 恢复 | 部分写入或旧库误开 |
| P1 | `packages/memory`、Presenter、Session | 关系 Observation 捕获与确定性呈现 | 把行为提升为心理事实 |
| P1 | World Pack / creator CLI | v2 目录校验、示例和激活入口 | 文案伪装成额外语义 |
| P1 | `tests/experiments` | 真实模型输入解释与角色反应试玩 | 只测 Schema，不测真实 Provider 行为 |

实现时先用 `rg --files` 和当前 import 图确认实际文件，不以本表代替代码定位。若 CodeGraph 索引存在，应先用 CodeGraph；当前调研基线没有 `.codegraph/`。

## 9. 分阶段实施与验收

### 9.1 C0：当前 v8 门禁与 Schema spike

工作：

- 收口当前表现 Schema 与真实模型复测结论，形成干净或明确隔离的基线；保留枚举收窄与 required，当前证据下移除 `anyOf/allOf/not/contains`，除非新的运行时级 A/B 证据推翻该结论；
- 把当前重叠工作至少拆成两个可独立评审的提交：生产/测试契约修复，以及试玩证据/说明/示例；记录二者各自基线，避免把文档样本与代码修复混成一个通过结论；
- 预先声明发布目标 Provider、固定输入语料、每个 Provider 的调用样本数与允许无效率；不在看到结果后修改阈值；
- 每个无效输出保存受限原文与精确校验路径，并归类为具体 Schema 构造、Validator 路径或 Provider 不遵循协议；
- 绘制 Player Input、Round Inbox、ProviderCall、World Commit 的崩溃窗口；
- 验证是否需要 World Schema v18、Context/ProviderCall migration 与 Logical v8；结论已冻结为 C1/C2 复用 World v17 / Logical v7，C3 引入 World v18 / Logical v8 / Context v6；
- 确定 Manifest v9 是否复用 Core Resolver，或使用新的 Rulebook ID/版本；结论已冻结为复用 `builtin:speak-move@2`，并明确排除 historical-only 的 @3；
- 通过纯函数原型验证 relation start/end/move-end 的 Event 前缀。

当前观测只作为基线，不直接充当发布证明：

| 路径 | 基线证据 | C0 含义 |
|---|---|---|
| DeepSeek 修复前/后 | 13 次调用 6 拒；17 次调用 1 拒 | 证明枚举收窄方向有效，不足以单独冻结长期阈值 |
| qwen 修复前/后 | 均为 4/4 拒绝 | 若列为发布目标，当前门禁未通过；否则必须明确标为诊断或非支持路径 |
| 移除组合子 A/B | 2/2 接受 | 支持最小移除决定，但样本不足以声称 Provider 普遍兼容 |

验收：组合子去留、目标 Provider 矩阵、样本与阈值、版本、DDL、恢复所有权和迁移路径均有可判定答案；所有残留失败可归类；没有修改 Accepted ADR 原文。工程答案与已通过的 relation 纯函数原型记录在 C0 Schema Spike，剩余阻断项仅是按预声明矩阵运行真实 Provider 证据。C1～C3 都是不可发布的内部工程门禁，只有 C3 关闭后 Manifest v9 才能成为发布候选，避免同一已发布 Manifest 版本被分阶段扩写语义。

### 9.2 C1：模型无关 hand_hold 闭环

工作：

- Manifest v9 完整 Schema 与 interaction-catalog/v2 严格解析；Manifest v9 从此时起已包含 `legacy-speech/v1 | player-intent/v1` 的可选 Player Input Policy，但 C1/C2 只允许 legacy 激活；
- Host 派生 Resolution Authority；
- hold/release Event、关系重建与动态 Affordance；
- 单个显式结构化玩家 Action 完成 Root Round；release 先通过纯 Rulebook 或后续独立 Action 验证，不在 C1 声称目标已获得同轮 S1 Context。

验收场景：

| 场景 | 预期 |
|---|---|
| 玩家 hold，Alice abstain | relation 保持 active |
| active relation 后 Alice 显式 release | end 提交，最终 inactive；relationId 与参与者严格重验 |
| active relation 后 Alice move | move 成功并以 participant_moved 结束关系 |
| Alice Provider 失败 | 玩家合法 hold 仍提交，终态如实记录 |
| Agent 伪造 manual_player_immediate | Schema/Authority 边界拒绝 |
| 玩家远距或目标 inactive | 领域 rejected，仅行动者收到原因 |

### 9.3 C2：Provisional ReactionView

工作：

- 复用现有 `world-player-candidate-s1` 传递接缝，为单个显式玩家 Action 构造真正包含 Event、Observation、关系状态、Affordance 与 rule trace 的 S1；
- provisional Event/Observation 与 final contentHash 绑定；
- direct target 从 S1 获得 release Affordance；
- full/occurrence-only/none 在 Recall 之前裁剪；
- 决定 relation target 是否仍符合 submit_actions/v5 的已冻结语义；若不符合，在本阶段引入 v6，而不是随 C1 或 C3 自动升级。

验收：目标同轮 release、move、speak 或 abstain 均走真实 S1 Context；不同 Scene、私密/公开动作、多人同 Scene、目标离场均得到稳定 Context Hash；Provider 返回顺序不改变 Event/Authority。玩家两步组尚未在本阶段宣称完成。

### 9.4 C3：耐久 Player Intent

工作：

- 原文受理、解释状态机、ProviderCall 与 clarification；
- 精确 Affordance 约束和 UTF-16 source span 校验；
- validated PlayerSubmission 入 Round Inbox；
- 把 C2 单 Action S1 扩展为完整两步玩家组预裁定；
- CLI/Web 使用自然文本，同时保留显式命令作为正式降级入口，而不只是诊断入口；
- 冻结解释 Provider/Profile、Token 预算、截止时间和 `timed_out` / `timed_out_ambiguous` / clarification 映射；
- 解除 C1/C2 对 `player-intent/v1` 激活的 fail-closed 门禁；Manifest v9 Schema 本身不在本阶段追加字段或改变既有字段语义。

验收：

- “我抓住 Alice 的手”只产生 hold；
- “我抓住 Alice 的手，她没有挣脱”仍只产生 hold；
- “我抓住她并说‘别走’”产生按原文顺序排列的一次 interact + 一次 speak；
- “我让 Alice 爱上我/永远服从我”不能产生目标心理、Claim 或未来限制；
- 含糊引用只产生耐久 clarification；
- 同键重试不重调已终态解释、不改变 Action、不重复 Tick；
- 解释失败、超时或预算不足都在有界时间内进入耐久终态，玩家随后可用显式命令表达同一意图；
- speak→hold 与 hold→speak 都在 Provider 调用前形成完整 S1，目标不会只看到组内第一步。

### 9.5 C4：恢复、迁移与真实模型验收

工作：

- 解释 dispatch、Round enqueue、World COMMIT、Reaction Job 与 post-commit adopt 全窗口故障测试；
- logical export/import、backup/restore、fork/as-of、Snapshot/Full Replay；
- 新 Pack/目录示例、Creator Runbook 和真实 Provider 长程试玩；
- 完整检查与阶段报告。

发布门禁：所有模型无关正确性先通过，再使用真实模型衡量体验。真实模型通过不能覆盖 Authority、Hash、恢复或 canary 失败。

## 10. 测试矩阵

### 10.1 权限与领域

- PlayerBinding 正确/缺失/错误 Principal/跨 Branch；
- player+standard、player+manual_player_immediate、agent+standard、director+standard 四种合法组合；agent/director+manual_player_immediate 两种伪造组合必须拒绝；
- 自目标、未知目标、inactive/dead/departed、不同地点、无 Scene、未绑定 interaction；
- relation 不存在、active、已结束、重复 start、重复 end、第三方 end；
- relationId 同 Action 重放稳定、新 Action 新建关系得到新 ID；第三方 Context 不枚举 relationId，猜中 ID 仍拒绝；
- move/lifecycle 结束零、一、多条关系；
- interaction label 与 operation 不一致时效果仍只由 operation 决定。

### 10.2 输入与越权文本

- 纯动作、纯对白、动作加对白、对白加动作；
- 目标不反抗、目标同意、目标喜欢、目标无法移动、永久状态等越权陈述；
- 同名角色、代词歧义、跨 Scene 引用、不存在目标；
- Provider 多字段、缺字段、错误 actor、未知 Action、过期 Affordance；
- source span 越界、重叠、非原文字节、代理对 Unicode surrogate pair 的一致索引。

### 10.3 顺序、观察与认知

- 玩家组 phase 0 连续，NPC/Director phase 1；
- 同一冻结输入下玩家 provisional/final 字节漂移为完整性失败；NPC phase 1 合法过期为普通领域 rejected；Head/Fence 漂移走并发恢复路径；
- Alice 同轮 release 与其他 NPC 同轮动作的稳定顺序；
- full/occurrence-only/none 和 direct target 的 provisional/final 一致；
- Relation Observation 进入目标 Memory，但不产生 consent/Affect/Goal/Claim；
- Reaction Cycle 仍保持 3 waves / 8 calls / 每角色 2 calls，玩家抢占语义不变。

### 10.4 持久化与故障

- Player Intent received/prepared/dispatch_started/response_received/validated/round_enqueued 每个边界重启；
- World `store.after-event-insert`、`store.before-commit`、`store.after-commit` 子进程硬终止；
- 同键相同原文、同键不同原文、同解释不同结构化结果；
- C1/C2 保持 v17；C3 执行 v17→v18 原子 migration，旧二进制拒绝新库；
- C1/C2 Logical v7 保持同表形状 round-trip；C3 Logical v7 导入不补造 v8 的 Player Intent 数据，v8 round-trip 和篡改拒绝；
- Live、Restart、Full Replay、Snapshot Replay、forkSeq 得到同一 active relation 集。

### 10.5 真实模型试玩

至少覆盖 50 条混合输入和 20 个连续 Root Round，分别使用一个 Schema 强制较强和一个只保证 JSON 的 Provider。记录：

| 指标 | 目标 |
|---|---|
| 未授权目标心理/未来事实进入 Event/Observation/Memory | 0 |
| 合法明确 hold 输入被正确映射 | 作为发布前基线设阈值，不在设计阶段伪造数字 |
| 同键解释漂移 | 0 |
| 结构无效导致整轮沉默 | 记录并设置发布阈值 |
| clarification rate | 分明确输入与真实歧义分别统计 |
| 玩家提交到首个 NPC 反应的 P50/P95 | 与 v8 同硬件基线对比 |

每次失败保存精确 validationError、受限长度原始输出和截断标记；敏感 Context 不进入公开报告。

## 11. 迁移与恢复决策表

| 情况 | 行为 |
|---|---|
| 打开 Manifest v1～v8 | 使用旧 Resolver/输入模式，字节与 Hash 不变 |
| 新二进制缺少 C0 冻结的 Rulebook Resolver 或目录 v2 | fail-closed `RULEBOOK_NOT_REGISTERED`/Manifest 不可用；不得回退 historical-only @3 |
| 旧二进制打开候选新 Schema | 明确拒绝，不降级运行 |
| v9 目录改变 | 新世界或受控 Manifest Epoch；不热读文件 |
| 解释已 validated，进程重启 | 读取耐久 PlayerSubmission，不重调模型 |
| 解释 dispatch 后结果未知 | timed_out_ambiguous，不自动重发 |
| World COMMIT 后 adopt 前崩溃 | 从 Round Authority/Event/Head 对账并补终态 |
| relation Event 前缀损坏 | quarantine，不静默隐藏关系 |
| fork 到 relation start 前 | 子 Branch 不含关系 |
| fork 到 relation start 后/end 前 | 子 Branch 含 active 关系且无父未来 end |

## 12. 风险与处置优先级

| ID | 文件 / 模块 | 影响 | 建议 | 优先级 | 成本 | 风险 |
|---|---|---|---|---:|---:|---:|
| R-001 | 当前 Contracts/Context 试玩改动 | 两个阶段共享文件且语义尚未收口 | C0 先形成可复现基线 | P0 | 低 | 高 |
| R-002 | RulebookResolutionContext | 特权可能由输入伪造 | 只接受 Host 派生 Authority 并纳入 Hash | P0 | 中 | 高 |
| R-003 | relation Event/Projection | 关系与位置/lifecycle 分裂 | move/lifecycle 同裁定追加 end Event | P0 | 中 | 高 |
| R-004 | provisional Context | 目标看见 hold 却没有 release 工具 | 用 S1 计算 direct target Affordance | P0 | 高 | 高 |
| R-005 | Player Intent FIFO | 重试改变 Action 或后输入越过前输入 | 耐久解释状态机和双阶段 FIFO | P0 | 高 | 高 |
| R-006 | 自由原文传播 | 重演 manifestation 绕过 move | 原文不进入事实链，只允许闭合 Action/Effect | P0 | 中 | 高 |
| R-007 | 通用交互抽象 | 首版演变成任意规则 DSL | operation 闭集只加 hold/release | P1 | 低 | 中 |
| R-008 | 真实 Provider 合规 | Schema 正确但模型仍输出非法对象 | 正式 Validator、失败证据和质量退避 | P1 | 中 | 中 |

## 13. Evidence → Finding → Path

### Evidence

| ID | 不可变观察 | 来源 |
|---|---|---|
| E-001 | v8 已有声明式目录、闭合 operation、最新前缀重验和动态 Affordance | `packages/kernel/src/interactions.ts`、ADR-0086 |
| E-002 | 玩家基础裁定发生在 Provider 调用前；现有协调器已把名为 `world-player-candidate-s1` 的 Hash 传入 `#freezeParticipants`，最终玩家 Action 再于 phase 0 进入候选前缀。该 Hash 尚未绑定 provisional Event、Observation、Affordance 或 rule trace | `packages/application/src/round-coordinator.ts` |
| E-003 | Root NPC Context 当前只携带 playerAction，Affordance 仍基于旧 history | `packages/application/src/context-pipeline.ts` |
| E-004 | 生产普通文本仍直接成为 speak，显式动作依赖命令 | `packages/application/src/player-input.ts`、实施规格 D-003 |
| E-005 | Round Authority 已保存 sourceRole、完整 Action、Resolution 与 ruleTraceHash | ADR-0044、`packages/application/src/round-coordinator.ts` |
| E-006 | 自由表现文本曾把未裁定移动传播到 Observation/Memory | 真实试玩缺陷记录与 ADR-0085 的闭合表现纠偏 |
| E-007 | DeepSeek 无效率从 46% 降至 5.9%，qwen 仍为 4/4 拒绝；去掉组合子后小样本 2/2 接受 | `docs/2026-09-10_修复后真实模型复测记录.md` |

### Finding

| ID | 结论 | Evidence |
|---|---|---|
| F-001 | 角色即时交互可以复用现有 `interact` 和回合顺序，不需要同步请求生命周期 | E-001、E-002 |
| F-002 | 同轮反制要求把玩家候选效果和 S1 Affordance正式纳入 ReactionView | E-002、E-003 |
| F-003 | 玩家不对称权威必须来自 Host/Authority，而不是 Action 字段 | E-004、E-005 |
| F-004 | 自然语言只有先压缩为闭合 Action/Effect，才能避免传播目标未来陈述 | E-004、E-006 |
| F-005 | Player Intent 的非确定调用必须耐久化，否则会破坏 FIFO、幂等和恢复语义 | E-004、E-005 |
| F-006 | Schema 静态一致不等于目标 Provider 可用；C0 必须以预声明矩阵和可归类的运行时证据出闸 | E-007 |

### Path

Path P-001：玩家即时关系与目标同轮反制。

```text
PlayerBinding
→ 耐久 PlayerSubmission
→ Host 派生 manual_player_immediate
→ Rulebook 产生 provisional relation-started
→ Scene 裁剪后的目标 ReactionView + release Affordance
→ NPC Proposal
→ 玩家组 phase 0 / NPC phase 1 重裁
→ Authority + Event + Observation + Reaction Job 原子提交
```

Path P-002：自然语言中的目标未来陈述失去事实传播路径。

```text
原始玩家文本
→ 不可信解释器仅选择当前 Affordance
→ Host 固定 actor
→ Validator 核对 source span 与闭合 Action
→ Rulebook 只执行 hold_hand
→ “她没有挣脱”无 Event/Effect Schema
→ 不进入 Observation/Memory/Presentation
```

Path P-003：解释调用崩溃后确定恢复。

```text
原文与 idempotency key 耐久受理
→ ProviderCall append-once
→ validated PlayerSubmission 落盘
→ Round Inbox 消费同一字节
→ 崩溃重启读取终态
→ 不重新解释、不改变 Action、不重复 Tick
```

Path P-004：当前 v8 门禁先形成可判定基线。

```text
保留枚举收窄与 required
→ 移除当前证据判定为净负面的组合子
→ 预声明目标 Provider、语料、样本和阈值
→ 保存并归类每个无效原始输出
→ 固定可复现基线 commit
→ 才进入 C1
```

## 14. 交付检查

- [x] ADR-0087 经用户明确评审并于 2026-09-11 从 Proposed 改为 Accepted；
- [ ] C0 关闭真实 Provider 门禁；v8 工程基线已由 `5d6b982` 固定并通过完整 `check`；
- [x] Schema spike 冻结数据库、逻辑传输、Context、Rulebook 和 Authority 版本；
- [x] C1～C4 每阶段都有 Evidence → Finding → Path 与明确未完成项；
- [x] 生产 `src` 逐文件 statements、branches、functions、lines 100%；
- [x] 高风险窗口使用真实子进程硬终止，不用普通 throw 替代；
- [x] 运行 `corepack pnpm@11.7.0 check`；
- [ ] 完成真实模型试玩并逐项核对 Event、Observation、Memory 与玩家可见结果；
- [x] 更新 Creator Runbook、World Pack 手册、版本迁移说明和阶段报告。
