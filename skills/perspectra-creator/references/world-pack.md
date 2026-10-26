# 源包、角色与信息

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

背景设定不会自动成为角色亲历。大卡和长文先按受众、主题拆分，并按实际选择预算组织；静态字符总量不等于每次模型注入量。constant 只免除关键词匹配，仍受受众、条件与预算限制。

可选 when 是 JSON Schema，根 type 为 object；只读取接收者获授权的 public/self/characters 状态、characterId、locationId、scene、items、activity、stimulus、knownStatus。属性要存在时写 required；`knownStatus.current=false` 和 items.lastObserved 表示上次确认，不能当成当前真值。条件不能扩大私有文档受众，完整宿主载入仍需实际验证。
