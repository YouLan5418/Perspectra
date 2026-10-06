# 记忆与认知实验

| 属性 | 内容 |
| --- | --- |
| 当前状态 | 6.0—6.6简化实验及网页有限接入完成；Context地点缺陷已修复 |
| 正常入口 | 新启动的源码网页显式使用 `--memory-core`；未传开关时沿用原生记忆 |
| 当前策略 | 原检索 + 简单ID候选准入 + 极简Delivery；JEV不作为必经；宽短期尾部、按上下文体积自动整理及手动整理 |
| 证据范围 | 有真实双角色、跨房间与浏览器实测；单轨迹不证明稳定收益或完整产品验收 |
| 历史 | [历史命令与记录](HISTORY.md)，保留此前的配置、失败与对照 |

## 1. 独立环境与网页试玩

在仓库根目录准备 Python 3.12 环境。依赖、E5 revision和资产校验描述位于仓库；环境和模型权重放在忽略的`.tmp`中。

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
python -m venv .tmp/hindsight-vector-venv
& .tmp/hindsight-vector-venv/Scripts/python.exe -m pip install -r experiments/hindsight-core/requirements-vector.txt
& .tmp/hindsight-vector-venv/Scripts/python.exe experiments/hindsight-core/setup-vector.py

# 本次本机网关使用8046；服务端口不同时调整此值
$env:HCW_LOCAL_ENDPOINT = 'http://127.0.0.1:8046/v1/chat/completions'
corepack pnpm@11.7.0 experience:web --memory-core --pack examples/world-packs/prototype-g1 --data-dir .tmp/my-simple-core-web
```

每个新实验使用未占用的数据目录。打开终端打印的带token本机地址；需要API认证时只通过`HCW_LOCAL_API_KEY`传入，不写进文件。`HCW_HINDSIGHT_PYTHON`、`HCW_HINDSIGHT_CORE_DIR`和`HCW_HINDSIGHT_ONNX_DIR`可显式覆盖本地路径。默认模型为`gemini-3.7-flash`，网关别名不证明底层模型身份。

Core开关目前支持本机OpenAI兼容服务的源码网页；Ollama/DeepSeek不能同时启用Core。桌面发布目录尚未打包Python、Core和E5资产。

## 2. 当前运行路径

宿主按角色提供已授权Source前缀，Core沿现有Retain→Group→Consolidate生成Atom、Episode、Observation与索引。原词法/本地向量检索保留分数诊断，简单ID准入补充认识候选；极简Delivery交付认识正文、来源类型、未解决反证标记和少量关键证据。源码Core最多六项、12000 JSON字符（独立对照脚本未传预算时仍沿用三项/4500），不再因发言支持或证据整组放不下就取消认识正文；摘选不完整会明确标注。

正常源码网页的每个会话按需启动一个长生命周期Python Core进程；顺序构建和召回共用既有E5编码器，档案、角色scope和授权Source仍逐请求提供。取消正在运行的Core任务会终止该进程，下一次请求重新启动；关闭网页运行时会回收进程。独立对照脚本仍可使用单次进程入口，检索算法没有改变。

宿主继续检查世界、角色、前缀、引用和摘选授权。认识是角色可修正的理解，不是权威世界事实；重要状态仍通过Action/Rulebook/Event裁定提交。Core模式关闭重复的原生`prepareStimulus`和主动recall，授权Source catch-up保留。复杂Delivery和JEV仍在历史对照工具中。

宿主手动“后台整理长期记忆”在排队前冻结每角色已授权Source前缀，复用旧Source/Atom；默认2个角色Build、每角色2个Retain批次有限并行，完整Atom合并/校验后依次Group、Consolidate与索引。后台不占前台busy、writer lease或常驻召回worker，玩家/NPC继续游玩。安装比较现有`scope.asOfWorldSeq`，仅严格更新时原子保存；旧结果迟到则丢弃，失败/取消保留各自原档案和未整理经历，关闭立即取消，没有持久任务或精确续跑。

Core取消16/8截断；实验默认约170k估算上下文软触发，按完整来源选较老约120k工作历史。冻结前缀后的全部原始经历保留，并额外保留约16k估算Source token近期重叠，手动整理也不清空所有近期材料。各预算可通过宿主实验选项覆盖，未传Core开关的原生模式沿用原窗口。600秒Build期限及已有Utility重试策略保持；attempt元数据写入`memory-core/utility-attempts-<pid>.jsonl`，按时间合并可查看真实并发、超时、重试、模型和usage。整理不提交世界事实，检索/Delivery语义不变。详见[后台整理与验收](../../docs/current/studies/ai-girls/background-compaction.md)。

当前角色地点由同一调用前缀的角色view生成，身份与设定来自Manifest。一般家族发现、多分支认识更新和正式schema改造仍未接入正常网页。

## 3. 当前简化实验与证据

| 阶段 | 结论及边界 | 报告 |
| --- | --- | --- |
| 6.0 原始授权Source | 验证更短的阅读路径，复杂档案仍可能为空 | [第一步](reports/report-memory-simplification.md) |
| 6.1 候选准入 | 打通认识候选入口，暴露复杂Delivery压住正文 | [候选入口](reports/report-candidate-admission.md) |
| 6.2 极简Delivery/JEV | 正文实际交付；JEV保留可选对照，未证明必经收益 | [Delivery与消融](reports/report-minimal-delivery-and-jev-ablation.md) |
| 6.3 即时证据 | 原始自然语言证据可支撑回应，未见认识提高行动率 | [即时对照](reports/report-immediate-delivery.md) |
| 6.4 延迟闭环 | 真实取证、新Source和已知家族更新跑通；非通用谱系 | [延迟闭环](reports/report-delayed-loop.md) |
| 6.5 网页有限接入 | 12次输入、2次整理；仅同行者实际模型调用 | [网页接入](reports/report-web-continuous.md) |
| 6.6 正常双角色 | 19次输入、2次整理、25次角色调用；暗号隔离正常 | [双角色实测](reports/report-normal-playtest.md) |
| 地点修复复验 | 默认check185项；新世界12次请求与提交地点一致 | [修复复验](reports/report-normal-playtest.md#5-地点投影修复及真实复验) |

实施决策见[记忆认知简化方案](../../docs/archive/memory-evolution/2026-10-05_记忆认知体系简化方案.md)，整体项目状态见[当前状态](../../docs/current/PROJECT-STATE.md)。早期活动、反证裁剪、Bank和认识谱系实验的完整命令与报告链接在[历史记录](HISTORY.md)。

## 4. 文件职责与复核

| 位置 | 职责 |
| --- | --- |
| `tests/experiments/playtest-memory-core.ts` | 网页角色授权、缓存、交付与引用检查 |
| `tests/experiments/playtest-frozen-runtime.ts` | 正常角色激活与Core开关接线 |
| `experiments/hindsight-core` | 随仓库保存的分层核心、本地编码器资产描述 |
| `core_bridge.py`、`candidate_admission.py`、`minimal_delivery.py` | 当前Python桥、候选准入及极简交付 |
| `tests/experiments/memory-*.ts` | 独立对照的准备、执行和闭环驱动 |
| `audit_*.py`、`test_*.py`、`reports/report-*.md` | 离线审计、回归及实验报告 |
| `.tmp/<实验目录>` | 新世界、角色缓存、私有trace、实际模型返回与审计结果 |

```powershell
# 不调用模型：候选准入、极简交付、认识谱系的相关回归
& .tmp/hindsight-vector-venv/Scripts/python.exe -m unittest discover -s experiments/activity-memory -p test_candidate_admission.py
& .tmp/hindsight-vector-venv/Scripts/python.exe -m unittest discover -s experiments/activity-memory -p test_minimal_delivery.py
& .tmp/hindsight-vector-venv/Scripts/python.exe -m unittest discover -s experiments/activity-memory -p test_cognition_lineage.py

# 复核既有真实试玩记录；会写本地审计结果，不再调用模型
& .tmp/hindsight-vector-venv/Scripts/python.exe experiments/activity-memory/audit_normal_playtest.py .tmp/simple-memory-playtest-20261005-v3
```

`memory-core/recall-trace.jsonl`和`model-trace.jsonl`保存角色私有材料，供本机审阅，不进入玩家页面。6.6原轨迹为v2，修复复验为v3；v2浏览器截图和快照归档至`browser-artifacts/`。旧世界及失败记录保留。

## 5. 仍接受的限制

宽准入会在无关话题交付旧认识；同行者可能被持续目标牵引而忽略新话题。部分证据只摘选，认识文字和反证布尔标记不能互相替代。手动整理仍需等待Utility处理；初期四角色为12次，较长增量材料会增加提炼批数。本轮AI美少女包复测的24次热启动完整召回为0.033—0.489秒；冷启动和取消后的重新加载仍有成本。已提交NPC回复在反应链进行中按玩家权限投影，不提供token流。测量与边界见[体验与性能首轮优化](../../docs/current/studies/ai-girls/optimization.md)；单轨迹并未证明稳定自然度或长期记忆更新收益。

[整理间隔实测](../../docs/current/studies/ai-girls/memory-cadence.md)继续同一AI美少女存档31次输入：两角色轨迹的新信息第8轮仍在窗口，第9轮退出并遗忘；人工整理后6次回答恢复。阻塞整理458秒、16次Utility处理；已有档案也出现原因未交付的细节遗漏。这是旧16/8配置的结果；后续按用户要求采用宽窗口，当前约170k/120k软触发后台整理，6—8轮不再作为当前整理候选周期。

本轮核心尚未成为默认记忆，完整多场景体验、桌面Core打包和通用认识版本更新未验收。后续以正常试玩的具体失败和已测等待决定局部投入。

宽窗口实现、当前参数及真实复测见[2026-10-06宽上下文记录](../../docs/current/studies/ai-girls/wide-context.md)。

完整报告入口：[报告索引](reports/README.md)。阶段历史命令继续保存在 [HISTORY](HISTORY.md)。
