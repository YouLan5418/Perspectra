# Harness / Cordis World V0

> 当前状态：Phase 0 契约与技术原型，不是可供最终用户运行的世界模拟产品。项目尚未提供正式 CLI、JSON-RPC、LLM、Memory、备份或远程访问。

这是一个独立的、事件溯源的 TURN_DRIVEN 世界模拟内核原型，用 Cordis 管理 Branch 运行时生命周期，用 Node 内置 SQLite 验证耐久原子性、幂等投递、forkSeq 时态重建和无模型确定性闭环。

## 快速验证

前置条件是 Node 22.19.x 或 24+，以及可用的 Corepack。

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check
```

`check` 依次运行类型检查、Lint、逐文件 100% 覆盖率、P0 集成测试和子进程硬崩溃测试。

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
| `@harness-world/contracts` | 品牌 ID、WorldAddress、Canonical JSON、Hash、错误和 Registry |
| `@harness-world/runtime-cordis` | BranchRuntimeSlot、Cordis Service/Listener/Dispose 隔离 |
| `@harness-world/store-sqlite` | WorldStore、SessionDeliveryAdapter、时态 Projection |
| `@harness-world/simulation` | Scripted Agent、三种 Director 和无模型 Round 闭环 |
| `@harness-world/testkit` | 确定性 Fixture、FaultInjector 和硬终止 Harness |

## 已验证行为

- 同一 Branch 只复用一个活动 Runtime Slot，不同 Branch 的 Service 和 Listener 不泄漏。
- Session Inbox、Observation append 和 cursor 推进同事务提交；重复相同 Delivery 返回 `already_applied`，分歧 fail-closed。
- World Event、Tick、Head、Round Commit 和 Outbox 同事务提交；COMMIT 前终止不留部分状态，COMMIT 后终止可幂等恢复。
- forkSeq 重建不会读取父分支未来 Observation、Claim、Goal 或 Visibility。
- Scripted/Rule/Noop 路径不需要模型或网络，重启与重放产生相同 Bundle Hash。

## 文档

- [冻结实施规格](docs/spec/implementation-v0.2.md)
- [ADR 索引](docs/adr/README.md)
- [Phase 0 阶段报告](docs/2026-08-22_阶段报告-Harness-Cordis-World-Phase-0-report.md)

遇到 `SESSION_DELIVERY_DIVERGED`、`BUNDLE_HASH_MISMATCH` 或其他 integrity 错误时不得重试覆盖数据；调用方应停止写入并进入受控诊断流程。
