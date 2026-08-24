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

兼容入口 `worldhost <world.sqlite> <session.sqlite>` 仍保留。环境变量为 `HCW_CONFIG_PATH`、`HCW_DATA_DIR`、`HCW_WORLD_PATH`、`HCW_SESSION_PATH`、`HCW_MEMORY_PATH`、`HCW_LEASE_TTL_MS`。示例见 [`config/world-host.example.yml`](../config/world-host.example.yml)。Secret 不属于该配置，不得写入 YAML、Backup 或 Export。

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
| `presentation.ready` | `session.render` |
| `health.changed` | `health.get` |
| `outbox.dead-lettered` | `outbox.list` |
| `branch.quarantined` | `quarantine.explain` |

`worldhost` 不打开 TCP、Pipe、Socket 或浏览器端口。

## 崩溃与 instance.lock

正常退出会先关闭 Round worker、Application 和 Writer Lease，再删除 `instance.lock`。硬终止会留下 lock；新实例只有同时确认旧 PID 已死亡且 World DB 无有效 Writer Lease时才回收。若 PID 仍活、权限不足、nonce 变化或 lease 未过期，必须等待或排查，禁止手工 force-steal。

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
