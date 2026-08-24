# ADR-0053：私有源码 V0 的本机发布边界

- 状态：Accepted
- 日期：2026-08-24
- Extends：ADR-0037、ADR-0038、ADR-0041、ADR-0043、ADR-0052

## 背景

V0 已完成从确定性内核、耐久存储到本机 Headless 的组合闭环。发布收口仍需明确源码形态、版本、协议边界、可选集成、进程所有权、通知语义、Outbox 重试和外部发布证据，避免把“本机测试通过”误写成“跨平台制品已发布”。

## 决定

1. V0 版本统一为 `0.1.0`，所有 workspace 包继续 `private: true`。不发布 npm 包，不自动创建远程、Tag 或 Release。
2. 宿主只提供 newline-delimited JSON-RPC 2.0 stdio。V0 不监听 TCP、Unix Socket、Named Pipe 或其他远程端点。
3. Harness Bridge 与 TencentDB Memory 保持默认禁用。无模型、Local Memory、Noop/Rule/Scripted Provider 是完整可运行路径。
4. 本机协议冻结 `world/branch/round/character/maintenance/snapshot/outbox/quarantine/backup/restore/import/export/health` 方法面。通知只有 `round.committed`、`presentation.ready`、`health.changed`、`outbox.dead-lettered`、`branch.quarantined` 五类；通知可丢失且不得改变权威操作结果，每类均有查询恢复入口。
5. `worldhost` 配置优先级固定为 CLI > 环境变量 > `world-host.yml` > 默认值。数据目录包含 `data/`、`backups/`、`exports/`、`logs/`、`config/` 与原子创建的 `instance.lock`。
6. `instance.lock` 的诊断 owner 前缀进入 `WorldApplication` writer owner。陈旧锁只有在原 PID 已死亡且 World DB 不存在有效 Writer Lease 时才可回收；nonce 分歧或检测不确定均 fail-closed。数据库 fencing 仍是写入权威屏障。
7. Session Outbox 使用耐久 `next_attempt_at_ms`，按 1、2、4、8、16、30 秒退避并保持 30 秒上限；默认 12 次、最长 10 分钟。完整性错误立即 quarantine，不进入普通重试。
8. 继续采用 ADR-0038 的恢复模型：Backup 是 World DB 的 SQLite 一致副本；Session 由保留的 deliveryId、序号和 payloadHash 幂等重建，Memory 是可重建派生库，Operational Audit 单独保留。不得宣称多个 SQLite 文件形成原子快照。
9. 本地 `pnpm check` 通过只代表本机候选门槛。GitHub Windows/Ubuntu × Node 22.19/24 四格 CI、clean install、远程和 `v0.1.0` Tag 必须有实际外部证据后才能宣称发布完成。

## 后果

- 私有源码可以在单机、无网络、无模型依赖下复现完整路径。
- stdout 上的通知与响应保持有序；订阅者失败不会反向污染世界事实。
- host 崩溃不会允许仍有有效 writer lease 的第二实例抢占。
- 0.1.0 是源码兼容标识，不是公开包稳定性承诺。

## 验证

- 生产文件逐文件 statements/branches/functions/lines 100%。
- 真实子进程验证 stdio 入口、输出断管、信号关闭、启动恢复和 `instance.lock` 硬终止恢复。
- Outbox 测试验证完整退避序列、maxAttempts、maxAge、人工重投归零、restore 归零和并发 claim CAS。
- 最终证据与未闭合外部门槛记录在 V0 Release Closure 报告中。
