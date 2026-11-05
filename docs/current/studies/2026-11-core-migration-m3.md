# 核心迁移 M3：状态机制与包内模块

开始：2026-11-04；收尾：2026-11-05。实施基线 `a9ab9ade`，接续[迁移计划](../../superpowers/plans/2026-11-04-core-mechanisms-migration.md)。本轮只完成 M3 的状态与包内模块拆分，活动机制、通信、自主配置及全局收口留给 M4～M7。剧情导演和外部插件通用持久状态继续暂停。

例如角色尝试偷走同伴的钱：机制根据角色已知信息提供操作，可信 resolve 根据真实余额提出变化；核心核验值与 Schema、告知权限和物品效果，才把结果与观察提交。替换解释器不能把不存在的余额、远处角色的告知或部分物品转移保存成事实。

## 1. 实际分层

| 层 | 当前入口 | 职责 |
| --- | --- | --- |
| 数据契约 | [contracts/status](../../../packages/contracts/src/status.ts)、[plugin-sdk](../../../packages/plugin-sdk/src/index.ts) | 既有状态／操作／事件数据类型与脚本限额；StatusSource、StatusInstance、ctx.status |
| 核心状态事实与授权投影 | [StatusState](../../../packages/application/src/status-state.ts) | 检查声明、值、Schema、归属、活动范围、告知对象与真实值；truth／known／playerTruth、初始值和轮末结果校验；不含 VM 或存储 |
| 内部机制 | [official-status](../../../packages/official-status/src/index.ts)、[模块脚本适配](../../../packages/official-status/src/modules.ts) | 解释 statusScript 与 packPlugin，组合现有脚本，计算 policy／resolve／轮末与 prepare；只返回数据 |
| 宿主资产与执行适配 | [status-source](../../../desktop/host/status-source.ts)、[StatusRuntime](../../../desktop/host/status-runtime.ts) | 校验资产；准备真实执行者和授权场景；重查许可、角色参数与物品可达性；把合法结果交 M2 核心执行 |
| 原生能力桥 | [PackModules](../../../desktop/host/pack-modules.ts) | 读取声明与锁定模块文本、核对依赖／方法、调用所选机制 prepareModule；管理异步原生调用、暂存结果、提交确认及失败清理，不执行 VM |
| 默认装配与交付 | [official-bundle](../../../desktop/official-bundle.ts)、[加载器](../../../desktop/host-plugins.ts)、Launcher | 通过 Cordis effect 注册官方默认，选择与实现分开；缺失槽位由默认组合提供，已选机制打开失败不回退 |

旧 desktop/host/pack-status.ts 已删除，不保留代理类或第二套实现。状态规则解释不再由 WorldGameplay 自行选择；它接收已准备好的 StatusRuntime。活动当前仍在宿主，复用此适配的状态查询和 activityEvent，不运行另一套状态解释器。

Lens 起点重写与分享导入仍明确使用官方只读预检组合，复用同一个 StatusScripts／StatusState，已移除旧静态加载调用。它们尚不加载任意用户解释器处理预检；完整创作者查询与扩展装配收口留给 M6。

## 2. Cordis 契约与权限

宿主 API 增量升到 **2.6**，2.0～2.5 插件仍可加载。通过 `ctx.effect(() => ctx.status.register(provider))` 注册单例，每世界及候选独立 open／close，ID／version／公开 identity 进入候选环境比较。清单与 Launcher 模块页识别 status。详细输入与错误契约见[作者指南](../guides/host-plugin-authoring.md#替换状态脚本机制26)。

只有所选状态 Provider 的 open 获得可选 statusSource，包含经验证的脚本文本、模块角色范围和已裁定的不可用能力 ID；不传 CompiledWorldPack、数据库、模型凭证或原生会话。状态资产按 256 KiB 校验，单模块资产仍为 64 KiB，组合脚本最多 256 KiB；官方每次调用仍用隔离 VM、100 ms 和有限 JSON。解释器本身属于可信原生代码，不提供恶意代码沙箱。

- **声明／初始化：** 世界有状态资产时必须提供对应实现；没有资产时 definition 必须为 undefined。核心规范化并校验声明，初始化结果必须完整且归属正确。没有通用外部插件状态注册、独立命名空间或新的持久状态挂载。
- **policy：** 只收到授权已知值与可见位置／物品。失败沿原行为隐藏该角色操作并记录诊断，不用全量 truth 替代。
- **resolve：** 可信规则获得 truth、真实 actor、操作参数、授权场景、目标和外部结果，返回候选；核心验证 Schema、值、活动范围、告知与物品。返回值不含提交能力。
- **prepareModule：** 只得到已知状态、真实 actor、模块局部操作与授权 world，不接收 truth。原生能力仍由桥调用，模块不能借更换解释器直接执行 Node 或异步脚本。
- **错误与生命周期：** 打开失败明确拒绝；机制计算异常记录真实 Provider ID。核心复制机制返回的数据再处理。先前已提交事实保留，非法候选不提交；关闭、取消、候选更换沿现有核心生命周期处理。

状态声明和模块声明在写 genesis 前完成核验；初始化仍作为既有独立状态轮次且只运行一次。显式声明空模块列表且无基础脚本时，继续初始化既有空状态事件；这与没有状态资产的世界分别处理。全部状态数据仍来自 status.updated，不新增数据库、事件类型、存档或脚本格式。

## 3. 玩法与提交语义

M2 的 executeWorldRound、NPC CharacterTurn 与玩家 RoundCoordinator 继续承担真实写入。原有脚本操作、活动中的状态结果、物品变化与观察仍走各自既有的原子事务。

包内模块的源码组合迁入 official-status，保留模块前缀、角色范围、不可用可选能力过滤，以及只转接基础 status.js 的 onRoundEnd；没有给各模块新增轮末钩子。PackModules 的描述和原生方法核验在激活前完成，世界激活后再绑定能力会话。

轮次计数留在宿主：有效玩家回合、静观、同回合多次提交、快捷活动两次提交和 retry 的含义不变。onRoundEnd 的变化及告知由核心检查；失败钩子不补跑，存储损坏不当作普通钩子失败吞掉。

原生 execute／resolveAction 继续按 operation、actor、参数和前缀匹配暂存结果。queued 只确认排队；completed 才让规则提出实际效果。外部已执行而本地失败时仍标记结果未知并停止后续操作；committed／failed 与 finally 清理保持，未承诺读档撤销外部副作用。

## 4. 验证

日志目录 `.tmp/migration-m3/`。整体对照仍使用 M0 的 `.tmp/migration-m01/baseline.json`，没有重录基线迁就实现。

| 检查 | 结果 |
| --- | --- |
| 接 Cordis 前的内部拆分回归 | 5 文件、77 项通过，`internal-split-tests.log` |
| 接 Cordis 后的相关回归 | 7 文件、89 项通过，`seam-tests2.log`；补齐空模块边界后 4 文件、78 项通过，`final-related.log` |
| 整体行为基线 | 12 组请求／转录／行动结果比较通过，`baseline-final.log` |
| Launcher | 类型及 98 项测试通过，`launcher.log` |
| 后端构建与构建后外部插件装载 | 构建通过，普通／自主／活动 3 项通过；状态服务实际打开并关闭，`build-final.log`、`bundle-final.log` |
| 全量检查 | 宿主边界（337 个生产文件）、类型、Lint、格式通过；185 文件中 181 通过、4 失败；1760 项通过、4 失败、4 跳过，`check-final.log` |
| 文档 | 模块地图覆盖新增包，没有新增断链；仍有 103 条历史断链报告（去重后 85 条）与 59 个缺失历史产物，`docs-final.log` |

全量命令因四项既有失败退出非零，不能称为全绿：story-nodes 缺本机记忆 Python；launcher-core 的受信任授权仅支持 Windows；plugin-requirements 子进程先报 Core 初始化失败；entry-layout 超时。它们与 M2 及此前未改运行时的基线一致，没有跳过测试或放宽断言。Lint 仍保留仓库已有警告。

另打包只导出 WorldApplication 的最小入口，159 个输入中没有 official-* 或 interactions-basic 实现，输入清单在 `minimal-bundle.json`。这验证依赖方向，不代替完整玩法与真实模型验收。

收尾回归先复现空模块声明丢失初始化的错误（`empty-modules-before.log`），再修复资产存在性与空组合处理；没有把合法空列表改成拒绝，也没有跳过原初始化检查。

新增测试覆盖真实外部 .mjs 注册并改变候选结果、打开失败不回退、异常归因、非法值与越权告知不提交、policy 的授权输入、候选实例关闭和 identity 改变后拒绝重生、禁止无资产挂载状态。包内模块另验证原生请求实际经过所选状态机制 prepareModule，收到授权值并沿旧事务提交。

未运行真实模型试玩或发布完整便携发行包；自动请求不代表玩法体验已验收。M4～M7 与两项暂缓需求未实施。
