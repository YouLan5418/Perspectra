# 跑团活动：取舍记录

2026-11-08，分支 `feat/rpg-plugin`。配合[设计](2026-11-08-trpg-activity-design.md)阅读，只记实施前已定的取舍及它们替代了什么。

## 1. `ctx.dice` 是单实现的可替换槽位

骰子是一个内部 Cordis 机制，入口 `ctx.dice`，和 `ctx.pacing` 同一模式：同一时间只有一个实现，玩家插件先注册就由它提供，否则 `official-bundle` 注册官方的 `official-dice`。世界打开时按 `SeamProvider.open` 打开，存档的模块记录（`plugin-set.json`）记下它。

替代：设计第 5.1 节留给实现的两种做法里，不让每个活动脚本自带一份骰子解析，也不把骰子写成宿主内置函数。换骰子规则（比如爆骰、优势骰）只换这个实现，不改活动脚本和宿主。

## 2. 随机来源是活动目录每轮的记录

掷骰取数用活动目录已有的每轮随机记录（`ActivityBindings.randomSource`，即 `ActivitiesRuntime` 的 `beginRoundRandom` / `roundRandom`），和初始化随机数、自动开始的平局选择排在同一串里。回看、分支、末端重新生成都按原记录重放，不重掷。

替代：两段式（`resolve` 先返回“需要掷 1d20”，宿主掷完再调一次），也不另建骰子存储或单独的骰子事件。点数随活动结果一起写进 `activity.updated`，由脚本决定写进哪个部分。

## 3. 脚本通过注入的 `rollDice` 掷骰

活动脚本在 `resolve` 里调用全局函数 `rollDice(expression)`，得到 `{ expression, dice, modifier, total }`。宿主把它作为 vm 全局注入，只在这次 `resolve` 调用期间有效；表达式非法或在别的钩子里调用都失败，整次结果不提交。

替代：脚本在 `resolve` 里自己用 `Math.random`。那样取到的数不进每轮记录，重新生成时会重掷，玩家可以靠重新生成刷检定。`resolve` 里的 `Math.random` 仍然不被记录，指南里写明要用 `rollDice`。

## 4. 检定 `check` 是纯函数

`official-dice` 导出 `check(roll, difficulty)`：`total >= difficulty` 为成功，`margin = total - difficulty`。它不掷骰、不读状态，玩法插件或活动生成器直接调用。

替代：把检定做成 `ctx.dice` 的另一个方法或宿主步骤。检定规则简单且确定，不需要替换和记录。
