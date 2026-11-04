# 核心迁移 M0／M1

日期：2026-11-04。M0 基线 `40666bfa`，对应[迁移计划](../../superpowers/plans/2026-11-04-core-mechanisms-migration.md)。本轮范围仅基线、知识机制和最小启动探针，不实施 M2～M7，也不解除两项暂缓需求。

## M0 基线

冻结运行时代码，使用 plugin-seams-baseline 的 record 模式，对 12 组场景分别运行两次，请求、转录及行动结果一致。另运行 status-market-items、pack-status-activity、cross-scene-communication、dual-plugins，4 个文件 27 项通过；它们检验脚本市场、活动状态联动、远程权限和原生能力的结果不变量，不冒充四套完整请求快照。基线和日志在 `.tmp/migration-m01/`，均为本轮新目录。

## 知识机制契约（M1 实施目标）

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

待实施后填写。M0 提交时未改运行时、未宣称 M1 完成；未运行真实模型与完整发行验证。
