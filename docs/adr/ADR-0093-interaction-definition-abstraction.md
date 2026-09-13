# ADR-0093：交互定义抽象、按需交互包与目标自声明

- 状态：Accepted（2026-09-13 用户明确确认；按 V0.2 与 I0-B 契约分阶段实施，工程验收另记）
- 日期：2026-09-13
- 修订：2026-09-13，接受记录及 [实施契约](../spec/interaction-definition-v0.1.md)；I0 Gate 已关闭
- Extends：[ADR-0034](ADR-0034-contract-registries.md)、[ADR-0044](ADR-0044-round-authority-ledger.md)、[ADR-0050](ADR-0050-rulebook-registry-mystery-boundary.md)、[ADR-0057](ADR-0057-creator-extension-runtime-author.md)、[ADR-0077](ADR-0077-bounded-autonomous-reaction-cycle.md)、[ADR-0078](ADR-0078-reaction-policy-manifest-version-gate.md)、[ADR-0081](ADR-0081-deployment-backup-restore-set.md)、[ADR-0083](ADR-0083-manifestation-observable-expression.md)、[ADR-0085](ADR-0085-bounded-action-groups.md)
- 局部 supersede（仅对新版本生效，不改写既有 ADR）：[ADR-0086](ADR-0086-object-interactions.md) 的固定 operation 与包外目录入口、[ADR-0087](ADR-0087-player-immediate-character-interactions.md) 的 `hand_hold` 专用关系实现
- 上位契约：[通用内容架构总纲 §9、§11](../spec/general-content-architecture-v0.1.md)、[交互抽象与按需交互包方案](../2026-09-13_方案-交互抽象与按需交互包-v0.2-report.md)

## 背景

交互已经是声明式的，但只到绑定层。

目录本身是数据：`definitions` 声明交互身份、显示名与操作，`bindings` 把交互挂到具体目标上，解析器做严格闭合校验并 canonical 排序。因此"给某个物品加上拿取/放下"、"改显示名"、"改绑定关系"已经是内容配置，不需要改代码。**但语义不在数据里**：

| 观测 | 证据 |
| --- | --- |
| `operation` 是闭合枚举，且按 `targetKind` 分家：entity 只能 `take/drop/give`，character 只能 `hold_hand` | `packages/kernel/src/interactions.ts:160-164` |
| `initiationPolicy` 形似配置，实为常量：entity 必须 `standard/standard`，character 必须 `commit_then_react/forbidden`，换值即抛 | 同文件 `:132-147` |
| `hold_hand` 的裁定语义是硬编码分支（同 Scene、同地点、目标 active、非自指、无重复、必须 manual player immediate） | 同文件 `:429-455` |
| `core:release-hand` 由运行时凭空生成，不在任何 `definitions` 里 | 同文件 `:416-425`、`:525` |
| 关系重建只接受 `hand_hold` | 同文件 `:226` |
| 基础移动直接调用结束角色关系的函数 | `packages/kernel/src/rulebook.ts:200` |
| 表现词汇固定为八个码 | `packages/contracts/src/action-group.ts:4` |

比语义闭合更根本的是**位置**：目录不在世界包里。`WorldPackSourceManifestV4` 列了 `worldFile`、`characterFiles`、`locationFiles`、`entityFiles`、`sceneFiles`、`playerSlotFiles`、`presentationFiles`、`cognitionFiles`、`memoryFiles`、`documentFiles`、`markdownFiles`、`assetFiles`、`assertionFiles`、`reactionFile`、`manifestationFile`，**没有交互目录字段**；全仓没有任何 `worldpack.source.json` 引用 interaction。目录经 `WorldPackRuntimeOptions.interactionCatalog` 进入编译器（`packages/world-pack/src/tooling.ts:86-89`、`compiler.ts:1299`），CLI 入口是 `activate <pack> --interactions <catalog.json>`。

后果是：**同一份已编译 Pack，换个目录就得到不同的 Manifest 与 specHash。** 世界形态由 Host 的运行时参数决定，而不是由世界内容决定。注意 `assertionFiles` 与 `manifestationFile` 都已在包源内——"把能力挂进包源"这个模式本仓库已经会用，交互只是当时没做。

ADR-0086 与 ADR-0087 明确规定了首版闭集，本 ADR 不否定它：那些限制来自阶段范围，不是设计上的终点。但继续按"每个新交互加一条 Kernel 分支"扩展，会让通用运行链路持续积累题材动作名，这正是 ADR-0057 想要避免的结果。

## 决定

1. **三个顶层入口同级。** speak 与 move 保留专用处理器与既有参数语义；interact 通过精确版本化定义调度。具体交互名不写入通用校验分支。
2. **定义身份与绑定身份分离。** InteractionDefinition 是受信任包提供的确定性行为；InteractionBinding 是目标上的一个配置实例，可带经校验的固定参数；InteractionRequest 是不可信提案，actor 与裁定权限由 Host 确定。显示名称不参与动作身份解析。
3. **基础交互与第三方交互实现同一契约。** 基础包不享有跳过验证的特殊路径。
4. **作者在物品与角色定义文件里声明 `interactionBindings`**，编译后统一收敛为 definitions、bindings、definitionLocks 与依赖闭包。目标声明"提供什么"，不声明哪个模型能代替谁行动。
5. **定义声明规则引用、参数契约、效果与生命周期；Rulebook 执行检查并掌握提交权。** 规则引用不是自然语言指令：首版只允许已注册规则与类型化参数，受信任规则是同步纯函数，输入为不可变候选快照与 Host 上下文，不传递数据库句柄、Provider、文件或网络能力。
6. **当前交互选项是指定角色的可重建授权视图**，绑定 WorldAddress、characterId、asOfWorldSeq、ManifestHash 与 viewPolicyHash；最终执行重验最新候选前缀。候选枚举只做可公开检查的部分，不调用效果构造器、不写状态、不生成真实关系身份。
7. **Host 已安装、世界启用、目标绑定、角色当前可尝试是四个不同条件。** 新世界必须把包选择写入 Manifest，不能依赖"程序启动时碰巧注册过"。
8. **可见目标与可尝试动作分开**；Scene 过滤器只能收窄能力，多个过滤器按冻结策略取交集而非并集。
9. **持续关系与待签收记录由事件重建**，必须各自提供解除或终止路径。关系句柄不是 capability，猜中身份也要重验参与者资格。
10. **新协议从同一份冻结定义派生 Schema 与校验**；旧协议继续使用原契约，旧 Manifest v1～v9 的编译、协议与 Resolver 不变。
11. **Memory 继续消费授权 Observation**，按交互种类增加捕获分支不算扩展。摘要与 Recall 不得从"拥抱发生"推导"双方喜欢"。
12. **首版不支持运行中热插拔。** 停用某包的新动作不代表可以卸载历史所需实现：已有关系、待签收记录与 Replay 依赖必须保留，无法安全完成生命周期时拒绝停用。
13. **依赖必须精确锁定。** 包完整声明传递依赖，激活前验证身份唯一、无依赖环、版本精确、契约与实现锁一致；缺失、重复或 Hash 漂移立即拒绝，禁止就近版本替换。

14. **参与者角色完整授权。** 定义声明主目标与辅助角色槽、数量/类型/别名约束和参数映射；Host 解析 actor，Rulebook 校验全部角色组合，结果映射进入 Authority。
15. **基础效果受限复用。** 包通过类型化状态域效果生成候选事件，不提供任意属性/事件 patch；新领域提供完整事件、Reducer 与不变量，不要求修改全局效果枚举。
16. **表现与持续可见状态的契约在 I0 冻结。** 新路径复用已有 visible-state 来源；表现不能虚构持有、接触、支撑或外观状态，旧八 cue 与旧归一化保留。
17. **空间能力显式准入。** 同地点不自动等价于触手可及或坐在指定椅子上；缺实现拒绝启用相关定义，不以表现补位移。
18. **反应依据来自裁定结果和授权 Observation。** 新排序采用独立策略身份、稳定预算和耐久来源，不改旧 responsive/v1；包不能自报优先级，沉默不等于同意。
19. **诊断只读既有耐久依据。** 作者视图串联选项、裁定、观察、调度和 Context，不建立新事实账本，不向玩家泄漏私有信息，也不声称解释了模型内部动机。

## 非范围

任意 guard/effect DSL、Pack 脚本、表达式字符串、宏、任意 Event 模板、递归规则与外部路径；不受信任第三方代码沙箱（ADR-0057 第 4 条的边界不变）；运行中热插拔；把自由叙述直接提交为世界事实（已验证表现仍可形成观察事实）；NPC 主动发起身体接触；世界级 Memory Profile 改造（本 ADR 只协调版本号分配）；活动世界原地升级。

## 后果

- **新交互的落点是受信任包，不是 Kernel。** 通用 Kernel 不再新增动作名分支，这是本 ADR 主要的可检验承诺。
- **新增两个 workspace 包**，依赖方向为 contracts ← interaction-runtime ← 基础包 ← Application 组合根；基础包不依赖 Application、Store 或 Memory。包数量用于保证依赖方向，不要求拆分进程或引入外部服务。
- **I0 评估全部受影响契约，只对实际表示或语义变更分配新版本。** 包括 Manifest、源格式、模型协议、Authority、表现/反应策略和必要的 SQLite 迁移，不强制所有数据库同时升版。重新枚举版本守卫；已有 27 处统计是核对起点。旧世界继续走旧路径。
- **新 Manifest 版本会让旧 Host 无法打开新世界**，这是既有 fail-closed 原则的延续，不是缺陷。
- **已产生新事件的世界不能回退给旧程序解释。** 与 ADR-0091/ADR-0092 同类，兼容矩阵要求升级前留存完整备份或继续使用兼容新 Host。
- **后续实现将使关系与移动解耦。** 新路径的 move 不再认识具体接触包，统一阶段计划在空间/Scene 迁移后驱动已启用关系定义收尾。这需要新增跨包生命周期 DAG 与环路拒绝；当前黄金冻结不代表该机制已实现。
- **签收类跨轮交接会新增一种耐久状态**（pending 递交），它不锁住物品、也不阻止移动，但必须有 withdraw、失效与竞争语义。

## 验证

I0～I5 的阶段 Gate 见方案 V0.2 §14。I0-A 的编译黄金已冻结；I0-B 契约、运行期补充黄金和版本表已完成，用户明确确认接受后进入 I1；见 [I0-B 记录](../2026-09-13_交互抽象-I0B运行黄金与契约准备.md)。结构性承诺包括：

- 未注册、未启用、Hash 漂移、重复注册的包与定义全部在 Writer Lease 或入站受理前失败。
- 一个物品完成 take → give → drop → take 闭环，且通用 Kernel 中不出现这三个交互名分支。
- 只修改内容文件即可加入新的可交互物品；角色、Scene、Branch 隔离与 as-of 重建全部通过。
- I5 以独立 fixture 包（自带状态、规则、Event、Reducer 与观察）验证完整调用链：不修改通用 Kernel、Application、Agents、Memory 中的动作名判断即可运行，禁用后从模型与当前选项中消失，且历史依赖仍可重放。
- **旧路径黄金全等**：`tests/interaction-baseline.integration.test.ts` 冻结了示例 Pack 在 Manifest v6～v9 四种适配下的 manifestHash 与 genesisHash、冻结注册表与词汇集 Hash，以及 `WORLD_SCHEMA_VERSION=18`／`CONTEXT_SCHEMA_VERSION=7` 两个字面量。该文件必须在任何重构之前保持通过。
- 生产代码逐文件四项 100% 覆盖，`corepack pnpm@11.7.0 check` 退出码 0，高风险提交窗口保留子进程硬终止测试（本次至少覆盖多事件交互的两个事件写入之间、最后一个事件写入后但 COMMIT 前、COMMIT 后 receipt 前）。

- 角色槽非法组合、表现虚构持有/支撑、缺空间能力、反应依据无观察来源全部拒绝；新旧策略的次序和预算分别可重放。
- 补充旧运行期 Event/Authority、模型 Schema/归一化与表现状态黄金；039b590 的原 expected 不因修订更换。未来确需数据库迁移时，单独说明字面量哨兵的变化并保留旧库兼容验证。

## 待决项（接受前历史记录）

以下必须在 I0-B 完成并进入生产实现前裁定；本文仍为 Proposed：

1. **第一批基础包动作目录。** 方案 §9.1 的九行是检验抽象的代表性案例，不是清单。
2. **新版本号分配。** 含 Manifest v10 的归属：合并记录 §7 第 1 条的声明式记忆策略与 ADR-0093 的包选择都指向 v10，两者可以共用同一版本（v9 已同时承载 `interactionCatalog` 与 `playerInputPolicy` 两个互不相关的命名新增），但必须先落笔。
3. **ADR-0092 在本基线仍为 Proposed。** 本 ADR 不承担其接受与否，也不因其代码已存在而视其为 Accepted。

4. **角色、表现、反应与空间契约。** 冻结方案 V0.2 的类型、来源规则、策略版本、资源上限及首批实现范围；示例不等于动作目录。

## 2026-09-13 接受裁定

用户明确同意 [I0-B 记录第 6 节](../2026-09-13_交互抽象-I0B运行黄金与契约准备.md) 所列接受修改；历史待决项及原决定保留，以下裁定解决对应问题：

1. 首批迁移 base:take、base:drop、base:give、base:hold-hand、base:end-contact；其他例子后续另议。
2. Manifest v10 先交互，世界级记忆策略后续升版。
3. 角色、效果、表现、反应、空间、预算和版本按 [I0-B 实施契约](../spec/interaction-definition-v0.1.md) 冻结。
4. ADR-0092 保持原状态。I1～I5 仍须逐阶段通过工程门禁，接受不代表功能已实现。
