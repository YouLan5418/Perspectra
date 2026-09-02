# Harness / Cordis World Phase 9C 实施规划

> **状态：Planning / implementation target。** 本文把已完成的 Phase 9A/9B 收束为可长期运行和可发布的本地 Host；它不是新的 Accepted ADR，也不授权改变既有 Reaction 语义。P9C.0 必须先评审并接受相应 ADR，之后才能改生产代码。

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-09-02 |
| 实施基线 | `af0541f`（Phase 9B 本机门槛完成） |
| 工作分支 | `phase9b/bounded-multi-wave` |
| 对照规格 | [Phase 9 实施规格：有界自主 Reaction Cycle](spec/phase-9-implementation-v0.1.md) §23～§25 |
| 推荐候选版本 | 私有源码 `0.4.0`，实际版本与 Tag 仍须在 Release Closure 时确认 |

## 1. 一句话目标

P9C 只回答一个问题：

> 已经能连续反应的 `responsive/v1` 世界，能否在长期运行、多 Branch 竞争、行政操作、备份恢复和创作者启用的真实本机环境里，仍然保持公平、有界、可恢复且不泄漏未裁决内容？

P9C 不增加新的对话玩法。它把 Phase 9B 已经成立的权威语义变成可以安全交付的运行闭环。

## 2. 当前基线与真实欠账

### 2.1 已经完成，不重复实施

- World Schema 已是 v16，包含 Cycle、Job、Stimulus、ProviderCall 关联和必要索引；
- Logical Authority Export 已是 `dshworld-authority/v6`；
- Manifest v5 已能精确表达 `disabled` 或 `responsive/v1`；
- Root Round、最多 3 waves、8 次 NPC 调用、每角色最多 2 次、每次最多一个 `speak@1` 已落地；
- 同 wave 并行、wave 间串行、玩家在 wave 边界抢占、启动扫描和 Reaction Presentation 已闭环；
- `instance.lock`、stdio-only Host、Writer Lease/fencing、Session 幂等和进程级硬崩溃 Harness 已存在。

因此，P9C 不再“升级一次 schema”或“重做逻辑导出”，而是使用真实旧库和当前库证明迁移、恢复与长期运行。

### 2.2 尚未闭合

| 欠账 | 当前表现 | P9C 目标 |
| --- | --- | --- |
| Host 公平性 | Round/Reaction worker 按 Branch 各自 `while` 排空，没有全局并发上限 | 一个 Branch 一次只执行一个耐久工作量子，跨 Branch 有界并行、无饥饿 |
| 背压 | wake key 与 worker 数随活跃 Branch 增长 | wake 合并、固定并发上限、溢出后依靠耐久扫描恢复 |
| 行政边界 | maintenance/archive/fork/quarantine 尚未完整纳入 active Cycle | 每种操作都有唯一、可测试的 Cycle 终止或等待语义 |
| 创作者入口 | Manifest v5 主要由运行时夹具产生；World Pack v2 不得扩字段 | 新版本 Pack 显式编译出 Manifest v5，旧 v1/v2 字节与 Hash 不变 |
| 恢复集合 | 现有物理 Backup 只覆盖 World SQLite | World、Session、Memory、Context、Audit 作为同一部署恢复集合校验 |
| 可观测性 | 只有 worker failure 等少量进程计数 | 固定基数的 Cycle、队列、公平性、终止原因和恢复指标 |
| 性能证据 | 已有 Phase 8 长历史基线，但缺 Reaction 专属高并发矩阵 | 索引、并行 wall time、抢占延迟、公平性和锁窗口均有门槛 |

## 3. 明确不做

- 不改变 `responsive/v1` 的 3 waves / 8 calls / 每角色 2 calls 上限；
- 不允许单次 Provider 产生多个 Action，不加入 move、take 或 Director 自主 wave；
- 不接真实 API Key、Harness Bridge、TencentDB、网络监听或远程管理面；
- 不扩展 Memory、Scene、心理词汇或悬疑玩法；
- 不修改 `worldpack-source/v1/v2`、compiled `worldpack/v1/v2` 或 Manifest v1～v4；
- 不把通知、Metric、wake hint 或进程内队列升级为世界事实；
- 不建立跨 Branch 的全局事件顺序；公平性只约束 Host 调度，不改变各 Branch 内的权威顺序。

## 4. P9C.0：先冻结三个治理决策

代码实施前起草并评审三个 Accepted ADR；编号以下一个可用编号为准，当前建议为：

1. **ADR-0079：Host 公平调度、背压与行政停止语义**
   - 冻结一个 Branch 一个量子的调度模型；
   - 冻结 graceful shutdown、maintenance、archive、fork、quarantine 与 active Cycle 的关系；
   - 明确公平调度只影响何时执行，不影响 Branch 内执行结果。
2. **ADR-0080：World Pack v3 与 Reaction Policy 创作者入口**
   - `worldpack-source/v3` → compiled `worldpack/v3` → Manifest v5；
   - v1/v2 永久冻结，禁止通过新增可选字段偷偷启用 Reaction；
   - 创作者只能选择 `disabled` 或固定的 `responsive/v1`，不能改写安全预算。
3. **ADR-0081：多库部署备份与恢复集合**
   - 定义 World、Session、Memory、Context、Audit 的一致性水位、制品 Manifest 和失败语义；
   - 恢复到新目录并验证后再由操作者切换配置，不覆盖正在使用的数据文件；
   - 单 World 物理备份继续作为底层工具，但不再代表完整部署恢复。

若评审要求改变 Hash、as-of、fencing、Provider append-once 或 SQLite 原子性，立即停止 P9C，而不是让实现先行。

## 5. Host 执行模型

### 5.1 一个量子，而不是排空一个世界

应用层增加单步能力，概念接口为：

```ts
processNextBranchWork(
  address: WorldAddress,
  correlationId: string,
): Promise<BranchWorkStep>
```

一次调用最多完成一个耐久量子：

- 有 active/stop_requested Cycle：推进至多一个 wave，或只完成终态化；
- 没有 active Cycle：处理至多一个已受理玩家 Root Round；
- 没有工作：返回 `idle`。

同一 Branch 内仍保持现有全序：旧 Cycle 未进入终态前，不处理下一条玩家 Round；玩家输入只会请求在当前 wave 边界停止旧 Cycle。

### 5.2 Host 级公平 Scheduler

新增 Host 级 `BranchWorkScheduler`：

- `wake(address, reason)` 是可丢失、可合并的提示；耐久表才是事实；
- 同一个 WorldAddress 同时最多一个量子在执行；
- ready Branch 按 UTF-16 `worldAddressKey` 建立稳定起点，再用 round-robin 轮转；
- 每个被选中的 Branch 只执行一个量子；仍有工作则排到队尾；
- 默认 `maxConcurrentBranches = 4`，本机配置允许 1～32，配置不进入 Manifest 或世界 Hash；
- 默认最多保留 1024 个驻留 wake key；达到上限时只置 `rescanRequired`，不把 wake 内容写成第二事实源；
- 启动扫描和周期性耐久扫描能够在所有 wake 丢失后恢复工作。

公平性的可验证定义：在持续 runnable 且没有锁/Provider 超时的条件下，N 个 ready Branch 各执行一次之前，任何 Branch 不得执行第二次。

### 5.3 关闭与恢复

graceful shutdown 固定为：

1. 停止接收新的 worker kick；
2. 不再领取新量子或新 ProviderCall；
3. 等待已冻结 wave 到其有效 deadline，并完成正在进行的短事务；
4. 释放 Host 持有的 lease/lock；
5. 未完成工作留在耐久状态，下一次启动扫描恢复。

关闭不修改 Branch admission，也不伪造 Cycle terminal reason。硬终止仍依靠 fencing、append-once 和启动扫描恢复。

## 6. 行政操作矩阵

| 操作 | active Cycle 时的行为 | 完成条件 |
| --- | --- | --- |
| 玩家抢占 | 已由 9B 实现：写 `stop_requested`，当前 wave 收口后终止 | 旧 Cycle terminal 后处理玩家 FIFO |
| graceful shutdown | 不新领工作；已冻结 wave 按 deadline 收口 | 剩余耐久工作由重启扫描接管 |
| maintenance | 先关闭 admission，并请求 `administrative_stop`；不启动下一 wave | 无 unfinished Round、active Cycle、有效 Writer Lease 或 critical inflight delivery |
| archive | active/stop_requested Cycle 时返回可重试错误，不自动取消 | Cycle terminal 且既有 archive barrier 全部满足 |
| fork | active/stop_requested Cycle 时返回可重试错误 | fork 点没有活跃 Cycle；子分支不继承 live Job、lease 或 Provider 责任 |
| quarantine | 最高优先级；在隔离事务内把 Cycle 标为 `quarantined`，未执行 Job 终态化并撤销 fence | 不等待 Provider；任何迟到结果都不能提交世界事实 |

行政终止原因必须进入闭集和耐久账本。maintenance 恢复不会自动复活旧 Cycle；操作者恢复 Branch 后，只处理仍合法的玩家 FIFO 或新刺激。

## 7. 创作者可用的 Pack Policy

### 7.1 新版本，不污染旧版本

推荐新增：

- `worldpack-source/v3`；
- compiled `worldpack/v3`；
- `worldpack-compiler/v3`；
- 必填的 `reactionFile`，其内容版本为 `worldpack-reaction/v1`；
- 输出 Manifest v5。

`reaction.json` 只接受两种精确形状：

```json
{ "schemaVersion": "worldpack-reaction/v1", "mode": "disabled" }
```

或：

```json
{
  "schemaVersion": "worldpack-reaction/v1",
  "mode": "responsive",
  "profile": "responsive/v1"
}
```

创作者不能覆盖 wave、调用次数、每角色次数、Action 类型或 deadline；这些仍由版本化 profile 冻结。

### 7.2 CLI 与 Runbook

- `worldpack init --profile responsive-social` 生成最小 v3 Pack；既有 `minimal/social` 输出不变；
- `validate/compile/inspect/test/activate` 全链支持 v3；
- `inspect` 显示最坏上限：3 waves、8 calls、每角色 2 calls，以及预算估算，不输出 Secret；
- 运行手册给出启用、观察、抢占、maintenance、恢复和禁用流程；
- Golden Fixture 证明旧 v1/v2 编译字节和 Hash 零变化。

## 8. 多库备份、迁移与恢复

### 8.1 部署恢复集合

新增部署级制品（暂名 `world-deployment-backup/v1`），包含：

- `world.sqlite` 与 `world.sqlite.audit.sqlite`；
- `session.sqlite`；
- `memory.sqlite`；
- `context.sqlite`；
- 每个文件的 byte length、SHA-256、SQLite application/user version 和 `quick_check`；
- World Head、Outbox/Session cursor、Memory watermark、Context ProviderCall 与 active Cycle 水位摘要；
- 制品自身的 canonical manifest hash 与 `ready` 标记。

备份只在部署级 admission barrier 下开始。每个 SQLite 文件使用 SQLite backup API 或等价一致快照；最终发布制品前执行双向水位校验。任何文件缺失、Hash/Schema 不符或跨库水位不闭合，制品不得标记 ready。

### 8.2 恢复纪律

- 只恢复到全新的空目录，不覆盖当前 Host 正在使用的文件；
- 在临时目录完成文件 Hash、SQLite integrity、World 权威、Session 双向对账、Memory as-of 和 ProviderCall/Cycle 校验；
- 验证成功后发布恢复目录和 provenance，操作者再切换 Host 配置；
- 中途崩溃只留下未 ready 的临时制品，不能被 Host 自动打开；
- 继续支持单 World 导出/导入，但文档明确其不等同于完整 Session/Memory 恢复。

### 8.3 必做真实演练

以冻结提交 `c2b3141`（World Schema v15）在隔离目录生成真实旧库 Fixture，记录生成命令和 SHA-256；当前代码把它迁移到 v16，并验证：

- 旧 Manifest 的 Reaction 仍为 disabled；
- 迁移失败时原文件仍可由旧基线打开；
- v16 重新打开、导出/导入、Branch integrity 和 Projection rebuild 全部一致；
- 当前多库备份恢复后，Session Presentation、Memory recall 和 Context/ProviderCall 水位一致。

## 9. 可观测性与隐私

只增加固定基数指标，不把 worldId、branchId、characterId、Prompt 或正文作为 label：

- Cycle started/completed；terminal reason 闭集计数；
- waves、calls、accepted actions、reserved/used tokens 总数；
- Provider ambiguous、lease recovery、fence rejection、head mismatch；
- runnable/active Branch 数、wake overflow/rescan 次数、最老等待时长；
- Root commit → 首 Reaction commit、wave freeze、Context、Provider、Rulebook、commit 和抢占等待的聚合耗时；
- Context/Memory unavailable 与 worker failure。

Health 提供进程级是否 degraded 及固定原因码。需要定位某个 Branch 时使用有权限的 `reaction.get/list` 和 Audit，不通过高基数 Metric 泄漏地址。

通知仍然是非权威提示：可重复、乱序或丢失，不用于 Scheduler 决策，也不参与 Release 完整性校验。

## 10. 性能、压力与故障门槛

### 10.1 两档数据集

| Profile | 用途 | 建议规模 |
| --- | --- | --- |
| CI | 每次 `pnpm check` 的稳定门槛 | 10,000 Event、32 Branch、256 pending Job、一次 8-call Cycle |
| release-local | Release Closure 人工/自动演练 | 100,000 Event、128 Branch、持续 Round/Reaction 混合负载 |

数字是运行规模，不是产品上限。第一次 Windows/Ubuntu 基线测量后，由 ADR 冻结可跨平台复现的时间阈值；不得通过减少 Event、Branch 或故障点让门槛变绿。

### 10.2 必须证明的性质

- Job 选择、Stimulus 消费和 Cycle 查询的 `EXPLAIN QUERY PLAN` 使用索引，不对长 Event Log 做逐 wave 全表扫描；
- 8 个各 100ms 的 Scripted Provider 调用 wall time 接近最慢一次调用，并显著小于串行总和；
- 32 个持续 runnable Branch 中，每个都在任何 Branch 第二量子前获得第一量子；
- 慢 Provider 不持有 SQLite 写锁，其他 Branch 可以提交；
- 玩家抢占等待不超过当前 wave 的有效 deadline 加一个 Scheduler 调度裕量；
- 两个进程竞争同一 Branch 时，只有有效 fence 能提交；
- wake 全部丢失、Host 硬终止、dispatch 四窗口、行政操作竞态和备份/恢复中断均能得到唯一且可解释的耐久结果。

## 11. 实施单元与最小提交

| 单元 | 主要交付 | 最小验收 | 推荐提交主题 |
| --- | --- | --- | --- |
| P9C.0 | ADR-0079～0081、旧库/Golden 基线 | 文档评审、fixture hash | `docs(adr)` |
| P9C.1 | 单量子应用 API、Host 公平 Scheduler、wake 背压 | 公平性、单 Branch 顺序、丢 wake 恢复 | `feat(operations)` |
| P9C.2 | graceful shutdown、启动恢复、固定基数 metrics/health | 信号关闭、硬终止、无高基数泄漏 | `feat(operations)` |
| P9C.3 | maintenance/archive/fork/quarantine Cycle 矩阵 | 每种竞态 + transaction crash 点 | `feat(store)` / `feat(application)` |
| P9C.4 | World Pack v3 与 `responsive-social` | v1/v2 Golden 不变；v3 E2E 激活 | `feat(world-pack)` |
| P9C.5 | 多库备份、迁移、恢复集合 | v15→v16 真盘迁移；五文件恢复对账 | `feat(backup)` |
| P9C.6 | 长历史、并发、故障与体验矩阵 | CI/release 两档门槛 | `test(phase9)` |
| P9C.7 | Creator Runbook、Release Closure、版本候选 | 完整 `pnpm check`、工作树和历史审计 | `docs` / `chore(release)` |

每个单元只在相关测试通过后独立提交。涉及状态机、事务或恢复窗口的提交必须先加测试，再实现；不得用普通 throw 测试替代真实子进程终止。

## 12. 验收与发布顺序

每个生产文件继续保持逐文件 statements、branches、functions、lines 100%。P9C 完成前至少执行：

```powershell
corepack pnpm@11.7.0 check
```

最终 Release Closure 顺序：

1. 本机 Node 24 完整门槛；
2. 真盘 v15→v16 迁移和多库恢复演练；
3. 工作树、提交粒度、Secret/产物审计；
4. 准备私有源码 `0.4.0` candidate；
5. 由用户推送远程；
6. GitHub Windows/Ubuntu × Node 22.19/24 四格通过；
7. 用户明确确认后才创建 annotated Tag。

不自动推送、不自动创建 Tag，也不把本机通过冒充为远程矩阵通过。

## 13. 停止条件

出现以下任一情况，立即停止当前单元并新增 superseding ADR：

- 公平调度改变了同一 Branch 内的 Action/Authority 顺序或 Hash；
- 背压必须丢弃耐久工作，或依赖进程内 wake 才能恢复；
- 行政操作只能通过跳过 Cycle/ProviderCall 完整性检查才能完成；
- Pack v3 需要改写 v1/v2 字节、Hash 或既有 Manifest 解释；
- 多库恢复不能证明 Session、Memory、Context 与 World 水位闭合；
- after-dispatch 崩溃会自动重发外部调用；
- 性能只能通过延长写事务、减少故障点或关闭 fail-closed 校验达标；
- 任一实现要求放宽 Canonical JSON、as-of、fencing、append-once 或 SQLite 原子性。

## 14. Evidence → Finding → Path

### Evidence

| ID | 不可变观察 | 来源 |
| --- | --- | --- |
| E-001 | Phase 9B 已通过 74 个测试文件、795 项测试、四项 100% 覆盖和 29 项硬崩溃测试 | [Phase 9B 完成报告](2026-09-02_阶段报告-Harness-Cordis-World-Phase-9B-report.md) |
| E-002 | Schema v16、Logical v6、Manifest v5 与 `responsive/v1` 已在生产路径存在 | `packages/store-sqlite/src/world-store.ts`、`logical-transfer.ts`、`packages/kernel/src/world-spec.ts` |
| E-003 | 当前 RPC 为每 Branch 独立 worker map，并会排空该 Branch；没有 Host 级并发上限 | `packages/operations/src/rpc.ts` |
| E-004 | 当前 maintenance/archive readiness 主要检查 Writer、Round 和 critical Outbox，尚未完整纳入 active Cycle | `packages/store-sqlite/src/branch-administration.ts` |
| E-005 | 当前物理 Backup 为 `world-sqlite-backup/v1`，而 Host 实际配置有 World、Session、Memory、Context 与 Audit 文件 | `packages/store-sqlite/src/archive-service.ts`、`packages/operations/src/host-config.ts` |
| E-006 | 冻结提交 `c2b3141` 的真实 World Schema 为 v15，可作为真盘迁移来源 | Git 对象 `c2b3141` |

### Findings

| ID | 结论 | Evidence | 置信度 |
| --- | --- | --- | --- |
| F-001 | Phase 9 的主要剩余风险不在对话语义，而在 Host 长期运行、公平性和恢复边界 | E-001、E-002、E-003 | 高 |
| F-002 | 继续使用“一个 worker 排空一个 Branch”会让热 Branch 垄断运行时间，并使全局背压不可证明 | E-003 | 高 |
| F-003 | World 单库备份不足以证明模型可见输入和 Provider 生命周期可重建 | E-005 | 高 |
| F-004 | P9C 可以用真实 v15 基线验证迁移，而无须伪造或降级当前 schema | E-002、E-006 | 高 |

### Path

| Finding | 实施路径 | 完成证据 |
| --- | --- | --- |
| F-001 | P9C.0 冻结边界，P9C.1～P9C.3 完成 Host 与行政闭环 | ADR、并发/崩溃矩阵、Health/Audit |
| F-002 | 单量子 API + 有界 round-robin + 耐久扫描恢复 | 32 Branch 公平性、wake-loss、双进程 fencing 测试 |
| F-003 | 部署恢复集合 + 双向水位校验 + 新目录恢复 | 多库 crash matrix、Presentation/Memory/Context 重建 Hash |
| F-004 | 从 `c2b3141` 生成真盘 fixture 并执行 v15→v16 | fixture SHA-256、迁移/回滚/旧世界 disabled 报告 |

## 15. 完成定义

P9C 完成不是“Host 能一直跑”，而是同时满足：

- 热 Branch 不会饿死其他 Branch，wake 丢失不会丢工作；
- shutdown、maintenance、archive、fork、quarantine 都不能留下语义不明的 active Cycle；
- 创作者能通过正式 Pack 版本显式选择 `responsive/v1`，旧 Pack 零漂移；
- 真盘旧库可以安全迁移，完整部署可以备份到新目录并恢复为同一可见世界；
- 长历史、8-call 并行、抢占与多进程竞争达到冻结门槛；
- 本机完整门槛和远程四格 CI 均通过，Release Closure 证据可复核。
