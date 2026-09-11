# ADR-0087：玩家受限即时成立权与角色关系交互

- 状态：Accepted（2026-09-11 用户授权按 C0～C4 分阶段实施；未关闭阶段不得声明完成）
- 日期：2026-09-11
- Supersedes（局部，且仅在本 ADR Accepted 后生效）：ADR-0023 的“所有普通文本原样成为对白”、ADR-0085 的人工玩家单 Action 入口、ADR-0086 的交互目标仅限实体
- Extends：ADR-0044、ADR-0057、ADR-0073、ADR-0077、ADR-0084～ADR-0086
- 实施草案：[角色交互与玩家即时成立 V0.1](../spec/character-interactions-v0.1.md)

> **实施边界：** 本 ADR 不改写 Manifest v1～v8、submit_actions/v1～v5、object-interactions/v1 或现有世界行为。文中尚未由 C0 冻结的版本号与持久化迁移仍是分阶段候选；实现不得越过对应阶段门禁。

## 背景

对象交互 V0.1 已证明，创作者可以声明 Affordance，Rulebook 在最新事件前缀上重新验证，并把合法 `interact` 编译成明确的领域 Event。其首版目标只允许实体，执行模板只包含 take、drop 和 give；角色身体接触及目标响应被明确留到后续阶段。

沉浸式 RP 又存在一种不同于竞技规则的产品需求：人工玩家输入“我抓住 Alice 的手”时，若世界硬约束允许，该即时外部结果应先成立，Alice 随后自行选择抽手、挣脱、说话、移动或不反应。系统不应先要求 Alice 审批，否则每次接触都增加请求、等待和结算阶段。

本文的“即时”是**裁决顺序语义**：效果不等待目标审批即可先进入玩家候选 S1；它不表示零延迟、提前显示或玩家阶段单独 COMMIT。玩家组与 NPC 结果仍在同一 Root Round 原子提交，UI 不得据此承诺固定响应时间。

这种不对称权威不能实现为用户可提交的 `privileged: true`，也不能让自由文本直接写 Event。Action、Agent Proposal 和 `/act` 都是不可信输入；若它们能自行选择裁决模式，NPC 或模型也能伪造玩家权力。过去自由 `manifestation.description` 已证明：只要自由文本能进入 Observation 和 Memory，它就具有事实传播能力，即使 Projection 没有改变，也会造成叙事现实与权威状态分裂。

## 决定

### 1. 权力是 Host 证明的裁决上下文

1. 新 Rulebook 上下文增加版本化的 `resolutionAuthority`，最小字段为 `sourceRole` 与 `adjudicationMode`。
2. `adjudicationMode = manual_player_immediate` 只能由 Application 根据当前 WorldAddress 下的耐久 PlayerBinding、已受理输入和 Round participant 身份派生。Player Action 参数、Agent/Director 输出、World Pack 文案和 Runtime Author 均不能声明或覆盖。
3. Rulebook 仍是唯一裁判。即时成立模式只改变被显式允许的角色交互解析策略，不绕过角色生命周期、同地点、目标存在、关系前缀、Manifest 绑定、Scene 上限或其他硬世界约束。
4. Round Authority 保存实际 `resolutionAuthority` 及命中的 policy trace；角色关系 Event 不保存“特权”字段。Event 回答发生了什么，Authority 解释为什么允许如此裁定。
5. 同一角色、同一动作、同一世界前缀因 `resolutionAuthority` 不同而得到不同结果是允许的，但该上下文必须进入 ruleTraceHash、Authority Hash 和恢复校验。

候选接口如下；字段名在 Accepted 前仍可调整：

```typescript
interface RulebookResolutionAuthorityV1 {
  readonly version: 'resolution-authority/v1'
  readonly sourceRole: 'player' | 'agent' | 'director'
  readonly adjudicationMode: 'standard' | 'manual_player_immediate'
}
```

合法组合穷举如下。`agent + manual_player_immediate` 与 `director + manual_player_immediate` 是必须拒绝的伪造状态，不是可供业务选择的模式：

| sourceRole | adjudicationMode | 语义 |
|---|---|---|
| player | standard | 普通玩家 Action，不具有即时角色关系策略 |
| player | manual_player_immediate | 仅 Host 证明的受限即时角色交互 |
| agent | standard | 自主角色提案 |
| director | standard | Director 提案 |

### 2. 交互目录继续声明能力，不获得执行权

1. 候选 Manifest v9 使用 `interaction-catalog/v2`，在不改写 object-interactions/v1 的前提下增加角色目标。
2. 定义显式声明 `targetKind`、闭合 `operation` 和按来源区分的 initiation policy。首个生产切片只新增 `hold_hand` 与 `release_hand`，保留实体 take/drop/give；不开放任意 guard/effect、脚本、表达式、宏或直接 Event 模板。
3. 创作者可以使用自有命名空间提供 interactionId 和 label，但这些文案不能扩大 operation 的前置条件、效果、观察范围或目标控制权。
4. `hold_hand` 的首版来源策略固定为：人工玩家可以 `commit_then_react`；自主角色不能发起。自主角色可以对自己参与的已存在关系执行 `release_hand`。NPC 发起请求、接受、拒绝或对抗另行版本化。
5. 目录、绑定和策略规范化后进入 specHash、Manifest Hash 与 Registry Hash。运行中的世界不读取可变目录文件。

### 3. 即时成立权只覆盖有限、可逆的当前效果

玩家即时角色交互必须同时满足：

- actor 来自当前 Principal 的 PlayerBinding，且 lifecycle 为 active；
- target 是 Manifest 中不同于 actor 的 active 角色；
- 双方在同一可交互 Location 和 Scene 范围内；
- 目标显式绑定该 interaction；
- 当前事件前缀不存在冲突或重复关系；
- operation 的全部闭合前置条件通过。

该模式不得表达或推导：

- 目标同意、接受、喜欢、害怕、顺从或其他心理/意愿；
- “没有挣脱”“无法说话”“不会反抗”等未来行为；
- 永久、不可解除或阻止目标获得 Reaction 的状态；
- 未注册的移动、伤害、失能、死亡、传送、姿态或持有变化；
- 由 label、原始玩家文本或表现文本暗示的额外效果。

凡是会持续到后续行动的即时效果，都必须是正式关系状态，并为每位受影响角色提供确定性解除路径。无法提供解除语义的 operation 不得声明 `commit_then_react`。

### 4. 首个关系状态是可解除的 hand_hold

1. 成功 `hold_hand` 生成 `character.relation-started@1`，至少包含 relationId、relationKind、initiatorId、targetId、interactionId 和来源 Action 身份。
2. `relationId` 固定由 `deterministicId('relation', { version: 'character-relation/v1', address, sourceActionId, relationKind, initiatorId, targetId })` 生成，实际形状为 `relation:<opaque>`。同一 Action 在同一 WorldAddress 重放产生相同身份；关系结束后的新 hold 使用新的 sourceActionId，因而产生新的 relationId；同一有效前缀不能重复激活同一 relationId。fork 继承已有 Event 时保留父 Branch 已写入的 relationId，不使用子 Branch 地址重算历史 ID；fork 后的新 Action 使用子 Branch WorldAddress 派生新 ID。
3. 任一参与者执行 `release_hand` 生成 `character.relation-ended@1`，包含 relationId、endedByCharacterId 和闭合 reason。
4. `release_hand` 只能结束行动者本人参与且当前 active 的关系。其他角色、过期关系和已结束关系均拒绝。
5. 任一参与者成功 move、离场或变为非 active 时，Rulebook 在同一候选执行中追加 `character.relation-ended`，reason 分别为 `participant_moved` 或 `participant_unavailable`。`hand_hold` 不阻止移动。
6. 当前关系是 Event 的时态 Projection，不是单独事实源。重建必须校验 start/end 前缀、参与者身份与状态迁移，损坏时 fail-closed。
7. 首版不建模左右手、手部占用数量、力量、体型、压制或战斗。`grapple`、`restrain`、`push_down` 不能伪装成 hand_hold 别名。
8. relationId 是不透明定位符，不是 capability。只有关系参与者能从 Context Affordance 枚举可执行的 relationId；真正授权始终来自 Rulebook 对行动者参与身份的重验。第三方可按 Scene policy 看见关系事件的公开语义，但不获得可调用的关系句柄；即使猜中 relationId，Rulebook 仍拒绝。

### 5. 玩家自然语言先解释为提案，再进入 Round

1. Manifest v9 的完整 Schema 从 C1 起即包含可选 Player Input Policy：`legacy-speech/v1` 或 `player-intent/v1`。C1/C2 只允许前者激活，且都是不可发布的内部工程门禁；到 C3 完成耐久解释、降级和恢复后才允许后者激活。旧世界继续执行 ADR-0023：普通文本逐字成为 `character.speak`，不隐式升级。
2. 新入口先耐久受理原始文本和 idempotency key，再由不可信 Player Intent Adapter 产生 `player-submission/v2`。解释完成前不建立 World Round，不推进 Tick。
3. `player-submission/v2` 最多包含一个 speak 和一个世界 Action，按原文中的明确顺序排列；复用 bounded-action-group/v1 的组内连续裁定、失败停止和不可插入边界。
4. Adapter 只能从当前角色获授权的精确 Affordance 中选择 Action，并为每个对白/行动保存可核对的原文 span。Action actor 由 Host 固定为玩家角色，Adapter 不能替目标角色提交动作。
5. 原始文本、未映射片段和目标角色陈述可以保存在输入/解释审计与玩家自己的 UI transcript 中，但不得直接进入 World Event、Observation、Character Context、Memory 或 Visible State。只有被 Rulebook 接受的 speak、interaction 与闭合表现码能传播。
6. “我抓住 Alice 的手，她没有挣脱”可以解释为一个 `hold_hand` Action；后半句没有可表达的目标意愿或未来效果，因此不能成为世界事实。系统不得把整句降级为对白或 manifestation 来绕过该限制。
7. 同一已受理原文和 idempotency key 的解释终态不可改写。崩溃恢复读取耐久解释结果；不能重新调用模型后得到不同 Action。
8. 无有效 Affordance、多个高影响解释并存或引用无法唯一绑定时，产生耐久 clarification，不建立 Round。纯格式问题不得通过猜测补齐。
9. Player Intent Provider、Profile、单次预算和截止时间必须版本化并遵循 ADR-0032。终态闭集为 `clarification_required`、`invalid_response`、`timed_out`、`timed_out_ambiguous` 和 `cancelled`；失败、超时或预算不足必须确定映射到其中一项，不允许一个解释记录永久占住玩家 FIFO。
10. 生产 `PlayerInputInterpreter` 现有的 `/act interact <canonical-json>`、`/act speak <canonical-json>` 通用结构化入口和 `/move <locationId>` 专用入口始终保留为不依赖解释 Provider 的确定性降级。在 `legacy-speech/v1` 下，普通非命令文本仍直接表达 speak；在 `player-intent/v1` 下，普通文本进入耐久解释，只有 validated PlayerSubmission 中的 speak 才能传播。未来若增加 `/say`、`/interact` 别名或 UI Affordance 控件，必须单独定义并测试，本文不把它们声明为既有接口。显式输入仍遵守已受理顺序，不能越过尚未终态的旧解释记录；解释失败也不得自动把原文降级为 speak。
11. 解释 attempt 进入任一终态后才到达的 Provider 响应只写非权威审计，不得把 `clarification_required`、`invalid_response`、`timed_out`、`timed_out_ambiguous` 或 `cancelled` 改回 validated。

### 6. 目标先获得同轮反应权，随后复用 Reaction Cycle

1. Application 在调用 NPC Provider 前，以同一 Rulebook 和同一冻结事件前缀预裁定完整玩家行动组，得到玩家候选状态 S1。
2. Provisional ReactionView 必须包含按 Scene 裁剪的已接受候选效果，而不只是原始 playerAction。直接目标在 S1 中能看见 relation-started，并获得基于 S1 计算的 `release_hand` Affordance。
3. 玩家组保持 phase 0；NPC/Director 保持 phase 1。目标可以在同一 Root Round 提交 release、speak、move 或 abstain，最终 Action 仍按稳定组顺序在最新候选前缀上重裁。
4. Provisional Event、Observation、Affordance 与正式提交内容必须通过 actionId、draftOrdinal 和 contentHash 绑定。在同一 S0、同一 Resolution Authority、同一玩家 Action 下，provisional 与 final 字节不一致属于完整性失败，不允许用“模型已经看过”作为提交理由。
5. 目标 Provider 超时、不可用、预算不足或 abstain 不回滚已合法的玩家效果。Round 如实提交参与者终态；后续已启用的 responsive/v1 Reaction Cycle 可以继续基于正式 Observation 反应。
6. 不新增同步 InteractionQueue，不在 SQLite 事务中等待目标模型，不让同 wave NPC 看见其他 NPC 未提交提案，也不扩大既有 3 waves / 8 calls / 每角色 2 calls 上限。

最终阶段区分三类失败：

| 条件 | 分类 | 处置 |
|---|---|---|
| 同一冻结输入下玩家 provisional/final 内容或 Hash 不一致 | 完整性失败 | 整轮不提交，进入现有完整性处置 |
| phase 1 NPC Action 因玩家效果或更早 phase 1 Action 而失效 | 正常领域 rejected | 记录确定原因；不回滚已合法的 phase 0 玩家效果 |
| Head、Writer Fence 或冻结前缀不再满足本轮提交条件 | 并发/恢复失败 | 按既有 Writer Lease、Inbox 与恢复契约中止或重试，不伪装成领域结果 |

玩家组是不可插入的 phase 0，因此 phase 1 NPC 不能“先移动”并使玩家 hold 合法失效；若出现这种结果，应视为排序或隔离不变量被破坏。

实现规格必须冻结 `player-provisional-resolution/v1` Hash，至少覆盖 WorldAddress、S0 Head、玩家 Action、resolutionAuthority、status/reason、按 draftOrdinal 排序的 EventDraft、Observation Scope 与 ruleTraceHash。每个参与者的 ContextReceipt 还必须绑定该 Hash、裁剪后的 provisional Observation 和 S1 affordanceHash；relationId 不得因为视图裁剪而改变。

### 7. Observation、Memory 与 Presentation 只消费已裁定事实

1. 直接目标获得完整 relation Observation 和可执行 relationId；同 Scene 第三方按 Scene policy 获得 full、occurrence-only 或 none，Scene 只能缩小 Rulebook 上限。第三方 Observation 不携带可用于提交 `release_hand` 的关系句柄。
2. Memory 可记录“玩家牵住 Alice 的手”和“Alice 随后抽回手”，不能从 relation 自动生成“同意”“信任”“喜欢”或其他 Claim/Affect。
3. Presentation 按已接受 Action、关系 Event 和闭合 Performance 渲染。原始输入中的目标反应若没有对应 Event，不得作为系统叙述重复。
4. 当前 v7/v8 闭合表现码保持独立语义；本 ADR 不恢复自由 `manifestation.description`，也不允许表现字段建立关系、位置或姿态状态。

### 8. 候选版本、迁移与恢复

版本不作为一个不可拆分的大锁引入，候选切片为：

| 切片 | 本切片冻结的版本 | 不随本切片引入 |
|---|---|---|
| C1 关系领域闭环 | Manifest v9 完整 Schema、interaction-catalog/v2、resolution-authority/v1、关系 Event Registry、升级后的 Round Authority（候选 v5） | Player Intent 运行时、NPC 同轮 relation 输出协议 |
| C2 Provisional ReactionView | S1 content binding、Context/Receipt 与目标动态 Affordance；仅当 v5 的实体目标语义不能兼容 relation target 时才引入 submit_actions/v6 | 自然语言玩家解释 |
| C3 Player Intent | player-intent/v1、player-submission/v2 | 不因玩家输入解释自动升级 NPC 输出协议 |

1. 当前仓库的 `builtin:speak-move@3` 是 historical-only Mystery Rulebook，不能成为新世界候选。本 ADR 不预先指定新 Rulebook 版本；C0 必须决定 Manifest v9 是否能在保持旧 Manifest 行为不变的前提下复用 Core Resolver，或是否需要新的 Rulebook ID/版本。
2. resolutionAuthority 必须进入耐久 Authority，因此 Round Authority 必须升级；v5 是待 C0 核对当前 Registry 后冻结的候选编号。World Schema v18 和 Logical Authority v8 同样只是占位候选，不构成锁。Schema spike 必须先确认 Player Intent Inbox/解释终态、关系事件、Authority 扩展和 Reaction 恢复是否能安全复用现有 JSON 列；不得为避免迁移而把耐久责任退回内存。
3. v1～v8 Manifest、旧 Rulebook、旧 Round Authority、旧输入解释和 object-interactions/v1 保持原字节与行为。Registry 精确匹配失败时拒绝加载，不做版本 fallback。
4. 活动世界不原地获得新语义。首版只允许新世界或受控的新 Manifest Epoch；导入旧逻辑格式不得补造玩家解释、关系或裁决模式。
5. Player Intent dispatch、ProviderCall、World COMMIT 和 post-commit adopt 的歧义分别恢复；已 dispatch 且没有耐久响应的外部解释调用不得自动重发，除非 Provider 提供并验证了相同幂等身份。
6. Authority、Event、Head、Outbox 与 Reaction Job 继续原子提交；Input/Context/Memory/Provider I/O 不在 `BEGIN IMMEDIATE` 内等待。

## 后果与非目标

- 玩家无需先取得目标同意即可推进允许的当前镜头，目标仍保有同轮及后续解除、移动、说话和其他行为权。
- Rulebook 从“相同角色/动作一律同策略”扩展为“相同世界状态、Action 与可信 Authority 上下文得到确定裁定”；审计和 Hash 范围相应扩大。
- Player Intent 引入新的耐久工作流和失败面，成本高于客户端临时翻译，但避免同键重试改变世界意图。
- 首版只验证 hand_hold/release_hand。拥抱、阻拦、抓捕、伤害、请求/接受、NPC 主动身体接触、多方关系、持续跟随、身体部位和任意规则插件均不在范围内。
- 玩家即时成立权不是内容安全或现实同意模型；它只是该单人 RP 世界的版本化叙事裁决策略。

## 验证门禁

- 非玩家来源、伪造字段、错误 Principal/PlayerBinding 和跨 Branch 输入不能获得 `manual_player_immediate`。
- 玩家 hold、目标同轮 release、目标 abstain、目标 move、Provider 失败和后续 Reaction 六条路径均有模型无关集成测试。
- 远距、inactive、自目标、未绑定、重复 relation、第三方 release、过期 relation 和损坏 Event 前缀全部拒绝或 quarantine。
- 玩家输入“她没有挣脱/无法反抗/永远服从”不能在 Event、Observation、Memory 或 Visible State 中留下对应事实。
- Player Intent 受理、dispatch 前后、解释落盘前后、Round enqueue 前后、World COMMIT 前后均覆盖重启或硬终止；同键不重复调用或产生不同 Action。
- Live、Full Replay、Snapshot Replay、Restart、fork-as-of 和逻辑导入得到相同关系状态、Authority Hash 和 Context Hash。
- 真实模型试玩同时核对输入解释率、澄清率、无效输出率、响应延迟，以及 Event → Observation → Memory 的事实一致性。
- C0 必须先记录组合子去留、目标 Provider 矩阵、预先声明的调用样本与失败率阈值，并把每个残留失败归类到具体 Schema 构造、Validator 路径或 Provider 不遵循协议；当前 17/13/4 次观测与 2/2 A/B 只作为基线，不单独充当发布证明。
- 生产代码变更必须保持逐文件四项 100% 覆盖，并通过 `corepack pnpm@11.7.0 check`。

## Evidence → Finding → Path

### Evidence

- E-001：`packages/kernel/src/interactions.ts` 已以闭合 take/drop/give operation 实现目录绑定、最新前缀重验、明确 `entity.transferred` Event 和动态 Affordance。
- E-002：`packages/application/src/round-coordinator.ts` 已在 Provider 调用前预裁定玩家单 Action，构造并向 `#freezeParticipants` 传递名为 `world-player-candidate-s1` 的 candidateHash，最终循环再让玩家 phase 0 Event 先进入 NPC Action 的候选前缀。当前 Hash 只绑定冻结 Head、玩家 Action 与可选 Manifestation，尚未绑定 provisional Event、Observation、Affordance 或 rule trace。
- E-003：`packages/application/src/context-pipeline.ts` 当前把 playerAction 作为 stimulus，却使用 Root Round 开始前 history 计算 Affordance，因此尚不能让目标在同轮看到由玩家候选关系新产生的 release 选项。
- E-004：`packages/application/src/player-input.ts` 当前把非命令普通文本直接解释为 speak；自然动作仍依赖明确命令或实验适配器。
- E-005：自由 manifestation 文本曾传播未经 move 裁定的位置陈述，证明“只在提示词中禁止越权”不能形成结构性边界。

### Finding

- F-001：现有 interact、phase 0/1、Provisional Observation、Authority 和 Reaction Cycle 足以承载“先成立、后反应”，无需引入同步 request/accept 生命周期。
- F-002：真正缺口不是一个用户可见布尔字段，而是可信来源上下文、闭合角色关系效果、候选状态 Affordance 和耐久玩家解释四项契约。
- F-003：只要目标意愿和未来行为没有可提交字段，自由文本就无法借即时成立权冻结 NPC；关系的解除与移动规则提供后续行为权。

### Path

```text
关闭当前 v8 试玩契约门禁
→ 新 ADR/Schema spike 与模型无关 hand_hold 原型
→ Host 派生 Resolution Authority
→ interaction-catalog/v2 与关系 Event/Projection
→ 玩家组候选 S1 与目标 Provisional Affordance
→ 耐久 Player Intent 解释
→ Observation/Memory/Presentation/Recovery
→ 真实模型长程试玩
→ 完整工程门禁
```
