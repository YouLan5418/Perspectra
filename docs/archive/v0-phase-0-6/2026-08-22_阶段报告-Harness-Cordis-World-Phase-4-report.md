# Harness / Cordis World V0 Phase 4 阶段报告

> 日期：2026-08-22
> 状态：本机 Phase 4 门槛通过
> 基线：`docs/spec/implementation-v0.2.md`
> 平台：Windows，Node 24.14.1，pnpm 11.7.0

## 1. 结论

Phase 4 已建立本地非权威 Memory 与认知派生边界。SQLite FTS5 Memory 按完整 WorldAddress 和 CharacterId 隔离，所有 capture/recall 都由本地 source mapping 与 as-of 防火墙约束；未来、跨 Branch、跨角色及 Session Summary 二次捕获全部 fail-closed。KnowledgeRule 和 `character.reflect` 只消费 CharacterView。Session Compaction 生成确定性摘要但保留全部原始 Session Event。TencentDB 继续默认禁用。

## 2. 交付面

| 单元 | 公共入口 | 已实现不变量 |
|---|---|---|
| Local Memory | `LocalMemoryStore.reconcile/capture/recall/forget` | 独立 namespace、来源闭包、FTS5、as-of、失效来源 fail-closed |
| Knowledge | `KnowledgeRule.derive` | 只从获授权 Observation 确定性生成 Claim Draft |
| Reflect | `CharacterReflectRule.resolve` | sourceRefs 必须存在于当前 CharacterView；Summary 禁止作为认知来源 |
| Session Compaction | `SessionCompactor.compact/readSummaries` | 连续来源范围、稳定 Hash、幂等、原始事件不删除 |
| External Memory | `TENCENTDB_MEMORY_ENABLED` | 固定为 `false`，无网络、凭证或外部依赖 |

## 3. Evidence

| ID | Evidence | 结果 |
|---|---|---|
| E-P4-001 | `corepack pnpm@11.7.0 check` | 退出码 0；类型、Lint、Coverage、P0～P4、Crash 全通过 |
| E-P4-002 | Coverage 汇总 | 1200/1200 statements、710/710 branches、245/245 functions、1028/1028 lines |
| E-P4-003 | `packages/memory/src/local-memory.test.ts` | capture/recall/forget/reconcile、namespace、source drift 与 as-of 矩阵通过 |
| E-P4-004 | `packages/memory/src/cognition.test.ts` | KnowledgeRule 与 reflect 的来源权限和非法输入验证通过 |
| E-P4-005 | `packages/store-sqlite/src/session-compaction.test.ts` | 摘要幂等、来源范围、数据库迁移与原始事件保留通过 |
| E-P4-006 | `tests/p4.integration.test.ts` | future、跨 Branch、跨角色和 Summary 二次捕获均被拒绝 |

## 4. Findings

| ID | Finding | Evidence |
|---|---|---|
| F-P4-001 | 外部检索不能承担“角色不知道未来”的安全责任；本地 source mapping 和 as-of 校验必须是强制闸门。 | E-P4-003、E-P4-006 |
| F-P4-002 | Memory namespace 必须同时绑定 tenant/world/branch/character；只按角色或世界隔离都会留下越界路径。 | E-P4-003、E-P4-006 |
| F-P4-003 | 来源内容或 seq 发生变化后，既有记忆必须在 recall 时失效，不能返回未经当前映射验证的旧文本。 | E-P4-003 |
| F-P4-004 | Session Summary 是展示上下文压缩产物，不是事实来源；禁止 Summary 形成 Claim 或再次 capture。 | E-P4-004、E-P4-006 |
| F-P4-005 | Compaction 不应成为数据删除的隐式入口；原始 Session Event 仍是审计和恢复依据。 | E-P4-005 |

## 5. Finding Paths

### 5.1 Memory as-of 防火墙

- target: 阻止未来、其他 Branch 或其他角色的信息进入 recall
- preconditions: CharacterView 已由权威 Projection 在明确 asOfWorldSeq 重建
- action: reconcile 当前来源映射；capture 校验 namespace、kind、id、seq、hash 与 as-of；recall 再次验证来源仍闭合
- evidence: E-P4-003、E-P4-006
- finding: F-P4-001、F-P4-002、F-P4-003
- verification: future、cross-character、cross-branch、missing、divergent 全部抛出 `MEMORY_SOURCE_UNVERIFIED` 或返回空结果
- residual_risks: FTS5 tokenizer 与排序只承诺本地 V0 确定性，不承诺跨 SQLite 大版本完全相同的相关度顺序

### 5.2 认知来源权限

- target: 防止模型或摘要凭空写入 KnowledgeClaim
- preconditions: 调用方只能取得单角色 CharacterView
- action: KnowledgeRule 仅遍历 Observation；reflect 对每个 sourceRef 在当前 View 中做成员检查
- evidence: E-P4-004、E-P4-006
- finding: F-P4-004
- verification: Summary、缺失来源、重复来源和空命题均被拒绝；合法来源生成确定性 `claim.upsert`
- residual_risks: Phase 4 没有语义真实性判断，只保证来源授权与可追踪性

### 5.3 Session Compaction

- target: 限制会话上下文增长，同时保留可验证来源
- preconditions: 指定范围内每个 delivery seq 都已有原始 Session Event
- action: 对连续 payload Hash、Observation ID 与 World Seq 边界生成稳定 contentHash 和 summaryId
- evidence: E-P4-005
- finding: F-P4-005
- verification: 同范围同内容幂等；范围缺口或已绑定分歧 fail-closed；压缩后原事件仍可读取
- residual_risks: Phase 5 才实现 Snapshot/Retention；当前不会清理任何源数据

## 6. 验收映射

| Phase 4 门槛 | 结果 | Evidence |
|---|---|---|
| 未来来源被拒绝 | 通过 | E-P4-003、E-P4-006 |
| 跨 Branch 来源被拒绝 | 通过 | E-P4-003、E-P4-006 |
| 跨角色来源被拒绝 | 通过 | E-P4-003、E-P4-006 |
| Summary 二次捕获被拒绝 | 通过 | E-P4-004、E-P4-006 |
| Session Compaction 不删除原事件 | 通过 | E-P4-005 |
| 每个生产文件四项覆盖率 100% | 通过 | E-P4-002 |

## 7. 未闭合门槛

TencentDB Memory 保持禁用，因为尚无固定审阅 commit、许可证结论与契约测试；这不影响本地 Memory。GitHub Actions 四组矩阵因没有远程仓库而未执行。Phase 5 的 Branch 管理、Admission Barrier、Snapshot/Retention、备份恢复、导入导出、本机运维接口、Health、Audit 与 Metrics 尚未实现。
