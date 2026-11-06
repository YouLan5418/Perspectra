# 创作者：剧情节奏

2026-11-05 当前源码：`scripts/pacing.js` 由 official-pacing 解释。自动测试覆盖选择规则、原子提交、认知隔离、重新生成和节点恢复；真实体验见[对照记录](../studies/2026-11-story-pacing.md)。节奏只调节事情的供应，不保证玩家实际感到起伏。

## 1. 它能做什么

玩家聊了六轮，家里什么都没发生。这时窗外下起了雨，或者门缝里塞进一张水电单，DeepSeek 闻到了楼下烤红薯的味道。下一轮可能什么也不发生，而那场高强度的停电要隔一阵才可能再来。

这个脚本决定两件事：

- **哪一轮来一件事**：冷却、起伏周期、停滞越久越容易介入。
- **来哪一件**：已满足条件的活动和节拍里，按强度抽一个。

一轮最多发生一件。没有 `scripts/pacing.js` 的包，行为和以前完全相同。

玩家可以在舞台设置里关掉剧情节奏。关闭后，世界就像没有这个脚本：节拍不发生，交给节奏管理的活动回到各自的 `autoStart` 条件。所以活动的条件本身要写得合理，不要指望节奏替你控制它的频率。这个开关是玩家偏好，不是世界事实，不写进事件日志。

## 2. 一个完整的例子

把脚本登记进 `assetFiles`。节拍依赖状态声明，只用节奏管理活动时不需要。

```js
globalThis.pacingScript = {
  definition: {
    cycleRounds: 16,
    chance: 0.35,
    cooldownRounds: { low: 3, medium: 5, high: 10 },
    recoveryRounds: 4,
    repeatAfterRounds: 10,
    stagnation: {
      afterRounds: 10,
      progress: { statuses: ['mood-note'], activities: ['game-battle'] },
      maxChance: 0.55,
      maxTensionBoost: 0.3,
    },
    activities: { 'blackout-comfort': { intensity: 'high' } },
    beats: { 'utility-bill': { intensity: 'medium', repeatAfterRounds: 24 } },
  },
  beats: {
    'utility-bill': {
      when: (truth, world) => [['付得起', truth.characters['character:player'].money >= 30]],
      apply: (truth, world) => ({
        changes: [
          { holderId: 'character:player', key: 'money', value: truth.characters['character:player'].money - 30 },
        ],
        reveals: [{ observerId: 'character:player', holderId: 'character:player', key: 'money' }],
        notice: '手机震了一下：这个月的水电费自动扣了 30 元。',
        // 只有在屋主身边才可能瞥见。
        stimuli:
          world.places['character:claude'] === world.locationId
            ? [{ characterId: 'character:claude', kind: 'perception', text: '你瞥见屋主低头看了一眼手机上的扣费提醒。' }]
            : [],
      }),
    },
  },
}
```

完整示例见[甜蜜日程](../../../examples/world-packs/model-girls-sweet-days/scripts/pacing.js)。

| 字段 | 含义 |
| --- | --- |
| `cycleRounds` | 起伏周期的回合数。紧张度沿正弦变化，高时偏向高强度事件，低时偏向低强度事件 |
| `chance` | 每轮介入的基础概率 |
| `cooldownRounds` | 上次事件后要隔几轮，按那次的强度取值 |
| `recoveryRounds` | 高强度事件冷却结束后，再等几轮才允许下一个高强度事件；其他强度可以先回来 |
| `repeatAfterRounds` | 可选，默认 0。同一个活动或节拍至少隔几轮才会再来；单个活动或节拍里也可以写，覆盖这个默认值 |
| `stagnation` | 可选。`progress` 声明什么算进展：状态值变化或活动结束。超过 `afterRounds` 没有进展，介入概率和紧张度逐步上升 |
| `activities` | 交给节奏管理的活动。它们的 `autoStart` 条件仍然生效 |
| `beats` | 节拍及其强度。声明了就必须有实现，有实现就必须声明，否则打不开 |

没有列入 `activities` 的活动照旧按自己的条件发生，并且优先：序章、结局这类必须发生的剧情不要交给节奏。手动开始活动不受冷却限制。

`when` 和 `apply` 收到 `truth`（全部状态真值）和 `world`（玩家视角的世界，加上 `places`：每个角色当前的位置）。`when` 的格式和 `autoStart` 的条件相同。`apply` 里的 `Math.random` 是回合记录的随机数，重新生成时会回放；`when` 里不要用随机。

## 3. 节拍能产生什么

| 字段 | 谁能看到 | 说明 |
| --- | --- | --- |
| `changes` | 按状态自身规则 | 和状态脚本同样校验。只能由指定活动改变的状态会被拒绝 |
| `reveals` | 点名的已声明角色 | 只写谁、哪个状态；值由宿主填。不要求同场 |
| `notice` | 玩家 | 1–500 字，显示为旁白 |
| `sceneNotice` | 玩家所在场景的所有人 | 1–500 字。没有 `notice` 时玩家也读这段 |
| `stimuli` | 只有被点名的角色 | 最多 8 条，每条 1–500 字。玩家和其他角色都读不到 |

一个节拍是一次原子提交：任何一处不合法，整个节拍都不发生，原因显示在创作者查询和包透视里，下一轮照常。节拍不能移动角色或物品；需要时用活动或状态操作。

一次性节拍要在 `when` 里自己判断，比如用一个状态记录。可重复是默认，但要设 `repeatAfterRounds`：真实试玩里，同一张水电单一局出现 7 次，角色每次都说差不多的话，读起来像在念台词。

## 4. 怎么写察觉和念头

`perception` 是她察觉到的事，`thought` 是她心里冒出的念头。念头记入记忆时标为主观推断，不会被当成亲历的事实。这两种都只是给她一个新刺激，她可以不理会。

写发生了什么，不写她该怎么做：

| 不要这样写 | 这样写 |
| --- | --- |
| 你很担心房租，请主动向屋主提起这件事。 | 你看见门缝里那张催租单上写着这个月的日期。 |
| 你现在很想吃烤红薯，于是拉着屋主下楼。 | 窗缝里钻进来一股烤红薯的甜香。 |
| 你嫉妒了，开始闹别扭。 | 你想起他刚才只给 Claude 倒了茶。 |

程序不判断文字是不是指令。写成指令时，角色会照本宣科，自主性就没了，这要靠作者自己把握，并在试玩中检查。

文字也不证明状态变化：写“扣了 30 元”不会扣钱，要写进 `changes`。

察觉要和她的处境相符。程序不检查文字和位置是否矛盾：写“你瞥见屋主看手机”，却在她不在屋主身边时也发给她，她就会记住一件没发生过的事。用 `world.places` 判断她在不在场。

## 5. 怎么检查

用[包透视](pack-lens.md)推演，每一步的结果都带 `pacing`，能看到这一轮的紧张度、概率和原因：

| `why` | 含义 |
| --- | --- |
| `no-candidates` | 没有满足条件的事情 |
| `cooling` | 还在冷却 |
| `repeated` | 满足条件的事情都刚发生过，还没到各自的再次间隔；`repeated` 字段列出它们 |
| `not-this-round` | 抽签决定这轮不介入 |
| `recovering` | 只剩高强度候选，还在恢复期 |
| `chosen` | 发生了，`key` 是哪一件 |
| `beat-failed` | 节拍的 `apply` 或结果不合法，`error` 是原因，这轮没有提交 |

`reason.excluded` 列出 `when` 抛错而被排除的节拍。这些信息只给创作者，不进玩家视图，也不进角色请求。

推演里抽的是真随机数。预期写死“这一步一定发生某事”的脚本在有节奏的包上会时有时无；要固定检查某个事件自身的条件，用一份去掉 `scripts/pacing.js` 的副本推演。

公式是起点。真实试玩后，优先调 `chance` 和冷却，看事件密度和角色回应，不要只看数字。
