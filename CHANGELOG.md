# Changelog

## 0.2.0 - Unreleased

Phase 7 私有源码候选：最小通用内容闭环。

### 新增

- `worldpack-source/v1` 严格来源目录、确定性 Compiler、不可变 `worldpack/v1` envelope 与内容来源 Hash。
- 通用实体、角色初始 Observation/Claim/Goal、秘密受众展开以及 Genesis/Memory 正式接入。
- 不依赖调查规则的酒馆社交参考 Pack，覆盖私密认知、错误认知、传闻、Scene 离场、重启和 fork 隔离。
- `worldpack init/validate/compile/inspect/test/activate` 本机创作者工作流。
- `worldappctl chat --data-dir <dir>` 持久连续交互入口，普通文本和 Core `move/take` 仍经过正式权威管线。
- Pack Manifest 显式运行能力、深度存量校验，以及统一的创作者 CLI `ErrorEnvelope`。

### 兼容与边界

- `v0.1.0` Tag、既有 Manifest/Event/Authority/Golden 和悬疑 v3/v4 语义保持不变。
- World Pack Compiler 实现版本仍为 `0.1.0`；它与项目 `0.2.0`、Pack 作者版本及 Schema 版本相互独立。
- `worldpack-source/v1` 与 `worldpack/v1` 的必填字段在本候选中收口；Tag 后新增必填字段必须升级格式版本。
- Phase 7 不包含 Scene v2、动态 Affect/InnerTension、创作者插件、Agent 接管玩家或真实 Harness Provider。
- 当前只形成本地候选；GitHub 四格 CI 与 `v0.2.0` Tag 必须在推送后另行完成。

## 0.1.0 - 2026-08-24

首个私有源码 V0 基线版本。

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

### 发布证据

- 私有 GitHub 远程已建立。
- Windows/Ubuntu × Node 22.19/24 clean install 与完整 `pnpm check` 全部通过。
- annotated Tag `v0.1.0` 已推送并固定最终全绿提交；未创建 GitHub Release 或发布 npm。
