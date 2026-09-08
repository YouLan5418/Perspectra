# ADR-0083：角色外显表现、观察传播与可见状态

- 状态：Accepted
- 日期：2026-09-08
- Extends：ADR-0024、ADR-0044、ADR-0065～0068、ADR-0077

## 背景

现有角色 Proposal 只能表达角色做了什么，`speak`、`move`、`take` 等 Action 无法结构化表达角色做这件事时外部可观察到的面部、视线、姿态、手势、声音和外观变化。将这些信息继续塞进对白正文会混淆行动与表现，无法可靠地交给 Observation、Memory、Galgame、Live2D 或其他表现层消费；把它建成第四种 Action 又会错误地把正交语义并入行为词汇。

同时，模型知道角色自己的 Affect、Goal、Secret 和 InnerTension。若外显表现绕过 Rulebook 直接进入 Observation 或 Memory，就会形成从私密心理到其他角色 Context 的事实泄漏旁路。

## 决定

### 1. 两条正交语义轴

1. `manifestation` 表达“角色做这件事时，别人能看到或听到什么”，不是 `speak`、`move`、`take` 的同类 Action。
2. V1 将 `manifestation` 放在角色 Provider 输出顶层，与 `actions` 平级。携带 `manifestation` 的 Proposal 必须恰好包含一个 Action；零 Action 的独立无言表现和多 Action 分别绑定表现推迟到后续版本。
3. 旧 `submit_actions/v1` 与 `submit_actions/v2` 的字段、验证、Canonical bytes、Hash 和运行行为永久不变。新能力使用显式 `submit_actions/v3`，并且只允许 Manifest 明确启用；不得根据模型是否返回新字段隐式升级旧世界。

### 2. V1 数据形状

`manifestation` 包含可选综合 `description` 和一至八个有序 `cues`。Cue 的 `channel` 闭集为：

- `facial`
- `gaze`
- `posture`
- `gesture`
- `voice`
- `appearance`

每个 Cue 拥有稳定 `cueId`、外部可观察的 `description` 和 `persistence`：

- `event_only`：只记录本次发生的表现；
- `until_changed`：除发生事件外，还更新当前可见状态。

`until_changed` V1 仅允许 `posture` 和 `appearance`，并必须携带稳定 `stateKey` 与 `set` 或 `clear` 操作。`event_only` 禁止携带状态操作。Cue 顺序属于 Proposal 语义并进入 Hash，不按数据库或 locale 重新排序。

`voice` 只表达语气、音量、语速或声音状态，不复制 `speak` 正文。`appearance` 只表达本轮新发生的外观变化，不重复角色固有外貌。Renderer 专用动画、立绘、TTS 或 Live2D 资源 ID 不进入世界事实；表现层按语义 Cue 做资源映射。

### 3. 独立裁定与 Authority

1. Manifestation 与 Action 分别产生裁定。Action 可以 accepted/rejected，Manifestation 可以 accepted、partially_accepted 或 rejected；Manifestation 失败不得反向改变合法 Action 的裁定。
2. 模型输出仍然只是 Proposal。结构校验、Channel/Persistence/状态操作限制和 Scene 权限检查通过后，Rulebook 才能生成 Manifestation Fact。
3. Round Authority 必须保存原始、已验证的 Manifestation Proposal、每个 Cue 的裁定和对应 Hash，并与 Event、Tick、Head、Outbox 在同一 World 事务提交。重放读取耐久 Authority/Event，不重新调用模型或重新解释自由文本。
4. V1 Manifestation 绑定该 Proposal 的唯一 Action attempt；Action 被领域拒绝时，Rulebook 仍可独立接受纯外显 Cue，但不得把描述中声称的未发生 Action 当成事实。

### 4. Event 与当前可见状态

被接受的 Cue 生成不可变、版本化 Manifestation Event，表示“刚刚发生了什么”。只有 `until_changed` Cue 才在同一提交中额外生成版本化 visible-state upsert/remove Event。

当前可见状态是这些 Event 的时态 Projection，不是第二事实源。Projection 至少保留 `characterId`、`stateKey`、`channel`、`description`、`sourceSeq` 和最后变更水位，并支持按 Branch、forkSeq 和任意 as-of 水位重建。状态只由后续显式 Event 替换或清除，不按墙钟或进程内 TTL 自动消失。

### 5. Observation、Memory 与心理边界

1. SceneDecision 在 Action 发生时计算观察者，Rulebook 给出的范围是上限，Scene 只能缩窄。完整观察者收到获授权的 Cue；`occurrence_only` 观察者只知道互动发生，不得收到 Manifestation 正文或结构化细节；不在场角色无 Observation。
2. 每个观察者获得自己的 `observation.upsert`。Player、Agent、Reaction Cycle、Session 和 Memory 只消费已提交 Observation，不读取 Provider Proposal。
3. Memory 记录“某角色表现了什么”，不得把 Manifestation 自动提升为该角色真实 Affect、Goal、Secret、动机或事实 Claim。`看起来嫉妒` 只是一项可观察表现或观察者判断，不等于 `jealousy = true`。
4. Manifestation Observation 可以随已绑定 Action 成为现有 Reaction 刺激，但 V1 不为 Cue 单独创建第二份 Reaction Job，避免重复刺激和无言表现循环。

### 6. Presentation

基础文字 Presenter 按“外显动作描写 + 对白/行动结果”渲染。若综合 `description` 缺失，使用已接受 Cue 的稳定顺序生成基础文本；Presentation 失败不得影响 World Commit。

Galgame、Live2D、语音和动画适配器只读取已提交、按观察者裁剪后的 Manifestation Observation 或当前 Visible State，不读取模型 Proposal、私密认知或全知 World Event。资源映射属于 Presentation Profile，不进入 World Hash。

## 后果

- 角色可以表达犹豫、掩饰、矛盾和非语言交流，而不会把内部心理直接变成公共事实。
- Event 历史与当前可见状态不再混淆，“皱眉”不会永久挂在角色身上，而“袖口湿了”可以持续到明确清除。
- 新能力会扩展 Provider Tool Schema、Manifest 能力轴、Round Authority、Event Registry、Projection、Observation 和 Presenter，因此属于独立版本化阶段，不是向旧 Schema 添加可选字段。
- V1 的单 Action 限制牺牲部分表达力，以换取明确的表现绑定和可重算裁定；未来可迁移为 `actions[].manifestation`，不得重解释 V1 历史。

## 验证

- 旧 `submit_actions/v1/v2`、Manifest、ProviderRequest、Authority 和 Event Golden 全等。
- 同一 Manifestation 在玩家 Root Round 与 NPC-only Reaction Round 中产生相同裁定语义。
- action accepted/rejected 与 manifestation accepted/rejected 的组合矩阵均有测试，且失败 Cue 不影响合法 Action。
- 同 Scene、occurrence-only、不在场、离场、私语、重启、fork 和 future canary 不泄漏未授权 Cue。
- `event_only` 不进入当前状态；`until_changed set/clear` 可在任意 as-of 水位精确重建。
- Memory 只从已提交 Observation 捕获；Proposal、被拒绝 Cue、其他角色私密心理和未授权 Cue 均不可召回。
- 文字 Presenter 有确定性回退；Live2D/资源映射变化不改变 World/Event/Context Hash。
