# World Pack v5 创作指南

当前 Launcher 与源码网页读取 `worldpack-source/v5` **源目录**。建议复制已运行的 v5 示例后逐步修改，不从历史 v4 模板或旧 `worldpack init` 开始。本文是当前创作入口；[旧字段手册](../../archive/creator-guides/world-pack-authoring-v1-v4.md) 仅用于查阅历史，不能把旧版本命令或 schema 直接套进当前包。

2026-10-29 按 main 源码补齐可选文件：例如甜蜜日程包同时用了多场活动、角色自主、短信、随包角色预设和只换美术的舞台，这些文件现在都列在下面第 2 节，详细契约仍在各自指南。本次只核对文件名、登记方式和加载入口，没有重新试玩或重建发行包。

2026-10-22 核对物品创作入口：例如希望角色拿起钥匙再交给汤汤，在包内 `scripts/status.js` 配置物品规则；当前所有 v5 示例包都已使用作者模板。本文说明源码接法，自动测试与真实样本的范围见[活动与状态指南](activity-and-variables.md#作者物品规则的验证范围)；未据此确认发行包已包含这些改动。

## 1. 从一个可以运行的包开始

只有程序包的创作者可以使用随包 [perspectra-creator Skill](../../../skills/perspectra-creator/SKILL.md)，用自带 Node 在新目录生成一个玩家、一个 NPC 和一个地点的空白 v5 源包，再逐步补作品内容。它还整合[酒馆卡静态提取与迁移](../../../skills/perspectra-creator/references/tavern.md)和[原生预设创作](../../../skills/perspectra-creator/references/presets.md)，卡片提取使用随包 Python，预设提供包推荐与预设库模板，并用 preset validate 单独校验。将整个 Skill 目录复制到所用 AI 工具的 Skill 目录；它不要求仓库、pnpm 或全局 Node／Python。下面的示例属于源码仓库，不附在本轮程序包中。

| 示例 | 适合验证 |
| --- | --- |
| [prototype-g1](../../../examples/world-packs/prototype-g1) | 最小角色、房间、物品与交互 |
| [character-autonomy](../../../examples/world-packs/character-autonomy/README.md) | 实验分支的关键角色自主行动、作者触发与区域许可 |
| [launcher-demo](../../../examples/world-packs/launcher-demo) | 变量、猜数字活动、包预设与社区前端 |
| [hand-in-hand](../../../examples/world-packs/hand-in-hand) | 角色交互与关系解除绑定 |
| [multiple-activities](../../../examples/world-packs/multiple-activities) | 两场独立活动、暂停、继续与作者恢复条件 |
| [ai-girls-hosted-guess](../../../examples/world-packs/ai-girls-hosted-guess) | 主持角色私有信息与多 NPC 活动 |
| [ai-girls-awaken-v10](../../../examples/world-packs/ai-girls-awaken-v10) | 多角色连续试玩 |
| [model-girls-dinner](../../../examples/world-packs/model-girls-dinner/README.md) | 角色各有秘密的多人局、物品显示名、一键活动操作与旁白 |
| [status-market](../../../examples/world-packs/status-market/README.md) | 金钱等常驻状态、只告诉部分人的结果、按已知状态筛选知识 |
| [rpg-turn-battle](../../../examples/world-packs/rpg-turn-battle/README.md) | HP / MP、轮流攻击与胜败奖励的回合战斗活动 |
| [model-girls-werewolf](../../../examples/world-packs/model-girls-werewolf/README.md) | 隐藏回合：夜里谁醒着不写进公开 turn，角色上下文里只有本人知道；默认舞台不显示谁在回复，但公共 PlayerView 的 `responders` 仍带正在处理的角色 |
| [model-girls-sweet-days](../../../examples/world-packs/model-girls-sweet-days/README.md) | 多场条件生活事件、角色自主、短信、随包角色预设与舞台美术 |
| [plugin-capabilities-demo](../../../examples/world-packs/plugin-capabilities-demo/README.md) | 包内插件模块调用玩家启用的本地 Cordis 能力 |

复制整个目录到自己的新目录。独立作品设置新的 `packId`，保留所有引用一致；修改正式内容时提升 `packVersion`。不要只改版本号期待旧存档自动迁移，运行时也校验实际内容摘要。

先改世界标题和角色人设，再添加地点、物品与认知；每一步校验通过后再加玩法。用 AI 生成时要求保持所选示例各文件的 schemaVersion、ID 引用及字段结构，不添加未知字段或凭证。

## 2. 源目录与入口

必需文件以 `launcher-demo` 为例，`#` 后是可选文件：

```text
my-world/
  worldpack.source.json
  world.json
  characters.json
  locations.json
  entities.json
  scenes.json
  player-slots.json
  presentation.json
  cognition.json
  memory.json
  reaction.json
  manifestation.json
  interactions.json
  assertions.json
  scripts/status.js              # 状态与物品规则
  scripts/activity.js            # 单场活动（标识 default）
  scripts/activities/<标识>.js   # 或多场独立活动
  documents.json + *.md          # 大段设定正文
  knowledge.json                 # 按关键词和权限交付设定
  autonomy.json                  # 玩家不在身边时角色的自主机会
  communication.json             # 跨场景短信（实验）
  plugins.json + plugins/*.js    # 包内插件模块
  model-preset.json
  role-presets.json
  cover.png
  frontend/manifest.json         # 整页替换：manifest + index.html …
  frontend/index.html
  frontend/theme.css             # 或只换美术：theme.css、portraits/、backgrounds/、stage.json
  frontend/portraits/<角色>.png
  frontend/backgrounds/<地点>.jpg
```

`worldpack.source.json` 是 Core 编译入口。完整形状可直接参照 [当前示例清单](../../../examples/world-packs/launcher-demo/worldpack.source.json)，不要把下面分类表当成可省略必填字段的缩略 schema。

| 文件/清单字段 | 内容及注意点 |
| --- | --- |
| sourceSchemaVersion、packId、packVersion | v5 源版本、内容包身份、作者版本 |
| worldFile | 世界配置、初始事实与当前宿主 profile |
| characterFiles | 角色 ID、人设、控制类型、初始位置与交互绑定 |
| locationFiles / entityFiles | 地点与对象；定义不等于可绕过规则改变运行中位置/归属。物品可加可选的 `name`（如“玻璃蒸馏器”），玩家界面和角色收到的行动结果会用这个名字，而不是 `entity:distiller` |
| sceneFiles / playerSlotFiles | 初始场景、参与者、玩家绑定；引用须存在 |
| presentationFiles | 世界与角色的展示配置 |
| cognitionFiles / memoryFiles | 角色各自初始认知、目标及记忆配置；不把秘密写成人人可见的描述 |
| documentFiles / markdownFiles | 按示例格式登记文档与文本，不隐式扫描全部文件 |
| reactionFile / manifestationFile | 连续反应与叙事表现配置；沿用 v5 示例当前版本 |
| interactionFile | 宿主已安装的交互包、定义版本和绑定 |
| assertionFiles | 断言声明；当前 `worldpack test` 仅编译计划，不执行断言 |
| assetFiles | Core 资产；只有登记过的文件才会被宿主读取。`scripts/status.js`、`scripts/activity.js`、`scripts/activities/<标识>.js`（标识小写字母开头，可含数字和连字符，最长 41 字符）、`knowledge.json`、`autonomy.json`、`communication.json`、`plugins.json` 与 `plugins/*.js` 都登记在这里 |
| scripts/activities/<标识>.js | 多场独立活动，每个文件一场，各自保留进度、一次只运行一场；与 `scripts/activity.js` 可并存，但不能再用 default 作标识。契约见[活动与状态](activity-and-variables.md#多活动选择与暂停2026-10-10当前源码) |
| knowledge.json | 运行时按权限、关键词和条件交付 documentFiles 里的设定；见[世界设定指南](world-knowledge.md) |
| autonomy.json | 指定哪些角色每隔几回合、在哪些地点获得自主处理机会，以及可用的操作；见[创作者运行时](../architecture/creator-runtime.md) |
| communication.json | 跨场景短信的媒介名和有向联系人，见第 5 节 |
| plugins.json / plugins/*.js | 包内插件模块，可声明所需的本地 Cordis 能力；必需能力缺失时世界打不开并写明缺少什么。见[包内插件](dual-plugin-entrypoints.md) |
| model-preset.json | 可选包推荐预设，独立读取；详见预设文档 |
| role-presets.json | 可选随包角色专属与角色组预设；启动器载入包时校验，并提示玩家一键分配到实例。不参与编译，也不改变包 Hash；详见[预设文档第 9 节](../model-presets.md#9-随包角色预设与一键分配2026-10-24当前源码) |
| frontend/ | 可选。放 `index.html` 时整页替换，须带 manifest 与内容授权；只放 `theme.css`、`portraits/`、`backgrounds/` 和 `stage.json` 时沿用官方舞台，只换样式和美术，立绘与背景按 ID 去掉前缀匹配（`character:companion` → `portraits/companion.png`）。详见[前端指南](web-ui.md)与[立绘出图要求](portrait-art.md) |
| cover.webp / cover.png / cover.jpg | 可选 Launcher 封面，放在包根目录，≤4 MB，建议 16:9。不参与编译，也不改变包 Hash；详见[创作者运行时](../architecture/creator-runtime.md) |

JSON 用 UTF-8，不写注释、尾随逗号或未知字段。各文件 schemaVersion 不全相同，不可统一替换成 v5。ID 使用稳定、合法、唯一的值；改角色 ID 时一起修改场景、认知、玩家槽和活动的引用。私有认知的 basisKeys 必须对应合法来源，不能引用其他角色的私密信息冒充已知。

完整字段约束由 [World Pack 源码](../../../packages/world-pack/src) 的当前 schema 和校验器决定；现有示例是可运行参照，本文不承诺旧版手册的每个字段仍有效。

## 3. 人设、信息与状态的边界

保留至少一个 manual 玩家和可参与的 scripted NPC。这里的 scripted 是 Core 控制类型，不表示你需要写 NPC 台词脚本。角色的公开人设用于扮演建议；秘密、误解与观察放在对应角色认知中，并按权限进入上下文。

NPC 自行决定回应或沉默，以及台词、情绪和行动。不要在调度脚本里预先规定角色态度或行为策略。仅在玩法确实追踪时结构化重要物品、位置、对象和机制状态；普通姿态、表情及细微动作保持叙事自由。

需要改变权威世界事实时走已有 Action / Rulebook / Event 路径。自由文本和普通变量补丁不能代替物品转移或移动的裁定。数据库没有变化也不代表叙事越权已解决，试玩时要观察其他角色是否开始相信虚构结果。

## 4. 交互定义和绑定

例如让玩家牵起汤汤的手，使用 [hand-in-hand 的 interactions.json](../../../examples/world-packs/hand-in-hand/interactions.json) 中的定义和角色绑定；松手通过 relationBindings，而不是靠一句台词删除关系。当前宿主的基础交互包只提供 `base:hold-hand` 和 `base:end-contact`，仍需包显式声明定义版本与绑定。

例如要拿起钥匙、把它放下或交给别人，复制[物品规则模板](../../../examples/templates/item-rules.js)到包内 `scripts/status.js`，在顶部 `ITEM_RULES` 分别列出允许 take、drop、give 的物品 ID，并按完整示例把模板并入脚本定义、policy 和 resolve；在 assetFiles 登记脚本。模板是可修改的作者代码，不是宿主内置能力。操作声明的 `targets` 绑定物品；`resolve` 第六参数接收目标 ID，返回 `items` 改外观或以 `to: { holderId }`／`{ locationId }` 交接。宿主校验后与本次行动的对白、状态结果和观察原子提交，详见[物品接口](activity-and-variables.md#对物品做的操作2026-10-22当前源码)。JSON 声明不能凭空安装新实现，超出现有脚本结果能力的机制仍可能需要扩展宿主。

物品操作的名字来自脚本中的 `label`。例如 `entities.json` 写 `"name": "一锅米"`，操作写 `label: '拿起{item}'`，菜单显示“拿起一锅米”；料理操作可直接写“用电饭煲煮一锅白米饭”。模板中的交给只产生一个“把一锅米交给”选项，点击后通过“交给谁”填写 `recipientId`；不为每个接收者生成一个选项。`characterParameters: ['recipientId']` 让宿主检查接收者属于当前授权场景，模板再拒绝交给自己。界面使用宿主返回的选项与参数契约，不自行拼接 optionId。物品应写 `name`，名称也会进入角色看到的物品描述；它只影响显示，不改变裁定或权威归属。

内置牵手等绑定仍可写 `label`（1–60 字），没写时有“牵起某人的手”等通用说法；relationBindings 暂不支持自定义 label。拿／放／给不再使用绑定上的内置名称兜底。`base:take`／`base:drop`／`base:give` 和旧料理／修理核心模块已删除；活动 policy、`autonomy.json` 统一引用 `status:take`／`status:drop`／`status:give`。旧包需修改脚本与引用后新建实例。

## 5. 扩展玩法和界面

- [活动与状态](activity-and-variables.md)：固定后端脚本、public/private/internal 范围、有界角色机会；经裁定的常驻状态与状态栏。另有多场活动与暂停、按条件自动开始（`autoStart`）、一键操作（`quick: true`）、固定演出（`simulate`）和隐藏回合：活动的 turn 每个参与者都看得到，狼人杀夜里谁醒着这类秘密写在 internal 和本人 private，由 schedule 读完整状态叫醒对的人。这只对角色隔离：默认舞台只显示“正在回复”，但公共 PlayerView 的 `responders` 仍列出正在处理的角色，玩家用开发者工具或社区前端可以读到；活动 revision 也会随夜间操作增加。玩家自己那份 private 也会显示在玩家的活动卡片上。
- 角色自主（`autonomy.json`）：例如留守者独自在后室，每两回合获得一次机会，可以自己走去前室或拿钥匙。只给机会，不规定他做什么，也不把前室的对话传给他。
- 跨场景短信（实验）：根目录放 `communication.json`，写 `{"medium": "短信", "contacts": {"character:player": ["character:a"], "character:a": ["character:player"]}}`，并登记进 `assetFiles`。联系人是有向许可，不等于在场；短信正文只证明发送者这样说，收信人不获得对方房间的视野。想让角色在自主行动里也能发，在 `autonomy.json` 的 `interactions` 里加 `experiment:message`。电话尚未接入。
- [预设格式](../model-presets.md)：根目录可选 `model-preset.json`，附加提示、参数、原生节点和文本规则；模型凭证不属于预设。
- [包内插件](dual-plugin-entrypoints.md)：`plugins.json` 声明模块和所需的本地能力；能力由玩家在 Launcher 启用的 Cordis 插件提供，包不能自己安装原生代码。BGM 也通过 Cordis 插件提供曲库。
- [自定义前端](web-ui.md)：HTML/CSS/JS 与公共玩家 API；只想换风格时放 `theme.css`、立绘、背景和 `stage.json`（取景、表情差分、姿势）即可。没有 frontend 时自动使用官方界面，存在但配置错误时明确失败。

后端活动/状态脚本是可信本地代码，不能把浏览器 iframe 沙箱或“前端授权”理解为恶意后端包的安全保证。只加载信任来源的整个游戏包。

## 6. 校验与试玩

2026-10-24：candidate4 已上传为 [v0.3.1-test1 预发行版](https://github.com/YouLan5418/Perspectra/releases/tag/v0.3.1-test1)，目录含 `worldpack.cmd` 和统一创作 Skill，使用随包 Node／Python，无需创作者安装源码、pnpm 或全局运行环境。程序不附试玩包；验收通过与未通过范围见[本轮记录](../studies/program-package-creator-skill-20261024.md)。先检查版本，再检查自己准备的作品源目录：

```powershell
& 'D:\Perspectra\worldpack.cmd' --version
& 'D:\Perspectra\worldpack.cmd' validate 'D:\我的游戏'
& 'D:\Perspectra\worldpack.cmd' test 'D:\我的游戏'
```

成功输出一行 JSON 并退出 0；失败在标准错误输出 ErrorEnvelope 并退出 1，包契约诊断含文件和 JSON pointer，便于创作 Skill 逐项修正。完整命令见[随包创作校验说明](../../../scripts/release/CREATOR.zh-CN.md)。当前自动验证覆盖脱离仓库、空 PATH、中文及空格路径下的命令入口、编译／适配／本地初始化和诊断；不等于完整 Launcher 或真实模型体验验收。

源码开发者仍可在仓库根目录执行：

```powershell
corepack pnpm@11.7.0 worldpack validate examples/world-packs/launcher-demo
corepack pnpm@11.7.0 worldpack test examples/world-packs/launcher-demo
```

校验检查源格式、引用、声明资产与已安装交互选择，不执行玩法脚本，也不加载完整宿主的状态、活动、知识、前端及预设扩展配置；`worldpack test` 当前返回 `status: compiled`、`assertionsExecuted: 0`，只编译和适配断言计划，不能当成断言执行成功或真实角色体验通过。可以用 `worldpack compile <源目录> --out <文件>` 导出编译制品，并用 `worldpack inspect <文件>` 查看；**Launcher 和当前网页的 --pack 仍传源目录，不传该制品**。

加载修改后的包并创建新实例，进行 [真实模型试玩](creator-playtest.md)。同一兼容包可以续玩，内容改变后旧实例可能因摘要不一致拒绝启动；保留原包及旧存档，不强行改哈希。新实验使用新目录，不写入 `D:/worlds` 历史数据。

发布给测试者时带齐源清单引用、后端脚本、推荐预设和前端资源；删除密钥、数据库、私有日志及模型请求。公开静态前端素材绝不能放秘密。说明所需宿主版本、建议模型、已验证玩法和已知限制；当前不提供包 ZIP 自动导入或跨版本存档迁移保证。
