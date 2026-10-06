# G4 架构减法：入口、依赖与删除顺序

日期：2026-09-23。基线为 `4741c66`，工作树 `harness-cordis-world-g4`。这是针对**当前本机 v10 / `worldpack-source/v5` 网页原型**的源码盘点，不宣称 G3 已通过，也不承诺继续运行旧世界包或旧宿主。`D:/worlds` 的历史存档仅作只读证据。

## G4 收口（2026-09-25）

G4 以当前 v10 / worldpack-source/v5 网页原型为边界收口：旧网页、独立宿主、历史 WorldSpec 编译器、v2–v9 Manifest 运行分流及其专属夹具已退出；现行 Event Log、权限隔离、交互裁定、单角色激活和创作者交互包保留。第 1–3 项删除清单已完成，第 4 项按对外接口价值保留，第 5 项仅留下仍有诊断价值的测试。没有证据要求为了完成 G4 继续删除整包或重做存储/调度。2026-09-25 当前提交 `39293c6` 的轻量检查（类型检查、Lint、66 项现行测试）通过；这不是 G3 体验验收。

暂缓项只在出现明确调用链收益或体验问题时重新评估，不构成 G4 未完成工作。G2-1 格式修正、G2-2 有界非法输出诊断和 G3 的自由叙述与受控事实分叉独立跟进。后续 20 轮真实试玩还发现离开卧室后部分角色长期失联、认知未更新及中文召回零产出；这些属于玩法/记忆路径调查，不以继续架构减法代替。详见 [20 轮试玩报告](../prototype-g1-g4/2026-09-25_试玩报告-ai-girls-awaken-v10-20轮真实模型.md)。

## 当前实际调用链

```text
experience:web → playtest-web-entry
  → v5 Pack: FrozenWorldPlaytestRuntime → WorldApplication
      → 玩家自然语言解释 / RoundCoordinator / Rulebook / WorldStore
      → PrototypeCharacterTurn + runPrototypeActivations
          → 角色可见场景 / 交互裁定 / 原子事件提交 / 结果观察
```

网页入口现在只接受 v5 源目录；`tests/experiments/playtest-frozen-runtime.ts` 装配 `WorldApplication`，先提交玩家 Root 再激活 NPC。`packages/application/src/prototype-character-turn.ts` 直接使用 `WorldStore`、`WriterLeaseService`、Rulebook 和 `SceneDecisionService` 提交并分发结果。它不是独立的新存储引擎。

最初盘点有 15 个 `packages` 目录；删除 `simulation` 与 `operations` 后剩 13 个包。仅非测试 TypeScript，`store-sqlite` 约 8 千行、`application` 约 6.4 千行、`world-pack` 约 4.7 千行。行数提示审查成本，不是删除依据。多个包通过 `index.ts` 汇总导出；“被 import”不等于每个导出都在试玩中执行。

| 层 | 当前 v5 作用 | G4 判断 |
| --- | --- | --- |
| `provider-chat`、玩家输入解释/绑定 | 连接真实模型，将玩家原文映射到可裁定动作；错序拒绝与未提交反馈已有实测 | 保留当前路径 |
| `world-pack` v5、`interactions-basic`、`interaction-runtime`、`kernel` | 编译作者声明的交互，提供 Rulebook 裁定 | 保留 v5 和当前交互；旧版本另审 |
| `application` 的 `WorldApplication`、`RoundCoordinator`、`PrototypeCharacterTurn`、场景决策 | Root 提交、角色执行与结果续写、观察权限 | 保留事实边界；缩小旧调度入口 |
| `store-sqlite`、`contracts`、`runtime-cordis` | Event Log、Head、租约、原子提交、角色视图和生命周期 | 不以“基础设施”一词整包删除；先追踪具体调用 |
| `agents`、`memory`、`presentation` | 仍由 `WorldApplication` 的分支装配或上下文路径引用 | 尚不能判定整包无用；先测实际生成的上下文和副作用 |
| `testkit` | 测试工具 | 仍由测试引用；独立 `operations` 宿主和备份包已退出 |

`WorldApplication` 并未因 `externalCharacterActivations: true` 变成薄壳：它仍装配 `RoundCoordinator`、存储与上下文。第一刀前，当前网页还调用 `processNextReactionWave` 并读取 `listReactionCycles`；固定外部激活后不会装配旧 Reaction Worker，第一刀已移除这两个网页调用。其他宿主仍可能使用旧账本，所以不能据此删除 Reaction Store 表或 `RoundCoordinator`。同样，`world-pack/src/tooling.ts:73-121` 的版本分派与 `compiler.ts` 的共享 v2–v5 编译过程交织，不能只删几个 `V2/V3/V4` 类就认为 v5 独立。

## 可删候选与先后关系

| 顺序 | 候选 | 已见证据与必要前置 | 决定 |
| --- | --- | --- | --- |
| 1 | `FrozenWorldPlaytestRuntime` 内的旧批量对照分支：`singleCharacterActivations: false`、`performNpcId`、`#pendingPerform`/`#continuePerformedItem` 等 | 删除前默认值为单角色；旧分支仅在历史对照测试显式打开。固定外部激活后不装配旧 Reaction Worker，现行激活测试能证明无悬挂 Cycle。 | **已删除**；对应旧断言与无效的网页排空/调试调用一并移除 |
| 2 | 网页入口的旧 Pack 回退、`WorldPlaytestRuntime`、专属测试与 v8 Provider 手工脚本 | README 已说明旧运行时不作为当前支持入口；v5 代码原先只借用了角色列表、玩家转录、默认数据目录三个工具。 | **已删除**；三个小工具迁至 `playtest-view.ts`，网页对旧 Pack 明确拒绝 |
| 2a | `grouped-playtest`、compact/lean Context 渲染、旧输入解释和旧模型对照命令 | 第二刀后只剩相互引用的实验脚本与专属测试；当前 v5 网页运行时不调用它们。`v10-provider-gate` 和 `context-cost` 有独立用途。 | **已删除**；清理三个旧 `experience:*` 命令，保留历史报告并标明旧入口退出 |
| 3 | `simulation` 的 mystery/rainy-road/tavern 演示、`WorldSimulation` 及旧命令 | 当前 v5 网页与 G1 路径不引用该包；最后仅历史 P0 门禁和包内测试调用 `WorldSimulation`。Store 专项测试已覆盖提交重试、分支重建与 Session 去重。 | **已删除整个 `simulation` 包**；场景可见性测试搬至当前原型套件。rainy-road/tavern 的 Pack 源目录仍被 `worldpack` 创作工具引用，保留待该工具的版本路径审查 |
| 4 | `operations` 的 headless RPC、BranchWorkScheduler、deployment backup/restore 与 `worldctl`/`worldappctl`/`worldhost`/`worlddeploy` 脚本 | `packages/operations/process/*` 是独立宿主；当前网页只使用 `playtest-server.ts`，不调用这些入口。`worldpack` CLI 属于另一个包。用户确认本机原型只保留网页和作者 Pack CLI。 | **已删除整个独立宿主包及其专属命令、测试和迁移演练脚本**；Event Log、Store 与当前网页路径保留 |
| 5 | `world-pack` v1–v4 编译/读取、旧 Manifest 与 `submit_actions` 版本路径 | 用户确认不再支持旧版本。v5 Pack 映射到 v10；公开 `tooling.ts` 与 `compiler.ts` 的来源编译路径已收为 v5-only；`schema.ts` 的 v5 编译封套解析仍借用 v4/v3/v2 解析链。 | **公开入口已切除旧版分派**；下一段按 v5 调用图拆共享函数，不把旧解析链误认为仍需支持旧输入 |
| 5a | `worldpack init` 的 v1–v4 模板 | 四种 profile 均生成当前网页不接受的源版本；当前 v5 示例与编译、校验命令不依赖脚手架。 | **已删除旧初始化入口**；现有 v5 示例作为新世界起点，历史手册标明适用范围 |
| 暂缓 | Context Receipt、Provider Call/Quality、Reflection、逻辑导出/快照、Quarantine、耐久 Reaction 账本及旧协议字段 | `WorldApplication`、上下文装配和 Store 仍静态或实际触达其中一些；仅凭名称判断不了是否保护当前状态与可见性。 | **不列入第一轮删除**；逐个证明不用、或先把当前路径改为更小的现有机制，再删旧实现 |

前十一刀是局部切除：未新建 Host 框架，未改权威事件模型，也未把叙事与状态分叉当成已解决。当前试玩类只保留单角色 NPC 协议；删除收益是减少维护和调试时的分叉，不是声称模型更自然。

第一刀验证（2026-09-23）：类型检查、Lint、40 个原型冒烟测试通过；`playtest-frozen-runtime`、网页服务、G1 组合和执行续写共 35 个相关测试通过。独立新存档的 4 句 DeepSeek 连续试玩均提交成功，首轮同行者自主拿取黄铜钥匙，seq38 为 `entity.transferred`、seq39 为接受的 `action.resolved`，随后收到结果并自由续写；至第 4 句没有第二次钥匙转移。该样本验证当前路径仍可交互，不能据此推断 G3 叙事一致性通过。新工作树安装依赖时复用了原型工作树的本地 `node_modules`；没有修改依赖或锁文件。

第二刀验证（2026-09-23）：移走网页旧运行时及其专属测试、v8 手工门禁脚本，共删约 1,700 行；三个仍被 v5 使用的视图工具迁到 `playtest-view.ts`。类型检查、Lint、40 个现行原型测试和 47 个相关测试通过。旧编译 Pack 启动明确失败，v5 源目录的网页入口可以启动；样例 v5 Pack 校验通过。独立新存档的 1 句 DeepSeek 试玩正常提交，同行者拿起黄铜钥匙并在随后表达中说明自己持有；本轮结束原因为 `character_limit`，这不是 G3 体验验收。旧 Pack 不再能从网页续玩，历史 `D:/worlds` 数据未修改；`grouped-playtest`、`lean-context` 等独立实验工具仍保留，需在下一刀按实际调用者审查。

第三刀验证（2026-09-23）：删除仅服务旧协议的 13 个实验脚本/测试和 3 个旧 `experience:*` 命令。类型检查、Lint、40 个现行原型测试与 28 个网页/G1 相关测试通过；v5 网页入口可启动。独立新存档的 4 句 DeepSeek 试玩均正常提交，第四句 NPC 提出拿取黄铜钥匙，规则提交后收到结果并明确说钥匙在自己手里，周期安静结束。此样本只证明当前路径仍可用，不能证明 G3 的自由叙述风险已经消失。历史实验记录保留作为证据，旧命令不再运行。

第四刀验证（2026-09-23）：移除悬疑 Demo 的命令入口、场景、专属调查规则与测试，`simulation` 不再依赖 Memory；保留的 `SceneDecisionService` 测试改用独立小夹具，原 5 项可见性与失败路径断言通过。现行 `check` 为 40/40，相关 `simulation`、进程入口、P0 与 G1 测试为 16/16。扩大测试发现旧 `rainy-road` 六轮断言有 1 项失败：期待 Alice 抵达站台，实际仍在路边；相同失败已在未做 G4 删除的原型基线 `4741c66` 复现，因此不为这次删除修改运行时或旧断言。独立新存档的 4 句 DeepSeek 试玩均提交成功，首轮 seq38 是钥匙交给同行者的唯一 `entity.transferred`。第四轮同行者又在自由叙述中说“钥匙给你”，但没有相应转移事件，G3 叙事与受控事实分叉仍然存在。历史 `D:/worlds` 存档未修改。

第五刀验证（2026-09-23）：移除旧 rainy-road/tavern 社交适配器、专属测试与两个 Phase 8 测量脚本，约净减 2,000 行；保留 `worldpack` 创作工具仍引用的源目录。`simulation` 不再依赖 Operations 或 World Pack。现行 `check` 为 40/40，剩余 `WorldSimulation`、场景可见性、P0 和 G1 相关测试为 10/10，v5 Pack 校验通过。独立新存档的 4 句 DeepSeek 试玩均提交成功，第四轮 seq100 为钥匙交给同行者的权威 `entity.transferred`，角色随后反馈持有钥匙；但上一轮自由叙述已提前说“钥匙我拿着”，再次呈现 G3 已知分叉。旧 `rainy-road` 六轮测试在第四刀已证明于原型基线同样失败，本刀随旧适配器退出，不把它记作现行行为验收。

第六刀验证（2026-09-24）：删除只供历史 P0 组合测试使用的 `WorldSimulation`、Provider 夹具与整个 `simulation` 包；旧 P0 门禁不再作为当前原型命令。场景可见性和私有观察测试搬至 `tests/prototype/scene-decision.test.ts`，加入现行检查。类型检查、Lint 和现行测试 45/45 通过；Store、Cordis、网页运行时、场景决策与 G1 的相关测试 62/62 通过，离线锁文件校验通过。独立新存档的 4 句 DeepSeek 试玩均成功提交，第四轮 seq100 为真实钥匙转移，角色得到结果后反馈；此前自由叙述已提前宣称持有，G3 风险仍存在。此次删除不改 Event Log、Store 或当前 v5 运行时。

第七刀（2026-09-24）：`worldpack init` 仅生成 v1、v3、v4 模板，均无法直接用于当前 v5 网页原型，删除此命令和专属脚手架。保留 v5 Pack 的 validate、compile、inspect、test、activate 命令，历史手册标明旧范围。类型检查、Lint、现行测试 45/45 及 v5 编译/G1 相关测试 45/45 通过。

第八刀（2026-09-24）：经产品范围确认，移除独立 `operations` 包、四个宿主/部署命令及其专属测试，净删约 6,700 行。玩家输入恢复与崩溃测试改为直接验证 `WorldApplication.processAcceptedRounds`，`worldpack` 独立进程测试保留。当前网页仍使用自己的 HTTP 服务与 SQLite 存档；不再提供 `worlddeploy` 的离线打包、校验和恢复能力。类型检查、Lint、现行测试 45/45，通过 Store/Cordis/场景可见性测试 51/51、权威事务硬终止测试 3/3 和接受回合硬终止测试 1/1；离线锁文件校验通过。扩展网页、G1、Pack、玩家输入和并发测试共 71 项，61 项通过，另 10 项旧玩家输入断言失败；同样 10 项已在未做 G4 删除的原型基线 `4741c66` 逐项复现，不记作本次删除回归。此刀未修改角色上下文或执行协议，因此未再进行真实模型试玩；此前 G3 叙事分叉仍是已知风险。

第九刀（2026-09-24）：用户确认不再支持旧版本后，把 World Pack 编译、读取、适配、序列化和检查的公开工具入口收为 v5-only，`worldpack activate` 删除只供 v4 使用的 `--action-groups`、`--interactions`。移除三份旧版公开入口兼容测试；新增旧源版本与旧编译封套在当前入口被拒绝的断言。类型检查、Lint、现行测试 45/45，v5 Pack、交互包、G1 相关测试 55/55 通过。内部 v2–v4 编译/校验函数仍在，尚未完成整条旧版本代码的删除。

第十刀（2026-09-24）：移除已无当前调用者的 World Pack v1–v4 编译器类、旧版编译辅助函数与三份专属测试，约删 1,700 行。v5 仍复用部分 v2–v4 内容校验函数和 `compilePhase8Source` 内的旧条件分支，这些尚未清除。类型检查、Lint、现行测试 45/45，v5 Pack、交互包、G1 相关测试 55/55 通过。

第十一刀（2026-09-24）：把 World Pack 来源编译函数收为 v5 专用，移除 v2–v4 清单、实体、角色分派及旧编译封套和 Hash 生成分支。v5 产物的规范化内容与 Hash 域保持原样；类型检查、Lint、现行测试 45/45，v5 Pack、交互包、G1 相关测试 55/55 通过。剩余主要是 `schema.ts` 的 v5 解析沿用旧解析链，以及更底层 Manifest/Action 协议版本实现。

第十二刀（2026-09-24）：把 v5 源清单和编译封套改为直接解析，删去 v1–v4 清单/封套解析器、旧版本常量与不再引用的旧封套类型，并移除只验证旧 Phase 7/8 封套的测试。v5 仍保留当前文档形状所需的 v1/v2/v3 字段名和校验函数；这些名字不代表继续接受旧 Pack。新增 v5 源清单重复文件、额外字段，以及编译封套身份、内容和注册锁的拒绝断言。v5 Pack Hash 域和规范化产物未改变。类型检查、Lint、现行测试 45/45 通过；v5 Pack、交互包、G1 相关测试 56/56 通过。本刀未改变角色上下文或运行时行为，未进行真实模型试玩。后续可审查底层 Manifest/Action 协议旧版本，但需先区分当前 v10 仍引用的文档形状与真正无调用者的兼容入口。

第十三刀（2026-09-24）：移除 WorldSpecCompiler 的 v1 自动升级和存档 Manifest v1 的运行时自动升级。两者现在明确拒绝 v1，避免旧数据被悄悄解释为新的世界事实；v2 WorldSpec 编译器暂留作当前场景可见性测试夹具，不代表 v2 World Pack 恢复支持。新增现行原型拒绝测试。类型检查、Lint、现行测试 47/47；v5 Pack、交互包、G1、场景可见性与旧版本拒绝测试 38/38 通过。历史 world-spec.test.ts 仍含大量 v1 夹具断言，未作为当前门禁运行；下一刀清理 v2–v9 Manifest 前，应先把当前场景可见性测试改为 v10 夹具，再删除旧读取分支。没有修改角色上下文或执行行为，未进行真实模型试玩。

第十四刀（2026-09-24）：将场景可见性测试夹具迁到现行 prototype-g1 v5 Pack / v10 Manifest，五项观察权限和场景生命周期断言继续通过。随后收口存档读取、WorldBootstrap 和直接 Store 激活入口：新世界与运行时读取只接受 Manifest v10；移除应用层不再有生产调用者的 activateSpec/compileSpec 旧入口，以及存档读取中的 v2–v9 分派。现行原型门禁用 v5 Pack 编译测试替换旧 v8 交互测试；增加 v2/v9 存档拒绝、旧版本 Genesis 不写入的测试。现行检查 67/67，v5 Pack、创作命令、交互集成、G1 与场景测试 64/64 通过。历史旧 Manifest/交互测试不再作为当前门禁，部分断言按旧行为编写，未要求重新变绿。内核里的旧版本类型、旧 WorldSpecCompiler v2 测试夹具和旧 submit_actions 分支仍待分片清理；保留 v5 Pack 当前内容字段上的 v1/v2/v3 标识。此次未改变模型可见上下文或角色执行行为，未进行真实模型试玩。

第十五刀（2026-09-24）：Context Pipeline 固定接收当前 Manifest v10，并直接构造 submit_actions/v7 工具描述；移除 v2–v5 工具 schema、旧 Manifest 工具选择和旧版 affordance 分派，约净减 90 行。v7 的工具字段顺序、动作范围、表现约束和 groupedOutput 值保持原样；Director 工具仍保留。类型检查、Lint、现行测试 67/67，通过交互包集成、G1 和叙事发布相关测试 10/10。当前网页原型使用外部单角色激活，不调用这条旧 Round Context Pipeline；因此此刀以直接使用该管线的 v10 集成测试验收，没有把网页真实模型试玩误记为这条管线的验证。ReactionScheduler、RoundCoordinator 与 SubmitActionsValidator 的旧版分派仍待后续清理。

第十六刀（2026-09-24）：将 RoundCoordinator 与 ReactionScheduler 的角色输出统一交给现行 submit_actions/v7 校验；独立 ReactionScheduler 现在明确拒绝旧 Manifest。删除校验器中 v4–v6 grouped 协议分支、对应旧单元测试，以及仅记录 Manifest v7–v9 运行时的历史集成测试与快照；用针对 v7 的小测试保留动作版本、表现位置、弃权和多重世界操作的约束。没有更改 v7 的动作顺序、反思上限或 Event Log 提交逻辑。v2 校验辅助和 v3/旧 Manifest 的其他分支仍待按调用图继续清理。类型检查、Lint、现行测试 67/67 通过；v7 校验、当前交互集成、G1、叙事发布与旧版本拒绝相关测试 17/17 通过。本刀不改变当前网页使用的外部单角色激活路径，因此未进行真实模型试玩。

第十七刀（2026-09-24）：移除 `SubmitActionsValidator` 的 v2/v3 对外校验方法、只为它们存在的返回类型与两份专属测试；v7 原先借用 v2 解析器检查反思字段，现直接在 v7 内保持原有格式和数量上限。`CharacterContextRequest.groupedOutput` 只接受当前 v7。保留仍有调用者的 v1 通用校验接口和玩家表现解析接口。本刀未改变 v7 模型可见 schema、权威提交或网页单角色激活。类型检查、Lint、现行测试 67/67 通过；v7 校验、交互集成、叙事发布及 G1 组合测试 15/15 通过。前一轮真实模型冒烟使用网页激活路径，不覆盖本刀的 v7 校验器；本刀未另行调用模型。

第十八刀（2026-09-24）：保留 `ReactionScheduler` 公开接口及当前 v10 Reaction 能力，只移除构造时已排除的旧 Manifest 条件分支：固定 v7 响应校验前的 JSON 边界、v10 动作集合与上限、分组排序、冻结交互表现绑定、Resolution Authority 和 Authority v6。旧 Provider 类型仍可在校验前返回 JSON，但旧协议不会通过 v7 校验。类型检查、Lint、现行测试 67/67 通过；v10 交互包、G1、场景观察与旧版本拒绝集成测试 16/16 通过。本刀不改当前网页单角色激活路径，未另做真实模型试玩。

第十九刀（2026-09-24）：`RoundCoordinator` 读取的存档已只接受 Manifest v10，因此收口其旧版本分流：玩家输入的 Authority/Provisional、冻结交互表现绑定、分组排序、反应动作策略和 Authority v6 均走现行路径；仍保留 `director` 的独立输出入口以及公开的提交接口。类型检查、Lint、现行测试 67/67，通过 v10 交互包、G1、场景观察及旧版本拒绝相关集成测试 16/16。另用独立 `.tmp/g4-round-coordinator-smoke-1790256065053` 存档重放同一句“我对同行者说：你好。”：DeepSeek `deepseek-flash` 的 5 次调用均完成，玩家和 4 名 NPC 各有一次 `action.resolved`，Head 从 seq101 到 seq129，4 条 NPC 文本可见，最终 `quiescent`、无错误提示。与上一轮 8 次调用/`call_limit` 的差异属于非确定性样本，不能归因于本次条件分支清理；本次未涉及物品执行或 G3 全面验收。

第二十刀（2026-09-24）：保留可供后续接入的 `ReactionAgentProvider`、`Phase8AgentProvider` 和 `RoundParticipant.provider` 接口，将其返回值改为未经信任的 `WorldJsonObject`，删除接口签名里 v2–v7 的历史协议联合。当前 v10 Scheduler/Coordinator 仍在提交前用 `submit_actions/v7` 校验；泛型 Provider 边界不赋予旧输出执行权。旧 `SubmitActionsV2`–`V6` DTO 定义暂留给历史测试，现行生产接口不再引用它们；不为纯类型删除大规模改写旧测试。类型检查、Lint、现行测试 67/67，v7 校验与当前交互/G1 相关测试 15/15 通过。本刀不改变模型请求、输出校验逻辑或网页行为，未再进行真实模型调用。

第二十一刀（2026-09-24）：存档 Manifest 读取早已拒绝 v2–v9，本刀将读取函数的返回类型明确为 v10，移除 `WorldApplication` 内部已不可达的 Phase 8 / Host Authority 版本判断，以及响应角色列表上的 v5 强制转换。当前 v10 的上下文装配、玩家意图选择与隔离恢复仍走同一路径；`WorldApplication` 的公开接口、权威提交、观察权限和模型请求未变。类型检查、Lint、现行测试 67/67，通过当前交互包、G1、场景观察和旧版本拒绝集成测试 16/16。本刀未改变角色可见内容或执行行为，未重复真实模型试玩。公开的历史类型和 `WorldSpecCompiler` 暂留，先评估它们作为未来创作/对外接口的价值，不因现行网页未调用就直接删除。

第二十二刀（2026-09-24）：保留 `RulebookRegistry`、`RulebookResolver` 和 `createCoreRulebookRegistry` 作为以后接入的公开扩展点，删除内置 `CoreRulebookResolver` 对 v2–v9 Manifest 的旧 `SpeakMoveRulebook`/交互目录回退，以及已无当前 Pack 选择的内置 Rulebook v1 注册。v10 仍委托同一个 `FrozenInteractionRulebook`，它内部继续复用 speak/move 规则；非 v10 Manifest 由冻结规则显式拒绝。类型检查、Lint、现行测试 67/67，通过当前交互包、G1、场景观察、旧版本拒绝和冻结交互集成测试 38/38。未更改模型上下文或提交语义，未再调用真实模型；旧版完整历史测试未作为验收门禁。

第二十三刀（2026-09-24）：移除不再作为原型验收的硬终止总套件、仅供它调用的九个子进程脚本，以及依赖已退役 v2 WorldSpec 的 P1/P3 阶段集成测试；同时清掉 `package.json` 中 P1–P4、P8 性能、硬终止、覆盖率和旧全量快捷命令，基线验证说明改为按路径运行相关测试。P2 观察/Session 隔离和 P4 记忆边界测试仍可通过 `test:related` 单独运行；历史报告保留其当时的命令与证据，不改写历史。此刀未修改生产运行时、Event Log 或存档，角色体验无直接变化。类型检查、Lint 和现行测试 67/67 通过；保留的 P2/P4 定向诊断 2/2 通过。v2 `WorldSpecCompiler` 没有生产调用者，但多份包含当前能力的测试仍借它拼装夹具；删除编译器须先更换这些夹具，不能通过整批删测试掩盖现行能力。

第二十四刀（2026-09-24）：将现行原型的自由叙述发布测试改为从 v5 Pack 编译出 v10 世界；交互定义测试改用直接声明的实体初始事件，不再借 v8 夹具。移除只覆盖旧 v7 分组 / v8 闭合交互的两份集成测试和内核测试，以及 Reaction Store 中无法再激活 v8 世界的跨版本断言；两个无调用者的旧模型输出夹具也退出。类型检查、Lint、现行测试 67/67，通过交互定义与 Reaction Store 定向测试 75/75。没有修改生产行为或模型提示，因此未做真实模型试玩。旧 v4→v9 夹具链仍被部分 v10 冻结交互测试借来构造世界，不能仅凭这刀删除 `WorldSpecCompiler`；下一步先替换这条夹具链。

第二十五刀（2026-09-24）：`WorldStore.commitRound` 的 Reaction Cycle 校验不再分派 v7–v9 Manifest 与 `interact@1`；已激活世界要求 v10 且交互能力必须为 `interact@2`。Store 仍支持无 Manifest 的低层单动作账本测试，双动作 Cycle 则要求 v10；这保留了通用账本接口，同时不再给退役版本留执行通道。首次直接要求每个 Cycle 都有 Manifest，导致 63 项使用无 Manifest 账本夹具的旧 Store 测试失败；收窄限制后现行检查 67/67、Store / v10 交互包 / G1 定向测试 75/75 通过。没有修改角色输出、提示或权威事件格式，未调用真实模型。同步夹具链跨多份测试，本刀未强行替换或删除 `WorldSpecCompiler`。

第二十六刀（2026-09-24）：删除内核 `world-spec.test.ts` 中已退役 v1–v7 WorldSpec 编译、旧 Manifest 读取与 Genesis 断言。当前 v10 激活拒绝及冻结交互路径继续由现行原型和 v10 集成测试验证；生产 `WorldSpecCompiler` 与其他公开接口尚未删除，以免旧夹具间接依赖在本刀中被大量替换或悄悄丢失。类型检查、Lint、现行测试 67/67；旧版本拒绝与 v10 冻结交互定向测试 25/25。只改变测试集合，未做真实模型试玩。下一步仍要把剩余同步夹具从 v2 编译器迁走，之后才能删除编译器实现。

第二十七刀（2026-09-25）：ReactionCycle 的公开草案/存档类型、草案校验和持久行读取只接受现行双动作词表 speak@1 / move@1 / interact@2；无 Manifest 的单动作 speak@1 账本接口继续保留。退役的 take@1、interact@1 不再作为可接受的 Cycle 词表，增加最小回归断言。删除使用 WorldSpec v2 和 take@1 拼装世界的旧 reaction-scheduler.test.ts（1030 行）；生产 ReactionScheduler 及公开接口未删除，当前网页仍走外部单角色激活。类型检查、Lint、现行测试 67/67，Store / v10 交互包 / G1 定向测试 75/75。另用独立 .tmp/g4-reaction-v10-smoke-1790266538441 存档向 deepseek-flash 提交“同行者，请试着拿起桌上的黄铜钥匙，并告诉我结果。”：5 次模型调用成功，Head seq19→46，同行者的 interact 得到 accepted 和事件引用，随后说“拿起来了。就在我手里。”；留守者也看到并回应，Cycle 以 quiescent 结束，无错误提示。这是现行网页模型链路的单次冒烟，不能证明已退役 ReactionScheduler 路径或 G3 自由叙述风险已被验证。

第二十八刀（2026-09-25）：共享 SpeakMoveRulebook 只服务 Manifest v10 的对白与移动；删除 v2–v9 的直接拿取、闭合交互目录、旧对白格式及角色关系终止分支。v10 的 interact 继续由 FrozenInteractionRulebook 和选中的交互包裁定；移动后的关系生命周期仍由冻结世界 fold 处理。移除六个没有调用者、专为旧 Manifest 版本分流的 Kernel 辅助函数，并去掉共享规则中无用途的旧交互上下文参数；保留 SpeakMoveRulebook 的公开入口以及交互包/Rulebook 扩展接口。类型检查、Lint、现行测试 67/67，v10 冻结交互、叙事发布、执行结果和 v5 Pack 定向测试 55/55。独立 .tmp/g4-rulebook-v10-smoke-1790267652216 存档提交玩家显式移动到后室：Head seq19→43，当前位置显示后室，3 次 deepseek-flash 调用成功，Cycle 以 quiescent 结束，无错误提示。该场景没有在后室同场 NPC，因而没有可见 NPC 对白；它只验证移动提交与当前网页模型链路，未覆盖跨房间长场景或 G3 分叉风险。

第二十九刀（2026-09-25）：当前应用中的 RoundCoordinator、ReactionScheduler 与 WorldApplication 都从只接受 Manifest v10 的存档入口取得世界；将前两者持有的 Manifest 类型收窄到 v10，三个反应策略调用点直接读取 manifest.reactionPolicy。删除原先为 v2–v4 补 disabled 策略的 reactionPolicyFromManifest 及历史默认值，以及两个没有调用者的 v8/v9 交互版本判断函数。保留 ReactionScheduler 构造时的运行时 v10 检查和公开调度接口；不触碰旧交互目录实现，因为部分仍被测试夹具链引用。类型检查、Lint、现行测试 67/67；v10 交互包、冻结交互和 G1 组合定向测试 30/30。此刀不改变模型可见上下文、裁定或权威提交，未重复真实模型试玩。旧 WorldSpecCompiler 与夹具链仍按清单第 3 项处理。

第三十刀（2026-09-25）：移除只激活 Manifest v5、使用 submit_actions/v2 的 Phase 9B Reaction 端到端测试与 P9 并发测试，共 807 行；两者不能通过当前仅接受 v10 的激活入口。同步裁掉专用 reaction-fixture.ts 中已无调用者的旧 Provider、绑定和地址构造，保留仍被 round-coordinator.test.ts 引用的 v5Manifest；从当前 retired-version 原型测试中去掉只验证退役 WorldSpecCompiler v2 拒绝 v1 源的断言，继续保留 v1/v2/v9 存档拒绝及旧 Manifest 激活不写入 Genesis 的检查。本刀不修改生产运行时或已提交事实。类型检查、Lint、现行测试 66/66（减少的 1 项正是退役编译器断言）；旧版本拒绝、G1 组合与 Reaction Store 定向测试 70/70。未进行模型试玩。历史 Phase 9 报告仍保留当时的测试路径作为历史记录，不把它们当作现行复现命令。WorldSpecCompiler 仍被 round-coordinator.test.ts 及其他旧夹具使用；后续先分类迁移 v10 需要的夹具，再删除编译器。

第三十一刀（2026-09-25）：将现行 v10 冻结交互夹具改为直接声明 v10 Manifest、冻结交互目录与 Genesis 事件；五份当前交互/部署/续写集成测试不再经过 v9→v2 WorldSpecCompiler 夹具链。旧 v2–v9 编译器及其余历史测试仍在，暂不删除其中可能有用的权限、提交和接口断言；这是移除旧编译器前的依赖切断，本刀没有删除生产接口。类型检查、Lint、现行测试 66/66，冻结交互及相关 G1 集成测试 57/57。只修改测试夹具，没有改变角色可见上下文或运行时行为，因此未重复真实模型试玩。

第三十二刀（2026-09-25）：将 `packages/kernel/src/world-kernel.test.ts` 缩为仍能运行的持久化 Round 结果解析测试，移除 7 项只依赖 v1 WorldSpec/v1–v4 Rulebook 的失效历史测试，共删除 518 行。删除前单独运行该文件为 1 通过、7 失败，失败均发生于旧编译器拒绝 v1 WorldSpec，未进入被测逻辑；现行 v10 冻结交互与叙事发布集成测试继续覆盖对白、移动及交互裁定。`WorldKernel` 类及公开接口未删除；其旧版提交/崩溃恢复测试没有被迁到 v10，作为当前非门禁覆盖限制记录。类型检查、Lint、现行测试 66/66；解析、冻结交互和叙事发布定向测试 25/25。只删除历史测试，未改变运行时或角色表现，未做真实模型试玩。

第三十三刀（2026-09-25）：将唯一使用 v5 `reaction-fixture.ts` 的“responsive 但没有 Reaction 绑定时不合成 Cycle”测试迁到现行 v10 冻结交互夹具，并显式安装该夹具选择的交互包。迁移前测试在 `WorldBootstrap` 的 v10 门槛处失败；迁移后该负向断言通过。删除无其他调用者的 104 行 v5 夹具和 130 行已导入不存在的 `ADDRESS`/`reactionBinding`、无法运行的旧 Reaction 历史测量脚本。保留 `RoundCoordinator`、Reaction 账本及其公开接口，未扩大运行时更改。类型检查、Lint、现行测试 66/66；定向负向测试 1/1。无模型可见行为修改，未重复真实模型试玩。

第三十四刀（2026-09-25）：将应用层唯一的 `player-provisional.test.ts` 从 v9 `characterInteractionWorld` 改为现行 v10 冻结交互夹具，以真实 `interact@2` 牵手结果验证临时绑定的事件 ordinal、漂移拒绝及 full/none/occurrence_only 的关系观察遮蔽；full 视图先断言有关系语义，避免空结果让遮蔽测试虚假通过。移除仅被退役闭合交互测试调用的 `endCharacterRelations` 批量终止辅助接口；v10 移动后的关系终止仍由冻结世界 fold 的定义处理器裁定，生产注释同步收口。没有改变现行运行时处理路径或权威提交。类型检查、Lint、现行测试 66/66，临时结果、关系 fold 与旧关系事件校验定向测试 3/3。其余依赖 v9 夹具的历史测试继续逐项判断，未做真实模型试玩。

第三十五刀（2026-09-25）：移除没有生产调用者的 `WorldSpecCompiler`、v2–v9 存档 Manifest 类型、旧闭合交互目录解析/可用性路径，以及四层历史 WorldSpec 夹具链。将 Branch Operation、玩家意图 Store/Worker 和 Round 的仍有效断言迁到现行 v10 冻结交互世界，并显式安装交互包；删除只能激活旧 Manifest 或依赖旧 cue 协议、无法进入当前行为的测试。当前 v10 Pack 仍使用的 V2 命名内容字段和解析函数保留，不按名称误删；公开的存档、事务及观察接口未变。类型检查、Lint、现行测试 66/66，相关 v10 定向测试 70/70。共删除约 5700 行，主要为历史测试和夹具；没有改变模型可见上下文或执行结果，未重复真实模型试玩。旧 ContextPipeline / WorldApplication 测试随其旧世界夹具退出，现行 v10 场景观察与权限断言仍在；这不等于旧路径的历史覆盖已迁移。

## 当前待清理清单（第三十五刀后）

以下顺序按当前 v5 网页与 worldpack 的调用链排定。具有以后对外提供价值的接口优先保留；删除候选限于已退出的旧协议或确认无用的内部重复实现。权威事实、观察权限和已提交事件的一致性继续保留。

| 顺序 | 待清理范围 | 当前证据与下刀边界 |
| --- | --- | --- |
| 1（已完成） | `submit_actions` v2/v3 校验入口及 v7 借用的旧解析辅助 | 已在第十七刀删除；保留 v1 通用校验和玩家表现解析接口。 |
| 2（完成） | `RoundCoordinator`、`ReactionScheduler` 的旧 Manifest 分流和 Provider 接口的历史输出联合 | 运行时内部固定 v10，Provider 公开接口保留并把输出交由 v7 校验；旧 DTO 类型仅供历史测试，后续可随旧测试自然退出。 |
| 3（完成） | kernel 的 v2–v9 Manifest 类型、`WorldSpecCompiler` v2 与对应旧夹具 | 第三十五刀已删除编译器、旧 Manifest 类型、历史夹具链和无当前调用者的闭合交互目录；仍有价值的当前断言迁到 v10。v10 Pack 使用的 V2 命名内容字段保留。 |
| 4（保留接口） | `WorldApplication` 的 archive、logical transfer、snapshot 离线 API | 这些能力未来可能需要对外提供，按用户要求保留公开接口；后续只审查内部重复或已失效的兼容分支，不以当前网页未调用为由删接口。 |
| 5（部分完成） | `package.json` 的旧阶段测试命令与专属夹具 | 已移除 P1–P4、P8 性能、硬终止、覆盖率及旧全量快捷命令，并清理硬终止/P1/P3 专属文件。P2/P4 与其他有观察、权限或接口诊断价值的测试保留为按需运行。 |
| 暂缓 | 耐久 Reaction 账本、Context Receipt、Provider Call/Quality、Reflection、Quarantine、Memory/Projection | `WorldApplication` 仍装配或调用其中部分；需先证明当前路径未使用，或先缩小接线。当前网页的单角色激活和旧 `ReactionScheduler` 是不同路径，不能因网页未调用后者就连带删除所有状态表。 |

G2-1 格式修正与 G2-2 有界非法输出诊断是待办；G3 自由叙述与受控事实分叉是体验风险。这三项不是代码删除的完成条件，也不因本轮清理自动解决。

## 第十六刀后的真实模型冒烟

用新的 `.tmp/g4-model-smoke-1790253974205` 存档、当前 `ai-girls-awaken-v10` v5 源目录和 `deepseek-flash`，提交一次“我对同行者说：你好。”。模型请求成功，玩家输入提交；世界 Head 从 seq101 到 seq150，记录 1 条玩家 `action.resolved` 和 7 条 NPC `action.resolved`，网页视角得到 6 条 NPC 文本。Provider 调用数为 8，末次状态 `ok`；本轮以 `call_limit` 停止，页面明确提示剩余反应未继续。数据目录独立于历史 `D:/worlds`，凭据仅从用户环境变量进入进程，未写入报告。这个样本证明现行网页链路可调用真实模型并提交事实；它没有触发受控物品交互，也没有直接执行旧 Round Context Pipeline 的 v7 工具协议，不能据此宣称 G3 或旧分支清理已通过真实玩法验收。

每个切片完成后运行类型检查、相关原型测试和 G1 组合测试；涉及玩家提交或观察权限时重跑相应集成场景。若改动到角色可见上下文或执行行为，再做一次短真实模型试玩，核对结果续写和跨房间隔离。删除旧脚本或文档时同步更新 README/指南；不要用旧 Golden 通过与否决定保留旧协议。G2-1/G2-2 仍是待办，G3 的自由叙述与受控事实分叉继续作为体验风险记录。
