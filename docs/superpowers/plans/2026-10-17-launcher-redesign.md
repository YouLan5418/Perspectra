# 启动器改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把启动器改成米哈游启动器式的单屏窗口（封面 + 图标栏 + 本局抽屉 + 设置弹窗），创作者控制台搬到系统浏览器（含发行包），“保存进度”搬到玩家宿主页。

**Architecture:** 服务端（`tests/experiments/playtest-server.ts`）先补齐 `/api/story-save`、`/creator` 静态页和 `/api/creator-meta`；创作者页作为 `apps/launcher` 的第二个 Vite 构建入口，产物 `dist-creator` 在开发模式由服务器从仓库读取、发行模式从 `runtime/creator-assets` 读取。启动器端删除创作者与保存 IPC，放开运行中的设置写入，最后重做 Vue 外壳：`LauncherShell` = 标题栏 + 图标栏 + 封面主屏 + `SessionDrawer` + `SettingsWindow`，现有对话框的表单内容改成可嵌入的面板组件。

**Tech Stack:** Vue 3 + Pinia + Vite 7 + Tauri 2（Rust）、Node 24 + TypeScript strict（ESM，显式 `.ts` 本地导入）、vitest 4、esbuild（发行打包）。

**Spec:** `docs/superpowers/specs/2026-10-17-launcher-redesign-design.md`

## 分工

- **后端（交给 GPT）**：Task 1、3、5、6 全部，Task 4 的 core / Rust 部分。交接说明见 `docs/superpowers/plans/2026-10-17-launcher-redesign-backend-handoff.md`，在分支 `feat/launcher-redesign-backend` 上进行。
- **前端（Claude）**：Task 2、7、8、9 全部，Task 1 和 Task 4 中 `apps/launcher/src/**` 的部分，Task 10。在分支 `feat/launcher-redesign-frontend` 上进行。
- Task 0 两边共用，先做。两条分支都完成后合并，然后一起做 Task 10 的真实试玩。

## Global Constraints

- 基线是 `feat/launcher-model-connections` 合入 main 之后的代码；模型连接 / 角色模型分配的数据形状与行为不改，只换容器（spec §4.3）。
- 不改 Core、世界事实、权限隔离、提交逻辑（spec §2 非目标）。
- 宿主页现有 CSP 不放宽；`/creator` 用 `playtest-server.ts` 已有的 `customPage` 策略（`script-src 'self'`、`connect-src 'self'`）。
- 现有 Tauri `open` 的 URL 校验不放宽；创作者页用新 operation `open-creator`，校验同样严格，路径固定为 `/creator/#token=`。
- 运行中仍禁止：`create / load / start` 之外的切包切实例、`story-select / story-fork / story-import`、`frontend-grant`；`frontend-revoke` 保持运行中可用且立即生效。
- 运行中放开：`settings / configure / play-settings / preset-save / preset-global / preset-instance`，以及分支中连接 / 实例模型分配的写请求。
- 窗口 1180×800、最小 800×640，`decorations: false`。
- 主色沿用 `palette` 设置；抽屉为毛玻璃（浅色主题偏白、深色主题偏深），不加压暗遮罩。
- 文案：运行中提示固定为“修改将在下次启动游戏时生效”；撤销信任行注明“立即生效”；模型接口页注明“连接修改立即保存”。
- 删除：底部状态栏、`GameList.vue`、`GameDetail.vue`、启动器内 `CreatorConsole` 全屏模式、`RequestInspectorDialog` 在启动器的入口、`story-save` IPC 与“保存完整节点”按钮、`creator-*` / `request-inspector` 透传。
- 测试命令：根目录 `corepack pnpm@11.7.0 test`（vitest prototype 配置，含 `tests/prototype/**`）；启动器 `corepack pnpm@11.7.0 launcher:check`。

## Review Focus

1. **`/creator/` 静态路由被路径穿越**（`/creator/assets/..%2f..%2fpackage.json`、反斜杠、编码的 `..`）——应一律 404，只从资源目录内读文件。→ Task 3 测试。
2. **创作者资源目录缺失**（开发时没跑 creator 构建、发行包漏拷）——`/creator/` 应返回 503 和一句中文说明，而不是 500 或空白页。→ Task 3 测试。
3. **游戏忙碌时点“保存进度”**——返回 409 与 `PlaytestBusyError` 原文，宿主页显示该文案，进度不丢。→ Task 1 测试。
4. **运行中改模型 / 预设后，当前子进程环境不变**，下次 `start` 才用新值。→ Task 5 测试。
5. **运行中“开始”按钮之外的危险操作**（切包、切实例、选故事线、授予信任）仍被 core 拒绝，即使前端没禁用。→ Task 5 测试。

---

### Task 0: 基线

**Files:**
- Modify: `.gitignore`
- Add: `docs/superpowers/specs/2026-10-17-launcher-redesign-design.md`、本计划

- [ ] **Step 1:** 确认工作树干净。main 当前有用户未提交改动（`desktop/launcher-core.ts`、`packages/interactions-basic/src/dinner.ts` 等）；**停下问用户**如何处理（提交 / 暂存），不得自行丢弃。
- [ ] **Step 2:** `git merge feat/launcher-model-connections`；冲突按分支语义解决，冲突涉及用户 WIP 时停下问用户。
- [ ] **Step 3:** 运行 `corepack pnpm@11.7.0 test` 与 `corepack pnpm@11.7.0 launcher:check`，期望全绿；记录合并后 `launcher-core.ts` 中连接 / 模型分配写请求的实际 operation 名（Task 5 要用）。
- [ ] **Step 4:** `.gitignore` 加 `.superpowers/`；提交 spec 和本计划：`git commit -m "docs: launcher redesign design and plan"`。

---

### Task 1: 宿主页“保存进度”与 `/api/story-save`

**Files:**
- Modify: `tests/experiments/playtest-server.ts`（`PlaytestRuntime` 接口、路由）
- Modify: `tests/experiments/playtest-host-page.ts`（工具栏按钮与脚本）
- Modify: `tests/experiments/playtest-web-entry.ts:103-109`（删除 `story-save` IPC 处理）
- Modify: `desktop/launcher-core.ts`（删除 `case 'story-save'`）
- Modify: `apps/launcher/src/stores/launcher.ts`（删除 `saveStoryNode`）、`apps/launcher/src/components/StorylineDialog.vue`（删除保存节点输入与按钮）
- Test: `tests/prototype/story-save-api.test.ts`（新建）；更新 `tests/prototype/launcher-core.test.ts` 中引用 `story-save` 的用例

**Interfaces:**
- Produces: `PlaytestRuntime.saveNode?(title: string): Promise<{ id: string; title: string }>`；HTTP `POST /api/story-save`，body `{ title: string }`（1–80 字符，`trim` 后为空则用 `保存于 ${HH:mm}`），成功 `200 { node: { id, title } }`，忙碌 `409 { error: <PlaytestBusyError.message> }`，runtime 无 `saveNode` 时 `501`。

- [ ] **Step 1: 写失败测试** `tests/prototype/story-save-api.test.ts`，用 `createPlaytestServer` + 假 runtime（参照 `tests/prototype/request-inspector.test.ts` 的起服务方式）：
  - `saves a node with the given title`：POST `{title:'晚饭后'}` 带 token → 200，`saveNode` 收到 `'晚饭后'`。
  - `rejects without token`：无 `x-playtest-token` → 401，`saveNode` 未调用。
  - `reports busy runtime`：`saveNode` 抛 `new PlaytestBusyError('角色仍在行动')` → 409，`body.error === '角色仍在行动'`。
  - `rejects overlong title`：81 字符 → 400。
- [ ] **Step 2:** `corepack pnpm@11.7.0 vitest run --config vitest.prototype.config.ts tests/prototype/story-save-api.test.ts`，期望 FAIL（404）。
- [ ] **Step 3:** 在 `/api/*` 已鉴权区块内加路由；`FrozenWorldPlaytestRuntime.saveNode`（`playtest-frozen-runtime.ts:618`）已满足接口，`playtest-web-entry.ts` 无需额外接线。
- [ ] **Step 4:** 跑同一命令，期望 PASS。
- [ ] **Step 5:** 宿主页工具栏在 `#escape` 前加 `<button id="save-progress" type="button">保存进度</button>`；点击用 `prompt('节点名称（可留空）')` 取名（取消则不保存），POST 后把结果写入 `#notice`：成功“已保存：<title>”，失败显示返回的 `error`。
- [ ] **Step 6:** 删除启动器侧 `story-save`（core case、web-entry IPC、store 方法、对话框按钮），更新 `launcher-core.test.ts` 相关断言为“`story-save` 是未知 operation”。
- [ ] **Step 7:** `corepack pnpm@11.7.0 test` 与 `launcher:check` 通过后提交：`feat(playtest): save progress from the host toolbar`。

---

### Task 2: 创作者页面构建入口

**Files:**
- Create: `apps/launcher/creator.html`、`apps/launcher/src/creator/main.ts`、`apps/launcher/vite.creator.config.ts`
- Modify: `apps/launcher/src/creator/source.ts`（Tauri invoke → 同源 fetch）
- Modify: `apps/launcher/src/creator/CreatorConsole.vue`（标题 / 故事线 / 角色从 `creator-meta` 取；去掉 `close` 事件与关闭按钮）
- Move: `apps/launcher/src/components/RequestInspectorDialog.vue` 的内容 → `apps/launcher/src/creator/RequestsView.vue`，作为 `CreatorNav` 的一个视图
- Modify: `apps/launcher/package.json`（`build` 追加 `vite build --config vite.creator.config.ts`；新增 `creator:dev`）
- Test: `apps/launcher/src/creator/source.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `GET /api/creator-meta` → `{ title: string; storyline: string; characters: { id: string; name: string }[] }`；已有 `/api/creator-debug|creator-history|creator-records`、`GET|POST /api/request-inspector`。
- Produces: `creatorSource(token: string, fetcher?: typeof fetch): CreatorSource`，在原接口上新增 `meta(): Promise<CreatorMeta>` 与 `requests(enabled?: boolean): Promise<InspectorSnapshot>`；`location.hash` 无 `#token=` 时 `main.ts` 用 `previewSource`。构建产物：`apps/launcher/dist-creator/index.html` + `dist-creator/assets/*`，`base: '/creator/'`。

- [ ] **Step 1: 写失败测试** `source.test.ts`：
  - `sends token header and query`：`debug({characterId:'a'})` 调用 `fetcher('/api/creator-debug?characterId=a', {headers:{'x-playtest-token':T}})`。
  - `throws readable error on non-ok`：fetcher 返回 401 → reject 消息 `创作者数据读取失败（401）`。
- [ ] **Step 2:** `corepack pnpm@11.7.0 --filter @perspectra/launcher test`，期望 FAIL。
- [ ] **Step 3:** 实现 `source.ts`；`main.ts` 从 `location.hash` 取 token 后 `history.replaceState` 清掉 hash（避免 token 留在地址栏历史）；挂载 `CreatorConsole`。
- [ ] **Step 4:** 测试 PASS；`corepack pnpm@11.7.0 --filter @perspectra/launcher build` 产出 `dist-creator/index.html`，其中脚本引用为 `/creator/assets/...`、无内联脚本。
- [ ] **Step 5:** 提交：`feat(creator): standalone creator page entry`。

---

### Task 3: 服务器托管 `/creator` 与 `creator-meta`

**Files:**
- Create: `tests/experiments/playtest-creator-assets.ts`
- Modify: `tests/experiments/playtest-server.ts`、`tests/experiments/playtest-web-entry.ts`（给 runtime 提供 meta）
- Test: `tests/prototype/creator-page.test.ts`（新建）

**Interfaces:**
- Produces: `creatorAsset(request, response, directory: URL | null): boolean`——处理 `GET /creator`（301 → `/creator/`）、`/creator/`（`index.html`）、`/creator/assets/<file>`；`creatorAssetDirectory(): URL | null`：`import.meta.url` 以 `.mjs` 结尾用 `./creator-assets/`，否则 `../../apps/launcher/dist-creator/`，目录不存在返回 `null`。`PlaytestRuntime.creatorMeta?(): { title; storyline; characters }`；路由 `GET /api/creator-meta`（需 token）。

- [ ] **Step 1: 写失败测试**（目录用 `mkdtemp` 造一个含 `index.html` 与 `assets/app.js` 的假目录）：
  - `serves index with custom page CSP`：`/creator/` → 200，`content-security-policy` 含 `script-src 'self'` 且不含 `'unsafe-inline'` 于 script-src。
  - `serves asset with js content type`：`/creator/assets/app.js` → 200，`text/javascript`。
  - `blocks traversal`：`/creator/assets/..%2f..%2fsecret.txt`、`/creator/assets/..\\x.js` → 404。
  - `reports missing build`：目录 `null` → `/creator/` 503，正文含 `创作者页面未构建`。
  - `creator-meta requires token`：无 token 401；有 token 返回 runtime 提供的对象。
- [ ] **Step 2:** 运行该测试文件，期望 FAIL。
- [ ] **Step 3:** 实现：解码后用 `path.resolve` 求真实路径并确认以资源目录为前缀；内容类型只认 `.html .js .css .svg .png .woff2`，其余 404；HTML 用 `headers(response, …, customPage=true)`。`createPlaytestServer` 增加可选参数 `creatorDirectory: URL | null = creatorAssetDirectory()`，放在 `frontendAsset` 之前处理。
- [ ] **Step 4:** `playtest-web-entry.ts` 给 runtime 增加 `creatorMeta`（标题取世界标题，故事线取 `PERSPECTRA_STORY_*` 已有信息或“主故事线”，角色取 `presetCharacters` 同源数据）。
- [ ] **Step 5:** 测试 PASS；`corepack pnpm@11.7.0 test` 全绿；提交：`feat(playtest): host the creator page`。

---

### Task 4: 启动器打开创作者页，删除旧控制台

**Files:**
- Modify: `desktop/launcher-core.ts`（新增 `case 'open-creator'`；删除 `creator-*`、`request-inspector` case 及相关 import）
- Modify: `apps/launcher/src-tauri/src/main.rs:174-197`（`open` 与 `open-creator` 共用一个校验函数）
- Modify: `apps/launcher/src/services/desktop.ts`（删 `inspectCreator*` / `inspectRequests`，加 `openCreator()`）
- Modify: `apps/launcher/src/stores/launcher.ts`（加 `openCreator`）
- Delete: 启动器对 `CreatorConsole` / `RequestInspectorDialog` 的引用（文件本身已在 Task 2 迁入 creator 入口）
- Test: `tests/prototype/launcher-core.test.ts`

**Interfaces:**
- Produces: core `open-creator` → `{ url: <active base> + '/creator/#token=' + token }`；Rust 校验：`url` 必须匹配 `http://127.0.0.1:<1-65535>` + 路径（`/` 或 `/creator/`）+ `#token=<64 hex>`，其他一律“游戏地址无效。”。store：`openCreator(): Promise<void>`。

- [ ] **Step 1: 写失败测试**（launcher-core.test.ts）：
  - `open-creator requires running game`：未运行 → reject `游戏尚未启动`。
  - `creator passthrough removed`：`creator-debug` → 未知 operation 错误（替换原 94 行断言）。
- [ ] **Step 2:** 跑 `launcher-core.test.ts`，期望 FAIL。
- [ ] **Step 3:** 实现 core 与 Rust；Rust 把校验提成 `fn validated_local_url(url: &str, path: &str) -> Result<(), String>`，`open` 传 `"/"`，`open-creator` 传 `"/creator/"`。
- [ ] **Step 4:** 测试 PASS；`cargo check`（`apps/launcher/src-tauri`）通过；`launcher:check` 通过。
- [ ] **Step 5:** 提交：`feat(launcher): open the creator page in the system browser`。

---

### Task 5: 运行中允许修改设置

**Files:**
- Modify: `desktop/launcher-core.ts`（去掉 Global Constraints 所列请求的 `this.#idle()`）
- Test: `tests/prototype/launcher-core.test.ts`

- [ ] **Step 1: 写失败测试**（沿用该文件已有的“启动一个假子进程”夹具）：
  - `settings writes while running apply on next start`：启动后发 `preset-instance`（或分支里实例模型分配的写请求）→ 成功；当前子进程 spawn 时的 env 不变；`stop` 再 `start` 后新 env 含新值。
  - `still refuses risky operations while running`：运行中 `story-select`、`story-fork`、`frontend-grant`、`create`、`load` 均 reject（`#idle` 的原文案）。
  - `revoke still applies immediately`：运行中 `frontend-revoke` 成功且子进程收到 `frontend-revoke` 消息。
- [ ] **Step 2:** 跑测试，期望第一个 FAIL、后两个 PASS。
- [ ] **Step 3:** 删除对应 `#idle()`；复核合并后模型分配与连接 Key 只在 `start` 中读取（若发现运行中被读取，停下报告，不扩大改动）。
- [ ] **Step 4:** 测试 PASS；提交：`feat(launcher-core): allow settings edits while a game runs`。

---

### Task 6: 发行包包含创作者页

**Files:**
- Modify: `scripts/release/build-portable.mjs:22`（在 `frontend-assets` 复制之后加一行）
- Modify: `scripts/release/verify-portable.mjs`

- [ ] **Step 1:** `build-portable.mjs`：先 `access(resolve('apps/launcher/dist-creator/index.html'))`，缺失则 `throw Error('Run launcher:build first; creator page is missing.')`；再 `cp(resolve('apps/launcher/dist-creator'), join(runtime,'creator-assets'), {recursive:true})`。
- [ ] **Step 2:** `verify-portable.mjs`：断言 `runtime/creator-assets/index.html` 存在；若该脚本会启动游戏冒烟，则额外 GET `/creator/` 期望 200。
- [ ] **Step 3:** `corepack pnpm@11.7.0 launcher:build` 后跑 `node scripts/release/build-portable.mjs <新目录>` 与 verify，期望通过（耗时长，后台运行）。若本机缺发行构建依赖，记录未验证并告知用户。
- [ ] **Step 4:** 提交：`build(release): ship the creator page`。

---

### Task 7: 窗口外壳与主屏

**Files:**
- Modify: `apps/launcher/src-tauri/tauri.conf.json`（`decorations: false`）、`capabilities/default.json`（加 `core:window:allow-minimize`、`core:window:allow-close`、`core:window:allow-start-dragging`、`core:window:allow-toggle-maximize`）
- Create: `apps/launcher/src/components/TitleBar.vue`、`PackRail.vue`、`HomeStage.vue`
- Modify: `apps/launcher/src/components/LauncherShell.vue`（重写布局）、`apps/launcher/src/style.css`
- Delete: `GameList.vue`、`GameDetail.vue`、底部 `statusbar` 样式
- Test: `apps/launcher/src/stores/launcher.test.ts`（只测新增的派生状态）

**Interfaces:**
- Produces（store 新增派生值，供 Task 7–9 共用）：`stageSummary: { title: string; storyline: string; model: string; frontend: 'sandbox' | 'trusted' | 'default'; blockedReason: string }`；`running: boolean`。
- `HomeStage` emits：`openDrawer(section?: 'model' | 'frontend')`、`play`、`stop`、`reopen`、`openCreator`；`TitleBar` emits：`openSettings`。

- [ ] **Step 1: 写失败测试** `stageSummary`：无模型时 `blockedReason === '还没有可用模型，请先完成模型设置'`；`frontend` 映射与现 `GameDetail.vue:206` 一致；有角色覆盖时 `model` 末尾追加 `· 另有 N 个角色单独配置`（沿用分支摘要函数，若分支已有则直接复用）。
- [ ] **Step 2:** 跑 `launcher:check`，期望 FAIL。
- [ ] **Step 3:** 实现 store 派生值，再实现组件，按 spec §3 布局：
  - `TitleBar`：`data-tauri-drag-region`，右侧 ⚙ / 最小化 / 关闭，透明渐变底。
  - `PackRail`：46px，包图标（封面裁切或 artwork 色 + 首字）、选中描边、hover 包名，底部“＋”→ 现有 `ImportDialog` package 模式；运行中整体 `disabled` 变灰。
  - `HomeStage`：封面 `object-fit: cover` 铺满；底部渐变上左侧包名 + 副标题行（故事线 · 模型标签 · 前端权限标签，两个标签可点击→ `openDrawer('model' | 'frontend')`）；右下“⋯”+ 主按钮。运行中主按钮“结束游戏”，并显示“回到游戏页面”“打开创作者页面”和呼吸灯。
  - 空状态：无包时默认封面 + “载入一个世界包，开始你的故事” + 载入按钮；初始化失败显示原因 + “重试初始化”。
  - `notice` 保留为右下 toast。
- [ ] **Step 4:** 测试 PASS；`corepack pnpm@11.7.0 launcher:dev` 浏览器预览（mock）截图检查：一屏无滚动条、800×640 下按钮不重叠、封面无压暗。
- [ ] **Step 5:** 提交：`feat(launcher): single-screen home stage with pack rail`。

---

### Task 8: 本局抽屉

**Files:**
- Create: `apps/launcher/src/components/SessionDrawer.vue`
- Create（由现对话框拆出表单主体，对话框文件随后删除）：`panels/StoryPanel.vue`（←`StorylineDialog` + `ImportDialog` story 模式 + `ExportDialog`）、`panels/ModelPanel.vue`（← 分支版 `ModelConfigDialog` + `ModelPicker`）、`panels/PresetPanel.vue`（← `PresetDialog`）、`panels/FrontendPanel.vue`（← `FrontendAuthorizationDialog`）、`panels/PlayPanel.vue`（← `PlaySettingsDialog`）
- Modify: `apps/launcher/src/style.css`
- Test: `apps/launcher/src/stores/launcher.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `stageSummary`、`running`、`openDrawer(section?)`；Task 4 的 `openCreator()`。
- Produces: `SessionDrawer` props `{ open: boolean; section: 'story' | 'model' | 'preset' | 'frontend' | 'play' | null }`，emits `close`。每个 panel emits `dirty(boolean)`，抽屉在返回 / 关闭且 dirty 时 `confirm('有未保存的修改，确定离开？')`。

- [ ] **Step 1: 写失败测试**：store 新增 `drawerRows` 派生（行顺序、摘要文本、`frontend` 行在 `sandbox` 且自定义前端时 `warn: true` 且动作文字 `解除沙箱`）。
- [ ] **Step 2:** 跑 `launcher:check`，期望 FAIL。
- [ ] **Step 3:** 实现：右侧滑出，宽 44%（最小 360px），`backdrop-filter: blur(18px)`、浅色 `rgba(255,255,255,.58)` / 深色主题偏深；Esc、✕、点抽屉外关闭。标题 = 包名 + 实例下拉（含“新建独立实例”）；分组“游玩 / 进阶”，行表见 spec §4.1；点行在抽屉内切到 panel，顶部“‹ 返回”。运行中顶部固定提示“修改将在下次启动游戏时生效”；`StoryPanel` 运行中只允许浏览和导出；`FrontendPanel` 撤销按钮旁注明“立即生效”；“创作者工具”行未运行时禁用并显示“启动游戏后可用”。
- [ ] **Step 4:** 测试 PASS；mock 预览中逐行点开检查无对话框叠加；提交：`feat(launcher): session drawer replaces per-game dialogs`。

---

### Task 9: 全局设置窗口

**Files:**
- Create: `apps/launcher/src/components/SettingsWindow.vue`、`panels/ConnectionsPanel.vue`（← 分支版 `ModelSettingsDialog`）、`panels/AppearancePanel.vue`、`panels/ReadingAudioPanel.vue`、`panels/DataPanel.vue`、`panels/AboutPanel.vue`（← `SettingsDialog` 拆分）
- Delete: `SettingsDialog.vue`、`ModelSettingsDialog.vue`
- Test: `apps/launcher/src/stores/launcher.test.ts`

**Interfaces:**
- Produces: store `preferencesDraft`（外观 + 阅读 + 声音 + 大字）与 `applyPreferences(): Promise<boolean>`、`resetPreferencesDraft()`；`SettingsWindow` emits `close`。

- [ ] **Step 1: 写失败测试**：`applyPreferences` 只发一次 `preferences` 请求且之后 `preferencesDirty === false`；`resetPreferencesDraft` 恢复为最近一次应用的值。
- [ ] **Step 2:** 跑 `launcher:check`，期望 FAIL。
- [ ] **Step 3:** 实现：居中浮层（左右各 12%、上 12%、下 8%），背后压暗；左侧分类“模型接口、外观、阅读与声音、数据位置、关于”；底部“取消 / 应用 / 保存”只作用于 `preferencesDraft`；✕ 与取消在 dirty 时确认；“模型接口”页顶部注明“连接修改立即保存”，其操作沿用分支即时语义。
- [ ] **Step 4:** 测试 PASS；提交：`feat(launcher): settings window with apply and save`。

---

### Task 10: 文档与真实试玩验收

**Files:**
- Modify: `docs/current/architecture/` 中涉及启动器、创作者工具、存档的章节（按 `docs/current/architecture/maintenance.md`），`docs/current/guides/player-playtest.md`

- [ ] **Step 1:** 更新文档：先给玩家视角例子（打开启动器 → 开始 → 游戏内保存 → 结束 → 抽屉载入节点），再写源码关系；标明“源码已接通 / 自动测试 / 真实体验验收 / 发行包已包含”各自状态。
- [ ] **Step 2:** `node scripts/docs/check-links.mjs` 通过。
- [ ] **Step 3:** 真实试玩（`corepack pnpm@11.7.0 launcher:desktop`，用带封面的 `examples/world-packs/model-girls-dinner-v2`，新数据目录）：开始 → 回到游戏页 → 打开创作者页（含请求视图）→ 宿主页“保存进度” → 运行中改预设并看到提示 → 结束 → 抽屉载入刚存节点再开始。检查：不滚动、沙箱状态一眼可见、封面人物不被遮挡、标题栏可拖动。
- [ ] **Step 4:** 提交：`docs: launcher redesign`；交付说明如实列出哪些验证未做（例如发行包未实际构建）。
