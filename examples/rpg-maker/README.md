# 直接连接 RPG Maker MZ：双端插件骨架

澄可以在 RPG Maker 制作的地图里与你交谈，并在其战斗系统中选择行动；地图、技能、装备、成长、事件与表现继续由 RPG Maker 提供，Perspectra 专注角色决策、授权信息和经历。这是本轮优先验证的方向，暂停继续扩展自研 RPG 规则。

**当前还没有实际 MZ 工程。** 本目录是原创桥接插件，已接入默认宿主能力与绑定 NPC 的原有角色回合，并通过本机通信和接口替身测试。它还不是可玩的 RPG Maker 游戏，没有接管战斗。不附带 RPG Maker 引擎、官方素材或第三方游戏内容。

## 已经写好什么

| 文件 | 放在哪里 | 当前能力 |
| --- | --- | --- |
| [PerspectraBridge.js](PerspectraBridge.js) | 作者 MZ 工程的 `js/plugins`，在插件管理器中启用；保留此文件名 | 连接桌面桥，读取队员视图、接收白名单事件请求、请求 AI 同伴处理 |
| [rpg-maker-bridge.mjs](../host-plugins/rpg-maker-bridge.mjs) 和 [transport.mjs](../host-plugins/rpg-maker/transport.mjs) | Perspectra 本地宿主插件目录，两个文件按原相对位置一起保留 | 提供 `rpg-maker@0.1.0` 能力及底层 `ctx.rpgMaker` 服务，一个游戏只绑定一个世界会话 |
| [pack-module.js](pack-module.js) 和 [plugins.example.json](plugins.example.json) | 按下节复制到世界包并登记资产 | 以本人私有状态记录已确认视图；事件请求仅确认排队 |
| [桥接测试](../../tests/desktop/rpg-maker-bridge.test.ts) | 本仓库 | 真实 Cordis、真实 TCP、真实桥接脚本；RPG Maker 对象使用小型接口替身 |

这条路径走 Cordis 能力入口（上一轮的 `ctx.gameplay` 规则生成器已删除）。外部游戏运行时是异步、有独立生命周期的进程，不能装进每个 hook 100ms 的同步活动脚本里。

## 服务提供什么

```js
// 以下代码由同一 Cordis Context 下的可信集成插件调用；不是已公开的前端 API。
const view = await ctx.rpgMaker.observe(1)
const result = await ctx.rpgMaker.queueCommonEvent(1, 2)
```

- `observe(actorId)` 要求该角色在 RPG Maker 当前队伍里，只返回该队员的 ID、名称、HP / MP、当前地图 ID、战斗是否进行，以及已出现敌人的名称和生存状态。不读取全部开关、变量、存档、隐藏敌人或其他队员 HP / MP。
- `queueCommonEvent(actorId, eventId)` 只允许作者在 MZ 插件参数里列出的公共事件。队员不存在、事件未列入白名单、正在战斗、地图事件执行中或已有预留公共事件时拒绝。
- `{ queued: true }` 只表示请求已交给 RPG Maker 的公共事件队列，**不表示事件已经执行，更不证明伤害、移动或奖励已发生**。
- `connected` 表示当前连接存在。断线和超时使未完成请求明确失败；不会自动重试可能已经被游戏接收的命令。

底层服务仅供可信原生代码使用。包模块通过 `rpg-maker/observe`（空参数）及 `rpg-maker/queue-common-event`（`{eventId}`）调用。调用者由宿主绑定到 `config.actors` 中的 MZ 队员，模型不能用参数指定另一个队员。示例将观察提交为本人已确认的 `rm-view` 状态，不同步宿主地点、物品或 HP 真值。返回 queued 时宿主不运行完成裁定。

连接后可调用 `await PerspectraBridge.requestCharacter(2)`，或插件命令“请求 AI 同伴行动”。宿主将队员映射回声明的 NPC，运行原有 CharacterTurn；角色可沉默或提出操作。返回仅含处理状态、调用数和玩家可见的新表达，不导出私有 Context。地图事件命令发起请求后立即返回，没有等待整个角色回合；若需等候或展示表达，请在作者逻辑中处理 Promise。请求不会把任意 MZ 变量或隐藏敌人注入角色知识。

## 以后有工程时怎样验证

1. 使用自己的 MZ 工程，将 `PerspectraBridge.js` 放进 `js/plugins`，在插件管理器启用，选择少量允许桥接请求的公共事件。首个测试事件只显示一句招呼，不修改数值。
2. 在启动两个进程的同一个 PowerShell 环境里创建本次连接配置，不把令牌写进插件参数、世界包、存档或日志：

```powershell
$env:PERSPECTRA_RPG_MAKER_PORT = '51013'
$env:PERSPECTRA_RPG_MAKER_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

3. 从该环境启动 Perspectra Launcher，并添加、启用 `rpg-maker-bridge.mjs`。如果已有 Launcher 进程不带这些环境变量，需要使用带该环境的进程启动游戏；这里只描述操作，不会自动重启现有实例。
4. 从相同环境启动实际 MZ 桌面游戏，在游戏事件里执行插件命令“连接 Perspectra”。`PerspectraBridge.status` 可查询 `offline / connecting / ready`。
5. 在自己的世界包中，将 `pack-module.js` 复制为 `plugins/rpg-maker.js`，将 `plugins.example.json` 的内容作为 `plugins.json`；在 `assetFiles` 登记这两个文件。修改声明的角色 ID 与 MZ 队员映射以符合实际工程。已有 plugins.json 时合并 modules，不能覆盖其他模块。宿主校验纯声明与脚本后，从普通场景操作提供“查看外部游戏”和“请求公共事件”。
6. 先核对本人视图，再请求白名单里的招呼事件；最后从 MZ 请求一个已绑定 NPC 处理。用玩家角色请求 AI 处理会拒绝，未绑定的队员也拒绝。没有工程时可以先运行[双入口演示](../world-packs/plugin-capabilities-demo/README.md)。

首版只面向桌面 MZ 的 Node 环境，不支持 MV、网页部署或默认 Perspectra 沙箱 iframe。官方文档说明 MZ 支持自定义插件、插件命令和桌面／浏览器部署；本骨架不因此宣称这些不同部署模式全部兼容。参见[插件管理器](https://rpgmakerofficial.com/product/MZ_help-en/01_05.html)、[插件注解](https://rpgmakerofficial.com/product/mz/plugin/make/annotation.html)、[输出格式](https://rpgmakerofficial.com/product/MZ_help-en/01_11_03.html)。

## 下一条需要实际验证的链路

拿到真实工程后，先做一名队友：

1. RPG Maker 在角色需要决策时提供有限可见信息与合法选项。
2. Perspectra 构建该角色的授权上下文，让角色选择和表达。
3. RPG Maker 经自身规则执行所选行动、播放表现，再返回实际结果。
4. 适配器将需共享的重要事实提交到既有 World Event Log，后续角色才按获授权的结果回应。

战斗的合法行动和实际执行要接真实 MZ 接口；本骨架不会猜测 `BattleManager` 的内部流程或把公共事件当作通用战斗输入。

同一重要事实应有明确的裁定方：伤害、装备和地图机制优先由 RPG Maker 执行，Perspectra 不再重算另一份。当前只有观察可经包规则提交为本人状态；公共事件没有执行完成回报，战斗实际结果仍需真实适配。能力结果非法、本地裁定失败或外部执行结果未知时，当前会话停止接受操作，不自动重试；须人工检查游戏后重启。

当前显式禁用此能力会话的重新生成、候选切换和故事节点。只有本地世界事件正常持久化，尚无 MZ 存档配对；重开实例也不会自动恢复 MZ。完整生命周期与边界见[双入口指南](../../docs/current/guides/dual-plugin-entrypoints.md)。

## 复现当前测试

```powershell
corepack pnpm@11.7.0 test:related tests/desktop/rpg-maker-bridge.test.ts tests/desktop/host-plugins.test.ts
```

本桥接覆盖队员视图裁剪、隐藏信息不导出、事件白名单与忙碌拒绝、错误令牌、Cordis 卸载清理、超时不自动重试，以及原生能力角色映射和 MZ 请求 NPC 回调。另有包模块及真实宿主入口测试。它们没有加载官方引擎、打开编辑器、运行真实战斗、调用真实模型或证明商业发行兼容性。

## Evidence → Finding → Path

| Evidence | Finding | Path |
| --- | --- | --- |
| 官方插件管理、注解与输出文档，链接见上方 | MZ 有作者插件入口及独立游戏运行方式 | 优先复用作者工程，在双端加桥接插件 |
| 桥接测试使用真实双端脚本、TCP 和原生能力会话 | 有限视图、事件白名单、角色映射和回调可独立验证 | 保留可运行骨架，不据此宣称实际 MZ 兼容 |
| 默认宿主已消费包模块和异步能力，MZ 仍无战斗合法选项输入 | 通用接线不能替代实际战斗适配 | 拿到真实工程后验证技能选择、完成回报与配对存档 |

本次全仓文档链接检查仍有两篇未修改的旧研究文档共 97 处断链，本说明及修改章节没有报告断链。未运行全仓测试，未提交或推送 Git。
