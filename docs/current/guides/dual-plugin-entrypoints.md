# 包内插件与 Cordis 宿主能力

例如你让澄向一个外部设备打招呼：澄自己决定是否行动；设备确认后，包内规则才增加她自己的确认次数。旁观者看不到她的私有数值。设备只说“已排队”时，宿主只记录排队说明，不提交完成效果。[最小示例包](../../../examples/world-packs/plugin-capabilities-demo/README.md)可以复现这条链路。

本指南核对 2026-10-26 实验分支。两种入口已经接入源码宿主和后端构建；复用现有状态、交互、角色回合与事件提交，没有新建存储或另一套角色协议。

| 入口 | 谁分发、谁选择 | 可以做什么 |
| --- | --- | --- |
| 世界包 `plugins.json` + `plugins/*.js` | 作者随包分发 | 声明状态和操作、筛选候选、准备能力参数、裁定返回结果 |
| 本地 Cordis `.mjs` | 玩家在 Launcher 启用 | 注册异步能力、连接外部进程或服务、请求绑定 NPC 处理一次机会 |

包不能自动安装或启用原生代码。两端都是可信扩展：包脚本与原有作者规则具有相同信任范围；Node VM 和 Cordis 都不构成恶意代码的安全沙箱。原生插件具有宿主进程权限，凭证只能在本地原生插件中处理，不写入包或返回结果。

## 包作者入口

在 `worldpack.source.json` 的 `assetFiles` 中登记 `plugins.json` 和每个 `plugins/*.js` 文件。源包编译仍只登记文件；模块声明与脚本在宿主加载时验证。CLI 编译成功不代表运行时依赖满足。

```json
{
  "modules": [{
    "id": "greetings", "entry": "plugins/greetings.js",
    "characters": ["character:player", "character:companion"],
    "capabilities": [{
      "id": "demo-device", "version": "0.1.0", "required": true, "config": {}
    }]
  }]
}
```

模块 ID 与操作 ID 使用小写字母、数字、连字符，首位为字母；组合后的 `<模块>-<操作>` 最长 41 字符。模块状态键必须以 `<模块>-` 开头。最多 16 个模块，脚本与声明各最多 64 KiB；文件必须在包的资产锁中且内容一致。`characters` 必须引用本包角色。

依赖按 ID 和版本字符串精确匹配。必需依赖缺失时在创建世界前失败，启动器会写明缺少的能力 ID 与版本；提供它的插件若加载失败，会被跳过并一并列出，而不是让所有世界都打不开；可选依赖缺失时隐藏其操作，包内纯规则仍可用。同一能力供多个模块使用时，版本、必需标记和配置须一致；绑定角色取这些模块角色的并集。当前没有热装载或依赖自动安装。

脚本设置 `globalThis.packPlugin`，完整例子见 [greetings.js](../../../examples/world-packs/plugin-capabilities-demo/plugins/greetings.js)：

| 成员 | 输入与职责 |
| --- | --- |
| `definition.statuses` | 沿用状态定义，包含 `key / label / type / owner` 等字段 |
| `definition.actions` | 沿用状态操作的 `id / label / schema / actors?`；异步操作再声明 `capability / method` |
| `initialize(characterIds)` | 返回 `{public, characters, reveals?}`，每个角色必须有对象 |
| `policy(known, actorId, world)` | 返回 `{operations: [本模块操作ID]}`；只接收该角色已知状态与授权世界视图 |
| `prepare(known, actorId, operation, arguments, world)` | 仅异步操作需要，返回原生方法参数对象 |
| `resolve(truth, actorId, operation, arguments, world, targetId, result)` | 返回原有 `{changes,reveals,description,audience,items?}` 或 `{rejectReason}`；纯操作的 result 为 null |

hook 必须同步，单次执行限制 100ms，只传入可序列化数据。模块合并到既有状态脚本后，操作成为 `status:greetings-confirm` 这样的普通交互。原来的 `scripts/status.js` 和活动继续使用，不要求迁移。本版不提供模块自己的每轮钩子，原状态脚本的钩子保留。

`policy` 在候选生成和执行时分别检查。`prepare` 不读取真值；`resolve` 与现有可信作者裁定一样读取真值并明确选择告知范围。包模块没有 Node 导入、数据库、模型调用或原始角色 Context 的专用接口。

## 原生能力入口

[demo-device.mjs](../../../examples/host-plugins/demo-device.mjs)是完整示例。注册方式：

```js
export const hostApi = '1.0'

export default function myPlugin(ctx) {
  ctx.effect(() => ctx.capabilities.register({
    id: 'my-device', version: '0.1.0',
    methods: {
      inspect: {
        arguments: { type: 'object', additionalProperties: false, properties: {} },
        result: { type: 'object' }, effect: 'read',
      },
    },
    async open(world, config) {
      // world: {address, worldVersion, requestCharacter(characterId, signal?)}
      return {
        async invoke(method, args, actorId, signal) {
          signal.throwIfAborted()
          return { completion: 'completed', data: { message: 'ready' } }
        },
        async close() {},
      }
    },
  }))
}
```

`ctx.capabilities.list()` 返回 ID、版本和方法 Schema 的副本，不含 provider 闭包。`open` 为每个世界运行时创建会话，收到包声明的配置副本。`invoke` 的 `actorId` 由宿主确定且必须属于绑定角色；模型参数不能代替调用者身份。输入和输出校验 Schema，输出最多 64 KiB；单次能力调用最长 10 秒。

`effect: 'read'` 表示不会改变外部状态；能排队、写入或改变外部世界的方法必须声明 `external`。这是可信插件契约，不是宿主对外部程序的自动检测。

`completion: 'completed'` 才把 data 交给包的完成裁定。`queued` 不执行作者完成裁定，只提交固定的自见排队说明，无数值变化。不要用 queued 冒充伤害、物品转移或奖励已经完成。

宿主先按原有操作 Schema、角色权限、可达性及活动 policy 做预检，再等待原生执行，最后经原有状态／物品校验提交。等待期间持有现有写租约，但不持有 SQLite 写事务；状态变化、行动结果和授权观察仍原子提交。不能把远端返回对象直接当作全部世界事实。

## 外部请求角色处理

会话可调用 `world.requestCharacter(characterId, signal?)`。角色必须在依赖该能力的模块声明中、确实是本包 NPC，且实例已就绪、未忙碌或暂停。宿主复用原有 `CharacterTurn`、Context、Memory、规则裁定和结果续写；角色可表达、提出行动或沉默，每次最多两步，模型调用仍受宿主预算限制。

调用不接收外部系统伪造的 Context、角色知识或任意刺激文本。返回 `{status,calls,expressions}`；expressions 仅含本次新提交且玩家有权阅读的该角色表达，不返回心理、私有上下文或凭证。目前没有“提交一组外部合法技能供角色选择”的通用接口，RPG Maker 战斗接入仍需实际工程验证。

## 生命周期、失败与存档

关闭世界、卸载 provider 或暂停未完成工作时取消调用；忽略取消的晚到结果也不提交。provider 由 `ctx.effect` 清理，会话有 `close()`，不因插件常驻而混用不同世界的角色绑定。

外部写可能已发生后，超时、断线、取消、非法结果或本地裁定／提交失败会使当前会话停止接受后续操作，并提示检查外部游戏后重启实例；不自动重试。本版没有跨进程事务或崩溃恢复。重启不会证明两侧已经一致，须先人工核对。

只要绑定 provider 声明外部写方法，本版就禁用故事节点、重新生成和候选切换，并在前端隐藏对应能力；启动时不创建自动节点。普通事件持久化保留，但没有外部游戏配对保存或恢复。只读能力和纯包模块继续沿用既有保存机制，原生只读服务自己的临时缓存不被保存。

## 验证到哪一步

自动化使用真实 Cordis、包模块、角色回合及 SQLite；角色模型服务为本机替身。另验证源码入口和 esbuild 后端通过 HTTP 暴露并执行模块操作。RPG Maker 测试运行真实双端桥接脚本和 TCP，MZ 对象是接口替身。

```powershell
corepack pnpm@11.7.0 test:related tests/desktop/host-capabilities.test.ts tests/scenarios/dual-plugins.test.ts tests/desktop/rpg-maker-bridge.test.ts tests/host/capability-plugin-entry.test.ts
```

没有真实模型试玩、实际 RPG Maker 工程、浏览器人工操作或发行包验收。接线和失败路径证据见[实验记录](../studies/2026-10-26_dual-plugin-entrypoints.md)。
