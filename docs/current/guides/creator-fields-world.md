# 世界包基础内容字段清单

依据当前 `main` 的 World Pack v5 源码整理，核对基线为 `bde72bd40b76eef9579099f32f89f88929a6406c`。这里列的是创作者**输入**：例如让同行者开局在前室、知道桌上有钥匙，可以分别填写角色位置、场景成员和该角色的初始观察。编译出的哈希、锁、运行时 Manifest、事件 ID 和记忆索引由程序生成，不是这些源文件中可自由填写的字段。

“必填”指所在对象存在时必须提供；“选填”指可以省略，默认值按下表。核心源文件的 JSON 对象使用封闭字段，未知字段会被拒绝。ID、名称等多数标识文本须非空、首尾无空白且不含 ASCII 控制字符；`description`、Markdown 正文和 JSON 值中的自由内容按各自解析规则处理。引用必须指向同一个包内已声明对象。路径使用 `/` 分隔的包根目录相对路径，不能使用绝对路径、`..`、反斜杠、Windows 设备名或大小写冲突的重复路径；列出的文件必须存在且解析后仍在包目录内。详见[字段解析](../../../packages/world-pack/src/schema.ts)和[编译及引用检查](../../../packages/world-pack/src/compiler.ts)。

本页涉及清单中的全部顶层入口和普通内容；活动、玩法脚本、插件组合、模型预设、前端与美术字段以相应专项说明为准。语法通过并不证明真实模型体验或发布包已验收。

## 1. 清单与来源路径

`worldpack.source.json` 是显式清单，源文件不靠目录扫描自动加入。它必须写如下键；数组标注可空是指键仍然必填。见[源清单解析](../../../packages/world-pack/src/schema.ts#L366)。

| 字段 | 必填及内容 |
| --- | --- |
| `sourceSchemaVersion` | 必填，固定 `worldpack-source/v5`。 |
| `packId` | 必填，包的稳定 ID，例如 `pack:my-world`。 |
| `packVersion` | 必填，精确版本，例如 `1.0.0`；不接受版本范围。 |
| `worldFile` | 必填，世界 JSON 路径。 |
| `characterFiles`、`locationFiles`、`sceneFiles` | 必填，路径数组且各至少一项，分别列出角色、地点、初始场景文件。 |
| `playerSlotFiles`、`presentationFiles` | 必填非空路径数组。每个玩家槽文件恰有一个槽、合并后也只能有一个槽，因此实际只能列一个玩家槽文件；展示文件则由编译器直接要求恰好一个。 |
| `entityFiles`、`cognitionFiles`、`memoryFiles` | 必填数组，可为空；分别列出对象、初始认知和记忆配置文件。 |
| `documentFiles`、`markdownFiles` | 必填数组，可为空；前者列文档元数据 JSON，后者列被引用的 Markdown 正文。 |
| `assetFiles`、`assertionFiles` | 必填数组，可为空；前者登记宿主要读取的文件，包括 `knowledge.json`、脚本等，后者登记断言 JSON。 |
| `reactionFile`、`manifestationFile`、`interactionFile` | 必填，分别指向反应、表现、交互选择配置；各文件使用自己的版本，详见第 7 节。 |
| `requiresPlugins`、`plugins`、`services`、`scripts` | 选填：插件依赖、显式插件选择、服务要求和共同脚本入口；见[创作指南](world-pack-authoring.md#b7-显式组合与共同脚本源码)及[插件接口](plugin-seams.md)。 |

路径在所有清单列表和单文件字段之间不能重复，忽略大小写后也不能冲突。最多登记 4096 个文件；源 JSON 单文件最多 1 MiB，Markdown 最多 256 KiB，普通资产最多 8 MiB；已登记源内容合计最多 16 MiB，编译结果另有 16 MiB 上限。个别宿主配置还有更小的限制。编译器读取的核心源 JSON 使用 UTF-8、只能含安全整数（不含负零），不能有注释、尾逗号或重复键；作为资产读取的其他 JSON 按各自加载器检查。Markdown 也须为 UTF-8；CRLF 会规范化为 LF，不接受单独的 CR。

## 2. 世界、初始事实与玩家

`worldFile` 指向的 JSON 见[世界解析](../../../packages/world-pack/src/schema.ts#L1016)：

| 字段 | 必填及内容 |
| --- | --- |
| `schemaVersion` | 必填，`worldpack-world/v1`。 |
| `title` | 必填，世界名称。 |
| `description` | 选填，世界简介；默认空串。 |
| `timeMode` | 选填，仅 `TURN_DRIVEN`，默认相同。 |
| `roundQueueLimit` | 选填，安全整数 1–1024，默认 `8`。 |
| `coreProfiles` | 选填；省略使用当前固定组合。若写出，四项都必须与下表固定值完全相同，不是任意插件选择入口。 |
| `initialFacts` | 选填，默认 `[]`；每项为下表事实，`factId` 不重复。 |
| `playerInputPolicy` | 选填，对象仅含必填 `version`：`legacy-speech/v1` 或 `player-intent/v1`；省略运行时使用前者。当前后者仍是确定性命令／发言解析，普通文本作为发言，不能凭名称推断启用模型解释。 |

`coreProfiles` 若填写，完整值为：

```json
{
  "rulebook": { "rulebookId": "builtin:speak-move", "version": 2 },
  "sceneDecision": { "pluginId": "builtin:scene-decision", "version": "2.0.0" },
  "agentContext": { "pluginId": "builtin:agent-context", "version": "2.0.0" },
  "presentation": { "profileId": "builtin:deterministic-presentation", "version": "1.0.0" }
}
```

每条 `initialFacts[]` 的 `factId`、`proposition`（合法 JSON 值）和 `initialAudience`（非空、不重复的角色 ID 数组）均必填。名称虽叫 initialFacts，[开局转换](../../../packages/world-pack/src/compiler.ts#L768)会为每位受众生成一条 `believed` 的初始主观 claim；这不会替代位置、物品归属或玩法状态等权威事实。

玩家槽文件根对象必须有 `schemaVersion: "worldpack-player-slots/v1"` 和 `playerSlots`；数组恰好一项。该项 `slotId`、`characterId` 必填，`controlMode` 选填且只允许 `manual`，默认 `manual`。角色必须存在并使用 `controllerClass: "manual"`。开局场景和位置仍分别在下面的场景和角色文件填写。见[玩家槽解析](../../../packages/world-pack/src/schema.ts#L1322)及[跨文件检查](../../../packages/world-pack/src/compiler.ts#L459)。

## 3. 角色、人设、地点、对象和场景

角色文件根对象的 `schemaVersion` 必填 `worldpack-characters/v3`，`characters` 必填数组。每个角色：

| 字段 | 必填及内容 |
| --- | --- |
| `characterId`、`displayName` | 必填，角色 ID 和名称。 |
| `controllerClass` | 必填，`manual` 或 `scripted`；后者不要求作者写死角色台词。 |
| `pronouns` | 选填，默认空串。 |
| `initialLocationId` | 选填或 `null`，默认 `null`；非空时必须是已声明地点。 |
| `lifecycle` | 选填，`active`、`incapacitated`、`dead`、`departed`；默认 `active`。 |
| `portrayal` | 选填或 `null`，默认 `null`；对象内字段见下。 |
| `interactionBindings` | 选填，角色上的交互绑定数组，字段与对象绑定相同，见下方。 |

`portrayal` 内字段均选填：`summary` 人设摘要和 `speakingStyle` 说话风格默认空串；`backgroundTextRef` 默认 `null`，非空须是 `markdownFiles` 登记的路径；`drives`、`principles` 默认空数组，每项都必须有 `key`、`text`，每数组最多 128 项。同一角色的人设条目 key 与认知记录 key 合计不得重复。`backgroundTextRef` 目前可解析并校验引用，但这里未核实它会自动展开进模型请求；需要按条件交付正文时应使用第 5 节的知识配置。

地点文件根对象必须有 `schemaVersion: "worldpack-locations/v1"`、非空 `locations` 数组；每项 `locationId` 和 `name` 均必填。对象文件根对象必须有 `schemaVersion: "worldpack-entities/v2"`、`entities` 数组；每项 `entityId`、初始 `locationId`、`kind` 必填，`name` 和 `interactionBindings` 选填。`locationId` 必须指向已声明地点。此处给对象初始地点，没有源字段可直接填写初始 `holderId`；持有与后续转移走已裁定的物品机制。角色和对象的 `interactionBindings[]` 各项必填 `bindingId`、`definition: { id, version }`、`config` 对象，选填 1–60 字符的 `label`；版本是正整数，具体 config 由所选交互定义决定，详见第 7 节和[交互绑定解析](../../../packages/world-pack/src/schema.ts#L1111)。

场景文件根对象必须有 `schemaVersion: "worldpack-scenes/v2"`、`scenes` 数组。每项必填 `sceneId`、`lifecycle`（`created`、`active`、`closed`）、`participantIds` 数组；`locationId` 选填或 `null`，默认 `null`。活动中场景 `active` 的参与者不能为空；角色和地点引用必须存在，同一角色不能同时属于多个 active 场景。场景参与关系与角色初始地点是分别声明的字段。见[角色／场景解析](../../../packages/world-pack/src/schema.ts#L547)和[开局编译](../../../packages/world-pack/src/compiler.ts#L1135)。

跨文件合并后，同类角色、地点、对象、场景、文档 ID 不得重复；单份角色、地点、对象、场景文件上限分别为 256、512、512、512 项，编译包读取时也会校验合并结果。角色、地点、对象和场景不提供任意额外字段；自由设定应放人设或文档，玩法状态应由已启用的玩法定义初始化，而不是向对象随意添加属性。

## 4. 初始认知与记忆配置

认知文件根对象必须有 `schemaVersion: "worldpack-cognition/v2"`、`characters` 数组。每项必填 `characterId`，选填以下八类数组；省略均为 `[]`。无对应认知文件或角色条目时，编译器为该角色补八个空数组。它们是该角色各自的初始认识，并非允许其他角色读取的公共真值。见[认知解析](../../../packages/world-pack/src/schema.ts#L590)和[Genesis 转换](../../../packages/world-pack/src/compiler.ts#L689)。

下面每项的 `key` 均必填；各记录共同的 `basisKeys` 选填，默认 `[]`。同一角色的八类记录共用 key 命名空间，不能与该角色的 `drives`、`principles` key 重复。`basisKeys` 和非空 `parentGoalKey` 只能引用本角色已有记录或人设条目，依赖不能成环；并不引用其他角色的私密认知。后缀 `Permille` 的值均为 0–1000 的整数。

| 数组 | 每项必填 | 每项选填及默认 |
| --- | --- | --- |
| `observations` | `key`、`content`（JSON 值）、`epistemicKind` | `saliencePermille: 500`、`basisKeys: []`。 |
| `claims` | `key`、`proposition`（JSON 值）、`stance`、`confidencePermille` | `saliencePermille: 500`、`awareness: "conscious"`、`status: "active"`（只允许 active）、`basisKeys: []`。 |
| `goals` | `key`、`objective: { kind, value }`（两个键均必填，value 为 JSON 值） | `priorityPermille: 500`、`awareness: "conscious"`、`status: "active"`、`parentGoalKey: null`、`targetKeys: []`、`blockerKeys: []`、`basisKeys: []`。 |
| `relationships` | `key`、`target`（角色 ID）、`type`、`facet`、`intensityPermille` | `confidencePermille: 500`、`awareness: "conscious"`、`status: "active"`、`basisKeys: []`。 |
| `affects` | `key`、`type`、`intensityPermille`、`cause`（JSON 值） | `targetKey: null`、`awareness: "conscious"`、`expressionMode: "restrained"`、`duration: "short_lived"`、`status: "active"`、`basisKeys: []`。 |
| `innerTensions` | `key`、`title`、`pressurePermille`、`poles` | `awareness: "conscious"`、`status: "active"`、`basisKeys: []`。`poles` 必须 2–4 项；每项必填 `key`、`tendency`、`impulseText`、`strengthPermille`、`awareness`，选填 `basisKeys: []`。 |
| `commitments` | `key`、`content`（JSON 值）、`origin` | `saliencePermille: 500`、`awareness: "conscious"`（仅 `conscious` 或 `partially_conscious`）、`status: "active"`、`basisKeys: []`。 |
| `openLoops` | `key`、`kind`、`summary` | `saliencePermille: 500`、`status: "open"`、`basisKeys: []`。 |

枚举完整值见[认知词表](../../../packages/sdk/src/contracts/cognition.ts)及[包常量](../../../packages/world-pack/src/contracts.ts#L177)：

| 字段 | 可用值 |
| --- | --- |
| `epistemicKind` | `direct_observation`、`observed_action`、`reported_speech`、`subjective_inference`、`self_intention`。 |
| `stance` | `believed`、`suspected`、`doubted`、`denied`。 |
| `awareness` | `conscious`、`partially_conscious`、`unrecognized`；commitments 的例外见上表。 |
| goal `objective.kind` / `status` | `registered`、`narrative` / `active`、`blocked`、`completed`、`abandoned`、`failed`。 |
| relationship `type` / `status` | `affection`、`trust`、`distrust`、`respect`、`dependence`、`obligation`、`resentment`、`fear`、`envy`、`rivalry` / `active`、`resolved`。 |
| affect `type` | `joy`、`sadness`、`anger`、`fear`、`anxiety`、`shame`、`guilt`、`relief`、`hope`、`disgust`、`pride`、`loneliness`、`surprise`、`curiosity`。 |
| affect `expressionMode` / `duration` / `status` | `concealed`、`restrained`、`leaking`、`overt` / `momentary`、`short_lived`、`sustained`、`persistent_until_resolved` / `active`、`resolved`。 |
| tension pole `tendency` / tension `status` | `pursue`、`avoid`、`preserve`、`change`、`express`、`conceal` / `active`、`resolved`。 |
| commitment `origin` / `status` | `promise`、`agreement`、`accepted_request`、`duty`、`self_commitment` / `active`、`fulfilled`、`breached`、`released`、`renounced`。 |
| open loop `kind` / `status` | `question`、`request`、`offer`、`decision_pending`、`follow_up` / `open`、`answered`、`resolved`、`dismissed`、`expired`。 |

这些可选数值型关系、情绪记录是现有源码支持的字段，并不意味着创作必须建立好感、信任或情绪分数。当前产品方向优先由人设、记忆和对白形成主观态度。`targetKeys`、`blockerKeys` 和 `targetKey` 的非空引用须指向允许的本角色认知、角色、地点或对象；具体检查见[引用校验](../../../packages/world-pack/src/compiler.ts#L484)。每种记录数组最多 512 项，活跃认知还受 memory profile 限制。

`reported_speech` 虽是源解析允许值，但[授权记忆来源捕获](../../../packages/core/src/memory/authorized-sources.ts)中，普通内容若没有可识别的 `speech` 结构，作为此类型捕获可能失败；不能仅凭 schema 通过就保证该形状能正常进入长期记忆。

记忆文件根对象必须有 `schemaVersion: "worldpack-memory/v2"`、`characters` 数组。每项必填 `characterId` 和 `profile`（`compact`、`standard`、`deep`），选填不重复的字符串数组 `attentionTopics`，默认 `[]`。无该角色条目时编译器补 `standard` 和空 topics。当前可确认 profile 用于[初始活跃认知容量校验](../../../packages/world-pack/src/compiler.ts#L353)，具体上限在[配置表](../../../packages/sdk/src/contracts/runtime-registries.ts#L83)；`attentionTopics` 被保存并在创作视图显示，但本次未发现它直接控制实际检索的消费路径。长期记忆来源和索引由运行时依据授权事件构建，作者不直接在 `memory.json` 写索引或记忆数据库行，参见[认知与记忆](../architecture/cognition-memory.md)。

## 5. 文档正文和按条件交付的知识

文档元数据文件根对象必须有 `schemaVersion: "worldpack-documents/v2"`、`documents` 数组；每项必填 `documentId`、`contentRef`、`usage`、`audience`，选填 `characterIds`（默认 `[]`）。`contentRef` 指向已列入 `markdownFiles` 的正文；ID 不重复。支持值和约束如下，见[文档解析](../../../packages/world-pack/src/schema.ts#L940)：

| 字段 | 值与约束 |
| --- | --- |
| `usage` | `world_context`、`portrayal`、`memory_seed`、`author_note`。`portrayal` 和 `memory_seed` 必须为 `character_private`；`author_note` 必须为 `author_only`。 |
| `audience` | `public`、`director_visible`、`character_private`、`author_only`。仅 `character_private` 使用非空 `characterIds`；其余必须为空或省略。 |
| `characterIds` | 角色私有时必填非空且不重复，所有角色必须存在。 |

`memory_seed` 的 Markdown 在开局转换为指定角色的初始 `direct_observation`，不是每回合固定注入。`world_context`／`portrayal` 若要按权限和关键词交付，需要在包根放 `knowledge.json` 并把它列入 `assetFiles`；仅写文档元数据不会自动让每次请求都收到正文。宿主按固定文件名读取、验证资产，见[加载入口](../../../apps/host/src/runtime/knowledge-source.ts)。

`knowledge.json` 仅接受以下字段，见[解析和选择器](../../../packages/providers/src/knowledge/selection.ts)：

| 字段 | 必填及内容 |
| --- | --- |
| `maximumCharacters` | 必填，100–65536 的安全整数；每次选择的正文总字符预算。 |
| `entries` | 必填数组，最多 4096 项；同一 `documentId` 不能重复。 |
| `entries[].documentId` | 必填，指向 `usage` 为 `world_context` 或 `portrayal` 且 `audience` 为 `public` 或 `character_private` 的文档。 |
| `entries[].keywords` | 必填数组，最多 256 个非空字符串，每个最多 512 字符；`constant: false` 时至少一个。大小写不敏感地做子串匹配。 |
| `entries[].constant` | 必填布尔值；`true` 时不要求关键词命中，仍需满足受众、`when` 和预算。 |
| `entries[].priority` | 必填安全整数；从高到低选择，同优先级按 documentId 排序。 |
| `entries[].when` | 选填，根 `type` 必须为 `object` 的严格 JSON Schema；不填即不额外筛选。 |

选择器先校验受众，再使用接收者被授权的 `public`、`self`、`characters` 已知状态，`characterId`、`locationId`、`scene`、`items.current`／`items.lastObserved`、`activity`、`stimulus`、`knownStatus` 等有限视图判断 `when`。关键词只扫描角色授权的场景、近期观察、自身观察、刺激和召回等材料，不扫描全局转录或其他角色私密认知。正文只整条交付，单条超过总预算时加载即报错，超过剩余预算时本次跳过；不保证每条都会进入请求。示例和视图细节见[世界设定指南](world-knowledge.md)。

## 6. 可选断言与输出边界

`assertionFiles` 中每个 JSON 根对象必须有 `schemaVersion: "worldpack-assertions/v1"`、`assertions` 数组。每项必填 `assertionId`、`assertionType`、`parameters`（JSON 值），ID 不能重复。[`worldpack test`](../../../packages/world-pack/src/tooling.ts#L79) 当前编译并生成断言计划，`assertionsExecuted` 为 0，不能把它当成实际执行了断言或真实试玩。

包的源清单和上述文件是输入；编译结果会生成 `compiledSchemaVersion`、`packHash`、`compiler`、插件／词表／注册表锁、`content.markdown` 的路径和内容摘要以及 `assets` 的路径／大小／摘要，并收录作者声明的断言。测试命令再生成断言计划摘要；适配世界时生成运行时 Manifest、玩家绑定、Genesis 事件和各自摘要。这些均是派生输出，不要作为作者源字段回填。世界包示例可从[前室原型](../../../examples/world-packs/prototype-g1/worldpack.source.json)和[知识配置](../../../examples/world-packs/status-market/knowledge.json)查阅。

## 7. 反应、外显表现和交互选择

这三个文件由源清单中的 `reactionFile`、`manifestationFile`、`interactionFile` 分别指定，路径名可以不同于下例，文件和根字段仍必填；不能仅因为不用某项功能就删掉源清单入口。

### 反应配置

`reactionFile` 的根对象只接受以下字段，见[解析器](../../../packages/world-pack/src/schema.ts#L456)：

| 字段 | 必填及内容 |
| --- | --- |
| `schemaVersion` | 必填，固定 `worldpack-reaction/v1`。 |
| `mode` | 必填，`disabled` 或 `responsive`。 |
| `profile` | 当且仅当 `mode: "responsive"` 时必填，可为 `responsive/v1` 或 `responsive/v2`；`disabled` 时不得出现。 |

**当前作用范围：**这套 ReactionPolicy 已退役，值仍编译进 Manifest，但[当前调度路径不读取这些值](../../../packages/sdk/src/contracts/reaction-policy.ts)。选择 `disabled` 不能保证角色不回应，选择某个 profile 也不能保证使用旧版的反应策略；实际机会由现行调度器和核心预算决定。文件中也没有可由作者填写的模型调用数或时限字段。

### 外显表现配置

`manifestationFile` 的根对象必须且只能填写 `schemaVersion: "worldpack-manifestation/v1"` 与 `mode`；后者源解析允许 `enabled` 或 `disabled`，均无默认值，见[表现解析器](../../../packages/world-pack/src/schema.ts#L488)。

**当前运行时限制：**源码虽接受 `disabled` 并能编译成 Manifest，现行 v10 运行时在读取存储的 Manifest 时要求表现为 `enabled`，否则报 `action groups require manifestation enabled`。因此要进入当前运行时，应填写 `enabled`；仅编译或 `worldpack test` 成功不能证明 `disabled` 能玩。见[运行时校验](../../../packages/core/src/kernel/world-spec.ts#L66)。

本次用临时精简包核对：`enabled` 时 validate、compile 和无头同场说话模拟通过；只改为 `disabled` 后 validate 仍通过，而 simulate 启动时报上述错误。这是该样本的离线结果，不代表真实模型试玩或发行包验收。

### 交互选择配置

`interactionFile` 的根对象只接受以下字段，见[交互源解析](../../../packages/world-pack/src/schema.ts#L1224)：

| 字段 | 必填及内容 |
| --- | --- |
| `schemaVersion` | 必填，固定 `worldpack-interactions/v1`。 |
| `packages` | 必填数组，可为空；每项必填 `id`、`version`，只能选择入口已安装的交互包。 |
| `definitions` | 必填数组，可为空；每项必填 `id`、`version`，选择由已选包提供的交互定义。 |
| `relationBindings` | 选填数组，默认 `[]`；各项字段见下表，用于给关系**类**绑定交互，而不是在此指定某个关系实例。 |

`packages[]`、`definitions[]` 及绑定内的 `definition` 都使用 `{ "id": "…", "version": 1 }`：两个字段均必填，`version` 是正整数；各自数组中同一 `id@version` 不得重复。`packages` 最多 32 项，`definitions` 最多 128 项。选定一个包不会自动启用其全部定义；绑定引用的具体定义必须也在 `definitions` 中选中。

每个 `relationBindings[]` 项必须且只能包含：

| 字段 | 必填及内容 |
| --- | --- |
| `bindingId` | 必填，绑定 ID；与所有角色、对象及关系绑定的 ID 全局不重复。 |
| `relationClass` | 必填，关系类名称，须等于某个已启用定义的 `id`；不填关系实例 ID。 |
| `definition` | 必填对象，含必填 `id` 与正整数 `version`；指向已启用、可接受该关系目标类型的交互定义。它可以与 `relationClass` 指向的定义不同。 |
| `config` | 必填对象；键及类型由所选定义的 `bindingConfigSchema` 决定，必须填写该 schema 列出的字段，不接受多余键；整个 JSON 编码最多 4096 字节。 |

`relationBindings` 最多 4096 条；合并角色、对象和关系的所有绑定后仍最多 4096 条。角色／对象上的 `interactionBindings[]` 的 `definition`、`config` 同样受已启用定义、目标类型及 config schema 校验；`label` 仅用于显示，不决定定义。绑定的编译规则和引用检查见[交互目录编译](../../../packages/world-pack/src/schema.ts#L1593)。

当前[命令行入口](../../../apps/host/src/cli/worldpack.ts#L20)和[默认角色扮演组合](../../../apps/host/src/official-bundle.ts#L45)的交互包注册列表为空；库调用可显式传入已安装的包描述，实际运行也须配置相应实现。命令行的 `--plugins` 用于内容插件校验，不会向这个列表添加旧交互包。如果没有另行提供交互包，用以下最小内容；此时角色、对象也不能引用未启用的交互定义。空选择不等于没有所有玩法，已选择的共同脚本仍走其自身运行入口。

```json
{
  "schemaVersion": "worldpack-interactions/v1",
  "packages": [],
  "definitions": []
}
```
