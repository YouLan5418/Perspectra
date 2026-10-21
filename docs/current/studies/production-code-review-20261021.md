# 生产路径代码审查报告（2026-10-21）

> 审查对象：D:\DeepSeek Harness\Perspectra-code-cleanup-20261021
> 分支：codex/code-organization-20261021，HEAD 414a164
> 审查方式：只读静态阅读 + 运行现有检查；未修改任何生产代码、测试或配置。本报告是本次审查唯一新增的文件。

## 0. 结论摘要

这套代码的工程基线明显好于一般原型：TypeScript strict 全开、本地导入强制显式 .ts、有可执行的包边界检查与失败夹具、有文档链接检查和真实构建入口回归。审查时默认回归 **89 个文件 / 757 项全部通过**，说明当前不是"坏掉"的状态。

主要问题不是"乱"，而是**清理之后仍保留多套并行实现和退役基础设施**：读代码时很难仅凭目录和命名判断哪条是生产路径。这是可维护性与可读性的核心矛盾，也是本报告的主要结论。

| 维度 | 判断 | 主要原因 |
| --- | --- | --- |
| 工程规范 | 较好 | 类型与导入纪律好，检查器有效；缺 formatter、lint 范围偏窄、默认门禁漏掉大量单测 |
| 可维护性 | 中等偏弱 | 两套提交管线、整套退役 Reaction 基础设施、49 方法门面、多份重复校验工具 |
| 可读性 | 中等偏弱 | 压缩风格、历史阶段词、超长条件表达式、遗留 director 语义 |
| 目录分层 | 基本合理 | 包级方向正确、无循环；但 desktop/ 三合一、application 兼任组合根、launcher 深导入包内部 |

## 1. 审查范围与方法

### 1.1 纳入范围

以当前实际可运行的生产入口为起点，向下阅读其依赖：

| 入口 | 路径 | 说明 |
| --- | --- | --- |
| 网页游戏宿主 | [web-entry.ts](../../../desktop/host/web-entry.ts) → [world-runtime.ts](../../../desktop/host/world-runtime.ts) | experience:web，源码与发行共用 |
| Launcher 后端 | [launcher-entry.ts](../../../desktop/launcher-entry.ts) → [launcher-core.ts](../../../desktop/launcher-core.ts) | Tauri 经 stdin/stdout 桥调用 |
| Launcher 前端 | [apps/launcher/src](../../../apps/launcher/src) | Vue 页面、创作者页面、IPC 服务 |
| 世界包工具 | [cli-entry.ts](../../../packages/world-pack/process/cli-entry.ts) | pnpm worldpack |
| 旧 Electron 外壳 | main.ts（已删除） | 仓库保留入口，仍参与 desktop:build |
| Python Core | [python 目录](../../../desktop/host/memory/python) | 宿主记忆适配，非 packages/memory |

packages/* 作为上述入口的依赖被阅读，重点是 contracts、kernel、store-sqlite、application、memory、world-pack、frontend、runtime-cordis。

### 1.2 实际运行的检查

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | node node_modules/typescript/bin/tsc --noEmit | 通过，0 错误（TypeScript 6.0.3，Node 24.14.1） |
| Lint | node node_modules/oxlint/bin/oxlint packages tests desktop vitest.config.ts vitest.regression.config.ts | 通过，0 error、2 warning（均为未使用导入） |
| 生产边界 | node scripts/check-host-boundaries.mjs | 通过，264 个生产文件 |
| 默认回归 | vitest run --config vitest.regression.config.ts --maxWorkers=2 | **89 文件 / 757 用例全部通过**，240.87s |
| 文档链接 | node scripts/docs/check-links.mjs | 通过，93 页、1101 个本地链接（含本报告；新增前为 92 页 / 1041 链接） |

### 1.3 未运行项

launcher:check（vue-tsc + 44 项）、desktop:build、launcher:build、Rust cargo check、Python Core 离线回归、真实模型试玩、性能剖析。因此本报告对"角色体验、权限实际效果、发行包可用性"不下结论。

## 2. 生产路径与分层现状

### 2.1 包级依赖方向

按各包 package.json 的 dependencies：

~~~text
contracts（零依赖）
  ← store-sqlite
  ← kernel（另含 interaction-runtime、store-sqlite）
  ← memory / agents（另含 store-sqlite）
  ← presentation / frontend / provider-chat / interaction-runtime
  ← interactions-basic（另含 interaction-runtime）
  ← runtime-cordis（另含 cordis）
  ← application（agents、interactions-basic、kernel、memory、presentation、runtime-cordis、store-sqlite）
  ← world-pack（application、kernel）
~~~

没有包级循环，方向总体正确。问题集中在"层的归属"而不是"边的方向"。

### 2.2 分层判断

| 层 | 判断 | 说明 |
| --- | --- | --- |
| packages/contracts | 合理 | 纯类型 + 规范序列化/哈希，零内部依赖；但 world-json.ts 依赖 node:crypto，不是浏览器安全包 |
| packages/store-sqlite | 偏重但合理 | 共享持久化底座；同时承载 19 段迁移、Reaction、Inbox/Outbox、认知任务 |
| packages/kernel | 职责混合 | 规则裁定 + 场景归约 + WorldBootstrap；同时含已死的 WorldKernel |
| packages/application | 职责混合 | 领域服务 + 组合根（直接 new Store/Memory、挂 Cordis） |
| packages/world-pack | 反向耦合 | 因 creator-cli 的 activate 命令依赖 application |
| desktop/host | 事实上的应用层 | 8842 行，超过任何单个 package；未独立成包 |
| apps/launcher | 边界穿透 | 五级相对路径直接引用 packages/provider-chat/src/* |

## 3. 问题清单

严重度：**P1** = 会直接增加误读或分叉风险；**P2** = 明显拖慢维护；**P3** = 整洁度问题。

| ID | 严重度 | 问题 | 主要位置 |
| --- | --- | --- | --- |
| P1-1 | 高 | WorldKernel 是完整但无人调用的第二套玩家提交流程，文档却指向它 | world-kernel.ts（已删除）、[code-walkthrough.md](../architecture/code-walkthrough.md) |
| P1-2 | 高 | 玩家与 NPC 两条提交/观察管线重复且已出现细节差异 | [round-coordinator.ts](../../../packages/application/src/round-coordinator.ts)、[character-turn.ts](../../../packages/application/src/character-turn.ts) |
| P1-3 | 高 | Reaction Cycle 已无生产者，但协议、存储、门面 API、拦截逻辑全部保留 | reaction-cycle.ts（已删除）、[world-store.ts](../../../packages/store-sqlite/src/world-store.ts) |
| P2-1 | 中高 | WorldApplication 49 个公开方法，宿主只用 8 个；组合根与运维 API 混在一起 | [world-application.ts](../../../packages/application/src/world-application.ts) |
| P2-2 | 中 | 大文件承担过多职责，单类持有过多可变状态 | world-store、local-memory、schema、world-runtime |
| P2-3 | 中 | untrusted-JSON 校验工具复制三份，语义已漂移 | [world-spec.ts](../../../packages/kernel/src/world-spec.ts)、[schema.ts](../../../packages/world-pack/src/schema.ts) |
| P2-4 | 中 | 默认测试门禁漏掉 59 个包级单测，含玩家提交与存储核心 | [vitest.regression.config.ts](../../../vitest.regression.config.ts) |
| P2-5 | 中 | 无 formatter、lint 规则少且不含 launcher/scripts | package.json、oxlint 默认配置 |
| P2-6 | 中 | desktop/ 同时是 Launcher 后端、游戏宿主和旧 Electron 外壳 | main.ts（已删除）、[launcher-core.ts](../../../desktop/launcher-core.ts) |
| P3-1 | 低 | launcher 通过五级相对路径进入包内部，靠正则白名单放行 | [PresetContentEditor.vue](../../../apps/launcher/src/components/PresetContentEditor.vue)、[check-host-boundaries.mjs](../../../scripts/check-host-boundaries.mjs) |
| P3-2 | 低 | 版本轴分散且存在交叉判断 | world-spec.ts、world-store.ts、local-memory.ts |
| P3-3 | 低 | 历史阶段词、director 命名、中英文错误混用 | 多处 |
| P3-4 | 低 | 无消费者的配置、重复 script、false 常量导出 | world-host.example.yml（已删除）、package.json、[local-memory.ts](../../../packages/memory/src/local-memory.ts) |

## 4. 详细发现

### P1-1 已死的 WorldKernel 与文档漂移

world-kernel.ts（已删除） 共 243 行，实现了完整的 submitPlayerInput：校验提交、查 PlayerBinding、写 Inbox、抢 Writer Lease、逐条 drain、调 Rulebook、commitRound、回写 Inbox。它是 2026-10 之前玩家提交的正式实现。

但全仓库对它的引用只有自身测试：

~~~text
git grep -l "\bWorldKernel\b" -- packages desktop apps tests
→ packages/kernel/src/world-kernel.test.ts
→ packages/kernel/src/world-kernel.ts
~~~

实际生产路径在 [round-coordinator.ts](../../../packages/application/src/round-coordinator.ts)。更严重的是文档仍把它当作生产节点：

- [code-walkthrough.md](../architecture/code-walkthrough.md) 第 3 节把 world-kernel.ts 与 world-store.ts 并列为"裁定结果、事件与事务提交"；
- [modules.md](../architecture/modules.md) 把 WorldKernel 列为 kernel 的阅读起点；
- 同一页又写"RoundCoordinator 只执行玩家行动"，而实际它承担了裁定、Authority、观察与提交。

**影响**：排查玩家提交问题时会被引向死代码；新人无法建立正确调用图；kernel 的职责边界被错误描述。
**建议**：删除 WorldKernel（及其导出与测试），或移入明确的实验包；修正两份文档，把 RoundCoordinator 写为玩家提交入口。

### P1-2 玩家与 NPC 两条平行、已开始分叉的提交管线

RoundCoordinator.#commitClaimed（[round-coordinator.ts:321](../../../packages/application/src/round-coordinator.ts)）与 CharacterTurn.run 的提交段（[character-turn.ts:420](../../../packages/application/src/character-turn.ts)）各自实现几乎相同的语义：

1. 用 Rulebook 裁定动作；
2. 生成 observation.upsert，并按场景受众裁剪内容；
3. 处理 movement 的"出发观察者 / 到达观察者"；
4. 给玩家绑定写 outbox；
5. 追加 action.resolved 与 world.tick-advanced；
6. 调 commitRound。

已经出现的差异：

| 维度 | RoundCoordinator | CharacterTurn |
| --- | --- | --- |
| 观察 ID | deterministicId('observation:scene-result', …) | actionId:observer:observerId 字符串拼接 |
| 玩家来源文本 | 附带 playerInput 解释证据 | 无 |
| NPC 结果描述 | 无 | String(feedback.description).replaceAll('你', …) |
| Outbox | 仅玩家绑定 | 所有玩家绑定 |

两条路径都写了"受众 / 观察 / outbox"这类直接决定"谁看到了什么"的代码。修改其中一个缺陷时，很容易只改一处。

**影响**：核心权限与观察不变量存在双实现；未来协议或受众规则演进会产生两个事实来源。
**建议**：抽出唯一的"裁定结果 → Authority + 观察 + Outbox"构造器，两条路径只保留调度、预算与提示差异。这是投入产出比最高的一次重构，且不需要改协议。

### P1-3 半退役的 Reaction Cycle

证据：

- reaction-cycle.ts（已删除） 1945 行，配套 2112 行测试；
- WorldStore.commitRound 仍接受 reactionCycle / reactionSettlement，并参与 bundle hash（[world-store.ts:991](../../../packages/store-sqlite/src/world-store.ts)）；
- WorldApplication 仍公开 reactionCycle / listReactionCycles / cancelReactionCycle；
- 生产入口没有任何地方创建 Cycle：git grep "reactionCycle:" 只命中 testkit、reaction-cycle.test.ts、player-only-assembly.test.ts；
- RoundCoordinator（[244](../../../packages/application/src/round-coordinator.ts)、[363](../../../packages/application/src/round-coordinator.ts)）与 CharacterTurn（[169](../../../packages/application/src/character-turn.ts)）又会在发现未完成 Cycle 时拒绝执行；
- 文档称旧 NPC Reaction 已退役，但没有说明 store 与门面 API 仍然保留。

**影响**：阅读 world-store.commitRound 必须先理解一套不会再产生的状态；新同学容易误以为 NPC 仍走 Reaction；store 的复杂度与测试成本持续存在。
**建议**：先确认历史数据是否仍需读取，再二选一——删除，或在 contracts/store 顶部明确标注"仅用于旧存档读取，禁止新写入"，并从 CommitRoundRequest 移除草稿字段。

### P2-1 WorldApplication：49 个公开方法的门面 + 组合根

[world-application.ts](../../../packages/application/src/world-application.ts) 共 1388 行，公开 49 个方法，覆盖：

- 玩家提交与文本解释；
- 回合状态、事件历史、Authority 查询；
- 记忆召回、诊断、投影读取；
- 快照、备份/恢复、便携导入导出；
- 分叉、归档、维护模式、隔离恢复；
- Reaction 查询；
- 会话渲染与 Outbox 投递。

宿主实际只调用 8 个：activate / head / release / submitText / deliver / close / characterViewForPrincipal / playerAffordancesForPrincipal。其余方法只在测试或无人调用。构造时它又直接 new WorldStore、new CognitiveMemoryService、new RoundCoordinator 并挂 Cordis slot，使"领域包"无法脱离 SQLite/Cordis 使用。

**影响**：任何改动都要在 1388 行里定位；测试必须装配整套基础设施；公开面过大导致猜不到生产入口。
**建议**：按消费者拆为窄接口：WorldPlay（宿主 8 个方法）、WorldRead（创作者只读）、WorldAdmin（备份/维护/隔离，可移到独立包或 scripts）。组合根上移到宿主侧。

### P2-2 大文件与单一职责

| 文件 | 行数 | 混在一起的职责 |
| --- | --- | --- |
| [world-store.ts](../../../packages/store-sqlite/src/world-store.ts) | 2076 | 19 段 schema/迁移、事件读写、commit 事务、完整性校验、Inbox/Outbox、认知任务、澄清记录、Reaction |
| reaction-cycle.ts（已删除） | 1945 | 退役机制的全部状态机 |
| [local-memory.ts](../../../packages/memory/src/local-memory.ts) | 1627 | 8 个 schema 版本、捕获、召回、关键词索引、摘要、诊断 |
| [world-application.ts](../../../packages/application/src/world-application.ts) | 1388 | 见 P2-1 |
| [schema.ts](../../../packages/world-pack/src/schema.ts) | 1361 | 手写解析 20+ 种源文件 |
| [world-runtime.ts](../../../desktop/host/world-runtime.ts) | 1119 | 60+ 个可变字段、模型装配、调度、状态投影、活动/状态/知识/自主性 |

WorldHostCore 的字段声明在 104-245 行；#activateCharacters（832-965）同时处理活动链、自主性、普通反应、预算、提示文案与错误标志。local-memory 把 SQLite 迁移、关键词倒排、摘要分组和召回诊断放在一个类里。

**建议**：按"schema/迁移 / 写入事务 / 读取查询 / 完整性校验"拆 store；按"存储 / 召回 / 诊断"拆 memory；把 WorldHostCore 的调度与状态投影拆出，至少把"活动 / 自主性 / 普通反应"三段拆成独立方法。

### P2-3 重复的校验工具

objectAt / textAt / hashAt / arrayAt / unique / exactKeys 在两处各有一份：

- [world-spec.ts:385-425](../../../packages/kernel/src/world-spec.ts)；
- [schema.ts:151-258](../../../packages/world-pack/src/schema.ts)；
- [frozen-interactions.ts](../../../packages/kernel/src/frozen-interactions.ts) 还有第三份 exactKeys。

object()（断言为普通对象）在 17 个生产文件中重复定义。语义已经漂移：world-spec 的 exactKeys 要求"键集合完全相等"，world-pack 的是"required + optional 允许清单"；textAt 的错误文本也不同。

这层代码决定"存储字节是否可信"，重复实现的漂移风险高于普通工具函数。
**建议**：在 contracts 下建一个极小的 untrusted-json 模块（对象/数组/文本/hash/精确键），统一错误类型与路径格式，三处改为复用。不要引入 schema 库。

### P2-4 默认测试门禁的选择面

[vitest.regression.config.ts](../../../vitest.regression.config.ts) 的 include 是：

~~~text
packages/store-sqlite/src/character-view.test.ts
packages/world-pack/src/compiler-v5.test.ts
tests/host/**/*.test.ts
tests/desktop/**/*.test.ts
tests/scenarios/**/*.test.ts
tests/integration/**/*.test.ts
~~~

默认 test 与 CI 都只跑这 89 个文件。按目录规则统计，另有 **59 个 packages/**/*.test.ts**（约 1.3 万行）不在默认门禁内，包括：

- packages/application/src/round-coordinator.test.ts（生产玩家提交管线）；
- packages/store-sqlite/src/store.test.ts（1266 行）；
- packages/store-sqlite/src/reaction-cycle.test.ts（2112 行）；
- packages/memory/src/local-memory.test.ts、cognitive-memory.test.ts；
- packages/provider-chat/src/wire.test.ts。

scenarios/integration 会间接覆盖部分路径，但单元级不变量（不经过宿主装配）默认不验证。同时那两个"包级代表"是按单个文件名硬编码的，新增单测不会自动纳入。

**建议**：至少把 round-coordinator、store、local-memory 纳入默认回归；把白名单改成目录规则；把 desktop 加入 coverage include（目前 [vitest.config.ts](../../../vitest.config.ts) 只统计 packages/*）。

### P2-5 格式与 lint 缺口

- **没有 formatter**：仓库无 prettier/biome/dprint 配置，只有 .editorconfig。
- **风格摆动**：同一仓库里既有完全展开的代码，也有接近压缩的写法，例如 [character-turn.ts:420-531](../../../packages/application/src/character-turn.ts)（循环体几乎无空格）、[activation-cycle.ts:110-180](../../../packages/application/src/activation-cycle.ts)（单字母变量密集）、[services/desktop.ts:27-37](../../../apps/launcher/src/services/desktop.ts)（1 空格缩进）。
- **lint 覆盖窄**：oxlint 默认规则、无配置文件、96 条规则；lint 脚本不含 apps/launcher、scripts、config；没有类型感知规则，any 与非空断言不会被拦截。
- **显式 any**：约 80 处词法命中、38 个文件，其中 [runtime-cordis.ts:12-13](../../../packages/runtime-cordis/src/runtime.ts) 的公共接口直接使用 any。
- **非空断言**：源码中形如 x! 的断言约 250 处，round-coordinator.ts 单文件 19 处，world-runtime.ts 12 处。多数处在不变量之后，但一旦不变量破坏，报错是 Cannot read properties of undefined，而不是领域错误。

**建议**：引入 formatter（prettier 或 dprint 任一）并一次性格式化；把 launcher/scripts 纳入 lint；先不加严格新规则，只固定格式，再逐步处理公共接口的 any。

### P2-6 desktop/ 三合一

desktop/ 同时包含：

1. **Launcher 后端**：launcher-core.ts、model-connections.ts、model-presets.ts、play-settings.ts、story-nodes.ts、story-share.ts；
2. **游戏宿主**：host/（8842 行）；
3. **旧 Electron 外壳**：main.ts（已删除）、preload.ts、renderer.ts，代码自称 "legacy Electron shell"，但仍被 desktop:build 构建，且 package.json 的 main 指向它的产物。

两套启动器各自实现设置读写、包枚举、后端子进程管理：Electron 用 launcher.json + saves/，LauncherCore 用另一份索引与实例目录。长期必然漂移。

**建议**：明确 Electron 外壳的产品状态——若不随产品发布，移出 main 字段并停止打包；若保留，至少复用 launcher-core 的设置/枚举逻辑。中期把 desktop/host 独立命名为应用层（如 apps/host），避免"宿主"藏在工具目录里。

### P3-1 launcher 深导入与正则白名单

[PresetContentEditor.vue](../../../apps/launcher/src/components/PresetContentEditor.vue) 直接：

~~~ts
import { rolePreset, ... } from '../../../../packages/provider-chat/src/preset.ts'
import { presetMacros } from '../../../../packages/provider-chat/src/preset-macros.ts'
import { REGEX_WORKER_PROGRAM } from '../../../../packages/provider-chat/src/preset-regex.ts'
~~~

[check-host-boundaries.mjs](../../../scripts/check-host-boundaries.mjs) 用一条正则 directModules 允许 launcher 直接引用这几个文件。provider-chat 没有 subpath exports，所以这不是"故意绕过"，而是缺少稳定入口。

**建议**：给 provider-chat 增加 exports 子路径（./preset、./preset-library 等），launcher 改用包名；边界检查器随后可删除这条白名单。

### P3-2 版本轴分散

当前同时存在：

- Manifest schemaVersion: 10；
- 源包 worldpack-source/v5；
- rulebook.version: 1 | 2 | 3 | 4，并有 version >= 4、version === 3 的历史分支；
- interaction-catalog/v3；
- SQLite user_version 19、memory 8；
- Round Authority schemaVersion 6；
- runtime capabilities 里的 sceneDecisionVersion: 2、agentContextVersion: 2。

它们各有理由，但仓库没有一处集中说明"哪些是当前值、哪些只为读旧数据"。读者需要在 5 个文件里拼出全景。
**建议**：在 docs/current/architecture 增加一张版本表，或在 contracts 顶部集中列出当前协议版本与兼容读取范围。

### P3-3 遗留命名与语言

- director / BranchPresentationComponent / worldDirector 仍是旧 Director 模型的命名，实际只持有确定性 Presenter；文档已承认"暂留"。
- 多处注释与错误文本仍带 Phase 0 / Phase 8 / prototype / experiment / Manifest v4，例如 "Authoritative Phase 0 World Event"（world-store）、"Phase 8 runtime capability"（world-spec）、"prototype concurrency"（activation-cycle）。
- 同一模块内中文用户文案与英文内部错误混用（rulebook.ts 英文 reason，http-server.ts 中文提示），没有统一约定。

**建议**：不改行为的前提下，删除历史阶段词；在注释里区分"玩家可见文案 / 创作者诊断 / 内部错误"三类语言。

### P3-4 无消费者或重复的遗留物

- world-host.example.yml（已删除） 的 maxConcurrentBranches / rescanIntervalMs 没有加载器，引用的 packages/operations 已不存在；
- experience:web 与 experience:web:flash 完全相同，后者只被归档文档引用；
- TENCENTDB_MEMORY_ENABLED = false（[local-memory.ts:235](../../../packages/memory/src/local-memory.ts)）为导出常量但无人使用；
- logical-transfer.ts 保留 v5/v6/v7 Authority 兼容解析，但生产入口不调用该服务。

**建议**：删除或在文件头标注"迁移期兼容，禁止新写入"。

## 5. 值得保留的做法

1. **确定性优先**：world-json 的 canonical 序列化、domain-separated hash、deterministicId，以及 store 的 request_hash 幂等重放，是这套代码最扎实的部分。
2. **失败关闭**：Manifest/回执/Authority 解析普遍先 canonicalize 再逐字段校验，未知字段直接拒绝；SQLite 打开时校验 application_id，迁移只前向。
3. **边界检查器 + 失败夹具**：[check-host-boundaries.mjs](../../../scripts/check-host-boundaries.mjs) 不完美（正则、只查相对导入），但有 [boundaries.test.ts](../../../tests/host/boundaries.test.ts) 覆盖放行/拒绝两侧，比"写在文档里的约定"可靠。
4. **入口布局回归**：[entry-layout.test.ts](../../../tests/host/entry-layout.test.ts) 真的构建 backend，并在源码、构建产物、安装布局三种形态下启动、请求 /api/state，这类测试比单元测试更能防住发布事故。
5. **测试目录分层**：tests/{host,desktop,scenarios,integration,support,experiments} 与"回归不得依赖 experiments"的规则清晰，[tests/support/README.md](../../../tests/support/README.md) 说明了唯一依赖方向。
6. **文档写法**：先给角色互动例子，再解释术语与源码，明确区分"源码已接通 / 测试范围 / 体验验收"，这在原型项目里很少见。

## 6. 建议路线

### P0（先消除歧义，风险最低、收益最大）

1. 删除 WorldKernel 或移出生产包；修正 code-walkthrough.md / modules.md 的生产路径描述。
2. 对 Reaction Cycle 做明确决断：删除，或标注"只读旧存档"并从 CommitRoundRequest 移除写入字段。
3. 删除 config/world-host.example.yml、experience:web:flash 这类无消费者的遗留物。

### P1（结构性收敛）

4. 抽出玩家/NPC 共用的"裁定 → Authority/观察/Outbox"构造器，先统一 ID 与受众规则，再谈调度差异。
5. 拆 WorldApplication：保留宿主 8 个方法 + 只读查询，其余移到 admin 模块。
6. 拆 WorldHostCore 的调度与状态投影；至少把"活动 / 自主性 / 普通反应"拆成独立方法。
7. 统一 untrusted-JSON 校验工具，消除三份 exactKeys。
8. 引入 formatter，并把 apps/launcher、scripts 纳入 lint。

### P2（渐进改善）

9. 默认测试至少纳入 round-coordinator、store、local-memory；regression 白名单改为目录规则。
10. 给 provider-chat 增加 subpath exports，替换 launcher 的五级相对导入。
11. 处理旧 Electron 外壳：明确不随产品发布并移出 main，或直接删除。
12. 逐步替换公共接口中的 any 与高频 !，优先 runtime-cordis 与 round-coordinator。

## 7. 未验证与限制

- 未运行 launcher:check、desktop:build、launcher:build、Rust 检查、Python Core 离线回归；发行布局与便携包未验证。
- 未做真实模型试玩；角色自然度、长期记忆收益、叙事一致性没有新的体验证据。
- 未做性能剖析；"每次操作打开多个 SQLite 连接"只是结构观察，未量化开销。
- 本报告的严重度是维护性判断，不是缺陷等级；默认回归全绿，不代表上述结构问题不存在。

## 附录 A：规模指标

| 指标 | 数值 |
| --- | --- |
| 生产源文件（ts/vue/rs/py，不含测试） | 约 258 |
| TypeScript 生产代码 | 约 3.9 万行 |
| ≥ 500 行的生产文件 | 18 |
| ≥ 1000 行的生产文件 | 6 |
| 最大文件 | world-store.ts 2076 行 |
| 形如 x! 的非空断言 | 约 250 处 / 64 文件 |
| 显式 any 词法命中 | 约 80 处 / 38 文件 |
| 默认回归 | 89 文件 / 757 用例，240.87s |
| 未纳入默认回归的包级单测 | 59 文件 / 约 1.3 万行 |
| Lint | 96 规则，0 error，2 warning |

## 附录 B：复现命令

~~~powershell
cd D:\DeepSeek Harness\Perspectra-code-cleanup-20261021
node scripts/check-host-boundaries.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/oxlint/bin/oxlint packages tests desktop vitest.config.ts vitest.regression.config.ts
node node_modules/vitest/vitest.mjs run --config vitest.regression.config.ts --maxWorkers=2
node scripts/docs/check-links.mjs
~~~

未运行项按第 1.3 节列出的命令补跑；其中 launcher:check、desktop:build 需要对应工具链。

## 附录 C：2026-10-21 处理记录

按用户选择，本轮处理 P0 全部与 P1-2，分支 codex/code-organization-20261021：

| 项 | 处理 | 说明 |
| --- | --- | --- |
| P1-1 | 已完成 | 删除 WorldKernel 及其测试；仍在用的 PlayerRoundResult、RoundExecutionLane、parsePlayerRoundResult 迁入 [round-coordinator.ts](../../../packages/application/src/round-coordinator.ts)；code-walkthrough 与 modules 改为以 RoundCoordinator 为玩家提交入口 |
| P1-3 | 已完成（删除） | 删除 store 状态机、contracts 存储契约、CommitRoundRequest 两个字段、门面 API、各处拦截、reaction-evidence 与 stable-call-budget；world 库迁移 v20 删四张表，开过/结算过 Cycle 的历史回合标记 legacy_reaction_link，完整性检查不再重算其 bundle hash 中已删除部分；未完成旧 Cycle 直接丢弃。Manifest 的 reactionPolicy 作为已哈希数据保留 |
| P3-4（部分） | 已完成 | 删除 world-host.example.yml、experience:web:flash、TENCENTDB_MEMORY_ENABLED；logical-transfer（含 v4–v8 兼容）随 Reaction 表一并删除，WorldApplication 去掉 exportAuthority/importAuthority |
| P1-2 | 已完成（观察段） | 新增 [action-observations.ts](../../../packages/application/src/action-observations.ts)，两条路径共用移动路线可见性、完整/仅知发生内容、观察 ID 与玩家投递；受众计算、预算与提示仍各自保留 |

P1-2 统一后的行为变化：NPC 观察 ID 由字符串拼接改为 deterministicId('observation:scene-result', …)；玩家回合的观察投递给所有作为观察者的玩家会话（此前只投递提交者）；NPC 投递 payload 去掉无人读取的 observationType；同一观察者若同时出现在完整与仅知发生两组，统一按仅知发生处理（现有受众计算不会产生这种重叠）。

第二轮（用户确认旧存档不再维护）：

| 项 | 处理 | 说明 |
| --- | --- | --- |
| 旧存档兼容 | 已删除 | 去掉 legacy_reaction_link；v20 迁移只删 Cycle 表，曾运行过 Cycle 的旧存档不再通过完整性检查 |
| P2-4 | 已完成 | 默认回归按目录运行全部 packages/**/*.test.ts（57 个文件约 17 秒）；覆盖率统计加入 desktop |
| P2-6 | 已完成（删除） | 删除 Electron 外壳、electron/electron-builder 依赖、desktop/desktop:release 脚本与 main 字段；desktop:build 只保留后端打包 |
| P2-3 | 已完成 | 新增 contracts/untrusted-json.ts，Manifest、world-pack 源文件与冻结交互三处读取共用；失败方式由调用方决定。其余 17 处 object() 多为带各自用户文案的一行判断，未统一 |
| P2-1 | 已完成（拆分保留） | WorldApplication 保留组合根、生命周期与游玩方法；只读查询移到 app.read（WorldReadQueries），备份/分叉/维护/隔离恢复移到 app.admin（WorldAdministration），两者经 WorldBranchAccess 访问分支；没有删除方法，组合根未上移到宿主 |
| P2-2 | 部分完成 | world-store 的建表与迁移移到 world-schema.ts；local-memory 的迁移与摘要分组移到 memory-schema.ts / memory-summaries.ts；WorldHostCore#activateCharacters 拆为建回合、活动链、场景反应、提示文案四个方法。WorldStore 类内的 Inbox/Outbox/认知任务与 world-pack schema.ts 未拆 |
| P2-5 | 已完成 | 引入 Prettier 3.6.2（无分号、单引号、120 列）并一次性格式化 379 个源码文件；世界包、文档、前端资产、JSON 不参与。lint 范围加入 scripts 与 apps/launcher/src；check 增加 format:check |

第三轮（P3）：

| 项 | 处理 | 说明 |
| --- | --- | --- |
| 格式化回归 | 已修复 | 第二轮的 Prettier 把 5 个双语句内联事件处理器拆成无分号多行，Vue 编译失败；vue-tsc 与 Launcher 单测未发现，只有 vite build 暴露。改为具名函数 |
| P3-1 | 已完成 | provider-chat 声明 preset、preset-library、preset-macros、preset-regex 子路径出口；Launcher 经 Vite/TS 别名用包名导入，类型从包入口 import type；边界检查器删除 Launcher 白名单，只保留纯 Node 发布脚本读取默认模板 |
| P3-2 | 已完成 | 新增 [协议与存储版本](../architecture/versions.md)，集中列出世界包、Manifest、运行时能力、规则、交互目录、Authority 与各 SQLite 库的当前值和旧值处理 |
| P3-3 | 已完成 | 分支组件 director 槽位与 worldDirector 服务改名为 presentation；删除执行不到的 rulebook v3/v4 分支（Manifest 类型收窄为 v2）、未使用的 SubmitActionsV2–V7、SceneDecision.directorEligible 与 presenter 的 reaction-round 分支；去掉错误文案与注释里的 Phase 0/8、Manifest v4、prototype 等阶段词；在[文档维护规则](../architecture/maintenance.md)写明三类文案的语言约定。sourceRole 'director' 与运行时注册表中的 director-planning 锁属于已哈希数据，保留 |

