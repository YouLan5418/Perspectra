# 宿主整理工作树审查（2026-10-21）

> **审查对象：** `D:\DeepSeek Harness\Perspectra-code-cleanup-20261021`，分支 `codex/code-organization-20261021`，HEAD `bd4e970`，基点 `717ed6c`。
>
> **性质：** 只读审查。没有修改该工作树的代码、文档或提交；审查结束时 `git status --porcelain` 为空。文中的绝对链接指向该工作树，目录移动或删除后会失效。
>
> **结论：** 整理方向正确、完成度较高。上一轮审查的三个结构性 P0（正式宿主在 `tests/experiments`、默认 Core 在 `experiments`、生产包反向依赖实验目录）已解决；核心命名项基本落地。仍有 **1 个真实回归**（Electron 源码入口仍指向已删除文件）、1 个边界检查盲区，以及文档、历史测试和 CI 的收尾问题。可以作为合并候选，但建议先修 P1/P2。

---

## 1. 审查对象与方法

### 1.1 工作树状态

- 分支：`codex/code-organization-20261021`
- HEAD：`bd4e970 refactor: organize game host and Core memory ownership`
- 基点：`717ed6c`
- 变更规模：252 个文件，1480 insertions / 1358 deletions（`git diff --stat 717ed6c..HEAD`）
- 工作树状态：干净（审查前、审查后均为 0 个变更）

### 1.2 方法

1. 阅读整理说明 [code-organization-20261021.md](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/docs/current/studies/code-organization-20261021.md>)。
2. 用 `git diff --name-status 717ed6c..HEAD` 核对迁移/重命名清单。
3. 对生产边界做静态检索：`packages`、`apps`、`desktop` 是否还引用 `tests/experiments` 或 `experiments/{activity-memory,hindsight-core}`。
4. 逐项抽查整理声明对应的源码：宿主入口、HTTP、Core 记忆、决策格式、网关适配、创作者接口、历史脚本、构建/发行/身份哈希。
5. 运行只读检查和测试：边界检查、类型检查、Launcher 类型检查、Lint、宿主 44 项测试、文档链接检查。
6. 对当前文档做一次全量本地链接扫描，区分“迁移导致”的断链和既有的 `.tmp`/output 断链。

### 1.3 没有做的事

- 没有重跑完整默认测试（说明中为 72 文件、651 项）；只重跑了 `tests/host` 44 项。
- 没有运行真实模型试玩、Ollama/OpenRouter、便携发行包构建、Rust/ONNX 原生加载。
- 没有启动 Electron 或 Tauri 图形界面；Electron 路径问题是静态检查结论。
- 没有修改被审工作树；所有验证命令均为只读或使用其既有测试临时目录。

---

## 2. 实际验证结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 生产边界 | `node scripts/check-host-boundaries.mjs` | 通过，258 个生产文件 |
| 根类型检查 | `corepack pnpm@11.7.0 typecheck` | 通过 |
| Launcher 类型检查 | `corepack pnpm@11.7.0 --filter @perspectra/launcher typecheck` | 通过 |
| Lint | `corepack pnpm@11.7.0 lint` | 0 warnings / 0 errors，400 个文件 |
| 宿主测试 | `corepack pnpm@11.7.0 test:related tests/host --maxWorkers=1` | 5 个文件、44/44 通过 |
| 文档导航 | `node scripts/docs/check-links.mjs` | 通过，12 页、398 个本地链接 |
| 全量默认测试 | `corepack pnpm@11.7.0 test --maxWorkers=1` | **未重跑**；说明称 651 项通过，本次未独立复核 |
| 便携/真实模型 | 构建脚本、真实 provider | **未运行** |

补充：根类型检查覆盖 `packages`、`tests`、`desktop` 和 `experiments/jev-narrative-auditor/scripts`；历史 `experiments/hindsight-core/tsconfig.json` 不在其中，单独检查会失败（见 P2-2）。

---

## 3. 改善确认

### 3.1 生产宿主已从测试目录移出

- 正式入口从 `tests/experiments/playtest-web-entry.ts` 迁移到 [desktop/host/web-entry.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/host/web-entry.ts>)。
- 构建入口已改为 `desktop/host/web-entry.ts`（[package.json](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/package.json#L15>)、[build-portable.mjs](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/scripts/release/build-portable.mjs#L26>)）。
- Launcher 子进程改指 `desktop/host/web-entry.ts`（[launcher-core.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/launcher-core.ts#L471>)）。
- `tail-runtime-identity` 改为哈希 `desktop/host/*` 与新的 Python 根（[tail-runtime-identity.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/tail-runtime-identity.ts#L23-L34>)）。
- 故事分享改从 `desktop/host` 导入记忆与状态模块（[story-share.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/story-share.ts#L10-L11>)）。
- `packages`、`apps`、`desktop` 对 `tests/experiments` 的静态 import 为 0；边界检查报告 258 个生产文件通过。

### 3.2 默认 Core 记忆已从 `experiments` 移出

- 运行实现迁到 `desktop/host/memory/python/{core,bridge}`；发行脚本从新位置复制（[build-portable.mjs](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/scripts/release/build-portable.mjs#L31-L33>)）。
- Node worker 与 `PERSPECTRA_RUNTIME_ROOT` 的发行路径同步（[python-worker.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/host/memory/python-worker.ts#L13-L17>)）。
- 运行时身份哈希包含新的 Python 根（[tail-runtime-identity.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/tail-runtime-identity.ts#L33-L42>)）。
- 新增发行布局验证脚本 [verify-core-layout.mjs](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/scripts/release/verify-core-layout.mjs>) 与说明；当前说明记录 38 项 Python 离线回归通过。

### 3.3 命名核心项已落地

| 旧名 | 新名/位置 | 状态 |
| --- | --- | --- |
| `playtest-frozen-runtime.ts` / `FrozenWorldPlaytestRuntime` | `desktop/host/world-runtime.ts` / `WorldHostRuntime` | 已改 |
| `playtest-server.ts` / `PlaytestState` | `desktop/host/http-server.ts` / `HostState` | 已改 |
| `playtest-memory-core.ts` / `PlaytestMemoryCore` | `desktop/host/memory/core-memory.ts` / `CoreMemoryAdapter` | 已改 |
| `hindsight-python.ts` / `hindsightPython()` | `desktop/host/memory/python-worker.ts` / `corePythonExecutable()` | 已改 |
| `local-prototype-turn-call.ts` / `localPrototypeTurnCall` | `desktop/host/gateway-turn-call.ts` / `gatewayTurnCall` | 已改 |
| `decideActivityFormat`（在 `pack-activity.ts`） | `desktop/host/decision-format.ts` / `decideWithFormatRetry` | 已拆出并改名 |
| `creator-debug.ts` / `CreatorDebugSnapshot` | `desktop/host/creator-inspection.ts` / `CreatorInspectionSnapshot` | 已改（HTTP 路由 `/api/creator-debug` 有意保留） |
| `variables`（创作者快照） | `statusTruth` | 已改 |

错误文案也同步了：Core 缺环境/失败信息不再称“实验记忆”，而是“Core 记忆”（[python-worker.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/host/memory/python-worker.ts#L25-L41>)）。

### 3.4 创作者语义已从“变量”切到“状态”

- 宿主快照字段改为 `statusTruth`（[creator-inspection.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/host/creator-inspection.ts#L25>)），运行时用 `PackStatus.truth()` 填充（[world-runtime.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/host/world-runtime.ts#L186-L192>)）。
- 创作者页面 `VariablesView.vue` 改为 [StatusView.vue](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/apps/launcher/src/creator/StatusView.vue>)，导航改为“状态”。
- Mock 改为客观状态字段（`timeOfDay/gateOpen/energy`），不再伪造情绪/信任值（[mock.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/apps/launcher/src/creator/mock.ts#L203>)）。
- 导出说明改为“世界历史、角色私密状态、长期记忆和已提交的玩法状态”，不再写“包变量”（[ExportDialog.vue](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/apps/launcher/src/components/ExportDialog.vue#L43>)）。
- 活动自己的 public/private/internal“变量”保留，语义正确。

### 3.5 死代码与历史资产

- 无引用的 `tests/experiments/playtest-page.ts` 已删除；宿主页为 `desktop/host/host-page.ts`。
- JEV 历史脚本移到 `experiments/jev-narrative-auditor/scripts/`，并新增说明，明确固定路径/外部调用/不可直接复跑（[scripts/README.md](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/experiments/jev-narrative-auditor/scripts/README.md>)）。
- Core 历史探针移到 `experiments/activity-memory/scripts/`，并标注历史输入绑定。
- 关系 spike 移到 `experiments/character-relations/archive/`，说明其已被 kernel/interactions-basic 取代。
- `goal-progress-search.ts` 文件改名为 `goal-progress-inspection-fixture.ts`；`official-demo.ts` 改名为 `official-prologue-offline.ts`；`tavern-card-slice.ts` 改名为 `tavern-black-shores-slice.ts`。
- 宿主测试集中到 `tests/host/`，44 项通过。

---

## 4. 仍未完全收口的问题

### P1-1. Electron 源码入口仍指向已删除文件

**事实：**

[desktop/main.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/main.ts#L108>) 在非打包分支仍拼：

```ts
: join(repository, 'tests', 'experiments', 'playtest-web-entry.ts')
```

而 `tests/experiments/playtest-web-entry.ts` 已随迁移删除；打包分支的 `dist/backend/playtest.mjs` 仍有效。

**影响：**

- `pnpm desktop`（源码运行 Electron）在启动后端时会失败；打包后的 Electron 仍可用。
- README 仍声明“旧 Electron 入口 `desktop` / `desktop:release` 仍保留”，因此这不是已退役入口的预期失败。
- 该问题不会被类型检查发现（是字符串路径），也未被新的边界检查捕获。

**建议：**

- 若保留 Electron 入口：改指 `desktop/host/web-entry.ts`（或构建产物），并补一次源码启动验证。
- 若决定退役：删除 `package.json` 的 `desktop` 脚本、`desktop/main.ts` 和 README 中“仍保留”的声明，避免留下坏入口。

### P1-2. 边界检查有盲区，恰好漏掉了上面的路径

**事实：**

[check-host-boundaries.mjs](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/scripts/check-host-boundaries.mjs#L19>) 只匹配连续的：

```js
/(?:tests\/experiments|experiments\/(?:activity-memory|hindsight-core))\//
```

`main.ts` 使用的是 `'tests', 'experiments', 'playtest-web-entry.ts'` 分段拼接，因此检查通过但实际路径已坏。

**影响：**

“258 个生产文件通过”不能证明不存在旧实验路径；这次真实回归就是反例。

**建议：**

- 在检查前把源码中的引号、逗号、空白归一化，或同时禁止 `playtest-web-entry` 等旧文件名。
- 增加一个回归用例：包含分段拼接的 fixture 必须让检查失败。
- 把检查范围与“生产入口清单”绑定，避免只靠正则。

### P2-1. `docs/current` 仍有 33 个迁移导致的断链

**事实：**

整理说明称已统一修改“源码、测试、构建与引用”，但对 `docs/current` 全量扫描后：

- 迁移导致的断链：**33 个**，分布在 13 个文件。
- 另有既有 `.tmp`/output 断链（例如截图、运行报告）不归因于本次迁移。

典型例子：

- [frontend-plugin-capability-boundary.md](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/docs/current/studies/frontend-plugin-capability-boundary.md>) 仍链接 `tests/experiments/playtest-frontend-assets.ts`、`playtest-host-page.ts`、`playtest-server.ts`、`playtest-pack-web.ts`。
- [dynamic-scheduling-20261011.md](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/docs/current/studies/dynamic-scheduling-20261011.md>) 仍链接 `playtest-frozen-runtime.ts`、`playtest-tail-runtime.ts`、`playtest-launch.ts`。
- `core-utility-timing-20261010.md`、`prologue-performance-20261010.md`、`tavern-card-slice-20261018.md`、`ark-endfield-playtest-20261020.md` 等也有旧路径。
- 当前指南仍有旧术语，例如 [activity-and-variables.md](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/docs/current/guides/activity-and-variables.md#L208>) 还写“调试接口的 `variables` 显示全部真实值”；[creator-playtest.md](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/docs/current/guides/creator-playtest.md#L23>) 仍写“变量”。

**原因：**

[check-links.mjs](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/scripts/docs/check-links.mjs#L8-L12>) 只检查 README、docs/README 和 architecture 页面，不检查 `docs/current/studies` 与 `docs/current/guides`；所以“12 页、398 链接通过”不能覆盖这些断链。

**建议：**

- 修当前指南/研究中的可点击链接；对确属历史快照的 studies，在文首标注“历史路径，不再维护”，并保留旧名说明。
- 把链接检查扩展到 `docs/current/**/*.md`（至少 studies/guides），或增加一次独立的全量检查。
- 统一“变量/状态”术语；活动 public/private/internal 变量除外。

### P2-2. 历史记忆测试与 README 命令已失配

**事实：**

- `core.py`、`vector_core.py`、`episode_core.py` 等已迁到 `desktop/host/memory/python/core`，但 `experiments/hindsight-core` 仍保留 `test_core.py`、`test_vector_core.py`、`test_projections.py` 等，测试仍 `import core`。
- 实际执行：

```powershell
python -c "import sys; sys.path.insert(0,'experiments/hindsight-core'); import core"
# ModuleNotFoundError: No module named 'core'
```

- [hindsight-core/README.md](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/experiments/hindsight-core/README.md#L36>) 仍保留 `python -m unittest discover -s experiments/hindsight-core -p test_core.py`。
- 单独运行 `tsc -p experiments/hindsight-core/tsconfig.json --noEmit` 还会报旧 `experimentalCharacterRequest` / `releaseForExperimentalHost` 错误（4 个）。
- [activity-memory/README.md](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/experiments/activity-memory/README.md#L65-L66>) 的“文件职责”仍指向已删除的 `tests/experiments/playtest-memory-core.ts` 与 `playtest-frozen-runtime.ts`。
- 移到 `experiments/activity-memory/scripts/` 的 `core-utility-*` 仍把 `sys.path` 指向 `experiments/activity-memory`，而不是新的 `desktop/host/memory/python/bridge`。

**判断：**

顶部声明“历史研究记录、不能作为现行入口说明”是合理的，但“运行”段和“文件职责”表仍给出会失败的命令/路径，读者照做会得到 ImportError 或断链。

**建议：**

- 要么像 [desktop/host/memory/README.md](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/host/memory/README.md#L25-L34>) 那样补上 `PYTHONPATH`（core + bridge + 历史辅助目录）并验证一组能跑的回归；
- 要么把这些历史测试/命令明确标为“不可复跑，仅保留记录”，并删除可执行命令；
- 修正 `activity-memory/README` 的文件职责表和 `core-utility-*` 的 `sys.path`；
- 若 `hindsight-core/tsconfig.json` 已不再维护，删除或标注“历史类型检查，预期失败”。

### P2-3. 宿主 44 项测试不在默认/CI 测试集

**事实：**

- [vitest.prototype.config.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/vitest.prototype.config.ts#L9-L13>) 的默认 include 只有 `tests/prototype/**/*.test.ts`（以及两个包测试）。
- [.github/workflows/p0.yml](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/.github/workflows/p0.yml#L30>) 只跑 `pnpm test`。
- `tests/host` 的 44 项需要手动 `test:related tests/host` 才跑。

**影响：**

宿主迁移后最直接的回归套件不在 CI 中；未来改动可能在本机通过 `pnpm check`，但没跑宿主测试。

**建议：**

- 把 `tests/host/**/*.test.ts` 加入默认 `vitest.prototype.config.ts`，或在 CI 增加 `test:related tests/host --maxWorkers=1` 步骤；两者选其一即可。

### P3. 残留命名与小文案

这些不影响运行，但会削弱“按职责更名”的完成度：

- `tests/prototype/playtest-memory-core.test.ts` 测的是 `desktop/host/memory/core-memory.ts`；
- `tests/prototype/local-prototype-turn-call.test.ts` 测的是 `gatewayTurnCall`；
- `tests/prototype/creator-debug.test.ts` 测的是 `creator-inspection`（路由保留是有意为之，测试名可随组件名）；
- [goal-progress-inspection-fixture.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/tests/experiments/goal-progress-inspection-fixture.ts#L17>) 仍导出 `goalProgressSearchPackage`；
- [tavern-black-shores-slice.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/tests/experiments/tavern-black-shores-slice.ts#L94>) 的 usage 文本仍写 `tavern-card-slice.ts`，且函数仍叫 `createTavernSlice`；
- [http-server.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/host/http-server.ts#L87>)、[world-runtime.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/host/world-runtime.ts#L296>)、[launch-arguments.ts](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/host/launch-arguments.ts#L37>) 仍有 `playtest runtime failure`、`playtest Pack`、`unsupported playtest argument` 等旧错误串；
- [core_bridge.py](<D:/DeepSeek Harness/Perspectra-code-cleanup-20261021/desktop/host/memory/python/bridge/core_bridge.py#L1>) 首行仍称 “experimental core”。

### 有意保留、不算问题的项

- `x-playtest-token` header、`/api/creator-debug` 路由、发行文件名 `playtest.mjs`：说明中明确保留，属于外部兼容。
- `HCW_HINDSIGHT_PYTHON`、`HCW_HINDSIGHT_ONNX_DIR` 等环境变量：保留现有安装方式的兼容选择。
- `.tmp/web-playtest-*` 默认目录：属于运行目录命名，不影响职责边界。

---

## 5. 与[上一轮审查](misleading-code-audit-20261021.md)的对照

| 上一轮问题 | 本次状态 | 说明 |
| --- | --- | --- |
| `tests/experiments` 承担正式宿主 | **已解决** | 入口/HTTP/宿主/创作者接口迁到 `desktop/host` |
| `experiments` 承担默认 Core | **已解决** | Python core/bridge/vendor 迁到 `desktop/host/memory` |
| 生产包反向依赖测试目录 | **已解决** | `packages/apps/desktop` 静态 import 为 0 |
| `decideActivityFormat` 范围错误 | **已解决** | 拆成 `decision-format.ts` / `decideWithFormatRetry` |
| `localPrototypeTurnCall` 名字错误 | **已解决** | 改为 `gatewayTurnCall` |
| `hindsightPython` 名字/错误文案 | **已解决** | 改为 `corePythonExecutable`，错误改“Core 记忆” |
| `Frozen/Playtest` 宿主命名 | **基本解决** | 主体已改；少量错误串/测试名残留 |
| 创作者 `variables` 显示状态 | **已解决** | `statusTruth` + 状态页 + mock/导出修正 |
| 死文件 `playtest-page.ts` | **已解决** | 已删除 |
| 历史 JEV/Core 探针、关系 spike | **部分解决** | 已迁移并标注；部分历史命令/文档路径仍失效 |
| `official-demo` / `goal-progress-search` / `tavern-card-slice` 命名 | **部分解决** | 文件已改名，符号/usage/文档仍有旧名 |
| 生产边界防回归 | **部分解决** | 新增检查，但存在分段路径盲区 |

---

## 6. 合并建议

### 合并前必须处理

1. **P1-1**：修 Electron 源码路径，或明确退役并删除入口/声明。
2. **P1-2**：补边界检查的分段路径盲区，至少加一个回归用例。

### 合并前建议处理

3. **P2-1**：修复 `docs/current` 的 33 个迁移断链，扩展链接检查范围，统一“状态/变量”术语。
4. **P2-2**：给历史记忆测试补可运行的 `PYTHONPATH` 命令，或明确标注不可复跑并删除坏命令。
5. **P2-3**：把 `tests/host` 纳入默认/CI 测试集。

### 可以随后清理

6. **P3**：残留测试文件名、函数名、usage 文本、错误串和 Python docstring。

### 不需要回滚

本次整理没有破坏现有结构；生产构建、Launcher 路径、宿主测试和类型检查均通过。上述问题属于收尾和防回归，不是方向性错误。

---

## 7. 验证边界

- 只读审查，没有修改被审工作树；`git status` 审查前后均为空。
- 未重跑完整 651 项默认测试；说明中的完整通过记录未被独立复核。
- 未运行真实模型、Ollama/OpenRouter、便携发行包、Rust/ONNX 原生加载、Electron/Tauri GUI。
- Electron 问题是静态路径检查结论，未实际启动 `pnpm desktop`。
- 33 个断链是本地 Markdown 链接扫描结果；未判断每个历史 studies 是否应保留旧路径作为历史证据。
- 本报告只覆盖“本次整理是否解决了上一轮误导性问题”，不替代完整代码评审或真实玩法验收。

---

## 附录 A：主要审查命令

~~~powershell
git -C "D:\DeepSeek Harness\Perspectra-code-cleanup-20261021" status --porcelain=v1
git -C "D:\DeepSeek Harness\Perspectra-code-cleanup-20261021" diff --name-status 717ed6c..HEAD
node scripts/check-host-boundaries.mjs
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 --filter @perspectra/launcher typecheck
corepack pnpm@11.7.0 lint
corepack pnpm@11.7.0 test:related tests/host --maxWorkers=1
node scripts/docs/check-links.mjs
~~~

## 附录 B：迁移导致的断链示例

以下均为 `docs/current` 内指向已迁移文件的链接（节选）：

- `tests/experiments/playtest-frozen-runtime.ts` → `desktop/host/world-runtime.ts`
- `tests/experiments/playtest-tail-runtime.ts` → `desktop/host/tail-runtime.ts`
- `tests/experiments/playtest-server.ts` → `desktop/host/http-server.ts`
- `tests/experiments/playtest-memory-core.ts` → `desktop/host/memory/core-memory.ts`
- `tests/experiments/local-prototype-turn-call.ts` → `desktop/host/gateway-turn-call.ts`
- `tests/experiments/pack-activity.ts` → `desktop/host/pack-activity.ts`
- `tests/experiments/tavern-card-slice.ts` → `tests/experiments/tavern-black-shores-slice.ts`
- `tests/experiments/core-utility-*.py` → `experiments/activity-memory/scripts/core-utility-*.py`
- `experiments/activity-memory/core_bridge.py` → `desktop/host/memory/python/bridge/core_bridge.py`

---

*本报告写入当前工作树的 `docs/current/studies/`，不修改被审工作树。*
