# Hindsight Core × Perspectra 认知隔离实验

此目录只用于验证 `retain → fact/representation → recall → observation consolidation`。它在独立分支 `codex/hindsight-core-experiment` 中，不改正式 Memory schema、World State、Event Log 或 Rulebook。

## 当前进展（2026-10-01）

已完成 [简化版本 120 回合连续试玩](long-small-delivery-report.md)：295 次角色调用全部返回；重启姓名恢复一致，但出现省略号召回省略号、动作模板噪声和全部 Observation 候选概括扣留。后 46 回合陷入等待，未证明行为收益。报告按每 20 回合保留非空／候选／扣留统计，参数全程不变。

最新按“角色扮演够用”收尾：统一姓名／模板清理进入实际查询和索引，Delivery 默认最多 3 项；缺少全部可信结果支持的 Observation 不交付自由概括，改用相关原始证据或返回空。保留 E5 与 improved-v3 暂定门槛，停止继续扩展标注及校准设施。见 [简化交付实现与验证](small-delivery-report.md)。后续补上从已完成授权请求恢复重启姓名表，并按每 20 回合统计非空交付与 Observation 候选／扣留数；严格 Observation 规则暂不放宽。

完成 12 个玩家回合、27 次真实角色调用，但旧记忆交付全部为空，只验证运行路径；四个历史请求及五次保存上下文调用提供局部补充，尚未证明长期行为收益。旧报告、评估工具与未使用留出集保留供回溯，以下各阶段记录不能作为当前规则。


当前连续入口的 --memory-grain episode --memory-projections 启用清洗并拆分的当前刺激查询、原始分数追踪、截断前按记忆合并、实体 IDF 与准入、RRF 后相关性排序以及交付预算调整。旧关键词/语义路径仍保留作对照。只修改实验目录，不修改认知档案或权威状态。

新增 [诊断补充](recall-diagnostics-report.md)：30点回溯留出未评价，边界拒绝项阅读、58个Observation版本审计及30次同输入回答对照。此轮不改变检索参数；自动审计通过率不能当失真率。

具体结果与保留的限制见 [召回质量报告](recall-quality-report.md)；当前契约见 [投影设计](projection-design.md)。下文保留各阶段记录，不能把初版检索和当前质量路径混为一谈。

## 源码来源和裁剪

`vendor/LICENSE` 保留 Hindsight 的 MIT 许可与版权声明。以下文件来自本机 `D:/DeepSeek Harness/hindsight-main/hindsight-api-slim/hindsight_api/engine`：

| 实验文件 | Hindsight 原路径 | 使用方式 |
|---|---|---|
| `vendor/hindsight_api/engine/search/fusion.py` | `search/fusion.py` | 原文件复制，实际执行 RRF |
| `vendor/hindsight_api/engine/search/types.py` | `search/types.py` | 原文件复制，实际使用 RetrievalResult |
| `vendor/hindsight_api/engine/consolidation/prompts.py` | `consolidation/prompts.py` | 原文件复制，实际构建整合提示词 |
| `vendor/hindsight_api/engine/prompt_utils.py` | `prompt_utils.py` | 原文件复制，供提示词构建使用 |
| `vendor/hindsight_api/engine/retain/concise_prompt.py` | `retain/fact_extraction.py` | 从原文件抽出 concise prompt 的五个顶层赋值；字面内容未改 |

`core.py` 是实验适配器，使用上述源码片段，负责模型调用、证据校验和临时结果。Hindsight 的 `MemoryEngine`、事实抽取执行器及整合执行器与 PostgreSQL/异步任务/配置层紧耦合，没有原封不动移植。初版 `core.py` 的检索候选臂是简单的字符片段、实体名和 `worldSeq` 顺序；它们不能代表 Hindsight 的向量、BM25、图遍历或时间索引能力。此次仅实际复用原版 RRF 融合、事实抽取提示词、整合提示词与结果形态。

## 边界

`drive.ts` 在真实 `PrototypeCharacterTurn` 外准备相同世界，并调用 `CognitiveMemoryService.catchUp`。它只从该角色 `namespace_key` 与已验证的 `worldSeq` 前缀读取来源，然后将完整 `sourceId/sourceHash/epistemicKind/worldSeq/CharacterId/WorldAddress` 传给 `core.py`。当前问题对应的来源不进入长期记忆。实验核心没有世界库路径、World Event Log 句柄或其他角色的来源。派生事实要求原文中的精确引用，Observation 只能引用本批已核实 fact ID，返回前再对授权来源映射逐字段核对。

派生数据仅写入实验输出文件；其语义仍可能有误，不能提升为权威世界事实。`sourceAgeTicks` 由宿主用真实世界 tick 计算，Hindsight 的日历时间推断在这里不使用。Observation 模式优先返回 Observation 并抑制其覆盖的原事实与原文副本，避免重复占满模型上下文。

## 运行

在仓库根目录执行（输出目录必须尚不存在）：

```powershell
corepack pnpm@11.7.0 install --offline --frozen-lockfile
python -m unittest discover -s experiments/hindsight-core -p test_core.py
corepack pnpm@11.7.0 exec tsc -p experiments/hindsight-core/tsconfig.json --noEmit
node --import tsx experiments/hindsight-core/drive.ts .tmp/hindsight-core-my-run
```

默认调用本机 `http://127.0.0.1:8045/v1/chat/completions` 的 `gemini-3.7-flash`。可用 `HCW_LOCAL_ENDPOINT`、`HCW_LOCAL_MODEL`、`HCW_LOCAL_API_KEY`、`HCW_HINDSIGHT_PYTHON` 环境变量调整；不要把密钥写入输出目录。`core-artifacts.json` 保存来源、事实、Observation 和两种召回；各模式的 `turn.json` 保存模型请求与回答；`comparison.json` 给出三模式结果。

## 首轮结果与限制

在 `2026-09-29` 的一轮真实 Gemini Character Turn 中，20 条 NPC 授权旧来源抽得 7 条 fact、整合出 3 条 Observation。三种模式都正确区分“鲍勃收走杯子”和“鲍勃声称已经转交”；NPC 请求与派生数据中未出现仅鲍勃可见的暗号。初始记忆条数分别为 2、3、2。此案例没有显示 Hindsight 方案优于现有记忆；单次模型回答也不能证明长期角色体验收益。该轮实验尚未抽取 Hindsight 原版向量/图检索。关键词/语义探针维持既有基线，此目录不延伸其架构。

## 52 回合长试玩

随后在三条独立的 52 个玩家回合轨迹中，分别用现有记忆、实验 Core Recall、实验 Core Recall + Observation 运行真实 Character Turn；另从同一个末回合世界快照分叉做三模式提问。三种模式均正确回忆私下提醒词的旧词与新词，并区分“只约定过”和“实际用过”。实验模式让同行者更频繁发言，却没有表现出明确的体验质量收益。方法、数字、原始产物与限制见 [长试玩报告](long-play-report.md)。

在仓库根目录执行；每条轨迹使用新的输出目录：

```powershell
node --import tsx experiments/hindsight-core/long-drive.ts .tmp/my-long-existing --mode existing
node --import tsx experiments/hindsight-core/long-drive.ts .tmp/my-long-recall --mode core-recall
node --import tsx experiments/hindsight-core/long-drive.ts .tmp/my-long-observation --mode core-recall-observation
node --import tsx experiments/hindsight-core/long-compare.ts .tmp/my-long-existing
node --import tsx experiments/hindsight-core/long-compare.ts .tmp/my-long-recall --only-mode core-recall
node --import tsx experiments/hindsight-core/long-compare.ts .tmp/my-long-observation --only-mode core-recall-observation
```

`long-drive.ts` 每 10 回合更新实验核心的来源快照，输出 `progress.json`、`shadow.json` 和实验模式的 `adapted.jsonl`；中断后可用相同参数续跑。`long-compare.ts` 复制封闭世界数据库作最终问题的独立分叉。加 `--exploratory` 可运行额外的改写与“是否真的执行”问题；若先前已运行对照，请使用新的输出副本，以免覆盖分叉目录。


## 图、向量、tick 与行为对照（2026-09-30）

新增 `vector_core.py`，继续只接收角色授权来源快照。下列 Hindsight 原始代码实际执行，精确来源、行号和片段 SHA256 在 `search-slices.json`，可用 `extract_search_slices.py` 从本机原仓库重新抽取。

| 能力 | 实际复用的源码 | 实验适配 |
|---|---|---|
| 本地向量 | `embeddings.py` 的 `OnnxEmbeddings` 和三个前缀编码方法 | multilingual-e5-small 量化 ONNX，384 维，query/passage 前缀；模型文件和缓存只在 `.tmp` |
| 语义边 | `retain/link_utils.py` 的 `compute_semantic_links_within_batch` | 按 fact/representation/Observation 类型建余弦 kNN 边，阈值 0.8、top 8 |
| 图扩展 | `search/link_expansion_retrieval.py` 的实体/语义/因果候选合并计分块 | 用角色内存中的实体集合与语义边替换 SQL 展开；因果候选为空，不是完整原版图检索 |
| 时间 | 原版时间边生成、边数限制、时间桶覆盖函数 | 以获知 tick 代替日历时间；内部数值桥接不向角色展示，不代表现实时间或事件发生时间 |
| 融合 | 原版 `search/fusion.py` | 语义、字符 gram BM25、图、显式 tick 窗口四臂 RRF |

实体名仍来自抽取结果和授权来源中的显式 ID；没有移植全套模糊实体消歧。字符 gram BM25 是本地存储适配。没有移植 PostgreSQL、SQL 图查询、日历时间解析、因果链提取、cross-encoder 重排、Reflect 或 Mental Models。普通角色决策测试没有自动猜测时间窗口；时间臂通过独立的显式 tick 窗口探针验证。所有臂与扩展邻居都必须服从同一窗口，多来源 Observation 只要含窗口外证据就被排除。

`behavior-drive.ts` 冻结四个场景：无回忆提示的主动行为、人物认识的前后变化、矛盾约定与执行状态、同音近名人物的相似事件。每个场景提交 72 或 84 tick 的**预写历史**，不是新增的 72/84 轮真实模型试玩；在冷却后的相同快照上运行真实 `PrototypeCharacterTurn`。人物认识场景还在第 52 tick 分叉，以同样刺激比较早期与晚期判断。

四模式为现有记忆、初版关键词 Core、新向量/图 Core、新 Core + Observation，每个刺激重复三次，共 120 次决策试验。另用 `--empty-memory-control` 在独立输出目录运行 30 次关闭长期记忆的对照，保留相同的近期观察与当前刺激；若模型请求主动召回，也返回空结果。角色请求没有评分标准、期望动作、目标来源 ID 或要求回忆的额外提示。角色仍可主动选择 recall，日志记录其请求和后续回答。

检索诊断另外保存移除图臂、移除直接语义臂的结果；后者仍保留依赖向量的图种子，不能解释为“完全关闭向量”。这些是召回结果消融，尚不是相应行为消融。三次重复和固定人工历史只能提供小样本证据。

准备可选的实验依赖与本地模型：

```powershell
uv venv --python 3.12 .tmp/hindsight-vector-venv
uv pip install --python .tmp/hindsight-vector-venv/Scripts/python.exe -r experiments/hindsight-core/requirements-vector.txt
.tmp/hindsight-vector-venv/Scripts/python.exe -c "from huggingface_hub import snapshot_download; snapshot_download('Xenova/multilingual-e5-small', revision='761b726', local_dir='.tmp/hindsight-e5-small', allow_patterns=['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','sentencepiece.bpe.model','onnx/model_quantized.onnx'])"
.tmp/hindsight-vector-venv/Scripts/python.exe -m unittest discover -s experiments/hindsight-core -p 'test_*.py'
corepack pnpm@11.7.0 exec tsc -p experiments/hindsight-core/tsconfig.json --noEmit
node --import tsx experiments/hindsight-core/behavior-drive.ts .tmp/my-behavior-run
node --import tsx experiments/hindsight-core/behavior-drive.ts .tmp/my-behavior-control --empty-memory-control
```

两个驱动默认用本机 8045 的 `gemini-3.7-flash`；向量编码在本地 CPU，不依赖网关 embeddings API。`HCW_HINDSIGHT_ONNX_DIR` 可指向其他本地模型目录，必须使用相同的固定模型资产。`--case <id>` 只运行一个场景，`--prepare-only` 只准备历史、抽取和索引；输出目录可续跑已完成试验，不覆盖未完成的 trial。产物含 `protocol.json`、分阶段 `prepared.json/index.json`、检索诊断、每次 `turn.json` 和 `trials.jsonl`。来源映射与凭证处理沿用上面的边界。

结果、行为证据与限制见 [图向量与行为对照报告](behavior-report.md)，逐次人工评估见 `behavior-assessment.json`。

## 真实连续试玩与调用追踪（2026-09-30）

`continuous-drive.ts` 用同一个模型扮演玩家，在新建的普通借宿驿站中自行选择下一步；NPC 仍通过真实 `FrozenWorldPlaytestRuntime / PrototypeCharacterTurn` 处理刺激。世界只有人物、房间、可取放转交的物品和普通初始认识，没有预写记忆历史、规定回合剧情、记忆考题或期待回答。默认运行 **120 个玩家回合**，`--turns` 可设为 100–300；NPC 模型调用、模型主动 recall 和宿主创建 Scene 不冒充玩家回合。

当前连续轨迹使用图/向量 Core Recall + Observation。现有记忆与关键词 Core 结果作为 shadow 基线保存，不影响人物回答，不能把它们算作行为 A/B。NPC 没有额外的“请回忆”提示。玩家模型只获得玩家的授权视图、当前可见物品与人物、近期转录、可用交互和自己的短笔记。笔记是模型自述，不能证明物品已归还或其他行动已完成。

每 5 个玩家回合，在角色决定之外更新授权来源、retain、consolidation 和索引。调用时排除已经完全覆盖于近期观察/自身观察的旧材料，从授权刺激与近期观察构造检索词。普通连续决策没有推测日历时间或强行开启 tick 窗口；向量、BM25、实体/语义图实际参加融合，时间距离由各来源 `knownTick` 与当前世界 tick 计算。温启动的 `vector-worker.py` 复用 ONNX 模型；来源、索引与缓存仍按角色隔离，核心不持有世界库句柄。

```powershell
node --import tsx experiments/hindsight-core/continuous-drive.ts .tmp/my-continuous-run --turns 120
# 在完成回合的边界先试 10 回合，然后沿同一协议和轨迹续跑：
node --import tsx experiments/hindsight-core/continuous-drive.ts .tmp/my-other-run --turns 120 --stop-after 10
node --import tsx experiments/hindsight-core/continuous-drive.ts .tmp/my-other-run --turns 120
.tmp/hindsight-vector-venv/Scripts/python.exe experiments/hindsight-core/trace-summary.py .tmp/my-continuous-run
.tmp/hindsight-vector-venv/Scripts/python.exe experiments/hindsight-core/trace-view.py .tmp/my-continuous-run --find '一起' --last 2
```

输出文件：

| 文件 | 可核对的内容 |
|---|---|
| `protocol.json` | 冻结的模型、玩家指令、模式、角色边界和实验限制 |
| `rounds.jsonl / progress.json` | 玩家真实提交输入、tick、世界事件、角色调度结果和 trace ID |
| `player-turn-XXXX.json` | 玩家实际调用内容与返回的下一步、短笔记 |
| `traces/turn-XXXX-call-XXX-actor.json` | 授权刺激、检索词、召回结果、各臂排名、RRF 贡献、图路径、完整来源、Observation、最终模型输入、实际返回、该调用后提交的行动事件 |
| `snapshots/turn-XXXX/actor/index.json` | 该次调用实际使用的角色内索引和授权来源；trace 引用该文件 |
| `consolidation.jsonl` | 新来源原文、fact、Observation 创建/更新/删除及整合前后内容 |
| `room-scenes.jsonl` | 实验宿主创建空 Scene 的单独记录，不计作玩家回合 |
| `trace-summary.json` | 完成回合、调用与未返回统计；只读核对角色来源表、世界 tick、六字段映射、融合贡献和实际输入一致性 |

检索路径说明材料如何进入候选；是否对融合排名有贡献应同时查看 `sourceRanks`。这些记录不能证明模型内部为什么说出某句话。`modelResponse` 是实际解码输出，`action.resolved` 和其他权威事件用于区别提出行动与真正执行。没有发生的私聊、失约、误解等不补编剧情，也不据此宣称已经覆盖。

连续游玩暴露了既有 Scene 生命周期的限制：最后一人离开后，房间的 Scene 被关闭；再次进入没有新 Scene，取放物品所需的场景交集消失。`continuous-scene.ts` 因此在已完成的玩家回合之间，用现有 `scene.created` 事件建立新的空 Scene，正常移动再决定成员加入。宿主先释放运行时写入租约，再获取自己的租约进行短提交，随后释放；没有改正式 Rulebook、World State/Event Log schema 或 Memory schema，也没有将记忆派生内容写成世界事实。这个实验宿主不代表正式产品已修复房间重入。

激活周期超时且玩家输入已提交时，保留失败调用、已经提交的角色结果和 `continuations.jsonl`，从下一步玩家选择继续；未返回不冒充 abstain。其他错误仍停止以检查证据。

不自动重放中断的玩家输入：如果存在 `inflight.json`，必须先读提交证据；若协议变化则另建输出目录。完成回合可安全续跑，已提交事件与失败轨迹保留，不回滚后挑选更好回答。

连续试玩结果与具体调用证据见 [连续试玩报告](continuous-play-report.md)。


## Source / Event Atom / Episode / Observation（2026-09-30）

可选分层模式用 Event Atom 替换自由改写的 fact，Episode 组织同一次经历，Observation 形成可修正主观认识。详见 [分层设计](episode-design.md) 和 [实际验证与限制](episode-validation-report.md)。所有原始来源与六字段追溯保留，不修改正式 schema 或世界事实。

```powershell
# 新目录先冒烟，之后用相同协议继续；不要覆盖旧 120 回合记录
node --import tsx experiments/hindsight-core/continuous-drive.ts .tmp/my-episode-play --turns 120 --stop-after 10 --memory-grain episode
node --import tsx experiments/hindsight-core/continuous-drive.ts .tmp/my-episode-play --turns 120 --memory-grain episode

# 只读重建原 120 回合中两处失真的原始来源批次；不是完整历史或行为 A/B
.tmp/hindsight-vector-venv/Scripts/python.exe experiments/hindsight-core/episode-regression.py .tmp/hindsight-continuous-20260930-v3 .tmp/my-episode-regression

# 用原角色请求、同一刺激验证实际注入；不执行返回的行动
node --import tsx experiments/hindsight-core/episode-turn-replay.ts .tmp/hindsight-continuous-20260930-v3/traces/turn-0074-call-001-friend.json .tmp/my-episode-regression/friend/prepared.json .tmp/my-episode-regression/turn-0074-replay.json
```

## 完整授权前缀与相同决策请求对照（2026-09-30）

已按原 120 回合全部 81 个角色前缀重建，复现 137 次检索，并对 135 个原决策请求分别运行现有记忆、旧 Core、新分层 Core，保存 405 次返回。额外移动差异另做 15 次探索性重复，不执行行动或改变原轨迹。

[完整报告与复现命令](episode-prefix-study-report.md)说明检索、噪声、正文及实际交付压缩率、模型波动和保真限制；[固定阅读评估](episode-prefix-study-assessment.json)保留逐条标签。正式产物在 `.tmp/hindsight-prefix-study-20260930-v2`，配置漏传的预试验 v1 保留但不混入正式结论。当前结果支持保留证据分层，尚未证明稳定行为收益，不据此迁移正式记忆系统。

## 检索投影 / 交付投影（2026-09-30）

已在独立实验中拆开档案、搜索表示和角色阅读。实现与边界见 [投影设计](projection-design.md)，实际数据和限制见 [冻结前缀对照报告](projection-prefix-study-report.md)。

复用完整分层前缀，不重新提炼：137 个查询、135 对相同决策请求共 270 次 Gemini 返回。平均 memories JSON 由 17,109 降到 1,588 字符；同证据语境和近期证据的重复交付归零。行为没有出现新的行动优势，仍有旧移动噪声和 Observation 确定性失真，存储中的嵌套证据暂时保留。

~~~powershell
$env:PYTHONIOENCODING='utf-8'
$env:PYTHONHASHSEED='0'
$python='.tmp/hindsight-vector-venv/Scripts/python.exe'
$study='.tmp/my-projection-study'
& $python experiments/hindsight-core/projection-prefix-study.py .tmp/hindsight-continuous-20260930-v3 .tmp/hindsight-prefix-study-20260930-v2 $study
node --import tsx experiments/hindsight-core/episode-prefix-behavior.ts $study --modes=old,new
& $python experiments/hindsight-core/projection-prefix-analysis.py $study
# 可选连续实验入口；必须使用新目录
node --import tsx experiments/hindsight-core/continuous-drive.ts .tmp/my-projection-play --turns 120 --memory-grain episode --memory-projections
~~~

连续 trace 新增 projection 字段，包含按 memoryId 合并后的各臂结果、搜索表示与 Atom/Source 的映射，以及真正交付/省略的内容及理由。hasObservation 表示实际阅读认识；候选中的认识不等于已经交付。正式产物为 .tmp/hindsight-projection-study-20260930-v2。


## 编码器离线比较（2026-10-01）

采用本机 Ollama 的 Qwen3-Embedding 0.6B 做候选比较，完成分布、AUC、E5 fp32/int8 和去人名/模板消融。完整证据、复现命令与限制见 [编码器报告](embedding-study-report.md)。当前运行时仍用 E5，30 点留出仍封存，未沿用旧门槛或宣称行为改善。


## 统一清理与池化盲评（2026-10-01）

全授权前缀的姓名/ID 清理已生成固定 retrievalText；候选池不经过旧门槛，提供离线人工盲评页面及查询内/聚类区间评估工具。E5 清理与 Qwen 清理并行保留，固定领域外背景只查尺度，尚不定门槛。见 [池化盲评说明](retrieval-pool-report.md)。Qwen 同版 Q8_0/fp16、重复编码和批次稳定性对照也已完成；30 点留出继续封存。


## 双模型独立盲标（2026-10-01）

按用户后续要求，人工标注改为本机 8045 的 Claude Opus 4.6 与 Gemini 3.1 Pro：各自独立完成 48 组、367 项。结果标为模型探索标签，人工评估默认路径仍拒绝它们，不强行合并共识或定门槛。见[完整报告](dual-model-review-report.md)。两模型对“有用”的判断明显不同，暂无编码器胜者；30 点留出未使用。

~~~powershell
.tmp/hindsight-vector-venv/Scripts/python.exe -u experiments/hindsight-core/pool_model_review.py .tmp/hindsight-pool-study-20261001-v4 .tmp/my-dual-review
~~~


## 2026-10-02 低信息收尾

查询和索引统一排除少于 2 个内容字符的表示；纯物品动作按具体物品 ID 走实体路，旧行动记录不作为阅读候选。连续 5 回合近似重复仅告警，每 20 回合统计单列纯标点。Observation 人工读到的 8 个版本均混有事实或计划，本轮维持严格规则。详见 [收尾报告](low-information-closeout-report.md)。旧 120 回合目录冻结；后续试玩使用新目录。


## Perspectra V1 独立接入（2026-10-03）

本目录保留 `codex/hindsight-core-experiment` 的核心与研究记录，导入来源提交为 `c6eb2dd`。研究报告描述当时的实验，不表示当前已启用所有评估设施；双模型标注和池化调参仍已停止。

当前活动记忆适配在 `../activity-memory/`，只接受角色授权来源，正式网页默认使用原生记忆。可选网页入口与安装命令见 [活动记忆说明](../activity-memory/README.md)。Python 依赖由 `requirements-vector.txt` 固定；`setup-vector.py` 按 `e5-assets.json` 的固定 revision 下载六个 E5 文件并校验 SHA256。默认环境和模型缓存都在本仓库 `.tmp` 内，不再引用旁边的 Hindsight 工作树。
