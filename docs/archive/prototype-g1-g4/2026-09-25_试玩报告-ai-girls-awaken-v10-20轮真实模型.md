# 试玩报告：ai-girls-awaken-v10 · 20 轮真实模型（deepseek-flash）

> 日期 2026-09-25 · 工作树 `harness-cordis-world-g4` @ `1e9450d`（分支 `codex/g4-architecture-reduction`）
> 模型 `deepseek-flash` · 运行时 `FrozenWorldPlaytestRuntime`（与网页试玩同一条生产路径）· `submit_actions/v7` over Manifest v10

## 一行结论

扩包在机械层面**完全生效**（新物品与新地点都进了玩家的可选动作空间、并被真实用上），但这次 20 轮试玩暴露的瓶颈**不是"玩具太少"**，而是三条与包内容无关的运行时行为：**玩家一离开卧室，另外三个角色就永久失联**（第 6 轮起 14 轮零发言、零记忆累积）；**角色活动认知 20 轮内逐字节不变**（4 个角色 / 46 次激活只有 4 个不同快照），直接表现为 GLM 从第 7 轮起语义复读；**关键词召回全程零产出**（`recall_receipts = 0`），与已定位的中文 FTS 缺陷一致。

## 一、本次改了什么

### 1.1 包：`examples/world-packs/ai-girls-awaken-v10` 2.0.0 → 2.1.0

| 项 | 改前 | 改后 |
|---|---|---|
| 地点 | 3（卧室 / 客厅 / 工作区） | **4**（新增 `location:kitchen` 厨房） |
| 可交互实体 | 3（手机@卧室、笔记本@工作区、键盘@工作区） | **8**（新增：充电器@卧室、遥控器@客厅、抱枕@客厅、马克杯@工作区、水壶@厨房；全部带 take/drop/give） |
| 场景 | 3 | 4（新增 `scene:kitchen`，`created`） |
| 断言 / 角色人设 / 认知 | — | **未改动** |
| `packHash` | `sha256:9a388e86…` | `sha256:b8b48e04…` |

改前"客厅零可交互物"是明显的可玩面空洞，本次补齐后**每个地点至少 2 件可交互物**（厨房 1 件）。

`validate` / `test` 均通过：`packVersion 2.1.0`、`status: compiled`、10 条断言计划不变。
（`assertionsExecuted: 0` 是 `packages/world-pack/src/tooling.ts:105` 硬编码的，不是回归。）

### 1.2 驱动器：`tests/experiments/frozen-playtest-drive.ts`

- `--scenario ai-girls` 的输入脚本由 5 轮扩到 **20 轮**，覆盖四个地点的移动、拿放递交、牵手与解除、以及一次"只对 Claude 低声说 → 再问 GPT 有没有听见"的信息隔离探针。`hand-in-hand` 情景**未改动**。
- 新增 `provider.jsonl` 落盘（每条真实 provider 请求/响应，含 `messages` + `tools`；不含 header 与密钥），使上下文计量可复现。

### 1.3 运行参数

```bash
./node_modules/.bin/tsx tests/experiments/frozen-playtest-drive.ts \
  --model deepseek-flash --pack examples/world-packs/ai-girls-awaken-v10 \
  --scenario ai-girls --turns 20
```

- 用时 **1 分 34 秒**，退出码 0，**无一次调用失败**。
- **66 次 provider 调用** = 20 次意图解析（system 444 tok）+ 46 次角色激活（system 185 tok）；`messages` 恒 2 条。
- 中途**关闭并重新打开**一次（第 10/11 轮之间），检验重启续跑。
- 世界事件 `headSeq` 108 → 492，运行期新增 384 条事件。

数据目录：`.tmp/frozen-playtest-drive-2026-09-24T21-18-38-344Z/`（`outcome.json` + `provider.jsonl` + 4 个 sqlite）。

## 二、扩包确实生效（机械证据）

意图解析请求的 `affordances` 列表里直接出现了新增内容（turn 1 的 user 段）：

```
… {"actionType":"interact","affordanceId":"…","parameters":{"bindingId":"binding:charger-take",
   "definitionRef":{"id":"base:take"},"targetRef":{"id":"entity:charger","kind":"entity"}}}
… {"actionType":"move","parameters":{"locationId":"location:kitchen"}}
```

真实被用上的新内容：

| 新内容 | 是否被用 | 证据 |
|---|---|---|
| `location:kitchen` | ✅ | 玩家第 15 轮移入；`character.moved` seq=434；`scene.activated scene:kitchen` seq=437 |
| `entity:coffee-mug` | ✅ | `entity.transferred` seq=375（玩家拿起） |
| `entity:kettle` | ✅ | `entity.transferred` seq=442（玩家拿起） |
| `entity:charger` | ✅（冒烟轮） | GLM 拿起并递交给玩家，`entity:charger 已交由GLM持有` |
| `entity:remote` / `entity:cushion` | ❌ 未用到 | 玩家第 11 轮试图拿遥控器时人不在客厅 |

**外部行为正常**：5 次物品转移、5 次移动、3 个场景动态激活、0 次 `action.rejected`。
第 11 轮玩家在**工作区**试图拿**客厅**的遥控器，世界返回 `not_afforded` 并拒收该输入（该轮 0 事件、无幽灵转移）——**fail-closed 正确**。

## 三、发现

### ❌ 发现 1：玩家一走出卧室，另外三个角色永久失联

| 角色 | 发言次数 | 最后一次发言 `seq` | 记忆累积截止 `seq` |
|---|---|---|---|
| Claude | 12 | **349** | **321** |
| DeepSeek | 11 | **354** | **322** |
| GPT | 7 | **359** | **324** |
| GLM | 13 | 488 | 485 |
| 玩家 | 14 | 483 | 486 |

第 6 轮玩家从卧室移动到工作区（`character.moved` seq=316），此后 **Claude / DeepSeek / GPT 在第 7–20 轮（14 轮）里一次都没有发言，记忆层也一条没记**（三者最后一次写入分别停在 seq 321/322/324，正是第 6 轮）。第 13–16 轮更极端：玩家独自在工作区/厨房，**该轮 0 次角色激活**（provider 调用数 = 1，只有意图解析）。

机制：协调器只把**新观察事件**变成候选刺激（`packages/application/src/prototype-activation-cycle.ts:14-30`），而观察按场景/位置分发；没有任何机制把同伴带走，也没有机制让玩家"叫上大家"。

**最直接的证据是第 10 轮**：玩家说「**我们先去客厅吧**」——被解析成"说话"而不是移动（无 `character.moved`），也没有任何角色跟随。于是玩家仍留在工作区，直接导致第 11 轮拿遥控器拿到 `not_afforded`。

### ❌ 发现 2：角色活动认知 20 轮内逐字节不变 → 语义复读

对全部 46 次角色激活，取出注入模型的 `context.cognition`，**剔除 `asOfWorldSeq` / `bundleHash` / `address` 三个易变字段后做哈希**：

| 角色 | 激活次数 | 不同认知快照数 |
|---|---|---|
| Claude | 12 | **1** |
| DeepSeek | 11 | **1** |
| GLM | 16 | **1** |
| GPT | 7 | **1** |
| 合计 | 46 | **4**（每角色恰好 1 个） |

各角色的 `claims` 恒 5 条、`goals` 恒 2 条、`relationships` 2–3、`affects` 1–2、`innerTensions` 1、`commitments` 1、`openLoops` 1 —— 从第 1 轮到第 20 轮**完全一致**。

世界账本侧同样干净：`character-goal.upsert` / `subjective-claim.upsert` / `affect-episode.upsert` / `open-loop.upsert` / `inner-tension.upsert` / `relationship-attitude.upsert` / `commitment.upsert` 全部只出现在 genesis（seq ≤ 108），**运行期 seq 109–492 一条都没有**。

**这不是"记忆没写"**：记忆层在积极写入（`cognitive_memory_v2_sources` 202 条、L1 摘要 55 条、`capture_receipts` 54）。是**结构化认知（goal/claim/affect/tension/loop）从不被运行期更新**。

它直接解释了 GLM 的表现。GLM 从第 7 轮起 13 次发言里，后 9 次都在重复同样的两件事——"电脑还是黑的"和"你手机时间报我、顺便看看有没有网口"：

```
6.  电脑还是黑的。你过来看一眼，顺便把手机时间报给我——先确认是没电还是线的问题。
7.  做梦不会让电脑开不了机。先别管那个，你过来看——电源线插着，屏幕还是黑的。手机时间报我。
10. 水就行。你手机时间报我，顺便看下客厅有没有网口或者路由器——电脑还是黑的，得先确认是没电还是线的问题。
11. 嗯。先不说。电脑还是黑的，你手机时间报我，顺便看下这屋有没有网口或者路由器。
12. GPT听没听见我不知道，我又不是它。你刚才说的是——问它你说了什么。电脑还是黑的，手机时间报我。
13. 行，你坐。电脑我先拿着——客厅插座我还没试。你手机时间报我，顺便看下这屋有没有网口或者路由器。
```

⚠️ 精确表述：这 13 条**不是逐字相同**（13/13 互不相同），是**语义复读**——同一个未闭合目标（确认电脑能否用）反复重述。她的 `goals` 恒 2 条从未变化，目标既没完成也没衰减，也没有任何新认知把它挤掉。

### ❌ 发现 3：关键词召回全程零产出

| 表 | 行数 |
|---|---|
| `cognitive_memory_v2_sources`（写入） | **202** |
| `cognitive_memory_v2_summaries`（L1 摘要） | **55** |
| `cognitive_memory_v2_receipts`（采集回执） | **54** |
| `cognitive_memory_v2_recall_receipts`（**召回回执**） | **0** |
| `cognitive_memory_v2_terms`（加权词表） | **0** |

FTS 建表语句（`packages/memory/src/local-memory.ts:142` 附近，实库 `sqlite_master.sql` 原文）：

```sql
CREATE VIRTUAL TABLE cognitive_memory_v2_fts USING fts5(namespace_key UNINDEXED, memory_id UNINDEXED, text_value)
```

**没有 `tokenize=` 子句 → 默认 `unicode61`**，中文无空格 → 整段中文成一个 token。配合查询侧"按空格切分、各自加引号、`AND` 连接"，中文召回结构性归零。这与 `MEMORY.md` 里已定位的缺陷完全一致，本次在**全新的 v10 世界 + 2.1.0 包**上复现（`recall_receipts = 0`）。

对照：`LIKE '%手机%'` 在 `cognitive_memory_v2_sources` 命中 51 条——**文本在库里，只是召回拿不出来**。

### ⚠️ 发现 4：信息隔离守住了，但"低声/只对某人说"的语用被抹平

第 18 轮玩家说「我只靠近 Claude 低声说：其实我有点怕这一切突然消失，**先别告诉她们**」。Host 记录：

```
seq=463 character.speak  {"addresseeIds":[], "scope":"scene_public",
  "text":"我只靠近 Claude 低声说：其实我有点怕这一切突然消失，先别告诉她们。"}
```

- `addresseeIds` **空**、`scope` = **`scene_public``** —— 玩家文本里的"只对 Claude / 低声"没有变成任何收件人或私密范围。
- 观察到这条的**只有 GLM 与玩家自己**（seq=465/466）。**Claude / GPT / DeepSeek 的观察记录里都没有**（逐角色核验）。
- 原因不是"泄漏"，是**Claude 当时不在场**（玩家在客厅，Claude 全程留在卧室）——所以第三人称转述的私密话被交给唯一在场的 GLM，而 GLM 也照做了（"嗯。先不说。"）。

**结论：隔离不变量成立（没有跨房间泄漏）**；但玩家表达的语用强度（低声 / 指定收件人）在意图解析层丢失。第 19 轮"问 GPT 我刚才说了什么"因 GPT 已不激活而**无法构成有效探针**（GPT 什么都不知道，不只是不知道这一句）。

### ⚠️ 发现 5：牵手关系在玩家移动时被自动解除

- `character.relation-started` seq=245：玩家牵 GPT 手（`hand_hold`）。
- `character.relation-ended` seq=317：`endedByCharacterId=player`、**`reason: participant_moved`** —— 玩家第 6 轮走向工作区时关系**自动终止**。
- 因此第 14 轮脚本里的「我松开一直牵着的 GPT 的手」**其实无事可做**（关系早就没了）。

规则本身合理（人走了手自然松），但玩家没有被告知；脚本作者需要知道"牵手跨房间不成立"。

### ✅ 发现 6：角色在无指令时保持主体性（正面样本）

- 第 2 轮 GLM 未被指派，自己说"我去把电脑和网络确认一下"并**主动移动到工作区、拿起笔记本**（`character.moved` seq=180、`entity.transferred` seq=191）——新实体被 NPC 自主使用。
- 四个角色语气稳定可辨：Claude 先验证再表态（"我不打算替这件事编一个听起来舒服的解释"）、GPT 先接情绪（"不用急着说什么…我在这儿"）、DeepSeek 好奇追问、GLM 短句务实。
- 达成预算上限时的提示语（"本轮角色反应达到预算上限"）每轮都出现，实为**正常的 8 次调用/轮上限**（`prototype-activation-cycle.ts:38`），不是故障——但措辞容易被误读为异常。

## 四、上下文计量（真实请求，非估算）

单条角色请求的 `context` 段结构（`turn 5` / `turn 20`，tiktoken `o200k_base`）：

| 段 | turn 5 | turn 20 | 说明 |
|---|---|---|---|
| `cognition` | 5,807 tok | 5,877 tok | **占约一半，且几乎恒定**（与发现 2 同源） |
| `observations` | 4,258 tok | 3,779 tok | 有上限、会滚动 |
| `selfObservations` | 1,013 tok | 854 tok | 角色自己说过的话 |
| `character` | 291 tok | 272 tok | 自身定义 |
| `affordances` | 138 tok | 303 tok | 扩包后变大 |
| `stimulus` | 128 tok | 133 tok | **本轮唯一真正相关的内容** |
| `items` | 59 tok | 162 tok | 场景内可交互物 |
| `scene` | 78 tok | 46 tok | — |
| `claims` | **1 tok** | **1 tok** | **恒为空数组 `[]`** |
| `goals` | **1 tok** | **1 tok** | **恒为空数组 `[]`** |

规模：

- 单条角色请求最大 **43.6 KiB**（turn 5）、平均 **34.2 KiB** —— **未触及** standard 档 `maximumRequestBytes = 96 KiB`（`packages/contracts/src/phase8-registries.ts:85-96`）。
- 每轮合计（含 8 次调用）：最高 **272 KiB**（turn 6）；第 13–16 轮各 **4.4 KiB**（只有一次意图解析）。
- **信噪比**：单条请求里真正随本轮变化的只有 `stimulus` ≈ 130 tok / 总计 ≈ 11,400 tok ⇒ **约 1.1%**。
- `claims` / `goals` 两个顶层段**恒为空**，真实数据却在 `cognition.claims`（n=5）/ `cognition.goals`（n=2）里——**同一信息存在两套并存表示，其中一套永远是空的**。

## 五、未验证 / 局限（如实标注）

- 只跑了 **1 个模型（deepseek-flash）、1 个包、1 条脚本、1 次运行**；语义复读与失联是否在其他模型上同样出现**未验证**。
- 20 轮全程**未触及**任何配额或字节上限（无 `COGNITION_STATE_LIMIT`、无 `CONTEXT_WINDOW_EXCEEDED`）——**长程压力仍未真正施加**。
- 「认知零更新」是**从注入模型的上下文反推**（`context.cognition` 去易变字段后哈希一致）+ 世界账本无认知事件，两路互证；**未实读**写入侧代码路径去确认"设计如此"还是"路径断了"。
- 第 18 轮的私密话**没有被证明泄漏**，但第 19 轮探针**无效**（收件人已不激活），所以"隔离在动态场景下成立"这一条**证据强度有限**。
- `expressions` 为空（`character.manifested` 事件 0 条），与产物的 `manifestation.json`（`mode: enabled`）关系**未查明**。

## 六、可选的下一步（均未动手）

1. **让"叫上大家"这类表达生效**：`move` 之外是否有"同行/跟随"语义可落到动作层——这是发现 1 的直接解法，也最贴近"连续互动"目标。
2. **认知回写**：确认运行期是否**本来就该**写 `goal/claim/affect`；若是路径断了，发现 2 与发现 3 可能是同一个根因的两面。
3. **中文召回**：`tokenize='trigram'` 是最小改动候选（`local-memory.ts` 的 FTS 建表语句），可先用同一份数据做离线 A/B。
4. **清理冗余段**：`claims`/`goals` 顶层空段（各 1 tok，可忽略）与 `cognition.*` 重复，值得合并。
5. 驱动器脚本可再扩一轮"离场后折返"的场景，专门检验角色是否会因为重逢而恢复发言。
