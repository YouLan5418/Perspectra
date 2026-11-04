# 核心迁移 M0／M1

日期：2026-11-04。M0 基线 `40666bfa`，对应[迁移计划](../../superpowers/plans/2026-11-04-core-mechanisms-migration.md)。本轮范围仅基线、知识机制和最小启动探针，不实施 M2～M7，也不解除两项暂缓需求。

## M0 基线

冻结运行时代码，使用 plugin-seams-baseline 的 record 模式，对 12 组场景分别运行两次，请求、转录及行动结果一致。另运行 status-market-items、pack-status-activity、cross-scene-communication、dual-plugins，4 个文件 27 项通过；它们检验脚本市场、活动状态联动、远程权限和原生能力的结果不变量，不冒充四套完整请求快照。基线和日志在 `.tmp/migration-m01/`，均为本轮新目录。

## 知识机制契约（M1 已接通）

例如角色听到“黑海岸”，知识机制根据该角色有权获知的作者设定、关键词、状态条件和预算选择整条材料；留守角色不因此获得另一人的私有设定。

- 内部机制使用 Cordis `knowledge` 服务和每世界 Provider。只负责解析与选择，不裁定或提交事实。
- 宿主先验证 knowledge.json 的资产锁，再提供配置及必要的 documents／markdown 数据描述；不把 CompiledWorldPack、数据库或宿主对象交给机制。
- `select(context)` 使用宿主构造的授权上下文，保持公开／角色私有 audience、关键词、priority、when、整条预算和说明文案不变。条件不读取全局真值。
- knownStatusView 抽为共享纯数据转换，仅整理调用者已经持有的已知值，不负责授权、不查询数据库。
- 官方 knowledge context 步骤及替代步骤复用同一读取能力；替代知识服务失败时明确失败，不静默回退另一套选择逻辑。
- 每个世界／重生候选独立 open／close；知识本身不声明世界状态或额外文件，不需要新存档格式。
- 在知识机制内解析失败不提交世界事实；世界打开失败要释放已经打开的服务。预设、记忆和权限路径保持原有语义。

## M2 的准备边界

探针仅使用已有 WorldApplication、WorldBootstrap、WorldStore 和当前 Manifest／交互目录验证无模型启动。它不会跳过闭合检查、移除隐式默认值或升级格式。当前默认基础交互、网页装配与物品／状态提交的拆分留在 M2 及之后；发现不能启动时记录具体阻塞。

## M1 实际结果

知识选择从宿主 PackKnowledge 移至 [official-knowledge](../../../packages/official-knowledge/src/index.ts)，通过 Cordis `ctx.knowledge` 注册；宿主 API 增量升至 2.5，2.0～2.4 插件继续可加载。旧文件删除，不保留兼容包装或双实现。默认 Provider 由 official-bundle 装配，WorldGameplay 不再持有知识机制。

[knowledge-source](../../../desktop/host/knowledge-source.ts)保留资产锁及大小验证，只给所选知识 Provider 提供配置和内容描述；其他机制的通用 WorldServices 不自动获得作者原始材料。所选机制属于可信代码，仍需正确实施受众筛选，这不是沙箱。共享 [knownStatusView](../../../packages/contracts/src/known-status-view.ts) 仅转换已有数据，不增加读取权限。

[knowledge-seam](../../../tests/host/knowledge-seam.test.ts) 验证外部 `.mjs` 实际注册并被官方 context 步骤消费、打开失败不回退、选择异常归因和保留输入、候选实例独立关闭及公开 identity 改变后拒绝重生。既有知识场景继续验证关键词、受众、已知状态条件、优先级和预算；没有改变角色输出、事实提交或数据库格式。

### 最小核心探针结论

[探针](../../../tests/scenarios/minimal-core-probe.test.ts)的四项测试给出以下范围：

- 显式提供测试交互包及授权来源 SQLite 时，WorldApplication 可在无模型、无 Python 的情况下激活、读取角色授权视图、关闭并重开。这里仍包含测试交互包，不能称为无具体玩法的最小核心。
- 若 Manifest 选择未安装的交互，激活在写入 genesis 前拒绝；不提供冻结交互运行时的直接 Bootstrap 路径也会拒绝。
- 空 packages／definitions／bindings 目录可通过 activate 并写入 genesis，但挂载读取被 `interactionCatalog.packages is outside the frozen selection budget` 拒绝。这是现存激活与读取校验不一致，已记录为 M2 阻塞；测试是临时诊断，修复该问题时应改成期望的统一行为，不永久保留错误语义。
- 选择 agent-context 的 Manifest 仍要求 memoryPath。此处是授权来源存储，不等于依赖 Python Core。探针未绕过任一校验、移除默认装配或调整格式。

### 验证与限制

日志在 `.tmp/migration-m01/`，不是随仓库分发的资产：

| 检查 | 结果 |
| --- | --- |
| `plugin-seams-baseline.ts compare .tmp/migration-m01/baseline.json` | 12 组场景对比通过，涵盖请求、转录、行动结果；`baseline-compare.log` |
| `test:related`：minimal-core-probe、knowledge-seam、pack-story-slice、split-knowledge、decision-seam | 5 文件、29 项通过；`m1-final-tests.log` |
| `check --maxWorkers=2` | 宿主边界、类型、Lint、格式通过；183 文件，1743 项通过、4 失败、4 跳过；`check.log` |
| `launcher:check` | 类型检查及 98 项测试通过；`launcher.log` |
| `desktop:build` 后设置 `HCW_TEST_DESKTOP_BUNDLE=1` 运行 desktop-launch | 构建通过，普通、自主、活动三种子进程装载知识插件并关闭实例，3 项通过；`build.log`、`bundle.log` |
| `node scripts/docs/check-links.mjs` | 没有新增断链、模块地图覆盖新增包；仍有与迁移前相同的 103 条历史断链，另报告 59 个缺失历史实验产物；`docs.log` |

全仓仍有与迁移前相同的四项失败：story-nodes 缺本机记忆 Python 环境；launcher-core 的受信任授权仅支持 Windows；plugin-requirements 子进程先报 Core 初始化失败；entry-layout 超时。这四项在此前未改运行时的基线已复现，未为本轮跳过或放宽断言。全仓检查命令因此退出非零，不能称为全绿。

本轮没有真实模型试玩，没有发布或验收完整便携发行包；自动基线使用测试模型，不能证明真实体验无退化。M2 的核心执行／显式默认装配及 M3～M7 均未实施，两项暂缓需求继续暂停。
