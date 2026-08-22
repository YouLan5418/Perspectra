# ADR-0041：异步 Round 受理与本机 Headless 循环

- 状态：Accepted
- 日期：2026-08-22
- Supersedes：ADR-0037 中 `round.submit` 同步等待完整 Round 的隐含行为

## 背景

`round.submit` 若同步等待 Provider、裁定与 WorldStore 提交，会把本地 RPC 的可用性绑定到模型时延，也无法稳定表达已经耐久受理但仍在处理的 Round。冻结协议要求提交入口快速返回，并允许调用方通过耐久查询恢复状态；CLI 的等待行为只能是客户端策略，不能改变服务器端受理语义。

## 决定

1. `RoundInbox.enqueue` 是 `round.submit` 的耐久完成点。成功后立即返回 `queued`、`processing` 或 `committed`；对已经进入终态的同键重放如实返回 `failed` 或 `cancelled`。所有结果均携带确定性的 `roundId`、`inboxSeq` 和 `idempotencyKey`。
2. `roundId` 由完整 `WorldAddress`、Inbox 序号、幂等键和输入 Hash 进行域隔离推导；相同受理事实在重启后得到相同身份。
3. `round.get` 必须且只能用 `roundId` 或 `idempotencyKey` 查询耐久状态。状态集合为 `queued | processing | committed | failed | cancelled`；进程内 worker 不是状态事实源。
4. `round.cancel-queued` 只允许在 Inbox 仍为 `pending` 时执行。状态检查、CAS 更新、结果 Hash 和 Branch Audit 在同一个 `BEGIN IMMEDIATE` 事务中提交；已经 claimed 或进入终态的 Round 拒绝取消，重复取消返回同一耐久结果。
5. 本机 Router 在受理后按完整 Branch 地址启动至多一个临时排空 worker，并用耐久受理后的进程内 wakeup 标记闭合“worker 即将退出时又入队”的竞态。worker 失败不伪造完成状态，调用方可通过 `round.get` 查询并由后续 drain 恢复；Router 关闭会等待已启动和收尾窗口重新唤醒的 worker 收口。
6. `worldctl round submit --wait` 通过轮询 `round.get` 实现有界等待，不切换服务端语义。
7. `worldhost` 提供 newline-delimited JSON-RPC 2.0 的 stdin/stdout 循环。它不监听 TCP、Pipe 或 Socket；每行一个请求、每行一个 canonical JSON 响应，EOF 时等待 Router 关闭。

## 后果

- 模型失败或慢调用不再延长 Round 受理响应。
- 崩溃恢复只依赖 Round Inbox 和 WorldStore，不依赖通知或存活的进程内 Promise。
- 当前 `roundId` 查询在 Branch Inbox 内扫描；V0 数据规模可以接受，后续若增加索引必须以迁移保持身份与查询语义不变。
- 本 ADR 不提供通知流；通知丢失后的查询恢复和协议其余方法面由后续 Release Closure 单元处理。

## 验证

- Store 测试覆盖两种查询键、全部耐久状态、取消 CAS、重复取消和损坏结果 Hash。
- Application/RPC 测试覆盖 queued、processing、committed、并发 worker 去重和 worker 失败隔离。
- CLI 测试覆盖轮询完成、缺失身份、processing/queued 超时与无状态响应。
- Headless 测试覆盖多行请求、解析失败、空行和 EOF 关闭。
