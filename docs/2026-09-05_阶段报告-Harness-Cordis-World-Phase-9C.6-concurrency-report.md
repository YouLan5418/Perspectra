# P9C.6 首批证据：真实应用并行与多分支公平性

> **状态：P9C.6 部分完成，不能据此宣布性能门槛或 Phase 9C 全部完成。** 本批仅增加测试与可配置测试 Fixture，不修改生产行为、Manifest 协议或 Hash。未调用外部模型、未推送、未创建 Tag。

## 已验证什么

- 八个 NPC 走 WorldApplication → Reaction Scheduler → 正式 Context / Provider 生命周期，同 wave 的八个 Provider 全部进入等待后，才允许任何一个返回。串行调用实现无法通过这个屏障。
- 八个 Provider 等待期间，另一个 Branch 的玩家 Round 可以提交；通过独立 WorldStore 连接校验其事件链和 Tick，排除仅返回受理成功的假象。
- Provider 释放后各等待 100 ms，完成一个真实 reaction wave；重放同键 Root Round 不增加调用次数。耗时仅作为诊断输出，不作为尚未完成跨平台标定的发布阈值。
- 32 个 Branch 各预先受理两个真实玩家 Round；不发送任何 wake 提示，由 SQLite Inbox 扫描恢复。单并发调度下，前 32 次提交各属于不同 Branch，之后才出现第二次提交；全部 32 条事件链验证通过，Tick 均为 2。

这不是八个 Mock Promise 或假数据表的性能测试：参与者经过正式应用路径，玩家提交与恢复扫描使用实际数据库。公平性用例只覆盖单并发、玩家量子；不能代替混合 reaction/player、四并发的完整压力矩阵。

## 复现

在仓库根目录运行：

```powershell
node node_modules/vitest/vitest.mjs run tests/p9-concurrency.integration.test.ts tests/reaction-e2e.test.ts
```

本机 Windows / Node 24.14.1：两个文件、15 项测试通过；新增并发文件单独运行两项通过。测试使用临时目录并关闭连接后清理，不接触用户运行库。

完整验收命令仍为：

```powershell
$env:pnpm_config_verify_deps_before_run='false'
corepack pnpm@11.7.0 check
```

新增用例自动被现有 coverage 测试发现，无需新增一套生产脚本。

本机完整 `check` 已通过，退出码 0：79 个 coverage 测试文件、855 项测试，生产文件四项覆盖率全部 100%；P0～P6 集成、3 项 P8 查询基准、33 项子进程硬崩溃测试通过。这些既有崩溃测试没有被重新包装为本轮长历史压力证据。

## Evidence → Finding → Path

| Evidence | Finding | 后续 Path |
| --- | --- | --- |
| E-001：[八参与者与跨分支提交测试](../tests/p9-concurrency.integration.test.ts)，上述命令可复现 | F-001：同 wave 并行真实成立；Provider 等待没有阻止另一 Branch 提交 | 保留作为正式路径回归测试，后续增加长历史场景而不替换成 Mock |
| E-002：同文件 32 Branch / 64 Round 耐久扫描与提交测试 | F-002：无 wake 情况可恢复，单并发公平性落实到数据库提交 | 补混合量子、默认四并发与发布规模测量 |
| E-003：[ReactionScheduler.runCurrentWave](../packages/application/src/reaction-scheduler.ts) 仍调用 `store.readEvents(address, head.headSeq)` | F-003：每 wave 仍读取全量历史，Job 查询有索引不等于满足“不逐 wave 全日志读取”的要求 | 先测 10,000 / 100,000 Event 的真实链与调用成本，再确定可验证的增量投影读取边界；不能用截断历史或跳过完整性校验换速度 |

## 尚未闭合

1. 10,000 Event / 32 Branch / 256 pending Job 的真实数据及查询计划证据；100,000 Event / 128 Branch 的本机发布压力数据。
2. 全历史读取路径的优化及 Hash、as-of、重启、fork 全等验证。若需要改变 Accepted ADR 的权威/恢复语义，先新增 superseding ADR，不通过更新 Golden 接受漂移。
3. 默认并发下混合 Root/Reaction、公平性与抢占延迟的规模验证，以及完整故障矩阵与这些压力场景的对应表。
4. Windows / Ubuntu 测量后的可移植时限；本轮没有远程 CI 证据，不能冻结跨平台性能结论。

下一单元优先补真实长历史基准，定位成本后再做最小优化；P9C.7 发布收口仍在其后。报告按 docs-generator 的渐进披露与证据链组织，避免把小规模正确性测试表述为整个压力门槛通过。
