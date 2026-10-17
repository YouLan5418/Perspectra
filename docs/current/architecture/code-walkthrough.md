# 一次输入的代码路线

核对日期：2026-10-18。建议先读[入门说明](getting-started.md)。下面是关键控制点，省略底层辅助调用；看具体分支时再顺着源码展开。

## 1. 从哪里启动

package.json 的 experience:web 指向 [playtest-web-entry.ts](../../../tests/experiments/playtest-web-entry.ts)。它读取参数与包，创建 FrozenWorldPlaytestRuntime 和本机 HTTP 服务。

桌面路径为：Vue Launcher → Tauri 请求桥 → Node LauncherCore → 网页宿主子进程 → 系统浏览器游戏页。对应 [desktop.ts](../../../apps/launcher/src/services/desktop.ts)、[main.rs](../../../apps/launcher/src-tauri/src/main.rs)、[launcher-entry.ts](../../../desktop/launcher-entry.ts)、[launcher-core.ts](../../../desktop/launcher-core.ts)。Launcher 管理实例和进程，具体游戏仍由网页宿主运行。游戏运行时，同一个网页宿主还托管只读的创作者页面（/creator），由 Launcher 交给系统浏览器打开，见[创作者调试接口](../creator-debug-api.md)。旧 [Electron main](../../../desktop/main.ts)是另一个保留入口。

## 2. 世界包如何成为可运行世界

[宿主](../../../tests/experiments/playtest-frozen-runtime.ts)检查源目录为 worldpack-source/v5，调用 [compileWorldPackSource](../../../packages/world-pack/src/compiler.ts)，用已安装的基础交互能力编译并适配世界。角色处理代码检查激活后的运行时 Manifest 为 v10。源包 v5 和 Manifest v10 描述不同层次，不是版本冲突。

宿主组合 WorldApplication、模型适配、预设及可选 Core 桥。设定里的初始位置用于启动；之后的位置从当前事件前缀的视图读取。“前缀”就是截至某条已提交事件的世界记录，避免混用不同时间的状态。

## 3. 输入如何到达提交路径

| 位置 | 看什么 | 为什么 |
| --- | --- | --- |
| [playtest-server.ts](../../../tests/experiments/playtest-server.ts) | 玩家 API、请求校验、busy 与 actionId | 页面请求不能直接写库 |
| [playtest-tail-runtime.ts](../../../tests/experiments/playtest-tail-runtime.ts) | 正式玩家回合、完整起点与候选选择 | FrozenWorldPlaytestRuntime 由 TailRoundRuntime 包装实际游戏 Core |
| [playtest-frozen-runtime.ts](../../../tests/experiments/playtest-frozen-runtime.ts) | FrozenWorldRuntimeCore.submit、活动与 /act 分支 | 普通表达、明确操作、活动输入走不同分支 |
| [world-application.ts](../../../packages/application/src/world-application.ts) | 玩家输入与世界应用组合 | 宿主复用裁定和提交机制 |
| [world-kernel.ts](../../../packages/kernel/src/world-kernel.ts)、[world-store.ts](../../../packages/store-sqlite/src/world-store.ts) | 裁定结果、事件与事务提交 | 重要状态在这里成为已提交事实 |

普通场景提交玩家输入后，宿主刷新视图并调用 #activateCharacters。活动输入先检查活动策略，不能把普通场景分支套到所有活动上。

NPC 处理途中玩家也可以插话，规则见下一节末尾。

## 4. NPC 如何获得处理机会

先看一个例子：玩家在客厅说“谁看见我的钥匙了？”。客厅里的 A、B 听见了，厨房里的 C 没听见。[runPrototypeActivations](../../../packages/application/src/prototype-activation-cycle.ts) 看到新提交的观察，给 A、B 各一次处理机会。A 回答“在桌上”，这句话又成了 B 的新观察，B 可能再回应一次——这就是“下一波”。到没人有新东西要处理，或者次数、时间用完，这一轮就停下。

**上限。** 默认 3 波、8 次模型调用、每个角色最多 2 次激活。源码网页默认整轮 30 秒（[playtest-tuning.ts](../../../tests/experiments/playtest-tuning.ts)），Launcher 默认 120 秒（[游玩设置](../../../desktop/play-settings.ts)），都能在启动配置里改。“一次激活”可能包含行动结果出来后的续写调用，所以不等于“一次模型请求”。活动有自己独立的链和预算，见[创作者运行时](creator-runtime.md)。

**并发（动态调度）。** 普通场景下，最多同时有两个角色在等模型返回，其中最多一个在玩家场景之外；同一地点、同一角色不会同时跑两份。谁先跑按这个顺序排：玩家所在场景优先，其次是重算次数少的、已完成次数少的，同级随机。模型思考时不占写锁；结果出来后排队逐个提交，提交前检查这个角色看到的东西（视图、场景成员、可见物品、可选操作）有没有变。变了就算“过期”（stale），丢掉这次结果重算一次；再过期就停止这个角色本轮。别的角色提交了无关事件，不会让它过期。

以下情况不走并发，改为逐个串行：启动时加了 `--serial-scheduling`、包里有变量脚本、活动正在指定参与者、或启用了发布审计。细节和边界见[动态调度实验](../studies/dynamic-scheduling-20261011.md)。

**角色自主行动。** 世界包可以声明某些角色到时间会主动做点什么。[PackAutonomy](../../../tests/experiments/pack-autonomy.ts) 在玩家每次成功提交后算出谁“到点了”，把它们和普通反应放进同一个 runPrototypeActivations，共用并发和提交队列，但调用预算和时限分开算。被唤醒只是多一次处理机会，不会让角色多知道任何东西。实现见[接入记录](../studies/autonomy-dynamic-dispatch-20261011.md)，作者怎么声明见[创作者运行时](creator-runtime.md#关键角色自主行动2026-10-11实验分支)。

**玩家插话。** 只要宿主公开的 `canInterrupt` 为真，玩家就能在 NPC 处理途中继续说话或点行动按钮。[TailRoundRuntime](../../../tests/experiments/playtest-tail-runtime.ts) 会取消旧回合还没提交的 NPC 计算，已经提交的保留。如果只剩玩家场景外的角色在处理，页面直接显示可以回应；场内仍在处理的角色列在 `responders` 里。活动进行中不开放插话。见[运行时](runtime.md)。

角色随时可以放弃。调度只决定“给不给一次机会”，从不替角色写台词或定情绪。

## 5. 角色拿到什么、返回什么

[PrototypeCharacterTurn](../../../packages/application/src/prototype-character-turn.ts)准备当前角色视图、场景、认知、授权观察、自身表达与可尝试操作。[CharacterViewBuilder](../../../packages/store-sqlite/src/character-view.ts)按角色和事件前缀重建信息。[上下文文本](../../../packages/provider-chat/src/character-context-text.ts)负责模型侧可读呈现，预设参与请求和输出处理。

原生记忆由 [CognitiveMemoryService](../../../packages/memory/src/cognitive-context.ts)准备召回；Core 模式由 [PlaytestMemoryCore](../../../tests/experiments/playtest-memory-core.ts)投影请求，经 [Python 桥](../../../tests/experiments/hindsight-python.ts)调用记忆实现。Core 的 Retain／Group／Consolidate 是提炼、分组和形成认识，不是世界裁定。详见[认知与记忆](cognition-memory.md)。

调用格式见 [prototype-turn.ts](../../../packages/provider-chat/src/prototype-turn.ts)，本机适配见 [local-prototype-turn-call.ts](../../../tests/experiments/local-prototype-turn-call.ts)。合法 JSON 仍需检查协议与行动资格。

这是当前 publish 的决策格式示例，不是玩家命令：

~~~json
{
  "decision": "publish",
  "segments": [
    { "type": "speech", "text": "先别走。" },
    { "type": "narration", "text": "她抬起头，声音放轻。" }
  ]
}
~~~

片段顺序、受众与长度检查见[Interaction](interaction.md)。表情无需额外编码成世界状态。

## 6. 结果如何回到角色和页面

perform 请求经过 Rulebook；[character-execution-result.ts](../../../packages/application/src/character-execution-result.ts)把实际结果给角色，供它继续表达，不能用请求文本代替执行结果。

提交完成后，宿主 onCommitted 更新玩家授权投影。[playtest-view.ts](../../../tests/experiments/playtest-view.ts)整理转录；[PlayerView](../../../packages/frontend/src/player-view.ts)定义公共数据。页面轮询已提交内容，当前没有逐 token 草稿流。新观察可能引发下一波。

失败不一定代表整回合没发生：玩家输入可能已提交，NPC 行动也可能已完成，只是后续表达失败。排查要看事件与宿主通知。

## 7. 按需展开的分支

| 分支 | 说明 | 代码与详细文档 |
| --- | --- | --- |
| 包内活动 | 独立玩法选择、暂停／继续、策略、操作、结果与参与者调度 | [PackActivities](../../../tests/experiments/pack-activities.ts)、[PackActivity](../../../tests/experiments/pack-activity.ts)、[受控交互](controlled-interaction.md) |
| 预设 | 实例默认、角色组、专属与请求／输出／显示处理 | [preset-runtime.ts](../../../packages/provider-chat/src/preset-runtime.ts)、[预设说明](../model-presets.md) |
| 社区前端 | 默认沙箱，授权后受信任模式；公共玩家接口 | [授权实现](../../../desktop/frontend-authorization.ts)、[资产服务](../../../tests/experiments/playtest-frontend-assets.ts)、[授权说明](../frontend-authorization.md) |
| 故事线 | 完整节点、独立分叉与单节点文件分享 | [story-nodes.ts](../../../desktop/story-nodes.ts)、[story-share.ts](../../../desktop/story-share.ts)、[使用边界](../storylines.md) |
| 动态角色调度与插话 | 跨地点有限并发、串行事实提交、角色视图过期检查及玩家中断 | [动态调度实验](../studies/dynamic-scheduling-20261011.md)、[activation-cycle](../../../packages/application/src/prototype-activation-cycle.ts)、[对照驱动](../../../tests/experiments/dynamic-scheduling.ts)、[样例包](../../../examples/world-packs/dynamic-scheduling/README.md) |
| 末端重新生成 | 完整起点、隔离重演与候选选择 | [TailRoundRuntime](../../../tests/experiments/playtest-tail-runtime.ts)、[tail-storage.ts](../../../desktop/tail-storage.ts)、[详细说明](../tail-round-regeneration.md) |

## 8. 解释基于什么

| Evidence（依据） | Finding（判断） | Path（阅读或验证方式） |
| --- | --- | --- |
| package.json 与 LauncherCore 的启动代码 | 当前游戏宿主仍在 tests/experiments | 沿入口阅读，Mock 与真实运行分别验证 |
| 宿主、PrototypeCharacterTurn、有界调度 | 玩家提交后触发角色处理，角色可以放弃 | 查执行结果与调度回归，体验另做真实试玩 |
| WorldStore、CharacterViewBuilder、记忆投影 | 已提交状态、授权信息、角色认识各有职责 | 权限与提交查相关测试，叙事一致性查连续回合 |

本次梳理核对源码关系，没有新增真实模型试玩。历史测试和性能数字请读相应报告，不当成本次重新验证。
