# B1 轻量公共契约与强类型作者定义记录

日期：2026-11-12

状态：主代理验收通过。B1 已固定作者类型、最小示例和 Schema 校验边界；B2 进入细节规划。

## 1. 先看一次作者使用

一个搜证玩法把“搜查”和“查看线索”写在同一个玩法定义中。搜查接受地点与精力参数，查看接受线索 ID；两个操作分别声明参数与结果 Schema，共享精力、线索状态和玩家面板。示例测试把模拟外部参数交给 application 的薄边界；实际玩家表单、模型候选和剧本入口尚未消费该契约。合法参数会被校验并复制，随后才进入作者 resolve；resolve 拿到宿主绑定的角色和可信状态，只能返回业务结果及待核心裁定的效果，不能提交事实。NPC 或玩家结果文本只接收该接收者已获授权的投影。

这个例子验证作者接口与校验边界。它不会注册操作、打开实例、调度角色或把结果写入事件日志。

## 2. 已固定的公共类型

公共 Manifest、Rulebook、表现数据已迁入 [contracts](../../../packages/contracts/src/index.ts)，kernel 与 frontend 保留解析或播放算法，并重导出同一类型。SDK 的 [rules.ts](../../../packages/plugin-sdk/src/rules.ts)和 [frontend.ts](../../../packages/plugin-sdk/src/frontend.ts)只依赖 contracts；[package.json](../../../packages/plugin-sdk/package.json)已移除 kernel／frontend 依赖并显式声明 AJV。

[gameplay.ts](../../../packages/plugin-sdk/src/gameplay.ts)提供：

- `OperationDefinition<TParams, TState, TOutcome>` 的强类型参数 Schema、结果 Schema、授权 offer、宿主绑定 resolve、NPC 说明和玩家描述。
- `GameplayDefinition` 的稳定 ID、版本、必要服务、数据版本、状态、活动、异构操作元组、初始化、configSchema、纯配置校验、玩家属性／条目展示、唯一的模块级 afterAction 和 onCycleEnd。
- `defineOperation<TState>()` 与 `defineGameplay<TState, TConfig, TActivityOutcome>()` 仅作推断辅助，保留不同操作的具体参数与结果。
- `BusinessRejection`、具有 pluginId／operation 归因的 `PluginFault`、`ExecutionCycleBudget` 和 `ExecutionCycleResult`。`interrupted` 表达取消，当前 Scheduler 行为没有改变。

最小示例见 [gameplay.example.ts](../../../packages/plugin-sdk/src/gameplay.example.ts)：同一搜证玩法包含 `investigation:search` 和 `investigation:inspect` 两个参数、结果不同的操作，并消费初始化、配置校验、NPC 结果文本及属性表／条目列表面板。操作集合由 helper 实际推断，不使用显式元组注解或无说明强转。

## 3. 外部数据校验

[gameplay-contract.ts](../../../packages/application/src/gameplay-contract.ts)提供 `compileOperationContract(definition)`。工厂只编译该操作的参数与结果 Schema，返回 `parseParameters(unknown)` 和 `parseOutcome(unknown)`；成功值会深拷贝，失败抛出 `GameplayContractError`：

- `GAMEPLAY_ARGUMENTS_INVALID`
- `GAMEPLAY_OUTCOME_INVALID`

该边界只验证外部数据。它不携带角色授权、不调用 resolve、不检查效果受众、不创建事务，也不提交 Event。现有核心路径继续负责这些检查。

## 4. 当前接通与验证范围

已接通的源码切片是公共类型独立导入、SDK 作者定义、最小示例、application 参数／结果 Schema 校验及类型负例。`resolve` 的业务拒绝与 accepted effect 当前由测试直接调用示例；没有新增注册表或执行器。

独立导入测试从 `@harness-world/plugin-sdk` 包自引用解析真实根入口，通过 TypeScript Compiler API 读取 `tsconfig.contract-test.json`，并检查解析后的工作树源码闭包只包含 SDK 与 contracts。Node 直接解析 workspace 包的限制不用于验收。

## 5. 尚未接通

- B2：实例 Fiber、Provider.open／close、装载失败和取消清理。
- B3：正式执行入口、硬预算、输入无关周期及 onCycleEnd 调用。
- B4：原生状态／活动注册、唯一操作处理器、限制合取和单层派生。
- B7：脚本导出与游戏包格式。
- B8：默认动作表单、控件和面板渲染。

模块级 afterAction／onCycleEnd、必要服务、数据版本和玩家展示目前都是作者声明；实际组合、装载、执行和 UI 尚未消费。现有 status／activities Provider 的 unknown 返回与校验路径不变。Provider 单例、多定义层叠、唯一操作处理器和实例资格仍按后续批次实施。

## 6. 验证记录

SDK 代理已报告公共类型迁移的定向类型检查和相关 kernel 测试通过；主代理已预审迁移并清理未使用 type import。SDK 依赖离线 frozen install、定向格式与 Lint 已通过。

最终合流后的真实结果：

| 检查 | 结果 |
| --- | --- |
| SDK 包级契约 `tsc` | 退出码 0 |
| 新增作者／校验测试、独立导入测试及既有 status／activity 测试 | 5 文件、24 测试通过，退出码 0，3.15 秒 |
| 全仓 `typecheck` | 退出码 0 |
| 宿主边界 | 退出码 0，413 个生产文件 |
| 本子任务定向 Prettier／oxlint | 退出码均 0 |
| SDK 离线 frozen install | 由 SDK 代理执行，退出码 0 |
| 相关 kernel world-spec／manifestation 测试 | 由 SDK 代理报告 2 文件、5 测试通过，未重复运行 |
| 文档链接检查 | 退出码 1；相对 B0 的 missing-target 集合仍为 103 条，新增 0、移除 0；另有 103 项历史本地产物缺失 |

原始日志在 `.tmp/composable-engine/b1/`。链接检查的原始输出、真实退出码与集合比较分别为 `docs-links-after.log`、`docs-links-after-exit.txt` 和 `docs-links-comparison.json`。该切片没有真实模型请求，没有验证 GUI、发行包或真实试玩。

主代理已核对公共类型迁移、真实推断的异构操作元组、兼容状态投影和严格回调负例、未知参数／结果校验、独立导入闭包与上述原始结果。审阅中收敛为单一模块级 afterAction，删除未使用类型导入，并统一示例中的创作者诊断文案。B1 通过；声明的后续运行能力仍按第 5 节接通。
