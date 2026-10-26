# 双插件入口与异步外部能力实验

日期：2026-10-26。分支：`codex/rpg-core-plugin-prototype`。本记录说明当前实验实现，不代表便携发行包已包含。

## 从一次角色互动开始

澄选择向设备打招呼，宿主先确认她有这个操作；本地 Cordis 插件异步确认后，包作者规则把她本人的次数加一，并只告知本人。玩家和旁观者的私有次数没有进入她的 Context。设备返回已排队时，不增加次数，也不调用作者完成裁定。原生会话还可请求澄处理一次机会，仍由原 CharacterTurn 决定行动、表达或沉默。

实际需求是让作者随包分发玩法代码，同时让玩家安装可连接外部进程的宿主插件。原先的同步活动生成器无法等待外部游戏；只注册 `ctx.rpgMaker` 也没有默认消费者。因此增加按世界绑定的能力目录和异步执行点，复用已有状态脚本、交互 ID、角色回合、事件和事务；没有另建 RPG 规则引擎、模型协议、数据库或恢复日志。

## 代码路径与证据

| Evidence | Finding | Path |
| --- | --- | --- |
| [目录与会话测试](../../../tests/desktop/host-capabilities.test.ts) | 不同世界分别打开服务，Schema、角色绑定、卸载取消与会话清理可验证 | [HostCapabilities](../../../desktop/host-capabilities.ts)负责原生注册，Cordis effect 持有注销函数 |
| [双入口场景测试](../../../tests/scenarios/dual-plugins.test.ts) | 包规则、权限筛选、私有 Context、原子提交、queued、可选依赖和失败暂停通过真实宿主执行 | [PackModules](../../../desktop/host/pack-modules.ts)组合成 PackStatus，复用现有 Rulebook 与状态事件 |
| [源码和构建入口测试](../../../tests/host/capability-plugin-entry.test.ts) | 外部 .mjs 与包模块经过真实入口装载，HTTP 操作可执行；无配对保存时不授予保存／重生成能力 | [web-entry](../../../desktop/host/web-entry.ts)、[HTTP 初始化](../../../desktop/host/http-server.ts)及 TailRoundRuntime 消费实际能力 |
| [MZ 双端脚本测试](../../../tests/desktop/rpg-maker-bridge.test.ts) | 真实 TCP、队员映射、白名单、绑定 NPC 回调和断线行为可测试，MZ 对象仍为替身 | [桥接说明与模板](../../../examples/rpg-maker/README.md)，拿到实际工程后再做战斗适配 |

包用 `plugins.json` 声明模块、资产、角色和精确版本依赖；操作成为普通 `status:<模块>-<操作>`。纯规则只在包内执行，需要外部能力的规则分为同步 prepare、原生异步 invoke、同步 resolve。prepare 仅接收已知状态；resolve 延用可信作者裁定真值的权限，输出仍受宿主状态、物品和受众校验。

角色路径在 CharacterTurn 原有写租约内等待能力，玩家独立状态操作和活动内操作也使用相同执行边界。没有把网络等待放进 SQLite 事务。提交前失败不会产生半组状态和观察；已确认外部写之后的本地失败会停止继续操作，防止自动重执行。活动 policy 继续筛选模块操作，未获准的旧选项不会调用原生服务。

`world.requestCharacter` 仅接受已绑定 NPC ID 和取消信号，不接收任意 Context 或知识文本。返回仅含处理状态、调用数和玩家有权阅读的新表达。它增加处理机会，不预先规定角色行为；仍使用原有模型请求、记忆与规则结果续写。

## 有意识接受的限制

- 原生插件是可信 Node 代码，VM / Cordis 不是恶意代码沙箱；包不会自动安装原生插件。
- 没有跨进程事务、自动重试或崩溃恢复。结果未知须人工核对外部游戏，再重启；重启本身不证明一致。
- 外部写 provider 绑定后禁用节点、重新生成与候选切换。普通事件仍持久化，但没有配对外部存档。
- MZ 仅有桌面连接、本人视图和公共事件排队，没有真实技能选择、BattleManager 适配或完成回报。公共事件排队不能证明伤害与奖励完成。
- 没有新增通用前端插件槽位、插件设置面板、热安装或任意外部刺激注入。先完成可测试的异步执行链路。

## 验证

复现核心实验：

```powershell
corepack pnpm@11.7.0 test:related tests/desktop/host-capabilities.test.ts tests/scenarios/dual-plugins.test.ts tests/desktop/rpg-maker-bridge.test.ts tests/host/capability-plugin-entry.test.ts
```

另运行相关活动、状态、CharacterTurn、前端能力和末端回合回归：18 文件共 203 项。固定源码后的沙箱运行有 198 项通过，5 项既有硬终止用例因 Windows taskkill 失败；这 5 项在沙箱外单独重跑全部通过。最初一次运行期间的格式化触发了源码身份保护，相关失败已在固定源码后重跑，不放宽保护检查。

类型检查、相关 Lint、格式检查、示例 JavaScript 语法检查及宿主边界检查通过。文档链接检查仍报告两篇未修改旧研究文档中的 97 处既有断链，以及 19 个缺少的非必需历史本机产物；本轮修改章节没有断链。未运行完整 `check`，也未运行 Launcher 全套检查。这些检查用于验证源码接线，不等价于体验验收。

未调用真实模型，未打开实际 MZ 工程，未验收 Launcher 人工操作、浏览器表现、Core 长会话或便携发行包。没有修改历史试玩目录，也没有提交或推送 Git。作者 API 和运行方法见[开发指南](../guides/dual-plugin-entrypoints.md)。
