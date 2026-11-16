# 整树备份批次交接

基线：完整活动舞台批次隔离快照 `5675ce0f1986f6c6f4c509ef1b5ee127d5ed3224`，引用 `refs/codex-local/activity-stages-backup-baseline`。工作区 `/workspace/Perspectra-save-tree-backup`，分支 `codex/save-tree-backup`。原 B10、全屏、护盾、MV、作者数值、活动舞台工作区保留；本批不提交功能、不推送、不建 PR、不合并、不进入 B11。

本批实现和用户操作见[整树备份指南](../../current/guides/save-tree-backup.md)。生产修改局限 Host 归档层、Launcher backend/store/dialog/file-picker。单节点格式保持原样，只导出已有校验函数供整树复用。

## 验证记录

Node 24.19.0，仓库锁定 pnpm 11.7.0，offline frozen lockfile 安装成功。测试使用临时 SQLite、真实 LauncherCore 与 WorldHostRuntime、本机假模型和注入的无费用记忆 runner；没有真实模型调用。

- 初始相关回归：`pnpm exec vitest run --config vitest.config.ts tests/host/rpg-story-share.test.ts tests/desktop/launcher-core.test.ts`：41 通过，1 失败。失败是既有 `revoke still applies immediately` 调用 Windows DPAPI，在 Linux 明确报“受信任授权目前仅支持 Windows”，本批未修改。
- 整树测试初轮（2 项）通过：25.78 秒；两个独立数据根，主线＋两个独立旁支＋一个无保存头旁支，两个旁支同序号不同私密经历；保存时记忆原文与恢复节点逐文件比较；不同 RPG 护盾／侵蚀状态恢复一致；两个旧节点分叉续玩；重复导入创建新实例；恢复零模型；原树哈希不变；单节点分享兼容。精确字节重复快照夹具共用一个 world 对象，连续保存不变记忆文件也共用对象。
- 损坏集覆盖缺对象、错误编码／哈希、重复对象／节点、未知版本、父子循环／缺父／跨线关系、非法文件名、错包、未知提供者及同序号旁支错装记忆。全部拒绝，未公布实例。
- 最终相关持久化回归：`pnpm exec vitest run --config vitest.config.ts tests/desktop/story-tree-backup.test.ts tests/host/rpg-story-share.test.ts tests/host/story-save-api.test.ts tests/host/storyline-crash.test.ts`：4 文件 23 项通过，52.27 秒。实际子进程恢复时 SIGKILL，无实例发布；索引 rename 失败删除本次目录；中断后重试成功。
- 按复审建议补合法图／错误事件祖先负例，另补尺寸、条目数量、提供者版本与诊断文件排除断言；最终 `tests/desktop/story-tree-backup.test.ts` 3 项通过，34.79 秒。导出额外要求原节点清单声明完整的五个必要文件。
- `pnpm typecheck`、`pnpm --filter @perspectra/launcher typecheck`、`pnpm lint`、`pnpm format:check` 通过。Lint 原有警告保留，本批 unused import 已清理。`node scripts/check-host-boundaries.mjs`：444 个生产文件通过。
- `pnpm --filter @perspectra/launcher test`：9 文件 103 项通过，2.35 秒。
- `pnpm launcher:build` 与 `pnpm desktop:build` 退出 0；含 Launcher、创作者、Lens 前端和 Node 后端构建。不是原生 Windows 打包验收。
- `node scripts/docs/check-links.mjs`：104 个既有 missing target、103 个历史本地素材缺失，与基线相同；本批链接未新增失败。
- 浏览器：`node --import tsx tests/experiments/tree-backup-preview.ts` ＋ `pnpm launcher:dev`，Playwright Chromium 实际点击整树备份、取消文件选择、坏文件、桥接中断反馈、恢复成功；真实后端确认实例由 1 变 2。浏览器脚本在交付 ZIP 内；截图仅保留任务内，不上传。强杀中断是后端测试，页面连接中断用桥接夹具注入，不能混称浏览器强杀验收。

## 独立复审与交付

显式以 `gpt-6.1-sol` 启动独立代理 `save_tree_sol_review`（fork none），只读审查未发现阻断缺陷；独立 3 项整树测试通过，35.87 秒。建议增加“合法图但实际祖先前缀错误”的负例，主代理已补齐，代理复核两处增量（该测试及导出文件清单加严）无新增问题；主代理最终 3 项复验通过。另有旧复审代理独立只读交叉检查与单节点导入后整树导出检查通过，但不把它的无法自证型号当作型号依据。

六个原工作区的 HEAD、索引、status 和完整 diff SHA-256 均逐项复核一致，记录位于 `.tmp/save-tree/preserved-worktrees.json`。功能保留未提交差异；独立补丁及 ZIP 位于 `.tmp/save-tree/`，只相对上述隔离快照，不含继承批次。

环境边界：不宣称 Windows 原生 Tauri、真实桌面选择器、真实模型或发行验收。浏览器通过测试桥接本机真实 Launcher backend；文件选择返回值由夹具代替原生对话框。独立 GPT-6.1 Sol 审查与主代理复验已完成。
