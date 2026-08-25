# ADR-0060：内容包 Manifest 来源绑定与 Genesis 接入

- 状态：Accepted
- 日期：2026-08-25
- Extends：ADR-0026、ADR-0033、ADR-0035、ADR-0054、ADR-0055
- Supersedes：Phase 7 规格中“完全不修改 Kernel”这一字面限制；不改变“题材语义不得进入 Kernel”的产品边界
- 上位契约：[Phase 7 实施规格 §4～5](../spec/phase-7-implementation-v0.2.md#4-最小-world-pack)

## 背景

`worldpack/v1` 已能确定性编译内容来源，但既有 Manifest v2 只记录世界拓扑和运行 Profile。若仅把 Pack 的秘密、错误认知和 Goal 写成 Genesis Event，重启与 fork 虽能重建结果，运行时却无法证明这些初始内容来自哪个 `packId + packVersion + packHash`，portrayal 和初始 lifecycle 也没有冻结位置。

## 决定

1. 旧 WorldSpec v1/v2、Manifest v1/v2、Event、Genesis 和 Hash 字节保持不变；`WorldSpecCompiler` 继续只产生 Manifest v2。
2. 仅由已验证 `worldpack/v1` 产物生成 Manifest v3。v3 完整保留 v2 的执行字段，并增加不可变 `contentPack` 来源绑定与带 portrayal/lifecycle 的 Character 记录。
3. `contentPack` 锁定 pack identity、Compiler identity、Core plugin locks、Presentation profile 和 author initial facts；运行时只读取 compiled Pack/Manifest，不重读 source 目录。
4. Pack 的初始 Observation、Claim、Goal 与 Secret audience 分别编译为现有 `observation.upsert`、`claim.upsert`、`goal.upsert` Genesis Event，并携带 pack/source 引用。非 active 初始生命周期使用既有 `character.lifecycle-changed` Event 表达。
5. Pack 内容不直接写 Projection 或 Memory。Projection 继续从 Event 重建；Memory 继续只 capture 已提交且属于该角色的 Observation、Claim 和 Goal。
6. Manifest v3 不增加酒馆、悬疑、心理或题材规则；Kernel 只识别来源绑定这一通用执行契约。缺失、畸形或 Hash 不一致均 fail-closed。

## 后果

- 世界数据库可独立证明自身由哪个不可变 Pack 创建，重启、fork 与恢复不依赖创作者 source 目录。
- Secret audience、错误认知和 Goal 继续使用同一角色/Branch/as-of 隔离机制，不建立第二事实源。
- 这是一次持久格式扩展，因此需要新增兼容测试；它不是把内容玩法写进 Kernel。

## 验证

- v1/v2 Manifest Golden 与既有测试原样通过；v3 Manifest 的 pack identity 与 Hash 可在重启后读取。
- 初始 Observation、Claim、Goal、Secret 和 lifecycle 经 Genesis 进入 CharacterView 与 Local Memory。
- fork 子分支只继承 forkSeq 前缀，父分支 future Claim/Memory canary 不泄漏。
- Manifest v3 的 contentPack 缺失、畸形或 Event Registry 不闭合时拒绝挂载/提交。
