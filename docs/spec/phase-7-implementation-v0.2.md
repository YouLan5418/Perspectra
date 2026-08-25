# Harness / Cordis World Phase 7 实施规格：最小通用内容闭环

- 状态：Accepted implementation target
- 规格版本：`phase7/v0.2`
- 日期：2026-08-25
- 基线：私有源码 `v0.1.0`
- 目标候选版本：`0.2.0`
- 架构总纲：[通用内容与真实运行架构总纲](general-content-architecture-v0.1.md)
- 主要 ADR：[ADR-0054](../adr/ADR-0054-world-pack-source-compiler-versioning.md)、[ADR-0055](../adr/ADR-0055-character-cognition-affect-goal.md)、[ADR-0059](../adr/ADR-0059-agent-participation-memory-provider.md)

> Phase 7 只证明“无需修改 Kernel，即可用通用 Pack 创建并持续运行一个具有独立角色知识与 Memory 的非悬疑酒馆世界”。架构总纲中的 Scene v2、动态复杂心理、CharacterTemplate、Runtime Author、Agent 接管玩家和真实 Harness Provider 均不属于本阶段完成门槛。

## 1. 完成定义

Phase 7 完成时，一个创作者必须能够：

1. 从显式来源目录编译一个不可变、可哈希的 World Pack；
2. 定义酒馆中的角色、地点、单一 active Scene、初始 Observation、Claim、Goal 和 portrayal；
3. 不修改 Kernel、Store 或 Application，激活并连续运行这个 Pack；
4. 使用普通文本、`/move` 和 `/take` 与同一持久 World 交互；
5. 证明不同角色对同一事件拥有不同 CharacterView 和 Memory recall；
6. 在重启、fork 和同键重放后保持相同权威 Hash 与认知隔离；
7. 继续让悬疑 v3/v4 回归全部通过，但不新增调查玩法。

Phase 7 只回答这一问题：

> 创作者能否仅修改内容文件，做出一个可连续运行、角色认知互相隔离的非悬疑世界？

任何不能直接支持这个问题的能力均推迟。

## 2. 本阶段范围

### 2.1 必须实现

| 单元 | Phase 7 交付 |
|---|---|
| Pack | `worldpack-source/v1` 最小来源目录、严格加载、诊断、默认值物化、compiled `worldpack/v1` envelope 与 packHash |
| Character | unique CharacterDefinition；identity、初始 location/lifecycle、Observation、Claim、Goal、portrayal |
| Secret | 权威命题加 `initialAudience`，编译为每角色独立 source-linked Claim |
| Scene | 复用现有单 focal active Scene policy，不新增多 Scene Projection 或 transition policy |
| Action | Core `speak`、`move`、`take`；普通文本和显式命令走既有 Validator/Rulebook/Authority |
| Memory | 复用现有 Local Memory、durable cognitive job、as-of 防火墙和 Context 路径，增加 Pack 初始认知接入 |
| Presentation | 一个固定版本的确定性纯文本 profile，只呈现玩家授权内容 |
| CLI | `init`、`validate`、`compile`、`inspect`、`test`、`activate` 与连续 stdio shell 的最小可用子集 |
| Reference | 一个“酒馆社交”Pack和 acceptance assertions；悬疑 Demo 只作回归 |

### 2.2 明确推迟

| 能力 | 计划阶段 | Phase 7 行为 |
|---|---:|---|
| 多 active Scene、SceneDefinition/Instance 动态转换 | 8 | 编译器拒绝 v2 policy |
| 动态 Affect、InnerTension、Objective policy | 8 | 来源 Schema 不开放这些字段 |
| CharacterTemplate、运行中实例化 | 9 | 每个角色必须是 unique、Genesis 固定实例 |
| 第三方题材插件、Action alias、Runtime Author | 9 | 只允许 Host 内建 Core 精确锁 |
| agent-controlled Player、Observer、`core:wait` | 10 | PlayerSlot 固定 manual |
| 完整 participation policy | 10 | 使用现有静态/Scene eligibility |
| 真实 Harness Provider、模型 L1 summary | 11 | Scripted/Rule/Noop；Bridge 保持禁用 |
| 旅途同行 Pack | 8 | 不进入本阶段验收 |

“推迟”表示相应 ADR 的方向继续有效，但 Phase 7 不应创建半成品表、空 RPC 或不可运行的预留入口。

## 3. 不变量与兼容边界

- World Event Log 继续是唯一世界事实权威；Pack 只生成 Manifest/Genesis，不是运行时第二事实源。
- 模型输出只为 Proposal；本阶段不需要真实模型即可完成全部验收。
- Pack 不包含脚本、函数、网络端点、Secret、外部路径或任意 Event/Rule 定义。
- 未注册 Rulebook/Context/Scene/Presentation 精确版本必须 fail-closed，禁止默认回退。
- `v0.1.0` Tag、既有 Manifest、Event、Authority、Golden 和 v3/v4 悬疑 Resolution 原字节不变。
- Local Memory 不能反写世界事实，recall 继续执行角色、Branch、source mapping 和 as-of 隔离。
- Phase 7 不引入新的真实时钟语义，仍只使用 `TURN_DRIVEN`。
- stdio only、private packages、Harness/TencentDB disabled 等 V0 发布边界保持不变。

## 4. 最小 World Pack

### 4.1 来源结构

Phase 7 接受以下最小目录：

```text
tavern-social/
├── worldpack.source.json
├── world.json
├── characters.json
├── locations.json
├── scenes.json
├── player-slots.json
├── presentation.json
├── text/
│   └── opening.zh-CN.md
└── assertions/
    └── cognition-isolation.json
```

根清单必须显式列出每个文件：

```json
{
  "sourceSchemaVersion": "worldpack-source/v1",
  "packId": "pack:tavern-social",
  "packVersion": "1.0.0",
  "worldFile": "world.json",
  "characterFiles": ["characters.json"],
  "locationFiles": ["locations.json"],
  "sceneFiles": ["scenes.json"],
  "playerSlotFiles": ["player-slots.json"],
  "presentationFiles": ["presentation.json"],
  "markdownFiles": ["text/opening.zh-CN.md"],
  "assetFiles": [],
  "assertionFiles": ["assertions/cognition-isolation.json"]
}
```

Phase 7 沿用总纲的路径、Unicode、文件数和大小限制。文件无隐式发现；未列出的文件不参与编译和 Hash。acceptance assertion 只进入 Testkit plan，不进入 Manifest、Genesis、Context 或 World Hash。

### 4.2 编译产物

`WorldPackCompiler.compile` 固定执行：

1. 解析根清单与安全相对路径；
2. 读取严格 JSON/UTF-8 Markdown；
3. 执行精确 Schema、未知字段、唯一 ID 和引用校验；
4. 验证只使用 Phase 7 allowlist 中的 Core profile；
5. 物化全部默认值并稳定排序；
6. 生成 canonical `worldpack/v1` envelope 和 packHash；
7. 适配既有 WorldSpecCompiler；
8. 输出 CompiledWorldManifest、GenesisPlan 和 acceptance plan。

同 `packId + packVersion` 异 packHash 返回 `PACK_VERSION_DIVERGED`。激活后的 World 只读取 compiled envelope/Manifest，不读取 source 目录。

Phase 7 allowlist 只包含已有 Core Rulebook、当前 Scene Decision、现有 Agent Context/Memory 路径和确定性 Presentation。Pack 可引用这些精确 id/version/hash，但不能声明新插件。

### 4.3 诊断

所有 Compiler 诊断包含：

```typescript
interface WorldPackDiagnostic {
  severity: "error" | "warning";
  code: string;
  file: string;
  jsonPointer: string;
  message: string;
  suggestion?: string;
}
```

Error 阻止产物生成；Warning 不改变产物语义或 Hash。`format` 只做语法与稳定排序，不进行语义修复。

## 5. 最小角色模型

Phase 7 的 Character 来源结构只开放：

```typescript
interface Phase7CharacterSource {
  characterId: string;
  displayName: string;
  pronouns?: string;
  initialLocationId: string;
  lifecycle?: "active" | "incapacitated" | "dead" | "departed";
  portrayal?: {
    summary?: string;
    speakingStyle?: string;
    backgroundTextRef?: string;
  };
  initialObservations?: InitialObservationSource[];
  initialClaims?: InitialClaimSource[];
  initialGoals?: InitialGoalSource[];
}
```

默认值为 lifecycle=`active`、空 portrayal、空 Observation/Claim/Goal、Agent disabled。自由 portrayal 不能声明 capability、Rule、Secret 或系统权限。

Goal 在 Phase 7 只支持初始 `active` Goal、priority、visibility 和 source refs；不实现动态 completion policy、父子传播或 Objective。关系使用已注册 proposition 的 Claim 表达，不引入通用 trust/affection 数值。

Secret 作者语法编译为权威 Genesis 命题与 audience 的独立 Claim。未知角色没有该 Claim；错误认知使用带 source 的普通 Claim。角色说出命题只产生“该角色说过该内容”的 Observation/Memory，不自动证明命题。

结构化 Affect、InnerTension 和 CharacterTemplate 在 Phase 7 Schema 中返回 `PACK_SOURCE_INVALID`，避免仅存字段却没有完整 Projection/Context/重放语义。它们的正式结构由 ADR-0055 保留到 Phase 8/9。

## 6. Scene 与参与者

Phase 7 只允许一个 active focal Scene，复用当前 Scene Decision 和生命周期/位置/availability 过滤：

- 玩家角色必须属于该 Scene；
- NPC 只有位于该 Scene、lifecycle active 且 runtime available 时才可参与；
- Observation 仍按当前可见性与 CharacterView 边界生成；
- 不允许运行时创建 Scene、多个 active Scene、自动 transition 或后台 Scene 自运行；
- Director 可按现有 Noop/Rule/Scripted 配置运行，但酒馆验收不依赖 Director。

这不是对 Scene v2 的否决，只是保持 Phase 7 只验证内容入口与认知隔离。

## 7. 通用连续交互

`WorldApplication.submitText` 与 `PlayerInputInterpreter` 支持：

- 普通非空文本 → `speak`；
- `/move <locationId>` → `move`；
- `/take <entityId>` → `take`；
- 未知命令、缺参、不可见目标或歧义 → 耐久 clarification，不建立 Round、不推进 Tick。

玩家输入不经模型改写。候选 Action 继续经过 durable Inbox、SubmitActionsValidator、Capability、Core Rulebook、Resolution、Authority 和 atomic commit。

连续 stdio shell 在同一已激活 World 上提供：提交文本、查询自身 View、查询 Round、Health、pause/exit。它不提供 author preview、NPC View、raw Memory、Store handle、Agent takeover 或 Runtime Author 命令。

Phase 7 CLI 最小命令面：

```text
worldpack init --profile minimal|social <dir>
worldpack validate <dir>
worldpack compile <dir> --out <worldpack.json>
worldpack inspect <worldpack.json>
worldpack test <dir>
worldpack activate <worldpack.json> --data-dir <dir>
worldappctl chat --data-dir <dir>
```

## 8. 酒馆社交参考 Pack

酒馆 Pack 至少包含：

- 一个人工控制的玩家角色；
- Alice 与 Bob 两个 NPC；
- 酒馆主厅一个 active Scene；
- 至少一个仅 Bob 知道的 Secret；
- Alice 对同一事件的错误或不完整 Claim；
- 一条“Bob 向 Alice 陈述 P”的公开对白路径；
- 玩家、Alice、Bob 各自不同的初始 Goal；
- 可移动到的相邻地点和可取得实体，用于验证 Core move/take；
- 确定性 Scripted/Rule Provider，使测试不依赖网络或真实模型。

它必须是开放式世界：没有 culprit、evidence、accuse、case status 或强制结局。所有内容通过 World Pack 编译入口进入运行时，不允许在测试或组合根中手工插入酒馆专用 Event。

Acceptance assertions 至少验证：

1. Bob 的 Secret 不在 Alice/玩家 CharacterView、Presentation 或 recall 中；
2. Alice 的错误 Claim 不被当作世界真相；
3. Alice 可记住“Bob 说过 P”，但不会自动获得“P 为真”的 Claim；
4. 同一 recall query 对三个角色返回不同且来源可验证的结果；
5. 角色离开当前 Scene 后不再作为下一轮参与者；
6. 重启、fork 和同键重放不改变这些结果。

## 9. 公共接口与错误

Phase 7 新增或冻结：

```typescript
interface WorldPackCompiler {
  compile(sourceDirectory: string, options: CompileOptions): Promise<CompiledWorldPack>;
}

interface WorldPackInspector {
  inspect(compiledPackPath: string): Promise<WorldPackInspection>;
}

interface WorldPackTestRunner {
  run(sourceDirectory: string, options: PackTestOptions): Promise<PackTestReport>;
}
```

Phase 7 使用总纲中的 `PACK_SOURCE_INVALID`、`PACK_REFERENCE_INVALID`、`PACK_VERSION_DIVERGED`、`PLUGIN_NOT_REGISTERED` 和 `REGISTRY_HASH_MISMATCH`。后续 Phase 的 control、Observer、AuthorCommand 和 Scene v2 错误不得提前暴露为空实现。

## 10. 实施单元

每个单元相关测试通过后独立提交：

1. P7.1 `feat(world-pack): add minimal source and compiled contracts`
   - 品牌 ID、source/envelope 类型、严格 Schema、diagnostic/error 目录；
   - 默认值和 allowlist 契约单元测试。
2. P7.2 `feat(world-pack): compile deterministic pack envelopes`
   - 安全路径加载、Markdown 规范化、引用校验、packHash、WorldSpec adapter；
   - Windows/Linux Golden bytes/hash 与非法输入矩阵。
3. P7.3 `feat(world-pack): activate pack cognition through genesis`
   - Character、Secret/audience、Observation、Claim、Goal 编译到既有 Genesis/Projection/Memory；
   - commit/restart/fork/future-canary 测试。
4. P7.4 `feat(interaction): add generic persistent world shell`
   - 通用文本/move/take、clarification、连续 stdio shell；
   - Principal view 和无旁路测试。
5. P7.5 `feat(content): add deterministic tavern social pack`
   - 酒馆 source、acceptance assertions、Scripted/Rule providers；
   - 多轮、重启、fork、Memory/Scene E2E。
6. P7.6 `docs: close phase 7 generic content evidence`
   - 创作者 runbook、兼容表、requirement→test evidence、跨平台结果和候选版本报告。

本阶段不创建代码占位来预演 Phase 8～11；只有被当前路径实际消费的接口才能进入生产包。

## 11. 测试门槛

### 11.1 Pack Compiler

- source 顺序、CRLF/LF、Windows/Linux 路径产生精确相同 canonical bytes/packHash；
- 非法 Unicode、路径逃逸、大小写碰撞、未知字段、缺失/循环引用、超限全部 fail-closed；
- minimal/social scaffold 可 validate、compile、test；
- 同 id/version 异 hash 拒绝；激活后 source 变化不影响 World；
- 未注册 profile/plugin 精确版本在 Writer Lease 前失败。

### 11.2 酒馆世界

- 连续至少十个 Round 混合 speak/move/take，Tick 与 Authority 顺序正确；
- 玩家、Alice、Bob 的 CharacterView/Memory 隔离满足六项 acceptance assertions；
- Provider failure/timeout 继续服从现有降级语义，不需要真实 Provider；
- 同键重放 Provider 调用为零，完整重放不依赖 source 目录或网络；
- fork 子分支不含父分支 forkSeq 之后的 Claim/Memory future canary；
- Session Presentation 不输出 NPC 私有 Claim 或 Memory。

### 11.3 回归与发布

- `v0.1.0` 的全部 Golden、P0～P6、hard-crash tests 和悬疑 v3/v4 生命周期矩阵保持通过；
- 所有生产文件逐文件 statements/branches/functions/lines 100%；
- `corepack pnpm@11.7.0 check` 本机通过；
- Windows/Ubuntu × Node 22.19/24 clean install 与完整 check 全绿；
- requirement→test evidence、创作者最小教程、兼容表和 clean worktree 完成后，才可请求创建 `0.2.0` Tag。

## 12. 停止条件

出现以下任一情况时停止对应单元并新增 ADR：

- Pack 需要脚本、任意 Event 或直接 Store 写入才能表达酒馆；
- 初始认知无法通过 Genesis/Event/Projection/Memory 正式路径构建；
- 为保持旧 Hash 需要更新 v3/v4 expected Fixture；
- 连续交互需要绕过 Inbox、Validator、Rulebook 或 Authority；
- 平台一致 Hash 无法在 Windows/Linux 保持；
- 无模型路径无法完成酒馆验收；
- 需要提前实现 Scene v2、Runtime Author、Agent Controller 或真实 Provider 才能证明核心问题。

## 13. Evidence → Finding → Path

### 13.1 Evidence

| Evidence | 结论 |
|---|---|
| `v0.1.0` 与 ADR-0050～0052 | Core 与悬疑 Resolver 已解耦，通用交互、Memory 和 Scene 正式路径已存在 |
| 2026-08-24 Phase 7 初步计划 | World Pack、非悬疑内容和真实 Provider 是三个可独立验收的工作流 |
| 2026-08-25 架构总纲 | 创作者、复杂角色、多 Scene、控制和真实模型的长期方向已冻结 |
| 本轮范围复核 | 将全部方向合并为单一 Phase 会掩盖最先需要验证的“内容不改 Kernel”问题 |

### 13.2 Finding

Phase 7 的最小闭环不是“完成创作者平台”，而是让一个非悬疑 Pack 经统一编译、激活、交互、Memory 和重放路径成立。酒馆比继续扩充悬疑更能直接验证通用性；Scripted/Rule Provider 比真实模型更能暴露架构问题。

### 13.3 Path

先实现最小 Pack 和酒馆闭环，保持单 Scene、manual player 与无模型运行。只有该闭环通过，才按总纲依次进入 Scene/心理、创作者扩展、Agent Controller 和真实 Provider。

## 14. 收敛结论

Phase 7 以一个明确、可复现的产品切片结束：创作者只编辑内容文件，就能运行一个非悬疑酒馆世界，并观察到角色知识与 Memory 真正独立。它不承担整个通用内容架构的实现责任，也不通过提前搭空接口制造虚假进度。
