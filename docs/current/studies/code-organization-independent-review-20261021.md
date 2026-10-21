# 代码整理独立审查与官方模型复测（2026-10-21）

同行者收到黄铜钥匙后实际交还玩家，独自先去后室；玩家随后跟上。只告诉同行者的虚构暗号，在 Core 整理、关闭源码后端并使用构建产物重开后仍能私下回答。留守者的实际请求和记忆档案未包含暗号。

本轮未发现阻止继续试玩的严重代码问题，但再次观察到保温壶保管叙述提前于正式拿取，并被另一角色短暂附和。自动化通过和世界状态正确不能消除这项体验问题。没有整理前的同模型对照，不能把它认定为本轮整理新增的回归。

## 审查对象与结论

- 工作树：`D:/DeepSeek Harness/Perspectra-code-cleanup-20261021`，分支 `codex/code-organization-20261021`。
- HEAD：`70788459751682fb037c5b9634ad99d15844fedd`，与本地 `main` 的共同基点以来的整理提交，以及审查开始时已有的 14 个已跟踪文件变更和新增 `.gitattributes`。已有修改包括删除独立 save-preflight CLI bundle、CI 构建检查、文案与文档收尾，均纳入本轮验证。
- 本轮只新增审查记录和忽略目录内的测试驱动、证据；没有修改生产逻辑、提示词、角色协议、规则或调度，也没有提交、合并或推送。

源码核对重点：

| 范围 | 结论与实现入口 |
| --- | --- |
| 玩家与 NPC 观察统一 | [action-observations.ts](../../../packages/application/src/action-observations.ts)保留完整/仅知发生的区别，移动起点与终点按见证权限分别交付；两条调用路径仍经过裁定和原子提交。玩家的完整原话仍受所有步骤受众条件限制 |
| WorldApplication 拆分 | [只读查询](../../../packages/application/src/world-read-queries.ts)、[管理操作](../../../packages/application/src/world-administration.ts)沿用分支访问与完整性守卫；这属于职责整理，不构成新的玩家权限接口 |
| 旧 Reaction Cycle 删除 | [world-schema.ts](../../../packages/store-sqlite/src/world-schema.ts)的 v20 删除旧表，当前 NPC 激活走现行角色路径。曾运行旧 Cycle 的存档不再保证可用，这是分支记录中已明确接受的不兼容范围；本轮未操作历史存档 |
| 宿主激活拆分 | [world-runtime.ts](../../../desktop/host/world-runtime.ts)仍先处理活动机会，再处理场景反应与自主机会；规则提交、权限投影和预算保持现行路径 |
| Core 文件迁移与发行路径 | [Python 路径](../../../desktop/host/memory/python-paths.ts)区分源码与安装根，[复制脚本](../../../scripts/build/copy-memory-runtime.mjs)共用运行载荷；自动测试覆盖隔离布局，本轮进一步验证构建产物用真实 Core 重开 |
| 格式化与 Launcher | 核对已修复的多语句 Vue 处理器、provider-chat 子路径导入；实际执行两次 Vite 构建，避免只依赖类型检查 |

仍存在可选的进一步整理：玩家与 NPC 的 Authority 构造、提交编排未完全合并，WorldHostCore 和部分 schema 文件仍较大。这些不作为本轮必须扩大的实施范围。

## 自动验证

| 检查 | 本轮结果 |
| --- | --- |
| `corepack pnpm@11.7.0 check` 的边界、类型、Lint、格式阶段 | 全部通过；边界覆盖 261 个生产文件，Lint 无 warning/error |
| 默认回归 | 144 文件 / 1338 项；沙箱内 1320 项通过，18 项因 `taskkill` 无法终止测试自建子进程失败 |
| 用户环境定向复跑 | `test:related tests/host/storyline-crash.test.ts tests/host/tail-round.test.ts --maxWorkers=2`，2 文件 / 37 项全部通过，58.48 秒；覆盖上述 18 项失败。因此不能把沙箱内整条 `check` 命令记为退出成功 |
| `launcher:check` | Vue 类型检查和 5 文件 / 44 项通过 |
| `launcher:build` | 主 Launcher 与 Creator 两次 Vite 构建通过 |
| `desktop:build` | 后端 bundle 构建通过 |
| 文档链接与差异空白检查 | 通过；新增本文后再次执行文档检查 |

没有修改测试断言、删除用例或用跳过来处理环境失败。两次执行合起来覆盖默认回归全部 1338 项；不是在同一环境中一次完整 `check` 全绿的证据。

## 官方 API 真实测试

凭证从已授权的 Windows 用户环境变量 `DEEPSEEK_API_KEY` 在进程内读取，只用于认证；模型目录实际返回 `deepseek-flash` 与 `deepseek-v4-pro`，本轮选择前者。生成请求均直达 `https://api.deepseek.com/chat/completions`，未使用 OpenCode、OpenRouter 或替代模型。数据写入全新 `.tmp` 目录，未读取或修改 `D:/worlds`。

| 场景 | 实际模型调用 | 结果 |
| --- | ---: | --- |
| 条件知识：19 步 | 42 | 全部 HTTP 200；知识选择 42/42 符合独立预期，越权活动材料交付 0 |
| 正式宿主：8 次玩家输入和一次重新生成 | 20 | 全部 HTTP 200；源码启动、构建产物重开和角色处理均无运行时错误 |
| 两角色的 Core Retain / Group / Consolidate | 6 | 全部 HTTP 200，均为首次尝试成功；12 条 started/finished 日志不能算成 12 次请求 |
| 合计 | **68** | **68 次生成请求成功**；模型目录、HTTP 状态轮询不计入 |

条件场景复用[既有驱动](../../../tests/experiments/knowledge-conditions-playtest.ts)，只在忽略目录的副本中替换官方认证、端点与模型，保留原测试场景和独立选择预期。涵盖场景人物、物品可见/保管、私语刺激、本人背景、状态新鲜度与活动本人私有材料。角色先明确旧余额 100 不确定，实际 perform 查看后才回答 130。活动里按作者提供的机会讲解自己的纸签，没有猜测别人或内部答案；但“纸料阴干、竹炭吸湿”等细节仍是模型扩写。

正式宿主组通过真实 HTTP API 驱动[web-entry.ts](../../../desktop/host/web-entry.ts)，默认 Python/E5 Core，未替换成原生记忆或 mock。启动请求采集后，对所有候选的记录按 record ID 去重，得到 20 次角色调用。私语检测结果：留守者 8 次实际请求均未包含虚构暗号，其 Core 档案也未包含；同行者的档案包含暗号，重开后私下复述正确。

两个角色的 Core 均安装前缀 148，约 15.2 秒完成：同行者 55 条 facts / 5 个 episodes / 4 条 observations，留守者 33 / 4 / 6。保存节点后通过 IPC 正常关闭源码后端，再用刚构建的 `dist/backend/playtest.mjs` 打开同一实例；转录、角色位置、物品状态以及两角色已安装档案逐项一致。再次对话成功，末端重新生成得到 2 个候选。此组未执行候选切回、历史节点恢复或分享导入。

条件组单请求中位数 1.216 秒 / P95 1.754 秒，宿主组 1.162 / 1.771 秒。一次玩家输入可能串接多个请求；这些数据不是性能 A/B。

## 已复现的体验问题

**P2：保管叙述提前于实际取得，且被其他角色短暂采用。**

| 证据 | 发现 | 后续定位路径 |
| --- | --- | --- |
| 宿主 `turns.json` 的 player-take，seq42、48、54；`analysis.json` 的 jarAt54 | 留守者先说“壶我先留着”“壶我拿着”，同行者 seq48 附和“壶他留着”；截至 seq54 壶仍为前室、无保管者。不是单纯触碰描写；另一角色已经短暂采用了未经裁定的保管说法 | [角色回合](../../../packages/application/src/character-turn.ts)、[模型上下文呈现](../../../packages/provider-chat/src/character-context-text.ts) |
| world 事件 seq68 的 `entity.transferred` 与最终 creator 真值 | 下一轮留守者才正式 take；最终保温壶由留守者保管，钥匙由玩家保管，完整性校验通过。文本没有直接修改数据库，但不能据此称语义一致性已经通过 | [基础交互](../../../packages/interactions-basic/src/index.ts)、[宿主](../../../desktop/host/world-runtime.ts) |
| [较早整理版本的官方试玩](code-organization-deepseek-playtest-20261021.md)已记录相似表现 | 当前样本再次复现，未证明是后续整理新增，也未证明已修复 | 对该具体场景做最小同模型复核；本轮不追加语义模型、过滤阶段或闭合动作枚举 |

条件场景中仍有重复确认和自行补充场景细节；宿主样本一轮触及反应预算。它们不构成已证明的程序权限漏洞，但属于继续改善体验的依据。

## 本机证据与未验收范围

- [条件组证据](../../../.tmp/review-official-7078845-conditions-20261021-01)：`calls.json`、`turns.json`、`summary.json`、`credential-scan.json`。
- [正式宿主证据](../../../.tmp/review-official-7078845-host-20261021-01)：`analysis.json`、`http.json`、前后重开快照、`reopen-check.json`、`saved-node.json`、`regenerated.json`、独立世界数据库和所有候选请求记录。
- [本机驱动](../../../.tmp/review-official-drivers-20261021)：官方适配的 conditions、正式入口的 host-smoke 与只读分析脚本。驱动与角色私有证据均未纳入版本控制；再次执行需要换新数据目录，并在进程内提供用户环境变量，不可把凭证写入命令或文件。

两个测试自建后端均已关闭。结束后再次扫描本轮驱动、两组数据与报告，凭证匹配为 0；结果保存在宿主证据目录的 `final-credential-scan.json`。

未做整理前同模型 A/B、长时间游玩、浏览器交互、Launcher 原生窗口、完整便携包和干净系统验收。近期原始记忆与档案存在重叠，因此重开后回答暗号不能独立证明长期遗忘后的召回质量。旧 Cycle 存档兼容没有恢复，也没有被本轮测试承诺。
