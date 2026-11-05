# M5：通信计算与自主策略迁移

日期：2026-11-05；分支 `fix/activity-notice-and-revision`；上一批 M4 为 `0bc481a7`。依据[迁移计划](../../superpowers/plans/2026-11-04-core-mechanisms-migration.md)与[统一规范](../architecture/plugin-standard.md)。本批完成 M5，M6～M7 待实施。

例如玩家给后室同伴发短信，同伴可以根据自己的目标获得一次自主处理机会。消息表达、可选联系人与自主触发策略现在由 Cordis 机制计算；真实发送者、收件权限、局部认知与世界效果仍在核心检查。普通 publish 不会变成远程投递，收到消息也不代表正文说的事情已成为世界事实。

## 职责和依赖

| 位置 | 职责 |
| --- | --- |
| [contracts/gameplay](../../../packages/contracts/src/gameplay.ts) | CommunicationDefinition、AutonomousRole 与触发数据；消息信封、机制操作 ID 与活动管理标识集中在公开契约 |
| [official-communication](../../../packages/official-communication/src/index.ts) | 消息参数、选项、正文／说明与角色指引；通过 ctx.communication 注册，不读取数据库、不返回事件 |
| [official-scheduler/autonomy-policy](../../../packages/official-scheduler/src/autonomy-policy.ts) | 解析既有自主声明、按交易计数触发频率、计算许可和指引；通过独立 ctx.autonomy 注册，Provider ID 为 official-autonomy |
| [CommunicationRules](../../../packages/application/src/communication-state.ts) | 联系人声明、实际信封和收发身份检查；验证计算提案，生成已认识的 speech／收件观察事实 |
| [autonomy-state](../../../packages/application/src/autonomy-state.ts) | 验证 NPC 身份、有限机会及地点／目标／操作声明；自主行动不能突破声明上限 |
| [gameplay-source](../../../desktop/host/gameplay-source.ts) | 复用已有 packJsonAsset 的路径、普通文件、64 KiB、资产大小和散列检查，提供锁定配置及公开标识 |
| [gameplay-services](../../../desktop/host/gameplay-services.ts) | 检查实例契约、复制输入和结果、归因机制异常；没有配置不能无声明安装通信或自主状态 |
| [CommunicationRuntime](../../../desktop/host/communication-runtime.ts) | 绑定基础规则、真实输入与 executeWorldRound，保留手动入口的玩家绑定、观察和原子提交 |
| [AutonomyRuntime](../../../desktop/host/autonomy-runtime.ts) | 从已提交事件／Authority 提取去重交易摘要，检查选中角色、生命周期、地点、行动与实际效果边界，将机会交现有调度器 |
| [WorldGameplay](https://github.com/YouLan5418/Perspectra/blob/91292dbf/desktop/host/world-gameplay.ts)／默认组合／Launcher | 接收选中实例并装配执行适配；不再读取配置或制造默认机制，模块页展示所选服务 |

旧 pack-communication.ts 与 pack-autonomy.ts 已删除，不保留并行生产实现。自主策略并入已有 official-scheduler 包，没有另建 scheduler 包或自主执行循环；ctx.autonomy 是配置／纯策略的独立选择，与 ctx.scheduler 的机会消耗分开。预算、动态并发、分段测量控制、角色续写均复用原路径。

通信定义的角色和联系人合法性留核心，默认机制直接提供原配置作为声明；联系人选项与消息计算可替换。自主原始 JSON 的严格解析在机制，规范化后的身份、机会与范围在核心复核。两部分都沿用 M3／M4 的“机制计算，核心检查并提交”切分，没有把原宿主类整体公开为插件 API。

## 契约、状态与失败

API 增到 **2.8**，新增 ctx.communication／ctx.autonomy，2.0～2.7 插件仍可加载。清单、实际服务记录、Launcher 标签与模块页、候选环境的 ID／version／公开 identity 均接通；默认机制经相同 Cordis register／effect 安装，每世界与候选独立 open／close。选定机制打开失败拒绝世界，不回退。完整方法见[作者指南](../guides/host-plugin-authoring.md#替换通信与自主策略28)。

只有对应选中 Provider 获得 communicationSource／autonomySource，其他机制不自动获得这些资产。Source 不包含整个编译包、数据库、凭证或提交句柄。两种配置和既有脚本、事件、世界库版本保持，没有通用插件持久状态。

通信 prepare 只得到已授权 actor／recipient／text／长度。核心固定发送者、收件人和 medium，候选只接受正文、说明或明确拒绝。候选不得携带任意事件或改写身份；手动 parameters 还须与调用者请求的收件人和正文绑定，即便另一个联系人同样已授权也不能悄悄改投。接收观察只含消息；发送者观察和消息事实与收件观察沿同一事务提交。基础远端物理权限没有放宽。

自主 due 不接收原始私密事件或上下文，只接收已确认玩家行为的标识摘要。官方按匹配交易计一次，保留 everyPlayerTurns、triggers、opportunities、地点和目标含义；静观计入，失败行为、NPC ticks 和开始／暂停等管理操作不计入。摘要来自本分支的正式前缀，缺失 Authority 仍报存储错误，不吞掉。

选中角色必须来自合法 roles，不得重复、不能为玩家；宿主继续检查 active 与当前位置，并排除活动参与者。permits 只能进一步收窄广告选项和行动，true 不能突破声明或基础规则；解析后效果仍检查实际移动与 resolvedRoles 目标范围。未提交计算不持久化，节点、重生与候选继续从事件重算。

机制调用的输入与返回值均复制。计算异常带 Provider ID，非法通信候选不提交；自主计算失败保留已经提交的玩家输入。原执行器负责取消、前缀、租约与原子性；本批没有改变崩溃恢复边界。可信原生插件仍有既有 WorldReader／数据目录能力，这些窄输入不构成恶意代码沙箱。

## 验证与限制

日志目录 `.tmp/migration-m5/`。整体行为继续比较 M0 的 `.tmp/migration-m01/baseline.json`，没有重录基线。

| 检查 | 结果 |
| --- | --- |
| 原有相关回归 | 5 文件、61 项通过，`related1.log`：自主、跨场景短信／电话、动态调度与活动自动开场 |
| 替换机制与源码装载 | 2 文件、21 项通过，`seams3.log`：18 项新接缝测试及当时 3 条源码装载路径；后补短信装载路径由全量与构建后测试验证 |
| 整体行为基线 | 12 组请求／转录／行动结果比较通过，`baseline-final.log` |
| Launcher | 类型检查与 98 项测试通过，`launcher.log` |
| 后端构建及构建后外部机制装载 | 构建通过，普通／自主／活动／短信 4 项通过；通信 prepare 实际收到真实发件人、收件人和正文，服务均独立关闭，`build.log`、`bundle.log` |
| 全量检查 | 350 个生产文件边界、类型、Lint、格式通过；187 文件中 183 通过、4 失败；1790 项通过、4 失败、4 跳过，`check.log` |
| 最小核心依赖探针 | 163 个输入无 official-* 或 interactions-basic 实现，`minimal.log`、`minimal-bundle.json` |
| 文档 | 模块地图覆盖新增包，无新增断链；仍为 103 条历史断链报告（85 条去重记录）、59 个缺失历史产物，`docs-final.log` |

全量命令因四项既有失败退出非零：story-nodes 缺本机记忆 Python，launcher-core 受信任授权仅支持 Windows，plugin-requirements 子进程先报 Core 初始化失败，entry-layout 60 秒超时。与 M4 基线相同，没有跳过测试或放宽断言；既有四项 skip 保留，Lint 保留已有警告。

新测试覆盖真实 .mjs／Cordis 双服务装载并改变消息和自主指引、打开失败不回退、伪造 sender／recipient／events 字段不提交、消息计算输入范围和错误归因、拒绝越权联系人选项、许可钩子收窄行动、拒绝未知自主角色且保留玩家事实、非法角色／地点／机会元数据、独立候选关闭与公开 identity、无配置不挂载机制状态、手动收件人绑定，以及原生许可全部放行时的自主位置和实际效果边界。

手动收件人测试促使参数生成补上原请求绑定，避免即使两个联系人都授权也被改投。该入口与普通动作仍共用真实信封检查；没有以隐藏选项替代执行检查。

没有运行真实模型试玩或完整便携发行包验证；自动请求与构建测试不等于玩法体验验收。电话仍仅是实验路径，现有实验回归保持。作者面统一、默认组合最终收口和最小核心整体验收仍属 M6～M7。剧情导演（扰动器＋节拍器）与通用外部插件持久化状态继续暂停。
