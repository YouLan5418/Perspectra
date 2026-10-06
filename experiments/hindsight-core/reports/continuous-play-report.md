# Hindsight Core 真实连续试玩与追踪报告

| 属性 | 内容 |
|---|---|
| 日期 / 分支 | 2026-09-30 / `codex/hindsight-core-experiment` |
| 实验工作树 | `D:/DeepSeek Harness/perspectra-hindsight-core`；未修改 Perspectra V1 主工作树 |
| 模型 | 本机 8045，`gemini-3.7-flash`；向量在本地 ONNX CPU 编码 |
| 主轨迹 | `.tmp/hindsight-continuous-20260930-v3`，120 个真实玩家提交回合 |
| 保留的前轨迹 | `.tmp/hindsight-continuous-20260930-v2`，50 回合，因房间重入机制干扰停止 |
| 实际角色模式 | 图/向量 Core Recall + Observation；现有和关键词召回仅作 shadow 基线 |
| 人工阅读 | 实施者检查具体调用和原文，非独立评审；见 `continuous-assessment.json` |

## 1. 结论

`retain → fact/representation → recall → observation consolidation` 已在同一世界的 **120 回合真实连续交互**中运行，调用前后的追踪能对应到授权原文与真实行动提交。没有预写记忆剧情、按回合注入的考题或期待答案。

这轮最明确的适配问题发生在**内容压缩**：retain 会丢失转述限定，甚至添加原文未证明的行为施事者；Observation 沿用这些 fact。角色内授权映射仍然正确，不能据此认定正文语义忠实。图扩展确实参与召回，也带来泛实体和旧动作记录的噪声。

已经出现长期召回与实际 NPC 移动同在一个回合的例子，但当前刺激本身足以解释动作；**没有行为 A/B，不能声称 Observation 或图检索产生了独立行为收益。** 暂时保留实验核心与 trace，不把派生内容写入权威世界，不迁移正式 Memory schema。

## 2. 实际规模

| 指标 | 120 回合主轨迹 |
|---|---:|
| 玩家移动 / 物品交互 / 表达提交 | 30 / 24 / 66 |
| 玩家重要行动与表达被规则接受 / 拒绝 | 119 / 1 |
| 自然私聊 | 1 |
| NPC 调用尝试 / 收到返回 / 未返回 | 137 / 135 / 2 |
| NPC abstain / publish / perform 返回 | 84 / 49 / 2 |
| 含长期召回的调用 / 含 Observation 的调用 | 102 / 58 |
| 实际 NPC 移动 / 发布表达 | 2 / 49 |
| 没有 NPC 调用的玩家回合 | 58 |
| 单独记录的空 Scene 创建提交 | 18 |
| 最终世界 tick | 189 |

最终角色内来源数分别是林晓 61、沈南 76、周姨 60；各自产生 40 条 fact、25/8/13 条 Observation。这些是角色派生材料数量，不能当成权威世界事实或稳定认知数量。NPC 没有选择主动 recall；上述长期结果来自调用前注入。

50 回合前轨迹另有 121 次 NPC 返回。两条轨迹合计 170 个玩家回合，**不是同一条 170 回合轨迹**。更早 1 回合的启动失败只作冷记忆缺陷证据，不并入主轨迹。旧的人工历史行为试验也不并入这些回合数。

## 3. 自然试玩方法与覆盖

世界是普通借宿驿站：4 人、5 个房间、8 件可取放转交物品。玩家模型只自行处理安顿、休息、阅读、泡茶和人际相处，获得玩家视图、可见状态、现有交互与自己的短笔记。人物仍经真实 Character Turn 自主决定表达、沉默或行动，执行经现有规则提交。

移动、取放物品、邀请、分开、重逢、改变日常安排、私聊与喝茶约定均自然发生。私聊只有一次；没有充分的失约、误解修正、矛盾长期认识或近名人物重复事件证据，没有为补齐覆盖而编剧情。多人同场喝茶不等于覆盖了复杂的相似人物事件辨认。

58 个回合没有 NPC 调用，大部分是独处、睡眠或阅读；也保留了重复闲适表达。普通小世界没有离开驿站的玩法，人物没有相互冲突的具体任务，后段较平静。回合数变长没有自动形成高干扰历史，不能据此宣称长期认知已经得到全面压力验证。

每 5 个玩家回合只从各角色 `CognitiveMemoryService` 命名空间更新来源。当前角色已经完全看见于近期观察/自身观察的材料从长期候选中排除。向量、BM25 和实体/语义图参与 RRF；没有自动猜测日历或 tick 窗口，普通调用的 temporal 臂为空。时间展示是来源获知 tick 与距今 tick，多来源归纳同时保留每条来源年龄；不是现实时间或所述事件的发生时间。

现有召回与关键词 Core 保存为 shadow，未决定角色行为；它们也不能当成候选预算完全相同的检索评分对照。

## 4. 可以逐步核对的行为

### 4.1 初次同行：不能误算为长期记忆收益

玩家在第 15 回合邀请沈南去院子，第 16 回合自己离开。[沈南的实际调用](<D:/DeepSeek Harness/perspectra-hindsight-core/.tmp/hindsight-continuous-20260930-v3/traces/turn-0016-call-002-friend.json>)在 tick 26 返回 `perform move location:courtyard`，随后 tick 27 提交 `character.moved` 与 accepted `action.resolved`。

该调用长期召回为空、没有 Observation，近期邀请就足以支持跟随。角色移动是真实执行，长期记忆收益没有被证明。

### 4.2 旧约定、私聊与实际移动同时出现

第 74 回合沈南说“待会儿茶水间见”。第 91 回合玩家告诉他公共厅有人在喝刚泡好的茶；第 92 回合玩家私下催促“快去吧，水还热着呢，慢慢喝”。

[第92回合沈南的实际调用](<D:/DeepSeek Harness/perspectra-hindsight-core/.tmp/hindsight-continuous-20260930-v3/traces/turn-0092-call-001-friend.json>)在 tick 143 选入 `obs:5`，含以前喝茶约定，来源最新 tick 115，距今 28 tick；最旧来源 tick 19，距今 124 tick。该归纳的 semantic/BM25/graph 排名是 1/7/6，完整图路径与原文可回溯。模型提出去公共厅，随后真实提交从院子到公共厅的移动，并获得其他角色回应。

这证明旧材料实际进入了重要行动回合，不能证明旧约定独立促成行动；当前催促与近期通知同样足够。这里没有把检索路由描述成模型内部的理由。

[私聊来源核验](<D:/DeepSeek Harness/perspectra-hindsight-core/.tmp/hindsight-continuous-20260930-v3/private-source-audit.json>)确认私聊原句对应的观察与记忆来源只在玩家、沈南命名空间；林晓、周姨随后处理沈南到来时的输入没有私聊原句。沈南公开表达“听说有茶”是他自主分享的已知信息。这是一次自然私聊的具体证据，不是所有语义泄漏的证明。

## 5. 记忆内容的两个真实问题

### 5.1 转述限定在 retain 时就消失

沈南的 `event:234`、knownTick 37、`reported_speech` 原文明确是玩家说：

> 我刚才去门廊那边瞧了一眼，视野挺好的，架上还备了雨伞。

retain 得到 `fact:event:234:0`：“门廊视野良好，且架子上备有雨伞”；随后 Observation `obs:7` 沿用这个表述。[第74回合调用](<D:/DeepSeek Harness/perspectra-hindsight-core/.tmp/hindsight-continuous-20260930-v3/traces/turn-0074-call-001-friend.json>)实际选入了这条 Observation。六字段映射与 reported_speech 仍完整，但正文没有保留“旅人说过”。这不是跨角色读库，属于授权信息的语义压缩失真。

### 5.2 呼唤对象被写成了准备茶的人

林晓 `event:938`、knownTick 175 的原文是玩家说“周姨，这茶温着正好，喝着真舒服”。retain 产生 `fact:event:938:1`：“旅人在客房翻阅后到大厅喝周姨准备的温茶”，再进入 `obs:25`。原引用是精确子串，却不能证明“周姨准备”。第 82 回合玩家曾公开表示是自己刚泡的茶；没有“周姨另泡了这批茶”的新证据。

这条归纳在实验记忆银行中形成；**本轮后续调用未选入 obs:25，没有看到由它造成的错误行动。** 最终原文、fact、Observation 可在[林晓的实验记忆](<D:/DeepSeek Harness/perspectra-hindsight-core/.tmp/hindsight-continuous-20260930-v3/memories/companion/prepared.json>)核对。两例均定位到 fact 抽取阶段，不能只修 consolidation。

## 6. 图召回和 Observation 的限制

[第27回合林晓的调用](<D:/DeepSeek Harness/perspectra-hindsight-core/.tmp/hindsight-continuous-20260930-v3/traces/turn-0027-call-001-companion.json>)是腰酸、休息的闲聊，却选入早期取旅行包、驿站设施和初次见面的记录；这些通过语义与图臂参与排名。模型仍正常回答“嗯，歇着吧”，所以确认的是召回噪声，尚不是错误行为。共同人物 ID、泛实体与序列化动作内容使图覆盖广；RRF 提高候选相对排名，不保证绝对相关性。

最终林晓的 25 条 Observation 仍有许多单次事件复述；沈南的 `obs:5` 则增长为跨 25 条来源、tick 19–180 的长事件串。多来源不自动等于可修订的稳定人物认识，本轮也没有强矛盾证据去验证认识修正。普通上下文还带着实验排名等元数据，这不是最终产品呈现形式。

## 7. 非记忆因素与失败均保留

前轨迹第 26 回合后出现反复往返、无法取放物品。原因是房间最后一人离开后旧 Scene 关闭，再次进入没有新的 Scene；现有交互要求场景交集。玩家短笔记甚至自述“已经归还”，但没有对应物品转移事件。这条 50 回合轨迹完整保留，不解释为 Hindsight 失败。

主轨迹的实验宿主在完成回合之间用现有 `scene.created` 建立新的空 Scene。正常移动才加入成员，不预设人物行为；获取/释放正式 WriterLease 后短提交。没有改正式 Rulebook、World State、Event Log schema 或 Memory schema，没有把记忆内容写成场景或世界事实。18 次宿主提交单独记录，也产生世界 tick，不冒充玩家回合。正式产品的房间重入仍未在本次修改中修复。

主轨迹还保留：第 63、70 回合激活周期被打断，2 次调用没有收到返回；使用的现有周期上限为 30 秒，没有伪造 abstain，也没有重放玩家输入。第 72 回合 Gemini 返回不在工具枚举中的 `scope:direct`，Rulebook 拒绝，未发布给 NPC；下一回合玩家自然重新表达。第 110 回合提交后一次 consolidation 请求失败，原控制台错误被截断，不能确定具体网络/HTTP状态；安全重试检查点后成功完成。后续失败记录现在保存请求与 stderr 尾部。

启动阶段还修复了“全部近期来源被排除后空 embedding 矩阵维度不符”的实验缺陷。暖向量进程复用 ONNX 权重，角色来源、索引和缓存仍隔离；Hindsight retain/vector 核心没有世界库句柄。

## 8. 验证与产物

根与实验 TypeScript 类型检查、相关 oxlint 通过；冻结运行时/场景重入 **9 个集成测试**通过；Python 核心/向量 **12 个测试**通过。租约冲突不提交、正常释放、空 Scene 不改角色位置和物品归属、再次移动后 drop 均有实际规则路径断言。未运行全量历史回归或覆盖率门禁。

[完整统计与来源核验](<D:/DeepSeek Harness/perspectra-hindsight-core/.tmp/hindsight-continuous-20260930-v3/trace-summary.json>)只读核对 cognitive namespace 与世界 tick 数据库，检查精确六字段来源映射、角色/世界前缀、获知 tick、记忆年龄、RRF 排名贡献以及最终模型输入一致性。核心权限单测和自然私聊提供对应证据，不能当成自由文本语义永不越权的证明。

每次调用的 JSON 包含 `currentStimulus → query/selected/retrieval → hasObservation → deliveredRequest/modelCall → modelResponse → roundOutcome.actionEvents`。`sourceId/sourceHash/epistemicKind/worldSeq/characterId/worldAddress` 与完整原文、knownTick 逐项保留。召回图路径是候选展开路径，是否影响最终融合应同时查看 sourceRanks；它们不能证明模型内部决策因果。

```powershell
.tmp/hindsight-vector-venv/Scripts/python.exe experiments/hindsight-core/trace-summary.py .tmp/hindsight-continuous-20260930-v3
.tmp/hindsight-vector-venv/Scripts/python.exe experiments/hindsight-core/trace-view.py .tmp/hindsight-continuous-20260930-v3 --id turn-0092-call-001-friend
```

## 9. 能力取舍

保留角色内来源出口、真实向量/图/RRF实验能力、获知 tick 和完整 trace。下一项有直接证据支持的适配是 fact/Observation 中的说话者、报告限定与行为施事者对应，先在实验目录解决并用这里的原句回归，不扩展正式架构。

行为收益应利用真实轨迹保存的同一授权刺激与来源前缀，比较现有记忆、Core Recall、Core Recall + Observation；不要把本轮 shadow 结果算成已经完成行为对照。归纳忠实度和真实行为收益得到验证以后，再决定原生重写哪些部分。暂不增加更多检索机制来掩盖已经定位的内容失真。
