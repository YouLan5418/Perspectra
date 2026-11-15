# 源包、角色与信息

## B7 显式组合与共同脚本（源码）

列入 assetFiles 只说明它是资产，不会自动启用玩法。添加或删除玩法时同步修改 worldpack.source.json 的 plugins；无需填满 services。

| 内容 | plugins 声明 |
| --- | --- |
| rpg.json | official-rpg 与 official-dice |
| trpg.json | official-trpg 与 official-dice |
| autonomy.json | official-autonomy |
| communication.json | official-communication |
| scripts/pacing.js | official-pacing |
| 旧 status.js、plugins.json、活动脚本 | pack-scripts；使用骰子再加 official-dice |

例如增加 "plugins": { "official-rpg": {}, "official-dice": {} }。精确版本和配置路径可写成 "official-rpg": { "version": "1", "config": "configs/rpg.json" }，config 路径也要列入 assetFiles。configSchema 公开结构，validateConfig 检查实体引用及跨字段条件，错误会阻止开档。

新玩法可声明 "scripts": { "gameplay": { "entry": "scripts/gameplay.cjs", "config": { "energy": 1 } } }。自包含脚本以 module.exports 导出 SDK 的 ContentGameplay；状态、操作、用途、参数 Schema 与结果投影和原生定义相同。entry 列入 assetFiles，不自动扫描未声明脚本。源码单文件示例在 examples/gameplay/investigation.cjs，默认控件与面板接入留 B8。

services 只在确实要求特定 Provider 时填写，如 "services": { "scheduler": "my-grid-scheduler" }；冲突会中止启动。LLM 通道、记忆实现和凭据通常交玩家管理。

静态 CLI／Launcher 预检不启动 Provider，遇到 services 时明确报告尚待宿主选型校验（CLI 为 runtimeValidation: pending-host-selection），不把静态合法当作运行环境已满足。正式开档按实际所选 Provider ID 校验，包括默认 LLM 入口。

共同脚本仅支持同步定义与有限 JSON 数据：不支持 async／await、动态 import、Promise、WebAssembly、Atomics 或异步内置 API，不提供时钟和未记录随机。函数留在 VM 中，每次调用上限 100 ms；脚本及单次跨界数据上限 1 MiB。配置文件读取上限也统一为 1 MiB；TRPG 加入玩家及名称后的活动配置另限 256 KiB，纯校验与正式开档一致。需要外部资源的实现使用已被用户信任的原生插件。

第三方生成器默认把原始配置交给共同定义；若生成器已在闭包内展开配置，可返回 gameplayConfig 显式指定定义收到的配置（官方 RPG／TRPG 使用空对象）。正式打开与读档预检遵循同一规则。

原生插件须先安装并允许执行，包只能选择已有插件。第三方导出 packPlugin 供纯校验；源码 CLI validate／compile／test 可追加 --plugins settings.json。这里描述源码能力，不代表旧发行版支持。


例如玩家来到书房，与知道旧信件的同行者交谈：characters 写身份与扮演特点，locations 写书房，scenes 决定初始在场者；信件内容只放在有权知道者的认知或私有知识中。不要把秘密写进地点公共名称或 NPC 的公开人设来模拟私有信息。

## 修改脚手架

先运行 `scripts/create-world.mjs`，它创建全部必需 JSON。各文件版本不同，不能批量统一成 v5。

| 文件 | 修改内容与联动 |
| --- | --- |
| worldpack.source.json | 新作品的 packId、作者版本 packVersion、所有文件引用；不会自动扫描其他目录 |
| world.json | title、公共 description；沿用现有 coreProfiles 和 playerInputPolicy，不凭名称创造新宿主插件 |
| characters.json | manual 玩家与 scripted NPC、初始地点、portrayal；scripted 表示 Core 控制，不是固定台词 |
| locations.json / scenes.json | 地点、初始场景与角色名单；改 ID 同步改角色位置与场景引用 |
| entities.json | 确实要追踪的物品；定义不意味着自动提供拿／放／给 |
| player-slots.json | 玩家角色绑定；改玩家 ID 同时改这里 |
| cognition.json | 各角色自己的初始观察与目标；修改角色数量时同步认知与记忆名单 |
| memory.json | 记忆 profile 和 attentionTopics；初始设定不伪装为发生过的全部历史 |
| reaction.json / manifestation.json | 保留模板的有界回应与自由叙述配置 |
| interactions.json | 至少选择一个宿主交互包；脚手架选基础包但未绑定具体动作，不会自动提供牵手；不是任意 JS 玩法的通用注册表 |
| assertions.json | 断言声明；CLI test 不执行它们 |

按玩法需要再加可选文件。宿主不会扫描目录：documents.json 登记到 documentFiles，正文 Markdown 登记到 markdownFiles，脚本、knowledge.json、autonomy.json、communication.json、plugins.json 和 plugins/*.js 登记到 assetFiles；预设、封面和 frontend/ 不登记：

| 文件 | 用途 |
| --- | --- |
| scripts/status.js | 常驻状态、物品规则和自定义操作，见[玩法扩展](gameplay.md) |
| scripts/activity.js 或 scripts/activities/<标识>.js | 一场或多场活动；标识小写字母开头，可含数字和连字符，最长 41 字符，default 留给 activity.js |
| documents.json（documentFiles）+ *.md（markdownFiles）、knowledge.json（assetFiles） | 大段设定和运行时选择，见下文 |
| autonomy.json、communication.json | 角色自主机会与跨场景短信，见[玩法扩展](gameplay.md) |
| plugins.json + plugins/*.js | 包内插件模块，可声明玩家需启用的本地 Cordis 能力 |
| model-preset.json、role-presets.json | 包推荐预设与角色专属预设，见[原生预设](presets.md)；不参与编译 |
| cover.png／.webp／.jpg | Launcher 封面，≤4 MB，建议 16:9；不参与编译 |
| frontend/ | 只换美术时放 theme.css、portraits/、backgrounds/、stage.json；放 index.html 则整页替换并须带 manifest.json |

所有 JSON 用 UTF-8，不能有注释、尾逗号或未知字段。文件路径保持包内相对路径，新增 JSON/Markdown/脚本按其用途登记。编译通过后保持完整源目录供 Launcher 载入；不要只交付 compile 的 JSON。

## 初始认知

可以为同行者添加一条自己的观察和基于它的目标，数组放在对应 characterId 的记录中：

```json
{
  "characterId": "character:companion",
  "observations": [{
    "key": "observation:companion-letter",
    "content": "我昨晚独自读过那封信，知道寄信人要求今天见面。",
    "epistemicKind": "direct_observation",
    "saliencePermille": 600
  }],
  "goals": [{
    "key": "goal:companion-meeting",
    "objective": { "kind": "narrative", "value": "先判断是否愿意向玩家说明信件。" },
    "priorityPermille": 500,
    "targetKeys": [],
    "basisKeys": ["observation:companion-letter"]
  }]
}
```

basisKeys 引用本角色合法来源，不能直接引用别人未公开的私有观察。叙事目标表达动机，不保证角色一定采取某个行动，也不会直接完成任务状态。

## 大段背景知识

新增 `documents.json` 并加入清单的 documentFiles；正文 `letter.md` 加入 markdownFiles。对应文档记录示例：

```json
{
  "schemaVersion": "worldpack-documents/v2",
  "documents": [{
    "documentId": "document:letter",
    "contentRef": "letter.md",
    "usage": "world_context",
    "audience": "character_private",
    "characterIds": ["character:companion"]
  }]
}
```

需要运行时选择该设定时，新增 `knowledge.json` 并登记到 assetFiles：

```json
{
  "maximumCharacters": 4000,
  "entries": [{
    "documentId": "document:letter",
    "keywords": ["信", "见面"],
    "constant": false,
    "priority": 10
  }]
}
```

背景设定不会自动成为角色亲历。大卡和长文先按受众、主题拆分，并按实际选择预算组织；单篇正文长于 maximumCharacters 时宿主拒绝加载，可用 `scripts/split-knowledge.mjs <作品目录>` 按段落拆分（先加 `--dry-run` 看计划），拆后逐段改写关键词；静态字符总量不等于每次模型注入量。constant 只免除关键词匹配，仍受受众、条件与预算限制。

可选 when 是 JSON Schema，根 type 为 object；只读取接收者获授权的 public/self/characters 状态、characterId、locationId、scene、items、activity、stimulus、knownStatus。属性要存在时写 required；`knownStatus.current=false` 和 items.lastObserved 表示上次确认，不能当成当前真值。条件不能扩大私有文档受众，完整宿主载入仍需实际验证。
