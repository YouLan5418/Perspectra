# 启动器改版后端交付

日期：2026-10-17。分支：`feat/launcher-redesign-backend`。工作树：`D:/DeepSeek Harness/launcher-redesign-backend`。

基线为 `2c321c3`，已包含模型连接分支与 `.superpowers/` 忽略规则。未修改 `apps/launcher/src/**`；前端改版需要独立合并，本分支没有承接 Task 2、7、8、9 或原生点击验收。

## 实现范围

| 任务 | 结果 | 提交 |
| --- | --- | --- |
| Task 1 | 宿主页保存按钮、鉴权 POST /api/story-save、删除保存 IPC | 1e0a6d0 |
| Task 3 | /creator 静态托管、严格资源边界、GET /api/creator-meta；启动传入故事线名称 | b2e7b92 |
| Task 4 后端 | open-creator、Rust 固定页面路径和本机 URL 校验；删除旧创作者透传 | dfd2b27 |
| Task 5 | 运行中编辑设置，下次启动生效；保留危险操作拒绝与即时撤权 | af2a6c1 |
| Task 6 | 发行资源预检、复制 creator-assets、验证器核对静态页 | a9af009 |
| 返回字段修正 | 真实运行时返回的完整节点只投影 id/title，保持接口约定 | 0310ce0 |

没有新增世界协议、存档版本或恢复机制，没有修改角色处理或事实提交逻辑。当前文档同步了 runtime、创作者 API 和故事线说明。

## 验证

- TypeScript strict 类型检查、Oxlint、`launcher:check`（4 文件 31 项）通过。
- 定向 `launcher-core.test.ts` 31 项通过，含真实假子进程启动／停止、运行配置保持、下次启动采用新设置、危险操作拒绝与撤权确认。
- `story-save-api.test.ts` 5 项与 `creator-page.test.ts` 5 项通过，包含鉴权、跨源拒绝、忙碌原文、标题校验、空标题、501、资源 MIME/CSP、原始编码路径、反斜杠与目录链接越界。
- `cargo check` 通过；`cargo test local_url_tests --bin perspectra-launcher` 通过，覆盖固定路径、端口与 token 拒绝边界。
- `node scripts/docs/check-links.mjs` 通过：12 页、351 个本地链接。
- `launcher:build` 通过；本分支的旧前端构建脚本尚不包含 creator 入口，这是前端分工内容。
- esbuild 将实际 `playtest-web-entry.ts` 打成 `.mjs`，配合另一实现者已生成的真实 creator 构建，在新临时数据目录启动真实运行时：页面及 2 个资源、元数据、鉴权和节点保存通过；未调用模型。证据：`.tmp/backend-bundle-smoke-1792248612737/result.json`。
- 首次沙箱完整测试为 539 通过、19 失败：18 项因 taskkill 权限，1 项因缺少 Python 路径。提升权限后两个崩溃测试文件共 37 项通过；复用既有便携包只读 Python/E5 环境后，故事分享集成用例通过。最终在该环境运行 `corepack pnpm@11.7.0 test --maxWorkers=1`：65 文件、567 项全部通过（350.12 秒）。

## 模型配置与 Key 核对

实际写 operation 为 `connection-save / connection-remove / configure`；连接写入此前已允许运行中操作，本轮没有新增凭证 API。Rust 在 start、列模型及连接测试请求中读取凭据；游戏进程启动时由环境构造角色决策 provider 和记忆 runner，运行中的游戏没有发现重新读取连接配置或 Key 的路径。预设文件也只在网页入口启动时载入。下次启动生效测试同时核对模型、连接地址、预设、阅读配置及运行参数。

## 尚未验收

- 完整发行构建没有完成：先验证缺少 creator 时的明确错误；补入实际 creator 构建后，构建在缺少 `.tmp/hindsight-vector-venv/pyvenv.cfg` 处终止。本工作树也未配置完整 WebView2／CRT 发行资产，因此没有运行完整便携包验证器。
- 没有实际发布新发行包，没有原生 Launcher 点击、真实模型连续试玩或干净机器验收。打包后无模型 HTTP 冒烟不替代这些验证。
- 合并前端时需使用新的 `open-creator` 与 HTTP 数据源，去掉保存 IPC 和旧创作者透传调用，并把 creator 构建加入 launcher:build；后端保持交接文档约定的接口。
