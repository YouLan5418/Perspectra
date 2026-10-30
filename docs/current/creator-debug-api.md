# 创作者只读调试接口

核对日期：2026-10-21。本次核对状态字段与宿主迁移，原有原生点击和真实模型验收限制保留。世界快照、完整事件历史、私有调用记录与预设快照接口已接通。后端改版将创作者入口移到同源浏览器页面；Launcher 前端改版独立交付，完整发行包尚未重建。

例如钥匙已经交给另一名角色，但角色仍说自己拿着：先查 entities 的保管关系和最近事件，再选中角色查 currentView 的授权观察、latestRequest 的清洗后历史与本次召回，最后检查长期记忆来源。工具只读已安装数据，不执行交互、召回、补齐来源或调用模型。

## 从浏览器创作者页读取

例如创作者要检查晚餐时钥匙的去向：游戏启动后，由 Launcher 发出 `open-creator`，Rust 校验本机地址和令牌后用系统浏览器打开 `/creator/#token=…`。旧的 `creator-debug / creator-history / creator-records / request-inspector` Launcher operation 已删除；HTTP 路由保持原样；2026-10-21 将检查响应的 variables 更名为 statusTruth，控制台已同步。

| 路由 | 用途 |
| --- | --- |
| GET /api/creator-meta | `{ title, storyline, characters: [{ id, name }], locations?: [{ id, name }] }`；角色来自包中可调用角色列表，与预设选择同源；locations 是包声明的公开地点名，2026-10-30 起提供，旧宿主没有 |
| GET /api/creator-debug | 当前世界、角色视图、状态真值、活动和 Core 档案 |
| GET /api/creator-history | 对话事件、受众、行动参数、裁定与物品历史 |
| GET /api/creator-records | 已保存请求、响应、思考、预设与执行关联 |
| GET / POST /api/request-inspector | 读取采集状态，或用 `{ enabled: boolean }` 修改采集开关 |
| GET / POST /api/creator-stage | 读取默认舞台的 `stage.json` 与可标记立绘；POST `{ characterId, framing, face? }` 把一个角色的取景和脸部框写回包里 |

`/api/creator-stage` 的 POST 是这里唯一写文件的接口：只写世界包的 `frontend/stage.json`，只替换该角色的 `framing` 和 `face`，按载入时的规则校验后整文件替换；不合格返回 400 和原因，文件不变。它不触碰世界事实或存档。包使用自己的 `index.html` 时不可写。

页面用同源 fetch 携带 `x-playtest-token` 读取上述数据。例如拿到本页宿主 token 后查询某角色：

```typescript
const response = await fetch('/api/creator-debug?characterId=character%3Acompanion&limit=50', {
  headers: { 'x-playtest-token': token },
})
if (!response.ok) throw new Error(`创作者数据读取失败（${response.status}）`)
const detail = await response.json()
```

静态页本身公开，数据接口需要宿主令牌和同源检查；游戏 iframe 的 SDK 与 Frontend API 均不开放这些接口。`/creator/` 使用 `script-src 'self'`，不放宽玩家宿主页 CSP；开发资源目录为 `apps/launcher/dist-creator`，打包运行时为 `runtime/creator-assets`。资源目录缺失返回 503「创作者页面未构建」，越界路径返回 404。故事线名称由启动时 `PERSPECTRA_STORY_NAME` 传入，命令行直接启动时默认「主故事线」。

本次已验证静态页、鉴权、路径穿越和打包后接口；原生 Launcher 点击、真实模型长会话及完整便携发行包未验收。旧版 Launcher 内控制台的界面记录保留在下文，前端改版合并后才形成完整新流程。

## 查询参数

| 参数 | 行为 |
| --- | --- |
| characterId | 可选；必须是本世界已声明角色。省略时只读世界总览 |
| afterSeq | 可选；返回该事件序号之后的记录。省略时返回最近 limit 条；设为 0 从开头遍历 |
| limit | 默认 50，范围 1～100；同时限制事件页和每个记忆分层的条数 |
| memoryOffset | 默认 0；每个记忆分层各自从此偏移读取 |

未知字段、重复 HTTP 参数、非法分页、未知角色或超过当前 headSeq 的游标返回 400；无宿主令牌返回 401，错误 Origin 返回 403；世界切换期间返回 409；未接入接口的运行入口返回 404。损坏数据校验失败返回 500，不作为空档案处理。接口不接受文件路径、任意命令或写入参数。

## 返回内容与含义

类型定义见 [CreatorInspectionSnapshot](../../desktop/host/creator-inspection.ts)，实现见 [运行宿主](../../desktop/host/world-runtime.ts)。

| 字段 | 内容与边界 |
| --- | --- |
| capturedAt / address / worldVersion / headSeq / tick | 当前采集时间、世界地址、运行版本、已提交前缀与 tick；返回整份快照的身份 |
| title / packHash / storyParentNodeId | 当前游戏标题、包身份和故事线起点节点；没有父节点时为 null |
| busy / paused / captureEnabled | 当前宿主状态及实际请求采集开关 |
| characters | 全部声明角色的位置、场景、生命周期和最近移动事件；processing.transport 是最近捕获请求的传输状态，lastActivation 是最近已完成反应周期中的角色结果 |
| entities | 事件日志重建的受追踪实体状态、最近变更。holderId 表示保管或携带，未单独追踪法律所有权。effectiveLocationId 可以来自保管者位置，locationBasis 明示推导来源；不能据此宣称精确姿态或桌面位置 |
| statusTruth | 2026-10-19 起为状态脚本的全部真实值 `{ public, characters }`，由事件日志推导；包没有 `scripts/status.js` 时为 null。读取不运行作者脚本。玩家和角色只看到各自上次确认的值 |
| activities | 各活动最近提交状态，含参与者、game 的公开／私有／内部变量；未开始的 state 为 null。这些信息仅限创作者宿主 |
| events | 事件页、nextAfterSeq 和 hasMore。后续用 nextAfterSeq 继续读取；完整记录保留事件类型、数据与序号 |
| character.currentView | 当前 headSeq 的授权观察、认识、目标等；它不是过去某次模型的实际请求 |
| character.latestRequest | 该角色最近一次捕获的实际请求，含清洗和预设处理后的 messages、contextParts、模型、时间、传输状态及 usage。无采集记录或已被容量淘汰时为 null；asOfWorldSeq 仅在已有认知前缀可用时附带 |
| character.memory | Core 已安装档案中的各数组分层分页，例如 sources、facts、episodes、observations；archivePrefix 标明整理边界。maintenance 显示该角色待整理前缀和正在运行／排队的任务。原生完整档案尚未接入，明确返回 native 与限制说明 |

本次实际召回内容位于 `latestRequest.contextParts` 中名为 `memories` 的分项。长期档案有某条记忆，并不证明它在这次被发送给模型；认识和对白也不等于权威世界事实。

信息受众依据 `observation.upsert` 的 `data.value.observerId` 和实际观察内容检查。对白的 addresseeIds 是交谈对象，不能当作全部听众；分页跨过相关事件时继续读下一页，不推测缺失受众。

请求检查器仍展示全局最近 4 条，额外保存每角色最近一次调用；角色快照限制为 32 个角色及约 800 万序列化字符，优先淘汰最早捕获角色。停止采集、清空或关闭运行时清理这些临时快照，**不会删除已保存的私有记录**。关闭检查器窗口不停止采集；开关保存在逻辑故事线数据目录，重启后继续沿用。第一次使用默认关闭。

单请求正文与提取后响应各自最多 100 万 UTF-16 字符，超限明确 omitted。响应仅保留模型正文、服务返回的思考／摘要、工具名称及参数、结束原因和用量；不保存认证头、Provider 配置、HTTP 错误正文、思考签名或未知信封字段。作者主动写入上下文的私密文本仍属于私有调试数据。

## 阅读完整对话与追踪物品

例如创作者检查“玩家声称交出了钥匙，但钥匙仍在自己手里”：先按物品查询取得、转交、随携带者移动和失败尝试，再打开相关对白及实际观察，最后用行动关联查询模型记录。发言不能单独证明转交成功。

`GET /api/creator-history` 的类型及推导实现见 [creator-history.ts](../../desktop/host/creator-history.ts)。读取完整已提交前缀后再分页，不受玩家 transcript 窗口限制，不执行预设、模型、召回或记忆整理。

| 参数 | 含义 |
| --- | --- |
| afterSeq / limit | 从 afterSeq 之后开始；默认 0 / 50，limit 为 1～100 |
| eventSeq | 精确定位某个事件；仍受其他筛选约束 |
| characterId / entityId | 按行动者或观察接收者、受控物品筛选；未知角色／物品返回 400 |
| eventType | 精确事件类型，例如 character.speak、action.resolved |
| status | accepted / rejected，只筛选 action.resolved |
| search | 在事件及对应行动中搜索，最多 200 字符 |

每条 items 保留完整 event，并附 actorId、actionId、已校验 Round authority 中的 action 参数、实际观察 recipients 和 relatedSeqs。受众的 full / occurrence_only 根据该行动的观察内容生成，不把 addresseeIds 当成全部听众；跨分页也能取得受众。观察记录自身的正文仍保留在原事件中，可查看每个角色实际收到的不同内容。

按 entityId 查询时，entityChange 提供保管／地点状态 before、after；followsHolder 标明随保管者移动。拒绝行动有参数与结果，但不生成物品状态变更。查询只按结构化实体目标建立关联，不从对白关键词推测物品已转移。尚未结构化追踪的物品属性不会补造。

返回 headSeq、tick、worldVersion、scope、nextAfterSeq 和 hasMore。过滤后末页的游标直接推进至采集前缀，继续轮询可读取新增事件。Tail 宿主额外返回 selection，包含当前末端回合、候选 ID 和候选列表；切换期间返回 409。已提交事件只有逻辑 tick 和序号，不伪造历史墙钟时间。

## 查看调用、思考和当时生效的预设

`GET /api/creator-records` 的类型和本地记录实现见 [creator-records.ts](../../desktop/host/creator-records.ts)。列表仅返回摘要，点击后以 recordId 读取正文。

| 参数 | 含义 |
| --- | --- |
| recordId | UUID，定位正文；不存在或不在所选范围内时 record 为 null |
| kind | request / decision / action / turn / recall |
| characterId / decisionId | 筛选角色或同一次决策关联组 |
| branchId / worldVersion | 默认当前候选 branchId，可显式检查返回 branches 中的其他本地候选；worldVersion 可继续细分运行版本 |
| status / search | 按摘要状态或全文搜索；字符串最多 200 字符 |
| offset / limit | 默认 0 / 50，limit 为 1～100 |

返回 items 摘要、total、nextOffset、hasMore、可用 branches 和可选 record。scope 包含世界地址、worldVersion、候选 branchId、运行 runId；不是绝对文件路径。storageError 非空表示本次运行有诊断写入失败，不得宣称采集完整。

request 的 data 保留实际 messages、上下文分项、最终请求 body、用量及 response。response.thinkingStatus 区分 provided / not_provided；thinking.kind 为服务提供的正文 text 或摘要 summary。Google 的 thought 文本按摘要标记；不还原未返回内容，不捕获隐藏思考。pending 表示只记录到开始，重启后也不推测其最终结果。传输成功不等于动作通过裁定。

request.preset 保存当时的最终 RolePreset 值和来源：默认、角色专属或角色组。Launcher 启动的默认预设另标明 auto / global / custom 及全局、包推荐或实例配置层；直接启动入口标记 pack / explicit。消息 source 保留节点 ID、名称、插入位置、原文与是否宏展开；messages 给出带来源的逻辑消息顺序、role 和正文；Anthropic / Google 的 system 合并与角色映射后的真实传输结构以 body 为准。禁用节点仍存在于预设快照中，但不会伪装成已发送消息。命名库应用时是复制配置，现有配置不保留库条目身份，接口不反推原库名称。

request、decision、action、turn、recall 通过 decisionId 关联。格式重试的多次请求属于同一决策；action 含 actionId、参数、结果、实际提交 eventRefs、起始时间与裁定加提交耗时，可跳回事件历史。decision 是预设输出处理后的提案，source 区分 model / script，不能当作已提交事实；turn 记录沉默、过期、取消、失败和预算停止。主动原生 recall 有查询与返回证据，Core 实际交付仍查看请求中的 memories。未提交就抛出的存储故障不会补造成功记录。

私有文件位于逻辑数据目录的 creator-debug 下：每次调用更新同一记录，其他执行记录单独保存；不进入世界事实、角色上下文、记忆来源、故事节点快照或分享包。重新生成仅继承生成起点前的本地历史引用，原始 scope 保留，旧尾部不会混入新候选；停止采集不删除历史。由其他机器导入的节点不能恢复原机器未分享的诊断记录。

## 创作者控制台

下面保留改版前的界面记录。原 Launcher 游戏详情里的「创作者控制台」是全窗口只读界面，进入后左侧是游戏、故事线与角色，中间是阅读与检索，右侧是选中内容详情。运行中的实例直接读上面三个接口；浏览器 Mock 预览（`launcher:dev`）改用结构相同的固定样例，不连接真实实例。

- 顶部两行：第一行是运行身份与宿主状态，第二行是视图切换、筛选和刷新；底部状态栏显示采集开关、最近更新、事件／记录条数、失败与收起条数。
- 「对话」按连续阅读排版，正文最宽约 880px。已提交表达带头像、角色、序号和受众标签；模型思考默认折叠在对应回应上方，工具调用与召回作为紧凑条目穿插；被拒行动显示为行动行。NPC 发言按 `segments` 显示，旁白以括号斜体与对白区分；发言的受众已在消息头标出，对应的通过行动与逐人观察不再重复列出；其他行动分发给多位观察者时合并为一行；世界 tick 推进显示为分隔线。
- 「轨迹」顶部是序号区间的概览条，下面是紧凑表格（类型／角色／摘要／结果／耗时或序号），支持角色、物品、类型、状态筛选与全文搜索。观察摘要依次取对白、移动和结果说明，不在列表里平铺原始 JSON；行动 ID、roundId 等内部标识只在右侧详情显示。点条目打开右侧详情。
- 右侧详情按对象变化：模型调用有概览／上下文／预设／响应／思考／计时，行动有概览／参数／结果／Schema／计时，事件有正文／受众／来源／关联记录，物品有当前状态／流转历史／角色观察；原始 JSON 固定在最后一级。面板可拖动、可关闭，窄窗口改为覆盖式抽屉。
- 世界总览、角色、物品、状态、活动页共用同一套紧凑列表框架，物品流转和角色处理过程使用纵向时间线。
- 2026-10-23 新增「立绘标记」页：在立绘上拖动头顶线、腰部线和脸部框，右侧按默认舞台的取景公式预览，并可叠加已声明的表情检查贴片位置；保存走 `/api/creator-stage`。浏览器预览没有立绘，不能保存。

前端的合并规则只使用接口已有证据：行动记录按 `eventRefs` 或匹配的 `action.resolved` 落位到对应已提交事件之前，并取代同一行动的裁定事件行；轮次落在所属回合的事件之后；读取不到正文的记录只显示「已记录」，不把未知状态写成未命中或失败。失败、取消与未发表的处理默认收在「显示处理过程」之后，状态栏给出计数。

历史接口只有正向游标，所以初始读取从 `headSeq` 向前取一页，更早内容按 `afterSeq` 逐页向前；记录按 `offset` 从尾部读取。两者都按 id 或序号去重后合并，轮询只追加新内容并刷新尾窗，不重排已读位置。旧记录阅读时新内容进入「新增 N 条」按钮，不自动跳转。

## 运行时间线

例如创作者想知道“GPT 做蛋炒饭之后谁知道了这件事”：在「运行时间线」里搜索 `#1018` 并点中 GPT 泳道上的 interact 块，页面高亮同一提交里的状态更新（#1015）、锅与餐盘的变更（#1016、#1017）、世界刻推进（#1022）和三条观察（#1019–1021），详情「链路」页列出 Claude、GPT、玩家收到了完整观察，DeepSeek 没有该行动的观察记录（她当时在水族馆）。旁边无关的发言不会被连上。

时间线只读 `/api/creator-history` 与 `/api/creator-records` 已有的数据，不新增事实来源，不调用模型，不改调度或存档。实现：[timeline.ts](../../apps/launcher/src/creator/timeline.ts) 负责泳道、排列、筛选、墙钟可用性与关联规则，[TimelineView.vue](../../apps/launcher/src/creator/TimelineView.vue) 负责绘制与交互，[ChainSection.vue](../../apps/launcher/src/creator/ChainSection.vue) 是详情里的「链路」页。

- 横轴默认「世界顺序」：每块一列，按已提交序号排序，按 tick 分组；列宽只表示先后，不表示时长。缩小到每列不足 16px 时按 tick 聚合，聚合块宽度表示条数。私有记录没有 tick，沿用落位处之前最近事件的 tick。
- 「实际耗时」只显示带墙钟时间的采集记录：模型请求按 startedAt + durationMs 画条形，行动记录读到正文里的 startedAt 时才画条形，其余为瞬时标记；已提交事件没有墙钟时间，在该模式下不显示。没有任何采集记录时该模式禁用并说明原因。
- 纵向泳道：玩家（由裁定事件的 sourceRole 或 manual 控制者识别）与各角色泳道只放发言、移动和已提交行动；系统泳道分角色处理（模型、上下文、决策、召回、反应周期）、规则裁定（采集到的行动记录与校验拒绝）、世界状态、观察投递，可折叠为一条或整体隐藏。同一行动投递给多人的观察合并为一块；同一事务、同一行为者的已通过裁定并入对应的发言或移动块。
- 筛选：角色、类型、结果（成功／拒绝／失败／中断／处理中／中性）、关键词、只看异常、只看当前角色。生效的筛选以标签显示，可逐个或一键清除，并显示隐藏条数；顶部的角色、物品、搜索是服务端载入范围，同样以标签提示。
- 交互：滚轮缩放，Shift+滚轮或触控板横扫平移，拖动画布平移，←／→ 切换选中事件，概览条点击或拖动跳转。手动移动后暂停跟随最新，回到最右端恢复；轮询新增不会把阅读旧记录的人拉回去。载入更早事件时保持当前可见事件的位置。增量刷新失败保留已载入内容并提供重试。
- 与轨迹页互相定位：详情顶部的「在轨迹页查看／在时间线查看」定位同一事件；轨迹页用行动记录取代裁定事件时自动换成对应行动行，并在需要时展开处理过程。角色详情可跳到只看该角色的时间线，物品流转可跳到对应事件。

关联只来自显式标识，按强度依次为：同一行动（共享 actionId）、行动记录引用（采集记录的 eventRefs）、同一决策（decisionId）、同一原子提交（transactionId）、同一处理周期（裁定事件的 participantId）。发言与移动事件多数不写 actionId，只在同一事务、同一行为者的裁定事件存在时借用其 actionId。时间相邻、同 tick、同场景都不构成关联；首版不画推测关联。一次提交含多个行动时，链路页明示状态变更不能归到某一个行动。

「变更前 → 变更后」只取已载入事件里同一物品或同一状态键的上一条记录，未载入时写「前值未载入」；行为者位置只按已载入的移动或创建事件推导。受众来自服务端按完整前缀推导的 recipients；未收到观察记录的角色单独列出，不表示他们之后不会从别人口中得知。

2026-10-30 用甜蜜日程真实存档的副本验收（1184 条事件，未开启采集，模型指向不可达端口）：蛋炒饭链路、DeepSeek 与玩家分别往返水族馆的七次独立移动、发言受众隔离、跨页定位、载入更早时位置不跳、缩小聚合均与预期一致，验收前后 headSeq 与 tick 不变。该存档没有被拒行动和采集记录，失败、预算耗尽与实际耗时模式只有单元测试覆盖，尚未在真实记录上验收；数千条事件下的流畅度只按可见范围渲染设计，未做性能测量。

缺口：没有记录哪个刺激触发了某次角色处理，也没有记录模型请求实际用到了哪些观察（请求只带 asOfWorldSeq），因此“玩家发言触发角色回应”和“后续回应依据了哪些信息”不画关联。断点调试未实现；若以后要做，最小扩展是在 CharacterTurn 的 decide、resolveAction 与提交前三处各加一个只读钩子，把当时的请求、提案和待提交事件写进现有 creator-records，时间线按 decisionId 落位即可。

## 需求覆盖与接受的限制

| 前端需求 | 当前数据支持 | 第一版状态 |
| --- | --- | --- |
| 完整已提交对话、私密受众 | creator-history 的原始发表与观察事件，包含结构化表达片段 | 已接入 |
| 模型输入、返回、思考、预设 | creator-records 的 request；需事先启用采集 | 已接入 |
| 行动、裁定、失败与关联跳转 | creator-history + creator-records 的 action / decision / turn | 已接入 |
| 受控物品当前状态与流转 | creator-debug.entities + creator-history.entityId | 已接入，随携带者移动单独标注 |
| 角色视图、Core 档案、状态与活动 | 现有 creator-debug；原生完整档案限制保持明确 | 已接入 |
| 搜索、筛选、增量更新 | 事件游标、记录分页和筛选；前端定时读取，不新增推送协议 | 已接入，轮询间隔 3 秒 |
| 运行时间线与确定关联 | creator-history 的 transactionId、actionId、participantId 与 recipients；creator-records 的 decisionId、eventRefs 与计时 | 2026-10-30 接入，见上文 |
| 书签、备注、片段导出 | 仍属后续需求 | 未实现 |

## 验证与当前限制

自动化覆盖宿主权限、Frontend API 拒绝访问、严格查询、跨页受众、物品转移／拒绝／随携带者移动、调用超过最近 4 条、预设快照、服务返回思考、重启、候选隔离与前缀继承、记录损坏和诊断写入失败；参见 [观测回归](../../tests/host/creator-observability.test.ts)、[候选回归](../../tests/host/tail-round.test.ts)、[请求回归](../../tests/host/request-inspector.test.ts)。既有 Core 来源校验与只读检查不触发 catch-up 的边界保持。

不推测未发生的处理机会、角色意图或不可见记忆；lastActivation 与最新传输状态可能来自不同处理时刻。状态的每次变更都是可在事件历史里查到的 `status.updated`。没有过去世界任意时刻完整状态预览、原生完整记忆档案、逐条清洗规则轨迹、未进入执行器的失败输入完整日志或自动诊断。历史检索扫描本地文件，尚未做长会话容量与延迟验收；不自动淘汰持久记录。

控制台第一版已在浏览器 Mock 预览下核对布局、对话排版、轨迹表、详情分页、物品时间线和窄窗口抽屉，并用固定样例对纯函数合并规则加了单元测试；尚未在真实运行实例、真实模型长会话或发行包里验收。为定位记录与事件的对应关系，窗口内的记录会逐条读取正文并常驻内存缓存，长会话下的请求量尚未测量；更早历史逐页向前的翻页成本同样未验收。
