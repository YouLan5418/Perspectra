# 统一检索清理与池化人工盲评（2026-10-01）

本文记录候选池准备阶段：统一清理、四回合重算、未经过旧门槛的候选池、本机盲评页面、标签导入与评估工具，以及 Qwen Q8_0/fp16 与重复/批次稳定性检查。用户后续选择改用 Claude Opus 4.6 与 Gemini 3.1 Pro 独立标注，已完成，见[双模型报告](../dual-model-review-report.md)。**仍没有人工 gold，尚未选择门槛或启用编码器，30 点留出未评估。**

不再要求用户继续人工标注；人工页面作为可选工具保留。本文修正上轮解读：文本清理是两个编码器共同改善的因素；0.90 vs 0.78 不能证明 Qwen 优于清理 E5。两个候选并行保留。固定背景仅作尺度诊断，同域难负例才用于门槛校准。

## 1. 统一清理

实现：[retrieval_text.py](../retrieval_text.py) 和 [projections.py](../projections.py)。

按角色收集历次已获准看到的 Context 的姓名—CharacterId 映射；只取当前档案 asOfWorldSeq 之前的信息，并要求名称或该 ID 在其授权 Source 中有见证。角色/WorldAddress 不匹配直接拒绝，未来的别名跳过。原始来源没有完整名字字典，因此不对自由文本用模型猜人名；未登记的昵称是接受的限制。没有读取其他角色的 Context 或来源，也不读取完整世界状态。

同一角色前缀在索引阶段生成 retrievalAliases；每个原有窗口新增固定 retrievalText 和规则标记。查询也使用这份前缀表和同一 clean 函数。窗口仍按原 E5 220 token 切分，原 text、实体角色、Source、Atom、Episode、Observation 及六字段映射不变。去掉已知人物姓名、CharacterId/尾部和模板，整理遗留标点，保留否定、失败、未知结果、条件、地点和物品内容。实体 ID 保留在结构元数据中。

实验评分读取固定 retrievalText；已有实验运行时仍读原 text，因此未把这个候选清理配置提前用于新的 Character Turn。正式 Memory schema、World State、Event Log、Rulebook 未改。

历史身份元数据仅用于别名，不使用留出查询的刺激、模型回答、召回结果或标签。时间截断按每个当时的前缀执行，不用最终角色名字表反向补早期未知人物。

## 2. 四回合同口径重算

正式池为 .tmp/hindsight-pool-study-20261001-v4。旧标签只用于这四个探索反例，**不写入人工盲评答案**。Episode 的旧行李标签对应实际交付的 Atom 表示，不套到整个 Episode 的其他窗口。

| 回合 | 原探索标签 | E5 原文重算 | E5 全前缀清理 | Qwen 全前缀清理 |
|---|---|---:|---:|---:|
| 49 | useful | 0.9114 | 0.9114 | 0.5455 |
| 63 | noise | 0.9200 | 0.8674 | 0.3332 |
| 82 | noise | 0.9090 | 0.8710 | 0.2596 |
| 91 | noise | 0.9126 | 0.8690 | 0.3216 |

第 49 回合原文与清理文本相同；此前编码结果约 0.543，本次重算约 0.5455，二者均是同一文本口径，差异体现了重复编码的数值波动。第 91 回合现在覆盖了此前不在场、但已认识的周姨和林晓。四条目标证据均在候选池中，未作为额外控制项强行补入。

这些反例支持继续检查表示问题，不是完整准确率或漏召回率。此次 int8 输入批次与上轮不同，不能把 E5 数值变化全部归因于清理。Qwen 也存在实测的执行/批次波动。

## 3. 池化设计与盲评

- 仍使用原 48 个开发查询。48 点的选点本身有历史探索偏差，不能称作独立验证集。
- 系统：E5 原文、E5 清理、Qwen 清理、BM25 清理；额外纳入 E5 清理+BM25、Qwen 清理+BM25 的 RRF 前 5 名，避免混合检索产生未标注的前 K 候选。RRF k=60、两路等权，参数在标注前确定。
- 所有窗口先按 memoryId 取最高分，单路按前 5 名合并；没有旧余弦/lift/覆盖度门槛，也没有 graph/时间扩展或低信息刺激启发式。
- 共 48 组、367 个候选项，8 个空池。纯移动在这个离线池中也可产生语义候选，不能据此说运行时已经改变召回策略。
- 查询与候选顺序均打乱，HTML/盲文件中没有系统、分数、排名、原 traceId/回合编号、旧标签。private-pool.json 单独保存连接映射、排名和六字段来源；本机服务只返回 review.html，不提供私有文件。
- 阅读保留姓名、完整原始证据语境、信息类型和主观认识的支持/反驳证据，不拿清理文本当角色阅读。显示来源多少 tick 前获知；不把它说成事件发生时间或 Observation 形成时间。
- 当前刺激、角色、场景、近期上下文可见，帮助判断是否重复交付。没有提供其他角色的私密状态。
- Episode 候选显示该记忆的完整授权证据；这次标注单位是记忆，不是某个系统最终 Delivery 的具体窗口。不同窗口、Atom/Episode 的证据重叠仍存在，因此评估不等于 Character Turn 交付效果。

人工标签：useful / background / irrelevant / harmful / uncertain。每组还标 none / some / missing / uncertain；none 是对当前刺激“无需额外旧记忆”的判断，**不是仅因池里没找到就默认应该为空**。missing 与 uncertain 不作为负例，保留池外遗漏线索。空池也需要人工判断。

页面：[本机盲评](http://127.0.0.1:8767/review.html)，可分批、导出 JSON、导入继续。浏览器存储仅方便恢复，请保留导出文件。页面离线，不调用模型或发送消息。

## 4. 评估工具与尚未完成的校准

[pool_evaluate.py](../pool_evaluate.py) 已实现，等用户标签后运行：

~~~powershell
.tmp/hindsight-vector-venv/Scripts/python.exe experiments/hindsight-core/pool_evaluate.py .tmp/hindsight-pool-study-20261001-v4 <人工导出的标签.json> .tmp/my-human-evaluation.json
~~~

使用完整、明确、人工标注且需求判断一致的查询；部分完成、missing、uncertain 单独计数，不偷偷补负例。模型标签不接收为人工结果；双模型脚本显式以 model 模式独立评估，所有结果标记 humanGold=false。

指标：同查询 AUC（有正负两类才算）、precision@5、nDCG@5、poolRecall@5、无需召回查询上的最高原始分数/非空情况，以及 E5/Qwen 与各自 BM25 混合的配对差值。

poolRecall 的分母是**池中被人工标出的有用记忆**，不是整份档案所有有用记忆，不能称作全库召回率。按 memoryId 计数，Atom/Episode 的共同证据不等于独立事实数。池外遗漏需要补池或单独探针核验。无需召回判断也依赖评审者当时提供的 Context，而非穷举全档案后的事实证明。

95% 区间以 5,000 次同玩家回合聚类 bootstrap 计算；同回合多个角色请求整体重采样，避免第 109 回合重复刺激当成独立样本。跨回合的同一长期经历仍可能相关，区间应按探索结果理解。分批完成数据有完成顺序偏差，不能据部分评审淘汰模型。

开发门槛曲线只用人工同域候选标签和“无需召回”查询，统计候选误放/遗漏及这些查询的误放，不选门槛、不使用领域外 z 值。实际门槛与所有选择冻结后，才评估封存 30 点一次。现在没有凭空给出新的 AUC、置信区间或门槛。

## 5. Qwen 精度与稳定性

Ollama 的 fp16 直接下载被本机 fake-IP 重定向检查拒绝。改从 [Qwen 官方 GGUF 仓库](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/tree/370f27d7550e0def9b39c1f16d3fbaa13aa67728) 下载同版本 fp16，校验 1,197,629,632 字节和 SHA256；本机 Q8_0 blob 哈希也与该版本官方文件一致。fp16 独立注册为 perspectra-qwen3-embedding-0.6b-fp16:latest，未替换现有模型、下载 4B/8B 或修改 Ollama 网络保护。

[qwen_precision.py](../qwen_precision.py) 对 317 个相同角色隔离的输入做 Q8/fp16 各两次 batch=8，以及各一次逐条编码。num_ctx=2048、truncate=false，查询/文档前缀、归一化与输入排序一致。分析 2,258 个查询—窗口分数及 97,192 个同查询不同记忆的可比较窗口对，忽略近似平局与同记忆内部窗口。

| 条件 | 绝对分数差 P95 | 最大差 | 配对排序翻转 |
|---|---:|---:|---:|
| Q8_0 重复批次 | 0.001484 | 0.004326 | 0.075% |
| fp16 重复批次 | 0.001162 | 0.005849 | 0.056% |
| Q8_0 批次8与单条 | 0.002958 | 0.005650 | 0.197% |
| fp16 批次8与单条 | 0.001683 | 0.005798 | 0.098% |
| Q8_0 与 fp16 | 0.009510 | 0.016335 | 0.991% |

因此 Q8_0 不是“没有精度问题”；fp16 也不是“完全确定”。精度对照含有重复编码/执行路径波动，不能把所有差异单独归因于权重量化，也不能凭翻转率判定召回质量。诊断用池 v3；最终 v4 只补评审时间信息，已核对所有角色 scope、检索文本、窗口与查询输入完全一致。

原始结果为 .tmp/hindsight-qwen-precision-20261001-v1/summary.json；没有阈值或相关度标签参与，不读取 30 点留出。

## 6. 验证与待办

74 项 Python 实验测试通过，含前缀别名/跨角色拒绝、未来和未见证别名、否定/失败保留、固定检索字段不改 Source、memoryId 去重、RRF、盲文件注入转义、人工标签校验、池外/不确定排除、未标注前 K 拒绝、同刺激聚类重采样。冻结基线 1522 文件核验通过。Playwright 实际验证标注、重载保存、导出和导入恢复；UI 冒烟标签仅在独立测试浏览器中生成，不用于评估，已清理。git diff --check 通过。

未跑 TypeScript 全门禁、新 Character Turn 或连续试玩；目前实验运行时仍是 E5。承诺生命周期、Observation 结构约束、窗口重切和语义边的新阈值仍待办。低信息刺激是否只走实体路，也要等标注验证，不加入拍脑袋规则。

复现（新目录）：

~~~powershell
$env:PYTHONIOENCODING='utf-8'
.tmp/hindsight-vector-venv/Scripts/python.exe experiments/hindsight-core/pool_study.py .tmp/my-pool
.tmp/hindsight-vector-venv/Scripts/python.exe experiments/hindsight-core/review_server.py .tmp/my-pool/review.html --port 8767
.tmp/hindsight-vector-venv/Scripts/python.exe experiments/hindsight-core/qwen_precision.py .tmp/my-pool .tmp/my-qwen-precision
.tmp/hindsight-vector-venv/Scripts/python.exe -m unittest discover -s experiments/hindsight-core -p test_*.py
~~~
