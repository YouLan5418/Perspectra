# Memory Evolution 实施规格：独立策略边界与长期召回

| 属性 | 值 |
|---|---|
| 契约版本 | `memory-evolution/v0.1` |
| 状态 | Proposed implementation target；尚未实施 |
| 日期 | 2026-09-06 |
| 调研基线 | `a2cc212` / 根包 `0.3.1` |
| 工作流 | M0～M4，不替代现有 Phase 路线 |
| 目标 | 在既有认知防火墙内独立演进召回与经历组织 |
| 规划入口 | [记忆模块策略演进规划](../archive/memory-evolution/2026-09-06_规划-记忆模块策略演进.md) |

> **版本警告：** 本文的新接口与算法名为目标契约，尚不存在于生产 API。旧 `recall-query-plan/v1`、`fts5-bm25-stable/v1`、L1 与 Context 语义不得原地替换。

> **权威警告：** “Alice 相信 X”可以是权威认知事实，“X 为真”并不因此成立。Memory 只派生和选择已授权来源，不直接写入认知事件。

> **验收警告：** 本文未执行质量基准或性能测量。表中的阈值是拟议验收目标，不是当前项目实测成绩。

## 1. 文档优先级与前置契约

Accepted ADR → 本文经接受后的契约 → 配套规划。Proposed 内容与现有 Accepted ADR 冲突时，继续执行既有契约，并在实施提交中新增 ADR 明确演进关系。

必须遵循：

- [V0.2 冻结规格](implementation-v0.2.md)；
- [Phase 8 规格](phase-8-implementation-v0.1.md)与 [Phase 9 规格](phase-9-implementation-v0.1.md)；
- [ADR-0035](../adr/ADR-0035-knowledge-memory.md)：捕获、来源与非权威边界；
- [ADR-0064](../adr/ADR-0064-context-v2-cache-provider-boundary.md)：Context 与 Provider 持久化边界；
- [ADR-0067](../adr/ADR-0067-cognitive-memory-worldpack-v2.md)、[ADR-0068](../adr/ADR-0068-phase8-context-summary-signal-quality-closure.md)：水位、唯一 L1 与 Hash；
- [ADR-0071](../adr/ADR-0071-reflection-operation-protocol.md)：Reflection 的已包含依据；
- [ADR-0073](../adr/ADR-0073-participant-stimulus-director-visibility.md)、[ADR-0074](../adr/ADR-0074-deterministic-world-text-order.md)：刺激权限与稳定文本排序；
- [ADR-0077](../adr/ADR-0077-bounded-autonomous-reaction-cycle.md)、[ADR-0081](../adr/ADR-0081-deployment-backup-restore-set.md)：wave as-of 与部署恢复集合。

不读取或修改只读上游调研仓库，不增加未发布 Harness 路径依赖。

## 2. 范围与非范围

本工作流实现内部职责分离、可版本化的确定性多路召回、来源分组、固定数据评测与部署兼容。首轮仍使用本机 `node:sqlite`，不引入模型检索工具、外部向量服务、图数据库或新的世界 Action。

保留现有 CognitiveMemoryService 对外门面与旧版路径；新行为采用显式策略版本。当前 Claim、Goal、Relationship、Affect、Commitment、OpenLoop 继续从权威 Projection 读取。后几类可提供查询线索，但不因此成为新的 Memory capture source kind。

## 3. 当前行为与目标差异

| 项目 | 当前实现观察 | 目标 |
|---|---|---|
| 存储与算法 | LocalMemoryStore 集中实现 | 在同一包内隔离 Repository / Validator / Strategy |
| 查询 | 从授权 stimulus 提取字符串 | 文本与结构线索分开，保存完整计划 |
| 检索 | FTS5 AND / BM25 / seq / ID | 三通道候选、稳定融合、确定性去重 |
| 计划 | 只允许 `fts5-bm25-stable/v1` | 新 Plan union 和显式策略锁 |
| 回执 | 排名与已选来源 | 新版本增加通道、策略、索引身份与裁剪理由 |
| L1 | 八条以内原文 extracts 分组 | 保留既有算法；新增独立来源分组索引 |
| Context | 消费侧二次容量裁剪 | 保持；补充“检索命中但未包含”的质量指标 |

这些观察只说明扩展点，不把未经复现的性能或泄漏风险写成已确认缺陷。

## 4. 模块职责与依赖

```text
WorldStore / authorized CharacterView
  -> SourceVerifier -> verified source records
  -> CaptureService -> SqliteMemoryRepository + watermark

Host authorized stimulus + current cognition refs
  -> RecallPlanner -> versioned plan
  -> RecallStrategy -> candidate identities
  -> SourceVerifier -> stable fusion / dedup / limits
  -> durable RecallReceipt
  -> Agent ContextAssembler -> included refs / ContextReceipt
```

| 职责 | 拥有的数据或行为 | 禁止行为 |
|---|---|---|
| SourceVerifier | namespace、来源 Hash、as-of、可见性闭包 | 信任策略自报的来源正文或授权 |
| CaptureService | 已提交来源捕获、耐久任务、水位协调 | 让异步整理阻塞世界事务 |
| SqliteMemoryRepository | Schema、SQL、事务、索引与回执存取 | 调用模型、根据墙钟改历史排名 |
| RecallPlanner | 从授权情境形成可重建查询 | 读取作者秘密或其他角色当前状态 |
| RecallStrategy | 在受限来源池产生候选 ID 与通道排名 | 直接写 WorldStore 或绕过公共验证 |
| EpisodeIndexBuilder | 将授权来源组织为经历索引 | 新写信念、生成另一份自由文本摘要 |
| CognitiveMemoryService | 生命周期与上述职责协调 | 向外暴露无范围数据库 Handle |

这些名称是职责建议，不要求每项成为类或服务。策略为仓库内受信代码，接口隔离不宣称 JavaScript 沙箱。来源 Reader 应只暴露完整 address、固定 character 和 as-of 的只读方法；生命周期注册跟随所属 Branch Fiber。

M0 保留 `index.ts` 已有导出，旧构造方式可通过默认组装适配。不要在拆分时迁移 `cognition.ts` 的领域规则或修改旧 Receipt bytes。

## 5. 不变量

1. 所有查询绑定完整 WorldAddress、characterId 和 required as-of；模型不能替换这些字段。
2. 仅已提交且授权的来源可长期捕获；当前 provisional stimulus 只作为查询上下文，不伪装成已提交 Memory。
3. 每次模型调用前必要捕获与验证追平目标水位；失败遵循既有参与者降级或完整性隔离策略。
4. 新通道的查询线索必须有可验证依据。线索合法不代表候选自动合法，候选仍逐项验证。
5. 来源缺失、Hash 分歧、未来或跨作用域不得退回未过滤文本。完整性故障不能伪装成正常空命中。
6. active Claim 是当前信念；旧的 belief Memory 是历史经历。检索结果不得覆盖当前 Cognition 或省略 epistemicKind。
7. Summary 不作为新的捕获来源，不做 summary-of-summary。经历分组只引用原始来源。
8. 排名不受 Promise 完成顺序、Locale、其他角色资料、父分支未来或当前墙钟影响。
9. 历史 Recall / Context 的精确结果可以由耐久数据重建；当前索引优化不得重写旧回执。
10. SQLite 保持 WAL、FULL 和短 BEGIN IMMEDIATE；事务中不等待模型、网络或异步整理。
11. fork 以 forkSeq 重建子 namespace；不能直接复制父分支当前索引和检索统计。
12. 同一来源既被 Tail 又被 Recall 包含时，预算与去重以来源身份核算，不能删除认知状态必要字段以节省空间。

## 6. Plan、Profile 与 Receipt 演进

### 6.1 新 Recall Plan

新增 `recall-query-plan/v2`，以 discriminated union 与 v1 并存。下表是必需语义字段；M1 提交正式 TypeScript / Schema Golden 后才成为运行接口。

| 字段 | 约束 |
|---|---|
| schemaVersion / planId | 新版本；确定性身份包含参与者与请求用途 |
| address / characterId / asOfWorldSeq | 宿主固定；品牌 ID 与 safe integer |
| strategyId / profileHash | 精确算法与参数身份；未知版本 fail-closed |
| queryText / normalizedTerms | 原始授权查询与确定性规范化结果；规范化算法锁版本 |
| entityRefs | 类型化实体 ID 及每项授权 basisRefs；禁止只用显示名作为主键 |
| activeCognitionRefs | 当前 Goal / Commitment / OpenLoop 的来源引用 |
| channelLimits / resultLimit / maximumBytes | 正整数且受宿主上限约束 |
| sourceBundleHash / indexVersion | 绑定可验证的目标前缀与索引算法，不绑定未来资料 |

Plan 不接收任意 WHERE、SQL、脚本、角色切换或自由表名。暂不新增 Claim/关系强度推断器。没有合法结构线索时，对应通道为空。

### 6.2 策略选择与兼容

拟议策略标识为 `multi-channel-stable/v1`。策略必须经 Manifest 或其锁定的 Registry/Profile 显式选择；Host 配置不能悄悄改变已激活世界行为。M1 冻结最终 Manifest/Pack 版本增量，旧格式缺少新字段时保持旧策略，不自动升级。

单纯新排名即可改变模型输入，因此不以“派生数据”为理由免除版本锁。Kernel 如需联动，只改 Manifest 校验与能力锁定，不改变 Rulebook 或 Round 排序。

### 6.3 新 Recall Receipt

新增 Receipt 版本，至少保存 Plan Hash、精确结果与排名 Hash、策略/Profile/索引版本、选中来源、各通道 rank、最终 rank、裁剪原因和前缀验证身份。排名分值使用 safe integer；精确融合比较可用中间 BigInt，但序列化不得写 BigInt 或浮点数。

排除理由区分 `no_match`、`channel_limit`、`duplicate_source`、`result_limit`、`byte_budget`；来源完整性错误走既有错误流程，不能仅记录一个 exclusion 后当健康结果继续。解释界面只面向当前授权主体，不暴露其他角色候选数或秘密命中存在性。

Receipt 身份覆盖 Plan 的语义输入；相同身份对应不同结果必须拒绝。普通当前查询与精确历史重放分离：历史调用读已保存结果并验证其来源，不能针对最新索引重跑同一计划后覆盖。活动 watermark 可前进，但不能改变已冻结历史 Receipt 的 Hash。

## 7. 多路召回算法

### 7.1 候选生成

| 通道 | 候选依据 | 首轮上限建议 |
|---|---|---:|
| text | 锁版本分词后的授权 Memory 文本匹配 | 32 |
| entity | 授权来源中的结构化实体 ID 与显式已知别名 | 32 |
| open_work | active Goal / Commitment / OpenLoop 的 basisRefs 与其实体关联来源 | 16 |

首轮 Profile 建议最终 10 条；最大文本字节预算在 M1 与现有 Context Profile 联合冻结。超出安全上限的 Plan 在执行前拒绝。

文本规范化先保留旧 v1 路径不变；新策略以独立 tokenizer 版本定义中文与拉丁文本行为，使用固定 Fixture 验证。不得直接把“空白切分后 AND”改为 OR 却继续标识旧算法。

实体索引只抽取结构化授权来源；对白中的名字只有匹配该角色已知别名映射时才能建立关联。无依据的别名不做全局消歧。未完成事项作为查找线索，其当前状态继续单独注入 Context，不复制为 capture row。

### 7.2 排序与统计范围

新策略所有统计必须限定到当前 namespace 与 as-of 前缀。FTS MATCH 的 WHERE 隔离不自动证明 BM25 的语料统计隔离：M1 必须通过“加入其他角色或未来文本，既有计划排名不变”的 canary 检查。若数据库原生 BM25 无法满足，保留 FTS 作为匹配器，使用前缀范围内的确定性统计排序；不得用全库统计进入新策略结果。

候选必须在通道 LIMIT 前按版本化全序截断。与 Hash 相关文本排序使用 `compareWorldText`，不得直接依赖 SQLite BINARY 或 localeCompare；否则取回 LIMIT 后再排序不足以修复边界选择差异。

首轮融合建议采用等权 Reciprocal Rank Fusion：每个通道从 1 起排名，常数 k=60，按各通道 `1/(60+rank)` 之和比较。用精确整数有理数比较或固定的版本化整数算法，Receipt 保存通道 rank，避免跨平台浮点序列化差异。

优先保留最多 2 个合法 open_work 来源名额，其余位置按融合顺序填充；不足则归还名额。最终同分按 sourceSeq 降序、memoryId 的 compareWorldText 顺序决定。该策略常数和配额一并进入 Profile Hash；M1 可用数据调整拟议值，但正式版本冻结后不能静默调整。

### 7.3 去重与最终消费

先按 sourceKind/sourceId/sourceSeq/sourceHash 去重，合并通道命中依据；不能把不同角色的同文消息合并成共同记忆。语义近似去重不纳入首轮，避免删掉相互矛盾证据。

Agents 继续负责最终 Context 容量。被裁掉的候选不得进入 `includedSourceRefs`，Reflection 不能引用仅命中而未实际提供给模型的原文。短摘录只授权模型可见的来源表达，不能利用未展开正文作隐含依据。展示与引用粒度须在 M1 的 Context 契约中明确绑定。

## 8. 经历分组与快慢路径

### 8.1 Episode Index

新增版本化派生索引，语义字段包括 episodeId、address、characterId、sourceRefs、sourceStartSeq、sourceEndSeq、entityRefs、groupingAlgorithmId 与 groupHash。身份由原始来源与算法派生，不使用随机时间。

M3 首轮按授权 Observation 的已提交 Round 关联和角色可见 Scene 边界组织；可用 Cycle 关联增强，但不要求必须存在 Cycle。不会推断隐藏 wave、未感知参与者或其他角色离场。具体分组算法在独立 Golden 中冻结；不得只因后台 Worker 批次不同得到不同 episodeId。

分组必须可以在请求 as-of 下重建，不能向历史查询返回包含未来 sourceRef 的当前 Episode。暂不增加自由文本叙事摘要；展示可引用既有 L1 或授权原文摘录。多个 Round 合成一段自然语言总结属于后续算法演进，不在本规格内。

### 8.2 执行与恢复

```text
World commit + durable cognitive job
  -> required capture / verification / watermark
  -> next participant Context

verified sources
  -> optional durable episode-index job
  -> index version + completed receipt
  -> later explicitly bound Recall Plan
```

必要 capture 不能等 Cycle 结束。optional job 失败可重试且不阻塞当前 Round；相同 source prefix / algorithm / namespace 幂等。新策略若依赖该索引，则 dispatch 前有界补齐并冻结版本，未就绪遵循确定性可用性策略；不能按机器快慢随机使用新索引或旧索引。

策略结果一旦耐久冻结，索引后续更新不改变本次调用。COMMIT 后 Job receipt 前终止通过耐久唯一键对账，不以进程内标记判定完成。

## 9. 数据、迁移、fork 与备份

M0 不新增 DDL。M2 / M3 若需要新表，建议按以下逻辑所有权设计，物理名称与 schemaVersion 在迁移提交时冻结：

| 数据 | 所有者 | 恢复规则 |
|---|---|---|
| entity-source mapping | MemoryStore | 授权 World 前缀确定性重建 |
| tokenizer / prefix statistics | MemoryStore | 按算法与目标前缀重建，不混用其他 namespace |
| episode membership / index jobs | MemoryStore | 唯一键幂等恢复，分组不依赖执行批次 |
| v2 plan / receipt / exact selected result | MemoryStore 或既有耐久 Context 边界的明确单一所有者 | M1 冻结所有权，保持历史精确输入 |
| Context included refs / ProviderRequest | 既有 Context 数据库 | 继续现有 append-once 与恢复集合契约 |

不得在两个数据库各自维护可改写的同一权威 Receipt。跨库只引用身份、Hash、水位，不建立分布式事务假象。M1 必须选择上表 Receipt 的单一所有者并补充 DDL、事务和恢复状态表，不能把该选择留给两个实现者分别决定。

新数据库版本严格 migration，未知版本拒绝打开；旧索引与旧 Receipt 不被新算法覆盖。fork 使用 forkSeq 授权来源构建子 namespace；不复制父当前统计。部署备份沿用 ADR-0081 的恢复集合，检查新增 Memory / Context 关联。

新策略停用应通过版本化配置/Manifest 演进恢复旧策略选择；不要求旧二进制打开新 Schema。真正回滚使用兼容备份与二进制集合。导出若只含世界权威，应明确它能重建派生视图，却不等价于恢复全部精确 Provider 历史；不得补造缺失调用结果。

## 10. 实施工作项与阶段门槛

| ID | 工作项 | 主要文件范围 | 完成证据 |
|---|---|---|---|
| M0.1 | 固定旧版公开 API、Golden、调用点与事务边界 | memory / application | 兼容矩阵 |
| M0.2 | 抽出 Repository、Verifier、旧 FTS Strategy | memory | 行为与字节等价测试 |
| M0.3 | Service 门面依赖收窄，保留默认构造和导出 | memory / application | 正式 Application 集成 |
| M1.1 | 固定 100 / 1,000 / 10,000 Round 数据集 | tests | 数据与 Query Hash |
| M1.2 | 记录命中、包含、字节、耗时与扫描量基线 | tests / docs | 可复跑报告 |
| M1.3 | 新 ADR、Plan/Profile/Receipt/Manifest、预算与 DDL 收敛 | contracts / docs | 精确字段、拒绝规则、Golden |
| M2.1 | 授权线索与实体索引 | memory | 别名、私语与未来 canary |
| M2.2 | 三通道融合、配额、去重 | memory | 稳定排名与质量差分 |
| M2.3 | 新 Receipt、历史结果读取与 Context 消费 | agents / application / memory | 相同请求可重建 |
| M3.1 | Episode 分组与幂等索引任务 | memory | as-of / 批次独立 / 崩溃测试 |
| M3.2 | 摘录与展开预算、来源精确包含 | agents / contracts | Reflection basis 不扩权 |
| M4.1 | migration、fork、backup、import 兼容 | operations / tests | 跨版本与恢复矩阵 |
| M4.2 | 完整 check 与长历史报告 | tests / docs | 逐文件覆盖率及故障证据 |

M0 通过前不启用新策略；M1.3 通过前不编写依赖未定义 Schema 的生产逻辑。该顺序用于使提交可审查，不要求用户逐项重新授权。每阶段报告实际完成项与未关闭项，不用更新 Golden 掩盖语义变化。

## 11. 评测与验收

### 11.1 固定数据与指标

Fixture 使用 Scripted / Rule 路径和正式 World 提交生成，包含多角色、私语、分场、信念修正、承诺完成与 fork。100 / 1,000 / 10,000 Round 三档使用固定种子和内容 Hash；另为每档记录实际 Observation 和 Memory 数，避免只比较 Round 数。

| 指标 | 定义 | 拟议门槛 |
|---|---|---|
| 强制案例来源命中 | 每个指定场景至少一个预标注必要来源进入最终 Recall | 100% |
| Context 证据包含 | 必需来源在既定预算下进入实际模型输入 | 强制案例 100% |
| Recall@10 | 前十条包含的相关来源数 / 全部标注相关来源数；逐查询计算后宏平均 | 扩展集较旧策略不下降 |
| 权限与未来泄漏 | 所有结果、排名、Hash 和解释中的未授权影响 | 0 |
| 可重建性 | restart / receipt replay 得到相同语义与请求 Hash | 全部通过 |
| 重复来源比例 | 重复 source identity / 选中来源总数 | 0；不同版本认知来源不算重复 |
| 字节预算 | 实际选中结果和 Context 字节 | 不超过冻结 Profile |

扩展集至少 60 个查询，覆盖三种通道与无命中负例，并划分调参集和保留集；期望答案以来源 ID 标注，不从待测算法输出反推。真实模型使用正确率作为后续实验单独报告，不阻塞本次离线门槛，也不以 Scripted 成功宣称真实模型质量。

性能至少报告 cold / warm p50、p95、峰值内存、读取行数、catch-up 与 recall 分项耗时。固定 Node、OS、硬件、数据 Hash，warm-up 后每档至少 30 次，同机交替测旧/新策略。拟议门槛为 warm recall p95 不超过旧策略的 1.5 倍，且单次无新增来源的查询不重新全量 capture / summary；M1 冻结绝对延迟和增长阈值后才能宣布 M4 性能通过。

### 11.2 必测场景

| ID | 场景 | 必须证明 |
|---|---|---|
| T-01 | 百轮后再次见到承诺对象 | 当前承诺与原始依据同时可见 |
| T-02 | 同一人物不同措辞出现 | 实体召回命中，不依赖原句完全匹配 |
| T-03 | 传闻与亲眼观察并存 | 保留不同 epistemicKind，不自动确认传闻 |
| T-04 | Claim 已修正 | 当前认知正确，旧经历仍带历史来源 |
| T-05 | 私语与隐藏实体别名 | 候选、计数、排名、解释均不泄漏 |
| T-06 | 父分支未来增加大量同词文本 | 子分支及历史计划结果不变 |
| T-07 | 别的角色追加语料 | 当前角色旧计划的排序与 Hash 不变 |
| T-08 | Recall 命中但 Context 超预算 | 未包含来源不能被 Reflection 引用 |
| T-09 | Index 后台不同批次与顺序 | 相同前缀产生相同分组和结果 |
| T-10 | 当前 stimulus 尚未提交 | 可形成授权查询，不进入长期来源 |
| T-11 | 空查询、无结构线索、未知策略 | 空结果有回执；未知策略拒绝 |
| T-12 | U+10000 / U+E000 排序及 LIMIT 边界 | Windows/Linux 选择与 Hash 相同 |

### 11.3 硬崩溃矩阵

已有 crash harness 必须扩展真实子进程终止窗口，不以普通异常替代：

| 窗口 | 恢复结果 |
|---|---|
| 新来源写入后、事务提交前 | 不留部分 mapping / watermark |
| capture COMMIT 后、job receipt 前 | 幂等补齐任务状态 |
| episode membership 写入后、提交前后 | 无半个分组；重复任务不重复条目 |
| Recall result / receipt 提交前后 | 无半个结果；已有身份不可改绑 |
| Recall 已提交、Context 未提交 | 复用冻结结果，来源前缀验证一致 |
| Context 已提交、Provider dispatch 前后 | 继续既有安全恢复与歧义不重发 |
| Memory migration 中途 | 原子回滚或完整升级，不静默修补 |

## 12. 验证命令与交付清单

生产实现最终必须从仓库根目录执行：

```powershell
corepack pnpm@11.7.0 check
```

阶段开发可先运行现有测试命令缩短反馈，但不能代替最终 check：

```powershell
corepack pnpm@11.7.0 test packages/memory/src
corepack pnpm@11.7.0 test:p8:performance
corepack pnpm@11.7.0 test:crash
```

交付包含：新 ADR 与索引、精确契约和 migration、逐文件四项 100% 覆盖、固定质量数据、基线/新策略差分、真实子进程故障结果、部署恢复说明、旧世界兼容证据。新增质量基准的命令应由 M1 提交正式 package script 后写入报告，本规格不声称该命令已存在。

## 13. Evidence → Finding → Path

| Evidence | 来源 | 观察 |
|---|---|---|
| E-001 | [Memory 包](../../packages/memory/package.json) | 存在独立包级边界 |
| E-002 | [Service](../../packages/memory/src/cognitive-context.ts) | 内部构造 Store 并形成固定 Recall Plan |
| E-003 | [Store](../../packages/memory/src/local-memory.ts) | 捕获、检索、回执与摘要集中 |
| E-004 | [契约](../../packages/contracts/src/memory-v2.ts) | 算法为 v1 literal，结果与 Receipt 已类型化 |
| E-005 | [Context](../../packages/agents/src/context-v2.ts) | 独立 Hash 验证与容量裁剪 |
| E-006 | ADR-0067 / 0068 / 0071 / 0081 | 来源、摘要、反思与恢复集合不可绕过 |

Finding F-001：E-001～E-003 支持包内职责拆分，不要求独立服务。Finding F-002：E-004～E-005 要求策略与消费契约一起版本化。Finding F-003：E-003、E-006 要求经历索引与权威认知分离，并保留精确历史结果。

Path P-001：固定基线 → 抽出旧策略 → 质量与契约门槛 → 多路召回 → 经历索引 → 完整恢复验收。每一步以前一步测试证据为输入，不把本文的目标叙述当作完成证据。
