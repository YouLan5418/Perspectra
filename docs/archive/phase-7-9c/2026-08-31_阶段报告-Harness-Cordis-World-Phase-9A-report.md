# Harness / Cordis World Phase 9A 阶段汇总

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-31 |
| 分支 | `phase8.2/correctness-closure` |
| 当前提交 | `3967ba0` |
| 状态 | **进行中：World 侧权威骨架第一批完成，运行闭环尚未完成** |
| 对照规格 | [Phase 9 有界自主 Reaction Cycle](../../spec/phase-9-implementation-v0.1.md) |

## 结论

Phase 9A 已经建立可耐久恢复的 Reaction Cycle 基础：玩家 Round 与初始 Cycle、Wave、Job、刺激引用可以原子冻结；Job 领取受 Writer Lease 和 fencing 保护；不可变 Reaction 权威与可变执行状态已经分离；World 侧逻辑导出升级到 v6；被领取的 Job 可以绑定唯一 Context Receipt 与 ProviderCall。

这批工作解决的是“NPC 后续反应如何被可靠记录和恢复”，还没有接通正式 Scheduler、单 wave Reaction Round 提交和跨 World/Context 数据库恢复。因此，当前不能把 Phase 9A 或“NPC 自主连续对话”宣称为完成。

## 已完成

| 能力 | 当前结果 | 关键提交 |
| --- | --- | --- |
| 正式 Schema | 建立 Cycle、Wave、Job、Stimulus 四张 v16 表 | `7467ec2` |
| 原子冻结 | 根 Round 的 Event、Head、Outbox、RoundCommit 与初始 Reaction 数据在同一 `BEGIN IMMEDIATE` 事务提交 | `14d3898` |
| 稳定预算与顺序 | 使用共享预算规划和 UTF-16 稳定顺序冻结参与者与刺激 | `639b605`、`14d3898` |
| Job 领取与 fencing | 要求当前 Writer Lease、Job fence 和精确状态 Hash；Job 租期不超过 Writer Lease | `329c8c5` |
| 权威 Hash 分层 | 根 Round 绑定不可变 Reaction Authority Hash，Job 领取等可变状态使用独立状态 Hash | `3ded3c8` |
| World 侧逻辑导出 v6 | 同一 WAL 读事务导出四张 Reaction 表；导入时重验链、Hash、来源绑定和状态组合 | `bcfadd6` |
| Provider 绑定 | live claim 只能绑定一个确定的 Context Receipt 与 ProviderCall；不同绑定 fail-closed | `3967ba0` |

## 本轮关键修正

实现过程中发现：如果根 Round 的 `bundleHash` 绑定了会随 Job 领取变化的状态 Hash，那么一次正常 claim 就会让历史 Round 看起来被篡改。现在已拆为两层：

- Reaction Authority Hash 只覆盖创建时不可变的 Cycle、Wave、Job 和刺激权威；
- Job 当前状态与租约由独立状态 Hash 和 CAS 保护。

这保证“历史事实不会因正常执行而改变”，同时保留并发领取和恢复时的 fail-closed 检查。

## 验证证据

| Evidence | Finding | Path |
| --- | --- | --- |
| E-001：`corepack pnpm@11.7.0 check` 退出码为 0 | F-001：当前生产文件继续满足逐文件四项 100% 覆盖，既有门禁未回退 | P-001：完整验收命令 → TypeScript/lint → 71 个测试文件、728 项测试 → P0～P6 → 24 项子进程崩溃测试 |
| E-002：`reaction-cycle.test.ts` 覆盖原子冻结、幂等、claim/fence、Provider 绑定和异常状态 | F-002：World 侧 Reaction 权威骨架具备确定性和并发防护 | P-002：根 Round 提交 → 原子创建 Cycle → claim CAS → 绑定 Context/ProviderCall |
| E-003：`logical-transfer.test.ts` 覆盖 v6 导出、v4/v5 升级和篡改拒绝 | F-003：World 侧 Reaction 账本可被一致导出并在导入时重验 | P-003：WAL 读快照 → v6 Envelope → 导入校验 → 恢复原状态 |

复现命令：

```powershell
corepack pnpm@11.7.0 check
```

## 尚未完成

- World 与 Context 数据库之间的 ProviderCall 恢复对账，以及包含 Context 伴随数据的完整迁移/备份集合；
- `prepared`、`dispatch_started`、已返回结果等 ProviderCall 状态的正式恢复策略；
- 单 wave NPC-only Reaction Round 的权威提交，以及 Job settle 与世界提交的原子闭合；
- Reaction 专属硬崩溃窗口测试；现有 24 项崩溃测试仍是既有系统矩阵；
- Scheduler、启动补扫、唤醒、查询 API、Presentation 和运行健康度接线；
- Phase 9B 的多 wave 与玩家抢占，以及 Phase 9C 的完整运行与降级演练。

## 下一步

1. 完成 World/Context 跨库恢复对账，并把被引用的 Context Receipt、ProviderCall 纳入同一恢复集合。
2. 冻结 ProviderCall 各状态的可重试与不可重试规则，确保 dispatch 歧义时不重复调用。
3. 实现单 wave Reaction Round 提交和 Job 原子 settle。
4. 为 claim、绑定、dispatch 和世界提交之间的窗口补真实子进程硬终止测试。
5. 最后接入应用 Scheduler 和启动恢复，形成可实际运行的单 wave NPC 后续反应闭环。

## 本阶段提交

```text
14d3898 feat(store): atomically freeze initial reaction cycles
329c8c5 feat(store): fence reaction job claims
3ded3c8 fix(store): separate reaction authority from job state
bcfadd6 feat(store): export reaction authority v6
3967ba0 feat(store): bind reaction jobs to provider calls
```
