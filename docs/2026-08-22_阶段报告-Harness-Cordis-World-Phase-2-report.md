# Harness / Cordis World V0 Phase 2 阶段报告

> 日期：2026-08-22
> 状态：本机 Phase 2 门槛通过
> 基线：`docs/spec/implementation-v0.2.md`
> 平台：Windows，Node 24.14.1，pnpm 11.7.0

## 1. 结论

Phase 2 已闭合“权威 World Commit → 角色授权视图 → World Outbox → Session 原子追加 → 确定性 Presentation”的本地路径。CharacterView 对 Observation、Claim、Goal、Visibility 和 Scene 做角色级 fail-closed 裁剪；Self Observation 不包含隐藏拒绝原因。Outbox Worker 以每 Session 连续序号投递，消费端幂等与发送端 Receipt 共同恢复跨库崩溃窗口，Critical Dead Letter 不允许同 Session 后续消息越序。

## 2. 交付面

| 单元 | 公共入口 | 已实现不变量 |
|---|---|---|
| CharacterView | `CharacterViewBuilder.rebuildAt` | 单一 asOfSeq、角色 owner filter、Scene/Visibility、自身状态与 Self Observation |
| Temporal Projection | `ProjectionRebuilder.rebuildAt` | Observation/Claim/Goal/Visibility 的 upsert/remove 与 fork 历史重建 |
| World Outbox | `WorldOutbox.claimNext/recordDelivered/recordFailed` | Session FIFO、稳定 delivery seq、Receipt 与恢复状态 |
| Dead Letter | `WorldOutbox.deadLetters/retryDeadLetter` | Critical 项阻止同 Session 后续序号，人工重试后恢复 |
| Session Consumer | `SessionDeliveryAdapter.appendIfAbsent` | Inbox、Observation Event 与 cursor 同事务原子提交 |
| Presentation | `DeterministicPresenter.render` | 纯模板、稳定缓存 Hash、失败不影响权威状态 |

## 3. Evidence

| ID | Evidence | 结果 |
|---|---|---|
| E-P2-001 | `corepack pnpm@11.7.0 check` | 退出码 0；类型、Lint、Coverage、P0/P1/P2、Crash 全通过 |
| E-P2-002 | Coverage 汇总 | 920/920 statements、505/505 branches、182/182 functions、803/803 lines |
| E-P2-003 | `packages/store-sqlite/src/character-view.test.ts` | A/B 角色私有数据、Scene visibility、Self Observation 与 parent future canary 全部验证 |
| E-P2-004 | `packages/store-sqlite/src/outbox-worker.test.ts` | FIFO、Receipt、消费端歧义重试、Critical Dead Letter 与恢复全部验证 |
| E-P2-005 | `tests/p2.integration.test.ts` | CharacterView → Outbox → Session → 中文 Presenter 端到端通过 |
| E-P2-006 | `tests/crash.test.ts` | 8 项真实子进程硬终止通过，含 Session 三点与 sender Receipt COMMIT 前后 |

## 4. Findings

| ID | Finding | Evidence |
|---|---|---|
| F-P2-001 | CharacterView 必须从同一 event prefix 组合全部视图，不能把“各自最新”数据拼在一起。 | E-P2-003、E-P2-005 |
| F-P2-002 | owner 字段缺失或不匹配的 Observation/Claim/Goal/Visibility 必须省略，不能默认为公开。 | E-P2-003 |
| F-P2-003 | Session COMMIT 和 World Receipt 不可能跨 SQLite 原子化；消费端幂等是恢复 COMMIT 歧义的必要条件。 | E-P2-004、E-P2-006 |
| F-P2-004 | Critical Dead Letter 必须冻结同 Session 队头，否则连续 delivery seq 会产生不可恢复的越序。 | E-P2-004 |
| F-P2-005 | Presentation 只能消费已经授权的 Observation；其文本和 Hash 不反馈进 Rulebook 或 Projection。 | E-P2-005 |

## 5. Finding Paths

### 5.1 多角色 future canary

- target: 证明角色 A 不读取角色 B 私有内容，也不读取 fork 点后的父分支未来
- preconditions: A/B 各有 Observation、Claim、Goal，父分支在 forkSeq 后写入 future canary
- action: 对子分支分别执行 `CharacterViewBuilder.rebuildAt(address, characterId, forkSeq)`
- evidence: E-P2-003、E-P2-005
- finding: F-P2-001、F-P2-002
- verification: A/B Bundle Hash 不同；A 中无 B 私有标记和 future canary；Self Observation 无隐藏拒绝原因
- residual_risks: Phase 2 的 Scene 是事件约定，完整感官/遮挡插件仍未实现

### 5.2 Session COMMIT 歧义

- target: Session 已提交但 Worker 未观察到成功时不重复 Observation
- preconditions: deliveryId、sessionDeliverySeq 与 payloadHash 已耐久绑定
- action: 在 `session-delivery.after-commit` 失败，发送端记录 pending，再次投递相同 Envelope
- evidence: E-P2-004、E-P2-006
- finding: F-P2-003
- verification: 第二次返回 `already_applied`，Session cursor 保持 1，随后发送端 Receipt 提交
- residual_risks: V0 Worker 由宿主调度，尚未实现长期后台进程与退避计时器

### 5.3 Critical Dead Letter

- target: 防止关键认知事件失败后同 Session 继续前进
- preconditions: 队头 Critical delivery 达到最大尝试次数
- action: 标记 `dead_letter`，FIFO 查询排除其后的同 Session 项；显式 `retryDeadLetter` 后恢复
- evidence: E-P2-004
- finding: F-P2-004
- verification: dead letter 存在时 Worker 返回 idle，重试后 seq 1、2 连续提交
- residual_risks: Phase 5 才提供正式 Health/Audit/CLI 人工操作面

### 5.4 Receipt COMMIT 前后硬终止

- target: 证明发送端不会留下部分 Receipt 状态
- preconditions: Outbox item 已被 claim，Session 消费结果视为成功
- action: 子进程分别在 `outbox.before-receipt-commit` 与 `outbox.after-receipt-commit` 被父进程强制终止
- evidence: E-P2-006
- finding: F-P2-003
- verification: COMMIT 前无 Receipt 且 item 可重试；COMMIT 后 Receipt 存在且 item 不再 claim
- residual_risks: 跨多台主机的分布式投递不在 V0 范围

## 6. 验收映射

| Phase 2 门槛 | 结果 | Evidence |
|---|---|---|
| 多角色 future canary 不泄漏 | 通过 | E-P2-003、E-P2-005 |
| Session Crash Matrix | 通过 | E-P2-004、E-P2-006 |
| Critical dead letter 不跳过 | 通过 | E-P2-004 |
| Deterministic Presentation | 通过 | E-P2-005 |
| 每个生产文件四项覆盖率 100% | 通过 | E-P2-002 |
| Phase 0/1 回归 | 通过 | E-P2-001 |

## 7. 未闭合门槛

GitHub Actions 四组跨平台矩阵仍因没有远程仓库而未执行。Phase 3 的 ContextAssembler、严格 `submit_actions`、Model Profile/Budget、Director Scheduler、Harness Agent Port 与 LLM Replay 尚未实现。Phase 2 Presenter 没有 LLM Renderer，也不会把渲染结果写回世界。
