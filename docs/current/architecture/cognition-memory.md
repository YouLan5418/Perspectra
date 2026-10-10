# 当前认知与记忆

> 2026-10-10 的[短信实验](../studies/cross-scene-communication-20261010.md)保留通信媒介：带 medium 的 speech 在来源文本、metadata 和自身发表中注明媒介，仍是发送者陈述。通信观察不授予对方房间视野；[电话实验](../studies/cross-scene-phone-20261010.md)的本地旁观者只收到本端声音。原生与 Core 桥的授权来源边界有自动验证；没有 medium 的既有来源保持原渲染。Core 的新增验证范围见[通信 Core 记忆实验](../studies/cross-scene-core-memory-20261010.md)。

> [节点实验](../studies/cross-scene-nodes-20261010.md)已验证通信的原生记忆回退、分享后按授权观察重建和真实模型续话。实验入口现在也可显式注入既有 PlaytestMemoryCore：本地回退恢复节点归档，分享保持不传 Core 缓存，导入后可按授权历史整理。未启用 Core 的入口仍明确拒绝非空 Core 快照或身份别名，默认宿主的恢复实现未修改。

> [工具耗时排查](../studies/core-utility-timing-20261010.md)确认 Python Core 的 thinking.disabled 未约束本机 Gemini 网关。按用户要求，当前 Gemini 的 OpenAI 兼容 Core 请求先发 reasoning_effort=low，仅超时后重试一次，移除该字段并改发 thinking.disabled；第二次失败停止。每次仍为 120 秒，并记录实际尝试的参数档位。非超时错误不触发这条回退；其他模型与原生协议沿用既有配置。客户端字段不证明网关真正关闭思考或执行输出上限。

这是了解 Perspectra 当前记忆的首选入口。直接源码网页默认原生记忆，显式 --memory-core 使用下述简化 Core 路径；当前 Launcher 后端启用 Core。记忆路径已接入不表示全部长期角色体验均已验收。

## 默认原生记忆

默认路径仍由 CognitiveMemoryService / LocalMemoryStore 从当前角色授权观察 catch-up 到指定世界前缀。prepareStimulus 按刺激及场景线索准备召回材料，角色也可在允许的决策阶段主动 recall 一次，再自行回应。来源类型和引用随结果保留；未命中不代表没有发生。近期观察／自身表达沿原生窗口，不套用 Core 的宽窗口或后台参数。

实现见[原生上下文服务](../../../packages/memory/src/cognitive-context.ts)与[本地记忆](../../../packages/memory/src/local-memory.ts)。以下 Source / Atom / Episode / Observation 分层、候选准入和极简 Delivery 描述显式 Core 实验，而非默认模式的全面改造。

## 授权材料与分层整理

Source 是角色获授权的原始经历，保留来源身份、类型和提交前缀。Core 不获得其他角色的来源或写世界状态的能力。Retain 从来源提炼 Atom；Group 将相关材料组织成 Episode；Consolidate 形成 Observation。这里的 Observation 是可修正认识，与运行时原始授权观察须区分，不能升级为权威世界事实。

构建沿 Retain → Group → Consolidate → 索引顺序推进，旧 Source / Atom 前缀可复用。每个角色档案独立，引用回到该角色授权 Source；宿主复核世界、角色、前缀和引用权限。角色 identity/设定来自 Manifest，当前位置来自同一调用前缀的当前 view。

## 当前 Recall 与 Delivery

当前 Core 保留词法／本地 E5 向量等现有检索与分数诊断，加入简单 ID 候选准入，再作极简 Delivery，送给 Character。认识正文优先，附来源类型、未解决反证存在标记和少量关键证据。不再要求全部支持证据都是 direct observation / accepted action，也不要求整个 Evidence Group 一起装入预算；不完整摘选有标注，权限检查保留。

源码网页预算最多 6 项、12000 JSON 字符；未显式配置的独立对照脚本仍可采用 3 项／4500。Core 模式关闭重复原生 prepareStimulus 和主动 recall，授权 Source catch-up 保留。JEV 是可选实验对照，当前不是必经步骤；不把历史复杂 Delivery 规则恢复为正常入口。

每会话按需启动一个长生命周期 Python Core 进程供顺序召回复用 E5 编码器；档案和 scope 仍逐请求提供。取消运行中任务会终止进程，下次调用重建，关闭宿主回收资源。

## 短期上下文与后台长期整理

Core 不再按 16 条观察／8 条自身表达截断；首次整理前保留授权工作历史。后续按成功整理边界保留未整理经历，并额外保留约 16k 估算 Source token 的近期原始重叠。

当前实验默认约 170k 估算上下文软触发，选择较老约 120k 完整授权工作历史。170k 包括固定上下文和 Delivery，120k 只计短期历史，因此整理后总量不保证精确 50k。这是宿主可覆盖的实验配置，不是模型容量承诺或硬上限；估算也不是供应商精确 tokenizer。

手动和自动整理均复用既有 Core 流程，在排队前冻结来源前缀。默认 2 个角色 Build 并行，每角色 2 个 Retain 批次有限并行；完整 Atom 校验后依次 Group、Consolidate 和索引。后台不占前台 busy 或 writer lease，玩家与 NPC 继续游玩。

安装只接受严格更新的 `scope.asOfWorldSeq`，原子保存成功后才推进边界。迟到旧结果丢弃；失败／取消保留原档案和新经历，关闭取消临时工作，不保证未提交计划精确续跑。旧 200k/150k 同步整理和按轮次检查属于前序实验。

## 证据与已知限制

同批 196 条 Source、16 次 Utility 的一次后台重放为 148.063 秒，启动请求 0.411 秒；期间对话、移动和房间隔离通过。尚未真实跨越 170k，也未完成 32k/64k/128k/192k 成组对照，不能据此宣称大窗口延迟和压缩质量已验收。

宽准入仍可能交付无关认识，关键原因也可能未被选进 Delivery；持续目标牵引、人物自然度和长期认识更新收益未全面验收。一般认识家族发现和多分支更新未全面验收。当前便携候选包已包含 Python/Core/E5 资产；干净 Windows 环境及长期稳定性验收仍见[候选包记录](../studies/launcher-portable-test3-20261009.md)。程序隔离与自由文本语义一致性仍分别验收。

运行与实验证据：[Activity Memory](../../../experiments/activity-memory/README.md)、[Hindsight Core](../../../experiments/hindsight-core/README.md)、[AI Girls 研究](../studies/ai-girls/README.md)。源码：[原生记忆](../../../packages/memory)、[宿主 Core](../../../tests/experiments/playtest-memory-core.ts)、[Python 桥](../../../experiments/activity-memory/core_bridge.py)、[候选准入](../../../experiments/activity-memory/candidate_admission.py)、[极简 Delivery](../../../experiments/activity-memory/minimal_delivery.py)。

### 官方序章的经历边界

序章模拟输出继续经过普通发表、授权观察及已有记忆输入；5 条玩家问题也正式提交，来源仅记录在活动事件审计字段。可见物品的 kind 是已提交的材料／熟饭／空容器状态；远处物品和未经授权目击的归属不会通过新增活动 world 输入暴露。第二天按钮仅改变活动公开日标签并提交明确点击的回访问题，不自动生成承诺或证明长期记忆检索已成功。完整序章无模型实验验证输入链路，跨压缩后真实召回另列体验验收。

官方包真实 Gemini 样例随后验证了归档后的约定召回：近期原文已不含九点／电饭锅，授权长期交付仍含实际约定，GPT 在第二天回答正确。私密样例中 Claude 以 private 回复，GPT 没有收到秘密且同场明确表示不知道。见 [真实验收](../../../examples/world-packs/model-girls-official/LIVE-VALIDATION.md)；只证明该样例，不保证所有推断或自由表达都与权限事实一致。

### 序章回合身份快照（2026-10-10）

玩家点击“继续”时，末端重新生成仍保存操作前的完整数据库起点。没有已安装长期档案的角色，只保存此前授权上下文得到的身份别名，并核对角色、世界和已提交前缀；不再为了保存名字逐角色构建全部授权记忆源。返回的别名是独立副本。存在已安装档案时，仍使用完整来源快照核对档案前缀；实际召回和后台整理仍按原有授权 Source 路径构建。

这是宿主源码优化，不改变发表、观察或记忆归档协议，也不取消数据库备份。尚未重新构建便携发行包；已有长期档案的快照仍接受原来的来源校验成本。


## 模型上下文呈现

Claude 私下听到一句暗号后，模型历史仍包含原始话语、private 受众和来源性质；GPT 的历史仍只有它有权看到的记录。呈现步骤不会补入其他角色经历，也不改变观察投影或记忆交付权限。

`characterRequestText` 在最后序列化阶段把 `observations` 与 `selfObservations` 合并成 `context.history`，使用宿主 `sourceSeq` 排序，以 observed / self 区分观察和自己的表达。模型不再接收排序序号、追踪 action/observation ID、证据 Hash、提交前缀和来源索引引用等保管字段；来源类型、正文、受众、认识置信与立场、记忆年龄保留。角色身份/设定先呈现，历史随后，当前刺激、场景、当前位置和调用阶段随后，减少追加经历时的早期文本变化。当前位置从 `character.locationId` 移到 `context.locationId`，系统说明同步解释该字段。

工具 Schema、Action 参数、交互目标与绑定引用、Activity 和作者变量保留原样；历史中的 parameters / arguments 也不按元数据字段名过滤。Rulebook、Core 归档与模型追踪继续使用原始宿主请求，结果续写仅去除外层 operationId / eventRefs，保留实际行动、状态与结果描述。没有新增输出协议、持久化格式或缓存服务。

针对同一盲测第 17–22 轮的 35 个旧请求作离线对比，模型用户消息估算总量减少 25.4%；同角色相邻 31 对请求的系统说明加用户文本，共同前缀加权比例从 2.47% 升到 94.63%。这是文本稳定性与本地估算，未计供应商工具序列化、缓存路由与实际 tokenizer，不能视为真实缓存命中率。85 项相关回归通过，涵盖原始宿主证据仍可归档、私密发生记录及行动结果续写。真实模型样例与剩余限制见[玩家验收记录](../../../examples/world-packs/model-girls-official/PLAYER-VALIDATION.md)。


### 故事节点的记忆时间边界（2026-10-09）

玩家在晚餐后保存节点，再在第二天形成新认识；返回晚餐节点时，只恢复晚餐当时已安装的角色档案和节点内授权原始经历。不会复制原线当前档案，也不会为了保存或分叉调用模型重新整理。

保存先取消并收束后台整理，将当时已安装的各角色 archive、index 与 aliasHistory 写入不可变节点的 `core-memory.json`，与既有数据库及身份快照一起保存。恢复复用已有校验：角色、世界、档案与索引 scope、记忆前缀和完整授权 Source 前缀必须匹配节点。未来前缀、其他角色档案或来源改变会拒绝启动，保留恢复标记供重试；原线不变。历史文件名 `rebuild-memory.json` 现在只表示恢复尚未完成，不再触发 Build。

未建立长期档案的角色继续使用节点内完整授权原始经历。旧节点和分享节点缺少 Core 快照时也采用此路径，不能精确还原从未保存的长期摘要，但不会引入未来认识。后续自动整理仍按上下文阈值触发，手动整理入口保持。保存、分叉和长期整理的触发分别处理。

回归覆盖已有档案及原文尾部恢复、连续保存/分叉零 Build、旧节点缺少快照、未来/其他角色/来源污染拒绝、原线保护和分享。实际旧节点副本恢复到 headSeq 2227 / tick 328，记忆 runner 在任何调用时都会抛错，恢复仍成功，模型调用为零；原存档未修改。没有重新验收长期文本质量或原生界面完整点击流程。

此前强制重建曾在 DeepSeek 直连遇到推理耗尽输出预算：16 次 Retain HTTP 请求均为 200，15 次完成 Token 全部为 reasoning，累计 83,806 完成 Token 中 83,378 为 reasoning。Utility JSON 请求已显式发送 `thinking: {type: disabled}`，该修复仍服务正常阈值/手动整理；保留完整 JSON 与授权校验，不把推理文本当记忆正文。失败诊断仅记录 finishReason、正文字符数和错误类型，不记录正文或凭证。此前 Gemini 分叉重建约 26.8 秒的实测属于旧流程，不代表当前分叉需要调用模型。
