# B2 实例生命周期与故障边界施工记录

2026-11-12。Kimi K3.1 Pro 制定方案，主代理核对当前入口后审阅并补充下面的接口、授权交互和故障来源要求；DeepSeek v4.1 flash 分工开发，主代理审阅并补充回归。状态：主代理验收通过。文档链接检查仍为 103 条历史断链，新增 0；另有 103 项未随工作树带入的历史本地产物，独立登记。

## 1. 角色互动与实际问题

玩家关闭世界 A 后，另一世界 B 应仍能使用自己的服务并继续对话。A 的取消任务即使晚到，也不能再激活角色或提交状态。玩家明确选定的调度器打开失败时，应停止打开并说明原因；已提交事实保留，程序不改用另一个调度器。

本批替代当前分散的 Provider 打开、手工关闭和按异常类型处理拒绝的路径。继续复用 WorldApplication 的根 Context 与 runtime-cordis 的 Fiber，不新建平行容器。不实施 B3 预算／周期、B4 玩法注册执行器或 B7 包格式。

## 2. 主代理审阅后的边界

- 进程 Context 登记工厂与外围服务；每实例的隔离 Context／Fiber 拥有实例绑定、监听、任务和清理。两个实例共享代码，不共享实例资源。
- 显式核心实现及最终必要能力失败即停止打开。只有明确的外围可选扩展可以告警继续。默认值只用于未选择实现的能力。删除调度器打开失败回退及依赖官方身份的保护绕过。
- 原生回调抛错和无效结果归插件故障；合法业务拒绝使用结构化结果。Host 回调中的核心／存储错误保留原错误来源，不能因穿过插件调用栈就改成 PluginFault。原始异常和私密输入不得进入玩家输出或未经处理的持久诊断。
- 安装记录保留在现有 hostPlugins 设置；新增 nativeAllowed，缺省 false。允许执行与启用加载独立。检查／读取清单不执行模块、不授予权限；改变插件路径清除旧许可。独立原生配置校验在 B7 接线，本批提供同一允许检查，不虚构新的 CLI 入口。
- 取消要主动结束等待并撤销资格；晚到 open 资源单独回收。复制 JSON 数据时保留受控 random／roll／Host 回调，并维护这些能力的资格和原错误来源。
- 先撤销资格，再逐项逆序清理。抛错或挂起不阻塞后续清理和存储关闭。清理报告是内部结果；核心关闭失败最终仍须抛出。同步可信原生代码不能被抢占，属于明确限制。

## 3. 协作接口与归属

runtime-cordis 提供下列宿主内部接口；实现可分文件，但名称和用途先保持一致，变更需通知主代理及消费者。

```ts
interface ProviderCleanupReport {
  readonly closed: readonly string[]
  readonly failed: readonly { readonly resource: string; readonly error: unknown }[]
  readonly timedOut: readonly string[]
}

interface WorldInstanceScope {
  readonly context: Context
  readonly signal: AbortSignal
  readonly active: boolean
  assertActive(signal?: AbortSignal): void
  open<T>(binding: string, provider: SeamProvider<T>, services: WorldServices, signal?: AbortSignal): Promise<T>
  invoke<T>(work: (signal: AbortSignal) => T | PromiseLike<T>, signal?: AbortSignal): Promise<T>
  own<T extends object>(binding: string, resource: T, close: () => void | Promise<void>): T
  resolve(binding: string): unknown
  close(): Promise<ProviderCleanupReport>
}
```

WorldApplication 暴露 `createInstanceScope(options?: { cleanupTimeoutMs?: number }): Promise<WorldInstanceScope>`，不暴露原始 application 根 Context。scope 的绑定实际受 Cordis 隔离与 Fiber 管理；`resolve` 用于宿主解析和测试，不是任意泛型强转入口。`own` 为已存在的非 SeamProvider 宿主资源提供同一所有权，替代额外的手工关闭链。

异步 `invoke` 只控制等待与资格，不是新的行动执行器，不授予提交能力。同步规则钩子继续使用同步保护和 `assertActive`，不把现行同步协议改成 Promise。关闭幂等，清理期限应可用于最小测试配置，并记录实际默认值。Context、close 和错误来源不得仅靠一个未消费的辅助类声明成立。

## 4. DeepSeek 写入分工

| 子任务 | 独占写入范围 | 交付 |
| --- | --- | --- |
| A | packages/runtime-cordis；packages/application/src/world-application.ts 及直接对应测试；必要 runtime-cordis 依赖与 pnpm-lock.yaml | scope／Fiber、取消与清理原语；修复 branch dispose 错误被吞掉的问题；窄 application 接口 |
| B | host-plugins、host-plugin-settings、launcher-core、host-plugin-manifest、plugin-requirements 与对应 desktop 测试；Launcher 插件设置组件、相关 store／类型与测试 | 工厂加载失败边界；允许记录和只读清单检查；真实允许／启用操作、路径变更清除许可 |
| C | desktop/host/world-runtime.ts、gameplay-services.ts、official-bundle.ts 及必要宿主故障辅助文件；对应 host 测试与 provider-lifecycle.test.ts | 正式宿主消费 scope；删除回退；保护输入输出、取消及核心回调错误；逐项清理接通 |
| D（合流时拆出） | 仅 tests/host/provider-lifecycle.test.ts | 真实宿主／临时 SQLite 的生命周期与故障集成回归，不改生产实现 |

主代理核对实际消费者后，C 的必要写入范围包含 activity-service、character-decision、rule-layers、scheduler-result、activities-runtime 和 pacing-runtime；它们直接消费统一故障与取消保护，不能只改入口留下旁路。D 独占新增生命周期测试，C 继续生产代码和既有断言迁移。配置错误的原生异常正文不再穿过运行故障边界；详细配置位置诊断由 B7 的独立校验入口处理。

真实知识回调故障回归进一步发现：CharacterTurn 在整个 decision 链执行前设置 modelFailure，导致已经正确穿过插件保护的存储异常仍被归为模型失败。主代理批准 C 对 character-turn.ts 扩围：由宿主传入窄的 propagateDecisionError 判断，复用同实例 HostCallbackErrors，已标明的核心异常原样传播；普通模型、预设、输出和循环故障保持现有分类。该入口替代笼统的错误来源推断，不增加故障协议或模型处理阶段。取消／资格错误不标成核心回调错误。主代理在 character-loop-execution 测试中补充原对象、无 reason 拒绝和取消并发回归，先复现 3 项失败；修复后连同 knowledge-seam 共 2 文件、21 项通过，日志为 `.tmp/composable-engine/b2/decision-source-reviewed.log`。这项证据尚不表示 B2 整体验收通过。

任务 A 可先固定实现接口，B 同时处理独立的设置与装载路径，C 可先完成已有同步边界的修改，随后接入 A。所有任务不回滚他人改动，不改历史 D:/worlds，不提交 Git。文档最终汇总和浏览器验收由主代理完成。

Launcher 沿用既有布局和组件。允许本地执行与启动加载分别表达，清楚标注未允许状态；不增加额外确认模态或重新设计。保存、重新读取及模块选择都必须保留这两个状态的真实含义。

## 5. 验证与放行

最小回归覆盖：Provider.open 失败；原生 TypeError／无效结果；A 关闭后 B 解析和响应正常；忽略取消的 Promise；晚到 open 回收；清理抛错或挂起仍关闭后续资源；旧能力取消／关闭后无新提交；Host 回调内存储错误不被插件故障覆盖；未允许模块的顶层代码不执行。

复用 runtime-cordis、host-plugins、native-provider-runtime、scheduler-seam 测试，增加 provider-lifecycle 最小回归。更新已废弃的调度器回退断言。运行类型和生产边界检查；权限设置改动运行 Launcher 类型／单测，并实际检查允许、启用、路径变更和未允许反馈。没有实际进程中断改动时不新增硬崩溃矩阵。

每个任务先做定向检查，合流后再运行必要集成场景。当前 B1 验收源码保存在 `.tmp/composable-engine/b1/reviewed-source/`，仅供比较已改源码，不是完整仓库快照。B2 日志在 `.tmp/composable-engine/b2/`。文档链接沿用 103 条历史断链与另 103 项本地产物缺失的独立基线。

本批只有实际消费入口、失败路径、所有权、清理和授权交互均有证据后才放行；通过类型或单测不等于真实模型或发行验收。

## 6. 实施与主代理验收证据

scope 由 WorldApplication 的既有根 Context 派生，真实 Fiber 持有绑定、取消和资源 effect。显式关闭或所属 Fiber 处置先撤销资格，再回收资源；默认逐项清理期限 5 秒，晚到 open 资源单独回收并记录内部诊断。BranchStore 的前项关闭失败不阻止后续句柄和核心 Store 关闭，错误原样或聚合传播。主代理加强预约竞态测试，实际在 abort 派发中启动同名重试，验证旧 finally 不会移除新预约。

装载器在导入前检查 nativeAllowed，启用却未允许时停止启动。清单声明和实际核心注册共同决定必要性，记录失败清理前的 Fiber UID；同步、异步注册后抛错均不能降级成外围跳过。路径改变撤销许可和加载选择，模块选择不授予许可。进程插件初始化／清理等待默认分别为 10 秒／2 秒。

所有所选 Provider 消费同一实例作用域，调度打开失败不回退，官方身份不再绕过调用保护。JSON 输入输出复制，受控 random、roll、turn、submit 等函数保留显式包装；来自原生的 beforeModelCall 和 reserveFormatRetry 仍按所属插件归因，不冒充核心回调。真实核心错误保留来源；合法拒绝沿原结构化路径；原生异常正文及 cause 不进入宿主生成的玩家提示或持久诊断。

检查结果分开记录，文件和测试数不相加，避免重复计算：

- 冻结的 scope／分支／应用关闭测试：4 文件、25 项通过；加强预约竞态后的单文件 12 项通过。
- 装载与 LauncherCore：5 文件、95 项通过；Launcher 相关 store 2 文件、38 项通过，根与 Launcher 类型检查通过。
- 宿主接缝最终集：14 文件、197 项通过；清理 unused 后相关 4 文件、58 项复验通过。
- 主代理最终代表集（节奏、RPG 正式行动、TRPG 活动、真实生命周期及角色执行）：5 文件、74 项通过，退出码 0。
- 主代理根 typecheck、Lint、全源码格式检查退出码均为 0；宿主边界覆盖 415 个生产文件。Lint 的未改文件警告另存日志，本批修改文件无警告。
- runtime-cordis 依赖修改后离线 frozen-lockfile 安装通过。

日志分别位于 `.tmp/composable-engine/b2/scope-reviewed-tests.log`、`b-loader/`、`c-host/`、`representative-reviewed.log` 和 `*-reviewed.log`。新增生命周期 7 个真实宿主场景覆盖 sibling 世界独立关闭、忽略取消、晚到调用无提交、晚到 open 回收、抛错／挂起清理、原生异常脱敏和真实 SQLite ERR_SQLITE_ERROR 按对象身份传播。

主代理实际操作 1280×720 浏览器预览：未允许时加载选项禁用，允许与加载独立选择，保存重开保留两个状态，换路径立即撤销两者且可保存。仅为 mock 表单状态，不导入原生模块，不验证真实凭据存储；磁盘保存／重新读取由 LauncherCore 临时目录测试验证。截图与状态记录在 `.tmp/composable-engine/b2/ui-path-revoked.png` 和 `ui-review.json`。唯一一次界面机械检查输出空列表、退出码 0。

本批没有真实模型请求、Tauri 原生窗口或发行包验收。可信原生同步代码不可抢占，未提交的异步计算允许丢弃；详细静态配置诊断、核心硬预算、原生玩法注册、公共周期、通用展示分别留在后续批次。原树和历史试玩数据未修改，没有 Git 提交或推送。

## 7. 独立 Sol 审查闭环

GPT-6.1 Sol 独立审查发现骰子实例调用、scheduler.onCommitted、轮次读取资格与核心来源、子 Fiber 核心注册归属四项遗漏。主代理逐项修复，新增对应最小回归；独立复核原四项均关闭，6 项定向测试及 2 项真实 Host 探针通过。主代理补跑调度、TRPG、自主行动及故障边界，6 文件、108 项通过，日志 `.tmp/composable-engine/b2/sol-final-regression.log`。B2 通过独立复审；真实模型、Tauri 与发行边界维持前述限制。

## 8. 按用户架构复核撤回放行

用户提供的只读架构审核指出，rules 插件故障仍降级为业务拒绝、affordances 故障跳过限制，以及取消竞态丢失已观察故障。这些与定稿 15.2／15.4 冲突，先前独立审查的四项关闭不足以证明 B2 完整满足计划。B2 放行撤回，按契约修复后重新独立审查；旧测试的回退断言不能用于保留旧行为。B3 尚未验收，B4 不开始。

### 本次规则故障收口的进一步修正

独立 Sol 的反向探针发现非法物品效果仍被归成核心 TypeError，以及准备阶段故障留在 received 并被新输入隐式重跑。主代理将插件返回值的最终效果校验放回其故障边界，核心 next 回调自身的失败仍保持来源；将输入处理所有阶段的明确插件故障终结为 failed。failed 是既有输入处理生命周期新增的终态，替代未完成或错误标记 completed 的故障处理，不是世界操作 rejected，不写 Event Log。相同 idempotencyKey 只重放脱敏故障，新输入不会带动旧故障请求执行。

现有 SQLite 输入表 CHECK 不允许该终态，因此使用已有迁移机制增加第 21 步，仅扩大 player_input_jobs 状态约束并原样复制其行；原有迁移、输入状态 hash 与世界事实保持原值。没有增加数据库、协议版本、兼容分支或恢复框架。迁移测试实际核对旧第 20 版表的所有输入列、状态证据和世界 head 保留，随后能写入 failed；本次新增迁移只在临时测试目录运行，历史试玩目录未接触。

初步验证：规则／故障终结／输入 worker 与队列 4 文件 44 项通过，输入存储含迁移单文件 11 项通过，根 typecheck 通过。独立 Sol 正在复核原两项 P1，未完成前仍不放行 B2。先前测试结果按日志分别保留，不累计重复计算。

第二轮复核又发现较早 FIFO 项的故障会误标当前输入失败，但留下其关联队列仍可执行。主代理按输入与回合归属修正排空逻辑：只将当前输入自己的故障终结为 failed；更早独立项的故障保留其诊断，当前输入继续完成自身生命周期。正式回归验证 A 故障、B 完成时，A 为 failed，B 的 job／inbox 分别为 completed／committed，世界只有 B 的发言。没有把未失败输入标成终止后再后台执行。

本次对应 3 文件 60 项（完整 store 46、输入表 11、故障终结 3）通过；旧第 20 版 schema 快照测试按真实第 21 版结构更新，生产语义不为该测试回退。根类型检查与 418 个生产文件边界检查通过。独立 Sol 仍在复核本轮发现，B2 放行继续保持撤回状态。

本次独立收口复审最终通过：Sol 复验原两项和 FIFO 归属缺陷全部关闭，正式 3 文件 60 项及 6 个独立探针通过；范围内没有剩余可行动问题。B2 恢复放行，B3 按原总计划继续。证据为 `.tmp/composable-engine/b2/sol-plan-review/fifo-closure-related.log` 和 `fifo-closure-probe.log`。未复核 B3，未作真实模型或发行验收。
