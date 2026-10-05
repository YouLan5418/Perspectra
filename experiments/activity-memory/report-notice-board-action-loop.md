# 自主获取证据与认知更新闭环实验

日期：2026-10-05。

**部分闭环通过，完整长期闭环未通过。** 角色确实会自主提交 `ask_staff`，Rulebook 接受后取得真实提交的角色私有发言来源，并接入既有 `cognition_lineage.update`。但8次无关互动后的自然初筛拒绝了全部认识，JEV 没有收到候选，修订认识没有交给角色。因此本轮不能证明“修订认识影响了未来实际行动”。

## 1. 冻结内容与实验范围

保留两块牌子的原文字：大厅公告牌“登记处：二楼203”、窗口指示牌“登记处：一楼105”。原读取 Capability 的代码、ID、裁定与私有来源规则不变；复用上轮三个种子的认识正文，逐字不改；成组阅读继续使用原 `inscriptionReadings`。

新增内容只在实验文件中：两个获取证据的交互、工作人员与终端、两个可实际移动的目的地及实验驱动。正式 `packages/`、Memory schema、Rulebook实现、JEV协议、排序、门槛、Delivery和Evidence Group发现机制没有修改。

新增交互需要被锁定的实验 Manifest 选择，因此新建世界数据库。没有改历史数据库的 Manifest，也没有把旧引用塞进新世界：在新实验世界中通过原 Rulebook 实际读取两块牌，再将冻结认识的证据引用映射到这些新提交来源。最初这6次读取由实验脚本安排，**不计自主行为，也不是新模型调用**。旧认识的正文与支持／反驳关系保持不变，来源引用和实验时间使用新前缀；这不是字节相同的旧数据库重放。

现有实验 fixture 仅增加可选 `extraPackages` 参数；旧调用默认行为不变。没有改变原牌子的能力实现。

## 2. 选择与验收

正常 `Character Turn` 的首次请求允许 perform、publish、abstain。玩家只问：

> 那我们接下来怎么办？

模型契约仍为原来的“自己决定是否回应、如何行动”，未增加“必须核实”的提示。

真实可选项：

| 选择 | 执行后得到什么 |
| --- | --- |
| ask_staff | 包内可信工作人员脚本返回发言：“我记得登记处在二楼203，不过我这周还没去过。”；Source为reported_speech |
| inspect_terminal | 实际读取终端显示：“登记业务受理：一楼105；本页未标明更新时间。”；Source为direct_observation |
| move location:203 | 真实移动到“二楼203”；不自动裁定登记处在那里 |
| move location:105 | 真实移动到“一楼105”；不自动裁定登记处在那里 |

原公告牌读取和隔壁小屋等原生选项也保留，没有剥夺其他选择。工作人员是可信交互脚本的回应，不是另一次工作人员LLM调用。它确实在交互成功时生成发言经历，但其说法的真实性没有被宿主背书。

只把以下链路计为实际获取证据：

`原生perform/interact提案 → Rulebook accepted → 同一事务提交action.resolved与专属observation → CognitiveMemoryService捕获Source`

对白中建议问人、查看或前往均不计为执行。新证据只进入行动角色的授权前缀；其他角色以后听到其转述，仍是发言来源。

## 3. 18次初始选择

三种记忆交付 × 三份短历史 × 每份两次采样，顺序轮换。每份历史中，去掉memories后的首次模型请求完全一致。recent observations和self observations均保留最近4条，这是所有组共享的实验上下文窗口；没有将其冒充上轮即时continuation的同一请求。 本轮updated阅读项保留正文、来源、family标志和证据相对年龄，未携带上轮即时续写中额外显示的形成／修订时间字段；这也限制了与上轮的直接比较，不能声称两轮只改变了是否允许perform。

| 交付 | 实际询问工作人员 | 实际读取终端 | 实际前往203/105 | 只提交对白 |
| --- | ---: | ---: | ---: | ---: |
| raw-evidence | 3/6 | 0/6 | 0/6 | 3/6 |
| paired-evidence | 1/6 | 0/6 | 0/6 | 5/6 |
| updated-cognition | 5/6 | 0/6 | 0/6 | 1/6 |

其余9次确实都意识到了两处牌面的分歧，并建议问人或查终端，但只提交了publish。例如：

> 大厅公告牌写着二楼203，窗口指示牌却写着一楼105，两边写的不一样。要不我们直接问问工作人员，或者查查办事终端？

这不是执行失败、非法输出或abstain，而是模型选择先向玩家提出建议。程序没有替它问人。

这轮**不支持paired evidence提高实际核实率**。updated组在此小样本中实际询问更多，但只有三个短历史、每份重复两次，不能将5/6与1/6当作稳定概率或统计显著的额外收益。不能把前轮6/6表达保留分歧外推为行动6/6。

## 4. 新来源接入既有更新

9次自主询问均取得新的reported_speech Source，并成功接入既有更新：

| 返回关系 | 次数 |
| --- | ---: |
| reinforcement | 5 |
| refinement | 1 |
| unresolved_conflict | 3 |
| counterexample | 0 |

更新收到的是两份原牌面证据加该次真实工作人员发言。并未输入预期关系、当前刺激或行为建议。支持、反驳引用和原始Source/Atom/Episode保持不变；旧版本留在sidecar。

一个refinement结果：

> 根据大厅公告牌的记录及工作人员的陈述（工作人员提及本周未去过），登记处可能在二楼203；但另一处公告牌写着登记处在一楼105，两处信息仍存在冲突，尚未核实何者属实。

9条输出正文均保留分歧，没有把工作人员回答升级为“登记处已确认在203”。结构校验通过仅证明来源和引用合法；强化／修订分类没有独立gold判定，同类发言在不同调用中返回不同关系，不能声称分类已稳定。

这里接受一个现有实现限制：`update`接收一条canonical Observation，而非一个多分支家族。本轮固定以第一分支作为输入，检查它确实引用两块牌的全部支持／反驳证据，全部原证据仍送入更新。另一旧分支保留历史追溯；没有加入新的分支合并器。**这不是完整多分支家族更新已经实现的证明。**

另一个现有元数据问题也保持原样：6个reinforcement/refinement结果正文仍写“存在冲突”，但`hasUnresolvedConflict`为false，因为现有函数只在relation等于unresolved_conflict时置true。没有因此删除反驳来源，但不能把这个布尔值当作冲突已经消失。本轮记录问题，没有顺势改Observation机制。

初始形成／修订tick是新fixture中赋予认识的实验时间，形成假定发生在首次读取之后，修订对应第二次读取；它们不是对原角色何时“意识到”的测量，也没有作为新近程度加权。更新发生tick与证据knownTick分别记录。

## 5. 延迟后的自然检索与实际行动

每个初始交付组，预先规定沿用**第一条确实获取新证据的轨迹**，不按认识生成质量或未来行为筛选。三条轨迹各推进8次无关玩家发言与真实NPC回复，涉及外套、薄荷、电影、做饭等。24次NPC都选择publish，没有额外取得牌面、工作人员或终端来源。

之后玩家问：

> 今天又来这栋办事楼，想给另一份材料办理登记。接下来怎么办？

这是一项新的登记任务，仍在同一大厅；世界没有离开／回返事件，玩家所说“又来”只属于发言。本轮不是跨建筑泛化，也不以这句话提交新的时间或位移事实。未来选择前tick为25，旧核实来源tick为7；旧牌面和工作人员Source已不在最近观察或自我观察窗口里。

每条轨迹用同一已提交前缀比较：

- current-cognition：修订后的认识参与自然检索；
- prior-cognition：原来的两条认识参与自然检索；
- no-cognition：仅历史证据参与检索。

三组共享相同历史证据，查询由当前刺激生成；没有塞入203/105、Source ID、family ID或指定目标。使用既有通用Retrieval Projection、E5/BM25等初筛，然后准备接现有JEV和Delivery。局部牌面认识此前没有独立适用性投影；本轮未生成新Trigger字段，也未套用需要人物subject匹配的Bank Trigger或优化检索。这个范围必须与以前有Applicability Projection的20条Bank实验区别开。

结果：

| 项目 | 结果 |
| --- | ---: |
| 未来正常选择 | 9 |
| 认识进入JEV | 0 |
| JEV实际调用 | 0 |
| 认识最终交付 | 0 |
| 任意记忆最终交付非空 | 0 |
| 实际读取终端 | 1 |
| 实际重读大厅公告牌 | 1 |
| 其余只提交对白 | 7 |

断点明确发生在初筛。三条轨迹的current认识余弦约0.891–0.895，但semantic lift约0.081–0.122，词项覆盖约0.001–0.029，均不满足冻结的lift≥0.30或覆盖≥0.15准入。查询不是纯标点，也未被跳过；没有必要把它归因于JEV拒绝或Delivery挤占。

全部未来memories为空，审计确认每条轨迹的三组**最终模型请求完全相同**。所以“current组重读了牌、no-cognition组读了终端”等差异来自同请求采样，不能当作认知更新的行为收益。不能根据组名说current已真正读到修订认识。

这两次后续真实读取也产生了新的direct_observation Source，并在`--finalize`阶段接回既有update：终端读取返回unresolved_conflict；重读同一块大厅牌返回reinforcement。重读只是又一次看见相同内容，**不是一个独立的信息源**；不能将它计为独立证据印证。没有为了让实验成功而改初筛或强行交付目标。

## 6. 验证与成本

新增真实调用总计73次：

- Character：62次 = 初始18次选择+9次执行后续写+24次无关回复+未来9次选择+2次执行后续写；
- cognition update：11次 = 初始9次+未来2次；
- JEV：0次；
- 初始化脚本读取、索引嵌入和请求预览不计入上述模型调用。

62次Character请求均返回，网关响应标签为`gemini-3.7-flash-high`，请求名为`gemini-3.7-flash`。Character usage：prompt 168033、completion 5008、total 214270；total可能包括隐藏推理，未将它等同prompt+completion。未作价格估算。

通过类型检查、局部oxlint、53项相关TS测试、6项既有认知更新Python测试，以及独立只读审计。审计核对原模型返回、perform参数、accepted结果、同事务Source、角色私有引用、旧前缀不可变、认识正文冻结、查询上下文一致和后续空交付。1180行审计来源包含克隆历史，不是1180条独立经历。

对应失败路径已测：对白不触发能力、伪造参数拒绝、位移后的旧选项拒绝、事务失败同时回滚行动与证据。原公告牌和continuation相关测试也通过。

未运行全量check、UI和长期连续试玩；没有验证多人自主工作人员调度、跨建筑迁移、大库检索或真实登记处真值。

## 7. 本轮结论与产物

已经验证：角色可以在无核实指令时自主获取世界能力提供的证据，真实Source能够进入认识更新。没有验证：该修订认识之后能自然返回角色上下文，并改变新的实际行动。

按本轮范围，保留“初筛前断链”这一结果，暂不恢复Observation、JEV、排序或Evidence Group发现优化。不应把“功能路径能提交并更新”报告成“长期认知行为闭环通过”。

实现与输出：

- 实验能力与世界：`tests/experiments/notice-board-action-fixture.ts`
- 驱动：`tests/experiments/notice-board-action-loop.ts`
- 已授权来源桥接：`notice_board_action_loop.py`
- 独立审计：`audit_notice_board_action_loop.py`
- [逐项结果与限制](notice-board-action-loop-assessment.json)
- 原始产物：`.tmp/notice-board-action-loop-20261005-v1`，包含所有原生请求／响应、SQLite、事件、Sources、revision、自然召回trace和audit。

复现时必须使用新的输出目录：

```powershell
node --import tsx tests/experiments/notice-board-action-loop.ts .tmp/my-action-loop --prepare
node --import tsx tests/experiments/notice-board-action-loop.ts .tmp/my-action-loop --run
node --import tsx tests/experiments/notice-board-action-loop.ts .tmp/my-action-loop --finalize
python experiments/activity-memory/audit_notice_board_action_loop.py .tmp/my-action-loop
```
