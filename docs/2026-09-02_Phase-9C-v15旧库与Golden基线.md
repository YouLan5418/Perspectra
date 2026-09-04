# Phase 9C v15 旧库与 Golden 基线

> **用途：** 本文是 P9C.0 的基线证据，固定两件东西：一台真实旧二进制产出的 World Schema v15 部署（迁移与多库恢复演练的来源），以及 `worldpack` v1/v2 的逐值 Golden 基线（P9C.4 零漂移的证明基准）。本文不改变任何 Accepted ADR 的方向。

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-09-02 |
| 冻结旧基线提交 | `c2b314188d391e676497c58a25db3fc824568702`（`chore(release): prepare private 0.3.1 candidate`，World Schema v15） |
| 当前实施分支 | `qwen`（与 `phase9b/bounded-multi-wave` 同指 `cd868dc`） |
| 相关决策 | [ADR-0079](adr/ADR-0079-host-fair-scheduling-backpressure-administrative-stop.md)、[ADR-0080](adr/ADR-0080-world-pack-v3-reaction-policy-creator-entry.md)、[ADR-0081](adr/ADR-0081-deployment-backup-restore-set.md) |
| 演练目录 | `.tmp/v15-baseline/`（被 `.gitignore` 排除，不进入提交） |

## 1. 真实旧库生成命令

在仓库根目录执行：

```bash
git worktree add .tmp/v15-baseline c2b3141
cd .tmp/v15-baseline
corepack pnpm@11.7.0 install --offline --frozen-lockfile --ignore-scripts
mkdir -p fixture-data
corepack pnpm@11.7.0 exec tsx tools/make-v15-fixture.ts fixture-data
corepack pnpm@11.7.0 exec tsx tools/report-v15-watermarks.ts
```

前置条件已核实：`c2b3141` 与当前 HEAD 的 `pnpm-lock.yaml` **逐字节相同**（`git diff --quiet c2b3141 HEAD -- pnpm-lock.yaml` 退出 0），因此离线安装即可复现旧依赖树；`c2b3141:packages/store-sqlite/src/world-store.ts:365` 的 `WORLD_SCHEMA_VERSION` 为 15。

生成器脚本全文见附录 A 与附录 B。脚本只使用旧提交自带的 `tests/fixtures/phase8-provider-world.ts`（Manifest v4 fixture）与旧提交的 `WorldApplication`，不引入当前分支代码。

## 2. 生成结果

第一次运行（`fixture-data`）生成器输出：

```json
{
  "generator": "tools/make-v15-fixture.ts",
  "baselineCommit": "c2b314188d391e676497c58a25db3fc824568702",
  "worldSchemaUserVersion": 15,
  "counts": { "events": 38, "branches": 2, "roundCommits": 4, "reactionTables": 0 },
  "forkSeq": 28,
  "parentKey": "tenant:p8-crash\u001fworld:p8-crash\u001fbranch:main",
  "childKey": "tenant:p8-crash\u001fworld:p8-crash\u001fbranch:child"
}
```

`reactionTables: 0` 证明旧库不含任何 `world_reaction_*` 表，因此 v15→v16 是真正的“新增结构”迁移，而不是重写。

> **2026-09-05 复核更正：** 原始 `c2b3141` 制品的 `context.sqlite` 实际为 `user_version=4`、`application_id=0`，不是本文初稿第 6 节“当前值”表里的 Context v5/`0x48435743`。第 6 节描述的是当前代码目标版本，不是旧制品版本。P9C.5 真盘演练已把 Context v4 前向迁移到 v5 并设置归属标识，迁移前后全部既有 Context 行的内容 Hash 相同。此差异没有被静默修饰，而是作为旧部署恢复矩阵的一部分保留证据。

## 3. 逐文件 SHA-256

同一命令连续运行两次，结果如下（byte length 两次相同）：

| 文件 | 字节 | 第一次 SHA-256 | 第二次 SHA-256 | 逐字节可复现 |
| --- | --- | --- | --- | --- |
| `world.sqlite` | 278528 | `sha256:4f91ee2ecbc38aa0626c922b248441dc1e3b6be8c2c4c7535e4d23df1d71890c` | `sha256:5ed9ccd05f0b5d3b5d0758a271c40b810e224592be1569c6c262e8c0740522ce` | 否 |
| `world.sqlite.audit.sqlite` | 16384 | `sha256:8e9f0d58dbea5807a8084731b1eea92c40613ee82029226ba9baffc7b1681747` | `sha256:2332fd43d52fe7ba4d4dce9aa62ad6eb8a51fe177f2fb459c2d9d43e0125816d` | 否 |
| `session.sqlite` | 45056 | `sha256:9b865633d854f78d90576043ea8ecb33ec21bee139b86839fd5f2ccf20d70ca6` | 同左 | 是 |
| `memory.sqlite` | 172032 | `sha256:287824a1d5cb2cd636deb6a473a848b4e2b38329dbb7ec0906beb44ecf8c21e4` | 同左 | 是 |
| `context.sqlite` | 110592 | `sha256:41c84ae9e869bcb556107930d158d516d943797e2cbae97eb788a5359b143c14` | `sha256:14f62a5ad4542b194fc8f427330c80971b909249a9507e4abce831fab6aed541` | 否 |

**可复现性边界（实测，不是推断）：** `events` 表不含任何墙钟列（DDL 只有 `seq`/`tick`/`event_type`/`event_version`/`data_json`/`previous_hash`/`event_hash`/`transaction_id`/`event_ordinal`），两次运行的 `delivery_id`、`payload_hash`、`transaction_id`、`authorityHash`、`bundleHash` **全等**，即权威层完全确定。差异只来自运维时间戳列：`outbox.first_attempt_at_ms`、`branch_audit_events.operational_time_ms`、`character_runtime_availability.changed_at_ms`、Audit 的 `occurred_at`、Context 的 `provider_quality_audit`。`session.sqlite` 与 `memory.sqlite` 的所有表都不含墙钟列，因此逐字节可复现。

结论：本表的 SHA-256 固定的是**本次演练所用的具体制品**，不是可跨机器复现的 Golden。P9C.5 的迁移与恢复断言必须针对结构、水位与权威 Hash，而不是针对整库字节。

## 4. 跨库水位实测

`report-v15-watermarks.ts` 对第一次制品的输出：

| 库 | 水位 |
| --- | --- |
| World heads | `branch:main` `head_seq=28`、`tick=2`、`event_hash=sha256:038d5039535ad6b18884f76aed582875910eb93c47e77c893682e82a6d698f13`；`branch:child` `head_seq=38`、`tick=3`、`event_hash=sha256:bbacd59d2994b391216630156ecb734aaa75d94e29db3eef253c09c2b7b588f9` |
| World Outbox | 6 行，全部 `delivered` |
| Session cursor | `session:player` `last_delivery_seq=6` |
| Memory 命名空间 | 4 个（main/child × player/npc），`verified_through_seq = captured_through_seq =` 对应 Branch head（main 28、child 38），`memory_epoch=1` |
| Context ProviderCall | 3 行，全部 `committed`；`continuity_checkpoints` 2 行 |
| Audit | `operational_audit_events` 2 行，hash chain 完整 |
| Memory v2 内容 | `cognitive_memory_v2_namespaces=4`、`sources=20`、`receipts=9`、`recall_receipts=3`、`summaries=4`、`cognitive_jobs=0` |

由此得到三条可直接写进 ADR-0081 校验器的不变量：

1. Session cursor（6）== World 已投递 Outbox 行数（6）；
2. 每个 Memory 命名空间水位 == 对应 Branch 的 `head_seq`，且不超过它；
3. Context `committed` ProviderCall 数（3）== 产生 NPC 提案的 Round 数（parent 2 + child 1）。

## 5. World Pack v1/v2 Golden 基线

P9C.4 必须保持以下断言值不变（`worldpack-source/v1`、`worldpack-source/v2`、compiled `worldpack/v1`、`worldpack/v2` 与 Manifest v1～v4 冻结，见 [ADR-0080](adr/ADR-0080-world-pack-v3-reaction-policy-creator-entry.md)）：

| 基线 | 值 | 固定位置 |
| --- | --- | --- |
| v1 `pack:tavern` packHash | `sha256:9f64a1428bebd5e7bd005dffb0315e46c912b772be55f99bd8b04b72c44af381` | `packages/world-pack/src/compiler.test.ts:146` |
| v1 canonical bytes | 3390 字节，`sha256:e060b076dc05d1eafa78f0a13781637f2261a6fd84eb5c4d212c0c63655407c9` | `packages/world-pack/src/compiler.test.ts:149-152` |
| v1 markdown contentHash | `sha256:b0a6460afb83ef07ddeddcdd0cb0b1c796729a69ffc5079790c19c9a17935fbf` | `packages/world-pack/src/compiler.test.ts:143` |
| v1 asset contentHash | `sha256:3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56`（4 字节） | `packages/world-pack/src/compiler.test.ts:145` |
| v2 packHash | `sha256:4eef7eeed78ebb6e2cd60223f8fd10a293ea6fbe16ab130042be2dc8afb1430f` | `packages/world-pack/src/compiler-v2.test.ts:195` |
| v2 manifestHash | `sha256:7531b3e328789aae4aa51813241992a5dcdc17f13f67b677ca20e5adae7deccc` | `packages/world-pack/src/compiler-v2.test.ts:241` |
| v2 genesisHash | `sha256:d650c9741435b3e89ba6783e39ee01f9fecebb98881d6c0dbe3132590955a922` | `packages/world-pack/src/compiler-v2.test.ts:242` |
| CLI `tavern-social` packHash | `sha256:515dd41a737d28139548364eefe3c7211c94a0f3a8b43bead4950a32f2f12c6d` | `packages/world-pack/src/creator-cli.test.ts:105` |
| CLI `rainy-road-companions`（v2）packHash | `sha256:76098df56b8a9169861f5094159d41ee7d6ef26c018339c8017615eb4686e0b8` | `packages/world-pack/src/creator-cli.test.ts:132` |

## 6. Schema 与 Manifest 基线

| 项目 | 当前值 | 位置 |
| --- | --- | --- |
| World Schema | 16（v16 = `WORLD_REACTION_SCHEMA`） | `packages/store-sqlite/src/world-store.ts:546`、`:389-544` |
| Logical Authority Export | `dshworld-authority/v6` | `packages/store-sqlite/src/logical-transfer.ts` |
| Manifest 闭集 | v2 / v3 / v4 / v5，其余 fail-closed | `packages/kernel/src/world-spec.ts:43-44`、`:181-266` |
| Reaction Policy | `reaction-policy/v1`，只有 `disabled` 或 `responsive` + `responsive/v1` | `packages/kernel/src/world-spec.ts:271`、`:289-302` |
| `responsive/v1` 预算 | 3 waves、8 NPC calls、每角色 2 calls、deadline 30000ms | `packages/application/src/round-coordinator.ts:88-91` |
| 存储侧硬校验 | `maxWaves ∈ [1,3]`、`maxNpcCalls ∈ [1,8]`、`maxCallsPerCharacter ∈ [1,2]` | `packages/store-sqlite/src/reaction-cycle.ts:201-203` |
| 五库 application_id | world `0x48435757`、audit `0x48435741`、session `0x48435753`、memory `0x4843574c`、context `0x48435743` | `packages/store-sqlite/src/sqlite.ts:6-7`、`operational-audit.ts:5`、`session-delivery.ts`、`packages/memory/src/local-memory.ts:36`、`packages/agents/src/context-database.ts:4` |
| 五库 user_version | world 16、audit 2、session 2、memory 5、context 5 | 同上各处常量 |

## 7. CI 与本机演练的分工

`.gitignore` 排除 `*.sqlite`，因此二进制旧库不能进入提交。两条路径分工明确，不得互相冒充：

| 路径 | 制品来源 | 用途 | 证据形式 |
| --- | --- | --- | --- |
| 本机真实演练 | `c2b3141` 旧二进制产出的 v15 部署（本文第 1～4 节） | 证明真实旧库可迁移、可五库备份、可恢复到新目录 | 命令、SHA-256、水位表、迁移后断言输出 |
| CI 门槛 | 由当前代码按冻结的 v1～v15 DDL 目录构造 `user_version = 15` 的等价旧库（先例：`packages/store-sqlite/src/store.test.ts:264-300`） | 每次 `pnpm check` 都验证 v15→v16 迁移与恢复校验器 | 测试断言 |

## 8. Evidence → Finding → Path

### Evidence

- E-001：`c2b3141` 与 HEAD 的 `pnpm-lock.yaml` 逐字节相同，旧提交可在隔离 worktree 离线安装并运行。
- E-002：旧二进制产出的库 `user_version = 15`、`reactionTables = 0`、38 events、2 branches、4 round commits（本文第 2 节）。
- E-003：两次运行的权威层标识与 Hash 全等，差异只出现在运维时间戳列（本文第 3 节）。
- E-004：Session cursor、Memory 水位、Context ProviderCall 与 World head 在真实旧部署上闭合（本文第 4 节）。
- E-005：v1/v2 Pack 的 packHash、canonical bytes、manifestHash、genesisHash 已被测试逐值固定（本文第 5 节）。

### Finding

- F-001：v15→v16 是纯新增结构迁移，旧库不含任何 Reaction 表，因此“旧世界保持 disabled”可以在真实制品上证明，而不只是在新代码里断言（E-002）。
- F-002：跨库水位不变量在真实旧部署上成立，ADR-0081 的双向校验器有可执行基准（E-004）。
- F-003：整库字节不是可复现 Golden，迁移与恢复断言必须落在结构、水位与权威 Hash 上（E-003）。
- F-004：Pack v3 的零漂移承诺可机械验证，因为 v1/v2 基线已逐值固定（E-005）。

### Path

1. P9C.5 已用本文第 1 节命令产出的制品执行真盘 v15→v16、Context v4→v5 迁移与五库备份/恢复演练，证据见[Phase 9C.5 阶段报告](2026-09-05_阶段报告-Harness-Cordis-World-Phase-9C.5-report.md)；
2. P9C.5 已在 CI 测试集中补由完整现行表集降级构造的等价 v15 旧库门槛；
3. P9C.4 已在引入 v3 编译链后重跑本文第 5 节全部 Golden 断言，v1/v2 字节与 Hash 未发生漂移；
4. P9C.7 Release Closure 引用本文作为迁移与恢复证据的来源。

## 附录 A：`tools/make-v15-fixture.ts`（在 `c2b3141` worktree 内运行）

```ts
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WorldApplication } from '@harness-world/application'
import { brandId, worldAddressKey, type SubmitActionsV2 } from '@harness-world/contracts'
import { phase8ProviderCrashWorld } from '../tests/fixtures/phase8-provider-world.ts'

const dataDirectory = process.argv[2]
if (dataDirectory === undefined) throw new Error('usage: make-v15-fixture <data-directory>')

const worldPath = join(dataDirectory, 'world.sqlite')
const sessionPath = join(dataDirectory, 'session.sqlite')
const memoryPath = join(dataDirectory, 'memory.sqlite')
const contextPath = join(dataDirectory, 'context.sqlite')
const auditPath = `${worldPath}.audit.sqlite`

const compiled = phase8ProviderCrashWorld()
const parent = compiled.manifest.address
const child = { tenantId: parent.tenantId, worldId: parent.worldId, branchId: brandId('branch:child', 'BranchId') }

const application = new WorldApplication({
  worldPath,
  sessionPath,
  memoryPath,
  contextPath,
  runtimeOwnerId: 'fixture:v15-baseline',
  leaseTtlMs: 5_000,
  modelBudgetTokens: 64,
  participants: () => [
    {
      participantId: 'agent:v15-npc',
      role: 'agent',
      actorId: brandId('character:npc', 'CharacterId'),
      allowedActionTypes: ['speak'],
      priority: 1,
      estimatedTokens: 1,
      timeoutMs: 1_000,
      provider: {
        async propose(): Promise<SubmitActionsV2> {
          return {
            schemaVersion: 2,
            decision: 'act',
            actions: [
              {
                actionId: 'action:v15:npc-speak',
                actorId: brandId('character:npc', 'CharacterId'),
                actionType: 'speak',
                actionVersion: 1,
                parameters: { text: 'legacy v15 provider response' },
              },
            ],
          }
        },
      },
    },
  ],
})

await application.activate(compiled)
for (const round of ['round-1', 'round-2']) {
  await application.submit(parent, {
    idempotencyKey: `v15-fixture:${round}`,
    principalId: 'principal:player',
    action: { actionType: 'speak', parameters: { text: `legacy v15 player input ${round}` } },
    correlationId: `v15-fixture:${round}`,
  })
  await application.deliver(parent, `v15-fixture:${round}:deliver`)
}
const fork = await application.forkAtHead(parent, child, 'v15 fixture fork', 'v15-fixture:fork')
await application.submit(child, {
  idempotencyKey: 'v15-fixture:round-3',
  principalId: 'principal:player',
  action: { actionType: 'speak', parameters: { text: 'legacy v15 child input' } },
  correlationId: 'v15-fixture:round-3',
})
await application.deliver(child, 'v15-fixture:round-3:deliver')
await application.close()

for (const path of [worldPath, sessionPath, memoryPath, contextPath, auditPath]) {
  const database = new DatabaseSync(path)
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  database.close()
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
}

function digest(path: string): { readonly byteLength: number; readonly sha256: string } {
  return { byteLength: statSync(path).size, sha256: `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}` }
}

const probe = new DatabaseSync(worldPath, { readOnly: true })
const worldRow = probe.prepare('SELECT user_version FROM pragma_user_version').get() as { user_version: number }
const counts = {
  events: (probe.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
  branches: (probe.prepare('SELECT COUNT(*) AS n FROM branches').get() as { n: number }).n,
  roundCommits: (probe.prepare('SELECT COUNT(*) AS n FROM round_commits').get() as { n: number }).n,
  reactionTables: (probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'world_reaction%'").get() as { n: number }).n,
}
probe.close()

process.stdout.write(`${JSON.stringify({
  generator: 'tools/make-v15-fixture.ts',
  baselineCommit: 'c2b314188d391e676497c58a25db3fc824568702',
  dataDirectory,
  worldSchemaUserVersion: worldRow.user_version,
  counts,
  forkSeq: fork.forkSeq,
  parentKey: worldAddressKey(parent),
  childKey: worldAddressKey(child),
  files: {
    world: digest(worldPath), audit: digest(auditPath), session: digest(sessionPath),
    memory: digest(memoryPath), context: digest(contextPath),
  },
}, null, 2)}\n`)
```

## 附录 B：`tools/report-v15-watermarks.ts`

```ts
import { DatabaseSync } from 'node:sqlite'

function query(path: string, sql: string): unknown[] {
  const database = new DatabaseSync(path, { readOnly: true })
  const rows = database.prepare(sql).all()
  database.close()
  return rows
}

process.stdout.write(`${JSON.stringify({
  heads: query('fixture-data/world.sqlite', 'SELECT address_key, head_seq, tick, event_hash FROM heads ORDER BY address_key'),
  outbox: query('fixture-data/world.sqlite', 'SELECT delivery_status, COUNT(*) AS n FROM outbox GROUP BY delivery_status'),
  auditRows: query('fixture-data/world.sqlite.audit.sqlite', 'SELECT COUNT(*) AS n FROM operational_audit_events'),
  sessionCursor: query('fixture-data/session.sqlite', 'SELECT session_id, last_delivery_seq FROM session_delivery_cursor ORDER BY session_id'),
  memoryWatermarks: query('fixture-data/memory.sqlite', 'SELECT namespace_key, verified_through_seq, captured_through_seq, memory_epoch FROM cognitive_memory_v2_namespaces ORDER BY namespace_key'),
  providerCalls: query('fixture-data/context.sqlite', 'SELECT state, COUNT(*) AS n FROM provider_calls GROUP BY state'),
  contextCheckpoints: query('fixture-data/context.sqlite', 'SELECT COUNT(*) AS n FROM continuity_checkpoints'),
}, null, 2)}\n`)
```
