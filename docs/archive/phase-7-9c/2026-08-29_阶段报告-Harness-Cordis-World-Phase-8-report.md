# Harness / Cordis World Phase 8 完成与 0.3.0 候选报告

> 当前结论：**Phase 8 的三个阶段门已在本机全部通过，代码可作为私有源码 `0.3.0` 候选提交远程矩阵验证。** 本报告不是 GitHub CI 或 Tag 证据；推送、远程四格 CI 和 annotated Tag 仍需用户执行或授权。

## 1. 报告信息

| 项目 | 内容 |
| --- | --- |
| 报告日期 | 2026-08-29 |
| 冻结发布基线 | `v0.2.0`，提交 `08c9a5f` |
| Phase 8 规格 | `phase8/v0.1` |
| 候选版本 | `0.3.0`，私有源码、stdio only |
| 实现范围 | P8.1～P8.12 |
| 本机环境 | Windows、Node.js 24.14.1、pnpm 11.7.0 |
| 外部集成 | Harness Bridge、TencentDB、真实模型 API 均保持禁用 |
| 远程状态 | 尚未推送本轮提交；Phase 8 四格 CI 与 `v0.3.0` Tag 尚不存在 |

## 2. 最终结论

Phase 8 回答了规格中的核心问题：创作者可以通过严格的 v2 Pack 描述多个角色彼此独立的认知、关系、情绪、矛盾、目标和 Scene；运行时可以在任意合法水位，从耐久 World Event、Memory 来源、Checkpoint、Tail 和 Context Receipt 精确重建某个 Agent 实际收到的输入。

实现没有把心理状态变成通用心理公式，也没有让模型直接写世界事实。Reflection 仍是受限 Proposal；World Event Log 仍是世界事实唯一权威；Memory、Checkpoint、Provider Call 与质量账本只保存可验证的派生、输入或调用证据。

非悬疑“雨夜同行”六轮 Fixture 已闭合公开对白、私语、角色离场、重新会合、转述、拿取车票、移动到下一 Scene、关系 Reflection、Memory 隔离、fork、restart、缓存前缀和降级恢复。悬疑和酒馆继续作为旧能力回归，题材规则没有进入 Kernel。

## 3. 三道阶段门

| 阶段门 | 单元 | 结果 | 主要证据 |
| --- | --- | --- | --- |
| 8A：权威结构 | P8.2～P8.5 | 通过 | Pack v2/Manifest v4、七类时态主观状态、Scene Decision v2、fork/as-of |
| 8B：可重建输入 | P8.6～P8.7 | 通过 | Cognitive Memory v2、唯一 L1 Summary、Checkpoint/Tail、Context/Renderer/Receipt、双 Hash |
| 8C：行为闭环 | P8.8～P8.11 | 通过 | Reflection/Policy、Provider 生命周期与质量退避、六轮参考 Pack、兼容与硬崩溃矩阵 |

P8.12 已补齐创作者手册、需求—测试矩阵、兼容表、本机验证与候选说明。收口检查还发现并修复了一个正式入口遗漏：`worldpack validate/test/compile/inspect/activate` 现在按显式 schema version 精确路由 v1/v2 Compiler；不会再把合法 v2 来源误送给 v1 解析器。

## 4. 已交付能力

### 4.1 World Pack v2 与版本边界

- `worldpack-source/v1`、compiled `worldpack/v1`、Manifest v1～v3、Context v1 和 Scene v1 保持原义。
- v2 来源显式编译为 compiled `worldpack/v2` 和 Manifest v4，锁定 Vocabulary、Registry、Context、Scene、Memory、Policy 与 Renderer 身份。
- v1/v2 Creator CLI 共用命令面，但只按来源或制品的显式 schema version 选择冻结 Compiler，不执行隐式升级。
- 编译继续执行严格 JSON、合法 Unicode、路径/符号链接/大小写边界、字节预算、引用、循环、容量和 Hash 校验。

“雨夜同行”当前 Golden：

| 产物 | Hash |
| --- | --- |
| Pack | `sha256:76098df56b8a9169861f5094159d41ee7d6ef26c018339c8017615eb4686e0b8` |
| Manifest | `sha256:897261604851697a116ac30c1fd10231d6c4ea84c5b6df8ee4edbf962e85c18c` |
| Genesis | `sha256:f013df53aae470d7cc2ee99a44c33d8ff6a326410272fb45d51f8764dd03cc69` |
| Assertion Plan | `sha256:542ded6195763f0727271dccd9bcc4b690a33341ee4520e15c488717a791cb28` |

### 4.2 可重建角色心智

- Subjective Claim、Character Goal、Relationship Attitude、Affect Episode、Inner Tension、Commitment 和 Open Loop 均可按 owner/branch/as-of 从事件前缀重建。
- trust/distrust、多 Affect 和矛盾 Tension Pole 可以并存；Kernel 只验证词汇、来源、状态转换、容量和权限。
- Reflection Batch 使用 optimistic state hash，必须引用获授权 Context source，整批先计算最终候选再原子接受或拒绝。
- 合法 Reflection 追加 `character.reflect@1` 与 Cognitive Policy Receipt；非法 Reflection 不产生部分认知事件，也不阻止同轮合法外部 Action。
- Provider 持续非法输出触发耐久退避或仅暂停 Reflection，合法 probe 可以恢复 ready；不会因此 quarantine 世界。

### 4.3 Memory、Checkpoint 与 Context

- Cognitive Job 随 World Commit 耐久入队，按角色和水位执行 capture/reconcile；写入后、Job complete 前崩溃不会重复 Memory。
- Recall 在建立候选前应用 tenant/world/branch/character/as-of 防火墙，并保存 plan、结果、来源和排除证据 Hash。
- L1 是唯一确定性提取式 Summary。Continuity Checkpoint 只引用其 identity/hash，不复制正文或维护第二套摘要算法。
- Character Context v2 按固定段落和预算选择 CharacterView、Scene、Checkpoint、Tail、Recall、候选 Action 与 Capability。
- Director Context 只读取 focal Scene 的 public/director-visible 来源和获授权粗粒度信号，不读取 private cognition、raw Memory、latent guidance 或 author truth。
- `contextHash` 锁定语义选择；`providerRequestHash` 锁定精确消息、Renderer、Tool、Model/采样和 Provider 分区。transport trace 与 cache hit 不改变两者。

### 4.4 Provider 边界与崩溃语义

- Scripted Provider 也必须经过 Context Receipt、prepared intent、dispatch_started、append-once result、Authority 和 World Commit。
- dispatch 前崩溃可安全重试；dispatch 后没有耐久终态时标为 ambiguous，不自动重发。
- 系统只保证世界效果 at-most-once，不宣称外部 API 调用或计费 exactly-once。
- before-dispatch、after-dispatch、after-response、before-world-commit 与 Memory catch-up 的真实子进程硬终止均有恢复测试。

### 4.5 Scene v2 与通用移动

- Scene 生命周期、成员、观察边界和调度均来自耐久 Event；同一角色同时属于多个 active Scene 属于完整性故障。
- `scene_public`、`direct`、`private`、`self` 在每个 Action 的事件前缀上重新计算；私语旁观者只得到 occurrence-only 脱敏观察。
- Manifest v4 的已接受通用 `move` 通过 ADR-0072 的 Location 绑定策略，在同一 World Commit 追加离场、关闭、激活和加入事件。
- 同轮参与者冻结，动作后的 Scene 变化立即收窄观察范围，并从下一轮改变 Agent 调度。

## 5. 需求 → 测试证据

| 规格要求 | 正式测试或门槛 | 结果 |
| --- | --- | --- |
| v2 严格来源、确定性编译、Manifest v4 与 Genesis | `compiler-v2.test.ts`、`source-v2-schema.test.ts`、`cognition-schema.test.ts` | 通过 |
| v1/v2 Creator CLI 精确路由且可激活 | `creator-cli.test.ts` 的完整 v1 与 v2 工作流 | 通过 |
| 七类主观状态、owner/as-of/fork、畸形历史 fail-closed | `cognition-projection.test.ts` | 通过 |
| Scene lifecycle、零/一 focal、观察范围与通用 move | `scene-decision.test.ts`、`round-coordinator.test.ts` | 通过 |
| Cognitive Memory Job、水位、来源、Recall、L1 和隔离 | `cognitive-memory-v2.test.ts`、`cognitive-context.test.ts` | 通过 |
| Checkpoint 只引用唯一 L1、Tail 逐块重建、fork 截断 | `continuity.test.ts` | 通过 |
| Character/Director Context 最小权限、预算和 canary | `context-v2.test.ts`、`director-context.test.ts`、`context-pipeline.test.ts` | 通过 |
| 双 Hash、精确 Provider bytes 与缓存分区 | `provider-request.test.ts`、`context-receipt.test.ts` | 通过 |
| Reflection 整批验证、来源补入和确定性 Policy | `reflection.test.ts`、`submit-actions-v2.test.ts`、`cognition-projection.test.ts` | 通过 |
| Provider append-once 生命周期、恢复和质量退避 | `provider-call.test.ts`、`provider-quality.test.ts`、`round-coordinator.test.ts` | 通过 |
| 六轮非悬疑 E2E、隐私、Scene、Memory、fork、restart | `rainy-road-pack.test.ts` | 通过 |
| 缓存最长公共前缀和 Provider/Memory 降级恢复 | `rainy-road-pack.test.ts` | 通过 |
| 旧 Pack、悬疑、酒馆、P0～P6 兼容 | 全量 coverage suite 与 `test:p0`～`test:p6` | 通过 |
| 高风险 SQLite/Provider/Memory/Host 窗口硬终止 | `tests/crash.test.ts` | 23 项通过 |

测试 oracle 没有通过更新旧 Golden 接受不兼容漂移；v1/v2 编译格式、Context 版本和 Scene 版本仍显式分离。

## 6. 参考 Pack 验收

六轮 Fixture 固定执行：

1. 玩家公开追问，Alice 与 Bob 依据各自 Context 回应；
2. Bob 只向玩家解释帮助受伤陌生人的原因，Alice 不获得正文；
3. Bob 移到站台，离开 focal Scene；
4. 玩家与 Alice 继续互动，Bob 不被当前 Scene 调度；
5. 玩家向 Alice 转述 Bob 的解释，reported speech 不自动成为真值；
6. Alice 拿取车票并移动，三人进入站台 Scene，关系 Reflection 进入下一轮心智。

同库重放不会再次调用 Provider；restart 和 fork 保持 Event、Authority、Context 与 Memory 来源一致。Alice 与 Bob 的请求各自拥有稳定 Character 分支，同时共享只读 Host/World 前缀。缓存前缀变化只影响命中，不改变 Resolution 或权威 Hash。

降级 E2E 覆盖 `provider-timeout` 与 `memory-catchup-failure`：玩家 Round 仍提交并推进 Tick；失败参与者的 terminal、Health、Metric 和 Audit 准确；没有伪造对白或 Memory；同键重放不再次调用失败 Provider；恢复 ready 后下一轮重新参与。

## 7. 兼容与边界

| 项目 | Phase 8 结论 |
| --- | --- |
| World Event 权威 | 保持；认知与 Scene 均由 Event 前缀重建 |
| 模型权限 | 保持；Action/Reflection/Directive 只能是 Proposal |
| 角色隔离 | 保持；private、latent、future、跨 Branch/角色 canary 均被拒绝 |
| SQLite 原子性 | 保持；事务内不执行 Provider、Memory 或其他 await |
| v1 Pack/旧 Manifest | 原义和 Golden 保持，不隐式升级 |
| 悬疑玩法 | 仍属于 Demo Resolver，不进入 Core |
| 真实模型/API Key | 未接入，按路线推迟到 Phase 11 |
| Harness/TencentDB | 默认禁用，且不是权威来源 |
| 网络 | stdio only，无 HTTP/TCP/Socket 监听 |
| 发布 | 私有源码，不发布 npm |

## 8. 本机验证

在所有 Phase 8 实现及 Creator CLI v2 接线后运行：

```powershell
$env:CI = 'true'
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 test
corepack pnpm@11.7.0 worldpack validate examples/world-packs/rainy-road-companions
corepack pnpm@11.7.0 worldpack test examples/world-packs/rainy-road-companions
```

| 门槛 | 结果 |
| --- | --- |
| TypeScript typecheck | 通过 |
| Oxlint | 通过 |
| V8 per-file coverage | 68 个文件、677 个测试；statements/branches/functions/lines 均 100% |
| 完整测试集 | 69 个文件、700 个测试通过 |
| P0～P6 集成门槛 | 全部通过 |
| Crash Harness | 23 项真实子进程硬终止测试通过 |
| v2 Creator CLI | validate/test/compile/inspect/activate 与重复激活通过 |

GitHub Actions 已配置 Windows/Ubuntu × Node 22.19/24 的 clean install 与完整 `pnpm check`，但本报告形成时尚未推送 Phase 8 提交，因此不能把配置存在当作远程 CI 已通过。

## 9. 0.3.0 候选与后续动作

`0.3.0` 候选的本地范围是：Phase 8 规格 P8.1～P8.12、ADR-0064～0072、World Pack v2、可重建认知/Memory/Context、Provider 权威边界和“雨夜同行”验收。它不包含真实 API Key、Runtime Author、Agent 接管玩家、第三方插件、HTTPS 或远程服务。

形成远程发布基线仍需：

1. 将本地 `main` 推送到私有 GitHub 远程；
2. 确认 `V0 gates` 的 Windows/Ubuntu × Node 22.19/24 四格全部通过；
3. 把 Run URL、Run 编号和最终提交写回发布证据；
4. 经用户明确确认后，在该全绿提交创建并推送 annotated `v0.3.0` Tag。

未完成以上步骤前，项目只能称为“本机 `0.3.0` 候选”，不能称为已发布 `v0.3.0`。

## 10. 下一阶段边界

Phase 8 完成后，最有价值的下一步不是继续增加题材玩法，而是先独立审查本候选，再按通用内容总纲进入 Phase 9 的创作者语义与受信任扩展设计。真实 Provider/API Key 仍应等待 Phase 11；在此之前不要把 endpoint、credential 或自由 Prompt 偷塞进 Pack。

## 11. Evidence → Finding → Path

### Evidence

| ID | 不可变观察 | 复现方式 |
| --- | --- | --- |
| E-001 | v2 Creator CLI 返回固定 Pack/Manifest/Genesis/Assertion Hash | 运行 §8 的两条 `worldpack` 命令 |
| E-002 | 覆盖率四项逐文件 100%，P0～P6 与 23 项 crash 通过 | `corepack pnpm@11.7.0 check` |
| E-003 | 全量 69 个文件、700 个测试通过 | `corepack pnpm@11.7.0 test` |
| E-004 | 六轮参考 Pack 包含 Scene、Memory、Reflection、fork、缓存与降级证据 | `rainy-road-pack.test.ts` |
| E-005 | 本地分支尚无 Phase 8 远程四格 CI 或 Tag 证据 | `git status -sb`、GitHub Actions |

### Findings

| ID | 结论 | 状态 | 证据 |
| --- | --- | --- | --- |
| F-001 | Phase 8 三道本地阶段门全部完成 | validated | E-001～E-004 |
| F-002 | Creator CLI 的 v2 正式路径已闭合，不再仅能由测试直接调用 Compiler | validated | E-001 |
| F-003 | 当前可以形成私有源码 `0.3.0` 本机候选，但还不能创建发布 Tag | validated | E-002、E-003、E-005 |

### Path

```text
Phase 8 本机候选
  → 独立只读审查（建议）
  → 推送 main
  → GitHub 四格 CI 全绿
  → 写回远程证据
  → 用户确认
  → annotated v0.3.0 Tag
```

## 12. 最终判断

Phase 8 没有把“雨夜同行”变成产品方向。它继续把题材当作试金石，用一个不含调查规则的场景证明：角色知道什么、记住什么、相信什么、在什么 Scene 观察到什么，以及 Agent 最终收到什么输入，都能在重启、fork、缓存和降级后由耐久证据精确解释。

因此，当前最准确的项目状态是：**Phase 8 功能和本地质量门槛已完成，私有源码 `0.3.0` 候选成立；远程 CI 与 Tag 尚待用户推进。**
