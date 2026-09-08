# ADR-0084：玩家自然语言外显表现输入

- 状态：Accepted
- 日期：2026-09-09
- Extends：ADR-0023、ADR-0048、ADR-0083

## 背景

ADR-0083 已允许角色 Provider 在唯一 Action Proposal 旁提交 `manifestation`，但人工控制的玩家入口仍只能提交 `speak`、`move` 或 `take`。这使 NPC 可以表达语气、视线和姿态，玩家角色却只能提交裸行为，破坏了同一世界内角色表达能力的对称性。

玩家不应学习 JSON 或 Provider Tool Schema。自然语言翻译器也不能绕过 Rulebook、直接写 Event、Observation 或 Memory。

## 决定

1. 人工玩家 Round 允许在唯一 `PlayerActionInput` 旁携带可选 `ManifestationProposal`。其结构、尺寸、Channel、Persistence 和状态操作限制与 `submit_actions/v3` 完全相同，不创建第二套表现协议。
2. `manifestation` 只在 Manifest 明确启用 `manifestation-policy/v1` 时可受理；旧 Manifest、未启用世界和不含该字段的旧请求保持原字节、Hash 与行为。
3. 玩家 Manifestation 与玩家 Action 独立裁定，并进入同一 Round Authority、Event、Tick、Head 和 Outbox 事务。Action 被拒绝时，合法外显 Cue 仍可独立成为事实；表现裁定失败不得改变 Action 结果。
4. 自然语言适配器是不可信输入翻译器。它只能把玩家明确表达的一个主行为和可观察细节转换为候选输入；不得推断隐藏情绪、动机、秘密或替玩家补写表现。歧义必须澄清，不能猜测。
5. 试玩适配器只接受能够在原始玩家文本中核对的对白和 Cue 描述。翻译后的结构化输入一旦进入耐久 Round Inbox，重放只读取该记录，不再次调用翻译模型。
6. 本版本不新增 `wait`、`emote` 或第四种基础动作。完全无主行为的沉默表现继续遵守 ADR-0083 的推迟决定；适配器应返回澄清，而不是伪造空对白。
7. 玩家 Observation、其他角色 Observation、Reaction Cycle、Memory、Visible State 和 Presentation 继续只消费已提交、按 Scene 裁剪的事实，不读取翻译模型原始输出。

## 后果

- 玩家可以输入“我皱了皱眉，避开 Bob 的视线说：‘随你。’”，系统将其转换为一个 `speak` 候选和可选外显表现，并以与 NPC 相同的方式裁定和传播。
- 旧调用者继续只提交 `action`；只有新调用者显式提交 `manifestation` 时，Round Inbox 与 Authority Hash 才包含新增语义。
- 完全沉默的非语言行动仍需后续独立决定通用行为载体，避免借本改动偷加动作词汇。

## 验证

- 玩家 Action 无表现时，旧 Inbox 输入、Authority、Event 和 Bundle Golden 不变。
- 启用世界中，玩家表现覆盖 accepted、partially accepted、rejected 以及 Action accepted/rejected 组合。
- 未启用世界、畸形 Cue、重复 cueId、非法持续状态和同幂等键改写表现均 fail-closed。
- Scene 内完整观察者、occurrence-only 观察者和不在场角色获得正确裁剪；Memory 只捕获已提交 Observation。
- 试玩翻译器覆盖对白、移动、拿取、显式可观察表现、内部心理排除、歧义澄清和模型失败安全回退。
