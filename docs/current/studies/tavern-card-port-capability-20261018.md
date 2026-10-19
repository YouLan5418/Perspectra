# 酒馆角色卡迁移到 v5 世界包的能力对照（2026-10-18）

> 2026-10-19 再次扩展：状态已支持作者 Schema 约束的对象、数组，操作 policy 和知识 when 都按接收者已知状态判断；已接通领奖菜单和条件材料样例。下面“不按状态条件激活世界书”等句子仅描述此前版本。仍无完整 MVU 导入、叙事更新解析、EJS 运行或任意楼层重演；类型、限制与已验证范围以[当前状态指南](../guides/activity-and-variables.md#3-状态2026-10-19当前源码)和[世界设定指南](../guides/world-knowledge.md)为准。

> 2026-10-19：MVU 的客观值（金钱、HP、时间、剧情阶段等）现在可由[状态](../guides/activity-and-variables.md#3-状态2026-10-19当前源码)承接：作者在 `scripts/status.js` 声明状态和改变它们的操作，所有变化经作者脚本裁定后以世界事件提交；玩家状态栏 `PlayerView.statusBar` 和角色上下文只显示各自已知的值。模型仍不能直接写值，`<UpdateVariable>` 这类叙述内更新不被解析，每条可写字段须改写成 resolve 分支；没有 MVU 导入器，也不按状态条件激活世界书。下文第 3 条和方案 A 的“缺”是此前的历史对照；好感度这类角色态度仍不做成数值。

> 同日后续：关键词世界书已有最小对应——[按需设定](../guides/world-knowledge.md)（常驻／关键词／优先级／字符预算，按角色权限交付）；`world_context` 文档因此有了运行时消费者。文档与登记文件上限已从 512 放宽到 4096，知识预算上限放宽到 65536 字符，563 条与 4 万字单条不再超限。下文的“缺”和超限数字是放宽前的历史对照；通用酒馆卡导入器仍未实现。

被测对象是一张体量偏大的酒馆（SillyTavern）角色卡 `chara_card_v3`：563 条关键词世界书（1.20 MB 正文）、50 个角色各带 Pro/Lite 两版人设、一套 MVU 变量框架（8 个脚本、约 860 KB）、22 条正则脚本，以及 16 个"开局"。

结论先说：**卡的三条体验主线在宿主都有对应机制，但其中两条的承载通道当前是缺的。** 剧情推进与角色扮演可以直接落到活动脚本和认知记录上；"状态随时可见"（状态栏、好感度、时间地点）和"关键词触发世界书"没有对应通道，只能靠活动 public 或角色私有记忆近似，而这两处恰好是这张卡反馈回路的核心。

本文只做能力对照与缺口定位，不建包、不调用真实模型。所有上限数字来自宿主源码与两个离线探针，未经验证的部分单列在最后一节。

## 一、被测对象

用 [卡探针](../../../tests/experiments/tavern-card-probe.ts) 解析原始 PNG 的 `chara` 文本块得到：

| 维度 | 数值 |
| --- | --- |
| 世界书 | 563 条、1.20 MB 字符、常驻 35 条、关键词触发 529 条、单条最大 39,734 字符 |
| 角色 | 50 个，各 1 条 Pro + 1 条 Lite（Pro 默认全部停用、Lite 默认启用 48 条） |
| MVU 变量 | 根 schema 含 `当前时间/所在地点/剧情显示/剧情权重/当前演绎事件/主角信息/女性角色{好感度…}/剧情触发器/伏笔`，`女性角色` 是 `Record<角色名, CharacterSchema>` |
| 玩法脚本 | `变量结构`48 KB、`剧情数据库`47 KB、`剧情逻辑`107 KB、`世界书控制`203 KB、`飞讯`367 KB、`CG图鉴`85 KB |
| 正则脚本 | 22 条，含状态栏渲染（替换文本 180,757 字符）与开场 UI（170,356 字符） |
| 开局 | `first_mes` + 16 条 `alternate_greetings`，每条 = 场景描写 + `<options>` 选项 + `<UpdateVariable>` 初始变量 + 状态栏占位 |

卡自身的循环是：**选开局 → 模型每回合输出对白 + 变量更新块 → MVU 脚本合并变量 → 状态栏渲染 → 剧情逻辑脚本按变量算出下一个事件节点并回写**。

## 二、对照表

| 卡的机制 | 宿主对应 | 判定 | 证据 |
| --- | --- | --- | --- |
| 玩家选项菜单 `<options>` | 活动 `operations` + `policy.speech` | 直接可用 | [activity.js:683](../../../examples/world-packs/model-girls-official/scripts/activity.js) |
| 剧情逻辑控制器（按变量算下一节点） | 活动脚本 `policy/resolve/onPublished/simulate` | 直接可用 | [活动与变量](../../current/guides/activity-and-variables.md) |
| 角色私密资料、各有秘密 | `cognition.json` 按角色分节 + `basisKeys` 同角色校验 | 直接可用 | [schema.ts:505](../../../packages/world-pack/src/schema.ts) |
| 50 个角色 | `MAX_CHARACTERS=256` | 声明可行 | [schema.ts:130](../../../packages/world-pack/src/schema.ts) |
| 好感度 / 关系阶段 | `cognition` 的 relationships/affects，或活动 public | 需变通（数量受限） | standard 档 relationships 16、affects 8 |
| 每回合变量更新（模型写 stat_data） | 模型侧变量只读，写只能由作者脚本裁定 | **缺** | 全仓无模型写变量路径 |
| 状态栏 / 常驻状态面板 | `PlayerView` 封闭，SDK 无变量通道 | **缺** | [player-view.ts:5](../../../packages/frontend/src/player-view.ts) |
| 563 条关键词世界书 | 包内无关键词声明字段；召回 = 角色记忆全文词元检索 | **缺** | [schema.ts:361](../../../packages/world-pack/src/schema.ts) 拒未知字段 |
| 长文本知识入库 | `documents.json` + `usage:"memory_seed"` → 该角色一条初始 observation | 部分可用 | [compiler.ts:553](../../../packages/world-pack/src/compiler.ts) |
| `world_context` / `portrayal` 文档 | 编译进 manifest，无运行时消费者 | 未接通 | 仅 [world-spec.ts:249](../../../packages/kernel/src/world-spec.ts) 引用 |
| CG 图卡、立绘 | 无内置机制；自定义前端可放图并 `resource()` 取 URL | 需自建 | [frontend-v1.md:44](../../current/frontend-v1.md) |
| 16 个开局 | 无多开局概念；player-slots 恰好 1 个 | 需变通 | [schema.ts:1120](../../../packages/world-pack/src/schema.ts) |
| 22 条正则（去 AI 腔等） | `preset:import` 可转成 input/history/display 三阶段文本规则 | 数量超限 | 见下节 |
| 状态栏/开场两条巨型替换 | 替换文本上限 4,000 字符 | **会被跳过** | [preset.ts:56](../../../packages/provider-chat/src/preset.ts) |

## 三、缺口（按对还原体验的影响排序）

**1. 状态不可见。** 卡的反馈回路靠状态栏把"好感度、时间地点、剧情节点"持续摆在玩家眼前。宿主的 `PlayerView` 字段封闭，`history` 项只有 `{seq,speaker,text,player,segments}`，`packages/frontend` 全包检索 `variables` 为 0 命中，[frontend-v1.md:44](../../current/frontend-v1.md) 也写明 public variables 不暴露。自定义前端能渲染任意 HTML 和图片，但拿不到变量，好感度只能塞进活动 public 或由前端从对白里猜。**这是当前最大的体验缺口：机制在跑，玩家看不见。**

**2. 世界知识无法按关键词进入上下文。** v5 清单的键是封闭的（`exactKeys` 直接拒绝未知字段），包内没有"关键词 → 条目"的声明位置。运行时的召回是角色记忆池的全文词元检索：`DEFAULT_RECALL_LIMIT=10`，渲染时再按档位截到 6/16/32 条，没有分组优先级。这意味着 563 条世界书里，每回合真正能进上下文的只有十几条，而且无法由作者指定"提到黑海岸就注入这几条"。

**3. 模型不能写变量。** MVU 的核心是模型每回合直接产出 `<UpdateVariable>` 并合并进 stat_data；宿主模型侧的 `packVariables` 是只读的。要还原，必须把每个可写字段改成作者脚本里的 `resolve` 分支——这会把一张声明式的卡变成手写状态机。

**4. 没有多开局。** 想让玩家选开局进入不同初始场景，现有做法只有活动菜单 + 后续 move（官方序章就是这一种，且只在单场景内分支）。

**5. 文本规则上限 32 条、替换文本上限 4,000 字符。** 探针实测这张卡的 22 条正则会展开成 38 条，直接被校验器拒绝；状态栏和开场两条巨型替换会被跳过。好消息是 `preset:import` 的三阶段映射本身是对的，"去 AI 腔"那 6 条短规则可以原样转过去。

## 四、已核实的证据与复跑方式

全部离线，不建包、不调用模型。

~~~powershell
# 卡侧对照（读卡 JSON，输出与宿主上限的差距）
node --import tsx tests/experiments/tavern-card-probe.ts <角色卡.json>

# 酒馆预设转换器（真实调用，验证文本规则映射）
corepack pnpm@11.7.0 preset:import <酒馆预设.json> --out <输出.json>
~~~

探针实测输出（本机，2026-10-18）：

- 世界书 563 条 > `MAX_DOCUMENTS` 512，超 51 条
- 22 条正则 → 38 条文本规则，`rolePreset` 抛 `文本规则数量超限。`
- 超长替换：`[开场白]鸣潮开场`（170,356 字符）、`[状态栏]MVU浪潮状态栏`（180,757 字符）

另外用临时探针包（`.tmp` 下，非交付物）实测了 `documents.json` 的真实行为，用于确认这条通道可不可用：

| 探针 | 结果 |
| --- | --- |
| `world_context` + `public` 文档 | `status: valid`，packHash `2d47f36d…` |
| 文档从 1 条改到 2 条 | packHash 变为 `cd283b8c…`（内容参与摘要） |
| `usage` 非法值 | `PACK_SOURCE_INVALID`：must be one of: world_context, portrayal, memory_seed, author_note |
| `contentRef` 指向不存在的 Markdown | `PACK_REFERENCE_INVALID` |
| `portrayal` + `public` | `PACK_SOURCE_INVALID`：portrayal usage requires character_private audience |
| 513 条文档 | `PACK_LIMIT_EXCEEDED`：must contain at most 512 documents |
| 改 `characters.json` 显示名 | packHash 变化，改回则复原 |

（首次探针漏写了 `worldpack.source.json`，`documentFiles` 仍为空数组，得出过"documents 不参与摘要"的错误结论，已修正并重跑。结论以本表为准。）

## 五、建议的下一步

按"先让体验闭环、再补机制"的顺序，三个候选：

**A. 补状态可见性。** 让 `PlayerView` 暴露一份作者声明的只读状态（例如活动 public + 包变量的白名单投影）。收益最大：它决定玩家能否感知好感度和剧情进度，也是这张卡区别于普通对话的核心理由。风险是动 `player-view.ts` 这个被前端共享的契约。

**B. 补知识注入。** 给包增加"知识条目 + 触发词 + 分组"的声明位置，或在现有 `documents.json` 上增加召回条件。收益是让 1.2 MB 世界知识真正可用；代价是要动 `worldpack-source/v5` 这个封闭 schema，并牵动 ADR-0088/0090 从 Proposed 落地。

**C. 先用现有机制硬拼一个最小切片。** 3 个角色、1 个开局、20 条知识种子、一份活动脚本，跑一次真实模型试玩，把上面这些"从代码推断的缺口"换成体验证据，再决定补哪个。

**建议 C → A → B**：项目自己的规则是"真实试玩发现的体验退化优先调查"，而现在的缺口全部来自源码阅读，还没有一次真实对话证明玩家真的会因为看不到好感度而体验受损。

## 六、未验证与已知限制

- 没有创建世界包，没有启动游戏，没有调用真实模型；本页所有判定都来自源码阅读与两个离线探针。
- 未验证 `memory_seed` 文档在真实会话里的召回质量（一条 39 KB 的条目能否被词元检索命中）。
- 未验证 50 个角色同场时的调度表现；已知同场可见主体在 standard 档上限 48，一轮实际调度约 2 人、最多 8 次调用。
- 未验证自定义前端在真实宿主里的变量替代方案（把好感度塞进活动 public）是否够用。
- 卡的 `creator_notes` 声明仅限指定平台发布、禁止转载；任何后续移植只作本机私有实验，不产出可发布包。
- 仓库根及多个子目录存在 0 字节 `nul` 文件（Windows 重定向残留），会让 `rg` 直接报错，检索需改用 Node 或绕开。
