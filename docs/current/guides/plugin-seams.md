# 插件能替换什么

2026-11-05 M4：API 2.7 新增 `ctx.activities`，活动计算与选择已独立；参与者、隐私、随机记录和提交仍由核心／宿主检查。见[M4 记录](../studies/2026-11-core-migration-m4.md)。

2026-11-05 M3：API 2.6 新增 `ctx.status`，解释既有状态和包内玩法脚本；值、告知权限、物品与提交仍由核心检查。普通玩法作者继续写脚本，不需要编写 Cordis 插件。见[状态机制](host-plugin-authoring.md#替换状态脚本机制26)与[M3 记录](../studies/2026-11-core-migration-m3.md)。

2026-11-04 M1：API 2.5 新增 `ctx.knowledge`，替换作者设定选择；原有 2.0～2.4 插件仍可加载。它通过公开 select 接入官方知识扩充，配置读取与规则提交仍归宿主。注册方式见[知识机制](host-plugin-authoring.md#替换设定知识机制25)。

2026-11-04 默认组合：第三方先注册，官方通过相同 register／effect 填充空位；打开顺序由组合声明。服务消费者可放在提供者前面，缺服务或互相等待时以 apply 原因显示未启动，不作为实际生效插件。requiresPlugins、Cordis inject 和 decisionOrder 是三种不同关系，详见[阶段 11](../studies/2026-11-plugin-first-phase-11.md)。

核对日期：2026-11-05，宿主 API `2.7`（2.0～2.6 插件仍可加载；自定义记忆窗口见编写指南）。这是给插件作者的总入口，每一项的完整写法在[插件编写指南](host-plugin-authoring.md)。

2.4 新增 `ctx.characterLoop`：例如只允许角色操作一次，再根据真实结果表达一次，可启用 [single-action-loop](../../../examples/host-plugins/single-action-loop.mjs)。官方循环也使用相同能力；授权上下文、受众、规则和提交仍在主干。写法见[角色执行循环](host-plugin-authoring.md#替换角色执行循环24)。

2.3 增加同一 `ctx.llm` 下的角色发送适配器，保留官方预设、输出/展示和检查；与完整通道互斥。注册和记录范围见[发送指南](host-plugin-authoring.md#只替换角色模型发送23)。2.0～2.2 插件仍可加载。

## 先看一个例子

你想让某个房间谁都进不去。写一个文件 `locked-room.mjs`，放在任何地方：

```js
export const hostApi = '2.0'

export default function (ctx, config) {
  ctx.effect(() =>
    ctx.rules.register({
      id: 'locked-room',
      version: '0.1.0',
      open: async () => ({
        resolve: (context, next) =>
          context.action.actionType === 'move' && context.action.parameters?.locationId === config.locationId
            ? { status: 'rejected', events: [], reason: 'plugin:门锁着，进不去。' }
            : next(context),
      }),
    }),
  )
}
```

旁边放一份 `locked-room.plugin.json`，写上 `id`、`name`、`version`、`services` 和要玩家填的 `config`。玩家在启动器“全局设置 → 插件”添加这个文件，填好房间，启用。之后玩家走过去会被拒，读到“门锁着，进不去”，角色也一样。完整版本是 [locked-room.mjs](../../../examples/host-plugins/locked-room.mjs)。

所有插件都这样：导出 `hostApi`，默认导出一个函数，通过 `ctx` 用服务，注册放进 `ctx.effect`。不用自己装 Cordis。

## 九个可替换的模块

`open` 在每个世界实例打开时调用一次，包括重新生成的候选，所以每局状态不要放在模块顶层。2.0 的调度接缝同时覆盖普通反应、自主机会和活动处理，官方实现也走相同入口。1.x 插件会因主版本不兼容被跳过，需要适配并更新声明；没有旧接口兼容分支。

| 接缝 | 用来做什么 | 需要的 `hostApi` | 官方实现 | 多个插件同时启用 | `open` 失败时 |
| --- | --- | --- | --- | --- | --- |
| [`ctx.scheduler`](host-plugin-authoring.md#替换角色调度器) | 决定谁在什么时候获得处理机会 | `2.0` | `official-scheduler` | 只用一个 | 改用官方调度 |
| [`ctx.activities`](host-plugin-authoring.md#替换活动机制27) | 活动脚本计算与候选选择 | `2.7` | `official-activities` | 只用一个 | 世界不打开 |
| [`ctx.status`](host-plugin-authoring.md#替换状态脚本机制26) | 解释既有状态与包内模块脚本 | `2.6` | `official-status` | 只用一个 | 世界不打开 |
| [`ctx.knowledge`](host-plugin-authoring.md#替换设定知识机制25) | 按角色权限与情境选择作者设定 | `2.5` | `official-knowledge` | 只用一个 | 世界不打开 |
| [`ctx.characterLoop`](host-plugin-authoring.md#替换角色执行循环24) | 决定一次处理内怎样申请行动、表达和续写 | `2.4` | `official-character-loop` | 只用一个 | 世界不打开 |
| [`ctx.memory`](host-plugin-authoring.md#替换长期记忆) | 整理角色的经历，在它决策时取回 | `2.0` | `official-memory-core` | 只用一个 | 世界不打开 |
| [`ctx.llm`](host-plugin-authoring.md#替换模型通道) | 把角色的决策发给模型 | `2.0` | `official-llm` | 只用一个 | 世界不打开 |
| [`ctx.decisions`](host-plugin-authoring.md#加入角色决策) | 给决策加内容，或包住整个决策 | `2.0` | `official-contexts`，五项官方扩充 | 默认有序组合，第三方可同 ID 替换 | 世界不打开 |
| [`ctx.rules`](host-plugin-authoring.md#增加世界规则) | 在官方规则外再加一层裁定 | `2.0` | 没有，默认为空 | 先注册的在最外面 | 世界不打开 |

只用一个的接缝，如果启用了多个提供它的插件，第一个生效，后面的注册失败、整个插件被跳过。玩家在插件页“模块”分组里能看到会生效的是哪个，也能选。

2026-11-04 核对：模块页按清单显示下次启动的预计组合；一个插件在调度等单例模块上冲突时，它声明的记忆、规则等其他服务也显示为预计跳过，不再单独算作生效。清单不能证明 apply 成功，启动后的跳过提示仍以实际加载结果为准。

运行中出错时：

| 接缝 | 结果 |
| --- | --- |
| 调度器抛错或返回非法结果 | 这一轮反应结束，已提交内容保留 |
| 角色循环自身抛错或虚报发布成功 | 角色处理失败，已提交内容保留；循环自身异常提示插件 ID |
| 状态机制计算抛错 | 报告实际机制 ID，保留已提交内容；候选效果仍须核心校验 |
| 知识的 `select` 抛错 | 这一轮角色处理失败，提示知识机制 ID，已提交内容保留 |
| 记忆的 `project` 抛错 | 这一轮角色处理失败并提示 |
| 模型的 `send` 抛错或超时 | 这一轮失败，提示里有插件 ID |
| 决策的 `context`、`decide` 抛错 | 这一轮失败，提示里有插件 ID |
| 规则的 `resolve` 抛错 | 这次行动被拒绝，世界不卡住 |
| 规则的 `affordances` 抛错 | 可选项不变 |

## 其他服务

这些不替换任何东西，只是加功能。

| 服务 | 用来做什么 | 例子 |
| --- | --- | --- |
| `ctx.capabilities` | 提供异步能力，比如设备或外部程序。世界包的脚本可以调用 | [demo-device.mjs](../../../examples/host-plugins/demo-device.mjs)、[双入口指南](dual-plugin-entrypoints.md) |
| `ctx.frontendServices` | 语音和背景音乐 | [http-speech.mjs](../../../examples/host-plugins/http-speech.mjs)、[demo-bgm.mjs](../../../examples/host-plugins/demo-bgm.mjs) |
| `ctx.playerFeed` | 只读订阅玩家看到的对话 | [transcript-file.mjs](../../../examples/host-plugins/transcript-file.mjs) |

## 哪些不能替换

- **事件日志和原子提交。** 模块只能提出结果，提交由宿主完成，只能产出主干认识的事件。
- **授权视图。** 每个角色能看到什么由主干算。这不是说插件读不到别的角色：调度器和记忆插件能读任意角色的视图，把私有内容交给另一个角色，隔离就破了，这是作者的责任。
- **插件装载本身，以及 `contracts`。**
- **世界包的玩法。** 活动和状态规则在包脚本里，想做新玩法请写包内脚本。规则接缝管不到状态操作、活动操作和短信。

## 世界包依赖插件时

世界包可以在 `worldpack.source.json` 里声明需要哪些插件：

```json
"requiresPlugins": [
  { "id": "locked-room", "version": "^0.1.0" },
  { "id": "my-bgm", "version": ">=1.0.0", "optional": true }
]
```

版本写 `1.2.3`（完全相同）、`^1.2.3` 或 `>=1.2.3`。启动器在开局前读取，不执行插件代码，一次列全缺失、没启用和版本不符的项目，然后拒绝开局。`optional` 的只提示，不拒绝。游戏进程启动时再查一次，所以配置无效或 `hostApi` 不兼容、被跳过的插件也算没生效。

只支持正式版本，预发布版本会被拒绝，构建元数据不影响比较。caret 固定首个非零版本分量：`^0.1.0` 可接受 `0.1.5`，`^0.0.1` 只接受 `0.0.1`。

依赖按清单里的 `id` 匹配，所以**插件想被世界包依赖，清单就要写 `id`**。没有清单或清单没写 `id` 的插件照常加载，但满足不了依赖。

不声明这个字段的世界包，哈希和以前完全一样。

## 换了模块以后，存档会怎样

每个存档目录有一份 `plugin-set.json`，记录上次实际生效的模块和版本。再次打开时如果不同，玩家会读到“这个存档使用的模块变了：长期记忆：a 1.0.0 → b 1.0.0。世界事实不受影响。”世界照常打开。文件损坏或缺失只是这次不提示。

卸载插件后同一个存档能打开，已提交的世界事实不变。插件自己的数据不会迁移给官方实现，角色可能因此“失忆”。

打开存档与重演旧回合是两件事：重新生成或切换旧候选会比较九个接缝的 ID、版本和公开 `identity`，包括叠加顺序。插件可以用 `identity` 声明会改变执行的非敏感设置；对象键顺序不影响比较，凭证不能放在里面。宿主不猜测未声明的插件配置变化，也不把这类配置自动复制到存档。旧回合环境不一致时拒绝重演，仍可继续新的玩家输入。

## 信任模型

玩家启用插件就视为信任作者。插件和游戏进程权限相同，没有沙箱。插件拿不到玩家的模型 Key，要调用模型得自己配置，费用和凭据由作者说明。给调度器的玩家上限只是建议，宿主不拦。

## 现在还没有

- 插件自己的 HTTP 路由、写入事件日志的私有记录、随节点复制的插件数据目录。设计里提过，阶段 5 确认没有实际插件需要，所以没做。记忆插件用 `snapshotArchives` / `restoreArchives` 随节点保存。
- `@harness-world/plugin-sdk` 还没发布到 npm，仓库外开发时参照[类型源码](../../../packages/plugin-sdk/src/index.ts)。

## 验证范围

官方实现和接缝都有自动测试和真实模型对比，记录在[阶段 1](../studies/2026-11-plugin-first-phase-1.md)到[阶段 5](../studies/2026-11-plugin-first-phase-5.md)。示例插件 `impulsive-scheduler`、`simple-llm`、`locked-room` 跑过真实模型。第三方的记忆插件和决策插件只用测试替身验证过，还没有真实插件试玩。
