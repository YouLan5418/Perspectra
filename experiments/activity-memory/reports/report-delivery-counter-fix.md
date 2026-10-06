# 活动补齐后二次裁剪丢失反证：修复记录

日期：2026-10-04。范围：实验核心实际使用的 `activity_delivery.py`，不修改正式 Memory schema、World State、Event Log 或 Rulebook。

## 问题与结果

上一轮完整阅读组实验复现了确定性的错误：基础 Delivery 已把认识和必要反证一起投影，但活动补齐加入结尾、开场后，再逐条按三项预算裁剪，留下了认识、丢掉反证。

本次修复最终预算分配，保留现有候选排序和三项／4500 JSON 字符上限。需要非当前上下文反证的认识，以及被扣留认识的原文回退，都与必要反证一起检查剩余预算；放不下则整组扣留。可选开场排在这些必要内容之后，结尾仍优先。共享反证按原始证据键复用，当前上下文已有的反证不重复占位。

| 同一份合成边界样本 | 修复前冻结结果 | 修复后实际路径 |
| --- | --- | --- |
| 实际交付项数 | 3 | 3 |
| 结尾 | 有 | 有 |
| 开场 | 有 | 无 |
| 认识正文 | 有 | 有 |
| 必要反证 | **无** | **有** |
| JSON 字符 | 1548 | 1142 |

这是程序裁剪缺陷修复。未把“相反认识”强制绑定成全局阅读组；上一轮发现这种策略会恢复不适用分支、挤掉有用内容，因此不接入。认识正文和来源规则不变，未证实概括仍按原规则回退，原始证据没有改写。

## 验证

- 最小回归先复现旧路径丢反证，修复后通过。
- 五项针对性测试覆盖三项预算、条目／字符不足、未证实认识回退、共享反证、当前上下文已有反证。共享反证测试的四项额度仅为诊断，默认额度仍为三项。
- 活动记忆 51 项、检索／交付投影 13 项、小交付 8 项，共 **72 项测试通过**。
- 重放 60 份普通查询和 3 份历史查询：两种既有排序路径的候选顺序、排序输入和完整交付结果均精确复现；同时核对 63 份原生 JEV 请求／返回。
- 原始冻结目录 JSON／JSONL 的前后哈希一致；新模型调用 **0**。测试和重放均不读取完整世界状态。

可复核摘要：[delivery-counter-fix-assessment.json](../delivery-counter-fix-assessment.json)。新输出目录：`.tmp/delivery-counter-fix-20261004-v1`。旧分组实验结果保留，作为修复前证据。

```powershell
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/verify_counter_clip_fix.py .tmp/my-counter-fix .tmp/delivery-order-20261004-v1 .tmp/delivery-groups-20261004-v2
& '.tmp/hindsight-vector-venv/Scripts/python.exe' -m unittest discover -s experiments/activity-memory -p 'test_*.py'
& '.tmp/hindsight-vector-venv/Scripts/python.exe' -m unittest discover -s experiments/hindsight-core -p 'test_projections.py'
& '.tmp/hindsight-vector-venv/Scripts/python.exe' -m unittest discover -s experiments/hindsight-core -p 'test_small_delivery.py'
```

## 接受的限制

结尾优先，必要认识／反证组超过剩余预算时可能整组不交付，本次不扩大预算。显式活动筛选移除了必要反证时，也扣留对应认识／回退材料。

63 份冻结查询主要验证无反证普通路径未回归；反证裁剪问题由合成边界和针对性测试验证。这轮没有新增 Character Turn 或长期试玩，不能据此声称角色实际表现已经改善。未运行 TypeScript 全项目检查，本次代码改动在 Python 实验目录内。
