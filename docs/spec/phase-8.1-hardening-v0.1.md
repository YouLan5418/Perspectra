# Harness / Cordis World Phase 8.1 加固规格

- 状态：Accepted implementation target
- 规格版本：`phase8.1/v0.1`
- 日期：2026-08-29
- 基线：私有源码 `v0.3.0`
- 目标候选版本：`0.3.1`
- 上位规格：[Phase 8 实施规格](phase-8-implementation-v0.1.md)
- 主要 ADR：[ADR-0073](../adr/ADR-0073-participant-stimulus-director-visibility.md)、[ADR-0074](../adr/ADR-0074-deterministic-world-text-order.md)、[ADR-0075](../adr/ADR-0075-session-dead-letter-sequence-continuity.md)

## 1. 目标与边界

Phase 8.1 只修复 `v0.3.0` 独立审查发现的权限、确定性、Session 连续性和派生持久化缺口，不扩展题材能力，不实现 Phase 9，也不接入真实 Provider。

`v0.3.0` Tag 保持不可变。已经激活的 World、Manifest、Event、Authority 和 Session 数据不得重写；修复以新代码、新测试和 `v0.3.1` 候选交付。

## 2. 角色刺激与 Director 权限闭环

1. RoundCoordinator 在调用参与者前，使用冻结 `baseHeadSeq` 对玩家 Action 做一次无副作用 Rulebook 裁定，并复用该裁定作为玩家行动的正式基础裁定。不得为获得可见范围而执行第二套解析规则。
2. Scene Decision 根据该裁定的 `observationScope` 生成动作时刻 audience。每个 Character Provider 只能接收自己的刺激视图：
   - `full`：角色在 `fullContentCharacterIds` 中，继续使用原始 ActionRequest；
   - `occurrence_only`：角色仅在 `occurrenceOnlyCharacterIds` 中，使用固定 `private_interaction` ActionRequest，只包含 actor、裁定 status 和 `contentVisibility=occurrence_only`；
   - `none`：使用不含原 actor、原 actionType、原 actionId、正文、recipient 或参数的固定 `context.no-visible-stimulus` ActionRequest。
3. Memory Recall query、Cognitive ProposalContext、Character Context、`contextHash` 和参与者可见 `candidateHash` 必须全部使用同一个裁剪后刺激。禁止只裁 Prompt 而让原文进入 Recall 或 Hash oracle。
4. `full` 路径的规范值和 Hash 保持现有字节；只有原来错误泄漏的 `occurrence_only`/`none` 路径产生新 Context Hash。
5. ContextReceipt 对被拒绝的完整刺激记录 `audience_forbidden` exclusion；ProviderRequest 不包含被拒绝来源的正文或原始 Hash。
6. Director public entries 只能来自当前 focal Scene 的 `scene_public` 发言、该 Scene 的公开生命周期事件或显式 `director_visible` 来源。`direct`、`private`、`self`、其他 Scene、角色私有认知和 raw Memory 在候选建立前删除。
7. Director directive target 必须由该角色当前 focal Scene 成员资格的耐久事件证明；不得把任意 Scene source 轮转分配给 target。
8. Agent 由 `schedulableCharacterIds` 决定；Director 单独由 `directorEligible` 决定。Phase 8.1 不重新设计 Director 身份或新增 Director 题材动作。

## 3. 确定性排序

所有进入 Canonical/Hash、Manifest、Projection、Authority、Context、Memory、Snapshot 或稳定执行顺序的字符串比较统一使用 Contracts 导出的 UTF-16 code unit 比较器。生产代码禁止使用 `localeCompare`。

已有 ASCII Golden 必须逐字节不变。新增中文、组合 Unicode、全角字符、BMP/辅助平面字符的顺序与 Hash Golden。若既有 Fixture 变化，必须停止并建立显式兼容路由，不能直接更新 expected。

`v0.3.0` 对非 ASCII 领域数组使用了依赖 ICU 的排序，因而不存在可跨平台冻结的唯一结果。Phase 8.1 不重写已经激活的数据，只为后续新计算定义唯一顺序。

## 4. Session 死信连续性

一旦 Outbox 项取得 `sessionDeliverySeq`，它就是该 Session FIFO 的一个不可跳过位置。任何较早的 `dead_letter`，不论 critical 标志，都阻止同 Session 的较晚项被领取。

人工重试保留原 deliveryId、payloadHash 和 sessionDeliverySeq；原项成功后后续项继续。Phase 8.1 不创建自动跳号、伪 Observation 或 Session tombstone。`critical` 继续决定行政归档等严重程度，但不决定序号是否连续。

## 5. Clarification 与派生持久化

1. 已有 clarification 在 maintenance、quarantined 或 archived 状态下仍可校验并幂等读取。
2. 新 clarification 必须在同一个 `BEGIN IMMEDIATE` 事务中确认 Branch 为 active 且 admission open，再与 Audit 一起写入。
3. ContextReceipt append 和 ProviderCall prepare 的 append-once 写入、冲突读取与 Hash 校验分别置于各自短事务中。
4. Checkpoint 所需 Memory 水位不足返回结构化 `MEMORY_CATCHUP_FAILED`；普通失败继续只降级参与者，不阻断玩家 Round。
5. Tail 容量为零时必须选择空数组，不能让 `slice(-0)` 意外选择全部历史。
6. Provider Quality 的阈值、暂停窗口和退避表只从注册的 `provider-quality/v1` 常量读取。该 Store 记录真实 Provider 运行质量，是非权威、append-once 的运维派生状态；它可以先于 World Commit 落盘，但不得反写世界事实。

## 6. 测试门槛

- `scene_public/direct/private/self` × recipient/bystander/other-scene × Character/Memory/Director 的完整 canary matrix；
- 同键重放不重新调用 Provider，不重新检索 Memory；
- Director public entry 和 directive target 的 source ref 必须能回查到同一焦点 Scene 的耐久事件；
- 所有生产 `localeCompare` 清零，Unicode Golden 在四格 CI 一致；
- 非关键死信后续项保持 pending 且未级联失败，人工重试后 cursor 连续到达下一序号；
- clarification 首次写受 admission barrier 阻止，既有结果仍可在非 active phase 重放；
- ContextReceipt/ProviderCall 双连接竞争保持 append-once 或 fail-closed；
- Phase 0～8、P0～P6、旧 Pack/Manifest/Authority/Context 公共路径和全部 hard-crash 测试继续通过；
- 生产文件逐文件 statements/branches/functions/lines 100%。

## 7. 明确推迟

真实 Token Counter、Explain 的完整外部身份系统、派生库 Retention、`controllerEpoch` 换代、Director 身份重构、真实 API/Harness Bridge 继续按原路线推迟。历史提交消息和已发布 Tag 不重写，只在阶段报告记录流程改进。

