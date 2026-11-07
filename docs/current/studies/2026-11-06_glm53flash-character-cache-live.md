# OpenCode Go GLM-5.3-Flash 角色缓存实验

例如林澄与陆遥轮流回应玩家，每名角色只收到自己的档案校验词。此次实验确认：这条连接能在角色交替时读取各自已建立的缓存，但现行每轮重发的单条上下文 JSON 即使带固定会话 ID，仍没有稳定收益。把稳定资料独立成消息的实验版本改善了读取比例；它尚未进入生产角色上下文。

下面先记录 60 次合成输入对照。用户随后要求使用已有长对话，文末追加了 60 次真实存档历史对照；后者发现同一分块策略下两名角色的命中不一致，不能把首轮的 88.72% 当作稳定保证。

## 环境与方法

- 日期：2026-11-06。用户指定网关 `http://127.0.0.1:3495/v1`，模型列表确认精确 ID 为 `opencode-go/glm-5.3-flash`。
- 网关根接口报告 `magpie 0.1.3135`。走 OpenAI 兼容 Chat Completions，角色使用生产 `createRoleProviders`、`createChatProvider` 及官方 `gatewayTurnCall` 工具 Schema。
- 缓存策略显式选择 `opencode-go`；本机地址的 `auto` 按既定规则解析成 `passive`，不会凭模型名字猜测上游。
- 两名角色、每组各自独立的 Provider、固定且互异的随机 UUID。每组有独立实验标签；没有跨组复用角色的完整资料。每个请求有 64 条合成授权观察，输入约 8500 token；没有加载真实角色隐私、存档或 Key。
- 普通序列每轮追加签到观察并改变最新刺激；没有把模型输出回填，控制不同组的输入长度和历史。连续顺序是 A1–A4、B1–B4；交替顺序是 A1、B1、A2、B2……。
- 请求间隔 1.5 秒，输出上限 512 token，45 秒超时，不重试。配置思考关闭，但部分上游响应仍报告 reasoning token，本实验不验收思考开关。
- 共 60 次正式对照，另有一次连通性冒烟。SSE 原始 usage 只作独立核对；生产运行时仍使用 pi-ai 用量，不新增一套流解析器。

“预热后读取占比”指排除每名角色首次请求之后，缓存读取 token 总和 / 输入 token 总和；它不是请求命中次数，也不是费用节省比例。

## 结果

| 输入布局 | 策略 | 顺序 | 请求数 | 有读取的请求 | 全部输入 / 缓存读取 | 预热后读取占比 |
| --- | --- | --- | --- | --- | --- | --- |
| 现行单条 JSON，每轮增长 | passive | 连续 | 8 | 0 | 68324 / 0 | 0% |
| 现行单条 JSON，每轮增长 | opencode-go | 交替 | 8 | 0 | 68324 / 0 | 0% |
| 现行单条 JSON，每轮增长 | passive | 交替 | 8 | 1 | 68324 / 7616 | 14.84% |
| 现行单条 JSON，每轮增长 | opencode-go | 连续 | 8 | 1 | 68324 / 7616 | 14.84% |
| 每名角色原样重复请求 | opencode-go | 连续 | 6 | 4 | 51006 / 30464 | 89.59% |
| 每名角色原样重复请求 | opencode-go | 交替 | 6 | 4 | 51006 / 30464 | 89.59% |
| 稳定资料与动态尾部拆成消息 | passive | 交替 | 8 | 6 | 68566 / 45696 | 88.72% |
| 稳定资料与动态尾部拆成消息 | opencode-go | 交替 | 8 | 6 | 68566 / 45696 | 88.72% |

原样重复组逐条核对了同一角色的消息与工具定义完全一致。每名角色首次读取 0，之后两次均读取 7616；交替调用没有破坏这次复用。该组全部输入的读取占比为 59.73%，包含冷调用，不能混写成 89.59%。

拆分组保持自己的角色资料、64 条既有观察、当前场景、追加观察、刺激和工具 Schema；只在实验调用中把角色资料与 64 条观察放在第一条 user 消息，其余内容放在后一条 user 消息，并加说明下一条是当前处境。每名角色首次读取 0，之后三次均读取 7616。包含冷调用的全部输入读取占比为 66.65%。这个实验改变了消息组织方式，不能据此宣称生产上下文已改好或自然玩法已验收。

这组数据支持：稳定消息边界值得进入下一步实现和行为验收。它不能证明 Go/GLM 内部缓存算法只按整条消息匹配，也不能证明未来任何路由、账号或负载下都能达到相同比例。拆分后的被动组也命中，说明这条网关自身能处理部分会话与隐式缓存，不能把全部收益归因于新增 UUID。

## 标识、用量与行为核对

应用发出的 `x-opencode-session` 对同一组同一角色始终一致，A/B 不同，且不出现在模型消息中。Magpie 的只读路由记录识别到了全部 36 次显式 Go 请求的对应 UUID；保存时严格按本实验 UUID 过滤，只留模型、时间、状态、请求次数与会话标识，没有保留其他人的路由历史或认证头。

这证明标识到达并被本机网关识别。没有抓取网关发往上游的认证流量，因此不把本机识别直接表述成上游收到同一字符串。Go 官方要求为每个会话提供稳定 `x-opencode-session`，见[官方说明](https://opencode.ai/v2/docs/console/go/)。Magpie 当前公开源码识别该头作为会话来源，见[网关源码](https://github.com/yetone/magpie/blob/main/internal/gateway/gateway.go)；公开主干可能与本机版本有差异。

60 次请求均为 HTTP 200，返回结果事后用实际发送的工具 Schema 经 Ajv 验证，全部通过。SDK 总输入、SDK 缓存读取与 `prompt_tokens`、`prompt_tokens_details.cached_tokens`、`opencode.tokens.cache_read` 逐条一致，写入计数均为 0。两次增长组中偶发命中均为 7616，显示先前的 0 不是 SDK 一概丢失了读取计数。

各次原始 usage 的 `cost` 均为 0，但 `opencode.allowance` 有扣减；正式对照 allowance 合计 0.05923026。不能把 `cost: 0` 解释为没有占用订阅额度，也不能直接用缓存 token 比例替代实际账单。

合成校验词检查中，没有输出另一角色的词。现行布局有 6 次选择不念自己的词，原文均表示保管或私密材料不便透露；原样重复组与拆分组全部正确念出自己的词。该检查只覆盖这份合成输入，不证明完整认知隔离、自然度、动作裁定或真实多人游玩已经验收。

分块 Go 组平均耗时约 2.62 秒，分块被动组约 3.48 秒；小样本顺序、输出与上游思考量不同，不据此承诺延迟改善。

## 复现与证据

脚本：[character-cache-live.ts](../../../tests/experiments/character-cache-live.ts)。下列命令会调用真实模型，应使用新的输出目录：

```powershell
node --import tsx tests/experiments/character-cache-live.ts output/cache-new-baseline
node --import tsx tests/experiments/character-cache-live.ts output/cache-new-exact --exact-repeat
node --import tsx tests/experiments/character-cache-live.ts output/cache-new-split --split-context
```

| 对照 | 汇总与核对 | 原始合成请求和响应 | 本实验网关会话 |
| --- | --- | --- | --- |
| 每轮增长 | [summary](../../../output/character-cache-live-20261106/summary.json)、[analysis](../../../output/character-cache-live-20261106/analysis.json) | [requests](../../../output/character-cache-live-20261106/requests.jsonl)、[samples](../../../output/character-cache-live-20261106/samples.jsonl) | [gateway-sessions](../../../output/character-cache-live-20261106/gateway-sessions.json) |
| 原样重复 | [summary](../../../output/character-cache-exact-20261106/summary.json)、[analysis](../../../output/character-cache-exact-20261106/analysis.json) | [requests](../../../output/character-cache-exact-20261106/requests.jsonl)、[samples](../../../output/character-cache-exact-20261106/samples.jsonl) | [gateway-sessions](../../../output/character-cache-exact-20261106/gateway-sessions.json) |
| 分块增长 | [summary](../../../output/character-cache-split-20261106/summary.json)、[analysis](../../../output/character-cache-split-20261106/analysis.json) | [requests](../../../output/character-cache-split-20261106/requests.jsonl)、[samples](../../../output/character-cache-split-20261106/samples.jsonl) | [gateway-sessions](../../../output/character-cache-split-20261106/gateway-sessions.json) |

脚本未进入默认自动化测试，不会在 `pnpm check` 中发真实请求。本轮新增实验脚本与记录，未修改生产角色消息组织方式、网关配置、核心状态或历史试玩数据。

本轮类型检查、Lint 和格式检查通过，Lint 仍列出既有警告。60 份结果事后按实际请求 Schema 重验通过，独立核对无用量不一致、无会话 ID 混入模型消息。文档链接检查仍因四篇既有研究文档的 103 处失效目标退出 1，另有 24 个非必需历史产物缺失，本轮新增链接未报错。未重跑全仓单测、Launcher 构建或原生发行包；上一阶段的验证范围见[实施记录](2026-11-06_character-prompt-cache-report.md#7-第一版实施结果)。

下一步若继续改善正常游玩的缓存，应在现有角色请求序列化处区分稳定资料与动态处境，复用现有授权与历史窗口，不建立第二份角色历史或持久缓存数据库。记忆更新、滑动窗口、工具资格与场景变化允许失效；需补实际角色互动、最新刺激、私有资料与动作裁定验收。OpenRouter 仍未做真实上游对照；本次结果不能推广到其他供应商。

## 真实存档长历史复测

用户指出合成历史不够长，因此追加使用[节奏试玩](2026-11-story-pacing.md)留下的 `.tmp/pacing-compare-glm2/on-1/world.sqlite`。原局有 30 条玩家发言、148 条全部角色发言；选取 DeepSeek 与 GPT，各自只取分配给本人的 `observation.upsert` 和本人 `character.speak`，不把整局转录合并给两人。数据库以 `readOnly: true` 打开，不创建运行时，不执行迁移，不写入旧存档。

按原存档 seq 1057、1103、1281、1359 四个时间点提取完整授权历史前缀；同 ID 观察采用该时间点最近一次内容。沿用当前生产序列化排序，去除原有诊断元数据，保留真实观察和自发表达。每次只增加一条受控回忆提问，没有回填本实验生成的回答。没有复制文本补长度，也没有保留上一轮的虚构角色或校验词。

| 存档时间点 | DeepSeek：观察＋自发表达 | 原布局实际输入 token | GPT：观察＋自发表达 | 原布局实际输入 token |
| --- | --- | --- | --- | --- |
| seq 1057 | 118＋39＝157 | 36803 | 96＋24＝120 | 29137 |
| seq 1103 | 123＋41＝164 | 38266 | 98＋25＝123 | 29902 |
| seq 1281 | 142＋49＝191 | 44803 | 120＋31＝151 | 35470 |
| seq 1359 | 153＋53＝206 | 49123 | 130＋33＝163 | 39121 |

这是全量授权历史回放，**不是原局逐字节模型请求重放**：没有恢复当时 Core 摘要、截断窗口、动态工具选项或完整现场；固定测试只允许表达与 abstain，不允许行动。模型看到的场景只列本人，当前位置来自截至相应时间点的本人初始位置或移动。这样可以测长历史复用，不能作为实际游玩验收。

分块版从四个时间点中找完全一致的历史前缀，DeepSeek 为 157 条、GPT 为 120 条；将其放进稳定消息，余下真实新经历、当前位置与提问放入动态消息。输入只比原布局多 29 token，范围为 29166～49152。逐条核对重新拼接后的内容，与原布局除独立实验标签外完全一致；稳定首条消息在同组同角色四次请求中完全相同。

### 长历史结果

仍沿用同一 3495 网关、模型、512 输出上限与 1.5 秒间隔。每组每名角色首次请求读缓存均为 0。“预热后读取占比”口径与首轮一致，包含获得 usage 但输出格式错误的请求，因为上游已处理并扣减额度。

| 布局 | 策略 | 顺序 | 请求数 | 有读取的请求 | 全部输入 / 缓存读取 | 预热后读取占比 | 格式失败 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 长历史单条 JSON，自然增长 | passive | 连续 | 8 | 0 | 302625 / 0 | 0% | 0 |
| 长历史单条 JSON，自然增长 | opencode-go | 交替 | 8 | 1 | 302625 / 38080 | 16.09% | 0 |
| 长历史单条 JSON，自然增长 | passive | 交替 | 8 | 0 | 302625 / 0 | 0% | 1 |
| 长历史单条 JSON，自然增长 | opencode-go | 连续 | 8 | 1 | 302625 / 29376 | 12.41% | 0 |
| 长历史分块，自然增长 | passive | 交替 | 8 | 6 | 302857 / 192576 | 81.30% | 0 |
| 长历史分块，自然增长 | opencode-go | 交替 | 8 | 3 | 302857 / 84864 | 35.83% | 1 |
| 长历史原样重复 | opencode-go | 连续 | 6 | 4 | 197826 / 128384 | 97.35% | 0 |
| 长历史原样重复 | opencode-go | 交替 | 6 | 4 | 197826 / 128384 | 97.35% | 0 |

长历史分块的角色差异值得保留：被动组预热后 DeepSeek 三次均读取 35904，GPT 三次均读取 28288；显式 Go 组只有 GPT 三次读取 28288，DeepSeek 三次均为 0。为排除“长请求本身不能缓存”，另外用新 Provider 和新会话 ID 原样重复各角色的第一份长请求，连续与交替的全部预热后请求均命中，读取仍分别为 35904 与 28288。97.35% 包含了两人预热后的全部输入加权；若计入首次冷调用，原样重复组的读取占比为 64.90%。

本次结果修正首轮的推广范围：加长真实历史后仍能读取缓存，交替调用本身也不必然导致丢失；但固定 ID 和稳定消息边界都不能保证这条网关上的两个角色持续命中。分块存在收益样本，尚不足以作为可靠生产改动。标识透传、上游路由、缓存驻留与匹配机制仍需进一步区分；没有抓取上游实际请求，不能把这次零读取归因于某一个内部算法或断言某个 UUID 有问题。

### 长历史核对与证据

60 次正式长历史请求均为 HTTP 200，58 次通过实际工具 Schema 验证，2 次把 `segments` 数组输出成字符串。失败分别位于 GPT 的被动原布局第 4 次与显式 Go 分块第 4 次；未修补模型原文或放宽校验。缓存计数与输出格式分开统计。

60 次的 SDK 用量均与原始 `prompt_tokens`、`cached_tokens`、`opencode.tokens.cache_read` 一致。36 次显式 Go 请求均在本机网关记录中识别到相应角色固定 UUID，UUID 未进入模型消息。分块 Go 组每名角色的四次路由记录只出现一个尝试目标标识、每次只有一次尝试；这排除了这些记录里可见的逐次目标切换，不能证明目标背后的实例或实际上游请求头稳定。

历史审计将每条请求重新与对应时间点、对应角色的原始观察及自发表达比较，60 次全部一致；分块的 16 次重新拼接后也与原布局一致。未把另一角色的私有资料或未来时间点的观察补入输入。原世界库大小与修改时间保持不变。本轮没有使用合成校验词检查模型的跨角色泄漏，也未验证自然互动质量；不能用摘要里的旧零计数字段代替未做的行为检查。

长历史正式请求 `opencode.allowance` 合计 0.26290272；`cost: 0` 仍不代表没有消耗额度。没有以小样本延迟或 token 比例推算账单节省。

| 产物 | 入口 |
| --- | --- |
| 原布局 32 次 | [配置与历史计数](../../../output/character-cache-long-save-20261106/config.json)、[汇总](../../../output/character-cache-long-save-20261106/summary.json)、[请求](../../../output/character-cache-long-save-20261106/requests.jsonl)、[响应及用量](../../../output/character-cache-long-save-20261106/samples.jsonl) |
| 分块 16 次 | [汇总](../../../output/character-cache-long-split-20261106/summary.json)、[请求](../../../output/character-cache-long-split-20261106/requests.jsonl)、[响应及用量](../../../output/character-cache-long-split-20261106/samples.jsonl)、[路由核对](../../../output/character-cache-long-split-20261106/routing-diagnostic.json) |
| 原样重复 12 次 | [汇总](../../../output/character-cache-long-exact-20261106/summary.json)、[请求](../../../output/character-cache-long-exact-20261106/requests.jsonl)、[响应及用量](../../../output/character-cache-long-exact-20261106/samples.jsonl) |
| 来源与归属核对 | [源库元信息](../../../output/character-cache-long-save-20261106/source-metadata.json)、[前 48 次历史及分块等价核对](../../../output/character-cache-long-save-20261106/history-audit.json)、[全部 60 次核对](../../../output/character-cache-long-save-20261106/combined-analysis.json) |

同一实验脚本新增 `--history-save`，只支持本轮明确选取的 DeepSeek/GPT 存档结构；缺角色、历史不足四条玩家发言或包含多个分支时直接失败，不增加通用存档兼容层。复现仍须新目录：

```powershell
node --import tsx tests/experiments/character-cache-live.ts output/cache-new-long --history-save=.tmp/pacing-compare-glm2/on-1
node --import tsx tests/experiments/character-cache-live.ts output/cache-new-long-split --split-context --history-save=.tmp/pacing-compare-glm2/on-1
node --import tsx tests/experiments/character-cache-live.ts output/cache-new-long-exact --exact-repeat --history-save=.tmp/pacing-compare-glm2/on-1
```

本轮只改实验脚本和记录，未推广生产分块，未改网关配置。类型、Lint、格式检查通过；未重跑全仓单测、Launcher、原生发行包或完整玩法。后续优先核对该网关到 Go 的真实会话与路由行为，再决定生产消息分块范围。

后续用户授权使用自己的 DeepSeek Key，将同一份长历史直连官方接口完成 48 次对照：原布局连续与交替的预热后读取占比均为 90.23%，实验分块为 83.03%，36 次预热后请求全部有读取、48 次工具 Schema 均通过。它说明不能把 Go/GLM 的结果推广为所有供应商都需分块，也不能仅凭更换模型与供应商的结果认定 Magpie 有缺陷。详细条件与证据见[DeepSeek 官方对照](2026-11-06_deepseek-character-cache-live.md)。
