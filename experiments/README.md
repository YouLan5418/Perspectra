# 实验证据

实验目录保存研究脚本、fixture、输入输出、审计与报告。默认游戏宿主与 Python Core 已迁至 [desktop/host](../desktop/host/README.md)，这里不再提供生产运行实现；项目现行机制首选[当前架构](../docs/current/architecture/README.md)。

| 实验线 | 入口 |
| --- | --- |
| 活动与简化记忆、网页接入 | [activity-memory](activity-memory/README.md) |
| Hindsight 分层核心与召回对照 | [hindsight-core](hindsight-core/README.md) |
| 叙事审查与纠错对照 | [JEV](jev-narrative-auditor/README.md) |
| 主动召回历史运行 | [active-recall](active-recall/README.md) |

每个新实验使用独立输出目录。小样本、固定 fixture 和自动审计不等于真实玩法全面验收。
