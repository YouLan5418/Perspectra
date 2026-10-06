# Source / Event Atom / Episode / Observation：首版验证

日期：2026-09-30。分支：`codex/hindsight-core-experiment`。模型：本机 8045 的 `gemini-3.7-flash`；向量：现有本地 multilingual-e5-small ONNX。

## 1. 实现结论

首版闭环已接入可选真实 Character Turn 模式。Event Atom 独立保留证据，Episode 仅组织同一次经历，Observation 明确是主观认识。Source/Atom 不接受来自上层的内容改写。权限出口仍是现有角色授权来源；核心没有世界库句柄。

这是分层可运行性与两处具体内容失真的验证，不是记忆方案已优于基线的结论。正式 Memory schema、World State、Event Log、Rulebook 实现没有变动。

## 2. 原 120 回合中的真实来源重建

输入是原轨迹 `consolidation.jsonl` 中发生两处失真的**原来源批次**，各批次再分成两次处理，验证跨批次 Episode 延续。没有人工补写历史、纠正事实或预设期望行为给模型。

| 来源 | 原问题 | 新结果 | 本次材料 |
|---|---|---|---|
| 沈南 `event:234`，knownTick 37 | 玩家转述门廊有雨伞，被写成不带说话者的事实 | Atom 保留 `character:player` 与听到发言标识；Observation 写“旅人告知门廊……” | 原批次 6 来源，16 Atom，2 Episode，2 Observation |
| 林晓 `event:938`，knownTick 175 | “周姨，这茶温着正好”被写成“周姨准备的茶” | Atom 只保留原发言和语境，没有新增准备茶的主体；该次 Observation 没有“周姨准备” | 原批次 4 来源，13 Atom，1 Episode，1 Observation |

完整来源与阶段产物在 [原句重建输出](<D:/DeepSeek Harness/perspectra-hindsight-core/.tmp/hindsight-episode-regression-20260930-v1/results.json>)，各角色目录保存 `prepared.json/index.json/stages.json`。

Observation 仍有时间线式表述和较宽的人物印象，例如“言行举止表现得随和友善”；它们保留为主观归纳，没有进入下层 Atom。本轮不把这些输出算作稳定人物认识。

## 3. 正常连续试玩冒烟

新目录 [分层试玩](<D:/DeepSeek Harness/perspectra-hindsight-core/.tmp/hindsight-continuous-20260930-episodes-v1/progress.json>)完成 12 个玩家回合，24 次 NPC 模型返回：20 次 abstain、4 次 publish，无失败回合。玩家 7 次交互、3 次移动、2 次发言；NPC 没有重要行动提议。世界 tick 18 包括 NPC 表达及 2 次实验宿主空 Scene 创建，不当作玩家回合。

检查点 0/5/10/12 与恢复入口正常；最后三角色分别有 10/10/11 条来源、18/18/22 个 Atom、2/4/2 条 Observation。所有 15 份分层快照/当前银行通过嵌套证据校验。

该短轨迹内材料仍在近期上下文，长期记忆实际选入次数为 0。因此这里确认真实调度、规则提交、分组与归纳更新的运行性，**不能算长期记忆行为验收**。protocol 的 120 是可续跑目标，本轮实际仅完成 12。

第 9 回合玩家发言声称把热水、茶叶放上桌；第 10 回合才正式 drop 保温瓶。该类声称、叙事与实际交互来源保持分开，不以 Episode 的存在证明所有物品已转移。这是不同证据类型的具体例子，不是自由文本永不误导的证明。

来源/获知 tick 与只读 cognitive/world 数据库核对、精确模型输入、来源年龄等检查见 [追踪统计](<D:/DeepSeek Harness/perspectra-hindsight-core/.tmp/hindsight-continuous-20260930-episodes-v1/trace-summary.json>)。

## 4. 原真实请求的分层记忆注入

保持原角色、原刺激、近期上下文与 affordances，仅替换长期记忆，并沿用原来的近期来源排除方法。记忆来源来自上述沈南的原批次；不是全部历史，没有同预算的基线行为比较。

| 原请求 | 实际选入 | Gemini 返回 | 执行情况 |
|---|---|---|---|
| `turn-0074-call-001-friend` | 6 条：Observation、Atom、Episode | publish：“行，那你先拾掇着，弄好了咱们茶水间见。” | 请求重放，不提交世界事件 |
| `turn-0092-call-001-friend` | 7 条：Atom、Episode、Observation | perform：move 到 `location:hall` | 提议未执行 |

[第74回合请求](<D:/DeepSeek Harness/perspectra-hindsight-core/.tmp/hindsight-episode-regression-20260930-v1/turn-0074-replay.json>)与[第92回合请求](<D:/DeepSeek Harness/perspectra-hindsight-core/.tmp/hindsight-episode-regression-20260930-v1/turn-0092-replay.json>)保存检索路线、嵌套 Atom、六字段映射、逐来源年龄、精确 wire 输入与模型返回。实际消息 JSON 与 deliveredRequest、selected 与交付的嵌套证据逐项一致。

这证明新结构进入了实际模型请求，不能证明它独立造成了回应或移动意图。当前刺激本身仍可解释行为。

## 5. 自动化检查

- Python 23 项测试通过：旧 Core/向量基线，以及真实失真对应的说话者保留、否定/不确定性片段拒绝、叙事/执行状态分离、跨批次分组、具体证据引用、纠正与相反证据、上层不修改下层、跨角色/未来来源拒绝、关键词/向量的 Atom 覆盖。
- 根 TypeScript 与实验 TypeScript 类型检查、相关 oxlint 通过。
- 冻结 Character Turn/实验场景重入 9 项集成测试通过。
- 原句输出、试玩 15 份分层快照、两次实际模型请求的来源与嵌套证据核验通过。
- 未运行全量历史回归与覆盖率门禁；未完成分层模式的 100–300 回合长期行为验证或完整 120 回合历史重建。

## 6. 后续与限制

完整语境与重叠证据保留使压缩率较低，Atom 可能还偏粗。Episode 的增量分组可能过宽，Observation 仍可能过度概括。主观标识和结构检查不能证明模型始终正确理解所有限定。

下一步应按原轨迹的授权来源前缀重建完整记忆，再比较同一真实刺激的召回和行为；当前输出不回填早期回合，也不作为权威事实。

## 7. 原始产物摘要

- `.tmp/hindsight-continuous-20260930-episodes-v1/protocol.json`: `83e9fa6205ed607252fd7f5e860d83f7401b6cb0dfa060eb7bf8de4ac9e7eec3`
- `.tmp/hindsight-continuous-20260930-episodes-v1/progress.json`: `4c66a99e02f8c94b27347f176e449ed9627501acbc733381980002180e1f29d9`
- `.tmp/hindsight-continuous-20260930-episodes-v1/consolidation.jsonl`: `b70f528a0531b99a8b4213ade93a7a2e6d3f313ca06a333a30a2207fc3bcb063`
- `.tmp/hindsight-episode-regression-20260930-v1/results.json`: `66dc91ef10ba8987ac05754cc245a548e98b01d1a8d03c345f19985244bbcfd5`
- `.tmp/hindsight-episode-regression-20260930-v1/turn-0074-replay.json`: `1531cfd0a4429c8c64f4e2dcbaf8417c5b400fe6af418b2d9c90a1e63815f1fb`
- `.tmp/hindsight-episode-regression-20260930-v1/turn-0092-replay.json`: `991a693b74bf83a8e5c33f7026e094e2211ae7dcb1b058e6a46e84bcaa0ea73f`
