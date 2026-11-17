# CI 检查说明

例如两位玩家分享一个带角色记忆的历史故事节点，测试需要启动真实本机记忆运行时。开发机恰好有 E5 资产，并不代表 GitHub 托管机器也有；流水线必须明确准备环境，才能判断分享、隔离和恢复逻辑是否回归。

## 已确认的问题与边界

2026-11-17 核对 GitHub 失败记录和本地主线源码：

- [主线 12bf03c1 的运行](https://github.com/YouLan5418/Perspectra/actions/runs/44018256151)通过了类型、边界、Lint、格式、Launcher 测试和构建，默认回归运行约 28.5 分钟后以 2,496 通过、1 失败结束；唯一失败是 `tests/desktop/story-nodes.test.ts` 的历史节点分享场景，缺失 Python 记忆环境。
- [2026-11-07 主线运行](https://github.com/YouLan5418/Perspectra/actions/runs/42379603696)也有相同环境错误，同时包含插件错误提示和玩法时间断言失败。[Node 记忆开发分支运行](https://github.com/YouLan5418/Perspectra/actions/runs/44019811460)还有多项真实行为断言失败，不能统一归为环境偶发错误。
- 本次修改基于本地 `b74519a4` 及其 Node 记忆迁移前置提交。当前记忆入口已经使用 Node worker 与固定 E5 资产；因此本流水线准备 Node 原生依赖和 E5，不补回已退役的 Python 运行时。旧提交需要它自身适用的环境。

上述日志证明旧流水线的问题，不证明新配置已经在托管机器通过。工作流静态校验、本机测试与 GitHub 首次运行的结果必须分别记录。此次范围仅为 CI。

## 任务与触发

[工作流](../../../.github/workflows/p0.yml)保留 `Prototype checks` 名称及最终 `check` 检查，使用下列独立任务：

| 任务 | 实际验证 | 任务上限 |
| --- | --- | --- |
| Static checks | TypeScript、生产路径边界、Lint、格式 | 15 分钟 |
| Launcher checks | Vue 类型、Launcher 单元测试、Launcher／创作台／透视前端构建 | 15 分钟 |
| Regression 1/4–4/4 | 全部默认回归，每片一台机器、片内文件串行 | 每片 30 分钟 |
| Runtime build checks | 后端与记忆资源构建、隔离创作 CLI 实际执行 | 15 分钟 |
| check | 检查全部前置结果，任何失败、取消或跳过均不通过 | 5 分钟 |

自动运行于向 `main` 的 push、所有 pull request 和合并队列；任意分支可通过 `workflow_dispatch` 手动验证。不再对每个未开 PR 的实验分支 push 自动运行；同一 PR 的更新会取消过期运行。推送主线与 PR 事件分属不同并发组，不会相互取消。不使用路径过滤，避免必需检查因文件分类缺失而一直等待。矩阵 `fail-fast: false` 保留其他分片的结果。

分片直接使用 Vitest 的 `--shard=N/4` 与原有 `vitest.regression.config.ts`，没有维护另一份易遗漏的测试清单。`tests/experiments` 仍按原有默认配置排除；这次没有扩大排除范围，也没有降低断言或加入测试重试。

## 环境与失败诊断

[共用准备动作](../../../.github/actions/setup/action.yml)读取 [.node-version](../../../.node-version)，通过 Corepack 调用锁定的 pnpm，执行 frozen-lockfile 安装。只缓存 pnpm 下载存储，不缓存 `node_modules`；缓存键包含平台、架构、Node 版本和依赖锁定配置。

回归和后端构建还会缓存六个固定 E5 文件；缓存键关联 [E5 资产清单](../../../packages/memory-core/e5-assets.json)。每次都执行 [资产准备脚本](../../../scripts/setup-memory-assets.mjs)，缺失时下载、存在时仍验证 SHA-256；失败直接结束准备。随后 [环境检查](../../../scripts/ci/check-environment.ts)实际执行内存 SQLite 查询与一次 384 维 CPU E5 编码并关闭资源，不访问模型网关。

定位失败时先看具体任务和步骤：

1. 安装、资产下载、哈希校验或原生推理失败：修复该运行的依赖或托管环境；没有到测试阶段就可能没有 XML。
2. 测试失败：查看对应分片的日志与 `regression-N-运行尝试号` JUnit 工件；Launcher 使用独立报告。只上传指定 XML，不上传世界、模型请求、存档或整份临时目录。
3. 构建失败：查看前端、后端或隔离 CLI 的具体步骤；编译通过仍不表示原生窗口通过验收。
4. 汇总 `check` 失败：其摘要列出每个前置任务结果，回到实际失败任务调查；汇总不会把取消或跳过当作通过。

JUnit 工件保留 14 天，包含运行尝试号以支持重跑。工作流只授予仓库内容读取权限，不需要模型凭证，也不写入 Release 或部署服务。

## 本地复现

先使用 `.node-version` 对应的 Node，再在仓库根目录执行；每条命令失败后应先修复原因。

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
node scripts/setup-memory-assets.mjs .tmp/hindsight-e5-small
node --import tsx scripts/ci/check-environment.ts

# 静态检查
corepack pnpm@11.7.0 typecheck
node scripts/check-host-boundaries.mjs
corepack pnpm@11.7.0 lint
corepack pnpm@11.7.0 format:check

# 某一回归分片；N 使用 1、2、3、4
corepack pnpm@11.7.0 test --maxWorkers=1 --shard=1/4 --reporter=default --reporter=junit --outputFile=.tmp/ci/regression-1.xml

# 完整默认回归
corepack pnpm@11.7.0 test --maxWorkers=1

# Launcher 与构建检查
corepack pnpm@11.7.0 launcher:check
corepack pnpm@11.7.0 launcher:build
corepack pnpm@11.7.0 desktop:build
node scripts/release/verify-worldpack-cli.mjs
```

本机复现还可能受到受限沙箱的进程终止权限影响；需要 `taskkill` 的测试应在具备权限的环境验证，不能靠跳过来修复。工作流不构建 Tauri 或完整便携发行包，不运行真实模型，不声明跨平台、干净 Windows、长局平衡或角色自然度已经验收。首次托管运行的实际分片耗时尚未测量，30 分钟是任务中止上限，不是已达成的性能承诺。

## 本次本地验证

2026-11-17，Windows / Node 24.14.1：

- `actionlint`、根类型检查、生产边界检查、Lint、完整源码格式检查通过。直接运行工作流中的汇总脚本，确认只接受全部成功，拒绝前置失败、取消和跳过。
- 资产脚本核验六个固定 E5 文件；SQLite 与真实 CPU E5 推理通过。另行指定不存在的资产目录时，环境检查明确失败，没有跳过推理或继续运行测试。
- 使用已安装 Vitest 的实际分片器核对全部 274 个默认测试文件：四片为 69、69、68、68，合计与默认发现完全一致，没有遗漏或重复。`vitest list --filesOnly` 本身不执行分片，不能直接用它的四份列表证明分片覆盖。
- 首次完整串行回归覆盖 274 个文件、2,545 项：2,544 通过、1 失败。唯一失败是自主行动场景中的测试替身：角色完成移动后，后续普通反应仍带有自身目标，替身误将它视为新的移动机会，在只剩表达预算时返回非法 `perform`。
- 修正该替身：只在允许行动且尚未到达目标房间时提出移动；从实际的离场决策与结果续写识别目标处理过程，继续检查自主调用预算、提交结果、位置及私密信息隔离。运行时和调度器没有修改。修正后该场景连续 12 次独立运行通过，所属文件 22 项全部通过；没有再重复整个完整套件。证据保存在本机 `.tmp/ci/full-regression.xml`、`autonomy-fixed.xml` 及相邻日志中。
- Launcher 103 项测试、Vue 类型及三个前端构建通过；后端构建与隔离创作 CLI 验证通过。隔离 CLI 使用新建的工作树内临时目录和正常权限，未读取历史世界，也未调用真实模型。
- 文档导航检查仍有原有的 103 处历史源码断链，本次修改的文档没有断链，模块地图没有遗漏。这些历史研究文档不加入本次 CI 门禁。

以上记录属于首次推送前的本机验证；GitHub 托管结果以相应提交的工作流运行记录为准。本流水线依赖 Node 记忆迁移提交，必须一起同步，不能只把 YAML 放到尚未迁移的旧主线上。

配置依据：[GitHub 工作流语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)、[Vitest v4 CLI](https://v4.vitest.dev/guide/cli)、[Vitest v4 报告](https://v4.vitest.dev/guide/reporters)。
