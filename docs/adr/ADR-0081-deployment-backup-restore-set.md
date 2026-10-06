# ADR-0081：多库部署备份与恢复集合

- 状态：Accepted
- 日期：2026-09-02
- 上位目标：[Phase 9 实施规格](../spec/phase-9-implementation-v0.1.md) §21、§23（Phase 9C）；[Phase 9C 实施规划](../archive/phase-7-9c/2026-09-02_实施计划-Harness-Cordis-World-Phase-9C.md) §8
- Extends：ADR-0027（Session FIFO 与原子幂等）、ADR-0029（Snapshot、Retention、Compaction）、ADR-0031（Telemetry、Health、Audit）、ADR-0035（Knowledge 与 Memory）、ADR-0064（Context v2 与 Provider 调用边界）、ADR-0075（Session 死信序号连续性）、ADR-0077（有界自主 Reaction Cycle）
- Supersedes（局部）：“单 World 物理备份即等于部署可恢复”的隐含假设；任何把备份制品当作世界事实来源的实现设想

> **边界警告：** 备份制品是物理副本，不是第二事实源。World Event Log 仍然是世界事实权威；Session、Memory、Context、Audit 都不能通过恢复流程反写或替代世界事实。恢复不修改制品内容，也不自动切换 Host 配置。

## 背景

当前物理备份只覆盖一个文件：`WorldArchiveService.backup` 使用 node:sqlite 在线 `backup()` 复制 `world.sqlite`，制品格式为 `world-sqlite-backup/v1`，只记录 `byteLength`、`fileHash`、`schemaVersion`（`packages/store-sqlite/src/archive-service.ts:15-20`、`:36-54`）。Audit sidecar 不是被备份，而是被追加写入（同文件 `:150`）。

但一个真实部署由五个 SQLite 库组成（`packages/operations/src/host-config.ts:16-28`、`:135-141`）：

| 库 | 默认路径 | application_id | user_version |
| --- | --- | --- | --- |
| World | `data/world.sqlite` | `0x48435757` | 16（`packages/store-sqlite/src/world-store.ts:546`） |
| Audit | `data/world.sqlite.audit.sqlite`（派生） | `0x48435741` | 2（`packages/store-sqlite/src/operational-audit.ts:5`、`:39-42`） |
| Session | `data/session.sqlite` | `0x48435753` | 2（`packages/store-sqlite/src/session-delivery.ts:59`） |
| Memory | `data/memory.sqlite` | `0x4843574c` | 5（`packages/memory/src/local-memory.ts:169`） |
| Context | `data/context.sqlite` | `0x48435743` | 5（`packages/agents/src/context-database.ts:4-5`） |

只恢复 World 无法证明“模型可见输入可由耐久记录重建”这一 Phase 8/9 的核心承诺：Context 里的 ProviderCall 账本、Memory 里的认知水位、Session 里的投递游标都会在恢复后与 World 脱节。

真实旧库验证了跨库水位本来就是闭合的。以冻结提交 `c2b3141`（World Schema v15）生成的真实部署（生成命令与 SHA-256 见[Phase 9C v15 旧库与 Golden 基线](../archive/phase-7-9c/2026-09-02_Phase-9C-v15旧库与Golden基线.md)）为例：

| 观察 | 值 |
| --- | --- |
| World heads | `branch:main` head_seq 28 / tick 2；`branch:child` head_seq 38 / tick 3 |
| Outbox | 6 行，全部 `delivered` |
| Session cursor | `session:player` `last_delivery_seq = 6` |
| Memory 水位 | 4 个命名空间，`verified_through_seq = captured_through_seq =` 对应 Branch head_seq（main 28、child 38） |
| Context ProviderCall | 3 行，全部 `committed`；continuity checkpoint 2 行 |
| Audit | 2 行，hash chain 完整 |

即：Session cursor 与 World 已投递 Outbox 数一致，Memory 水位与 World head 一致，ProviderCall 状态与已提交 Round 一致。这些不是巧合，而是既有契约（ADR-0027、ADR-0035、ADR-0064、ADR-0075）的必然结果，因此可以被机械校验。

## 决定

### 1. 制品格式 `world-deployment-backup/v1`

制品是一个目录，成员固定：

```text
<target>/
  manifest.json                      # canonical world-deployment-backup/v1
  world.sqlite
  world.sqlite.audit.sqlite
  session.sqlite
  memory.sqlite
  context.sqlite
  ready                              # 最后写入，内容为 manifestHash
```

`manifest.json` 至少包含：

- `format: 'world-deployment-backup/v1'`、`correlationId`、`createdAtMs`、`sourceDeployment`（数据目录标识，不含 Secret）；
- `files[]`：每个文件的 `role`（`world`/`audit`/`session`/`memory`/`context`）、相对路径、`byteLength`、`sha256`、`applicationId`、`userVersion`、`quickCheck`；
- `watermarks`：World 每 Branch 的 `head_seq`/`tick`/`event_hash`、Outbox 按状态计数与最大 `session_delivery_seq`、Session 每 `session_id` 的 `last_delivery_seq`、Memory 每命名空间的 `verified_through_seq`/`captured_through_seq`/`memory_epoch`、Context 的 ProviderCall 按状态计数与最大 checkpoint `as_of_seq`、Reaction 的 active Cycle 数与 terminal Cycle 数；
- `manifestHash = hashWorldJson('world-deployment-backup/v1', <不含 manifestHash 的 manifest>)`，且 `ready` 标记文件内容必须等于该 Hash。

缺少 `ready` 标记、或标记与重算 Hash 不符的制品一律视为**未完成**，Host 与工具都不得打开。

### 2. 备份只在部署级静默屏障下开始

备份开始前必须证明整个部署静默（quiescent），任一条不满足即 fail-closed 拒绝，不得“尽力备份”：

1. 调用方持有 Host `instance.lock`，或 Host 已停止；不存在其他写入者；
2. 每个 Branch：无 unfinished Round（`round_inbox` 无 `pending`/`claimed`）、无有效 Writer Lease、无 critical 且未 `delivered` 的 Outbox；
3. 无 active / stop_requested Reaction Cycle，无 `pending` / `claimed` Reaction Job；
4. 无未结算的认知 Job；
5. 没有 Branch 处于 `quarantined`：完整性未被证明时不得产出“看起来可用”的制品；
6. 五个库全部通过 `PRAGMA quick_check` 且 `application_id` / `user_version` 为当前期望值。

快照按固定顺序 `world → audit → session → memory → context` 逐个使用 SQLite 在线 `backup()` API（或等价一致快照）生成。顺序固定是为了让制品可复现比较；静默前提下顺序本身不产生偏斜。

发布制品前必须执行**双向水位校验**：

| 方向 | 规则 |
| --- | --- |
| World → Session | 每个 `delivered` Outbox 行的 `session_delivery_seq` 必须已被对应 Session cursor 覆盖，且无序号空洞（ADR-0075） |
| Session → World | 每个 Session cursor 值必须能在 World Outbox 中找到对应的已投递事实，不得领先于 World |
| World → Memory | 每个 Branch 的命名空间水位必须存在且 `captured_through_seq ≤ verified_through_seq ≤ head_seq` |
| Memory → World | 每个命名空间必须能解析到已知 Branch，`memory_epoch ≥ 1`，不得引用不存在的 Branch |
| World → Context | 每个 `committed` ProviderCall 必须能对应到耐久世界权威引用；静默下不得残留 `dispatch_started` / `response_received` |
| Context → World | checkpoint 与 receipt 的 `as_of_seq` 不得超过对应 Branch `head_seq` |
| World → Reaction | active Cycle 数必须为 0；terminal Cycle 的预算用量必须可由耐久行重算 |
| Audit | hash chain 必须端到端验证通过，不得出现分叉 |

任何文件缺失、Hash / Schema 不符、`quick_check` 失败或跨库水位不闭合，制品不得标记 `ready`，并且必须清理已写入的临时成员。

### 3. 恢复纪律

1. 只恢复到**全新的空目录**；目标存在、非空或与源同一文件即拒绝（沿用 `archive-service.ts:136-143` 的 `#guardNewTarget` 语义），不覆盖任何正在使用的数据文件；
2. 在临时目录完成校验：`ready` 标记与 `manifestHash` 重算一致、逐文件 `byteLength` / `sha256` / `application_id` / `user_version` / `quick_check` 一致；
3. 复制使用排他写入（`wx` 语义），复制后在新位置重新校验 Hash；
4. 对恢复出的副本执行第 2 节的完整双向水位校验，另加：World Branch integrity（`packages/store-sqlite/src/world-store.ts:581-587`）、Session `verifyIntegrity`（`packages/store-sqlite/src/session-delivery.ts:183-232`）、Memory as-of 召回一致性、Context ProviderCall / Cycle 校验、Audit hash chain 校验；
5. 验证成功后在恢复目录写出 `restore-provenance`（canonical JSON：源 `manifestHash`、逐文件 Hash、各项校验结论、`correlationId`、时间），再由**操作者**切换 Host 配置；
6. 中途崩溃只留下未 `ready` 的临时制品，不能被 Host 自动打开，也不参与后续恢复；
7. 部署级恢复**不重置** Outbox、claim 或 receipt。这与单 World 工具的 `recoveryMode: 'redeliver-outbox'`（`archive-service.ts:158-174`）刻意不同：制品在静默点生成，任何重置都会破坏 Session cursor 与 Outbox 的闭合。是否重投是操作者在恢复之后单独做出的决定。

### 4. 与既有工具的关系

- 单 World 物理备份 `world-sqlite-backup/v1` 继续作为底层工具存在，但文档必须明确它**不代表完整部署恢复**；
- Logical Authority Export / Import（`dshworld-authority/v6`）继续是权威级迁移与审计工具，与物理部署集合互补，不互相替代；
- 三者都不是世界事实来源；World Event Log 才是。

### 5. 真实旧库迁移演练是发布前置条件

必须以冻结提交 `c2b3141`（World Schema v15）生成的真实旧库证明：

1. 当前代码把 v15 前向迁移到 v16，Reaction 表为空、旧 Manifest 的策略仍为 `disabled`；
2. 迁移失败时原文件仍可由旧基线打开（回滚不破坏旧库）；
3. v16 重新打开、Logical Export / Import、Branch integrity 与 Projection rebuild 全部一致；
4. 对该旧部署执行多库备份并恢复到新目录后，Session Presentation、Memory recall 与 Context / ProviderCall 水位一致。

演练命令、生成器与 SHA-256 必须记录在阶段文档中，可复核。CI 无法提交二进制库（`*.sqlite` 已被 `.gitignore` 排除），因此 CI 门槛使用由冻结 v15 DDL 目录构造的等价旧库；真实旧二进制制品的演练在本机执行并留证。两者不得互相冒充。

## 结果

- 一次恢复即可得到同一个可见世界：Session 展示、Memory 召回、Context / ProviderCall 生命周期与 World 事实一致。
- 半成品制品不可用，崩溃不会留下“看起来能开”的数据目录。
- 跨库水位从隐含契约变成可机械校验的发布门槛。
- 代价：备份需要部署级静默窗口，不能在热运行中随时抓取；恢复流程更长，且必须由操作者显式切换配置。

## 证据链

### Evidence

- E-001：`packages/store-sqlite/src/archive-service.ts:15-20`、`:36-54` 显示制品只含 `world.sqlite` 的 `byteLength`/`fileHash`/`schemaVersion`；`:150` 显示 audit sidecar 只被追加。
- E-002：`packages/operations/src/host-config.ts:16-28`、`:135-141` 显示部署实际由 world / session / memory / context 四个可配置路径加派生 audit 组成。
- E-003：五个库各有独立 `application_id` 与 `user_version`（见背景表），且都已具备 `quick_check` / 完整性校验先例（`archive-service.ts:176-197`、`session-delivery.ts:183-232`、`operational-audit.ts:77-113`）。
- E-004：`c2b3141` 真实旧部署的实测水位闭合（见背景表），证明跨库不变量可机械校验。
- E-005：`archive-service.ts:158-174` 的单 World 恢复会重置 Outbox 与 claim，这与多库水位闭合不相容。

### Finding

- F-001：单库备份不足以证明模型可见输入与 Provider 生命周期可重建，缺的是集合级制品与跨库校验，而不是新的备份算法（E-001 / E-002、E-003）。
- F-002：跨库水位不变量已经由既有契约保证并在真实旧库上成立，因此“双向校验”是可实现的发布门槛，不是研究问题（E-004）。
- F-003：部署级恢复必须放弃单库恢复的 Outbox 重置行为，否则恢复出来的集合自身不闭合（E-005 / E-004）。

### Path

1. 先定义制品格式、静默屏障与水位摘要读取，产出 `ready=false` 的制品并证明缺 `ready` 不可用；
2. 再实现双向水位校验，用真实旧部署与人为破坏的制品（改一个字节、删一个文件、推进 cursor）验证 fail-closed；
3. 然后实现新目录恢复、就地重校验与 provenance 发布，并补恢复中断的崩溃测试；
4. 最后执行 v15→v16 真盘迁移与五文件恢复演练，把命令与 Hash 记入阶段文档。
