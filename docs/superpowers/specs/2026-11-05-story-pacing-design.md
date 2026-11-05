# 剧情起伏器设计

日期：2026-11-05。状态：待用户确认，尚未实施。依据[统一规范](../../current/architecture/plugin-standard.md)和[暂缓需求](../../current/architecture/plugin-layering-direction.md#4-已记录暂不实现的两个需求)。

## 1. 要解决什么

例如玩家在客厅聊了十轮天，什么都没发生。作者希望这时来点事：门缝里塞进一张催租单，全屋紧张度加一，GPT 看见单子上写着她的名字，然后由她自己决定要不要提起。刚闹过一场之后，又不该马上再来一场。

用户要的起伏器有三件事：**触发事件、按条件变动数值、对角色进行一次作者要求的刺激**。

| 缺口 | 证据 |
| --- | --- |
| 自动事件的内容只有玩家看得到 | 探针：玩家读到“轰隆一声闷雷，灯灭了。”，同伴只读到“轮流猜数字开始。”，之后的模型请求里没有闷雷 |
| 作者无法控制事件的疏密 | 官方规则只比条件数目，条件满足就开始 |
| 脚本不能单独给某个角色写观察 | 只能靠开始活动或发短信。`onRoundEnd` 能改状态，但只能告知归属者本人，也看不到世界视图 |

**前提：** 朋友反馈的是“玩法空”，还没有证据证明节奏是主因。第一部分（第 3 节）直接做，其余用真实试玩决定去留（第 8 节）。

## 2. 目标与边界

**目标**

- 作者能让在场角色知道自动事件发生了什么。
- 作者写一个脚本，就能声明节拍：何时可以发生、改哪些数值、告诉谁、刺激谁。
- 节奏决策在存档、分叉、重新生成后保持一致。
- 创作者能看到某一轮为什么发生或没发生。

**不做**

- 通用外部插件持久状态。起伏器不需要，继续暂缓。
- 新事件类型、新存档字段、新数据库。
- 节拍直接移动角色或物品。需要时用活动或状态操作。
- 给角色下行动指令（见第 5 节）。

**做成这样算失败，即使功能都能跑**

- 节奏拦住了作者写死必须发生的剧情，比如序章。
- 角色变成照本宣科：刺激之后总是按同一种方式回应。
- 叙述文字被当成已发生的状态变化。数值只有经 `changes` 校验提交才算数。
- 角色知道了不该知道的事。刺激只到被点名的角色，别人读不到。
- 对外宣称正弦波能保证玩家体验。它只调节供应。

## 3. 第一部分：在场角色知道事件内容

`autoStart` 增加可选字段 `sceneNotice`，写给在场所有人。节拍的 `sceneNotice` 含义相同（第 4 节）。

| 接收者 | 没写（现状不变） | 写了 |
| --- | --- | --- |
| 玩家 | notice，否则 opening，否则“标题开始。” | notice，否则 opening，否则 sceneNotice |
| 活动参与者 | “标题开始。” | “标题开始。”，另加一条 sceneNotice |
| 同场非参与者 | 收不到 | 一条 sceneNotice |
| 不在场的人 | 收不到 | 收不到 |

字符串，1–500 字。受众用现有 `audienceForAction` 的 scene_public。私密事件不写即可。只影响自动开始，手动开始不变。

sceneNotice 是一条独立、没有行动者的观察（`{ eventNotice }`），所以不会被读成玩家做的事，记忆里归类为直接观察。

**验收：** 断言各类接收者的观察；模型请求含这段文字且没有行动者。

## 4. 第二部分：节拍

### 4.1 作者写什么

世界包新增可选脚本 `scripts/pacing.js`，放进 `assetFiles`。没有它时行为和现在完全相同。

~~~js
globalThis.pacingScript = {
  definition: {
    cycleRounds: 16,
    chance: 0.35,
    cooldownRounds: { low: 2, medium: 4, high: 8 },
    recoveryRounds: 3,
    stagnation: {
      afterRounds: 6,
      progress: { statuses: ['affection'], activities: ['game-battle'] },
      maxChance: 0.8,
      maxTensionBoost: 0.4,
    },
    // 交给节奏管理的活动。它们的 autoStart 条件仍然生效。
    activities: { 'midnight-fridge': { intensity: 'medium' }, 'blackout-comfort': { intensity: 'high' } },
    beats: { 'rent-due': { intensity: 'medium' } },
  },
  beats: {
    'rent-due': {
      // 和 autoStart 一样的条件格式
      when: (truth, world) => [['房租还没交', truth.public['rent-paid'] === false]],
      apply: (truth, world) => ({
        changes: [{ holderId: null, key: 'tension', value: truth.public.tension + 1 }],
        reveals: [],
        notice: '门缝里塞进来一张纸。',                     // 给玩家，可选
        sceneNotice: '门缝里塞进来一张催租单。',             // 给在场所有人，可选
        stimuli: [
          { characterId: 'character:gpt', kind: 'perception', text: '你看见那张催租单上写着你的名字。' },
          { characterId: 'character:claude', kind: 'thought', text: '你忽然想起这个月的房租好像是你经手的。' },
        ],
      }),
    },
  },
}
~~~

- `when` 和 `apply` 是同步脚本，运行环境和现有状态、活动脚本相同，不能读库或调用模型。
- 两者收到 `truth`（全部状态真值，可信）和 `world`：玩家视角的世界，加上一张 `places`（每个角色当前位置）。结果不会原样交给角色。
- 一次性节拍：`when` 里自己判断，比如用一个状态记录。可重复是默认。
- 活动没有列入 `definition.activities` 时不受管理，见 4.3。

### 4.2 节拍产生什么

一次原子提交，走 `executeWorldRound`：

| 产出 | 怎么落地 | 检查 |
| --- | --- | --- |
| 数值变化 | `status.updated`，来源新增 `{ kind: 'beat', beatId }` | 复用 `StatusState.validate`：已声明、Schema、归属、总量。只能由指定活动改变的状态会被拒绝 |
| 告知 | 同一事件的 `reveals`，值由宿主填 | 接收者必须是已声明角色。节拍没有行动者，所以不要求同场，和初始告知一样 |
| 玩家和在场文字 | 同第 3 节规则的 `observation.upsert` | 1–500 字 |
| 刺激 | 见第 5 节 | 见第 5 节 |

`status.updated` 即使没有数值变化也会写，它就是这次节拍发生过的记录，所以不需要新事件类型。因此**写了节拍的世界包必须有状态声明**，否则打开时报错。

### 4.3 每轮怎么选

玩家回合结束、状态轮末之后，也就是现在自动开始的位置。一轮最多发生一件事。

1. 取条件满足的活动候选，以及 `when` 全部满足的节拍候选。
2. 有未受管理的活动候选：照现有 `chooseAutoStart` 选，结束。必须发生的剧情不被拦住。
3. 距上次受管理事件的回合数，小于那次强度的 `cooldownRounds`：不发生。
4. 紧张度 `t = (sin(2π × 回合 / cycleRounds) + 1) / 2`。
5. 停滞程度 `s`：无进展回合数超过 `afterRounds` 后，从 0 线性升到 1（再过 `afterRounds` 回合到顶）。
6. `t' = min(1, t + s × maxTensionBoost)`，介入概率 `p = chance + s × (maxChance − chance)`。
7. 抽随机数，大于等于 `p`：不发生。
8. 上次是 high 且仍在 `recoveryRounds` 内：去掉 high 候选。没有候选就不发生。
9. 按权重抽一个：low 为 `1 − t'`，medium 为 `1 − |2t' − 1|`，high 为 `t'`，每项至少 0.05。

未发生时不写入任何事件。公式是起点，试玩后再调。

手动开始活动不受冷却限制，和现在一样。

### 4.4 决策不需要持久状态

| 信息 | 来源 |
| --- | --- |
| 回合数 | 玩家回合记录，和 `statusRoundNumber` 共用一套计数，移到 contracts |
| 上次事件 | `activity.updated` 的 start，`status.updated` 的 beat 来源 |
| 进展 | 声明的状态键变化，声明的活动结束 |
| 随机数 | 现有回合随机序列，重新生成时回放 |

作者自己的长期数值存进已声明的状态。所以分支、读档、重新生成都天然一致，也不会出现“启动失败却记了冷却”。

### 4.5 活动和节拍之后的回应

提交后调用现有 `#activateCharacters`，起点设在这次提交之前，所以只有这次的新观察会唤醒角色。受预算限制，角色可以不回应。`autoStart` 开始活动后的现有流程不变。

## 5. 对角色的刺激

**系统里的刺激本来就是观察**：调度器按观察序号把新观察交给角色，由角色决定怎么回应。所以这里不新增“指令”通道。

| kind | 作者写什么 | 记录为 | 例子 |
| --- | --- | --- | --- |
| `perception` | 她察觉到的事 | `epistemicKind: direct_observation` | “你看见门缝里那张催租单。” |
| `thought` | 她心里冒出的念头 | `epistemicKind: subjective_inference` | “你忽然想起今天是她的生日。” |

`subjective_inference` 已在记忆系统的合法分类里，所以念头不会被当成亲历的事实，也不需要新词。观察内容用独立字段（`perceived`／`innerThought`）。

**规则**

- 对象必须是已声明、活跃的非玩家角色。玩家不是对象，玩家的内容用 `notice`。
- 一个节拍最多 8 条，每条 1–500 字。
- 只进被点名角色的观察。玩家界面和别的角色都读不到，创作者查询能看到。
- 文字不证明状态变化。要改数值就写进 `changes`。
- 可以给不在场的角色。不授予物理权限，她要过去仍然走移动规则。

**第三种（直接指令）不支持**，比如“这轮请主动向玩家提起房租”。这和 AGENTS 第 4 节冲突，用户也选择不做。

**程序无法完全拦住指令：** 文字是自由文本，作者仍可能写进指令。按 AGENTS，不为此加语义分类器。靠创作指南和 Skill 讲清写法，真实试玩检查角色是否照本宣科。

**AGENTS 需要补一句：** 第 4 节约束调度器不得预设意图。作者的 `thought` 属于内容，不是调度器行为，但它离这条线很近。实施时在第 4 节写明这个例外及其边界。

## 6. 装配：新增 `ctx.pacing`

这里确实需要一个新的 Cordis 机制：它有自己的脚本、每世界实例和选择算法，符合规范里内部机制的定义。

| 位置 | 内容 |
| --- | --- |
| `packages/plugin-sdk/src/pacing.ts` | `ctx.pacing` 单例槽位和 `PacingInstance` 类型 |
| `packages/official-pacing` | 解释 `scripts/pacing.js`，实现第 4.3 节的纯函数选择 |
| `packages/application/src/pacing-state.ts` | 校验节拍结果并生成事件：刺激对象、字数、条数；状态变化交给 StatusState |
| `packages/application/src/status-state.ts` | 接受 `beat` 来源 |
| `desktop/host/pacing-runtime.ts` | 校验资产，提供授权输入和历史，调用 `executeWorldRound`，记录随机数 |
| `desktop/official-bundle.ts` | 默认 RP 选配 `officialPacingProvider`，打开次序在 activities 之后 |
| 创作者查询和透视 | 显示回合、紧张度、停滞程度、候选和未发生原因；不进玩家视图和角色请求 |
| HOST API | 升到 2.9（新服务属于小版本） |

```ts
interface PacingInstance {
  readonly definition: unknown
  /** 每个节拍的条件，形状和 autoStart 的 when 相同。 */
  checks(input: { truth: StatusTruth; world: WorldJsonObject }): Record<string, unknown>
  /** 只在受管理候选之间选择；undefined 表示这轮不发生。 */
  choose(input: { candidates: PacingCandidate[]; history: PacingHistory; random: () => number }): PacingChoice
  apply(beatId: string, input: { truth: StatusTruth; world: WorldJsonObject }): unknown
  close?(): void | Promise<void>
}
```

- 机制拿不到 Store 和提交回调，只返回候选和选择。
- `chooseAutoStart` 保留在活动机制里不动，继续负责未受管理的候选。所以活动的公共接口不变。
- 显式组合省略 `pacing` 而世界包有 `scripts/pacing.js`：打开前报错，和其他机制一致。
- 脚本或配置错误：打开即失败并指明字段。运行时 `when`／`apply` 抛错：这轮不发生，记录原因，不重试。
- `worldpack validate` 不执行脚本，所以它只查文件存在；配置错误在透视或打开世界时发现。

## 7. 内容：甜蜜日程作为第一个使用者

节拍让小事变便宜：不用写一场活动，几行脚本就行。

- 给现有突发活动标上强度。序章和结局不列入。
- 新增 3–5 个可重复的低、中强度节拍，比如有人敲门、窗外下雨、夜宵的味道、催租单。我起草，你润色。
- 文字只写发生了什么和她察觉到什么，不规定怎么反应。

## 8. 怎么判断值得留下

**自动测试证明机制正确，不证明体验变好。**

| 验证 | 内容 |
| --- | --- |
| 纯函数 | 固定随机序列下的每一步；冷却和恢复期内绝不发生；未管理候选优先 |
| 原子性 | 非法数值让整个节拍不提交，观察也不写 |
| 认知隔离 | 刺激只到被点名角色；别的角色的模型请求和玩家视图都读不到 |
| 记忆 | `thought` 以 subjective_inference 进入记忆来源，Core 记忆真实走一遍 |
| 一致性 | 存档恢复和重新生成后决策相同，分支各走各的 |
| 无脚本 | 没有 `scripts/pacing.js` 时行为基线逐字节不变 |
| 分布模拟 | 事件间隔和强度分布，作为机制特性记录，不当作体验证据 |
| 真实模型对照 | 甜蜜日程同一组玩家输入约 30 轮，开启和关闭各跑两次 |

**对照要记录：** 事件次数和间隔、最长无事件回合、高强度是否扎堆、角色是否知道事件内容、收到刺激后的回应是否多样（有没有照本宣科）、念头有没有被说成事实、读转录时的自然度和重复感。

**去留：** 由你读转录决定。没有明显改善时，不在甜蜜日程上默认启用，并记录原因。

## 9. 实施顺序

1. 第 3 节，可以单独合并。
2. `ctx.pacing` 骨架和选择算法，先只管活动。
3. 节拍：数值、文字、刺激。
4. 第 7 节内容。
5. 第 8 节真实对照，结果给你看。

每一步都能停。

## 10. 我替你定的部分

都可以改，读的时候请留意：

| 决定 | 理由 |
| --- | --- |
| 新增 `ctx.pacing` 和 `official-pacing`，不塞进活动机制 | 节拍不是活动，有自己的脚本和生命周期 |
| 所有配置放进一个 `scripts/pacing.js` | 作者在一处看全，节拍本来就要写脚本 |
| 未列入的活动优先于受管理事件 | 必须发生的剧情不能被拦住 |
| 节拍必须依赖状态声明 | 复用 `status.updated` 作记录，不加新事件类型 |
| 节拍不能移动角色或物品 | 先保持小，核心检查那些效果需要行动者 |
| `sceneNotice` 也给同场非参与者 | 闷雷这种事在场的人都该知道；私密事件不写即可 |
| 刺激可以给不在场的角色 | 手机响了这类事很常见；不授予物理权限 |
| 节拍产生的告知不要求同场 | 节拍没有行动者，由作者负责 |
| 公式和三档强度 | 起点，试玩后再调 |
| 新节拍由我起草 | 沿用甜蜜日程之前的做法 |

这个会话没有派独立审查代理，这份设计只由我按实施者视角自查过。
