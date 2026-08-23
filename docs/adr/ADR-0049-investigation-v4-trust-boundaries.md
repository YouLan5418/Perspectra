# ADR-0049：调查 v4 的证据身份与作者真相边界

- 状态：Accepted
- 日期：2026-08-23
- Supersedes：ADR-0048 中 Rulebook v3 作为悬疑 Demo 当前版本的决定
- Extends：ADR-0024、ADR-0026、ADR-0030、ADR-0047、ADR-0048

## 背景

Rulebook v3 以 `entity.kind` 生成 evidenceId，而 Demo 的文本目录由手工清单维护。合法检查一个未列入清单的实体会产生耐久证据，但后续解析器无法表示它；原实现还把该不一致抛成进程异常。v3 的正确指控从通用 `claim.upsert` 历史识别 `is_culprit`，未来模型反思也能产生 Claim，因此缺少不可伪造的作者来源边界。

v3 Registry 和 Manifest Hash 已被接受，不能原地改变其重放语义。

## 决定

1. 新增 `builtin:speak-move` Rulebook version 4；v1、v2、v3 Registry、Manifest 与历史裁定保持原样。
2. v4 检查证据 ID 固定为 `evidence:inspection:${entityId}`。实体 ID 在 Manifest 内唯一，因此相同 kind 的实体不会共享证据能力。
3. v4 Registry 新增 `investigation.culprit-seeded`。Compiler 只为 Genesis 中同时满足以下条件的作者 Claim 生成该事件：`source=author-secret`、命题主语等于 Claim owner、谓词为 `is_culprit`、对象为 `true`。通用 `claim.upsert`、Memory、reflect 与模型 Proposal 均不能生成作者真相事件。
4. v4 正确指控只读取耐久 `investigation.culprit-seeded` 前缀；畸形种子事件 fail-closed。模型伪造的同形 Claim 不参与结案判断。
5. v4 结案后 `inspect`、`ask`、`present_evidence`、`accuse` 全部返回 `CASE_ALREADY_CLOSED`；其他非调查 Action 不受影响。
6. `DeterministicInvestigationIntentParser` 的安全默认是零角色、零实体、零证据授权。调用方必须显式传入当前可见目录；授权集中出现目录外的耐久 ID 时取交集并返回 clarification，不得崩溃或泄漏完整目录。
7. Demo 文本目录从已编译 Manifest 的角色和实体生成，并为每个实体生成对应 evidenceId；CLI 仅输出玩家自己的调查视图，不输出其他角色的 discovered/presented 台账。
8. v4 的玩家 Observation 对同轮公开 `character.speak` 附带已裁定 speech 数据，使现场对白进入耐久玩家可见输入；Presentation 仍不成为事实源。
9. Demo 使用新 World 地址 `world:ashgrove-murder-v3` 和输出协议 `ashgrove-murder/v3`，不以新 Manifest 重新解释 v2 数据库。

## 后果

- 合法探索不会因文本目录漂移永久锁死数据库。
- 证据身份不再依赖可重复的展示分类，真凶事实不再能被普通 Claim 洗白。
- Parser 作为公共 API 时默认 fail-closed；显式授权仍只是候选过滤，最终授权继续由 Validator 与 Rulebook 执行。
- v3 保留作为历史兼容版本；新悬疑场景只使用 v4。

## 验证

- 全新世界在开场前检查钥匙，后续询问、重启和出示仍可继续。
- 无授权 Parser 不解析或枚举角色、实体、证据；未知授权 ID 不抛异常。
- 两个相同 kind 的实体得到不同 evidenceId；同轮重复检查在已接受前缀上重裁决。
- 伪造 `is_culprit` Claim 不改变结案结果，作者种子可正确结案，畸形种子 fail-closed。
- 结案后的四类调查 Action 全部拒绝；玩家视图可见 Bob 的已提交对白且 CLI 不含其他角色调查台账。
