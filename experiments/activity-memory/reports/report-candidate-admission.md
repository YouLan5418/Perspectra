# 6.1 候选入口实验（2026-10-05）

| 属性 | 内容 |
| --- | --- |
| 范围 | 简化方案6.1；仅实验入口，不接正常网页 Memory |
| 正式数据 | `.tmp/memory-candidate-admission-20261005-v2`，`audit.json` 与 `dialogue-review.json` |
| 预检数据 | `v1`只含旧三条取证Source；仅准备材料，无Character调用，不并入正式比较 |
| 轨迹 | 原双牌闭环三条已提交轨迹，各经过八次无关互动 |
| 对照 | 原候选门槛 / 原候选并入明确授权ID关联项；其余检索分数、JEV和Delivery不变 |
| 模型 | 请求`gemini-3.7-flash`，响应`gemini-3.7-flash-high`；JEV沿用`typesafe/jev-1.13` |
| 调用 | 24次首步选择，35次Character调用，9次JEV材料准备调用；无选择性重试 |
| 状态 | 候选断点修通；认识阅读和延迟行为闭环尚未通过 |

## 1. 实际问题与最小改动

原实验的认识初筛需要semantic lift或词项覆盖达标。即便认识明确引用眼前公告牌的证据，登记刺激也不能让它进入候选。本轮新增`candidate_admission.py`：保留原候选，并允许授权对象、地点、当前说话者和已有活动ID的明确关联进入候选。

ID来自当前授权Context和原Query，认识ID、203/105及答案不注入Query。角色自身不是通配seed；显式对象话题不再打开整个当前场景的其他对象。仅复用原表示中的实体/活动关联，无家族自动扩展，无新语义模型。新准入项保留原数值诊断，不伪造RRF票；按原relevance、已有融合分和ID排序，最多32项。atomScores中的准入标记同步保留原门槛结果，供原Delivery选择证据回退。

这一步替换的是“只有原语义/词项门槛才能进入”的限制，并没有删除旧检索、JEV或Delivery，也没有减少嵌入处理次数。

## 2. 冻结与样本

预检发现旧Memory档案只包含三条Capability取证Source。八次无关互动在世界历史中，却不在检索池中。正式v2向两臂同时补入完整宿主授权历史：登记案例31条Source，两个负控各32条；新增Source只按原方式生成Atom/Episode，原三条证据及当前认识正文保持原样。因此v2的原路径历史候选不再为空，不能直接与6.0的三Source档案作行为收益比较。

八次无关互动的16条玩家/NPC发言确实参与两臂检索。其他历史单独统计，不把所有非取证Source都称为噪声。旧互动中的NPC发言有时已经混入登记旧事，这些原文不清洗。

三个刺激分别是：

- 登记：原已提交后续问题“今天又来这栋办事楼，想给另一份材料办理登记。接下来怎么办？”；每轨迹、每臂两次Character样本。
- 同对象无关：“只说大厅公告牌 entity:hall-board 的装饰边框。你觉得好看吗？”；每轨迹、每臂一次。
- 不同对象：“只说办事终端 entity:registration-terminal 的外观设计。你觉得好看吗？”；每轨迹、每臂一次。

负控通过真实玩家提交产生新的授权刺激，使用当前可见对象ID，不提交目标认识ID或答案。负控仍保留先前登记问题于recent上下文，因此出现登记旧话题不能唯一归因于Recall。

两臂同一案例的前缀、非Memory请求、模型、Capability、recent窗口和调用预算相同。Delivery仍最多3项、4500 JSON字符；Character每次激活最多2次调用。禁止隐式原生关键词检索和主动recall，不在激活中更新认识。每案例/臂仅准备一次JEV结果，Character重复样本复用；没有验证JEV的重复稳定性。

## 3. 候选 → JEV → 实际阅读

| 刺激 | 原路径目标认识入池 | 新入口入池 | JEV | 认识正文交付 |
| --- | --- | --- | --- | --- |
| 登记，三轨迹 | 0/3 | 3/3，排名13、13、11 | 新入口3/3 RELATED | 两臂均0/3 |
| 同对象装饰，三轨迹 | 3/3 | 3/3 | 两臂均3/3 UNRELATED | 两臂均0/3 |
| 不同对象设计，三轨迹 | 0/3 | 0/3 | 未送审目标认识 | 两臂均0/3 |

登记的新入口实际让认识进入候选，JEV也接受。下游仍有两次拒绝：

1. 原Delivery要求支持原子全为直接观察或已接受行动；支持证据含工作人员发言，认识正文被压住，转原始证据回退。
2. 回退证据与必要反证成组保留，因前面候选已占预算而整组不读。三条轨迹均留下`unverified observation summary suppressed; original evidence fallback`与`budget; original evidence and counter-evidence kept together`。

这不是JEV拒绝，也不能算认识已经被角色阅读。正文及回退组都没交付，不是“交付完整认识后丢掉反证”。独立原始牌面证据在部分负控仍可交付；JEV只审认识，不能阻止同对象的原始证据。

登记的raw-evidence、paired-evidence两条轨迹，两臂最终Memory完全相同。updated-cognition轨迹多交付了一条旧历史材料，仍没有认识正文；该轨迹对白差异不能归因于认识。

## 4. 噪声与角色体验

| 刺激 | 原路径候选数（各轨迹） | 新入口候选数 | 原路径无关互动候选数 | 新入口无关互动候选数 |
| --- | --- | --- | --- | --- |
| 登记 | 12 / 12 / 6 | 32 / 32 / 32 | 0 / 0 / 0 | 8 / 7 / 11 |
| 同对象装饰 | 7 / 7 / 5 | 32 / 32 / 32 | 2 / 0 / 0 | 15 / 12 / 12 |
| 不同对象设计 | 4 / 2 / 2 | 32 / 32 / 32 | 2 / 0 / 0 | 14 / 14 / 14 |

候选数以Memory项计；同一Source可有Atom与Episode，不能解读成独立事件数。新入口的当前说话者关联会准入较多旧发言，仍不够窄。登记两臂都没有最终交付八次无关互动材料；负控中的部分旧发言实际交付，Source明细见audit。

逐条人工读完35个返回决策，包括11次执行续写：装饰/外观意见与细小姿态属于允许的叙事自由。负控中原路径2/6、新入口1/6出现登记话题侵入，不据此声称改善稳定。例子：updated-cognition的不同对象设计、新入口回答外观后又问“你是想先去一楼105看看，还是直接去二楼203？”；原路径的同对象装饰也有相同转题。

| 刺激 | 原路径真实取证 / 首步选择 | 新入口真实取证 / 首步选择 |
| --- | --- | --- |
| 登记 | 4/6 | 4/6 |
| 同对象装饰 | 1/3 | 0/3 |
| 不同对象设计 | 1/3 | 1/3 |

仅Rulebook接受、`action.resolved`实际提交并在同事务生成Capability Source才计取证；publish中的建议不计执行。登记的八次实际取证均读取大厅公告牌，随后推荐203，没有继续读终端或问人。新读取证明牌面写203，不能据此认定与旧105材料的冲突已经解决。updated-cognition的新入口两次提出核实建议，均未实际执行。

## 5. 用量与等待

| 项目 | 原路径 | 新入口 |
| --- | --- | --- |
| Character调用 | 18 | 17 |
| 提供商prompt_tokens | 49,944 | 48,646 |
| completion_tokens | 1,402 | 1,323 |
| total_tokens（原样记录） | 63,843 | 61,605 |
| 12次角色激活累计耗时 | 90.893秒 | 88.639秒 |
| 9个案例/臂材料准备累计耗时 | 39.470秒 | 20.868秒 |
| JEV准备调用 | 3 | 6 |
| JEV累计等待 | 4.185秒 | 4.891秒 |

JEV准备共9次，其usage中的input/output/cost保留在audit；Character未返回可核实价格，不报告整段费用。total_tokens按提供商原值保存，不把prompt与可见completion相加冒充总量。

材料准备存在缓存/暖机与固定臂顺序，Character重复样本复用准备结果；两臂调用数还受真实行动分叉影响。这些耗时不能证明新候选入口更快。当前阶段仍使用原评分，不是无模型的直接检索。

## 6. 验证、取舍与下一步

已运行：`corepack pnpm@11.7.0 check`，27个文件、184项测试通过；最后的入口元数据调整另跑typecheck和lint。Python候选准入7项、反证裁剪5项、Delivery排序4项、认知谱系6项，共22项通过。v2只读审计通过：完整授权历史、原证据身份、认识正文冻结、双臂查询/数值分数相同、候选与原Delivery确定性重放、必要反证依赖和实际取证原子提交。共用宿主审计仍能通过6.0 v3数据。

6.1的候选断点定位与实验修通已完成，当前方案的体验接入验收未通过。暂不删除JEV/Observation、不替换正常网页路径。没有修改World State、Rulebook、正式Memory schema或历史试玩库；不新增崩溃恢复机制。未运行正式网页连续试玩、长历史、更多角色、JEV消融或中断恢复测试。

下一步先把已发现的Delivery阻塞作为窄问题处理：主观认识如何保留发言的证据性质并实际被读到，以及完整认识/反证组如何进入预算。之后冻结同一候选池和阅读预算做6.2 JEV消融；若两臂仍读不到认识或请求相同，明确记录实验失效，不能靠Character采样差异决定删留。当前说话者关联产生的噪声也应保留为实测限制，避免立即扩展成新的语义分类层。

## 7. 入口与重跑

代码：`candidate_admission.py`、`test_candidate_admission.py`、`audit_candidate_admission.py`、`tests/experiments/memory-candidate-admission.ts`。桥接仅增加可选candidateMode与同臂完整历史输入，原实验缺省行为保留；宿主审计复用`audit_simplification.py`。

```powershell
node --import tsx tests/experiments/memory-candidate-admission.ts .tmp/memory-candidate-admission-fresh --prepare
node --import tsx tests/experiments/memory-candidate-admission.ts .tmp/memory-candidate-admission-fresh --run
.tmp\hindsight-vector-venv\Scripts\python.exe experiments/activity-memory/audit_candidate_admission.py .tmp/memory-candidate-admission-fresh
```

必须使用新目录。准备步骤会调用原JEV并记录实际trace，运行步骤使用本机现有网关；不打印或保存凭证。`HCW_ADMISSION_SAMPLES=1..3`仅控制登记Character重复数，负控各一次。v1预检、v2正式结果及全部旧实验均保留。
