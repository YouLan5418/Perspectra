# 通过 Cordis 加载宿主插件

核对日期：2026-10-18。源码已接通；未重建便携发行包，未验收真实合成器或实际音频体验。

例如玩家读到角色的一句对白，支持语音的前端引用这段对白申请音频。宿主先核对玩家是否有权阅读、内容是否仍有效，再把该段文本交给 Cordis 插件注册的合成服务。语音失败可以继续无声阅读，不改变角色决策、记忆或世界事实。

## 在启动器启用

1. 打开全局设置的“插件”，点击“添加本地插件”。
2. 填写不重复的插件 ID，例如 `tts`，以及本地 `.mjs` / `.js` 文件的绝对路径。
3. 勾选“启动游戏时加载此插件”，点击“应用”或“保存”，下次启动游戏生效。

插件选择保存在数据根目录的 `launcher.json` 的 `preferences.hostPlugins`，不进入世界包、存档或故事分享。默认列表为空，新添加的条目默认停用；停用条目不会被导入。移除条目只移除设置，不删除插件文件。最多配置 16 项。

“阅读与声音”里的“启用语音朗读”是播放偏好，与插件加载开关独立。加载合成器不代表前端已有播放器；官方默认舞台目前仍未接入语音播放。自定义模板继续使用 [Perspectra.synthesizeSpeech](../../packages/frontend/src/client.ts) 及既有阅读游标。

**只加载可信本地代码。** 插件与游戏宿主拥有相同的文件、网络和进程权限。独立的 Cordis Context 只隔离服务注册，不是安全沙箱；用户的启用选择不是游戏包自动授权。界面不接收插件凭证，插件自行从环境或自己的安全配置读取，不能把凭证放进世界包、前端或上述设置。

## 编写语音插件

装载器接受默认导出的 Cordis 函数、类或带 `apply` 的对象。推荐使用 `.mjs`；`.js` 的 ESM 解析沿用文件所在目录的 Node 包配置。首版不安装依赖、不接收远程模块地址、不提供热更新或任意 JSON 插件配置。

当前有一个实际消费点：`ctx.frontendServices.registerSpeech(synthesize)`，返回注销函数。插件通过 `ctx.effect()` 持有它，在 Cordis 释放插件时注销服务。参数和音频返回值沿用 [FrontendSpeechInput / FrontendSpeechAudio](../../packages/frontend/src/speech.ts)，不新增一套语音协议：

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
- [游戏入口](../../tests/experiments/playtest-web-entry.ts)在创建世界运行时之前调用 [loadHostPlugins](../../desktop/host-plugins.ts)。装载器创建独立 Context，注册 `frontendServices`，再按列表顺序 `ctx.plugin()`；没有挂载世界内核、存储、记忆或角色服务。
- 同时只允许一个合成服务。启用模块不存在、导出不合法、初始化失败或重复注册会使本次启动明确失败，并释放此前装载的插件；用户可停用该条目后重试。宿主返回插件 ID 与公开错误，不把模块异常正文交给前端。
- 服务通过已有 `FrontendHostServices` 交给 [HTTP 宿主](../../tests/experiments/playtest-server.ts)。模板声明的能力与实际安装服务共同决定是否授予 `speech`；合成前校验授权文本，合成后重验段落，候选替换后返回 409。未安装服务返回 404，合成失败返回 502。
- 前端请求断开或服务注销会触发 abort。插件应把信号传给实际请求；即使插件忽略取消，注销后晚到的音频也会被拒绝。关闭游戏时释放插件及其 `ctx.effect()`，不为未完成音频增加恢复机制。

## Live2D 与 BGM 的范围

同一装载入口可以加载其他可信 Cordis 插件，但当前只有语音合成的宿主消费点。Live2D 渲染、BGM 播放、前端脚本与素材注册、口型同步仍未接通，不会因为加载模块就自动出现在舞台。

后续增加这些表现时，复用装载和启停设置，按实际需要增加前端接线；播放与动画应跟随玩家阅读进度，不能直接追随后台最新发表，也不能把表现当作世界状态变化。当前不引入通用前端插件框架或新的世界事件。

## 验证范围

自动化覆盖设置保存与恢复、非法配置拒绝、下次启动传递、停用不导入、真实模块装载、重复服务拒绝、失败清理、取消与晚到结果拒绝、HTTP 示例转接和原有授权边界；真实游戏入口的进程测试覆盖加载后授予能力及退出清理。

本机还将游戏入口打包为 ESM，随附现有前端静态资源后，验证构建产物可装载外部 `.mjs` 插件、授予语音能力并在退出时清理；过程中未调用角色模型。该检查不代表完成 Tauri 或便携发行包构建。

没有调用真实语音供应商或角色模型，没有验收浏览器 / Tauri 的音频播放、朗读节奏、Live2D 或 BGM，也没有重建发行包。相关实现测试见 [host-plugins](../../tests/prototype/host-plugins.test.ts)、[frontend-speech](../../tests/prototype/frontend-speech.test.ts)、[desktop-launch](../../tests/prototype/desktop-launch.test.ts) 与 [launcher-core](../../tests/prototype/launcher-core.test.ts)。
