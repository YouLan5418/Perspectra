# ADR-0068：Phase 8 摘要、上下文 Hash、信号与 Provider 质量边界

- 状态：Accepted
- 日期：2026-08-26
- extends：[ADR-0064](ADR-0064-context-v2-cache-provider-boundary.md)、[ADR-0065](ADR-0065-cognition-v1-reflection-policy.md)、[ADR-0066](ADR-0066-scene-v2-director-observation.md)、[ADR-0067](ADR-0067-cognitive-memory-worldpack-v2.md)

## 背景

Phase 8 规格已经冻结可重建 Context、Cognitive Memory、Reflection 和限域 Director，但独立审查发现五个实施者仍可能作出不同解释的交界面：Checkpoint 与 Memory L1 是否各自生成摘要、语义 Hash 与精确请求 Hash 的成员边界、latentGuidance 的最小权限、Dramatic Signal 是否能从私密心理聚合，以及 Provider 持续产生非法认知输出时如何降级。

这些问题不改变 ADR-0064～0067 的方向，却必须在 P8.2 开始前收敛，否则两个均“合理”的实现可能生成不同 Context、泄漏私密存在性，或在坏 Provider 上无限空转。

## 决定

1. Memory L1 是 Phase 8 唯一的确定性经历摘要算法。Checkpoint 不生成第二套经历摘要；它只引用已经验证的 L1 Summary identity、source range 和 Hash，并组合当前结构化认知状态。若该水位没有可用 L1，Checkpoint 只保存来源范围和 Hash，不临时生成自由文本。
2. Reflection Profile 约束单轮变化，Context Profile 约束接受后的最终 active 状态。Validator 必须先在不可变前缀上计算整个 Batch 的最终候选，再同时检查数量、幅度、awareness、文本和目标 Profile 容量；任一失败整批拒绝，不以事后裁剪满足容量。
3. `contextHash` 标识预算完成后实际选中的语义段、稳定顺序、规范化值、版本和 source refs。`providerRequestHash` 标识由该 Context 渲染出的精确消息角色与 UTF-8 bytes、Renderer、Tool Schema、Provider、Model、采样参数及 Provider 可见分区值。API credential、传输超时、请求追踪 ID、缓存命中结果、网络重试次数和计费回执不进入两者。
4. Phase 7 的 `epistemicStatus` 与 Phase 8 的 Claim `stance` 是两个版本化词汇，不自动映射。`mistaken` 只描述作者或测试对 Claim 与权威事实的比较结果，不进入角色 Context，也不自动产生 believed、suspected、doubted 或 denied。
5. `latentGuidance` 只允许指定角色自己的 unrecognized Goal、RelationshipAttitude、Affect 和 InnerTension 的结构化字段。它不得包含 Claim、Memory/Observation 原文、作者秘密、其他角色状态或从无权来源派生的标签；不得进入 Player/Observer/Director Context、Explain 安全面或其他角色 ProviderRequest。
6. Dramatic Signal 只能从 focal Scene 的 public Event/Observation、明确 `director_visible` 来源、运行时 Health/Availability，或显式标记为 director-visible 的结构化认知项派生。权限过滤必须先于计数、聚合和阈值判断；`character_private`、latentGuidance、raw Memory 和 author-only 来源不能通过数量、布尔值或压力等级间接进入 Director Context。
7. Provider 质量由 Manifest 锁定的 `provider-quality/v1` 确定性策略管理。eligible Tick 指该角色按 Scene、参与策略和非质量类 Runtime Availability 本应被调度的 Tick。默认连续三次非法 Reflection Batch 后暂停该参与者的 Reflection 能力四个 eligible Tick，外部 Action 能力继续运行，窗口结束时允许一次 Reflection probe；合法 Batch 清零计数。连续三次整个 Provider 响应非法时，参与者进入 `provider_output_invalid` degraded 状态，按 1、2、4、8 eligible Tick 封顶退避进行 probe；合法完整响应恢复 ready。质量降级写耐久状态、Audit 和 Metric，但不 quarantine 世界。
8. Host Model Profile 字段固定命名为 `providerUserPartitionPolicyId`。它表示 Provider 侧稳定、伪名化的业务 Principal 分区策略，不使用 NPC/Character ID 充当外部用户身份。
9. Phase 8 以三道门实施：8A 为契约、Pack、时态认知和 Scene；8B 为 Memory、Checkpoint、Context 和缓存；8C 为 Reflection、Provider、参考 Pack 与崩溃闭环。每道门通过自己的重启、fork、as-of、Hash 和隔离门槛后，下一道门才开始组合。

## 后果

- Checkpoint 与 Memory 不会产生两套相互漂移的摘要事实源。
- Cache key 可以因布局变化失效而不改变语义身份，也不会把运行环境凭证或瞬时传输状态写入耐久语义。
- 私密心理不能借 latentGuidance 或聚合后的 Director Signal 绕过角色边界。
- 坏 Provider 会被确定性降级和探测，而不会无限空转、阻塞玩家或把格式错误误判为世界完整性故障。
- 三道门降低联调爆炸面，但不改变 P8.2～P8.12 的最小提交顺序。

## 验证

- 同一 L1 Summary 被 Checkpoint 按 identity/hash 引用；L1 缺席时 Checkpoint bytes 中不存在替代经历正文。
- Golden mutation matrix 分别覆盖语义内容、source/order、Renderer、Tool Schema、Model/采样、credential、timeout、trace id 和 cache hit，证明两个 Hash 只在规定成员变化时改变。
- latent、other-character、author-only 和 private-count canary 不出现在 Character、Director、Observer 或 ProviderRequest 的未授权 bytes、长度、计数和 Signal 中。
- Reflection 最终候选同时触发单轮幅度和 Profile 容量检查，Batch 不发生部分接受或事后裁剪。
- 非法 Reflection 与非法完整响应分别达到阈值、退避、probe 和恢复；玩家 Round 正常提交，同键重放不重复调用 Provider。
- 8A、8B、8C 均有独立 requirement→test evidence，失败的后一道门不得通过更新前一道门 Golden 绕过。
