# 官方 RPG 作者声明战斗数值

明确需求：作者需要暴雨、耐火、怒气和架势等命名数字实际参与战斗，不想改引擎代码。本批用已有活动持久数据和声明式效果解决；未增加核心事件总线、脚本、世界可写地址或第二份存档。

## 隔离

MV 批次已完整收尾，独立补丁在 `/workspace/Perspectra-rpg-mv/.tmp/rpg-mv/feature.patch`。Library 已确认上传 `Perspectra-MV-battle-review.zip`，文件 ID `file_00000000b07c81f59d3bb66a6a586d81`、Library ID `libfile_87d1955bbec4819185118803b6d560fe`。

本批从最终 MV 快照 `4cc5f9d441cfe9437d7c3d6ac718dcc2b7ad5b3d`，引用 `refs/codex-local/rpg-mv-values-baseline`，在 `/workspace/Perspectra-rpg-values`、分支 `codex/rpg-author-values` 独立施工。使用替代索引快照，包含全部跟踪和新增有效文件，不含 ignored 产物；原 B10、全屏、护盾和 MV 工作树不更改 HEAD/索引/差异。没有 push、PR、合并、发布或 B11。

## 实现与取舍

[作者指南与最小例子](../../../examples/rpg-values/README.md)定义字段、费用、伤害和触发时序。共享值一份，单位资源每人一份，属性基础来自配置、状态修正只参与集中读取。资源费用和条件与普通费用、合法目标一起判定；玩家、同伴、敌人共享同一规则和效果解释器。Schema 与运行时解析器都扩展，Lens 静态展示和正式编译使用相同配置。

有限触发仅存活单位实际 HP 损失后加资源，以及正数归零施加状态。归零状态不能递归写资源，重复零值不重复结算。全体技能的 actor/shared 写按效果位置一次，target 每目标一次。数值默认在场参与者公开；没有隐藏值声明，投影不扩大普通活动权限。战斗外仍不写回世界属性。

持久版本 3/支持 `[3]`；无旧存档兼容。已有官方包没有声明 battleValues 时使用空表，仍只有同一解析和结算格式。MV 基线 2 的历史记录不追改为 3；当前作者文档和实例使用本批语义。

## 验收记录

Node 24.19.0，锁定 pnpm 11.7.0；离线 frozen-lockfile 安装。所有命令设置 `COREPACK_HOME=/tmp/perspectra-corepack`。施工前基线：3 文件16项通过，10.09 秒。初期既有 MV/护盾/授权投影回归：4 文件19项通过，10.04秒。

实际结果（不同集合有重叠，不能直接相加）：

| 范围 | 结果 |
| --- | --- |
| RPG/Host/SDK/前端主回归 | 26 文件237项通过，76.58秒 |
| B9/Lens/组合/正式玩法及通用原型 | 7 文件72项通过，71.37秒 |
| 审查修复后效果/Schema/投影/新旧Host | 6 文件27项通过，19.38秒 |
| 数值 Host 含暂停/恢复/保存分支重开追加复验 | 1 文件3项通过，10.80秒 |
| 旧 MV 正式 CLI | 8 步通过，startup 1229ms、compile 204ms、initialize 565ms、execution 1197ms、cleanup 6ms |
| 新数值正式 CLI | 6 步通过，含房外不知怒气/架势/暴雨/破防；startup 1236ms、compile 217ms、initialize 636ms、execution 972ms、cleanup 10ms |
| 类型、Lint、变更格式、生产边界、Node 后端构建 | 类型/Lint/格式/build 退出0；边界440生产文件通过，Lint保留既有warnings |
| 文档链接 | 104条既有断链、103项历史本地资源缺失；不修无关旧失败 |

CLI 时间是当前 Linux 容器真实边界，不是模型速度或 Windows 性能。命令中的 pnpm 均指 corepack pnpm@11.7.0：

```sh
pnpm test:related packages/plugins/src/rpg tests/host/rpg-values.test.ts tests/host/rpg-mv.test.ts tests/host/rpg-effects.test.ts tests/host/rpg-perform-path.test.ts tests/host/rpg-pack.test.ts tests/host/rpg-story-share.test.ts tests/host/rpg-map-activity.test.ts tests/host/rpg-battle-stage.test.ts tests/host/lens-rpg.test.ts tests/host/frontend-api.test.ts tests/host/frontend-reading.test.ts packages/sdk --maxWorkers=1
pnpm test:related tests/host/lens-simulation.test.ts tests/host/lens-cli.test.ts tests/host/official-gameplay-path.test.ts tests/host/pack-composition.test.ts tests/host/gameplay-presentation.test.ts tests/scenarios/rpg-core-activity.test.ts tests/scenarios/rpg-turn-battle.test.ts --maxWorkers=1
pnpm test:related packages/plugins/src/rpg/battle-values.test.ts packages/plugins/src/rpg/combat-effects.test.ts packages/plugins/src/rpg/battle-view.test.ts packages/plugins/src/rpg/config-schema.test.ts tests/host/rpg-values.test.ts tests/host/rpg-mv.test.ts --maxWorkers=1
pnpm test:related tests/host/rpg-values.test.ts --maxWorkers=1
pnpm exec tsx tests/experiments/rpg-mv-simulate.ts
pnpm exec tsx tests/experiments/rpg-values-simulate.ts
pnpm typecheck
pnpm lint
node scripts/check-host-boundaries.mjs
pnpm desktop:build
node scripts/docs/check-links.mjs
```

真实 Chromium 使用正式 Host、SQLite、iframe/SSE 和受控 perform：压制两次、怒击双击只扣一次、唤雨与雨中火球；玩家怒气0→3→6→4，敌人架势4→2→0，持续打零架势不刷新破防；共享雨量2→5，最终敌HP87/玩家HP25。通用卡片显示同一数值并可继续操作，全屏切换不改变状态，375×812窄屏与宿主按钮正常。原始证据 `.tmp/rpg-values/browser-results.json`，截图在同目录，交付包不携带截图或完整模型上下文。

独立 GPT-6.1 Sol `rpg_values_review` 发现 P2：致死后 break 跳过后续 actor/shared 写。修复为只跳过依赖存活目标的效果，并加单体/全体致死、费用归零、恢复再归零回归。审查者独立复现雨量2→3，重跑3文件10项通过，11.15秒，确认关闭；没有剩余确定阻塞。审查者没有独立运行浏览器。

中间失败如实记录：类型检查曾发现可选属性被显式赋 undefined，已收窄；新CLI首轮把伤害前生命误写91（实际92），修正预期后通过。另一次额外试验在重生成后继续操作，历史事件读取的雨量仍为2而非5，未定位为产品或测试读取问题，未修改核心；本批重放验收限定为流程末重生成状态一致，不能声称候选重生成后继续游玩已验收。正常连续操作、保存分支重开后继续操作均实际通过。

未跑全仓check、原生Windows/Tauri或发行验收。未使用真实模型或计费 API，SQLite 与模型替身均在隔离临时目录／本机环回端点。未修前批多人浏览器写租约问题，不将无头多人测试称为浏览器多人验收。

## 阅读路线

examples/rpg-values/effects.json → config.ts/value-config.ts/config-schema.json（声明与引用验证）→ battle-values.ts（边界和前置条件）→ battle.ts initialize/readValue/changeValue/applySkill/hurt（活动权威状态）→ 原活动提交 → battle-view.ts（授权白名单）→ battle-stage.ts/通用卡片 → tests/host/rpg-values.test.ts（真实提交与重放）。


## 独立交付

本批差异 `.tmp/rpg-values/feature.patch` 基于 4cc5f9d，不包含上一批 MV 差异；当前功能未提交。交付 ZIP 包含本批补丁、完整作者配置/剧本、说明、测试摘要和交接记录。Library 是否成功以工具实际回执为准。原四工作树保留证据见 `.tmp/rpg-values/preserved-worktrees.json`。
