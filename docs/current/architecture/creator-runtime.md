# 当前创作者运行时

> [跨场景短信实验样例](../studies/cross-scene-communication-20261010.md)允许声明媒介名称和有向联系人；[电话实验](../studies/cross-scene-phone-20261010.md)进一步支持自主接听与持续连接，但仅独立实验入口加载。默认网页、活动脚本与 Launcher 尚未安装此能力；改名为托梦不会自动实现睡眠条件或匿名来源。

> [活动与通信组合实验](../studies/cross-scene-activity-20261010.md)已用活动现有 `interactions` 白名单裁定通信：允许时可以收发与接听，禁止时直接提交也不能绕过；默认宿主尚未安装这套组合规则。

World Pack 用于定义人物、地点、物品、认知、场景、叙事与 Interaction。当前网页接受 `worldpack-source/v5` 源目录，以宿主已安装能力编译；旧格式不会自动回退到旧运行时。可参考 `ai-girls-awaken-v10`、`prototype-g1` 和 `hand-in-hand`。

Interaction 定义和绑定提供玩法可选行为，规则负责重要状态的资格与结果。角色与地点定义不等于运行中当前位置；运行时通过提交事件和当前 view 获得状态。创作者仅在当前玩法明确追踪的机制中增加状态约束，不必结构化所有叙事细节。

## 包内活动

例如作者可以固定与同行者猜数字，也可以让玩家选择邀请留守者约会；被邀请者自己通过操作接受或拒绝。当前活动桥位于实验宿主。可信本地脚本声明 title、operations，以及固定 npcIds 或动态 participants（player-select、人数与可选候选白名单）；initialize 收到本次实际选定的 npcIds，policy 决定各主体表达／操作许可，resolve 同步裁定，schedule / onOutcome 返回 wait 或请求该场参与者处理。可选 simulate(request) 为该角色提供局部固定演出决策，null 表示调用真实模型；仅替换响应来源，不改变授权上下文、预设输出处理、格式校验、Rulebook、事务提交或观察分发。

每场最多 8 个 NPC，玩家身份由宿主绑定，开始时参与者须存在且属于玩家当前授权场景；动态名单开始后固定，暂停与恢复保留同一名单。状态 public 只在参与者间共享，private 仅给对应角色，internal 不进入角色视图；脚本不能直接写世界或调用模型。活动结果按参与者或 self 投递，非参与者不获得活动视图、许可限制或活动调度资格，仍按普通交流和行动的观察权限知情。结果范围 self 只限制结果收件人，不能补救把秘密写进 public 的错误。接口例子和旁观者边界见[活动指南](../guides/activity-and-variables.md)。

每次活动输入最多串行 4 次角色激活、每次最多 2 次决策机会，主动 recall 可追加一次补问；最多 12 次模型调用，活动链 90 秒。预算耗尽或失败保留已提交状态，允许显式重试或逃生，不精确恢复未提交机会。

`ai-girls-hosted-guess` 展示主持角色私有答案与多 NPC 有界链；默认能力限制不替角色决定情绪、策略和台词；作者显式声明的固定演出可通过 simulate 提供同格式决策。完整活动结果附带身份／阶段元数据以形成授权经历，但 Core 整理仍须显式开启，默认网页仍原生记忆。

## 创作入口与限制

先看[字段手册](../guides/world-pack-authoring.md)、[试玩步骤](../guides/creator-playtest.md)和[自定义网页](../guides/web-ui.md)。`frontend/` 使用显式 manifest 和 iframe 公共玩家接口，只改展示，不改变世界包编译身份；未提供时使用官方默认模板。新实验使用独立数据目录。

实现：[活动桥](../../../tests/experiments/pack-activity.ts)、[活动选择](../../../tests/experiments/pack-activities.ts)、[World Pack 工具](../../../packages/world-pack)、[主持示例](../../../examples/world-packs/ai-girls-hosted-guess)。当前不承诺任意玩法零宿主改动、多活动并行或不可信脚本沙箱。短冒烟不等于长试玩验收。

### 多个独立玩法，一次运行一个（2026-10-10）

例如玩家暂停猜数字、讨论周末计划、再回来继续猜：assetFiles 可登记 scripts/activities/guess.js 与 scripts/activities/weekend.js，每场各有状态、参与者和操作。它替代原先整个包只能使用一套活动的约束，没有新增并行调度。原 scripts/activity.js 作为 default 活动继续使用。

PackActivities 选择唯一正在运行的 PackActivity，只向该活动交付角色请求、许可和调度；没有 active 时使用普通规则。活动事件以 activityKey 区分，暂停保留进度并关闭 active，旧操作因身份／revision 或非 active 被拒绝。开始／继续在写入租约内检查没有另一 active；状态、玩家管理观察和世界 tick 同事务提交。继续使用当前授权 world 检查作者 resume 条件；没有 hook 时要求同场。暂停／恢复不改真实世界位置或物品，不续跑未提交计算。放弃暂停进度和前台逃生保留已提交经历，其他暂停活动不变。

完整节点通过原世界数据库保存全部活动进度。作者 hook、公开 SDK 字段及操作步骤见[活动指南](../guides/activity-and-variables.md#多活动选择与暂停2026-10-10当前源码)，样例见[多活动包](../../../examples/world-packs/multiple-activities/README.md)。测试覆盖切换、隔离、条件拒绝、事务失败及分叉；真实模型体验与既有便携包包含情况另行报告。


### 2026-10-07：活动格式失败的有界修正

活动角色调用按 Core 的严格决策 schema 校验，本机发送端继续复用既有扁平 schema 适配。格式非法时只自动修正一次；能够唯一识别模型已选决策及交互选项时，修正请求使用该分支和选项，避免网关展开联合字段。固定数字在修正 wire schema 中用相等的 minimum/maximum 表达，以规避本机 numeric const 调用中多次得到字符串输出的现象（未分析网关内部实现）；Core 仍使用原始 schema 校验，不转换模型字段、不删除混合表达。

格式修正不增加受控动作预算。返回后继续现有世界高水位、活动版本、权限及事务校验。两次均非法保留原轮次，格式失败与服务失败分别显示；重试和逃生仍可用。此实现仅覆盖活动调用，不表示通用 G2 格式修正全部完成。

## 官方同居试玩包的最小补齐

例如玩家点击序章的“继续”，当前节点是“……什么情况？这里不是我家吗？”，这句话会成为正式玩家公开表达，而不是只写进前端对白框。`resolve` 可返回 `playerExpression: { text }`，宿主只允许玩家活动操作使用，按当前表达许可及原有 speak Rulebook 校验，将表达、授权观察和活动进度放在同一事务中。脚本来源保存在活动事件的 `scriptedPlayerExpression.source`，不投递给角色观察或公共 SDK。默认没有该字段的活动行为不变。

NPC 固定台词发表时，可选 `onPublished(state, actorId, expression)` 返回新的 game，或 null。宿主仅在活动中的参与角色发表合法 speak 时调用，将发表与进度更新原子提交；提交失败不会跳过该句。该 hook 是同步裁定，不直接发言、调用模型或启动独立引擎。

`initialize` 另收到玩家授权的 `world` 和 `previous`（玩家自己的上次活动视图或 null）；`resolve` 第五参数是当前行动主体授权的 `world`。它包含 locationId、当前可观察角色 characterIds、items.current / lastObserved，使用同一事件前缀与已有可见物品投影，不提供全世界库存。条件不满足可返回唯一字段 `rejectReason`（非空、最多 2000 字符），不提交活动变更。

[官方包](../../../examples/world-packs/model-girls-official/README.md) 使用这些入口完成 112 条序章表达，其中 5 条为玩家中性问题。最后请求收留后活动结束，后续输入走真实模型。生活活动只提交开场种子；米饭制作另由已有交互扩展机制裁定。自动实验核对完整表达与零角色 provider 调用；后续本机 Gemini 已完成拒绝、正式料理、私密交流、蛋糕目击和归档后回访的短场景验收，见 [真实记录](../../../examples/world-packs/model-girls-official/LIVE-VALIDATION.md)。默认反应时间截止及未覆盖组合仍明确保留。

### 完整序章的脚本输入限额（2026-10-09）

从 Launcher 开启 Core 记忆运行官方序章时，第 100 句的正常角色授权请求为 66,124 个 JSON 字符，超过原来的 65,536 输入上限，导致固定输出不能发表。现在仅 simulate 的完整角色上下文输入允许最多 1 MiB JSON 字符；其他脚本调用和所有返回值仍限制 65,536 字符，脚本执行仍限制 100 ms。超过上限继续失败，不截断认知、不扩大读取权限，不推进未发表的游标。模拟输出仍经过正常表达校验与提交。

### 固定序章的活动状态读取（2026-10-10）

例如同一句固定对白在准备、格式校验和提交后刷新中多次读取活动状态，宿主现在先核对当前世界提交序号，只读取 `activity.updated` 事件，并复用同一前缀下已验证的状态。每次返回独立副本；新事件提交后重新读取，失败提交不会提前更新活动游标。复用范围限于当前 PackActivity 实例，不缓存角色授权上下文或模型决策，不在候选世界之间共享状态。

这是源码接通的性能优化；现有 test3 便携包尚未更新。普通角色视图与已安装记忆档案仍走原有读取／来源校验路径，未引入持久化缓存或新增数据库。

完整 112 条序章及同节点重复测量见[性能实测](../studies/prologue-performance-20261010.md)，包含自动验证范围与未完成的真实模型试玩。
