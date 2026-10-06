# AI美少女包：体验与性能首轮优化（2026-10-06）

## 1. 范围与结果

| 属性 | 内容 |
| --- | --- |
| 优先级 | 按用户指定顺序完成增量投影、Core常驻和固定Context压缩，再真实复测 |
| 世界包 | `examples/world-packs/ai-girls-awaken-v10`，未修改世界包或角色设定 |
| 入口 | 正常源码网页HTTP接口及真实浏览器；本机8046网关，别名`gemini-3.7-flash` |
| 数据 | 新目录`.tmp/ai-girls-optimized-20261006/core`，旧世界和`D:/worlds`未修改 |
| 真实工作 | 13次玩家输入、1次手动整理；42次Character HTTP尝试，38次返回、4次取消；12次Utility调用 |
| 参数 | 保留默认3波、8次调用、每角色2次激活、30秒期限；未改变调度、检索或整理算法 |
| 当前状态 | 源码与报告已在工作区实现并验证，未提交或发布桌面包 |

基线见[耗时追踪](performance.md)。此前已提交回应要等整轮结束才进入玩家state；现在每次完整事务提交后就重新构建玩家授权视图，原有网页轮询可以立即取到。热启动Core召回低于原定约1秒目标；Character固定认知通过无损结构压缩减少重复输入。一次真实轨迹不能代表稳定分位数，也不能把自然行动不同的两轮总时长作为严格因果对照。

## 2. 实现与必要边界

| 修改 | 复用的机制 | 验证与接受的限制 |
| --- | --- | --- |
| `PrototypeCharacterTurn.onCommitted` | 在既有`commitRound`完整返回后通知宿主；投影仍经`CharacterViewBuilder`与`SceneDecisionService` | 只显示已提交且玩家可观察的回复、移动和交互结果；不显示模型草稿、私有Context或token流 |
| 网页增量投影 | 直接读取NPC持有写租约时的已提交前缀，避免重新挂载应用争用租约 | 后续NPC尚未完成时玩家已能读到前一个回应；页面仍busy，候选操作在整轮结束后完整刷新 |
| 每会话一个Python Core进程 | 顺序请求共用既有`vector_core._MODELS`编码器缓存；档案、scope和Source逐请求提供 | 取消任务会终止子进程，下一次请求新建；关闭运行时回收进程。临时未完成工作允许丢弃，无自动重试 |
| Character固定cognition紧凑呈现 | 重复字段放入common，变化字段用columns/rows；相同来源引用集中表达，records与values逐行对应 | 所有正文、ID、Hash、权限范围、来源和数值保留；仅改变模型消息文本，宿主Context和持久化不变 |

常驻网页入口使用`createCoreWorker`与Python桥`--serve`。独立对照脚本仍可使用原单次进程命令。没有引入通用进程池、框架、数据库、持久化协议版本或新恢复机制。压缩只作用于已经为当前角色授权的认知材料；模型消息说明了表格读取方式和主观认识边界，没有跨角色汇总。

对应源码：`packages/application/src/prototype-character-turn.ts`、`tests/experiments/playtest-frozen-runtime.ts`、`tests/experiments/hindsight-python.ts`、`experiments/activity-memory/core_bridge.py`、`packages/provider-chat/src/character-context-text.ts`与`prototype-turn.ts`。

## 3. 真实耗时与信息体积

主测为10次输入加1次整理，之后另补2次工作区输入及1次真实浏览器输入。每750毫秒读取玩家state；首条时间有最多一个轮询间隔的测量误差。首条指新增的已提交NPC可见内容，包含移动反馈，不保证是对白；没有新增可见NPC内容时记为“无”。单位为秒。

| 主测阶段 | 整轮HTTP | 首条NPC可见内容 | Character HTTP尝试 | Core投影合计 | 结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| 问候四角色 | 25.27 | 7.56 | 4 | 0.07 | 完成，四角色分别回应 |
| 点名GPT闲聊 | 26.89 | 12.17 | 3 | 0.06 | Claude先移动；随后格式错误 |
| 说明饮料偏好 | 30.33 | 6.07 | 5 | 0.11 | 期限中断，已显示三人回复 |
| 整理长期记忆 | 153.77 | 无 | 0 | — | 完成，四角色构建合计153.49秒 |
| 整理后换话题 | 30.37 | 6.83 | 6 | 0.99 | 期限中断，已显示回复与移动 |
| 询问饮料回忆 | 8.45 | 8.45 | 2 | 0.14 | 完成，GPT记得柠檬茶与不太甜 |
| 移动到客厅 | 30.34 | 6.08 | 6 | 0.48 | 期限中断，DeepSeek/GPT已跟随并表达 |
| 客厅继续闲聊 | 10.24 | 5.32 | 2 | 0.17 | 完成 |
| 客厅暗号 | 15.57 | 5.33 | 3 | 0.31 | 完成，仅客厅两人收到 |
| 返回卧室 | 30.40 | 无 | 5 | 0.46 | 期限中断；NPC在其他房间行动 |
| 卧室询问暗号 | 0.30 | 无 | 0 | 0.00 | 无在场NPC，不算隔离验证通过 |

补测进入工作区共13.95秒，Claude在9.11秒出现；询问未在场两人的暗号共8.41秒，Claude在5.32秒出现。两次首次出现时state均仍busy。真实浏览器再通过世界包iframe中的发送按钮推进，MutationObserver记录Claude在8.43秒进入DOM，当时busy为true且发送禁用；之后GLM才结束。页面截图保存在`output/playwright/ai-girls-incremental.png`，没有把接口轮询等同于浏览器绘制实测。

### Core与Embedding

整理后的主测24次完整Python召回（宿主发送至收到结果）为**0.033—0.489秒，中位数0.044秒**；首次约0.489秒，后续多数约0.04秒。主测四角色整理期间仅一次模型初始化，3.46秒；之后新查询编码约数毫秒至数十毫秒。基线需新编码的召回为4.68—4.79秒，进程内加载约3.42—3.50秒。新进程的冷启动、重开网页或取消后的重新加载仍有成本，不把热启动数字宣传为所有场景速度。

另外直接调用生产版`--serve`入口，对三个不同角色的同一授权档案、请求和索引，与原单次进程返回做deep equality：全部一致。本组查询已缓存，单次进程约1.02—1.05秒；常驻入口首请求0.88秒、后续0.04秒左右。它验证正式入口和结果一致，不能替代上面的需新编码实测。

整理仍为153.77秒，12次Utility累计145.62秒。常驻进程减少重复加载，却没有让Utility等待消失；基线156.59秒与本轮153.77秒不是相同来源量的对照，不能据此宣称整理稳定加速。按用户顺序暂不优化这12次调用。

### Character固定认知

| 角色 | 原cognition字符 | 紧凑字符 | 减少 | 基线同类开场prompt token | 新开场prompt token |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude | 14012 | 10355 | 26.1% | 9356 | 7795 |
| DeepSeek | 14037 | 10249 | 27.0% | 9364 | 7706 |
| GLM | 14050 | 10698 | 23.9% | 9892 | 8189 |
| GPT | 14545 | 10724 | 26.3% | 9828 | 7968 |

从基线20份及本轮38份真实返回请求提取cognition，用独立还原器展开后逐字段比较，**58份全部一致**。表格字符数取四角色的代表性固定材料；token数是网关实际usage，含完整消息和工具schema，并非字符数换算。同类开场请求约减少17%—19% token，后续观察累积使本轮完整prompt仍达到7706—12292 token。没有删除观察、记忆、人格或 provenance，也没有证明生成延迟会同比减少。

## 4. 人物自然度、隔离与剩余体验问题

开场Claude仍审慎地谈身体与认知失调，DeepSeek表现兴奋和探索欲，GLM关注设备与工作环境，GPT温和地回应关心。之后Claude和GLM自主去了工作区，DeepSeek/GPT跟到客厅再去厨房；没有为计时固定行动或强制所有人回应。这些表现说明本轨迹没有显著丢失原设定，不能作为长期自然度已验收的证明。

暗号发生时玩家、DeepSeek、GPT在客厅，Claude/GLM在工作区。先回卧室因无人无法验证，随后实际进入工作区询问：Claude明确说不知道、没有接收到客厅输入；GLM也说没在客厅、没听到。离线复核38份返回请求的角色地点与场景地点全部一致，42份召回trace角色scope一致，Claude/GLM全部实际请求都没有暗号正文；SQLite中8行含暗号的Source只属于玩家、DeepSeek和GPT。增量投影的另一房间私有回复回归也通过。

13次输入中仍有4次期限中断，另1次格式错误：模型返回Markdown代码块字符串而非决策对象，未提交该次输出。增量显示减少整轮没有新内容的等待，但busy期间仍不能发送下一条；返回空卧室时远处NPC处理仍可能花30秒且玩家看不到回复。没有证据可以断言30秒现在已不难受，后续由真实玩家继续感受，再决定调度、deadline和调用预算。格式问题保留为已知失败，本轮没有附加解析重试或语义审查层。

## 5. 检查、复核入口与未验收范围

| 验证 | 结果 |
| --- | --- |
| `corepack pnpm@11.7.0 check` | 类型、Lint、默认27文件185项通过 |
| 相关TypeScript测试 | 6文件45项通过，覆盖增量可见/暂停、异房间隐藏、Core授权、进程复用/取消/关闭、压缩还原与现有perform路径 |
| Python桥局部单元测试 | `unittest discover -s experiments/activity-memory -p test_core_bridge.py`，18项通过 |
| 真实模型与网页 | 13次输入、1次整理，含一次真实浏览器DOM确认与暗号跨房间补测 |
| 全部Python实验、硬崩溃、桌面打包/发布 | 本轮未运行；没有修改提交事务或恢复规则，桌面Core资产打包仍未验收 |

相关测试命令使用`vitest run --config vitest.config.ts`，文件为`tests/experiments/playtest-frozen-runtime.test.ts`、`hindsight-python.test.ts`、`tests/prototype/playtest-memory-core.test.ts`、`g1-combination.test.ts`、`perform-continuation.test.ts`及`packages/provider-chat/src/character-context-text.test.ts`。默认check与专项测试有重叠，不将项数相加作为独立覆盖数量。

完整诊断在`.tmp/ai-girls-optimized-20261006/`：`stages.json`为冻结主测，`supplemental.json`为工作区补测，`timing.jsonl`/`python-timing.jsonl`为阶段计时，`context-lossless.json`、`production-worker-check.json`、`audit.json`为离线校验，`browser-timing.json`为DOM首条证据，`profile.ts`、`profile_bridge.py`、`check-context.ts`、`check-worker.ts`与`audit.py`为本机复核工具。模型trace与Source属于私有诊断，只留本机，不发给玩家或进入Git。

保留的新网页服务继续使用本次Core存档；原基线服务仍是旧运行代码，不能将旧页当作新版。用户后续输入可以继续计时，但不自动追加到已冻结的主测表。下一步是继续正常游玩，观察首条等待、回复自然度、busy期间的等待及中断后内容衔接；常驻Core、压缩和增量显示已有收益，预算与长期整理的进一步修改等待实际体验证据。
