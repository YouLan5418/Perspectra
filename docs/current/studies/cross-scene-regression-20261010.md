# 跨场景通信对原功能的回归检查

分支 `codex/cross-scene-communication`，2026-10-10。检查当前工作树；工作树还包含已有的活动和前端修改，因此全仓结果不能单独归因于通信实验。

## 影响范围

[电话](cross-scene-phone-20261010.md)规则、通话事件安装、样例与入口均在独立实验代码中。默认宿主未安装电话绑定；默认编译器事件注册表未增加通话事件。

[短信](cross-scene-communication-20261010.md)实验涉及五处共享行为：

| 共享路径 | 改动 | 需要验证的原功能 |
| --- | --- | --- |
| publicationSourceText | 仅带 medium 的表达加入媒介和接收者 | 普通表达、记忆来源校验 |
| LocalMemoryStore | 仅带 medium 的表达增加通信 metadata | 授权记忆提取、检索 |
| CharacterViewBuilder | 自身发表保留 medium 与接收者 | 自观察、角色视图隔离 |
| playerTranscript | 带 medium 的说话者名称注明媒介 | 普通转录、私有内容不外泄 |
| localPrototypeTurnCall | 动态参数必填字段取实际候选的交集 | 原有活动操作 Schema、正式规则校验 |

不带 medium 的既有表达沿用原来的来源和显示路径。早期通信实验中已经使用 medium 的来源格式曾改变，不保证那些旧实验目录的派生记忆兼容，详见短信报告。

## 本轮自动检查

运行 `corepack pnpm@11.7.0 check`：类型检查、Lint 通过。默认测试为 44 文件、385 项；42 文件通过，367 项通过，18 项失败。失败全部位于 storyline-crash 与 tail-round 的强制终止子进程用例，错误为 `taskkill failed`。没有将这些失败跳过或改写断言来得到绿色结果。

通过范围包括原有官方玩法、多活动、场景判断、激活调节、叙事发表、玩家接口及授权、原生 Provider、记忆 Core 桥、角色视图、世界包编译、故事节点保存／切换／分享，以及电话与短信测试。详细范围由 vitest.prototype.config.ts 决定，默认检查不等于仓库全部历史测试。

另运行 LocalMemoryStore 与 CognitiveMemory V2 两组测试：2 文件、22 项全部通过。

在允许终止测试自身子进程的环境中重跑 `test:related tests/prototype/storyline-crash.test.ts tests/prototype/tail-round.test.ts`：2 文件、36 项全部通过，包括原先失败的 18 项。当前选中的 385 项均在本轮默认运行或针对性重跑中获得通过结果；初次沙箱内 check 本身仍以失败退出，未重新宣称该命令整体绿色。

## 原有玩法真实模型检查

运行既有 `tests/experiments/activity-invitation-live.ts`，使用 8046 / `gemini-3.8-flash`，新数据目录 `.tmp/activity-invitation-live-1791639624603`。

角色正式执行回应操作，接受约会邀请，然后表达“好，我答应你。不过你打算去哪儿？我还没有什么具体想法。”；仅说对白没有被当作接受依据。活动暂停、恢复、结束全部提交成功，暂停前进度恢复一致，没有自动移动，旁观者没有获得活动私有状态。脚本 report.json 为 passed。

另运行既有 `tests/experiments/multiple-activities-live.ts`，同样使用 8046 / `gemini-3.8-flash`，新数据目录 `.tmp/multiple-activities-live-1791639707587`，6 次 Provider 调用。角色正式执行猜数操作（猜 60，规则反馈偏小），猜数暂停后在周末讨论中正式投票“出门散步”，随后恢复原猜数活动。脚本验证恢复的活动 ID、公开进度和轮次与暂停前一致，两场活动都有实际 NPC 操作，而非仅对白或弃权；report.json 为 passed。

这是原有活动使用当前共享 Schema 的真实模型结果，不能代替所有玩法的长期体验验收。默认宿主里的活动与电话同时运行、通信故事节点／分享仍未接入，不能由原功能测试推断其已得到验证。

随后已进行独立[活动与通信组合实验](cross-scene-activity-20261010.md)，验证活动期间短信、电话与活动许可。此处保留原功能回归时的范围记录，默认宿主与故事节点／分享的通信集成仍未完成。
