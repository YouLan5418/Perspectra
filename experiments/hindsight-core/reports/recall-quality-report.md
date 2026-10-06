# 查询与召回质量：冻结来源实验

日期：2026-10-01。分支：codex/hindsight-core-experiment。当前实现仅位于 experiments/hindsight-core。

后续诊断见 [诊断补充](recall-diagnostics-report.md)：old对old重现此前类别变化；旧Character Turn对照不得解释为行为收益。

## 1. 结论

查询清洗本身不足以解决噪声。加入索引正文清洗、截断前合并、实体准入、暂定相关性门槛和交付预算后，原 137 个查询的平均记忆 JSON 从 1,588 降至 256 字符；非空交付从 113 次降至 57 次。这是载荷与选择行为变化，不是准确率或长期体验收益。

第 109 回合的旧读书经历仍保留；第 49 回合恢复共同去院子的答应与空气感受。纯移动不再普遍展开旧移动和取包。第 92 回合仍出现“慢慢来”旧闲聊，第 63/82/91 回合仍有同人物寒暄偏置。固定 48 点实际阅读剩余 27 项中：5 项有明确连续性价值，10 项只提供一般背景，10 项无关，2 项包含既有 Observation 的确定性失真。空结果不自动视为正确；没有完整漏召回 gold set。

15 个既有固定 Character Turn、两组各一次 Gemini 返回：两组各提出一次去大厅的相同移动；新组多一次外显回应。没有证明动作或长期主体性改善。

## 2. 实现范围与边界

- queries.py：替代当前刺激加最近三条记录的混合查询。只读取当前角色授权 Context；当前对白优先，叙述只作无对白时的查询；保留主动 recall。
- 语义文本含 query 前缀与特殊 token 最多 256 token。BM25 使用确定性中文双字项与拉丁词，文档保留真实词频。动作 JSON 改为结果性质明确的短描述。
- 实体种子取自刺激和授权场景地点；明确说话者与动作字段角色放入搜索元数据，不再让动作记录独占显式实体索引。
- 空刺激直接跳过。成功纯移动只走实体路，并排除单纯行动记录作为阅读候选；拒绝动作和主动询问历史不使用该限制。没有寒暄词黑名单。
- 截取每臂 32 个候选和 20 个语义种子前按 memoryId 合并。完整匹配表示仍用于 trace，不重复投票。
- 实体出现频率按不同 memoryId 计 IDF；实体共享不能绕过相关性准入。语义邻居不再作为独立 graph 票，现有边仅记录诊断关系，不承担新增候选或事实印证。
- 普通查询不自动猜时间窗；显式 tickWindow 过滤所有候选，质量路径不通过时间边扩展候选。
- 暂定门槛：原始余弦 >=0.3 且相对背景语义提升 >=0.30，或词项 IDF 覆盖度 >=0.15。提升值为 max(0, (cosine - 当前候选余弦中位数)/(1 - 中位数))，不是概率、事实置信度或独立校准结果。
- 融合仍使用原 Hindsight 等权 RRF k=60，之后按 max(语义提升, 词项覆盖度) 重排序，RRF 打破同分。允许空召回，不以 RRF 数值作准入门槛。
- Delivery 优先读取自身相关的 Atom；每轮每记忆一段、非 Observation 最多两段，保持八项/4,500字符上限。完整原文不截断，Observation 与其已登记反证不可拆散。候选连通簇仍是诊断，不做可能将多个经历桥接成一组的硬配额。

所有实际交付仍回到冻结档案。sourceId/sourceHash/epistemicKind/worldSeq/CharacterId/WorldAddress 逐字段核验。原始 来源、Atom、Episode、Observation 未重新提炼或改写。未修改正式 Memory schema、World State、Event Log 或 Rulebook。旧关键词与原搜索路径作为基线保留，continuous-drive 的 --memory-grain episode --memory-projections 使用当前路径。

## 3. 顺序对照与未采用结果

原轨迹：.tmp/hindsight-continuous-20260930-v3，120 玩家回合。认知档案：.tmp/hindsight-prefix-study-20260930-v2。直接基线为 .tmp/hindsight-projection-study-20260930-v2 的投影结果。

所有阶段使用相同档案、授权前缀、近期排除和实际 Context。没有新增 retain/group/consolidate 调用。

| 阶段 | 平均 JSON 字符 | 非空交付次数 | 解释 |
|---|---:|---:|---|
| 原投影结果 | 1,588 | 113 | 冻结基线 |
| 仅清洗当前查询 query-v2 | 1,520 | 113 | 索引、图与交付不变，噪声仍明显 |
| 初步质量门槛 improved-v1 | 1,093 | 94 | 提升/覆盖统一0.20；纯移动噪声仍多 |
| 较严格 improved-v2 | 91 | 27 | 提升0.40、覆盖0.15；共同去院子的有效材料被删，不采用 |
| 当前 improved-v3 | 256 | 57 | 提升0.30、覆盖0.15；恢复有用材料，保留噪声与漏召回风险 |

最初 query-v1 同时使用对白与表情叙述，阅读发现点头、微笑影响召回，因此改为对白优先。所有输出保留，不覆盖失败或较差阶段。每个目录保存 Python 代码副本和 Hash。

此前“两个检索臂在这轮因256-token截断回答不同问题”的解释不成立：原137个查询含前缀/特殊token的中位数113、最大245，均未截断。代码中的潜在长查询风险已经用预算解决。

## 4. 固定阅读与追溯

48 点在 improved 输出前确定：原15个固定阅读点，加33个按原 trace 排序确定的分布点。全部最终载荷经过助手阅读，结果在 recall-quality-assessment.json；数值摘要与回答校验在 recall-quality-summary.json。非盲评，且门槛依据这些点探索调整，不是独立留出验证。

这48点旧版交付283项，新版27项，31点为空。未对所有旧项目重新标注，不能计算新旧准确率改善百分比。只有“更少”并不足以通过验收。

- 第21/28/98回合沈南：旧移动/取包不再普遍进入阅读。
- 第49回合沈南：保留“行，走吧，正好去院子里透透气”等共同经历；严格版本曾删掉，当前版本恢复。
- 第82回合林晓：原八条回大厅/行李/院子记录缩为一条茶水间相关语境，但仍只是背景，不是泡茶经历的直接证据。
- 第92回合沈南：仍带回两条旧闲聊；不能声称清洗已解决。
- 第109回合林晓/周姨：保留 event:382/383 的看书喝茶再遇经历。
- 第97/98回合：已有 Observation 仍把泡茶/分茶写得过于确定；正确召回不能修复它们。

Trace 保留完整 rawScores：原始余弦、BM25、词项覆盖、匹配词、语义提升、实体分、准入结果；保留各臂实际名次、命中窗口、Atom 和六字段映射。连续入口已修正表示ID到记忆ID的路径映射；语义边诊断不会冒充新增准入。

对1522个基线/档案文件做逐字节核验均未改变，另核对原轨迹305个已冻结文件，包括两个SQLite数据库，均未改变。

## 5. 真实模型 Character Turn 对照

本机8045、gemini-3.7-flash。复用原15个固定点，old为前一轮投影输入，new为本轮结果；除此之外Context字段完全相同。组别顺序交替，不挑选返回。

| 决策 | old | new |
|---|---:|---:|
| abstain | 6 | 5 |
| publish | 8 | 9 |
| perform | 1 | 1 |

30/30 返回通过模型输出schema和结构检查。第92回合两组都提出 move 到 location:hall，参数相同。唯一类别变化是第44回合林晓从沉默变为闭眼听风的外显表现。

这只有每点每组一次的随机样本，不能归因或声明更自然、更主动。没有执行提议、追加主动recall或运行新的连续世界轨迹。

## 6. 验证和接受的限制

自动化：51个Python相关测试通过；根项目及实验TS类型检查通过；变动TS工具oxlint通过；git diff --check通过。测试覆盖查询去重/否定/预算、纯实体弱命中被拒、语义无词面命中、重复窗口不耗名额、单字主题、跨角色/时间窗/伪造来源、完整证据和反证预算、worker交付路径、跨角色请求在查询前被拒绝、纯移动不重述旧行动。

未运行全仓历史回归、崩溃恢复、新的完整连续试玩。所有长期行为和动作收益仍需真实新轨迹验证。

门槛尚未独立校准；查询背景依赖记忆库分布，窗口数量仍可能影响最大值与背景；纯移动实体模式可能漏掉旧行动相关提醒；同人物指称、短回应语义、行动描述的重复前缀仍可能稀释词项信号、不同层级的机会偏置与跨来源同义重复仍未完善。实体角色只是结构和诊断，未完成别名/代词解析或角色语义匹配。Observation置信度、来源独立性、自我强化、核实机制、open/resolved、常驻关系、重要度整理和遗忘均未加入。

## 7. 复现

从仓库根目录执行，新输出目录必须不存在：

~~~powershell
$env:PYTHONIOENCODING='utf-8'
$env:PYTHONHASHSEED='0'
$python='.tmp/hindsight-vector-venv/Scripts/python.exe'
& $python experiments/hindsight-core/recall-quality-study.py .tmp/hindsight-projection-study-20260930-v2 .tmp/hindsight-prefix-study-20260930-v2 .tmp/my-recall-quality --phase improved
& $python -m unittest discover -s experiments/hindsight-core -p test_*.py
corepack pnpm@11.7.0 exec tsc --noEmit -p experiments/hindsight-core/tsconfig.json
~~~

真实回答可用 episode-prefix-behavior.ts 的 --modes=old,new 和 --traces=逗号分隔的原traceId，避免无必要地重放全部调用。历史query-v2使用其输出/code中的Python副本，不能用当前projections.py重跑并冒充相同输入。
