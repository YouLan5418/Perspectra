# 宿主与记忆代码整理（2026-10-21）

本次在独立分支 `codex/code-organization-20261021` 整理当前实现，起点为 `717ed6c`。原工作区已有文档、未跟踪文件与历史试玩目录保持原状；没有合并到 main、推送、调用真实模型或改写历史实验结果。

例如玩家启动游戏、查看创作者状态、保存故事节点时，实际运行的文件现在集中于 `desktop/host`，不再需要从“测试／实验”目录寻找正式宿主。整理保持既有角色协议、提示内容、预算、规则裁定和存储格式；创作者检查响应的 `variables` 明确更名为 `statusTruth`，第一方页面同步调整，没有保留旧字段兼容层。

## 改动与证据

| 原问题与证据 | 本次处理 | 当前入口 |
| --- | --- | --- |
| 源码启动、桌面打包和便携脚本从 `tests/experiments` 加载宿主，生产相关静态导入集合为 27 个 TS 文件 | 迁移到现有 desktop 所有权下，统一修改源码、测试、构建与引用 | [宿主说明](../../../desktop/host/README.md)、[web-entry.ts](../../../desktop/host/web-entry.ts) |
| 默认 Core 从 `experiments` 启动 Python，便携包复制其中实现 | 迁移 10 个运行模块、vendor、资产清单、准备脚本和依赖说明；Rust、worker、发行复制与校验同步 | [Core 说明](../../../desktop/host/memory/README.md)、[便携构建](../../../scripts/release/build-portable.mjs) |
| frontend 的公共视图文件引用宿主状态与运行接口 | 将投影和操作执行适配移入宿主；公共数据、请求校验与补丁仍由 frontend 提供 | [frontend-adapter.ts](../../../desktop/host/frontend-adapter.ts)、[公共视图](../../../packages/frontend/src/player-view.ts) |
| `decideActivityFormat` 实际服务全部角色决策 | 从活动运行时拆出通用重试，改名为 `decideWithFormatRetry`；重试内容和预算逻辑保持一致 | [decision-format.ts](../../../desktop/host/decision-format.ts) |
| `frozen/playtest/hindsight` 混淆正式职责 | 内部入口、宿主、网关适配、解释器和检查类型按职责更名；既有品牌 ID、外部 HTTP 路由、token header 和发行 `playtest.mjs` 文件名保留 | [world-runtime.ts](../../../desktop/host/world-runtime.ts)、[gateway-turn-call.ts](../../../desktop/host/gateway-turn-call.ts)、[python-worker.ts](../../../desktop/host/memory/python-worker.ts) |
| 创作者“变量”页展示状态真值，样例仍含情绪／信任值 | 改为状态导航与 `statusTruth`，样例使用客观状态，修正导出说明；活动内部变量保留 | [StatusView.vue](../../../apps/launcher/src/creator/StatusView.vue)、[接口文档](../creator-debug-api.md) |
| 历史 JEV/Core 探针绑定固定记录，关系 spike 已退役 | 移入对应研究目录，注明外部调用／固定样本限制；冻结证据源码保持原样 | [JEV 历史脚本](../../../experiments/jev-narrative-auditor/scripts/README.md)、[Core 诊断](../../../experiments/activity-memory/scripts/README.md)、[关系原型](../../../experiments/character-relations/archive/README.md) |
| 无引用的旧 `playtest-page.ts` 与实际宿主页并存 | 删除旧页；宿主测试移到 `tests/host`，零模型序章与专用角色卡切片准确命名 | [宿主页](../../../desktop/host/host-page.ts)、[宿主测试](../../../tests/host)、[离线序章](../../../tests/experiments/official-prologue-offline.ts) |

没有引入新的 Host 框架、包、协议版本、数据库或通用脚本平台。`packages/memory` 仍提供原生记忆；Python Core 是宿主适配，不把宿主存档与发行职责塞进原生记忆包。

## 路径与运行时身份

源码 Python 实现在 `desktop/host/memory/python/{core,bridge}`，发行位置为 `runtime/memory-core/python/{core,bridge}`。Python 的源码根目录回退随层级调整；发行时继续通过既有环境变量指定模型与缓存。头像和创作者资产的源码相对位置也已核对。

[运行时身份](../../../desktop/tail-runtime-identity.ts)同步跟随新路径，并包含拆出的格式重试、前端适配与授权名称模块。改路径会改变身份；旧末端回合不能因此绕过环境一致性检查重新生成或切换候选。本次不新增旧候选迁移。故事节点、原始经历与记忆授权边界按现有回归分别验证，不把“身份改变”泛化为所有存档损坏。

## 验证方法与范围

从仓库根目录运行；本机 Python/E5 环境准备见 [Core 说明](../../../desktop/host/memory/README.md)：

```powershell
node scripts/check-host-boundaries.mjs
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 lint
corepack pnpm@11.7.0 launcher:check
corepack pnpm@11.7.0 test --maxWorkers=1
corepack pnpm@11.7.0 test:related tests/host --maxWorkers=1
corepack pnpm@11.7.0 launcher:build
corepack pnpm@11.7.0 desktop:build
node --import tsx scripts/release/verify-core-layout.mjs
cargo check --offline --manifest-path apps/launcher/src-tauri/Cargo.toml
node scripts/docs/check-links.mjs
```

生产路径检查只读扫描源码，默认 `check` 和 Windows CI 均调用它；它不做语义权限证明。Python 的候选准入、桥和原生协议三组离线回归为 38 项，通过。宿主测试 44 项与 Launcher 测试 44 项通过；源码两端构建、Rust 离线检查、文档链接检查通过。

隔离布局检查在全新的 `.tmp/core-layout-*` 目录复制发行所需 Python 模块，验证源码／打包单次请求、两次常驻 worker 请求、本地 E5 编码（`[1,384]`）与默认 Core HTTP 启动。结果 JSON 仅保存检查结论，不含令牌、角色材料或模型凭据。它复用本机 Python/E5，不代表完整便携包或干净 Windows 已验收。

首次默认测试执行了 72 个文件、651 项断言：632 项通过，19 项硬中断场景因沙箱 `taskkill` 权限失败；另出现一次活动 mock 空请求的未处理异常。没有为此跳过用例或修改断言：允许终止测试自建子进程后，两组相关测试 37 项通过；活动测试单独复跑 33 项通过。沙箱内 Rust 和 ONNX 的原生加载也失败，环境限制解除后的相同验证通过。

最终在相同串行配置下完整重跑默认回归：**72 个文件、651 项全部通过，退出码 0，401.66 秒，无未处理错误**。这次完整运行也覆盖故事保存／分享、候选切换、授权记忆与硬中断恢复。初次活动 mock 异常未再次出现；没有据此声称修复了一个尚未稳定复现的缺陷。

## 有意识保留的限制

- 未做新的真实模型连续试玩，不宣称角色自然度、长期记忆收益或叙事一致性新增验收。
- 未构建完整便携发行包；本机缺少 WebView2/CRT 等发行素材和 release Launcher EXE。没有下载替代素材，也没有把旧 EXE 当作新 Rust 桥的发行验证。
- 历史脚本保留原记录绑定，不承诺全部可以在新环境复跑；固定证据副本不批量重写。活跃实验若要再次使用，先核对来源与新输出目录。
- `tests/experiments` 仍保留研究驱动；已经移出的宿主不会继续从该目录加载实现。

## 复核后的修复（2026-10-21）

复核基点为 `bd4e970`。这轮处理入口缺陷与整理收尾，没有扩大角色运行机制：

| 问题 | 修复与验证边界 |
| --- | --- |
| Electron 开发入口仍拼旧实验路径 | 改为 `desktop/host/web-entry.ts`，保持显式原生记忆；实际 TypeScript 后端启动纳入回归，未运行 Electron 图形界面 |
| 构建后的后端把源码目录误判为安装目录，加载身份时即因 Python 路径失败 | worker 与身份共用 `corePythonRoot`，以既有 `PERSPECTRA_RUNTIME_ROOT` 显式选择；缺文件仍直接失败，没有跳过身份检查 |
| Electron 包缺少身份检查需要的 Python 源文件 | `desktop:build` 与便携构建共用复制清单，Electron 打包时设置自己的 runtime root；未给旧 Electron 增加 Core 解释器或 E5 发行支持 |
| 边界检查漏掉 `join(repository, 'tests', 'experiments', ...)` | 同时检查 `join` / `resolve` 的字面路径段，加入失败夹具；扫描范围补上构建脚本 |
| 宿主 44 项测试只在手动选择时运行 | 默认配置与 CI 使用同一发现规则，纳入 `tests/host`；另加边界检查与入口布局回归 |
| 33 处源码链接因迁移失效 | 修复 13 篇研究页的源码导航，附迁移前提交／原路径；不把历史测试结果当作新实现验收 |
| 指南与历史记忆命令仍指向旧职责 | 指南统一 `statusTruth`，历史说明跳转到当前 Core 环境和离线命令；删除已失效的历史 TypeScript 检查配置，不恢复退役 API；修正两份探针的导入路径 |
| 小范围旧命名残留 | 测试文件、目标检查 fixture、黑海岸切片与宿主错误文案按现职责命名；既有外部路由、header、发行文件名和环境变量保持 |

离线布局检查已验证源码／打包单次 Python 请求、两次常驻 worker 请求、E5 编码 `[1,384]`，以及构建后端在源码、Electron 资源目录和隔离便携目录中的默认 Core HTTP 状态接口，外部模型调用为 0。证据写入本机 `.tmp/core-layout-wLyfn5/result.json`，不含凭据或令牌。

本轮最终默认回归 **79 个文件、697 项全部通过，退出码 0，422.33 秒**，包括宿主原有 44 项与两项新增回归；日志位于本机 `.tmp/prototype-followup-final.log`。三种原生记忆入口布局的就绪与鉴权状态接口均已验证，Python 三组离线回归 38 项通过；两份历史探针只执行导入前缀，均解析到当前 Python 桥，未执行模型探测正文。类型、Lint、桌面构建通过。

生产边界检查通过（261 个文件）；文档检查通过（91 页、1005 个本地链接），覆盖全部 `docs/current`。33 个缺失的 `.tmp`／`output` 私有实验产物仅报告数量，不作为源码导航失败。完整便携包、Electron 界面和真实角色体验仍沿用上文的未验收限制。

## 第三轮：命名、包入口与回归依赖（2026-10-21）

复核基点为 `f7070f0`。前两轮已让生产代码离开实验目录，这一轮处理复核时仍能看到的三类问题，不改变角色协议、提示内容、调度、规则裁定或存储格式。

| 问题与证据 | 处理 |
| --- | --- |
| 角色回合主路径叫 `prototype-character-turn.ts`、`PrototypeCharacterTurn`、`runPrototypeActivations`，provider-chat 的请求构造叫 `prototypeTurnCall` | 改为 [character-turn.ts](../../../packages/application/src/character-turn.ts)、[activation-cycle.ts](../../../packages/application/src/activation-cycle.ts)、[character-turn-call.ts](../../../packages/provider-chat/src/character-turn-call.ts)；符号同步去掉 `Prototype` 前缀，写入租约的临时 owner 前缀改为 `character-turn:`。带日期的证据目录、历史报告和 archive 保持原名 |
| 宿主有 62 处 `../../packages/x/src/...` 深路径，其中 17 个包内文件未从入口导出；`packages/frontend` 没有 package.json | application 与 provider-chat 入口导出宿主实际使用的模块；frontend 成为 `@harness-world/frontend` 包；`desktop` 全部改用包名。launcher 的 tsconfig 只为类型检查增加同一映射，其运行时代码仍只直接引用浏览器安全的 preset 模块 |
| 默认回归经 14 个文件依赖 `tests/experiments`，删除实验驱动会打破回归 | 共用场景、夹具与崩溃子进程移入 [tests/support](../../../tests/support/README.md)；`hidden-cure` 两个驱动拆出共享场景与玩家策略，真实模型 CLI 留在原处 |

[边界检查](../../../scripts/check-host-boundaries.mjs)新增两条规则：TypeScript 源码不得用相对路径进入其他包的 `src/`（launcher 与 `.mjs` 发布脚本仅允许类型导入和明确列出的浏览器安全模块）；`tests/` 中除研究驱动外不得 import `tests/experiments`。在 `f7070f0` 的源码上运行，新规则分别报告 desktop 的深路径与 29 处回归依赖；[宿主测试](../../../tests/host/boundaries.test.ts)补了对应的失败与放行夹具。

运行时身份覆盖 packages 与宿主文件路径，改名会再次改变身份；与前两轮相同，不为旧末端回合增加迁移。

验证：默认回归 **79 个文件、697 项全部通过**（串行，427.83 秒）；typecheck、lint、边界检查、文档链接检查通过；`launcher:check`（类型检查与 44 项测试）、`launcher:build`、`desktop:build` 通过，打包产物中没有残留未解析的包名导入。未运行真实模型试玩、Python Core 离线回归、Rust 检查或便携包构建；本轮没有改动这些路径的源码。

后续已在同一源码提交 `38b6487` 完成 [DeepSeek 官方真实试玩](code-organization-deepseek-playtest-20261021.md)：72 次模型请求全部成功，覆盖角色回合、授权知识、活动、实际 Core 整理、保存重开与候选生成／切换。仍发现一次未执行拿取却叙述取得保管的体验问题；没有同模型基点 A/B，不归因为本次整理。完整证据与限制见该报告。

## 第四轮：版本号命名、测试分层与宿主拆分（2026-10-21）

基点为 `ddcbe4a`（第三轮之后的试玩记录），分三个提交，不改变角色协议、提示内容、调度顺序、规则裁定或存储格式。

**命名与退役契约**（`6559f47`）。`contracts/context-v2.ts` 中导演规划、上下文回执和各类上下文哈希约 360 行，生产代码零引用，只有自身测试在用，连同测试删除；仍在使用的 `ContextSourceRef` 移到 [context-source.ts](../../../packages/contracts/src/context-source.ts)。`memory-v2.ts`、`phase8-registries.ts` 改为 [cognitive-memory.ts](../../../packages/contracts/src/cognitive-memory.ts)、[runtime-registries.ts](../../../packages/contracts/src/runtime-registries.ts)；`PHASE8_*` 契约导出改为 `BASIC_VOCABULARY_*`、`RUNTIME_REGISTRY_*` 等。哈希域字符串与存档中的 ID 未改，词表与注册表 Golden 仍通过。

**测试分层**（`6097aed`）。`tests/prototype` 按被测入口拆为 [tests/host](../../../tests/host)、[tests/desktop](../../../tests/desktop)、[tests/scenarios](../../../tests/scenarios)；根目录的 `p2/p4/p8/frozen-*` 集成测试移入 [tests/integration](../../../tests/integration) 并按行为命名。默认配置改名为 `vitest.regression.config.ts`，并纳入原先只在 `test:related` 中运行的 10 个集成测试文件（60 项，迁移前已确认全部通过）。

**宿主拆分**（本提交）。模型与按角色预设的装配移到 [role-providers.ts](../../../desktop/host/role-providers.ts)，Core 记忆按模型分组的 runner 移到 [python-worker.ts](../../../desktop/host/memory/python-worker.ts)，散落在 5 处的默认模型与端点统一为 [provider-defaults.ts](../../../desktop/provider-defaults.ts)。角色决策管线从构造函数中的闭包改为私有方法 `#decide`，逻辑原样搬移。`WorldHostCore` 构造函数由约 180 行降到约 75 行。

有意保留：
- 调度（`#activateCharacters`、`#activateAutonomous`）和状态投影仍在 `WorldHostCore` 中。它们与大量可变运行状态交织，拆分需要配合真实试玩，本轮不动。
- 创作者查询需要读取十余个私有字段，抽出只会把耦合换成大参数对象，保留在类内。
- world-pack 中 Phase 7/Phase 8 两代格式配置、V1–V3 源文件解析器，以及 `SceneDecisionService` 的 v1 分支仍可到达。它们是多代兼容层，是否删除需先确认现存世界包与存档，未在本轮改名或删除。（第五轮核对后更正：这些分支只在自身测试中可达，已删除或改名，见下文。）

运行时身份新增 `role-providers.ts` 与 `provider-defaults.ts`，身份再次改变，旧末端回合同样不迁移。

验证：拆分后默认回归 **89 个文件、757 项全部通过**（串行，435.92 秒）；全部包内单元测试 61 个文件、696 项通过；typecheck、lint、边界检查、文档链接检查、`launcher:check`、`launcher:build`、`desktop:build` 通过。本轮之前用户已完成一次真实试玩；本轮之后未再试玩，Python Core 离线回归、Rust 检查与便携包构建未运行。

## 第五轮：多代兼容层核查与删除（2026-10-21）

基点为 `27979f1`（第四轮末），分支 `codex/legacy-compat-cleanup-20261021`，三个代码提交加本节文档。第四轮把下列分支记为“仍可到达”，本轮逐项核对后结论不同：它们只在自身测试中可达，生产路径和全部示例包都走不到。

**证据。** 改动前用当前编译器和宿主安装的交互包编译 `examples/world-packs/` 下全部 22 个带源清单的世界包：18 个为 `worldpack-source/v5`，全部编译成功，`contentPack.runtimeCapabilities.sceneDecisionVersion` 均为 2，scene-decision 插件锁均为 `2.0.0`；`ai-girls-awaken`（v4）、`model-girls-home`（v3）、`rainy-road-companions`（v2）、`tavern-social`（v1）在源清单校验阶段即被拒绝（缺 `interactionFile`、`manifestationFile`、`reactionFile`、`cognitionFiles`），走不到任何文件级解析器。存储层 `runtimeManifestFromStored` 只接受 Manifest v10，且要求 `contentPack` 存在、`sceneDecisionVersion` 为 2，因此已有存档同样得不到旧分支。每个提交后重新编译这 18 个包，packHash、manifestHash、genesisHash 与改动前逐字节一致；注册表哈希也与改动前一致。

| 对象 | 可达性与使用者 | 结论 |
| --- | --- | --- |
| `PHASE7_CORE_PROFILES`、`copyCoreProfiles`、`profileAt` | 只被 v1 的 `parseWorldPackWorldSource` 和 `pluginLocksAt` 的默认参数使用；后者唯一调用者显式传入 Phase 8 配置 | 删除（`9cbda65`） |
| v1 的 world / entities / characters / scenes 解析器及其专用辅助函数、类型 | 仓库内零调用（含 desktop、tests、apps） | 删除（`9cbda65`） |
| `parseWorldPackCharactersSourceV2` | 只有自身测试；编译器用 V3，V3 复用同一 `parseCharacterV2` 校验 | 删除导出，测试改测 V3（`9cbda65`）。原测试中一条 `world-pack-characters-source/v2` 哈希断言只存在于测试、且上方 `toEqual` 已固定完整结果，随输入版本变化删除 |
| `PHASE8_CORE_PROFILES` 等仅剩一代的名字 | 可达，是当前唯一配置 | 改名 `WORLD_PACK_CORE_PROFILES`、`parseWorldPackWorldSource`（原 `…V2`，实际读 `worldpack-world/v1` 文件）、`coreProfilesAt`、`exactLockSetAt`、`genesisSource` 等；作者诊断去掉 “Phase 7/8” 字样（`9cbda65`） |
| 实体 V2、角色 V3、场景/记忆/认知/文档 V2 解析器 | 可达；后缀对应示例包文件里实际写的 `schemaVersion` | 保留原名，名字描述的是文件格式版本 |
| `SceneDecisionService` v1（`#legacyDecision`、`legacySceneState`） | 只有用默认参数构造服务的测试可达；world-application 对 `1.0.0` 插件与能力 2 的组合本来就拒绝 | 删除，服务不再带版本参数，决策字段改为必填；两条 v1 测试迁到 v2 事件上，保留生命周期、位置、可见性、可用性过滤与损坏可见性前缀的覆盖（`bf4324a`） |
| `phase8SceneState`、`phase8Speech`、`phase8Audience` | 可达，是当前唯一实现 | 改名 `currentSceneDecisionStates`、`resolveSpeech`、`actionAudience`（`bf4324a`）。拒绝原因文本（如 “invalid for Manifest v4”）会写入事件，未改 |
| `registries(1..4)` → `phase8ManifestRegistries` → `manifestationManifestRegistries` → `interactionManifestRegistries` | 外部只调用链尾的 `characterInteractionManifestRegistries`；`registries` 只以 2 调用 | 压平为一份按用途分组的名单，四个注册表哈希与原链逐字节一致（`041d7f5`） |
| `'phase8-vocabulary/v1'` 等哈希域、`world-pack-*-id/v2` 等 ID 域 | 编译包与存储 Manifest 携带这些锁哈希 | 不改；在定义处注明原因 |

**接受的限制与后续候选**（本轮未处理）：

- 上述 4 个旧版本示例包和两个旧编译产物（`ai-girls-awaken.worldpack.json` 为 `worldpack/v4`，`model-girls-home.worldpack.json` 为 `worldpack/v3`）当前编译器与宿主都无法使用；`rainy-road-companions` 仍被 `compiler-v5.test.ts` 当作素材在测试内升级为 v5。是删除、迁移到 v5 还是标为历史素材，需要单独决定。
- kernel 中 `currentSceneStates`（interactions.ts）与 `currentSceneDecisionStates`（scene-state.ts）是两份相近的场景归约，前者不带 `locationId`、错误文本不同。合并会改变错误路径，留作单独整理。
- 同类的多代分支还有 `cognitiveMemoryVersion` 的 1/2 选择、`CompiledWorldManifest.rulebook.version: 1 | 2 | 3 | 4` 与 `rulebook.version >= 4` 判断，本轮未核对。
- 未读取 `D:/worlds` 下的历史存档：存储层只接受 v10 Manifest，本轮删除的分支在 v10 存档上本来就不可达，且哈希未变。

验证：`corepack pnpm@11.7.0 check` 中边界检查（264 个生产文件）、typecheck、lint 通过；默认回归 **89 个文件中 88 个通过，757 项中 756 项通过**。唯一失败是 `tests/desktop/story-nodes.test.ts` 中需要本机 Core 记忆 Python 环境的一项：新 worktree 没有 `.tmp/hindsight-vector-venv`。在同一环境下对基点 `27979f1` 单独运行该文件，以同样的错误失败；借用其他检出的 Python 环境后两边又同样报 “Core 初始化失败”，因此判定为本机环境缺失，不是本轮回归，但该项在本轮没有实际通过。全部包内单元测试 `vitest run --config vitest.config.ts packages` **61 个文件、696 项通过**；`node scripts/docs/check-links.mjs` 通过。示例包哈希对比如上。未运行真实模型试玩、`launcher:check`、`desktop:build`、Python Core 离线回归；本轮只删除不可达分支和改名，角色可见行为预期不变，但没有试玩验收。
