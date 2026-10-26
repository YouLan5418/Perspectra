# RPG Core：可复用战斗规则的作者端生成

> **同日方向调整：** 用户提出优先复用 RPG Maker，暂停继续扩展本页的自研战斗算法。这里保留已完成实验及证据；新方向与未接通的事实／存档边界见 [RPG Maker 双端桥接骨架](../../../examples/rpg-maker/README.md)。新骨架尚无真实 MZ 工程验收，不能把本页测试移作 RPG Maker 兼容性证据。

> **同日第二次调整：已删除运行时 `ctx.gameplay` 生成器。** 本实验最初让 Cordis 宿主插件 `rpg-core` 通过 `ctx.gameplay.registerActivity` 注册活动规则生成器，包用 `activities.json` 按 provider / version 引用。这样规则代码会从包里移到玩家安装的插件，与“包内插件写规则、Cordis 插件提供宿主能力”的[双入口分工](../guides/dual-plugin-entrypoints.md)重叠，还多出“没装对插件就打不开世界”的故障。现在 RPG Core 是作者端工具：生成器在创作时输出普通活动脚本，随包发布。宿主不再有 `gameplay` 服务、`activities.json` 或 `pack-plugin-activities.ts`；下文旧接线只作历史说明。

2026-10-26，实验分支 `codex/rpg-core-plugin-prototype`。玩家与澄迎战守卫、浮游机：澄通过角色行动入口选择技能，敌人由规则推进，双方的伤害与中毒都由同一活动规则结算。只有玩家和澄注册为角色；两只敌人是包内配置的战斗单位。

本实验不表示已经实现 RPG Maker 的地图、数据库编辑器、完整装备成长系统或通用玩法 SDK。原先[包内脚本实验](2026-10-26_gameplay-rpg-report.md)保留作对照。

## 解决的问题与最小选择

以前每个包都要手写完整战斗脚本。现在共享算法放在 [examples/rpg-core](../../../examples/rpg-core/battle-runtime.js)，作者只维护战斗数据：

```text
作者编辑 battle.config.json
  → node examples/rpg-core/generate.mjs 校验数据并输出 scripts/activities/battle.js
  → 包登记该脚本为普通资产，编译锁记录其内容摘要
  → 玩家或角色提出活动操作
  → 既有规则裁定、活动与状态原子提交
  → 授权角色观察、玩家投影与通用活动卡片
```

它替代每包重复手写的战斗脚本，不另建战斗数据库、提交路径、模型协议或宿主服务。生成器按原始字节读取规则文件再附上配置调用，不依赖 `Function#toString`；测试里 vitest 转译模块时曾让后者的输出发生变化。

## 代码路径

| 位置 | 职责与边界 |
| --- | --- |
| [activity.mjs](../../../examples/rpg-core/activity.mjs) | 作者端数据校验；不合法时报 `RPG_CONFIG_INVALID`，不写出脚本 |
| [battle-runtime.js](../../../examples/rpg-core/battle-runtime.js) | 共享战斗算法，逐字复制进生成的脚本；宿主没有硬编码 RPG 公式 |
| [generate.mjs](../../../examples/rpg-core/generate.mjs) | 命令行入口，以及测试使用的 `renderActivityFile(config, from)` |
| [rpg-core-demo](../../../examples/world-packs/rpg-core-demo/README.md) | 战斗资料与生成后的 `scripts/activities/battle.js`；只走原有包内活动路径 |

生成脚本仍受原有活动环境约束：最多 64 KiB，每次 hook 100ms，有限 JSON，状态形状和结果检查。

## 本例的玩法能力

- 两个真实角色与两个纯规则敌人，按速度排定先后手。`game.turn` 始终是实际角色 ID；下一次真实角色行动前，规则会有界推进中间的敌方行动。
- 普攻、单体法术、群体伤害、中毒、治疗、防御、共享药水与撤退。一个“使用技能”操作接收技能与目标，测试覆盖 24 个技能，不为每个技能占一个活动操作槽位。
- HP / MP / 护卫 / 中毒 / 轮序只有活动内的一份权威状态；显示摘要从同次提交的单位数据生成。事件里的结构化 `results` 保存这次操作及随后的敌方行动和中毒结果，未来可供专用界面消费。
- 澄沿用现有角色模型决策和结果续写。自动化使用本地模拟服务，不能当作真实模型已经合理选择技能的证据。
- 击倒全部敌人获得 45 金币。胜败与金币沿同一事务提交，并明确告知玩家新余额；奖励有问题时，造成该次胜利的伤害与活动进度一起拒绝。

敌方行动是当前玩家或角色操作触发的连锁结果，记录在该次活动更新及 `results` 中，不生成独立的 Character Agent 行动。前端可以按战斗单位 ID 区分表现，但不能把它们当成宿主已注册角色。

完整规则、运行步骤和有意识接受的限制见[包说明](../../../examples/world-packs/rpg-core-demo/README.md)。当前不支持由纯规则单位开场抢先行动、跨战斗继承生命、动态增援、装备换装或随机命中；未实现专用战斗前端。

## Evidence → Finding → Path

| Evidence：复现入口 | Finding：本次结论 | Path：处理方式 |
| --- | --- | --- |
| [RPG 场景测试](../../../tests/scenarios/rpg-core-activity.test.ts)：群攻、中毒、胜败、奖励、重启 | 纯规则敌人不需要伪装成角色；可复用现有角色和事务链 | 战斗单位留在活动状态，只有真实队员获得模型处理机会 |
| 同文件：错误目标、未学技能、MP 不足、错误奖励 | 玩家菜单和实际执行需要分别检查；胜利不能先落伤害再单独发钱 | 正式提交前由现有活动与状态桥校验整组结果 |
| 同文件：发布脚本与资料一致、技能引用不存在 | 资料改了却忘记重新生成会让试玩与作者意图不符；坏数据不应产出脚本 | 测试比对生成结果；生成器先校验再写出 |

删除运行时生成器的同时，删除了它的注册与资产测试；原入口测试只保留 Cordis 能力插件的源码与打包入口用例，改名为 [capability-plugin-entry.test.ts](../../../tests/host/capability-plugin-entry.test.ts)。

## 校验与验收边界

```powershell
corepack pnpm@11.7.0 worldpack validate examples/world-packs/rpg-core-demo
corepack pnpm@11.7.0 test:related tests/scenarios/rpg-core-activity.test.ts
```

调整后运行了类型检查、全仓 Lint、宿主边界检查、包校验，以及 11 个相关测试文件共 78 项（RPG Core 场景、包内回合战斗、双插件场景、能力目录、RPG Maker 桥接、能力插件入口、活动与状态组合、声音插件和入口布局）。未运行完整 `check`。所有角色测试使用本地模拟服务、原生记忆和新建临时目录。没有调用真实模型、验证浏览器可见体验或重建便携发行包。

## 仍未开放的入口

需要更复杂 RPG 时，后续应依据实际作品继续接动态目标查询、装备与世界物品映射、地图转换及专用表现数据。共享算法升级不会自动进入已发布的包；每个包带着生成时的规则，与自己的存档一致。若将来确有多个包需要在运行时共享同一份规则，再评估包侧的库机制，而不是恢复宿主插件生成代码。
