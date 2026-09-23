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

仓库目前有 15 个 `packages` 目录、约 260 个包内文件。仅非测试 TypeScript，`store-sqlite` 约 8 千行、`application` 约 6.4 千行、`world-pack` 约 4.7 千行。行数提示审查成本，不是删除依据。多个包通过 `index.ts` 汇总导出；“被 import”不等于每个导出都在试玩中执行。

| 层 | 当前 v5 作用 | G4 判断 |
| --- | --- | --- |
| `provider-chat`、玩家输入解释/绑定 | 连接真实模型，将玩家原文映射到可裁定动作；错序拒绝与未提交反馈已有实测 | 保留当前路径 |
| `world-pack` v5、`interactions-basic`、`interaction-runtime`、`kernel` | 编译作者声明的交互，提供 Rulebook 裁定 | 保留 v5 和当前交互；旧版本另审 |
| `application` 的 `WorldApplication`、`RoundCoordinator`、`PrototypeCharacterTurn`、场景决策 | Root 提交、角色执行与结果续写、观察权限 | 保留事实边界；缩小旧调度入口 |
| `store-sqlite`、`contracts`、`runtime-cordis` | Event Log、Head、租约、原子提交、角色视图和生命周期 | 不以“基础设施”一词整包删除；先追踪具体调用 |
| `agents`、`memory`、`presentation` | 仍由 `WorldApplication` 的分支装配或上下文路径引用 | 尚不能判定整包无用；先测实际生成的上下文和副作用 |
| `operations`、`simulation`、`testkit` | 独立宿主/备份、旧试玩和示例/测试工具 | 不在 v5 网页主链路；有独立命令与测试，分批退出 |

`WorldApplication` 并未因 `externalCharacterActivations: true` 变成薄壳：它仍装配 `RoundCoordinator`、存储与上下文。第一刀前，当前网页还调用 `processNextReactionWave` 并读取 `listReactionCycles`；固定外部激活后不会装配旧 Reaction Worker，第一刀已移除这两个网页调用。其他宿主仍可能使用旧账本，所以不能据此删除 Reaction Store 表或 `RoundCoordinator`。同样，`world-pack/src/tooling.ts:73-121` 的版本分派与 `compiler.ts` 的共享 v2–v5 编译过程交织，不能只删几个 `V2/V3/V4` 类就认为 v5 独立。

## 可删候选与先后关系

| 顺序 | 候选 | 已见证据与必要前置 | 决定 |
| --- | --- | --- | --- |
| 1 | `FrozenWorldPlaytestRuntime` 内的旧批量对照分支：`singleCharacterActivations: false`、`performNpcId`、`#pendingPerform`/`#continuePerformedItem` 等 | 删除前默认值为单角色；旧分支仅在历史对照测试显式打开。固定外部激活后不装配旧 Reaction Worker，现行激活测试能证明无悬挂 Cycle。 | **已删除**；对应旧断言与无效的网页排空/调试调用一并移除 |
| 2 | 网页入口的旧 Pack 回退、`WorldPlaytestRuntime`、专属测试与 v8 Provider 手工脚本 | README 已说明旧运行时不作为当前支持入口；v5 代码原先只借用了角色列表、玩家转录、默认数据目录三个工具。 | **已删除**；三个小工具迁至 `playtest-view.ts`，网页对旧 Pack 明确拒绝 |
| 2a | `grouped-playtest`、compact/lean Context 渲染、旧输入解释和旧模型对照命令 | 第二刀后只剩相互引用的实验脚本与专属测试；当前 v5 网页运行时不调用它们。`v10-provider-gate` 和 `context-cost` 有独立用途。 | **已删除**；清理三个旧 `experience:*` 命令，保留历史报告并标明旧入口退出 |
| 3 | `simulation` 的 mystery/rainy-road/tavern 演示与根脚本 `demo:mystery*`、旧体验脚本 | 当前 v5 样例是 `examples/world-packs/prototype-g1`；simulation 由旧试玩、示例命令和测试引用。 | **部分完成**；悬疑 Demo、四个命令与专属规则/测试已删除。场景可见性测试换用最小夹具；rainy-road、tavern 和 `WorldSimulation` 仍有独立引用，留待下一刀 |
| 4 | `operations` 的 headless RPC、BranchWorkScheduler、deployment backup/restore 与 `worldctl`/`worldhost`/`worlddeploy` 脚本 | `packages/operations/process/*` 是独立宿主；当前网页只使用 `playtest-server.ts`，不调用这些入口。`worldpack` CLI 属于另一个包。 | **可作为单独产品范围决策**；本机原型若只保留网页与作者 Pack CLI，优先删除独立入口，再清理依赖；不要误删 Event Log 的原子提交 |
| 5 | `world-pack` v1–v4 编译/读取、旧 Manifest 与 `submit_actions` 版本路径 | v5 Pack 映射到 v10；`tooling.ts` 仍支持 v1–v5，`compiler.ts` 共享解析与校验，旧世界与文档仍引用旧版本。 | **方向上可删，实施成本高**；须先完成第二步并确认不迁移旧存档，再按实际 v5 调用图拆共享函数 |
| 暂缓 | Context Receipt、Provider Call/Quality、Reflection、逻辑导出/快照、Quarantine、耐久 Reaction 账本及旧协议字段 | `WorldApplication`、上下文装配和 Store 仍静态或实际触达其中一些；仅凭名称判断不了是否保护当前状态与可见性。 | **不列入第一轮删除**；逐个证明不用、或先把当前路径改为更小的现有机制，再删旧实现 |

前四刀是局部切除：未新建 Host 框架，未改权威事件模型，也未把叙事与状态分叉当成已解决。当前试玩类只保留单角色 NPC 协议；删除收益是减少维护和调试时的分叉，不是声称模型更自然。

第一刀验证（2026-09-23）：类型检查、Lint、40 个原型冒烟测试通过；`playtest-frozen-runtime`、网页服务、G1 组合和执行续写共 35 个相关测试通过。独立新存档的 4 句 DeepSeek 连续试玩均提交成功，首轮同行者自主拿取黄铜钥匙，seq38 为 `entity.transferred`、seq39 为接受的 `action.resolved`，随后收到结果并自由续写；至第 4 句没有第二次钥匙转移。该样本验证当前路径仍可交互，不能据此推断 G3 叙事一致性通过。新工作树安装依赖时复用了原型工作树的本地 `node_modules`；没有修改依赖或锁文件。

第二刀验证（2026-09-23）：移走网页旧运行时及其专属测试、v8 手工门禁脚本，共删约 1,700 行；三个仍被 v5 使用的视图工具迁到 `playtest-view.ts`。类型检查、Lint、40 个现行原型测试和 47 个相关测试通过。旧编译 Pack 启动明确失败，v5 源目录的网页入口可以启动；样例 v5 Pack 校验通过。独立新存档的 1 句 DeepSeek 试玩正常提交，同行者拿起黄铜钥匙并在随后表达中说明自己持有；本轮结束原因为 `character_limit`，这不是 G3 体验验收。旧 Pack 不再能从网页续玩，历史 `D:/worlds` 数据未修改；`grouped-playtest`、`lean-context` 等独立实验工具仍保留，需在下一刀按实际调用者审查。

第三刀验证（2026-09-23）：删除仅服务旧协议的 13 个实验脚本/测试和 3 个旧 `experience:*` 命令。类型检查、Lint、40 个现行原型测试与 28 个网页/G1 相关测试通过；v5 网页入口可启动。独立新存档的 4 句 DeepSeek 试玩均正常提交，第四句 NPC 提出拿取黄铜钥匙，规则提交后收到结果并明确说钥匙在自己手里，周期安静结束。此样本只证明当前路径仍可用，不能证明 G3 的自由叙述风险已经消失。历史实验记录保留作为证据，旧命令不再运行。

第四刀验证（2026-09-23）：移除悬疑 Demo 的命令入口、场景、专属调查规则与测试，`simulation` 不再依赖 Memory；保留的 `SceneDecisionService` 测试改用独立小夹具，原 5 项可见性与失败路径断言通过。现行 `check` 为 40/40，相关 `simulation`、进程入口、P0 与 G1 测试为 16/16。扩大测试发现旧 `rainy-road` 六轮断言有 1 项失败：期待 Alice 抵达站台，实际仍在路边；相同失败已在未做 G4 删除的原型基线 `4741c66` 复现，因此不为这次删除修改运行时或旧断言。独立新存档的 4 句 DeepSeek 试玩均提交成功，首轮 seq38 是钥匙交给同行者的唯一 `entity.transferred`。第四轮同行者又在自由叙述中说“钥匙给你”，但没有相应转移事件，G3 叙事与受控事实分叉仍然存在。历史 `D:/worlds` 存档未修改。

每个切片完成后运行类型检查、相关原型测试和 G1 组合测试；涉及玩家提交或观察权限时重跑相应集成场景。若改动到角色可见上下文或执行行为，再做一次短真实模型试玩，核对结果续写和跨房间隔离。删除旧脚本或文档时同步更新 README/指南；不要用旧 Golden 通过与否决定保留旧协议。G2-1/G2-2 仍是待办，G3 的自由叙述与受控事实分叉继续作为体验风险记录。
