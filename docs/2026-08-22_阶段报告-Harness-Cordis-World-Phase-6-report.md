# Harness / Cordis World V0 Phase 6 阶段报告

> 日期：2026-08-22
> 状态：本机 Phase 6 门槛通过
> 基线：`docs/spec/implementation-v0.2.md`、ADR-0039
> 平台：Windows，Node 24.14.1，pnpm 11.7.0

## 1. 结论

Phase 6 已将 Phase 0～5 的独立原语闭合为一条生产路径：本机 CLI/JSON-RPC 进入 `WorldApplication`，按 `WorldAddress` 获取 Cordis Branch Runtime，在同一 InteractionRound 内处理玩家、Agent 和 Director 候选，经稳定排序与 Rulebook 重裁决后只提交一次 WorldStore，再由 Outbox、Session 和 Presenter 生成可恢复输出。完整 `pnpm check` 退出码为 0。

这表示冻结规格所要求的 V0 本机架构已经形成可执行、可重放、可硬崩溃恢复的 Reference Application；不表示远程服务、真实 Harness 模型桥或 TencentDB Memory 已启用。

## 2. 交付面

| 单元 | 公共入口 | 已实现不变量 |
|---|---|---|
| Runtime Composition | `BranchComponentFactory`、`WorldRuntimeRegistry` | 真实 branch-owned Store/Kernel/Agent/Director、单 Branch FIFO、Fiber dispose、跨 Branch 隔离 |
| Unified Round | `RoundCoordinator.submit` | 玩家先行、Provider 仅提案、严格动作校验、稳定排序、逐动作重裁决、单次权威提交 |
| Branch Operations | `BranchOperationCoordinator`、`WorldStore.forkDrainedBranch` | Gate 关闭后排空已受理 Inbox；fork/archive 前复核 Barrier；归档源不能再 fork |
| Application Root | `WorldApplication` | 按地址 acquire/release、Writer fencing、Round/Head/View、Outbox/Session/Presenter、重启查询 |
| Local Protocol | `ApplicationJsonRpcRouter`、`worldappctl` | 激活、Round、Head、View、投递、渲染、fork/archive、Snapshot、Backup、Restore、Transfer |
| Reference/Crash Matrix | `tests/p6.integration.test.ts`、Application crash worker | 多参与者、future canary、父归档后子继续、Provider 不重放、COMMIT 后硬终止恢复 |

## 3. Evidence

| ID | Evidence | 结果 |
|---|---|---|
| E-P6-001 | `corepack pnpm@11.7.0 check` | 退出码 0；TypeScript、Oxlint、Coverage、P0～P6、Crash 全通过 |
| E-P6-002 | Coverage 汇总 | 2222/2222 statements、1361/1361 branches、404/404 functions、1936/1936 lines |
| E-P6-003 | Coverage 测试集合 | 29 个测试文件、111 项测试通过；所有生产 `src` 文件逐文件四项 100% |
| E-P6-004 | `tests/p6.integration.test.ts` | 玩家、Agent、Director 同轮；fork；父归档；子继续；Session 渲染；重启与幂等回放通过 |
| E-P6-005 | `tests/crash.test.ts` | 11 项真实子进程终止测试通过，新增 Application 在 Store COMMIT 后、Inbox complete 前终止恢复 |
| E-P6-006 | Application/Operations 契约测试 | Writer 身份隔离、维护路由、权限/参数错误、Snapshot/Backup/Transfer 路由均 fail-closed |

## 4. 架构符合性

| 冻结设计要求 | 状态 | 说明 |
|---|---|---|
| WorldStore 是世界事实唯一权威 | 符合 | Provider、Cordis、Session、Presenter 和 Audit 均不能直接生成或改写世界事实 |
| 每 Branch 最多一个有效 Writer | 符合 | 进程实例使用独立 ownerId，数据库 Writer Lease/fencing 决定有效写者 |
| Provider 只能产生 Proposal | 符合 | Agent/Director 输出进入统一 Validator 和 Rulebook；不能绕开 Resolution/commitRound |
| 单 Round 单事务提交 | 符合 | Provider 调用在事务外；最终事件、Tick、Head、RoundCommit、Outbox 仍由一次 `commitRound` 提交 |
| 已受理 Round 不因维护丢失 | 符合 | durable admission proof 只允许 Gate 关闭前已入 Inbox 的 Round 排空；新输入仍被拒绝 |
| fork as-of 与模型可见内容可重建 | 符合 | 子分支按 forkSeq 截断；future canary 不进入 CharacterView；Session 输出由 Outbox 重建 |
| Cordis 生命周期按 Branch 隔离 | 符合 | 生产 Slot 注入真实组件，Service/Listener/FIFO/dispose 不跨 Branch 泄漏 |
| 本机入口不复制业务流程 | 符合 | Application JSON-RPC 只路由到 `WorldApplication`/Application Port；无远程监听 |

## 5. 关键恢复路径

### 5.1 COMMIT 后、Inbox 完成前终止

- 子进程在 `store.after-commit` 故障点被父进程硬终止。
- 新进程以相同受控 writer owner 恢复，重新提交同一 idempotency key。
- WorldStore 返回已提交结果，Inbox 被补记完成；Head 保持 Tick 1，Provider 不需要再次成为事实来源。

### 5.2 fork、父归档与子分支持续运行

- 父分支在 fork 后写入 `FUTURE_CANARY` 并完成 Session 投递。
- 协调器排空父分支后归档；子分支仍可提交新的 Tick。
- 子分支 CharacterView 不含父 fork 点后的 canary，重启后 Round 结果与 Presentation Hash 可恢复。

## 6. 完成门槛映射

| Phase 6 门槛 | 结果 | Evidence |
|---|---|---|
| 生产 Runtime 不再使用 Probe 组件 | 通过 | E-P6-004、E-P6-006 |
| 同轮玩家/NPC/Director 可完整重放 | 通过 | E-P6-004 |
| Provider 失败/超时/预算耗尽不阻塞玩家 | 通过 | E-P6-003、E-P6-006 |
| Gate/Drain/fork/archive 不丢失已受理 Round | 通过 | E-P6-003、E-P6-004 |
| 本机 RPC/CLI Reference Application 端到端 | 通过 | E-P6-004、E-P6-006 |
| 每个生产 `src` 文件四项覆盖率 100% | 通过 | E-P6-002、E-P6-003 |
| Application 硬崩溃恢复 | 通过 | E-P6-005 |

## 7. 保留边界与外部门槛

- 时间模式保持 V0 已决定的 `TURN_DRIVEN`；未实现实时守护进程或分形时间。
- Harness Bridge 默认禁用，未把只读上游源码复制或改入本仓库；无模型路径不受影响。
- TencentDB Memory 仍禁用，本地 SQLite FTS5 Memory 与 as-of 防火墙是当前实现。
- 没有远程监听、Branch merge/rebase/cherry-pick、物理删除、远程仓库、Tag 或 npm 发布。
- GitHub Actions 已配置 Windows/Ubuntu × Node 22.19/24 四组矩阵，但因没有远程仓库尚未执行；当前有效证据仅为 Windows/Node 24.14.1。
