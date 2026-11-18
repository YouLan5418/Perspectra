# 当前协议与存储版本

2026-11-04 M2：允许显式空交互目录，不改变现有格式版本；锁、引用、绑定与闭合检查保留。WorldApplication 的省略安装列表改为空，入口须显式提供所选玩法，见[M2 记录](../studies/2026-11-core-migration-m2.md)。

核对日期：2026-10-21。2026-11-18 追加核对宿主插件 API；其余版本表未在本次重新核对。

宿主插件 API 当前为 `2.12`，新增[独立世界事件消费](world-events.md)。同主版本且要求次版本不高于宿主的插件可加载。版本判定定义在 [plugin-sdk/version](../../../packages/sdk/src/version.ts)，仍经[根入口](../../../packages/sdk/src/index.ts)导出。调度接缝新增自主与活动阶段，因此显式升级主版本；1.x 插件不执行，需适配并更新声明。此版本不改变世界包、数据库或角色输出协议。

先看一个例子：作者用 `worldpack-source/v5` 写好世界包，宿主编译出 Manifest v10，玩家开局后世界库升到 user_version 20、记忆库升到 8。之后玩家每说一句话，RoundCoordinator 就提交一份 Round Authority v6。这些版本号各管一件事，互不推导；下表把它们放在一处，并写明遇到别的值时会怎样。

“旧值处理”说的是当前代码的行为。旧存档不再维护：曾运行过已退役 NPC Reaction Cycle 的存档，完整性检查会失败。

## 1. 世界包与 Manifest

| 版本轴 | 当前值 | 定义位置 | 旧值处理 |
| --- | --- | --- | --- |
| 世界包源格式 | `worldpack-source/v5` | [world-pack contracts](../../../packages/world-pack/src/contracts.ts) | 其他版本直接拒绝，不上转 |
| Manifest | `schemaVersion: 10` | [world-spec.ts](../../../packages/core/src/kernel/world-spec.ts) | 读取已存 Manifest 时只接受 10 |
| Manifest 内容包 | `contentPack.schemaVersion: 2` | 同上 | 只接受 2 |
| 运行时能力 | `publicSpeechObservationVersion 1`、`cognitionProjectionVersion 1`、`sceneDecisionVersion 2`、`cognitiveMemoryVersion 2`、`agentContextVersion 2` | 同上 | 必须恰好等于这些值，否则拒绝 |
| 核心规则 | `builtin:speak-move` v2 | [rulebook-registry.ts](../../../packages/core/src/kernel/rulebook-registry.ts) | 注册表只有 v2；世界包声明别的版本会在激活时找不到规则 |
| 交互目录 | `interaction-catalog/v3` | [interaction-definition.ts](../../../packages/sdk/src/contracts/interaction-definition.ts) | 只接受 v3 |
| 反应策略 | `reaction-policy/v1` | [reaction-policy.ts](../../../packages/sdk/src/contracts/reaction-policy.ts) | 只作为已哈希的 Manifest 数据保留，运行时不读取 |

## 2. 提交与运行时记录

| 版本轴 | 当前值 | 定义位置 | 说明 |
| --- | --- | --- | --- |
| 玩家回合 Authority | `schemaVersion: 6` | [round-coordinator.ts](../../../packages/core/src/application/round-coordinator.ts) | 与回合事件同一事务提交，哈希进 bundle |
| NPC 行动 Authority | 无版本号 | [character-turn.ts](../../../packages/core/src/application/character-turn.ts) | 记录行动者、行动、裁定状态与 resolutionAuthority |
| 场景决策 | `scene-decision/v2` | [scene-decision.ts](../../../packages/core/src/application/scene-decision.ts) | 运行时计算，不持久化 |
| 角色预设库 | `PRESET_SCHEMA_VERSION 1` | [preset-library.ts](../../../packages/providers/src/chat/preset-library.ts) | Launcher 保存的预设文件 |

## 3. SQLite 数据库

每个库用 `application_id` 区分，`user_version` 记录已执行到哪一步迁移。迁移只向前：打开较旧的文件会依次补齐，打开比代码更新的文件会直接报错。

| 数据库 | 当前 user_version | 迁移定义 |
| --- | --- | --- |
| world.sqlite | 20 | [world-schema.ts](../../../packages/core/src/store/world-schema.ts)；v20 删除已退役的 Reaction Cycle 表 |
| memory.sqlite | 8 | [memory-schema.ts](../../../packages/core/src/memory/memory-schema.ts) |
| context.sqlite | 7 | [context-database.ts](../../../packages/core/src/agents/context-database.ts) |
| session.sqlite | 2 | [session-delivery.ts](../../../packages/core/src/store/session-delivery.ts) |
| 运维审计库 | 2 | [operational-audit.ts](../../../packages/core/src/store/operational-audit.ts) |
| 投影库、快照库 | 1 | [sqlite.ts](../../../packages/core/src/store/sqlite.ts) 的 `openOwnedDatabase` |

## 4. 改版本时

- 改 Manifest 字段、运行时能力或交互目录：会改变 Manifest 哈希，已编译的世界包需要重新编译。
- 给 SQLite 加迁移：在对应迁移列表末尾追加一步，并更新这张表。不要改写已有的迁移 SQL，已有文件不会重新执行它。
- 版本号只为读旧数据而保留时，在定义处注明，并写进上面的“旧值处理”列。

## 世界包牵手迁移（2026-11-17）

13 个原先绑定内置牵手的 v5 示例包已提升包主版本并携带自己的 `scripts/gameplay.cjs`。宿主删除 `package:interactions-basic`，核心删除牵手专用关系事件与状态；使用这些定义的旧世界包或存档不能直接继续使用。新内容使用 `contact:*` 操作和包内状态，新实验创建新数据目录，历史试玩目录不修改。本次未添加历史迁移或兼容路径，未重建 portable 发行包。
