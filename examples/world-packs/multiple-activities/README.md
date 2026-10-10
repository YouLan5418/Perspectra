# 多活动与暂停示例

先和同行者猜数字，中途暂停，改为讨论周末计划；结束讨论后继续之前的猜测。两场玩法独立保存进度，一次只运行一个。

将本目录作为源包导入 Launcher 并创建新实例，或在源码网页使用 `--pack examples/world-packs/multiple-activities`。需要配置可用的角色模型。本示例不提供固定演出替代角色选择。

1. 在活动面板选择“开始 轮流猜数字”，猜一个数字。
2. 当前处理结束后选择“暂停 轮流猜数字”。角色恢复正常互动许可，猜测次数和答案保留。
3. 选择“开始 讨论周末计划”，自由交谈后用活动表单表达偏好。
4. 结束或暂停讨论，再选择“继续 轮流猜数字”。也可以同时保留两场暂停进度。
5. 暂停猜数字，移动到后室后尝试继续：因参与者不在同一场景而拒绝，进度不变。回前室再继续。
6. 保存完整节点、推进任一活动并分叉，核对各自进度恢复。永久无法继续时可放弃该场暂停进度，之后重新开始。

`worldpack.source.json` 的 assetFiles 显式登记三个独立脚本：

- [guess.js](scripts/activities/guess.js)：标识 guess，使用默认恢复条件。
- [weekend.js](scripts/activities/weekend.js)：标识 weekend，演示作者 resume 条件。
- [invite.js](scripts/activities/invite.js)：标识 invite，玩家选择一位当前可见 NPC 发出约会邀请；目标角色通过 respond 接受或拒绝。接受邀请不会自动移动。

活动最多 8 个 NPC、16 个操作的限制按每场计算。一次只运行一个；不后台推进暂停活动，不动态增减参与者。周末偏好只记录意见，不把选项当成实际出行。

猜数字与周末讨论采用作者固定名单；约会邀请使用 `participants: { mode: 'player-select', min: 1, max: 1 }`，可增加 candidates 限定可选角色。开始后的名单固定。活动状态和结果只交付参与者；旁观者仍可依据原有权限听见公开对白，私密交流只获知交流发生，定向交流不向其投递。活动不会自动调度旁观者插话。

源码自动化验证见 [多活动测试](../../../tests/prototype/pack-activities.test.ts)。样例内容已编译校验；已有便携发行包不会自动包含新增能力。

真实模型实验：`node --import tsx tests/experiments/multiple-activities-live.ts`，每次新建 `.tmp/multiple-activities-live-<时间戳>`，输出报告与公开转录。可通过 HCW_LOCAL_MODEL / HCW_LOCAL_ENDPOINT 指定本机配置。实验副本固定猜数字答案以核对进度；不改变本示例的随机玩法。

2026-10-10 使用 8046 的 gemini-3.8-flash 完成真实模型短链验证：玩家猜 20，角色猜 60 并说“还小。该你了。”；暂停猜数字后讨论周末，玩家选择在家休息，角色选择出门散步并说“出去走走挺好。”；讨论结束后恢复猜数字，活动身份、公开进度和换手与暂停前一致。两场均有真实角色操作提交，未用 simulate 替代。角色处理分别约 38 秒和 31 秒，6 次模型请求均返回 HTTP 200。报告与转录位于仓库本机 `.tmp/multiple-activities-live-1791628263175/report.json`。这次未验证恢复后的下一轮模型回应、前端人工操作或长期试玩。

同日 gemini-3.7-flash 的实际角色请求返回 HTTP 429（`.tmp/multiple-activities-live-1791628169413/report.json`）；gemini-3.5-flash 返回 HTTP 200，但正文是型号已下线的通知，未通过角色协议。模型列表中的名字不代表实际可用。实验默认型号采用本次成功的 gemini-3.8-flash，仍可用环境变量覆盖。

动态邀请真实模型实验：`node --import tsx tests/experiments/activity-invitation-live.ts`。2026-10-10 使用同一 8046 / gemini-3.8-flash，选择留守者后由该角色正式提交接受，并表达“好啊，我答应了。不过接下来具体要做什么，你有什么打算吗？”。随后暂停、恢复、结束成功，恢复的完整玩家活动视图一致，无自动移动。同行者收到一条公开表达观察，没有活动元数据。首次角色处理约 33 秒。报告位于仓库本机 `.tmp/activity-invitation-live-1791632484336/report.json`；这次真实样本没有覆盖拒绝、多人邀请或前端人工操作。
