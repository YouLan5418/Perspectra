# ADR-0080：World Pack v3 与 Reaction Policy 创作者入口

- 状态：Accepted
- 日期：2026-09-02
- 上位目标：[Phase 9 实施规格](../spec/phase-9-implementation-v0.1.md) §23（Phase 9C）；[Phase 9C 实施规划](../2026-09-02_实施计划-Harness-Cordis-World-Phase-9C.md) §7
- Extends：ADR-0054（World Pack 来源、编译、信任与版本）、ADR-0067（Cognitive Memory v2 与 World Pack v2）、ADR-0069（World Pack v2 作者源文件形状）、ADR-0077（有界自主 Reaction Cycle）、ADR-0078（Reaction Policy 的 Manifest 版本门）
- Supersedes（局部）：ADR-0078 决定 6 中“正式创作者编译入口尚未存在”的状态；任何通过给 `worldpack-source/v1`、`worldpack-source/v2` 增加可选字段来启用自主反应的实现设想

> **兼容警告：** `worldpack-source/v1`、`worldpack-source/v2`、compiled `worldpack/v1`、`worldpack/v2` 与 Manifest v1～v4 的字节、Hash 和运行语义永久冻结。自主反应只能由 `worldpack-source/v3` 的必填 `reactionFile` 编译出的 Manifest v5 显式开启。

## 背景

ADR-0078 冻结了能力门：只有严格校验的 Manifest v5 必填 `reactionPolicy` 才能启用 `responsive/v1`，Manifest v1～v4 恒为 `disabled`。但该 ADR 同时留下一个缺口——生产组合根不得通过测试夹具、环境变量或应用默认值开启自主反应，而当时**没有任何正式创作者入口能产出 Manifest v5**。

当前状态证实了这个缺口：

- Manifest v5 只能由测试夹具手工构造（`tests/reaction-fixture.ts:143-155`），生产路径无法到达；
- Pack 编译器只有两条链：`WorldPackCompiler.compile` 输出 compiled `worldpack/v1` 并把 Manifest 重标为 v3（`packages/world-pack/src/compiler.ts:279-370`、`:452-459`），`WorldPackCompilerV2.compile` 输出 compiled `worldpack/v2` 并构造 Manifest v4（同文件 `:863-975`、`:978-1053`）；
- 版本派发只认 v2，其余一律走 v1（`packages/world-pack/src/tooling.ts:47-53`）；
- CLI profile 只有 `minimal` 与 `social`（`packages/world-pack/src/creator-cli.ts:28`、`:46`），`WorldPackInspection` 也不含任何预算字段（`packages/world-pack/src/contracts.ts:487-497`）。

因此创作者今天无法合法启用反应，而任何“给 v2 加个可选字段”的捷径都会破坏 ADR-0078 的冻结承诺。

## 决定

### 1. 新增一条显式版本链，不污染旧版本

新增：

- `worldpack-source/v3`；
- compiled `worldpack/v3`；
- `worldpack-compiler/v3`（编译器版本 `0.3.0`）；
- 输出 Manifest v5（`packages/kernel/src/world-spec.ts:161-168`）。

`worldpack-source/v3` 完整继承 ADR-0069 冻结的 v2 内容文件形状（world、character、location、entity、scene、player-slot、presentation、cognition、memory、document、markdown、asset、assertion），只新增一个**必填**键：

```ts
interface WorldPackSourceManifestV3 extends WorldPackSourceManifestV2 {
  readonly sourceSchemaVersion: 'worldpack-source/v3'
  readonly reactionFile: string
}
```

compiled `worldpack/v3` 同样继承 compiled `worldpack/v2` 的全部字段（含 `vocabularyLocks`、`registryLocks`），新增编译后的 `reaction` 成员。Pack Hash 使用独立域分隔：`hashWorldJson('compiled-world-pack/v3', …)`，因此 v3 Hash 不可能与 v1/v2 冲突。

内容限额继续记为 `worldpack-limits/v2`，不新增 limits profile：字节与条目上限没有变化，而 Reaction 预算根本不属于 Pack（见决定 3）。

### 2. `reaction.json` 只接受两种精确形状

`reactionFile` 指向的 JSON 内容版本为 `worldpack-reaction/v1`，只接受：

```json
{ "schemaVersion": "worldpack-reaction/v1", "mode": "disabled" }
```

或：

```json
{
  "schemaVersion": "worldpack-reaction/v1",
  "mode": "responsive",
  "profile": "responsive/v1"
}
```

校验规则与 ADR-0078 对 Manifest 的要求同构且同样 fail-closed：缺字段、未知字段、未知 `schemaVersion`、未知 `mode`、未知 `profile` 一律拒绝，不回退默认值，不猜测创作者意图。`disabled` 编译出 Manifest v5 的 `reactionPolicy.mode = 'disabled'`；`responsive` 编译出 `profile: 'responsive/v1'`。

`reactionFile` 缺失即整个 Pack 无效：v3 不存在“没有反应声明”的合法形状，避免沉默默认。

### 3. 创作者不能改写安全预算

Pack 只选择 `disabled` 或固定的 `responsive/v1`。以下全部由版本化 profile 冻结，不接受创作者输入，也不出现在 Pack 来源或编译产物中：

- 最多 3 waves、8 次 NPC 调用、每角色最多 2 次调用、每次调用最多一个 `speak@1`（`packages/application/src/round-coordinator.ts:88-91`，存储侧硬校验 `packages/store-sqlite/src/reaction-cycle.ts:201-203`）；
- Cycle deadline 30 秒；
- Action 类型闭集与 Rulebook 裁决边界。

因此 v3 不引入任何新的数值字段；创作者唯一的选择是“开或关”。

### 4. Participant 绑定仍是 Host 运行时职责

Manifest v5 的 `responsive/v1` 要求每个 active 且非 manual 的 NPC 都有一条 Reaction participant 绑定，激活时 fail-closed 校验（`packages/application/src/world-application.ts:344-358`）。绑定携带 `provider` 实现与 `estimatedTokens`，属于部署与运行时事实，可能涉及凭据，因此：

- Pack v3 **不声明、不存储、不编译** participant 绑定；
- `worldpack activate` 不伪造绑定，也不因为缺绑定而拒绝写入 Manifest；它必须在结果中回报该 Pack 需要的 `requiredReactionActors` 集合（按 `compareWorldText` 排序），让操作者知道 Host 必须提供什么；
- 若 Host 未提供匹配绑定，Branch mount 时按既有 fail-closed 规则抛出，不降级为 `disabled`，也不静默跳过该角色。

### 5. CLI 与 Runbook

- `worldpack init --profile responsive-social` 生成最小 v3 Pack（含 `reaction.json`，`mode: responsive`）；既有 `minimal`、`social` profile 的输出保持逐字节不变，仍为 v1；
- `validate`、`compile`、`inspect`、`test`、`activate` 全链支持 v3，并按 `sourceSchemaVersion` 精确派发编译器，未知版本 fail-closed；
- `inspect` 对 v3 额外显示最坏上限：3 waves、8 calls、每角色 2 calls、每次最多一个 `speak@1`、Cycle deadline 30 秒，以及由此推出的“一次玩家输入最多产生的 NPC 发言条数”预算估算；`inspect` 不输出任何 Secret、Prompt 或 Provider 配置；
- Creator Runbook 必须给出启用、观察、抢占、maintenance、恢复与禁用六条流程，并明确 token 预算由 Host 绑定的 `estimatedTokens` 决定，Pack 不可见。

### 6. 零漂移证明

Golden Fixture 必须证明 v1/v2 编译字节与 Hash 零变化。当前已被测试固定的基线值（详见[Phase 9C v15 旧库与 Golden 基线](../2026-09-02_Phase-9C-v15旧库与Golden基线.md)）：

| 基线 | 值 | 固定位置 |
| --- | --- | --- |
| v1 tavern packHash | `sha256:9f64a1428bebd5e7bd005dffb0315e46c912b772be55f99bd8b04b72c44af381` | `packages/world-pack/src/compiler.test.ts:146` |
| v1 canonical bytes | 3390 字节，`sha256:e060b076dc05d1eafa78f0a13781637f2261a6fd84eb5c4d212c0c63655407c9` | `packages/world-pack/src/compiler.test.ts:149-152` |
| v2 packHash | `sha256:4eef7eeed78ebb6e2cd60223f8fd10a293ea6fbe16ab130042be2dc8afb1430f` | `packages/world-pack/src/compiler-v2.test.ts:195` |
| v2 manifestHash / genesisHash | `sha256:7531b3e328789aae4aa51813241992a5dcdc17f13f67b677ca20e5adae7deccc` / `sha256:d650c9741435b3e89ba6783e39ee01f9fecebb98881d6c0dbe3132590955a922` | `packages/world-pack/src/compiler-v2.test.ts:241-242` |
| tavern-social CLI packHash | `sha256:515dd41a737d28139548364eefe3c7211c94a0f3a8b43bead4950a32f2f12c6d` | `packages/world-pack/src/creator-cli.test.ts:105` |
| rainy-road-companions v2 CLI packHash | `sha256:76098df56b8a9169861f5094159d41ee7d6ef26c018339c8017615eb4686e0b8` | `packages/world-pack/src/creator-cli.test.ts:132` |

P9C.4 的实现不得修改上述任一断言值。若某个值必须改变，说明 v3 污染了旧版本，必须停止并回到本 ADR。

## 结果

- 创作者第一次拥有正式、可审计的反应启用入口，且只能在 `disabled` 与固定 `responsive/v1` 之间选择。
- v1/v2 世界与 Pack 零漂移；旧世界升级宿主后仍不会自行行动（与 ADR-0078 一致）。
- Manifest v5 不再只能由测试夹具产生，生产组合根可以合法启用反应。
- 代价：v3 承担一次显式迁移成本（新常量、新 schema parser、新编译器分支、新 CLI profile），且绑定与 Pack 分离意味着“启用反应”始终是 Pack + Host 两侧配置的结果，Runbook 必须把这一点讲清楚。

## 证据链

### Evidence

- E-001：`packages/kernel/src/world-spec.ts:181-266` 已接受 Manifest v5，`:289-302` 的 `parseReactionPolicy` 已对两种形状 fail-closed。
- E-002：`packages/world-pack/src/compiler.ts` 只有 v1（`:279-370`，Manifest v3）与 v2（`:863-975`，Manifest v4）两条链；`packages/world-pack/src/tooling.ts:47-53` 只按 v2 派发。
- E-003：`tests/reaction-fixture.ts:143-155` 是 Manifest v5 的唯一生产者，属测试夹具。
- E-004：`packages/application/src/world-application.ts:344-358` 要求 responsive/v1 与 participant 绑定精确一一匹配，绑定来自 `WorldApplicationOptions.reactionParticipants`（`:344`）。
- E-005：`packages/world-pack/src/creator-cli.ts:28`、`:46` 只有 `minimal`、`social` 两个 profile；`packages/world-pack/src/contracts.ts:487-497` 的 `WorldPackInspection` 无预算字段。
- E-006：v1/v2 的 packHash、canonical bytes、manifestHash、genesisHash 已被测试逐值固定（见决定 6 的表）。

### Finding

- F-001：能力门（ADR-0078）已经就绪，缺的只是“谁能合法产出 Manifest v5”；因此 P9C.4 是版本链扩展，而不是重新设计反应语义（E-001 / E-002、E-003）。
- F-002：绑定携带 Provider 实现与 token 估算，天然属于部署侧；把它塞进 Pack 会让内容包携带运行时凭据面，违背最小权限与脱敏边界（E-004）。
- F-003：v1/v2 基线已经被逐值 Golden 固定，所以“零漂移”是可机械验证的，而不是口头承诺（E-006）。

### Path

1. 先加 v3 常量、`worldpack-reaction/v1` parser 与源 Manifest v3 校验，全部 fail-closed；
2. 再加 `WorldPackCompilerV3`，输出 compiled `worldpack/v3` 与 Manifest v5，并复用 v2 的内容管线；
3. 然后按 `sourceSchemaVersion` 精确派发编译器与读取器，确保 v1/v2 路径字节不变；
4. 最后扩 CLI：`init --profile responsive-social`、v3 全链支持、`inspect` 上限展示，并用既有 Golden 断言证明零漂移。
