# RPG Core 实验包

你与法师澄迎战遗迹守卫和浮游机。玩家和澄是两个真实角色；两只敌人只存在于战斗数据中，不注册角色、不调用模型、不占角色处理机会。

本例验证一套可复用的战斗规则怎样以作者工具的形式分发：作者写战斗数据，[生成器](../../rpg-core/generate.mjs)把数据和共享规则合成一份普通活动脚本，随包发布。宿主不需要安装任何插件，也不知道 RPG Core 的存在。这还不是 RPG Maker 功能或完整创作工具。自动化验证范围见[实验记录](../../../docs/current/studies/2026-10-26_cordis-rpg-core-prototype.md)；没有进行真实模型或浏览器可见体验验收，也未重建发行包。

## 启动

在当前源码 Launcher 中导入本包目录，使用新游戏实例启动，模型连接沿用已有配置。点击“进入遗迹迎战”，在活动卡片选择“使用技能”、技能名称和目标；澄通过正常角色决策入口选择自己的行动。

只从源码命令行启动网页：

```powershell
corepack pnpm@11.7.0 experience:web --memory-native --pack examples/world-packs/rpg-core-demo --data-dir .tmp/rpg-core-demo-manual-20261026
```

重新试玩请使用新的数据目录。

## 修改玩法

[battle.config.json](battle.config.json)是战斗资料，[scripts/activities/battle.js](scripts/activities/battle.js)是由它生成的活动 `battle`，已登记在 `assetFiles`。修改资料后重新生成，不要手改生成的脚本：

```powershell
node examples/rpg-core/generate.mjs examples/world-packs/rpg-core-demo/battle.config.json examples/world-packs/rpg-core-demo/scripts/activities/battle.js
corepack pnpm@11.7.0 worldpack validate examples/world-packs/rpg-core-demo
```

生成器先校验数据，单位、技能或奖励不合法时报 `RPG_CONFIG_INVALID`，不会写出脚本。`battle.config.json` 只供作者使用，不在资产锁里，运行时不会读取它。

| 数据 | 本例 |
| --- | --- |
| 队伍 | 冒险者 40 HP / 8 MP；澄 30 HP / 12 MP |
| 敌群 | 守卫 50 HP、浮游机 24 HP；没有角色 ID |
| 技能 | 普通攻击、火球、群体毒雾、治疗 |
| 伤害 | 技能威力 + 攻击 - 防御，最低 1；防御使下一次受击伤害减半 |
| 持续状态 | 毒雾使存活目标中毒，每轮结束受 4 点伤害，持续 2 轮 |
| 先后手 | 速度排序；本例为玩家 → 澄 → 守卫 → 浮游机 |
| 敌方策略 | 按确定性规则选择可用攻击技能，优先攻击生命最低的队员 |
| 资源与结果 | 2 瓶共享药水；胜利获得 45 金币；全灭、撤退无奖励 |

增加技能时修改 `skills`，再把技能 ID 加入相应单位的 `skills`。最多 64 个技能共用一个“使用技能”操作，实际使用时检查角色是否学会、目标是否合法和 MP 是否充足。技能名称和单位名称在本例中必须唯一，表单用名字选择，结算与结果使用稳定 ID。

活动中保存单位生命、魔力、护卫、中毒与轮序；这是唯一一份战斗状态。`队伍`、`敌群`等文字是从同次提交的单位状态生成的显示摘要。金币和遭遇结果由 [status.js](scripts/status.js) 声明，胜败与金币在同一事务提交。没有新增战斗数据库。

共享算法在 [battle-runtime.js](../../rpg-core/battle-runtime.js)，数据校验在 [activity.mjs](../../rpg-core/activity.mjs)。生成器按原始字节复制规则文件，再附上配置调用，所以同一份资料无论在哪里生成，结果都相同。改了共享算法后，每个使用它的包都要重新生成；生成的脚本是普通包资产，仍走原有活动执行环境（每次 hook 100ms、有限 JSON、状态与结果检查）。

## 有意识接受的限制

- 当前是一场不可重复领奖的遭遇，没有跨战斗继承 HP、装备换装、升级、地图事件或独立编辑器。
- 所有战斗单位数值和技能资料都对参与者可见；没有隐藏敌方属性玩法。内部策略标记不进入玩家或角色活动视图。
- 规则最多 16 个单位，角色绑定最多为玩家加 8 名 NPC。初始最快单位必须绑定真实角色；尚不支持开场由纯规则单位抢先行动。
- 只有澄走角色模型决策。她可以沉默或只说话，轮次会保留；玩家可重试或逃生。测试用的是本地模拟服务，真实战术与叙事一致性待验。
- 当前规则完全确定性，没有命中、暴击和随机掉落；没有把新的随机路径混入宿主的重新生成机制。
- 技能表单列出本场全部技能和单位；不合法组合执行时拒绝，尚未做随技能变化的目标列表或技能专用界面。
- 共享算法升级不会自动同步到已发布的包；每个包带着生成时的那一版规则，存档与包一起保持一致。
- 默认舞台沿用通用活动卡片、显示摘要和战斗结果；没有专用血条或动画，本次未完成浏览器可见验收。

## 自动化复跑

```powershell
corepack pnpm@11.7.0 worldpack validate examples/world-packs/rpg-core-demo
corepack pnpm@11.7.0 test:related tests/scenarios/rpg-core-activity.test.ts
```

场景测试复制本包，按需修改资料并重新生成脚本，再用真实宿主和临时 SQLite 运行；角色决策由本地模拟服务提供。测试还核对随包发布的脚本与 `battle.config.json` 的生成结果一致，防止资料改了却忘记重新生成。
