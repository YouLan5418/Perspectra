# 交互抽象 I4-d（第二片）：Round Authority 6

| 属性 | 值 |
|---|---|
| 日期 | 2026-09-14 |
| 工作树 / 分支 | harness-cordis-world-v0-merged / fix/step-cue-normalization |
| 实施基线 | `2e4ece2`（I4-d 第一片：模型协议） |
| 上位规格 | [交互定义实施契约](spec/interaction-definition-v0.1.md) §7、§9 |
| 状态 | Authority 6 落地；`responsive/v2` 与 `reaction-evidence/v1` 仍未做 |

## 1. 补的是哪一条

规格 §7 给新路径分配了 `Round Authority schemaVersion 6：显式角色/定义依据绑定`。从 I4-a 起，v10 世界的 Authority 一直写 5，理由每次都记着"输入还没有"。第一片做完后输入有了：`RulebookResolution.interactionTrace` 带着冻结裁定自己的三个哈希。这一片把它落进耐久记录。

## 2. 实现

| 位置 | 改动 |
|---|---|
| [round-coordinator.ts](../packages/application/src/round-coordinator.ts) | Authority 版本 v10 → 6；每条 resolution 在冻结路径下带上 `interaction` |
| [reaction-scheduler.ts](../packages/application/src/reaction-scheduler.ts) | 同上（反应回合也写 6） |
| [player-provisional.ts](../packages/application/src/player-provisional.ts) | 玩家预裁定绑定带上 `interaction`，并纳入 `ruleTraceHash` 的哈希输入 |

`interaction` 的内容就是冻结裁定自己算出来的东西：

```
definitionSetHash         本次裁定用的定义集合（世界选择）
resolvedRoleBindingsHash  实际解析出的角色绑定
ruleTraceHash             把上面两项与 World/Manifest/候选前缀/Authority/Action 绑在一起的 trace
```

**为什么这三样就是"显式角色/定义依据绑定"**：`ruleTraceHash` 由 `FrozenInteractionWorld` 在 `finish()` 里算，输入包含 address、manifestHash、asOfWorldSeq、candidatePrefixHash、actionId、actorId、authority、完整 request 与规则 trace——也就是说，它绑定的正是"哪个定义、哪些角色、在哪段前缀、按谁的授权"。删掉它，耐久记录就只剩"某个动词跑过"，说不出是哪把锁让它跑起来的。

## 3. 证据

**两条独立的证伪**，各自只回退一半：

1. 把 Authority 版本改回 5 → 用例失败（`expected 5 to be 6`）。
2. 只把 `interaction` 那一段去掉、版本保持 6 → 用例失败（找不到 `interaction`）。

**两条独立的正向断言**（不只是"字段在"）：

- `definitionSetHash` 等于**另外独立冻结**出来的同一个世界选择（测试里用 `InteractionRegistry` 直接 `freeze` 编译产物），证明耐久记录指向的定义集合与运行期裁定用的是同一份，而不是 Host 自己重述的。
- `ruleTraceHash` **不等于**协调器自己算的那条 `round-rule-trace`，证明带的是冻结裁定的 trace，不是 Host 侧的复述。

**一条反向守卫：** v9 回合仍然写 Authority 5，且它的每条 resolution 都没有 `interaction` 字段——新绑定是 v10 独有的，旧路径逐字不变。这条断言加在既有的 v9 用例里。

**反应入口也覆盖：** 反应波形里的代理提出一次交互（拿保温壶），断言反应回合的 Authority 同样是 6 且带 trace。这一条同时把反应路径上"冻结 resolution 带 trace"的分支打满。

## 4. 仍未做

| 项 | 说明 |
|---|---|
| **`responsive/v2` 与 `reaction-evidence/v1`** | 规格 §5 的新证据结构（`sourceEventRef`、`observationId`、`observerCharacterId`、`actionId`、`definitionRef` 或专用入口身份、`roleClass`）、`self/direct/addressee/witness` 分级、"仅观察到失败尝试的旁观者不得被标为 direct"、按 direct→addressee→witness 再按角色 ID/来源事件序/jobId 排序，以及"必须有该观察者的耐久 Observation 来源"——**全部未做**。这一片只让**已有的**证据结构写进 Authority 6 |
| 交互步骤上的表现 | 冻结请求带 `performance` 一律拒绝，因为"把被接受的表现转成观察事实"未接线 |
| 容量 fixture | I5-b 剩余 |
| 真实模型用例（I5-d） | 链路已通，缺真实调用 |

**I4 的 Gate 因此仍未关闭**：模型协议与 Authority 6 完成了，反应依据那一半没完成。这一点与上一轮审查的判断一致，不做粉饰。

## 5. 验证结果

- `corepack pnpm@11.7.0 check` 退出码 0。
- 逐文件 statements / branches / functions / lines 100%，全库汇总 100%；用例 1366 项。
- 未使用 `--update`；两个黄金基线字节未动；v6～v9 的 manifestHash 与 genesisHash 不变。
- 行为变化：v10 回合的 Authority 由 5 变 6，玩家预裁定绑定的哈希输入多了 `interaction`。**v10 尚无任何已激活的存量世界**（激活门禁直到 I4-c 才打开，且需要 Host 声明安装包），所以没有需要迁移的 Authority。
- lint 仅剩既有 `tests/experiments/grouped-runtime.test.ts:25` warning。

## 6. Evidence → Finding → Path

E1：v10 的耐久 Authority 只记了"哪个动作、什么结果"，无法证明是哪把定义锁让它跑起来的。F1："显式角色/定义依据绑定"这条规格要求没有落点。P1：把冻结裁定自己的三个哈希写进每条 resolution（§2）。
E2：`interactionTrace` 若只是被复制而没有真正绑定，验证会看不出差别。F2：无法区分"绑定了"和"抄了一句"。P2：断言它与独立冻结的世界选择一致、且与 Host 自己的 trace 不同（§3）。
E3：新字段若也出现在 v9 回合上就是越界。F3：旧路径被静默改动。P3：v9 用例断言字段缺席（§3）。
