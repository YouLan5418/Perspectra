# Harness / Cordis World V0 Phase 5 阶段报告

> 日期：2026-08-22
> 状态：本机 Phase 5 门槛通过
> 基线：`docs/spec/implementation-v0.2.md`
> 平台：Windows，Node 24.14.1，pnpm 11.7.0

## 1. 结论

Phase 5 已闭合本机 Branch 生命周期、Admission Barrier、Snapshot/Retention、World SQLite Backup/Restore、authority-only 逻辑 Export/Import、stdio CLI/进程内 JSON-RPC、Health、Audit、Metrics 和 Reference/Stress/Fault Matrix。没有实现远程监听、Branch merge/rebase/cherry-pick 或物理删除。P0～P5 的单机验收命令全部通过。

## 2. 交付面

| 单元 | 公共入口 | 已实现不变量 |
|---|---|---|
| Branch 管理 | `BranchAdministration`、`WorldStore.forkBranch` | Barrier、不可逆 archive、深度 8、同 world、Manifest 继承、无物理删除 |
| Snapshot | `SnapshotStore.create/read/latest/retireBefore` | 同 as-of Unit/Bundle Hash、完整 Bundle、只退休派生数据 |
| Backup/Restore | `WorldArchiveService.backup/restore` | SQLite 一致副本、quick_check、Schema/Hash、目标不覆盖 |
| Logical Transfer | `WorldLogicalTransferService.exportAuthority/importAuthority` | Canonical authority-only、Event Hash 复验、ID 保留、目标冲突拒绝 |
| Local Operations | `LocalJsonRpcRouter`、`executeLocalCli` | 进程内/stdio、无网络监听、稳定 ErrorEnvelope |
| Observability | `WorldHealthService`、`OperationalAuditLog`、`OperationsMetrics` | 只读 Health、append-only Audit、固定基数指标、非权威 |

## 3. Evidence

| ID | Evidence | 结果 |
|---|---|---|
| E-P5-001 | `corepack pnpm@11.7.0 check` | 退出码 0；类型、Lint、Coverage、P0～P5、Crash 全通过 |
| E-P5-002 | Coverage 汇总 | 1555/1555 statements、901/901 branches、307/307 functions、1335/1335 lines |
| E-P5-003 | `tests/p5.integration.test.ts` | fork/archive、迁移、Snapshot、Backup/Restore、物理与逻辑 Transfer、本机 RPC 端到端通过 |
| E-P5-004 | 64-Round stress fixture | Parent 64 Tick/Event；forkSeq 32 子 Branch 永久保持 32 个有效 Event |
| E-P5-005 | `tests/crash.test.ts` | 10 项真实子进程终止测试通过，含 backup/restore 完成窗口 |
| E-P5-006 | `packages/store-sqlite/src/logical-transfer.test.ts` | malformed、unsupported、missing table、invalid row、Event/hash 分歧全部 fail-closed |
| E-P5-007 | `packages/operations/src/operations.test.ts` | Health、RPC、CLI、Audit、Metrics 与非法请求矩阵通过 |

## 4. Findings

| ID | Finding | Evidence |
|---|---|---|
| F-P5-001 | Admission Barrier 必须同时保护 Inbox 前入口和 WorldStore 新事务；已提交 transaction 的幂等回放仍可读取。 | E-P5-003 |
| F-P5-002 | fork 需要继承 Manifest 并限制同 world/深度；只重建 Event 会得到不能启动的子 Branch。 | E-P5-003、E-P5-004 |
| F-P5-003 | Snapshot Retention 不能成为 WorldLog 删除入口；retired 只表达派生缓存不再首选。 | E-P5-003 |
| F-P5-004 | Backup 与逻辑 Export 是不同产品语义：前者保存 SQLite 页，后者只携带 authority 表并重新验证 Event Envelope。 | E-P5-003、E-P5-006 |
| F-P5-005 | 运维信号不能参与 World Hash；关键请求需先写 sidecar Audit，Metrics 只使用固定键。 | E-P5-007 |
| F-P5-006 | 进程终止后的“文件存在”不代表可恢复；必须用新连接复验 Schema、Hash、Head 和 Event。 | E-P5-005 |

## 5. Finding Paths

### 5.1 Branch maintenance 与 archive

- target: 在维护、快照和归档窗口阻止新权威写入
- preconditions: 操作员持有本机管理权限并给出 reason/correlationId
- action: 持久化 draining；Kernel 在 Inbox 前检查，WorldStore 在新 transaction 内再次检查；archive 固化 draining
- evidence: E-P5-003、E-P5-007
- finding: F-P5-001、F-P5-002
- verification: draining 返回 `BRANCH_DRAINING`；archive 不能 reopen；历史仍可读；深度 9 和跨 world fork 被拒绝
- residual_risks: V0 没有多操作员仲裁或分布式 Barrier

### 5.2 Backup、Restore 与逻辑 Transfer

- target: 本机灾难恢复和不含 Session/Memory/Audit 的 authority 移交
- preconditions: 调用方已进入维护窗口；目标路径不存在
- action: Backup 使用 Node SQLite 一致复制；Restore 校验文件 Hash/Schema/quick_check；逻辑 Import 校验 Canonical bundleHash 和每个 Event Envelope
- evidence: E-P5-003、E-P5-005、E-P5-006
- finding: F-P5-004、F-P5-006
- verification: 恢复/导入后 Event Hash 与源完全一致；损坏 Hash、Event、格式或目标冲突均 fail-closed
- residual_risks: 当前公共原语以单个 World 数据库为单位；多 Store 部署编排需由 host 在同一 Barrier 下组合各 Store 水位

### 5.3 本机运维边界

- target: 提供可自动化但不暴露远程攻击面的管理入口
- preconditions: 调用者已拥有本机文件和进程权限
- action: CLI 解析为同一 JSON-RPC 2.0 请求；Router 仅进程内执行；Health 只读；Audit sidecar 先于关键操作写入
- evidence: E-P5-007
- finding: F-P5-005
- verification: health/status/drain/open/archive/fork/audit/metrics 路径通过；非法请求返回 ErrorEnvelope；源码没有网络 listener
- residual_risks: V0 CLI 方法面是本机管理最小集，不包含远程通知或多人认证

## 6. 验收映射

| Phase 5 门槛 | 结果 | Evidence |
|---|---|---|
| fork/archive/Barrier 与迁移 | 通过 | E-P5-003 |
| Snapshot/Retention 不删除权威历史 | 通过 | E-P5-003 |
| Backup/Restore 与 Import/Export | 通过 | E-P5-003、E-P5-006 |
| 本机 CLI/JSON-RPC、Health、Audit、Metrics | 通过 | E-P5-007 |
| Reference/Stress/Fault Matrix | 通过 | E-P5-004、E-P5-005 |
| 每个生产 `src` 文件四项覆盖率 100% | 通过 | E-P5-002 |

## 7. 未闭合外部门槛

GitHub Actions 的 Windows/Ubuntu × Node 22.19/24 四组矩阵因没有远程仓库而保持已配置、未执行；当前证据仅为 Windows/Node 24.14.1。实际 Harness LLM Bridge 与 TencentDB Memory 仍因兼容公开版本、固定 commit、许可证和契约测试条件未满足而禁用。项目没有发布包、远程仓库、Tag 或远程管理监听。
