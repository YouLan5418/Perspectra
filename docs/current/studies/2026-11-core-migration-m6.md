# M6：作者契约与默认装配收口

日期：2026-11-05；分支 `fix/activity-notice-and-revision`；上一批 M5 为 `91292dbf`。依据[迁移计划](../../superpowers/plans/2026-11-04-core-mechanisms-migration.md)与[统一规范](../architecture/plugin-standard.md)。本批完成 M6，整体验收见[M7 记录](2026-11-core-migration-m7.md)；M7 审查修复了 M3 引入的状态错误类别回归。

例如作者给料理活动换一个状态解释器，透视起点校验和初始化也应使用它；开发者明确省略知识或长期记忆时，核心不能在下一轮或重生时把默认机制装回。本批处理这些具体装配问题，并把分散的身份、输入、权限、状态、失败与生命周期说明统一到[共同契约](../architecture/mechanism-contracts.md)。

## 实际变化

| 位置 | 变化 |
| --- | --- |
| [SDK 根入口](../../../packages/plugin-sdk/src/index.ts) | 只重导出分组后的 world、host、scheduler、character-loop、memory、llm、rules、decisions、knowledge、status、activities、communication、autonomy、capabilities、frontend、player-feed、version。根导出和 Cordis Context 扩充保持；exports 仍只有根入口，API 仍为 2.8 |
| [official-bundle](../../../desktop/official-bundle.ts) | 新增显式 WorldComposition／assembleRoleplay：交互安装、所选机制、模型装配器和调度失败回退。没有新注册框架或配置格式 |
| [WorldHostCore](../../../desktop/host/world-runtime.ts) | 必须接收完整组合；编译、基础规则和 WorldApplication 使用同一安装列表，不补交互或缺席可选机制。必要服务和包声明的机制缺失时，在激活前失败 |
| WorldHostRuntime／[TailRoundRuntime](../../../desktop/host/tail-runtime.ts) | 默认 RP 由公共桌面入口明确选择；显式组合原样传给候选。环境比较使用实际安装目录与所选 Provider，不再写死基础交互 |
| [WorldAdapters](../../../desktop/host/world-adapters.ts) | 原 WorldGameplay 的 prepare／load 装配方法退出，剩下执行适配器上的规则与上下文投影。宿主启动阶段显式绑定适配器；没有 ctx.gameplay，也没有并行旧生产类 |
| [创作者查询](../../../desktop/host/creator-queries.ts) | 只接收 statusTruth／activityStates 只读能力，不获取整个适配器集合，不另建状态或活动解释器 |
| [Lens](../../../desktop/lens/simulation.ts)／[会话](../../../desktop/lens/session.ts) | 可接收同一组合并贯穿重启／重载；起点状态覆盖所选 Provider.initialize 的结果，再沿正式 StatusState 检查。删除直接制造默认 StatusScripts 的路径，不再重写 status.js 来覆盖初始值 |
| [故事分享](../../../desktop/story-share.ts) | 可明确传入相同组合；一次性副本上的状态声明预检通过所选 Provider.open／close 和 StatusState，复用[公共角色描述](../../../desktop/host/world-cast.ts)。不执行初始化、不改发送者节点 |
| [静态边界](../../../scripts/check-host-boundaries.mjs) | 保留所有原边界；补核心依赖宿主、SDK 运行时依赖实现、世界包脚本导入 Cordis／原生 SDK 的拒绝检查与回归 |
| 创作 Skill、CLI 与发布 | Skill 同步层次和格式含义；world-pack 库仍消费公开安装契约，进程明确选择基础交互，结构校验不执行 hook。发布入口打包同一 CLI／Lens；记忆布局检查改从公开包根导入 coreRunner，而非私有 worker 文件 |

未新增包、子路径、脚本 SDK、事件、数据库、队列或版本迁移。脚本、JSON、角色输出格式保持；既有数据的授权与提交仍沿前几批的核心检查。测试与实验中需要单实例 RP 核心的调用，改为显式选择同一组合的测试辅助，不在生产核心保留旧默认回退。

## 契约与选择

默认桌面入口仍保持原行为。plugins 是默认 RP 的覆盖列表；显式 composition 的 mechanisms 为最终选择，不再二次补齐，不与 plugins 同传。省略 knowledge／memory 等可选服务，回合和重生保持缺席。状态／活动／通信／自主资产需要对应机制，scheduler、characterLoop 及模型通道／模型装配器是此宿主的必要能力。

调度打开失败的官方回退仍是默认 RP 明确选择的策略，自定义组合未提供 fallbackScheduler 时不会临时制造官方实现。模型失败不改投，状态解释器等已选服务失败不换实现。关闭、取消、最新前缀和原子提交保持原路径。

Lens 使用所选解释器的声明校验起点键和 owner；覆盖值交实际初始化流程的 Schema／归属检查。错误发生在 Provider.open 的装饰期间时，已经打开的实例也会关闭。透视 UI 的声明、操作和状态继续从真实运行实例查询，角色权限不因创作者可见真值而改变。

分享预检只是声明检查与既有快照校验，不保证任意第三方算法、插件文件或外部副作用都可恢复。CLI／Launcher 的透视和分享默认入口仍明确使用默认 RP，不自动装载任意用户原生插件与凭证；需要相同原生机制的宿主集成应显式传入 composition。此限制没有被隐藏为另一份默认解释器。

SDK 按职责整理，但只发布既有根类型面。内部文件不是可用 npm 子路径；普通作者脚本不导入它们，继续使用既有授权数据与候选格式。完整机制表、生命周期和失败语义集中在共同契约，具体方法仍链接到作者指南，避免强造统一万能 hook。

## 验证

日志目录 `.tmp/migration-m6/`。整体基线继续比较 M0 的 `.tmp/migration-m01/baseline.json`，未重录。

| 检查 | 结果 |
| --- | --- |
| 相关回归 | 6 文件、57 项通过，`related1.log`：透视、创作者查询、装配、调度接缝 |
| 新组合及边界回归 | 2 文件、9 项通过，`composition2.log`：8 项新组合／透视／分享测试及强化原边界用例 |
| 全量检查 | 368 个生产文件边界、类型、Lint、格式通过；188 文件中 184 通过、4 失败；1798 项通过、4 失败、4 跳过，`check.log` |
| 行为基线 | 12 组请求／转录／行动结果比较通过，`baseline.log` |
| Launcher | 类型检查、98 项测试通过，`launcher.log` |
| 后端构建与外部插件 | 构建通过，普通／自主／活动／短信 4 项构建后装载通过，`build.log`、`bundle.log` |
| 隔离创作 CLI | 中文／空格路径、PATH 隔离、模型调用 0；version、help、validate、test、compile、inspect、activate、错误封装及 lens-view 通过，结构检查未执行玩法脚本，`cli.log` |
| 创作 Skill | 脚手架、引用样例、物品模板、卡片 PNG／JSON 提取、预设和拒绝边界通过，`creator-final.log`。临时程序目录使用本机标准库 Python 启动器，非完整便携 Python 发行验收 |
| 记忆公开入口 | 源码与打包后的 coreRunner 公共根导出通过，未启动 Python，`core-public-entry.log`；完整 Core 布局／模型环境未验收 |
| 最小核心依赖 | 163 个输入中没有 official-*／interactions-basic 实现，`minimal.log`、`minimal-bundle.json` |
| 文档 | 模块地图覆盖完整，无新增断链；仍有 103 条历史断链报告（85 条去重记录）与 59 个缺失历史产物，`docs-final.log` |

全量命令仍因四项既有失败退出非零：story-nodes 缺本机记忆 Python，launcher-core 的受信任授权仅支持 Windows，plugin-requirements 子进程先报 Core 初始化失败，entry-layout 60 秒超时。与 M5 基线相同，没有跳过测试、放宽断言或给旧协议加兼容分支；既有四项 skip 和 Lint 警告保持。

Skill 完整验证第一次在卡片提取处发现隔离 CLI 测试目录未含 Python 启动器；补齐该临时环境后原验证脚本通过，未修改生产校验或跳过提取。Core/E5 的 Python 依赖仍缺失，不能据此声称本机记忆或完整便携发行已经通过。

新测试验证：核心必须有显式组合，省略机制在普通轮次和重生后仍不补回，空安装不会制造默认交互，缺少所需状态机制拒绝打开，自定义组合没有隐式调度回退，透视通过所选声明与初始化应用覆盖、会话重载保持选择，分享通过同一所选服务并清理实例。所选原生状态测试故意使用默认解释器无法执行的源文本，防止悄悄走另一套规则。

未运行真实模型试玩或完整便携发行包；默认请求基线相同不等于角色自然度／玩法体验已验收。M7 的最小核心、不同玩法共享机制及存档分支整体验收仍未完成。剧情导演（扰动器＋节拍器）和通用外部插件持久化世界状态继续暂停。
