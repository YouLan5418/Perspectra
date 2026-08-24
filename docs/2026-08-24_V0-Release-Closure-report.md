# Harness / Cordis World V0 Release Closure 报告

- 日期：2026-08-24
- 源码形态：私有、未发布 npm
- 版本：`0.1.0`
- 本机环境：Windows，Node 24.14.1，pnpm 11.7.0
- 协议：stdio only
- 可选集成：Harness/TencentDB 禁用
- 判定：**本机 Release Closure 通过；外部发布门槛未完成**

## 本轮闭合

1. Application Port 接管 maintenance/status/audit，生产 RPC 不再需要绕过组合根。
2. 七个真实 process entry 均有子进程 smoke；Headless 处理背压、EPIPE、SIGINT/SIGTERM 和有序关闭。
3. 冻结本机 V0 RPC 方法面并提供五类 ephemeral notification；每类均可查询恢复，监听器错误不影响权威结果。
4. `worldhost` 支持 CLI > env > YAML > defaults 配置和标准目录；`instance.lock` 同时校验 PID 与数据库 Writer Lease，并绑定 runtime owner 前缀。
5. Outbox 采用耐久 1/2/4/8/16/30 秒退避、默认 12 次与 10 分钟 maxAge；World schema v14。
6. 所有私有包统一 `0.1.0`；新增 Changelog、运行/恢复手册、示例配置和 `world-json/v1` 精确 Golden Fixture。

## 本机验收证据

最终命令：

```powershell
corepack pnpm@11.7.0 check
```

结果：

| 门槛 | 结果 |
|---|---|
| TypeScript strict typecheck | 通过 |
| Oxlint | 通过 |
| 覆盖测试 | 45 files，258 tests 通过 |
| statements | 100% |
| branches | 100% |
| functions | 100% |
| lines | 100% |
| P0～P6 integration | 8 tests 通过 |
| hard crash matrix | 18 tests 通过 |
| 真实 host/CLI process smoke | 纳入覆盖测试并通过 |

关键新增崩溃证据包括：`instance.lock` 获取后硬终止，恢复进程仅在原 PID 死亡且无有效 Writer Lease 时取得新锁。既有 COMMIT 前后、Session delivery、Outbox receipt、quarantine、archive、异步 Round 恢复窗口继续通过。

## 规格/实现映射

| 约束 | V0 落点 |
|---|---|
| Event Log 唯一世界事实 | `WorldStore.commitRound` 事务、事件 Hash 链、Authority Ledger |
| 模型输出只能提案 | Validator + 精确 Rulebook Registry + Resolution 后提交 |
| 角色知识/记忆隔离 | CharacterView、Local Memory namespace、as-of/source firewall |
| 异步 Round 可恢复 | durable Inbox、roundId/idempotency、startup scan、`round.process/get/cancel-queued` |
| 单 Writer 与多进程安全 | DB fencing token、Branch FIFO、instance lock + owner nonce |
| Session 至少一次且幂等 | Outbox claim CAS、delivery receipt、连续 seq、退避/dead-letter |
| 通知非事实源 | 五类 stdio notification + 对应查询恢复 |
| 悬疑只是试金石 | Core v1/v2 通用规则；v3/v4 Resolver 只由 Demo 显式注册 |
| 无模型完整运行 | Scripted/Rule/Noop、Local Memory、六种降级 Drill |

## 格式兼容表

| 项目 | V0 值 | 兼容策略 |
|---|---|---|
| 源码版本 | 0.1.0 | 私有 workspace，不承诺 npm semver |
| Canonical JSON | `world-json/v1` | 精确 bytes/hash Golden 固定 |
| Compiled Manifest | schema v2 | 存量 v1 只读 upcast，原字节/Hash 不变 |
| World SQLite | schema v14 | 连续前向迁移；不重写历史 Event |
| Session/Projection/Snapshot SQLite | schema v1 | 独立 application_id 与所有权 |
| Memory SQLite | schema v4 | 派生数据，可由 World 来源重建 |
| Backup | `world-sqlite-backup/v1` | 必须精确匹配 World schema v14 |
| Logical authority | `dshworld-authority/v5` | v4 可受控升级；不含 Session/Memory/Secret |
| Mystery Rulebook | v3 存量、v4 当前 | 通用 host 未注册时 `RULEBOOK_NOT_REGISTERED` |

## 有记录的规格替代

冻结规格曾描述多数据库 backup manifest。ADR-0038 已以可证明的恢复模型替代：只对 World DB 做 SQLite 一致备份，保留 Outbox delivery 序号并以消费端幂等重建 Session；Memory 作为派生状态重建。实现和报告均不得把独立数据库描述成共享事务或原子快照。

## 未闭合外部门槛

以下事项需要用户授权或 GitHub 外部状态，本轮未执行：

1. 尚未创建或配置 GitHub 私有远程；没有 push。
2. `.github/workflows/p0.yml` 已配置 Windows/Ubuntu × Node 22.19/24，但四格未实际运行；尚无 run URL/commit SHA。
3. 尚未创建 `v0.1.0` Tag 或 GitHub Release。
4. 本机版本切换后的 `pnpm install --frozen-lockfile --offline` 在 Windows package link 收尾阶段持续不终止；现有依赖树下正式 `pnpm check` 完整通过，但这不能作为 clean-install 证据。必须由四格 CI 的 clean install 关闭。
5. 工作树中保留了本轮开始前已有的用户未跟踪内容 `.workbuddy/` 与 `docs/2026-08-24_独立代码审查报告.md`；Release 提交未包含或删除它们。

## 发布建议

下一次由用户确认后：创建私有 GitHub 远程 → push 当前候选 → 等待四格 CI 全绿 → 保存证据 → 确认工作树/commit → 创建并推送 `v0.1.0` Tag。任何一格失败都不得打 Tag。
