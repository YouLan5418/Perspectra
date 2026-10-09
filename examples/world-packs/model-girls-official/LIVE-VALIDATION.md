# Gemini 实际试玩验收 · 2026-10-09

使用用户开启的本机 8046 OpenAI 兼容接口，模型标识 `gemini-3.7-flash`；四个 NPC 都使用该模型，各自经过独立授权 Context 与记忆。全部使用新实例与新分支，没有读写 D:/worlds 历史数据。序章完整运行后分别测试不同玩家选择，没有把自由回应改成预写输出。

## 结果

| 项目 | 实测证据 | 结论 |
| --- | --- | --- |
| 序章 → 自由输入 | 112 条正式表达、5 条玩家问题，零角色 provider 调用；末句后玩家分别答应与拒绝 | 固定演出与自由阶段交接通过 |
| 拒绝同居 | Claude 接受边界，DeepSeek 讨论其他落脚点，GLM 讨论证件与应急方案，GPT 提议清点物资与征求意见 | 没有把玩家拒绝改成同意；第二波遇默认时间截止，见下文 |
| 同意后的分歧 | Claude 关注隐私／规则，DeepSeek 关注吃饭，GLM 关注开销，GPT 关注安排 | 角色各自决策；本轮后续反应同样触及默认时间截止 |
| 私密交流 | 玩家只告诉 Claude “松果七号”；Claude 自主以 private 范围回复。GPT 原观察中无秘密；同场复验时明确说“不知道” | 权限隔离与该样例的可见行为通过；首次对 GPT 提问时她已离场、没有接收，因此仅采用同场复验结论 |
| 第一顿饭 | 正常移动后所有参与者到厨房；晚餐 Activity 只发表 DeepSeek 开场，零角色 provider 调用，随后恢复真实决策 | 条件开场与自由交接通过 |
| 真实料理 | 最初模型返回版本字符串而被拒绝；修复 wire schema 后，DeepSeek 自己选择 home:cook-rice，规则提交 raw-rice-kit → cooked-rice；后续又选择食用，变成 empty-meal-container | 已验证真正的规则操作，未用台词冒充熟饭；同一实体、两次合法变化 |
| 蛋糕认知差异 | 玩家合法拿取、带到书房并放下，再回厨房；GPT 只看见拿取，没有目击放下。寻找 Activity 条件成立后，真实模型说没有看到放下，并根据最后记录推断仍由玩家保管 | 世界实际位置与角色知晓分离通过；角色推断可能错误，不把推断写回权威物品位置 |
| 第二天长期记忆 | GPT 真实答应“明天上午九点检查电饭锅”；Core 整理后，该信息已不在近期原文里。第二天实际回访仍回答时间与事项；长期交付中有对应的授权来源 | 该样例通过真正的归档后召回；不是只读仍在上下文里的原句 |

## 实测修复与等待配置

普通角色调用的本机适配器把交互版本写成数值单值 enum，本机返回两次 `version: "1"`，因此严格规则拒绝料理。现在仅在允许版本唯一时，以 integer 和相等 minimum/maximum 表达同一约束；没有转换模型输出、放宽版本、加入分类模型或绕过 Rulebook。回归检查数值 1 可执行，字符串和版本 2 仍拒绝。修复代码在 [local-prototype-turn-call.ts](../../../tests/experiments/local-prototype-turn-call.ts)。

默认 30 秒反应窗口在本机约 6–8 秒一次的串行调用下，多次在第二波截止，页面会保留已经发表的回应并显示后续未完成。原记录保留为失败样例，不能称默认等待体验全部通过。本次同场秘密、料理和蛋糕复验使用已有配置：反应周期 120 秒、单次发布 600 字符，其他调用预算仍为默认 8 次、3 波、每角色 2 次激活；没有持续后台自治，也没有修改宿主默认值。建议用同样设置试玩此本机服务；达到调用上限时正常结束。

长期记忆实验为了可复现整理，使用触发估算 6000、整理目标 3500、近期原文目标 100，并显式运行现有 Core 整理。完成 8 个构建任务、失败 0、四角色档案安装到前缀 1524。最终 GPT 检索前缀 1524、当前头 1548；近期 observations / selfObservations / stimulus 不含“九点”和“电饭锅”，6 条长期交付中包含实际约定。整理步骤的前台 error 标记仍继承前一轮超时，应以安装记录和 failed=0 判断整理本身；此处未修改错误提示机制。

仍接受首版的一锅饭整体食用、没有食物份额与冰箱层级、游戏日仅为明确推进的标签等限制。没有验收所有角色组合、长时间自然度、多模型兼容或任意自由叙事都不越权；没有制作新版便携发行包。

## 复查证据

独立根目录：[official-live-1791517548038](../../../.tmp/official-live-1791517548038)。

- [初次分支报告](../../../.tmp/official-live-1791517548038/report.json)：默认预算的成功表达、未接收提问及超时均保留。
- [私密观察结果](../../../.tmp/official-live-1791517548038/life/private-audience.json)与 [同场语义复验](../../../.tmp/official-live-1791517548038/followup-1791517950014/report.json)。
- [料理失败原始决策](../../../.tmp/official-live-1791517548038/cook-diagnosis/memory-core/model-trace.jsonl)、[修复后决策](../../../.tmp/official-live-1791517548038/cook-verified/memory-core/model-trace.jsonl)、[权威料理结果](../../../.tmp/official-live-1791517548038/cook-verified/world-evidence.json)。
- [蛋糕角色回应](../../../.tmp/official-live-1791517548038/cake-1791518452862/report.json)与 [实际位置／目击差异](../../../.tmp/official-live-1791517548038/cake-1791518452862/world-evidence.json)。
- [长期记忆交付证据](../../../.tmp/official-live-1791517548038/long-memory/recall-evidence.json)、[整理任务记录](../../../.tmp/official-live-1791517548038/long-memory/memory-core/background-builds.jsonl)。

重现入口：`node --import tsx tests/experiments/official-demo-live.ts`；它会新建根目录并记录默认预算样例。然后以输出的新根目录为参数运行 official-demo-live-followup.ts 和 official-demo-live-cake.ts。模型或延迟变化可能得到不同角色选择，不固定要求某个剧情结局。

## 最终自动检查

`corepack pnpm@11.7.0 check` 通过：41 个测试文件、353 项测试；清理实验脚本未使用导入后再次运行 lint，无警告。`node scripts/docs/check-links.mjs` 通过（12 页、216 个本地链接，模块地图完整），`corepack pnpm@11.7.0 desktop:build` 成功。自动检查不替代上述真实模型验收及其失败记录。
