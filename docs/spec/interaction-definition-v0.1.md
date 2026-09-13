# 交互定义抽象实施契约 V0.1

| 属性 | 值 |
|---|---|
| 日期 | 2026-09-13 |
| 上位方案 | [交互抽象 V0.2](../2026-09-13_方案-交互抽象与按需交互包-v0.2-report.md) |
| ADR | [ADR-0093](../adr/ADR-0093-interaction-definition-abstraction.md) |
| 实施基线 | fix/step-cue-normalization，6d79ed3 |
| 授权 | 用户要求开始按方案实施；首批迁移已有动作；v10 先交互，记忆后续升版 |
| 状态 | I0-B 冻结实施契约；2026-09-13 用户明确接受 ADR-0093 |

## 1. 首批范围与不变量

基础包为 `@harness-world/interactions-basic`，执行宿主为 `@harness-world/interaction-runtime`。
首批精确定义为 `base:take@1`、`base:drop@1`、`base:give@1`、`base:hold-hand@1`、`base:end-contact@1`。
拥抱、待签收交付、请求/同意协议不在首批。五项是本次迁移目录，不是未来基础包的闭合枚举。

1. 模型仅提出 speak@1、move@1、interact@2；一次组最多两步且至多一次世界操作。
2. actor 来自完整 WorldAddress 下 Host 证明的行动上下文；任何参数不得覆盖 actor 或 resolutionAuthority。
3. 所有参与者按当前候选前缀验证；选项可见不是执行许可。
4. 包定义产生候选事件，提交只由宿主执行。失败不提交部分效果。
5. 旧 Manifest v1～v9 不调用新定义，新定义不重解释旧事件、Authority 或归一化规则。
6. World Event Log 是事实权威；Memory 消费授权 Observation，不认识具体动作名。
7. 受信任 TypeScript 扩展不是不可信代码沙箱；数据 Pack 不携带可执行函数或任意 patch。

## 2. 身份、严格结构与角色

定义描述全部可 Canonical JSON 序列化，定义函数独立注册。注册键为 id 与正整数 version，不能按 label、前缀或最近版本解析。
`definitionHash` 使用 `interaction-definition/v1` Hash Envelope，覆盖完整数据描述；`implementationHash` 锁定受信任实现发布契约，不能用函数 toString 代替发布锁。
包锁覆盖定义、具名规则、效果、事件 Schema、Reducer、观察/表现/生命周期实现锁及精确依赖。

| 结构 | 必需内容 |
|---|---|
| Definition | versionTag、id、version、participantRoles、argumentSchema、bindingConfigSchema、preconditions、effectBuilderRef、effectCapabilityRefs、authorityPolicyRef、observationPolicyRef、performancePolicyRef、reactionEvidencePolicyRef、spatialRequirementRefs、lifecycleRefs、dependencyRefs、limits |
| DefinitionLock | id、version、definitionHash、implementationHash |
| Binding | bindingId、targetRef、definitionRef、config；所有字段必需，空 config 为 {} |
| TargetRef | kind（entity/character/relation）、id；运行时关系引用需验证耐久来源 |
| Request parameters | targetRef、bindingId、definitionRef（id/version）、arguments；禁止额外字段 |
| Role slot | name、kind、source、distinctFrom；首批每槽恰好一个对象，不开放任意数量数组 |
| source | hostActor、primaryTarget、argument（严格字段名）、derived（精确 resolver 引用）；不接受自由表达式或 propertyPath |

所有 record 闭合；未识别字段、缺字段、重复身份、非法 Unicode、非安全整数一律拒绝。
argumentSchema 首版只支持闭合 object 的 boolean、安全 integer（显式上下限）、string（显式 UTF-8 上限/可选 enum）字段；所有字段 required。
不支持 $ref、远程 Schema、递归、额外属性、隐式默认值和任意 JSON 参数。模型 Schema 与 Host 验证从同一结构派生。

| 动作 | 角色 | 来源与额外约束 |
|---|---|---|
| take/drop | actor、item | Host / 主目标；目标为 entity |
| give | actor、item、recipient | recipient 来自 arguments.recipientId，必须与 actor 不同 |
| hold-hand | actor、target | 主目标为 character，不能自指 |
| end-contact | actor、contact、initiator、target | contact 为主目标；双方从关系来源派生；actor 必须是其中一方 |

`resolvedRoleBindingsHash` 覆盖完整有序映射和来源引用，进入裁定 trace 与 Authority。
对外映射只保留观察者有权知道的角色；不得因为内部需 sender 或隐藏实体就泄漏身份。
参数组合先整体校验再授权，禁止把各字段独立 enum 视为任意组合。

## 3. 规则与基础效果

规则函数输入只读快照、已解析角色、定义 config、Host authority；输出 accepted/rejected 与结构化 reason/trace。
按定义 preconditions 顺序执行，首个拒绝结束；规则 ID、版本、参数、角色映射、候选前缀 Hash 都进入 trace。
未知规则、缺能力、错误实现锁属于激活完整性错误，不伪装为普通动作失败。

物品效果 `entity-transfer@1` 明确输入实体、预期前持有/地点、后持有/地点，后两项恰好一个非 null。
通用关系效果 `contact-start@1` / `contact-end@1` 声明关系类型、参与者、来源 Action 和定义锁；先校验前缀再生成事件。
关系 ID 从 WorldAddress、actionId、定义锁、实例 ordinal 派生，不能使用墙钟/随机或可猜测 ID 作为授权。
以上是基础包的可复用效果实现，不是所有扩展必须加入的全局操作枚举。
新领域注册自己的类型化事件、Reducer 与不变量。输出事件需逐项匹配声明的状态域、事件版本与角色影响范围。
不开放 raw JSON patch、任意事件模板、任意属性写入或角色位置转移；位移仍归 move。

## 4. 来源权限、空间和持续关系

首批保持已有权限：take/drop/give 可由有相应行动能力的玩家/NPC 发起；hold-hand 只允许 Host 证明的 manual_player_immediate；end-contact 允许关系任一参与者自发解除。
同意、喜欢、顺从、无法反抗都不是 contact Event 的含义。NPC 沉默不生成这些事实。

首批空间能力明确命名为 `space:co-location@1` 和 `space:scene-intersection@1`，只断言现有 Location/Scene 事实。
旧拿取/接触玩法使用这些条件，不将它们命名为 reach/contact-support。新定义若要求可达、墙体支撑或坐椅，缺对应空间实现时激活失败。
本期不增坐标、米级距离或物理模拟。关系迁移不隐式搬动任何角色。

生命周期按以下阶段组成 DAG：主动作候选 → 位置/Scene 规范化 → 持续关系收尾 → 观察与表现 → 完整候选验证。
同阶段处理器按精确 ID 和实例 ID 排序；拓扑排序只对可并行节点用 ID 破同序。反向依赖、环或重复注册在激活时拒绝。
关系任一方移动出约定范围、离场或失效，产生单个结束事件；不得由 Kernel 识别 hand_hold。
每个处理器/实例/来源事件在单次 fold 至多执行一次。触及上限整组失败，不能截断尾部后提交。
启动关系定义必须依赖其结束定义与收尾实现；模板未选择结束入口时依赖闭包补齐，缺实现拒绝激活。

## 5. 表现、可见状态和反应

首批表现种类仍为现有八个 cue；新策略身份为 `interaction-performance/v1`，不改旧表。
independent 仅可自我瞬时表现；onSuccess 必须绑定成功步骤。声音属于 speak，步态属于 move。
未来参数化表现通过注册定义与角色/状态来源校验，不增加自由描述兜底。
持续外观/姿态复用现有 visible-state 事件与投影，必须来自正式事件；模型表现不能 set/clear 任意状态。

新反应证据结构固定为：sourceEventRef、observationId、observerCharacterId、actionId、definitionRef 或专用入口身份、roleClass。
roleClass 为 self/direct/addressee/witness；必须有该观察者的耐久 Observation 来源，不凭角色槽直接生成私有刺激。
仅观察到失败尝试的旁观者不能被标记为效果 direct。失败是否可观察由动作观察策略决定。
新 `responsive/v2` 按 direct、addressee、witness 排序，再按角色 ID、来源事件序、jobId 排序；self 不自动派生自我追加调用。
预算仍为最多 3 waves / 8 calls / 每角色 2 calls；不足时稳定跳过；不强制回复或重试 abstain。
旧 responsive/v1 的候选顺序、预算 Hash 和恢复路径全部保留。

## 6. 首版资源上限

| 资源 | 上限与失败处理 |
|---|---|
| 每世界启用包 / 定义 / 绑定 | 32 / 128 / 4096；超限拒绝编译 |
| 每定义角色槽 / 参数字段 / config 字段 | 8 / 8 / 8 |
| 每定义前置规则 / 依赖引用 / 生命周期处理器 | 16 / 64 / 16 |
| 字符串参数 UTF-8 / 单 config Canonical JSON | 1024 B / 4096 B |
| 每动作主效果事件 / 含生命周期效果事件 | 16 / 64；不含宿主审计及观察派生事件 |
| 单 fold 处理器调用次数 | 256；超限整组失败 |
| 单角色公开选项 / 每绑定参数组合 | 128 / 64；稳定排序并保留本人解除入口 |
| 必须保留的退出选项超过视图预算 | 明确失败，不静默删除；限制激活内容或当前实例数量 |

界限进入 limits profile `interaction-limits/v1` 与 Manifest 锁。它们不能随配置文件在运行中变化。
候选枚举必须有界扫描；若仅靠输出截断仍需遍历无界组合，不算满足上限。
Host 不给同步受信任函数提供抢占沙箱；规则执行预算计结构化调用数，不能宣称防止恶意无限循环。

## 7. 版本分配与守卫

| 契约 | 新路径分配 | 历史路径 |
|---|---|---|
| Manifest | v10，交互包选择与定义锁 | v1～v9 原字节 |
| 世界级记忆策略 | 后续另行版本化，本次不分配编号 | 保持现有 Memory 行为 |
| 作者 / 编译 Pack | worldpack-source/v5 / worldpack/v5 | v1～v4 解析与 Hash 不变 |
| 编译交互目录 | interaction-catalog/v3 | 原 v1/v2 不转换 |
| 交互 Action / 模型 | interact@2 / submit_actions/v6 | interact@1 / submit_actions/v1～v5 |
| 行动组 | bounded-action-group/v2，允许新交互版本及定义锁 | v1 原行为 |
| Authority | Round Authority schemaVersion 6，显式角色/定义/依据绑定 | v1～v5 原解析 |
| 玩家提交 / 意图准备 | player-submission/v3；准备记录显式绑定新参数结构和视图 Hash | 已有 player-submission/v2 原恢复 |
| 反应 | 新 profile responsive/v2，证据版本 reaction-evidence/v1 | responsive/v1 不变 |
| 表现 | interaction-performance/v1 | 旧八 cue 与旧归一化不变 |
| World / Context SQLite | 本期先保持 18 / 7；新增列/表需单独迁移决定 | 黄金哨兵不改 |

Host 必须在 Manifest 注册闭包可解析后才获取 Writer；新世界不能用旧 Resolver 兜底。
版本号登记不是声称解析器已支持。各生产入口按 I1～I4 接通，未完成闭包不向普通激活入口公开新世界。

| 守卫模块 | 必查面 |
|---|---|
| kernel/world-spec、world-bootstrap、interactions、rulebook-registry | 编译/存储 Manifest、新功能 predicate、引导、精确 Resolver |
| world-pack/contracts、compiler、source、tooling、creator-cli | 作者版本、规范化、编译 Hash、源绑定、激活适配、CLI |
| contracts/action-group、player-submission、reaction-cycle、protocol、resolution-authority | 新结构与版本、完整 Hash 输入、旧分支 |
| agents/submit-actions、provider-call、replay、player-intent-call | 模型 Schema/Host 同源、记录与恢复、拒绝整体提案 |
| application/context-pipeline、round-coordinator、reaction-scheduler、world-application、player-intent-* | Root/S1/final/Reaction/玩家四入口与来源绑定 |
| store-sqlite/world-store、reaction-cycle、logical-transfer、snapshot-store、player-input* | 原子提交、注册预检、持久化与导入/恢复；不能只改主解析器 |
| operations 的挂载/恢复入口 | 错误版本与缺包在写入前拒绝 |

机械扫描记录随 I0 冻结文件提供；语义检查以上表为准，不把正则命中数当成完成证据。

## 8. 黄金与阶段门禁

保留 tests/interaction-baseline.integration.test.ts 的原 expected，以及原 I0 黄金记录和 V0.1 方案字节。
新增 tests/interaction-runtime-baseline.integration.test.ts 捕获未改生产代码的 6d79ed3 行为：v7～v9 完整 Event、Root Authority、反应周期/预算/刺激账本、真实 Provider 工具契约、旧归一化和 visible-state 事件。
只固定 Date.now 与 UUID 输入，不删除或重写被比较的输出字段。先生成、独立复跑，再冻结；后续不得 --update 回填。
历史 v6 表现路径的来源/投影与恢复另由 kernel/manifestation.test.ts、store-sqlite/visible-state.test.ts 及既有集成测试补足；代表性黄金不等于历史组合穷举。

I0 Gate：旧黄金与补充黄金通过；首批范围/版本/角色/效果/表现/反应/空间/预算明确；ADR-0093 获明确接受确认；全量 check 完成并记录结果。各项已完成，2026-09-13 用户明确接受 ADR-0093，I0 Gate 关闭。
I1 Gate：注册/闭包/角色/规则接口与物品闭环；缺依赖、Hash 漂移、未启用、跨角色参数组合拒绝。
I2 Gate：只改内容可加物品；无字段组合越权；表现不能虚构持有、接触或支撑；持续可见状态单一来源；角色/Scene/Branch/as-of 隔离、预算与退出选项保留。**进度（2026-09-13）：** 作者声明与目录编译已落地，见 [I2-a 实施记录](../2026-09-13_交互抽象-I2a作者声明与目录编译.md)；每角色选项视图与参数域已落地，见 [I2-b 实施记录](../2026-09-13_交互抽象-I2b每角色选项视图与参数域.md)。"只改内容可加物品"已在编译层成立，"无字段组合越权"由 `bindingConfigSchema`、目标 kind 校验与联合枚举 + 计划过滤共同覆盖，"角色/as-of 隔离"与"预算及整项裁剪"已由 `view()` 覆盖。**仍未接入：** 模型/Host 同源 Schema、表现与持续可见状态契约，以及 §6.2 的退出选项优先保留与容量失败（首批定义里没有恢复类入口，该声明应与 I3 的 `end-contact` 一起定义）。**I2 Gate 未关闭**。本轮实际分配 `worldpack-source/v5`、`worldpack/v5`、`worldpack-entities/v2`、`worldpack-characters/v3`、`worldpack-interactions/v1`、`interaction-catalog/v3`；第 7 章其余版本号与 Manifest v10 本轮未分配。
I2～I5 仍按上位方案执行，不因 I0/I1 合格提前声明 UI、恢复或真实模型验收完成。

## 9. 迁移、恢复与诊断

首版只新世界启用。旧源转换输出新副本；不原地重写旧世界或 Manifest。
新依赖必须随 Manifest/备份登记；未提供精确实现时 fail-closed。停止新动作不等于可删历史解释器。
fork 继承历史身份，新实例使用子 Branch 地址；退出和收尾不依赖进程内句柄缓存。
复用 JSON 容器也必须严格解析逻辑版本。若确需迁移数据库，另设迁移矩阵和子进程硬终止测试。
作者诊断只读串联选项、角色映射、rule trace、Event、Observation、reaction job、Context receipt；未知历史字段显示未记录，不能推测补齐。

## 10. Evidence → Finding → Path

E1：039b590 仅冻结编译与常量。F1：运行期变更缺少字节对照。P1：新增确定性运行黄金，保持原测试不动。
E2：用户确认只迁移已有动作。F2：无需引入签收状态机即可验证抽象。P2：I1 物品、I3 关系；独立 fixture 验证扩展状态域。
E3：用户确认 v10 先交互。F3：世界级记忆策略不再占本次 v10。P3：新协议/Authority/Pack 一起登记，Memory 后续单独提案。
E4：旧 hold_hand 权限来自 ADR-0087。F4：抽离实现不代表放开 NPC 发起权。P4：由基础定义声明策略，Host 派生权限上下文，Rulebook 验证。
