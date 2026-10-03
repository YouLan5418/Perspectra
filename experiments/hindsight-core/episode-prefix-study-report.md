# 原 120 回合授权来源前缀重建与行为对照

| 属性 | 内容 |
|---|---|
| 日期 / 分支 | 2026-09-30 / `codex/hindsight-core-experiment` |
| 原始轨迹 | `.tmp/hindsight-continuous-20260930-v3`，只读 |
| 正式实验 | `.tmp/hindsight-prefix-study-20260930-v2` |
| 核心版本 | `697610e` 的 Source / Event Atom / Episode / Observation；三份核心源码 Hash 在实验期间保持不变 |
| 模型 | 本机 8045，网关标识 `gemini-3.7-flash`；固定本地 multilingual-e5-small ONNX 向量 |
| 数据 | [统计与边界审计](episode-prefix-study-summary.json)、[固定样本阅读评估](episode-prefix-study-assessment.json) |

## 1. 结论

**完整重建可行，Atom 的证据边界值得保留；当前实现尚未证明稳定的角色行为收益，检索交付与压缩需要先修正。**

旧的两处具体失真在 Atom 层得到修正：沈南听到的门廊雨伞信息保持为旅人的发言；旅人呼唤周姨评论茶温，不再提炼成“周姨准备了茶”。但 Observation 仍会把声称泡茶概括成“旅人泡好热茶分给大家”。完整来源映射、主观标识与引用校验不能证明上层正文没有抬升事实确定性。

新版本会命中更贴近当前话题的旧经历，也仍出现大量同句重复和旧移动噪声。平均交付的记忆 JSON 从 **8,619 增至 17,109 字符，增加 98.5%**。新增的一次去门廊提议，在重复对照中旧 Core 也出现，不能据此认定分层产生稳定的行动收益。

本轮只新增实验重建、检索对照、模型重放和统计工具及记录。正式 Memory schema、World State、Event Log、Rulebook 和 Perspectra V1 主工作树未由本轮修改，重放提议没有执行。

## 2. 如何保持对照边界

逐角色按原来全部 27 个检查点顺序追加来源，共 **81 个前缀**。每个前缀的 scope、来源原文、顺序及六字段映射必须与原快照一致；从当前前缀生成 Atom、Episode 和 Observation，不先用最终记忆回答早期问题。最终三角色共有 197 条来源，产生 501 个 Atom、44 个 Episode、11 条 Observation。

宿主只读核对角色来源表及 seq → tick 元数据。核心函数仅得到当前角色的授权来源和既有派生材料，没有世界库句柄、其他角色的来源或完整世界状态。所有层保留 sourceId / sourceHash / epistemicKind / worldSeq / characterId / worldAddress。获知 tick 和发生时间仍分开理解，年龄使用当前 tick 减 knownTick。

全部 **137 次保存查询**使用原刺激、原近期来源排除规则、相同向量/RRF 参数和 limit=8。旧索引复现原召回 ID **137/137**，排除了重放工具改变基线这一干扰。原关键词 shadow 基线继续保留在原 trace，不增加新的检索算法实验。

对原来正常返回的 **135 个决策调用**分别重放现有记忆、旧 Core、分层 Core，共 **405 次新模型返回**。这些调用包括原有两次行动结果续写；各调用独立使用其保存上下文，不构成新的连续世界轨迹。三组的角色、刺激、近期观察、场景、认知、affordances 和调用预算保持原样；新旧 Core 仅替换 memories。fresh-old 的 modelCall 与原录制 modelCall 在 135 次中均完全一致。

每组保存实际请求、模型调用、返回、延迟与输入 Hash。没有主动 recall 返回，因而没有追加检索续答。perform 只保存提议，未经过本轮 Rulebook 执行，也不冒充已经移动或完成交互。

预试验 `v1` 漏传原 observationsMission，发现后保留其产物并重新完整执行 `v2`。本报告统计采用 `v2`，其归纳任务说明与原轨迹完全一致；不混合预试验与正式统计，也不只保留较好的回答。

## 3. 压缩：区分正文、档案与实际交付

三角色原始 Source 正文合计 **41,717 字符**。下表的“派生正文”是 fact/Atom + Episode + Observation 的 text 合计，不包含原始 representation 档案，也不是实际模型 token 成本。比值大于 1 表示扩张。

| 角色 | 来源 | 新 Atom / Episode / Observation | 旧派生正文 / 来源正文 | 新派生正文 / 来源正文 |
|---|---:|---:|---:|---:|
| 林晓 | 61 | 150 / 18 / 6 | 0.141 | 2.349 |
| 沈南 | 76 | 199 / 13 / 2 | 0.101 | 2.618 |
| 周姨 | 60 | 152 / 13 / 3 | 0.137 | 2.440 |
| 合计 | 197 | 501 / 44 / 11 | 0.125 | **2.477** |

旧摘要正文只有 5,200 字符，但此前已证明有语义失真，不能把小体积直接视为更好。新派生正文为 103,332 字符：Atom 保留完整语境，Episode 又组合全部 Atom，原始输入和实际发言还会重复，当前并未实现有效压缩。

新 Observation 正文仅 885 字符，但带完整嵌套证据的 JSON 合计 **155,630 字符**。各角色全部派生单位 JSON / Source JSON 比为 **9.746 / 9.643 / 10.283**。这说明应把可核对的证据档案与每次交付角色的内容分别设计；不能只报告短摘要正文的“压缩率”。

本轮记录到 139 次成功的核心模型调用，累计 system/user 输入约 1,395 万字符，单次最高 429,535 字符。这是输入字符量，未获得可核对的网关计费 token 数据；全历史重复交付的成本需要正视。

## 4. 检索与噪声

| 指标，137 次调用 | 旧 Core | 分层 Core |
|---|---:|---:|
| 有长期召回的调用 | 102 | 102 |
| 返回单位总数 | 788 | 776 |
| 含 Observation 的调用 | 58 | 21 |
| Observation 返回次数 | 146 | 28 |
| 平均记忆正文字符 | 969 | 1,401 |
| 平均实际 memories JSON 字符 | 8,619 | 17,109 |
| 同一来源重复引用次数 | 161 | 321 |
| 已在近期上下文出现的来源引用次数 | 95 | 155 |
| 选中单位含 graph_rank 贡献 | 743 | 766 |
| 最老来源年龄 | 182 tick | 183 tick |

现有记忆的平均 memories JSON 为 4,672 字符。所有平均载荷均包含空召回调用；来源重复不自动等于语义重复，旧记忆也不自动等于噪声。上层单位只要还含一条非近期来源，就可能把已在近期出现的其他成员一起交付，解释了近期来源重复为何仍存在。

固定阅读样本在重建前选取：三个角色、四个回合区间各取一个已有长期召回的中间调用，再补原 27/74/92 的关键调用，合计 15 个。由实施者阅读实际刺激、近期查询语境及完整选中证据，分别标注相关、混合、无关、冗余；没有调用额外评审模型。这是主观评估，不是独立盲评或全量精确率。

| 固定样本单位标签 | 旧 Core，112 条 | 分层 Core，109 条 |
|---|---:|---:|
| 相关 | 6 | 6 |
| 混合：有用内容与其他内容同在 | 16 | 21 |
| 无关 | 72 | 41 |
| 冗余：本次已交付同一意思 | 18 | 41 |
| 无关 + 冗余 | 80.4% | 75.2% |

无关旧动作减少，但转成了更多重复的同源话语，直接有用单位没有增加。混合 Episode 含有用内容，也携带额外材料，不能把整个 Episode 算成一个纯命中。

具体证据：第 109 回合林晓听到“在屋里看了会儿书，还是厅里坐着舒服”。旧版八条结果主要是取包和旧出入大厅；新版本命中旧的读书/喝茶发言，但八个名额只覆盖 event:382 和 event:121 两条来源，原始输入、发言和完整语境反复出现。第 92 回合新版本同样被 event:122 / event:437 的旧话语占满，旧版至少保留了先前喝茶约定的归纳。

**图向量问题不能只归因于 fact 改写失真。** 最终 44 个 Episode 中 **30 个超过编码器 256-token 上限**，最大 2,522 token，中位数 682；语义向量只看到开头部分。相同人物/地点的泛关联仍大量进入 graph 融合，Atom ID 去重又无法识别“同句话的原始输入与发言”这类语义重复。当前索引形成时间边，但这些普通查询没有 tickWindow，时间检索臂未启用；不能把来源年龄展示当成时间检索效果。

## 5. 相同 Character Turn 决策点的行为

| 正式 135 次返回 | 现有记忆 | 旧 Core | 分层 Core |
|---|---:|---:|---:|
| abstain | 85 | 81 | 80 |
| publish | 48 | 52 | 52 |
| perform 提议 | 2 | 2 | 3 |
| recall | 0 | 0 | 0 |

新旧 Core 的决定类别不同 **7/135**；旧 Core 现在重放与原录制相比也不同 **7/135**。35 次新旧 modelCall 完全相同的自然对照中，仍有 1 次决定不同。不能将这些差异全部归因于记忆。

唯一新增移动发生在第 19 回合：新版本提议去门廊，另外两组首次沉默。再对该保存请求做每组 **5 次额外调用**，现有记忆 5 次沉默，旧 Core 和新 Core 均为 4 次沉默、1 次去门廊。额外 15 次作为事后探索单独保存，不并入正式 135 对统计。该回合的新召回没有 Observation，且近期上下文已明确提到稍后去门廊；它不能证明 Observation 产生独立行动收益。

第 92 回合三组都提议移动到公共厅喝茶。第 74 回合三组都答应稍后在茶水间见；第 109 回合三组都围绕喝茶放空作自然回应。新召回内容改变了部分表达，但没有可重复的、超出当前刺激足以解释的行为优势。

结果说明：**本次记忆可以进入角色决策；尚未证明这个实现能稳定改善长期认知驱动的行为。** 这也不是证明 Hindsight 的设计无效。原世界主要是休息、移动、读书与喝茶，没有足够的失约、矛盾修正或近名人物相似事件，不能据此宣称覆盖了那些能力。

## 6. 保真和权限分别验收

81 个新前缀与原来源一致，Atom 原句、channel、施事归属及上层嵌套引用通过现有校验。交付结果的 **1,248 条顶层来源引用**逐一核对六字段、角色、世界、前缀及 knownTick；135 对 fresh-old 实际调用与原调用一致，137 对新旧请求没有非记忆字段变化。原协议、trace、快照与两个 SQLite 数据库等 **305 个冻结文件字节未变**。三份核心源码 Hash 与原 observationsMission 亦一致。

这些证明本轮程序输入和权威数据边界保持，并不证明所有正文推断合理。最终林晓 obs:6 写“旅人泡好热茶分给大家”，引用材料包含旅人的发言和叙述，没有独立的泡茶裁定证据；周姨 obs:2 也把目的地/行动时间线写得过于确定。应保留“他自述/我听说/似乎”等具体证据限定，不能依靠笼统“主观认识”前缀为其中的确定事实背书。当前还有重复添加主观前缀的文案问题，已记录，未在冻结实验中改算法。

## 7. 下一步采用最小修正

本轮不新增因果图、实体消歧模型、分类器或生产记忆 schema。已有实测支持优先处理：

1. 同一发言的原始输入、实际发言和完整语境不要重复占召回名额；保持 Source 档案和各证据类型，不再把重复内容视为独立事件或多次印证。
2. 角色交付只展示选中的必要 Atom 和具体限定，完整嵌套证据留作可展开 trace。Episode 作为经历容器，检索到成员后按需要展开，避免长篇整体正文只编码开头。
3. Observation 对正文中的具体经历保留转述、计划与执行差异；先修复已经出现的确定性抬升，再优化哪些主观认识值得交付。

保留 Source → Event Atom → Episode → Observation 的层次和六字段映射。下轮先看同一批真实决策点的重复、载荷与保真缺陷是否改善，再决定是否继续扩展检索能力。当前结果不足以支持正式系统迁移。

## 8. 复现与验证记录

`episode-prefix-rebuild.py` 初始化冻结协议，三个 actor 任务可分别运行；每个 retain/group/consolidate 输入输出与模型调用落盘，完成前缀可续跑。检索工具保存所有原查询、各臂排名、图路径及三组实际请求。行为工具保存首个返回，按回合轮换条件顺序，三个请求并发；失败不会冒充沉默。

```powershell
$env:PYTHONIOENCODING='utf-8'
$env:PYTHONHASHSEED='0'
$original='.tmp/hindsight-continuous-20260930-v3'
$study='.tmp/my-authorized-prefix-study'
$python='.tmp/hindsight-vector-venv/Scripts/python.exe'
& $python experiments/hindsight-core/episode-prefix-rebuild.py $original $study --init
& $python experiments/hindsight-core/episode-prefix-rebuild.py $original $study --actor companion
& $python experiments/hindsight-core/episode-prefix-rebuild.py $original $study --actor friend
& $python experiments/hindsight-core/episode-prefix-rebuild.py $original $study --actor host
& $python experiments/hindsight-core/episode-prefix-retrieval.py $original $study
node --import tsx experiments/hindsight-core/episode-prefix-behavior.ts $study
& $python experiments/hindsight-core/episode-prefix-analysis.py $study
# 可选：对一个保存请求每组再作五次探索性对照，输出到独立目录
node --import tsx experiments/hindsight-core/episode-prefix-behavior.ts $study turn-0019-call-001-friend
```

正式产物中的 `snapshots`、`actors/*/calls`、`retrieval`、`behavior`、`behavior-confirmation` 和汇总 JSON 保留全部追踪。阅读标签和 tokenizer 长度统计分别来自人工阅读及固定本地 tokenizer，不是上述模型重放工具自动打出的质量分数。

已通过：23 个 Python 相关测试，三个新 Python 工具语法检查，根项目及实验 TypeScript 类型检查，新增 TypeScript 工具的 oxlint；实际完成 81 个前缀、137 次检索、405 + 15 次模型重放及对应边界核验。未运行全仓历史回归、崩溃恢复或新的连续世界轨迹，也未验证新提议的规则执行与长期后续影响。角色输出结构检查通过，不替代 Rulebook 裁定或真实玩法收益验收。
