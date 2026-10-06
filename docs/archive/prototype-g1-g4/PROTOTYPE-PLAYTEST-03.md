# 第三轮：玩家输入与反应链诊断

日期：2026-09-20。工作树：harness-cordis-world-prototype。模型：deepseek-flash；世界包：ai-girls-awaken-v10。玩家输入切片通过本轮小样本；角色自然度仍未通过体验验收。生产调度策略未修改。

## 玩家侧改动与实测

玩家对 NPC 的请求、提问、建议按玩家自己的对白提交，不要求请求内容本身是玩家可执行的交互。NPC 仍自行决定响应。玩家自己的普通表现通过 narrate 选择发布；Host 仅绑定原文引用，不能由解释模型编造表现。移动、物品转移等仍使用已提供的执行选项。

复用 speak 的 text/narration 参数，没有新增协议版本、分类模型或数据库。允许两次表达，仍最多两步、一次重要状态操作。玩家模型的 Schema 和交互选项不再展示表现码；旧表现码绑定辅助代码尚未整体删除，不属于本轮已完成的清理范围。

首轮数据 `.tmp/player-input-playtest-20260920` 保留：14 次调用，手势请求已成功，但混合输入因模型沿用 Schema 中旧 performance 字段而失败。移除该模型可见字段及旧选项菜单后，在独立目录 `.tmp/player-input-playtest-20260920-b` 复测；23 次调用，233876 总 token，均记录了去除凭证的请求和响应。

| 玩家输入 | 修复后结果 |
| --- | --- |
| GPT，先不要说话，可以只用表情或手势回应我一下吗？ | speak 原文提交；GPT 以无声表现回应 |
| 我有点尴尬地笑了笑，说“我不是要做实验，只是想和你们待一会儿。” | 两次原文发布：表现 seq216、对白 seq222；未要求澄清 |
| 我拿起桌上的魔法权杖。 | not_afforded；世界 head 保持 309，没有提交虚构拿取 |

## 到底是谁在让角色继续反应

结论是两个因素叠加：调度器把符合基本资格的观察纳入后续唤醒候选；本次上下文中的模型被唤醒后持续选择表达。不能从这些记录推断模型天生不愿沉默。

第二轮成功样本 `.tmp/narration-playtest-20260920-b/world.sqlite` 的反应任务、刺激证据与原始响应核对结果：

| 指标 | 结果 |
| --- | --- |
| NPC 调用 | 21：Root 7，后续 Reaction 14 |
| 决策 | act 21，abstain 0 |
| 落库后续刺激 | 41，全部为 witness |
| 刺激来源 | 34 条带对白表达、3 条移动、4 条纯表现 |
| 同观察者、同源事件重复刺激 | 0 |
| 两个周期的停止原因 | 均为 call_limit |

GPT 的纯表现事件 seq247 和 seq269 分别被 Claude、DeepSeek 观察并进入下一波任务，共四条。相同任务也含其他人的对白，因此不能声称删除这四条刺激就必然少四次调用。调度按角色、波次合并刺激，也不是每个表情词各调用一次。

代码证据：

- `packages/application/src/round-coordinator.ts` 的 reactionStimuli 与 `#buildReactionCycleDraft`：记录观察，排除自身和 Root 已处理的玩家刺激，其余按观察者组织候选。
- `packages/application/src/reaction-scheduler.ts`：可调用、非行为者自身的观察者进入下一波候选；没有区分微小表现与值得立即处理的新信息。
- `packages/contracts/src/stable-call-budget.ts`：角色类别决定预算优先级，witness 并不意味着不唤醒。
- `packages/application/src/reaction-evidence.ts`：明确受众依赖 addresseeIds；当前模型表达 Schema 和自然语言玩家绑定没有提供该字段。对白中写“GPT”并不会自动变成调度受众信息。

`tests/experiments/playtest-frozen-runtime.test.ts` 的确定性测试已验证：Root 的纯表现会触发后续调用；下一波均返回 abstain 后，周期以 all_abstained 结束，总计四次角色调用。协议允许真正不产生新内容，调度也能正常停止。GPT “不说话但做手势”属于 act，并不是 abstain。

本轮修复后的真实样本同样是 20 次 NPC 调用全部 act、零 abstain。GPT 多次表达“我在听/等待”，其他人仍接话。另出现 GPT 把长段对白放进 narration、重复发布相近段落的问题。不能把玩家输入成功当作自由表达整体已验收。

过度分析的内容还受世界包影响：characters.json 中 Claude 习惯确认前提，DeepSeek 喜欢追问为什么；cognition.json 中存在研究实体化原因的目标与冲动。调度放大了输出机会，但没有直接指定这些分析内容。目前没有更换人物设定或模型的控制实验，不能量化二者各占多少。

## 下一步建议

优先分开“能够观察到”与“值得立即再唤醒”：普通旁观表现仍进入可见历史，但不因此自动启动反应链。明确面向角色的表达、直接影响其状态的交互等，应保留处理机会，角色自行选择回应或 abstain。

不要一刀切禁止纯表现唤醒：玩家请求手势，以及有明确对象的非语言交流仍需可用。下一轮先选一个小的调度规则做对照试玩，同时保持人物设定不变；不增加语义分类模型，也不把调度器变成角色意图编排器。本轮尚未实施此规则。

## 验证与限制

- 默认 check 通过：类型检查、Lint、3 文件 9 个核心测试；保留 grouped-runtime.test.ts:25 的既有可选链警告。
- 玩家绑定、输入准备、输入 worker、Frozen runtime 四组相关测试通过，共 75 个；新增旧表现字段 Schema 回归断言后，该绑定套件再次通过 55 个测试。
- 未运行旧全量、覆盖率与硬终止测试；未修改事务或恢复机制。
- 连续自然度、叙述与对白分工、对重要事实的语义越权、长会话重复仍未验收。原有两步上限及原文连续引用限制仍保留。
- 旧 WorldPlaytestRuntime 的 compact/lean Context 适配问题仍未处理；当前支持的入口是 v10 Frozen runtime。
