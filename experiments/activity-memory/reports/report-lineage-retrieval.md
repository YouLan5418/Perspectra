# 认知谱系的检索续验（2026-10-04）

本轮只修改实验检索表示和候选组织，复用上一轮冻结的20条 Observation Bank、当前19条认识及五个刺激。结果支持两个局部方向：更新后保留仍成立的检索入口；同家族按一次融合排名后展开当前冲突分支。分情境表示没有改善目标交付，条件误判与有限阅读预算仍未解决。暂不接正式 Memory。

## 1. 范围与对照

认识自然语言正文、Source / Atom / Episode、编码器 E5 small int8、查询、JEV 协议和现有 Delivery 保持不变。新增代码全部位于 experiments/activity-memory，没有改 World State、Event Log、Rulebook 或正式 schema，也没有增加 Character Turn。

| 阶段 | 唯一或主要差异 |
| --- | --- |
| A-current | 上轮更新后的投影，仍逐条认识检索 |
| B-continuity | 用旧正文、当前正文、旧投影与修订关系，保留有效入口、删除失效入口、增加当前条件 |
| C-scenarios | B 的基础上，把19条认识各拆为最多四个短情境；词项改为每认识一次存在计数 |
| D-families | C 的基础上，将新版与 bank:10 相反认识归在已知导航家族，家族每路只获得一次排名 |

C 同时改变短情境表示与词项重复计数，不能把差异单独归因于短情境。另存 binary-only-diagnostic.json，比较不拆情境、只改变词项计数的便宜检索对照，未追加 JEV。

各阶段均保持候选总上限7条认识、Delivery总上限3项。家族展开占用实际条目预算，不能以7个家族偷换为无限多认识；一个家族放不下时整组跳过，不暗中挑一个冲突支作为真相。JEV 仍独立判断每条原认识是否 RELATED；家族共享融合分数，不把对立关系解释为证据或世界事实。

每阶段五刺激各重复三次，调用顺序按预定种子轮换，共60次 JEV；显式历史模式另重复三次。Gemini 3.7 Flash 仅做5次投影生成，不读取刺激和标签。全部返回成功。

## 2. 五个冻结刺激的结果

表内9次为三个应唤起目标的刺激各重复三次；6次为两个对象或主题负对照各重复三次。导航两支为 new-task / new-stop 各三次。探索标签来自原库预定义标签，不是独立人工 gold。

| 指标 | A-current | B-continuity | C-scenarios | D-families |
| --- | ---: | ---: | ---: | ---: |
| 目标应相关：进入候选 / RELATED / 最终读取 | 6/9 / 6/9 / 6/9 | 9/9 / 9/9 / 9/9 | 9/9 / 9/9 / 9/9 | 9/9 / 9/9 / 9/9 |
| 目标负对照：RELATED / 最终读取 | 0/6 / 0/6 | 0/6 / 0/6 | 0/6 / 0/6 | 0/6 / 0/6 |
| 两种当前相反认识同时读取 | 3/6 | 3/6 | 3/6 | 6/6 |
| 全部应读取标签中未获 RELATED（含初筛漏项） | 6/27 | 3/27 | 3/27 | 0/27 |
| 全部应读取标签中最终未读 | 6/27 | 4/27 | 6/27 | 3/27 |
| 标为无关但 RELATED / 最终读取的项数 | 6 / 6 | 6 / 6 | 8 / 8 | 8 / 8 |
| 送 JEV 的认识总数 | 96 | 96 | 96 | 96 |

这是五个固定问题的重复调用记录，不是15个独立问题。四组原生请求中的部分认识在完全相同请求下也发生选择翻转，因此小幅噪声差不能都归因于表示变化。

### 有效旧入口找回了新版，但最高语义信号仍不理想

new-stop 是上轮漏掉的首次前往等候点刺激。目标从 A 第10名恢复到 B 第3名，三次均 RELATED 且交付；C 与 D 也均第3名并交付。只改词项存在计数、不拆情境的便宜对照已将目标排到第1名；这轮没有证据支持短情境比保留入口本身更有价值。

B 命中的唯一关键词仍只是“次到”。C / D 中目标最高语义相似度约0.883，来自“熟悉且常去的场所进行路线指引”的例外情境，而当前是陌生等候点。这说明恢复候选不等于编码器识别了正确适用条件。不能把9/9交付表述为条件检索已经通过。

模型将本例所有旧短语保留，只增加“当日更新地图”等当前正文支持的入口。它们在本例仍成立；本轮没有含失效旧条件的反例，因而没有证明 removed 通道能可靠删除失效入口。精确分区和对象检查是确定性校验，语义是否成立仍来自模型判断。

### 家族保留了冲突，也改变了阅读名额分配

当前认识仍有19条，家族检索组从19变为18；两条相反认识都继续存在。D 在 new-stop 三次都读到新版与 bank:10，之前逐条初筛漏掉后者。默认不再开放 obs:1 和 bank:04。

代价是 D 的 new-stop 三次都挤掉了另一条被标为必需的 bank:09（检查资料日期）。最终读取为 bank:19、新版与 bank:10。原有 Delivery 没有“每个认知维度占一份阅读名额”的机制；这轮没有修改它，也没有证明家族组织会全面减轻 Top-K 压力。

熟悉地点刺激中，仅适用于陌生地点旧资料的 bank:10 在 B / C / D 均被判 RELATED 并读取3/3次；同人物杂志闲聊仍误触发 bank:15，不同人物导航还存在 bank:18 条件误判。目标本身的两类负对照没有误读，但整体噪声仍存在。

## 3. 显式历史认知查询

调用者明确声明 historical 模式，使用实际历史问题重建查询；不复用旧刺激元数据、不新增自动意图识别。先检索当前家族，再由已有修订关系开放旧 obs:1、当前新版与相反的 bank:10。bank:04 是被整合的互补方面，不冒充旧版本，也不在这里开放。

三次均做到：旧版进入候选、RELATED、交付；新版与当前相反支同时交付。上轮“找到旧版但没读到”的缺口在此固定问题上通过。旧记录未删除，普通查询仍只有当前分支竞争。

这里仅证明模型输入能包含历史对照。没有新增角色回答、版本时间标注或让角色解释认识变化的测试，因此不能宣称角色已经理解修订时间与演化关系。此入口也尚未接普通聊天。

## 4. 费用、来源与限制

| 阶段 | JEV输入 / 输出token | 合计费用USD | 单请求延迟中位数 |
| --- | ---: | ---: | ---: |
| A | 56,706 / 4,095 | 0.002381652 | 765 ms |
| B | 57,087 / 4,093 | 0.002397654 | 786 ms |
| C | 56,970 / 4,085 | 0.002392740 | 784 ms |
| D | 56,958 / 4,079 | 0.002392236 | 766 ms |

含历史查询的63次 JEV 共240,525输入 / 17,228输出token，供应商返回费用 $0.01010205；不含5次本机 Gemini utility，也不含离线编码成本。四组都送96项，费用基本相同，未证明本轮省调用或省token。

审计逐项重放投影、排名、JEV请求和Delivery；两个冻结目录 JSON / JSONL 字节不变；原认识正文和 Source / Atom / Episode 未改写。投影引用保持规范 sourceId / sourceHash / epistemicKind / worldSeq / CharacterId / WorldAddress 映射；跨角色或世界请求在发送 JEV 前拒绝。新目录的派生 contentHash 曾继承旧值，离线复核时已更正并重新审计，未改变模型输入、向量或任何原始证据。

本轮家族关联仍是预先选定的导航维度，未验证自动发现家族。相反支的 bank 认识没有 counterAtomIds；本次两支交付成功不代表上轮 D 类“每支三条反证、默认三项预算导致全部扣留”已修复。既有反证完整交付规则保持原样。

## 5. 判断

保留最小方案：认识修订后重建投影时沿用仍有效的检索入口；按已知家族组织当前分支；显式历史查询开放真实修订端点。这三项在固定失败样本上有可复核收益。

暂不将短情境表示作为默认替换，也不扩候选库或修改正式 schema。还需区分适用条件误判与 Delivery 阅读名额取舍；当前结果不能作为正式认知生命周期或长期行为效果的验收。

## 6. 复现与验证

运行时要求新输出目录，两个旧输入目录只读：

```powershell
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/lineage_retrieval.py .tmp/my-lineage-retrieval .tmp/observation-bank-20261004-v1 .tmp/observation-lineage-20261004-v1
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/audit_lineage_retrieval.py .tmp/my-lineage-retrieval
& '.tmp/hindsight-vector-venv/Scripts/python.exe' -m unittest discover -s experiments/activity-memory -p 'test_*.py' -v
& '.tmp/hindsight-vector-venv/Scripts/python.exe' -m unittest discover -s experiments/hindsight-core -p 'test_projections.py' -v
& '.tmp/hindsight-vector-venv/Scripts/python.exe' -m unittest discover -s experiments/hindsight-core -p 'test_small_delivery.py' -v
```

实际目录：.tmp/observation-lineage-retrieval-20261004-v1；结果摘要：lineage-retrieval-assessment.json；主要记录：projection-generation.json、prepared.json、rankings.json、results.json、historical-results.json、utility-calls.jsonl、jev-calls.jsonl、audit.json、binary-only-diagnostic.json。

55项相关测试通过，其中新增5项检查旧入口分区、重复表示只投一次票、家族整体预算、历史端点范围和跨角色／世界调用前拒绝。未运行全量门禁；未验证正式网页、长期试玩或新的角色行为。
