# M4：活动机制与宿主执行分离

日期：2026-11-05；分支 `fix/activity-notice-and-revision`；上一批 M3 为 `36d3efd8`。依据[迁移计划](../../superpowers/plans/2026-11-04-core-mechanisms-migration.md)和[统一规范](../architecture/plugin-standard.md)。本批完成 M4，M5～M7 待实施。

例如猜数字与 RPG 战斗继续使用各自世界包脚本；共同的活动解释器及候选选择现在可以经 Cordis 更换。换解释器不能让不存在的角色加入活动、读取别人的私有手牌、打断已提交的前台活动，或直接提交世界事实。默认玩法行为保持。

## 职责与依赖

| 位置 | 职责 |
| --- | --- |
| [contracts/activity](../../../packages/contracts/src/activity.ts) | 共享活动数据、请求、自动开场检查与作者透视形状，替代其他模块从旧宿主类导入类型 |
| [ActivityStateRules](../../../packages/application/src/activity-state.ts) | 声明及操作 Schema、已提交状态、参与者、private 归属、阶段／轮次与角色作用域投影；不执行 VM、不写数据库 |
| [official-activities](../../../packages/official-activities/src/index.ts) | 解释既有活动钩子，默认前台／最近／首项选择，自动开始最多条件优先及平局随机；不依赖 application、kernel、store 或 desktop 实现 |
| [activity-source](../../../desktop/host/activity-source.ts) | 发现已声明活动，验证路径、普通文件、尺寸、资产散列，交付锁定文本 |
| [activity-world](../../../desktop/host/activity-world.ts) | 授权世界读取与 actorWorldView，供活动、状态、原生桥共用；不反向依赖活动执行 |
| [activity-service](../../../desktop/host/activity-service.ts) | 核对所选机制与资产 key 一致，复制输入／输出，绑定方法并归因异常 |
| [ActivityRuntime](../../../desktop/host/activity-runtime.ts) | 准备授权输入，检查玩家／NPC 的真实执行者与许可，绑定现有 Rulebook 和 executeWorldRound；保留开始、暂停、继续、放弃、逃生、观察与活动／状态原子效果 |
| [ActivitiesRuntime](../../../desktop/host/activities-runtime.ts) | 当前前缀缓存、唯一前台与自动开始资格检查，调用选择机制，提供现有回合随机记录，管理连接与取消 |
| [official-bundle](../../../desktop/official-bundle.ts)／[加载器](../../../desktop/host-plugins.ts)／Launcher | 通过同一公开 Cordis API 注册官方默认，记录实际 ID／version；选择与实现分开 |

旧 desktop/host/pack-activity.ts 与 pack-activities.ts 已删除，不保留代理类或第二份解释器。WorldGameplay 接收已经打开的活动实例，不能自行制造官方默认。基础核心规则由组合显式提供，活动内部不再回退创建默认规则。测试夹具也显式组合机制与执行适配。

计划原文曾将 state／game 校验整体归机制；本批按不可替换的事实／隐私边界收窄：参与者、持久状态形状和授权投影留核心，具体脚本计算与候选策略才可替换。这与 M3 的 StatusState 切分一致，没有把旧活动宿主整类公开成插件接口。宿主仍有活动专用执行适配，不宣称完成全部最小核心验收。

## 契约、权限与生命周期

API 增到 **2.7**，新增 `ctx.activities`；2.0～2.6 插件仍可加载。清单、Launcher 模块展示与服务标签、实际插件组合记录、候选环境的 ID／version／公开 identity 均接通。每世界与候选独立 open／close；选择的机制打开失败明确拒绝，不回退。详细方法见[作者指南](../guides/host-plugin-authoring.md#替换活动机制27)。

只有选中的活动 Provider 在 open 得到 activitySource。它不是整个编译包、活动宿主类、数据库或提交回调。返回活动 key 必须与资产声明精确一致；空资产对应空目录，不能借此声明任意持久状态。

policy 收到参与者自己的 private 与 public；simulate 沿原授权角色请求。resolve、published、schedule／outcome 是可信规则，按原语义可使用完整活动状态；autoStart 可读状态 truth 和玩家授权 world。它们不能将真值直接灌入模型请求。输入和提案复制后再处理，插件修改对象不会改变缓存或已提交事实；核心继续检查游戏状态、操作 Schema、参与者激活与观察。

活动和状态通过 M3 StatusRuntime.activityEvent 等既有检查组合，不重复保存 truth，也不让 official-activities 运行时依赖 official-status。原子提交、最新前缀、租约、取消、重入、失败清理仍走 M2 执行器。

默认自动开始仍在状态轮末之后检查，每轮至多一场，不连锁；暂停进度不自动重开，已有前台不被选择器隐藏。只把满足条件的候选摘要交给选择机制；返回未入选 key 被拒绝。随机抽取与初始化消费同一个既有回合序列，候选重生按记录回放；借出的 random 在同步调用后立即失效。没有新的调度循环或随机协议。

官方 VM 继续 100 ms、有限 JSON、禁字符串／WASM 代码生成；simulate 输入上限 1 MiB，其他输入及输出 64 KiB，活动源文本沿既有 SCRIPT_SOURCE_LIMIT。原生替换机制是可信代码，这些 VM 限额不构成原生插件沙箱。机制异常带真实 Provider ID 与活动 key；TypeError／RangeError 保留自动开始逐项诊断语义。合法开始已经提交后，调度失败不会撤销它。

## 验证与限制

日志目录 `.tmp/migration-m4/`。整体行为继续比较 M0 的 `.tmp/migration-m01/baseline.json`，没有重录基线适应实现。

| 检查 | 结果 |
| --- | --- |
| 既有活动相关回归 | 5 文件、75 项通过，`related2.log`：活动、状态联动、自动开场、官方示例 |
| 新活动服务与源码装载验证 | 2 文件、14 项通过，`seam3.log`：11 项新接缝测试和 3 项源码后端外部插件测试 |
| 整体行为基线 | 12 组请求／转录／行动结果比较通过，`baseline.log` |
| Launcher | 类型检查与 98 项测试通过，`launcher2.log`；同步迁移服务标签与 Lens 共享类型 |
| 后端构建与构建后插件装载 | 构建通过，普通／自主／活动 3 项通过，实际打开并关闭外部活动机制，`build.log`、`bundle.log` |
| 全量检查 | 343 个生产文件边界、类型、Lint、格式通过；186 文件中 182 通过、4 失败；1771 项通过、4 失败、4 跳过，`check.log` |
| 最小核心依赖探针 | 直接打包 WorldApplication 的公开入口，160 个输入无 official-* 或 interactions-basic 实现，`minimal.log`、`minimal-bundle.json` |
| 文档检查 | 模块地图覆盖新增包，无新增断链；仍为 103 条历史断链报告（85 条去重记录）、59 个缺失历史产物，`docs-final.log` |

全量命令因四项既有失败退出非零：story-nodes 缺本机记忆 Python，launcher-core 的受信任授权仅支持 Windows，plugin-requirements 子进程先报 Core 初始化失败，entry-layout 60 秒超时。与 M3 及之前基线相同，没有跳过测试或放宽断言；四项既有 skip 保留。Lint 保留仓库已有警告。

新测试覆盖真实外部 .mjs／Cordis 注册改变初始化结果、选中机制打开失败不回退、错误归因、非法 private owner／turn 不提交、policy 授权与输入副本、拒绝隐藏已提交前台、候选独立实例及关闭、公开 identity 改变拒绝重生、初始化随机回放与回调失效、拒绝未知资产／自动开场 key，以及拒绝激活非参与者并保留合法已提交开始。

首次接缝测试暴露 activities 的公开 identity 尚未进入候选环境比较，修复后重新验证拒绝重生；没有仅依赖源码散列替代 Provider 身份。Launcher 检查也发现残留旧类型导入及缺失服务标签，修复后类型与测试通过。

未运行真实模型试玩或完整便携发行包验证；自动请求与构建测试不代表角色自然度或玩法体验已验收。通信、自主配置、作者接口最终收口和整体验收仍属 M5～M7。剧情导演（扰动器＋节拍器）与通用外部插件持久化状态继续暂停。
