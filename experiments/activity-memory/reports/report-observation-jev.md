# JEV 适用性判断与延迟自主选择实验

日期：2026-10-04。结论：**JEV 在这组小样本中可以替代 Gemini 适用性判断器，且再次观察到了认识影响自主选择的现象。** 不据此宣称全库召回质量已经解决、JEV 优于 Gemini，或正式网页已经启用。

## 1. 本次改变了什么

只在独立实验入口新增 `--jev-judge-from`。对象匹配后，使用 OpenRouter `typesafe/jev-1.13` 判断当前刺激与一条冻结认识是否相关；角色模型继续使用本机 Gemini 3.7 Flash。

请求经 `POST https://openrouter.ai/api/alpha/decisions`，使用 `state + questions + criteria`，返回 RELATED / UNRELATED / UNCERTAIN。只有 RELATED 准入；UNCERTAIN 允许不交付但单独留在 trace，接口失败直接失败，不伪造成不相关或角色弃权。一次有界请求，不自动重试。接口形态参考 [OpenRouter 官方教程](https://openrouter.ai/blog/tutorials/how-to-use-jev/)。

密钥从进程环境或 Windows 当前用户环境的 `OPENROUTER_JEV_KEY` 临时读取，不写入文件、不输出值。trace 不含请求认证头。

与上一轮 Gemini 不同，JEV 返回选择和概率，不生成解释、字段归因或引用片段。没有伪造这类解释来凑齐旧协议。判定结果只用于候选准入；角色最终看到的仍是原认识正文、来源和时间，不看到 JEV 标签、概率、判断指令或检索字段。概率和 confidence 均不是认识的可信度，也没有据它们调门槛。

## 2. 冻结条件与边界

复用 `.tmp/observation-applicability-20261004-v1` 的完整 build 和 applicability，不重新 retain 或生成投影。与上一轮有效 Gemini 对照目录 `.tmp/observation-facet-judge-20261004-v2` 核对：

- 档案、原索引、认识正文、证据、适用性字段完全一致。
- 五个查询、两种判断器实际接收的刺激／认识／字段，以及最终交付内容一致。
- 本轮 27 个角色请求与上一轮各对应请求逐项相等，变化只在模型抽样返回。
- 当前刺激没有记忆提醒；旧观察和自我观察为空；所有分组同样禁止再次 recall。
- Source 六字段映射继续核验；私密“雪青密码”没有进入该角色请求。
- 不修改正式 Memory schema、World State、Event Log 或 Rulebook。试验副本的合法动作仍由现有规则裁定提交，原历史库未改变。

认识仍是：

> 【主观认识，可修正】旅人在初次前往或陌生的场所容易参考旧材料指路导致跑错位置，但在熟悉的常去场所能够准确指引目的地。

第 15 tick 整理，第 55 tick 测试，相隔 40 tick；证据末尾为第 13 tick，实际交付 age 为 42。这里的历史是 55 个已提交的人工经历 tick，不是 55 回合连续真实模型试玩。

**候选是事先指定的一条认识。** 它经过自动对象门槛、JEV 判断与现有 Delivery 后才交付，没有强行注入角色。但这还没有测大记忆库中如何廉价发现和排序许多候选；通过准入后的候选排序仍沿用原分字段检索分数。

## 3. 实际调用结果

请求模型 `typesafe/jev-1.13`，12 次均返回构建 `typesafe/jev-1.13-20260917`。先每个合格查询调用一次并进行行为实验，实验结束后各追加两次相同输入，追加结果不用于回头修改行为实验。

| 刺激 | JEV 三次判定 | RELATED 概率范围 | 实际交付 |
| --- | --- | ---: | --- |
| 第一次来，旅人带路去登记 | 三次 RELATED | 0.89–0.90 | 原认识 |
| 初次到达，旅人说看过介绍并带去等候点 | 三次 RELATED | 0.92–0.93 | 原认识 |
| 常来地点，旅人带路 | 三次 RELATED | 0.99 | 原认识 |
| 同一旅人聊杂志 | 三次 UNRELATED | 0 | 空 |
| 陆舟带路，其他内容与第一项相同 | 未调用 JEV，对象门槛拒绝 | — | 空 |

熟悉地点是认识中的例外，相关是合理结果；验收看它是否导致错误的不信任。另一人物对照只验证确定性对象门槛，不能记为 JEV 的分类能力。

12 次 JEV 总费用按 API usage 为 **$0.000409752**，不包含角色调用；合计 9,756 输入 token、546 输出 token。本机实测端到端耗时中位数 **674 ms**，范围 647–941 ms，包含网络往返。未比较 Gemini 判断器的价格和延迟，不声称倍数优势。

## 4. 首次自主选择

三种条件分别重复三次：有认识、无认识 A、无认识 B。共 27 次真实 Gemini 返回，27 次均通过宿主输出校验，6 次 move 被规则接受并提交；其余 21 次 publish。以下为非盲阅读，属于探索性描述。

| 场景 | 有认识，3 次 | 无认识，合计 6 次 |
| --- | --- | --- |
| 第一次去登记 | 3 次答应同行并提醒留意指引／避免走错 | 6 次直接答应，无上述提醒 |
| 初次去等候点 | 3 次先问介绍是否最新，0 次移动 | 6 次直接提交移动 |
| 常来地点 | 3 次正常答应，无错误怀疑 | 6 次正常答应 |

等候点的一次真实回应：

> 你看的介绍是最新的吗？第一次来的地方可别又照着旧材料走错了。

当前刺激只说“看过介绍”，没有提示旧材料风险，也没有要求询问资料。JEV 没有提供行为建议，角色自行从认识形成了这个回应。

第一项有认识时仍然答应同行，因此这不是把某种认识硬编码为拒绝行为。熟悉地点全部自然答应，也没有把“陌生地点风险”泛化成“这个人永远不可靠”。

这里只测首次选择，未测试询问得到回答后的后续行为。move 结果中的 budget_exhausted 是单次模型预算结束，已核对 accepted 的 action.resolved 与 character.moved，不算移动失败。

## 5. 验证与限制

通过类型检查、入口 oxlint、3 项 JEV 传输／解析测试、21 项原投影／交付测试。只读审计通过；错误角色、篡改 Source 哈希、篡改字段向量、选择标签与 related 冲突四种负例均被拒绝。审计使用缓存判定，禁止新的模型调用。

原始数据位于 `.tmp/observation-jev-judge-20261004-v1`。仓库内保留 [可复核摘要](../observation-jev-assessment.json)，包括完整授权认识、逐点判定、重复概率、27 个角色返回和审计结果。

本轮没有完整回归、正式网页集成、多认识竞争、更多难负例或新的连续长试玩。三次相同分类也不等于分类器长期稳定；这些概率没有校准意义。本次结果支持继续把 JEV 作为适用性判断器候选，下一步优先在自然试玩中检查多条认识的选择和误触发，暂不修改认识本体或推演新的认识生命周期。

## 6. 复现

输出目录必须是新的。冻结目录需要原 build、applicability 及原刺激上下文。

```powershell
node --import tsx tests/experiments/observation-choice.ts .tmp/my-observation-jev --jev-judge-from .tmp/observation-applicability-20261004-v1
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/audit_observation_facet_match.py .tmp/my-observation-jev
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/jev_applicability_stability.py .tmp/my-observation-jev
```

稳定性脚本再增加八次 JEV 调用，不调用角色模型，不重新决定先前行为实验的交付。
