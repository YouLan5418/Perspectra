# 交接：Launcher 按角色模型（Part B，Task 7–9）

日期：2026-10-17 · 交出方：Claude · 接手方：GPT

> 接手后的交付、实际环境修正和验收结果见[按角色模型验收](../../current/studies/launcher-role-models-20261017.md)。下文保留交出时原始状态与排查过程，不代表后续任务仍未完成。

先读：[实施计划](../plans/2026-10-17-launcher-model-connections.md)的 Part B 和[设计规格](../specs/2026-10-17-launcher-model-connections-design.md)第 5、7 节，以及仓库根目录的 `AGENTS.md`。全程用中文沟通。**不要 merge，也不要 push。**

## 1. 工作位置

- Worktree：`D:/DeepSeek Harness/Perspectra V1/.claude/worktrees/launcher-model-connections`
- 分支：`feat/launcher-model-connections`（Part A 已完成并评审过；Part B 在它上面又加了 3 个提交）
- 主仓库 `main` 上另有其他会话没提交的改动，不要碰。

| 提交 | 内容 |
|---|---|
| `060fa93` | feat(runtime): per-character decision models（Task 7） |
| `0e6dc65` | feat(runtime): per-character memory consolidation models（Task 8） |
| `cfd4b05` | feat(launcher): per-character model overrides（Task 9 的 UI 部分） |

工作树里没有我留下的未提交代码改动。`nul` 文件和 `.claude/` 不是我建的，不用管。

## 2. 已完成的部分

### Task 7：决策模型按角色（已完成，测试全绿）

- `desktop/model-connections.ts`
  - `modelEnvironment()` 除原有 `HCW_LOCAL_*` 外，新输出 `PERSPECTRA_ROLE_MODELS`（`resolveRoleModels` 的 JSON，**不含 Key**）和 `PERSPECTRA_MODEL_KEYS`（只含被默认层或角色覆盖引用到的连接的 Key）。
  - 新增 `RuntimeModel` / `RuntimeRoleModels` 类型和 `runtimeRoleModels(roles, keys)`：游戏进程用它把目标和 Key 重新拼起来，并校验地址、协议和模型 ID。
- `tests/experiments/playtest-web-entry.ts`：读取上面两个变量，读完立即 `delete process.env.PERSPECTRA_MODEL_KEYS`，这样 Python worker 拿不到其他连接的 Key。然后把结果作为 `roleModels` 传给运行时。
- `tests/experiments/playtest-frozen-runtime.ts`
  - 新选项 `roleModels`，只允许 `provider: 'local'`。
  - 角色 ID 若不在本包可调用角色内，报“此包之外”。
  - 构建 `roleProviders` 时，有覆盖的角色**整体替换**协议、地址、模型、思考强度和 Key。这里有意偏离了计划写的“thinkingLevel 仅在覆盖有值时覆盖”：否则默认层的 Key 和思考强度会漏给另一家服务商。
  - 按角色自己的协议选择 `localPrototypeTurnCall`（只用于 openai 协议）或 `prototypeTurnCall`。
- `desktop/launcher-core.ts` 的 `start` 本来就展开了 `modelEnv`，所以两个新变量会自动带上。
- 测试：
  - `tests/prototype/model-presets.test.ts` 新增 `routes each character's decision call to its own model and endpoint`：companion 被覆盖为 Anthropic 协议的另一地址，friend 走默认，并检查包外角色被拒。
  - `tests/prototype/model-connections.test.ts` 新增 `passes per-character targets without keys and only the keys they reference`。

### Task 8：记忆整理按角色（已完成，测试全绿）

- `tests/experiments/playtest-memory-core.ts`：`MemoryBuildOptions.runFor?(actor)` 返回 `{recall, build}` 或 `undefined`；recall 和 build 都优先使用角色自己的 runner。
- `playtest-frozen-runtime.ts`
  - 按“协议 + 地址 + 模型 + Key”去重，每种不同的记忆配置起一组 runner（懒启动的 Python worker 加一次性 build）。
  - 默认记忆配置取 `roleModels.memory`；没有时按旧逻辑使用默认决策模型。
  - 每组的环境变量都显式设置 `HCW_LOCAL_API_KEY`，没有 Key 时设为空串，不继承父进程的默认 Key。
  - 运行时关闭时会关掉所有组。
  - 新增测试注入点 `memoryCoreRunners(env)`。
- 测试（都在 `tests/prototype/playtest-memory-core.test.ts`）：
  - `uses each character's own memory runner for recall and build`
  - `starts one Core runner per distinct memory model and never writes a key to the data directory`：验证两组、环境变量和 Key、关闭行为，以及数据目录全文搜不到 Key。

### Task 9：UI（已完成、已提交；文档和真实验收未完成）

- `apps/launcher/src/model-choices.ts`（新）：纯函数 `modelsDraft` / `draftModels`，负责对话框草稿和 `InstanceModels` 互转，有单测 `model-choices.test.ts`。
- `apps/launcher/src/components/ThinkingOptions.vue`（新）：思考强度按钮组，保留 Gemini 不能“关闭”的限制。
- `ModelConfigDialog.vue` 的结构：
  1. 默认决策模型和思考强度。
  2. “记忆整理跟随上面的决策模型”勾选框；取消勾选后可另选，这就是 Part A 有意没做的记忆选择器。
  3. “按角色单独设置”：每个角色一行，取消“跟随默认”后可选决策模型、思考强度，以及“记忆整理跟随该角色的决策模型”或另选。
- `GameDetail.vue` 的摘要会追加“；另有 N 个角色单独配置”。
- Mock 模式：`stores/launcher.ts` 把模型选择存在内存，`mock.ts` 提供 `mockCharacters`，所以浏览器 Mock 下能核对保存和回显。
- 已在浏览器 Mock 下实际操作过：建两条连接，给“旅人”单独选第二条连接的模型并设思考“高”，保存后摘要显示“另有 1 个角色单独配置”，重新打开对话框时回显正确。

### 已跑过并通过的验证

- 根目录 `corepack pnpm@11.7.0 typecheck`
- vitest：`model-presets`、`model-connections`、`playtest-memory-core`、`launcher-core`、`cross-scene-core-memory`、`pack-activities`、`native-provider-runtime`、`storyline-crash`、`story-nodes`
- Launcher 的 `typecheck` 和 `test`（4 个文件、30 个用例）

**还没跑：**`corepack pnpm@11.7.0 check`、Rust 部分（Part B 没改 Rust）、全仓测试。

## 3. 剩下的任务

1. **文档**（计划 Task 9 Step 3）
   - `docs/current/launcher-core-integration.md` 第 82 行附近：删掉“当前运行时仍只接收一个模型……按角色指定模型尚未接通”。改为说明 `PERSPECTRA_ROLE_MODELS` 和 `PERSPECTRA_MODEL_KEYS`；写清 Key 只经过子进程环境、游戏进程读完即删、每个 Python worker 只拿到自己那组的 Key。
   - `docs/current/architecture/runtime.md` 的“角色思考强度”一节：补充按角色覆盖，以及“记忆 Utility 沿用……”这句话现在的真实含义（跟随角色或默认层的记忆模型）。
   - `docs/current/guides/player-playtest.md` 和 `docs/current/model-protocols.md`：加一个“给重要角色换强模型”的例子，按 `AGENTS.md` §9 的要求先给例子再讲术语。
   - 改完运行 `node scripts/docs/check-links.mjs`。
2. **真实试玩**（计划 Task 9 Step 4，详见第 4 节）。
3. **收尾**：运行 `corepack pnpm@11.7.0 check`，然后如实写交付说明：哪些跑了、哪些没跑、哪些风险尚未验证。

## 4. 真实试玩：已有进展与踩过的坑

**用户明确要求：不要用 Ollama 的模型。** 也不要从凭据管理器读取用户的 Key。目前用的是本机两个不需要 Key 的连接，都由 8045 网关提供：

- 默认连接：OpenAI 协议 `http://127.0.0.1:8045/v1/chat/completions`，模型 `gemini-3.8-flash`，思考“低”。`gemini-3.7-flash` 当时被限流。
- 覆盖连接：Anthropic 协议 `http://127.0.0.1:8045/v1/messages`，模型 `claude-sonnet-4-6`，思考“关闭”，只覆盖 `character:claude`。
- 游戏包：`examples/world-packs/model-girls-official`，角色有 Claude、DeepSeek、GLM、GPT。

### 已确认

用真实 `LauncherCore` 走了完整流程：`connection-save` → `load` → `create` → `configure`（带角色覆盖）→ `start`。打开请求检查器后玩了 3 轮：

- Claude 的请求都是 `model: claude-sonnet-4-6`、Anthropic 请求体、`thinking: {type: disabled}`。
- 其他三个角色都是 `gemini-3.8-flash`，带 `reasoning_effort: low`。

决策路由符合预期。

### 体验问题（不是 Part B 接线导致，但需要写进交付说明）

Claude 连续 3 轮都选了 `abstain`。它的思考内容里明明写着想回应，但工具参数只有 `{"decision":"abstain"}`。请求的 Schema 正确：根是 `oneOf`，第一项是 abstain。

这和源码里 `tests/experiments/local-prototype-turn-call.ts` 开头的注释描述的是同一类问题：8045 网关会把根 `oneOf` 当成只有第一个选项。OpenAI 路径用 `localPrototypeTurnCall` 绕过了这个问题，Anthropic 路径没有绕过。结果是：通过 8045 的 Anthropic 接口覆盖角色时，这个角色基本不说话。

可选的处理方式：

- 用户另给一条真正不同服务商的连接再验收；
- 或者调查是否需要为 Anthropic 走类似的扁平 Schema。这属于新改动，需先问用户。

### 记忆整理验收未完成。遇到两个环境问题

1. **worktree 里没有 E5 向量资产。** 我已在 worktree 建了目录联接 `.tmp/hindsight-e5-small` → 主仓库的 `.tmp/hindsight-e5-small`。它被 gitignore 忽略；用完可以删掉，删联接不会删源目录。
2. **这台机器上 venv 里的 Python 不能在 `D:\Temp\...` 下建文件**（PermissionError），但在 worktree 下可以。最初的数据目录放在 D:\Temp 的 scratchpad 里，所以所有角色的整理在写 `utility-attempts-<pid>.jsonl` 时失败。

**结论：验收数据目录要放在 worktree 的 `.tmp/` 下**（例如 `.tmp/accept-root`，我已建好，里面有一次刚启动但还没玩的实例，可以删掉重来）。

在副本上用 `replay2.mts` 重放时已确认：运行时确实起了两组 runner，一组是 gemini-3.8-flash/openai，一组是 claude-sonnet-4-6/anthropic。但因为上面第 2 个问题，还没有真正写出 `utility-attempts.jsonl`。

### 接着做的步骤

在 worktree 根目录执行，所有脚本都在 `.tmp/accept-scripts/`：

```bash
export HCW_HINDSIGHT_PYTHON="D:/DeepSeek Harness/Perspectra V1/.tmp/hindsight-vector-venv/Scripts/python.exe"
rm -rf .tmp/accept-root && mkdir -p .tmp/accept-root
node --import tsx .tmp/accept-scripts/drive-launcher.mts "$PWD/.tmp/accept-root" examples/world-packs/model-girls-official character:claude
```

- 脚本会打印 `{url, control, ...}`。`control` 是一个本地 HTTP 端口：POST JSON（如 `{"operation":"request-inspector"}`）会转发给 `LauncherCore.handle`，并自动带上 instanceId。
- 发言：`python -I .tmp/accept-scripts/say2.py <游戏地址> <token> <UTF-8 文本文件>`。在 Git Bash 里直接把中文放在命令行参数会乱码，所以要用文件。
- 导出对话：`python -I .tmp/accept-scripts/state.py <游戏地址> <token> <输出文件>`
- 触发整理：`POST <游戏地址>/api/memory/refresh`，请求头带 `x-playtest-token`。完成后检查：
  - 实例目录下 `memory-core/utility-attempts-*.jsonl` 里，Claude 那组的 `requestedModel` 应为 `claude-sonnet-4-6`，其他角色为 `gemini-3.8-flash`；
  - 对 `.tmp/accept-root` 全目录搜索，不应出现任何 Key（这次没有 Key，可以检查 `HCW_LOCAL_API_KEY` 或 `PERSPECTRA_MODEL_KEYS` 的值是否出现）。
- 游戏前端是沙箱 iframe，内置浏览器点不进去，所以用上面的 HTTP 接口驱动。
- 结束时 POST `{"operation":"stop"}`，再结束脚本进程。

## 5. 有意接受的限制

- 每种不同的记忆配置各起一个 Python worker，每个都会加载一份 E5 编码器（内存占用叠加）。目前只在角色真的有不同记忆模型时才会多起。
- 请求检查器只显示模型名，不显示连接或地址。两条连接如果用同名模型，从检查器上无法区分。
- Mock 模式下的模型选择只存在内存里，刷新就丢。
