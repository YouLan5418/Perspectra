# 记忆认知实验：历史命令与记录

| 属性 | 内容 |
| --- | --- |
| 归档日期 | 2026-10-05 |
| 来源 | 整理前累积的实验 README，以下按原文保留 |
| 用途 | 旧实验复现及结果追溯；当前入口以 [README](README.md) 为准 |

历史的默认配置、严格 Delivery、主动 recall 和“下一阶段”均适用于各自实验阶段，不作为当前 Core 网页行为说明。

---

# 主持人活动的记忆认知实验

初版日期：2026-10-02；独立接入更新：2026-10-03。分层核心现随仓库保存在 `experiments/hindsight-core`，不再默认依赖另一工作树。正式 Memory schema 和世界状态 schema 不变。默认网页仍使用原生记忆；新启动的实验网页可显式选择 Core，已有网页进程不会自动切换。

## 独立环境与网页试玩

在仓库根目录准备本地 Python 3.12 环境。依赖版本、E5 小模型的固定 revision 和资产校验值均随仓库保存；环境和模型文件放在忽略的 `.tmp` 中，不提交模型权重。

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
python -m venv .tmp/hindsight-vector-venv
& .tmp/hindsight-vector-venv/Scripts/python.exe -m pip install -r experiments/hindsight-core/requirements-vector.txt
& .tmp/hindsight-vector-venv/Scripts/python.exe experiments/hindsight-core/setup-vector.py

# 网关须先启动，数据目录使用新的名字
corepack pnpm@11.7.0 experience:web --memory-core --pack examples/world-packs/ai-girls-hosted-guess --data-dir .tmp/my-core-web
```

启动后使用终端打印的带 token 的本机地址。网页顶部的宿主按钮“整理长期记忆”会逐角色整理其全部已授权来源，复用已验证的旧 Atom，只对新增来源提炼，再重建 Episode、Observation 和索引。首次整理前长期交付为空，近期上下文仍正常提供。整理不是每回合自动运行：建议在一局结束或一段交流之后手动触发，当前总期限十分钟，避免正常发言隐含触发昂贵整理。

整理期间普通输入暂停，宿主逃生可取消；完整完成的角色缓存保留，未完成角色保留旧缓存。取消、失败或完成后输入恢复。取消不伪造角色行为，整理也不向世界提交游戏结果。重启按角色加载缓存，并从该角色已授权的请求记录恢复姓名线索；它不读取完整包内姓名表或其他角色档案。

新索引和私有 trace 位于该存档的 `memory-core/`。`recall-trace.jsonl` 保存授权前缀、清洗查询、召回与实际交付，`model-trace.jsonl` 保存模型原始返回，包括最终被拒的输出。这些内容不提供给玩家网页，不包含 API 认证头。最多交付三项。2026-10-05 起，新启动的 `--memory-core` 使用简单 ID 候选准入与极简 Delivery：认识正文优先，明确来源类型、未解决反证及证据摘选覆盖，不要求所有支持来源为直接观察，也不要求证据整组容纳。角色/世界/前缀与引用授权校验继续保留；该模式关闭重复的原生检索和主动回忆，JEV 不作为必经步骤。手动整理仍使用原有生成流程。

此开关当前支持本机 OpenAI 兼容服务，默认 Gemini 3.7 Flash；Ollama/DeepSeek 启动方式不能同时启用 Core。桌面发布目录尚未包含 Python、Core 和模型资产，当前只验收源码下的实验网页入口。若不传 `--memory-core`，仍使用原生记忆。

`HCW_HINDSIGHT_PYTHON`、`HCW_HINDSIGHT_CORE_DIR`、`HCW_HINDSIGHT_ONNX_DIR` 只用于显式覆盖本地路径。下文历史命令中的 `$env:HCW_HINDSIGHT_PYTHON` 可先设为当前仓库的 `.tmp/hindsight-vector-venv/Scripts/python.exe`；无需另一工作树。

## 运行

在 Perspectra V1 根目录，使用不存在的新输出目录。默认网关 8045、Gemini 3.7 Flash，密钥只从 HCW_LOCAL_API_KEY 环境读取。

```powershell
node --import tsx tests/experiments/activity-memory-drive.ts .tmp/my-hosted-memory game
node --import tsx tests/experiments/activity-memory-drive.ts .tmp/my-hosted-memory sources
node --import tsx tests/experiments/activity-memory-drive.ts .tmp/my-hosted-memory build
node --import tsx tests/experiments/activity-memory-drive.ts .tmp/my-hosted-memory probe
```

可通过 HCW_HINDSIGHT_PYTHON、HCW_HINDSIGHT_CORE_DIR 调整 Python 与实验核心位置。build/probe 都只给 Python 核心发送当前角色的授权来源或其派生档案，绝不传世界数据库路径。

## 方法与边界

先在新世界由真实 Character Turn 玩主持人游戏；玩家按公开裁决缩小区间，不读取主持人的私有答案。最多三次显式重试，仍无法继续时使用宿主逃生，保留失败输出与实际结局。

sources 调用 CognitiveMemoryService.catchUp，逐角色读取已验证的 source 表前缀，保留 sourceId/sourceHash/epistemicKind/worldSeq/CharacterId/WorldAddress 与获知 tick。答案是当前活动私有上下文，没有授权观察来源，不把它塞入长期记忆。Python 核心不知道世界库或其他角色来源。

实验适配保留宿主已经提供的 resultDescription。原核心行动投影会丢掉这个字段，导致只有“interact accepted”而没有裁决详情；适配同时把它加入检索文本。原始 Source、哈希及说话／行动类型不改，playerInput/reason 仍不能伪装成完成证据。这里只增加通用结果字段，没有猜数字的检索枚举。

build 运行真实 retain、Episode 分组、Observation 生成与检索索引。沿用 E5、现有 improved-v3 门槛、清理规则与最多三项交付；不在此轮切换编码器或校准参数。严格 Observation 交付规则保持，生成认识不等于它会被角色读到。

probe 从同一份已关闭的世界库复制独立分支，运行真实 PrototypeCharacterTurn；近期观察、自身近期观察清空，只保留相同人物设定、认知初值、场景与受控当前刺激（不作为新的过去证据入档）。四组分别为：空长期记忆、现有关键词记忆、分层 Recall、分层 Recall + Observation。主动 recall 仍能发生，且在相同冻结来源前缀内处理。被拒操作或后续探针回答不会流入原游戏来源。

这是**冷上下文受控探针**，不代表自然过去了很多回合，也不人为增加 tick。时间距离用实际获知 tick 计算。每条件单次抽样，不能用回答变化证明统计效果或模型内部因果。未参与者收到的是实验中的新问题，其问题本身可透露“存在一局游戏”；是否知道旧细节只能结合本人的实际交付与回答判断。

## 产物

- game-call-N.json：每次真实角色请求、返回与 HTTP 状态。
- game-steps.jsonl / game-state.json：提交操作、对白、重试和实际游戏结局。
- actor-sources.json：逐角色的授权原始证据。
- actor-archive.json：Atom、Episode、Observation 和六字段追溯。
- actor-index.json / actor-build-trace.json：实际索引、生成操作及上游源码哈希。
- probes/条件/call-N.json：当前刺激、实际交付、检索路径、Observation 扣留及模型返回。
- probes/条件/result.json：真实 Turn 的提交结果，拒绝和模型失败不冒充角色行为。

这些文件包含角色私有实验上下文，只用于本机审阅，不进入玩家页面。API 凭证和请求认证头不写入记录。原网页 10242／2099 的存档不读写。最终结果另见本目录 report.md。

只读核验及结局检索诊断：

```powershell
& $env:HCW_HINDSIGHT_PYTHON experiments/activity-memory/audit.py .tmp/my-hosted-memory
```

## 结束证据重放（第二轮）

活动已提交结果现在携带最小 `resultMetadata.activity`，实验适配保留 id/revision/phase/round/active/lifecycle，不复制 public/private/internal。Episode 关联开场／结束证据；Delivery 默认结束优先、开场其次，再保留检索片段。精确活动 ID 可直接关联，含糊的“那局”不猜 ID。完整度和关联来源写入 trace，标注也计入三项／4500 字符预算。

对第一轮冻结档案确定性重建，不重新提炼或整理，不修改 Source。replay.py 只读原目录，并要求新输出目录不存在。复用旧候选排除检索调参；Character Turn 用旧世界的独立副本，不向原轨迹提交结果。

```powershell
& $env:HCW_HINDSIGHT_PYTHON experiments/activity-memory/replay.py .tmp/hosted-memory-20261002-v1 .tmp/my-closure-replay
node --import tsx tests/experiments/activity-memory-replay.ts .tmp/my-closure-replay
& $env:HCW_HINDSIGHT_PYTHON experiments/activity-memory/audit_replay.py .tmp/my-closure-replay
```

默认交付使用 expanded；old 和 annotation 仅用于重放对照，分别是不补全／不标注，以及只标注完整度。重放保留原 Observation 文本；其生成和严格交付规则没有调整。

旧冻结档案的明确宿主逃生结果在实验适配中识别，其他缺少结构化结束依据的历史阶段不猜测。新活动使用 active/lifecycle；不按创作者自定义阶段名推断结局。实际结果与限制见 report-closure.md。

首轮 audit.py 会按当前确定性投影重建临时档案，其重跑诊断反映当前 Delivery 行为；需要保留首轮报告时不要在原目录重跑该写报告入口，使用上述新目录重放。

## 连续真实试玩（2026-10-03）

`activity-memory-live.ts` 在新世界中连续运行实际玩家输入、包内活动调度、Rulebook 提交和 Character Turn。NPC 请求经过本机代理，按角色注入独立 Hindsight Core 的 Recall + Observation 交付；近期上下文保留。AI 玩家也使用 Gemini 3.7 Flash，但只读取玩家当前场景、公开／玩家私有活动视图、转录和可用移动目的地，不读取调试视图或 NPC 私有答案。

```powershell
node --import tsx tests/experiments/activity-memory-live.ts .tmp/my-hosted-memory-live
# 只有确实中断的实验才使用，继续同一份存档并保留原失败记录：
node --import tsx tests/experiments/activity-memory-live.ts .tmp/my-hosted-memory-live --resume
& $env:HCW_HINDSIGHT_PYTHON experiments/activity-memory/audit_live.py .tmp/my-hosted-memory-live
```

计划运行三局小游戏及 24 次自由交流／移动，最多 80 次玩家入口操作。第二局只给 AI 玩家按规则退出的选择，不强制它退出。参与者必须通过普通移动／邀请会合；六次正常操作仍未会合就停止追加游戏，继续自由交流，不传送角色。游戏卡住最多显式重试两次，仍卡住则宿主逃生，技术失败不冒充角色 pass。

记忆在初始、每局结束、自由交流中段和结束时读取角色授权 Source 前缀并完整重建；不是生产级增量整理。每次代理请求记录实际记忆前缀、当前世界序号、刺激、清洗查询、各路召回和交付 trace、实际模型返回。记忆查询不携带 `context.activity` 或包变量；主持人的当前私有答案仍只由宿主直接授权给主持人本轮模型上下文。

`inputs.jsonl` 记录实际提交结果和拒绝；`games.jsonl` 记录玩家可见的最终游戏状态；`character-call-N.json` 保留模型请求与原始返回，未被宿主接受的输出不会修补或入档。`checkpoint-N/` 保存各角色的完整授权档案与索引。`audit_live.py` 在宿主侧只读提交事件核对返回与已发生内容，提交事件不传入记忆核心；仍以六字段授权映射检查真正交付的来源。

真实第一次运行遗漏了 GLM 的实验档案，因此 call 26 是原生记忆请求；恢复后的入口从包内角色表读取全部 scripted NPC，之后四位均使用各自的实验档案。原始失败和这个差异保留，不把整轮描述为完全一致的对照。首次运行使用默认 30 秒普通反应期限，恢复后仅将实验期限放宽至 120 秒，次数／波次限制不变。

这些是连续试玩记录，没有新旧系统随机对照，非空率不等于有效召回率，不能单独证明行为改善。详细结果见 `report-live.md`。当时正式网页仍使用原生记忆；该轮通过实验入口验证，没有更新玩家正在使用的页面。2026-10-03 新增的可选网页接入见上文。

本次连续实验在 38 次入口／115 次 NPC 调用后主动停止：固定房间场景关闭后不可重访，后七次操作没有 NPC 观众。`stopped.json` 标明未完成全部自由交流计划，checkpoint-6 只有部分角色档案。该目录冻结，入口拒绝继续写入已主动停止或已完成的目录；具体阻断、噪声和结束关联验证见 report-live.md。

## 第二次连续试玩

修正固定房间重访、按 sourceSeq 选活动刺激，以及闲聊 Atom 继承 Episode 活动关联造成的结尾噪声。独立新目录运行，上一轮 stopped 目录保持冻结。目标至少 60 次玩家入口，包含三局游戏及至少 32 次自由互动；最多 80 次入口。普通反应从开局统一使用 120 秒期限，调用数和波次不变，活动链仍为 90 秒。连续三个入口没有在场 NPC 会记入 warnings.jsonl，只告警，不替玩家或 NPC 移动。

冻结前轮的五个具体案例可只读重投影，候选和原档案不重建，也不调用模型：

```powershell
& $env:HCW_HINDSIGHT_PYTHON experiments/activity-memory/diagnose_live_fixes.py .tmp/hosted-memory-live-20261003-v1 .tmp/my-live-fix-diagnostics
```

新目录中的实际行为与限制另见 report-live-v2.md；这些局部修正不包含 Observation 全面放宽或检索门槛再校准。


第二轮保留了 AI 玩家 JSON 原文和实际单行 `submittedText`，只把段落换行／制表符替换为空格，NPC 非法混合输出仍整包拒绝。中段 135 条来源的整批提炼超过原 240 秒期限后，改为按完整 Source 边界分批（叙述请求约 9000 字符），全部来源先验证再发送任何一批；合并后再次核验六字段映射。批次不会截断 Source，Atom ID 仍由原 sourceId 与该来源内序号生成。Episode／Observation 继续在完整前缀上整理；整个 build 最多十分钟，recall 保持原四分钟上限。完整前缀提炼的 JSON 输出预算按输入长度增加，`finish_reason=length` 或无效 JSON 直接失败，不补 JSON、不吞掉错误；各角色的 `*-utility-calls.jsonl` 记录输出和用量，不记录认证头。原 2500 token 上限已不足以返回本轮中期的完整 Atom JSON。这是实验传输调整，不是记忆层或正式模型协议升级。

最终 206 来源的整批再提炼仍超时后，用已验证 Atom 复用替代重复提炼旧来源：保留完整最新授权 Source 前缀，校验旧档案角色／世界地址／前缀范围、逐项 Source 文本与哈希一致后，只给 retain 发送新增来源。旧 Atom 与新增 Atom 合并，再在完整集合上重建 Episode 和 Observation。相同完整范围和全部 Source 未变的整理直接保留已完成档案，重新生成索引。每次 input.json 保存所用 retainedPrefix，可追溯复用；源文或权限不符直接失败。这是实验重建的计算节省，当前没有加入正式 Memory 维护调度。

整理用模型的输入也去掉重复结构：Atom 只传一次包含完整引用语境的原证据文本，以及通道／主体／来源类型／来源序号；Episode 只传标签与 Atom ID 列表，避免再次嵌入全部 Atom 和来源元数据。存档、索引与交付 trace 中的完整六字段映射保持不变，生成后的认识仍按规范来源核验，不降低来源或交付门槛。utility trace 的 inputChars 是实际发送长度，originalInputChars 是原结构长度；旧记录未包含后者。retain 的逐字证据段列表不使用此整理投影。

确实中断且最近目录四角色档案／索引均完整时，可显式复用该前缀继续；记录中的 memoryPrefix 仍是缓存实际序号，不伪装成已经整理到当前世界：

```powershell
node --import tsx tests/experiments/activity-memory-live.ts .tmp/my-hosted-memory-live --resume --reuse-complete-memory
# 中段整理中断时先完整重建，再跑完剩余输入；避免在剩余段中再次插入一次中段整理，结束整理仍运行：
node --import tsx tests/experiments/activity-memory-live.ts .tmp/my-hosted-memory-live --resume --skip-mid-refresh
```

已完成存档可再做一个独立冷问题。入口复制 world／memory 库，移除最近观察和活动私有上下文，在三个副本分别使用原生记忆、Core 原交付、Core 结束补齐交付；不会向自然轨迹插入提问、合并探针回答或改变原库。每组只有一个初始抽样，不能作为效果大小或因果证据，也不合并进自然试玩的非空率。

```powershell
node --import tsx tests/experiments/activity-memory-live-probe.ts .tmp/my-hosted-memory-live .tmp/my-hosted-memory-cold-probe
```

## Observation 对自主选择的延迟对照（2026-10-04）

本轮只验证一个目标：同一角色在相似新场景中，读到／没读到同一条主观认识，首次自主选择是否不同。受控历史在第 15 tick 形成认识，第 55 tick 比较，采用 Gemini 3.7 Flash 和三组各三次重复。自然召回未交付目标认识；明确标记的交付干预中出现了先询问与直接移动的差异。两项结论分别报告，不将条件行为效应当作自然记忆链路通过。入口、原始回答摘要、失败记录和复现方法见 [延迟选择报告](report-observation-choice.md)。


## Observation 适用性投影对照（2026-10-04）

在冻结认识上，只替换一个搜索窗口的检索文本，原三个刺激加同人物无关、不同人物导航对照。Gemini 生成一次适用性字段，编码器、查询、准入和交付规则保持原样；自然交付仍为 0/3，未启动角色行为调用。复现命令、逐点分数和对象匹配限制见 [适用性投影报告](report-observation-applicability.md)，可复核摘要见 observation-applicability-assessment.json。此参数需要上一轮包含 build.json 与 new-task-preview-request.json 的冻结目录。


## 对象与适用性判断续验（2026-10-04）

冻结上一轮字段，先测对象＋分字段 E5（仍为 0/3），再单独测对象＋Gemini 适用性准入（原三点交付、两对照为空）。后者完成 27 次真实首次选择对照，等候点出现先问资料与直接移动的分叉。期间修复了成功 Observation 经活动交付器时 trace 缺少 coveredAtomIds 的可复现缺陷。方法变化、失败记录、局限及复现见 [对象与适用性判断报告](report-observation-facet-match.md)。未接入正式网页或修改正式记忆 schema。


## JEV 适用性判断对照（2026-10-04）

实验入口新增 `--jev-judge-from`，复用冻结认识与适用性字段，经确定性对象门槛后只让 OpenRouter `typesafe/jev-1.13` 判断相关性；角色仍用 Gemini 3.7 Flash。密钥读取 `OPENROUTER_JEV_KEY`（进程或 Windows 当前用户环境），不保存值。三态决定、重复稳定性与 27 次首次选择结果见 [JEV 实验报告](report-observation-jev.md) 和 observation-jev-assessment.json。

```powershell
node --import tsx tests/experiments/observation-choice.ts .tmp/my-observation-jev --jev-judge-from .tmp/observation-applicability-20261004-v1
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/audit_observation_facet_match.py .tmp/my-observation-jev
# 可选：相同输入各追加两次，只增加 JEV 判断调用：
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/jev_applicability_stability.py .tmp/my-observation-jev
```


## 多候选 Observation Bank（2026-10-04）

`--bank-from` 在新测试世界提交 19 条仅本角色授权的合成经历，保留原目标认识及证据；模型派生适用性字段，然后比较嵌套 5／10／20 条全量 JEV 与对象关系＋E5／BM25 初筛最多七条的路径。各次请求一次判断所有候选，三次打乱重复；角色行为使用 20 条初筛路径首次交付，并且只删除原目标作对照。

```powershell
node --import tsx tests/experiments/observation-choice.ts .tmp/my-observation-bank --bank-from .tmp/observation-applicability-20261004-v1
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/audit_observation_bank.py .tmp/my-observation-bank
```

90 次批量判定与 27 次角色返回完成；初筛减少费用与部分噪声，但漏了相反认识，交付排序也挤掉重要的已准入认识。没有扩到 50 条或修改正式记忆本体。完整方法、探索标签局限及失效链路见 [多候选报告](report-observation-bank.md) 与 observation-bank-assessment.json。


## Observation 认知更新／谱系受控实验（2026-10-04）

用四类角色内合成证据分别验证强化、条件精化、单个反例与未解决冲突；Gemini 三次重复分类，认识自然语言正文保留，家族和版本放在实验旁侧。旧版保留历史入口，证据不回写；没有新证据不调用更新模型。回接冻结20条库后当前视图为19条，但发现新版检索遗漏、历史版未交付和冲突证据预算不足，暂不接正式 schema。

```powershell
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/cognition_lineage.py .tmp/my-observation-lineage .tmp/observation-bank-20261004-v1
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/audit_cognition_lineage.py .tmp/my-observation-lineage
& '.tmp/hindsight-vector-venv/Scripts/python.exe' -m unittest discover -s experiments/activity-memory -p test_cognition_lineage.py -v
```

家族预先关联、更新对预先选择，不是自动谱系发现；A–D 是模拟来源，回接部分才复用宿主授权档案。分类结果、三类时间、现有Delivery失败与后续范围见 [认知更新报告](report-observation-lineage.md)，可复核摘要见 observation-lineage-assessment.json。原始结果在新的 .tmp/observation-lineage-20261004-v1；未运行新的角色行为或长期试玩。

## 认知谱系检索续验（2026-10-04）

复用冻结20条库的19条当前认识和五个刺激，比较原更新投影、有效旧入口继承、短情境表示、家族按路单次投票四组，各三次真实 JEV，另测三次显式历史查询。候选总预算7、交付总预算3和既有模型协议保持不变。

```powershell
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/lineage_retrieval.py .tmp/my-lineage-retrieval .tmp/observation-bank-20261004-v1 .tmp/observation-lineage-20261004-v1
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/audit_lineage_retrieval.py .tmp/my-lineage-retrieval
```

保留入口使漏掉的新版回到候选；家族展开保留相反认识，历史端点也能一起交付。但条件误判和阅读名额竞争未解决，未证明调用成本下降，未接正式 schema 或追加 Character Turn。方法、分阶段结果与限制见 [谱系检索报告](report-lineage-retrieval.md)，摘要见 lineage-retrieval-assessment.json。

## Delivery 排序离线对照（2026-10-04）

复用上轮63次既有 JEV 返回，只将已经 RELATED 的认识按 RELATED 概率排序，以原RRF、余弦与ID破同分。候选、准入、正文和三项／4500字符预算保持不变，不追加模型调用。

```powershell
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/delivery_order.py .tmp/my-delivery-order .tmp/observation-lineage-retrieval-20261004-v1
```

家族路径的资料日期三次恢复，导航冲突两支保留，普通查询的无关读取减少；但历史旧版读取3/3→2/3，未直接接正式运行时。完整方法、逐路径结果、退化和未验证边界见 [Delivery排序报告](report-delivery-order.md)，摘要见 delivery-order-assessment.json。

## Delivery 完整阅读组续验（2026-10-04）

继续复用63份冻结返回，比较逐条概率排序、仅历史新旧成组、再强制当前冲突支成组三种路径。条目上限仍3、字符上限4500，组按实际成本扣留，模型调用0。

```powershell
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/delivery_groups.py .tmp/my-delivery-groups .tmp/delivery-order-20261004-v1
```

历史新旧成组恢复3/3，普通查询保持原结果；盲目冲突成组恢复了不适用支并挤掉必需项。另复现现有活动补齐后二次裁剪丢掉必要反证的缺陷，实验整组算法阻止正文单独留下，但原路径未修改。C／D证据组和较大预算只做机械诊断。见 [完整阅读组报告](report-delivery-groups.md) 与 delivery-groups-assessment.json；成功输出 .tmp/delivery-groups-20261004-v2。

## 活动 Delivery 反证裁剪修复（2026-10-04）

已修复实际实验路径的二次裁剪：认识／原文回退与必要反证共同占用预算，可选开场让位，结尾优先；预算不足整组扣留。默认仍三项／4500字符，不接入全局冲突组，也不改变检索排序和认识正文。

72项相关测试通过，63份冻结结果精确复现，合成缺陷样本由“结尾、开场、认识”变为“结尾、认识、反证”。模型调用0；未追加Character Turn。见 [修复记录](report-delivery-counter-fix.md) 和 delivery-counter-fix-assessment.json。

## Delivery 反证真实角色对照（2026-10-04）

已完成Gemini网关27次真实Character Turn；full／移除反证／移除认识与反证三组各重复三次。完整交付3/3回答对最新胜者，反证消融3/3只谈旧两局；再玩一局时各组都答应玩家先猜，未测出自主选择差异。

测试使用预写授权历史和研究者指定认识，候选为显式交付干预，不是自然召回验收。三项／4500字符预算、来源引用、非记忆上下文和原库不变均通过核验。模型请求名gemini-3.7-flash，网关响应标签gemini-3.7-flash-high。准备／调用／审计命令与限制见 [真实角色报告](report-delivery-counter-live.md)。


## Observation 自然召回与首次自主选择续验（2026-10-04～05）

冻结19条当前认识，按新刺激自然初筛→JEV→三项Delivery，主实验36次真实Character调用；目标旅人认识9/9进入阅读，换陆舟0/3进入候选。主实验目标消融未分离独有作用；事后9次相反认识删除诊断中，保留目标后三次主动问资料是否最新，再删除目标后三次不问。后者是小样本条件效应，删除冲突只作干预，不升级为运行策略。45次返回、44次合法，非法混合输出整包拒绝且无事件。见 [自然召回与选择报告](report-observation-natural-choice.md) 和 observation-natural-choice-assessment.json。

```powershell
node --import tsx tests/experiments/observation-natural-choice.ts .tmp/my-natural-choice --prepare
node --import tsx tests/experiments/observation-natural-choice.ts .tmp/my-natural-choice --run
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/audit_natural_choice.py .tmp/my-natural-choice
node --import tsx tests/experiments/observation-conflict-choice.ts .tmp/my-conflict-choice .tmp/my-natural-choice
python experiments/activity-memory/audit_conflict_choice.py .tmp/my-conflict-choice
```


## Observation 连续互动续验（2026-10-05）

冻结前轮自然阅读，三组各配当天／旧资料反馈，各重复两次；玩家对白和NPC移动真实提交，移动后保留续写，第三步移除所有长期阅读。12段短互动实际39次模型返回、38次合法，1段因围栏JSON普通文本提前结束。出现一段“询问时效性→旧资料反馈→先核实计划→短期延续”的链条，但首次提问未稳定复现，未提供核实交互，也未生成新的Observation。29项相关测试和只读事件／来源审计通过。见 [连续互动报告](report-observation-sequential-choice.md) 及 observation-sequential-choice-assessment.json。

```powershell
node --import tsx tests/experiments/observation-sequential-choice.ts .tmp/my-sequential-choice --prepare
node --import tsx tests/experiments/observation-sequential-choice.ts .tmp/my-sequential-choice --run
python experiments/activity-memory/audit_sequential_choice.py .tmp/my-sequential-choice
```


### 2026-10-05 公告牌受控查看实验

见 [最小 World Capability 实验报告](report-notice-board-capability.md)。沿用 native perform/interact、包定义、Rulebook 和原子观察提交；三段真实 Gemini 互动均实际查看，再获得角色独有的 direct_observation Source。未修改记忆算法。新目录命令和限制见报告。


### 2026-10-05 真实查看证据的认识更新与后续选择

见 [真实 Source 回流实验报告](report-notice-board-revision.md)。六次既有更新器调用、十二次 Character 激活（十四次调用）。局部认识三次修订，阅读新认识或原证据可避免重复查看；更新理由的过度确定与角色补出迁址仍未通过，未接正式自动更新。


### 2026-10-05 两份真实观察的冲突认识

见 [双牌冲突实验报告](report-notice-board-conflict.md)。三段实际查看取得六份阅读证据，三次原更新器均保留两条未决分支；十二次后续角色对照能保留分歧并拒绝“后看到就更准”，原证据组也能做到，未证明认识独有效应。即时读后回应三次仍未提冲突，且旧认识实际已在输入中；自动更新时机尚未接入。全轮27次真实调用、0次JEV。相关15项TS及6项谱系测试、类型检查／局部lint和只读来源审计通过，未跑长试玩或UI。


### 2026-10-05 执行提交后、即时表达前的认识更新

见 [更新时机实验报告](report-notice-board-update-timing.md)。使用原生 maxCalls=1 保存真实查看后的未回复状态，再用 continuationOf 比较旧认识／新冲突认识／两份原始Atom。三个种子各两次采样，新认识6/6表达分歧，旧认识和原始Atom均0/6；只验证表达及计划，未执行核实。全轮30次真实调用，更新额外模型等待中位数约8.35秒，未测端到端延迟。36项相关TS与6项谱系测试、类型／局部lint及只读审计通过；正式核心未改。


### 2026-10-05 原证据自然语言与成组交付

见 [证据交付实验报告](report-notice-board-evidence-delivery.md)。复用同一真实查看后的冻结种子，新调用24次，认识更新／JEV／查看均0次。原JSON 0/6、自然语言分项2/6、自然语言成组6/6、冻结更新认识6/6保留两处不同线索；成组一条仍补出未给定的当前楼层，未把成功数当作全文正确或实际核实成功。保留成组为Delivery实验方向，不删除Observation。46项相关TS、类型／局部lint和只读审计通过，正式核心未改。

### 自主获取证据与认知更新闭环（2026-10-05）

[实验报告](report-notice-board-action-loop.md) / [逐项结果](notice-board-action-loop-assessment.json)：三个交付对照共18次正常行动选择，实际问人 raw 3/6、paired 1/6、updated 5/6；9份真实新发言来源接入既有更新。三条轨迹各推进8次无关互动后，9次自然检索交付全空，JEV没有候选，完整长期闭环未通过。共62次Character、11次update调用，正式核心和检索机制冻结。后续两次真实读取同样接入更新，没有把同请求采样差异当成记忆收益。

## 2026-10-05 记忆认知简化：第一步对照

已按[简化方案](../../docs/2026-10-05_记忆认知体系简化方案.md)新增独立入口：

```powershell
node --import tsx tests/experiments/memory-simplification.ts .tmp/my-simplification --prepare
node --import tsx tests/experiments/memory-simplification.ts .tmp/my-simplification --run
.tmp/hindsight-vector-venv/Scripts/python.exe experiments/activity-memory/audit_simplification.py .tmp/my-simplification
```

只使用新目录，复用旧闭环的三份冻结授权前缀。直接历史路径不调用嵌入、BM25、RRF、JEV或认识整理；按当前人物、地点／可见对象和活动的明确ID关系选择Source，自身观察不构成通配匹配。默认两次重复，保留真实模型输出、执行、来源、预算和用量trace。

本机网关未声明token容量，预算采用8000／24000 UTF-8 JSON字节，不能解释成8k／24k token。当前短历史两档均交付20条相同材料，不能证明扩大窗口收益。正常网页路径尚未替换；当时待推进6.1，后续进展见下节。完整结果及v1计数修正见[第一步实测记录](report-memory-simplification.md)。

### 6.1 候选入口（2026-10-05）

新增 `candidate_admission.py` 与 `tests/experiments/memory-candidate-admission.ts`，在完整宿主授权历史中比较原准入和明确ID准入；保留原分数、JEV、Delivery及认识正文。正式结果 `.tmp/memory-candidate-admission-20261005-v2`：24次首步选择、35次Character调用；登记认识由0/3入池变为3/3、JEV全接受，但原Delivery回退和预算仍导致正文0/3交付。登记实际取证两臂均4/6，不能归因于认识。负控暴露旧话题侵入与较宽的说话者关联。详见 [实测报告](report-candidate-admission.md)，独立审计 `audit_candidate_admission.py`；未接入正常网页路径，也未删除JEV。

### 极简 Delivery 与 6.2 JEV 消融（2026-10-05）

按用户方向新增 `minimal_delivery.py`：先交付授权的主观认识正文、来源类型、未解决反证标记，再按预算附最多两条关键证据；不要求支持全为直接观察/已接受行动，也不要求整个证据组完整进入预算。原复杂Delivery保留作对照，非认识证据投影继续复用。

[实测报告](report-minimal-delivery-and-jev-ablation.md)：两组共48次首步选择、66次Character调用。Delivery对照中登记认识实际阅读0/6→6/6，极简路径六次有效回应均表达分歧，其中三次真实询问工作人员。6.2同对象无关话题无JEV多读三份认识，但两臂话题侵入均1/3；登记/不同对象阅读材料相同，不把行动差异算作JEV收益。有JEV一条Markdown包裹JSON被原生Turn判invalid_output，保留失败、未重试。后续实验采用极简认识交付，JEV保留可选对照；当时待进入6.3；后续进展见下节。正式网页与6.4尚未完成。

入口：`tests/experiments/memory-minimal-delivery.ts`，先`--prepare-delivery`/`--run`，再用新目录`--prepare-jev`/`--run`；只读审计`audit_minimal_delivery.py`。正式结果目录分别为`.tmp/memory-minimal-delivery-20261005-v1`、`.tmp/memory-jev-ablation-20261005-v1`，原候选池和证据数据未变。


### 6.3 即时原始证据 / 已有认识（2026-10-05）

[实测报告](report-immediate-delivery.md)：同一双牌前缀、无核实提示，12次首步选择、18次Character调用，真实询问两臂均3/6；其余均只发表建议。原始证据可直接支撑即时回应，不需前置认识整理；已有认识未显示行动率收益。原始组全部六次回应明确保留相反牌面，已有认识四次；本轮提供商总用量约少23%，不作为稳定速度或长期替代结论。

新准备入口`tests/experiments/memory-immediate-delivery.ts`，执行继续复用`memory-minimal-delivery.ts --run`；只读审计`audit_immediate_delivery.py`。正式目录`.tmp/memory-immediate-delivery-20261005-v2`，来源、正文、同前缀、私有隔离、原子提交和逐条对白复核完成。默认check184项、相关Python7项通过；完整证据覆盖说明已修正，旧Delivery/JEV结果仍可重放。当时待验证6.4；后续进展见下节，正常网页接入尚未验收。


### 6.4 延迟认识与真实行为闭环（2026-10-05）

[实测报告](report-delayed-loop.md)：三条真实工作人员Source进入已知家族更新，各推进八轮真实闲聊后，三臂均索引31条相同授权历史。原检索当前/旧目标六个准备均未入池，简单ID准入让正文全部实际读到；18次选择中真实取证当前5/6、旧2/6、无认识6/6，但无认识全部重读大厅旧牌并在对白中省略105。当前/旧12条回应均保留分歧。三组首次后续Source再更新3/3通过，旧证据与反证保留；小样本及材料呈现差异不构成稳定更新收益证明。

共55次Character、6次整理调用；默认check184项、相关Python20项和来源/旧版本/私有隔离/原子提交/再更新审计通过。正式目录`.tmp/memory-delayed-loop-20261005-v1`，人工复核保存在`dialogue-review.json`。有限已知家族闭环已跑通，正常网页未接入。

入口`tests/experiments/memory-delayed-loop.ts --prepare`，选择复用`memory-minimal-delivery.ts --run`，再`memory-delayed-loop.ts --finalize`；只读审计`audit_delayed_loop.py`。下一阶段沿已有--memory-core和手动refresh入口接线并在新目录连续试玩，不新增自动家族发现或通用合并层。


## 6.5 正常网页入口接入

详见 [正常网页 Memory 与连续互动实测](report-web-continuous.md)。现有 `--memory-core` 接入极简路径；默认未传开关仍为原生记忆，不额外增加模式开关。新目录实测完成12次玩家输入、2次手动refresh、13次Character和12次Utility调用；八轮闲聊后仍承认钥匙用途未核实。10次Core请求实际交付认识正文；无关闲聊也均读入旧认识，接受噪声但不宣称稳定收益。

默认check185项、相关Python21项和65行Source/交付/原生提交审计通过。两角色档案整理通过，但实际模型选择只有同行者；多角色活跃体验、浏览器UI和桌面打包未验收。复现实测：

```powershell
node --import tsx tests/experiments/memory-web-continuous.ts .tmp/my-memory-web-continuous
& .tmp/hindsight-vector-venv/Scripts/python.exe experiments/activity-memory/audit_web_continuous.py .tmp/my-memory-web-continuous
```


## 6.6 正常双角色与浏览器实测

[实测报告](report-normal-playtest.md)：默认调度预算、近期16/8，在用户8046网关下完成19次玩家输入、2次手动整理、25次真实Character调用。两个角色均实际参与，跨房间暗号未泄露，传闻没有变成已确认用途；90行Source与实际模型材料、确定性交付重放、旧Source/Atom及原生动作提交审计通过。浏览器输入、整理禁用/恢复和最终状态完成检查，服务保留供试玩。

数据目录`.tmp/simple-memory-playtest-20261005-v2`；入口`audit_normal_playtest.py`，结果`normal-audit.json`及`normal-dialogue-review.json`。本轮未修改运行时，未重跑完整check。实际发现静态character地点与当前scene不一致，建议优先局部修复；宽准入的无关材料、同行者反复追问柜子和整理等待仍是已知限制。单轨迹不是稳定认识收益或完整产品验收，当前进程没有Utility用量trace，不报总成本。


6.6后续修复已完成：Character请求用当前角色view的地点覆盖静态Manifest地点，移动续写和下一次激活回归通过；默认check185项通过。修复版新世界`.tmp/simple-memory-playtest-20261005-v3`完成6次输入、1次整理、12次真实角色调用，调用时事件前缀与两个地点字段全部一致，38行Source及私有暗号隔离审计通过。详见[报告第5节](report-normal-playtest.md#5-地点投影修复及真实复验)；角色目标牵引、宽准入和整理成本仍保留为限制。
