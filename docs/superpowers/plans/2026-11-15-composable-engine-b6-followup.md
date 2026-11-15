# B6 九项复核修正记录

2026-11-15，按用户要求修复跨 B2–B6 的九项独立审查发现。主代理直接实施，完成后由新的独立 GPT-6.1 Sol 复审。本轮不进入 B7。

当前状态：九项修复及首轮独立复审发现的三处残留均已完成；三位新的独立 GPT-6.1 Sol 最终复验全部 PASS。本轮 B6 收口通过。此前 B6 PASS 记录保留其当时的验证范围，本轮九项以本记录的最终验收为准。

| 编号 | 修正目标 | 状态 |
| --- | --- | --- |
| R1 | 官方原生定义绑定所选 State／Activity Provider | 独立复验 PASS |
| R2 | TRPG 公开引用保护私有地点 | 独立复验 PASS |
| R3 | 取消竞态保留已观察的核心错误 | 独立复验 PASS |
| R4 | 调度输入的数据所有权隔离 | 独立复验 PASS |
| R5 | 完整验证调度返回结构 | 独立复验 PASS |
| R6 | 通信参数与选项校验归入插件故障边界 | 独立复验 PASS |
| R7 | 正式通用 Handler 接收选中目标 | 独立复验 PASS |
| R8 | 手动活动生命周期运行单层 afterAction | 独立复验 PASS |
| R9 | 通信展示故障不阻断已投递消息的本次反应 | 独立复验 PASS |

保留有限恢复和现有时间机制。强制 escape 及 onCycleEnd 结算不运行普通行动后置派生；未提交的后续反应仍允许丢弃。未访问历史试玩数据，不提交或推送。


## 修正与验证范围

1. **R1 Provider 实际执行。** SDK 的 bindNativeGameplay 将生成定义绑定到当前世界已经打开、经过故障包装的 State／Activity 实例。初始化、policy、resolve 与活动行为使用所选实现，核心唯一 Handler 继续作权限、状态效果与原子提交校验。删除 Host 将活动 Provider 反向改绑到原生计算的旧适配，避免循环与重复 published。替换 Provider 的正式 rest／skill 拒绝已由 Host 回归验证，拒绝不留下状态／活动变化。
2. **R2 私有地点引用。** TRPG 公开内容引用地点时，只接受公开地点；有公开引用的地点不能直接收为私有。真实 Host 桩角色完成私有地点、非法公开物品、公开地点、合法物品、禁止重新隐藏的完整场景，其他参与者观察不含私有地点标记。
3. **R3 核心错误优先。** 插件异步调用在取消结束等待时短暂让已结束回调收束；已标记的核心错误保留原对象上抛，不能变成 interrupted。不等待忽略取消的悬挂 Provider。周期末 abort 与 hostCallback 错误同轮发生的回归验证无提交、无后续钩子。
4. **R4 输入隔离。** 调度列表、策略预算、机会预算与初始次数使用独立副本；回归同时修改本次与迟到引用，宿主原值保持不变。
5. **R5 返回校验。** 验证非负安全整数、激活结果及可选 autonomy／reactions。异常结果进入对应插件故障并终止正常结算。没有通过截零或丢弃无效 autonomy 把故障伪装成完成。
6. **R6 通信故障归属。** 复用核心信封解析器，在插件 parameters／options 边界验证完整结果；参数还需绑定请求的收件人与正文。异常被归为对应插件 invalidResult 并诊断；当前联系人权限仍由核心复核。
7. **R7 目标传递。** 通用正式请求在核对候选目标后，把选中的 targetRef.id 传给 Handler.targetId。真实 app.submit 的 entity:cup 回归确认处理器收到该 ID。
8. **R8 生命周期派生。** 公共引擎与 Host 手动开始／暂停／恢复／放弃都运行单层 afterAction；相同主候选、合并校验和一次提交。核心与 Host 回归验证失败时无半次生命周期状态；自动结算开始和强制 escape 保留例外。
9. **R9 展示失败降级。** describeDelivery 的异常与非法返回归属插件故障；消息已经提交时，routeGameplayInput 使用基本结果说明，仍返回本次反应资格。真实 Host 回归验证投递事实、收件人模型请求、正常周期完成、安全诊断及同 key 重试不重复投递。

## 本轮主代理检查

- 根 corepack pnpm@11.7.0 typecheck：通过。
- node scripts/check-host-boundaries.mjs：425 个生产文件通过。
- 修复与邻接回归：10 文件共 156 项；首次 155 项通过，余下一项为新 Host 测试误用强制退出入口，改为实际 runtime.escape 后该文件 7/7 通过。其余文件源码未再改动，集合不重复相加。
- 定向 Oxlint：退出码 0；既有 execution 测试的 require-yield warning 保留，未为本轮修改无关测试。
- 本轮 TypeScript 文件的格式检查通过；复审追加修改后的检查另见最终收口。
- node scripts/docs/check-links.mjs：退出码 1，103 条历史断链报告（85 条去重条目）与 B6 基线一致，新增 0；另有 103 个非必需历史产物缺失。原始结果和集合比较见 .tmp/composable-engine/b6-followup/docs.log、docs-comparison.json。
- 未运行真实外部模型试玩、GUI、发行构建或完整 pnpm check。上述 Host 用例使用临时数据与本地桩模型，不能替代角色体验验收。

## 独立复审

主代理冻结实现后，启动三位新的 GPT-6.1 Sol，分别覆盖 R1/R2/R8、R3/R4/R5、R6/R7/R9。复审者只读正式代码，可在各自临时证据目录添加探针；首轮发现与修正、最终结论见下文。


### 首轮独立复审与修正

三位审查者均没有以旧测试全绿直接放行，分别用独立探针发现 R1、R5、R7 还需补齐：

- R1：聚合 State Provider 会同时执行基础脚本，所属 RPG known view 不含基础公开状态。增加宿主内部 projectKnownStatus 投影，复用 StatusRuntime.known／knownStatusView 返回当前 actor 的完整授权状态；模块 truth 与状态投影不扩权。正式组合回归同时验证 base-bag 可见、cheng／mei 私有 marker 不可见。
- R5：String 转换、仅对象判断和 Array.every 会放过装箱枚举、Map／BigInt 与稀疏数组。改为原始字符串、普通记录、完整数组元素及既有 canonicalizeWorldJson 校验；五项坏返回纳入正式调度入口回归。
- R7：原先 verifyTarget 在 Handler 后执行，业务拒绝还会跳过目标资格。已移至 Handler 之前；accepted／rejected 两种 Handler 均有“不被伪造目标调用”的正式回归。搜证示例把地点资格留在 offer、资源拒绝留在 resolve，因此精力为零仍返回 INSUFFICIENT_ENERGY，不新增目标资格接口；此时搜查候选继续可见是明确接受的示例行为。

追加实现后，根类型检查通过；原生 gameplay 44 项、Host 官方接入 8 项、SDK 示例 3 项通过；执行入口 27 项通过。执行套件曾因新 BigInt 案例的测试名使用 JSON 格式化而无法收集，改为索引测试名后 27/27 通过。原失败探针已由各独立审查者再次执行，最终结论如下。


### 最终独立复验与收口

| 审查范围 | 独立审查者 | 最终证据 | 结论 |
| --- | --- | --- | --- |
| R1／R2／R8 | b6_fix_review_gameplay | 原组合探针 1/1；三文件正式回归 80/80 | PASS |
| R3／R4／R5 | b6_fix_review_execution | 原独立探针 9/9；正式回归 38/38；五类非法返回均 failed，结算 0 次 | PASS |
| R6／R7／R9 | b6_fix_review_communication | 原目标探针 2/2；正式回归 73/73；SDK 示例 3/3 | PASS |

独立探针共 12 项，正式测试组存在重叠，不相加。审查报告保存在 .tmp/composable-engine/b6-followup/review-gameplay/report.md、review-execution/REPORT.md、review-communication/REVIEW.md，保留初审失败与最终修复证据。三位审查者未修改生产代码或正式测试；主代理实施追加修正后再次交回原审查者验证。

最终根类型、425 生产文件边界检查、定向 Lint、Prettier 均通过；Lint 仅有原测试已有的 require-yield warning。最终文档导航与既有基线比较新增断链 0（全量仍报告原有 103 条断链，不能宣称全量文档检查通过）。现行入口、创作者运行时、运行时、模块地图、B6 原记录和主实施计划均已同步本次结论。

独立工作树仍为 D:/DeepSeek Harness/Perspectra-composable-impl，分支 codex/composable-engine-implementation。本轮无提交、合并或推送，不改变世界时间，不增加跨重启补齐后续反应的承诺，不进入 B7。真实模型、GUI 和发行验收仍未执行。
