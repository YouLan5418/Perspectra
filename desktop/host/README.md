# 游戏宿主

玩家发送一句话后，HTTP 服务把输入交给世界宿主；角色依据自己的授权上下文决定如何回应，受控操作继续经过现有规则裁定。这个目录负责装配和对外服务，不另建世界规则或角色协议。

| 要找什么 | 源码 |
| --- | --- |
| 源码与发行共用的游戏入口 | [web-entry.ts](web-entry.ts) |
| HTTP、认证与前端服务 | [http-server.ts](http-server.ts)、[frontend-server.ts](frontend-server.ts)、[creator-assets.ts](creator-assets.ts) |
| 世界装配、角色激活与故事线 | [world-runtime.ts](world-runtime.ts)、[tail-runtime.ts](tail-runtime.ts) |
| 世界包的玩法模块（活动、状态、自主、短信） | [world-gameplay.ts](world-gameplay.ts) 持有，[player-input.ts](player-input.ts) 分发输入，[gameplay-projection.ts](gameplay-projection.ts) 投影给玩家 |
| 设定知识素材适配（选择规则在 official-knowledge） | [knowledge-source.ts](knowledge-source.ts) 校验并提供数据，宿主通过 Cordis knowledge 实例选择 |
| 活动资产、授权读取与执行适配（计算在 official-activities） | [activity-source.ts](activity-source.ts)、[activity-world.ts](activity-world.ts)、[activity-runtime.ts](activity-runtime.ts)、[activities-runtime.ts](activities-runtime.ts)，见[M4](../../docs/current/studies/2026-11-core-migration-m4.md) |
| 通信／自主资产和执行适配（计算在官方机制） | [gameplay-source.ts](gameplay-source.ts)、[communication-runtime.ts](communication-runtime.ts)、[autonomy-runtime.ts](autonomy-runtime.ts)，核心检查在 application，见[M5](../../docs/current/studies/2026-11-core-migration-m5.md) |
| 状态与模块资产／执行适配（解释在 official-status） | [status-source.ts](status-source.ts)、[status-runtime.ts](status-runtime.ts)、[pack-modules.ts](pack-modules.ts)；核心声明与告知检查在 [StatusState](../../packages/application/src/status-state.ts)，见[M3](../../docs/current/studies/2026-11-core-migration-m3.md) |
| 状态／活动／通信的核心即时执行 | [executeWorldRound](../../packages/application/src/world-round-execution.ts) 统一租约、前缀、取消与原子提交；业务适配仍在本目录，见[M2 记录](../../docs/current/studies/2026-11-core-migration-m2.md) |
| 活动合法参与者与真实结果桥、自主机会投影和结束提示（循环策略在 official-scheduler） | [activity-round.ts](activity-round.ts)、[autonomy-round.ts](autonomy-round.ts)、[round-notices.ts](round-notices.ts) |
| 规则层 | [rule-layers.ts](rule-layers.ts)：玩家、角色和活动共用的核心规则来源，插件的 `ctx.rules` 包在外面 |
| 玩家公开视图与操作适配 | [frontend-adapter.ts](frontend-adapter.ts)；公共数据和请求形状在 [frontend](../../packages/frontend/src/player-view.ts) |
| 模型连接与按角色预设 | 官方模型通道 [official-llm](../../packages/official-llm/src/index.ts)；默认模型与端点见 [provider-defaults.ts](../provider-defaults.ts) |
| 角色决策 | [character-decision.ts](character-decision.ts)、[decision-format.ts](decision-format.ts) |
| 默认 Core 记忆 | [official-memory-core](../../packages/official-memory-core/README.md) |
| 创作者只读查询 | [creator-queries.ts](creator-queries.ts)、[creator-inspection.ts](creator-inspection.ts)、[creator-history.ts](creator-history.ts)、[creator-records.ts](creator-records.ts) |
| 可选 JEV 审计 | [official-jev-audit](../../packages/official-jev-audit/src/index.ts) |

源码入口为 `corepack pnpm@11.7.0 experience:web --pack <世界包> --data-dir <新目录>`。发行时仍打包成 `playtest.mjs`；输出文件名与 HTTP 路径不因源码整理整体改名。创作者检查响应中的 `variables` 改为 `statusTruth`，第一方页面同步消费该字段。

JEV 不是默认必经机制。`--jev-shadow` 会向 OpenRouter 发送审计材料，启动时仍显示提示。受信任前端沿现有独立 origin 与权限策略服务。

宿主通过 `@harness-world/*` 包入口使用 packages，不直接引用包内文件。`tests/experiments` 保留研究驱动和真实模型探针；默认宿主和默认回归都不从中加载代码，共用场景放在 `tests/support`。历史 JEV、Core 探针与关系 spike 分别归入 `experiments` 对应研究目录。运行 `node scripts/check-host-boundaries.mjs` 检查生产代码是否重新依赖实验路径。
