# Launcher 模型连接与角色模型分配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全局只管理多条模型连接并列出可用模型；实例从汇总列表选模型，可按角色覆盖决策模型与记忆整理模型；Key 存进 Windows 凭据管理器。

**Architecture:** 新增纯函数模块 `desktop/model-connections.ts`（连接/选择的校验、列模型、解析生效配置），`desktop/launcher-core.ts` 改用它持久化连接和实例选择。Key 只经过 Tauri Rust 层：Rust 用 `keyring` 存取，在转发给 Node 的请求里注入 `apiKeys`，Node 从不落盘。运行时通过 `PERSPECTRA_ROLE_MODELS` / `PERSPECTRA_MODEL_KEYS` 环境变量拿到每个角色的配置，复用已有的按角色 `roleProviders`，记忆整理按“不同配置”各起一组 Core runner。

**Tech Stack:** TypeScript strict / ESM（显式 `.ts` 导入）、Vue 3 + Pinia、Tauri 2（Rust）、vitest 4、Python Core bridge（不改 Python）。

**Spec:** [docs/superpowers/specs/2026-10-17-launcher-model-connections-design.md](../specs/2026-10-17-launcher-model-connections-design.md)

## Global Constraints

- Key 不得出现在：`launcher.json`、任何数据目录文件、`utility-attempts.jsonl`、请求检查器、错误消息、stdout/stderr、快照（`snapshot()`）。
- 凭据条目：service `Perspectra`，user `model-connection/<connectionId>`；`connectionId` 为 UUID（`/^[a-f0-9-]{36}$/`）。
- 接口地址校验沿用 `localModel` 的规则（http/https、无认证参数/查询/hash；openai 以 `/chat/completions` 结尾；anthropic 以 `/messages` 结尾；google 为 `/models/<x>:generateContent`）。
- 模型 ID ≤120 字符；连接名 1–80 字符。
- 不给玩家输入解析配模型；不做角色组模型分配；不起本地代理进程。
- 不保留旧 `defaults` / 实例 `model` 字段的读取分支；只做一次性迁移并备份旧文件。
- 沿用现有错误文案风格：中文、短句、不回显请求数据或服务商原文。
- 测试命令：根目录 `corepack pnpm@11.7.0 exec vitest run --config vitest.prototype.config.ts <file>`；Launcher 前端 `corepack pnpm@11.7.0 --filter @perspectra/launcher test`；类型 `corepack pnpm@11.7.0 typecheck` 与 `corepack pnpm@11.7.0 --filter @perspectra/launcher typecheck`。

## Review Focus

1. **网关不提供 `/models`（404/返回 HTML）**：列模型失败只提示，模型输入框仍可手打并能保存、启动。→ Task 1 测试 404；Task 5 手动核对。
2. **实例引用的连接被删除**：快照里该实例标记 `brokenConnection`，`start` 拒绝并说明“连接已删除，请重新选择”，不崩溃也不静默换模型。→ Task 2 测试。
3. **连接有 Key 但凭据管理器读取失败 / 条目不存在**：按“无 Key”继续（本地网关常不需要 Key），不报“Core 通信失败”。→ Task 3 Rust 单测。
4. **Google 列表含 embedding 等不支持 `generateContent` 的模型、名字带 `models/` 前缀**：只保留可对话模型并去前缀。→ Task 1 测试。
5. **角色覆盖引用了已不在包里的角色**（包更新后）：保存时拒绝；启动时沿用已有“引用了此包之外或不可调用的角色”报错。→ Task 2、Task 7 测试。

---

## Part A：连接与选择（可单独交付）

### Task 1: 连接模型与列模型

**Files:**
- Create: `desktop/model-connections.ts`
- Test: `tests/prototype/model-connections.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ModelConnection { id: string; name: string; protocol: ProviderProtocol; endpoint: string }
  export interface ModelTarget { connectionId: string; model: string }
  export interface DecisionTarget extends ModelTarget { thinkingLevel?: ThinkingLevel }
  export interface CharacterModels { decision?: DecisionTarget; memory?: ModelTarget }
  export interface InstanceModels { decision: DecisionTarget; memory?: ModelTarget; characters?: Record<string, CharacterModels> }
  export function modelConnection(value: unknown): ModelConnection
  export function modelsListUrl(connection: ModelConnection): URL
  export function modelPage(protocol: ProviderProtocol, body: unknown): { models: string[]; next?: string }
  export async function listModels(connection: ModelConnection, apiKey: string | undefined, fetcher?: typeof fetch): Promise<string[]>
  ```

- [ ] **Step 1: 写失败测试** `describe('model connections')`：
  - `modelConnection({id:<uuid>,name:' 本地 ',protocol:'openai',endpoint:'http://127.0.0.1:8046/v1/chat/completions'})` → name 被 trim；非 UUID id、空名、81 字符名、带 `?key=` 的地址、openai 地址不以 `/chat/completions` 结尾都 `toThrow()`。
  - `modelsListUrl`：openai `http://h/v1/chat/completions` → `http://h/v1/models`；anthropic `https://api.anthropic.com/v1/messages` → `https://api.anthropic.com/v1/models`；google `https://g/v1beta/models/x:generateContent` → `https://g/v1beta/models`。
  - `modelPage('openai',{data:[{id:'b'},{id:'a'}]})` → `{models:['b','a']}`；`modelPage('anthropic',{data:[{id:'claude-x'}],has_more:true,last_id:'claude-x'})` → `next:'claude-x'`；`modelPage('google',{models:[{name:'models/gemini-3',supportedGenerationMethods:['generateContent']},{name:'models/embed',supportedGenerationMethods:['embedContent']}],nextPageToken:'t'})` → `{models:['gemini-3'],next:'t'}`；格式不对 → `toThrow('模型列表')`。
  - `listModels` 用桩 fetcher：跟随分页两页后合并、去重、按字母排序；请求头由 `providerHeaders(protocol, key)` 生成（断言 openai 带 `authorization: Bearer K`）；anthropic 第二页 URL 带 `after_id=claude-x`，google 带 `pageToken=t`；401 → `toThrow('认证')`；404 → `toThrow('不提供模型列表')`；网络异常 → `toThrow('连接失败')`；抛出的消息不含 Key 和服务商响应原文。
- [ ] **Step 2: 运行确认失败** `corepack pnpm@11.7.0 exec vitest run --config vitest.prototype.config.ts tests/prototype/model-connections.test.ts` → FAIL（模块不存在）。
- [ ] **Step 3: 实现上述函数。** 地址校验复用 `localModel` 的规则：把 `launcher-core.ts` 里的 URL 校验抽成 `export function modelEndpoint(endpoint: string, protocol: ProviderProtocol): URL` 放进本模块，`localModel` 暂时改为调用它（Task 2 会删除 `localModel`）。`listModels` 用 `redirect:'error'`、每页 `AbortSignal.timeout(15000)`，最多 20 页。
- [ ] **Step 4: 运行确认通过**，同一命令 → PASS。
- [ ] **Step 5: 提交** `git add desktop/model-connections.ts desktop/launcher-core.ts tests/prototype/model-connections.test.ts && git commit -m "feat(launcher): model connections and model listing"`

### Task 2: LauncherCore 持久化连接与实例选择

**Files:**
- Modify: `desktop/model-connections.ts`（加选择校验与迁移）
- Modify: `desktop/launcher-core.ts`（`Index`、`Instance`、`initialize`、`handle` 的 `test-model`/`settings`/`configure`/`create`/`story-import`/`start`，新增操作）
- Modify: `tests/prototype/launcher-core.test.ts`（改写依赖旧 `defaults`/`model` 的用例）
- Test: `tests/prototype/model-connections.test.ts`

**Interfaces:**
- Consumes: Task 1 全部导出。
- Produces（`model-connections.ts`）：
  ```ts
  export function instanceModels(value: unknown, connections: readonly ModelConnection[], characterIds: readonly string[]): InstanceModels
  export interface ResolvedModel { connectionId: string; protocol: ProviderProtocol; endpoint: string; model: string; thinkingLevel?: ThinkingLevel }
  export interface RoleModels { default: { decision: ResolvedModel; memory: ResolvedModel }; characters: Record<string, { decision: ResolvedModel; memory: ResolvedModel }> }
  export function resolveRoleModels(models: InstanceModels, connections: readonly ModelConnection[]): RoleModels
  export function migrateModels(parsed: Record<string, unknown>): { connections: ModelConnection[]; instanceModels: Record<string, InstanceModels>; lastModels: InstanceModels | undefined }
  ```
- Produces（LauncherCore 请求，均返回 `snapshot()`，除注明外）：
  - `connection-save {connection}`：新增或按 id 覆盖。
  - `connection-remove {connectionId}`：删除；不改实例。
  - `list-models {connectionId, apiKeys?}` → `{ models: string[] }`
  - `test-model {connectionId, model, apiKeys?}` → `{ message }`（沿用现有测试逻辑，改为从连接取协议/地址）
  - `configure {instanceId, models}`：校验后保存，同时写 `lastModels`。
  - `settings {largeText}`：只剩字体。
  - `start {instanceId, apiKeys?}`：`apiKeys: Record<connectionId,string>`。
- 快照新增：`connections: ModelConnection[]`；实例字段 `models: InstanceModels` 与 `brokenConnection: boolean`；`lastModels?`。删除快照里的 `defaults` 和实例 `model`。

- [ ] **Step 1: 写失败测试**（`model-connections.test.ts`）：
  - `instanceModels` 拒绝：未知 `connectionId`、空模型名、`characters` 里不在 `characterIds` 中的角色（`toThrow('此包之外')`）、多余字段。接受只有 `decision` 的最小形态。
  - `resolveRoleModels`：无覆盖时角色不出现在 `characters`；`default.memory` 缺省等于 `default.decision` 去掉 `thinkingLevel`；角色只覆盖 `decision` 时，其 `memory` 跟随该角色 `decision`；角色同时覆盖二者时各用各的。
  - `migrateModels`：`defaults` 与两个实例（其中一个同地址同协议、一个不同地址）→ 产生 2 条连接，名字为 `host:port`，实例 `models.decision` 指向对应连接并保留原 `model` / `thinkingLevel`；`lastModels` 来自旧 `defaults`。
- [ ] **Step 2: 写失败测试**（`launcher-core.test.ts`，替换现有 `configure`/`settings`/`test-model` 用例）：
  - `create {packageId, name, models?}`：有 `lastModels` 时实例取 `lastModels`；否则取请求里的 `models`（由前端用第一条连接的第一个模型填，见 Task 4）；都没有时仍创建（载入包会自动建实例），实例 `models` 为空、快照 `needsModel: true`，`start` 拒绝并提示“请先在模型配置中选择模型”。`create` 本身不发网络请求。
  - 迁移：写入旧格式 `launcher.json`（含 `defaults` 与实例 `model`），`initialize()` 后快照有 `connections`，实例有 `models`，数据目录出现 `launcher.backup-*.json` 且内容与旧文件一致；新 `launcher.json` 不含 `defaults`。
  - `connection-remove` 后引用它的实例 `brokenConnection === true`；`start` 拒绝并含“连接已删除”。
  - `list-models` 用 `vi.stubGlobal('fetch')`：返回列表；`apiKeys:{[id]:'PRIVATE_KEY'}` 时请求头带 Key；之后 `launcher.json` 与 `snapshot()` 序列化结果都不含 `PRIVATE_KEY`。
  - `start` 时（沿用现有测试里桩 `HCW_HINDSIGHT_PYTHON` 的方式，或 mock `spawn`）子进程环境 `HCW_LOCAL_MODEL/ENDPOINT/MODEL_PROTOCOL/THINKING_LEVEL` 来自默认决策，`HCW_LOCAL_API_KEY` 来自 `apiKeys[默认连接]`。
- [ ] **Step 3: 运行确认失败**（两个测试文件）。
- [ ] **Step 4: 实现。** `Index` 改为 `{ packs; instances; connections: ModelConnection[]; lastModels?: InstanceModels; preferences; playSettings? }`；`Instance.model` 改为 `models?: InstanceModels`。`initialize` 在 `parsed.connections === undefined && parsed.defaults !== undefined` 时调用 `migrateModels`，先把原文件 `copyFile` 为 `launcher.backup-<ISO 时间去冒号>.json` 再 `#save`。实例 `models` 加载时若引用缺失连接，保留原值并在快照算 `brokenConnection`（不抛错，保证删除连接后 Launcher 仍能打开）。删除 `localModel` 与常量 `defaults`；`apiKeys` 校验：对象，值为 ≤8192 字符字符串。
- [ ] **Step 5: 运行确认通过**，再跑 `corepack pnpm@11.7.0 typecheck`（预期 `apps/launcher` 以外无错误；`desktop/main.ts` 若引用 `localModel` 一并改）。
- [ ] **Step 6: 提交** `git commit -m "feat(launcher): persist model connections and instance model choices"`

### Task 3: Tauri 凭据管理器与 Key 注入

**Files:**
- Modify: `apps/launcher/src-tauri/Cargo.toml`（`keyring = { version = "3", features = ["windows-native"] }`）
- Create: `apps/launcher/src-tauri/src/model_keys.rs`
- Modify: `apps/launcher/src-tauri/src/main.rs`（`launcher_request` 分派）

**Interfaces:**
- Consumes: Task 2 的请求形状（`connectionId`、`apiKeys`）。
- Produces（前端可调用的操作，Rust 自己处理，不转发或转发前后加工）：
  - `connection-key-set {connectionId, apiKey}`：`apiKey` 为空串时删除条目；返回 `{ saved: true }`。不转发。
  - `connection-key-status {connectionIds: string[]}` → `{ stored: string[] }`。不转发。
  - `connection-remove`：先转发，成功后删除该条目（删除失败忽略）。
  - `list-models` / `test-model`：转发前注入 `apiKeys = {connectionId: key}`（有 Key 时）。
  - `start`：转发前先请求 `snapshot`，取 `connections[].id`，注入全部已存 Key。
  - 任何来自前端的 `apiKeys` 字段在注入前先移除。
- `model_keys.rs`：`pub fn inject(request: &mut Value, ids: &[String], lookup: impl Fn(&str) -> Option<String>)`、`pub fn get(id) -> Option<String>`、`pub fn set(id, key) -> Result<(), String>`、`pub fn remove(id)`；`id` 不符合 UUID 形状时 `set` 报“连接标识无效。”。

- [ ] **Step 1: 写失败 Rust 单测**（`model_keys.rs` 内 `#[cfg(test)]`）：`inject` 移除前端传来的 `apiKeys`；`lookup` 返回 `None` 的 id 不出现在注入结果里；全部 `None` 时不写 `apiKeys` 字段。
- [ ] **Step 2: 运行** `cargo test --manifest-path apps/launcher/src-tauri/Cargo.toml model_keys` → FAIL。
- [ ] **Step 3: 实现 `model_keys.rs` 与 `main.rs` 分派**（keyring 读取错误一律视为 `None`；错误消息不含 Key）。
- [ ] **Step 4: 运行** 同一命令 → PASS；再 `cargo build --manifest-path apps/launcher/src-tauri/Cargo.toml` 成功。
- [ ] **Step 5: 提交** `git commit -m "feat(launcher): store model connection keys in Windows Credential Manager"`

### Task 4: 前端 store 与类型

**Files:**
- Modify: `apps/launcher/src/core-types.ts`（`CoreSnapshot`：`connections`、实例 `models`/`brokenConnection`/`needsModel`、`lastModels`；删除 `defaults`、`LocalModel`）
- Modify: `apps/launcher/src/services/desktop.ts`（`testModelConnection(connectionId, model)`、新增 `listConnectionModels(connectionId): Promise<string[]>`、`setConnectionKey(id, key)`、`connectionKeyStatus(ids): Promise<string[]>`）
- Modify: `apps/launcher/src/stores/launcher.ts`
- Modify: `apps/launcher/src/stores/launcher.test.ts`

**Interfaces:**
- Consumes: Task 2 快照与操作、Task 3 Rust 操作。
- Produces（store 导出，替换 `providers`、`defaults`、`currentRealModel`、`saveSettings`、`configureModel`）：
  - `connections: Ref<ModelConnection[]>`、`storedKeys: Ref<Set<string>>`
  - `modelLists: Ref<Record<string, { models: string[]; error?: string; loading: boolean }>>`
  - `saveConnection(connection: ModelConnection, apiKey?: string): Promise<boolean>`（`apiKey === undefined` 表示不改 Key）
  - `removeConnection(id: string): Promise<boolean>`
  - `refreshModels(id: string): Promise<void>`（结果进 `modelLists`，失败写 `error`，不抛）
  - `currentModels: ComputedRef<InstanceModels | undefined>`
  - `configureModels(models: InstanceModels): Promise<boolean>`
  - `saveLargeText(value: boolean): Promise<boolean>`（原 `saveSettings` 的字体用途，若有调用方）
  - `startGame()` 不再传 Key，不再做地址比对。
  - `newInstance(name)`：快照无 `lastModels` 且有连接时，先 `refreshModels(connections[0].id)`，列表非空就把 `{decision:{connectionId, model: 列表第一项}}` 作为 `models` 传给 `create`；没有连接时照常创建并提示“请先在模型设置添加连接”。
- Mock 模式（`!isTauri()`）：Key 存在内存 `Map`，`refreshModels` 返回固定 `['mock-flash','mock-pro']`。

- [ ] **Step 1: 写失败测试**：删除旧的 `providers` 地址比对用例（第 28–32、140–158 行附近）；新增：`refreshModels` 失败时 `modelLists[id].error` 有文案且 `loading` 复位；`startGame` 调用的 `coreRequest('start', …)` 参数不含任何 Key 字段；`saveConnection(conn, 'K')` 先 `connection-save` 再 `setConnectionKey`；无 `lastModels` 时 `newInstance` 发出的 `create` 带 `models.decision.model === <列表第一项>`，无连接时 `create` 不带 `models`。
- [ ] **Step 2: 运行确认失败** `corepack pnpm@11.7.0 --filter @perspectra/launcher test`。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行确认通过**，再 `corepack pnpm@11.7.0 --filter @perspectra/launcher typecheck`（此时对话框组件会报错，Task 5 修；如需让本任务单独通过类型检查，可在本任务里先把两个对话框改到能编译的最小形态）。
- [ ] **Step 5: 提交** `git commit -m "feat(launcher): store wiring for model connections"`

### Task 5: 对话框 UI（Part A 部分）

**Files:**
- Create: `apps/launcher/src/components/ModelPicker.vue`
- Modify: `apps/launcher/src/components/ModelSettingsDialog.vue`（改为连接管理）
- Modify: `apps/launcher/src/components/ModelConfigDialog.vue`（默认选择）
- Modify: `apps/launcher/src/components/GameDetail.vue:146`（模型摘要）

**Interfaces:**
- Consumes: Task 4 store 导出。
- Produces: `ModelPicker` props `{ modelValue: ModelTarget | undefined; label: string }`，emit `update:modelValue`。内部：连接下拉 + 模型输入框（带 `<datalist>` 或过滤列表，按当前连接的 `modelLists` 显示），可自由输入；打开时若该连接未拉过列表则调用 `refreshModels`；显示 `error` 但不阻止输入。

- [ ] **Step 1: `ModelSettingsDialog`**：连接列表（名称、协议、地址、“已保存 Key”标记），每行「编辑」「删除」「获取模型列表」「测试连接」；编辑表单含 Key 输入（留空 = 不修改，提供“清除 Key”）；删除前若有实例引用，列出实例名并要求确认。去掉“新实例默认模型”与思考强度。沿用现有协议说明文案。
- [ ] **Step 2: `ModelConfigDialog`**：去掉协议/地址字段；“所有角色”区块用 `ModelPicker` + 现有思考强度按钮组（Gemini 禁用“关闭”的逻辑保留，按所选模型判断）；“记忆整理”默认折叠显示“跟随决策模型”，可展开选另一个 `ModelPicker`。`brokenConnection` 时顶部提示“连接已删除，请重新选择”。保存调用 `configureModels`。
- [ ] **Step 3: `GameDetail`** 显示 `模型名 · 连接名`（+ 思考强度）；`needsModel` / `brokenConnection` 时显示“尚未设置”/“连接已删除”。
- [ ] **Step 4: 验证**：`corepack pnpm@11.7.0 --filter @perspectra/launcher typecheck` 与 `test` 通过；`corepack pnpm@11.7.0 launcher:dev` 在浏览器 Mock 下截图核对：添加两条连接 → 获取列表 → 实例里从列表选择 → 手打一个不在列表的模型也能保存。
- [ ] **Step 5: 提交** `git commit -m "feat(launcher): connection manager and model picker dialogs"`

### Task 6: Part A 文档与真实验收

**Files:**
- Modify: `docs/current/model-protocols.md`、`docs/current/launcher-v1.md`、`docs/current/launcher-core-integration.md`、`docs/current/guides/player-playtest.md`（凡描述“模型设置填 Key、仅本次会话保留”“实例填接口地址”的段落）
- Modify: `docs/current/architecture/modules.md`（登记 `desktop/model-connections.ts`）

- [ ] **Step 1: 更新上述文档**：先给“添加连接 → 选模型 → 开局”的操作例子，再写 Key 存储位置与“不写入数据目录”；标明角色覆盖尚未接通（Part B）。
- [ ] **Step 2: 运行** `node scripts/docs/check-links.mjs` → 无错误。
- [ ] **Step 3: 真实验收**（`corepack pnpm@11.7.0 launcher:desktop`）：旧数据目录副本（不要用 `D:/worlds`，复制到新目录）启动 → 迁移成功、备份存在 → 补 Key → 重启 Launcher 后 Key 仍在 → 开局一回合角色正常回应。记录结果到交付说明。
- [ ] **Step 4: 提交** `git commit -m "docs: launcher model connections"`

---

## Part B：按角色覆盖

### Task 7: 运行时按角色决策模型

**Files:**
- Modify: `tests/experiments/playtest-frozen-runtime.ts`（options 新增 `roleModels?: RuntimeRoleModels`；`roleProviders` 构建处）
- Modify: `tests/experiments/playtest-web-entry.ts`（读 `PERSPECTRA_ROLE_MODELS` + `PERSPECTRA_MODEL_KEYS`）
- Modify: `desktop/launcher-core.ts` `start`（设置这两个环境变量）
- Test: `tests/prototype/model-presets.test.ts`（仿照 “routes each real Core character call to its selected preset” 新增用例）

**Interfaces:**
- Consumes: Task 2 `RoleModels`、`ResolvedModel`。
- Produces:
  ```ts
  // playtest-frozen-runtime.ts
  export interface RuntimeModel { protocol: ProviderProtocol; endpoint: string; model: string; thinkingLevel?: ThinkingLevel; apiKey?: string }
  export interface RuntimeRoleModels { characters: Record<string, { decision: RuntimeModel; memory: RuntimeModel }> }
  ```
  `PERSPECTRA_ROLE_MODELS` = `JSON.stringify(resolveRoleModels(...))`（不含 Key）；`PERSPECTRA_MODEL_KEYS` = `JSON.stringify(apiKeys 中被引用的连接)`。入口把二者合并成 `RuntimeRoleModels` 传入；默认层仍走现有 `HCW_LOCAL_*`。

- [ ] **Step 1: 写失败测试** `routes each character's decision call to its own model and endpoint`：`roleModels.characters['character:companion'].decision = {protocol:'openai',endpoint:'http://other.test/v1/chat/completions',model:'strong',apiKey:'K2'}`，桩 fetch 记录 `(url, body.model, authorization)`；`submit` 后 companion 的调用 URL/模型/Key 为覆盖值，friend 的为默认值，且 friend 请求头不含 `K2`。再断言 `roleModels.characters` 含包外角色时 `create` `toThrow('此包之外')`。
- [ ] **Step 2: 运行确认失败**（provider 用 `'local'` 以走 openai 协议）。
- [ ] **Step 3: 实现**：构建 `roleProviders` 时 `{...providerOptions, ...override}`（`endpoint` 转 `URL`，`apiKey` 覆盖，`thinkingLevel` 仅在覆盖里有值时覆盖）；角色 ID 校验与预设映射共用同一检查。`launcher-core` `start` 设置两个环境变量。
- [ ] **Step 4: 运行确认通过**，并跑 `tests/prototype/launcher-core.test.ts`。
- [ ] **Step 5: 提交** `git commit -m "feat(runtime): per-character decision models"`

### Task 8: 记忆整理按角色

**Files:**
- Modify: `tests/experiments/playtest-memory-core.ts`（构造参数）
- Modify: `tests/experiments/playtest-frozen-runtime.ts`（`memoryCore` 构建处，约 322–333 行）
- Test: `tests/prototype/playtest-memory-core.test.ts`

**Interfaces:**
- Consumes: Task 7 `RuntimeRoleModels`。
- Produces: `MemoryBuildOptions` 新增 `runFor?: (actor: string) => { recall: CoreRunner; build: CoreRunner }`；`PlaytestMemoryCore` 在 recall 处用 `runFor?.(actor).recall ?? this.run`，build 处用 `runFor?.(job.actor).build ?? this.#buildRun`。运行时按“不同 memory 配置（protocol+endpoint+model+connection Key）”去重，每组一个 `createCoreWorker(env)` + `coreRunner(env)`，`env` 与现有 `coreEnvironment` 同形；关闭运行时时关闭所有 worker。

- [ ] **Step 1: 写失败测试** `uses each character's own memory runner for recall and build`：两个桩 runner A/B 记录调用；`runFor` 把 companion 映射到 A、其他到 B；触发一次 build 与一次 recall 后，A 只收到 companion 的 scope（`characterId === 'character:companion'`），B 从不收到 companion。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现**，`utility-attempts.jsonl` 路径不变；断言（加进 Step 1 测试）：数据目录下所有文件内容不含测试 Key 字符串。
- [ ] **Step 4: 运行确认通过**，并跑 `tests/prototype/cross-scene-core-memory.test.ts`、`tests/prototype/pack-activities.test.ts` 确认无回归。
- [ ] **Step 5: 提交** `git commit -m "feat(runtime): per-character memory consolidation models"`

### Task 9: 实例配置里的角色覆盖 UI、文档与真实验收

**Files:**
- Modify: `apps/launcher/src/components/ModelConfigDialog.vue`
- Modify: `apps/launcher/src/components/GameDetail.vue`
- Modify: Task 6 列出的文档，`docs/current/architecture/runtime.md`

- [ ] **Step 1: UI**：“按角色单独设置”区块，角色来自 `store.presetCharacters`；每个角色一行：“跟随默认”开关；关闭后出现决策 `ModelPicker` + 思考强度，记忆整理默认“跟随该角色决策模型”可展开。`GameDetail` 摘要追加“另有 N 个角色单独配置”。
- [ ] **Step 2: 验证** Launcher `typecheck` + `test`；Mock 下截图核对一个角色覆盖的保存与回显。
- [ ] **Step 3: 文档**：去掉“角色覆盖尚未接通”，补一个“给重要角色换强模型”的例子；`runtime.md` 说明 `PERSPECTRA_ROLE_MODELS` 与 Key 只经环境变量传递。运行 `node scripts/docs/check-links.mjs`。
- [ ] **Step 4: 真实试玩**（spec 第 7 节）：两条不同服务商连接；一个角色覆盖到另一服务商；开局数回合，在请求检查器确认该角色调用的模型/地址为覆盖值、其他角色为默认；触发一次记忆整理，确认 `utility-attempts.jsonl` 中该角色的 `requestedModel` 为其记忆模型，且全目录搜索不到任何 Key。
- [ ] **Step 5: 提交** `git commit -m "feat(launcher): per-character model overrides"`，最后跑 `corepack pnpm@11.7.0 check` 并在交付说明里如实写出运行与未运行的测试。
