# World Pack v5 创作指南

当前 Launcher 与源码网页读取 `worldpack-source/v5` **源目录**。建议复制已运行的 v5 示例后逐步修改，不从历史 v4 模板或旧 `worldpack init` 开始。本文是当前创作入口；[旧字段手册](../../archive/creator-guides/world-pack-authoring-v1-v4.md) 仅用于查阅历史，不能把旧版本命令或 schema 直接套进当前包。

## 1. 从一个可以运行的包开始

| 示例 | 适合验证 |
| --- | --- |
| [prototype-g1](../../../examples/world-packs/prototype-g1) | 最小角色、房间、物品与交互 |
| [launcher-demo](../../../examples/world-packs/launcher-demo) | 变量、猜数字活动、包预设与社区前端 |
| [hand-in-hand](../../../examples/world-packs/hand-in-hand) | 角色交互与关系解除绑定 |
| [multiple-activities](../../../examples/world-packs/multiple-activities) | 两场独立活动、暂停、继续与作者恢复条件 |
| [ai-girls-hosted-guess](../../../examples/world-packs/ai-girls-hosted-guess) | 主持角色私有信息与多 NPC 活动 |
| [ai-girls-awaken-v10](../../../examples/world-packs/ai-girls-awaken-v10) | 多角色连续试玩 |

复制整个目录到自己的新目录。独立作品设置新的 `packId`，保留所有引用一致；修改正式内容时提升 `packVersion`。不要只改版本号期待旧存档自动迁移，运行时也校验实际内容摘要。

先改世界标题和角色人设，再添加地点、物品与认知；每一步校验通过后再加玩法。用 AI 生成时要求保持所选示例各文件的 schemaVersion、ID 引用及字段结构，不添加未知字段或凭证。

## 2. 源目录与入口

以 `launcher-demo` 为例：

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
  scripts/variables.js
  scripts/activity.js
  model-preset.json
  frontend/manifest.json
  frontend/index.html
  frontend/app.js
  frontend/style.css
```

`worldpack.source.json` 是 Core 编译入口。完整形状可直接参照 [当前示例清单](../../../examples/world-packs/launcher-demo/worldpack.source.json)，不要把下面分类表当成可省略必填字段的缩略 schema。

| 文件/清单字段 | 内容及注意点 |
| --- | --- |
| sourceSchemaVersion、packId、packVersion | v5 源版本、内容包身份、作者版本 |
| worldFile | 世界配置、初始事实与当前宿主 profile |
| characterFiles | 角色 ID、人设、控制类型、初始位置与交互绑定 |
| locationFiles / entityFiles | 地点与对象；定义不等于可绕过规则改变运行中位置/归属 |
| sceneFiles / playerSlotFiles | 初始场景、参与者、玩家绑定；引用须存在 |
| presentationFiles | 世界与角色的展示配置 |
| cognitionFiles / memoryFiles | 角色各自初始认知、目标及记忆配置；不把秘密写成人人可见的描述 |
| documentFiles / markdownFiles | 按示例格式登记文档与文本，不隐式扫描全部文件 |
| reactionFile / manifestationFile | 连续反应与叙事表现配置；沿用 v5 示例当前版本 |
| interactionFile | 宿主已安装的交互包、定义版本和绑定 |
| assertionFiles | 断言声明；当前 `worldpack test` 仅编译计划，不执行断言 |
| assetFiles | Core 资产；启用后端变量或活动脚本时登记固定脚本路径 |
| model-preset.json | 可选包推荐预设，独立读取；详见预设文档 |
| frontend/ | 可选社区前端，独立 manifest 与内容授权；详见前端指南 |

JSON 用 UTF-8，不写注释、尾随逗号或未知字段。各文件 schemaVersion 不全相同，不可统一替换成 v5。ID 使用稳定、合法、唯一的值；改角色 ID 时一起修改场景、认知、玩家槽和活动的引用。私有认知的 basisKeys 必须对应合法来源，不能引用其他角色的私密信息冒充已知。

完整字段约束由 [World Pack 源码](../../../packages/world-pack/src) 的当前 schema 和校验器决定；现有示例是可运行参照，本文不承诺旧版手册的每个字段仍有效。

## 3. 人设、信息与状态的边界

保留至少一个 manual 玩家和可参与的 scripted NPC。这里的 scripted 是 Core 控制类型，不表示你需要写 NPC 台词脚本。角色的公开人设用于扮演建议；秘密、误解与观察放在对应角色认知中，并按权限进入上下文。

NPC 自行决定回应或沉默，以及台词、情绪和行动。不要在调度脚本里预先规定角色态度或行为策略。仅在玩法确实追踪时结构化重要物品、位置、对象和机制状态；普通姿态、表情及细微动作保持叙事自由。

需要改变权威世界事实时走已有 Action / Rulebook / Event 路径。自由文本和普通变量补丁不能代替物品转移或移动的裁定。数据库没有变化也不代表叙事越权已解决，试玩时要观察其他角色是否开始相信虚构结果。

## 4. 交互定义和绑定

从 [hand-in-hand 的 interactions.json](../../../examples/world-packs/hand-in-hand/interactions.json) 或最小示例复制结构：选择宿主安装的交互包，锁定定义 ID/版本，然后在角色、对象或关系上绑定。解除关系的绑定放在 relationBindings，而不是靠一句台词直接删除关系。

JSON 声明不能凭空安装新规则实现。超出现有交互包的玩法可能需要扩展宿主，当前不承诺任意机制都能零代码创建。物品给不同角色、同定义不同参数是不同动作；界面使用 Core 返回的选项，不自行拼接 optionId。

## 5. 扩展玩法和界面

- [活动与变量](activity-and-variables.md)：固定后端脚本、public/private/internal 范围、有界角色机会。
- [预设格式](../model-presets.md)：根目录可选 `model-preset.json`，附加提示、参数、原生节点和文本规则；模型凭证不属于预设。
- [自定义前端](web-ui.md)：HTML/CSS/JS 与公共玩家 API。没有 frontend 时自动使用官方界面，存在但配置错误时明确失败。

后端活动/变量脚本是可信本地代码，不能把浏览器 iframe 沙箱或“前端授权”理解为恶意后端包的安全保证。只加载信任来源的整个游戏包。

## 6. 校验与试玩

在仓库根目录执行，路径按自己的目录调整：

```powershell
corepack pnpm@11.7.0 worldpack validate examples/world-packs/launcher-demo
corepack pnpm@11.7.0 worldpack test examples/world-packs/launcher-demo
```

校验检查格式、引用与宿主支持；`worldpack test` 当前返回 `status: compiled`、`assertionsExecuted: 0`，只编译断言计划，不能当成断言执行成功或真实角色体验通过。可以用 `worldpack compile <源目录> --out <文件>` 导出编译制品，并用 `worldpack inspect <文件>` 查看；**Launcher 和当前网页的 --pack 仍传源目录，不传该制品**。

加载修改后的包并创建新实例，进行 [真实模型试玩](creator-playtest.md)。同一兼容包可以续玩，内容改变后旧实例可能因摘要不一致拒绝启动；保留原包及旧存档，不强行改哈希。新实验使用新目录，不写入 `D:/worlds` 历史数据。

发布给测试者时带齐源清单引用、后端脚本、推荐预设和前端资源；删除密钥、数据库、私有日志及模型请求。公开静态前端素材绝不能放秘密。说明所需宿主版本、建议模型、已验证玩法和已知限制；当前不提供包 ZIP 自动导入或跨版本存档迁移保证。
