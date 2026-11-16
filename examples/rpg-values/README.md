# 作者声明的战斗数值

复制 [effects.json](effects.json) 中 battleValues、combatStatuses 和 skills 到包的 rpg.json，并把需要的技能 ID 加入角色／敌人 skills。无需脚本或模型。此实验叠在上一批 MV 技能上，不改变山丘遗迹原包平衡。

```sh
# 仓库根目录，Node 24、pnpm 11.7.0；当前云容器加 COREPACK_HOME=/tmp/perspectra-corepack
corepack pnpm@11.7.0 exec tsx tests/experiments/rpg-values-preview.ts
corepack pnpm@11.7.0 exec tsx tests/experiments/rpg-values-simulate.ts
```

打开打印的 URL，使用两次“压制”攻击遗迹守卫。玩家每次真正掉血获得 3 怒气，第二次压制令敌人架势 4→2→0，获得破防。“怒击”此时可用，发动一次扣 5 怒气；敌人随后攻击又增加 3。继续命中零架势不会刷新破防。切回默认卡片可继续操作，再打开战斗视图，数值相同。“唤雨”把暴雨提高到 5，“雨中火球”会因雨量和目标耐火属性减伤。“隔热术”暂时提高单位耐火。

## 最小可复制配置

```json
{
  "battleValues": {
    "shared": { "rain": { "label": "暴雨", "initial": 2, "min": 0, "max": 5 } },
    "attributes": { "heat-resist": { "label": "耐火", "initial": 0, "min": 0, "max": 75 } },
    "resources": {
      "rage": { "label": "怒气", "initial": 0, "min": 0, "max": 10, "onHpLoss": 3 },
      "posture": { "label": "架势", "initial": 4, "min": 0, "max": 4, "onZeroStatus": "broken" }
    }
  }
}
```

`broken` 必须引用已声明状态，例如 `{ "name":"破防", "turns":3, "timing":"after-action", "polarity":"negative", "modifiers":{"defense":-3} }`。

- **shared**：整个活动共用一份，只能由 `value` 效果修改。
- **attributes**：每单位一个基础值，规则只读；状态的 `attributeModifiers` 按名称相加后夹取到声明边界。
- **resources**：每单位独立初值、边界和余额。用 `resourceCost:{"rage":5}` 付费。原 `cost` 仍指世界 RPG HP/MP 那组统计（HP 不可付费）；两者不是同一个命名空间。敌人可以支付战斗资源，但仍不能支付世界统计费用。
- 角色和敌人可在各自 `battleValues:{"attributes":{"heat-resist":25},"resources":{"rage":5}}` 覆盖初值，否则采用声明默认值。

有限读取引用：`{scope:"shared",key:"rain"}` 或 `{scope:"actor"|"target",kind:"attribute"|"resource",key:"..."}`。伤害和治疗的 `adjustments:[{value:引用,multiplier:-1}]` 最多 4 项，整数乘数 -10…10，结果夹取 1…9999；没有表达式字符串。周期效果的 actor 和 target 都指持有者，既有燃烧未配置此项，手感保持原样。

技能 `requires:[{value:引用,atLeast:1}]` 是合取前置条件，仅允许 shared 或 actor 引用，在任何消耗和效果前判定。效果 `{kind:"value",scope:"shared"|"actor"|"target",key:"...",delta:-2}` 只能改共享值或单位资源，不能写属性、世界地址或任意路径；超出运行时边界夹取。配置初值越界则拒绝加载。

伤害可声明 `resistance:"heat-resist"`，读取目标自定义属性作为百分比抗性，与火伤原火抗相加、总上限 75%。直接伤害先计算配置调整后的威力＋攻击−防御，再抗性、一次性防御、护盾、生命；DoT 不吃一次性防御和攻防。自定义属性不自动当火抗，必须在对应伤害／tick 显式引用。

## 结算与持久范围

先验证授权、目标、世界费用、战斗资源费用和条件，再扣每组费用一次，再按既有逐目标／逐效果顺序执行。全体技能的 actor/shared 写入按效果位置仅执行一次，target 写入每个目标一次；因此共享写入会影响该位置之后的结算，不是同时结算。目标被前置伤害击倒后，仍执行后续 actor/shared 写入，跳过依赖存活目标的效果。触发只有两种：

1. `onHpLoss`：每个直接或周期伤害实际扣生命且持有者仍存活后，资源增加声明量；护盾完全挡住、零损失或致死不触发。每个伤害效果独立计算，不按整段技能合并。
2. `onZeroStatus`：该资源从正数降到零时，施加一个状态；费用或 value 效果均可触发。同一变化只触发一次，保持零值不会再触发；重新获得正值后可再次归零触发。只施加状态，不允许递归写资源。现有状态刷新规则适用。

数值权威存在原活动 game.internal，通过原活动事件原子提交和重放，没有第二份存档或跨活动写回。暂停／重开视图不重置；角色临时离场内部余额保留，但不投影；新活动实例按配置重新初始化。结束活动的最终快照保留供记录，不能再发动技能。所有本功能数值明确是**在场战斗参与者公开信息**，无隐藏属性模式；全屏只取同一已授权 public 投影，房外观察不获得内部资源表。

每类最多 16 项，键最多 33 字符、标签最多 36 字，边界 0…9999，资源最小值必须 0。状态属性修正 -1000…1000。JSON Schema 检查形状和静态范围，正式解析器再检查声明引用、初值及费用与声明上限，不能只跑 JSON Schema 代替正式编译。

本批持久数据版本 **3，仅支持 3**；不兼容此前配置对应的旧存档，不提供自动迁移。旧 MV 新格式仍是唯一技能格式，可省略 battleValues 表示没有作者数值。没有 TRPG、MV 导入、DSL、通用核心触发器或新权限入口。
