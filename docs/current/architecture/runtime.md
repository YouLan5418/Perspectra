# 当前运行时

当前源码网页通过 v5 World Pack 编译并创建 `FrozenWorldPlaytestRuntime`。玩家推动世界；一次输入可以触发有界 NPC 连锁回应，周期结束后停止自主推进。

## 一次输入

1. 网页宿主接收玩家输入。普通自由表达与显式 `/act` 操作分开处理；有活动时，先经过当前活动策略。
2. 玩家行动经现有裁定与提交路径形成世界事件。宿主按角色可见的新刺激提供处理机会。
3. `PrototypeCharacterTurn` 用当前提交前缀构建角色 view、场景、认知、授权观察和自身表达。角色地点来自该前缀的角色 view，不使用初始设定代替当前位置。
4. 默认模式使用原生记忆；`--memory-core` 通过宿主实验桥加入该角色长期 Delivery。已授权固定认知可紧凑渲染，正文和权限信息保留。
5. Character Agent 调用模型，自主选择回应、放弃或提出行动。模型提案经过协议检查和 Action / Rulebook 裁定，不能直接写世界库。
6. Commit 完整返回后更新玩家授权投影。已提交 NPC 回复可在后续反应尚未结束时显示；页面通过轮询取完整结果，没有 token 流或草稿发布。
7. 已授权的新观察可以触发后续 Reaction Round；执行预算或期限到达后结束。普通入口默认 3 波、8 次 NPC 调用、每角色 2 次激活、30 秒期限，属于现有实验参数。

活动入口复用角色处理能力，但由脚本的 schedule / onOutcome 请求参与者处理，采用自己的有界链；见[创作者运行时](creator-runtime.md)。调度机会不规定角色情绪、意图或对白。

## 后台记忆与边界

Core 长期整理在排队前冻结授权 Source 前缀。后台运行期间前台继续对话和移动；成功安装后保留新经历尾部。未提交计算允许取消和丢弃，已提交世界事实保持一致。默认原生模式没有因此改为 Core。

核心实现入口：[网页宿主](../../../tests/experiments/playtest-frozen-runtime.ts)、[Character Turn](../../../packages/application/src/prototype-character-turn.ts)、[网页玩家视图](../../../tests/experiments/playtest-view.ts)、[Core 桥](../../../tests/experiments/playtest-memory-core.ts)。性能证据见[研究索引](../studies/ai-girls/README.md)。一次真实轨迹仍出现普通反应约 30 秒中断；增量显示没有消除整轮等待。
