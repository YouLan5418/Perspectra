# 被隐瞒的治疗方案

洛恩在旅馆陪伴伊蕾，塞维恩可以在没有新观察时自行寻找档案、争取治疗主导权。玩家若先拿走摘要，塞维恩到场只能看到文献缺失，不能直接知道谁拿走。伊蕾也能自己移动、追问和拒绝。所有角色成年，无成人内容，没有预定结局。

这是动态博弈能力实验，不是正式剧情包。复用 main 的 v5 包、普通场景、原生认知记忆、移动、take/give/drop 和 autonomy.json；没有 Activity、变量、演出脚本或新的运行时规则。controllerClass=scripted 是现有 NPC 声明类别，本实验实际决策来自真实模型，并非脚本对白。

## 重复运行

在仓库根目录运行，先确保本机现有 OpenAI 兼容服务 `http://127.0.0.1:8045/v1/chat/completions` 提供 `gemini-3.8-flash`。服务配置与凭证不写入实验包。驱动不会自动切换模型、模拟 NPC 或重试其决策。

```powershell
corepack pnpm@11.7.0 test:related tests/prototype/hidden-cure.test.ts tests/prototype/character-autonomy.test.ts tests/prototype/dynamic-scheduling.test.ts tests/prototype/character-visible-items.test.ts tests/p2.integration.test.ts packages/store-sqlite/src/character-view.test.ts --fileParallelism=false
node --import tsx tests/experiments/hidden-cure.ts
# 也可单独重跑一条预定玩家路径，每次都会创建新目录
node --import tsx tests/experiments/hidden-cure.ts --case=B
# 把最后输出的 directory 代入；生成逐回合转录及机械核验
python tests/experiments/hidden-cure-audit.py output/hidden-cure/live-实际目录
```

三组各 8 回合，模型与预算一致，顺序运行，各有独立世界目录。A 陪伴交流，B 移动到档案室、拿取摘要并返回旅馆，C 私下分享模糊未来风险并提出一次限制女主自由的不合理请求。驱动固定玩家输入，不会为了追随 NPC 的移动而补写结果。女主若离开旅馆，玩家在那里说的话就不会自动传给她。

固定的是初始世界与玩家操作，不是模型答案或同级调度顺序，重跑可能产生不同剧情。默认自主机会随有效玩家提交触发，不是墙钟后台自治。两名 NPC 各一次机会；自主共享 8 次调用、后续 2 波/6 次，普通 3 波/8 次，每角色最多 2 次激活，期限 180 秒，单请求 60 秒；具体声明见驱动中的 settings。Launcher 默认自主总预算只有 3 次，本实验预算不同；既有发行包没有重新制作。

## 信息与受控状态

- 三地点：旅馆、教会大厅、档案室；唯一受控物品为 `entity:cure-record`。保管与移动以权威事件为准。
- 两个治疗思路及风险是物品的作者固定文字。当前物品投影没有独立正文/阅读能力，因此用 `kind` 承载一张展开摘要的可见短文。这是内容侧折中，不代表存在通用阅读系统；看到正文也不会自动写入一条持久的“已读”事实。
- 物品地面可见、本人持有或满足既有见证条件时才进入当前物品投影。模型可记住自己以前见过的文字，但不能因此继续拥有原件。
- 玩家私有“灰钟梦兆”，女主的感情与意愿，竞争者私有“独占议程”，分别只放在各自 cognition。双方的原始目标与知识没有写进公共世界 description。
- 社会资源、治疗准备和诅咒恶化仅是叙事背景。本实验未声明执行治疗、时间恶化、调集辅祭、查阅其他古籍或借阅账的规则，相关表达不能计为行动成功。没有好感数值或剧情标志。
- 没有启用跨场景短信/电话实验入口。不同地点必须实际移动后交流，不能当成远程传话。

## 记录与边界

每次输出 `output/hidden-cure/live-随机名/`：各组的 `record.json` 包含实际玩家输入、逐调用的角色授权材料/提案/usage/耗时、权威事件、行动接受或拒绝、三个角色每回合 view/cognition/items 与完整性检查；`summary.json` 统计费用，`transcript.md` 只展示提交记录。输入中的宿主来源序号会被现有模型呈现器省略，作者可在对应 views 的 sourceSeq、source/basisRefs 回溯来源。原生 memory.sqlite 保存该角色授权记忆。

这些是**作者证据**，包含场外与私有内容，不能接到玩家 UI 或任何 NPC 输入。实际玩家授权转录另在每回合 playerTranscript。工具不记录认证头、凭证、系统提示或隐藏推理，只保存这批虚构角色的授权输入、允许的决策字段及 usage。

自动核验检查信息受众、来源归属和物品事件重放；它不证明自由文本没有杜撰，也不把角色说“马上动身”当成实际移动。8 回合原生记忆不是长期整理、重启遗忘或 Core 记忆的体验验收。

中文行为分析及本次证据位置见[实验报告](../../../docs/current/studies/hidden-cure-20261011.md)。
