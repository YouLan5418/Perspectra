# 创作者编辑器字段总览

做《门廊便笺》的第一步，作者只需决定作品叫什么、谁由玩家控制、阿林叫什么，以及两人在哪里开场。要写阿林的说话风格、便笺的拆封条件和停电事件时，再进入相应表单。下面按当前 `main`（`bde72bd4`，2026-11-20）记录可写入源包、脚本和随包资源的字段，可与[编辑器设计稿](../../superpowers/specs/2026-11-20-creator-editor-design.md)一起使用。

## 按创作任务查字段

工作台当前可从表单创建世界、角色、地点、物品和开局，设定活动条件与裁定、世界事件、知识、文风、活动专属页面，以及官方 RPG 与跑团。跑团从作品目录进入，RPG 的「完整配置」可查看字段分类。下面的字段索引同时涵盖仍由源包提供的能力。在「世界与角色开局」可编辑开局事实与知情角色、人物动机原则、八类初始认知、记忆容量和关注话题。角色通讯录已支持按人勾选双向或单向联系。「角色自主机会」可以选择触发行动、活动操作和允许的角色、地点与物品。「舞台与美术」支持导入封面、立绘、图层、背景，并用表单编辑表情、拼合图、开场活动和默认舞台组件。

| 想做什么 | 查哪一页 |
| --- | --- |
| 建作品、角色、人设、地点、物品、场景和玩家槽，设置初始事实、认知、记忆、知识正文/读者或交互绑定 | [世界包基础字段](creator-fields-world.md) |
| 写包级变量、活动、操作、物品转移、剧情节奏、角色自主机会或世界事件 | [状态、活动和世界进程](creator-fields-gameplay.md) |
| 写自定义玩法脚本，声明参数、可用操作、裁定、状态、玩家面板和舞台 | [共同玩法脚本与展示](creator-fields-gameplay-sdk.md) |
| 配置战斗、技能、地图、装备、敌人，或跑团角色卡、主持人和剧本 | [官方 RPG 与跑团](creator-fields-modes.md) |
| 配封面、角色立绘与表情、背景、舞台组件、自定义网页、声音或模型文风预设 | [画面、声音与角色请求预设](creator-fields-presentation.md) |
| 配短信联系人、包内插件及其能力、原生插件设置表单，或编写验收剧本 | [通信、插件模块与试玩推演](creator-fields-extensions.md) |

**如何读“必填”**　各页按源文件和对象标注。必填键必须出现在导出数据里，其中一部分可由编辑器生成。选填键可省略。条件必填的要求随作者的选择生效，例如添加一条角色私有知识后就要指定读者。必填数组允许的项数也各不相同，`assetFiles: []` 合法，`presentationFiles` 要列出恰好一个文件。设计稿允许作者先保存缺项的草稿，本表的要求适用于编译或开局。

## 第一个可试玩开局

| 作者填写或选择 | 导出时必填 | 可以稍后再填 |
| --- | --- | --- |
| 作品名称与身份 | `world.title`；源清单的 `packId`、`packVersion` 和格式版本。编辑器可以生成 ID 和初版版本号。 | `description`、初始事实、玩家输入策略等。 |
| 玩家与同行角色 | 每个角色的 `characterId`、`displayName`、`controllerClass`。玩家槽的 `slotId` 和 `characterId` 指向一个 `manual` 角色。 | `pronouns`、`portrayal` 和其下的摘要、说话风格、动机、原则，还可稍后补知识和记忆。 |
| 地点与同场开局 | 地点的 `locationId`、`name`，场景的 `sceneId`、`lifecycle`、`participantIds`。要同场开局，选同一地点，将两人列入同一 `active` 场景。 | 场景 `locationId` 和角色 `initialLocationId` 在格式上都可省略。本例显式填写两者以确定开场位置。 |
| 第一次进入正式游戏 | v5 源清单共有 **19 个必填键**。编辑器可生成各文件的版本标记、索引、反应/表现/交互文件和空集合。当前默认宿主选择空的旧交互目录、启用表现即可。 | 物品、活动、世界事件、专属前端、模型预设和 RPG/TRPG 均可后加。 |

例如，“必须先拿到开信刀才能拆信”可以直接读取持有关系。同一封便笺也能有公开知识和只向阿林交付的背景。前者由活动或玩法规则判断，后者由文档的 `audience`、`characterIds` 和知识选择条件控制。[活动与状态](creator-fields-gameplay.md) · [文档与知识](creator-fields-world.md#5-文档正文和按条件交付的知识)

## 选择玩法时的清单字段

源清单仅有以下四个选填顶层键。游戏内容作者往往只需要勾选玩法并填写对应章节的配置。原生插件维护者可定义额外的配置键，必填性由所选版本的 `configSchema` 和语义校验决定。[源清单解析](../../../packages/world-pack/src/schema.ts) · [组合校验](../../../packages/world-pack/src/composition.ts) · [官方玩法目录](../../../apps/host/src/official-pack-metadata.ts)

| 字段 | 何时填写 | 子字段及必填性 |
| --- | --- | --- |
| `plugins` | 选填。需要某项官方或已安装的玩法时明确选择。 | 按插件 ID 填对象。对象可为空；`version` 选填，填写时是精确字符串。`config` 选填，填写时必须指向已登记资产。省略路径时，带默认配置文件的插件仍要求该文件存在并已登记。插件依赖需显式选择。 |
| `requiresPlugins` | 选填。作品依赖玩家安装的本地插件时使用。 | 每项必填 `id`、`version`，后者可写 `1.2.3`、`^1.2.3`、`>=1.2.3`。布尔 `optional` 选填，默认按必需依赖处理。 |
| `services` | 选填。作品要求某个特定服务实现时才填。 | 可选键为 `scheduler`、`characterLoop`、`memory`、`llm`、`status`、`activities`、`communication`、`knowledge`，每个已填键的值必须是非空提供方 ID。正式开局核对实际选择。 |
| `scripts` | 选填。自行编写共同玩法脚本时使用。 | 存在时必填 `gameplay`，其中 `entry` 必填且须列入 `assetFiles`。`config` 选填，默认 `{}`。脚本可要求该对象内的特定属性。 |

发布源包时还要保留宿主按约定路径独立读取的前端、美术和预设。运行时产生的哈希、锁、修订号、事件记录、角色实际请求与试玩回放有各自的诊断用途，编辑器可用只读视图展示。[呈现与文件归属](creator-fields-presentation.md) · [开局编译与派生输出](creator-fields-world.md)

## 已核实的校验边界

| 验证 | 当前结果 |
| --- | --- |
| 精简双角色源包 | 只保留 19 个顶层必填键，省略两人的人设、文档、认知、记忆、物品与断言内容后，源码 CLI 的 `validate` 和 `compile` 均通过。无头 `simulate` 中，同场 NPC 的实际请求包含玩家当步发言。使用的是桩模型。 |
| 空白包生成器 | 新包的 `interactions.json` 使用空的 `packages` 列表。作者可以直接校验、导出，再逐步添加交互。[生成器](../../../skills/perspectra-creator/scripts/create-world.mjs) · [CLI 装配](../../../apps/host/src/cli/worldpack.ts) |
| 表现模式 | 在上述精简包仅把 `manifestation.json` 的 `mode` 改为 `disabled`，`validate` 通过，`simulate` 在开局时报 `action groups require manifestation enabled`。当前编辑器导出可游玩作品时应使用 `enabled`。 |
| 官方玩法与预设 | `hill-ruins`、`rainy-manor`、`model-girls-sweet-days` 的源包校验通过。`launcher-demo/model-preset.json` 通过独立的 `preset validate --pack`。RPG 的三处条件字段另用缺键/补键输入核对，结果见[官方玩法字段](creator-fields-modes.md)。 |

上表记录源包输入与桩模型的核对范围。各编辑入口与验证方式见[创作者工作台](world-workbench.md)。真实模型对白、美术与音频效果、已发行版本仍需分别试玩验收。
