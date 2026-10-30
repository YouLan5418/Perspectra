# 当前认知与记忆

2026-10-30 读取复用：例如 NPC 接收新观察后，记忆追赶和角色准备都需要同一授权前缀，宿主单步内共享 WorldStore 已解析的事件；CharacterViewBuilder 对地址、角色、序号及不可变事件完全相同的视图复用投影并返回副本。全局原始历史只在宿主内部读取，交付仍经过原有角色过滤，不能因为共用前缀而把他人的私密观察放进角色上下文。操作结束清空读取范围，Core 档案、召回和持久化机制保留；45 步离线等价与未验收范围见[单步前缀记录](../studies/2026-10-30_event-prefix-reuse-report.md)。

2026-10-22 核对物品来源：例如角色通过作者模板把摘要交给玩家，同场授权目击者从已提交的转移观察得知新持有人；角色只说“交给伊蕾了”不能生成该事实。拿／放／给现由各包 `scripts/status.js` 的 `status:take`／`status:drop`／`status:give` 裁定，沿用物品事件与授权观察进入原生／Core 记忆，不新增记忆来源或全局库存视图。状态 policy 的 `place` 只给行动者手里和脚下的物品，不能借它读取别人的私有库存；字段见[物品操作指南](../guides/activity-and-variables.md#对物品做的操作2026-10-22当前源码)。此次 hidden-cure-next D2 仅一次真实样本，实际交给了玩家而非伊蕾，不能证明接收对象选择或长期记忆已验收；测试和试玩边界见[项目状态](../PROJECT-STATE.md#验证到了哪一步)。

2026-10-19 知识条件扩展：角色离开前室后，前室限定的材料不再交付，但不会撤回它此前说过或记住的内容。知识选择器的 when 现在只从现有授权 Context 提取位置、场景、物品、本人活动、刺激与已知状态行，并保留原状态值条件；不读取他人私有材料、活动 internal 或全局真值，不扩大文档受众。已知状态行可检查 current，旧值条件本身仍允许匹配上次确认值。Core／原生记忆的来源、召回、持久化与调度不变；[Core／DeepSeek 短试玩](../studies/knowledge-conditions-deepseek-playtest-20261019.md)验证 39 次请求的条件交付与余额核实续写，退出活动后仍能回忆已讲过的材料；作者背景仍可能被说成“读到过”，长期来源语义未验收。用法及限制见[世界设定指南](../guides/world-knowledge.md)。

2026-10-19：角色上下文新增 `knownStatus` 与 `knownStatusNote`。例如失主的钱被偷后，它的 knownStatus 仍是“余额 100”，但立刻变成 current=false，提示说明这是上次确认的值、之后可能已变。只要真实值在上次确认后被任何事件改过就会这样，所以失主知道有变化，但拿不到新值、来源或原因；对暗中偷窃这类玩法，这是已知限制。从未被告知的状态（例如别人的钱袋）完全不出现。已知值在每次构建请求时从 `status.updated` 事件的 reveals 推导，不另存，也不写进记忆。限制：knownStatus 不在过期重算（stale）的比较内容里，角色思考期间别人改了状态，它的台词可能沿用刚变化前的值，但操作仍在最新前缀上重新裁定。见[活动与状态指南](../guides/activity-and-variables.md#3-状态2026-10-19当前源码)。

2026-10-18：[原型遗留处理](../studies/phase8-prototype-transition-audit-20261018.md)已移除旧 Reflection、Context Pipeline 和 Checkpoint 服务。作者七类初始材料的编译、读取及既有模型呈现保留，不存在旧 Reflection 持续写回。曾尝试把模型文本分为 initialCognition／recordedCognition，但改前对照发现行动选择退化迹象，已撤回该尝试及专属测试，现仍发送原有 cognition。来源捕获、Core 与显式原生模式保留；初始材料易被误作当前心理快照的限制尚未解决。

2026-10-18：作者设定现在可通过[按需知识](../guides/world-knowledge.md)进入 `context.knowledge`，例如提到黑海岸时补充角色有权知道的背景，而不把它当成亲历。宿主在既有 Core／原生记忆交付之后筛选文档受众、匹配本人授权内容并按字符预算选整条正文；不扫描其他角色或全局转录，不将本次设定自动写成记忆。角色情感由人设、预设、记忆与对话历史动态形成，本轮已撤销外加的信任数值及门槛。原生与 Core 的存储／召回路径没有改变。原版知识交付有 DeepSeek 短试玩证据，移除分数后只做离线回归；Launcher Core 连续体验未验收。

2026-10-17 核对物品 Context 提示：例如角色亲眼看到玩家拿走钥匙，最终模型文本会提醒“当前不由你保管”；若只有旧观察，则只提示当前归属与位置未确认。`characterRequestText` 在已授权的 `current/lastObserved` 物品行副本上添加 `narrativeBoundary`，不覆盖原有错认，不读取隐藏持有人，也不修改请求中的原始 Context、观察或记忆来源。提示随授权物品行刷新，长度进入既有最终上下文预算。实现与验证范围见 [Interaction](interaction.md#物品-context-边界提示)；自由叙事一致性仍需真实体验验收。

2026-10-13 新增[创作者调试接口](../creator-debug-api.md)：按角色读取已安装 Core 档案及整理任务状态，校验来源但不补齐来源、召回或触发模型。实际发送记忆仍以最近捕获请求为准；原生完整档案尚未接入，接口明确标注限制。

2026-10-13 的[近期执行证据实验](../studies/goal-progress-context-20261013.md)允许角色再次集中看到已交付的结构化反馈：例如“检查西侧目录架未发现原件”，而不是把“抵达后室”写成调查失败。默认关闭的 recentExecutionEvidence 只计算当前角色已有 observations，保留真实来源和有限范围；不从对白或主观记忆提取成果，不替角色判断目标进展或策略。普通宿主在现有 Core 交付后接入，原文窗口、召回、整理及持久化机制不变。最多 6 条、宿主 JSON 1200 字符；来源链接只在 host 审计保留。短轨迹、节点及真实模型证据与限制见实验记录。

> 2026-10-10 的[短信实验](../studies/cross-scene-communication-20261010.md)保留通信媒介：带 medium 的 speech 在来源文本、metadata 和自身发表中注明媒介，仍是发送者陈述。通信观察不授予对方房间视野；[电话实验](../studies/cross-scene-phone-20261010.md)的本地旁观者只收到本端声音。原生与 Core 桥的授权来源边界有自动验证；没有 medium 的既有来源保持原渲染。Core 的新增验证范围见[通信 Core 记忆实验](../studies/cross-scene-core-memory-20261010.md)。

> [节点实验](../studies/cross-scene-nodes-20261010.md)已验证通信的原生记忆回退、分享后按授权观察重建和真实模型续话。实验入口现在也可显式注入既有 CoreMemoryAdapter：本地回退恢复节点归档，分享保持不传 Core 缓存，导入后可按授权历史整理。未启用 Core 的入口仍明确拒绝非空 Core 快照或身份别名，默认宿主的恢复实现未修改。

> [工具耗时排查](../studies/core-utility-timing-20261010.md)确认 Python Core 的 thinking.disabled 未约束本机 Gemini 网关。按用户要求，当前 Gemini 的 OpenAI 兼容 Core 请求先发 reasoning_effort=low，仅超时后重试一次，移除该字段并改发 thinking.disabled；第二次失败停止。每次仍为 120 秒，并记录实际尝试的参数档位。非超时错误不触发这条回退；其他模型与原生协议沿用既有配置。客户端字段不证明网关真正关闭思考或执行输出上限。

这是了解 Perspectra 当前记忆的首选入口。源码网页与 Launcher 现在默认都走下述简化 Core 路径；原生记忆只在显式 `--memory-native` 时使用，用于不装 Python 的离线调试。记忆路径已接入不表示全部长期角色体验均已验收。

## 原生记忆（显式 --memory-native）

默认路径仍由 CognitiveMemoryService / LocalMemoryStore 从当前角色授权观察 catch-up 到指定世界前缀。prepareStimulus 按刺激及场景线索准备召回材料，角色也可在允许的决策阶段主动 recall 一次，再自行回应。来源类型和引用随结果保留；未命中不代表没有发生。近期观察／自身表达沿原生窗口，不套用 Core 的宽窗口或后台参数。

实现见[原生上下文服务](../../../packages/memory/src/cognitive-context.ts)与[本地记忆](../../../packages/memory/src/local-memory.ts)。以下 Source / Atom / Episode / Observation 分层、候选准入和极简 Delivery 描述当前默认 Core 路径；显式原生记忆不使用这套 Python 流程。

## 授权材料与分层整理

Source 是角色获授权的原始经历，保留来源身份、类型和提交前缀。Core 不获得其他角色的来源或写世界状态的能力。Retain 从来源提炼 Atom；Group 将相关材料组织成 Episode；Consolidate 形成 Observation。这里的 Observation 是可修正认识，与运行时原始授权观察须区分，不能升级为权威世界事实。

构建沿 Retain → Group → Consolidate → 索引顺序推进，旧 Source / Atom 前缀可复用。每个角色档案独立，引用回到该角色授权 Source；宿主复核世界、角色、前缀和引用权限。角色 identity/设定来自 Manifest，当前位置来自同一调用前缀的当前 view。

2026-10-14 核对的读取复用只减少重复计算：例如 Claude 的 Core 快照仍从它自己的授权经历捕获 Source，并完整同步到指定前缀；[宿主快照](../../../desktop/host/memory/core-memory.ts)改用已有 `catchUpReceipt()`，保留原有记忆提交、来源校验及失败传播，省去原 `catchUp()` 为返回值额外构建、随后未被宿主使用的 view。实际捕获仍需要角色视图，该视图内部的场景、自身经历与观察投影共用一次事件读取。删除事件、角色创建判断、角色隔离和前缀 Hash 有回归；[同数据前缀对照](../studies/prologue-performance-20261010.md#视图读取复用2026-10-14)验证角色视图 Hash 和捕获来源一致。已有档案继续完整验证来源，调试只读检查仍不执行 catch-up。

快照为 Claude 的已有授权来源补充知晓时间时，[WorldStore](../../../packages/store-sqlite/src/world-store.ts)的 `readEventTicks()` 只查询指定前缀的 `seq` 与 `tick`，替代原来为取时间戳而读取、解析全部事件正文的步骤。时间戳与完整事件查询共用分叉范围计算，父线未来不进入子线；调用拒绝未来或非法前缀，来源缺少对应时间戳仍报错。权限筛选与正文来源校验继续由原有记忆捕获及档案验证执行，这个时间戳接口本身不验证事件正文，也不把额外事件内容送给角色。嵌套分叉、缺失时间戳、来源篡改和同步失败已有回归；[分项实测与整体限制](../studies/prologue-performance-20261010.md#时间戳读取与动态准备复用2026-10-14)分别记录。

## 当前 Recall 与 Delivery

当前 Core 保留词法／本地 E5 向量等现有检索与分数诊断，加入简单 ID 候选准入，再作极简 Delivery，送给 Character。认识正文优先，附来源类型、未解决反证存在标记和少量关键证据。不再要求全部支持证据都是 direct observation / accepted action，也不要求整个 Evidence Group 一起装入预算；不完整摘选有标注，权限检查保留。

源码网页预算最多 6 项、12000 JSON 字符；未显式配置的独立对照脚本仍可采用 3 项／4500。Core 模式关闭重复原生 prepareStimulus 和主动 recall，授权 Source catch-up 保留。JEV 是可选实验对照，当前不是必经步骤；不把历史复杂 Delivery 规则恢复为正常入口。

例如 Claude 使用独立记忆模型、其他角色使用默认模型时，2026-10-17 源码会按协议、地址、模型和 Key 去重为两组 runner；每组按需启动一个长生命周期 Python Core 进程供顺序召回复用 E5 编码器，后台 Build 另起进程。档案和 scope 仍逐角色、逐请求提供，不共享私有经历。每组只接收自己的 Key，不写入数据目录；不同组的 E5 内存开销叠加。取消运行中任务会终止进程，下次调用重建，关闭宿主回收所有组。模型继承与传递见[运行时](runtime.md#角色思考强度)，此次改动未重建发行包。

## 短期上下文与后台长期整理

Core 不再按 16 条观察／8 条自身表达截断；首次整理前保留授权工作历史。后续按成功整理边界保留未整理经历，并额外保留约 16k 估算 Source token 的近期原始重叠。

当前实验默认约 170k 估算上下文软触发，选择较老约 120k 完整授权工作历史。170k 包括固定上下文和 Delivery，120k 只计短期历史，因此整理后总量不保证精确 50k。这是宿主可覆盖的实验配置，不是模型容量承诺或硬上限；估算也不是供应商精确 tokenizer。

手动和自动整理均复用既有 Core 流程，在排队前冻结来源前缀。默认 2 个角色 Build 并行，每角色 2 个 Retain 批次有限并行；完整 Atom 校验后依次 Group、Consolidate 和索引。后台不占前台 busy 或 writer lease，玩家与 NPC 继续游玩。

安装只接受严格更新的 `scope.asOfWorldSeq`，原子保存成功后才推进边界。迟到旧结果丢弃；失败／取消保留原档案和新经历，关闭取消临时工作，不保证未提交计划精确续跑。旧 200k/150k 同步整理和按轮次检查属于前序实验。

## 证据与已知限制

同批 196 条 Source、16 次 Utility 的一次后台重放为 148.063 秒，启动请求 0.411 秒；期间对话、移动和房间隔离通过。尚未真实跨越 170k，也未完成 32k/64k/128k/192k 成组对照，不能据此宣称大窗口延迟和压缩质量已验收。

宽准入仍可能交付无关认识，关键原因也可能未被选进 Delivery；持续目标牵引、人物自然度和长期认识更新收益未全面验收。一般认识家族发现和多分支更新未全面验收。当前便携候选包已包含 Python/Core/E5 资产；干净 Windows 环境及长期稳定性验收仍见[候选包记录](../studies/launcher-portable-test3-20261009.md)。程序隔离与自由文本语义一致性仍分别验收。

当前环境准备见 [Core 记忆说明](../../../desktop/host/memory/README.md)。2026-10-21 已核对宿主适配与 Python 文件迁移、源码和发行目录解析；这一整理没有重新验收角色长期记忆体验。

历史运行与实验证据：[Activity Memory](../../../experiments/activity-memory/README.md)、[Hindsight Core](../../../experiments/hindsight-core/README.md)、[AI Girls 研究](../studies/ai-girls/README.md)。源码：[原生记忆](../../../packages/memory)、[宿主 Core](../../../desktop/host/memory/core-memory.ts)、[Python 桥](../../../desktop/host/memory/python/bridge/core_bridge.py)、[候选准入](../../../desktop/host/memory/python/bridge/candidate_admission.py)、[极简 Delivery](../../../desktop/host/memory/python/bridge/minimal_delivery.py)。

### 官方序章的经历边界

序章模拟输出继续经过普通发表、授权观察及已有记忆输入；5 条玩家问题也正式提交，来源仅记录在活动事件审计字段。可见物品的 kind 是已提交的材料／熟饭／空容器状态；远处物品和未经授权目击的归属不会通过新增活动 world 输入暴露。第二天按钮仅改变活动公开日标签并提交明确点击的回访问题，不自动生成承诺或证明长期记忆检索已成功。完整序章无模型实验验证输入链路，跨压缩后真实召回另列体验验收。

官方包真实 Gemini 样例随后验证了归档后的约定召回：近期原文已不含九点／电饭锅，授权长期交付仍含实际约定，GPT 在第二天回答正确。私密样例中 Claude 以 private 回复，GPT 没有收到秘密且同场明确表示不知道。见 [真实验收](../../../examples/world-packs/model-girls-official/LIVE-VALIDATION.md)；只证明该样例，不保证所有推断或自由表达都与权限事实一致。

### 序章回合身份快照（2026-10-10）

玩家点击“继续”时，末端重新生成仍保存操作前的完整数据库起点。没有已安装长期档案的角色，只保存此前授权上下文得到的身份别名，并核对角色、世界和已提交前缀；不再为了保存名字逐角色构建全部授权记忆源。返回的别名是独立副本。存在已安装档案时，仍使用完整来源快照核对档案前缀；实际召回和后台整理仍按原有授权 Source 路径构建。

这是宿主源码优化，不改变发表、观察或记忆归档协议，也不取消数据库备份。尚未重新构建便携发行包；已有长期档案的快照仍接受原来的来源校验成本。


## 模型上下文呈现

Claude 私下听到一句暗号后，模型历史仍包含原始话语、private 受众和来源性质；GPT 的历史仍只有它有权看到的记录。呈现步骤不会补入其他角色经历，也不改变观察投影或记忆交付权限。

`characterRequestText` 在最后序列化阶段把 `observations` 与 `selfObservations` 合并成 `context.history`，使用宿主 `sourceSeq` 排序，以 observed / self 区分观察和自己的表达。模型不再接收排序序号、追踪 action/observation ID、证据 Hash、提交前缀和来源索引引用等保管字段；来源类型、正文、受众、认识置信与立场、记忆年龄保留。当前位置从 `character.locationId` 移到 `context.locationId`，系统说明同步解释该字段。

字段顺序（2026-10-24 调整）：例如 Claude 在书房连续两次回应屋主，两次请求的角色设定、所在房间、物品、可用操作和操作说明都没变，只有经历多了一条、刺激换了一句。现在 `context` 依次是：角色设定 `character`、`cognition`、`claims`、`goals`、`publicationCharacters`、`knownStatusNote`，然后是经历 `history`，再是眼下处境 `locationId`、`memories`、`knownStatus`、`items`、`scene`、`affordances`、`actionExplanations`，未列出的字段（如 `activity`、`autonomy`）保持相对顺序放在其后，最后是 `recentExecutionEvidence`、`statusChanges`、`stimulus`。（2026-10-25 再次调整：最初把处境放在 `history` 之前，依据的是本地记忆下只有几千字符的短 `history`；Launcher 默认的 Core 记忆会让 `history` 累积到数万字符，占请求九成以上，处境里任何一项变化都会让其后的整段经历无法复用。用玩家真实试玩的 40 次请求模拟，处境在前时理论可复用前缀为 55%，`history` 在前时为 84%。）这样同一房间的相邻请求能共享很长的前缀，模型服务的前缀缓存可以命中；当前刺激也紧跟在经历之后、位于上下文末尾。只改变呈现顺序，不增删字段、不改变授权内容。

调整前 `history` 排在第二位，它每次都会追加，导致其后约五千字符的稳定内容无法复用；`stimulus` 名义上最后写入，实际因对象键顺序停在场景之前。2026-10-24 用 deepseek-flash、本机《屋檐下的心动日程》与同一套 11 步对白做 A/B（新旧顺序各 2 局，其余完全相同）：实际缓存命中率 47.8% → 63.8%，每次调用未命中输入 token 3447 → 2436（约 −29%）；回复长度、套话与第一人称旁白无差异，两组角色都回应了最新输入。两组各出现叙事疏漏：旧顺序一次虚构“红茶已喝完”，新顺序一局中 Claude 写出尚未购买的黄铜书签，并两次以“他”指代屋主。样本小，未观察到系统性退化，也不能证明行为等价。

`history` 是否只在末尾追加，取决于记忆模式。例如 GPT 已有 20 条经历时又听到一句话：Core 记忆（Launcher 默认）把记忆边界之后的经历全部放进 `history`，两次记忆整理之间只在末尾追加，整理后边界前移一次；本地记忆（`--memory-native`，离线调试用）只取最近 16 条观察与 8 条自我表达（[character-turn.ts](../../../packages/application/src/character-turn.ts) 的 `recentObservations` / `recentSelfObservations`），超出后每来一条新经历就从开头挤出最旧一条，`history` 整体前移，前缀从开头断开。2026-10-24 用固定回复模型让玩家连说 30 句验证：本地记忆下 GPT 的 `history` 停在 16 条，之后 17 次请求都从开头断开；Core 记忆下从 4 条增长到 33 条，29 次全部纯追加。上文 A/B 与早期试玩驱动使用本地记忆，较长的对局里观察到的约两成“开头不同”即来自这一滑动窗口，并非初始观察排序不稳定。本地记忆路径的这一缓存损失作为已知限制保留，未改动窗口规则。

公开状态的变化（2026-10-25）：例如屋主在深夜说完“晚安”就结束今天，GPT 第二天清晨被自主行动唤起。以前她的刺激为空，最近的经历停在那句晚安，`knownStatus` 里的“清晨”只是一个状态值，她常常接着道晚安；不在同一房间的角色连推进时段的旁白都看不到。现在宿主在每次角色调用前，把她最近一次被提交的行动（`action.resolved` 的 `actorId` 是她；从未行动则以初始状态为准）时知道的公开状态，与现在知道的值比较，值不同的公开状态（`holderId` 为空且当前已确认）列为 `context.statusChanges`：`[{ key, label, from, to }]`，例如“天数 1→2、今日时段 深夜→清晨”，停电时还有“全屋供电 true→false”。只从已提交事件推导，不新增存储，重启或重新生成同一回合给出相同结果；它不授予新的知识，列出的都是她本来就能在 `knownStatus` 里看到的公开值。系统说明同步解释这个字段；自主行动提示保留“没有新消息不代表发生了你不知道的事”，并补充“statusChanges 里的变化已经发生，请按现在的时段与处境行动”。实现见 [pack-status.ts](../../../desktop/host/pack-status.ts) 的 `publicStatusChanges` 与 [world-runtime.ts](../../../desktop/host/world-runtime.ts)。

验证：场景测试覆盖“推进到深夜、说晚安、结束今天”后 GPT 收到天数与时段变化，同一晚相邻请求没有变化。2026-10-25 用 deepseek-flash 做受控回放：取真实的第二天清晨 GPT 自主请求，去掉她对晚安的回应，使最后一条经历是屋主的“晚安”，同一请求各发 6 次。旧提示且无 `statusChanges` 时 3 次接着道晚安或说“明早”、1 次关灯离开、2 次 abstain；新提示加 `statusChanges` 时 5 次按清晨说话、1 次移动。另跑 4 局完整对局（Core 记忆，新旧各 2 局），`statusChanges` 在每次推进时段与睡醒后的唤起中正确送达；这 4 局里没有自然出现“晚安未回应就入睡”的条件，因此行为差异以受控回放为证据。样本小，未覆盖停电、打工外出等其他状态变化的真实表现。

工具 Schema、Action 参数、交互目标与绑定引用、Activity 和作者变量保留原样；历史中的 parameters / arguments 也不按元数据字段名过滤。Rulebook、Core 归档与模型追踪继续使用原始宿主请求，结果续写仅去除外层 operationId / eventRefs，保留实际行动、状态与结果描述。没有新增输出协议、持久化格式或缓存服务。

2026-10-12 的[操作语义说明实验](../studies/action-semantics-20261012.md)在这一最终呈现步骤增加了 actionExplanations。2026-10-22 核对：[当前实现](../../../packages/provider-chat/src/character-action-explanations.ts)仍只按本次 affordances 和角色自己当前场所的已有名称生成说明，例如“前往旅馆”对应已有 move 参数；物品操作使用作者标签与目标，并携带参数契约，不再对旧保管定义使用专用文案模板。它不查询其他角色私密信息或远处物品，不猜自定义效果，不增加操作；关闭 perform 时不提供说明。观察、记忆与世界提交格式未因此改变；旧实验的开销和真实验证结论只适用于当时版本，当前作者规则样本见[项目状态](../PROJECT-STATE.md#验证到了哪一步)。

针对同一盲测第 17–22 轮的 35 个旧请求作离线对比，模型用户消息估算总量减少 25.4%；同角色相邻 31 对请求的系统说明加用户文本，共同前缀加权比例从 2.47% 升到 94.63%。这是文本稳定性与本地估算，未计供应商工具序列化、缓存路由与实际 tokenizer，不能视为真实缓存命中率。85 项相关回归通过，涵盖原始宿主证据仍可归档、私密发生记录及行动结果续写。真实模型样例与剩余限制见[玩家验收记录](../../../examples/world-packs/model-girls-official/PLAYER-VALIDATION.md)。


### 故事节点的记忆时间边界（2026-10-09）

玩家在晚餐后保存节点，再在第二天形成新认识；返回晚餐节点时，只恢复晚餐当时已安装的角色档案和节点内授权原始经历。不会复制原线当前档案，也不会为了保存或分叉调用模型重新整理。

保存先取消并收束后台整理，将当时已安装的各角色 archive、index 与 aliasHistory 写入不可变节点的 `core-memory.json`，与既有数据库及身份快照一起保存。恢复复用已有校验：角色、世界、档案与索引 scope、记忆前缀和完整授权 Source 前缀必须匹配节点。未来前缀、其他角色档案或来源改变会拒绝启动，保留恢复标记供重试；原线不变。历史文件名 `rebuild-memory.json` 现在只表示恢复尚未完成，不再触发 Build。

未建立长期档案的角色继续使用节点内完整授权原始经历。旧节点缺少 Core 快照时也采用此路径，不能精确还原从未保存的长期摘要，但不会引入未来认识。2026-10-15 分享文件开始携带节点已有的 `core-memory.json`；例如晚餐节点分享给朋友后，角色保留晚餐当时已整理的认识及随后至节点的授权原文。导出与导入在临时副本上复用 `restoreArchives` 校验，其他角色、未来前缀或被修改的授权 Source 会在实例公布前拒绝；源节点和已有实例不变。既有未携带快照的分享继续使用授权原文，没有新增迁移协议。后续自动整理仍按上下文阈值触发，手动整理入口保持。保存、分叉和长期整理的触发分别处理。

回归覆盖已有档案及原文尾部恢复、连续保存/分叉零 Build、旧节点缺少快照、未来/其他角色/来源污染拒绝、原线保护和分享。实际旧节点副本恢复到 headSeq 2227 / tick 328，记忆 runner 在任何调用时都会抛错，恢复仍成功，模型调用为零；原存档未修改。没有重新验收长期文本质量或原生界面完整点击流程。

此前强制重建曾在 DeepSeek 直连遇到推理耗尽输出预算：16 次 Retain HTTP 请求均为 200，15 次完成 Token 全部为 reasoning，累计 83,806 完成 Token 中 83,378 为 reasoning。Utility JSON 请求已显式发送 `thinking: {type: disabled}`，该修复仍服务正常阈值/手动整理；保留完整 JSON 与授权校验，不把推理文本当记忆正文。失败诊断仅记录 finishReason、正文字符数和错误类型，不记录正文或凭证。此前 Gemini 分叉重建约 26.8 秒的实测属于旧流程，不代表当前分叉需要调用模型。
