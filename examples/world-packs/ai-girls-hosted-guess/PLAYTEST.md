# AI 美少女 · Claude 主持实验

包 ID `pack:ai-girls-hosted-guess`，版本 **1.0.0**，源格式 worldpack-source/v5。独立目录、新存档；原 AI 美少女包保留为脚本数值裁定对照。

## 如何玩

开始活动后，Claude 作为角色主持，私有持有 1–100 的答案。玩家与 GPT 轮流提交猜数，Claude 用 `judge` 提交“偏大”“偏小”或“猜中”。流程是：

```text
Claude 开场 → 玩家猜数 → Claude 裁决 → GPT 猜数 → Claude 裁决 → 玩家
```

脚本不会比较猜数与答案，也不会纠正错误裁决；它只记录主持人的决定，并据此换手或结束。若 Claude 判错，这就是本轮玩法实际采用的裁决。经历写作“Claude 主持人裁决为……”，不把它包装成程序核实的数值事实。角色名 Claude 不指定模型供应商；当前实验所有角色均使用本机 Gemini 3.7 Flash。

游戏期间保留自由对白，关闭 narration、移动和普通交互。猜数由顶部宿主控件提交，普通台词仍由下方包内页面输入。对白不能替代游戏操作，也不自动消耗游戏行动回合。玩家可主动 pass，或按玩法退出；宿主红色逃生按钮随时中止限制，取消待处理模型并恢复原本能力，保留已提交结果与记忆。

## 玩法由包内脚本定义

[scripts/activity.js](scripts/activity.js) 声明参与者、参数、角色权限、阶段、私有资料和下一处理者。宿主不认识“主持人”“猜数”或“答案”。

| 函数／字段 | 作者定义的内容 |
| --- | --- |
| definition.npcIds | 本活动 NPC ID 列表，玩家由宿主绑定 |
| definition.operations | 操作 ID、标签、封闭参数 schema、是否要求当前行动回合 |
| initialize({playerId,npcIds}) | 初始阶段、当前行动者及 public/private/internal 状态 |
| policy(scopedView,actorId) | 当前角色的对白、外显、移动、原交互及活动操作许可 |
| resolve(state,actorId,operation,parameters) | 裁定新游戏状态、结果描述及 participants/self 观察范围 |
| schedule(scopedView) | wait，或 activate 一个已声明 NPC |
| onOutcome(turnResult,scopedView) | 当前真实 Character Turn 之后等待或选择下一 NPC |

宿主负责身份、schema、权限、轮次／修订复核及原子提交；真正的角色调用、预算、超时和取消也在宿主。每次输入最多四次串行角色激活，每次最多两次决策机会；主动 recall 可增加一次补问，因此至多十二次实际调用，活动链总时限 90 秒。本包在模型失败、interrupted 或未成功提交操作时等待，保留真实轮次，提供显式重试与逃生；不把 abstain 或技术失败伪造成 pass。

模型只收到公开状态和自己的 private。答案只在 Claude.private，玩家与 GPT 不获得其他角色私有数据，非参与者不接收游戏操作的私密经历。作者应把私密结果放在对应 private 中：audience:self 限制结果观察的收件人，不会把已放在 public 的数据自动变私密。提交游戏状态与授权观察在同一世界事务中完成；未唤醒者仍拥有自己已授权的经历。重启恢复已提交阶段与轮次，不自动重跑未提交模型计算。

原包的角色背景、地点、variables.js 和对话页面继续复用。系统不追踪日常物品，未参与的 DeepSeek 和 GLM 不继承游戏限制。变量脚本的说明见 [原包试玩说明](../ai-girls-awaken-v10/PLAYTEST.md)；活动期间禁止 /vars 调试。

## 启动

```powershell
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/ai-girls-hosted-guess --data-dir .tmp/ai-girls-hosted-playtest-1.0.0
```

模型和凭证使用本机配置，不写入世界包。修改脚本后使用新数据目录，暂不迁移旧包存档。

## 已验证与限制

自动化测试验证三角色真实 Turn 管线、答案仅主持人可见、错误裁决也不暗中纠正、未授权角色拒绝、调度链预算、待裁决状态恢复与逃生、结果进入参与者现有记忆。

真实 Gemini 3.7 Flash 短冒烟共八次调用：Claude 开场；玩家猜 50；Claude 裁决；GPT 猜 25；Claude 再裁决，回到玩家。八次均返回并通过输出验证，没有重试。这是短流程验证，还不是长试玩或完整实局结束验收。

本入口使用现有 CognitiveMemoryService，独立 Hindsight Core 尚未接入，不能把本实验称为 Hindsight 长期认知验证。自由对白仍可能泄露答案或与操作结果矛盾，输入权限隔离不能保证模型表达永不出错。只支持一个活动、可信同步作者脚本，不提供多活动仲裁、并行收集、通用插件平台或恶意代码安全沙箱。

补充验收：轻量 check（类型、lint、20 文件 133 项测试）最终通过，相关三文件 48 项测试通过，desktop:build 与世界包编译通过。check 首次有一项未发出预期模型请求；相关单跑和完整复跑通过，未确定首次波动原因。浏览器真实完成 Claude 开场及宿主逃生，移动与输入恢复；发送按钮核验使用拦截请求，仅证明表单确实产生 submit 请求，没有把核验文本写入世界。
