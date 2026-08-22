# ADR-0045：调查物品的版本化取得规则

- 状态：Accepted
- 日期：2026-08-23
- Extends：ADR-0026、ADR-0034、ADR-0039

## 背景

最初的三角色悬疑 Demo 要求证明“Bob 拿走钥匙后，钥匙不再处于原位置”。Rulebook v1 只有 speak/move，`entity.upsert` 也只有 Genesis 种子用途；若由脚本直接写位置或持有者，会绕过 ActionRequest、稳定排序和逐动作重裁决，不符合 World Event Log 的权威边界。

同时，已经持久化的 Rulebook v1 Manifest、Registry Hash 和 Event Hash 不能因新增 Demo 规则而改变。

## 决定

1. 保留 `builtin:speak-move` version 1 的规范输入与全部 Registry 定义不变。
2. 新增同一 Rulebook ID 的 version 2。只有 v2 Manifest 注册 `take` Action、`entity.taken` Event 和 `builtin:speak-move/v2` Rule 定义，因此升级会产生新的 spec/manifest/registry Hash，不会静默改变 v1 世界。
3. `take` 参数严格为已有 Manifest `entityId`。每个 Action 在当前 Event prefix 上重建角色位置及物品 location/holder；物品存在、无人持有且与行动者同位置时才接受。
4. 接受时只生成 `entity.taken { entityId, characterId, fromLocationId }`；物品的当前状态由 `entity.upsert` 与 `entity.taken` 重放得到，不维护第二套可变事实。
5. 同一 Round 的后续竞争者必须看到前一个已接受 Action 的 EventDraft。物品已被取得或不在同一位置时返回领域拒绝 `ITEM_NOT_AVAILABLE`，Candidate 不变，技术错误不伪装成剧情结果。

## 后果

- 悬疑 Demo 的钥匙变化来自正式 Proposal 和 Rulebook，而不是测试专用写入口。
- 取得状态可以从 Event Log、fork prefix 和重启后的相同历史确定性重建。
- V0 暂不实现放下、转交、容器、所有权或隐藏物品；这些需要新的 Action/Event 版本。

## 验证

- 单元测试覆盖首次取得、重复取得、异地取得、未知实体、非法参数及 v1 不具备 take affordance。
- `MysteryDemoScenario` 集成测试验证 Bob 的 Proposal 被裁定为 accepted、钥匙 holder 变为 Bob，并在重启后保持相同 Event/CharacterView Hash。
