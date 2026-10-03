# 检索投影 / 交付投影：原 120 回合冻结对照

日期：2026-09-30。实验分支 codex/hindsight-core-experiment。

## 1. 结论

两个投影已实现，证据档案与角色阅读内容分离。平均记忆载荷从 **17,109 降到 1,588 字符，减少 90.7%**；这不是计费 token 指标。结构性的同证据重复和近期证据重复均归零，长 Episode 的搜索表示不再超过编码上限。

135 个相同 Character Turn 的 270 次真实 Gemini 返回均通过输出结构检查。两组各提出 2 次行动，目标与参数相同；8 个决策点发生 publish/abstain 差异，新投影组净少 6 次回应。不能据此认定角色行为更好，也需留意互动减少。

固定阅读点仍有旧移动、旧行李和一般闲聊噪声。既有 Observation 中的确定性抬升没有被修复。本轮证明的是职责拆分有效减少重复与载荷，没有证明长期认知或行动收益。

## 2. 范围与控制

- 原轨迹：.tmp/hindsight-continuous-20260930-v3，120 玩家回合，137 个角色调用，其中 135 个返回。
- 认知档案：.tmp/hindsight-prefix-study-20260930-v2，81 个完整授权前缀；最后合计 197 Sources / 501 Atoms / 44 Episodes / 11 Observations。
- 本轮产物：.tmp/hindsight-projection-study-20260930-v2。
- 原轨迹和整个前一轮 JSON 产物共冻结 1,330 个文件，完成后字节变化为 0，包括原世界和记忆 SQLite。
- 没有重新 retain/group/consolidate，也没有新增 LLM 提炼调用。
- old：上一轮的分层 Core 检索与完整对象交付；new：同一认知档案的检索投影和交付投影。135 对 old 的实际 modelCall 与上一轮 new 请求完全一致。
- 现有 native 记忆与原关键词/语义基线保留在既有产物中，本轮没有重新请求 native 模型。
- deliveryOnly 只在检索诊断中沿用旧候选、替换交付；未运行其行为对照。
- 其余 Character Turn 字段不变；两次原中断调用只比较检索，不计模型返回。
- v1 在索引后因快照引用路径错误停止，无行为结果；保留但不纳入正式 v2 结论。

## 3. 实现与替代

[projections.py](projections.py) 提供两种普通投影函数，替代直接索引完整认知正文及整个对象展开交付。

检索表示来自原文和宿主标签，Episode 按成员产生多个短窗口；同一记忆每臂只贡献一次排名，再沿用原 Hindsight RRF。向量、BM25、实体/语义图仍可参加检索；图边不是事实或因果证明。普通保存查询未指定 tickWindow，不能据此验证时间检索收益。

交付回到认知档案，合并同一完整证据语境及确证相同的玩家输入/发言渲染，排除近期已读证据，读取 Episode 的匹配局部。保留不同时间、不同主体和不同独立渠道的事件。Observation 不覆盖具体证据；反证不能被预算挤掉后只留下认识。

交付最多 8 项、4,500 个紧凑 JSON 字符，按融合顺序分配。没有每簇配额或新语义裁判。完整原文语境放不下时省略整项，不截断否定、条件、来源或执行状态。

角色只读必要字段，完整六字段映射、支持/反证、覆盖的 Atom、搜索表示和图路径放在独立 trace。时间距离依据来源 knownTick，不能解释成事件发生时间。

连续实验入口与 warm worker 已接入可选 --memory-projections。新索引与 trace 仅在实验目录，不修改正式 schema 或世界事实。

## 4. 检索、交付与审计

| 指标（137 个原查询） | 分层 Core 原交付 | 两个投影 |
|---|---:|---:|
| 平均 memories JSON 字符 | 17,109 | 1,588 |
| 非空交付次数 | 102 | 113 |
| 交付 Observation 的调用数 | 21 | 41 |
| 交付 Observation 项数 | 28 | 66 |
| 同证据语境重复出现次数 | 615 | 0 |
| 近期已读证据语境出现次数 | 291 | 0 |

原交付的证据次数包含实际交给模型的内嵌 Atom，包括 Observation 支持证据；新版本的支持证据仅保留在 trace。该指标计算同一来源、渠道、主体和完整语境的重复，不等同于全部语义冗余或原报告的 sourceId 重复指标。

仅替换 Delivery 的 shadow 平均载荷为 **1,300 字符**，说明多数体积下降来自停止展开档案。两个投影的最大单次实际载荷为 3,192 字符。更小载荷不自动证明召回更准；原交付包含 1,149 个不同证据语境，新版实际阅读 739 个，省略了一部分上下文与证明材料。

81 个前缀的全部搜索表示最多 220 passage token。最后三个角色共 635 个搜索表示，44 个 Episode 的各局部均可参与向量搜索；多个表示不算多份独立证据。

审计实际交付的 1,119 条 Source 引用，六字段与授权快照完全匹配。逐项检查非 Observation 正文保留完整原始片段、来源年龄正确、已读证据排除和语境无重复；Observation 正文与冻结档案相同，没有在投影中改写。

## 5. 固定阅读检查

复用前一轮提前固定的 15 个查询点，按实际新载荷阅读。记录见 [逐项评估](projection-prefix-study-assessment.json)。这是助手阅读，非独立盲评；交付粒度改变，未计算与原单位混比的 precision 百分比。

- 第 109 回合林晓：仍保留 event:382 的读书再遇线索；原来两来源占满八个槽位，新交付来自八个来源。同一发言的输入、副本和完整语境不再反复出现。但新增的多数材料只是一般歇息、喝茶闲聊。
- 第 92 回合沈南：同源重复消失，但仍召回早期厅/院子话语，没有恢复旧 Core 曾命中的有效喝茶约定。
- 第 21、28、98 回合：旧进出大厅和取包噪声仍存在。同一人物/地点和行动 JSON 的相似性仍会触发召回，投影分离没有证明相关性问题解决。
- 第 49 回合：共同去院子的邀请、答应与空气感受分别保留，避免把经历压成一个确定事实。
- Observation 次数增加，同时意味着已有错误认识可能更常交付。主观标签不能修复正文里的事实确定性抬升。

## 6. 相同决策请求的真实行为

本机 8045 的 gemini-3.7-flash，每点两组各一次；组别顺序交替，三个 worker 并发，全部首个有效返回保留。

| 决策 | 原交付 | 两个投影 |
|---|---:|---:|
| abstain | 79 | 85 |
| publish | 54 | 48 |
| perform | 2 | 2 |

8 / 135 个决策类别不同：7 次从回应变为沉默，1 次从沉默变为回应。55 个完整响应不同，许多仅是措辞差异。24 对实际模型输入完全相同，决策类别差异为 0；这仍不足以排除其他差异来自模型随机性。

两组的行动类型、目标和参数全部相同。所有 270 次返回通过协议 schema 和结构检查；没有执行行动或追加召回，也没有形成一条新的连续反事实世界轨迹。尚未证明更稳定的主动行为或长期关系认知。

## 7. 验证与接受的限制

通过：36 个 Python 相关测试、根项目和实验 TypeScript 类型检查、变动的两个 TS 工具 oxlint、Python 语法检查、137 个查询及 270 次真实返回、完整来源与冻结文件审计。

测试覆盖：错误角色、错误世界/前缀与引用、未来知识 tick、所有检索臂的时间窗口、重复表示单次投票、同源独立事件保留、跨时间重复承诺保留、完整否定/条件语境、认识与反证预算和 warm worker 的实际交付路径。

未运行：全仓历史回归、崩溃恢复、新的完整连续试玩、动作 Rulebook 执行或矛盾情境的真实长期行为验证。反证预算通过构造回归测试验证；原 120 回合没有足够真实反证，不能视为长期矛盾处理验收。

本轮保持档案嵌套存储，存储放大未解决；原 Observation 的语义失真仍是明确缺陷；预算仍按融合顺序，来源性质与 JSON 常见字段导致的检索噪声仍在。下一步应围绕这些已经观察到的问题调整，不继续增加搜索算法或生产基础设施。

## 8. 复现

详情与契约见 [投影设计](projection-design.md)，数值及逐次差异见 [汇总 JSON](projection-prefix-study-summary.json)。

~~~powershell
$env:PYTHONIOENCODING='utf-8'
$env:PYTHONHASHSEED='0'
$python='.tmp/hindsight-vector-venv/Scripts/python.exe'
$study='.tmp/my-projection-study'
& $python experiments/hindsight-core/projection-prefix-study.py .tmp/hindsight-continuous-20260930-v3 .tmp/hindsight-prefix-study-20260930-v2 $study
node --import tsx experiments/hindsight-core/episode-prefix-behavior.ts $study --modes=old,new
& $python experiments/hindsight-core/projection-prefix-analysis.py $study

# 新建连续试玩的可选入口。本轮没有重新跑完一条新连续轨迹。
node --import tsx experiments/hindsight-core/continuous-drive.ts .tmp/my-projection-play --turns 120 --memory-grain episode --memory-projections
~~~

输出目录独立于原轨迹和认知档案；代码变化时使用新目录，不覆盖已有对照结果。
