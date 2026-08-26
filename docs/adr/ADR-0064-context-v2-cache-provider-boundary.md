# ADR-0064：Context v2、前缀缓存与 Provider 调用边界

- 状态：Accepted
- 日期：2026-08-26
- Extends：ADR-0024、ADR-0032、ADR-0044、ADR-0059
- Supersedes：ADR-0059 与通用内容总纲中把完整 ContextAssembler v2 推迟到 Phase 11 的实施时点；真实 Provider 仍留在 Phase 11
- 上位契约：[Phase 8 实施规格 §10～13](../spec/phase-8-implementation-v0.1.md#10-charactercontrollercontext-v2)

## 背景

角色长期运行需要独立 Memory、当前 Scene、主观心理和最近互动，但直接继承 Provider 聊天历史无法证明 as-of、角色权限、fork 隔离或重建一致性。另一方面，若每轮把全部动态状态放在 Prompt 前部，会让前缀缓存几乎失效。真实 Provider 尚未接入，但如果 Scripted Provider 绕过最终 Renderer，Phase 11 仍会被迫重做上下文和调用边界。

## 决定

1. 每次 Character/Director 调用都从耐久来源在明确 as-of 水位重建语义 Context，不继承不透明 Provider Session。允许来源只包括冻结 Manifest、指定 CharacterView、SceneDecision、已验证 Memory、当前 Round stimulus、Affordances 和 Host 固定契约。
2. Character、Director、未来 Observer 使用不同 Context 类型，不建立带大量可选敏感字段的通用 Context。角色 Context 固定为 `character-controller/v2`，Director 固定为 `director-planning/v1`。
3. Character Provider 的缓存顺序固定为 Host Protocol、Controller Contract、World Public Anchor、Character Anchor、Continuity Checkpoint、Recent Interaction Tail、Current Self、Current Scene、Recall、Stimulus、Affordances、Output Reminder。动态 ID、时间和审计 Hash 默认留在 Receipt，不提前破坏 Prompt 前缀。
4. Checkpoint 是来源范围、Hash 和版本化派生数据；只在确定性 Round 边界重建。近期历史按完整 InteractionBlock 追加，不截断问题/回答、承诺/回应或开放事项。Fork 只继承不晚于 forkSeq 的 Checkpoint。
5. `contextHash` 只标识语义选择；`providerRequestHash` 标识精确 Renderer、消息、Tool、Model Profile 和采样请求。每个参与者耐久保存 `context-receipt/v1`，支持同版本历史 rebuild/verify。
6. Pack/玩家/Memory/Portrayal 都是不可信数据叶子，不能进入 System/Developer 控制层。角色 Provider 只允许一次 `submit_actions`，Director 只允许一次 `submit_director_plan`；不保存或要求 chain-of-thought。
7. Context Profile 与 Host Model Profile 分离。compact/standard/deep 只改变已授权内容容量，不改变 namespace、as-of、Capability 或 Secret 可见性。必需内容超限时参与者降级，不静默删权限、当前心理或 Stimulus。
8. Phase 8 的 Scripted Prompt Provider 必须消费最终 ProviderRequest 字节，并经过耐久 ProviderCallIntent、append-once Result、Authority 引用和崩溃恢复。Phase 8 不创建未被当前路径使用的 HTTPS/Credential 空实现。
9. dispatch 后无终态的外部调用是 ambiguous；无可靠 Provider 幂等契约时默认不自动重发。系统保证世界效果 at-most-once，不宣称外部 API 计费 exactly-once。
10. 默认只保留有效 Tool Call、Canonical Proposal、Hash、Usage、Cache 和 terminal 元数据；Prompt/Response 原文和 chain-of-thought 默认不持久化。API Key 永不进入 Context、Manifest、Hash、Audit 或 Export。

## 后果

- 同一历史水位可以重建角色实际看到的上下文，并区分语义一致与 Provider 布局一致。
- Cache miss 只影响性能，不会改变角色权限、Memory 或世界结果。
- Checkpoint 只造成局部、一次性的缓存失效；Character Anchor 之前的前缀继续复用。
- Phase 11 接真实 API 时只增加网络、凭证、真实 Token Counter 和错误映射，不再改变世界提交或上下文语义。
- 外部请求可能在不确定窗口产生一次无法确认的费用，但永远不能重复写世界事实。

## 验证

- Character/Director Context、Receipt 和 ProviderRequest 精确 bytes/hash 跨 Windows/Linux、Node 22/24 一致。
- secret、latent、director、future、other-world、other-branch、other-character canary 不出现在未授权请求字节。
- shared prefix、Character branch、Tail append 和 Checkpoint 单次失效的最长公共前缀符合 Golden。
- ContextReceipt 同版本重建全等；来源缺失、版本缺失、as-of 越界或 Hash 分歧 fail-closed。
- Provider before-dispatch、after-dispatch、after-response 和 before-world-commit 硬崩溃矩阵保证调用状态和世界 at-most-once。
