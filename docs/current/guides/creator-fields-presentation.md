# 创作者字段：画面、声音与角色请求预设

例如，作者想让 Claude 在图书馆里以立绘出现，并用轻小说笔触回应：把立绘和背景放到 `frontend/` 的约定位置，需要表情时再写 `stage.json`；把文风提示放到包根目录的 `model-preset.json`。这些入口解决不同问题：前者控制玩家看见的画面，后者影响角色请求，角色的性格和知识仍由人物与世界内容提供。

本页按当前 `main` 源码整理，标明作者可填写的字段和条件；它不表示真实模型、音画听感或发行包已经验收。角色卡、地点和玩法字段另见对应字段清单。表中的“必填”指所在文件或对象存在时必须填写，不表示该可选文件必须存在。除另行说明外，JSON 字段区分大小写。

## 入口与文件归属

| 入口 | 是否需要 | 用途和读取方式 |
| --- | --- | --- |
| `worldpack.source.json` 的 `presentationFiles` | **必填**：数组且恰好列出一个文件 | 编译器读取并保存该文件的语言和样式；通常叫 `presentation.json`。 |
| `worldpack.source.json` 的 `assetFiles` | **必填数组**，可以为空 | 显式列出的包内资源进入编译锁；玩法脚本和插件配置引用时须列入。它不是默认舞台美术的目录清单。 |
| 包根 `cover.webp`、`cover.png`、`cover.jpg`、`cover.jpeg` | 选填 | Launcher 游戏封面。按上述顺序读取第一个存在的文件，最多 4 MiB；超限或读取错误时不显示，不继续尝试后续文件。 |
| `frontend/` | 选填 | 默认舞台的样式、美术与设置，或自定义网页。缺省使用官方舞台；目录存在但不符合受支持的目录模式时加载失败。 |
| 包根 `model-preset.json` | 选填 | Launcher 和网页宿主读取的包推荐角色请求预设。缺省为 `{}`。 |
| 包根 `role-presets.json` | 选填 | Launcher 提供给实例的一组角色专属与角色组预设；不静默分配。 |

`frontend/`、封面和两个随包预设按约定单独读取，**不必**列入 `assetFiles`；通常不属于编译产物或世界包 Hash。作者若主动将其中的文件列入 `assetFiles`，编译器仍会按所列文件锁定它。`frontend/` 的文件另有自己的内容摘要，供前端授权使用。来源：[源包清单解析](../../../packages/world-pack/src/schema.ts)、[编译器](../../../packages/world-pack/src/compiler.ts)、[Launcher 封面与加载](../../../apps/launcher/backend/core.ts)、[前端加载器](../../../apps/host/src/runtime/pack-frontend.ts)、[预设读取](../../../apps/host/src/model-presets.ts)。

[整包创作工作台](world-workbench.md)可编辑下文两种随包预设并枚举包内角色。外部 Agent 可通过 `editor preset-validate` 同时校验字段和角色引用，通过 `editor preset-play` 核对分配前后的实际角色请求。

### 从工作台和外部 Agent 修改舞台

舞台美术可以直接从[工作台](world-workbench.md#给角色配立绘和初始表情)导入。Agent 用 `worldpack editor stage <pack>` 读取舞台与素材，或附加请求 `{"kind":"components"}` 读取布局。用 `stage-candidates` 提交 `path` 和当前草稿 `config`，例如 `["characters","character:companion","expressions","blink","cell"]` 枚举所选拼合图的格子。格子编号以整数保存。用 `stage-save` 提交 `kind`、读取时的原值 `base` 和完整新 `config`。

用 `stage-art-import` 提交 `kind`（`portrait`、`background`、`cover`、`layer`）与文件的 `base64`。底图或背景另传角色或地点 `id`，图层另传相对 `portraits/` 的 `name`。替换前用 `stage-art-preview` 传原文件 `path` 读取预览和 `base`，回传它可防止覆盖别人的改图。

### `presentation.json`

| 字段 | 必填性 | 约束 / 缺省值 |
| --- | --- | --- |
| `schemaVersion` | 必填 | 固定 `"worldpack-presentation/v1"`。 |
| `locale` | 选填 | `"en"` 或 `"zh-CN"`；缺省 `"en"`。编译后保存为展示配置，不是角色文风预设；不能据此断言默认舞台语言会切换。 |
| `style` | 选填 | 目前只能为 `"plain"`；缺省 `"plain"`。 |

不接受其他字段。确定性展示器本身接受独立的 `locale` / `style` 选项；当前核对的会话渲染调用传入的是调用方选项，未发现自动从该包字段取值的接线。见[解析实现](../../../packages/world-pack/src/schema.ts)、[展示器](../../../packages/core/src/presentation/presenter.ts)、[会话渲染调用](../../../packages/core/src/application/world-read-queries.ts)及[示例](../../../examples/world-packs/launcher-demo/presentation.json)。

## 官方舞台：素材与 `stage.json`

不写 `index.html` 时，`frontend/` 可以只包含 `theme.css`、`stage.json`、`components.json`、`portraits/`、`backgrounds/` 下的图片，以及活动页面绑定 `activity-pages.json` 与 `activities/` 下的资源，不需要 `manifest.json`。官方舞台按角色或地点 ID 去掉第一个冒号及其之前的前缀，匹配目录下**顶层**同名文件。角色底图依次找 `png`、`webp`，例如 `character:claude` → `frontend/portraits/claude.png`；背景依次找 `jpg`、`png`、`webp`、`jpeg`，例如 `location:library` → `frontend/backgrounds/library.jpg`。图片缺失或无法加载时分别退回角色标记和纯色背景；同一个地点默认只匹配一张背景，不会自动按时间切换。官方 RPG 的 `maps` 是地点、敌人、出口与事件等玩法配置，没有地图图片字段或格子地图；地图画面可由自定义页面实现，地点背景仍按上述约定提供。见 [RPG 配置 Schema](../../../packages/plugins/src/rpg/config-schema.json)和 [RPG 玩法指南](rpg.md)。

`theme.css` 可覆盖官方样式、CSS 变量和规则；无 JSON 字段。样式在默认舞台样式之后加载。开发者工具中切换纯官方模板时，包的主题和素材一起停用。样例及美术尺寸建议见[主题模板](../../../skills/perspectra-creator/assets/theme.css)、[前端指南](web-ui.md)和[立绘要求](portrait-art.md)。

`stage.json` 整个文件选填；一旦提供，加载时严格检查，字段未知、格式错误、差分图片缺失或引用越界会失败。即使包含自定义 `index.html`，文件存在时加载器也会先解析它；自定义页面本身不使用此配置。路径相对 `frontend/`，差分、拼合图和姿势图片必须在 `portraits/` 下，扩展名为 PNG 或 WebP，文件须存在且路径不能含 `..`。名称规则为小写字母或数字开头，其后仅小写字母、数字、`-`、`_`，最多 40 字符。来源：[舞台配置解析](../../../apps/host/src/runtime/pack-frontend.ts)、[默认舞台](../../../packages/frontend/src/default-template.ts)、[示例](../../../examples/world-packs/model-girls-sweet-days/frontend/stage.json)。

| 字段 | 必填性 | 约束 / 缺省值 |
| --- | --- | --- |
| `characters` | **必填对象**，允许为空 | 键为 `character:<非空无空白内容>`，冒号后最多 200 字符；值为下面的角色配置。解析器检查 ID 形状，不在此步骤验证它一定是包内角色。 |
| `autoplay` | 选填对象 | 为开场活动启用自动推进；仅按当前已提供的合法行动执行。缺省不自动推进。 |
| `autoplay.activity` | 提供 `autoplay` 时必填 | 活动名，符合上述名称规则。 |
| `autoplay.operation` | 提供 `autoplay` 时必填 | 推进操作名，符合上述名称规则。 |
| `characters.<角色ID>.framing` | 选填对象 | 底图头顶和腰部位置；缺省 `top: 0.03, waist: 0.48`。 |
| `framing.top` / `framing.waist` | 提供 `framing` 时两项均必填 | 占图片高度的比例，`0 ≤ top < waist ≤ 1`。 |
| `characters.<角色ID>.face` | 选填 | `[左, 上, 宽, 高]`，相对底图的 0–1 比例；宽高大于 0，框不能超出图片。局部表情没写 `at` 时使用此框。 |
| `characters.<角色ID>.sheets` | 选填对象 | 键为上述名称规则的拼合图名；值为路径字符串，或 `{ image, columns?, rows? }`。 |
| `sheets.<名称>.image` | 对象形式时必填 | 拼合图的包内图片路径。 |
| `sheets.<名称>.columns` / `rows` | 选填 | 各为 1–16 的整数，均缺省 4。字符串简写也使用 4×4。 |
| `characters.<角色ID>.expressions` | 选填对象 | 键是上述名称规则的表情名；值为整张透明图层路径、`{ image, at? }` 局部贴片或 `{ sheet, cell, at? }` 拼合图格。 |
| `expressions.<名称>.image` | 局部贴片形式时必填 | PNG/WebP 路径；局部贴片须写 `at` 或角色级 `face`。直接路径形式表示覆盖整张底图，不需要框。 |
| `expressions.<名称>.sheet` | 拼合图形式时必填 | 引用同一角色 `sheets` 中已经声明的名称。 |
| `expressions.<名称>.cell` | 拼合图形式时必填 | 从 0 开始逐行计数的整数，必须小于 `columns × rows`。 |
| `expressions.<名称>.at` | 贴片/拼合图形式选填 | 同 `face` 的比例框；不填时必须有角色级 `face`。 |
| `characters.<角色ID>.defaultExpression` | 选填 | 必须引用本角色已声明的表情；不填则没有初始表情层。 |
| `characters.<角色ID>.poses` | 选填对象 | 键为姿势名，值为整张替换底图的 PNG/WebP 路径。当前协议允许声明，默认舞台没有把模型输出接为姿势切换入口。 |

已声明的表情名会进入该角色的模型上下文；模型可为表达片段选择，舞台随阅读显示，不是权威世界状态。实际效果仍需试玩，图像是否画得合适不由格式校验证明。`stage.json` 不提供 Live2D 模型入口；自定义页面可自行实现其展示，但不等于官方舞台已内建 Live2D。来源：[角色上下文接线](../../../apps/host/src/runtime/web-entry.ts)、[片段类型](../../../packages/sdk/src/contracts/expression.ts)。

## 官方舞台组件：`frontend/components.json`

整个文件选填，仅作用于官方舞台。它最多 8 KiB；超过、无法解析或顶层结构不对时记录警告并使用默认组件。未知组件、未知或无效字段按项忽略并警告，其余有效配置继续使用。见[解析器](../../../apps/host/src/runtime/pack-components.ts)、[组件运行代码](../../../packages/frontend/src/stage-components.ts)与[完整示例](../../../examples/world-packs/multiple-activities/frontend/components.json)。

| 字段 | 必填性 | 内容 |
| --- | --- | --- |
| `version` | 文件提供时必填 | 数字 `1`。 |
| `components` | 文件提供时必填对象 | 键为下表组件 ID；没有配置的组件使用官方默认。 |
| `components.<ID>.anchor` | 选填 | 仅接受下表该组件对应位置。 |
| `components.<ID>.icon` | 选填 | 仅接受下表该组件对应内置图标名。 |
| `components.<ID>.size` | 选填 | `standard` 或 `large`。 |
| `components.<ID>.tone` | 选填 | `forest` 或 `indigo`。 |
| `components.<ID>.shape` | 选填 | `soft` 或 `pill`；`sendAudience` 不支持。 |
| `components.<ID>.order` | 选填 | 仅 `inventory`、`nearby`、`location`、`history`、`activity`、`statusSummary` 可用；0–9 整数，参与排序时缺省为 5。 |
| `components.<ID>.label` | 选填 | 仅 `inventory`、`nearby`、`history`、`activity` 可用；1–6 字符，以文字或数字开头，后续仅文字、数字、空格、`·`、`-`。 |
| `components.<ID>.narrow` | 选填对象 | 窗口宽度 ≤640 CSS 像素时覆盖同一组件字段；字段规则相同，不允许再次嵌套 `narrow`。 |

| 组件 ID | 允许的 `anchor` | 允许的 `icon` |
| --- | --- | --- |
| `inventory` | `index`、`toolbar`、`story` | `bag` |
| `nearby` | `toolbar`、`story` | `diamond` |
| `sendAudience` | `footer-end`、`footer-inset` | `arrow` |
| `identity` | `waist`、`above-waist` | `dots` |
| `location` | `heading`、`toolbar` | `compass` |
| `history` | `toolbar`、`story` | `book` |
| `activity` | `story`、`toolbar` | `flag` |
| `statusSummary` | `heading`、`toolbar` | `meter` |

## 活动页面与独立 CSS

`frontend/activity-pages.json` 选填。每个活动键对应一条绑定，其中 `html` 必填，`css` 选填，均为相对于 `frontend/` 的 `activities/…` 路径。`elements` 选填。在其中配置时每个元素的 `id` 必填，`operation`（按钮）和 `rules` 选填。每条规则须填 `field`、`compare`、`value` 和 `effect`。HTML 自身也可链接多份本地 CSS。工作台枚举活动键及已有资源，CLI 校验与游戏加载会检查显式引用的文件，工作台导出时还会核对活动键。包内链接的样式或图片需要在浏览器里核对。[活动页面标记与示例](activity-stages.md)

## 自定义完整网页：`frontend/manifest.json`

作者提供 `frontend/index.html` 时需要同目录 `manifest.json`；页面加载 `/frontend/sdk.js` 后通过公开玩家接口访问授权视图与操作。页面自己负责界面和媒体播放。`web/` 是旧入口，不作为当前可执行前端。见[前端加载器](../../../apps/host/src/runtime/pack-frontend.ts)、[SDK](../../../packages/frontend/src/client.ts)、[前端指南](web-ui.md)。

| 字段 | 必填性 | 约束 |
| --- | --- | --- |
| `apiVersion` | 必填 | 数字 `1`。 |
| `capabilities` | 必填数组 | 字符串项可为 `view`、`history`、`speak`、`perform`、`regenerate`、`subscribe`、`resources`、`speech`、`bgm`。未知字符串被过滤，重复项去重；运行时缺少相应服务时能力仍可能被移除。 |

顶层不接受其他字段。整个 `frontend/` 最多 2048 文件、单文件 64 MiB、合计 512 MiB；禁止符号链接。允许 `.html`、`.css`、`.js`、`.mjs`、`.json`、`.png`、`.jpg`、`.jpeg`、`.webp`、`.gif`、`.svg`、`.woff`、`.woff2`、`.mp3`、`.ogg`、`.wav`。前端资源可公开读取，不应放凭证或角色私密资料。默认沙箱与额外授权的受信任模式不同，见[前端授权](../frontend-authorization.md)。

## 音乐与语音

官方舞台没有“把音频文件放进游戏包某目录就自动播放”的 BGM 字段。默认播放器通过宿主 Cordis 插件的 `ctx.frontendServices.registerBgm` 取得曲库和选曲回调；插件是单独安装和启用的宿主扩展。最多一个 BGM 服务，可同时存在一个语音服务。自定义网页也可声明 `bgm` / `speech` 并使用 SDK，自行实现播放。示例：[BGM 插件](../../../examples/host-plugins/demo-bgm.mjs)、[语音插件指南](host-plugin-authoring.md)、[类型](../../../packages/sdk/src/contracts/presentation.ts)。

| BGM 插件字段 | 必填性 | 约束 |
| --- | --- | --- |
| `tracks` | 必填数组 | 1–16 条，ID 不重复。 |
| `tracks[].id` | 每条必填 | 小写字母或数字开头，其后小写字母、数字、`_`、`-`，最多 64 字符。 |
| `tracks[].title` | 每条必填 | 非空，最多 120 字符。 |
| `tracks[].contentType` | 每条必填 | `audio/mpeg`、`audio/ogg`、`audio/wav`。 |
| `tracks[].bytes` | 每条必填 | `Uint8Array`，非空且不超过 32 MiB。 |
| `selectTrack(input, signal)` | 必填函数 | 返回已注册的曲目 ID 或 `null`（静音），可异步。`input` 为授权阅读片段，含 `seq`、`segmentIndex`、`text`、`type`，`speakerId` 可能缺省。 |

语音插件通过 `registerSpeech(synthesize)` 提供合成函数。宿主提供与选曲相同的授权阅读片段和取消信号，函数异步返回音频对象，必填 `contentType`（`audio/mpeg`、`audio/ogg` 或 `audio/wav`）和 `bytes`（`Uint8Array`）。无服务时官方界面禁用语音。可设置的音色和服务连接字段取决于所装插件。[接口](../../../packages/sdk/src/frontend.ts) · [音频类型](../../../packages/sdk/src/contracts/presentation.ts) · [宿主注册](../../../apps/host/src/host-plugins.ts)

## 包推荐：`model-preset.json`

文件内容是**裸 `RolePreset` 对象**，不是带 `format`、`schemaVersion` 的预设库交换封套。所有顶层字段均选填，未知字段拒绝；`{}` 合法。它影响角色模型请求，不配置模型服务、凭证、角色权限或权威规则。格式校验不能证明文风有效或模型会遵守。来源：[校验和类型](../../../packages/providers/src/chat/preset.ts)、[Provider](../../../packages/providers/src/chat/provider.ts)、[示例](../../../examples/world-packs/launcher-demo/model-preset.json)。

| 字段 | 必填性 | 类型、约束和作用 |
| --- | --- | --- |
| `prompt` | 选填 | 字符串，最多 16000 字符；非空时作为附加角色表现提示。 |
| `nodes` | 选填 | 提示节点数组，最多 64 项，ID 在数组内唯一，按顺序插入上下文前后；子项见下表。 |
| `textRules` | 选填 | 文本替换规则数组，最多 32 项，ID 在数组内唯一；子项见下表。 |
| `temperature` | 选填 | 有限数，0–2；未设时角色请求使用 Provider 选项，未配置时非 Anthropic 默认为 0.3，Anthropic 不发送该默认值。 |
| `topP` | 选填 | 有限数，0–1。 |
| `frequencyPenalty` | 选填 | 有限数，−2 至 2；Anthropic 角色请求不支持，填写会报错。 |
| `presencePenalty` | 选填 | 有限数，−2 至 2；Anthropic 角色请求不支持，填写会报错。 |
| `maxOutputTokens` | 选填 | 1–32768 整数；覆盖角色请求默认上限。启用思考时运行时可能按思考级别提高上限。 |
| `stop` | 选填 | 最多 4 个字符串，每个 1–100 字符；空数组允许。 |

`prompt` 与所有节点 `content` 合计最多 64000 字符。未设生成参数通常由 Provider 或服务处理；上表关于 Anthropic 和默认温度的行为是官方内置 Provider 的行为；选择可替换的 LLM transport 时，已填写的参数交给该 transport 处理，不保证相同默认或支持范围。不同模型协议未必支持全部参数。例如内置 Provider 的 Anthropic 开启思考时会移除 `temperature` 和 `topP`。具体实际请求可以用 Launcher 检查器核对。

### `nodes[]`：每个子项的字段均必填

| 字段 | 约束 |
| --- | --- |
| `id` | 非空字符串，最多 100 字符，节点内唯一。 |
| `name` | 非空字符串，最多 80 字符。 |
| `enabled` | 布尔值；禁用节点不插入请求，保存校验只检查启用节点的宏。 |
| `role` | `system`、`user` 或 `assistant`。 |
| `position` | `beforeContext` 或 `afterContext`；核心固定契约仍在前。 |
| `content` | 字符串，可为空，最多 32000 字符。启用且展开后非空才发送。 |

节点支持 `{{char}}`、`{{user}}`、`{{scene}}`、`{{date}}`、`{{time}}`，以及 `{{setvar::键::值}}`、`{{getvar::键}}`、`{{random::选项1::选项2}}`、`{{roll::NdM}}`、`{{trim}}` 和 `{{//注释}}`；不支持嵌套宏。骰子最多 20 个、面数 1–9999。变量在一次角色请求内共享，请求之间不共享；宏展开后每节点最多 64000 字符。宏仅在节点内容中展开，不把 `prompt` 当成宏模板。来源：[宏实现](../../../packages/providers/src/chat/preset-macros.ts)、[节点装配](../../../packages/providers/src/chat/preset-runtime.ts)。

### `textRules[]`：每个子项的字段均必填

| 字段 | 约束 |
| --- | --- |
| `id` / `name` / `enabled` | 与节点相同；ID 在规则数组内唯一。 |
| `stage` | `input`、`history`、`output`、`display`，分别处理本次输入投影、历史表达投影、角色发布前表达和玩家展示副本。 |
| `target` | `speech`、`narration`、`both`。 |
| `pattern` | 非空 JavaScript 正则表达式，最多 1000 字符，须能编译。 |
| `flags` | 最多 6 字符，仅 `g`、`i`、`m`、`s`、`u` 且不能重复；可为空。 |
| `replacement` | 字符串，可为空，最多 4000 字符。 |

输入与历史只处理已授权表达的副本；`output` 在发布前处理角色表达，不能改写玩法规定的闭合对白选项；`display` 不回写事件和角色记忆。规则失败会报错，不能把文本替换当成权限保护。来源：[文本规则运行](../../../packages/providers/src/chat/preset-runtime.ts)、[规则执行](../../../packages/providers/src/chat/preset-regex.ts)。

## 随包角色与角色组：`role-presets.json`

文件整个选填，只接受下面两个顶层字段，至少有一个非空。Launcher 载入时会校验格式与引用，并提供一键分配；分配是复制到实例，不会随包更新而自动同步。来源：[加载和校验](../../../apps/host/src/model-presets.ts)、[Launcher 的角色引用检查](../../../apps/launcher/backend/core.ts)、[分配逻辑](../../../packages/providers/src/chat/preset.ts)、[示例](../../../examples/world-packs/model-girls-sweet-days/role-presets.json)。

| 字段 | 必填性 | 约束 |
| --- | --- | --- |
| `characters` | 选填对象 | 键为角色 ID，值为上节的裸 `RolePreset`；ID 须为该包可调用角色。 |
| `groups` | 选填数组 | 最多 32 组；每项严格只包含 `name`、`preset`、`members`。 |
| `groups[].name` | 每组必填 | 非空，最多 80 字符；去首尾空格后组名唯一。 |
| `groups[].preset` | 每组必填 | 裸 `RolePreset` 对象。 |
| `groups[].members` | 每组必填 | 非空角色 ID 数组；每个 ID 最多 200 字符，必须是包内可调用角色，一个角色最多属于一个组。 |

可调用角色不含玩家、`manual` 控制及非 `active` 角色。角色专属优先于所属组；组优先于实例默认，并且角色或组预设**完整替代**下层，不是逐字段合并。实例使用自动模式时，全局预设与包推荐按顶层字段合并，包推荐同名字段覆盖全局；也可选全局或实例自定义。`nodes` 等数组作为整个字段替换。源见[实例选择](../../../apps/host/src/model-presets.ts)和[角色选择](../../../packages/providers/src/chat/preset.ts)。

### 库交换格式与宿主私有设置

预设库导出支持单项 `{ "format": "perspectra-model-preset", "schemaVersion": 1, "name": "…", "preset": { … } }` 或整库 `{ "format": "perspectra-model-preset", "schemaVersion": 1, "presets": [{ "name": "…", "preset": { … } }] }`。`name` 非空且去空格后最多 80 字符；导入也接受无版本的原生裸预设、命名对象及命名数组；其中裸预设与包推荐使用相同结构，命名对象及数组是库导入兼容格式，不能直接放进包推荐文件。源见[预设库解析](../../../packages/providers/src/chat/preset-library.ts)。

模型连接的协议、地址、模型 ID、思考等级及凭证由 Launcher/宿主配置，不是 `model-preset.json` 或 `role-presets.json` 字段；密钥保存在系统凭据存储。玩家的浅色/深色、阅读和声音偏好也是宿主设置。源见[模型连接](../../../apps/host/src/model-connections.ts)与[Launcher 设置](../../../apps/launcher/backend/core.ts)。

## 验证边界

编译或 `worldpack validate` 检查源包清单、`presentation.json` 和显式资产；它不等价于启动 Launcher 来读取 `frontend/`、封面和随包预设。可使用 `worldpack preset validate <文件> --pack` 单独检查裸 `RolePreset` 的字段、启用节点宏和正则语法；该命令不验证 `role-presets.json` 的角色映射，也不评价文风。Launcher 实际载入时还检查前端及随包角色引用。模型调用、图片视觉质量、音频播放和角色体验仍需在实际宿主和目标模型中验证。来源：[CLI](../../../apps/host/src/cli/worldpack.ts)、[作者校验入口](../../../packages/world-pack/src/creator-cli.ts)、[Launcher 载入](../../../apps/launcher/backend/core.ts)。
