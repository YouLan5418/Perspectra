# 启动器改版：后端任务交接

给接手后端部分的实现者（GPT）。前端（`apps/launcher/src/**`、Vue 组件、样式、store）由另一位实现者同时进行，**请不要修改这些文件**。

## 先读

1. `AGENTS.md`（项目约束：中文沟通、TypeScript strict、ESM、显式 `.ts` 本地导入、短事务、不吞错误、不记录凭证）
2. 设计：`docs/superpowers/specs/2026-10-17-launcher-redesign-design.md`
3. 完整计划：`docs/superpowers/plans/2026-10-17-launcher-redesign.md`。下面列出的任务编号都指这份计划，任务步骤以计划为准，本文只说明分工和接口约定。

## 基线与分支

- 等 Task 0 完成后再开工。Task 0 指 `feat/launcher-model-connections` 已合入 main，且 `.superpowers/` 已加入 `.gitignore`。
- 从 main 新建分支 `feat/launcher-redesign-backend`，在独立 worktree 中工作。
- 每个任务单独提交，提交信息沿用计划中给出的写法。

## 你负责的部分

| 计划任务 | 你做的内容 | 不归你的部分（前端会做） |
|---|---|---|
| Task 1 | `PlaytestRuntime.saveNode`、`POST /api/story-save`、宿主页 `playtest-host-page.ts` 的“保存进度”按钮、删除 `playtest-web-entry.ts` 中的 `story-save` IPC 和 `launcher-core.ts` 中的 `case 'story-save'`、`tests/prototype/story-save-api.test.ts`、更新 `launcher-core.test.ts` | `apps/launcher/src/stores/launcher.ts` 的 `saveStoryNode`、`StorylineDialog.vue` |
| Task 3 | `tests/experiments/playtest-creator-assets.ts`、`/creator` 路由、`GET /api/creator-meta`、`playtest-web-entry.ts` 中的 `creatorMeta`、`tests/prototype/creator-page.test.ts` | 无 |
| Task 4 | `launcher-core.ts`：新增 `open-creator`，删除 `creator-debug / creator-history / creator-records / request-inspector` 透传；`main.rs` 中的 `validated_local_url` 和 `open-creator` 分支；`launcher-core.test.ts` | `apps/launcher/src/services/desktop.ts`、store 中的 `openCreator`、删除启动器内的创作者 UI |
| Task 5 | 全部 | 无 |
| Task 6 | 全部（依赖前端产出的 `apps/launcher/dist-creator`；前端没完成之前，可以先用 Task 3 测试里的假目录验证脚本逻辑） | 无 |

## 和前端约定的接口（不能改）

- `POST /api/story-save`
  - body：`{ title: string }`，长度 1–80；`trim` 后为空时，标题取 `保存于 HH:mm`。
  - 返回：成功 `200 { node: { id, title } }`；忙碌 `409 { error }`，`error` 为 `PlaytestBusyError.message`；无 token `401`；runtime 不支持时 `501`。
- `GET /api/creator-meta`
  - 需要 `x-playtest-token`。
  - 返回 `{ title: string; storyline: string; characters: { id: string; name: string }[] }`。
- 创作者页面静态资源
  - 访问 `/creator/` 时返回资源目录下的 `index.html`；访问 `/creator/assets/*` 返回构建产物。
  - 前端构建时 Vite 设了 `base: '/creator/'`，产物位置是 `apps/launcher/dist-creator/{index.html,assets/*}`。
  - 资源目录位置：开发模式为 `apps/launcher/dist-creator/`；发行模式为 `runtime/creator-assets/`。
  - 目录缺失时返回 503，正文包含 `创作者页面未构建`。
- 创作者页面沿用现有接口，形状不变：`/api/creator-debug`、`/api/creator-history`、`/api/creator-records`，以及 `GET|POST /api/request-inspector`。页面直接用同源 fetch 加 `x-playtest-token` 调用它们。
- core operation `open-creator`
  - 返回 `{ url: 'http://127.0.0.1:<port>/creator/#token=<64 hex>' }`；游戏未运行时抛出 `游戏尚未启动。`
  - Tauri 校验通过后，用系统浏览器打开这个地址，并返回 `{ opened: true }`，和现有 `open` 一致。

## 安全要求（必须测到）

- `/creator/` 路由不能被路径穿越：编码后的 `..`、反斜杠都要返回 404，只允许读取资源目录内部的文件。
- 不放宽宿主页现有 CSP，也不放宽现有 `open` 的 URL 校验。
- `frontend-revoke` 运行中仍然可用，且立即生效。运行中仍须拒绝的操作见计划 Task 5。

## 交付时请说明

- 跑了哪些测试：`corepack pnpm@11.7.0 test`、`launcher-core.test.ts`、`cargo check`、发行构建（如果跑了）。
- 哪些没有验证。
- 是否发现合并后的模型分配或连接 Key 会在运行中被读取（计划 Task 5 Step 3）。如果发现，只报告，不要扩大改动。
