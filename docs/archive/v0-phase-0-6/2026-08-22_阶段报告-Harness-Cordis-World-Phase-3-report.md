# Harness / Cordis World V0 Phase 3 阶段报告

> 日期：2026-08-22
> 状态：本机 Phase 3 门槛通过
> 基线：`docs/spec/implementation-v0.2.md`
> 平台：Windows，Node 24.14.1，pnpm 11.7.0

## 1. 结论

Phase 3 已建立 Agent/Director 的最小权限与失败隔离层。ContextAssembler 只组合显式 WorldAddress、单角色 CharacterView、玩家候选行动和 Capability；模型输出只能经严格 `submit_actions` 进入 Proposal。Harness 集成使用独立 `HarnessAgentPort`，默认 Bridge 禁用，没有安装版本不一致的公开 Harness 包，也没有引用本地只读源码。模型失败、超时和预算耗尽均返回空提案，玩家 Kernel 继续提交。

## 2. 交付面

| 单元 | 公共入口 | 已实现不变量 |
|---|---|---|
| Agent Context | `ContextAssembler.assemble` | address/character/capability 一致、稳定 contextHash |
| Tool Validation | `SubmitActionsValidator.validate` | 精确 Schema、actor/action allowlist、版本、数量与唯一 actionId |
| Harness Boundary | `HarnessAgentPort`、`DisabledHarnessBridge` | 默认无网络/模型；仅注入端口可启用 |
| Model Profile/Budget | `ModelBudgetLedger`、`SafeAgentRunner` | 调用前预留、callId 稳定绑定、失败/超时/耗尽降级 |
| Director | `DirectorScheduler.schedule` | enabled/authorization 过滤、priority/id 稳定顺序 |
| LLM Replay | `ModelReplayStore.record/replay` | append-once、request/response 域隔离 Hash、回放不调用 Provider |

## 3. Evidence

| ID | Evidence | 结果 |
|---|---|---|
| E-P3-001 | `corepack pnpm@11.7.0 check` | 退出码 0；类型、Lint、Coverage、P0～P3、Crash 全通过 |
| E-P3-002 | Coverage 汇总 | 1056/1056 statements、609/609 branches、210/210 functions、910/910 lines |
| E-P3-003 | `packages/agents/src/agents.test.ts` | Context、tool Schema、禁用 Bridge、预算、超时、Director 与 Replay 全部验证 |
| E-P3-004 | `tests/p3.integration.test.ts` | Provider 失败、超时和预算耗尽后玩家消息仍提交为 Tick 1 |
| E-P3-005 | `pnpm-lock.yaml` 与 workspace 包图 | 没有 Harness 包；Agents 只依赖 contracts/store-sqlite |

## 4. Findings

| ID | Finding | Evidence |
|---|---|---|
| F-P3-001 | 模型不是 Principal；它只能继承调用角色的最小 Capability，输出还需 Kernel 前的结构校验。 | E-P3-003 |
| F-P3-002 | Context Hash 必须绑定单角色 as-of View 与完整 WorldAddress，不能让 Provider 自选 actor 或 Branch。 | E-P3-003 |
| F-P3-003 | 预算必须在调用前稳定预留；预算耗尽不应启动 Provider，也不应阻塞玩家。 | E-P3-003、E-P3-004 |
| F-P3-004 | Harness 版本不匹配不是无模型路径的阻塞条件；Port + Disabled Bridge 可保持依赖隔离。 | E-P3-004、E-P3-005 |
| F-P3-005 | Replay 必须校验原 requestHash；相同 callId 的请求或响应分歧是 integrity 错误。 | E-P3-003 |

## 5. Finding Paths

### 5.1 严格 submit_actions

- target: 阻止模型越权 actor、Action type 或输出任意结构
- preconditions: 调用方已给出 participantId、actorId、action allowlist 和 maxActions
- action: 对唯一工具输出执行 Canonical World JSON、精确字段、版本、数量和唯一 ID 校验
- evidence: E-P3-003
- finding: F-P3-001
- verification: 未知字段、越权 actor/type、重复 actionId、错误版本与非 JSON 全部返回 `MODEL_SCHEMA_INVALID`
- residual_risks: Phase 3 尚未把 Agent Proposal 合入 WorldKernel 的同轮 Candidate；玩家路径保持独立

### 5.2 Provider 失败隔离

- target: 模型不可用时保持玩家活性
- preconditions: Agent 调用已获得稳定预算 reservation
- action: `SafeAgentRunner` 对 Provider Promise 设置 deadline，并把异常/超时转换为空 Proposal
- evidence: E-P3-003、E-P3-004
- finding: F-P3-003、F-P3-004
- verification: failed、never-resolving 和 exhausted 三类 Provider 之后，玩家 `character.speak` 仍提交为 Tick 1
- residual_risks: 当前 deadline 使用进程内 timer；Phase 5 才提供正式指标和 Health 状态

### 5.3 Harness 端口隔离

- target: 在没有兼容公开 Harness 包时保持明确集成边界
- preconditions: 上游源码目录全程只读，生产依赖图不允许本地路径 import
- action: 定义 `HarnessAgentPort.submitActions`，默认实现固定返回 `MODEL_PROVIDER_FAILED`
- evidence: E-P3-003、E-P3-005
- finding: F-P3-004
- verification: Fake Port 契约测试通过；Disabled Bridge fail-closed；锁文件没有 Harness 包
- residual_risks: 真正 Bridge 仍需固定兼容版本、许可证复核和独立契约测试

### 5.4 Model Replay

- target: 历史重放不再次调用 LLM
- preconditions: callId、request 与 response 已首次记录
- action: 保存 requestHash、responseHash 和 canonical response；回放时重新校验 requestHash
- evidence: E-P3-003
- finding: F-P3-005
- verification: 精确请求返回原响应；同 callId 的请求或响应分歧返回 `BUNDLE_HASH_MISMATCH`
- residual_risks: Replay Store 目前只服务本机 V0，不包含外部 Provider 原始 Secret 或完整网络 Trace

## 6. 验收映射

| Phase 3 门槛 | 结果 | Evidence |
|---|---|---|
| 模型失败不阻塞玩家 | 通过 | E-P3-004 |
| 模型超时不阻塞玩家 | 通过 | E-P3-004 |
| 预算耗尽不阻塞玩家 | 通过 | E-P3-003、E-P3-004 |
| 无模型模式完整运行 | 通过 | E-P3-001、E-P3-004 |
| Harness 依赖隔离 | 通过 | E-P3-005 |
| 每个生产文件四项覆盖率 100% | 通过 | E-P3-002 |

## 7. 未闭合门槛

实际 Harness LLM Bridge 仍未启用，因为没有与调研源码匹配且已复核许可证的公开版本。该外部门槛不影响本地无模型功能。GitHub Actions 四组矩阵仍因没有远程仓库而未执行。Phase 4 的 Local FTS5 Memory、source mapping、as-of 防火墙、KnowledgeRule、`character.reflect` 与 Session Compaction 尚未实现。
