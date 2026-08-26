# ADR-0067：Cognitive Memory v2、World Pack v2 与旅途试金石

- 状态：Accepted
- 日期：2026-08-26
- Extends：ADR-0035、ADR-0052、ADR-0054、ADR-0059、ADR-0060、ADR-0061、ADR-0062、ADR-0063
- 上位契约：[Phase 8 实施规格 §9、§14～15](../spec/phase-8-implementation-v0.1.md#9-cognitive-memory-v2)

## 背景

Phase 7 Pack v1 已证明内容编译和初始认知隔离，但不能表达 Phase 8 的词汇、Scene v2、Checkpoint 和正式 Memory 水位。直接给 v1 增加字段会重复产生版本契约漂移。Memory 若接受调用方提供的 CharacterView 或自行选择 namespace，会再次打开伪造来源、future 和跨角色通道。悬疑与酒馆也不足以单独覆盖多 Scene 和复杂主观状态。

## 决定

1. `worldpack-source/v1` 与 compiled `worldpack/v1` 永久冻结。Phase 8 新内容使用显式 `worldpack-source/v2`、compiled `worldpack/v2`、`worldpack-compiler/v2` 和 Manifest schemaVersion 4；不隐式 upcast 已激活 v1 世界。
2. Source 根文件继续是 `worldpack.source.json`，显式列出所有文件。v2 增加 cognitionFiles、memoryFiles、documentFiles；仍禁止 glob、目录逃逸、符号链接、大小写碰撞、Secret、endpoint、脚本和任意 Event/Rule。
3. 角色 Cognition、Memory 和 Documents 全部可选。省略表示没有已声明状态，不生成平均人格。创作者使用稳定 local key，Compiler 生成品牌 ID、Genesis source、seq 和 Hash；安全默认值物化并进入 packHash。
4. Documents 必须声明 public、director_visible、character_private 或 author_only。长背景若需要召回，Compiler 生成指定角色的 Genesis Observation，再经正式 cognitive job 捕获；Pack 不能直接写 Memory row。
5. World Commit 在同一事务中为受影响角色写耐久 cognitive job。Worker 只接受 address、characterId、asOfSeq，自行从 WorldStore 重建/验证 CharacterView 和 Source Mapping，禁止信任调用方提供的 View。
6. Phase 8 Memory 只捕获 episodic Observation、communication Observation、SubjectiveClaim belief 和 CharacterGoal intention。其他心理状态由当前 Projection/Checkpoint 承担，不复制为另一套事实源。
7. 每个 tenant/world/branch/character 独立维护 verified/captured watermark、memoryEpoch 和 sourceMapHash。Provider 调用前必须追平到 required as-of；普通 catch-up 失败降级参与者，跨角色/Branch/future/hash 分歧为完整性故障。
8. Recall namespace 由 Host 固定，模型没有搜索工具。L1 只允许确定性提取式、单层、来源完整的 Summary；不做 summary-of-summary，不再次捕获，不删除 L0/World Source。
9. Phase 8 维护一个仅由内容文件构成的“雨夜同行”Pack，使用 Core speak/move/take/reflect 和 Scene/Memory 验证错误认知、关系侧面、矛盾心理、私语、分场/合流、fork、缓存和降级。禁止旅行专用 Resolver、角色名分支或硬编码关系加减分。
10. Scripted Provider 输出属于 Testkit Fixture，不进入 Pack Manifest、Genesis、Agent Context 或世界规则。`worldpack test` 必须使用临时 SQLite 和正式 Application 路径实际运行 assertions。

## 后果

- Pack v1 兼容字节不受影响，v2 能显式锁定 Phase 8 全部新契约。
- Memory 的来源、作用域和水位由世界权威闭包决定，不能由 Agent 或 Pack 扩权。
- 派生 Memory/Checkpoint 损坏可以从 World 前缀重建；跨作用域泄漏会停止 Agent 调用而不是继续使用可疑数据。
- “雨夜同行”证明新能力是通用角色世界能力，不是悬疑或旅行产品方向。

## 验证

- v1 source/compiled/Manifest Golden 全等；v2 source 顺序、CRLF/LF 和 Windows/Linux 产生相同 pack/manifest/genesis bytes/hash。
- cognition/document 引用、循环、受众、未知字段、超限和未注册 Profile 全部 fail-closed。
- Memory 写入后/Job complete 前硬终止可幂等恢复，水位不倒退；future/branch/character/source divergence canary 全部拒绝。
- Alice、Bob、玩家对同一查询得到不同来源链，reported speech 不升级为真值。
- 旅途 Pack 在 restart、fork、同键重放、Scene 变化、Checkpoint 重建和降级后保持相同 Authority/Context 不变量。
