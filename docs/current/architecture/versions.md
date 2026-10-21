# 当前协议与存储版本

核对日期：2026-10-21。

先看一个例子：作者用 `worldpack-source/v5` 写好世界包，宿主编译出 Manifest v10，玩家开局后世界库升到 user_version 20、记忆库升到 8。之后玩家每说一句话，RoundCoordinator 就提交一份 Round Authority v6。这些版本号各管一件事，互不推导；下表把它们放在一处，并写明遇到别的值时会怎样。

“旧值处理”说的是当前代码的行为。旧存档不再维护：曾运行过已退役 NPC Reaction Cycle 的存档，完整性检查会失败。

## 1. 世界包与 Manifest

| 版本轴 | 当前值 | 定义位置 | 旧值处理 |
| --- | --- | --- | --- |
| 世界包源格式 | `worldpack-source/v5` | [world-pack contracts](../../../packages/world-pack/src/contracts.ts) | 其他版本直接拒绝，不上转 |
| Manifest | `schemaVersion: 10` | [world-spec.ts](../../../packages/kernel/src/world-spec.ts) | 读取已存 Manifest 时只接受 10 |
| Manifest 内容包 | `contentPack.schemaVersion: 2` | 同上 | 只接受 2 |
| 运行时能力 | `publicSpeechObservationVersion 1`、`cognitionProjectionVersion 1`、`sceneDecisionVersion 2`、`cognitiveMemoryVersion 2`、`agentContextVersion 2` | 同上 | 必须恰好等于这些值，否则拒绝 |
| 核心规则 | `builtin:speak-move` v2 | [rulebook-registry.ts](../../../packages/kernel/src/rulebook-registry.ts) | 注册表只有 v2；世界包声明别的版本会在激活时找不到规则 |
| 交互目录 | `interaction-catalog/v3` | [interaction-definition.ts](../../../packages/contracts/src/interaction-definition.ts) | 只接受 v3 |
| 反应策略 | `reaction-policy/v1` | [reaction-policy.ts](../../../packages/contracts/src/reaction-policy.ts) | 只作为已哈希的 Manifest 数据保留，运行时不读取 |

## 2. 提交与运行时记录

| 版本轴 | 当前值 | 定义位置 | 说明 |
| --- | --- | --- | --- |
| 玩家回合 Authority | `schemaVersion: 6` | [round-coordinator.ts](../../../packages/application/src/round-coordinator.ts) | 与回合事件同一事务提交，哈希进 bundle |
| NPC 行动 Authority | 无版本号 | [character-turn.ts](../../../packages/application/src/character-turn.ts) | 记录行动者、行动、裁定状态与 resolutionAuthority |
| 场景决策 | `scene-decision/v2` | [scene-decision.ts](../../../packages/application/src/scene-decision.ts) | 运行时计算，不持久化 |
| 角色预设库 | `PRESET_SCHEMA_VERSION 1` | [preset-library.ts](../../../packages/provider-chat/src/preset-library.ts) | Launcher 保存的预设文件 |

## 3. SQLite 数据库

每个库用 `application_id` 区分，`user_version` 记录已执行到哪一步迁移。迁移只向前：打开较旧的文件会依次补齐，打开比代码更新的文件会直接报错。

| 数据库 | 当前 user_version | 迁移定义 |
| --- | --- | --- |
| world.sqlite | 20 | [world-schema.ts](../../../packages/store-sqlite/src/world-schema.ts)；v20 删除已退役的 Reaction Cycle 表 |
| memory.sqlite | 8 | [memory-schema.ts](../../../packages/memory/src/memory-schema.ts) |
| context.sqlite | 7 | [context-database.ts](../../../packages/agents/src/context-database.ts) |
| session.sqlite | 2 | [session-delivery.ts](../../../packages/store-sqlite/src/session-delivery.ts) |
| 运维审计库 | 2 | [operational-audit.ts](../../../packages/store-sqlite/src/operational-audit.ts) |
| 投影库、快照库 | 1 | [sqlite.ts](../../../packages/store-sqlite/src/sqlite.ts) 的 `openOwnedDatabase` |

## 4. 改版本时

- 改 Manifest 字段、运行时能力或交互目录：会改变 Manifest 哈希，已编译的世界包需要重新编译。
- 给 SQLite 加迁移：在对应迁移列表末尾追加一步，并更新这张表。不要改写已有的迁移 SQL，已有文件不会重新执行它。
- 版本号只为读旧数据而保留时，在定义处注明，并写进上面的“旧值处理”列。
