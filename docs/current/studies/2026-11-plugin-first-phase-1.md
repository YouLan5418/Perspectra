# 插件优先运行时：阶段 1 记录

日期：2026-11-02。分支：`feat/plugin-first`。设计见[插件优先运行时](../../superpowers/specs/2026-11-02-plugin-first-runtime-design.md)。

例如开发者写一个插件，让急性子的角色总是抢先回应，玩家启用后它就取代官方调度器。这次把这条路走通了：[示例插件](../../../examples/host-plugins/impulsive-scheduler.mjs)只用公开接口，放在任意路径都能加载；移除后同一存档回到官方调度。

## 改了什么

| 项目 | 结果 |
| --- | --- |
| 调度算法 | 从 `application` 移到 [official-scheduler](../../../packages/official-scheduler/src/index.ts)，运行时不依赖 `store-sqlite` 和 `application` |
| 回合接口 | [createSchedulerRound](../../../packages/application/src/scheduler-round.ts) 替调度器读事件；调度器按序号指定观察，序号不属于该角色时拒绝 |
| 宿主 | `WorldHostCore` 每个实例打开一个调度器，不再直接 import 调度实现，只有 [official-bundle.ts](../../../desktop/official-bundle.ts) 能引用官方包，边界脚本检查这一点 |
| 第三方异常 | 抛错、非法结果和打开失败都有处理；已提交内容保留 |
| 插件写法 | 与 DSH 一致，可以 `import { Service } from '@deepseek-ai/cordis'`；解析钩子把它指向宿主这一份 |

## 接口够用吗

够用，但比设计初稿复杂。动态调度要跟踪已消费的观察、接续已提交的行动，所以 `round.turn` 保留了 `onCommitted` 和 `continuationOf`。第三方示例约 50 行逻辑，没有用到这两个，说明简单的调度器仍然好写。

## 成本

- 生产代码（`desktop`、`packages`、`apps`、`scripts`，不含测试）净增约 360 行。
- `world-runtime.ts` 从 2,255 行变为约 2,300 行。**这个接缝让调度可替换了，但总装配文件没有变小**：调度算法本来就不在它里面，它反而多了打开实例和处理异常的逻辑。
- 原有调度测试只替换了函数名，断言都没改。

## 验证

| 范围 | 结果 |
| --- | --- |
| `pnpm check` | 通过，175 个文件，1655 个测试（见下方偶发项） |
| `launcher:check` | 通过，87 个测试 |
| 源码和打包两种入口加载仓库外的插件 | 通过；去掉解析钩子时失败 |
| 真实模型试玩 | **未进行**，官方调度无退化和第三方调度的实际体验都未验证 |
| 发行包 | 未重建 |
| Launcher 里添加示例插件的手动流程 | 未进行 |

偶发项：`tests/host/frontend-trusted.test.ts` 有一次报 `bad port`，原因是随机端口落到 `fetch` 禁用的端口，与本次改动无关，单独重跑通过。

`tests/experiments/dynamic-scheduling.ts` 自统一 provider 后已不可用，因为它的假服务返回非流式响应。所以没有前后时序对比，调度行为靠原有断言保证。

## 后续判断

- **记忆（阶段 2）：** 接口已知，最大的未知是拆分 `packages/memory` 时来源捕获对召回表的依赖。
- **决策管道（阶段 3）：** `#decide` 边界清楚，拆它才会明显减少 `world-runtime.ts` 的行数。
- **规则与玩法（阶段 4）：** 仍是最难的。本阶段没有碰它，工作量判断没有变化，仍要先摸底。

要让总装配真正变小，阶段 3、4 才是关键。调度器这种“已经是独立函数”的接缝，成本低，收益主要是开放能力。
