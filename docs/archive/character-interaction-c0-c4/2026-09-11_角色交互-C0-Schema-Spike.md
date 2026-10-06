# 2026-09-11 角色交互 C0 Schema Spike

| 属性 | 值 |
|---|---|
| 对应 ADR | `ADR-0087-player-immediate-character-interactions.md` |
| 对应规格 | `character-interactions-v0.1.md` |
| 状态 | 工程版本边界已冻结；真实 Provider 出闸样本待运行，C0 尚未关闭 |
| 分支 | `codex/player-immediate-character-interactions` |
| v8 代码基线 | `5d6b982 fix: align grouped manifestation schemas` |
| 设计基线 | `26bc98c docs: define player character interaction plan` |
| 授权基线 | `171798e docs: accept staged character interaction implementation` |

本文只冻结 C0 的工程边界，不把尚未运行的真实模型样本写成通过。C1～C3 仍是不可发布的内部工程门禁；只有 ADR-0087 定义的全部发布门禁关闭后，Manifest v9 才能成为发布候选。

## 1. 已核实事实

| Evidence | 代码事实 | 含义 |
|---|---|---|
| E-C0-001 | `packages/store-sqlite/src/world-store.ts` 当前 `WORLD_SCHEMA_VERSION = 17`；Event data、Manifest 与 Round Authority 都以 canonical JSON 存入现有列 | 新 Event 类型或 Authority 对象新增字段本身不要求 DDL |
| E-C0-002 | `packages/store-sqlite/src/logical-transfer.ts` 的 `dshworld-authority/v7` 按固定表/列导出；导入对 `authority_json` 只重算 `world-round-authority` Hash，不按 Round Authority 内部 schema 分支 | 表集合不变时，新的 Manifest/Event/Authority JSON 可以沿用 Logical v7 |
| E-C0-003 | Manifest v8 已在 `builtin:speak-move@2` 上通过 Manifest capability gate 扩展 `interact`；Registry 是精确 ID/version 匹配，没有 fallback | Manifest v9 可复用 Core Resolver @2，而无需占用 historical-only @3 或伪造 @5 继承关系 |
| E-C0-004 | `packages/application/src/round-coordinator.ts` 对 v7/v8 写入 Round Authority `schemaVersion: 4`；Authority Hash 覆盖整个 JSON 对象 | C1 增加 `resolutionAuthority` 时必须升级 Round Authority，但不要求 SQL 迁移 |
| E-C0-005 | 当前 `submitText` 在网络调用前没有耐久 Player Intent 状态；`round_clarifications` 只保存同步解释终态；`ProviderCallStore` 要求 Round/Context Receipt 身份且位于可重建 Context DB | C3 不能把解释调用塞进现有同步路径，也不能仅靠现有 clarification 或内存状态恢复 |
| E-C0-006 | 当前 Context DB 为 schema v5；`provider_calls` 的唯一键固定为 `(namespace, round, participant)`，用途隐含为 Round participant | Player Intent 若复用 ProviderCall 生命周期，需要显式用途/输入身份，不能冒充 NPC participant |
| E-C0-007 | `world-player-candidate-s1` 已在玩家基础裁定后生成并传给 `#freezeParticipants`，但 NPC Context 仍由旧 history 构造 | C2 是让 Context 消费现有 S1 接缝，不是新建另一条协调协议 |
| E-C0-008 | v8 修复后完整 `corepack pnpm@11.7.0 check` 通过：96 个测试文件、968 项测试、生产 `src` 四项覆盖率 100%、P0～P6、3 项性能测试与 39 项硬终止测试通过 | v8 代码基线可以与角色交互改动独立评审 |

## 2. 冻结决定

### 2.1 C1/C2 不升级 World SQLite 或 Logical Authority

| 切片 | World Schema | Logical Authority | 原因 |
|---|---:|---:|---|
| C1 关系领域闭环 | v17 | v7 | Manifest v9、关系 Event 与 Round Authority v5 都使用现有 canonical JSON 列；表/列集合不变 |
| C2 Provisional ReactionView | v17 | v7 | S1 binding、Context Receipt 和动态 Affordance 使用既有 World/Context 记录，不增加 World 表 |
| C3 耐久 Player Intent | **v18** | **v8** | 新增权威输入解释状态表，Logical export/import 必须显式传输该表 |

Logical 格式版本跟随可传输的表/列集合，而不是跟随每一种 JSON payload 的内部版本。因而 C1/C2 把 Logical v7 升成 v8 只会制造空迁移；C3 新表出现时才升级是可判定边界。

旧二进制读取 Manifest v9 必须在 `runtimeManifestFromStored` 处 fail-closed。旧二进制即使把同表形状的 Logical v7 文件导入成功，也不得把 v9 世界降级运行；“导入文件”不等于“世界已被运行时接受”。

### 2.2 Round Authority 在 C1 升为 v5

Round Authority v5 在 v4 字段上增加逐 Action 的可信裁决上下文：

```ts
interface RoundAuthorityV5 {
  readonly schemaVersion: 5
  // v4 fields remain byte-for-byte unchanged in meaning
  readonly actions: readonly Array<{
    // existing action authority fields
    readonly resolutionAuthority: {
      readonly version: 'resolution-authority/v1'
      readonly sourceRole: 'player' | 'agent' | 'director'
      readonly adjudicationMode: 'standard' | 'manual_player_immediate'
    }
  }>
}
```

具体对象仍由 Host 从 PlayerBinding 或已冻结的 Round participant 派生。Action parameters、Provider proposal 和 World Pack 都没有提交单次 `sourceRole` / `adjudicationMode` 的入口。Authority Hash 继续使用现有 `hashWorldJson('world-round-authority', authority)`，因此新增字段自动进入完整性边界。

### 2.3 Manifest v9 复用 `builtin:speak-move@2`

C1 冻结为复用 Core Resolver @2，并以 Manifest v9 capability gate 启用 interaction-catalog/v2 与关系 operation：

- 不注册 `builtin:speak-move@3`：它是 historical-only Mystery Rulebook；
- 不注册 `builtin:speak-move@5`：当前仓库不存在一条由 @2 直接演进到 @5 的 Core 版本轴，使用 @5 会与既有 @3/@4 Mystery 语义制造错误继承暗示；
- 不修改 Manifest v1～v8 的 gate：旧 Manifest 仍走原分支、产生原 Event/Hash；
- Registry 继续精确匹配 `builtin:speak-move@2`，不存在版本 fallback；Manifest v9 的 registriesHash 单独包含新增 action/event 定义。

这里的兼容先例不是推测：Manifest v8 已经在同一 @2 resolver 下用 Manifest gate 把 `take` 替换为 `interact`。C1 沿用这个仓库已有的版本含义——Rulebook ID/version 选择确定性实现家族，Manifest capability 选择该世界冻结的闭合词汇与功能。

### 2.4 `submit_actions/v6` 不随 C1 自动引入

- C1 没有目标 NPC 的同轮关系 Affordance，NPC 仍提交 v5 的既有 speak/move/interact 语义；
- C2 先尝试把 relation target 表达为 v5 `interact` 的严格 target/arguments 变体；
- 只有证明 v5 的“实体 target”冻结语义不能无歧义承载角色关系 target 时，C2 才引入 submit_actions/v6；
- C3 不因 Player Intent 自然语言解释而顺带升级 NPC 输出协议。

### 2.5 C3 使用 World v18 + Logical v8 + Context v6

C3 的持久化所有权冻结如下：

| 数据 | 权威库 | 冻结理由 |
|---|---|---|
| 原始文本 Hash、受理序号、Principal、Manifest/as-of、解释状态、终态、validated PlayerSubmission、Round enqueue 绑定 | World DB `player_input_jobs` | 决定玩家 FIFO、幂等、是否允许生成 Round；不能是可丢失缓存 |
| 精确模型请求/响应、receipt、token/Provider metadata、append-once dispatch 生命周期 | Context DB `provider_calls` v2 语义 | 复用已有网络边界与 `prepared → dispatch_started → response_received` 恢复规则 |
| World Event / Observation / Memory | 仅 accepted Rulebook effects | 原始文本、解释理由和目标未来陈述不进入事实传播链 |

World Schema v18 新表必须至少能表达以下闭集，最终 DDL 名称可在 C3 实现提交中机械调整，但不得减少状态或绑定：

```text
player_input_jobs
  address_key + input_seq                    -- Branch FIFO
  idempotency_key UNIQUE per address
  input_hash + principal_id + original_text
  manifest_hash + accepted_head_seq
  status: received | prepared | dispatch_started | response_received |
          validated | clarification_required | invalid_response |
          timed_out | timed_out_ambiguous | cancelled | round_enqueued
  model_call_id nullable, UNIQUE when present
  submission_json/hash nullable, append-once
  result_json/hash nullable, terminal or enqueue receipt
  round_inbox_seq/round_id nullable, both present only at round_enqueued
  claim_owner_id + fencing_token nullable according to live states
```

Context Schema v6 不能让 Player Intent 伪装成一个已经存在的 Round participant。ProviderCall identity 增加闭合用途与工作键：

```text
purpose: round_participant | player_intent
work_id: existing round/participant identity or player input identity
```

旧 v1 Round ProviderCall 的 identity/hash 不能重写；迁移只补能确定推导的 discriminator。Player Intent 使用新的 intent/hash domain。Context DB 仍是可重建库，但 World `player_input_jobs` 保存足以判定是否可安全重建、是否已经 dispatch 以及是否必须进入 `timed_out_ambiguous` 的权威状态。

## 3. Player Intent 崩溃窗口

| 窗口 | 重启可见记录 | 确定处置 |
|---|---|---|
| 原文写入前崩溃 | 无 input job | 客户端可用同键重试 |
| `received` 后、ProviderCall `prepared` 前 | World job 存在 | 用冻结 input/as-of 幂等 prepare |
| ProviderCall `prepared` 后、World job 绑定前 | Context 有确定 modelCallId，World job 尚未绑定 | 用确定 identity 对账并绑定，不 dispatch 第二个调用 |
| 两库都记录 `prepared`、dispatch 前 | 两侧一致 | 可安全 dispatch 一次 |
| `dispatch_started` 后、响应耐久前 | 调用结果未知 | `timed_out_ambiguous`，不自动重发 |
| response 已耐久、World job 尚未 adopt | Context 有 response | World 按 Hash adopt，同一结果只校验一次 |
| validated submission 后、Round Inbox enqueue 前 | World job 含 append-once submission | 幂等 enqueue 同一字节 |
| Round Inbox 已 enqueue、job 尚未标记 | Inbox 可按 idempotency key/receipt 对账 | adopt 为 `round_enqueued`，不重复 Round |
| World COMMIT 后、ProviderCall/job adopt 前 | Round Authority、Inbox、Head 可对账 | 补 `committed`/终态，不改 Event |

两库之间没有伪造的跨库原子事务。恢复依赖确定 ID、append-once Hash 与显式 adopt；每个窗口都必须有子进程硬终止测试。

## 4. v8 Provider 出闸矩阵（运行前声明）

本节在新一轮真实调用前冻结，不能在看到结果后修改阈值。

| 项 | 发布目标 | 诊断路径 |
|---|---|---|
| Provider / model | deepseek / `deepseek-v4-flash`（若账号实际 ID 不同，运行前另起修订记录精确 ID，不覆盖本文） | ollama / `qwen3.5:4b` |
| Pack / catalog | `ai-girls-awaken.worldpack.json` + `ai-girls-awaken.interactions.json` | 相同 |
| Renderer / protocol | `grouped-playtest/v2` / submit_actions/v5 | 相同 |
| 样本 | 至少 20 次 NPC Provider 调用；不足则继续固定输入序列，不能按结果提前停 | 4 次 smoke，不设发布阈值 |
| 无效输出阈值 | `invalid_response / calls <= 10%`，即前 20 次最多 2 次 | 只归类兼容性，不阻塞 DeepSeek 单 Provider 发布范围 |
| 分类门禁 | 0 个未分类失败；每个无效输出都有 `validationError`、受限 `rawOutput` 与 truncation 标记 | 同样要求可分类 |
| 结构门禁 | 0 次因缺 `independent` / `onSuccess` 或误读 `anyOf/allOf/not/contains` 而失败 | 记录，不作为发布阻断阈值 |

固定输入序列使用全新 data directory，并按顺序提交：

1. `大家先分别介绍自己，并说说眼前最想确认的事。`
2. `/interact entity:phone core:take`
3. `你们看见我刚才拿手机了吗？各自怎么想？`
4. `/move location:living-room`
5. `到客厅后，谁愿意先看看这里有什么？`

每个 Root 输入等待当前 Reaction Cycle 到稳定边界后再提交下一条；到达 20 次调用后仍完成当前已打开 wave，避免按结果截断。调用计数、accepted/invalid、具体错误路径和证据文件名写入新的日期记录，不回写历史观测。

当前 Codex 进程没有继承 `DEEPSEEK_API_KEY`。尝试以 `deepseek-worker.ps1` 启动只读 DeepSeek 子进程时在发出网络请求前 fail-closed；没有调用模型，也没有修改文件。因此本节仍是预声明门禁，不是通过记录。

## 5. Relation 纯函数原型约束

C1 实现前的纯函数原型必须对同一 Event prefix 得到以下确定结果；这些用例将直接成为 Kernel 单元测试，不以模型输出判断成功：

| 前缀 + 输入 | 预期 Event 后缀 |
|---|---|
| 无 active relation + 合法 player immediate `hold_hand` | 一个 `character.relation-started` |
| 同一 sourceActionId 重放 | 同一 relationId、同一 Event 字节 |
| 新 sourceActionId 再次 hold 同一双方 | 领域 rejected，不覆盖已有关系 |
| active relation + 任一参与者 `release_hand` | 一个 `character.relation-ended(reason=released)` |
| active relation + 参与者成功 move | `character.moved` 后追加 `character.relation-ended(reason=participant_moved)`；move 不被关系阻止 |
| active relation + 参与者变为非 active | lifecycle Event 后追加 `character.relation-ended(reason=participant_unavailable)` |
| 第三方给出 relationId 执行 release | 领域 rejected；猜中 ID 不构成授权 |
| 关系 start/end 前缀次序、参与者或 relationId 损坏 | fail-closed integrity error，不静默当作 inactive |

relationId 仍使用 ADR-0087 已冻结的完整输入与 child WorldAddress；fork 继承旧 Event 时保留旧 ID，fork 后新 Action 使用子 Branch address 生成新 ID。

## 6. Evidence → Finding → Path

### Finding

| Finding | 结论 | Evidence |
|---|---|---|
| F-C0-001 | C1/C2 的新语义不改变 World 表形状；World v18 / Logical v8 属于 C3，不应提前打包 | E-C0-001、E-C0-002、E-C0-005 |
| F-C0-002 | Core @2 + Manifest v9 capability gate 是仓库原生兼容路径；@3 明确禁止，@5 会制造错误谱系 | E-C0-003 |
| F-C0-003 | `resolutionAuthority` 必须进入 Round Authority v5，但现有 Authority JSON/Hash 列足够 | E-C0-004 |
| F-C0-004 | Player Intent 需要 World 权威 job 与 Context ProviderCall 的双记录恢复，不能在每回合前临时调用模型 | E-C0-005、E-C0-006 |
| F-C0-005 | v8 静态门禁已通过，真实 Provider 门禁仍因环境凭据不可见而未运行 | E-C0-008、§4 |

### Path

```text
C0a v8 schema/code baseline (5d6b982)
→ C0b version and persistence decisions (this document)
→ C0c predeclared DeepSeek 20-call gate
→ only after C0c passes: C1 Manifest v9 + relation domain + Authority v5
→ C2 existing S1 seam becomes a real provisional ReactionView
→ C3 World v18 + Logical v8 + Context v6 durable Player Intent
```

## 7. 出闸清单

- [x] v8 组合子去留已决：保留 enum/required，移除 `anyOf/allOf/not/contains`；
- [x] v8 契约修复与角色交互文档拆成独立提交；
- [x] 完整工程门禁通过并记录可复现代码基线；
- [x] Manifest/Rulebook/Round Authority/World/Logical/Context 版本归属已冻结；
- [x] Player Intent 恢复所有权与崩溃窗口已冻结；
- [x] 目标 Provider、固定语料、样本数和阈值已在运行前声明；
- [ ] 使用可见于当前进程的 `DEEPSEEK_API_KEY` 完成 20-call 发布目标复测；
- [ ] 所有残留无效输出归类，且 DeepSeek 门禁满足 §4；
- [x] relation start/end/move-end 约束已由 `tests/experiments/character-relation-spike.test.ts` 纯函数原型验证；C1 须将同一用例迁入 Kernel 正式实现；
- [ ] C0 关闭后才开始 C1 生产实现。
