# 核心迁移 M2：执行边界与显式默认装配

日期：2026-11-04。实施基线 `a0206327`，接续[迁移计划](../../superpowers/plans/2026-11-04-core-mechanisms-migration.md)与[M0／M1](2026-11-core-migration-m01.md)。范围仅 M2，状态、活动等完整 Cordis 迁移留给 M3～M5；剧情导演与外部插件通用持久状态继续暂停。

例如作者脚本提出把杯子交给同场角色，脚本不能决定写入哪条分支，也不能把一半结果保存下来。宿主绑定真实行动者，在已提交前缀上裁定，核心检查物品去向与写入资格，然后把事实、观察和回合记录一起提交。关闭世界或等待外部结果期间前缀发生变化时，旧结果不能再提交。

## 1. 默认组合退出核心

[WorldApplication](../../../packages/application/src/world-application.ts) 不再导入 interactions-basic，移除 DEFAULT_INTERACTION_PACKAGES 及对应包依赖。interactionPackages 省略时为空，只能激活不选择交互包的世界；若世界选择了未安装的包，仍在 genesis 前拒绝。

桌面默认组合由 [official-bundle.defaultInteractionPackages](../../../desktop/official-bundle.ts) 显式提供，宿主编译、规则层与 WorldApplication 使用它。rule-layers 接收安装列表，不自行补基础包。PackActivity／PackActivities 的回退只建立空安装的核心注册表，生产宿主显式传入已有规则链；独立测试消费者也显式装配。

创作 CLI 的库函数区分编译所需的 interactionPackages 描述与激活所需的 interactionImplementations。两者均由[进程入口](../../../packages/world-pack/process/cli-entry.ts)选择并传入，库不重新决定默认玩法。仅提供描述不会授予执行实现。

[生产边界检查](../../../scripts/check-host-boundaries.mjs) 增加 application／kernel／store-sqlite 不得导入 interactions-basic 的约束，不放宽已有官方机制与宿主的边界。

## 2. 空交互选择一致性与最小入口

移除世界包源文件、编译目录和存档读取的“必须至少一个交互包”限制，保留数量上限、锁、引用、绑定、依赖闭合与已安装实现核验。不增加 Manifest、数据库或宿主 API 版本。空 packages 不能借机选择其他包的定义；已有场景仍显式选择自己的包。

[M1 探针](../../../tests/scenarios/minimal-core-probe.test.ts)已从期望错误改为正确行为：WorldApplication 只给 worldPath／sessionPath，Manifest 显式选择空交互目录和空 plugins，即可激活、提交公开发言、读取授权角色视图、关闭并重开；越权读取仍拒绝。不要求模型、Python、预设、舞台或记忆路径。

这使用当前合法的编程式 CompiledWorldSpec，不在核心加“测试玩法”分支。空交互世界包可编译并往返解析；默认世界包装配仍选择 agent-context，选择它的世界仍必须配置授权来源 SQLite。这与 Python Core 算法分开，也不表示网页入口已无需模型。

该入口验证了 M2 的最小装配基础。通用状态机制、完整存档分支组合及不同玩法整体组合的最终验收仍属 M3～M7，不能称为全部最小核心目标完成。

## 3. 核心执行契约

新增 [executeWorldRound](../../../packages/application/src/world-round-execution.ts)，替代状态、活动和通信里重复的即时提交管线。这是宿主适配调用的核心函数，**不是 Cordis 服务，也不放进插件 SDK**。不给脚本传递数据库、租约或任意 commitRound 回调。

| 项目 | 当前处理 |
| --- | --- |
| 输入来源 | 宿主提供已绑定的 address、owner、真实玩家 actorId、可选生命周期 signal；系统轮次无玩家 actor |
| 读取 | 核心取得 fencing 租约，读取同一已提交 head、Manifest、事件前缀和该事务既有 authority；裁定回调仅接收数据快照 |
| 业务规则 | 既有宿主适配保留状态／活动／通信协议、幂等检查、受众与观察构造；不把一个万能执行接口交给插件 |
| 核心复核 | 玩家必须在 Manifest 绑定；authority 与 action.resolved 的 actor 一致；观察接收者必须存在；tick 仅由核心生成；具体受众权限继续由既有场景／机制检查 |
| 提交 | Store 原子复核分支状态、最新前缀、租约有效期和 fencing，保存事实、观察、tick 与 authority；等待外部能力时没有 SQLite 长事务 |
| 取消／失败 | 裁定前和等待返回后检查 signal；过期／取消不提交，不自动重做外部效果；finally 释放自己的租约，不释放取代它的写入者 |
| 保存 | 沿用世界事件及既有回合记录，无新文件、状态命名空间或存档格式 |

实际写入路径逐项核对：

| 路径 | 本轮处理 |
| --- | --- |
| CharacterTurn：NPC 行动、观察与 outbox | 原有受控激活、最新前缀、取消与短事务保持；未强行改用即时提交函数 |
| RoundCoordinator：玩家收件箱与原子回合 | 原有准入、写租约、观察、outbox 和恢复保持 |
| PackStatus：ensureInitial／apply／endRound | 改用核心即时执行；保留初始化一次、请求内容幂等、外部能力完成确认和回合计数 |
| PackActivity：apply／escape／worldAction | 改用核心即时执行；保留快捷操作两次提交、活动 revision、参与者、受众和逃生语义；retry 只触发后续处理，不写新玩家回合 |
| CrossSceneCommunication.perform | 改用核心即时执行；从存储的 Manifest／前缀裁定，保留发送失败记录与发送者反馈，不授予远端物理权限 |

活动目录关闭会中止其执行信号；玩家即时状态／活动／通信输入接入宿主取消信号。已经提交的事实保留。外部副作用发生后本地提交失败，仍沿用现有 RESULT_UNKNOWN 处理，不承诺撤销现实世界效果。

[物品效果检查](../../../packages/application/src/item-effects.ts)从 PackStatus 移入 application：可达性、实体存在、外观变化保留位置／持有者、合法接收者或当前位置、一次结果至多移动一件物品、不接受无效去向。玩家和 NPC 的状态裁定共用它。状态声明 Schema、值及 reveal 的授权检查仍由宿主侧 PackStatus 执行，M3 再拆离计算与核心检查，未把它们迁给外部脚本。

## 4. 验证

本轮新日志目录为 `.tmp/migration-m2/`。整体请求对照复用 M0 冻结的 `.tmp/migration-m01/baseline.json`；不修改基线迁就新实现。

- 12 组场景的请求、转录与行动结果对比通过，`baseline-compare.log`。
- 相关状态／活动／通信与默认装配回归 7 文件、96 项通过，`explicit-activity-tests2.log`；新增核心执行与空源包测试也纳入下面全量检查。
- `check --maxWorkers=2` 的宿主边界（332 个生产文件）、类型、Lint、格式通过；184 文件中 180 通过、4 失败，1750 项通过、4 失败、4 跳过，`check.log`。Lint 仍有既有警告；检查命令因测试失败退出非零，不能称为全绿。
- Launcher 类型检查与 98 项测试通过，`launcher.log`。
- 后端构建通过，构建后三种游戏子进程装载／关闭知识插件的 3 项测试通过，`build.log`、`bundle.log`。
- 真实 CLI 进程编译 hand-in-hand 并在本轮新目录激活成功，`cli-compile.log`、`cli-activate.log`；没有读取或改动历史世界。
- 另以 esbuild 打包仅导出 WorldApplication 的入口，89 个输入中没有 official-* 或 interactions-basic 的运行时实现，输入清单在 `minimal-bundle.json`。这是依赖核对，不代替玩法验收。
- 文档检查没有新增断链，模块地图已同步；仍有原先 103 条历史断链报告（去重后 85 条），另有 59 个缺失历史实验产物，`docs.log`。

四项全仓失败与 M1 相同：story-nodes 缺 Python 记忆环境；launcher-core 的受信任授权仅支持 Windows；plugin-requirements 子进程先报 Core 初始化失败；entry-layout 超时。它们此前在未改运行时的基线已复现，本轮没有跳过测试、放宽断言或修改这些环境路径。

核心新增六项失败路径与事务测试，验证事实／观察／authority 一起提交、无提交的重试、非法行动者／接收者、取消后返回、旧前缀、fencing 被取代、存储故障回滚及干净重试。既有状态、物品、活动与通信场景验证各自业务权限；自动模型不代表真实体验验收。

没有真实模型试玩，没有发布完整便携发行包；没有扩大到 M3。M1 记录中的空目录阻塞已在本轮解决，原记录保留当时发现。
