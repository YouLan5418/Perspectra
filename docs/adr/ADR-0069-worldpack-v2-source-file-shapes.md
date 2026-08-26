# ADR-0069：World Pack v2 作者源文件形状

- 状态：Accepted
- 日期：2026-08-26
- 上位契约：[Phase 8 实施规格 §14](../spec/phase-8-implementation-v0.1.md#14-world-pack-v2)
- 关联 ADR：[ADR-0054](ADR-0054-world-pack-source-compiler-versioning.md)、[ADR-0067](ADR-0067-cognitive-memory-worldpack-v2.md)

## 背景

Phase 8 已冻结 `worldpack-source/v2` 的显式文件列表、认知词汇、Scene/Memory 边界和 Document audience，但没有给出 Character、Scene、Memory、Document 四类作者文件的完整 JSON 字段，也没有定义 Document `usage`。若由 Compiler 实现自行猜测，会把未审议的字段名和默认值写入 packHash，并使跨平台 Golden 失去稳定依据。

## 决定

### Character v2

1. 文件版本固定为 `worldpack-characters/v2`。每项只必填 `characterId`、`displayName` 和 `controllerClass`。
2. `controllerClass` 固定为 `manual | scripted`。它是内容期望的逻辑控制类别，不是 Provider、模型、endpoint 或 Secret；Host 仍负责解析实际能力和 Runtime Availability。
3. `pronouns` 默认为空字符串，`initialLocationId` 默认为 `null`，`lifecycle` 默认为 `active`。这些默认值必须物化并进入 packHash。
4. `portrayal` 可省略；省略时规范化为 `null`，不生成平均人格。显式 Portrayal 只允许 `summary`、`speakingStyle`、`backgroundTextRef`、`drives` 和 `principles`；前两者默认为空字符串，背景引用默认为 `null`，drive/principle 是带唯一 local `key + text` 的数组。

### Cognition v2 补充

1. `worldpack-cognition/v2` 每个角色除 ADR-0065 的七类主观状态外，还可声明 `observations`。
2. 初始 Observation 必填 `key`、`content` 和 `epistemicKind`；`epistemicKind` 使用 Phase 8 已冻结的 `direct_observation | observed_action | reported_speech | subjective_inference | self_intention`，禁止作者声明派生专用的 `derived_summary`；`saliencePermille` 默认 500，`basisKeys` 默认空数组。
3. 同一角色的 Observation 与全部认知记录共享 local key 命名空间。Compiler 后续把它们转换为品牌 ID 和 Genesis source refs；作者仍不得手写 Event ID、seq 或 source hash。

### Scene v2

1. 文件版本固定为 `worldpack-scenes/v2`。每项必填 `sceneId`、`lifecycle` 和 `participantIds`，可选 `locationId` 默认为 `null`。
2. `lifecycle` 只允许 `created | active | closed`。初始 active Scene 可有一名或多名成员；created/closed Scene 可为空。成员无重复。
3. Source Parser 只验证局部形状。Compiler 必须验证 Character/Location 引用存在，并拒绝同一 Character 同时出现在多个初始 active Scene。Runtime 的 Scene 事件与 quarantine 不变量仍由 ADR-0066 管理。
4. Pack 不声明 Director 可见私密字段、观察扩大规则或后台 autoplay；Director eligibility 和动作时刻可见性继续由注册 Policy 决定。

### Memory v2

1. 文件版本固定为 `worldpack-memory/v2`，内容是按角色声明的逻辑配置，不是 Memory row 或召回结果。
2. 每项必填 `characterId` 和 `profile`；`profile` 只允许 `compact | standard | deep`。可选 `attentionTopics` 默认空数组，每项是普通不可信文本叶子。
3. 同一 Character 最多一项配置。缺少配置表示由 Manifest 锁定的 `standard` 逻辑 Profile；Compiler 必须把该默认完整物化，运行时不得据此改变 namespace、as-of 或来源验证。

### Documents v2

1. 文件版本固定为 `worldpack-documents/v2`。每项必填 `documentId`、`contentRef`、`usage`、`audience`；`characterIds` 默认空数组。
2. `usage` 固定为：

   - `world_context`：获授权的世界/Scene 背景数据叶子；
   - `portrayal`：角色塑造数据叶子，不产生 Memory；
   - `memory_seed`：为指定角色生成 Genesis Observation，再经正式 cognitive job 捕获；
   - `author_note`：仅供作者工具检查，不进入运行时 Context。

3. `audience` 继续固定为 `public | director_visible | character_private | author_only`。`character_private`、`portrayal` 和 `memory_seed` 必须声明至少一个 `characterId`；其他 audience 的 `characterIds` 必须为空。`author_note` 必须搭配 `author_only`，`memory_seed` 必须搭配 `character_private`。
4. `contentRef` 必须引用根清单显式列出的 Markdown 文件。自由文本始终是不可信 JSON 数据叶子，不能成为 System/Developer 指令；`author_only` 不进入运行时 Provider Context。

### 共同约束

1. 所有文件严格拒绝未知字段、非法 Unicode、重复 ID、越界 permille、未注册枚举和超过注册上限的数组。
2. Parser 只做单文件、可确定的局部检查；跨文件引用、controller 能力、basis 合法性/循环、Scene 单活归属、Document 引用和 Profile registry 均由 v2 Compiler 在生成 packHash 前 fail-closed 验证。
3. 本 ADR 只补齐 Phase 8 已要求的作者输入形状，不新增自定义 Controller、心理词汇、Rule DSL、真实 Provider 或 Runtime Author 接口。

## 结果

- 创作者文件有唯一可测试的规范化结果，默认值和 Hash 不再依赖实现者猜测。
- `worldpack-source/v1`、compiled `worldpack/v1`、旧 Manifest/Event/Authority 字节完全不变。
- v2 Compiler 可以按“局部 Schema → 跨文件链接 → compiled v2”三段实现，并在链接前给出精确 JSON Pointer 诊断。

## 验证

- 每类文件均有最小输入、完整输入、未知字段、非法枚举、重复 key、上限和默认值 Golden。
- v2 Compiler 必须另测缺失/跨角色/cycle basis、双 active Scene、Document audience/usage 配对和未注册 controller/profile。
- v1 Golden 不允许通过更新 expected 接受漂移。
