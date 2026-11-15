# B9 无头推演与搜证切片

仅实施 B9，保留工作树改动供审阅，不提交、推送、创建 PR、合并 main 或发布。B10 包迁移与 B11 整体验收未开始。

## 起点与环境

- 云端 `/workspace/Perspectra`，origin 为 `https://github.com/YouLan5418/Perspectra.git`。
- 显式获取远端 `codex/composable-engine-implementation`；本地同名分支从 B8 交接点 `153ca9b34199c4152e6fa67733c5081a6585bb93` 建立，HEAD 包含该提交。环境默认只 fetch main，因此显式获取远端引用；未在 main 施工。
- Linux、Node 24.19.0、仓库锁定 pnpm 11.7.0。默认 `/home/agent` 缓存不可写，使用 `COREPACK_HOME=/tmp/perspectra-corepack`、`XDG_DATA_HOME=/tmp/perspectra-data`、`XDG_CACHE_HOME=/tmp/perspectra-cache`。`CI=true corepack pnpm@11.7.0 install --frozen-lockfile` 完成，锁文件未改。
- 先跑 Lens simulation、CLI、RPG 基线：3 文件 36 项通过，41.20 秒，退出 0。原始日志 `.tmp/composable-engine/b9/baseline.log`。
- 不依赖用户本地电脑、凭据或历史数据。所有运行实例使用新的临时 SQLite，结束清理。没有真实模型或计费请求。

## 接通内容

玩家在客厅搜查，精力 2→1，得到一封信；澄看到翻找，卧室的阿茹没有这条观察。重复搜查继续扣精力但不复制证物，精力耗尽后提交同一正式提案获得 `INSUFFICIENT_ENERGY`，状态保持不变。

- [ScriptedModel](../../../desktop/lens/scripted-model.ts) 是现有 `LlmTransportInstance` 的进程内实现，保留官方预设、Default DecisionService、授权上下文与正式响应校验。NPC 队列和动作匹配继续属于 Lens，HTTP 桩从这条执行路径移出。旧测试支持的 HTTP 桩文件保留。
- [LensSimulation](../../../desktop/lens/simulation.ts) 经 `WorldHostRuntime.create/perform/submit` 使用 B3 公开执行周期；共同玩法仍由 `GameplayRuntime` 裁定，经核心短事务提交。没有第二套规则执行器或提前迁包。
- `worldpack simulate <source> <scenario.json>` 与原 Lens 命令共用 [runScenario](../../../desktop/lens/scenario.ts)。成功退出 0，执行或断言失败退出 2，命令／装配异常退出 1。
- `interact` 匹配当前候选；完整 `action` 可提出当前未展示的请求，仍走正式身份、参数及规则检查。候选缺失不冒充业务拒绝。
- `resolution` 比较该步实际提交的玩家 `action.resolved`；`status` 复用 `committedStatusTruth` 回放所有共同状态事实。`knows/doesNotKnow` 读取各角色授权观察；`contextContains/contextExcludes` 检查该步实际送入传输层的授权请求，未调用不能算隔离通过；`panelsContain/panelsExclude` 检查玩家玩法投影。
- `fault` 比较真实 PluginFaultError 的插件、操作和 invalidResult；故障注入验证没有新裁定事实且精力／线索不变。内部异常原因不进入断言输出。允许预期故障后继续检查，非预期故障仍失败。
- 新增[独立搜证包](../../../examples/world-packs/investigation/README.md)，含一个实现文件、显式启用声明和短剧本；同定义原生与脚本版本比较状态、裁定、授权观察及玩家投影。两实例随机行动 ID 归一化后比较观察文本，保留其余内容。
- NPC 实际搜查回归发现 Host 与公共入口双层规则包装生成相同候选。只在 `GameplayRuntime.resolver` 合并候选时按完整 canonical JSON 去掉完全相同项，保留不同目标、绑定、参数；正式授权与 resolve 不变。检验 NPC 执行而非只检查候选存在。

## 独立审查

按 AGENTS 由主代理实施，独立 GPT-6.1 Sol 审查。首轮发现 `fault` 未列入 JSON 解析白名单；已修复并补 parser 正反例。独立复验 4 文件 44 项、B9 定向 4 项通过；独立临时包注入 resolve 异常后，经真实 CLI 运行 JSON fault 剧本，退出 0、结构故障正确、resolutions 为空、精力 2／线索空且内部异常未泄露，首轮 PASS。

最后 NPC 增量独立审查复现重复候选造成计划弃权，主代理按上面的合并去重修复；独立两文件 74 项复验通过，最终 PASS，无未关闭阻断。上述独立集合有重叠，不累加测试数量。

## 验证与耗时

首轮主验收 6 文件 57 项通过，56.37 秒；包含 Lens simulation／CLI／RPG、gameplay-presentation、pack-composition、status-state。根类型检查通过，生产边界 434 文件通过，定向 Lint 通过。最终主回归 9 文件 125 项通过（64.80 秒，退出 0），增加核心执行、共同玩法与官方玩法路径回归。中间一轮因新增 NPC 测试发现重复候选而失败（115 通过、1 失败），没有隐藏或削弱断言；修复后完整重跑以上最终组。

主要命令（前缀环境变量仅改变缓存路径）：

```sh
COREPACK_HOME=/tmp/perspectra-corepack corepack pnpm@11.7.0 typecheck
COREPACK_HOME=/tmp/perspectra-corepack corepack pnpm@11.7.0 test:related tests/host/lens-simulation.test.ts tests/host/lens-cli.test.ts tests/host/lens-rpg.test.ts tests/host/gameplay-presentation.test.ts tests/host/pack-composition.test.ts packages/application/src/status-state.test.ts packages/application/src/gameplay-runtime.test.ts packages/application/src/execution-engine.test.ts tests/host/official-gameplay-path.test.ts --maxWorkers=1
node scripts/check-host-boundaries.mjs
node scripts/docs/check-links.mjs
```

最终类型、定向 oxlint／Prettier、434 生产文件边界和 `git diff --check` 均退出 0。日志为 `.tmp/composable-engine/b9/{acceptance-verified,typecheck-verified,lint-verified,format-verified,boundaries-verified}.log`。文档链接检查退出 1：与本次云端起点相同的 104 条 missing-target 报告、86 条去重后的报告，新增 0、移除 0；另报告 103 个未随仓库保存的历史本地产物。比较见同目录 `docs-comparison.json`。

真实 Chromium（Linux headless）加载 `createHostServer` 的默认舞台和真实 WorldHostRuntime，使用进程内模型传输，点击“行动→搜查房间→状态”，看到精力 1 和“一封信”，pageerror 为空。截图 `.tmp/composable-engine/b9/stage-search.png`；脚本、控制台和错误记录同目录。它证明默认页面／宿主桥接行为，不代表 Windows Tauri 原生壳或真实模型体验。

计时字段单位毫秒：

| 字段 | 实际测量范围 |
| --- | --- |
| startupMs | 当前 Node CLI 进程启动到调用 runScenario 前，包含模块加载／剧本解析；不含外层 corepack/pnpm 启动，也不含输出序列化 |
| setupMs | 临时目录清扫、创建和源包复制 |
| compileMs | Lens 首次编译、内容装载检查、起点改写；不是纯编译器 CPU 时间 |
| initializeMs | WorldHostRuntime 创建、其内部重新编译／装配、SQLite 初始化及初始展示读取 |
| executionMs | applyScenario 的候选读取、步骤执行、真实 SQLite 提交、轨迹／模型输入／面板收集和断言；交互单步使用时累计 step 耗时 |
| cleanupMs | runtime 关闭和临时目录删除 |

不同阶段不含冷下载依赖，也不承诺几十毫秒。最终三步 CLI 单次实测（非隔离性能基准）：startupMs=1287.3、setupMs=3.0、compileMs=77.7、initializeMs=287.3、executionMs=382.0、cleanupMs=5.2 毫秒，退出 0。此执行值包含候选读取、轨迹和断言；原始输出为 `.tmp/composable-engine/b9/timing-final.log`。输出保留实际测量，不使用桩延时估算核心性能。

## 阅读路线

1. [CLI](../../../packages/world-pack/process/cli-entry.ts) 的 simulate 分支 → [scenario.ts](../../../desktop/lens/scenario.ts) `parseScenario/runScenario/applyScenario`，先看第三步完整提案和期望拒绝码。
2. [simulation.ts](../../../desktop/lens/simulation.ts) `open/step` → [WorldHostRuntime](../../../desktop/host/world-runtime.ts) `create/perform/turn` → [WorldApplication](../../../packages/application/src/world-application.ts) `createExecutionEngine/withExecutionResources`，理解身份、生命周期和预算绑定。
3. [GameplayRuntime](../../../packages/application/src/gameplay-runtime.ts) `resolver` → 搜证 `resolve` 只提出 effects → [RoundCoordinator](../../../packages/application/src/round-coordinator.ts) 的正式行动与观察构建 → `RoundCoordinator.options.store.commitRound` 的 SQLite 原子提交（系统／初始化路径另经 [world-round-execution.ts](../../../packages/application/src/world-round-execution.ts)）。NPC 路径通过 [CharacterTurn](../../../packages/application/src/character-turn.ts) 的受控 perform。
4. 回到 `LensSimulation.events/perceived/modelInputs` 与 `committedStatusTruth`，再看 `scenario.check`；最后读 `lens-simulation.test.ts` 的 B9 用例，核对断言来源是已提交事实和真实授权交付。

## 保留的边界

未执行全仓 check、Launcher 全量、真实模型、Python/E5、Windows taskkill／Tauri、发行构建或发布；这些不能从本次通过结果推导。未验证第三方任意预设改写请求形状、任意自定义模型／记忆服务组合、长期运行性能。搜证是有限示例，线索规则由定义决定，不是通用搜证系统。推演输出是作者诊断，逐角色输入不能作为所有角色共享上下文。
