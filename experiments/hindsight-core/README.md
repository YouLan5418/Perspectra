# Hindsight Core 实验

验证分层提炼、组织、认识整合和召回能否改善角色长期体验，同时维持角色授权隔离。实验现已保存在本仓库；旧独立分支说明属于历史。源码网页的当前简化接入见[Activity Memory](../activity-memory/README.md)，项目机制见[认知与记忆](../../docs/current/architecture/cognition-memory.md)。

## 当前结论与限制

已有 52 回合多模式及 120 回合简化交付等对照。295 次角色调用返回不代表行为收益；旧严格交付出现 Observation 全部扣留、模板噪声与后段等待。后续简化网页不再沿用这套严格扣留作为必经规则。相关阶段报告完整保留，不能混合成同一配置的实验。

本地 E5、词法、图候选、时间窗口与 RRF 等适配用于实验；未整体移植 Hindsight MemoryEngine、PostgreSQL、异步任务、日历解析、因果链提取、cross-encoder、Reflect 或 Mental Models。模型提炼可能语义失真，授权引用检查不证明认识正确或体验收益。

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


后续向量、语义边、图扩展与 tick 适配的具体复用范围、来源片段及限制见[历史记录](HISTORY.md)及[行为报告](reports/behavior-report.md)。vendor 的许可与来源保持原样。

## 运行

在仓库根目录执行，输出目录必须是新的；最后一条会调用真实模型：

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
python -m unittest discover -s experiments/hindsight-core -p test_core.py
corepack pnpm@11.7.0 exec tsc -p experiments/hindsight-core/tsconfig.json --noEmit
node --import tsx experiments/hindsight-core/drive.ts .tmp/hindsight-core-my-run
```

本机接口使用 `HCW_LOCAL_ENDPOINT`、`HCW_LOCAL_MODEL`，认证仅通过 `HCW_LOCAL_API_KEY`。向量环境准备见[Activity Memory](../activity-memory/README.md)。原始结果包含私有角色材料，仅本机审阅。

## 报告与历史

[报告索引](reports/README.md)保留具体阶段结果，[HISTORY](HISTORY.md)保留完整命令和参数演进。`dual-model-review-report.md` 因已保存的 JSON 产物引用保持原位。
