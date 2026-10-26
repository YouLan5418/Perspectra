# 用包内规则扩展玩法

例如同行者想把钥匙交给玩家：对白可以表达意愿，物品归属必须由规则裁定。只在这件物品确实影响玩法时登记它；普通目光、姿态和语气不用增加状态键。

## 物品操作

1. 在 entities.json 添加物品，例如 `{ "entityId": "entity:key", "name": "钥匙", "kind": "key", "locationId": "location:start" }`。
2. 将本 Skill 的 `assets/status-items.js` 复制为作品的 `scripts/status.js`，把顶部 ITEM_RULES 中需要允许的 take/drop/give 数组改成该物品 ID。
3. 在 worldpack.source.json 的 assetFiles 加 `scripts/status.js`，用目标 CLI 校验，再载入新实例。

模板定义的是作者可修改的 `status:take`、`status:drop`、`status:give`。policy 按行动者知道的当前物品筛选选项；resolve 在执行前重查，宿主继续检查可达、去向和单一持有者，再提交物品事件。不要恢复已删除的 `base:take/drop/give`，也不要让普通状态值保存第二份物品归属。

模板操作分别有固定参数 schema；give 的 `recipientId` 通过 characterParameters 声明为角色参数，目标物品由选项绑定，resolve 第六参数接收 targetId。扩展烹饪／修理等操作时自行声明参数与规则，正确返回拒绝原因或经过裁定的结果，不能仅凭叙述完成动作。

## 常驻客观状态

金钱、HP、游戏时间或明确追踪的任务可以使用同一 `scripts/status.js`。它定义 `globalThis.statusScript`：

- definition.statuses 声明 key、label、type、owner，可带 schema；owner 为 public 或 character。
- definition.operations 声明操作、参数 schema、可选 actors、characterParameters 和 targets。
- initialize(characterIds) 接收角色 ID 数组，返回 `{ public: {...}, characters: { [角色ID]: {...} } }` 初始真值；没有状态时各对象为空，仍列出全部角色。
- policy(known, actorId, place) 用行动者已知状态和场景决定 operations／targets；选项可见不代表执行必定成功。
- resolve(truth, actorId, operationId, parameters, world, targetId) 重查规则；返回 changes、reveals、可选 items、description、audience，或仅返回 rejectReason。

changes 改真实值，reveals 用 observerId/holderId/key 指定谁获知哪个状态，值由宿主填入，不由作者任意传值。未知或过时不等于当前状态。仅将明确公开的值设 alwaysKnown；playerTruth 是主动交给玩家前端的真值，不会自动公开给 NPC。所有脚本均为作者可信代码，不应访问凭证或复制宿主内部实现。

## 活动、预设和界面

有局部回合、参与者或胜负的小游戏才考虑 `scripts/activity.js`；在 assetFiles 登记，定义 globalThis.activityScript 的 definition、initialize、policy、resolve、schedule/onOutcome。public 仅向参与者共享，private 各角色只读自己的部分，internal 不交给角色。它不是全世界公开状态。NPC 仍可自己决定是否接受与如何行动。

本 Skill 不提供未验证的复杂活动模板；没有对应版本的具体契约时先完成普通互动和客观规则，明确扩展未完成的部分，不猜字段声称已接通。用户要求活动时应取得同版本的活动指南或审阅可运行源包再实现，不把此限制变成永久删减用户范围的理由。

model-preset.json 和 frontend/ 是宿主独立读取的扩展；CLI 编译不等于它们已有效。默认沿用官方舞台，确需界面时仅使用公共玩家数据，静态前端不得含角色秘密或 Key。不把模型预设当作规则或权限的替代品。

验收至少覆盖：正确条件下出现选项、条件失效时被拒绝、成功后状态与观察一致、未授权角色没有获得秘密。数据库一致与叙事一致分别检查；未调用真实模型时不能宣布后者通过。
