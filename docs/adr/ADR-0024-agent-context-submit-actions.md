# ADR-0024：Agent ContextAssembler 与 submit_actions

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §6](../spec/implementation-v0.2.md#6-agent-上下文与提案协议)

## 决策

Agent 只读取其 WorldAddress、CharacterView、当前 Round 和获授权 Memory；模型输出不是事实。每个参与者每轮至多返回一次结构化 Proposal，内容为 abstain 或一至两个 ActionRequest。Provider 必须可替换，历史重放不得再次调用 Provider。

## 结果

Phase 3 已实现 `ContextAssembler`、严格 `SubmitActionsValidator`、`HarnessAgentPort` 与默认禁用 Bridge。非法数量、重复 Action ID、越权 actor/action type、错误版本和未知字段均 fail-closed；本地 Harness 源码不进入生产 import。
