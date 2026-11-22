# 目录与模块地图

2026-11-15 B10：按真实 imports 与消费者将旧 `@harness-world/*` 收敛为以下 `@perspectra/*` 包。B9 搜证作为迁移前后对照；依赖图、迁移顺序与验收范围见 [B10 记录](../../superpowers/plans/2026-11-15-composable-engine-b10-packages.md)。没有新增玩法或改变存档／事件协议，源码迁移不代表 Windows 原生发行验收。

例如玩家搜查房间，Host 选择游戏包声明的搜证实现；核心合取限制、检查授权并提交事实；同房角色得到外显结果，私密线索只进入玩家面板。沿下面的入口可以跟踪这个过程，不能把“包导出了函数”当成入口已调用它的证据。

## 应用与工具入口

| 目录 | 当前职责 | 阅读起点 |
| --- | --- | --- |
| [apps/host](../../../apps/host) | Node／CLI 装配、HTTP、角色与玩法执行适配、端侧资源和授权接入 | [正式 CLI](../../../apps/host/src/cli/worldpack.ts)、[Web 入口](../../../apps/host/src/runtime/web-entry.ts)、[WorldHostRuntime](../../../apps/host/src/runtime/world-runtime.ts)、[默认组合](../../../apps/host/src/official-bundle.ts) |
| [apps/launcher](../../../apps/launcher) | Vue 管理界面、Tauri 桥、本地管理进程、创作者控制台和包编辑器 | [Node 入口](../../../apps/launcher/backend/entry.ts)、[LauncherCore](../../../apps/launcher/backend/core.ts)、[界面状态](../../../apps/launcher/src/stores/launcher.ts)、[创作者](../../../apps/launcher/src/creator/main.ts) |
| [Host 推演](../../../apps/host/src/simulation) | 临时 SQLite、正式引擎装配、剧本执行与断言 | [simulation](../../../apps/host/src/simulation/simulation.ts)、[scenario](../../../apps/host/src/simulation/scenario.ts) |
| [tests/support](../../../tests/support) | 回归测试共享装配与夹具 | [说明](../../../tests/support/README.md) |
| [tests/experiments](../../../tests/experiments) | 非默认运行的研究与真实模型探针 | 默认回归与生产代码不可反向依赖 |
| [experiments](../../../experiments) | 冻结研究与历史证据 | [索引](../../../experiments/README.md) |
| [scripts/build](../../../scripts/build) | Node 产物、CLI 与独立资源复制 | [backend](../../../scripts/build/build-backend.mjs)、[CLI](../../../scripts/build/build-worldpack-cli.mjs)、[Node 记忆资源](../../../scripts/build/copy-memory-runtime.mjs) |
| [scripts/release](../../../scripts/release) | Windows 便携包组装与检查 | [构建说明](../../../scripts/release/BUILD.md)，B10 不运行 B11 发行验收 |
| [世界包示例](../../../examples/world-packs) | 显式选择玩法的作者内容 | [搜证场景](../../../examples/world-packs/investigation/scenario.json) |
| [作者 Skill](../../../skills/perspectra-creator) | 随程序提供的创作指导与工具 | [入口](../../../skills/perspectra-creator/SKILL.md) |

## 软件包与公开出口

子入口用于限制加载依赖；providers／plugins 不提供汇总所有能力的根入口。

| 包 | 职责与入口 | 边界 |
| --- | --- | --- |
| [sdk](../../../packages/sdk) | `@perspectra/sdk` 的强类型作者与能力契约；`/contracts` 的 ID、事件、规则、JSON 和展示数据 | 不依赖实现；[玩法定义](../../../packages/sdk/src/gameplay.ts)、[基础契约](../../../packages/sdk/src/contracts/index.ts) |
| [core](../../../packages/core) | 根入口 WorldApplication；`/kernel`、`/store`、`/runtime`、`/memory`、`/interactions`、`/presentation`、`/agents` | 权威事实、授权投影、原子提交、分支、资源、受控执行；不导入具体能力或玩法。[执行](../../../packages/core/src/application/execution-engine.ts)、[玩法裁定](../../../packages/core/src/application/gameplay-runtime.ts)、[提交协调](../../../packages/core/src/application/round-coordinator.ts) |
| [providers](../../../packages/providers) | `/activities`、`/status`、`/knowledge`、`/communication`、`/contexts`、`/character-loop`、`/scheduler`、`/llm`、`/memory-none`、`/scripted-model`、`/chat` | 默认可替换实现；脚本模型只替代调用传输，保留正式 DecisionService 授权组装。浏览器使用 `/chat/preset` 等纯子入口，不加载模型适配 |
| [plugins](../../../packages/plugins) | `/rpg`、`/trpg`、`/dice`、`/pacing` | 原生玩法；牵手／松手已迁入世界包脚本，不再提供基础交互包导出。自主机会策略与调度共享实现，实际保留在 providers/scheduler |
| [memory-core](../../../packages/memory-core) | Node 长期记忆、worker 与资源；`/paths` 只含路径和持久 ID | Host 按需加载 [memory-composition](../../../apps/host/src/memory-composition.ts)，静态校验不加载记忆 worker |
| [world-pack](../../../packages/world-pack) | 格式、编译、校验、工作台和 CLI 共用的 [字段与引用选择](../../../packages/world-pack/src/editor-fields.ts) | 动态推演与断言由 Host 执行 |
| [frontend](../../../packages/frontend) | 公共客户端、默认舞台、参数表单、控件与授权只读面板 | 不依赖 Node Host；[默认模板](../../../packages/frontend/src/default-template.ts)、[通用展示](../../../packages/frontend/src/gameplay-widgets.ts) |
| [jev-audit](../../../packages/jev-audit) | 独立实验审计与可选插件 | 仅显式实验启动参数触发动态导入，不进入默认 RP 组合 |
| [testkit](../../../packages/testkit) | 跨包测试构造 | 内部测试工具，不是玩家入口 |

旧 npm 名称不设置兼容壳，维护中的消费者共同迁移；持久插件 ID 仍为 `official-*`。`desktop:build`、`worldpack`、`experience:web`、`launcher:*` 命令名与便携产物文件名保留，以免改变用户操作入口。历史分批职责与判断保存在原实施记录中。

## 从行为回到代码

搜证：CLI → Host 推演 `runScenario`／`LensSimulation` → WorldApplication 公共执行周期 → `gameplay-runtime`／`round-coordinator` → SQLite → 推演核对正式裁定、角色观察和玩家面板断言。详见[代码路线](code-walkthrough.md)。

Launcher 与 Host 同为应用代码：Launcher 管理实例与连接，Host 提供装配及运行。它们不把玩法规则复制进管理端。Host 的 `/play-settings` 与 `/plugin-settings` 是共享纯配置公共出口，Launcher 可在浏览器导入；真实 browser 打包闭包各只有一个文件，其他 Node Host 运行时导入仍被禁止。源码导入检查、SDK／RPG 实际加载探针、静态校验和隔离目录入口测试分别验证不同边界，不能互相替代。
