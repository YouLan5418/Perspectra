# JEV 叙事审查实验

JEV 是对叙事状态变化主张作分类／选择的实验工具。本线调查自由叙述与权威持有、放置和经历来源不一致的问题，不取代 Rulebook，也不让分类结果直接改世界事实。

## 模式与结论

shadow 在输出后记录主张和正式事件的对照，不干预角色发布。intervention 在发布前检查，实验性地最多请求一次重写；它会增加等待，也可能误干预。placement 追踪放置与完整经历链；holdout 用未参加先前调参的新文本和连续试玩检查泛化；custody 及 input / boundary 研究临时保管、玩家原话、主体归属和原文证据。

冻结 holdout 的固定新样本通过，但真实连续试玩未通过自动纠错验收，停止扩展、不默认开启纠错。后续保管边界和主体归属仍未通过，授权原文路径只有限定验证。分类准确或稳定不等于语义完全正确，也不能证明自然角色体验改善。

当前简化记忆把 JEV 留作可选对照，不作为 Recall → Delivery 的必经步骤。正常架构见[认知与记忆](../../docs/current/architecture/cognition-memory.md)。

## 报告与资产

详细历史报告保留在[原型历史索引](../../docs/archive/prototype-g1-g4/README.md)：

- [最初分类实验](../../docs/archive/reviews/PROTOTYPE-JEV-NARRATIVE-AUDITOR.md)
- [shadow 窗口](../../docs/archive/prototype-g1-g4/PROTOTYPE-JEV-SHADOW-WINDOW-03.md)
- [intervention](../../docs/archive/prototype-g1-g4/PROTOTYPE-JEV-INTERVENTION-04.md)
- [placement](../../docs/archive/prototype-g1-g4/PROTOTYPE-JEV-PLACEMENT-05.md)
- [holdout](../../docs/archive/prototype-g1-g4/PROTOTYPE-JEV-HOLDOUT-07.md)
- [custody boundary](../../docs/archive/prototype-g1-g4/PROTOTYPE-CUSTODY-BOUNDARY-EXPERIMENT-10.md)

带日期的 historical-replay、objective-event-replay、shadow-window、intervention、placement、boundary、holdout、custody 系列目录均是历史 run，保留输入、概率、protocol、summary、审查和当时源码副本，不移动或重命名产物。根目录 run.mjs / analyze.mjs 和 tests/experiments 的 jev-* 驱动仍有复现价值；各报告提供精确参数。未把所有目录重写为一个大报告。

## 运行与复核

在仓库根目录离线复核已保存结果（不调用模型）：

```powershell
node experiments/jev-narrative-auditor/analyze.mjs experiments/jev-narrative-auditor/results-2026-09-25.jsonl
```

新分类实验需要进程环境 `OPENROUTER_JEV_KEY`，并调用真实外部模型；使用独立输出，凭证不落盘：

```powershell
node experiments/jev-narrative-auditor/run.mjs --mode text --output .tmp/my-jev-results.jsonl
node experiments/jev-narrative-auditor/analyze.mjs .tmp/my-jev-results.jsonl
```

历史模型快照、费用和延迟只代表当时实测。完整现场 replay 先阅读对应报告和驱动参数，不覆盖已有 run。
