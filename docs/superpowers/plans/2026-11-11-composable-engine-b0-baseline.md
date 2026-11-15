# B0 基线与可复用场景记录

日期：2026-11-11

状态：主代理复核通过。本文记录施工起点和现有机械对照，不表示真实模型试玩、GUI 或发行包已经验证。

## 1. 先看一次互动

例如玩家输入“我去厨房看看冰箱”。宿主可以把这次正式输入交给一个受控执行机会；当前规则若接受相应行动，物理事实、观察受众与世界时间由 Round 的提交边界校验并原子写入。深夜节奏条件也可能产生自己的 `status.updated` 来源和面向获准角色的刺激。Lens 逐步显示每个角色实际收到的内容，不会把厨房的只读事实或他人的消息塞给未获准角色。

“再给阿澄发消息”应通过通信行动或消息接口另行授权与提交；一句自由文本是否被拆成移动、消息等多个操作不属于本示例的保证。RPG 战斗按钮和 TRPG 主持操作同样各自走正式事实边界：前者产生持久活动状态、公开结果与分场景观察，后者把公开桌面、主持人私有笔记和暗骰受众分开。任何校验、取消、存储或机制回调失败都不得留下半截状态；已经提交的输入行动可以保留，后续机制失败应单独归因。

## 2. 工作树与材料

- 实现工作树：`D:/DeepSeek Harness/Perspectra-composable-impl`
- 分支：`codex/composable-engine-implementation`
- HEAD：`18f6a558ba2064baddfe28f38eb5e1ed4c555954`
- 原树：`D:/DeepSeek Harness/Perspectra V1`，只作读取来源
- 新数据根：`.tmp/composable-engine`
- 历史 `D:/worlds`：本轮未扫描、未写入。用户尚未声明需要保留的具体源包或存档，因此没有制定用户数据迁移清单。

已由主代理带入本工作树的 12 项材料包括根 [AGENTS.md](../../../AGENTS.md)、[文档入口](../../README.md)、[当前架构入口](../../current/architecture/README.md)、[文档维护规则](../../current/architecture/maintenance.md)、[机制契约](../../current/architecture/mechanism-contracts.md)、[模块地图](../../current/architecture/modules.md)、[分层范围记录](../../current/architecture/plugin-layering-direction.md)、[核心与插件规范](../../current/architecture/plugin-standard.md)、[原型契约](../../current/prototype-contract.md)、[架构定稿](../../current/architecture/composable-engine.md)、[实施计划](2026-11-11-composable-engine-refactor.md)和[架构草稿](../specs/2026-11-11-composable-engine-architecture-draft.md)。

未带入的实验材料为 `.claude/launch.json`、`.archviz/`、`drafts/`、`examples/world-packs/model-girls-sweet-days/prologue-draft.md`、`output/`、`packages/official-scheduler/src/autonomy-policy.test.ts` 和 `plugins/`。它们不构成本轮基线，也不因原树存在而被默认为需要兼容。

## 3. 已执行检查

主代理已完成离线依赖安装、类型检查和宿主边界检查。真实记录保存在 `.tmp/composable-engine/b0/setup.json`、`typecheck.log`、`boundaries.log` 和 `docs-links-before.log`。

| 检查 | 结果 |
| --- | --- |
| `corepack pnpm@11.7.0 install --offline --frozen-lockfile` | 退出码 0 |
| `corepack pnpm@11.7.0 typecheck` | 退出码 0 |
| `node scripts/check-host-boundaries.mjs` | 退出码 0，403 个生产文件 |
| B0 前 `node scripts/docs/check-links.mjs` | 退出码 1；103 条历史源码/导航断链；另报告 103 项未带入本地的历史产物缺失，两类计数独立 |
| B0 文档后 `node scripts/docs/check-links.mjs` | 退出码 1；missing-target 集合新增 0、移除 0；另有 103 项历史本地产物缺失 |

本阶段运行：

```powershell
corepack pnpm@11.7.0 test:related packages/application/src/world-round-execution.test.ts tests/host/communication-autonomy-seams.test.ts tests/scenarios/pacing-beats.test.ts tests/host/rpg-perform-path.test.ts tests/host/trpg-activity.test.ts tests/host/plugin-set.test.ts tests/host/pack-content.test.ts tests/host/rpg-pack.test.ts tests/host/trpg-pack.test.ts tests/host/lens-simulation.test.ts tests/host/lens-cli.test.ts tests/host/lens-rpg.test.ts --maxWorkers=1
```

原始输出保存在 `.tmp/composable-engine/b0/tests.log`。结果为 12 个测试文件全部通过、135 个测试全部通过，Vitest 汇总耗时 124.08 秒，真实退出码 0。该日志只报告文件与测试总汇总，因此本文不推断每个文件各自的执行数量。文档检查的 after 日志、真实退出码和集合比较分别保存在 `.tmp/composable-engine/b0/docs-links-after.log`、`docs-links-after-exit.txt` 和 `docs-links-comparison.json`。

环境为 Windows、Node `24.14.1`、pnpm `11.7.0`；使用单 worker 降低本机子进程资源竞争。日志仅出现 Node SQLite experimental warning，没有历史失败或环境跳过。本轮没有真实模型请求，没有运行全仓检查，也没有执行 GUI 或发行验证。

## 4. 五类机械对照

### 4.1 对话提交

对照为[即时 Round 测试](../../../packages/application/src/world-round-execution.test.ts)、[Lens 模拟测试](../../../tests/host/lens-simulation.test.ts)及其源码 [world-round-execution.ts](../../../packages/application/src/world-round-execution.ts)、[lens/simulation.ts](../../../desktop/lens/simulation.ts)。

已确认的行为是：Round 从已提交前缀取得快照，异步计算期间持有 fencing lease 但不占住 SQLite 事务；提交时重新检查 expected head 和 writer token，并把事实、观察、authority 与唯一一次 `world.tick-advanced` 原子写入。未绑定玩家、伪造 actor、未知观察接收者、取消后的晚到结果、陈旧前缀和存储故障都不会发布半截结果。

Lens 用临时数据目录运行，不修改源包和实际数据目录；每一步都按已提交事件列出各角色实际收到的内容，并能和普通 Host 的可见状态核对。没有提交的一步不会重复上一轮自动开始。

### 4.2 通信

对照为[通信与自主接缝测试](../../../tests/host/communication-autonomy-seams.test.ts)和[communication-runtime.ts](../../../desktop/host/communication-runtime.ts)。

已确认的行为是：通信、自主均可由实际 Cordis 替换实现打开；投递候选中的伪造 actor、收件人或绑定字段会在提交前被拒绝。机制失败会以对应机制归因，并且不会产生部分投递。初始投影删除未授权联系人，自主机制可在声明上限内否决广告行动，宽松的权限回调不能扩大地点或效果边界。

一个重要的现有边界是：玩家输入已经提交后，若随后的自主选择包含未声明角色，请求会报错，但已经提交的玩家事实保留。这说明原子边界覆盖单个机制提交，不表示多阶段周期失败时应当回滚先前已经提交的行动。

### 4.3 节奏

对照为[节奏场景测试](../../../tests/scenarios/pacing-beats.test.ts)和[status-runtime.ts](../../../desktop/host/status-runtime.ts)。

已确认的行为是：一个 beat 的 `status.updated` 变更、叙事文本和角色刺激可以一起提交，并只推进一次 tick；记录中的 `source` 能区分 `beat` 与普通玩家 Round。值无效、条件抛错或 `apply` 抛错时 beat 不提交，后续 Round 仍可重试；一个条件失败的 beat 不影响同一轮其他候选。

刺激只交付给脚本明确命名的角色。感知与作者念头分别记录为 `direct_observation` 和 `subjective_inference`，未命名角色的观察、状态投影和模型请求都不会看到它们。

### 4.4 RPG

对照为[RPG 行动路径测试](../../../tests/host/rpg-perform-path.test.ts)、[RPG fixture helper](../../../tests/support/rpg-fixture.ts)和受控包 [rpg.json](../../../tests/fixtures/rpg-pack/rpg.json)。

已确认的行为是：默认前端把战斗按钮当作正式的 `runtime.perform` 世界行动，而非另一条绕过提交的快捷接口。战斗目标、技能和回合输入会校验；非法操作不改活动状态。剩余灼烧回合可在故事分支中恢复，击杀 tick、活动胜利状态和掉落事实共享同一 transaction。

场景权限继续按已提交观察计算：留守在家的角色只会被告知队伍到达，不会获得遗迹战斗、生命值、隐藏储藏或击破细节。掉落不会伪装成玩家主动放下物品，玩家和队友也不会自动知道隐藏储藏位置。活动 `internal` 与 `private` 数据不会进入普通角色输入。

### 4.5 TRPG

对照为[TRPG 活动测试](../../../tests/host/trpg-activity.test.ts)、包内 [rainy-manor.trpg.json](../../../packages/official-trpg/src/fixtures/rainy-manor.trpg.json)和测试 [trpg-pack fixture](../../../tests/fixtures/trpg-pack/trpg.json)。

已确认的行为是：AI 主持人通过真实 `CharacterTurn` 发起 `activity:*` 操作，活动更新和私有笔记随其他事件提交。主持人邀请、参与者、公开桌面和私有 `rolls`/`secret`/`instructions` 分开；隐藏检定只写入主持人观察，其他角色看不到总数值或检定痕迹。主持人仅对单个玩家说的话不会进入桌面 `lastResult` 或其他玩家观察。

主持人操作只提供给主持人，结束后的操作和回合都被拒绝，私密笔记有明确长度上限。TRPG 内部状态变化不改变主世界物品或状态。重生成上一轮会复用已记录的骰值；若重生成需要更多随机值，则记录新值，后续重生成继续复用。

## 5. 真实入口

| 入口 | 当前源码与行为 |
| --- | --- |
| `worldpack` | [package.json](../../../package.json)指向 [cli-entry.ts](../../../packages/world-pack/process/cli-entry.ts)，其余命令委派给 [creator-cli.ts](../../../packages/world-pack/src/creator-cli.ts)。当前支持 `help`、`version`、`validate <dir>`、`compile <dir> --out <worldpack.json>`、`inspect <worldpack.json>`、`test <dir>`、`activate <worldpack.json> --data-dir <dir>` 和 `preset validate <file> [--pack]`；没有名为 `build` 的命令，构建使用 `compile`。`test` 只执行编译与适配，当前不执行剧本断言。 |
| `experience:web` | [package.json](../../../package.json)指向 [desktop/host/web-entry.ts](../../../desktop/host/web-entry.ts)。实际启动必须由 `--pack` 或环境配置指定 `worldpack-source/v5` 源目录；解析逻辑见 [launch-arguments.ts](../../../desktop/host/launch-arguments.ts)。 |
| Launcher | [desktop/launcher-entry.ts](../../../desktop/launcher-entry.ts)承载进程入口，[desktop/launcher-core.ts](../../../desktop/launcher-core.ts)维护包索引、实例元数据和子进程，并使用同一 web entry 打开选定包；它还创建和关闭包 Lens 页面。 |
| Lens CLI | [desktop/lens/cli.ts](../../../desktop/lens/cli.ts)提供 `view`、`requests`、`simulate` 和 `serve`。`simulate` 经临时模拟运行场景，并以 0/1/2 区分成功、命令失败和场景未通过。 |
| Lens 页面 | [desktop/lens/server.ts](../../../desktop/lens/server.ts)提供 token 保护的本地页面与 API，[view.ts](../../../desktop/lens/view.ts)和 [rpg-view.ts](../../../desktop/lens/rpg-view.ts)把源包内容投影为可检查条目。页面读取源包并创建模拟，不把 Lens 自己的记录写回包内容。 |

## 6. 真实持久对象

### 6.1 插件选择与生成内容记录

[plugin-set.ts](../../../desktop/host/plugin-set.ts)使用数据目录中的 `plugin-set.json` 记录 `seams` 和各生成器的 `generatedContent` 摘要。文件先写临时文件再 `renameSync`；候选世界不覆盖正式记录。缺失或损坏的记录只表示没有可比较的旧选择，世界仍可在报告变化后打开。

[pack-content.ts](../../../desktop/host/pack-content.ts)根据包中注册的配置生成状态模块、活动和规则。生成摘要覆盖生成器 id、版本、解析后的配置以及生成模块和活动；模块或活动重名在世界打开前失败。旧存档只复核它记录过的生成器：当前摘要变化或生成器缺失会拒绝打开，新增生成器因旧记录没有对应项而采用当前内容。

### 6.2 状态

[status-state.ts](../../../packages/application/src/status-state.ts)把状态事实保存在 `status.updated` 事件中。事件数据固定包含 `source`、`changes` 和 `reveals`；来源可为 `initial`、`operation`、`activity`、`round` 或 `beat`。`changes` 是权威真值，`reveals` 才决定某个观察者何时得知某个值。

读取侧只从已提交事件重建真值和角色已知值。活动范围内的变化要求来源 `activityKey` 属于状态声明的活动；普通状态变化的受众由 reveal 与场景观察决定，不能从叙事文本反推权威状态。

### 6.3 活动

[activity-state.ts](../../../packages/application/src/activity-state.ts)从 `activity.updated.data.state` 读取最新活动状态。状态包含 `id`、单调 `revision`、`participants`、`game` 和可选 `suspendedTurn`；`game` 再分为 `public`、每个参与者各自的 `private` 与 `internal`。读档会校验参与者、阶段、轮次、私有角色键和活动结构，并限制活动状态为 65,536 字符。

[activity-lifecycle.ts](../../../packages/application/src/activity-lifecycle.ts)要求请求的 id、revision、active 状态和参与者都与已提交状态一致。活动结果观察只向指定参与者提供结果元数据，私有笔记按接收角色分别生成观察，不会把 `internal` 或别人的私有材料自动广播。

### 6.4 世界事件、分支与故事节点

[world-schema.ts](../../../packages/store-sqlite/src/world-schema.ts)以 `branches`、`events`、`round_commits`、`round_authority` 等表保存分支和事实。子分支记录 `parent_address_key` 与 `fork_seq`；[world-store.ts](../../../packages/store-sqlite/src/world-store.ts)的读取按 fork 点截取父分支事件，并在提交时原子检查 head、tick、writer fencing、事件哈希和 transaction 绑定。

[story-nodes.ts](../../../desktop/story-nodes.ts)创建的是不可变故事节点快照，不直接继续写回原节点。保存前要求没有 pending/claimed Round、未完成的玩家输入任务、未投递的关键 outbox 和有效 writer lease；节点记录包 hash、`headSeq`、`tick`、父节点及实际存在的世界、会话、记忆文件。恢复只复制该节点列出的文件，并要求包 hash 相同和目标目录为空。

[story-share.ts](../../../desktop/story-share.ts)使用单节点 JSON 容器分享固定文件白名单，校验尺寸、base64、SQLite integrity、包 hash、Head/tick、世界事件链、会话投递一致性及静止状态。导入先验证临时副本，再以新节点 id 写入新实例；验证过程可能运行迁移，但不会改写来源节点。当前每个文件上限 64 MiB，总内容上限 96 MiB。

## 7. 验收边界

本阶段已满足直接基线与机械对照所需的条件：工作树和 HEAD 明确，带入文件与实验排除项明确，主代理的安装、typecheck、边界检查有真实日志，12 个批准测试文件以真实退出码 0 完成，五类场景路径和关键权限/提交行为已登记，真实入口与当前持久对象已链接到源码。

尚未验证真实模型试玩、正常 GUI 交互、Launcher 打包、发行候选和真实用户存档迁移。`D:/worlds` 未参与本轮检查，也没有据此断言存在必须兼容的持久数据。后续 B6/B7 应根据实际保留对象决定迁移，不沿用本阶段测试 fixture 臆测用户兼容需求。

B0 已由主代理核对原始测试日志、实际入口与持久对象、文档链接前后集合并通过复核。审阅中纠正了断链与本地产物缺失的混淆，以及 worldpack 命令范围的误述。下一步由 Kimi 制定 B1 细节，审阅通过后再交给 DeepSeek 实现。
