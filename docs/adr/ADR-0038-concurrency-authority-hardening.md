# ADR-0038：并发领取、权威来源与一致性传输加固

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §6、§11～14、§18、§21、§24](../spec/implementation-v0.2.md)
- 相关决定：ADR-0023、ADR-0024、ADR-0027、ADR-0031、ADR-0035、ADR-0036、ADR-0037

## 背景

Phase 0～5 的串行测试已通过，但独立审查证明部分实现没有把既有不变量贯穿到跨 Worker 和跨模块路径：Provider Proposal 可绕过裁定，Outbox 没有 claim ownership CAS，Round completion 没有提交证明，Memory reconcile 信任调用方 View，逻辑导出没有固定读快照。

## 决策

1. 所有 Provider 输出在进入权威提交前必须依次通过结构/授权 Validator 和确定性 Rulebook；Provider 不能构造 accepted Resolution。
2. 所有可被多个 Worker 领取的耐久任务必须保存不可复用 claim token、owner 和 lease deadline。完成、失败或续租只能用原 claim 做状态 CAS；迟到操作 fail-closed。
3. `FaultInjector.hit` 是同步接口。SQLite `BEGIN` 与 `COMMIT/ROLLBACK` 之间禁止任何 `await`、Provider 调用或事件循环让出。
4. Round Inbox claim/complete 必须验证当前 Writer Lease；complete 还必须绑定已存在的 `round_commits.transaction_id`、bundle hash 和结果 hash。
5. Memory reconcile 不接受调用方构造的 CharacterView 作为信任根。Memory Store 通过注入的可信 ViewSource 按完整地址、角色和 asOfSeq 重建，并拒绝 source 序号倒退或同序号 Hash 分叉。
6. 逻辑 authority Export 在单一 SQLite read transaction 中生成。Import 必须验证事件链、分支锚点、Head、Round bundle 和所有引用；不完整的 Session/Outbox 运行态不得伪装成可恢复状态。
7. fork 在单一写事务内检查 Admission、unfinished Round、Head、forkSeq、深度和事件锚点，但不等待 Writer Lease 或 critical Outbox；两者继续属于父分支，且由 archive 屏障兜底。子分支继承权威 Event 前缀，不复制父 Outbox/Session/Memory/Snapshot。父分支归档不影响已存在子分支继续提交。
8. Operational Audit 使用 requested/completed 可调和记录和 Hash chain；Restore/Import provenance 必须写入目标端。`round.committed` 与权威提交同事务，但 `round_commits/events/heads` 仍是世界提交的唯一权威证明。
9. Restore/Import 不假设独立 Session 数据库与 World 数据库能跨文件原子恢复。目标 Outbox 清除 sender receipt、claim、attempt 和状态，但保留已分配的 `session_delivery_seq` 与 `outbox_session_counters`，再由 Session 以 deliveryId+sequence+payloadHash 幂等恢复模型可见记录。Logical Authority 格式 v3 同样携带这组序号绑定。

## 结果

Schema 需要向前迁移；公共 claim/completion/reconcile 接口会变得更严格。旧调用方若没有 claim token、提交证明或可信 ViewSource 将在编译期或运行时失败。并发交错测试成为发布门槛，逐文件覆盖率继续保留但不替代状态机验证。
