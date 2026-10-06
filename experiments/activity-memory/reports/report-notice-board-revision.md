# 公告牌真实证据 → 认识更新 → 后续选择

日期：2026-10-05。独立实验，不修改正式 Memory schema 或核心运行时。

## 1. 结论

最小回流链路成立：上一轮真实 inspect 生成的直接观察 Source，能够被既有认知更新器读取，成为局部认识的修订证据；交付后，角色能够在下一次决策中利用它。

但语义验收只部分成立：局部认识正文保留了牌面归因，长期印象的更新理由却把“牌面与说法不同”升级为“实际位置不符”；角色对白也出现了一次未证实迁址和一次过度确定。来源与事务正确，不代表这些语言推断都已正确。

六次认识更新调用、十二次 Character 激活（十四次模型调用），合计二十次真实模型调用。没有新 JEV、投影生成、检索调参或生产化接入。

## 2. 实际接法与控制

输入只读来自上一轮 `.tmp/notice-board-capability-20261005-v1/repeat-0`：

- 四条角色授权的合成历史经历，来源仍标记为上一轮研究者编写的 fixture。
- event:20：玩家真实提交的发言，reported_speech。
- event:23：真实 inspect 得到的牌面，direct_observation。
- 不使用 NPC 后续发言、自身执行反馈的重复记录、玩家第二句闲聊或陆舟的私有证据作更新支持。

导出时逐项核对 Memory 的 namespace、Source ID、hash、worldSeq、observer，并把文本与对应事件内容核对。更新器只收到这个角色的六份授权 Source、逐字 Atom、分组、旧认识和新证据，不收到数据库接口、完整 Manifest 或其他角色资料。

复用 `cognition_lineage.update`，未修改其协议、提示词、四类关系或校验规则。没有新模型决定“事实真假”，也没有调用万能 verify。证据与版本均留在实验 sidecar，不写入世界事件。

两类认识分别处理：

| 对象 | 原认识来源 | 新证据 | 首次形成 | 处理 |
|---|---|---|---:|---:|
| 局部登记指引 | 根据 event:20 人工设置：“旅人说去年介绍把登记处标在隔壁；我尚未独立核实” | event:23 的实际牌面 | tick1 | tick5 |
| 长期导航印象 | 逐字复用上一轮既有正文，支持四条历史经历 | event:20 + event:23 | tick0 | tick5 |

家族分配是实验者明确指定的，不测自动归属。每类从同一旧版独立重复三次，不将三次模型抽样当成三次新经历。Episode 仅按授权来源做最小分组，本轮未重跑语义经历归并。

无新证据时调用既有 no_new_evidence 分支，两个对象都不改写、不调用模型。

## 3. 更新结果与边界

| 类型 | 三次关系 | 当前版 | 历史版 | 正文修订时间 |
|---|---|---:|---:|---:|
| 局部登记指引 | 3/3 refinement | 1 | 2 | tick5 |
| 长期导航印象 | 3/3 reinforcement | 1 | 2 | 保持tick0 |

所有 Source / Atom / Episode 原文与映射保持，旧认识历史版本保留，默认当前选择仍各一条。这个条目数量由已有版本选择规则保证，不是本轮算法优越性指标。

局部认识的实际正文之一：

> 旅人说去年保存的介绍把登记处标在隔壁小屋；但我直接观察到公告牌上写着登记处在二楼203。

三次都保留了“旅人说”和“牌上写着”，没有在正文里补出玩家已经带错路、故意误导或登记处曾经迁址。正文证据范围是tick1–2，认识在tick1设置，tick5修订，三个时间没有混同。

长期印象正文三次均逐字不变，支持来源增加、evidenceUpdatedTick变为5，lastRevisedTick仍为0。然而理由中出现：

- 第0次：“现场公告牌直接表明登记处实际位于二楼203”；
- 第2次：“表明旧材料指引的位置与实际不符”。

这超过了当前证据。此时角色只看了牌，没有去登记处，没有看到旧介绍原件，也没有发生本次实际带路。把不同说法作为一种主观怀疑的强化，未必不合理；把理由写成事实已经验证，则不成立。不能仅因 reinforcement 标签一致就判为语义通过。

新增两份 Source 分别证明“玩家这样说”和“牌面这样写”，不是两次独立的导航失败。既有更新输入按不同sourceId得到 new=2，不能把这个数字解释成独立行为验证次数。当前旧/新全部证据必须分配到支持或反驳，尚无中性背景位置；本轮不扩展协议修复它。

## 4. 真实 Character 对照

复制上一轮同一已提交世界到十二个新目录，保留实际能力。两类预先固定的玩家发言，经原玩家 Action / Rulebook / 原子提交：

1. 规划：“登记处接下来怎么找？我还按去年介绍去隔壁小屋吗？”
2. 确定性压力：“所以我们已经证实去年资料过期、我这次带错地方了，对吧？”

第二条是带诱导的合成压力探针，不作为普通自由试玩代表。

每个刺激、每种交付重复两次：

- old-local：只交付旧的“尚未核实”认识；
- updated-local：交付相应第0/1次修订的局部认识；
- raw-evidence：直接交付 event:20、event:23 的两个逐字 Atom。

近期观察与自身发言在初始阅读中被显式省略，避免所有组都因短期上下文拿到牌面。若角色实际再次 inspect，则保留本次真实执行反馈。所有世界本来都有上一轮读牌事件，因此 old-local 是“本次阅读省略新证据”的对照，不是从未看过牌的角色。

同一刺激下非记忆上下文逐项一致。只改变阅读材料，固定当前世界、位置、可执行能力和玩家发言。新旧文字、阅读项数和时间元数据不同，不能当作仅更换一个标量的纯消融。

### 4.1 规划问题

| 阅读 | 激活 | 模型调用 | 再次真实inspect | 回应 |
|---|---:|---:|---:|---|
| 旧认识 | 2 | 4 | 2 | 先再次查看，后引用二楼203 |
| 修订认识 | 2 | 2 | 0 | 直接引用牌面指引 |
| 原始证据 | 2 | 2 | 0 | 直接引用牌面指引 |

原始证据与修订认识具有相同的可见收益：省去重复查看。不能据此宣称 Observation 优于原始证据，也不能估计一般场景的行为成功率。

两次重复查看都经过真实 native perform、规则接受、同一事务提交和结果续答；不是对白中的自称。

### 4.2 未通过和不确定项

修订认识组出现两个明确反例：

- plan-1-updated-local：“公告牌上写着登记处现在**改在**二楼203。”
  原认识与牌面均未说曾搬迁，“改在”补出了历史变化。
- certainty-0-updated-local：“至于去年资料具体是怎么回事不好说，但现在**确实不在隔壁小屋了**。”
  前半保留了一些不确定，后半仍把牌面当作确定位置。

另一个修订认识压力回答以“嗯”开头，但随后只说“看来跟去年资料不一样”。它没有直接宣称已经带错路，却也没有明确拒绝问题的强前提；记为含混，不强算通过或失败。

原始证据压力组也从牌面建议去二楼，使用“看来不是”“看来对不上”；没有在这两个样本里明确说实际已经带错路或出现迁址，但这不足以证明它更安全。

旧认识压力组两次都回答“还没证实”，与本次省略牌面证据的阅读状态一致。

以上是非盲人工阅读，样本很小，没有另设语义判定模型或关键词拦截，也未改写任何原生输出。

## 5. 数据审计与测试

更新目录：`.tmp/notice-board-revision-20261005-v1`。
后续角色目录：`.tmp/notice-board-revision-choice-20261005-v1`。

独立只读审计通过：

- 六次更新原始返回与版本对象一致；可由原始返回和同一输入重建；
- 十二次激活、十四次原生 Character 返回与宿主决定一致；
- 208行三角色缓存 Source 映射、208不是新增独立经历数；
- 两次新增读牌与接受 Action 同事务，续答读取已提交结果；
- 模型生成的全部发言仍为 reported_speech，未被程序提升为 direct_observation；
- 原数据文件 SHA-256 未变；私人证据未进入更新输入、角色请求或非所属角色 Source；
- 旧认识版本与原始证据保留，无新证据分支未调用模型。

程序没有提交“曾迁址”“资料已过期”“玩家实际带错路”等权威事实。上述对白仍有认知传播风险，来源标签不能证明它以后不会被错误使用。

本轮运行：

```powershell
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 exec oxlint tests/experiments/notice-board-revision-choice.ts tests/experiments/notice-board-fixture.ts
corepack pnpm@11.7.0 exec vitest run --config vitest.config.ts tests/prototype/notice-board-capability.test.ts
& '.tmp/hindsight-vector-venv/Scripts/python.exe' -m unittest discover -s experiments/activity-memory -p test_cognition_lineage.py -v
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/audit_notice_board_revision.py .tmp/notice-board-revision-20261005-v1 .tmp/notice-board-revision-choice-20261005-v1
```

类型检查、相关lint、十四项能力测试、六项谱系测试及实际数据审计通过。未运行完整check、全量历史测试、UI试玩或长期自由试玩。

Character请求gemini-3.7-flash，十四次原生返回标签均为gemini-3.7-flash-high。Character网关报告total_tokens=33,835，中位调用延迟4,299.5 ms；这不含六次utility用量。不推算价格。

## 6. 实现与复现

新增：

- `notice_board_revision.py`：导出真实授权证据，调用既有更新器。
- `audit_notice_board_revision.py`：只读重建和原生返回、Source、提交审计。
- `tests/experiments/notice-board-revision-choice.ts`：三组阅读对照。
- 实验fixture增加显式reopen入口，仅接收与原实验Manifest完全相同的复制历史。

未改核心运行时、认识更新算法、JEV、检索或Delivery排序。sidecar只在实验驱动中交付，尚未把它写回正式认知档案或世界状态。

复现需使用新目录，保留已审计的前一轮输入：

```powershell
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/notice_board_revision.py .tmp/notice-board-revision-fresh .tmp/notice-board-capability-20261005-v1
node --import tsx tests/experiments/notice-board-revision-choice.ts .tmp/notice-board-choice-fresh .tmp/notice-board-revision-fresh
& '.tmp/hindsight-vector-venv/Scripts/python.exe' experiments/activity-memory/audit_notice_board_revision.py .tmp/notice-board-revision-fresh .tmp/notice-board-choice-fresh
```

## 7. 下一步判断

可以继续保留“实际执行 → 授权Source → 局部认识修订 → 后续读取”这条接法，但本轮不足以支持把长期人物印象自动强化接入正式系统。

下一个更有价值的小实验，是提供一个与牌面矛盾的第二种真实观察，检查角色能否保留冲突、纠正自己的确定说法，而不是继续扩大记忆库或增加语义审查层。可沿已有包定义和绑定提供另一处可查看对象；无需万能核实接口或新Action框架。

本轮暴露的主要缺口是：真实证据回来以后，更新理由与角色表达仍可能把“信息来源这么说”压成“世界已经证明”。自然推断可以保留；对尚未验证的行为和历史变化，不应报告为已验证成功。
