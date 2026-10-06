# V0 本机运行与恢复手册

## 支持边界

- 私有源码版本：`0.1.0`
- Node：`^22.19.0 || >=24.0.0`
- pnpm：`11.7.0`
- 传输：仅 newline-delimited JSON-RPC 2.0 stdio
- Harness/TencentDB：默认禁用
- 权威库：World SQLite；Session、Memory、Snapshot 与 Audit 按各自所有权独立

## 安装与验收

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check
```

`check` 必须依次通过 typecheck、lint、逐文件四项 100% 覆盖率、P0～P6 和真实子进程崩溃矩阵。

## worldhost 配置

配置优先级固定为：CLI > 环境变量 > `world-host.yml` > 默认值。

```powershell
corepack pnpm@11.7.0 worldhost -- --config D:\path\world-host.yml
```

也可使用：

```powershell
corepack pnpm@11.7.0 worldhost -- --data-dir D:\HarnessCordisWorld --lease-ttl-ms 5000
```

兼容入口 `worldhost <world.sqlite> <session.sqlite>` 仍保留。环境变量为 `HCW_CONFIG_PATH`、`HCW_DATA_DIR`、`HCW_WORLD_PATH`、`HCW_SESSION_PATH`、`HCW_MEMORY_PATH`、`HCW_CONTEXT_PATH`、`HCW_LEASE_TTL_MS`，以及 Host 调度专用的 `HCW_MAX_CONCURRENT_BRANCHES`（1～32，默认 4）、`HCW_RESCAN_INTERVAL_MS`（100～60000，默认 1000）、`HCW_SHUTDOWN_TIMEOUT_MS`（1000～300000，默认 35000）。三个调度旋钮只决定何时执行工作，不进入 Manifest、Genesis 或任何世界 Hash（见 [ADR-0079](../../adr/ADR-0079-host-fair-scheduling-backpressure-administrative-stop.md)）。示例见 [`config/world-host.example.yml`](../../../config/world-host.example.yml)。Secret 不属于该配置，不得写入 YAML、Backup 或 Export。

默认目录：

```text
HarnessCordisWorld/
  instance.lock
  data/world.sqlite
  data/session.sqlite
  data/memory.sqlite
  backups/
  exports/
  logs/
  config/world-host.yml
```

Windows 根目录默认位于 `%LOCALAPPDATA%\HarnessCordisWorld`；Linux 位于 `$XDG_DATA_HOME/harness-cordis-world` 或 `~/.local/share/harness-cordis-world`。

## stdio 协议

stdin 每行一个 JSON-RPC request，stdout 每行一个 response 或 notification。stderr 仅用于诊断。不得把 stdout 日志混入协议流。通知可能丢失：

| 通知 | 查询恢复 |
|---|---|
| `round.committed` | `round.get` |
| `reaction.started` | `reaction.get` / `reaction.list` |
| `reaction.round_committed` | `reaction.get` / `session.render` |
| `reaction.completed` | `reaction.get` |
| `presentation.ready` | `session.render` |
| `health.changed` | `health.get` |
| `outbox.dead-lettered` | `outbox.list` |
| `branch.quarantined` | `quarantine.explain` |

`worldhost` 不打开 TCP、Pipe、Socket 或浏览器端口。

## 公平调度与可观测性

Host 按 [ADR-0079](../../adr/ADR-0079-host-fair-scheduling-backpressure-administrative-stop.md) 以「一个 Branch 一个量子」调度：

- 一次量子最多推进一个已冻结 Wave，或提交一个已受理玩家 Round；Cycle 未终态前不会跳到下一条玩家输入；
- 同一 Branch 同时只有一个量子在执行，跨 Branch 最多 `maxConcurrentBranches` 个并行；
- ready Branch 按 `worldAddressKey` 的 UTF-16 顺序建立稳定起点并轮转，热 Branch 不会饿死其他 Branch；
- wake 只是可丢失、可合并的提示：驻留提示上限 1024，超限只置 `rescanRequired`；启动扫描与每 `rescanIntervalMs` 的耐久扫描会从 `round_inbox` 与 `world_reaction_cycles` 重新推导可运行 Branch，因此丢掉全部提示也不会丢工作。

观测入口同样是固定基数：

- `metrics.get` 返回进程计数（含 `reaction_cycles_started/completed`、`reaction_waves_committed`、`reaction_actions_accepted`、终态原因分布、`branch_work_failures`、`shutdown_timeouts`）与 `branchWork` 调度快照（ready/in-flight 数、`wakeOverflow`、`rescans`、`scanFailures`、`oldestReadyWaitMs`）；
- `health.get` 在数据库与 Branch 健康之外返回进程级 `process.degraded` 与 `process.reason`；
- 两者都不含 `worldId`、`branchId`、`characterId`、Prompt 或正文。需要定位某个 Branch 时使用 `reaction.get` / `reaction.list` 与 `audit.list`。

`round.process` 与 `reaction.process` 现在都只推进一个量子，不再是排空命令；需要排空请反复调用或交给 Host 调度。

## 崩溃与 instance.lock

正常退出按固定五步关闭：停止接收新的调度提示；不再领取新量子或新 ProviderCall；在 `shutdownTimeoutMs` 预算内等待已冻结 Wave 收口和正在进行的短事务；释放 Writer Lease、Application 与 `instance.lock`；预算内没完成的工作留在耐久状态，由下次启动扫描恢复。超时只计入 `shutdown_timeouts`，不伪造 Cycle 终态，也不修改 Branch admission。硬终止会留下 lock；新实例只有同时确认旧 PID 已死亡且 World DB 无有效 Writer Lease时才回收。若 PID 仍活、权限不足、nonce 变化或 lease 未过期，必须等待或排查，禁止手工 force-steal。

若确认是陈旧锁但仍被拒绝：

1. 保留 `instance.lock` 和 World DB 副本；
2. 检查旧 PID 是否仍存在；
3. 查询 `writer_leases.expires_at_ms`，等待 TTL；
4. 再启动 host；
5. 仍失败时停止写入并按 integrity/quarantine 流程诊断，不直接改 SQL。

## Backup 与 Restore

V0 的部署级 Backup 复制一个一致的 World DB，不宣称跨多个 SQLite 文件原子。恢复时：

1. 离线或进入全局 maintenance，停止 host；
2. 验证 file hash、`quick_check`、application_id、World schema、Event Chain 与 Head；
3. restore 到全新目标路径，不覆盖现有库；
4. 清除 sender receipt/claim/attempt，但保留 `session_delivery_seq` 与 counter；
5. 重新投递 Outbox，由已有或全新 Session 以 deliveryId + sequence + payloadHash 幂等重建；
6. Memory 从 World 前缀按角色/Branch/as-of 重建；
7. 查询 Health、Outbox、Quarantine 后再开放写入。

Operational Audit sidecar 与原 Session/Memory 是否保留取决于部署恢复策略；它们不进入 World 权威 Hash。逻辑 `.dshworld` 只传输权威数据，不用于合并两个实例。

## Quarantine

遇到 `SESSION_DELIVERY_DIVERGED`、`BUNDLE_HASH_MISMATCH`、事件链、Projection 或 Memory 来源完整性错误时：

1. 不重试覆盖，不修改 Event；
2. 用 `quarantine.explain` 与 `health.get` 保存诊断；
3. 在 maintenance 中执行全链、Projection、Session/Memory 校验；
4. 仅在验证全部通过后调用 `quarantine.recover`；
5. 恢复失败保持 quarantined。

## 发布者待办

本机门槛通过后仍需：创建 GitHub 私有远程、推送候选 commit、实际运行 Windows/Ubuntu × Node 22.19/24 四格 CI、保存 run URL/commit SHA，最后再创建 `v0.1.0` Tag。Tag 必须指向四格 CI 全绿的同一 commit。
