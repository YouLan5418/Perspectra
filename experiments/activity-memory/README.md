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

新索引和私有 trace 位于该存档的 `memory-core/`。`recall-trace.jsonl` 保存授权前缀、清洗查询、召回与实际交付，`model-trace.jsonl` 保存模型原始返回，包括最终被拒的输出。这些内容不提供给玩家网页，不包含 API 认证头。最多交付三项，Observation 的严格来源规则保持；生成了认识不意味着认识获准交付。

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
