# 审查修复记录：Round 账本与悬疑 Demo

- 日期：2026-08-23
- 来源：GLM 5.3 对 Round Authority、实体规则和三角色悬疑 Demo 的独立审查
- 范围：只修复已确认的账本可重算性、同轮竞争、Demo 输出边界与玩家视图授权；不引入真实模型或新事实源

## 修复思路

### 1. 分开保存“提案原序”和“裁定顺序”

旧账本把全局裁定 ordinal 误称为 `proposalOrdinal`。修复后，每项 Action 顶层保存它在所属 Proposal 内的原始序号；`orderKey` 只保存真正影响全局裁定的 phase、roleRank、priority、actorId、actionId。这样可以从同一份耐久账本分别重建原 Proposal 和实际裁定序列，并独立重算 `proposalHash`。

Authority 新写入格式升为 schemaVersion 2，旧 v1 Authority 不改写。该决定记录于 ADR-0046。

### 2. 不伪装不存在的外部模型/预算记录

当前 Provider Port 没有写入 ModelReplayStore 或独立预算凭证，因此不再使用看似外键的 `modelCallId`、`budgetDecisionId`。新字段 `providerInvocationId`、`budgetEvaluationId` 只表示 Authority 文档内的稳定关联身份；`modelReplayRecordHash`、`budgetReservationRecordHash` 显式为 null。未来只有在对应外部记录真实存在且可校验时才填 Hash。

### 3. 用正式 Round 管线锁定同轮物品竞争

新增两个 Agent 同轮执行 `take(entity:key)` 的集成测试。高优先级 Agent 先取得物品，低优先级 Agent 必须基于已经接受的事件前缀重新裁定为 `ITEM_NOT_AVAILABLE`；最终只有一个 `entity.taken`。同时，实体事件前缀遇到匹配 ID 的畸形 `entity.upsert` / `entity.taken` 时改为 fail-closed，避免静默降级成错误状态。

### 4. 区分作者全知快照与玩家输出

`MysteryDemoScenario.snapshot()` 是作者/调试能力，包含四个 CharacterView 和 Authority，不能整体进入玩家通道。文档示例改为只输出 head、公开实体状态和 `views.player`。Demo Scenario 也不再直接打开 WorldStore，而是通过 WorldApplication 的完整性检查读取 Event/Authority；缺少预期实体或 Authority 时 fail-closed。

CLI 输出新增 `execution: executed | durable_replay`，明确区分首次执行与同幂等键的耐久重放。

### 5. 把隐私边界放在入口，而不是相信 payload

Goal/Claim 内的 `visibility` 与 `epistemicStatus` 只是故事语义元数据，不是授权依据。真正的访问边界仍是 owner-scoped CharacterView。`view.character` JSON-RPC/CLI 现在必须提供 principalId，并且只能读取冻结 PlayerBinding 对应的 characterId；读取 NPC 或其他玩家返回 `UNAUTHORIZED`。作者进程内调试能力不进入 RPC Port。该决定记录于 ADR-0047。

## 验证证据

- 多 Action Proposal 测试以原序 `action:z, action:a` 提交，确认裁定序为 `a,z`，再按 proposalOrdinal 恢复 `z,a` 并得到相同 proposalHash。
- 同轮双 take 测试确认仅一个 `entity.taken`，第二个 Resolution 为 `ITEM_NOT_AVAILABLE`。
- Application/RPC 测试覆盖正确 PlayerBinding、跨角色读取拒绝和非法 principal。
- Demo CLI 测试覆盖首次 `executed`、重启 `durable_replay`，且输出不含 `is_culprit` / `may_be_involved`。
- `pnpm test:coverage`：35 个测试文件、190 项测试通过；生产源码逐文件 statements/branches/functions/lines 100%。

## 有意保留的边界

- `modelReplayRecordHash` 与 `budgetReservationRecordHash` 仍为 null；接入真实 Harness/模型时需要独立设计真实记录的提交与核对关系。
- 全知作者视图目前只限进程内 API；若未来需要管理员 RPC，必须新增显式 capability，不能放宽 PlayerBinding。
