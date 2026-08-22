# ADR-0043：耐久 Round 的宿主恢复驱动

- 状态：Accepted
- 日期：2026-08-23
- Extends：ADR-0041

## 背景

ADR-0041 把 Round 受理事实放入耐久 Inbox，但最初只有新 `round.submit` 会唤醒进程内 worker。宿主在受理后或 claimed 后崩溃时，事实没有丢失，但没有新提交就不会自动继续；旧 Writer Lease 尚未过期时，单次启动扫描也可能立即失败。

## 决定

1. `round.submit` 的受理路径不获取 Writer Lease。它只校验当前存储 Manifest、PlayerBinding 和输入契约，并在 Round Inbox 事务中完成准入；同键终态可在 quarantined Branch 上只读重放。
2. `RoundInbox.unfinishedAddresses` 列出 runtime phase 为 active 且存在 pending/claimed Round 的 Branch。Headless Host 启动时必须扫描并唤醒这些 FIFO。
3. 冻结本机方法 `round.process`，用于按完整 `WorldAddress` 显式排空耐久 FIFO；该方法与启动扫描使用相同的 `WorldApplication.processAcceptedRounds` 和 fencing 路径。
4. worker 遇到标记为 retryable 的 `WorldError` 时，在宿主未关闭期间以有界间隔重新唤醒同一 Branch；关闭开始后停止重排队并等待当前 worker 收口。
5. 每次 worker 失败增加固定基数 metric `round_worker_failures`，并向 Branch Audit 写入 `round.worker.failed`。进程内 worker 及重试计时都不是权威事实。
6. `round.get` 和已完成结果读取直接使用耐久 Inbox，不依赖 Branch Writer Lease，因此 quarantined/archived Branch 仍可查询。完整性分歧仍会原子触发 quarantine。
7. Headless stdout 必须等待背压、传播 EPIPE 等写失败；SIGINT/SIGTERM 触发有序停止，随后关闭 Router 和 Application。

## 后果

- 新提交、宿主启动和显式运维调用都能驱动孤儿 Round；恢复不再依赖“再提交一轮”。
- 活 Writer 尚未过期时不会 force-steal；当前宿主等待 fencing 条件自然满足。
- quarantine 中止 Round 的查询和同键重放不需要临时恢复写能力。
- worker 失败可以从 metrics 和耐久 Branch Audit 追踪，但最终状态仍以 Round Inbox/WorldStore 查询为准。

## 验证

- 子进程把 Round 置为 claimed 后由父进程执行 OS 级硬终止；新 Router 启动扫描后完成同一 Round。
- 测试覆盖 retryable 首次失败后的自动重试、非类型异常审计、typed `WorldError` 审计和关闭时停止重排队。
- RPC 测试覆盖 `round.process` 与角色 Runtime Availability get/set。
- Headless 测试覆盖背压、同步/异步 stdout 错误、活动信号和预先取消信号。
