# 第一阶段：记忆召回与认知更新链路核查

> 2026-09-25；依据 `ai-girls-awaken-v10` 的 20 轮真实模型试玩与本次修复复测。阶段一尚未通过行为验收。

## 证据 → 发现 → 处理

| 证据 | 发现 | 处理 |
| --- | --- | --- |
| 原试玩 `cognitive_memory_v2_sources=202`，召回回执和加权词表均为 0；后续角色请求没有长期记忆段 | 写入存在，但中文默认 FTS 无法有效召回 | 网页试玩选用仓库已有的 `cjk-ngram/v1` 策略 |
| 网页角色激活由 `PrototypeCharacterTurn` 直接组装上下文，只读取 `CharacterView` 和认知投影 | 即使启用 tokenizer，召回结果原先也不会进入角色请求 | 激活时按角色、世界前缀和当前刺激调用现有 `CognitiveMemoryService.prepareStimulus`，将召回记忆交给模型；不赋予记忆修改权威事实的能力 |
| 新复测中 31 次角色请求都有非空 `memories`，记忆库有 174 条来源、10,354 个派生词项、31 条 v2 召回回执；中途关闭重开后继续运行 | 捕获 → 检索 → 角色请求的程序链路已接通 | G1 网页运行时回归检查后一轮请求读到前一轮已提交的经历 |
| 新复测运行期 `seq 109–398` 仍没有 `goal/claim/affect/loop/relationship/commitment` 更新事件；GLM 仍多次回到电脑任务 | 结构化认知由创世事件初始化，当前原型角色输出只有 perform/publish/abstain，没有运行期认知回写。检索成功尚未证明经历改变后续决策 | 下一次体验迭代先做有明确前后行为对照的长程场景，再决定最小认知更新方式；不把新的反思系统作为本次修复的一部分 |

## 复测边界

运行命令：`node --import tsx tests/experiments/frozen-playtest-drive.ts --model deepseek-flash --pack examples/world-packs/ai-girls-awaken-v10 --scenario ai-girls --turns 20`。密钥仅从用户环境变量临时读取。新数据位于 `.tmp/frozen-playtest-drive-2026-09-25T11-39-28-358Z/`，未触碰历史试玩库。

20 轮完成，51 次 provider 调用。第 6 轮一次角色输出格式无效（玩家移动已提交，角色输出未提交）；第 11 轮位置不符的拿取按 `not_afforded` 拒绝。玩家离开后，不在场角色仍无法参与后续交流，属于下一阶段的多人互动问题。真实模型只用了 `deepseek-flash`、一个世界包、一条脚本；“角色能稳定利用旧经历改变行为”尚未验证。

验证：`corepack pnpm@11.7.0 check` 通过（66 项默认测试）；定向的 Memory、tokenizer、G1 网页运行时与 perform 续写测试 44 项通过。自动化验证了召回内容进入后续请求，不能替代真实行为验收。

## 后续受控实验

[受控试玩报告](PROTOTYPE-EXPERIENCE-PHASE1-CONTROLLED-PLAYTEST.md) 已补做长程私语、无暗号对照与钥匙目标对照。结果确认：旧私语离开近期窗口后仍可被直接追问唤起；钥匙目标可随已裁定归属调整行为；私下约定在自然犹豫时仍未稳定主动执行。实验还修复了近期观察按 ID 截取的错误，并移除模型请求中重复的近期观察与初始认知记忆。第一阶段的行为验收状态仍为未通过。
