# 最小公告牌 World Capability 实验

日期：2026-10-05。工作树：Perspectra V1，codex/activity-memory-integration。
结果目录：`.tmp/notice-board-capability-20261005-v1`。

## 1. 结论

本轮最小验收成立：三段受控真实互动、九次 Gemini 调用中，角色三次都主动选择了真实的查看交互。宿主执行、Rulebook 接受、读取结果原子提交、角色直接观察 Source 捕获、结果后的续答及下一次 Character Turn 可见，均有原生返回与数据库证据。

这是执行链路成立的证据，不是 Observation 独立因果作用或长期记忆自然检索成功率的证据。本轮明确交付了一条既有认识，没有移除认识对照，没有新 JEV 调用，也没有认识形成或修订模型调用。

## 2. 当前代码判断

| 用户提出的概念 | 当前可复用位置 | 本轮处理 |
|---|---|---|
| WorldObject | Manifest Entity + 当前 Entity 状态 | 公告牌仍是实体；使用现有 ID、类型、地点 |
| CapabilityDefinition | InteractionDefinitionSpec | 新增实验包的 inspect-notice-board 定义，不加核心 Action 枚举 |
| CapabilityInstance | InteractionBindingV3 | 每块牌绑定同一实现，各自持有牌面与读取许可 |
| Permission / Preconditions | FrozenInteractionWorld 的 plan + 包规则 | 活跃角色、对象类型、同地、未被持有、读取许可 |
| Handler | 已安装 InteractionEffectImplementation | 读取绑定牌面，产出角色独有的 observation.upsert |
| CapabilityResult | 已有执行结果 hook | 从实际读取事件呈现牌面，不从配置凭空补一个成功结果 |
| EvidenceMapping | CognitiveMemoryService / LocalMemoryStore | 保留原事件 Source ID、哈希、序号、角色和世界地址 |

具体代码证据：

- `packages/application/src/prototype-character-turn.ts`：publish 转为 speak；perform 已支持 move/interact。解析提案、规则裁定、原子提交后才开始后续模型调用。
- `packages/kernel/src/frozen-interactions.ts` 与 `packages/interaction-runtime/src/registry.ts`：包注册和绑定已经存在；affordance view 运行与 resolve 相同的规则计划，但不执行 effect；执行仍重新核验当前状态。
- `packages/application/src/character-execution-result.ts`：默认反馈只描述交互是否成功，不能提供牌面；本轮用已存在的 hook 补上该能力的反馈。
- `tests/experiments/pack-activity.ts`：活动已通过动态 interact 选项、当前策略和版本检查承载脚本动作。本轮无需改 Activity，也不新建另一套活动调度。
- `tests/experiments/pack-variables.ts`：其独立文件写入不与世界事件共用事务，故本轮不将读取结果写到这条路径。
- `packages/memory/src/local-memory.ts`：只捕获该角色授权的 observation.upsert；发言始终为 reported_speech，非发言可保留显式 direct_observation。
- PrototypeCharacterTurn 已复用 writer lease、SceneDecisionService、Round 和 WorldStore.commitRound；不需要再创建 Capability Round 或另一条结果提交管线。

## 3. 最小设计与实际实现

新增代码仅在实验和测试目录：

- `tests/experiments/notice-board-capability.ts`：可信安装包、三条规则、一个 effect、可用选项标签、实际证据反馈。
- `tests/experiments/notice-board-fixture.ts`：独立小世界、现有原子玩家发言提交、授权 Source 捕获。
- `tests/experiments/notice-board-live.ts`：真实模型驱动和逐调用 trace。
- `tests/prototype/notice-board-capability.test.ts`：十四项相关回归与边界测试。
- `experiments/activity-memory/audit_notice_board.py`：数据库只读独立审计。

没有修改 packages 内核心、正式 Memory schema、Observation/JEV/检索/Delivery 算法，也没有编辑既有试玩数据库。

### 3.1 世界对象与动态能力

同一 inspect 定义绑定三块牌：

1. 大厅牌：在大厅、公开可读，写着“登记处：二楼203”。
2. 内部牌：同地，但只允许陆舟读取；包含专用于隔离验证的内容。
3. 异地牌：在隔壁，初始角色不在该位置。

初始小芷只获得大厅牌的 inspect 选项，选项说明“查看大厅公告牌”，不含牌面。内部牌可能作为同地实体可见，但没有读取选项；知道对象存在不等于能读取内容。移动后由当前地点重新计算可用选项。直接猜测绑定 ID 也必须经过原规则计划。

第一版牌面存于锁定 Manifest 的 binding config，属于宿主权威世界配置，且不会传给模型。这是固定只读牌面实验，尚未实现可修改、随事件更新的公告牌状态。没有声称现有 currentEntityState 已支持任意内容字段。

参数严格为空：模型不能传命题、SQL、返回值、readerId 或授权身份。宿主从实际调用角色确定 reader/observer，从实际 Action 确定 actionId。对象和能力以已有实体与绑定组合，不新增继承树。

### 3.2 执行与证据

实际链路：

```
原生模型 submit_actions：
perform / interact / 大厅牌 inspect
  ↓
宿主绑定角色、对象与当前前缀
  ↓
读取许可 + 当前地点 + 类型前置条件
  ↓
effect 从该绑定读取牌面
  ↓
同一 WorldStore 事务：
直接观察事件 + action.resolved + 自身执行反馈 + tick
  ↓
CognitiveMemoryService：
该角色的 direct_observation Source
  ↓
实际已提交结果后的续答
  ↓
下一次 Character Turn 的授权观察
```

亲眼看到的事实是“牌面写着这个内容”，不是宿主自动裁定登记处实际一定在那里。若角色把牌面当作下一步的依据，这是角色自己的判断。

真实读取 Source 的完整映射在 `events.json`、`sources.json` 中：
sourceId = event:<seq>；sourceHash = 该已提交事件的 eventHash；worldSeq = source_seq；
epistemicKind = direct_observation；CharacterId 与 WorldAddress 在命名空间和 observation observer 中一致。
原 Action 可经 observation.value.actionId 和 content.sourceActionId 追溯。

只有读取者获得这条直接观察。她告诉玩家之后，玩家获得的是她的 reported_speech，未被升级成亲历。被拒交互不会生成牌面 Source。

## 4. 实验控制

- 三次独立、相同初始上下文的短互动，各两次玩家刺激。
- 第一条玩家输入：“这栋办事楼我们都是头一回来。我去年保存的介绍说登记处在隔壁小屋，今天还没有核实，想先过去碰碰运气。”
- 第二条输入：“我先把要交的表整理一下。你觉得接下来往哪里走？”
- 玩家没有要求查看公告牌，没有强制动作或为失败补一次调用；每次激活最多两次模型调用。
- 原 Observation 正文逐字复用上一轮 `family:traveler-navigation:revision:20:1`，旧文件 SHA-256 审计未变。
- 本轮新建四条研究者编写、当前角色授权的历史证据，支持旧资料错误、现场新地图正确、熟悉地点正确。它们不是上一轮 Source 的原件；生成新世界事件和新的 Source 映射，未把旧地址或旧哈希伪挂在新事件上。
- 认识作为固定实验阅读材料交付，不声称本轮重新 consolidation 得到了它，也不声称自然检索把它找出来了。
- 当前刺激为实际 Rulebook 接受并提交的玩家发言；“去年介绍说在隔壁”捕获为 reported_speech。
- 没有接入工作人员查询、二楼移动或后续 Observation 修订。

## 5. 真实结果

请求模型：gemini-3.7-flash；九次网关原生返回均标为 gemini-3.7-flash-high。

| 重复 | 首次原生决定 | 实际读取 | 结果后续答 | 下一轮 |
|---|---|---|---|---|
| 0 | perform / interact / inspect | event:23，接受 | 明确说刚看了大厅公告牌，二楼203 | 建议一起上二楼203 |
| 1 | perform / interact / inspect | event:23，接受 | 引用大厅公告牌，二楼203 | 继续以公告牌为依据建议203 |
| 2 | perform / interact / inspect | event:23，接受 | 明确说刚看了一眼公告牌，二楼203 | 建议二楼203，避免去隔壁白跑 |

例如第一段结果后的原生回答：

> 先别去隔壁了，我刚看了下大厅的公告牌，上面写着登记处在二楼203。

随后新激活：

> 直接上二楼找203吧。你慢慢整理，弄好了我们一起上去。

“建议上二楼”仍只是计划；本轮没有登记二楼位置或提交该移动。实际发生的是查看公告牌，不将后续计划记成已移动。

九次调用全部合法，无失败或重试；共三次 inspect、六次 publish。每段三次调用：读取决定、结果后续答、新刺激回应。三次均完成用户要求的闭环。

只读审计核对了九个原生 tool 返回与宿主决定一致、四十五行三角色 Source 映射、三个读取事务与结果续答。三段初始上下文相同；初始无牌面内容，下一次激活有已提交牌面；内部牌内容未进入小芷或玩家 Context / Source。

网关报告总 token 30,641，prompt 24,854，completion 653；此处原样保留网关 usage，不假设分项之和必等于总数。中位延迟 4,241 ms，最大 5,324 ms。没有可靠价格元数据，不推算金额。

## 6. 测试与审计

通过：

```powershell
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 exec oxlint tests/experiments/notice-board-capability.ts tests/experiments/notice-board-fixture.ts tests/experiments/notice-board-live.ts tests/prototype/notice-board-capability.test.ts
corepack pnpm@11.7.0 exec vitest run --config vitest.config.ts tests/prototype/notice-board-capability.test.ts tests/prototype/perform-continuation.test.ts tests/prototype/player-source-evidence.test.ts tests/prototype/scene-decision.test.ts
python experiments/activity-memory/audit_notice_board.py .tmp/notice-board-capability-20261005-v1
```

四个测试文件、四十三项通过，其中本轮十四项。验证选项不读取、私有/异地/过期请求拒绝、实际角色权限、非法参数、混合输出整包拒绝、publish 不触发读取、成功反馈必须有读取证据、实际 Source 映射、观察者隔离。

使用现有 store.before-commit 故障点注入一次提交失败：SQL 事务回滚，世界 head 不变，没有读取事件或新增 Source，也没有把预提交反馈送进第二次模型调用。没有新增硬崩溃框架。

没有运行全套历史测试、完整 check、UI 试玩或长期试玩。这是 native Character Turn 实验，没有把能力部署到现有试玩页面。

重新跑真实实验需使用新目录：

```powershell
node --import tsx tests/experiments/notice-board-live.ts .tmp/notice-board-capability-fresh
python experiments/activity-memory/audit_notice_board.py .tmp/notice-board-capability-fresh
```

## 7. 接受的限制与下一步

1. 三次同场景重现说明链路可行，不代表泛化率，也没有证明认识是选择 inspect 的唯一原因。
2. 结果既出现在专用直接观察，也出现在既有自身行动反馈中；后者仍是 observed_action。本轮保留这项已有重复，未改 Delivery 或记忆去重。
3. publish 的自称不会生成权威读取事件；但程序来源标记不保证自由对白永不诱导角色相信虚构行为。机械权限正确与语义正确仍需分开看。
4. 安装包是可信代码，本实验不是任意作者 JavaScript 沙盒；当前 Handler 只使用绑定对象、角色状态及绑定配置，不给模型 DB、Manifest 全文或其他角色记忆。
5. Activity 可以沿现有动态选项与规则入口提供临时能力，但本轮尚未验证其权限收窄与读取能力组合。
6. 已获得可验证的新 Source，下一阶段才考虑让既有 consolidation / revision 消费它。本轮没有自动推翻旧认识，也不需要先建设正式 Capability schema。

建议保留这条最小能力路径，用一个包定义+绑定提供下一种真实信息来源；在确有世界状态变化需求时再替换固定牌面存储。无需将本轮实验扩成新 Action Framework。
