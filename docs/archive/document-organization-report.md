# 纯文档信息架构整理报告（2026-10-06）

## 1. 新结构与数量

```text
docs/
  README.md
  current/
    PROJECT-STATE.md
    prototype-contract.md / baseline.md
    architecture/  # 五份当前说明与 README
    guides/        # 四份指南与 README
    studies/ai-girls/  # 五份研究与 README
  archive/         # 七组历史、迁移清单和本报告
  adr/             # 原编号保留
  spec/            # 冻结文档保留
experiments/
  README.md
  activity-memory/  # README / HISTORY / reports / 原代码资产
  hindsight-core/  # README / HISTORY / reports / vendor / 原代码资产
  jev-narrative-auditor/README.md  # 历史 run 原位
  active-recall/README.md         # 三个旧运行目录原位
```

移动 **227** 份文档（226 份 Markdown、1 份原文不变的历史 TXT 附件）：current 11 份、archive 169 份、实验 reports 46 份。逐文件原路径、新路径、分类理由和现行状态见[迁移清单](document-migration.md)。docs 根目录仅剩 README.md 与四个职责目录。

## 2. 当前入口与历史分类

current 保留唯一项目状态、原型契约、开发基线、五份架构说明、四份运行／创作指南和 AI Girls 研究。新增 architecture、guides 索引；仓库 README 直达运行时、Interaction、认知记忆、创作者与最新研究，相关问题在 1—3 次跳转内可读。

历史按 V0/Phase 0—6、Phase 7—9C、Character Interaction C0—C4、Interaction Abstraction I0—I7、Prototype G1—G4、memory-evolution、reviews 七组分类。每组有完整文件索引；无法作为现行结论的方案保留归档，不据此判定其全部机制已废弃。旧项目状态快照完整保留，不删除有内容的历史文档。

## 3. experiments 与 README

Activity Memory 31 份详细报告进入 reports，README 保留现行准备、路径、证据与限制，HISTORY 保留历史命令。Hindsight 15 份报告／阶段设计进入 reports，旧 README 全文保存到 HISTORY，新 README 区分实际复用、未复用、运行方式及实验结论。没有合并或压缩原始实验报告。

JEV 新入口解释 shadow、intervention、placement、holdout、custody 与停止默认纠错的结论；active-recall 新入口索引三条历史轨迹。日期运行目录、原始 JSON/JSONL、fixture、assessment、vendor、实验代码均保持原位。

新增 README：

- `docs/archive/README.md`
- `docs/archive/character-interaction-c0-c4/README.md`
- `docs/archive/interaction-abstraction-i0-i7/README.md`
- `docs/archive/memory-evolution/README.md`
- `docs/archive/phase-7-9c/README.md`
- `docs/archive/prototype-g1-g4/README.md`
- `docs/archive/reviews/README.md`
- `docs/archive/v0-phase-0-6/README.md`
- `docs/current/architecture/README.md`
- `docs/current/guides/README.md`
- `docs/current/studies/ai-girls/README.md`
- `experiments/README.md`
- `experiments/active-recall/README.md`
- `experiments/activity-memory/reports/README.md`
- `experiments/hindsight-core/reports/README.md`
- `experiments/jev-narrative-auditor/README.md`

## 4. 替代与保留

五份当前架构说明替代从历史实施报告拼接现行机制的阅读方式，不改变历史设计内容。旧 V0 手册因命令与覆盖率门禁过时归档；local-runbook 从现行 package scripts、试玩指南和基线提炼。Phase 7/8 旧创作者手册归档。最新日期状态迁移为活文档，两个旧快照归档。

`experiments/hindsight-core/dual-model-review-report.md` 被已保存的 `retrieval-pool-summary.json` 相对引用，因此不移动，reports 索引提供入口。active-recall 和 JEV 所有运行资产因复现／审计路径依赖保持原位。没有修改 JSON 产物来追随目录美化。

## 5. 链接与路径依赖

迁移阶段重写 672 处相对链接（含索引后续被重写的引用），另修复 3 处原有错误指向：ADR-0095 两处、跨分类历史报告一处。初始扫描有 15 处缺失引用，其中 ADR-0095 的 2 处已修复；另有原本有效、因跨分类移动需修复的报告链接 1 处。其余 13 处指向已缺失的历史测试／本机证据，保留标签与原路径，转为明确标注的历史文字引用，不伪造资产。

以下是本工作树缺失的旧引用（发生在整理前）：

| 历史文档 | 缺失路径 |
| --- | --- |
| `docs/archive/interaction-abstraction-i0-i7/2026-09-13_交互抽象-I0B运行黄金与契约准备.md` | `../../../tests/interaction-runtime-baseline.integration.test.ts` |
| `docs/archive/interaction-abstraction-i0-i7/2026-09-13_交互抽象-I0B运行黄金与契约准备.md` | `../../../tests/__snapshots__/interaction-runtime-baseline.integration.test.ts.snap` |
| `docs/archive/interaction-abstraction-i0-i7/2026-09-14_交互抽象-I4d第四片反应回合自身观察者分类.md` | `../../../tests/workers/action-group-crash-worker.ts` |
| `docs/archive/interaction-abstraction-i0-i7/2026-09-14_交互抽象-I4d第四片反应回合自身观察者分类.md` | `../../../tests/crash.test.ts` |
| `docs/archive/interaction-abstraction-i0-i7/2026-09-14_交互抽象-I4d第四片反应回合自身观察者分类.md` | `../../../tests/fixtures/character-interaction-world.ts` |
| `docs/archive/interaction-abstraction-i0-i7/2026-09-14_交互抽象-I5c冻结路径硬终止窗口.md` | `../../../tests/workers/action-group-crash-worker.ts` |
| `docs/archive/interaction-abstraction-i0-i7/2026-09-14_交互抽象-I5c冻结路径硬终止窗口.md` | `../../../tests/crash.test.ts` |
| `docs/archive/phase-7-9c/2026-09-05_测试报告-P9C.6长历史基准-report.md` | `../../../tools/measure-reaction-history.ts` |
| `docs/archive/phase-7-9c/2026-09-05_阶段报告-Harness-Cordis-World-Phase-9C.6-concurrency-report.md` | `../../../tests/p9-concurrency.integration.test.ts` |
| `docs/archive/prototype-g1-g4/PROTOTYPE-PLAYTEST-05.md` | `../../../.tmp/reaction-context-audit-20260920/call-09.md` |
| `docs/archive/prototype-g1-g4/PROTOTYPE-PLAYTEST-05.md` | `../../../.tmp/reaction-context-audit-20260920/call-12.md` |
| `docs/archive/prototype-g1-g4/PROTOTYPE-PLAYTEST-05.md` | `../../../.tmp/reaction-context-audit-20260920/call-11.md` |
| `docs/archive/prototype-g1-g4/PROTOTYPE-PLAYTEST-05.md` | `../../../.tmp/reaction-context-audit-20260920/audit.json` |


全局扫描代码、测试、脚本未发现需要修改的被移动文档引用；保留的 JSON 报告路径仍有效。最终相对文件链接和 current/新入口锚点检查结果见下文。外网链接不作可用性保证；本机私有绝对路径仅作为原有证据位置，不迁移或上传。

## 6. 内容冲突及处理

- 默认原生记忆与显式 Core 实验分开说明；JEV 不再作为简化路径必经步骤。旧 Hindsight 严格 Observation 扣留、3 项预算留在历史与独立对照说明中。
- 旧 16/8 窗口、6—8 轮建议及 200k/150k 同步整理保留为阶段证据；现行 Core 为约 170k/120k 软触发、16k 重叠和后台 2×2 有限并行。
- 试玩指南旧“整理暂停输入”更新为后台继续；V0 的 100% 覆盖率与崩溃矩阵不再伪装当前指南。
- 基线中的旧工作树、旧下一步及项目状态的提交快照明确标注历史范围；“当时未接入”不用于否定后续 Core 接入。

## 7. 验证与行为边界

本轮只修改 Markdown 和文档路径。未改运行逻辑、模型协议、数据库 Schema、Memory/JEV 算法、Interaction 行为、世界包、权限或事务提交；没有代码重构，没有删除历史实验数据、ADR 或复现报告。体验预期仅为更容易找到当前机制和证据，不声称提升角色行为。

`corepack pnpm@11.7.0 check` 通过：类型检查、Lint、27 个文件 196 项测试。`git diff --check` 通过。current 与新入口的锚点检查结果：2 处，0 处未解析。最终文件相对链接扫描见以下补充。未运行真实模型试玩、桌面打包、旧全量套件或硬崩溃矩阵：本轮不改变对应行为和事务边界。接受历史资产部分不可在当前树找到、研究小样本和大上下文尚未验收的限制。

最终扫描 364 份 Markdown、1209 个相对文件链接，缺失目标 0。13 处原有缺失资产仍按历史文字路径保留。current/新入口标题锚点 2 处通过；未全面检查历史标题锚点或外部网址。

Git 差异范围核对：非 Markdown 跟踪文件仅有历史 TXT 的位置变化。附件经 Git 换行规范化后对象 hash 与 HEAD 原文相同；运行代码、配置、依赖、世界包和实验产物无 Git 差异。迁移辅助脚本只在忽略的 `.tmp` 内。
