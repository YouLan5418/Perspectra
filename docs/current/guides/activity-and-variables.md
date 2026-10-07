# 创作者：活动与包变量

当前玩法桥由实验宿主加载可信本地脚本。先复制 [launcher-demo](../../../examples/world-packs/launcher-demo) 或 [主持猜数字示例](../../../examples/world-packs/ai-girls-hosted-guess)，逐步修改并真实试玩。完整运行时边界见 [创作者运行时](../architecture/creator-runtime.md)。

## 1. 文件和信任范围

`worldpack.source.json` 的 assetFiles 必须登记 `scripts/activity.js`、`scripts/variables.js`，宿主按固定路径读取；仅把脚本放进目录不代表启用。加载时核对编译资产内容和包内路径。脚本使用同步 JSON 输入/输出，执行时间和数据大小有界，不能把异步模型调用或任意数据库对象当成参数。

**这是可信作者的后端扩展，不是不可信脚本安全沙箱。** 浏览器社区前端的 iframe 与授权只约束前端，不为整个恶意游戏包提供安全保证。只加载可信来源的后端脚本，不放模型密钥或私有运行日志。

## 2. 活动生命周期

固定入口为 `globalThis.activityScript`。定义和 hook 的完整形式以 [演示脚本](../../../examples/world-packs/launcher-demo/scripts/activity.js) 与 [当前活动桥](../../../tests/experiments/pack-activity.ts) 为准。

| 部分 | 职责 |
| --- | --- |
| definition | title、npcIds、operations；声明操作 ID、标签、是否消耗回合及参数 schema |
| initialize | 根据宿主提供的玩家和 NPC 身份生成初始状态 |
| policy | 限定当前角色可用的发言、叙事、移动、交互和活动操作 |
| resolve | 对操作参数同步裁定，返回新状态和结果描述 |
| schedule / onOutcome | 等待，或给已声明角色一次处理机会；不规定其情绪、策略或台词 |

操作 schema 为明确属性的对象，不接受额外字段；活动身份/版本由宿主提供，不能在属性中重定义 activityId、revision。最多 8 个 NPC、16 个操作，开始时参与者必须存在且同场景；当前不提供任意多活动叠加。

状态分为：

| 字段 | 可见范围 |
| --- | --- |
| public | 活动参与者共同可见 |
| private | 只交付对应角色的部分 |
| internal | 程序内部裁定材料，不进入角色视图 |
| active / phase / turn / round | 活动控制状态，按当前脚本契约生成 |

猜数字的答案可以留在 internal，若主持角色需要知道答案则写进该角色 private。不要先把秘密写进 public，再试图用结果收件人 self 补救；操作 description 也应检查是否泄密。

Activity 收紧局部玩法许可，不代替模型决定扮演内容。活动状态沿 activity.updated 提交；位置和物品仍走已有规则路径。宿主限定角色调用次数和链路耗时；耗尽或失败保留已提交结果，玩家可重试或逃生，未提交机会不保证精确恢复。

开始/退出及恢复控制在宿主界面。当前社区前端 SDK 不提供活动管理私有接口，不能直接读内部答案或执行后台脚本。

## 3. 包变量

固定入口为 `globalThis.packScript`，提供 initialize、getVariables、applyPatch。参照 [演示变量脚本](../../../examples/world-packs/launcher-demo/scripts/variables.js) 与 [变量桥](../../../tests/experiments/pack-variables.ts)。

initialize 为各角色返回 public 和 private；所有角色初始化出的公共部分须一致。getVariables / applyPatch 接收公共值及当前角色自己的私有值，不能通过普通变量接口读取别人的 private。

变量适合玩法明确维护的计数、标签和角色私有值。脚本的补丁规则由示例实现：演示允许对已声明路径做 test / replace，不支持任意新增字段。不要假定所有作者脚本都有同一套补丁语义，更不要用变量冒充已经裁定的移动或物品转移。

变量保存在实例 `pack-variables.json`，绑定当前包内容。它是现有独立文件，不是 World Event Log 的通用事实事务；完整节点保存会一并保留变量。当前公共玩家 SDK 没有任意变量读写接口，不能把调试接口当成创作者前端 API。

## 4. 试玩要求

校验包后创建新实例：检查开始条件、每个操作的合法/非法参数、轮转、结束、模型失败后的重试与逃生。分别让参与者知道不同秘密，检查角色上下文、结果描述和公开页面是否泄漏。再保存完整节点、改变状态并分叉，确认活动与变量回到节点时刻。

自动化结构检查不证明自然度，也不能证明自由文本永不违背裁定。遇到玩法需求超出现有宿主支持，先记录具体体验缺口，不把任意新 JSON 字段当成已实现规则。
