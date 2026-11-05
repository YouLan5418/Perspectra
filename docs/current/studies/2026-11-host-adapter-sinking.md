# 宿主适配器下沉

日期：2026-11-05；分支 `refactor/host-adapter-sinking`，基线 main `198693e`。依据[下沉方案](../../superpowers/plans/2026-11-05-host-adapter-sinking.md)，活动生命周期按用户选择的方案 A 放入核心。

例如玩家在活动中走到隔壁房间。以前同屋的人只知道有人行动，不知道他从哪走、去了哪；同样的移动不在活动中就有这些信息。现在两条路径用同一个函数构造观察，目击者知道的内容一致。

## 实际变化

| 位置 | 变化 |
| --- | --- |
| [immediate-action](../../../packages/application/src/immediate-action.ts) | 玩家即时行动的事实、场景迁移、观察和行动记录统一构造，复用 actionObservations |
| [world-view](../../../packages/application/src/world-view.ts) | 由 desktop/host/activity-world 移入，授权世界视图属于核心 |
| [status-operations](../../../packages/application/src/status-operations.ts) | 许可解析、操作准入、结果解析、受众、选项和轮次计数；不读库、不执行脚本 |
| [activity-lifecycle](../../../packages/application/src/activity-lifecycle.ts) | 开始、暂停、恢复、放弃、逃生的状态迁移，事件和结果观察；逃生不接收脚本输入 |
| [activity-projection](../../../packages/application/src/activity-projection.ts) | 选项、许可过滤、表达和决策检查、结果解析、调度校验 |
| [ActivityRuntime](../../../desktop/host/activity-runtime.ts) | 删除只有测试才会走的本地随机序列和读取路径，统一由活动目录提供 |
| [world-runtime](../../../desktop/host/world-runtime.ts) | 五个打开方法共用 `#openMechanism`，状态 guard 移到 [gameplay-services](../../../desktop/host/gameplay-services.ts) |
| [静态边界](../../../scripts/check-host-boundaries.mjs) | `desktop/` 不能直接调用 `.commitRound(` |

没有新增包、事件、存档字段、Provider 方法或 HOST API 版本。脚本解释仍在 official-*，身份绑定、Store 与租约、外部能力和随机数记录留在宿主。

## 解决的玩家可见问题

- 活动中移动，目击者现在能得到路线；到达场景的人也会收到观察，以前收不到。
- 他人读到的结果文本把“你”换成“行动者”，和角色路径一致。以前别人会读到第二人称的玩家结果。

实施中还引入过一个回归并已修复：结果观察一度带上脚本替玩家说的台词，历史里出现两次。全量检查抓到了它，回归用例在 [immediate-action.test](../../../packages/application/src/immediate-action.test.ts)。

## 行数：低于方案估算

| 文件 | 之前 | 之后 | 方案估算 |
| --- | --- | --- | --- |
| activity-runtime.ts | 1141 | 892 | 约 400 |
| activities-runtime.ts | 357 | 362 | 未估算 |
| status-runtime.ts | 689 | 578 | 约 330 |
| world-runtime.ts | 2191 | 2150 | 约 2050 |
| activity-world.ts | 80 | 移入核心 | 未估算 |

宿主合计少 476 行，方案估算约 1200 行，差距很大。核心新增 697 行（不含测试）。估算错在把 `apply`、`#resolve`、`view` 的流程编排算成了可搬走的逻辑。这些代码要调用脚本钩子、规则链和 Store，属于绑定工作，真正能抽成纯函数的只是其中的校验。

所以这次的收益主要是修了认知分叉、校验可以单独测试、生产和测试走同一路径，而不是宿主变小。**宿主里的活动适配仍然是最大的一块。** 继续压缩需要改变活动和宿主的调用关系，那已经不是下沉，是另一次设计；没有实际需求时不建议做。

## 验证

日志目录 `.tmp/migration-sink/`。

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 372 个生产文件边界、类型、Lint、格式通过；195 文件、1856 项全部通过，退出码 0 |
| 行为基线 | 对照 `a020632` 录制结果，12 组中 11 组逐字节相同；autonomy-integrated 的已提交状态相同，仍只有并发请求顺序差异 |
| Launcher | 类型检查与测试通过，退出码 0 |
| 后端构建与 CLI | 构建通过，隔离 CLI 检查通过（构建在回归修复前的提交运行，修复只改一处核心判断） |
| 便携包 | 本次未重新构建 |

基线场景没有覆盖活动中移动，所以路线修复不体现在基线里，由 [immediate-observation-parity](../../../tests/host/immediate-observation-parity.test.ts) 验证。

### 真实模型

gemini-3.8-flash 经本机 8045 网关，驱动 [m7-composition-live](../../../tests/experiments/m7-composition-live.ts)，转录在 `.tmp/migration-sink/live`。运行时的代码是回归修复前的 `0ed65f2`，这几种玩法都不走脚本替玩家说话的路径。

默认 RP、状态市场、RPG 和狼人杀都跑完了，狼人杀打完一整局。市场的偷偷塞钱只告知本人，物品归属和角色说法一致，RPG 真值与战斗文本一致。默认 RP 的角色仍有反问收尾的倾向，和 M7 那轮相同。长发言只读了开头部分。

这些包的活动都禁止移动，所以**修好的活动中移动没有经过真实模型验证**，只有自动测试。也没有做迁移前后同场景的严格对照。

## 接受的限制

- 活动生命周期不能被第三方机制替换（方案 A）。需要时再做方案 B。
- 官方机制仍然薄，这是有意的。
- 通信、自主和知识没有动。
- `world-runtime.ts` 其余部分没有拆，application 对 plugin-sdk 的类型依赖没有处理。
- 按 AGENTS，本轮未请独立审查代理，只做了作者自查。
