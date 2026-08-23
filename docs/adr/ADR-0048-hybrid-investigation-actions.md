# ADR-0048：混合文本输入与版本化调查 Action

- 状态：Accepted
- 日期：2026-08-23
- Extends：ADR-0024、ADR-0030、ADR-0045、ADR-0047

## 背景

悬疑 Demo 需要让玩家用自然语言执行检查、询问、出示证据和指控，但文本解析不能成为第二套世界规则，也不能让模型或 UI 直接生成世界事实。既有 Rulebook v2 已被 Manifest/Registry Hash 锁定，不能为新 Demo 静默增加 Action/Event。

## 决定

1. 新增 `builtin:speak-move` Rulebook version 3；v1/v2 Registry 和历史 Hash 不改写。v3 在 v2 的 `take` 之外注册：
   - Action：`inspect`、`ask`、`present_evidence`、`accuse`；
   - Event：`entity.inspected`、`character.asked`、`evidence.presented`、`investigation.accusation-resolved`、`investigation.case-closed`。
2. `DeterministicInvestigationIntentParser` 是非权威输入适配器。它把窄自然语言或显式命令转换为候选 `PlayerActionInput`；未知、歧义或缺参返回 `clarification_required`，不得猜测。
3. 所有候选 Action 继续经过耐久 Round Inbox、Validator、Rulebook、Authority 和 World Commit。解析成功不等于裁定成功。
4. 证据能力由截至当前 Head 的耐久 Event 前缀重建。解析器只接收该角色已经发现的 evidenceId；未发现证据不得出现在补全候选中，也不能被 `present_evidence` 或 `accuse` 裁定接受。
5. 调查顺序固定为：检查产生证据 → 出示证据 → 指控引用已经出示的证据。错误指控是已接受但 outcome=incorrect 的世界行为；正确指控产生 `investigation.case-closed`。结案后再次指控被拒绝。
6. 私有 culprit Claim 只由 Rulebook 在裁定正确指控时读取。玩家视图和 CLI 在结案前不暴露该 Claim；结案后只公开裁定结果。
7. 由于 v3 Manifest 与旧 Demo v2 不兼容，新切片使用 `world:ashgrove-murder-v2` 和输出协议 `ashgrove-murder/v2`，不尝试用同地址重解释旧数据库。

## 后果

- 玩家可以使用文本，但文本解释层无法绕开权威规则。
- 同一 Action 可以来自确定性 parser、未来 LLM intent provider 或显式命令，而重放只读取耐久 Action/Authority。
- 调查 Observation 已进入 CharacterView，可作为后续 Local Memory capture 的可信来源；本 ADR 不把 Memory 变成世界事实源。

## 验证

- Parser 测试覆盖中英文/显式命令、未知目标、别名冲突、证据授权过滤和重复证据。
- Rulebook 测试覆盖完整调查路径、错误/正确指控、目标不在场、证据未发现/未出示、结案屏障和畸形事件前缀。
- Demo Golden Scenario 覆盖七轮调查、私有 Claim 不泄漏、重启重放不调用 Provider、Event Hash 不变。
