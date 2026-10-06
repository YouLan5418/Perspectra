# Harness / Cordis World Phase 0 阶段报告

> 状态：本机 Phase 0 实现与验收已通过；Windows/Linux × Node 22.19/24 的远程 CI 矩阵已配置但尚未执行，因此不能把本报告解释为跨平台发布验收。

本阶段建立了独立 pnpm/TypeScript 工程，完成基础契约、Cordis Branch Runtime、三个 SQLite 所有者、无模型模拟、六个 P0 原型、15 个 Accepted ADR，以及可复现的覆盖率和硬崩溃测试。

## 快速复现

在仓库根目录运行：

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check
```

本机验收环境为 Windows、Node 24.14.1、pnpm 11.7.0。`check` 的最终结果是 typecheck 通过、Oxlint 无告警、覆盖率 100%、P0 集成 1/1、硬崩溃矩阵 6/6。

## 实现结果

| 能力 | 实现 | 验证 |
|---|---|---|
| Canonical JSON/Hash | `world-json/v1`、完整 Hash Envelope、稳定 ID | 非法值、Unicode、排序和域隔离测试 |
| Cordis Runtime | Registry、Branch Slot、四个隔离 Service、显式 Listener Filter | 双 Branch Service/Listener/Dispose 测试 |
| Session Delivery | Inbox、Event、Cursor 同事务幂等写入 | 分歧、乱序、COMMIT 前后终止 |
| WorldStore | Event、Tick、Head、Round Commit、Outbox 同事务 | 重放、冲突、故障注入和重启 |
| 时态 Projection | Observation、Claim、Goal、Visibility 重放和物化 | forkSeq、修订、删除、future canary |
| 无模型闭环 | Scripted Agent、Noop/Rule/Scripted Director | 玩家原文、玩家先行、重启 Hash |

公共入口和使用方式见[根 README](../../../README.md)，实现约束见 [`AGENTS.md`](../../../AGENTS.md)，决策依据见 [ADR 索引](../../adr/README.md)。

## Evidence

### E-001

- title: 冻结实施规格逐字节一致
- observed_at: 2026-08-22T01:47:00+08:00
- source_type: file
- source_ref: `docs/spec/implementation-v0.2.md`
- content_hash: `sha256:8e0c8fa13e6279e266ab18010ef50976d6277839c67ee57fd7682bd787afe4eb`
- artifact_path: `docs/spec/implementation-v0.2.md`
- repro_command: `Get-FileHash -Algorithm SHA256 docs/spec/implementation-v0.2.md`
- raw_excerpt: 原文件与仓库副本 SHA-256 相同。
- linked_workitem: n/a
- supersedes: none

### E-002

- title: 本机统一验收入口通过
- observed_at: 2026-08-22T01:51:03+08:00
- source_type: command
- source_ref: `corepack pnpm@11.7.0 check`
- content_hash: n/a
- artifact_path: n/a
- repro_command: `corepack pnpm@11.7.0 check`
- raw_excerpt: typecheck、Oxlint、coverage、P0 integration、crash tests 全部 exit 0。
- linked_workitem: n/a
- supersedes: none

### E-003

- title: 生产源码逐文件 100% 覆盖
- observed_at: 2026-08-22T01:51:00+08:00
- source_type: file
- source_ref: `coverage/coverage-summary.json`
- content_hash: `sha256:4596aba4c71943e395b90b4eba7d725b1ccffbb18e3e84ffbb127b22954d9571`
- artifact_path: `coverage/coverage-summary.json`
- repro_command: `corepack pnpm@11.7.0 test:coverage`
- raw_excerpt: statements 424/424、branches 200/200、functions 86/86、lines 376/376。
- linked_workitem: n/a
- supersedes: none

### E-004

- title: WorldStore 与 Session Delivery 硬崩溃恢复通过
- observed_at: 2026-08-22T01:51:03+08:00
- source_type: command
- source_ref: `tests/crash.test.ts`
- content_hash: n/a
- artifact_path: n/a
- repro_command: `corepack pnpm@11.7.0 test:crash`
- raw_excerpt: 6 tests passed；覆盖 Event insert、COMMIT 前后、Inbox insert、Observation append 和 Session COMMIT 后。
- linked_workitem: n/a
- supersedes: none

### E-005

- title: Cordis Branch 事件需要显式 dispatch filter
- observed_at: 2026-08-22T01:43:20+08:00
- source_type: file
- source_ref: `packages/runtime-cordis/src/runtime.ts:72,88`
- content_hash: `sha256:afd073155d72dd2c4d8c17fe773b3b56c88ac05e8c44e6c5360d1707bb9dbe14`
- artifact_path: `packages/runtime-cordis/src/runtime.ts`
- repro_command: `corepack pnpm@11.7.0 test:p0`
- raw_excerpt: Service 使用 isolate；事件通过带 `Context.filter` 的 Branch Context 作为显式 thisArg 分发。
- linked_workitem: n/a
- supersedes: none

### E-006

- title: 上游调研源码保持只读
- observed_at: 2026-08-22T01:51:20+08:00
- source_type: command
- source_ref: `../deepseek-harness-dsh-v0.1.1-rc.1`
- content_hash: n/a
- artifact_path: n/a
- repro_command: `Get-ChildItem ..\deepseek-harness-dsh-v0.1.1-rc.1 -Recurse -File | Where-Object { $_.FullName -notlike '*\node_modules\*' -and $_.LastWriteTime -gt [datetime]'2026-08-22T01:20:00' }`
- raw_excerpt: 没有发现实施开始后的非依赖文件修改。
- linked_workitem: n/a
- supersedes: none

## Findings

### F-001

- title: Phase 0 本机实现门槛已通过
- severity: info
- category: design
- status: validated
- evidence_ids: [E-001, E-002, E-003, E-004]
- location: repository root
- impact: 后续 Phase 1 可以在已验证的确定性、事务和隔离接口上开发。
- confidence: high
- repro_steps: 安装锁定依赖；运行统一 `check`。
- remediation: n/a
- optional_attack: n/a

### F-002

- title: Cordis Service isolate 不自动隔离普通事件 Listener
- severity: medium
- category: design
- status: validated
- evidence_ids: [E-005]
- location: `packages/runtime-cordis/src/runtime.ts:63-90`
- impact: 如果只隔离 Service，某 Branch 发出的事件会被其他 Branch Listener 接收。
- confidence: high
- repro_steps: 创建两个 Branch Slot；只使用 Service isolate；从 A 分发 probe；观察 B Listener；加入 `Context.filter` 后复测。
- remediation: 每个 Branch Context 同时配置独立 Service label 和 Listener filter，并始终以 Branch Context 作为 dispatch thisArg。
- optional_attack: n/a

### F-003

- title: SQLite COMMIT 边界满足全有或全无恢复
- severity: info
- category: design
- status: validated
- evidence_ids: [E-004]
- location: `packages/store-sqlite/src/world-store.ts:161-299`、`session-delivery.ts:57-125`
- impact: 进程在稳定故障点被 OS 终止后，不会观察到部分 World Bundle 或部分 Session Delivery。
- confidence: high
- repro_steps: 运行 crash test；分别检查 COMMIT 前 head/cursor 为 0，COMMIT 后为 1。
- remediation: 保留 `synchronous=FULL`、短事务和硬终止回归测试。
- optional_attack: n/a

### F-004

- title: 跨平台 Golden 与崩溃矩阵尚待远程 CI 证据
- severity: low
- category: other
- status: candidate
- evidence_ids: [E-002, E-003, E-004]
- location: `.github/workflows/p0.yml`
- impact: 当前只能确认 Windows/Node 24.14.1；Node 22.19 和 Linux 行为尚无本仓库 CI 运行记录。
- confidence: high
- repro_steps: 将仓库推送到启用 GitHub Actions 的远程；观察四组 matrix 的 `pnpm check`。
- remediation: 远程 CI 四组全部通过后再把 Phase 0 标为跨平台完成。
- optional_attack: n/a

## Paths

### P-001

- title: 玩家输入到权威 World Commit
- path_type: callflow
- start: `WorldSimulation.submitPlayerMessage`
- goal: 可重放的 Event/Tick/Head/Outbox Bundle
- steps:
  1. action: 逐字生成玩家 `character.speak` Action — evidence: E-002 — finding: F-001
  2. action: Scripted Agent 与 Director 生成结构化 Proposal — evidence: E-002 — finding: F-001
  3. action: 生成 Resolution、Observation 和 Outbox Draft — evidence: E-003 — finding: F-001
  4. action: WorldStore 在一个 `BEGIN IMMEDIATE` 中提交全部权威状态 — evidence: E-004 — finding: F-003
- residual_risks: 当前 Provider 均为无模型实现；Harness LLM Bridge 属于 Phase 3。

### P-002

- title: World Outbox 到 Session Observation
- path_type: callflow
- start: 已提交 Outbox Item
- goal: Session Event 与 Cursor 原子可见
- steps:
  1. action: 校验 Session FIFO cursor 和 delivery 绑定 — evidence: E-003 — finding: F-001
  2. action: 插入 `session_delivery_inbox` — evidence: E-004 — finding: F-003
  3. action: 追加 Observation Event 并推进 cursor — evidence: E-004 — finding: F-003
  4. action: 重试相同内容返回 `already_applied`，分歧 fail-closed — evidence: E-002 — finding: F-001
- residual_risks: Phase 0 未实现 Outbox Worker 重试调度和 Critical Dead Letter 管理面。

## 交付边界

本阶段没有实现正式 CLI、JSON-RPC、WorldSpec Compiler、Genesis、Harness LLM Bridge、Memory、Snapshot、行政 Barrier、Backup 或 Restore。仓库未创建远程、未发布包、未自动提交，也没有修改上游 Harness 源码。
