# 通过 Cordis 加载宿主插件

2026-10-26 插件故障：例如玩家同时启用了语音插件和设备插件，语音插件文件损坏。游戏照常启动，启动器提示“tts（导入失败）已跳过”，设置页在该插件下标出原因；只有当世界包把设备能力声明为必需而设备插件也坏了时，世界才不打开，启动器会写明缺少哪个能力。做法参考 DSH 的可选插件策略，见下方“装载、授权与退出”。

2026-10-26 双入口：例如澄请求设备确认，包内模块定义操作、私有次数和完成规则，可信 Cordis 插件提供异步设备能力。新增 `plugins.json`／`plugins/*.js` 与 `ctx.capabilities.register`，沿用原有状态和交互提交。会话可以请求绑定 NPC 的原有角色回合，不传出私有 Context。[开发指南](guides/dual-plugin-entrypoints.md)说明声明、能力目录、角色绑定、完成／排队和取消语义；源码及打包后端入口已自动验证，真实模型与发行包未验收。

RPG Maker [双端连接骨架](../../examples/rpg-maker/README.md)已注册 `rpg-maker@0.1.0`，按包配置把宿主调用者绑定到队员；MZ 可请求已绑定 NPC 处理，观察结果可由包内规则提交为本人已知状态。当前没有实际 MZ 工程、AI 战斗输入或配对存档；通信与接口替身测试不能证明实际 RPG Maker 玩法已集成。

2026-10-26 玩法实验：例如玩家与澄对抗两只规则怪物。最初由 Cordis 插件通过 `ctx.gameplay.registerActivity` 在开局生成活动脚本；同日已删除该服务，RPG Core 改为作者端生成器，生成的脚本随包发布，宿主不再为玩法规则加载插件。原因与现状见[实验记录](studies/2026-10-26_cordis-rpg-core-prototype.md)和[示例包](../../examples/world-packs/rpg-core-demo/README.md)。下方 TTS / BGM 的日期和验收仍保留各自原范围。

核对日期：2026-10-24。源码已接通 Cordis 本地装载、TTS 与 BGM 服务；默认舞台已有两个播放器。本轮不重建便携发行包，不代表真实合成器、正式配乐或听感已经验收。

例如玩家读到角色的一句对白，支持语音的前端引用这段对白申请音频。宿主先核对玩家是否有权阅读、内容是否仍有效，再把该段文本交给 Cordis 插件注册的合成服务。语音失败可以继续无声阅读，不改变角色决策、记忆或世界事实。

例如玩家还停在平静对白时，即使后台已经发布争执，BGM 仍播放日常曲；等玩家读到争执段落，插件才选紧张曲，舞台淡出旧曲并循环播放新曲。可直接加载 [demo-bgm.mjs](../../examples/host-plugins/demo-bgm.mjs)试用；替换成自己的配乐与规则见[创作者插件制作指南](guides/host-plugin-authoring.md)。

## 在启动器启用

1. 打开全局设置的“插件”，点击“添加本地插件”。
2. 填写不重复的插件 ID，例如 `tts`，以及本地 `.mjs` / `.js` 文件的绝对路径。
3. 勾选“启动游戏时加载此插件”，点击“应用”或“保存”，下次启动游戏生效。

插件选择保存在数据根目录的 `launcher.json` 的 `preferences.hostPlugins`，不进入世界包、存档或故事分享。默认列表为空，新添加的条目默认停用；停用条目不会被导入。移除条目只移除设置，不删除插件文件。最多配置 16 项。

“阅读与声音”里的“启用语音朗读”是播放偏好，与插件加载开关独立。官方默认舞台已通过 Web Audio 播放授权对白；BGM 插件安装后，首次在舞台内点击解锁音频，按阅读进度播放。舞台的背景音乐开关只在当前页面有效，音量与静音沿用现有偏好。自定义模板使用 [Perspectra SDK](../../packages/frontend/src/client.ts)及既有阅读游标自行控制播放。

**只加载可信本地代码。** 插件与游戏宿主拥有相同的文件、网络和进程权限。独立的 Cordis Context 只隔离服务注册，不是安全沙箱；用户的启用选择不是游戏包自动授权。界面不接收插件凭证，插件自行从环境或自己的安全配置读取，不能把凭证放进世界包、前端或上述设置。

## 编写语音插件

装载器接受默认导出的 Cordis 函数、类或带 `apply` 的对象。推荐使用 `.mjs`；`.js` 的 ESM 解析沿用文件所在目录的 Node 包配置。首版不安装依赖、不接收远程模块地址、不提供热更新或任意 JSON 插件配置。

语音消费点是 `ctx.frontendServices.registerSpeech(synthesize)`，返回注销函数。插件通过 `ctx.effect()` 持有它，在 Cordis 释放插件时注销服务。参数和音频返回值沿用 [FrontendSpeechInput / FrontendSpeechAudio](../../packages/frontend/src/speech.ts)，不新增一套语音协议：

```js
export default function speechPlugin(ctx) {
  const endpoint = new URL(process.env.PERSPECTRA_TTS_ENDPOINT);
  ctx.effect(() => ctx.frontendServices.registerSpeech(async (input, signal) => {
    const response = await fetch(endpoint, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error('TTS service failed');
    return { contentType: 'audio/wav', bytes: new Uint8Array(await response.arrayBuffer()) };
  }));
}
```

此例要求目标服务接收原样的授权段落 JSON 并返回 WAV。项目附带更完整的可选 [HTTP 语音插件](../../examples/host-plugins/http-speech.mjs)，支持 WAV / MP3 / OGG，并可读取 `PERSPECTRA_TTS_API_KEY` 作为 Bearer 凭证。它只是 HTTP 转接器，不附带合成模型，也不宣称兼容任意厂商的请求格式；供应商请求不同就替换插件内部的转换逻辑。

使用附带插件时，在启动 Launcher 的环境中设置 `PERSPECTRA_TTS_ENDPOINT` 为实际语音服务地址，必要时设置上述 Key，再把 `examples/host-plugins/http-speech.mjs` 的绝对路径添加到启动器。不在 Launcher 设置中保存这些环境值。HTTP 请求体是：

```json
{"seq":7,"segmentIndex":1,"text":"你好。","type":"speech","speakerId":"character:remote"}
```

`speakerId` 可缺省；`type` 沿用表达段落类型，可能是对白或叙述。插件决定旁白音色及角色音色。返回 HTTP 成功状态、`Content-Type: audio/wav`、`audio/mpeg` 或 `audio/ogg`，正文为音频字节。

## 装载、授权与退出

- [LauncherCore](../../desktop/launcher-core.ts)只保存和传递插件选择，不在启动器后端导入插件。每次启动用 `PERSPECTRA_HOST_PLUGINS` 覆盖传入当前保存的列表。
- [游戏入口](../../desktop/host/web-entry.ts)在创建世界运行时之前调用 [loadHostPlugins](../../desktop/host-plugins.ts)。装载器创建独立 Context，注册 `frontendServices` 和按世界绑定的 `capabilities`，再按列表顺序 `ctx.plugin()`。只提供有限角色请求回调，没有挂载世界内核、存储、记忆或原始 Context。
- 同时只允许一个合成服务与一个 BGM 服务，两者可以由同一个或不同插件注册。启用模块不存在或导出不合法（`import`）、初始化抛错或重复注册（`apply`）时，只跳过这一个插件：Cordis 撤销它已经用 `ctx.effect` 注册的服务，其他插件照常运行。详细错误带插件 ID 写入游戏进程的标准错误输出；`ready` 与 `startup-error` 消息只带 `{ id, reason }`，启动器据此在主界面和设置页提示，不显示模块异常正文。插件设置本身不合法（ID、路径格式）仍使整次启动失败。世界能否打开由包声明的必需能力决定：缺少时宿主抛出 `MissingCapabilityError`，启动器提示“世界包需要宿主能力 X”。被跳过的语音或 BGM 插件不阻止任何世界，只是没有对应服务。已知限制：Launcher 不保存游戏进程输出，玩家在界面上只看到插件 ID 与原因；插件作者需从命令行启动游戏查看详细错误。
- 服务通过已有 `FrontendHostServices` 交给 [HTTP 宿主](../../desktop/host/http-server.ts)。模板声明的能力与实际安装服务共同决定是否授予 `speech`；合成前校验授权文本，合成后重验段落，候选替换后返回 409。未安装服务返回 404，合成失败返回 502。
- 前端请求断开或服务注销会触发 abort。插件应把信号传给实际请求；即使插件忽略取消，注销后晚到的音频也会被拒绝。关闭游戏时释放插件及其 `ctx.effect()`，不为未完成音频增加恢复机制。

## BGM 与其他扩展的范围

BGM 消费点是 `ctx.frontendServices.registerBgm({ tracks, selectTrack })`。曲库在注册时复制并校验，只提供明确发布的 WAV / MP3 / OGG 字节；选曲回调只收到与语音相同的授权阅读段落。当前最多 16 首、每首 32 MiB，全部驻留内存，不提供流媒体。`selectTrack` 返回注册曲目 ID，或 `null` 表示静音；应按输入独立决定，不依赖请求次数或顺序。

社区模板须声明 `bgm` 且宿主实际装有服务，才获得 `Perspectra.selectBgm(seq, segmentIndex, text)` 与 `Perspectra.getBgmAudio(id)`。前者走授权检查和候选替换重验，后者只读取插件已发布曲库，不接受文件路径，也不提供角色私有信息。默认舞台同曲不重启、循环播放、0.6 秒淡入淡出、音量及静音实时生效；过期异步结果被丢弃，页面退出时停止播放。

同一装载入口可以加载其他可信 Cordis 插件，但 Live2D 渲染、任意前端脚本注入、通用插件设置面板与口型同步仍未接通。Cordis 负责生命周期与服务依赖；创作者能扩展的功能还取决于 Perspectra 已开放的消费接口。现有独立宿主 Context 没有提供世界内核、记忆、`ctx.tools` 或 `ctx.llm`，其他宿主的插件不能直接假定这些服务存在。当前不引入通用前端插件框架或新的世界事件。

## 验证范围

自动化覆盖设置保存与恢复、非法配置拒绝、下次启动传递、停用不导入、真实模块装载、重复服务拒绝、失败清理、取消与晚到结果拒绝、HTTP 示例转接和原有授权边界；真实游戏入口的进程测试覆盖加载后授予能力及退出清理。

本机还将游戏入口打包为 ESM，随附现有前端静态资源后，验证构建产物可装载外部 `.mjs` 插件、授予语音能力并在退出时清理；过程中未调用角色模型。该检查不代表完成 Tauri 或便携发行包构建。

以上装载与 TTS 构建检查是 2026-10-18 的历史验证。本轮 BGM 自动化见 [frontend-bgm](../../tests/host/frontend-bgm.test.ts)、[bgm-playback](../../tests/host/bgm-playback.test.ts)和[舞台桥权限](../../tests/host/stage-controls.test.ts)，覆盖真实 Cordis 示例装载、HTTP 字节返回、授权拒绝、候选失效、插件清理、阅读游标同步、同曲不重启、淡出、静音竞态与过期结果丢弃。复现界面使用[无模型预览](../../tests/experiments/bgm-plugin-preview.ts)，不读取已有存档。

未调用真实语音供应商或角色模型，未验收正式配乐听感、长时间内存表现、Tauri WebView、Live2D 或便携发行包。浏览器结果与运行命令见[制作指南的验证范围](guides/host-plugin-authoring.md#验证范围)。
