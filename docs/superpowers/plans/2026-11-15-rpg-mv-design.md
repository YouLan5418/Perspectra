# 官方 RPG：MV 启发式战斗改造

## 本批结果与隔离

例如“破甲击”先降低目标防御，再结算同次伤害；火球直接火伤后附加燃烧；护盾吸收伤害；净化移除负面状态再给予正面攻击加成。技能名不触发代码分支，都是有界效果列表。玩家、同伴、敌人走同一活动解释器及已有核心提交。全屏和通用卡片只是同一授权视图的展示。

基线为完整护盾工作树本地快照 `a2afeaf921fd61d00c6c715b93bcd4dba9e827c5`，本地引用 `refs/codex-local/rpg-effects-mv-baseline`。采用替代索引，包含原全部跟踪和新增文件，不含 ignored 产物或凭据。本批在 `/workspace/Perspectra-rpg-mv`、`codex/rpg-mv-design`，差异未提交。原 B10、全屏和护盾三个工作树的 HEAD、索引、status、完整二进制差异指纹都保持一致，证据 `.tmp/rpg-mv/preserved-worktrees.json`。未推送、PR、合并、发布或进入 B11。

## MV 来源、借用与不借用

实际读取官方 MIT 仓库 [rpgtkoolmv/corescript](https://github.com/rpgtkoolmv/corescript)，锁定 commit `182e31449707ba7e406db0485c44c2a9d11e2dcd`。参考目录在本任务 `/tmp/perspectra-mv-reference`，没有加入产品依赖。

| 读取的固定版本源码 | 借用设计 | 本地改造 |
| --- | --- | --- |
| [Game_Action.js](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_objects/Game_Action.js) 的 apply/applyItemEffect/makeDamageValue/evalDamageFormula | 一次行动、依次多个效果、集中伤害步骤 | 强类型 damage/heal/status/shield/cleanse；拒绝 eval、命中/暴击/浮动/反射/反击 |
| [Game_BattlerBase.js](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_objects/Game_BattlerBase.js) 的 param/resetStateCounts/updateStateTurns | 属性修正集中、状态次数与定义分开 | 基础＋装备＋平坦状态修正、有限夹取；确定时长，不用 Math.randomInt |
| [Game_Battler.js](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_objects/Game_Battler.js) 的 addState/removeStatesAuto/onAllActionsEnd/onTurnEnd/onBattleEnd | 重施刷新、明确移除时机、出场清理 | after-action 保留燃烧手感，round-end 显式选择，净化立即移除负面状态 |
| [BattleManager.js](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_managers/BattleManager.js) 的 startAction/endAction/endTurn/invokeAction | 行动费用与目标效果循环分开、轮末阶段 | 复用当前活动与核心权威提交，没有第二份全局对象或存档 |

这是**设计参考后的本地实现**，没有逐段复制或改写 MV 实质函数，没有安装 MV 运行时；未使用 MZ、本体、素材、第三方插件或 MV 工程导入。保留官方 [MIT 许可及版权声明](../../legal/rpg-maker-mv-MIT.txt)作为来源记录；若以后实际移植实质代码，仍须随代码保留该声明。

## 格式、算法与迁移

唯一技能格式为 id/name/target/scope/cost/effects。target 按施法者相对关系为 ally、opponent、self；效果最多 8 项。验证授权候选、目标、技能和资源后费用扣一次，再按列表顺序逐目标执行；状态立即影响后续效果。敌人配置带费用技能会被拒绝，不默默忽略费用。

状态定义须有 name/turns/timing/polarity，可有 tick、modifiers 或两者。最多 32 个状态，持续 1–99 次；修正仅 attack/defense/fireResistance，各 -1000…1000；周期数值 1…9999。基础、当前有效装备和状态修正汇入同一函数，攻防夹取 0…9999，火抗 0…75。同 ID 刷新、不叠层；不同 ID 修正相加。没有新脚本 DSL、全局命名变量或核心事件总线。

伤害顺序：基础威力＋修正后的攻击−修正后的防御 → 火抗向下取整 → 一次性防御减半向上取整 → 护盾 → HP。DoT 只过火抗和护盾，不吃基础攻防或一次性防御。盾仍是单个、重施替换、耗尽破碎、有效行动后到期；自施当次免扣护盾次数。净化只移除 negative，不移除 positive 或护盾。纯净化无负面状态时仍可有效施放并支付费用，未虚称其为非法。

after-action 在持有者有效行动结束时 tick 并扣次数；燃烧保持此默认示例。round-end 在出手序列循环完成、下一轮开始前处理，单位及状态顺序固定；同一单位阶段末清除归零状态。不是同时伤害的数学模型。拒绝、发言、读文本、换视图不扣时长。死亡清理该单位、胜败/撤退清空；离场单位在下一次有效规则快照清理。敌方随机目标使用宿主 `roll` 记录的骰子，正式重生成回放保持结果；没有新 RNG、Math.random 或修订号伪随机。

**破坏性变更：**删除技能顶层 kind/power/element/inflicts，删除状态旧 damage/element 和绝对 target party/enemy，持久数据版本为 2、仅支持 `[2]`，无旧配置/存档兼容。现有官方 hill-ruins、rpg 测试包、此前效果片段、实例夹具、Schema、Lens、当前作者文档已同步。独立旧脚本原型及历史研究文档不算新官方格式，未强行改造它们。详细操作见[作者指南](../../current/guides/rpg.md#破坏性迁移本批不兼容旧版)。

## 验证记录

Node 24.19.0，pnpm 11.7.0；离线 frozen lockfile 安装。默认 Corepack 缓存路径不可用，命令统一使用 `COREPACK_HOME=/tmp/perspectra-corepack`。以下 pnpm 均指 `corepack pnpm@11.7.0`。

| 范围 | 实际结果 |
| --- | --- |
| 施工前 RPG＋护盾 Host 基线 | 6 文件 42 项通过，8.73 秒 |
| RPG/持久与分享/地图/Host/前端/SDK 主回归 | 23 文件 229 项通过，58.65 秒 |
| Lens/B9 展示与正式玩法/组合/独立原型通用回归 | 7 文件 72 项通过，61.88 秒 |
| 最终 Schema/效果边界/正式新 Host 场景复验 | 3 文件 16 项通过，12.47 秒 |
| 正式 CLI 无头实验 | 8 步全部 passed；断言破甲、火伤、燃烧、护盾、净化、攻击加成、胜利及房外隔离 |
| 新 Host 测试 | 两次完整场景真实提交的 game 状态逐项一致；错误目标和旧候选不提交、不耗资源/时长；多人 NPC 火球与敌人随机目标实际执行并重生成一致 |
| Schema/解析器 | 同时接受新例子，同时拒绝旧字段、治疗元素、HP费用、越界持续次数/修正；不是只测桩 |
| 类型、Lint、格式、边界、构建 | typecheck、lint、变更 TS 格式检查、desktop:build 均退出 0；生产边界 438 文件通过；Lint 保留既有 warnings |

主回归命令：

```sh
pnpm test:related packages/plugins/src/rpg tests/host/rpg-mv.test.ts tests/host/rpg-effects.test.ts tests/host/rpg-perform-path.test.ts tests/host/rpg-pack.test.ts tests/host/rpg-story-share.test.ts tests/host/rpg-map-activity.test.ts tests/host/rpg-battle-stage.test.ts tests/host/lens-rpg.test.ts tests/host/frontend-api.test.ts tests/host/frontend-reading.test.ts packages/sdk --maxWorkers=1 --reporter=verbose
pnpm test:related tests/host/lens-simulation.test.ts tests/host/lens-cli.test.ts tests/host/official-gameplay-path.test.ts tests/host/pack-composition.test.ts tests/host/gameplay-presentation.test.ts tests/scenarios/rpg-core-activity.test.ts tests/scenarios/rpg-turn-battle.test.ts --maxWorkers=1 --reporter=verbose
pnpm test:related packages/plugins/src/rpg/config-schema.test.ts packages/plugins/src/rpg/combat-effects.test.ts tests/host/rpg-mv.test.ts --maxWorkers=1
pnpm exec tsx tests/experiments/rpg-mv-simulate.ts
```

最初迁移复验有 5 项旧格式/旧目标断言失败，逐项迁移后主回归全过；类型检查随后指出必填效果列表仍带 undefined 和测试数组可选项，已收窄。没有将这些中间失败计为通过。

实际 Chromium 在正式 Host/iframe/SSE/FrontendActions/SQLite 上施放四步连招：破甲后敌人 46 HP，火球与 DoT 后 31 HP，炽热护盾后玩家 34 HP/盾10，净化后负面状态移除、振奋剩1轮。通用卡片和全屏来回切换状态一致；375×812 布局没有横向溢出。记录 `.tmp/rpg-mv/browser-results.json`，截图 battle-desktop.png/battle-mobile.png；本次只做单玩家浏览器，多人仅验证无头正式路径，不修复前批多人浏览器租约冲突。

独立 GPT-6.1 Sol `rpg_mv_review` 只读检查配置、Schema、效果解释器、授权和来源。发现 P2：Schema 接受治疗元素/HP成本、运行时拒绝；已同步并加共同测试。复核关闭，独立运行 Schema/效果/投影 3 文件16项通过；无剩余确定问题。审查者没有独立跑浏览器，范围不扩张。

未使用计费模型或凭据；未跑全仓 check、原生 Windows/Tauri 或发行验收。文档链接检查仍报告 104 条既有断链及 103 个历史本地资源缺失；本批新增文档无断链。不修无关旧失败。

## 试玩、阅读与交付

[实验 README](../../../examples/rpg-mv/README.md)给出配置、四步试玩和两条命令。阅读路线：effects.json → config.ts/Schema → combat-effects.ts 的 combatAttributes/damageAfterMitigation → battle.ts 的 applySkill/settleConditions/endTurn/advance → 既有正式活动/核心提交 → battle-view.ts → 默认全屏及通用卡片 → tests/host/rpg-mv.test.ts 的提交、隔离与重放断言。

本批独立差异 `.tmp/rpg-mv/feature.patch`，基于 a2afeaf9，不把之前三批拼进去。交付包在 `.tmp/rpg-mv/deliverables/`，包含补丁、作者说明、配置、完整剧本、测试摘要、来源和 MIT 声明。Library 上传是否成功以最终工具回执为准，不将任务路径冒充可下载附件。
