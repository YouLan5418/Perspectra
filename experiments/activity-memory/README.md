# 记忆与认知实验

| 属性 | 内容 |
| --- | --- |
| 当前状态 | 6.0—6.6简化实验及网页有限接入完成；Context地点缺陷已修复 |
| 正常入口 | 新启动的源码网页显式使用 `--memory-core`；未传开关时沿用原生记忆 |
| 当前策略 | 原检索 + 简单ID候选准入 + 极简Delivery；JEV不作为必经；手动整理 |
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

宿主按角色提供已授权Source前缀，Core沿现有Retain→Group→Consolidate生成Atom、Episode、Observation与索引。原词法/本地向量检索保留分数诊断，简单ID准入补充认识候选；极简Delivery交付认识正文、来源类型、未解决反证标记和少量关键证据。最多三项、4500 JSON字符，不再因发言支持或证据整组放不下就取消认识正文；摘选不完整会明确标注。

宿主继续检查世界、角色、前缀、引用和摘选授权。认识是角色可修正的理解，不是权威世界事实；重要状态仍通过Action/Rulebook/Event裁定提交。Core模式关闭重复的原生`prepareStimulus`和主动recall，授权Source catch-up保留。复杂Delivery和JEV仍在历史对照工具中。

宿主手动“整理长期记忆”复用校验过的旧Source/Atom，只提炼新增来源，再重建认识和索引。首次整理前长期交付为空，近期上下文正常；两次整理之间档案保持上次前缀。整理期间普通输入暂停，宿主逃生可取消，完成/失败/取消后恢复输入。完整角色缓存保留，其余保留旧缓存。整理不会提交游戏结果。

当前角色地点由同一调用前缀的角色view生成，身份与设定来自Manifest。一般家族发现、多分支认识更新和正式schema改造仍未接入正常网页。

## 3. 当前简化实验与证据

| 阶段 | 结论及边界 | 报告 |
| --- | --- | --- |
| 6.0 原始授权Source | 验证更短的阅读路径，复杂档案仍可能为空 | [第一步](report-memory-simplification.md) |
| 6.1 候选准入 | 打通认识候选入口，暴露复杂Delivery压住正文 | [候选入口](report-candidate-admission.md) |
| 6.2 极简Delivery/JEV | 正文实际交付；JEV保留可选对照，未证明必经收益 | [Delivery与消融](report-minimal-delivery-and-jev-ablation.md) |
| 6.3 即时证据 | 原始自然语言证据可支撑回应，未见认识提高行动率 | [即时对照](report-immediate-delivery.md) |
| 6.4 延迟闭环 | 真实取证、新Source和已知家族更新跑通；非通用谱系 | [延迟闭环](report-delayed-loop.md) |
| 6.5 网页有限接入 | 12次输入、2次整理；仅同行者实际模型调用 | [网页接入](report-web-continuous.md) |
| 6.6 正常双角色 | 19次输入、2次整理、25次角色调用；暗号隔离正常 | [双角色实测](report-normal-playtest.md) |
| 地点修复复验 | 默认check185项；新世界12次请求与提交地点一致 | [修复复验](report-normal-playtest.md#5-地点投影修复及真实复验) |

实施决策见[记忆认知简化方案](../../docs/2026-10-05_记忆认知体系简化方案.md)，整体项目状态见[当前状态](../../docs/PROJECT-STATE-2026-10-06.md)。早期活动、反证裁剪、Bank和认识谱系实验的完整命令与报告链接在[历史记录](HISTORY.md)。

## 4. 文件职责与复核

| 位置 | 职责 |
| --- | --- |
| `tests/experiments/playtest-memory-core.ts` | 网页角色授权、缓存、交付与引用检查 |
| `tests/experiments/playtest-frozen-runtime.ts` | 正常角色激活与Core开关接线 |
| `experiments/hindsight-core` | 随仓库保存的分层核心、本地编码器资产描述 |
| `core_bridge.py`、`candidate_admission.py`、`minimal_delivery.py` | 当前Python桥、候选准入及极简交付 |
| `tests/experiments/memory-*.ts` | 独立对照的准备、执行和闭环驱动 |
| `audit_*.py`、`test_*.py`、`report-*.md` | 离线审计、回归及实验报告 |
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

宽准入会在无关话题交付旧认识；同行者可能被持续目标牵引而忽略新话题。部分证据只摘选，认识文字和反证布尔标记不能互相替代。手动整理成本与召回启动等待仍明显；并未证明稳定自然度、更新收益或速度改善。

本轮核心尚未成为默认记忆，完整多场景体验、桌面Core打包和通用认识版本更新未验收。后续以正常试玩的具体失败和已测等待决定局部投入。
