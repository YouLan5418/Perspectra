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
