# 按权限、关键词和授权处境交付世界设定

当前源码，2026-10-19；没有重新发行便携包。

例如守岸人与玩家在花房聊天：提到“黑海岸”时，作者的公开背景进入她的上下文；只有她有权知道的人设和秘密仍留给她自己。她如何看待玩家，结合人设、预设、记忆和对话历史动态形成，不需要先换算为信任或好感度。

本轮撤销了最初实验添加的关系数值、数值面板及其门槛提示。保留世界设定交付。变量优先承载玩法明确追踪的客观变化，例如游戏时间、库存、机关或任务状态；位置和物品继续复用已有事实与裁定。并非每个叙事细节都需要变量，角色主观认识也不能与世界真相混为一谈。

## 1. 声明正文和受众

正文继续放在 `documents.json` 和 Markdown，登记在源清单的 `documentFiles`、`markdownFiles`。用途为 `world_context` 或 `portrayal`，受众为 `public` 或 `character_private`；私有文档使用已有 `characterIds`。`portrayal` 仍只能私有。

在 `assetFiles` 加入 `knowledge.json`，单份配置最多 1 MiB，正文使用独立 Markdown：每条文档各占一个 Markdown 文件，单个文件最多 256 KiB。

```json
{
  "maximumCharacters": 8000,
  "entries": [
    {"documentId": "document:coast", "keywords": ["黑海岸"], "constant": false, "priority": 20},
    {"documentId": "document:own-persona", "keywords": [], "constant": true, "priority": 100}
  ]
}
```

documentId 必须实际存在。最多 4096 条、每条最多 256 个关键词，关键词最长 512 字符；世界包相应允许最多 4096 篇文档、4096 个登记文件，编译后合计仍不超过 16 MiB。总正文字数为 100–65536，单条正文只要不超过该预算即可整条交付，例如 4 万字的长设定；按 `priority` 从高到低选择，整条正文超出剩余预算则跳过，不截断成半条规则。单条正文比整个预算还长时，它永远不可能被选中；2026-10-26 起宿主在加载时直接报错，写明条目、字数和预算，而不是每轮悄悄丢掉。可以调高 `maximumCharacters`，或用创作者技能附带的 [split-knowledge.mjs](../../../skills/perspectra-creator/scripts/split-knowledge.mjs) 按段落、句子拆成不超过预算的多条：第一段沿用原文档 ID 与文件，其余为 `<原ID>-part-002` 等，受众、用途、关键词、常驻、优先级和条件全部沿用，拆完应逐段改写关键词。脚本不拆在其他 JSON 文件中被引用的文档，只在报告里列出。预算按字符计算，不是 token；预算越大，每次角色请求越长、越慢，也越贵，模型自身的上下文窗口仍是最终上限。不能保证所有激活条目都进入上下文。关键词按子串匹配，“条目5”也会被“条目59”命中。配置使用封闭字段，状态条件使用下述 when，不解析酒馆宏。

### 按已知状态筛选

例如角色自己的委托已经完成，才给它说明怎样领奖。条目可增加 `when`，内容是 JSON Schema。其中 `{ public, self, characters }` 与状态脚本 policy 使用相同的已知值；知识条件还可读取下面列出的授权场景和本次刺激。

```json
{
  "documentId": "document:reward", "constant": true, "keywords": [], "priority": 20,
  "when": {
    "type": "object", "required": ["self"], "properties": {
      "self": { "type": "object", "required": ["mission"], "properties": {
        "mission": { "const": "done" }
      } }
    }
  }
}
```

这里 mission 是作者声明的状态键；对象、数组状态也可用 properties、items、contains 等标准 Schema 条件判断。需要某个键存在时务必写 required，单独 properties 不要求字段存在。条件只读接收者已被告知的值；未知键不出现，旧值仍是上次确认。其他角色的隐藏变化不会直接激活条目。文档受众先校验，when 不能扩大私有文档的接收范围；随后状态条件与关键词均须满足，constant 只免除关键词检查，不免除 when 和预算。完整嵌套任务条件见[集市配置](../../../examples/world-packs/status-market/knowledge.json)。

### 按场景、物品、活动与本次刺激筛选

例如同行者在前室、能感知玩家、当前确认黄铜钥匙在眼前，才收到钥匙背景。无需把位置或物品归属再复制成状态键。`when` 的完整输入如下；这只是每次请求里的临时筛选视图，不新增存档，也不会直接把整份视图另发给模型。

| 字段 | 内容与边界 |
| --- | --- |
| `public / self / characters` | 接收者已知的状态值，可能过时；不是全局真实值 |
| `characterId` | 本次接收者 ID |
| `locationId` | 该角色当前位置；未提供时为 null，不从历史推断 |
| `scene` | 已授权场景，含 `locationId / name / people`；`people` 行含 `characterId / name`，不含其他角色私有材料 |
| `items` | `current` 为当前可确认的物品，行含 `entityId / holderId / locationId / kind` 等；`lastObserved` 只是上次观察，不能当作现在持有或可见 |
| `activity` | 当前参与活动的授权视图；无活动时为 null。含稳定的 `activityKey`、实例 `id / revision / participants`，以及 `game.active / phase / turn / round / public / private`；private 仅为本人部分，没有 internal |
| `stimulus` | 本次激活收到的授权观察数组；续写时可继续保留同一刺激。内容位于行的 `content`，不是全局转录，也不是历史关键词扫描结果 |
| `knownStatus` | 原有已知状态行，含 `key / label / holderId / value / current`，可以同时检查归属、值与新鲜程度；未知项不出现 |

筛选只使用这些显式字段，不开放完整 Context、他人认知、隐藏世界真值或先前注入的知识。缺省场景为 `{ "people": [] }`，物品为 `{ "current": [], "lastObserved": [] }`，刺激和已知状态均为空数组。字段是附加的；原来的状态条件可继续使用，若 Schema 根层设置 `additionalProperties: false`，须允许所需的完整视图字段。

以下可作为知识条目的 `when`，要求人在前室、玩家在授权场景内，且钥匙当前可确认：

```json
{
  "type": "object", "required": ["locationId", "scene", "items"],
  "properties": {
    "locationId": { "const": "location:front-room" },
    "scene": {
      "type": "object", "required": ["people"], "properties": {
        "people": { "type": "array", "contains": {
          "type": "object", "required": ["characterId"],
          "properties": { "characterId": { "const": "character:player" } }
        } }
      }
    },
    "items": {
      "type": "object", "required": ["current"], "properties": {
        "current": { "type": "array", "contains": {
          "type": "object", "required": ["entityId"],
          "properties": { "entityId": { "const": "entity:brass-key" } }
        } }
      }
    }
  }
}
```

若要求钥匙由同行者持有，在该物品条件的 required 加入 `holderId`，properties 加入 `"holderId": { "const": "character:companion" }`。不要用 lastObserved 的旧归属满足持有条件；持有文档也不自动证明已经阅读过。

下面的 `when` 要求默认猜数字活动正在进行，且本次激活确实收到玩家刺激。脚本直接安排的活动回合可能没有 stimulus，此时不会交付；只按活动阶段筛选时去掉 stimulus 条件即可。多活动包将 default 改成活动配置中的稳定 key；`id` 是运行实例 ID，不适合写成固定条件。

```json
{
  "type": "object", "required": ["activity", "stimulus"],
  "properties": {
    "activity": {
      "type": "object", "required": ["activityKey", "game"], "properties": {
        "activityKey": { "const": "default" },
        "game": { "type": "object", "required": ["active", "phase"], "properties": {
          "active": { "const": true }, "phase": { "const": "playing" }
        } }
      }
    },
    "stimulus": { "type": "array", "contains": {
      "type": "object", "required": ["content"], "properties": {
        "content": { "type": "object", "required": ["actorId"],
          "properties": { "actorId": { "const": "character:player" } }
        }
      }
    } }
  }
}
```

刺激正文可以进一步使用 Schema 的 pattern 筛选。玩家输入的正文通常位于 `speech.text`；NPC 表达通常用 `speech.segments` 片段数组，可用 contains 检查 `type: speech` 的片段及其 text。需要同时支持两种来源时，用 anyOf 分别检查这两个形状；使用 pattern 时必须同时声明 `type: string`。这不改变 keywords 的固定子串匹配，也不把历史对白当作本次刺激。玩家声称“拿到了钥匙”只证明它说过这句话，不能代替物品条件或规则裁定。没有刺激的自主机会不会满足要求刺激的条件。

### 只在已知状态仍有效时交付

例如购买建议只适用于同行者已确认且未过时的余额。以下 `when` 同时检查 key、holderId、value 和 current，避免把别人的已知余额或旧值用来满足条件：

```json
{
  "type": "object", "required": ["knownStatus"], "properties": {
    "knownStatus": { "type": "array", "contains": {
      "type": "object", "required": ["key", "holderId", "value", "current"],
      "properties": {
        "key": { "const": "money" }, "holderId": { "const": "character:companion" },
        "value": { "type": "number", "minimum": 20 }, "current": { "const": true }
      }
    } }
  }
}
```

`current: false` 可用于选择“需要重新核实”的材料，但不会告知现在的值、来源或原因。它沿用状态系统已有的过时标志：即使角色未观察到变化，也能知道旧值过时，这是现有的认知限制。本次不改变状态系统。知识选择在每次角色请求时重算，不保证角色思考期间状态不再改变；执行仍由最新事实裁定。

## 2. 什么会进入角色请求

先检查文档受众，再用该角色自己的授权场景、近期观察、自身发表、刺激及召回内容做忽略大小写的关键词匹配。任一词命中即可；不扫描全局转录，不从其他角色知识补齐，不扫描本次注入内容做递归触发。不因未命中追加模型调用。

[PackKnowledge](../../../desktop/host/pack-knowledge.ts)在现有 Core／原生记忆交付后、预设准备前，把正文放进 `context.knowledge`，标明 `author_setting`。它不伪装成新近亲历，也不直接写入角色记忆或情绪。作者笔记、导演文档不进入此通道。

## 3. 客观变量与角色态度的边界

“她记得玩家曾经帮过她，所以更愿意谈自己的过去”属于角色对经历的理解和表达。无需建立分数，也不通过分数强制决定情绪、同意或对白。

“玩家购买了一份食材，库存减少一份”属于玩法明确追踪的客观变化，应沿既有交互／规则／事件提交。库存减少不代表角色因此喜欢玩家。活动可以维护自己的客观进度；金钱、HP、时间这类常驻客观值用经裁定的[状态](activity-and-variables.md#3-状态2026-10-19当前源码)，它们只以世界事件提交（2026-10-19 起替代已退役的包变量）。不能靠两个存储分别写一次维护同一个重要事实。

常驻状态现支持结构化值、操作 policy 与知识 when 条件；它们不自动触发下一条事件或规定角色态度。确实需要基于任务、道具或时间开放某项玩法时，仍在该玩法现有规则中检查执行条件并提交实际效果。

## 4. 验证与限制

- 配置启动时校验包内路径、大小及编译摘要；出错拒绝启动，不加载未登记文件。
- 当前支持常驻／固定关键词／授权处境 Schema 条件／优先级与字符预算，没有递归世界书、keywords 正则触发或完整酒馆脚本兼容。
- 条件关闭只停止本次交付，不撤回已发表内容或记忆；分发不自动唤醒角色、安排动作或解锁实际操作。没有新增交付次数、冷却、随机分发或隐藏真值入口。
- [离线回归](../../../tests/scenarios/pack-story-slice.test.ts)覆盖受众、整条预算跳过、配置篡改、600 条文档与约 4 万字单条的编译和交付，以及 Ollama／本地 OpenAI 两条协议的宿主私语隔离、重开与末端重新生成。使用模拟 HTTP 服务，不调用真实模型。
- 2026-10-19 新增条件的回归覆盖位置、场景人物、当前／旧物品及持有者、活动、刺激与已知状态新鲜程度；两条宿主协议验证场景／物品／刺激组合，[活动回归](../../../tests/host/pack-activity.test.ts)验证本人私有材料可用、他人私有与 internal 不可用、退出后停止交付。[DeepSeek 条件知识试玩](../studies/knowledge-conditions-deepseek-playtest-20261019.md)完成 19 步、39 次真实请求，所有交付符合预期，覆盖新条件的交付与缺席；未发现他人余额、玩家活动私有或内部答案泄漏。角色仍会把作者设定说成自己读过的经历；单次样本不证明长期语义一致性，发行包未重建。
- [DeepSeek 真实试玩](../studies/tavern-card-deepseek-playtest-20261018.md)记录移除分数前版本的知识交付和私语边界；旧数值未触发不是当前待修目标。移除后版本未重跑真实模型，不能把旧结果直接视作新版本完整验收。

本机生成及当前切片见[花房实验](../studies/tavern-card-slice-20261018.md)。
