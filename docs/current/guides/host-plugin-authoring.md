# 编写并加载自己的 Cordis 宿主插件

2026-11-04：本次核对宿主 API 2.0 与完整调度接缝；下方声音等历史验收范围保留。想先知道插件能替换什么、不能替换什么，看[总入口](plugin-seams.md)。世界包依赖插件的写法也在那里。

2026-10-26：例如同伴操作外部设备，包内模块负责玩法规则，Cordis 插件通过 `ctx.capabilities.register` 提供异步原生能力。按世界创建会话、角色请求、完成后裁定及失败限制见[双入口指南](dual-plugin-entrypoints.md)。原生完整例子是 [demo-device.mjs](../../../examples/host-plugins/demo-device.mjs)，外部程序方向见 [RPG Maker](../../../examples/rpg-maker/README.md)。下方声音指南仍沿用原验收范围。

2026-10-26 玩法补充：宿主插件不负责生成包的玩法规则。可复用的规则以作者工具形式分发，例如 [RPG Core 生成器](../../../examples/rpg-core/generate.mjs) 在创作时输出普通活动脚本，随包发布；同日删除的 `ctx.gameplay.registerActivity` 不再可用。说明见[示例包](../../../examples/world-packs/rpg-core-demo/README.md)与[实验记录](../studies/2026-10-26_cordis-rpg-core-prototype.md)。

例如同行者读到“门外的争执让气氛变得紧张”，创作者希望日常曲淡出、紧张曲响起。创作者编写曲库和选曲规则；默认舞台提供播放器，玩家读到那一段才触发选择。音乐不会写入世界事件、存档或角色记忆。

核对日期：2026-10-24。适用于当前源码；本轮未重建便携发行包。插件是可信本地 Node 代码，与宿主拥有相同权限，须由玩家在启动器明确启用。Cordis 管理装载与退出，不提供安全沙箱或自动 npm 安装。

## 先运行一个不需要音频文件的示例

1. 在启动器“全局设置 → 插件”点“添加本地插件”，文件选择 [demo-bgm.mjs](../../../examples/host-plugins/demo-bgm.mjs)的绝对路径，插件 ID 没有自动填上就填 `demo-bgm`。
2. 勾选加载，保存设置，下次启动游戏生效。
3. 在默认舞台内点击一次，解锁浏览器声音。“设置 → 声音”中可关闭背景音乐、调整音量或静音。

示例在内存生成两段很轻的测试和弦，不是正式配乐。当前段落含“争执”“危险”或“紧张”时选紧张曲，含“停止音乐”时返回静音，其他段落选日常曲。这只是可替换的示例规则，运行时没有新增文本分类器或模型调用。

插件文件可以独立分发给玩家，不要求放进世界包；选择保存在本机 Launcher 设置，不随故事分享。示例本身只依赖 Node 和宿主给出的 `ctx`，不需要创作者安装 Cordis。若自己的插件依赖第三方 npm 包，需要自行备好依赖，宿主不会安装。

## 换成自己的音乐和规则

创建一个目录，放入 `my-bgm.mjs`、`calm.ogg` 和 `tense.ogg`。在 `my-bgm.mjs` 写：

```js
import { readFile } from 'node:fs/promises'

// 必须声明：本插件需要的最低宿主 API 版本。
export const hostApi = '2.0'

export default async function myBgm(ctx) {
  const tracks = await Promise.all([
    ['calm', '午后', './calm.ogg'],
    ['tense', '不安', './tense.ogg'],
  ].map(async ([id, title, file]) => ({
    id, title, contentType: 'audio/ogg',
    bytes: new Uint8Array(await readFile(new URL(file, import.meta.url))),
  })))

  ctx.effect(() => ctx.frontendServices.registerBgm({
    tracks,
    selectTrack(input, signal) {
      signal.throwIfAborted()
      if (input.text.includes('停止音乐')) return null
      return input.text.includes('争执') ? 'tense' : 'calm'
    },
  }))
}
```

再放一份同名清单 `my-bgm.plugin.json`，启动器会显示插件名、作者和用途，并为 `config` 里的字段生成输入框：

```json
{
  "id": "my-bgm",
  "name": "我的配乐",
  "version": "1.0.0",
  "author": "你的名字",
  "description": "日常与争执两段配乐。",
  "services": ["frontendServices"],
  "config": {
    "tenseWord": { "type": "string", "title": "触发紧张曲的词", "default": "争执" }
  }
}
```

`id` 是可选的小写字母、数字和连字符，世界包声明依赖时按它匹配，想被依赖就要写。插件函数的第二个参数就是玩家填写的值，已补上默认值：把上例的 `input.text.includes('争执')` 换成 `input.text.includes(config.tenseWord)`，函数签名写成 `myBgm(ctx, config)`。需要保存 API Key 之类的值时，给字段加 `"secret": true`，它会存进 Windows 凭据管理器而不是设置文件。字段格式和保存位置见[宿主插件](../host-plugins.md)。

将整个目录交给玩家，在 Launcher 添加 `my-bgm.mjs`，即可使用官方播放器。不要同时启用这个插件和示例 BGM；当前只允许一个插件决定配乐，但可以同时加载 TTS。

音频格式用正确的 `contentType`：MP3 为 `audio/mpeg`，OGG 为 `audio/ogg`，WAV 为 `audio/wav`。宿主检查字节与大小，不检测实际编码，文件能否解码还取决于浏览器；加载损坏音频时舞台提示失败，阅读照常继续。

## 宿主提供哪些接口

当前宿主 API 为 `2.2`（既有 2.0、2.1 插件仍可加载），插件须导出 `export const hostApi = '2.0'`。装载器在调用插件之前比较版本：主版本必须相同，宿主次版本不低于声明值；未声明或不兼容时跳过并提示。2.0 中，同一个调度器也负责自主和活动处理；旧 1.x 插件需核对接口并更新声明，不会自动回退到旧调度行为。其他服务的调用形状未在本次改变，但也须更新主版本声明。

所有接口类型集中在 [@harness-world/plugin-sdk](../../../packages/plugin-sdk/src/index.ts)：`HostServices` 列出服务，`SchedulerRound` 等定义参数与事件形状。宿主直接引用这些类型。该包尚未发布到 npm，也不随便携包附带；仓库外开发时可参照源码或复制类型。

目前使用项目依赖的 `@deepseek-ai/cordis@4.0.1`。装载器接受默认导出的函数、类或 `{ apply(ctx) {} }` 对象；资源注册用 `ctx.effect(() => register(...))`，退出时返回的注销函数随插件释放。外部文件入口必须是 `.mjs` 或可由 Node 按 ESM 解析的 `.js`，不直接执行 TypeScript。插件初始化抛错时只跳过这一个插件，已经通过 `ctx.effect` 注册的服务会被撤销，所以注册都应放进 `ctx.effect`；启动器设置页会标出上次被跳过的插件及原因；详细错误只输出到游戏进程的标准错误，调试时请从命令行启动游戏。加载入口见[宿主插件](../host-plugins.md)，类型定义见 [plugin-sdk](../../../packages/plugin-sdk/src/index.ts)。

| 接口 | 用途 |
| --- | --- |
| `ctx.capabilities.register(provider)` / `list()` | 注册按世界打开的异步能力 / 读取方法目录，详见[双入口指南](dual-plugin-entrypoints.md) |
| `ctx.playerFeed.subscribe(listener)` | 只读订阅玩家可见的对话记录，收到 `{ kind: 'append' \| 'reset', lines }`，返回退订函数；详见[宿主插件](../host-plugins.md)，例子是 [transcript-file.mjs](../../../examples/host-plugins/transcript-file.mjs) |
| `ctx.frontendServices.registerBgm({ tracks, selectTrack })` | 注册一个曲库和选曲回调，返回注销函数 |
| `ctx.frontendServices.registerSpeech(synthesize)` | 注册一个 TTS 回调，详见[语音示例](../../../examples/host-plugins/http-speech.mjs) |
| `ctx.effect(() => disposer)` | 把自己打开的连接、定时器或注册项交给 Cordis 在退出时释放 |

`tracks` 是 1–16 项数组，每项包含 `id`、`title`、`contentType`、`bytes`。ID 是最多 64 字符的小写字母、数字、下划线或连字符，首字符必须是字母或数字；标题 1–120 字符；音频字节非空、单首不超过 32 MiB。曲库注册时复制，在游戏进程内存中保留，当前没有流式播放或持久缓存。

`selectTrack(input, signal)` 接收 `{ seq, segmentIndex, text, type, speakerId? }`。这是宿主从玩家有权阅读的已提交段落重新解析的内容，不接受前端伪造的正文或发言者，也没有角色心理、私有记忆、完整角色名单或宿主令牌。

返回已注册曲目 ID，或 `null` 表示静音；可以返回 Promise。建议只依据本段输入和自己的静态配置选择，以便跳过、重载、候选替换时行为一致；不要靠“被调用几次”推进音乐。回调没有逐段历史场景或玩家当前地点，不能用后台最新场景代替阅读时点。需要异步请求时传递 `signal`；插件注销会取消请求并拒绝晚到结果。

这些接口是 Perspectra 提供的服务，不是所有 Cordis 宿主共有的业务 API。插件可以自行使用 Node 能力，但世界玩法应通过现有作者规则和 Action / Rulebook / Event 路径扩展；不要直接改数据库或把配乐选择写成世界事实。当前没有任意前端脚本注入、通用插件设置面板、热更新或自动安装依赖。

## 替换角色调度器

例如你想让性格急躁的角色总是抢先回应。[impulsive-scheduler.mjs](../../../examples/host-plugins/impulsive-scheduler.mjs) 就是这样一个示例：在“抢先回应的角色”里填 `character:witness`，这个角色听见动静后最先获得机会。它说什么、要不要回应，仍由模型决定。

插件向 `ctx.scheduler` 注册一个 Provider：

```js
export const hostApi = '2.0'

export default function (ctx) {
  ctx.effect(() =>
    ctx.scheduler.register({
      id: 'my-scheduler',
      version: '1.0.0',
      open: async world => ({ run: round => myRun(round) }),
    }),
  )
}
```

- `open` 在每个世界实例打开时调用一次，包括重新生成的候选，所以不要把每局状态放在模块顶层。
- `round.phase` 区分 `scene`、`autonomy` 与 `activity`。普通场景可能同时携带 `round.autonomy`：你的实现决定先后或交错执行；`autonomy.staged` 是官方分段选项，第三方可自行组织。活动后单独的自主机会使用 `autonomy` 阶段。
- `round.observationsSince(afterSeq, throughSeq)` 告诉你谁有新观察。`round.turn(id, { signal, stimulusSeqs, maxCalls })` 让角色处理一次。你只按序号指定观察，内容由宿主取出，序号不属于该角色时会被拒绝。
- `round.observationSeqs(id, afterSeq, throughSeq)` 返回该角色授权视图中的全部观察序号，顺序沿用视图，不保证数值递增。官方活动将它们排序后取最近 8 条；自主机会沿用视图顺序。自主处理用 `round.turn(id, { kind: 'autonomous', ... })`，合法行动继续由宿主裁定。
- `round.activity.next()` 给出当前合法参与者；你可以不给机会、只处理一次或继续处理。每次 `turn` 前宿主重查参与者，完成后用真实结果推进活动。不能跳过法定次序、伪造 outcome，或同时执行两个活动参与者。`resultUnknown()` 为真时应停止。
- 返回 `{ calls, wave, terminalReason, activations }`。`failed`、`interrupted`、`call_limit`、`wave_limit`、`character_limit` 有各自的玩家提示，其他值都显示为本轮已结束。
- 进阶接口 `onCommitted` 和 `continuationOf` 用于动态并发和过期重算，可参考[官方实现](../../../packages/official-scheduler/src/index.ts)。

需要定义自己的服务时，可以 `import { Service } from '@deepseek-ai/cordis'`，宿主会把它指向自己运行的那一份，插件不用也不要自带。

**由作者负责的部分。** `round.limits` 是玩家设置的上限，只作为建议传给你，宿主不做总量拦截，超出就要玩家多付模型费用。`world` 和 `round.world` 能读所有事件和任意角色的视图，把一个角色的私有内容交给另一个角色，隔离就破了。玩家启用插件即视为信任作者，宿主不做沙箱。活动中的合法参与者属于玩法；调度器决定是否提供机会，不改变玩法规定的合法顺序。`beforeModelCall` 是可选的本轮预算回调，在真实发送与格式重试前调用；官方分段自主调度用它计数，第三方不传时宿主不施加官方总量限制。`calls` 仍是角色决策计数，不等于任意决策插件实际发送的总次数。

调度器抛错或返回非法结果时，这一轮反应结束，已提交的内容保留，玩家看到提示后可以继续。打开失败时改用官方调度。如果它忽略取消信号又一直不返回，这一轮会卡住，只能重启游戏。

玩家移除插件后，同一个存档回到官方调度，已提交的世界事实不变。自动测试覆盖替换、异常、候选与存档重开。阶段 7 的真实模型验收单独记录在[实施记录](../studies/2026-11-plugin-first-phase-7.md)，不能从单测推导。示例采用自主处理后不追加反应波的简化策略；官方实现保留原有后续反应。

## 替换长期记忆

例如你想用自己的向量库让角色记住玩家说过的话，不想装 Python。插件向 `ctx.memory` 注册一个 Provider，官方 Core 就不再启动：

```js
export const hostApi = '2.0'

export default function (ctx) {
  ctx.effect(() =>
    ctx.memory.register({
      id: 'my-memory',
      version: '1.0.0',
      open: async world => ({
        project: async (request, signal) => {
          const characterId = request.context.character.characterId
          const { headSeq } = world.world.head()
          const sources = world.world.authorizedSources(characterId, headSeq)
          return { ...request, context: { ...request.context, memories: await myRecall(sources, signal) } }
        },
      }),
    }),
  )
}
```

- `open` 在每个世界实例打开时调用一次，包括重新生成的候选。每局数据放在 `world.dataDirectory` 下，那是这个插件在这个世界实例里的专属目录，目录要自己创建。新世界在 `open` 时可能还没激活，不要在 `open` 里读世界，等 `project` 时再读。
- `project` 是唯一必需的方法，每次角色决策前调用，返回的 `context` 交给模型。放进 `memories` 的内容排在场景信息之前，也参与[按需知识](world-knowledge.md)的条件匹配；其他字段名也能送达，排在已知字段之后。角色提示不会解释这些内容，要让它们自己说得清楚。
- `world.authorizedSources` 只返回这个角色有权知道的内容，每个世界实例的进度由宿主保存。
- 记忆 Provider 的 `shortTermAfterSeq` 现在由实际执行交付的决策步骤转接。默认官方记忆步骤自动转接；自定义步骤须按下方 2.2 接口明确配对。没有步骤提供截断回调时，使用最近 16 条观察和 8 条自身表达；不会仅因 Core 还开着就裁掉归档前缀。
- 其他方法都可选：`startRefresh` 手动整理，`backgroundState` 显示进度，`snapshotArchives` / `restoreArchives` 随节点保存。类型见 [plugin-sdk](../../../packages/plugin-sdk/src/index.ts) 的 `MemoryInstance`。

**由作者负责的部分。** `world.world` 还能读所有事件和任意角色的视图，只用 `authorizedSources` 才不会把一个角色的私有内容交给另一个角色。插件拿不到玩家的模型设置和 Key，要调用模型需要自己配置，费用和凭据由作者说明。

| 情况 | 结果 |
| --- | --- |
| `open` 失败 | 世界不打开，错误里有插件 ID。不会悄悄换成别的记忆，否则玩家会以为角色失忆 |
| `project` 抛错 | 这一轮角色处理失败并提示，已提交内容保留，下一轮可以继续 |
| 重新生成 | 宿主在每轮开始时按文件复制 `world.dataDirectory`，候选能看到这些文件。保持文件一致是作者的事，比如 SQLite 要先把日志写回主文件；数据很大时每轮都会变慢 |
| 保存节点 | 节点不包含这个目录。要让节点带上记忆，实现 `snapshotArchives` / `restoreArchives` |
| 没有实现 `restoreArchives` | 节点照常保存和恢复，新故事线的角色只有近期经历 |
| 打开别的记忆实现保存的节点（包括别人分享的） | 档案只交还给写入它的同一插件 ID。其他实现收到空档案，角色只有近期经历，Core 档案也不例外 |
| 换插件或升级插件版本 | 上一轮不能再重新生成，提示环境已改变 |
| 同时使用 `--memory-none` 和记忆插件 | 插件优先 |

玩家移除插件后，同一个存档回到 Core，已提交的世界事实不变，插件自己的数据不会迁移给 Core。自动测试覆盖替换、异常、重新生成、节点恢复和分享导入，用的都是测试里的假实现；还没有真实的第三方记忆插件在真实模型下试玩过。

## 替换模型通道

例如你想让角色走自己的本地模型，或者加一层缓存。[simple-llm.mjs](../../../examples/host-plugins/simple-llm.mjs) 是完整示例，把决策发给任意 OpenAI 兼容地址。插件向 `ctx.llm` 注册一个 Provider，只需要写 `send`：

```js
export const hostApi = '2.0'

export default function (ctx) {
  ctx.effect(() =>
    ctx.llm.register({
      id: 'my-llm',
      version: '1.0.0',
      open: async world => ({
        send: async (characterId, call, request, signal) => myModel(call.messages, call.schema, signal),
      }),
    }),
  )
}
```

- `send` 收到准备好的消息和回答格式，返回解析后的 JSON。宿主校验回答，格式不对时重试一次，再不对就不执行任何操作。所以解析不了就把文本原样返回，只有调用本身失败才抛错。
- 把 `signal` 传给实际请求。信号触发后宿主不再等待，这一轮提示超时；请求还在跑的话，停下它是作者的事。
- `prepare` 可选，用来换掉默认提示词。`display` 可选，用来调整玩家读到的文字。
- 插件拿不到玩家的模型 Key，地址和凭据写在插件自己的配置里，见[插件清单](../host-plugins.md)。

| 情况 | 结果 |
| --- | --- |
| `open` 失败 | 世界不打开，错误里有插件 ID。不会悄悄改用官方模型，否则玩家的故事会发到没想到的地方 |
| 插件被跳过（配置不全、版本不兼容等） | 清单 `services` 声明了 `llm` 时，世界不打开，同样不会改用官方模型。没有清单的插件宿主无从判断，会直接用官方模型 |
| `send` 抛错或超时 | 这一轮失败，提示里有插件 ID，详细错误写到游戏进程的标准错误。已提交内容保留，下一轮可以继续 |
| 换插件或升级插件版本 | 上一轮不能再重新生成，提示环境已改变 |

**换掉之后少了什么。** 玩家的预设（提示词、输出和显示规则）属于官方实现，第三方收到的是不带预设的默认消息。创作者页也看不到这条通道的请求详情。Core 的整理由 Python 调用模型，不走这个接缝。启动器的连接检查不变，仍要配一个模型连接。

## 组合官方上下文扩充（2.1）

例如只想减少设定材料，可启用 [focused-knowledge](../../../examples/host-plugins/focused-knowledge.mjs)，它以 `official-context-knowledge` 为 ID 注册 decisions，替代该项默认实现。其余官方步骤仍执行，基础授权与活动约束仍在主干。

默认顺序是 `official-context-memory`、`official-context-recent-execution`、`official-context-status`、`official-context-knowledge`、`official-context-expressions`；未指定位置的第三方步骤按加载顺序追加。同 ID 注册即明确替换；返回空实例可停用该项。配置影响行为时在 Provider 的公开 identity 中声明，勿写入凭证。

每世界 `open(world)` 可读 `world.contextSources` 的 `memory`、`recentExecution`、`status`、`knowledge`、`expressions`。它们接收当前 request 与 signal，返回扩充后的 request。status 和 knowledge 复用当前角色授权选择，不返回完整真值；知识条件读取前面投影的已知状态。memory 只调用所选记忆 Provider 的 project，停用此步骤不卸载该记忆 Provider 或取消其后台整理。

源码装配可通过 `HostSeams.decisionOrder` 明确有序 ID 列表；省略的官方项不再补回，未定位的第三方项追加。重复或未知 ID 拒绝打开。该设置尚无 Launcher 专用排序界面。顺序与第三方 ID/版本/identity 一起进入候选环境比较。请区分“只停用扩充”和“停用记忆服务”；不要让两个步骤重复调用 memory 投影。

### 替换记忆步骤时配对交付与窗口（2.2）

例如你只想在 Core 的交付结果后补一句提醒，替换步骤应同时保留交付和窗口；否则 Core 即使仍在后台整理，也不能证明本轮角色收到了档案。新增接口要求插件声明 `hostApi = '2.2'`：

```js
export const hostApi = '2.2'
export default function (ctx) {
  ctx.effect(() => ctx.decisions.register({
    id: 'official-context-memory', version: '1.0.0',
    open: async world => ({
      context: (request, signal) => world.contextSources.memory(request, signal),
      shortTermAfterSeq: id => world.contextSources.memoryAfterSeq?.(id),
    }),
  }))
}
```

`DecisionInstance.shortTermAfterSeq` 表示这个实例负责交付被裁去前缀的归档。最多一个步骤声明该回调，且它须有 context 或 decide 实现。也可用自己的交付与边界；第三方代码仍由玩家信任。没有提供回调时回到近期观察窗口，宿主不会暗中恢复默认记忆步骤；若记忆 Provider 仍提供归档边界，打开实例时会提示长期记忆交付由所选扩充负责。近期窗口不等于完整长期记忆，自定义步骤仍需明确选择是否交付档案。

此规则也适用于旧 2.1 的自定义记忆步骤：它们可以加载，但要保留 Core 的归档后窗口，需要按 2.2 明确转接。其他 2.1 步骤无需改动。

## 加入角色决策

例如你想在角色开口前加一段“今天的天气”，或者检查回答后让角色重新说一次。`ctx.decisions` 可以注册多个实现，按加载顺序生效：

```js
export const hostApi = '2.0'

export default function (ctx) {
  ctx.effect(() =>
    ctx.decisions.register({
      id: 'my-weather',
      version: '1.0.0',
      open: async world => ({
        context: async request => ({ ...request, context: { ...request.context, weather: '下雨' } }),
        decide: async (request, next, signal) => {
          const answer = await next(request)
          return isFine(answer) ? answer : next({ ...request, context: { ...request.context, retry: true } })
        },
      }),
    }),
  )
}
```

- `context` 给这个角色加内容，在记忆、状态和知识之后运行。你加的内容就是这个角色知道的，把别人的私有内容放进去，隔离就破了。
- `decide` 包住整个决策，可以多次调用 `next`，也可以不调用，自己返回答案。答案同样要经过 `CharacterTurn` 校验，不能直接写入世界事实。
- `serial: true` 让角色逐个处理，并关闭发布后继续行动。`committed(headSeq)` 在世界就绪时报告一次，之后每次刷新时报告当前的 head，可能跳过几次提交，也可能重复。`debug()` 的内容并入状态的 debug。
- `world.candidate` 为真时是作为重新生成候选打开的，会往外发请求、写日志的实现应该跳过。玩家选中候选后这个实例继续运行，下次打开世界时才变成假。

`open` 失败时世界不打开。`context` 或 `decide` 抛错时这一轮失败，提示里有插件 ID，已提交内容保留。[JEV 审计](../../../packages/official-jev-audit/src/index.ts) 是一个完整的官方例子。

自动测试覆盖以上行为。`simple-llm` 经真实加载器在真实模型下跑过一次短局；`ctx.decisions` 还没有在真实模型下用第三方插件试过。

## 增加世界规则

例如你想让某个房间谁都进不去。[locked-room.mjs](../../../examples/host-plugins/locked-room.mjs) 是完整示例。插件向 `ctx.rules` 注册一层规则，可以注册多层，先注册的在最外面：

```js
export const hostApi = '2.0'

export default function (ctx) {
  ctx.effect(() =>
    ctx.rules.register({
      id: 'my-rules',
      version: '1.0.0',
      open: async world => ({
        resolve: (context, next) =>
          isForbidden(context.action)
            ? { status: 'rejected', events: [], reason: 'plugin:门锁着，进不去。' }
            : next(context),
        affordances: (context, next) => next(context),
      }),
    }),
  )
}
```

- `resolve` 裁定一次行动。调用 `next` 交给里面的规则，或者自己拒绝。玩家和角色的发言、移动和核心互动都经过它，活动进行时也一样。
- **状态操作（`/status`，包括一些包里的拿取和转交）、活动操作和短信不经过它**，它们有自己的规则，可选项也加在规则层外面。所以“禁止发短信”这样的规则现在写不出来。
- `affordances` 决定可选项，比如把上锁的房间从目的地里去掉。角色的回答格式也按它生成，所以角色通常根本选不到。
- `reason` 以 `plugin:` 开头时，后面的文字会原样读给玩家和角色听，否则只说“没有执行”。同场的人也可能读到，所以写中性的句子，不要写“你”。
- **拒绝角色的发言会被当作这一轮失败**，玩家看到错误提示，其余角色也可能失去机会。目前只建议拒绝移动和互动。
- 规则是同步的，不能在里面调用模型或网络，需要异步的用 `ctx.capabilities`。
- 规则要是确定的，同样的输入给出同样的答案，重新生成依赖这一点，宿主不检查。
- 通过时只能产出主干认识的事件，提交由宿主完成。一般直接返回 `next` 的结果就够了。

| 情况 | 结果 |
| --- | --- |
| `open` 失败 | 世界不打开，错误里有插件 ID |
| `resolve` 抛错 | 这次行动被拒绝，错误写到游戏进程的标准错误，世界不会卡住 |
| `affordances` 抛错 | 可选项不变，错误同样写到标准错误 |
| 换插件或升级插件版本 | 上一轮不能再重新生成，提示环境已改变 |

世界包的活动和状态规则仍在包脚本里，不能用插件整个替换，想做新玩法请写包内脚本。

## 自定义前端怎样使用

自定义模板在 `manifest.json` 的 `capabilities` 中添加 `bgm`。只有宿主确实安装 BGM 服务时，初始化结果才包含这个能力；未声明能力的模板不能经桥调用音乐接口。

在自己的播放器中，以当前阅读单元 `unit` 调用：

```js
const info = await Perspectra.ready
if (info.capabilities.includes('bgm')) {
  const { track } = await Perspectra.selectBgm(unit.seq, unit.segmentIndex, unit.text)
  if (track) {
    const { contentType, bytes } = await Perspectra.getBgmAudio(track.id)
    // bytes 是 ArrayBuffer。用已在玩家手势中解锁的 AudioContext 解码。
    // 自己处理循环、音量、同曲不重启、过期结果丢弃和退出停止。
  }
}
```

该片段假定模板已有阅读游标及播放器。默认舞台已经完成这部分，直接使用上面的插件即可。SDK 通过宿主 MessagePort 取回音频，不需要放宽沙箱网络、媒体或存储权限，也不接受任意本地文件路径。

宿主路由为 `POST /frontend-api/v1/bgm`（选曲）和 `POST /frontend-api/v1/bgm/audio`（按 `{ id }` 取音频），只有持有宿主令牌的同源桥可访问。不要从模板直接请求这些路由。注册曲库是插件明确发布的表现素材，获得 `bgm` 能力后可以读取其中任意曲目；曲名与音频不应夹带剧情秘密或凭证。

| 情况 | 结果 |
| --- | --- |
| 没装服务或曲目不存在 | 404 |
| 伪造段落、附加私有字段或传入文件路径参数 | 400；未注册 ID 返回 404 |
| 选曲期间候选替换导致段落失效 | 409，舞台丢弃旧结果 |
| 回调抛错、选到未注册曲目或服务已退出 | 502，只向前端提供公开错误 |

## 验证范围

源码已接通插件注册、授权选曲、音频传递和默认舞台播放。默认播放器循环播放、同曲不重启、0.6 秒淡入淡出、实时音量／静音，开关只在当前页面有效；初次用户手势前不会自行播放，也不在没有阅读内容时调用选曲。

自动化覆盖真实 Cordis 示例装载及 HTTP 音频返回、权限拒绝、候选失效、服务注销、阅读游标与新内容的分离、过期选择／解码丢弃、静音期间解码完成、循环与停止。测试见 [frontend-bgm](../../../tests/host/frontend-bgm.test.ts)、[bgm-playback](../../../tests/host/bgm-playback.test.ts)和[桥权限](../../../tests/host/stage-controls.test.ts)。复现命令：

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/host/frontend-bgm.test.ts tests/host/bgm-playback.test.ts tests/host/stage-controls.test.ts
node --import tsx tests/experiments/bgm-plugin-preview.ts
```

第二条命令启动固定测试对白，终端显示本地地址；不打开已有世界、存档或真实模型。`--no-bgm` 另起无插件预览，可检查开关置灰。Chromium 校验使用这个真实 HTTP 宿主和沙箱舞台，示例 WAV 成功完成解码和开始播放；验证日常曲切到紧张曲、规则返回静音、关闭／重新开启，以及 1280×820 浅色和 375×812 深色布局。截图保存在本地 `output/playwright/bgm-*.png`，不属于发行资产。这是合成测试素材，不代表正式配乐听感或真实模型体验。

本轮相关自动回归 10 个文件、71 项通过，包含真实游戏子进程装载 BGM 服务并读取注册音频。全量文档链接检查仍报告两份既有研究文档的 97 条旧源码断链（`misleading-code-audit-20261021.md` 88 条、`tavern-card-experience-migration-20261019.md` 9 条）；本轮修改页面没有断链，未为此改动历史研究正文。

未运行真实模型试玩、长时间内存测试或 Tauri WebView 验收，未重建便携发行包。Live2D、音效叠加、多插件混音、曲库流式加载和跨页面恢复播放位置暂不提供。
