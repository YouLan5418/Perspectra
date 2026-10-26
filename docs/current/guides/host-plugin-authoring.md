# 编写并加载自己的 Cordis 宿主插件

2026-10-26：例如同伴操作外部设备，包内模块负责玩法规则，Cordis 插件通过 `ctx.capabilities.register` 提供异步原生能力。按世界创建会话、角色请求、完成后裁定及失败限制见[双入口指南](dual-plugin-entrypoints.md)。原生完整例子是 [demo-device.mjs](../../../examples/host-plugins/demo-device.mjs)，外部程序方向见 [RPG Maker](../../../examples/rpg-maker/README.md)。下方声音指南仍沿用原验收范围。

2026-10-26 玩法补充：宿主插件不负责生成包的玩法规则。可复用的规则以作者工具形式分发，例如 [RPG Core 生成器](../../../examples/rpg-core/generate.mjs) 在创作时输出普通活动脚本，随包发布；同日删除的 `ctx.gameplay.registerActivity` 不再可用。说明见[示例包](../../../examples/world-packs/rpg-core-demo/README.md)与[实验记录](../studies/2026-10-26_cordis-rpg-core-prototype.md)。

例如同行者读到“门外的争执让气氛变得紧张”，创作者希望日常曲淡出、紧张曲响起。创作者编写曲库和选曲规则；默认舞台提供播放器，玩家读到那一段才触发选择。音乐不会写入世界事件、存档或角色记忆。

核对日期：2026-10-24。适用于当前源码；本轮未重建便携发行包。插件是可信本地 Node 代码，与宿主拥有相同权限，须由玩家在启动器明确启用。Cordis 管理装载与退出，不提供安全沙箱或自动 npm 安装。

## 先运行一个不需要音频文件的示例

1. 在启动器“全局设置 → 插件”添加本地插件，ID 填 `demo-bgm`，文件选择 [demo-bgm.mjs](../../../examples/host-plugins/demo-bgm.mjs)的绝对路径。
2. 勾选加载，保存设置，下次启动游戏生效。
3. 在默认舞台内点击一次，解锁浏览器声音。“设置 → 声音”中可关闭背景音乐、调整音量或静音。

示例在内存生成两段很轻的测试和弦，不是正式配乐。当前段落含“争执”“危险”或“紧张”时选紧张曲，含“停止音乐”时返回静音，其他段落选日常曲。这只是可替换的示例规则，运行时没有新增文本分类器或模型调用。

插件文件可以独立分发给玩家，不要求放进世界包；选择保存在本机 Launcher 设置，不随故事分享。示例本身只依赖 Node 和宿主给出的 `ctx`，不需要创作者安装 Cordis。若自己的插件依赖第三方 npm 包，需要自行备好依赖，宿主不会安装。

## 换成自己的音乐和规则

创建一个目录，放入 `my-bgm.mjs`、`calm.ogg` 和 `tense.ogg`。在 `my-bgm.mjs` 写：

```js
import { readFile } from 'node:fs/promises'

// 必须声明：本插件需要的最低宿主 API 版本。
export const hostApi = '1.0'

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

插件函数的第二个参数就是玩家填写的值，已补上默认值：把上例的 `input.text.includes('争执')` 换成 `input.text.includes(config.tenseWord)`，函数签名写成 `myBgm(ctx, config)`。需要保存 API Key 之类的值时，给字段加 `"secret": true`，它会存进 Windows 凭据管理器而不是设置文件。字段格式和保存位置见[宿主插件](../host-plugins.md)。

将整个目录交给玩家，在 Launcher 添加 `my-bgm.mjs`，即可使用官方播放器。不要同时启用这个插件和示例 BGM；当前只允许一个插件决定配乐，但可以同时加载 TTS。

音频格式用正确的 `contentType`：MP3 为 `audio/mpeg`，OGG 为 `audio/ogg`，WAV 为 `audio/wav`。宿主检查字节与大小，不检测实际编码，文件能否解码还取决于浏览器；加载损坏音频时舞台提示失败，阅读照常继续。

## 宿主提供哪些接口

2026-10-26 宿主 API 版本：例如你按当前宿主写好插件分享给别人，对方的 Perspectra 较旧、还没有 `ctx.playerFeed`。插件导出 `export const hostApi = '1.0'` 后，宿主在调用插件之前比较版本，不兼容就跳过并在启动器标出“宿主 API 版本不兼容或未声明”，而不是运行到一半报错。规则：主版本必须相同，宿主次版本不低于插件声明的次版本；当前宿主 API 为 `1.0`。没有导出 `hostApi` 的插件同样被跳过。所有接口类型集中在 [@harness-world/plugin-sdk](../../../packages/plugin-sdk/src/index.ts)：`HostServices` 列出插件能用的三个服务，`CapabilityProvider`、`PlayerFeedEvent` 等是参数与事件的形状；宿主的实现直接引用这些类型，接口改动会先在类型检查中暴露。该包目前只在本仓库内，尚未发布到 npm，也不随便携发行包附带；仓库外开发时可参照源码或复制其中的类型。

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
