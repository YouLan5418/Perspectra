# World Pack 创作者字段手册

> 历史 v1–v4 创作手册，保留供阅读旧世界包。当前网页原型只接受 v5；`worldpack init` 的旧模板入口已退出。新建可试玩世界请从 `examples/world-packs/hand-in-hand` 复制并参考 [当前试玩指南](creator-playtest.md)。以下旧版“当前推荐”说法仅适用于当时版本。

本手册说明如何只编辑 JSON/Markdown 内容，创建一个可以由真实模型驱动 NPC、支持独立认知与有界连续反应的本机世界。

> **当前推荐版本：** 需要角色表情、姿态、语气等外显表现的新世界使用 `worldpack-source/v4`，从 `expressive-social` 模板开始。只需连续对白时仍可使用 v3；不要让 AI 混用不同版本的文件形状。
>
> **可选扩展：** 需要「一轮两步动作」或「拿取/放下/递交物品」的新世界，**仍然使用同一个 `worldpack-source/v4`**，只是在激活和试玩时追加一个开关，见 §16 有界行动组与 §17 对象交互。扩展会改变生成的 Manifest 与模型协议，但不新增 Pack 源版本。
>
> **交互字段（新源版本）：** 需要把交互包与每个定义、每条绑定**冻结进世界**（定义锁、每定义各自的表现与观察策略、`submit_actions/v7`）的新世界，使用 `worldpack-source/v5`，见 §17.3。它与上面那条目录扩展路线**互斥**：v5 世界不接受 `--interactions`。

> **严格格式：** Schema 会拒绝未知字段、错误枚举、重复 ID、越界数字和未登记文件。不能通过“多写一个看起来合理的字段”扩展系统。

> **能力边界：** World Pack 是内容，不是程序。它不能包含 JavaScript、任意 Event、API Key、模型地址、系统提示或自定义规则脚本。

本次接入大模型并验证两步/交互，请先按[真实模型试玩指南 §1～5](creator-playtest.md)设置凭证、选择新协议和检查运行状态；本手册用于查询字段。

## 1. 五分钟创建并试玩世界

在仓库根目录执行：

```powershell
$source = 'D:\worlds\my-world'
$artifact = 'D:\worlds\my-world.worldpack.json'
$data = 'D:\worlds\my-world-playtest'

corepack pnpm@11.7.0 worldpack init --profile expressive-social $source
corepack pnpm@11.7.0 worldpack validate $source
corepack pnpm@11.7.0 worldpack test $source
corepack pnpm@11.7.0 worldpack compile $source --out $artifact
corepack pnpm@11.7.0 worldpack inspect $artifact
corepack pnpm@11.7.0 experience:web --deepseek --pack $artifact --data-dir $data
```

没有 DeepSeek Key 时，可使用本机 Ollama：

```powershell
corepack pnpm@11.7.0 experience:web --pack D:\worlds\my-world.worldpack.json --data-dir D:\worlds\my-world-playtest
```

如果这个世界需要「一轮两步动作」或「物品交互」，保持同一个 v4 Pack 不变，只在命令末尾加一个开关（两个开关互斥，二选一）：

```powershell
# 有界行动组：Manifest v7 / 模型协议 submit_actions/v4
corepack pnpm@11.7.0 experience:web --deepseek --pack $artifact --data-dir $data --action-groups

# 对象交互：Manifest v8 / 模型协议 submit_actions/v5（需要目录文件）
corepack pnpm@11.7.0 experience:web --deepseek --pack $artifact --data-dir $data `
  --interactions examples\world-packs\possession-interactions.json
```

详细字段、码表和玩家指令见 §16 与 §17。浏览器打开命令输出的本机地址。页面只监听 loopback，不向局域网或公网开放。

## 2. 选择起点

| 起点 | 生成版本 | 包含内容 | 适用场景 |
| --- | --- | --- | --- |
| `worldpack init --profile minimal` | v1 | 一个玩家、一个地点、一个 Scene | 学习最小目录和编译流程 |
| `worldpack init --profile social` | v1 | 酒馆、玩家、Alice、Bob、秘密与错误认知 | 查看旧版简单社交内容 |
| `worldpack init --profile responsive-social` | v3 | 复杂认知、Memory、Scene v2、NPC 连续反应 | 不需要非语言表现时使用 |
| `worldpack init --profile expressive-social` | v4 | v3 全部能力，加上可观察的表情、视线、姿态、手势、声音与外观变化 | **表现型新世界推荐起点** |
| `examples/world-packs/rainy-road-companions` | v2 | Phase 8 完整认知参考 | 查阅字段；直接复制时没有 Reaction Cycle |
| `examples/world-packs/hand-in-hand` | **v5** | 定义锁交互（交互包选择、定义与绑定、关系类解除）、`responsive/v2` | **交互字段新世界推荐起点**（§17.3） |
| `examples/world-packs/ai-girls-awaken-v10` | **v5** | 四角色长上下文世界、自然语言 Player Intent、物品与牵手交互、`responsive/v2` | **玩家与创作者综合试玩包**；旧 `ai-girls-awaken` 保留为兼容黄金 |

`expressive-social` 复制“雨夜同行”的完整结构，同时加入 Reaction 与 Manifestation 配置。创作者应保留文件形状，替换世界内容、角色、地点和交叉引用。

> Profile 只决定初始文件形状。「有界行动组」和「对象交互」**不是** Profile，而是激活/试玩时追加的开关，见 §16、§17；它们不会改变 Pack 源格式。

## 3. 让 AI 生成内容

可以把本手册和下列要求一起交给 AI。第一次生成时，先要求它保持模板中的 ID；校验通过后再整体重命名 ID，能显著减少交叉引用错误。

```text
请依据《World Pack 创作者字段手册》，把 expressive-social 模板改写成一个“暴风雪中的山间旅店”世界。

要求：
1. 继续使用 worldpack-source/v4，不改变任何 schemaVersion。
2. 保留一个 manual 玩家角色，增加三个 scripted NPC。
3. 每个 NPC 都有公开人设、个人目标、至少一条只属于自己的认知；其中一人持有秘密，一人持有错误认知。
4. 至少创建两个地点和两个 Scene；只有一个 Scene 初始为 active。
5. 使用 responsive/v1，不添加自定义数字预算。
6. 不添加手册未列出的字段，不写 API Key、模型名、系统提示、脚本或 Event。
7. 所有 basisKeys、characterId、locationId、participantIds、initialAudience 和 PlayerSlot 引用必须存在。
8. 输出修改后的完整文件，不输出省略号，不用 JSON 注释。
```

AI 输出后始终运行 `worldpack validate`。自然语言看起来合理，不代表引用和权限一定正确。

## 4. 通用格式规则

| 规则 | 要求 |
| --- | --- |
| 编码 | UTF-8 JSON 或 UTF-8 Markdown |
| JSON | 不允许注释、尾随逗号、`undefined`、`NaN` 或未知字段 |
| 数字 | 只接受安全整数；不接受小数和负零 |
| `schemaVersion` | 必须逐字使用本手册给出的固定值 |
| ID | 使用稳定、唯一、易读的 ASCII 名称，如 `character:alice` |
| Permille | `0`～`1000` 的整数；`700` 表示 70% |
| 路径 | 相对于 Pack 根目录，必须在 `worldpack.source.json` 显式登记 |
| 版本 | `packVersion` 使用 SemVer，如 `1.0.0` |
| 排序 | 数组顺序会参与内容 Hash；没有必要时不要反复重排 |
| 修改 | 已激活版本的内容改变时必须提升 `packVersion` |

“拒绝未知字段”针对 Schema 结构本身。`proposition`、`content`、`cause`、`parameters` 等明确标为 World JSON 数据叶子的字段，可以包含创作者自定义的合法 JSON 对象；这些对象仍然只是数据，不会自动成为规则或指令。

建议采用以下 ID 前缀：

```text
pack:       character:   location:    entity:      scene:
slot:       fact:        observation: claim:       goal:
relationship: affect:    tension:     pole:        commitment:
loop:       drive:       principle:   document:    assertion:
```

前缀是可读性约定；真正的约束是 ID 必须合法、稳定、唯一且所有引用一致。

## 5. 推荐 v4 目录

```text
my-world/
├── worldpack.source.json
├── world.json
├── characters.json
├── locations.json
├── entities.json
├── scenes.json
├── player-slots.json
├── presentation.json
├── cognition.json
├── memory.json
├── reaction.json
├── manifestation.json
├── assertions.json
├── documents.json             # 可选
└── text/                      # 可选 Markdown
```

`worldpack.source.json` 没有列出的文件不会被隐式扫描。反过来，清单中列出的文件必须存在。

## 6. 声明文件清单

`worldpack.source.json` 是唯一入口。v4 的所有字段都必须出现；暂时不用的类别也要写成空数组。

v5 在 v4 的字段之外**多一个 `interactionFile`**（指向 `interactions.json`），其余字段形状相同：

```json
{
  "sourceSchemaVersion": "worldpack-source/v5",
  "interactionFile": "interactions.json"
}
```

`interactions.json` 的形状与含义见 §17.3；`reactionFile` 与 `manifestationFile` 在 v5 里同样可用。

```json
{
  "sourceSchemaVersion": "worldpack-source/v4",
  "packId": "pack:mountain-inn",
  "packVersion": "1.0.0",
  "worldFile": "world.json",
  "characterFiles": ["characters.json"],
  "locationFiles": ["locations.json"],
  "entityFiles": ["entities.json"],
  "sceneFiles": ["scenes.json"],
  "playerSlotFiles": ["player-slots.json"],
  "presentationFiles": ["presentation.json"],
  "cognitionFiles": ["cognition.json"],
  "memoryFiles": ["memory.json"],
  "documentFiles": [],
  "markdownFiles": [],
  "assetFiles": [],
  "assertionFiles": ["assertions.json"],
  "reactionFile": "reaction.json",
  "manifestationFile": "manifestation.json"
}
```

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `sourceSchemaVersion` | 是 | 表现型新世界固定 `worldpack-source/v4` |
| `packId` | 是 | 内容包稳定身份；不同世界不要复用 |
| `packVersion` | 是 | 作者版本；内容变更后递增 |
| `worldFile` | 是 | 唯一世界配置文件 |
| `characterFiles` | 是且非空 | 角色文件列表 |
| `locationFiles` | 是且非空 | 地点文件列表 |
| `entityFiles` | 是，可空 | 物品文件列表 |
| `sceneFiles` | 是且非空 | Scene 文件列表 |
| `playerSlotFiles` | 是且非空 | 玩家绑定文件列表 |
| `presentationFiles` | 是且非空 | 呈现配置文件列表 |
| `cognitionFiles` | 是，可空 | 初始主观认知文件列表 |
| `memoryFiles` | 是，可空 | Memory Profile 文件列表 |
| `documentFiles` | 是，可空 | 文档权限元数据列表 |
| `markdownFiles` | 是，可空 | Markdown 文件列表 |
| `assetFiles` | 是，可空 | 二进制素材文件列表 |
| `assertionFiles` | 是，可空 | 验收声明文件列表 |
| `reactionFile` | 是 | NPC 连续反应策略文件 |
| `manifestationFile` | 是 | 外显表现能力开关文件；v4 必须显式登记 |

清单最多登记 512 个文件。一个路径不能在两个位置重复出现。

## 7. 定义世界

`world.json` 使用 `worldpack-world/v1`；在 v4 Pack 中仍然保持这个文件版本。

```json
{
  "schemaVersion": "worldpack-world/v1",
  "title": "山间旅店",
  "description": "四名旅客被暴风雪困在山间旅店。",
  "timeMode": "TURN_DRIVEN",
  "roundQueueLimit": 16,
  "coreProfiles": {
    "rulebook": { "rulebookId": "builtin:speak-move", "version": 2 },
    "sceneDecision": { "pluginId": "builtin:scene-decision", "version": "2.0.0" },
    "agentContext": { "pluginId": "builtin:agent-context", "version": "2.0.0" },
    "presentation": { "profileId": "builtin:deterministic-presentation", "version": "1.0.0" }
  },
  "initialFacts": [
    {
      "factId": "fact:storm-blocks-road",
      "proposition": { "subject": "road:mountain", "predicate": "blocked_by_snow" },
      "initialAudience": ["character:player", "character:innkeeper"]
    }
  ]
}
```

| 字段 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `schemaVersion` | 是 | — | 固定 `worldpack-world/v1` |
| `title` | 是 | — | 网页和工具显示的世界名称 |
| `description` | 否 | `""` | 世界简述 |
| `timeMode` | 否 | `TURN_DRIVEN` | 当前只允许玩家输入推动世界时间 |
| `roundQueueLimit` | 否 | `8` | 待处理玩家输入上限，范围 1～1024 |
| `coreProfiles` | 否 | 当前 Phase 8 固定组合 | 若填写，必须与示例逐字一致，不能自定义插件 |
| `initialFacts` | 否 | `[]` | 作者确认的初始事实及最初知情者 |

每条 `initialFacts` 必须填写：

| 字段 | 含义 |
| --- | --- |
| `factId` | 稳定事实 ID |
| `proposition` | 任意合法 World JSON 数据；推荐结构化对象 |
| `initialAudience` | 至少一个已存在角色；只有这些角色最初知道该事实 |

`initialFacts` 不是“全世界自动公开”。它会给指定角色生成初始认知。未列入受众的角色不能因为事实存在于 Pack 中而知道它。

## 8. 定义角色与公开人设

`characters.json` 使用 `worldpack-characters/v2`。

```json
{
  "schemaVersion": "worldpack-characters/v2",
  "characters": [
    {
      "characterId": "character:player",
      "displayName": "旅客",
      "controllerClass": "manual",
      "initialLocationId": "location:lobby"
    },
    {
      "characterId": "character:innkeeper",
      "displayName": "林老板",
      "controllerClass": "scripted",
      "pronouns": "他",
      "initialLocationId": "location:lobby",
      "lifecycle": "active",
      "portrayal": {
        "summary": "经营山间旅店多年的老板。",
        "speakingStyle": "沉着、简短，回避谈论旅店旧事。",
        "backgroundTextRef": null,
        "drives": [
          { "key": "drive:innkeeper-protect-guests", "text": "在暴风雪中保护所有住客。" }
        ],
        "principles": [
          { "key": "principle:innkeeper-discretion", "text": "未经允许不泄露住客隐私。" }
        ]
      }
    }
  ]
}
```

| 字段 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `characterId` | 是 | — | 角色稳定身份 |
| `displayName` | 是 | — | 玩家看到的名字 |
| `controllerClass` | 是 | — | `manual` 或 `scripted` |
| `pronouns` | 否 | `""` | 人称或称谓文本 |
| `initialLocationId` | 否 | `null` | 初始地点；可为空 |
| `lifecycle` | 否 | `active` | 初始生命/在场状态 |
| `portrayal` | 否 | `null` | 公开角色塑造；省略不会自动生成平均人格 |

`controllerClass` 的含义：

| 值 | 含义 |
| --- | --- |
| `manual` | 由玩家直接控制；当前一个世界只有一个 PlayerSlot |
| `scripted` | 由宿主提供者控制；网页试玩会把 active 的这类角色接到所选模型 |

不要填写 `llm`、模型名称或 API 配置。`scripted` 表示逻辑控制类别，具体用 Ollama 还是 DeepSeek 由运行命令决定。

`lifecycle` 可选值：

| 值 | 含义 |
| --- | --- |
| `active` | 可正常进入 Scene 和被调度 |
| `incapacitated` | 失去正常行动能力 |
| `dead` | 已死亡 |
| `departed` | 已离开世界当前活动范围 |

`portrayal` 内部字段全部可省略：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `summary` | `""` | 简短公开人物描述 |
| `speakingStyle` | `""` | 语言习惯；属于角色内容，不是系统提示 |
| `backgroundTextRef` | `null` | 引用已登记 Markdown |
| `drives` | `[]` | 长期驱动力，每项必须有唯一 `key + text` |
| `principles` | `[]` | 行为原则，每项必须有唯一 `key + text` |

`drive` 和 `principle` 的 key 可以成为该角色认知记录的 `basisKeys`。

## 9. 定义地点、物品和 Scene

### 地点

`locations.json` 至少要有一个地点：

```json
{
  "schemaVersion": "worldpack-locations/v1",
  "locations": [
    { "locationId": "location:lobby", "name": "旅店大堂" },
    { "locationId": "location:kitchen", "name": "后厨" }
  ]
}
```

每项只允许 `locationId` 和 `name`，两者必填。最多 512 个地点。

### 物品

`entities.json` 可以是空数组：

```json
{
  "schemaVersion": "worldpack-entities/v1",
  "entities": [
    {
      "entityId": "entity:guest-register",
      "locationId": "location:lobby",
      "kind": "book"
    }
  ]
}
```

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `entityId` | 是 | 物品稳定 ID |
| `locationId` | 是 | 初始位置，必须存在 |
| `kind` | 是 | 内容类别，例如 `book`、`key`、`ticket_bundle` |

`kind` 是受信数据标签，不会自动创造“阅读”“开锁”等新规则。当前 Core 只保证通用拿取和位置状态。最多 512 个物品。

### Scene

`scenes.json` 使用 `worldpack-scenes/v2`：

```json
{
  "schemaVersion": "worldpack-scenes/v2",
  "scenes": [
    {
      "sceneId": "scene:lobby",
      "lifecycle": "active",
      "locationId": "location:lobby",
      "participantIds": ["character:player", "character:innkeeper"]
    },
    {
      "sceneId": "scene:kitchen",
      "lifecycle": "created",
      "locationId": "location:kitchen",
      "participantIds": []
    }
  ]
}
```

| 字段 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `sceneId` | 是 | — | Scene 稳定 ID |
| `lifecycle` | 是 | — | `created`、`active` 或 `closed` |
| `participantIds` | 是 | — | 初始参与角色；active Scene 不得为空 |
| `locationId` | 否 | `null` | Scene 所在地点 |

Scene 决定当前互动、观察和 NPC 调度范围，Location 只表示物理位置。同一角色不能同时属于两个初始 active Scene。

## 10. 绑定玩家并设置显示语言

`player-slots.json` 当前必须恰好包含一个 PlayerSlot：

```json
{
  "schemaVersion": "worldpack-player-slots/v1",
  "playerSlots": [
    {
      "slotId": "slot:traveler",
      "characterId": "character:player",
      "controlMode": "manual"
    }
  ]
}
```

`slotId`、`characterId` 必填；`controlMode` 可省略，默认且只允许 `manual`。绑定的角色应在 `characters.json` 中声明为 `manual`。

`presentation.json` 控制确定性基础呈现：

```json
{
  "schemaVersion": "worldpack-presentation/v1",
  "locale": "zh-CN",
  "style": "plain"
}
```

| 字段 | 必填 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `schemaVersion` | 是 | — | `worldpack-presentation/v1` |
| `locale` | 否 | `en` | `en`、`zh-CN` |
| `style` | 否 | `plain` | 当前只允许 `plain` |

## 11. 定义角色的独立认知

`cognition.json` 使用 `worldpack-cognition/v2`。一个角色条目只强制 `characterId`；八类认知列表都可以省略，省略即空数组。

```json
{
  "schemaVersion": "worldpack-cognition/v2",
  "characters": [
    {
      "characterId": "character:innkeeper",
      "observations": [],
      "claims": [],
      "goals": [],
      "relationships": [],
      "affects": [],
      "innerTensions": [],
      "commitments": [],
      "openLoops": []
    }
  ]
}
```

同一角色的 `observations`、七类主观状态、`drives` 和 `principles` 共用本地 key 空间。key 不能重复。`basisKeys` 只能引用合法且属于该角色的依据，不能借此读取其他角色秘密。

### Observation：角色经历过什么

```json
{
  "key": "observation:innkeeper-heard-engine",
  "content": "林老板听见雪地里传来汽车引擎声。",
  "epistemicKind": "direct_observation",
  "saliencePermille": 700,
  "basisKeys": []
}
```

| 字段 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `key` | 是 | — | 该角色内部的稳定来源 key |
| `content` | 是 | — | 任意合法 World JSON 内容 |
| `epistemicKind` | 是 | — | 这段经历是怎么知道的 |
| `saliencePermille` | 否 | `500` | 对角色的重要程度 |
| `basisKeys` | 否 | `[]` | 形成该经历的已有依据 |

`epistemicKind`：

| 值 | 含义 |
| --- | --- |
| `direct_observation` | 亲眼、亲耳直接感知 |
| `observed_action` | 观察到某个行动 |
| `reported_speech` | 听到别人说过某句话；不代表内容为真 |
| `subjective_inference` | 角色自己的推断 |
| `self_intention` | 角色知道自己的意图或行为原因 |

### Claim：角色认为事实如何

```json
{
  "key": "claim:innkeeper-car-will-arrive",
  "proposition": { "subject": "car:supply", "predicate": "will_arrive_tonight" },
  "stance": "believed",
  "confidencePermille": 650,
  "saliencePermille": 600,
  "awareness": "conscious",
  "status": "active",
  "basisKeys": ["observation:innkeeper-heard-engine"]
}
```

必填：`key`、`proposition`、`stance`、`confidencePermille`。

可选默认：`saliencePermille=500`、`awareness=conscious`、`status=active`、`basisKeys=[]`。

`stance`：`believed` 相信、`suspected` 怀疑为真、`doubted` 对其存疑、`denied` 否认。Claim 永远是角色观点，不会自动升级为世界真相。

### Goal：角色想完成什么

```json
{
  "key": "goal:innkeeper-keep-guests-safe",
  "objective": {
    "kind": "narrative",
    "value": "让所有住客安全度过暴风雪。"
  },
  "priorityPermille": 850,
  "targetKeys": ["character:player"],
  "blockerKeys": [],
  "basisKeys": ["drive:innkeeper-protect-guests"]
}
```

必填：`key`、`objective.kind`、`objective.value`。

可选默认：`priorityPermille=500`、`awareness=conscious`、`status=active`、`parentGoalKey=null`、`targetKeys=[]`、`blockerKeys=[]`、`basisKeys=[]`。

| 字段 | 可选值或含义 |
| --- | --- |
| `objective.kind` | `narrative` 适合创作者文本；`registered` 只用于已注册的结构目标 |
| `status` | `active`、`blocked`、`completed`、`abandoned`、`failed` |
| `parentGoalKey` | 可选父目标 key |
| `targetKeys` | 人物、物品或其他目标引用 |
| `blockerKeys` | 阻碍该目标的状态引用 |

新内容通常使用 `narrative`，不要让 AI 自行发明 `registered` 目标协议。

### Relationship：角色如何看待另一个角色

```json
{
  "key": "relationship:innkeeper-trust-porter",
  "target": "character:porter",
  "type": "trust",
  "facet": "handling emergencies",
  "intensityPermille": 700,
  "confidencePermille": 650,
  "basisKeys": ["observation:innkeeper-heard-engine"]
}
```

必填：`key`、`target`、`type`、`facet`、`intensityPermille`。

可选默认：`confidencePermille=500`、`awareness=conscious`、`status=active`、`basisKeys=[]`。

`type` 可选：`affection`、`trust`、`distrust`、`respect`、`dependence`、`obligation`、`resentment`、`fear`、`envy`、`rivalry`。

`facet` 是自由文本维度，例如“诚实”“能力”“金钱往来”。同一角色可以同时在不同 facet 上信任和不信任同一个人；系统不会压成单一好感度。`status` 为 `active` 或 `resolved`。

### Affect：角色当前的情绪

```json
{
  "key": "affect:innkeeper-anxiety",
  "type": "anxiety",
  "intensityPermille": 680,
  "cause": "积雪仍在加深。",
  "targetKey": "location:mountain-road",
  "expressionMode": "restrained",
  "duration": "sustained",
  "basisKeys": ["goal:innkeeper-keep-guests-safe"]
}
```

必填：`key`、`type`、`intensityPermille`、`cause`。

可选默认：`targetKey=null`、`awareness=conscious`、`expressionMode=restrained`、`duration=short_lived`、`status=active`、`basisKeys=[]`。

| 类别 | 可选值 |
| --- | --- |
| `type` | `joy`、`sadness`、`anger`、`fear`、`anxiety`、`shame`、`guilt`、`relief`、`hope`、`disgust`、`pride`、`loneliness`、`surprise`、`curiosity` |
| `expressionMode` | `concealed` 隐藏、`restrained` 克制、`leaking` 不自觉流露、`overt` 公开表达 |
| `duration` | `momentary`、`short_lived`、`sustained`、`persistent_until_resolved` |
| `status` | `active`、`resolved` |

多个 Affect 可以同时存在；Kernel 不计算唯一“当前心情”。

### Inner tension：角色内部互相冲突的倾向

```json
{
  "key": "tension:innkeeper-warn-or-conceal",
  "title": "警告住客，还是隐瞒旅店旧事",
  "pressurePermille": 750,
  "poles": [
    {
      "key": "pole:innkeeper-warn",
      "tendency": "express",
      "impulseText": "立即告诉住客山路上的危险。",
      "strengthPermille": 760,
      "awareness": "conscious",
      "basisKeys": ["principle:innkeeper-discretion"]
    },
    {
      "key": "pole:innkeeper-conceal",
      "tendency": "conceal",
      "impulseText": "避免提到旅店过去发生的事故。",
      "strengthPermille": 690,
      "awareness": "partially_conscious",
      "basisKeys": []
    }
  ],
  "basisKeys": ["goal:innkeeper-keep-guests-safe"]
}
```

外层必填：`key`、`title`、`pressurePermille`、`poles`。`poles` 必须包含 2～4 项。

每个 pole 必填：`key`、`tendency`、`impulseText`、`strengthPermille`、`awareness`；`basisKeys` 可省略。

外层可选默认：`awareness=conscious`、`status=active`、`basisKeys=[]`。

`tendency`：`pursue`、`avoid`、`preserve`、`change`、`express`、`conceal`。系统保留全部倾向，不自动计算“哪一边获胜”。

### Commitment：承诺、职责或约定

```json
{
  "key": "commitment:innkeeper-shelter-guests",
  "content": "暴风雪结束前允许住客留在旅店。",
  "origin": "duty",
  "saliencePermille": 800,
  "basisKeys": ["principle:innkeeper-discretion"]
}
```

必填：`key`、`content`、`origin`。

可选默认：`saliencePermille=500`、`awareness=conscious`、`status=active`、`basisKeys=[]`。Commitment 的 awareness 只允许 `conscious` 或 `partially_conscious`。

| 字段 | 可选值 |
| --- | --- |
| `origin` | `promise`、`agreement`、`accepted_request`、`duty`、`self_commitment` |
| `status` | `active`、`fulfilled`、`breached`、`released`、`renounced` |

### Open loop：尚未处理完的对话事项

```json
{
  "key": "loop:innkeeper-engine-source",
  "kind": "question",
  "summary": "雪地里的引擎声来自谁？",
  "saliencePermille": 720,
  "basisKeys": ["observation:innkeeper-heard-engine"]
}
```

必填：`key`、`kind`、`summary`。

可选默认：`saliencePermille=500`、`status=open`、`basisKeys=[]`。

| 字段 | 可选值 |
| --- | --- |
| `kind` | `question`、`request`、`offer`、`decision_pending`、`follow_up` |
| `status` | `open`、`answered`、`resolved`、`dismissed`、`expired` |

## 12. 配置每个角色的 Memory Profile

`memory.json` 配置容量档位，不写入具体 Memory：

```json
{
  "schemaVersion": "worldpack-memory/v2",
  "characters": [
    {
      "characterId": "character:innkeeper",
      "profile": "standard",
      "attentionTopics": ["暴风雪", "住客安全", "汽车引擎"]
    }
  ]
}
```

| 字段 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `characterId` | 是 | — | 已存在的角色 |
| `profile` | 是 | — | `compact`、`standard`、`deep` |
| `attentionTopics` | 否 | `[]` | 该角色通常关注的主题文本 |

某个角色没有配置项时，Compiler 会为其物化 `standard`。同一角色最多一项。

| Profile | 请求上限 | 近期互动块 | Recall 条数 | 活跃认知总量 |
| --- | ---: | ---: | ---: | ---: |
| `compact` | 32 KiB | 4 | 6 | 12 |
| `standard` | 96 KiB | 10 | 16 | 32 |
| `deep` | 192 KiB | 20 | 32 | 64 |

`deep` 不是“角色更聪明”，只是允许装填更多上下文，通常更慢、更贵。新世界先用 `standard`。

## 13. 添加长文档和私有背景

`documents.json` 是 Markdown 的权限目录。正文路径还必须出现在 `markdownFiles`。

```json
{
  "schemaVersion": "worldpack-documents/v2",
  "documents": [
    {
      "documentId": "document:innkeeper-past",
      "contentRef": "text/innkeeper-past.zh-CN.md",
      "usage": "portrayal",
      "audience": "character_private",
      "characterIds": ["character:innkeeper"]
    }
  ]
}
```

| 字段 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `documentId` | 是 | — | 文档稳定 ID |
| `contentRef` | 是 | — | 已登记 Markdown 相对路径 |
| `usage` | 是 | — | 文档用途 |
| `audience` | 是 | — | 谁可以读取 |
| `characterIds` | 否 | `[]` | `character_private` 时必须非空；其他 audience 必须为空 |

`usage`：

| 值 | 含义 |
| --- | --- |
| `world_context` | 获授权的世界或 Scene 背景 |
| `portrayal` | 指定角色塑造，不自动产生 Memory |
| `memory_seed` | 给指定角色生成初始经历，再经正式 Memory 捕获 |
| `author_note` | 只供作者工具检查，不进入运行时 Context |

`audience`：`public`、`director_visible`、`character_private`、`author_only`。

配对限制：

- `portrayal` 和 `memory_seed` 必须是 `character_private`；
- `memory_seed` 只给列出的角色，不是世界真相广播；
- `author_note` 必须是 `author_only`；
- `author_only` 内容不会进入模型上下文；
- Markdown 是不可信内容叶子，不会被当成 System/Developer 指令。

每个 Markdown 文件最大 256 KiB；单个素材最大 8 MiB。当前试玩网页不提供完整素材渲染，素材能力主要是打包和完整性锁定。

## 14. 开启或关闭 NPC 连续反应

推荐的 `reaction.json`：

```json
{
  "schemaVersion": "worldpack-reaction/v1",
  "mode": "responsive",
  "profile": "responsive/v1"
}
```

完全关闭时必须删除 `profile`：

```json
{
  "schemaVersion": "worldpack-reaction/v1",
  "mode": "disabled"
}
```

`responsive/v1` 的安全预算由系统固定，创作者不能修改：

| 限制 | 固定值 |
| --- | ---: |
| 最多 wave | 3 |
| 每次玩家输入后最多 NPC 调用 | 8 |
| 每个角色最多调用 | 2 |
| 每次调用最多 Action | 1 |
| 最多 NPC 发言 | 8 |
| Cycle deadline | 30 秒 |

当前 Reaction Cycle 中 NPC 每次只能提议一个 `speak@1`。它用于让 NPC 在同一次玩家输入后有界地互相回应，不是无限自主运行。

## 15. 开启角色外显表现

v4 Pack 必须提供 `manifestation.json`。推荐启用：

```json
{
  "schemaVersion": "worldpack-manifestation/v1",
  "mode": "enabled"
}
```

若希望保留 v4 制品形状但暂不让模型输出表现，可写：

```json
{
  "schemaVersion": "worldpack-manifestation/v1",
  "mode": "disabled"
}
```

这个文件只有两个必填字段，不接受其他设置。创作者不需要在 Pack 中预写每一轮的表情和动作；启用后，运行时会向角色模型开放一个受约束的 `manifestation` 输出槽。其字段如下：

| 字段 | 必填 | 格式 | 用途 |
| --- | --- | --- | --- |
| `description` | 否 | 非空文本 | 本轮表现的综合舞台动作；基础网页优先显示它 |
| `cues` | 是 | 1～8 项数组 | 可被观察、记忆和未来表现层分别消费的结构化线索 |
| `cues[].cueId` | 是 | 本次 Proposal 内唯一的非空 ID | 让裁定和审计稳定指向某个 Cue |
| `cues[].channel` | 是 | 下表闭集 | 表现通道 |
| `cues[].description` | 是 | 非空文本 | 外界实际可见或可听的描述 |
| `cues[].persistence` | 是 | `event_only` 或 `until_changed` | 只发生一次，或持续成为当前可见状态 |
| `stateKey` | 条件必填 | 稳定非空 ID | 仅 `until_changed` 使用，标识要设置或清除的状态 |
| `operation` | 条件必填 | `set` 或 `clear` | 仅 `until_changed` 使用 |

`channel` 的含义：

| 值 | 适合表达 | 能否持续 |
| --- | --- | --- |
| `facial` | 皱眉、微笑、脸红 | 否 |
| `gaze` | 看向某人、移开视线 | 否 |
| `gesture` | 攥拳、敲桌、拨弄头发 | 否 |
| `voice` | 轻声、发颤、语速加快 | 否 |
| `posture` | 抱臂、倚靠、蹲下 | 是 |
| `appearance` | 袖口湿了、衣服破损、出现擦伤 | 是 |

玩家最终看到的基础文本类似：

```text
（Claude 避开视线，握杯子的手略微收紧。）
Claude 说：“随你。”
```

安全边界：

- 只能写外界可观察到的线索，不能写“真实嫉妒 0.8”“其实在撒谎”“暗中想杀人”等内在事实。
- `voice` 只写语气、音量或声音状态，不复制对白正文。
- `appearance` 只写本轮发生的变化，不重复银发、蓝眼等固有外貌。
- `event_only` 只进入历史；`until_changed` 才更新当前可见状态。V1 只允许 `posture` 和 `appearance` 持续。
- 模型输出只是 Proposal。只有经过规则裁定、提交并被某个角色实际观察到的表现，才会进入该角色的 Observation 和 Memory。
- 表现不会自动证明角色的真实情绪、动机、秘密或说法为真。

当前 V1 中，带 `manifestation` 的 Proposal 必须恰好有一个 Action。它不是第四种 Action，也不能脱离 Action 单独提交。未来逐动作绑定表现时会使用新版本，不会重解释 v4 历史。（逐动作、闭合码的表现现在已由 §16 有界行动组提供。）

## 16. 有界行动组（两步动作）

默认情况下，一个角色每轮最多提交**一个** Action。启用有界行动组后，同一个角色可以在一次模型调用里**按顺序提交最多两步**动作（例如「先移动、后发言」）。两步在同一个原子 Round 内连续裁定：**第一步被拒绝，第二步记为 `skipped`**，已成功的步骤不会因后续失败而撤回，组内也不会插入其他角色。

| 项 | 值 |
| --- | --- |
| Pack 源格式 | 仍是 `worldpack-source/v4`（**不变**） |
| 生成的 Manifest | **v7** |
| 模型协议 | **submit_actions/v4** |
| 两步组合 | 必须恰好一次 `speak` 加一次 `move` 或 `take`；顺序可任意；`abstain` 必须零步 |

在编译之后启动网页试玩并追加开关（数据目录要新的）：

```powershell
# 网页试玩自带激活，不需要先执行 worldpack activate。
corepack pnpm@11.7.0 experience:web --deepseek --pack $artifact --data-dir $data --action-groups
```

启用后，表现**不再接受自由文案**，改为**闭合表现码**。每个步骤可带一个 `manifestation`，由两个数组组成，合计最多 8 项且不得重复：

| 数组 | 含义 |
| --- | --- |
| `independent` | 本次尝试中独立成立的表现，**不能**含声音或步态 |
| `onSuccess` | 仅在该步骤被接受时才发生 |

可用码表：

| 码 | 通道 | 绑定约束 |
| --- | --- | --- |
| `smile` | 面部 | 任意步骤 |
| `frown` | 面部 | 任意步骤 |
| `nod` | 手势 | 任意步骤 |
| `shake_head` | 手势 | 任意步骤 |
| `avert_gaze` | 视线 | 任意步骤 |
| `quiet_voice` | 声音 | 只能放 `speak` 的 `onSuccess` |
| `trembling_voice` | 声音 | 只能放 `speak` 的 `onSuccess` |
| `slow_walk` | 步态 | 只能放 `move` 的 `onSuccess` |

未知的表现码会让该 Provider 输出判为 `schema-invalid`（默认不重试）。表现**不会**授予位置、视野、持有或心理事实。

玩家侧：普通输入仍按对白处理，也可以用 `/say <台词>` 明确发话。

> **命名提醒：** 这里的 **submit_actions/v4** 是**模型协议版本**，和 Pack 源格式 `worldpack-source/v4` 完全是两回事。Pack 源格式始终是 v4；启用行动组只改变生成的 Manifest 与模型协议。

## 17. 对象与角色交互

这一章有**两条互斥的路线**，先选一条再读下去：

| 路线 | Pack 源 | 交互词汇从哪来 | 生成的 Manifest / 协议 | 读哪一节 |
| --- | --- | --- | --- | --- |
| 目录扩展 | `worldpack-source/v4`（不变） | 激活时传的 `--interactions` 目录 | v8 / v9，`submit_actions/v5` | §17.1、§17.2 |
| **定义锁** | **`worldpack-source/v5`** | **Pack 自己的 `interactions.json`** | **v10，`submit_actions/v7`** | **§17.3** |

两者不能混：v5 世界把自己的选择冻结进去，因此不接受 `--interactions`，也不会被低版本编译器重新解释。

### 17.1 对象交互（拿取/放下/递交）

> 本节属于**目录扩展**路线（v4 源 + `--interactions`）。要把交互冻结进世界请读 §17.3。

默认规则只有 `take`，持有关系不成循环。启用对象交互后，模型用统一的 `interact` 动作执行**拿取 / 放下 / 递交**，且只在合法前置条件下成功：

- 拿取：物品无人持有且与行动者同地点；
- 放下：行动者持有该物品；
- 递交：行动者持有该物品，且收件人是另一个同地点的 active 角色。

递交只改变持有关系，**不表示对方同意、承诺或作出身体反应**。

| 项 | 值 |
| --- | --- |
| Pack 源格式 | 仍是 `worldpack-source/v4`（**不变**） |
| 生成的 Manifest | **v8** |
| 模型协议 | **submit_actions/v5**（动作词汇为 `speak` / `move` / `interact`） |
| 目录协议 | `object-interactions/v1` |

目录是一个独立 JSON 文件，激活时传入，规范化后计入 `specHash`；运行中的世界不会再去读它。

```json
{
  "version": "object-interactions/v1",
  "definitions": [
    { "interactionId": "core:take", "label": "拿取", "operation": "take" },
    { "interactionId": "core:drop", "label": "放下", "operation": "drop" },
    { "interactionId": "core:give", "label": "递交", "operation": "give" }
  ],
  "bindings": [
    { "entityId": "entity:ticket-bundle", "interactionIds": ["core:take", "core:drop", "core:give"] }
  ]
}
```

- `definitions` 声明交互 ID、显示名和确定性操作（首版只有 `take` / `drop` / `give`）。
- `bindings` 把交互 ID 绑定到具体物品。
- 自定义 ID 必须使用自有命名空间（如 `travel:collect-tickets`）；`core:` 保留给同名操作。
- 命名与文案**不会**改变操作的前置条件或效果。
- 上限：最多 128 个定义、4096 个对象绑定，ID 与名称最长 128 字符。

启用方式（目录中的物品 ID 必须与自己的 Pack 一致）：

```powershell
# 网页试玩自带激活；--interactions 已包含两步能力。
corepack pnpm@11.7.0 experience:web --deepseek --pack $artifact --data-dir $data `
  --interactions examples\world-packs\possession-interactions.json
```

玩家侧可以用

```text
/interact <物品ID> <交互ID> [收件角色ID]
```

明确提交一次交互（例如 `/interact entity:ticket-bundle core:give character:alice`）；其它普通输入仍按对白处理，也可以用 `/say <台词>` 发话。旧的 `/take` 在 v8 世界会被拒绝，并提示改用 `/interact`。

模型只能在 `affordances.interactions` 当前枚举出的候选里选择（同地点无人持有的物品、以及自己持有的物品；递交收件再按当前 Scene 可见角色裁剪）。这些候选是**提案输入，不是授权票据**——执行时会在最新事件前缀上重新验证。

### 17.2 角色即时交互（牵手/松手）

Manifest v9 只增加一个最小角色关系：人工玩家可对目录中明确绑定的 active、同地点角色执行 `hold_hand`。合法效果先成为玩家候选 S1，不等待目标审批；目标随后可在同一 Root Round 中 `release_hand`、move、speak 或 abstain。这里的“即时”是裁决顺序，不是零延迟或提前显示。

可直接使用随仓库提供的示例：

```powershell
$artifact = '.\examples\world-packs\ai-girls-awaken.worldpack.json'
$catalog = '.\examples\world-packs\ai-girls-awaken.character-interactions.json'
$data = 'D:\worlds\ai-girls-character-playtest'

corepack pnpm@11.7.0 experience:web --deepseek --pack $artifact --data-dir $data `
  --interactions $catalog
```

示例目录同时声明实体操作和角色操作。角色定义必须使用以下固定策略；创作者只能决定绑定目标与显示名称，不能放宽即时成立权、解除权或目标响应边界：

```json
{
  "interactionId": "core:hold-hand",
  "label": "牵住对方的手",
  "targetKind": "character",
  "operation": "hold_hand",
  "initiationPolicy": {
    "manualPlayer": "commit_then_react",
    "autonomousCharacter": "forbidden"
  }
}
```

玩家可用显式命令提交，不依赖 Player Intent Provider：

```text
/interact character:gpt core:hold-hand
```

`release_hand` 不写入静态目录。关系成立后，Host 只向关系参与者动态枚举 `core:release-hand` 及不可猜测的 relationId；move 也会确定性结束关系。第三方即使猜中 relationId 仍会被 Rulebook 拒绝。当前 Creator 入口生成的 Manifest v9 保持 `playerInputPolicy=legacy-speech/v1`：普通文本仍是对白，不能把“我牵住她”写成自然语言后期待建立关系。`player-intent/v1` 的生产 Provider/Profile 接入仍属于发布门禁。

`worldpack activate` 用于另一个 Host 的激活，写入 `<data-dir>/data/`；网页试玩写入 `<data-dir>/` 且使用不同地址和玩家绑定。两种入口不能通过相同目录互相接续。新 v7/v8 DeepSeek 模式不需要 Ollama 翻译玩家输入；普通文本只作为对白。

### 17.3 定义锁与新协议（`worldpack-source/v5` → Manifest v10 → `submit_actions/v7`）

§17.1、§17.2 是**目录扩展**：源仍是 v4，交互词汇由激活时的目录给出。本路线是**定义锁**：交互包
与其中每个定义、每条绑定在选择时**冻结进世界**，世界不再回看目录，模型协议升到 `submit_actions/v7`。

**你要声明什么。** v5 源多一个入口 `interactionFile`，指向 `interactions.json`：

```json
{
  "schemaVersion": "worldpack-interactions/v1",
  "packages": [{ "id": "package:interactions-basic", "version": 1 }],
  "definitions": [
    { "id": "base:take", "version": 1 },
    { "id": "base:give", "version": 1 },
    { "id": "base:hold-hand", "version": 1 },
    { "id": "base:end-contact", "version": 1 }
  ],
  "relationBindings": [{
    "bindingId": "binding:release",
    "relationClass": "base:hold-hand",
    "definition": { "id": "base:end-contact", "version": 1 },
    "config": {}
  }]
}
```

- `packages`：选择 Host **已安装**的受信包。没装的包会被拒绝（`is not installed by the Host`）。
- `definitions`：选择要启用的定义。**只能选，不能改**——角色槽、前置条件、效果、它接受哪些表现
  cue、谁可以观察到它的成败，全部是包内受锁策略的声明。
- `relationBindings`：唯一一种"名字不是实例"的绑定。它写**关系类**（`base:hold-hand`），运行中的
  具体关系实例由世界按这个类匹配，作者永远不需要知道也不应该写某个实例 ID。
- 物品与角色的绑定写在实体与角色文件里（形状与 §17.1 相同）。

**包拥有、而 Pack 不能改的两件事。** 这是本路线最容易误解的地方：

| 属性 | 谁声明 | 怎么改 |
| --- | --- | --- |
| 一个定义接受哪些表现 cue | 包内受锁的 `interaction-performance/v1` 策略 | 改包（Host 侧的受信实现），不是改 Pack |
| 成功与失败分别谁可以观察到 | 包内受锁的 `interaction-observation-policy/v1` 策略 | 同上 |

两条策略都进选择锁与 Hash，所以同一个世界不会在不同 Host 上表现不同。

**模型会看到什么。** v7 的交互步骤用绑定的身份地址，而不是目录条目：

```json
{ "actionId": "a1", "actorId": "character:npc", "actionType": "interact", "actionVersion": 2,
  "parameters": { "targetRef": { "kind": "entity", "id": "entity:umbrella" },
    "bindingId": "binding:umbrella-give",
    "definitionRef": { "id": "base:give", "version": 1 },
    "arguments": { "recipientId": "character:friend" } },
  "manifestation": { "independent": ["frown"], "onSuccess": ["smile"] } }
```

- `manifestation` 是可选的**步骤**。cue 取自闭合词表，且**不含声音/步态 cue**（那两类自带动作）。
  每个定义接受哪些 cue 由它自己的策略决定，模型会在上下文里拿到这份清单，不必猜。
- 越界的 cue、越界的绑定或越界的定义锁**整条步骤被拒绝**，不会被悄悄丢弃。
- 被接受的表现会成为**观察事实**（`character.manifested`）：同一场景里看得见这次动作的角色都会看到
  它是怎么做的，而不只是发生了。
- 失败的可观察性由定义声明：有的失败整个场景都看得见，有的只有行动者自己知道；事实层照常记
  `action.rejected`，策略只决定通知谁。

**玩家也能说是怎么做的。** 两条玩家路径都能带这一步，用的是同一个键和同一份清单：

- **显式命令**：`/act interact {"targetRef":…,"bindingId":…,"definitionRef":…,"arguments":…,"performance":{"independent":["frown"],"onSuccess":["smile"]}}`。
  这个第五个键是冻结请求本来就接受的可选键（模型那一步也走它），`interact@2` 没有新版本。
- **自由文本（Player Intent）**：解释器多一个输出字段 `actions[].performance`（`player-intent-candidate/v2`），
  它同时会看到每个选择**接受哪些 cue**（选项上的 `performances`；不接受任何 cue 的选择没有这个字段——
  "没有清单"与"清单为空"是同一个意思，所以不出现空数组）。玩家说"我皱着眉把杯子递给他"，解释器就填这个字段。
- **清单外即澄清，不静默丢弃、也不连累整条动作。** 玩家说了一个该定义不接受的 cue 时，宿主在提交前
  就回 `clarification_required / not_afforded`，玩家可以换一种说法；世界不会因此拒掉"递杯子"这件事本身。
  这条与模型不同：模型的越界 cue 是**整条交互被拒**（`PERFORMANCE_NOT_ACCEPTED`），因为模型已经被
  告知过清单，它是有意越界的提案。
- 玩家这一步同样成为**观察事实**，与模型那一步没有任何区别：同一场景里看得见的人都会看到它是怎么做的。

**上限。** 冻结 profile `interaction-limits/v1`（完整表见[实施契约 §6](../../spec/interaction-definition-v0.1.md)）：

| 资源 | 上限 |
| --- | --- |
| 每世界启用包 / 定义 / 绑定 | 32 / 128 / 4096 |
| 单 config Canonical JSON | 4096 字节 |
| 每定义角色槽 / 参数字段 / config 字段 | 8 / 8 / 8 |
| 每定义前置规则 / 依赖引用 / 生命周期处理器 | 16 / 64 / 16 |
| 单角色公开选项 / 每绑定参数组合 | 128 / 64 |
| 每动作主效果事件 / fold 累计事件 | 16 / 64 |

**超限是确定性失败，不截断。** 唯一按预算裁剪的是普通公开选项，而裁剪前的真实数量由
`candidateCount` 如实报出；本人解除关系的入口永远保留，放不下就明确失败而不是删掉它。

**编译与运行。**

```powershell
corepack pnpm@11.7.0 worldpack validate examples\world-packs\hand-in-hand
corepack pnpm@11.7.0 worldpack test     examples\world-packs\hand-in-hand
corepack pnpm@11.7.0 worldpack compile  examples\world-packs\hand-in-hand --out D:\worlds\hand.wp.json
corepack pnpm@11.7.0 worldpack inspect  D:\worlds\hand.wp.json
corepack pnpm@11.7.0 worldpack activate D:\worlds\hand.wp.json --data-dir D:\worlds\hand-data
```

`compile` 需要 Host 的已装包清单，命令行入口会带上默认安装（含 `package:interactions-basic@1`）；
它**不需要** `--interactions`，v5 世界也不接受那个开关。

**对照示例。** `examples/world-packs/hand-in-hand` 是只为这条路线写的小世界：两个旅人在山脊雨棚下
躲雨、共用一把伞、一个保温壶。它示范了从 v4 复制、升级源版本、加 `interactions.json`、给同行者一条
角色绑定（牵手）、给关系类一条解除绑定，并在 `reaction.json` 里选 `responsive/v2`。按上面的命令编译
并激活后可以观察到：递交落在收件人而不是地点；走到别处时由**世界的 fold**结束牵手（不是内核按接触名
分支）；带 cue 的递交在落库事件里留下一条 `character.manifested`。

**用真实模型驱动它。** 网页试玩会识别 `worldpack-source/v5` 目录并使用 Manifest v10、`submit_actions/v7` 和生产 `provider-chat` 适配器：

```powershell
corepack pnpm@11.7.0 experience:web --deepseek --pack examples\world-packs\ai-girls-awaken-v10 --data-dir D:\worlds\ai-girls-awaken-v10-playtest
```
要跑真实模型请用付费实验门禁：

```powershell
$env:DEEPSEEK_API_KEY = '<你的 key>'
node --import tsx tests/experiments/v10-provider-gate.ts --model deepseek-flash
```

它把生产的上下文与 v7 契约原样发给端点，再把答案原样交给世界校验。真实适配器有两条前置（门禁里已
实现，缘由见 [I5-d 记录](../../archive/interaction-abstraction-i0-i7/2026-09-14_交互抽象-I5d冻结路径的真实模型门禁.md)）：Host 的 `tools` 是
**契约描述**，要由适配器渲染成 JSON Schema；组装出的上下文里有一段 `role: 'developer'`，端点不认，
需要映射。

## 18. 声明验收意图

`assertions.json` 的格式是：

```json
{
  "schemaVersion": "worldpack-assertions/v1",
  "assertions": [
    {
      "assertionId": "assertion:secret-hidden-from-player",
      "assertionType": "view.excludes",
      "parameters": {
        "characterId": "character:player",
        "text": "只有老板知道的秘密"
      }
    }
  ]
}
```

每项必填 `assertionId`、`assertionType`、`parameters`。但当前 `worldpack test` 只验证编译和适配，并会如实报告 `assertionsExecuted: 0`；这些声明不能替代正式隐私测试，也不能被当作已经执行的安全保证。

不需要验收声明时使用：

```json
{
  "schemaVersion": "worldpack-assertions/v1",
  "assertions": []
}
```

## 19. 理解引用和隐私

编译前必须满足以下闭包：

1. PlayerSlot 的 `characterId` 必须存在，且逻辑控制类别应为 `manual`。
2. Character、Entity 和 Scene 的 `locationId` 必须存在。
3. Scene 的 `participantIds`、Fact 的 `initialAudience`、Document 的 `characterIds` 必须引用现有角色。
4. 同一角色不能同时属于多个初始 active Scene。
5. Cognition 条目的 `basisKeys` 必须属于正确角色，且不能形成循环依赖。
6. `backgroundTextRef`、Document 的 `contentRef` 必须引用清单中的 Markdown。
7. 不同角色即使写了完全相同的句子，也仍然是不同的认知和 Memory 来源。

最重要的语义区别：

| 内容 | 表示什么 | 不表示什么 |
| --- | --- | --- |
| `initialFacts` | 作者确认的事实，并按受众初始化认知 | 自动让所有角色知道 |
| `claims` | 某角色当前相信、怀疑或否认的命题 | 命题一定为真 |
| `reported_speech` | 某角色听见别人说过 P | P 已被证实 |
| `affects` | 角色可并存的主观情绪 | 单一心情分数 |
| `innerTensions` | 互相冲突的倾向 | 系统已经替角色作出选择 |
| `author_note` | 作者私有说明 | 可进入 NPC 上下文的隐藏提示词 |

## 20. 校验、版本化和试玩

每次编辑后按顺序执行：

```powershell
corepack pnpm@11.7.0 worldpack validate D:\worlds\my-world
corepack pnpm@11.7.0 worldpack test D:\worlds\my-world
corepack pnpm@11.7.0 worldpack compile D:\worlds\my-world --out D:\worlds\my-world.worldpack.json
corepack pnpm@11.7.0 worldpack inspect D:\worlds\my-world.worldpack.json
```

`validate` 会检查严格 JSON、版本、文件路径、引用、权限、容量与 Profile。`compile` 生成不可变、内容寻址的制品。`inspect` 只读取制品，不回看来源目录。

`worldpack-source/v5` 的 Pack 走同一组命令，但 `compile` 会按 Host 的安装清单核对它选的交互包（默认安装已包含 `package:interactions-basic@1`），因此不需要也不接受 `--interactions`；激活同样直接读 Pack 自己的选择（见 §17.3）。

同一个 `packId + packVersion` 必须永远对应同一内容。已经试玩 `1.0.0` 后又修改内容，应改为 `1.0.1`，并使用新的数据目录：

```powershell
corepack pnpm@11.7.0 experience:web --deepseek `
  --pack D:\worlds\my-world-1.0.1.worldpack.json `
  --data-dir D:\worlds\my-world-1.0.1-playtest
```

不要手改 SQLite、Manifest Hash 或编译产物来覆盖旧世界。

### 试玩可选开关

`experience:web` 在 `--pack` / `--data-dir` 之外还接受两个**互斥**开关，用于试玩新协议（详见 §16、§17）：

```powershell
# 有界行动组（Manifest v7 / submit_actions/v4）
corepack pnpm@11.7.0 experience:web --deepseek --pack $artifact --data-dir $data --action-groups

# 对象交互（Manifest v8 / submit_actions/v5，需目录文件）
corepack pnpm@11.7.0 experience:web --deepseek --pack $artifact --data-dir $data `
  --interactions examples\world-packs\possession-interactions.json
```

两个开关都**必须配合 `--pack`**（不能用于内置示例世界），且**只能选一个**。试玩命令会自行在给定数据目录里激活世界，因此数据目录必须是全新（空）的。

进入页面后，可以用 `/say <台词>` 明确发话；启用对象交互时还可以用 `/interact <物品ID> <交互ID> [收件角色ID]` 提交一次交互。

## 21. 常见错误

| 表现 | 常见原因 | 处理方法 |
| --- | --- | --- |
| `PACK_SOURCE_INVALID` | 字段拼错、未知字段、枚举错误、JSON 注释 | 对照本手册删除未注册字段 |
| `PACK_REFERENCE_INVALID` | 角色、地点、basis 或 Markdown 引用不存在 | 搜索引用 ID，确保定义与拼写一致 |
| `PACK_DUPLICATE_ID` | ID、key 或文件路径重复 | 给每项稳定且唯一的 ID |
| `PACK_LIMIT_EXCEEDED` | 文件、角色、认知或字节数超限 | 拆分内容或改用更合适的 Profile |
| `PACK_PROFILE_NOT_ALLOWED` | AI 自行修改了 Core Profile | 恢复本手册中的固定 Profile |
| `PACK_VERSION_DIVERGED` | 同一 packId/version 对应不同内容 | 提升 `packVersion` 并重新编译 |
| NPC 不说话 | 角色不是 active/scripted，或不在 active Scene | 检查 Character、Scene 和 Reaction |
| NPC 不连续回应 | 使用 v1/v2 Pack 或 Reaction disabled | 使用 v3/v4 并启用 `responsive/v1` |
| 没有舞台动作 | 使用 v1～v3、Manifestation disabled，或模型省略表现 | 使用 v4 并检查 `manifestation.json` 为 `enabled` |
| 秘密泄漏 | 把秘密写进 public Portrayal、公开 Fact 受众或玩家文档 | 把信息放进正确角色的 Cognition/私有 Document |
| 世界能编译但玩法不存在 | `kind` 或自由文本不会自动生成规则 | 只依赖 Core `speak/move/take/reflect`，新硬语义需要受信规则实现 |
| 一轮只能做一个动作 | 未启用有界行动组 | 用 `--action-groups`（见 §16） |
| 拿取 / 放下 / 递交不可用 | 未启用对象交互 | 用 `--interactions <catalog>`（见 §17） |
| 角色牵手不可用 | 目录仍是 `object-interactions/v1`、目标未绑定或不在同一地点 | 使用 `interaction-catalog/v2` 并核对 character binding（见 §17.2） |
| 表现只能选固定码，不能写自由文案 | 已启用行动组或对象交互 | 新版使用闭合表现码；自由文案表现只存在于 Manifest v6 / submit_actions v3 |
| `/take` 被拒绝 | v8 世界改用统一的 `interact` | 用 `/interact <物品ID> <交互ID> [收件角色ID]` |
| 报错 `choose --action-groups or --interactions` | 同时传了两个互斥开关 | 二选一；两者都要求 `--pack` 与全新数据目录 |
| 报错 `package … is not installed by the Host` | v5 的 `interactions.json` 选了 Host 没装的包 | 只选已装包；默认安装含 `package:interactions-basic@1` |
| 交互步骤被拒 `PERFORMANCE_NOT_ACCEPTED` | 该步骤带了这条定义策略不接受的 cue | 从上下文给出的、那条定义接受的 cue 里选；或这一步不带表现 |
| 交互步骤被拒 `INVALID_INTERACTION_PARAMETERS` | 地址不是被提供的选项（bindingId/targetRef/definitionRef 的组合不符），或带了声音/步态 cue | 只提交上下文提供的选项；交互步骤不承载声音/步态 |
| 报错 `the required exit options exceed the view budget` | 本人可解除的关系太多，128 项放不下退出入口 | 减少当前关系实例或内容；系统**不会**静默删掉退出入口 |
| 表现怎么写都被拒 | 这条定义没有声明任何 cue | 换用声明了表现策略的定义（如 `base:give`），或在包里改策略（§17.3） |
| `--interactions` 用在 v5 世界上被拒 | v5 世界自带冻结选择，不再读目录 | 去掉 `--interactions`；交互词汇在 Pack 的 `interactions.json` 里 |

全局安全上限：最多 256 个角色、512 个地点、512 个物品、每类每角色最多 512 条认知、512 个 Document；每个源 JSON 最大 1 MiB，完整编译制品最大 16 MiB。

## 22. 版本兼容说明

| Source 版本 | Character/Scene/Cognition | Reaction | Manifestation | 使用建议 |
| --- | --- | --- | --- | --- |
| v1 | Character v1、单 Scene、简单 Observation/Claim/Goal | 无 | 无 | 只维护旧 Pack |
| v2 | Character v2、Scene v2、完整 Cognition/Memory/Document | 无 | 无 | Phase 8 历史世界或字段参考 |
| v3 | 与 v2 内容形状一致 | 有 | 无 | 只需连续对白的新世界 |
| v4 | 与 v3 内容形状一致 | 有 | 有，显式开关 | **需要非语言表现的新世界** |
| v5 | 与 v4 一致，另加 `interactionFile` | 有（可用 `responsive/v2`） | 有 | **需要定义锁交互的新世界**（§17.3） |

不要把 v1 的 `initialClaims`、`initialGoals` 写进 Character v2。v2/v3/v4 将这些内容集中放在 `cognition.json`。系统不会隐式升级旧 Pack，也不会在解析失败时退回其他版本。

上表的 **v1～v4 指 Pack 源格式**。在 `worldpack-source/v4` 基础上，激活/试玩时可追加开关，从而生成不同的 Manifest 与模型协议：

| 激活开关 | 生成的 Manifest | 模型协议 | 动作词汇 | 表现形式 | 用途 |
| --- | --- | --- | --- | --- | --- |
| 无 | v6 | submit_actions/v3 | speak / move / take | 自由文案 `manifestation` | 表现型基础世界（§15） |
| `--action-groups` | v7 | submit_actions/v4 | speak / move / take | 闭合表现码（§16） | 一轮最多两步顺序动作 |
| `--interactions <object-interactions/v1>` | v8 | submit_actions/v5 | speak / move / interact | 闭合表现码（§16） | 拿取 / 放下 / 递交（§17.1） |
| `--interactions <interaction-catalog/v2>` | v9 | submit_actions/v5 | speak / move / interact | 闭合表现码（§16） | 实体操作 + 玩家即时牵手/参与者解除（§17.2） |
| **（v5 源，无开关）** | **v10** | **submit_actions/v7** | speak / move / interact@2 | 闭合表现码，**按定义**决定接受哪些 | **定义锁交互**：包与定义冻结进世界，表现落成观察事实（§17.3） |

上面的 `--action-groups` 与 `--interactions` 两个扩展**不新增 Pack 源版本**；`worldpack-source/v5` 是**新增的源版本**，它把选择写进 Pack 自己。三种路线的旧 Pack 文件、旧 Hash 与旧世界的语义都保持不变，系统不会根据模型输出隐式升级，也不会把 v4 的 Pack 当 v5 解释。

## 23. Evidence → Finding → Path

| Evidence | 实现来源 | 可复现观察 |
| --- | --- | --- |
| E-001 | `packages/world-pack/src/creator-cli.ts` | `init` 注册四种模板；v4 模板显式生成 Reaction 与 Manifestation 文件 |
| E-002 | `packages/world-pack/src/schema.ts` | 每类文件使用 exact-key、枚举、默认值和跨文件编译门禁 |
| E-003 | `packages/world-pack/src/contracts.ts` | v1～v4、认知词汇、Reaction 与 Manifestation 均有版本化类型 |
| E-004 | `examples/world-packs/rainy-road-companions` | 完整 v2 角色认知、Memory 与多 Scene 参考数据 |
| E-005 | `docs/current/guides/creator-playtest.md` | 已验证从脚手架到真实模型网页试玩的执行路径 |
| E-006 | `examples/world-packs/ai-girls-awaken.character-interactions.json`、`compiler-v4.test.ts` | 仓库内 v2 目录被真实编译器适配为 Manifest v9，并固定保持 legacy speech 策略 |

Finding F-001：E-001～E-004 证明创作者可以只改内容文件建立通用世界；是否需要外显表现决定选择 v3 或 v4，不能混合版本字段。

Finding F-002：E-002～E-003 证明“可省略”不等于“不进入编译结果”；默认值会物化并参与 Pack Hash，因此手册必须精确记录默认值。

Finding F-003：E-006 证明创作者可通过闭合目录启用角色关系能力，但目录不能自行开启自然语言 Player Intent，也不能改变 Host 派生的即时裁决权。

Path P-001：生成 `expressive-social` → 只改登记文件 → `validate` → `test` → `compile` → `inspect` → 用独立数据目录进行真实模型网页试玩。

## 24. 相关文档

- [创作者 World Pack 与真实模型试玩指南](creator-playtest.md)
- [Phase 8 创作者运行手册](../../archive/phase-7-9c/PHASE8-CREATOR-RUNBOOK.md)
- [World Pack v2 作者源文件形状 ADR](../../adr/ADR-0069-worldpack-v2-source-file-shapes.md)
- [角色外显表现 ADR](../../adr/ADR-0083-manifestation-observable-expression.md)
- [有界行动组 ADR](../../adr/ADR-0085-bounded-action-groups.md)与[实施规格](../../spec/bounded-action-groups-v0.1.md)
- [对象交互 ADR](../../adr/ADR-0086-object-interactions.md)与[实施规格](../../spec/object-interactions-v0.1.md)
- [角色即时交互 ADR](../../adr/ADR-0087-player-immediate-character-interactions.md)与[实施规格](../../spec/character-interactions-v0.1.md)
- [雨夜同行参考 Pack](../../../examples/world-packs/rainy-road-companions/worldpack.source.json)
