# 修复方案：Claude / GLM 生成失败（affect targetKey=null 击穿试玩渲染器）

> 日期：2026-09-07 · 状态：**待确认，未执行任何修改**
> 世界包：`examples/world-packs/ai-girls-awaken`（packId `pack:ai-girls-awaken` v1.0.0）
> 编译制品：`examples/world-packs/ai-girls-awaken.worldpack.json`

---

## 1. 根因摘要

- 源 `cognition.json` 中 claude 的 `affect:claude-wary-curiosity`、glm 的 `affect:glm-quiet-pride` / `affect:glm-faint-ache` **未写 `targetKey`**。
- 手册明确 `targetKey=null` 是 affect 的合法默认值，`worldpack validate/compile` 均通过。
- 但试玩渲染器 `tests/experiments/compact-context.ts` 的 `compact()/alias()` 把 referenceKeys（`id/key/observationId/projectionId/targetKey/targetKeys/blockerKeys`）一律要求为字符串；遇到 schema 合法的 `null` 即抛：
  `TypeError: context reference must be a string [key=targetKey value=null]`
  抛出位置在 **continuity_checkpoint 段**（该段携带角色的 activeCognition，含 affect 的 `value.targetKey`）。
- 该异常发生在发起 HTTP 请求**之前**（证据目录中无任何 claude/glm 请求文件），被协调器归类为 `provider_failed` → 写入 `character_runtime_availability = model_unavailable`（**会话持久，不自动恢复**）→ 此后每轮 `runtime_unavailable` 直接出局。
- 对照组：deepseek / gpt 所有 affect 均显式写了 `targetKey:"character:player"`，故正常。

## 2. 修复选项

### 选项 A（推荐）：渲染器健壮性修复 + 语义补全

#### A1. 渲染器容忍 null/undefined 引用 —— `tests/experiments/compact-context.ts`

现逻辑（约 L103–110，已用 `git checkout` 还原为原始状态）：

```ts
const alias = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(alias)
  if (typeof value !== 'string') throw new TypeError('context reference must be a string')
  if (/^(character|location|entity|scene):/.test(value)) return value
  if (!references.has(value)) references.set(value, `R${references.size + 1}`)
  return references.get(value)!
}
```

修改为（**在字符串校验前放行 null/undefined**）：

```ts
const alias = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(alias)
  if (value === null || value === undefined) return value
  if (typeof value !== 'string') throw new TypeError('context reference must be a string')
  if (/^(character|location|entity|scene):/.test(value)) return value
  if (!references.has(value)) references.set(value, `R${references.size + 1}`)
  return references.get(value)!
}
```

- 影响面：`tests/experiments/` 实验工具，非生产 `src`；行为变化仅为「合法 null 引用不再炸、原样保留在渲染上下文里」。
- 配套测试：`tests/experiments/compact-context.test.ts` 存在；建议补一条 `targetKey: null` 不抛错、输出保留 null 的用例。执行 `pnpm test tests/experiments/compact-context.test.ts`（或全量 `pnpm test`）确认。
- 收益：**一次性保护所有世界包**（含 V1 `model-girls-home` 的同类隐患、未来任何合法 null affect），不只修当前包。

#### A2.（可选，语义更准）`examples/world-packs/ai-girls-awaken/cognition.json`

仅给 glm 的 `affect:glm-faint-ache` 补目标——它语义本就指向玩家：

```json
{ "key": "affect:glm-faint-ache", "type": "loneliness", ..., "targetKey": "character:player", ... }
```

claude 的 `wary-curiosity`（针对“为何实体化”的疑问）与 glm 的 `quiet-pride`（自我效能感）无真实指向对象，**维持 null**（A1 修复后不再构成问题）。

#### A3. 重编译 + 重启

```powershell
cd "D:\DeepSeek Harness\harness-cordis-world-v0"
pnpm worldpack validate examples/world-packs/ai-girls-awaken
pnpm worldpack compile examples/world-packs/ai-girls-awaken --out examples/world-packs/ai-girls-awaken.worldpack.json
# 换全新数据目录（旧目录 model_unavailable 已持久化，无法复活）：
pnpm experience:web --deepseek --pack examples/world-packs/ai-girls-awaken.worldpack.json --data-dir D:\worlds\ai-girls-awaken-playtest-v2
```

### 选项 B（最小改动，不改代码）：仅世界侧补全

在 `cognition.json` 给 3 处情绪（claude `wary-curiosity`、glm `quiet-pride`、glm `faint-ache`）补 `"targetKey": "character:player"`，然后执行上面的 A3（validate/compile/新目录重启）。

- 优点：零代码改动、零测试影响。
- 缺点：claude 好奇与 glm 自傲这两处情绪并不真的指向玩家，硬补会把情绪错误地定向到玩家（影响 NPC 上下文可读性）；且 V1 与未来包仍会踩同一雷。

### 选项 C：仅出方案（本次所选）

本文件即交付物；确认后按 A 或 B 执行。

## 3. 修复后验证清单

| # | 验证项 | 方法 | 期望 |
| --- | --- | --- | --- |
| 1 | 渲染器单测 | `pnpm test tests/experiments/compact-context.test.ts` | 全绿（含新增 null 用例） |
| 2 | 世界包校验 | `pnpm worldpack validate examples/world-packs/ai-girls-awaken` | `status:"valid"` |
| 3 | 编译 | 见 A3 | `status:"compiled"`，新 packHash |
| 4 | 四人同场 | 新数据目录试玩，开场问“你们是谁” | claude / glm 与 gpt / deepseek 均开口 |
| 5 | 无熔断 | 玩 2–3 轮后查 `character_runtime_availability` | 四角色均 `ready` |

## 4. 风险与备注

- ⚠️ 当前主试玩会话（数据目录 `D:\worlds\ai-girls-awaken-playtest`）中 claude/glm 已熔断，**修好后也必须新开数据目录**；旧目录若需保留回放可留作证据。
- ⚠️ V1 `model-girls-home` 存在同类隐患（affect 缺 targetKey），走 A 方案后无需单独处理即可安全试玩。
- 诊断期间对 `tests/experiments/playtest-runtime.ts`、`compact-context.ts` 的临时日志补丁**已全部还原**（`git status` 干净）；复现实验仅消耗 gpt/deepseek 各 2 次小调用。
- 若确认走 A，建议 A1 的测试用例与代码改动一并提交，遵循 AGENTS.md 的「改代码必须带测试」约束（A1 属实验工具，仍建议最小测试覆盖）。
