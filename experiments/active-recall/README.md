# 主动召回历史实验

研究角色能否自主选择一次 recall 查询，在取得自己的来源证据后自由回应，查询本身不提交世界变化。

| 历史运行 | 证据目录 |
| --- | --- |
| 明确问法与正常查询 | [normal](../active-recall-2026-09-28/) |
| 间接物品指代 | [opaque](../active-recall-opaque-2026-09-28/) |
| 原持有者离场 | [away](../active-recall-away-2026-09-28/) |

[实验 11 报告](../../docs/archive/prototype-g1-g4/PROTOTYPE-ACTIVE-RECALL-EXPERIMENT-11.md)记录四次激活、七次模型调用，三次选择 recall；away 未召回旧交接／传闻。隔离和查询入口得到限定验证，没有证明长期自主核查收益。

复现代码：[active-recall-drive.ts](../../tests/experiments/active-recall-drive.ts)，运行前读其参数及报告；在仓库根目录使用新的输出目录：

```powershell
node --import tsx tests/experiments/active-recall-drive.ts .tmp/my-active-recall
```

此驱动会调用真实模型，密钥只通过环境传入。历史产物目录保持原位，避免破坏脚本或审计路径；这里提供统一索引，不新建运行协议。当前显式 Core 模式关闭重复的原生主动 recall，见[现行记忆](../../docs/current/architecture/cognition-memory.md)。
