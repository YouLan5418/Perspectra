# Harness / Cordis World V0

> 当前状态：Phase 0～6 Reference Architecture 的 Windows/Node 24 本机门槛与独立审查修订已通过。严格 V0 Release Closure 仍在进行；异步 Round 本机协议已闭合，冻结方法面、通知、Host 配置/instance.lock 和跨平台发布证据尚未闭合。LLM/TencentDB Bridge 与远程访问保持禁用。

这是一个独立的、事件溯源的 TURN_DRIVEN 世界模拟内核原型，用 Cordis 管理 Branch 运行时生命周期，用 Node 内置 SQLite 验证耐久原子性、幂等投递、forkSeq 时态重建和无模型确定性闭环。

## 快速验证

前置条件是 Node 22.19.x 或 24+，以及可用的 Corepack。

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check
```

`check` 依次运行类型检查、Lint、逐文件 100% 覆盖率、P0～P6 集成测试和子进程硬崩溃测试。

已存在 World 数据库时，可通过本机 stdio CLI 查询健康状态：

```powershell
corepack pnpm@11.7.0 worldctl -- D:\path\to\world.sqlite health
```

需要长驻本机进程时，可启动 newline-delimited JSON-RPC stdio Host；它不会开启任何网络监听：

```powershell
corepack pnpm@11.7.0 worldhost -- D:\path\to\world.sqlite D:\path\to\session.sqlite
```

运行无模型的悬疑 Demo 固定开场（再次执行会从同一 SQLite 幂等恢复）：

```powershell
corepack pnpm@11.7.0 demo:mystery D:\path\to\mystery-world.sqlite D:\path\to\mystery-session.sqlite
```

命令只输出玩家可见视图和公开物品状态；Bob 的私有凶手 Claim 不会出现在终端结果中。

固定开场后，可以用同一数据库逐轮提交自然语言或显式调查命令：

```powershell
corepack pnpm@11.7.0 demo:mystery:turn D:\path\to\mystery-world.sqlite D:\path\to\mystery-session.sqlite turn:inspect "检查一下书桌"
```

每轮都必须提供唯一幂等键；未知或歧义输入返回 `clarification_required`，不会猜测或提交世界事实。该结果会独立耐久并审计，但不会创建 Round 或推进 Tick。

也可以在同一进程、同一 mounted world 中连续输入普通对白、通用命令或调查语法：

```powershell
corepack pnpm@11.7.0 demo:mystery:shell D:\path\to\mystery-world.sqlite D:\path\to\mystery-session.sqlite
```

悬疑只是一项架构试金石。调查 Resolver 位于 Demo 组合根，通用 Kernel 只内建 `speak/move/take`；普通文本通过正式 `WorldApplication.submitText` 进入同一 Inbox、Validator、Rulebook 和 Authority 管线。

六种本机降级演练可用全新数据库路径运行，例如：

```powershell
corepack pnpm@11.7.0 demo:mystery:drill agent-timeout D:\path\to\drill-world.sqlite D:\path\to\drill-session.sqlite
```

可选模式为 `agent-failure`、`agent-timeout`、`budget-exhausted`、`director-fallback`、`memory-catchup-failure` 和 `session-dead-letter`。输出只含玩家结果、terminal、Health、Audit/Metric 摘要与恢复步骤。

## 使用基础契约

```typescript
import { canonicalizeWorldJson, hashWorldJson } from '@harness-world/contracts'

const bytes = canonicalizeWorldJson({ message: 'hello', tick: 1 })
const hash = hashWorldJson('example', { byteLength: bytes.byteLength })
console.log(hash)
```

## Workspace

| 包 | 责任 |
|---|---|
| `@harness-world/application` | WorldApplication 组合根、统一 Round、Branch 排空与真实 Runtime 组件 |
| `@harness-world/contracts` | 品牌 ID、WorldAddress、Canonical JSON、Hash、错误和 Registry |
| `@harness-world/agents` | ContextAssembler、submit_actions、HarnessAgentPort、预算、Director Scheduler 与 Replay |
| `@harness-world/kernel` | WorldSpec Compiler、Tick 0 Genesis、PlayerBinding、通用 Rulebook Registry/Resolver 与 WorldKernel |
| `@harness-world/memory` | 本地 SQLite FTS5 Memory、source mapping、as-of 防火墙和认知规则 |
| `@harness-world/operations` | 无网络监听的本机 CLI/JSON-RPC、Health 和固定基数 Metrics |
| `@harness-world/presentation` | 只消费已授权 Observation 的确定性模板渲染器 |
| `@harness-world/runtime-cordis` | BranchRuntimeSlot、Cordis Service/Listener/Dispose 隔离 |
| `@harness-world/store-sqlite` | World/Session/Projection、Branch Barrier、Snapshot、Audit、Backup 与逻辑 Transfer |
| `@harness-world/simulation` | Scripted Agent、三种 Director、无模型 Round 闭环、Demo-owned 调查 Resolver 与三角色悬疑 Scenario |
| `@harness-world/testkit` | 确定性 Fixture、FaultInjector 和硬终止 Harness |

## 已验证行为

- 同一 Branch 只复用一个活动 Runtime Slot，不同 Branch 的 Service 和 Listener 不泄漏。
- Session Inbox、Observation append 和 cursor 推进同事务提交；重复相同 Delivery 返回 `already_applied`，分歧 fail-closed。
- World Event、Tick、Head、Round Commit 和 Outbox 同事务提交；COMMIT 前终止不留部分状态，COMMIT 后终止可幂等恢复。
- forkSeq 重建不会读取父分支未来 Observation、Claim、Goal 或 Visibility。
- Scripted/Rule/Noop 路径不需要模型或网络，重启与重放产生相同 Bundle Hash。
- WorldSpec 严格编译为稳定 Manifest 与 Genesis Plan；Tick 0 激活可幂等重放。
- 数据库 Writer Lease 使用单调 fencing token；耐久 Round Inbox 与 Branch FIFO 保持每条玩家输入独立成 Tick。
- 无 Agent 玩家 `character.speak`、move 和领域拒绝均可提交；提交后、Inbox 完成前失败可用相同 transaction/hash 恢复。
- CharacterView 在同一 asOfSeq 组合 Scene、Visibility、Self Observation、Observation、Claim 与 Goal，并按角色 fail-closed 裁剪。
- Outbox Worker 为每个 Session 分配连续序号；Receipt 可恢复，Critical Dead Letter 阻止同 Session 越序。
- Deterministic Presenter 只渲染授权内容，不参与 World Event、Projection 或权威 Bundle Hash。
- Agent Context 固定 WorldAddress/CharacterView/Capability；`submit_actions` 对 actor、action type、版本和数量严格校验。
- Harness Bridge 默认禁用且只通过 `HarnessAgentPort` 注入；预算、失败和超时均降级为空提案，不阻塞玩家。
- Director Scheduler 为确定性纯逻辑，Model Replay 只读取已记录的精确 request/response Hash。
- Local Memory 只接受当前角色、当前 Branch 且不晚于 as-of 边界的已提交来源；Summary、未来和跨 namespace 来源均 fail-closed。
- KnowledgeRule 与 `character.reflect` 只从 CharacterView 推导 Claim；Session Compaction 保留原始事件并绑定来源范围与 Hash。
- Branch fork 继承 Manifest、限制最大深度 8；Admission Barrier 和 archive 阻止新写入，但不物理删除历史。
- Snapshot Unit/Bundle 同 as-of 绑定并只做派生退休；WorldLog、幂等账本和投递账本不截断。
- SQLite Backup/Restore 保持原 Event Hash；authority-only `.dshworld` 逻辑包排除 Session、Memory、Audit 和进程状态。
- World/Branch/Archive/Transfer 请求写 append-only sidecar Audit；Health 与固定基数 Metrics 不参与权威状态。
- `round.submit` 只完成耐久受理并返回稳定 `roundId`；`round.get` 查询 queued/processing/committed/failed/cancelled，queued 取消使用事务 CAS。
- JSON-RPC 同时支持进程内路由与 newline-delimited stdio Headless 循环；CLI 的 `--wait` 只轮询耐久状态，没有 TCP、Pipe、Socket 或远程监听。
- 生产 Cordis Slot 持有真实 Store、Kernel、Agent 和 Director 组件；Branch Fiber 统一释放资源，不再以 Probe 代替生产组件。
- 玩家、NPC Agent 与 Director 候选在同一 Round 中经过严格校验、稳定排序和逐动作重裁决，并只执行一次 WorldStore 提交。
- 三角色悬疑 Scenario 已冻结私有初始知识和差异化观察；Bob 通过 `take` Proposal 取得钥匙，重启后 Event、Authority 与 CharacterView Hash 保持不变。
- Branch 行政操作先关闭 Gate，再排空已耐久受理的 FIFO，最后执行 fork/archive；新输入不能混入维护窗口。
- `WorldApplication` 贯穿 Runtime、Outbox、Session 与 Presenter；父分支归档后子分支可继续提交，重启和幂等回放不再次调用 Provider。
- Application JSON-RPC/CLI 覆盖激活、Round、Head、CharacterView、投递、渲染、fork/archive、Snapshot、Backup 和 Transfer；数据库 Writer 身份默认按进程实例隔离。
- Rulebook 采用精确版本注册；Core 只注册通用 v1/v2，悬疑 v3/v4 只由 Demo 组合根显式加载，旧世界 Golden 与生命周期保持兼容。
- 新 Demo 的 Scene 调度从耐久 Projection 决断；Cognitive Memory v2 按角色、Branch 和 as-of capture Observation/Claim/Goal 并绑定每参与者 Authority。
- 普通对白、通用命令与调查语法可以在同一个连续 shell 中交错；clarification 不创建 Round。
- 六种降级 Drill 均验证玩家 Tick 前进、terminal/Audit/Metric/Health、零调用重放和恢复后的重新参与。
- 非悬疑社交参考切片只使用 Core v2、Scene、Cognitive Memory 与通用文本输入，证明横向能力不依赖调查规则。

## 文档

- [冻结实施规格](docs/spec/implementation-v0.2.md)
- [ADR 索引](docs/adr/README.md)
- [Phase 0 阶段报告](docs/2026-08-22_阶段报告-Harness-Cordis-World-Phase-0-report.md)
- [Phase 1 阶段报告](docs/2026-08-22_阶段报告-Harness-Cordis-World-Phase-1-report.md)
- [Phase 2 阶段报告](docs/2026-08-22_阶段报告-Harness-Cordis-World-Phase-2-report.md)
- [Phase 3 阶段报告](docs/2026-08-22_阶段报告-Harness-Cordis-World-Phase-3-report.md)
- [Phase 4 阶段报告](docs/2026-08-22_阶段报告-Harness-Cordis-World-Phase-4-report.md)
- [Phase 5 阶段报告](docs/2026-08-22_阶段报告-Harness-Cordis-World-Phase-5-report.md)
- [Phase 6 阶段报告](docs/2026-08-22_阶段报告-Harness-Cordis-World-Phase-6-report.md)
- [Phase 6 独立审查修复报告](docs/2026-08-22_Phase-6独立审查修复报告.md)
- [异步 Round 与本机 Headless 进度报告](docs/2026-08-23_进度报告-异步Round与本机Headless-report.md)
- [三角色悬疑 Demo 首个可执行切片](docs/2026-08-23_进度报告-三角色悬疑Demo首个可执行切片.md)
- [悬疑 Demo Phase 2：多轮调查与真相揭露闭环](docs/2026-08-23_阶段报告-悬疑Demo-Phase-2.md)
- [悬疑 Demo 架构纠偏与四项欠账闭环](docs/2026-08-23_阶段报告-悬疑Demo架构纠偏与四项欠账闭环.md)

遇到 `SESSION_DELIVERY_DIVERGED`、`BUNDLE_HASH_MISMATCH` 或其他 integrity 错误时不得重试覆盖数据；调用方应停止写入并进入受控诊断流程。
