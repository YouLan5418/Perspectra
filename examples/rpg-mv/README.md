# MV 启发式官方 RPG 战斗切片

这是一份真正调用 Perspectra 官方 RPG 的可玩实验，不是 MV 工程导入器。配置在 [effects.json](effects.json)，完整无头剧本在 [scenario.json](scenario.json)。没有真实模型或付费接口，测试世界和 SQLite 都临时创建。

```sh
# 根目录，Node 24.19 / pnpm 11.7.0；云容器需 COREPACK_HOME=/tmp/perspectra-corepack
corepack pnpm@11.7.0 exec tsx tests/experiments/rpg-mv-preview.ts
corepack pnpm@11.7.0 exec tsx tests/experiments/rpg-mv-simulate.ts
```

预览打开打印的 URL，读完后依次选择：破甲击→遗迹守卫、燃烧火球→遗迹守卫、炽热护盾→玩家、净化振奋→玩家。可以在宿主按钮切换全屏和通用卡片，进度不变。Ctrl+C 关闭并清理世界。

剧本从客厅进入遗迹，共 8 步，经过上述四种技能，再普通攻击直到胜利。关键结果：破甲击造成 4 伤害（破甲先于伤害）；火球直接 12 加持有者行动后燃烧 3；护盾吸收自己燃烧及敌人攻击；净化解除燃烧并保留正面振奋，下一击受攻击加成影响。最终玩家 HP 28、MP 3，战斗胜利。数值是此实验的明确选择，没有暗改山丘遗迹原例平衡。

炽热护盾同时带来负面燃烧，是为演示“多效果的代价”和随后净化而特意配置的技能；护盾系统本身不会自动附加燃烧。普通护盾只需一个 shield 效果。所有行为由配置表达，没有技能名特判。

## 短作者例子

```json
{
  "id": "sunder", "name": "破甲击", "target": "opponent", "cost": { "mp": 1 },
  "effects": [{ "kind": "status", "status": "fracture" }, { "kind": "damage", "amount": 2 }]
}
```

对应状态为：

```json
{ "name": "破甲", "turns": 3, "timing": "after-action", "polarity": "negative", "modifiers": { "defense": -3 } }
```

把 effects.json 的 combatStatuses 合入 rpg.json，把 skills 追加，再在角色 skills 列表声明学会的技能。敌人也使用相同列表和解释器，但没有资源池，不能引用带 cost 的技能。目标按施法者相对关系使用 ally/opponent/self；状态 timing 必须写明 after-action 或 round-end。

先验证技能与目标、一次扣费，再按列表处理效果；伤害统一走基础攻防与状态修正→火抗→一次性防御→护盾→HP。DoT 不使用基础攻防或一次性防御。状态同 ID 刷新不叠层；净化移除 negative，保留 positive 和护盾。

## 破坏性迁移

本批不兼容旧配置或旧存档。移除技能顶层 kind/power/element/inflicts，改为 target＋effects；旧状态 damage/element 改 tick，并声明 timing/polarity。持久数据版本改为 2，仅支持 2；没有兼容分支或自动迁移。旧包声明的插件版本仍是 official-rpg/1，和持久数据版本是两回事。

详细边界见[作者指南](../../docs/current/guides/rpg.md#破坏性迁移本批不兼容旧版)和[实现／来源记录](../../docs/superpowers/plans/2026-11-15-rpg-mv-design.md)。未引入 MV 整体运行时、MZ、素材或第三方插件；未实现 MV 项目/插件导入。
