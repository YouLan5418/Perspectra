# ADR-0059：Agent 参与调度、Memory Profile 与真实 Provider

- 状态：Accepted
- 日期：2026-08-25
- Extends：ADR-0024、ADR-0032、ADR-0033、ADR-0035、ADR-0051、ADR-0052
- 上位契约：[通用内容架构总纲 §12](../spec/general-content-architecture-v0.1.md#12-agent-参与memory-与真实-provider)

## 背景

开放世界不能把“角色存在”等同于“每轮调用模型”。创作者还需要调整角色关注点和记忆风格，但不能改变 as-of、namespace 或来源防火墙。真实 Harness Provider 必须验证既有提案、降级和重放边界，而不能成为世界正确性的前提。

## 决定

1. 新 Manifest 锁定 participation policy，模式为 focal、reactive、rule_only、silent、disabled。Scene、lifecycle、runtime availability、policy、预算和 Host hard cap 共同生成候选。
2. 超限候选按 policy priority、role rank、CharacterId 稳定选择。参与者集合、顺序、预算和 terminal 耐久冻结；Director 每轮最多一次。
3. silent/background Character 不调用模型，但继续接收获授权 Observation 与 durable cognitive job。Runtime Author 只能从未来 Round 起审计式调整 participation，不改变 lifecycle。
4. Pack 不直接写 Memory row，只配置 logical Memory Profile。L0 source-linked memory 强制；L1 可选且 Phase 7 默认 deterministic/scripted；L2/L3 自动抽象推迟。
5. Profile 可调整 recall 上限、salience、attention topics、Goal/Affect bias 和 L1 policy，但不能改变角色/Branch namespace、as-of、source mapping、summary 非事实规则或跨角色隔离。
6. ContextAssembler v2 以固定权限优先顺序组合 runtime boundary、World/Round、CharacterView、Scene、Goal、Affect/Tension、verified Memory、玩家 Action、Affordance、portrayal。每角色保存独立 context/recall/source/profile hash。
7. Creator 只引用 logical model profile，Host 决定 provider/model/Secret/预算/隐私/timeout/fallback。Pack 不保存 API key 或 endpoint。
8. 真实 Harness Bridge 位于 `HarnessAgentPort` 后、默认关闭。只有公开固定版本、许可证和契约测试满足时启用；不得引用只读源码内部路径。
9. 默认不保存原始 Prompt/Response/chain-of-thought。模型输出仍只为 Proposal；失败、超时、预算耗尽和非法输出只降级参与者，已提交重放零模型调用。

## 后果

- 大量角色可以存在、形成认知并被观察，而不会造成每轮模型调用风暴。
- 创作者可塑造“记住什么、关注什么”，但无法打开未来或跨角色信息通道。
- Scripted/Rule/Noop 始终是完整路径；真实 Provider 只验证适配边界。
- 如果 Harness 接入面不合法或不匹配，Phase 7 的 Provider 单元可记录阻塞，但不得拖垮无模型内容能力。

## 验证

- 参与候选、裁剪顺序、terminal 和重启重放完全确定；silent/background 角色调用为零且 Memory 追平。
- 不同角色 contextHash、source refs 和 recall hash 独立，future/branch/character canary 全部拒绝。
- Provider error/timeout/budget/invalid output 不阻塞玩家 Tick，同键重放调用为零。
- Pack、Audit、Export 和默认数据库中不存在 Secret、endpoint、raw Prompt/Response 或 chain-of-thought。
