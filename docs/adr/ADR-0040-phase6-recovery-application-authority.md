# ADR-0040：非确定参与者恢复、实例权威与应用边界

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §6、§14、§19、§25](../spec/implementation-v0.2.md)
- 相关决定：ADR-0023、ADR-0027、ADR-0036、ADR-0038、ADR-0039

## 背景

Phase 6 首版把玩家、Agent 和 Director 合并到一个 Round，但独立审查发现：COMMIT 后、Inbox complete 前崩溃会重新调用非确定 Provider；Writer Lease 在长模型调用期间没有续约；行政 Gate、Outbox Worker、进程 ownerId 和本机 RPC 仍存在跨事务或绕过 Application Port 的缝隙。同步假 Provider、固定 ownerId 和单 Worker 测试不能证明这些组合路径安全。

## 决策

1. Round 恢复首先按确定性 transactionId 查询并完整验证已提交记录。若事件链、序号、Tick、Outbox 边界和 Bundle Hash 均成立，直接从已提交玩家 Resolution 补完 Inbox；不得再次调用任何 Provider。
2. Coordinator 在 claim、每个参与者调用前后、提交前和 Inbox complete 前续约数据库 Writer Lease。参与者 timeout 必须保留明确 TTL 安全余量，组合根必须透出 `leaseTtlMs`。
3. Round Inbox 在自己的 `BEGIN IMMEDIATE` 内检查 Admission；提交事务将 admission proof 一次性绑定到 transactionId 和 bundle。Gate 前的同键重试可恢复，Gate 后的新键不可入队。
4. fork/archive 编排必须有失败补偿。fork 失败重新开放父分支；archive 无论成功失败都释放 Cordis Slot。不可恢复的补偿分歧使用 `AggregateError` 暴露，不伪装成功。
5. Outbox claim、完成、失败、dead-letter 查询和人工重试都按完整 `WorldAddress` 隔离。人工重试与 branch audit 同事务，并只能经 `WorldApplication`/Application Port 进入生产协议。
6. 调用方提供的 `runtimeOwnerId` 仅是诊断标签。每个 `WorldApplication` 强制追加不可注入的随机实例 nonce；崩溃后的新实例必须等待旧 Lease 到期并取得更高 fencing token，不允许同标签复活旧 Lease或 force-steal。
7. 配置 `WorldApplication` 的 JSON-RPC Router 不创建或暴露旧 Store/Admin 直通对象；旧行政适配器只在无 Application 的显式 legacy 模式存在。CLI 对 `WORLDSTORE_BUSY` 只做有界等待。
8. Cordis Branch Slot 在 await 前同步预留引用，避免已挂载 Slot 在 acquire 微任务窗口被提前销毁。生产事件只能经 Branch lane 的 scoped emit API 发射，调用方不获得裸 Context。
9. 所有耐久 Inbox 玩家输入在进入 Rulebook 前重新解析；路由、幂等、审计和 authority 字符串拒绝 ASCII 控制字符。

## 结果

模型非确定性不再参与崩溃恢复，进程标签不再是租约权限，分支 Worker 不能消费其他 Branch 的 Outbox，生产 RPC 不能绕过组合根。测试门槛包含非确定 Provider 的真实 SIGKILL、旧 Lease 未到期时 busy/到期后恢复、critical dead-letter 恢复后归档、Application RPC/CLI 端到端和 acquire/dispose 微任务交错。
