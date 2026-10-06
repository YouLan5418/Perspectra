# Phase 8 创作者运行手册

本手册面向只编辑 JSON/Markdown 内容、不修改 Kernel 的本机创作者。Phase 8 在 Phase 7 的角色、地点、物品和初始认知之上，增加可重建的复杂主观状态、多 Scene、Memory Profile 与 Context v2；它不开放脚本、模型端点或系统提示。

## 1. 当前能创作什么

`worldpack-source/v2` 可以声明：

- 角色公开刻画、驱动和原则；
- 角色各自的 Observation、Subjective Claim、Goal、Relationship、Affect、Inner Tension、Commitment 与 Open Loop；
- `created`、`active`、`closed` Scene，Location 绑定和初始成员；
- 每个角色的 `compact`、`standard` 或 `deep` Memory Profile 与 attention topics；
- public、director-visible、character-private、author-only 文档及 `memory_seed` 用途；
- 通用物品、地点、玩家绑定和确定性呈现。

这些内容只定义状态和来源，不定义心理学公式。`trust` 与 `distrust` 可以同时存在，多种情绪和矛盾倾向也可以并存；Kernel 不会自动推导“帮助一次就增加信任”或“听到一句话就相信它”。后续变化必须来自合法 Action、Reflection Proposal 和确定性 Policy。

## 2. 从参考 Pack 开始

Phase 8 不新增半成品脚手架命令。请复制仓库中的 `examples/world-packs/rainy-road-companions`，再修改副本：

```powershell
Copy-Item -Recurse examples\world-packs\rainy-road-companions D:\worlds\my-journey
```

主要文件如下：

| 文件 | 用途 |
| --- | --- |
| `worldpack.source.json` | 显式列出全部来源文件；不使用 glob 或隐式扫描 |
| `world.json` | 世界元数据、时间模式与冻结 Core Profile |
| `characters.json` | 角色身份、控制类别、初始位置与公开刻画 |
| `cognition.json` | 每个角色独立的八类初始认知与来源依赖 |
| `memory.json` | 每个角色的 Memory Profile 与注意主题 |
| `scenes.json` | Scene 生命周期、Location 绑定和初始成员 |
| `locations.json`、`entities.json` | 物理位置和通用物品 |
| `player-slots.json` | 唯一手动玩家角色绑定 |
| `presentation.json` | 本地确定性呈现配置 |
| `assertions.json` | Testkit 验收计划；不进入世界事实或 Agent Context |

字段精确定义见 [ADR-0069](../../adr/ADR-0069-worldpack-v2-source-file-shapes.md)。不要手写 Event ID、序号、Hash 或 Memory row；Compiler 会生成品牌 ID、来源引用、Manifest v4 和 Tick 0 Genesis。

## 3. 校验、测试、编译和激活

在仓库根目录执行：

```powershell
corepack pnpm@11.7.0 worldpack validate D:\worlds\my-journey
corepack pnpm@11.7.0 worldpack test D:\worlds\my-journey
corepack pnpm@11.7.0 worldpack compile D:\worlds\my-journey --out D:\worlds\my-journey.worldpack.json
corepack pnpm@11.7.0 worldpack inspect D:\worlds\my-journey.worldpack.json
corepack pnpm@11.7.0 worldpack activate D:\worlds\my-journey.worldpack.json --data-dir D:\worlds\my-journey-data
```

统一入口会读取 `sourceSchemaVersion` 或 `compiledSchemaVersion`，选择精确的 v1/v2 Compiler；不会把 v1 隐式升级为 v2，也不会在找不到版本时退回宽松解析。

`worldpack test` 当前执行确定性编译和 WorldSpec 适配，并如实返回 `assertionsExecuted: 0`。参考 Pack 的六轮 Scene、Memory、Reflection、fork、缓存与降级断言属于仓库 Testkit E2E，由 `pnpm check` 执行；命令不会假装运行这些行为断言。

同一个 `packId + packVersion` 的内容一旦改变，必须提升作者自己的 `packVersion`。不要用修改 Hash、删除锁或手改 SQLite 的方式覆盖已激活世界。

## 4. Scene 与移动

Scene 和 Location 是两件事：Location 表示物理位置，Scene 表示当前互动、调度和观察边界。

在 Scene v2 世界中，已接受的通用 `/move <locationId>` 会按目标 Location 查找至多一个未关闭 Scene，并在同一次 World Commit 中追加离场、必要的旧 Scene 关闭、目标 Scene 激活和加入事件。找不到目标 Scene 时角色可以处于零 focal Scene；找到多个候选属于完整性错误，系统不会猜选。

同轮参与者在 Round 开始时冻结。角色本轮移动离开后不再观察后续动作，进入新 Scene 的角色从下一轮开始参与 Agent 调度。完整决定见 [ADR-0072](../../adr/ADR-0072-location-bound-scene-transition.md)。

## 5. 认知、Memory 与隐私

- 每条主观状态属于一个角色；其他角色不能因为“数据库里存在”就读取它。
- 错误 Claim 仍是该角色的看法，不会升级为作者真相。
- “Bob 说过 P”形成带来源的交流记忆，不自动得到“P 为真”。
- `character_private`、latent guidance、raw Memory 与 author-only 内容不会进入其他角色或 Director Context。
- Recall 在候选建立前执行 world、branch、character 和 as-of 过滤；fork 后父分支 future canary 不可见。
- Continuity Checkpoint 只引用唯一确定性 L1 Summary，不复制或再生成第二份摘要。
- `contextHash` 表示获授权语义选择，`providerRequestHash` 表示精确消息布局；缓存未命中只能影响性能，不能改变内容或结果。

诊断时应使用正式 CharacterView、Context Receipt 和 Explain 输出，不要以作者全知读取代替角色视角。

## 6. 参考 Pack 的验收含义

“雨夜同行”只使用 Core `speak/move/take/reflect`，不包含旅行专用、调查、证据或结案 Action。正式 E2E 验证：

- Alice、Bob 和玩家拥有不同的初始认知与 Recall；
- Bob 的私下解释不泄漏给 Alice；
- Alice 可同时信任 Bob 的能力、怀疑其诚实，并保留互相冲突的情绪和行动倾向；
- Bob 离场后不再被当前 Scene 调度，三人移动到站台后下一轮恢复调度；
- Alice 的关系变化通过受限 Reflection Proposal 提交，而不是模型直写 Projection；
- restart、fork、future canary、同键重放、缓存前缀与降级恢复均保持确定性。

参考测试使用固定无网络 Scripted Provider，以证明 Context/Provider 权威边界。这个 Provider 不是 Pack 脚本，也不进入 Manifest Hash。通用本机激活不会把该 Fixture 当作创作者可配置代码；真实 API Key、Provider 选择和角色控制策略仍按规格推迟到 Phase 11。

## 7. 安全边界与恢复

Pack 不得包含 JavaScript、任意 Event、Memory row、网络 URL、API key、系统提示或 Provider 参数。路径逃逸、符号链接、大小写碰撞、未知字段、循环来源、跨角色 basis 和容量超限都会 fail-closed。

来源错误返回 Canonical `ErrorEnvelope`。出现 `PROJECTION_INVARIANT_FAILED`、`BUNDLE_HASH_MISMATCH`、`REGISTRY_HASH_MISMATCH` 或 quarantine 时，应停止写入并按 [V0 本机运行与恢复手册](../v0-phase-0-6/V0-LOCAL-RUNBOOK.md)处理，不要通过放宽 Schema 或重写 Golden 绕过。

Phase 8 的本机边界仍是私有源码、stdio only、Harness/TencentDB/真实模型禁用。它证明“每个 Agent 实际看到的输入和产生的主观变化可以精确重建”，不宣称已经提供面向最终用户的创作者平台或真实模型服务。
