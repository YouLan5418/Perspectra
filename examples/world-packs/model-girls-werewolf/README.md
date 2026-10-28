# 模型娘狼人杀（实验）

包 ID `pack:model-girls-werewolf`，版本 0.1.0，源格式 worldpack-source/v5。独立实验包：玩家与 GPT、Claude、DeepSeek、GLM、Gemini、Qwen 打 7 人局狼人杀，观察角色之间的猜忌、信息隔离和跨局记忆。设计见 [werewolf-pack-design](../../../docs/superpowers/specs/2026-10-28-werewolf-pack-design.md)，试玩结果见 [PLAYTEST](PLAYTEST.md)。

前四人的设定取自 [model-girls-official](../model-girls-official/characters.json)，复制进本包；Gemini 与 Qwen 是本实验新增角色。

## 规则

2 狼人、1 预言家、1 女巫、3 村民，开局随机发身份，玩家也可能是狼。夜晚狼人 → 女巫 → 预言家依次行动；天亮公布死讯，存活者按顺序各发言一次，再依次投票，全部投完才公布票型，平票无人出局。狼人全灭好人胜，存活狼人数不少于好人数狼人胜。局末公布全员身份，不公布夜间过程。

规则全部在 [scripts/activities/werewolf.js](scripts/activities/werewolf.js)，没有改宿主：

- 身份表、夜间行动、未公布的票只在 `internal`；本人身份、狼同伴、验人记录、女巫看到的刀口只在各自 `private`。
- 白天发言是自由对白，发完由 `onPublished` 换到下一位；嘴上说的身份不改变任何裁定。
- 夜晚只有轮到的狼人可以说话。想和同伴商量请用**定向**发言，公开发言所有人都能听到——规则只能控制能否说话，管不了说给谁。

## 启动

```powershell
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/model-girls-werewolf --data-dir .tmp/werewolf-playtest-0.1.0 --play-settings '{"activityOpportunities":20,"activityDeadlineSeconds":600}'
```

一个白天需要 12–13 次角色处理，超过默认的 4 次 / 90 秒，所以要把「活动连续处理机会」调到 20、「活动处理总时限」调到 600 秒（上面的 `--play-settings`，或在启动器的试玩设置里改）。修改脚本后使用新数据目录。

自动对局驱动：`node --import tsx tests/experiments/werewolf-live.ts <新目录>`，模型由 `HCW_LOCAL_MODEL` / `HCW_LOCAL_ENDPOINT` 指定。

## 已知限制

- 狼人误用公开发言会被全场听到，规则拦不住。玩家当狼时，夜里直接在输入框打字等于对全体说话，要在发送区选“定向”并选同伴。
- 默认舞台的忙碌提示只显示“正在回复中”，不显示是谁；自带前端的包若显示 `responders` 名字，同样会暴露夜里谁在行动。
- 宿主的活动 `revision` 随夜间操作增加，模型可据此推断夜里行动的人数。
- 模型不提交操作时回合会停住，可重试或逃生；不会替角色行动。
- 一局约 11–12 分钟（gemini-3.8-flash）。
- 没有专用前端，使用默认活动卡片；浏览器内体验尚未验收。
