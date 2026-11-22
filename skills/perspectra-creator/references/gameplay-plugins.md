# 编写新玩法与选用 SDK

玩家点「搜查房间」，扣 1 点精力，得到只有自己知道的线索。玩法的关键代码是同一份 [investigation.cjs](../assets/investigation.cjs)。只在某个作品使用，就把它放进包里。若要让多个包选用同一个已安装的玩法、各自配置初始精力，就给它加原生插件入口。

## 在作品中直接写玩法

复制示例为 `scripts/gameplay.cjs`，把这个路径加入源清单的 `assetFiles`，并合并 `"scripts":{"gameplay":{"entry":"scripts/gameplay.cjs","config":{"energy":1}}}`。这个入口接收一个自包含的 CommonJS 定义，以 `module.exports` 导出。普通包脚本在同步 VM 内运行，示例中的 `import('@perspectra/sdk')` 是 JSDoc 类型标注。运行时直接使用宿主传入的参数。

| 作者要改变什么 | 在共同玩法定义中写什么 |
| --- | --- |
| 谁拥有精力、开局有多少 | `states` 声明字段和可见性，`initializeState` 依据角色 ID 与作品配置产生初值 |
| 玩家和角色可以做什么 | `operations[].offer` 从当前行动者的授权视图给候选，`argumentSchema` 描述参数，`resolve` 重新裁定并返回效果或业务拒绝 |
| 谁知道搜到了什么 | `resultSchema` 描述结果，`npc.projectResult` 按接收者投影，`npc.formatResult` 写成对方可读的观察 |
| 玩家看到怎样的操作和面板 | `ui` 描述操作，`playerView` 提供属性表、条目、开关或选择控件，变更状态的控件绑定正式操作 |

定义必填 `id`、`version`、`dataVersion`、`requiredServices`、`configSchema` 和 `operations`；声明状态时提供初值。操作 ID 使用自己的命名空间，如 `investigation:search`。验收一次成功、一次精力不足，以及旁观者实际收到的结果。

## 做成可供多个包选用的原生插件

1. 把 [investigation.mjs](../assets/investigation.mjs)、[investigation.plugin.json](../assets/investigation.plugin.json) 和 [investigation.cjs](../assets/investigation.cjs) 复制到**同一个本地插件目录**。`.mjs` 导出宿主 API 版本、供 CLI 读取的 `packPlugin`，以及默认 Cordis 函数。该函数通过 `ctx.effect(() => ctx.content.register(generator))` 注册生成器并绑定清理。`.plugin.json` 是启动器可直接读取的清单，与入口同名。新玩法需同步改清单、描述符和作品选择中的 ID 与版本。
2. 在游戏包中新建 `investigation.json`，填 `{"energy":1}`。把该文件加入已有 `assetFiles`，把 `"example-investigation":{"version":"1","config":"investigation.json"}` 加入已有 `plugins`。生成器的 `generate(config, pack)` 可读取本包角色、地点、物品和玩家 ID；本例返回 `{gameplay:[investigation]}`，宿主把作品配置传给定义。**同一个包选择一种接入方式**，同时选用原生搜证并在 `scripts.gameplay` 再声明同 ID 会冲突。
3. 在启动器的插件设置中选本地 `.mjs`，由玩家允许在本机执行并启用。游戏包只携带选择和配置。第三方原生代码以宿主权限运行，运行插件和 CLI 导入其校验模块都需要这份许可。
4. 单独用 CLI 核对时，用实际绝对路径写本地设置文件，然后执行下面的命令。静态校验会读取 `packPlugin.configSchema`；跨字段和包内引用可用 `validateConfig(config, pack)` 返回 `[{path,message}]`。用正式宿主开新档才能检验生成器、候选与实际结算。

```json
[{"id":"example-investigation","path":"D:/我的插件/investigation.mjs","enabled":true,"nativeAllowed":true}]
```

```powershell
worldpack.cmd validate "<源包目录>" --plugins "<本地设置.json>"
```

示例填 `energy:1` 时，应能搜查一次并看到精力变为 0，再次搜查应提示「精力不足」。把配置改成 `energy:0` 应在 `validate` 就报错。`--plugins` 是 `validate`、`compile`、`test` 的末尾选项；当前 `simulate` 和编辑器 CLI 没有加载这份原生插件设置的选项。

**只用命令行试玩原生插件。** 在新的 PowerShell 会话中，先按[正式 Host 试玩步骤](tavern/validation.md#用命令行做真实模型试玩)设置模型地址、标识和运行目录，再把静态校验用过的同一份设置读入 `PERSPECTRA_HOST_PLUGINS`。该环境变量的值是 JSON 数组正文。启动 Host 后从玩家页面或玩家 HTTP 接口实际选择操作，检查第二次调用和重新开档的表现。

```powershell
$env:PERSPECTRA_HOST_PLUGINS = Get-Content -LiteralPath '<本地设置.json>' -Raw -Encoding utf8
& './runtime/node.exe' './runtime/playtest.mjs' --pack '<源包目录>' --data-dir '<新存档目录>' --memory-core
```

使用同版本的系统 Node 也可以直接执行工具目录里的 `runtime/worldpack.mjs` 和 `runtime/playtest.mjs`。每次开档仍要由作品在清单里选择插件。

## 从已有包抽取玩法

抽出寄养柜台时，先找出谁在写随身队伍、首发和游戏时钟。若战斗与寄养原本共同修改一份角色台账，新建一个独立玩法定义后，`offer` 取得的 `state` 只包含本定义获准读取的状态。从另一个定义直接取旧台账键，可能表现为包能开档、界面上始终没有寄养选项。需要共同裁定这份台账时，可以让作品适配代码把战斗操作和通用护理操作组合在同一个拥有台账的定义中。另一部作品可使用自己的初值、时钟和面板。用战斗实际造成的损伤做一次寄养，等到期后领回，再查原队伍与首发，可以检验两处使用的确实是同一份状态。

迁移前还要查该操作是否出现在 `scripts.gameplay.responders`。这张表会按包内脚本声明的操作校验。移走操作后遗留旧键会在 `validate` 报「未知回应配置操作」。原生操作能通过 `npc.projectResult` 投影柜台回执；当前原生玩法定义没有同等的逐操作回应名单。原包用 `[]` 静默办理时，要在正式试玩中另外核对 NPC 的插话频率。

插件配置的自定义校验返回值里，`path` 使用字符串，如 `[{ "path": "/station/companions/0/hp", "message": "体力超过上限" }]`。填成数组会触发 `PLUGIN_VALIDATOR_FAULT`。用一份有意填错的配置运行 `validate --plugins`，确认作者看到的是具体字段和改法。

## 可用 SDK

当前源码的宿主 API 为 **2.12**。TypeScript 工程中 `@perspectra/sdk` 导出 `HostPlugin`、`HostServices`、`ContentGenerator`、`ContentGameplay`、`ActivityHooks` 等作者类型，以及 `defineGameplay`、`defineOperation` 等辅助函数。`@perspectra/sdk/contracts` 提供 `ActivityState`、`StatusTruth`、`WorldJsonObject` 等数据契约。项目将 SDK 标为私有工作区包；上面的 JavaScript 模板只依赖随附文件，可在单独插件目录运行。使用运行时辅助函数的 TypeScript 插件需在构建时解析并打包依赖。

| 原生插件的任务 | 对应的宿主 `ctx` 服务 |
| --- | --- |
| 按包配置生成玩法、活动与状态模块 | `content`。使用 `ContentGenerator`，返回共同定义或带原生钩子的活动、状态模块 |
| 增加规则裁定、消费获授权的世界事件 | `rules`、`worldEvents` |
| 提供活动、状态、骰子或节奏机制 | `activities`、`status`、`dice`、`pacing` |
| 提供知识、通信、自主行动机制 | `knowledge`、`communication`、`autonomy` |
| 调整角色处理机会、执行、决策或模型与记忆服务 | `scheduler`、`characterLoop`、`decisions`、`llm`、`memory` |
| 接入外部能力、语音或音乐、订阅玩家可见动态 | `capabilities`、`frontendServices`、`playerFeed` |

宿主原生插件在 Cordis 注册时得到 `ctx`。包内脚本只使用对应钩子的参数。例如写一个新棋类活动可直接用活动定义；要替换整个活动解释机制才涉及注册 `ctx.activities` Provider。原生模块的宿主 API 版本、清单的插件版本、持久玩法的 `dataVersion` 各自独立。
