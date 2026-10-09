# 一次输入的代码路线

核对日期：2026-10-08。建议先读[入门说明](getting-started.md)。下面是关键控制点，省略底层辅助调用；看具体分支时再顺着源码展开。

## 1. 从哪里启动

package.json 的 experience:web 指向 [playtest-web-entry.ts](../../../tests/experiments/playtest-web-entry.ts)。它读取参数与包，创建 FrozenWorldPlaytestRuntime 和本机 HTTP 服务。

桌面路径为：Vue Launcher → Tauri 请求桥 → Node LauncherCore → 网页宿主子进程 → 系统浏览器游戏页。对应 [desktop.ts](../../../apps/launcher/src/services/desktop.ts)、[main.rs](../../../apps/launcher/src-tauri/src/main.rs)、[launcher-entry.ts](../../../desktop/launcher-entry.ts)、[launcher-core.ts](../../../desktop/launcher-core.ts)。Launcher 管理实例和进程，具体游戏仍由网页宿主运行。旧 [Electron main](../../../desktop/main.ts)是另一个保留入口。

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

## 4. NPC 如何获得处理机会

[runPrototypeActivations](../../../packages/application/src/prototype-activation-cycle.ts)扫描新提交的 observation.upsert，选择相关 NPC，按有界波次处理。它跟踪调用数、各角色激活数和期限。

普通默认值见 [playtest-tuning.ts](../../../tests/experiments/playtest-tuning.ts)与[游玩设置](../../../desktop/play-settings.ts)：3 波、8 次模型调用、每角色最多 2 次激活、30 秒周期期限。启动配置可覆盖。“一次激活”可能包含执行结果后的再次调用，不等于“一次模型请求”。活动有自己的链和预算，见[创作者运行时](creator-runtime.md)。

角色可以放弃；没有新刺激或达到预算后结束。调度不给角色预先写台词。

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
| 包内活动 | 策略、操作、结果与参与者调度 | [PackActivity](../../../tests/experiments/pack-activity.ts)、[受控交互](controlled-interaction.md) |
| 预设 | 实例默认、角色组、专属与请求／输出／显示处理 | [preset-runtime.ts](../../../packages/provider-chat/src/preset-runtime.ts)、[预设说明](../model-presets.md) |
| 社区前端 | 默认沙箱，授权后受信任模式；公共玩家接口 | [授权实现](../../../desktop/frontend-authorization.ts)、[资产服务](../../../tests/experiments/playtest-frontend-assets.ts)、[授权说明](../frontend-authorization.md) |
| 故事线 | 完整节点、独立分叉与单节点文件分享 | [story-nodes.ts](../../../desktop/story-nodes.ts)、[story-share.ts](../../../desktop/story-share.ts)、[使用边界](../storylines.md) |
| 末端重新生成 | 完整起点、隔离重演与候选选择 | [TailRoundRuntime](../../../tests/experiments/playtest-tail-runtime.ts)、[tail-storage.ts](../../../desktop/tail-storage.ts)、[详细说明](../tail-round-regeneration.md) |

## 8. 解释基于什么

| Evidence（依据） | Finding（判断） | Path（阅读或验证方式） |
| --- | --- | --- |
| package.json 与 LauncherCore 的启动代码 | 当前游戏宿主仍在 tests/experiments | 沿入口阅读，Mock 与真实运行分别验证 |
| 宿主、PrototypeCharacterTurn、有界调度 | 玩家提交后触发角色处理，角色可以放弃 | 查执行结果与调度回归，体验另做真实试玩 |
| WorldStore、CharacterViewBuilder、记忆投影 | 已提交状态、授权信息、角色认识各有职责 | 权限与提交查相关测试，叙事一致性查连续回合 |

本次梳理核对源码关系，没有新增真实模型试玩。历史测试和性能数字请读相应报告，不当成本次重新验证。
