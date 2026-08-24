# Changelog

## 0.1.0 - 2026-08-24

首个私有源码 V0 候选版本。

### 核心能力

- TURN_DRIVEN 事件溯源 World、耐久 Round Inbox、单 writer fencing、fork/as-of 重建与 quarantine 恢复。
- Cordis Branch Runtime 隔离，WorldApplication 组合根，以及无模型 Agent/Director 闭环。
- 独立角色 CharacterView、Scene 决断、Local Cognitive Memory、Session FIFO/Outbox/Presentation。
- Core `speak/move/take` Rulebook Registry；悬疑调查规则只存在于 Demo 组合根。
- 异步 Round stdio JSON-RPC、耐久查询/取消/恢复、五类可丢失通知和连续本机 CLI。
- SQLite Backup、逻辑 Export/Import、Snapshot、Health、Audit、Metrics 与 18 项硬崩溃矩阵。

### Release Closure

- 所有私有 workspace 包统一为 `0.1.0`。
- 新增 CLI > env > YAML > defaults 配置、标准数据目录和与 Writer Lease 关联的 `instance.lock`。
- Outbox 重试改为耐久 1/2/4/8/16/30 秒退避，默认 12 次、最长 10 分钟；World schema 升至 v14。
- 新增 `world-json/v1` 跨平台精确 bytes/hash Golden Fixture。

### 明确禁用

- Harness Bridge、TencentDB Memory、远程监听与 npm 发布默认禁用。
- 不支持 Branch merge/rebase/cherry-pick、物理删除、REALTIME_DAEMON 或 FRACTAL 时间。

### 外部门槛

GitHub 远程、Windows/Ubuntu × Node 22.19/24 CI 实跑和 `v0.1.0` Tag 尚未创建；详见 Release Closure 报告。
