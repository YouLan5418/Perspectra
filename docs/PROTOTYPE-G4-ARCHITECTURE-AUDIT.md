# G4 架构减法：入口、依赖与删除顺序

日期：2026-09-23。基线为 `4741c66`，工作树 `harness-cordis-world-g4`。这是针对**当前本机 v10 / `worldpack-source/v5` 网页原型**的源码盘点，不宣称 G3 已通过，也不承诺继续运行旧世界包或旧宿主。`D:/worlds` 的历史存档仅作只读证据。

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

每个切片完成后运行类型检查、相关原型测试和 G1 组合测试；涉及玩家提交或观察权限时重跑相应集成场景。若改动到角色可见上下文或执行行为，再做一次短真实模型试玩，核对结果续写和跨房间隔离。删除旧脚本或文档时同步更新 README/指南；不要用旧 Golden 通过与否决定保留旧协议。G2-1/G2-2 仍是待办，G3 的自由叙述与受控事实分叉继续作为体验风险记录。
