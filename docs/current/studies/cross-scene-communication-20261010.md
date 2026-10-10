# 跨场景通信实验：短信

分支：`codex/cross-scene-communication`。日期：2026-10-10。这里只说明独立源码实验，不表示默认网页、Launcher 或 test3 发行包已具备通信能力。

玩家独自在前室，同行者与留守者在后室。玩家给同行者发送短信；同行者可以回复、沉默，也可以向留守者说话。留守者只收到后室发生的授权表达，不因同行者收信而获得短信内容。

## 实验实现

- [一次投递规则](../../../tests/experiments/cross-scene-communication.ts)复用 RulebookResolver/Registry，使用 `interact` 的现有参数形状；特殊实验绑定仅由此入口安装，不加入通用物理可达目标。
- [实验运行时](../../../tests/experiments/cross-scene-runtime.ts)使用原有 PrototypeCharacterTurn、WorldStore 短事务、原生记忆与有界激活。没有加载活动，因此不能通过该入口验收活动期间的通信策略。
- [样例包](../../../examples/world-packs/cross-scene-sms/worldpack.source.json)和 [communication.json](../../../examples/world-packs/cross-scene-sms/communication.json)声明有向联系人与媒介名称。联系人不等于在场人员，也不授予位置、物品或对方私有认知。
- 发送规则在同一事务产生 `character.speak` 与接收者专属 `observation.upsert`，规则结果为 self 范围；接收观察只含消息。接收者的本地 publish 仍使用场景受众规则。
- 消息的 `medium` 与接收对象保留在自观察、通信记忆来源与 metadata 中，玩家转录标识媒介。没有 medium 的现有表达保持原呈现。收信刺激来自已提交观察，角色不必回应。

这是一次投递的实验实现。参数中的 text 是自由正文；正文只证明发送者这样说，不能替代移动或物品变化。接收观察是通信感知，记忆归类为 reported_speech。

## 启动

在仓库根目录运行，显式指定新数据目录。按用户要求，此实验入口默认使用 `http://127.0.0.1:8046/v1/chat/completions` 与 `gemini-3.8-flash`；环境变量 HCW_LOCAL_ENDPOINT / HCW_LOCAL_MODEL 可以覆盖，凭证只从 HCW_LOCAL_API_KEY 读取。

```powershell
node --import tsx tests/experiments/cross-scene-sms-entry.ts output/experiments/my-sms-trial
```

输入正文即给同行者发送短信，`/quit` 退出；也可以在目录之后附带一段正文，运行一轮后退出。模型决策的有界正文记入目录内 decisions.jsonl，不保存 Provider 请求信封或凭证。规则动作成功不表示对方已读或同意。

```powershell
node --import tsx tests/experiments/cross-scene-inspect.ts output/experiments/my-sms-trial
```

检查器针对这个固定样例输出位置、短信、本地发表和秘密暗号泄漏检查，并写 evidence.json；不是通用自然语言安全证明。修改样例包后使用新目录，不迁移旧实验数据。

## 验证与实际结果

[回归测试](../../../tests/prototype/cross-scene-communication.test.ts)覆盖远程往返与本地连锁、沉默不唤醒旁观者、普通远程 publish 拒绝、猜测联系人与物理接触拒绝、SQLite 触发器中断投递后的实际事务回滚、重启不自动重放激活，以及原生来源与 Core 桥的授权来源隔离。Core 使用确定性替身验证 Build/Recall 的来源边界，没有运行真实 Python 模型整理。

真实模型：8046 / gemini-3.8-flash。第一次成功的数据目录为 `output/experiments/sms-gemini38-20261010-01`。第一轮同行者回短信“我过去。”，随后在后室对留守者说“我等会儿去前室。”；留守者回应，同行者弃权，周期 quiescent。4 次模型调用。第二轮在同一数据目录重启后，同行者通过短信回复暗号“蓝色纸鹤。”，随后弃权；2 次调用。玩家转录只含短信。此前 8045 无服务；8046 / gemini-3.7-flash 调用失败，gemini-3-flash 返回停用通知，这些失败保留在各自实验目录中。

首个成功样例从 prototype-g1 复制，仍带有旧的初始场景描述与一条留守者 cognition；检查后已校正为两房间设定，并用新目录 `output/experiments/sms-gemini38-20261010-02` 重新验证。同行者回短信“可以，我过去。”，在后室说“玩家在前室，我等会儿过去。”，留守者回应，同行者本地回复“好。”；3 波、4 次模型调用后 wave_limit 停止，未强制得到自然收束。两个目录的 evidence.json 都确认三人位置没有改变、留守者观察不含暗号、玩家观察不含后室对白。上述结果仅代表短场景，不证明长期行为质量。

类型检查与 Lint 通过。首次默认 check 为 43 文件、378 项：359 通过、19 失败；18 个失败用例涉及沙箱中 taskkill 失败，另一个末端候选记忆用例单独重跑通过。默认 gate 没有整体通过。额外记忆测试暴露了既有错误文案断言（speech requires 与当前 publication requires 不一致），仅同步断言，未放宽错误校验。

相关验证为 8 文件、90 项通过，覆盖本实验当时的 6 项、场景／调度、原生记忆、Core 桥、玩家 API、官方玩法与多活动。随后补充本地 Schema 必填字段回归，本实验、官方玩法与多活动 3 文件、26 项通过；最终本实验、执行续写、运行参数及原生记忆 4 文件、60 项通过。本实验目前 7 项。真实 Core 模型整理、长期通信试玩和持续连接仍未验证。

后续把接收对象加入通信来源文本和 metadata 后，继续旧目录 02 触发 `MEMORY_SOURCE_UNVERIFIED`：已捕获的同一来源不能绑定到改变后的内容。消息已提交，角色处理未完成；未吞掉错误或改写旧记忆。最终版本用新目录 `output/experiments/sms-gemini38-20261010-03` 验证。当前实验不承担早期短信实验目录的派生记忆格式兼容；没有 medium 的既有游戏来源渲染不变。

最终新目录首轮：同行者回复短信“我愿意过去。”，后室对白为“他在前室。”；留守者追问，同行者回答“是玩家。先等等。”。4 次模型调用，3 波后 wave_limit。evidence.json 再次确认三人位置保持原处、暗号没有投递给留守者、本地对白没有投递给玩家。停止原因是预算上限，未宣称模型主动收束全部连锁。

## 有意识保留的限制

- 没有默认宿主或前端发送入口，没有活动通信许可、故事节点／分享／末端重新生成的实验通信验收。现有相关功能的回归通过也不能替代新增通信的集成验收。
- 没有离线未读、后台自动唤醒、已读回执、外部消息投递或崩溃后精确续跑。已提交观察保留，后续处理仍受 3 波、12 次调用、每角色 2 次激活、120 秒预算限制；不会因跨场景重新获得预算。
- medium 当前只是作者为一次投递给出的名称；改名“托梦”不自动实现睡眠条件、隐藏真实发送者或接受／拒绝规则。后续独立[电话实验](cross-scene-phone-20261010.md)已验证持续连接与本端可听边界，铃声和免提尚未实现。
- 没有新增包、Manifest 版本、数据库或恢复协议。联系人是明确声明的有向许可，不默认因为一次来信就授权反向联系。
