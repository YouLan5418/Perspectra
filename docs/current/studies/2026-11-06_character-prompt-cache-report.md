# 多角色前缀缓存：调研结果与改动方案

日期：2026-11-06。范围：当前 main 工作树、项目使用的 pi-ai 1.4.0、主要供应商官方接口。状态：调研与离线复现完成，第一版已实施；实施结果见第 7 节。没有调用真实供应商模型或构建原生发行包。

例如 Claude 和 Gemini 两名角色都使用同一条 DeepSeek 连接：希望 Claude → Gemini → Claude 交替处理刺激时，每名角色仍可复用自己的稳定前缀。玩家只配置模型连接，不为每名角色手填供应商参数。缓存只优化请求计算与费用，不替代角色授权、记忆、规则或事实提交。

建议先补齐缓存观测，再在现有连接和适配器中增加有限的缓存策略、角色级固定标识及前缀缓存点。不要全局改成 short，也不要把供应商的隔离标识、路由提示和缓存对象 ID 混成同一种能力。Gemini 显式缓存对象与方舟 Responses 会话缓存作为后续独立扩展。

## 1. 现状与证据

### 源码已经接通的路线

1. [模型连接](../../../desktop/model-connections.ts)：ModelConnection 只保存 id、name、protocol、endpoint；校验拒绝未知字段。resolveRoleModels → modelEnvironment → runtimeRoleModels 把连接转换为角色目标，经进程环境传递，凭证另行处理。
2. [Launcher 编辑器](../../../apps/launcher/src/components/ModelSettingsDialog.vue)：save 显式挑选上述四个字段，新增连接配置不能只改后端类型。
3. [官方角色 Provider](../../../packages/official-llm/src/role-providers.ts)：已经按角色建立独立 ChatProvider，角色相同不等于共用同一个 Provider 对象；独立对象本身不会创建供应商缓存命名空间。
4. [官方模型插件](../../../packages/official-llm/src/index.ts)：在每次 open(world) 中创建角色调用实例，适合管理与此次运行同寿命的缓存标识。
5. [发送适配器](../../../packages/provider-chat/src/provider.ts)：经 pi-ai 的 streamSimple 发送，显式 cacheRetention: 'none'，没有 sessionId，也没有向 DeepSeek Chat 写入 user_id。onPayload 已提供最后一次调整供应商请求的位置。
6. [请求检查器](../../../packages/provider-chat/src/request-inspector.ts)：只能保留输入、输出、合计；inspected(message) 又把 SDK 的非缓存输入误当成总输入，丢弃 cacheRead/cacheWrite。轻量 onCall 目前没有 token 用量。
7. [角色文本](../../../packages/provider-chat/src/character-context-text.ts)：已经去除部分不稳定宿主元数据并调整字段顺序。当前经历和处境仍合并成一个 user JSON 字符串。

调用路径：Launcher 连接配置 → resolveRoleModels → modelEnvironment → web-entry/runtimeRoleModels → official-llm.open → createRoleProviders → createChatProvider → pi-ai → 供应商。缓存设置必须完整经过此路径，不能只加一个 UI 开关。

### 离线复现

运行以下命令，可重现此次 SDK 请求捕获与当前统计问题，不使用真实 Key，不访问网络：

~~~powershell
node --import tsx docs/current/studies/2026-11-06_character-prompt-cache-probe.mjs
~~~

探针在 onPayload 捕获请求后主动抛出 CAPTURE_ONLY；返回的 error 是预期停止手段，不是接口故障。全局 fetch 有禁止联网的守卫；用量场景注入内存 SSE 响应。模型名字仅用于核对本机目录的序列化，不表示这些历史型号仍可在线调用。

| 证据 | 条件 | 观察结果 | 实施意义 |
| --- | --- | --- | --- |
| E1 | OpenAI 官方、传 sessionId、none/short 对照 | none 不发 key；short 发 prompt_cache_key | SDK 能复用，但当前设置阻断了这一条路径 |
| E2 | 未知 OpenAI 兼容地址、传 sessionId、short | 不发 prompt_cache_key | 自定义中转需要明确策略，不能只透传 SDK sessionId |
| E3 | DeepSeek Chat、传 sessionId 和 metadata.user_id、short | 仍无顶层 user_id | 必须在适配器显式设置该字段 |
| E4 | Claude Messages、none/short 对照 | none 无缓存点；short 在简单 fixture 中添加两个缓存点 | 开启 SDK 缓存还要核对实际落点，不能默认缓存动态尾部 |
| E5 | DeepSeek Messages、metadata.user_id | metadata.user_id 保留；short 还会添加缓存点 | DeepSeek 隔离参数与 SDK 缓存点应分别控制 |
| E6 | Google、short/sessionId | 没有 cachedContent | 显式缓存对象不是改一个选项就能接通 |
| E7 | 上游 SSE 报输入 1000、读取缓存 800、输出 20、合计 1020 | 当前检查器显示输入 200、输出 20、合计 1020；onCall 没有 usage | 先修统计，否则会误判缓存与输入成本 |

脚本：[离线探针](2026-11-06_character-prompt-cache-probe.mjs)。本次输出：[探针结果](2026-11-06_character-prompt-cache-probe.json)。SDK 依据是本地 node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js、anthropic-messages.js、google-generative-ai.js 与 types.d.ts；不要修改或复制这些 SDK 实现。

E1–E7 证明请求生成和数据丢失，不证明供应商会命中缓存。用户观察到的“同供应商交替调用不命中”仍缺少同角色请求及服务端 usage 的对照，不能把根因直接定为缓存互相覆盖。

## 2. 供应商能力及可用边界

| 实际上游 | 官方能力 | 项目当前路径及建议 |
| --- | --- | --- |
| DeepSeek | Chat 顶层 user_id；其 Anthropic 兼容接口使用 metadata.user_id。用于 KVCache 隔离及调度隔离 | 两条现有协议都能局部接入。保留服务端自动缓存，不为此额外发送 Claude 缓存点 |
| OpenAI | prompt_cache_key；GPT-5.6 之前帮助缓存路由，之后主要隔离缓存统计，路由自动处理 | 当前 Chat Completions 已支持该参数。首版仅设置稳定 key，不主动开启长 TTL、预热或新缓存模式 |
| Claude 官方 | cache_control，按缓存点之前的内容匹配；有写入计费和模型相关的最小长度 | 使用现有 Messages 路径。缓存点应落在已知稳定前缀；不能把 metadata.user_id 当作 DeepSeek 的隔离能力 |
| 阿里云百炼 | 支持模型可用 cache_control，OpenAI/Anthropic 兼容路径均有官方示例 | 作为前缀标记策略接入；只对已核对端点/模型或玩家显式选择启用 |
| Gemini | GenerateContent 可先创建 CachedContent，再通过 cachedContent 引用；内容不可变，TTL 可更新，另有存储费用。Interactions 不支持显式对象 | 当前 Google 路径没有创建、续期、删除缓存对象的接入。首版保留隐式缓存，只补观测；显式对象另做 |
| 火山方舟 | 现行文档明确 Chat 与 Responses 都支持 prompt_cache_key；Messages 使用 metadata.user_id.session_id；显式会话缓存仅 Responses 支持 | 首版 Chat 可复用 prompt-key 策略。Messages 的 user_id 具体编码需要进一步核对接口定义后再接入。当前没有 Responses 协议，不能把 previous_response_id 塞进 Chat 路径 |
| 未知中转、本地服务、其他模型平台 | 能力取决于实际端点，不能从模型名或协议推断 | 自动模式默认不注入缓存专属字段；允许明确覆盖为已经实现的策略，不宣称通用支持 |

官方依据（2026-11-06 核对；型号、端点及套餐仍以实际接入时文档为准）：

- [DeepSeek user_id 隔离及两种协议写法](https://api-docs.deepseek.com/quick_start/rate_limit/)；[缓存命中及写入规则](https://api-docs.deepseek.com/guides/kv_cache/)。隔离并不保证独占 GPU、固定容量或必然命中。
- [OpenAI 缓存规则与型号区别](https://developers.openai.com/api/docs/guides/prompt-caching)；[Chat Completions 参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。key 不保证固定机器，也不保证命中。
- [Claude 缓存与失效规则](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。缓存点之前的 tools、system、messages 需要匹配；动态尾部打点可能反复写入而没有读取。
- [百炼显式缓存](https://help.aliyun.com/zh/model-studio/explicit-cache-guide)。有最小长度、缓存时限、写入费用及模型支持范围，不用填充无意义文本凑长度。
- [Gemini CachedContent API](https://ai.google.dev/api/caching?hl=en)；[GenerateContent 缓存说明](https://ai.google.dev/gemini-api/docs/generate-content/caching)；[Interactions 缓存限制](https://ai.google.dev/gemini-api/docs/caching)。GenerateContent 资料通过官方索引内容核对；部分直读请求返回不支持 Markdown 内容类型，未据此推断新能力。
- [方舟现行缓存说明](https://console.volcengine.com/ark/region:cn-beijing/docs/context-cache)。旧 Context API 页面已标为下线，不作为新实现依据。

## 3. 推荐的最小改动

### 先补观测，纠正输入统计

在现有调用回调及检查记录中增加 SDK 用量：总输入、非缓存输入、缓存读取、缓存写入、输出、合计。总输入按 pi-ai 的 input + cacheRead + cacheWrite 还原；不能再直接把 message.usage.input 标成总输入。

沿用 RequestInspector、ChatCallObservation、现有角色调用记录与创作者请求页，不新增日志数据库或监控服务。轻量 token 计数即使没有启用请求正文捕获也能交付；正文仍由创作者主动开启，不为测缓存默认记录角色私密上下文。

UI 使用“SDK 记录的缓存读取/写入”，不要把 SDK 的缺省 0 宣称为供应商明确报告的 0。首版承认当前 SDK 不能可靠区分所有端点的“未报告”和“真实为 0”；若需要精确区分，再针对实际端点调查，不复制一套 SSE 解析器。只要没有完整的读写信息，就不宣称已经省钱。

### 连接只增加一个可选策略

建议新增 ModelConnection.cacheMode，允许以下值；字段缺省表示 auto，不做旧存档迁移或新增配置版本。

| 配置值 | 玩家显示 | 意义 |
| --- | --- | --- |
| auto | 自动 | 仅按核对过的官方 host、路径和协议选择策略；未知地址使用 passive |
| passive | 不主动优化 | 不注入缓存标识/缓存点，不表示能关闭上游自动缓存 |
| deepseek-user | DeepSeek 角色隔离 | 根据所选协议注入顶层或 metadata 内的 user_id |
| prompt-key | 缓存路由标识 | 为已经确认支持 prompt_cache_key 的 OpenAI 兼容端点传角色 key |
| prefix | 前缀缓存标记 | 对支持 cache_control 的 Chat/Messages 端点设置稳定缓存点 |

这是一个有限的请求配置，不新增供应商注册框架、插件层或任意 JSON 参数编辑器。auto 与覆盖值解决“同协议不同实际服务商”的差异。识别使用精确主机/明确路径，不用包含字符串或模型名字猜测上游。

配置在 Launcher 高级设置中展示，默认无需操作；显示本次解析出的策略及“支持待实测/已观察到读取”，不把连接测试成功写成缓存验证成功。自定义中转由玩家或维护者选择已确认的适配，不自动轮流尝试供应商字段或悄悄切换上游。协议和所选策略不兼容时在保存/启动时说明，不额外发送一轮付费探测。

cacheMode 随 resolved/runtime 目标经过完整进程链路。源码入口也应能指定同一个选项，不能只让 Launcher 有效。模型 Key 保持现有保管路径，不进入策略、缓存 key 或配置展示。

### 缓存标识只在角色 Provider 实例内管理

推荐首版在 officialLlmProvider.open 内为每个模型角色生成一个随机 UUID，由该角色 ChatProvider 持有至关闭。同一运行中的 A → B → A → B 分别重复各自 UUID；不同运行实例即使角色 ID 相同也获得不同 UUID。UUID 为 ASCII，长度 36，不会触发本地 SDK 对 OpenAI key 的 64 字符截断。

这替代“新增本地玩家账号、安装身份、持久缓存命名空间文件”的方案，不叠加新的身份系统。不上送玩家名字、角色私密资料、本地绝对路径或凭证。缓存 ID 不进入模型消息、世界事件、记忆或权威事实，也不参加世界状态校验。

当前 [world-runtime](../../../desktop/host/world-runtime.ts) 的 tenant 是固定 web-playtest，worldId 由世界包摘要派生，branch 是固定 main；它们不能直接区分多个玩家的同一世界包。worldVersion 在 [tail-runtime](../../../desktop/host/tail-runtime.ts) 中可能来自已有选择或重生成版本，不等于全局玩家身份。不要为缓存修改这些世界地址。

明确接受：进程重启、切换存档、重开运行实例或生成新候选后需要重新预热。首版不追求跨启动保温，也不持久化 UUID；如果实测表明频繁冷启动有明显成本，再复用已有 Launcher 实例/故事线身份设计持久命名空间，同时核对故事分享与复制语义。未来统一代调服务才需要服务端确认的玩家/租户命名空间，此次不引入账号系统。

DeepSeek 策略保持 SDK 不主动添加前缀标记，只在 onPayload 写入正确位置的 user_id。prompt-key 策略可复用 SDK 对官方 OpenAI 的支持；明确选用该策略的自定义端点在 onPayload 显式设置 key，不能指望 SDK 自动识别。

### 谨慎启用前缀缓存点

只改 cacheRetention 为 short 会使 SDK 默认在最后的 user 内容上打点。当前这段内容包含历史、处境、刺激和阶段，通常每轮不同；Claude 以内容块为缓存边界，不能把一个不断改写的完整 JSON 当作可靠的长历史缓存。

首版前缀策略仅在最终请求中已确认稳定的系统前缀边界打点，不默认给动态 user JSON 写缓存；按协议处理现有系统块/首段系统消息，保留文本与消息顺序。SDK 自带落点不符合要求时，在现有 onPayload 中定点处理，而不是修改 pi-ai。默认使用供应商短 TTL，不自动预热或开启长期存储。

这只能复用稳定系统前缀，不能承诺 Claude 已经复用完整的角色经历。如果系统前缀不足最小长度，允许正常调用且没有命中，不补无意义文本。缓存点前的工具定义也参与匹配，而 [角色决策 Schema](../../../packages/provider-chat/src/character-turn-call.ts) 与 [网关 Schema](../../../packages/official-llm/src/gateway-turn-call.ts)会随受众、可执行操作和续写阶段变化；设置角色 ID 无法消除这些失效条件。

在真实对照确认收益不足后，才评估第二次小改动：把稳定角色材料/已归档经历与动态处境分成可复用块。该步骤会影响模型上下文呈现，须单独进行角色行为和认知隔离验收；不借此稳定成过宽的工具 Schema，不绕过 Host 校验，也不合并角色上下文。

## 4. 实施落点与暂缓范围

| 位置 | 预计改动 |
| --- | --- |
| desktop/model-connections.ts | 可选策略校验、解析、进程传递、源码环境入口；默认 auto |
| Launcher ModelSettingsDialog 与相关 store | 编辑、保存和显示策略；沿用 API Key 管理 |
| packages/official-llm/src/role-providers.ts | 给角色 Provider 传策略及固定 UUID |
| packages/official-llm/src/index.ts | 在 open 生命周期内创建角色缓存标识；关闭后释放 |
| packages/provider-chat/src/provider.ts，必要时同包一个小 helper | 根据策略设置 SDK 选项和最终请求；修正用量；不修改采样、思考、重试与角色输出 |
| packages/provider-chat/src/request-inspector.ts | 保存缓存读写与总输入语义 |
| 创作者 RequestsView/DetailPanel 与类型 | 显示真实可获得的缓存计数及其 SDK 来源 |
| docs/current/model-protocols.md、architecture/cognition-memory.md 及受影响章节 | 说明策略、上下文边界、观测口径、未覆盖能力；保留发行包与实测范围区别 |

不新增 package，不改核心事实提交。plugin-sdk 的 LlmTransportInstance.send 已有 characterId，且适配器在 open 时获得 WorldServices；第三方发送插件可以自行管理角色缓存，无需为首版扩大公共接口。完整替换通道/第三方 transport 不被官方参数强制改写；当前插件响应没有通用 usage 字段，不能伪造其缓存统计。

暂缓：Gemini 缓存对象生命周期；方舟 Responses 协议及尚未核对编码的 Messages 会话字段；Core Python utility_llm 的缓存；跨进程保温；上游多账号路由管理。方舟缓存说明已确认 Chat 支持 prompt_cache_key，其链接指向的 Messages 接口定义直读跳转登录，不能据此猜测 user_id 的序列化。Core 记忆本来走独立 Python 请求，当前承诺仅覆盖官方角色决策。更换上游账号、淘汰、过期、最小长度和前缀变化仍可能造成未命中。

## 5. 验证顺序与完成标准

1. 观测回归：用已复现的 1000/800/20 用量验证总输入 1000、缓存读取 800、非缓存输入 200、输出 20、合计 1020；覆盖独立写入 token、无报告、失败与取消。关闭正文捕获时仍只交付数字统计。
2. 配置回归：旧连接缺字段按 auto；Launcher 保存/重开、角色覆盖、源码入口、环境序列化与未知中转均不丢失设置。已有凭证变更主机保护保持有效。
3. 请求回归：A → B → A → B 的 A key 相同、B key 相同且 A/B 不同；不同 open 获得不同 key；DeepSeek 两种协议位置正确；未知地址的 auto/passive 不加字段；不兼容策略明确失败。缓存 key 不进入模型上下文。
4. 前缀策略：只在指定稳定边界打点；不把动态刺激末尾当成默认写入点；设置前后逻辑消息和授权内容相同，工具资格与 Host 校验不变。优先扩展已有 provider-chat-adapter、role-providers、request-inspector、model-connections 与 Launcher store 测试，不新增穷举矩阵。
5. 真实供应商对照：使用新的实验目录和固定授权请求序列，在同一连接/模型上对比 A 连续调用与 A/B 交替调用；每名角色至少多次复用已建立的前缀，留出供应商缓存写入时间。记录总输入、读取、写入、非缓存输入、模型/策略和延迟；有写入费用时一并核对，不能把读取比例直接当费用节省比例。不上送额外私有信息，不使用 D:/worlds 历史试玩目录写入实验。
6. 角色试玩：维持多人自然轮流互动，检查最新刺激、角色私密信息与动作裁定没有回归。若另行拆上下文块，追加多轮真实模型行为验收。

自动检查沿用 corepack pnpm@11.7.0 check 与 Launcher 检查，按实际改动运行；文档更新后执行 node scripts/docs/check-links.mjs。真实缓存验收需使用玩家实际选择的端点，HTTP 200、本机模拟通过和请求带参数都不能替代它。

完成标准：不同玩家正常配置自己的连接即可使用已支持策略；同一实例每个角色得到稳定且独立的标识（适用时）；能看到正确的缓存统计；至少目标实际供应商完成交替调用对照；未覆盖接口明确显示能力边界。不能交付“所有供应商都保证角色独占缓存”这样的结论。

## 6. 调研轮交付范围（实施前）

已完成源码与 SDK 读取、官方资料核对、八组离线 payload 捕获，以及统计错误的内存 SSE 复现。新增此调研文档、可复现探针及输出，未改运行时与玩家配置。未进行真实模型、Core Python、浏览器 UI、发行包或长会话验收；本轮不运行全仓测试，文档链接与探针执行结果单独报告。

验证结果：离线探针正常完成，networkAttempts 为 0；新增文档的本地链接均存在。全仓 node scripts/docs/check-links.mjs 已运行，因四篇既有研究文档共 103 处缺失目标而退出 1；其中没有本次新增文档的错误。另有 24 处历史本地产物不在工作树，检查器按既有规则列为非必需。未扩大此次范围修复历史链接。


## 7. 第一版实施结果

已实现连接的 cacheMode 传递、协议校验、源码环境配置、运行期角色固定 UUID、正确的 SDK 缓存用量与 Launcher/创作者界面。角色原本就有独立 ChatProvider，因此直接在 createChatProvider 的实例闭包生成 UUID，复用既有 open 生命周期，不再额外建立角色 ID 映射或修改核心 WorldServices。

除原方案外，按用户补充接入了两个中转：

| 策略 | 会话传递与缓存行为 |
| --- | --- |
| openrouter | Chat 请求体 session_id，Messages 请求头 x-session-id。规范 Claude ID 与官方列出的部分百炼模型另加稳定系统前缀缓存点；未知别名只做会话亲和 |
| opencode-go | 三种协议均发送 x-opencode-session，使用 Perspectra User-Agent；不强制插入模型专属缓存点。识别当前 /inference/go 路径与既有 /zen/go/v1 路径，不重写 URL |

依据：[OpenRouter 官方缓存与会话说明](https://openrouter.ai/docs/guides/best-practices/prompt-caching)、[OpenCode Go 官方会话请求头说明](https://opencode.ai/v2/docs/console/go/)。区域 OpenRouter 主机仍沿用原始地址，不切换区域；支持条件见[官方区域说明](https://openrouter.ai/blog/announcements/us-in-region-routing/)。手动指定这两种策略可供二级中转透传，不表示任意中转均已验收。

cacheMode 已贯通 ModelConnection → ResolvedModel → RuntimeModel → LlmModel → ChatProvider；记忆目标不携带该设置。SDK 仍使用 none 来抑制其默认末尾缓存点，适配器随后精确注入选中策略。没有把所有调用统一改为 short，没有修改调度、角色上下文内容、规则与事实提交，也没有更改插件 SDK 或 pi-ai 依赖版本。新增公开的浏览器安全子路径 @harness-world/provider-chat/prompt-cache，Launcher 和创作者构建通过它读取标签/解析逻辑，避免引入 Node 模块或跨包私有文件。

验证结果：

- corepack pnpm@11.7.0 check：主干边界、类型、Lint、格式检查通过。全量测试 205 个文件、1963 项中，1945 项通过，18 项因沙箱 taskkill 权限及后续临时目录占用失败；仅涉及 tail-round 与 storyline-crash 两份文件。
- 随后在允许结束测试自建子进程的环境单独复验上述两份文件，38 项全部通过；没有跳过、删除测试或放宽断言。其余默认回归在原 check 中已通过。
- corepack pnpm@11.7.0 launcher:check：Vue 类型检查通过，9 个文件、99 项单测通过。
- corepack pnpm@11.7.0 launcher:build：Launcher、创作者、Lens 三个前端目标均完成生产构建；没有构建 Tauri/便携发行包。
- 角色调用回归覆盖 prompt-key、OpenRouter 和 OpenCode Go 的 A/B/A/B 调用与重新打开后的命名空间变化；传输回归覆盖 Go 三种协议请求头、OpenRouter 两种协议、DeepSeek 两种协议、被动模式、稳定前缀及未知别名。
- 修正后的离线探针仍为零网络请求；同一合成上游输入 1000、命中 800、输出 20，现在检查器及轻量回调均报告总输入 1000、非缓存输入 200、读取 800、写入 0、合计 1020。结果见[实施后探针输出](../../../output/character-cache-20261106/probe-after.json)。旧 JSON 保留为实施前的对照证据。
- 浏览器 Mock 预览验证两条连接自动识别、保存和高级设置；请求详情显示总输入与 SDK 读写计数。截图：[连接配置](../../../output/character-cache-20261106/launcher-cache.png)、[请求用量](../../../output/character-cache-20261106/creator-cache-counts.png)。样例不是供应商实际命中记录。

上述第一版交付阶段只完成离线与 Mock 验证。随后用户指定本机 Magpie 网关的 OpenCode Go `opencode-go/glm-5.3-flash`，完成了 60 次正式在线缓存对照，见[GLM-5.3-Flash 实验](2026-11-06_glm53flash-character-cache-live.md)。固定会话下原样重复请求，连续和交替的预热后读取占比均为 89.59%；现行单条 JSON 每轮增长时仍很少命中。只在实验脚本中分开稳定资料与动态尾部后，交替调用的预热后读取占比为 88.72%，被动模式也有同样读取。不能把该收益归因于 UUID，或表述成生产上下文已完成优化。真实 OpenRouter、自然角色试玩与发行包仍未验收；跨启动保温、生产历史分块、Gemini 显式对象、方舟 Responses、Core Python 缓存继续暂缓。

用户随后要求使用已有长对话，追加了同一报告中的 60 次存档历史对照：每次约 2.9～4.9 万输入 token，原样重复的连续与交替组均为 97.35%，自然增长的显式 Go 交替组仅为 16.09%。分块 Go 组为 35.83%，且只有 GPT 命中，DeepSeek 三次预热后读取均为 0；分块被动组为 81.30%。这进一步限制了首轮结论：标识和分块均不保证稳定命中，暂不推广生产分块。历史只读提取本人授权观察与自发表达；60 次归属、时间点和用量核对通过，2 次工具格式失败单列，没有宣称真实玩法已验收。

再按用户授权将相同长历史直连 DeepSeek 官方 `deepseek-flash`，完成 [48 次对照](2026-11-06_deepseek-character-cache-live.md)：原布局连续和交替、有无 `user_id` 均为 90.23% 的预热后读取比例，分块为 83.03%，36 次预热后请求均有缓存读取，48 次工具 Schema 全部通过。这验证了官方 DeepSeek 角色隔离字段和统计路径，也表明现行消息布局不普遍阻碍缓存；不把 Go/GLM 的样本推广成全供应商分块要求。不能仅凭同时更换服务端与模型的结果断言网关故障。
