# 误导性代码与命名审查（2026-10-21）

> **状态：只读审查记录。** 本文没有修改任何代码，也没有运行会调用真实模型、OpenRouter 或付费接口的脚本。
>
> **范围：** `tests/experiments/` 全部 139 个文件；顶层 `experiments/`；`desktop/`、`packages/`、`apps/launcher`、`scripts/` 中对这些目录的引用。
>
> **结论：** 最严重的问题不是单个文件起错名，而是三层职责错位——**`tests/experiments` 承担正式宿主，`experiments` 承担默认 Core 记忆，生产包反向依赖这两个"实验"目录**。单文件命名问题大多由这三层错位派生。

---

## 1. 摘要

1. **`tests/experiments` 不是测试目录。** 桌面构建、便携发行包、启动器、故事分享和运行时身份哈希都直接依赖它（第 3.1 节）。
2. **`experiments` 不是纯证据目录。** 默认 Core 记忆运行 `experiments/activity-memory/core_bridge.py`，发行包会复制两个 `experiments` 子目录（第 3.2 节）。
3. **生产包反向依赖测试代码。** `packages/frontend`、`apps/launcher`、`desktop` 从 `tests/experiments` 导入类型或运行时代码（第 3.3 节）。
4. **至少 26 个 `tests/experiments` 文件属于生产面**，包括网页入口、HTTP 服务、宿主运行时、记忆桥、活动/状态运行时、创作者只读接口和故事节点校验（附录 A）。
5. **单文件层面最误导的是**：`decideActivityFormat` 实际处理所有角色回合；`localPrototypeTurnCall` 是默认请求路径；`hindsightPython()` 只返回解释器路径；`official-demo` 是零模型调用回归；`playtest-page.ts` 是死文件；创作者页面的"变量"实际显示状态真值（第 4～6 节）。
6. **一批 JEV/Core 脚本名字像通用工具，实际写死某次历史运行的目录、seq 或另一个工作树的绝对路径**，换环境会失败或分析错数据（第 5 节）。

---

## 2. 审查方法与判定

### 2.1 方法

- 对 `tests/experiments` 的 139 个文件逐一核对文件名、文件头注释、导入关系和入口调用点。
- 对与生产接壤、或名称明显可疑的约 40 个文件阅读正文、参数处理和输出路径。
- 用只读检索核对生产引用：`git grep -n "tests/experiments"`、`git grep -n "experiments/activity-memory\\|experiments/hindsight-core"`。
- 对照现有说明文档，区分"文档已承认但代码未收口"与"文档和代码都未提示"。

### 2.2 判定标准

本文把问题分为四类，严重度只表示"误导后造成错误决定的可能性"，不表示代码一定存在运行时缺陷：

| 类型 | 含义 | 典型后果 |
| --- | --- | --- |
| 结构边界 | 目录名或所有权与真实职责相反 | 删"测试"导致游戏/发行包损坏 |
| 名称与职责 | 文件、函数、字段名承诺的行为与实际不同 | 改错文件、漏改路径、错误评估能力 |
| 历史绑定 | 名字像通用工具，实际只对某次运行有效 | 换环境失败、分析旧数据得出错误结论 |
| 旧名新义 | 旧概念名承载了新语义 | 创作者/玩家看到不存在的"变量" |

**事实与判断分开写。** 带"事实"的条目有源码或检索证据；带"影响"的是审查判断。

---

## 3. 结构性问题（P0）

### 3.1 `tests/experiments` 是正式运行时

**事实：**

- [package.json](../../../package.json#L15) 的 `desktop:build` 把 [playtest-web-entry.ts](../../../tests/experiments/playtest-web-entry.ts) 打包成发行用的 `dist/backend/playtest.mjs`；[package.json](../../../package.json#L19-L20) 的 `experience:web` 也指向它。
- [desktop/launcher-core.ts](../../../desktop/launcher-core.ts#L471) 在未设置 `PERSPECTRA_RUNTIME_ROOT` 时直接以 tsx 启动这个测试目录入口。
- [scripts/release/build-portable.mjs](../../../scripts/release/build-portable.mjs#L26) 把同一入口编进便携发行包。
- [desktop/tail-runtime-identity.ts](../../../desktop/tail-runtime-identity.ts#L23-L30) 把 12 个 `tests/experiments/*.ts` 文件与 `package.json`、`pnpm-lock.yaml` 一起算作运行时身份哈希。
- [desktop/story-share.ts](../../../desktop/story-share.ts#L10-L11) 在真实故事导入导出逻辑中导入 `PlaytestMemoryCore` 与 `PackStatus`；[#L108](../../../desktop/story-share.ts#L108)、[#L113](../../../desktop/story-share.ts#L113) 实际执行它们。
- [desktop/main.ts](../../../desktop/main.ts#L9)、[desktop/renderer.ts](../../../desktop/renderer.ts#L4) 从 [playtest-tuning.ts](../../../tests/experiments/playtest-tuning.ts) 导入。
- [scripts/release/verify-portable.mjs](../../../scripts/release/verify-portable.mjs#L6) 从测试目录导入宿主页面，用于发行校验。

**影响：**

- 删除、移动或重命名"测试文件"会破坏游戏启动、发行包、故事节点兼容与发行验证。
- 代码评审者会按 `tests/` 的惯例低估这些文件的稳定性和权限边界。
- 现有文档已经承认这一点：[modules.md](../architecture/modules.md#L11) 称该目录"当前网页宿主与实验驱动混放"，[phase8 迁移审计](./phase8-prototype-transition-audit-20261018.md#L41) 称"实验宿主已承担正式运行职责，目录没有收口"。代码结构没有变化。

### 3.2 `experiments` 是默认记忆实现

**事实：**

- [build-portable.mjs](../../../scripts/release/build-portable.mjs#L31-L33) 把 `experiments/hindsight-core/*.py`、`experiments/activity-memory/*.py` 复制进发行运行时。
- [tail-runtime-identity.ts](../../../desktop/tail-runtime-identity.ts#L33) 把这两个目录的 Python 文件计入运行时身份。
- [playtest-memory-core.ts](../../../tests/experiments/playtest-memory-core.ts#L10) 导入 `experiments/hindsight-core/alias-history.ts`。
- [hindsight-python.ts](../../../tests/experiments/hindsight-python.ts#L27) 与[同一文件的第 55 行](../../../tests/experiments/hindsight-python.ts#L55) 执行 `experiments/activity-memory/core_bridge.py`。
- 默认 Core 记忆不是可选实验：[playtest-launch.ts](../../../tests/experiments/playtest-launch.ts#L59-L62) 说明 Core 是默认值，原生记忆是显式的离线选择。
- 但 [experiments/README.md](../../../experiments/README.md#L1) 开头称"实验证据"，[README.md](../../../README.md#L210) 也称"实验代码与证据"。

**影响：**

- 把 `experiments` 当历史证据清理，会让默认游戏在启动或首次召回时失败。
- "实验"一词会让维护者误以为这些 Python 文件可以不跟 `packages` 一起做类型、许可、发行和兼容检查。

### 3.3 生产包反向依赖"测试"代码

| 生产位置 | 依赖 | 性质 |
| --- | --- | --- |
| [packages/frontend/src/player-view.ts](../../../packages/frontend/src/player-view.ts#L2) | `playtest-server.ts` | 类型导入，运行时擦除，但类型检查依赖测试目录 |
| [apps/launcher/src/creator/source.ts](../../../apps/launcher/src/creator/source.ts#L1-L3) | `creator-debug.ts`、`creator-history.ts`、`creator-records.ts` | 类型导入 |
| [desktop/story-share.ts](../../../desktop/story-share.ts#L10-L11) | `playtest-memory-core.ts`、`pack-status.ts` | **运行时代码** |
| [desktop/main.ts](../../../desktop/main.ts#L9)、[desktop/renderer.ts](../../../desktop/renderer.ts#L4) | `playtest-tuning.ts` | 运行时代码/类型 |
| [desktop/launcher-core.ts](../../../desktop/launcher-core.ts#L19-L20) | `playtest-pack-web.ts`、`hindsight-python.ts` | 运行时代码 |
| [scripts/release/verify-portable.mjs](../../../scripts/release/verify-portable.mjs#L6) | `playtest-host-page.ts` | 发行验证代码 |

**影响：** `packages` 与 `apps` 无法独立构建或发布；"测试目录"成为公共 API 的事实来源。类型导入虽然不在运行时生效，但仍让 `tsc` 和 IDE 把测试目录当作上层依赖。

---

## 4. 名称与职责不符（P1）

### N1. `decideActivityFormat`：名字限定活动，实际处理所有角色决策

- 位置：[pack-activity.ts](../../../tests/experiments/pack-activity.ts#L24)。
- 事实：宿主对**每一个**角色 decision 都调用它，见 [playtest-frozen-runtime.ts](../../../tests/experiments/playtest-frozen-runtime.ts#L420)。它不仅做活动格式检查，还做有界重试、分支裁窄、字段诊断。
- 影响：只改活动路径会漏掉普通回合；读代码的人会以为普通回合没有格式修正。

### N2. `localPrototypeTurnCall`：名字像本机原型调试，实际是默认请求路径

- 位置：[local-prototype-turn-call.ts](../../../tests/experiments/local-prototype-turn-call.ts#L7-L8)。
- 事实：[playtest-frozen-runtime.ts](../../../tests/experiments/playtest-frozen-runtime.ts#L398) 对所有非 Google 的 local provider 角色调用它。它会把根 `oneOf` 展平、把唯一版本改成等值数值边界、按可用操作生成参数 schema。
- 影响：它承载协议兼容与安全边界，不是"本机调试小工具"；误删或误改会影响全部默认玩家。

### N3. `hindsightPython()`：名字像运行 Hindsight，实际只返回解释器路径

- 位置：[hindsight-python.ts](../../../tests/experiments/hindsight-python.ts#L8-L11)。
- 事实：真正执行的是 `core_bridge.py`（[#L27](../../../tests/experiments/hindsight-python.ts#L27)、[#L55](../../../tests/experiments/hindsight-python.ts#L55)）。`hindsight` 是记忆线的旧名，当前产品称 Core 记忆。
- 同文件把生产错误信息写成"实验记忆"（[#L32](../../../tests/experiments/hindsight-python.ts#L32)、[#L51](../../../tests/experiments/hindsight-python.ts#L51)）；[#L24](../../../tests/experiments/hindsight-python.ts#L24) 称"Experimental JSON bridge"。
- 影响：玩家/维护者会把默认记忆故障当成可选实验故障；排障时找错方向。

### N4. `FrozenWorldPlaytestRuntime` / `FrozenWorldRuntimeCore`：`frozen` 没有冻结语义

- 位置：[playtest-frozen-runtime.ts](../../../tests/experiments/playtest-frozen-runtime.ts#L134)、[#L1189](../../../tests/experiments/playtest-frozen-runtime.ts#L1189)。
- 事实：[isFrozenPackDirectory](../../../tests/experiments/playtest-frozen-runtime.ts#L108) 只检查源包是否为 `worldpack-source/v5`，不检查只读、快照或不可变性。第 1188 行注释称其为"Public runtime"。
- 影响："frozen"会被读成测试夹具或冻结世界；实际是可写、可提交、可生成新回合的正式宿主。

### N5. `PlaytestMemoryCore` / `playtest-memory-core.ts`：生产记忆核心

- 位置：[playtest-memory-core.ts](../../../tests/experiments/playtest-memory-core.ts#L53-L54)。
- 事实：它是 Core 记忆的宿主适配器，负责快照、授权来源查询、档案恢复和背景整理；[story-share.ts](../../../desktop/story-share.ts#L113) 在真实故事分享校验中使用。
- 影响：名字让人以为只在试玩里用，容易在重构时绕过其授权检查或恢复逻辑。

### N6. `createPlaytestServer` / `playtest-server.ts`：正式 HTTP API

- 位置：[playtest-server.ts](../../../tests/experiments/playtest-server.ts#L57)（`PlaytestRuntime`）、[#L153](../../../tests/experiments/playtest-server.ts#L153)（`createPlaytestServer`）。
- 事实：提交、活动、暂停、记忆刷新、故事保存、创作者查询等路由都在这里；[player-view.ts](../../../packages/frontend/src/player-view.ts#L2) 直接引用其类型。
- 影响：它是安全边界（token、来源校验、busy 状态），不是临时 mock server。

### N7. `playtest-*` 家族：生产模块带试玩前缀

除上述文件外，[playtest-web-entry.ts](../../../tests/experiments/playtest-web-entry.ts#L32)、[playtest-tail-runtime.ts](../../../tests/experiments/playtest-tail-runtime.ts#L19)、[playtest-view.ts](../../../tests/experiments/playtest-view.ts#L27)、[playtest-tuning.ts](../../../tests/experiments/playtest-tuning.ts#L11)、[playtest-launch.ts](../../../tests/experiments/playtest-launch.ts#L16) 都是生产面。名称共同制造"这是可丢弃试玩代码"的印象。

### N8. `playtest-frontend-assets.ts`：资产名，实际包含受信任前端服务器

- 位置：[playtest-frontend-assets.ts](../../../tests/experiments/playtest-frontend-assets.ts#L8)、[#L35](../../../tests/experiments/playtest-frontend-assets.ts#L35)、[#L41-L45](../../../tests/experiments/playtest-frontend-assets.ts#L41-L45)。
- 事实：文件导出 `createTrustedFrontendServer`，其 `trusted` CSP 允许 `unsafe-eval`、`script-src http: https:`、`connect-src http: https:`。文件头"Fixed public asset only"只对 `frontendAsset` 函数成立。
- 影响：安全审查者会低估该文件的权限边界；前端授权改动可能漏看这里。

### N9. `creator-debug.ts`：名字是调试，实际是创作者控制台正式只读接口

- 位置：[creator-debug.ts](../../../tests/experiments/creator-debug.ts#L4)、[#L25](../../../tests/experiments/creator-debug.ts#L25)。
- 事实：它定义 `CreatorDebugSnapshot`，被创作者页面读取；`variables` 字段现在装状态真值（见 U1）。
- 影响："debug"会让人以为可以随时删；实际是创作者可见能力的一部分。

### N10. `pack-activity.ts`：名字是包活动，实际是活动运行时 + 通用格式重试

- 位置：[pack-activity.ts](../../../tests/experiments/pack-activity.ts#L24) 起。
- 事实：文件包含活动脚本 VM、可见性/执行权限、Rulebook 包装、状态联动和 `decideActivityFormat`；`pack-activities.ts` 只是加载器。
- 影响：改活动加载会以为只动 `pack-activities.ts`，漏掉真正的运行时。

### N11. `official-demo.ts`：名字是演示，实际是零模型调用回归

- 位置：[official-demo.ts](../../../tests/experiments/official-demo.ts#L9-L10)、[#L22](../../../tests/experiments/official-demo.ts#L22)。
- 事实：provider 是 `ollama`，端点写 `127.0.0.1:1`，断言 `providerCalls=0`。真实模型演示是 [official-demo-live.ts](../../../tests/experiments/official-demo-live.ts#L12)。
- 影响：新人跑 `official-demo` 看不到演示，只会得到断言；也可能把这份"演示"当成角色能力样例。

### N12. `playtest-page.ts`：死文件，却最像"试玩页面"

- 位置：[playtest-page.ts](../../../tests/experiments/playtest-page.ts#L1)。
- 事实：全仓检索 `PLAYTEST_PAGE` / `playtest-page` 只有定义本身，没有引用。现行页面是 [playtest-host-page.ts](../../../tests/experiments/playtest-host-page.ts#L2)。
- 影响：编辑这个文件不会改变任何界面，而且它的旧版视觉和 `/narrate`、`/move` 提示会让人以为旧命令仍是当前交互。

### N13. `goal-progress-search.ts`：名字是搜索，实际是交互包 fixture

- 位置：[goal-progress-search.ts](../../../tests/experiments/goal-progress-search.ts#L17)。
- 事实：它定义 `goalProgressSearchPackage()`，为 `bounded-search` 场景提供"检查西侧目录架/借阅索引"的交互定义，不是检索工具。
- 影响：搜索代码的人会打开错误文件；改动可能误触实验包语义。

### N14. `tavern-card-slice.ts`：名字是 slice，实际是一次性世界包生成器

- 位置：[tavern-card-slice.ts](../../../tests/experiments/tavern-card-slice.ts#L30-L41)。
- 事实：硬编码角色"守岸人/椿"、必须命中第 3 条 `alternate_greetings` 且包含"花房"；换卡直接报错。
- 影响：被当成通用"酒馆卡 → 世界包"转换器复用时会连续失败；真正的通用探针是 [tavern-card-probe.ts](../../../tests/experiments/tavern-card-probe.ts#L1)。

### N15. `activity-memory-drive.ts`：名字是 drive，实际是四阶段流水线

- 位置：[activity-memory-drive.ts](../../../tests/experiments/activity-memory-drive.ts#L18-L19)。
- 事实：要求 `game|sources|build|probe` 四个阶段、不同前置产物和固定世界包 `ai-girls-hosted-guess`。
- 影响：把它当单次 driver 运行会在第二阶段失败；也不清楚每一步输出属于哪条实验线。

### N16. `character-relation-spike.ts`：被正式实现取代的原型

- 位置：[character-relation-spike.ts](../../../tests/experiments/character-relation-spike.ts#L47)、[#L99](../../../tests/experiments/character-relation-spike.ts#L99)。
- 事实：现行握手规则在 [kernel/interactions.ts](../../../packages/kernel/src/interactions.ts#L27) 与 [interactions-basic/basic.ts](../../../packages/interactions-basic/src/basic.ts#L135)；spike 只被自己的测试引用。
- 影响：`spike` 名称本身诚实，但 174 行接近正式规则的实现容易被误认为当前 Rulebook；两边行为若分叉会制造"测试通过但游戏不同"的假象。

---

## 5. 看起来通用，实际绑定某次历史运行（P1/P2）

这一族不会在名字或头部说明"仅适用于某次 run"，而是直接读固定路径、固定 seq 或另一个工作树的绝对路径。换环境后会失败，或者更糟：静默分析旧数据并得出看似有效的结论。

### H1. `jev-intervention-failure-probe.ts`

- [第 8 行](../../../tests/experiments/jev-intervention-failure-probe.ts#L8) 写死 `.tmp/jev-window-live-20260926-04/world.sqlite`；[#L15-L18](../../../tests/experiments/jev-intervention-failure-probe.ts#L15-L18) 写死 4 条负样本 seq。
- 名字是"failure probe"，实际是某一次失败窗口的分类复核；文件不存在时直接抛 SQLite 打开错误。

### H2. `jev-shadow-smoke.ts`

- [第 1 行](../../../tests/experiments/jev-shadow-smoke.ts#L1) 说"Public, manually authored fixtures only"，[#L27](../../../tests/experiments/jev-shadow-smoke.ts#L27) 却把结果追加到 `experiments/jev-narrative-auditor/results-shadow-local-window-2026-09-26.jsonl`。
- [#L26](../../../tests/experiments/jev-shadow-smoke.ts#L26) 创建真实分类器；[jev-shadow-claims-client.ts](../../../tests/experiments/jev-shadow-claims-client.ts#L101-L108) 会向 `https://openrouter.ai/api/alpha/decisions` 发请求。
- 影响：它不是一个自包含的冒烟测试，而是会花钱、会写历史证据目录的外部调用脚本。

### H3. `jev-historical-replay.ts`

- [第 9 行](../../../tests/experiments/jev-historical-replay.ts#L9) 绑定 `experiments/jev-narrative-auditor/historical-replay-2026-09-26`。
- [#L15-L23](../../../tests/experiments/jev-historical-replay.ts#L15-L23) 使用另外两个工作树的绝对路径：
  `D:/DeepSeek Harness/harness-cordis-world-prototype/.tmp/...`、`D:/DeepSeek Harness/Perspectra Action First/.tmp/...`，以及本仓库的固定 `.tmp` 日期目录。

### H4. JEV 家族中的固定证据路径

| 文件 | 固定点 |
| --- | --- |
| [jev-boundary-probe.ts](../../../tests/experiments/jev-boundary-probe.ts#L42) | `.tmp/jev-placement-live-20260927-` 前缀；[#L49-L51](../../../tests/experiments/jev-boundary-probe.ts#L49-L51) 再读 `placement-2026-09-27` 与 `jev-intervention-20260927-` |
| [jev-placement-probe.ts](../../../tests/experiments/jev-placement-probe.ts#L13) | `.tmp/jev-intervention-20260927-` |
| [jev-custody-reconcile.ts](../../../tests/experiments/jev-custody-reconcile.ts#L10) | 硬编码 `seq === 265` 的怀表记录；[#L13-L16](../../../tests/experiments/jev-custody-reconcile.ts#L13-L16) 的名字和物品也固定 |
| [jev-custody-replay.ts](../../../tests/experiments/jev-custody-replay.ts#L13) | `holdout-2026-09-27`；[#L18](../../../tests/experiments/jev-custody-replay.ts#L18) 真实分类器 |
| [jev-holdout-live-drive.ts](../../../tests/experiments/jev-holdout-live-drive.ts#L30) | `holdout-2026-09-27/live-pack` |

这些文件的名字是 `probe`、`replay`、`acceptance`、`drive`，读起来像可复用工具；实际是"某次证据包的重分类脚本"。

### H5. `player-command-playtest.ts`

- [第 39 行](../../../tests/experiments/player-command-playtest.ts#L39) 从 `experiments/jev-narrative-auditor/holdout-2026-09-27/live-pack` 加载世界，而不是 `examples/world-packs`。
- 名字像当前玩家命令试玩，实际是围绕历史 holdout 包的影子审计。
- 另外：[#L58](../../../tests/experiments/player-command-playtest.ts#L58) 已 `runtime.close()`，[#L68](../../../tests/experiments/player-command-playtest.ts#L68) 的 `finally` 又 close 一次；这是重复清理，不是命名问题，但会让脚本行为更难读。

### H6. Core 诊断/探针

| 文件 | 固定依赖 |
| --- | --- |
| [core-utility-build-probe.py](../../../tests/experiments/core-utility-build-probe.py#L12) | `output/experiments/nodes-core-sms-gemini38-20261010-01/source/memory-core/...` |
| [core-utility-timing-probe.py](../../../tests/experiments/core-utility-timing-probe.py#L15) | 同一固定缓存文件 |
| [core-gateway-diagnostics.py](../../../tests/experiments/core-gateway-diagnostics.py#L7) | `~/.antigravity_tools/proxy_logs.db`；[#L11](../../../tests/experiments/core-gateway-diagnostics.py#L11) 固定 model 与时间戳 |
| [core-timing-diagnostics.py](../../../tests/experiments/core-timing-diagnostics.py#L9) | 三个固定历史目录名 |

### H7. `hidden-cure-format-audit.ts`

- [第 11 行](../../../tests/experiments/hidden-cure-format-audit.ts#L11) 默认读 `output/hidden-cure/live-vuTX5e/B/record.json`。
- 名字像通用格式审计，实际只审某一次 B6 记录；缺少目录时直接失败。

### H8. `autonomy-scheduling.ts` / `dynamic-scheduling.ts`：默认不是 live

- [autonomy-scheduling.ts](../../../tests/experiments/autonomy-scheduling.ts#L13) 通过 `--live` 才使用真实模型；默认是受控脚本服务器（[#L20](../../../tests/experiments/autonomy-scheduling.ts#L20) 固定本机端点）。
- [dynamic-scheduling.ts](../../../tests/experiments/dynamic-scheduling.ts#L11-L13) 同样默认受控，`--live` 才代理真实上游；默认输出目录前缀是 `comparison-`，live 才是 `live-`。
- 名字没有提示默认非 live，容易被引用为"真实调度对比"。

### H9. `official-demo-live-cake.ts` / `official-demo-live-followup.ts`

- [cake 第 10 行](../../../tests/experiments/official-demo-live-cake.ts#L10)、[followup 第 10 行](../../../tests/experiments/official-demo-live-followup.ts#L10) 都 `resolve(process.argv[2]!)` 并复制 `root/life`。
- 名字像独立场景，实际必须接在 `official-demo-live.ts` 的输出之后；缺少参数时是底层的 undefined 错误，而不是可读的使用说明。

---

## 6. 旧概念名套在新语义上（P1）

### U1. `CreatorDebugSnapshot.variables` 现在装的是状态真值

- [creator-debug.ts](../../../tests/experiments/creator-debug.ts#L25) 仍叫 `variables`。
- [playtest-frozen-runtime.ts](../../../tests/experiments/playtest-frozen-runtime.ts#L186-L191) 把 `PackStatus.truth()` 填进这个字段。
- 包变量（pack variables）已退役，字段名没有改。

### U2. 创作者控制台的"变量"页实际展示状态

- [VariablesView.vue](../../../apps/launcher/src/creator/VariablesView.vue#L9) 的选择标签是"变量 · …"；[#L15](../../../apps/launcher/src/creator/VariablesView.vue#L15)、[#L26](../../../apps/launcher/src/creator/VariablesView.vue#L26) 标题是"公开变量/私有变量"。
- 但 [#L38](../../../apps/launcher/src/creator/VariablesView.vue#L38) 自己说"状态值从已提交的 `status.updated` 世界事件推导"。
- [DetailPanel.vue](../../../apps/launcher/src/creator/DetailPanel.vue#L90-L97) 的"变量路径"同样指向 `world.variables`。

### U3. Mock 仍伪造已退役的包变量

- [mock.ts](../../../apps/launcher/src/creator/mock.ts#L203) 提供 `weather/timeOfDay/mood/trustInPlayer` 等字段。
- [store.ts](../../../apps/launcher/src/creator/store.ts#L58) 在无 token 时默认使用 mock；预览看起来像当前真实能力，但这些字段已没有对应的运行时来源。

### U4. 导出说明声称包含"包变量"

- [ExportDialog.vue](../../../apps/launcher/src/components/ExportDialog.vue#L43) 写"文件包含……长期记忆和包变量"。
- 故事分享的实际文件清单见 [story-share.ts](../../../desktop/story-share.ts#L16)：只有 world/session/memory 文件，没有独立的包变量；包变量功能本身已退役。

---

## 7. 注释与"纯度"声明（P2）

### C1. "shadow" 会发外网

- [playtest-web-entry.ts](../../../tests/experiments/playtest-web-entry.ts#L50-L58) 的 `--jev-shadow` 会把已发布对白/叙述发到 OpenRouter；[#L58](../../../tests/experiments/playtest-web-entry.ts#L58) 打印了提示。
- "影子审计"容易被读成"本地影子观察、不影响外部"。启动提示是缓解，不是命名澄清。

### C2. "Experimental" 出现在默认路径

- [hindsight-python.ts](../../../tests/experiments/hindsight-python.ts#L24) 称"Experimental JSON bridge"；[#L32](../../../tests/experiments/hindsight-python.ts#L32)、[#L51](../../../tests/experiments/hindsight-python.ts#L51) 的错误信息称"实验记忆"。
- [playtest-launch.ts](../../../tests/experiments/playtest-launch.ts#L59) 说明 Core 是默认值。默认能力不应该用"实验/Experimental"描述其错误。

### C3. "frozen" 只是源包版本检查

- [isFrozenPackDirectory](../../../tests/experiments/playtest-frozen-runtime.ts#L108) 只检查 `worldpack-source/v5`；没有只读或快照语义。

### C4. "offline" 仍会起本地服务器

- [status-market-offline.ts](../../../tests/experiments/status-market-offline.ts#L8) 称 model-free；[#L35](../../../tests/experiments/status-market-offline.ts#L35) 的 provider 标为 `ollama`，实际连的是 [#L17-L34](../../../tests/experiments/status-market-offline.ts#L17-L34) 的本地脚本 HTTP server。
- 没有外部模型，结论仍成立；但"offline"字面不准确，安全/网络审查会误判。

### C5. 正式 NPC 主循环自称 experiment

- [prototype-character-turn.ts](../../../packages/application/src/prototype-character-turn.ts#L507) 的注释："This experiment does not fabricate a legacy batch Authority or provider-replay receipt."
- 项目整体是原型，`prototype` 前缀可接受；但在正式路径中称"this experiment"会强化"可丢弃"的印象，与 `frozen/playtest` 命名形成叠加。

### C6. 同名的历史源码副本

- `experiments/jev-narrative-auditor/holdout-2026-09-27/jev-shadow.ts`、`jev-shadow-claims-client.ts`、`jev-shadow-window.ts`、`jev-publication-intervention.ts` 是 `tests/experiments/jev-*.ts` 的冻结副本，文件名完全相同。
- `boundary-2026-09-27/probe-*-classifier-source.ts` 也是副本。
- [jev-custody-reconcile.ts](../../../tests/experiments/jev-custody-reconcile.ts#L27) 还会再生成 `reconciler-source.ts`。
- 影响：grep 和 IDE 跳转会落到不再维护的副本；审查者可能修改错误文件。

---

## 8. 死代码与重复（P2）

| 文件 | 状态 | 证据 |
| --- | --- | --- |
| [playtest-page.ts](../../../tests/experiments/playtest-page.ts#L1) | 死文件 | 全仓无引用；现行页面是 [playtest-host-page.ts](../../../tests/experiments/playtest-host-page.ts#L2) |
| [character-relation-spike.ts](../../../tests/experiments/character-relation-spike.ts#L47) | 被正式实现取代 | 仅被自己的测试引用；正式逻辑在 kernel/interactions-basic |
| JEV 冻结副本 | 重复源码 | 见 C6 |

旧页面特别值得处理：它是完整的 HTML+JS，标题、暗色样式和命令提示（`/narrate`、`/move`、`/take` 等）都像当前版本，但改了不生效。

---

## 9. 风险矩阵

| ID | 问题 | 触发方式 | 主要后果 | 优先级 |
| --- | --- | --- | --- | --- |
| 3.1 | `tests/experiments` 是生产宿主 | 按测试目录删除/重构 | 游戏、发行包、故事节点损坏 | P0 |
| 3.2 | `experiments` 是默认记忆实现 | 按证据目录清理 | 默认 Core 记忆失败 | P0 |
| 3.3 | 生产包反向依赖测试目录 | 独立构建/发布包 | 构建失败、层次倒置 | P0 |
| N1 | `decideActivityFormat` 范围错误 | 只改活动路径 | 普通回合格式修正遗漏 | P1 |
| N2 | `localPrototypeTurnCall` 范围错误 | 当调试工具修改/删除 | 默认 provider 全部受影响 | P1 |
| N3 | `hindsightPython` 名称与错误文案 | 排障、打印错误 | 误判为可选实验故障 | P1 |
| N4 | `Frozen` 无冻结语义 | 当只读夹具使用 | 误判可写性与生命周期 | P1 |
| N5/N6 | `PlaytestMemoryCore`/`createPlaytestServer` | 安全/权限评审 | 漏查生产边界 | P1 |
| N8 | 受信任前端服务器藏在 assets 文件 | 前端授权审计 | 低估 CSP/权限面 | P1 |
| N11 | `official-demo` 零模型调用 | 当演示运行 | 误判角色能力/看不到效果 | P2 |
| N12 | 死页面 | 编辑界面 | 改动不生效 | P2 |
| H1-H9 | 固定历史路径/seq | 换环境复跑 | 失败或分析旧数据 | P1/P2 |
| U1-U4 | "变量"显示状态真值 | 创作者页面/导出 | 误判存在包变量 | P1 |
| C1 | shadow 外发 | 启用 `--jev-shadow` | 隐私预期落空 | P1 |

---

## 10. 建议处置（按优先级，本文未实施）

### 10.1 先收口边界（P0）

1. 把生产面从 `tests/experiments` 移出，放到真正承载体（如 `desktop/` 或独立 host 包）；文件内容不变，只改 import。最小清单见附录 A。
2. 把 `experiments/hindsight-core`、`experiments/activity-memory` 中运行时必需的 Python/TS 文件迁到记忆包或发行运行时目录；其余历史报告留在 `experiments`。
3. 迁移后同步 `package.json` 构建脚本、`build-portable.mjs`、`tail-runtime-identity.ts`、`story-share.ts`、`player-view.ts` 与创作者页面的类型导入。
4. 不需要新增 Host 框架或兼容层；这是目录与依赖方向调整。

### 10.2 重命名与删除（P1）

| 现名 | 建议名 | 说明 |
| --- | --- | --- |
| `decideActivityFormat` | `decideWithFormatRetry` | 对所有 decision 生效 |
| `localPrototypeTurnCall` | `localGatewayTurnCall` | 描述网关兼容职责 |
| `hindsightPython` | `corePythonExecutable` | 返回解释器路径 |
| `FrozenWorldRuntimeCore` | `WorldRuntimeCore` | 去掉无意义的 frozen |
| `official-demo` | `official-demo-offline` 或 `official-regression` | 零 provider 回归 |
| `goal-progress-search` | `goal-progress-inspection-fixture` | 它是交互包 fixture |
| `CreatorDebugSnapshot.variables` | `statusTruth` | 与 PackStatus 对齐 |
| `playtest-page.ts` | 删除 | 无引用，且与宿主页面重复 |
| `character-relation-spike.ts` | 归档 | 正式实现已在 kernel/interactions-basic |

### 10.3 固定历史脚本（P1）

- 对 H1-H9 的脚本，把固定 `.tmp`、绝对路径、seq 改成**必填参数**，缺失时给出明确用法；或移到 `experiments/<line>/scripts/` 并在文件头标"仅适用于某次 run"。
- `jev-shadow-smoke.ts` 至少改名（它会产生外部调用并写历史证据），或把输出改到调用者指定目录。
- `autonomy-scheduling.ts` / `dynamic-scheduling.ts` 在文件头第一行写清"默认受控，`--live` 才用真实模型"。

### 10.4 创作者页面（P1）

- `VariablesView` 的标题、导航、详情标签从"变量"改为"状态/真值"；保留活动内的 public/private/internal"变量"（那是活动状态，语义正确）。
- 删除 `mock.ts` 中已退役的 `weather/mood/trustInPlayer`，或改为符合 `StatusTruth` 形状的示例。
- 修正 `ExportDialog` 的"包变量"文案。
- `creator-debug.ts` 的 `variables` 改为 `statusTruth` 后同步创作者页面。

### 10.5 防回归（P2）

加一条轻量只读检查即可，不需要新框架：

~~~powershell
git grep -n "tests/experiments" -- packages apps
~~~

预期结果应为空（或只剩明确允许的过渡项）。如果短期不能迁移，至少在 `tests/experiments/README.md` 顶部列出"生产面清单"，避免继续被当作测试目录。

### 10.6 验证

迁移或重命名后需要跑：

~~~powershell
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 test
corepack pnpm@11.7.0 desktop:build
node scripts/docs/check-links.mjs
~~~

以及一次真实启动与故事导出/导入。本文只做审查，以上均未执行。

---

## 11. 复核方法与限制

### 11.1 本文证据如何复核

~~~powershell
git grep -n "tests/experiments" -- packages desktop apps scripts package.json
git grep -n "experiments/hindsight-core\|experiments/activity-memory" -- desktop tests/experiments scripts
git grep -n "PLAYTEST_PAGE" -- tests desktop packages apps
git grep -n "decideActivityFormat\|localPrototypeTurnCall" -- tests/experiments
~~~

### 11.2 限制

- **只读审查**：没有修改任何文件，没有运行会调用真实模型/OpenRouter 的脚本，没有跑测试。
- 139 个 `tests/experiments` 文件全部核对了名称、头部与导入；正文与调用点重点看了约 40 个。`playtest-frozen-runtime.ts`（1196 行）与 `playtest-memory-core.ts`（462 行）只读关键段，不是逐行审计。
- 排除了 `node_modules`、`.tmp`、`output`、`.claude/worktrees`；这些位置的副本会干扰搜索，但不属于当前工作树。
- 部分名字可能是刻意保留的历史称呼；"事实"与"影响"已分开写。本文是讨论清单，不应直接当作缺陷单批量修改。
- 没有验证迁移后的性能、发行包体积或 Python 资产路径；这些需要实际构建。

---

## 附录 A：生产面文件清单

以下 `tests/experiments` 文件被生产入口直接或间接引用（至少 26 个）：

**入口与服务**

- `playtest-web-entry.ts`：打包为 `playtest.mjs`，启动器与 `experience:web` 使用。
- `playtest-server.ts`：网页宿主 HTTP API。
- `playtest-pack-web.ts`：包内前端资产加载。
- `playtest-frontend-assets.ts`：默认/受信任前端服务。
- `playtest-creator-assets.ts`：创作者静态页面。
- `playtest-host-page.ts`：宿主外壳页面。
- `playtest-launch.ts`：启动参数解析。
- `playtest-tuning.ts`：运行预算。
- `playtest-view.ts`：玩家转录与默认数据目录。

**运行时**

- `playtest-frozen-runtime.ts`：世界装配、角色激活、状态/活动/记忆接线。
- `playtest-tail-runtime.ts`：末端回合与候选切换。
- `playtest-memory-core.ts`：Core 记忆宿主适配。
- `hindsight-python.ts`：Python 解释器与 Core worker 桥。
- `local-prototype-turn-call.ts`：默认本机请求 schema。
- `pack-activity.ts`、`pack-activities.ts`：活动运行时与加载。
- `pack-status.ts`：状态运行时。
- `pack-autonomy.ts`：角色自主触发。
- `pack-knowledge.ts`、`pack-json-asset.ts`：知识/编译资产读取。

**创作者与审计**

- `creator-debug.ts`、`creator-history.ts`、`creator-records.ts`：创作者只读接口。
- `jev-shadow.ts`、`jev-shadow-claims-client.ts`、`jev-shadow-window.ts`、`jev-publication-intervention.ts`：可通过 `--jev-shadow`/发布审计接入正式宿主。

> 统计口径：从 `package.json`、`desktop`、`packages/frontend`、`apps/launcher`、`scripts/release` 的引用出发，沿 import 展开。未计入仅被这些文件使用的测试/实验脚本。

---

## 附录 B：已核对但不作为"误导"处理的项目

为避免把历史命名一概当缺陷，以下项目已核对，结论是**不作为本文问题**：

- [cross-scene-sms-entry.ts](../../../tests/experiments/cross-scene-sms-entry.ts#L11)：短信是真实建模的，[cross-scene-sms/communication.json](../../../examples/world-packs/cross-scene-sms/communication.json#L2) 的 `medium` 就是"短信"。
- [frontend-stage-preview.ts](../../../tests/experiments/frontend-stage-preview.ts#L1)：确实不打开存档、不调用 provider，使用内存态 `PlaytestRuntime`。
- [scripted-performance.ts](../../../tests/experiments/scripted-performance.ts#L10)：`performance` 指"脚本化演出"，不是性能基准；注释明确无真实模型。
- [storyline-crash-worker.ts](../../../tests/experiments/storyline-crash-worker.ts#L9)：故障注入只发生在子进程 worker 内，不进入生产路径。
- [status-market-offline.ts](../../../tests/experiments/status-market-offline.ts#L8)：虽然没有外部模型，但仍起本地 HTTP server；本文只在 C4 提示措辞，不把它当行为缺陷。
- [packages/kernel/src/frozen-interactions.ts](../../../packages/kernel/src/frozen-interactions.ts#L1)：这里的 `frozen` 指冻结交互注册表，语义准确。
- `ActivitiesView.vue` 中的"公开变量/私有变量"：活动状态确实有 public/private/internal 三级，这里的"变量"不是已退役的包变量。
- `official-demo.ts` 本身没有运行时缺陷；本文只质疑"demo"这个名字与其零模型调用行为不符。

---

## 附：本文未改动的文件

本文写入 `docs/current/studies/`，未修改 `tests/experiments`、`experiments`、`packages`、`desktop`、`apps` 或构建脚本。
