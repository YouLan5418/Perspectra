# ADR-0024：Agent ContextAssembler 与 submit_actions

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §6](../spec/implementation-v0.2.md#6-agent-上下文与提案协议)

## 决策

Agent 只读取其 WorldAddress、CharacterView、当前 Round 和获授权 Memory；模型输出不是事实。每个参与者每轮至多返回一次结构化 Proposal，内容为 abstain 或一至两个 ActionRequest。Provider 必须可替换，历史重放不得再次调用 Provider。

## 结果

Phase 0 提供 `AgentProvider`、`DirectorProvider`、Scripted Agent 以及 Noop/Rule/Scripted Director。非法数量、重复 Action ID 和重复 participant fail-closed；Harness LLM Bridge 留到 Phase 3。
