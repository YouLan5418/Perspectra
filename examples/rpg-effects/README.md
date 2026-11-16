# 护盾与持续效果示例

[effects.json](effects.json) 是合并到官方 `rpg.json` 的配置片段，不是独立世界包。将 `combatStatuses` 合入同名对象、`skills` 追加到技能数组，再把 `ward`、`venom`、`renewal` 加入指定角色的 `skills`。现有包的属性必须包含 `mp`。本例没有修改既有示例的平衡。

实际可玩入口：

```sh
corepack pnpm@11.7.0 exec tsx tests/experiments/rpg-effects-preview.ts
```

它复制测试包到临时目录，应用本 JSON，启动真正 Host 和官方规则，仅使用回环假模型。打开终端 URL，读完后选“护盾术”对玩家施放；第一次敌方攻击被吸收，护盾从 12 剩 4，HP 仍 40。切回通用卡片施放“侵蚀术”对遗迹守卫，敌人在自己的行动后受 4 点伤害；重新打开战斗页可见状态及剩余次数。然后可以施放“再生术”。Ctrl+C 关闭并删除临时世界。

`kind: effect` 以 `target: party | enemy` 声明**绝对阵营**（玩家队伍／敌方），而不是相对施法者的友敌。双方都能使用新效果技能，敌方沿用配置顺序与已有选目标策略。旧 `damage` 和 `heal` 技能仍可用；新列表最多 8 项，按顺序结算有限的 damage、heal、status、shield，没有任意 JS。

规则、时长、抗性顺序与兼容边界见[官方 RPG 指南](../../docs/current/guides/rpg.md#持续效果与护盾)。
