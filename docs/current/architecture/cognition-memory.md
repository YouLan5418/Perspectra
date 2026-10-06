# 当前认知与记忆

这是了解 Perspectra 当前记忆的首选入口。默认网页仍使用原生记忆；源码网页显式 `--memory-core` 才使用下述简化 Core 路径。Core 已有限接入，不等于正式替换默认记忆或完成桌面发布。

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

宽准入仍可能交付无关认识，关键原因也可能未被选进 Delivery；持续目标牵引、人物自然度和长期认识更新收益未全面验收。一般认识家族发现、多分支更新和桌面 Core 资产打包未完成。程序隔离与自由文本语义一致性仍分别验收。

运行与实验证据：[Activity Memory](../../../experiments/activity-memory/README.md)、[Hindsight Core](../../../experiments/hindsight-core/README.md)、[AI Girls 研究](../studies/ai-girls/README.md)。源码：[原生记忆](../../../packages/memory)、[宿主 Core](../../../tests/experiments/playtest-memory-core.ts)、[Python 桥](../../../experiments/activity-memory/core_bridge.py)、[候选准入](../../../experiments/activity-memory/candidate_admission.py)、[极简 Delivery](../../../experiments/activity-memory/minimal_delivery.py)。
