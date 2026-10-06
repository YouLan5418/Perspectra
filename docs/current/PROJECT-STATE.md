# 当前项目状态

> 更新依据：2026-10-06 状态与同日后台整理报告。下文提交／分支清理表和“未提交”说明保留收口当时记录，实时 Git 状态以仓库为准。现行运行机制见[当前架构](architecture/README.md)。

| 属性 | 内容 |
| --- | --- |
| 工作目录 | `D:/DeepSeek Harness/Perspectra V1` |
| 当前分支 | `main`，跟踪`origin/main` |
| 远端 | `https://github.com/YouLan5418/Perspectra.git` |
| 主线状态 | 认识/Delivery实验、网页Core接入、地点修复及文档整理已提交、快进合并并推送 |
| 分支与工作树 | 本地仅保留main及本工作树；origin仅保留main |
| 项目性质 | 多角色扮演原型实验；合入main不代表完整体验或桌面Core发布验收 |
| 当前记忆 | 默认原生记忆；源码网页通过`--memory-core`显式启用简化实验路径 |

后续体验与性能修改已在本工作区实现，尚未提交或发布：NPC提交后增量投影、网页Core长生命周期及Character固定认知无损压缩。AI美少女包真实复测与边界见[首轮优化报告](studies/ai-girls/optimization.md)；下文提交表和收口验证仍描述此前已合并的阶段。后续[31次输入的整理间隔实测](studies/ai-girls/memory-cadence.md)记录了新信息第9轮退出近期窗口、人工整理恢复、458秒整理阻塞与已整理细节交付遗漏。

## 1. 当前入口与实现边界

直接试玩或制作世界包见[试玩指南](guides/creator-playtest.md)和[World Pack手册](guides/world-pack-authoring.md)。开发边界见[AGENTS](../../AGENTS.md)及[当前原型契约](prototype-contract.md)。

简化Core记忆沿用授权Source，已改为宽短期窗口、按上下文体积自动整理并保留手动入口：原检索→简单ID准入→极简Delivery→Character。认识正文优先，保留来源类型、未解决反证存在标记及少量证据；不再要求全部支持证据属于direct observation/accepted action，也不要求整个Evidence Group完整进入预算。角色、世界、前缀和引用权限仍检查，JEV留作可选对照。首次整理前仍有近期上下文。

角色请求的`character.locationId`使用同一调用前缀的当前角色view，与`scene.locationId`一致。重要状态变化仍经Action/Rulebook/Event提交；自由叙事不能独立证明这些状态已改变。

具体命令和报告见[实验入口](../../experiments/activity-memory/README.md)、[记忆认知简化方案](../archive/memory-evolution/2026-10-05_记忆认知体系简化方案.md)及[最新双角色实测与地点修复](../../experiments/activity-memory/reports/report-normal-playtest.md)。模块职责与当时轨迹见[10月5日快照](../archive/prototype-g1-g4/PROJECT-STATE-2026-10-05.md)，旧分支布局见[10月3日快照](../archive/prototype-g1-g4/PROJECT-STATE-2026-10-03.md)；两份快照的分支和未提交状态只适用于当时。

## 2. 提交与验证

| 提交 | 内容 |
| --- | --- |
| `ce90f7e` | 保存认识谱系、极简Delivery及后续对照的源码、回归、审计与报告 |
| `88a3b63` | 简化网页Core召回并修复角色当前位置投影 |
| `2e25e99` | 整理项目入口、当前状态、实验入口和历史记录 |

以上提交快进合并到main；本收口文档随后单独提交。最终主线以`git log`和`origin/main`为准。

| Evidence | Finding | Path |
| --- | --- | --- |
| 提交前重新运行`corepack pnpm@11.7.0 check`：类型、Lint、27文件185项通过 | 当前原型默认自动检查通过 | 不把自动检查等同于真实体验验收 |
| Python实验`unittest discover`：66项通过 | 实验桥及相关局部回归通过 | 与网页真实角色验证分别记录 |
| `2e25e99`的GitHub Prototype checks成功 | 合并后的源码在远端Windows检查通过 | 后续文档提交的CI由Actions记录 |
| 既有真实模型复验：6次输入、1次整理、12次角色请求、38行Source | 地点字段与事件前缀一致，整理后召回与隔离正常 | 本次提交清理未增加模型调用；报告保留原实测范围 |

宽准入带来的无关记忆、持续目标牵引和整理等待仍需在更长试玩中观察。一般认识家族发现、通用多分支更新、完整G3体验和桌面Core打包尚未验收；合并时没有扩大这些范围。

## 3. 分支和工作树清理

清理前已校验全部旧工作树没有未提交的受版本控制文件，核对忽略数据，并验证Git bundle包含36个分支/远端引用及对应提交。已删除26个旧本地分支、origin上的3个旧实验分支和4个旧工作树，仅保留当前main。

已移除工作树：`Perspectra Action First`、`Perspectra Jev Auditor`、`perspectra-hindsight-core`和`perspectra-main-integration`。部分旧分支含独立实验提交，它们保存在bundle中，不因清理而自动合并其不同玩法。`legacy-cordis`远端未修改。

| 本机归档 | 内容 |
| --- | --- |
| `.tmp/git-closeout-20261006/branches-before-cleanup.bundle` | 清理前完整Git引用和可恢复历史，已通过`git bundle verify` |
| `.tmp/git-closeout-20261006/` | 原分支SHA、提交分组、bundle验证、数据搬迁计划和清理结果 |
| `.tmp/retired-worktrees-20261006/` | 旧工作树的`.tmp`及JEV工作树的`.workbuddy`数据 |
| `.tmp/simple-memory-playtest-20261005-v2/browser-artifacts/` | 正常试玩截图、快照与console证据，共8份 |

归档仍在本机忽略目录，没有上传GitHub。可重建的node_modules和Python缓存随旧工作树移除；当前树的Python环境、模型资产、数据库和私有trace保留。`D:/worlds`历史试玩数据及只读调研源码未修改。

需要恢复旧实验时，先在仓库根目录验证bundle，再读取指定旧引用。例如恢复Action First到新分支：

```powershell
git bundle verify .tmp/git-closeout-20261006/branches-before-cleanup.bundle
git fetch .tmp/git-closeout-20261006/branches-before-cleanup.bundle refs/heads/prototype/free-narrative-v0.1:refs/heads/codex/restored-action-first
```

后续从main开始做小规模、可回退的修改；依据真实失败回合选择下一项简化，不恢复旧实验为当前运行必经流程。

按用户后续要求，Core取消16/8条短期截断，保留角色授权工作历史；长期Delivery6项/12000字符沿前轮配置。当前长期整理在排队前冻结Source前缀，2个角色Build、每角色2个提炼批次有限并行，玩家/NPC继续游玩；只允许严格更新的前缀安装，失败/取消保留原档案和新经历。软触发实验默认约170k上下文、整理较老约120k，保留约16k原始重叠。详见[后台整理报告](studies/ai-girls/background-compaction.md)；[宽上下文记录](studies/ai-girls/wide-context.md)的200k/150k同步执行属于前一阶段。

同批196条Source、16次Utility真实重放，后台148.063秒，启动请求0.411秒，实际Utility峰值3、无超时/重试。期间对话与移动继续，安装后新暗号仍在原始尾部，房间隔离通过。关闭/失败/迟到结果及声明式交互由受控回归覆盖。默认check196项、相关38项和Python70项通过；尚未真实跨越170k或完成32k/64k/128k/192k对照，普通ReactionCycle仍出现一次30秒中断，桌面发行包未重建。
