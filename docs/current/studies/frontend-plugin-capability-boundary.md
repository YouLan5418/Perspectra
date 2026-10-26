# 前端表现插件的能力边界：立绘差分、BGM 与语音

2026-10-24 现状补充：本文主体保留 2026-10-15 的核查和当时限制。当前默认舞台已接语音播放器，并增加 Cordis BGM 的曲库注册、授权段落选曲与舞台播放；不再需要为了给默认舞台加音乐而替换整套页面。现行接口、示例和验证边界见[插件制作指南](../guides/host-plugin-authoring.md)。Live2D、通用前端插件注入仍未提供，本文其他历史缺口不因此视为已解决。

状态：2026-10-15 对照源码核查，已接通发言者 ID、宿主持久化的音频偏好、可选 TTS 宿主接口，并放宽资源额度。相关类型检查和自动化验证通过；未安装 TTS 合成器、缓存或默认播放器，没有真实模型音频体验或发行包验收。后续候选方案仍是分析，不表示已经交付。

## 已接通的最小表现数据（2026-10-15）

例如两个角色同名，其中一人从电话发言，模板可以用 `history[].speakerId` 区分音色；该 ID 来自玩家已经获准接收的观察，不增加完整角色名单。`speaker` 继续用于显示，可能带通信后缀；“游戏结果”等非角色行没有 `speakerId`。阅读游标在拆分 `segments` 时保留 ID，默认舞台按 ID 匹配已有现场成员，不因远程发言增添立绘。历史场景快照仍未接通。

Launcher 的“全局设置 → 声音偏好”保存 `{ volume, muted, voiceEnabled }`，音量为 0–100 整数，默认 `{ volume:80, muted:false, voiceEnabled:false }`。数据复用 `launcher.json` 的 `preferences.audio`，下次启动通过 `PERSPECTRA_AUDIO` 传给运行时，公共视图显式选取为 `settings.audio`。这属于本机全局偏好，不写世界数据库、角色记忆或故事节点，也不缓存语音。模板不能通过公共 SDK 写入设置。

模板沿用 `await Perspectra.getView()` 读取，例如 `const audio = view.settings?.audio; player.volume = (audio?.volume ?? 80) / 100; player.muted = audio?.muted ?? false;`，是否朗读取 `audio?.voiceEnabled ?? false`。自动播放解锁、实际播放器和阅读同步由模板处理；官方舞台目前不会播放音频。SDK 的通用快照和补丁合并已保留新增字段，无需增加独立同步通道。

相关自动化覆盖授权转录到逐段阅读的身份传递、同名和电话后缀、非角色结果行、公共投影白名单、设置补丁、Launcher 保存/重启读取、非法配置拒绝，以及恢复偏好后交给真实运行时投影。未调用真实模型，未验证 Tauri WebView 音频，未重建发行包。

第一批检查：根 TypeScript 类型检查、Lint、5 个相关测试文件共 50 项、Launcher Vue 类型检查和 17 项单元测试，以及文档链接检查通过。Chromium 清洗夹具验证同名角色只高亮对应 ID、远程电话发言不新增或误高亮立绘、SDK 可读取音频偏好；Launcher 浏览器预览验证设置保存后重新打开及非法音量拒绝，磁盘持久化由 LauncherCore 集成测试验证。界面截图在本机 `output/playwright/frontend-audio-settings-20261015.png` 和 `output/playwright/frontend-speaker-identity-20261015.png`，这些不证明实际音频播放可用。

## TTS 宿主扩展接口（2026-10-15）

例如玩家读到电话里的角色发言，社区模板可引用当前阅读单元申请音频；未来合成器只收到玩家已经获准阅读的文本与身份，不读取角色私有上下文。接口定义见 [speech.ts](../../../packages/frontend/src/speech.ts)，宿主注入点是 `createPlaytestServer(runtime, token, packWeb, policy, services)` 的第五个参数：

```ts
interface FrontendHostServices {
  synthesizeSpeech?: (input: FrontendSpeechInput, signal: AbortSignal) => Promise<FrontendSpeechAudio>
}
// input: { seq, segmentIndex, text, type, speakerId? }
// audio: { contentType: 'audio/mpeg' | 'audio/ogg' | 'audio/wav', bytes: Uint8Array }
```

这是可选回调，不是默认合成实现。2026-10-18 已增加 [Cordis 宿主插件装载](../host-plugins.md)：插件注册合成服务，Launcher 保存本地模块路径与加载开关，下次启动生效。适配器自己管理云端或本地服务、音色映射、凭证、费用限制与缓存；不改 `FrozenWorldPlaytestRuntime`、application / kernel、规则提交或记忆。当前只提供可信本地模块装载与语音服务注册，没有通用前端扩展或供应商配置界面。

模板的 manifest 声明 `speech` 后，还必须等宿主实际安装服务才会得到该能力；默认插件列表为空。沿用 `Perspectra.ready` 检查 `capabilities`。模板已有阅读游标 `playback`，并在玩家点击时解锁过 `audioContext` 后，可用：

```js
const unit = playback.current();
const info = await Perspectra.ready;
if (unit && info.capabilities.includes('speech')) {
  const result = await Perspectra.synthesizeSpeech(unit.seq, unit.segmentIndex, unit.text);
  const decoded = await audioContext.decodeAudioData(result.bytes);
  // decoded 是 AudioBuffer；模板决定是否仍在读这一段、何时播放和停止。
}
```

阅读游标现在保留原始 `segmentIndex`，无分段的旧式转录按第 0 段处理。模板传入的 `text` 只用于核对，宿主再次从当前公共玩家转录解析文本与 `speakerId`；伪造文本、未知段落和未授权请求会被拒绝。合成完成后重新检查段落，候选替换导致内容失效时返回 409。回调只收到选中段落，不收到完整玩家视图、Core 令牌、调试信息或凭证。

`POST /frontend-api/v1/speech` 沿用宿主令牌及来源校验，返回二进制音频；Host 桥经 MessagePort 返回 `{ contentType, bytes: ArrayBuffer }`。单次输出接受非空且不超过 32 MiB 的 WAV / MP3 / OGG，适配器异常只返回公开的失败提示。请求断开会向适配器发出 abort 信号，实际取消由适配器响应。没有 actionId、世界操作或事件；没有静态媒体路由、语音缓存或对 CSP 的放宽。模板可用 Web Audio 解码字节；直接把数据变成 blob URL 再交给 `<audio>` 仍受现有 `media-src` 限制。

模板应在按钮手势内解锁声音，不能等异步合成结束后才依赖该手势；跳过、回看、切换候选后的旧播放停止与异步结果丢弃仍由模板负责。该接口不保证自动播放，也没有内置阅读节奏或播放器。

本批验证：根类型检查、Lint、5 个前端相关测试文件共 36 项及文档链接检查通过。测试覆盖未安装时不授予能力、鉴权、字段与授权文本校验、二进制返回、回调失败不泄露内部错误，以及候选替换拒绝旧音频。Chromium 在 opaque origin、`connect-src 'none'` 且无 blob 媒体权限的沙箱中，通过 SDK → Host → 注入夹具返回一秒 WAV，Web Audio 解码成功；记录在本机 `output/playwright/frontend-speech-interface-20261015.json`。夹具只有固定 PCM 数据，不是 TTS，也未验证真实服务、音质、试听或跨 WebView 行为。

## 1. 先看一个具体情形

玩家在 Launcher 里启动一个实例，该世界包自带 `frontend/` 目录，因此界面是社区模板而不是官方默认舞台。角色发布“她别过脸去，把杯子放回桌上”，模板在玩家读到这段旁白时把立绘换成防备表情、把背景音乐从“夜晚”淡入“紧张”，同时朗读这句台词。

这三件事都不改变世界：立绘、音乐、语音都是**表现**，不进入事件日志、授权观察或记忆，也不写存档。它们能不能做到、卡在哪里，取决于三条通道：

| 通道 | 提供者 | 现状 |
| --- | --- | --- |
| 玩家已授权的转录 `PlayerView.history`（每行带 `segments`） | 宿主投影 | 已接通 |
| 包内静态素材 `/frontend/custom/**` | 世界包的 `frontend/` 目录 | 已接通，有额度 |
| 额外数据或合成能力：物品、世界时间、语音合成 | 玩家投影或宿主服务 | 物品/时间缺失；语音只有可选接口 |

社区模板的最小形态见[官方示例前端](../../../examples/world-packs/ai-girls-awaken-v10/frontend/app.js)：一个 `frontend/` 目录、`index.html`、`manifest.json` 和若干脚本，通过 SDK 与宿主通信。

## 2. 硬约束（读取自当前源码）

沙箱 iframe 的 CSP 见[前端素材服务](../../../desktop/host/frontend-server.ts)中的 `sandbox` 常量：

| 指令 | 沙箱值 | 对表现插件的影响 |
| --- | --- | --- |
| `media-src` | `<origin>/frontend/` | 包内 mp3/ogg/wav 可以播放 |
| `connect-src` | `'none'` | 不能 fetch、WebSocket、EventSource；配置必须内联或作为 `<script src>` |
| `script-src` | `<origin>/frontend/`，无 `'unsafe-eval'` | 只能用包内脚本；**WASM 编译受限**，常见 WASM 本地 TTS 方案受阻，不代表所有纯 JS 方案都不可能 |
| `worker-src` | `'none'` | 没有 Worker，worker 版推理一并不可用 |
| `img-src` | `<origin>/frontend/ data:` | 立绘可以加载 |

另外三处同样决定可行性：

- iframe 是 `<iframe sandbox="allow-scripts">`，**没有 `allow="autoplay"`**（[宿主页](../../../desktop/host/host-page.ts)）。沙箱 iframe 是不透明来源，自动播放被浏览器策略挡住，音频必须由玩家第一次点击解锁。
- 宿主外壳页的 CSP 没有 `media-src`（[网页服务](../../../desktop/host/http-server.ts)），所以**音频只能在 iframe 内播放**，不能在宿主页里做播放器。
- 包前端资源额度：最多 2048 个文件、单文件 64 MiB、合计 512 MiB，扩展名必须在白名单内（[包前端加载](../../../desktop/host/pack-frontend.ts)）。BGM、固定语音与立绘共用总量；当前仍整包读入内存并计算内容摘要。

受信任模式（[前端授权](../frontend-authorization.md)）放宽网络、存储、`unsafe-eval`，但仍是 `worker-src 'none'`、`frame-src 'none'`，并且要求玩家逐实例确认。

## 3. 三项需求的判定

| 需求 | 结论 | 依据 |
| --- | --- | --- |
| 立绘姿势、表情差分 | 插件内可以完成 | `history[].segments` 带 `type` 与文本；`scene.recipients` 给出在场角色的 id 与名称 |
| BGM、音效 | 插件内可以完成 | `media-src` 放行包内音频，`api.resource()` 可取路径 |
| 固定台词配音（序章、固定选项、活动提示） | 插件内可以完成 | 素材进包即可 |
| 系统语音朗读 `speechSynthesis` | 候选能力，沙箱下未实测 | 音色、可用性与用户手势要求取决于浏览器和系统，不能先保证离线 |
| 模型即兴文本的外部 TTS | **已留宿主接口，默认未安装实现** | 未来注入合成回调；保持当前沙箱和凭证边界，不改世界规则内核 |
| 浏览器直连云 TTS | 不建议 | 需要把 API key 放进前端或包内，与现有凭证边界冲突 |

可复用的两个已有做法：

- 官方的[阅读游标](../../../packages/frontend/src/reading-playback.ts)只有约四十行，就是为内嵌到模板脚本设计的，插件可以直接使用同一套语义。
- 玩家视图的公共字段见[玩家投影](../../../packages/frontend/src/player-view.ts)。插件只能看到这里列出的内容，看不到私有变量、记忆、完整角色名单或调试信息。

## 4. 问题清单

每条按“现象 / 影响 / 根因 / 候选做法 / 代价”记录。源码缺口已核查，未全部构成玩法缺陷；资源上限何时首先触发、浏览器实际音频行为仍需实测。第一批已解决的部分在对应条目中注明。

### P1-1 转录行没有逐段场景快照

- **现象**：`history` 每行提供 `seq / speaker / speakerId? / text / player / segments?`（[宿主状态类型](../../../desktop/host/http-server.ts)）。没有“这条发表发生时谁在场”，也没有当时的活动公开状态。
- **影响**：发言者 ID 已解决同名和通信后缀的身份匹配；中途入场、离场的精确演出仍缺少对应阅读时点的数据。
- **根因**：公共 SSE 是最终视图补丁，场景成员只在读完或跳过时更新，见[默认情景舞台](../frontend-stage.md)的“有意识接受的缺口”。
- **候选做法**：确认入场、离场演出需求后，以玩家已授权的观察序号提供最小场景变化；活动历史状态按玩法需要再接，不默认给每段复制完整快照。
- **代价**：需要后端扩展并验证历史可见范围，不能用当前全量世界状态回填历史。

### P1-2 玩家偏好已由宿主持久化，语音缓存延期

- **现象**：沙箱 iframe 没有同源存储；音量、静音、语音开关已由 Launcher 保存，并经 `settings.audio` 提供给模板（[玩家投影](../../../packages/frontend/src/player-view.ts)）。
- **影响**：采用该字段的模板可在重新启动后恢复声音偏好；模板自行维护的临时值仍会重置。当前没有动态 TTS，所以未新增语音缓存。
- **根因**：沙箱不授予同源存储；受信任模式才提供 browser-storage。
- **当前做法**：复用现有 preferences 保存与 playerSettings 投影；SDK 和宿主已有 settings 补丁通道，不新增写入 API。语音缓存留到 TTS 接入时处理。
- **限制**：设置在 Launcher 修改，下次启动游戏生效；没有模板内实时修改宿主偏好的接口。

### P2-1 外部 TTS 已预留宿主接口，合成实现延期

- **现象**：沙箱禁止网络，而凭证不得进入前端或世界包。
- **当前做法**：已预留 `FrontendHostServices.synthesizeSpeech`，模板引用已授权段落；宿主把回调音频作为字节交给沙箱，不开放网络或静态媒体目录，详见上方接口说明。
- **已延期**：实际合成适配器、音色配置、缓存和默认播放器均未实现，默认不授予能力。后续安装宿主回调和模板播放逻辑即可，不改世界规则 core。

### P2-2 没有自动播放权限

- **现象**：iframe 没有 `allow="autoplay"`。
- **影响**：能否无操作播放取决于 iframe 权限和浏览器自身策略，当前没有跨浏览器实测。即使增加权限，也不能承诺无操作播放；优先用模板内“开启声音”点击解锁并处理失败。
- **候选做法**：接受现状；或在宿主页为 iframe 增加该权限并评估其含义。
- **代价**：加权限等于放宽一条浏览器策略，需要单独判断，不应顺手加上。

### P2-3 模板只能随包分发，授权绑定内容摘要

- **现象**：实例前端只从该世界包目录加载（[Launcher Core](../../../desktop/launcher-core.ts)）；没有全局模板安装入口，早期记录也把模板安装管理列为未实施（[前端 V1](../frontend-v1.md)）。受信任授权校验整个前端目录的内容摘要。
- **影响**：给别人的游戏加语音或差分，需要改动那个世界包目录；受信任模式下**改动任一前端文件都会让已授权实例退回沙箱，玩家需要重新确认**。对持续迭代的插件，这是最痛的一条。
- **候选做法**：短期接受；若确有多游戏复用需求，再讨论模板目录与授权粒度的关系。
- **代价**：涉及授权语义，不宜在需求明确前设计。

### P3-1 资源额度已放宽

- **原问题**：旧额度 100 文件、单文件 8 MiB、合计 16 MiB，数张 2–3 MiB 立绘就能耗尽总量。
- **当前做法**：调整为 2048 文件、单文件 64 MiB、合计 512 MiB；文件类型、符号链接隔离与内容摘要授权规则保持原样。报错直接说明三项额度。
- **验证**：真实加载 129 文件、约 21 MiB 的前端包；测试拒绝超过 64 MiB 的单文件和超过 2048 文件的目录。
- **接受的限制**：继续整包读入内存，不新增懒加载或流式素材服务；没有在本轮验证满额 512 MiB 包的启动延迟与内存峰值。

### P3-2 官方舞台既不读包内美术，也不受插件影响

- **现象**：官方默认舞台是内核内建页面，立绘只尝试内建的 `/frontend/assets/gpt-6.png`，包内美术位于 `/frontend/custom/**`，没有接给默认页（[默认舞台](../../../packages/frontend/src/default-template.ts)、[素材服务](../../../desktop/host/frontend-server.ts)）。
- **影响**：玩家不切到作者提供的模板，就看不到任何差分、音乐或语音；作者想让“官方舞台也有差分”，必须改内核。
- **候选做法**：把差分与音频做成插件形态先验证；确认要通用后再考虑官方舞台的内置通道。
- **代价**：官方舞台的内置通道会动到阅读游标与默认模板两个内核文件。

### P3-3 物品、背包与世界时间没有进入玩家视图

- **现象**：PlayerView 不含物品、背包或世界时间；[默认情景舞台](../frontend-stage.md)已把这批数据列为未接通。
- **影响**：Galgame 与 SLG 常见的物品栏、时钟、状态面板，插件无法自行实现。
- **候选做法**：按真实玩法需要逐项投影，不一次性开放整个运行时状态。
- **代价**：每项都要定义公开范围，避免把私有信息带进公共视图。

## 5. 三条不能破的边界

1. **表现不是事实**：立绘、音乐、语音都不进入事件、观察或记忆，不写存档，也不得反过来影响裁定。它们可以由已提交内容随时重建，允许失败和丢弃。
2. **表现跟“读到哪儿”，不跟“世界到哪儿”**：差分、音乐切换与朗读都应挂在阅读游标上。否则读速落后时，后台已提交的后续表情会提前跳变，等于剧透。官方舞台的自动阅读目前按字数估时（[默认模板](../../../packages/frontend/src/default-template.ts)），有语音后应以音频结束为准，字数只做兜底。
3. **不引入语义分类器，也不做指代消解**：表现归属取“这段旁白属于哪次发表”，匹配交给作者声明的规则。角色 A 的旁白里可能正在描述别人，这一点靠作者把规则写成自指来缓解，不能靠新增模型调用解决。

## 6. 不建议的路径

- 把差分或情绪写成独立的结构化世界事实、闭合枚举或表现码。这会迫使全部叙事转成枚举，与[项目根约束](../../../AGENTS.md)中“不得为防止少量越权表现而把全部叙事文本强制转换”相冲突。
- 为浏览器直连 TTS 把 API key 放进前端或世界包。受信任模式只放开浏览器网络权限，不改变凭证归属。
- 为了让插件更容易做而一次性开放完整运行时状态。公共投影应当按需要逐项扩展。

## 7. 推进顺序建议

1. **先做不需要内核的部分**：立绘差分、BGM、预烘焙与系统语音，用来验证真正的问题——“语音长度与自动阅读节奏合不合拍”。
2. **再判断是否需要内核侧 TTS**：只有在真实试玩确认节奏可用、且系统语音质量确实不可接受时，才值得增加适配器、缓存与路由。
3. **基础数据先于 TTS**：发言者 ID 与宿主音频偏好已接通；逐段场景数据按真实演出需要再补，不默认扩大到完整历史快照。

## 8. 未核对与未验证

- `speechSynthesis` 在不透明来源沙箱 iframe 中的实际可用性、音色列表与用户手势要求，未实测。
- Tauri WebView 与 Chromium 的自动播放与音频策略差异，未核对。
- 新额度下满额 512 MiB 世界包的启动延迟与内存峰值尚未实测；自动化只验证约 21 MiB 的可加载包及部分上限拒绝。
- Web Audio 在该沙箱下的 `AudioContext` 解锁与恢复行为，未核对。
- 第一批基础字段已运行相关自动化；音频播放、阅读节奏与真实模型体验仍未验收。

## 源码导航迁移（2026-10-21）

本次只更新源码导航，未重新验证上文历史结论。迁移前快照为提交 `717ed6c1a662e5e55e534c7cf7e2651d405b46f1`；原路径与当前实现的对应关系如下。

| 迁移前路径（上述提交） | 当前源码 |
| --- | --- |
| `tests/experiments/playtest-frontend-assets.ts` | [frontend-server.ts](../../../desktop/host/frontend-server.ts) |
| `tests/experiments/playtest-host-page.ts` | [host-page.ts](../../../desktop/host/host-page.ts) |
| `tests/experiments/playtest-server.ts` | [http-server.ts](../../../desktop/host/http-server.ts) |
| `tests/experiments/playtest-pack-web.ts` | [pack-frontend.ts](../../../desktop/host/pack-frontend.ts) |
