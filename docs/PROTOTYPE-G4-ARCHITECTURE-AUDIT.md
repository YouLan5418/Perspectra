# G4 架构减法：入口、依赖与删除顺序

日期：2026-09-23。基线为 `4741c66`，工作树 `harness-cordis-world-g4`。这是针对**当前本机 v10 / `worldpack-source/v5` 网页原型**的源码盘点，不宣称 G3 已通过，也不承诺继续运行旧世界包或旧宿主。`D:/worlds` 的历史存档仅作只读证据。

## 当前实际调用链

```text
experience:web → playtest-web-entry
  → v5 Pack: FrozenWorldPlaytestRuntime → WorldApplication
      → 玩家自然语言解释 / RoundCoordinator / Rulebook / WorldStore
      → PrototypeCharacterTurn + runPrototypeActivations
          → 角色可见场景 / 交互裁定 / 原子事件提交 / 结果观察
  → 旧 Pack: WorldPlaytestRuntime → 旧批量提案与 simulation 示例
```

当前 v5 路径由 `tests/experiments/playtest-web-entry.ts:21-39` 选择；`tests/experiments/playtest-frozen-runtime.ts:213-229` 实例化 `WorldApplication`，`:297-322` 先提交玩家 Root 再激活 NPC，`:419-431` 调用新的单角色激活。`packages/application/src/prototype-character-turn.ts` 直接使用 `WorldStore`、`WriterLeaseService`、Rulebook 和 `SceneDecisionService` 提交并分发结果。它不是独立的新存储引擎。

仓库目前有 15 个 `packages` 目录、约 260 个包内文件。仅非测试 TypeScript，`store-sqlite` 约 8 千行、`application` 约 6.4 千行、`world-pack` 约 4.7 千行。行数提示审查成本，不是删除依据。多个包通过 `index.ts` 汇总导出；“被 import”不等于每个导出都在试玩中执行。

| 层 | 当前 v5 作用 | G4 判断 |
| --- | --- | --- |
| `provider-chat`、玩家输入解释/绑定 | 连接真实模型，将玩家原文映射到可裁定动作；错序拒绝与未提交反馈已有实测 | 保留当前路径 |
| `world-pack` v5、`interactions-basic`、`interaction-runtime`、`kernel` | 编译作者声明的交互，提供 Rulebook 裁定 | 保留 v5 和当前交互；旧版本另审 |
| `application` 的 `WorldApplication`、`RoundCoordinator`、`PrototypeCharacterTurn`、场景决策 | Root 提交、角色执行与结果续写、观察权限 | 保留事实边界；缩小旧调度入口 |
| `store-sqlite`、`contracts`、`runtime-cordis` | Event Log、Head、租约、原子提交、角色视图和生命周期 | 不以“基础设施”一词整包删除；先追踪具体调用 |
| `agents`、`memory`、`presentation` | 仍由 `WorldApplication` 的分支装配或上下文路径引用 | 尚不能判定整包无用；先测实际生成的上下文和副作用 |
| `operations`、`simulation`、`testkit` | 独立宿主/备份、旧试玩和示例/测试工具 | 不在 v5 网页主链路；有独立命令与测试，分批退出 |

`WorldApplication` 并未因 `externalCharacterActivations: true` 变成薄壳：它仍装配 `RoundCoordinator`、存储与上下文；当前网页还调用 `processNextReactionWave` 做旧 Cycle 排空，并用 `listReactionCycles` 填调试状态（`playtest-frozen-runtime.ts:473-525`）。所以不能先删除 Reaction Store 表或 `RoundCoordinator`。同样，`world-pack/src/tooling.ts:73-121` 的版本分派与 `compiler.ts` 的共享 v2–v5 编译过程交织，不能只删几个 `V2/V3/V4` 类就认为 v5 独立。

## 可删候选与先后关系

| 顺序 | 候选 | 已见证据与必要前置 | 决定 |
| --- | --- | --- | --- |
| 1 | `FrozenWorldPlaytestRuntime` 内的旧批量对照分支：`singleCharacterActivations: false`、`performNpcId`、`#pendingPerform`/`#continuePerformedItem` 等 | 默认值为单角色；旧分支只在历史对照测试显式打开（`playtest-frozen-runtime.test.ts:104,511`）。删时保留玩家 Root 后对旧 Cycle 的必要排空，验证没有悬挂 Cycle。 | **首个删除切片**；同时移除对应旧断言，不保留运行时兼容开关 |
| 2 | 网页入口的旧 Pack 回退、`WorldPlaytestRuntime`、`grouped-playtest`/`lean-context`/旧对照适配器 | README:47 已说明旧 compact/lean 不作为当前支持入口；但 `playtest-web-entry.ts:7,28-39` 仍可进入旧运行时，且 v5 代码复用 `playtest-runtime.ts` 的 `playtestModelCharacters`、`playerTranscript`、`defaultPlaytestDirectory`。 | **可删，待第一步后**；先将三个小工具移到当前入口附近，再移除回退和旧测试 |
| 3 | `simulation` 的 mystery/rainy-road/tavern 演示与根脚本 `demo:mystery*`、旧体验脚本 | 当前 v5 样例是 `examples/world-packs/prototype-g1`；simulation 由旧试玩、示例命令和测试引用。 | **可从本原型分支退出**；先完成第二步，逐项移除示例入口和仅服务示例的测试 |
| 4 | `operations` 的 headless RPC、BranchWorkScheduler、deployment backup/restore 与 `worldctl`/`worldhost`/`worlddeploy` 脚本 | `packages/operations/process/*` 是独立宿主；当前网页只使用 `playtest-server.ts`，不调用这些入口。`worldpack` CLI 属于另一个包。 | **可作为单独产品范围决策**；本机原型若只保留网页与作者 Pack CLI，优先删除独立入口，再清理依赖；不要误删 Event Log 的原子提交 |
| 5 | `world-pack` v1–v4 编译/读取、旧 Manifest 与 `submit_actions` 版本路径 | v5 Pack 映射到 v10；`tooling.ts` 仍支持 v1–v5，`compiler.ts` 共享解析与校验，旧世界与文档仍引用旧版本。 | **方向上可删，实施成本高**；须先完成第二步并确认不迁移旧存档，再按实际 v5 调用图拆共享函数 |
| 暂缓 | Context Receipt、Provider Call/Quality、Reflection、逻辑导出/快照、Quarantine、耐久 Reaction 账本及旧协议字段 | `WorldApplication`、上下文装配和 Store 仍静态或实际触达其中一些；仅凭名称判断不了是否保护当前状态与可见性。 | **不列入第一轮删除**；逐个证明不用、或先把当前路径改为更小的现有机制，再删旧实现 |

第一步是局部切除：不新建 Host 框架，不改权威事件模型，不把叙事与状态分叉当成已解决。它能先消掉当前同一试玩类中的两套 NPC 协议、特例状态与旧测试分支；删除收益是减少维护和调试时的分叉，而非声称模型更自然。

每个切片完成后运行类型检查、相关原型测试和 G1 组合测试；涉及玩家提交或观察权限时重跑相应集成场景。若改动到角色可见上下文或执行行为，再做一次短真实模型试玩，核对结果续写和跨房间隔离。删除旧脚本或文档时同步更新 README/指南；不要用旧 Golden 通过与否决定保留旧协议。G2-1/G2-2 仍是待办，G3 的自由叙述与受控事实分叉继续作为体验风险记录。
