# 插件优先运行时阶段 5：世界包依赖与 Launcher 选配 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让玩家在 Launcher 里看得到、选得了各个模块，世界包缺插件时开局前一次列全问题，存档换了模块时有提示。

**Architecture:** 清单增加稳定的 `id`，世界包增加 `requiresPlugins`。同一个检查函数在 Launcher 启动前和游戏进程启动时各跑一次，都不执行插件代码。设置页新增“模块”一块，只依据清单显示和选择。实例目录写 `plugin-set.json`，打开时比较，不同就提示，不阻止。

**Tech Stack:** TypeScript strict、ESM、Vue（Launcher）、vitest。

**Spec:** [插件优先运行时](../specs/2026-11-02-plugin-first-runtime-design.md) 第 6.6、6.7 节。

## 这一阶段能得到什么

例如玩家下载了一个声明“需要上锁的房间 0.1 以上”的世界包，自己没装。点开始时 Launcher 直接列出“缺少插件 locked-room（需要 ^0.1.0）”，一次列全，不会打开到一半才报错。

又如玩家同时启用了两个记忆插件。现在第二个会悄悄被跳过；以后设置页的“模块”一块会显示“记忆：选一个”，让玩家自己定。

## 设计里的三项，我建议这一阶段不做（请确认）

| 项目 | 设计 | 建议 | 理由 |
| --- | --- | --- | --- |
| 插件路由 `/plugins/<插件 ID>/` | 6.6 节 | 不做 | 没有实际插件要用。开放 HTTP 路由还要和宿主令牌、前端沙箱的授权一起设计，不算小事 |
| 插件私有事件 `plugin:<ID>/<名>` | 6.7 节 | 不做 | 设计本身写了“没有实际插件需要就推迟”。现在没有，插件用 `world.dataDirectory` 就够 |
| 节点带上 `plugins/` 目录 | 6.7 节 | 不做 | 重新生成已经带上了。节点靠 `snapshotArchives` 保存，分享文件的范围也不扩大。没有实际问题 |

等真有人需要时再加，这些都不影响现有接口。

## Global Constraints

- Launcher 读取清单和世界包声明时不执行插件代码。
- 缺必需插件时不启动；可选依赖缺失只提示。版本不符算缺失。
- 没有清单或清单没有 `id` 的插件照常加载，但不能满足依赖。
- 模块更换时允许打开存档并提示，不阻止。世界事实不受影响。
- 官方组合下模型请求与基线逐字一致。`requiresPlugins` 不存在时世界包哈希不变。
- 宿主 API 不变（仍是 `1.4`），这一阶段不增加 `ctx` 服务。
- 版本范围只支持 `1.2.3`、`^1.2.3`、`>=1.2.3`，不新增依赖。
- 每个任务都要通过 `corepack pnpm@11.7.0 check` 和 `corepack pnpm@11.7.0 launcher:check`，**都通过后才提交**。
- 改了 Launcher 页面要在浏览器预览里看一遍。
- 新实验使用新数据目录，`D:/worlds` 只读。

## 有意接受的限制

- 这一阶段不发布 `plugin-sdk` 到 npm，也不处理 `RuleContext` 暴露 `kernel` 类型的问题。开源前要单独决定。
- 不做插件市场、下载或自动安装依赖。
- 插件配置变了不算模块更换。
- 不重建便携发行包，只验证打包后的后端能加载外部插件。

## Review Focus

1. 世界包声明的插件存在但被停用、配置无效或 `hostApi` 不兼容：Launcher 或游戏进程都要说清原因，不能打开后才发现规则没生效。（Task 1）
2. 从节点或分享开新故事线时，世界包要求的插件缺失：同样在开局前拒绝，不留下半成品实例。（Task 1）
3. 同一接缝启用了两个插件，玩家没处理就开局：结果和设置页显示的一致，不能悄悄换成另一个。（Task 2）
4. 记忆插件换了又换回：提示准确，`plugin-set.json` 写坏或缺失时不影响打开世界。（Task 3）
5. 候选世界和选中候选后：不重复提示，也不把候选的记录写到主目录。（Task 3）

---

### Task 1: 插件 ID 与世界包依赖

**Files:**
- Create: `desktop/plugin-requirements.ts`、`tests/desktop/plugin-requirements.test.ts`
- Modify: `packages/plugin-sdk/src/index.ts`、`desktop/host-plugin-manifest.ts`、`packages/world-pack/src/compiler.ts`、`desktop/launcher-core.ts`、`desktop/host/web-entry.ts`、`examples/host-plugins/*.plugin.json`、`apps/launcher/src/components/PluginSettingsBlock.vue`、`apps/launcher/src/stores/launcher.ts`

**Interfaces:**
- Produces:

```ts
// plugin-sdk: PluginManifest gains
readonly id?: string  // 与设置里的插件 ID 同样的格式
// desktop/plugin-requirements.ts
export interface PluginRequirement { readonly id: string; readonly version: string; readonly optional?: boolean }
export interface InstalledPlugin { readonly id?: string; readonly version?: string; readonly enabled: boolean }
export interface RequirementProblem {
  readonly id: string
  readonly version: string
  readonly optional: boolean
  readonly kind: 'missing' | 'disabled' | 'version'
  readonly found?: string
}
export function satisfiesVersion(version: string, range: string): boolean
export function checkPluginRequirements(required: readonly PluginRequirement[], installed: readonly InstalledPlugin[]): RequirementProblem[]
export function requirementMessage(problems: readonly RequirementProblem[]): string  // 中文，一次列全
```

- 编译结果和 `CompiledWorldPackV5` 增加可选的 `requiresPlugins`。不存在时不写入，哈希不变。

- [ ] **Step 1: 写失败测试**

```ts
it('accepts exact, caret and at-least ranges', ...)                 // ^0.1.0 接受 0.1.5，不接受 0.2.0；^1.2.0 接受 1.9.0
it('lists every missing, disabled and mismatched plugin at once', ...)
it('does not let a plugin without a manifest id satisfy a requirement', ...)
it('only warns about an optional requirement', ...)
it('rejects a malformed requiresPlugins when compiling', ...)
it('keeps the pack hash when requiresPlugins is absent', ...)       // 对一个示例包比较改动前后的哈希常量
it('refuses to launch and lists every problem', ...)                // launcher-core：不启动进程，错误里有全部项
it('refuses to open a story line from a node when a plugin is missing', ...)
it('refuses in the game process when launched without the launcher', ...) // web-entry 路径
```

Run: `node node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/desktop/plugin-requirements.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 2: 实现**

`launcher-core` 在现有 Python 检查前调用检查，错误信息走现有启动失败提示。选配时按路径读到清单后，用清单 `id` 填默认的插件 ID。给 `examples/host-plugins` 的清单加 `id`。给一个示例世界包（`plugin-capabilities-demo` 不动，新建或选用不影响其他测试的包）加声明验证。

- [ ] **Step 3: 验证并提交**

Run: 相关测试；基线探针；`check`；`launcher:check`。
Expected: 全部通过；请求逐字相同。

```bash
corepack pnpm@11.7.0 check && corepack pnpm@11.7.0 launcher:check && git add -A packages desktop tests examples apps/launcher/src && git commit -m "feat: let world packs declare the plugins they need"
```

### Task 2: Launcher 的“模块”一块

**Files:**
- Create: `apps/launcher/src/components/ModuleSettingsBlock.vue`、`apps/launcher/src/stores/modules.ts`、`apps/launcher/src/stores/modules.test.ts`
- Modify: 设置页组件、`apps/launcher/src/core-types.ts`、`desktop/launcher-core.ts`

**Interfaces:**
- Consumes: 现有 `pluginManifests`、`hostPlugins`。
- Produces:

```ts
export interface ModuleRow {
  readonly seam: 'scheduler' | 'memory' | 'llm' | 'decisions' | 'rules'
  readonly label: string              // 角色调度、长期记忆、模型通道、角色决策、世界规则
  readonly single: boolean            // 前三个只能有一个，后两个可以叠加
  readonly providers: readonly { readonly pluginId: string; readonly name: string; readonly enabled: boolean }[]
  readonly effective: string          // “官方默认”，或生效的插件名
  readonly conflict: boolean          // 只能有一个却启用了多个
}
export function moduleRows(plugins: readonly HostPluginSettings[], manifests: Readonly<Record<string, PluginManifestInfo>>): ModuleRow[]
```

依据清单 `services`。一个接缝启用多个时，宿主实际生效的是列表里第一个（后面的注册会抛错而被跳过），设置页如实显示，并允许玩家选一个，选中后停用其他提供者。

- [ ] **Step 1: 写失败测试**

```ts
it('shows the official default when no plugin provides a seam', ...)
it('shows the first enabled plugin as effective and marks a conflict', ...)   // 和 loadHostPlugins 的实际结果对照
it('stacks decisions and rules without a conflict', ...)
it('disables the other providers when the player picks one', ...)
it('does not check for Python when an enabled plugin provides memory', ...)   // launcher-core
```

Run: `corepack pnpm@11.7.0 launcher:check`
Expected: FAIL，模块不存在。

- [ ] **Step 2: 实现并在浏览器里看**

Launcher 启动前的 Python 检查改成：有已启用插件在清单里提供 `memory` 时跳过。用 `apps/launcher` 的开发页面预览“全局设置 → 插件”，截图确认浅色、深色和窄屏布局。

- [ ] **Step 3: 验证并提交**

```bash
corepack pnpm@11.7.0 check && corepack pnpm@11.7.0 launcher:check && git add -A apps/launcher/src desktop tests && git commit -m "feat: show and choose module implementations in the launcher"
```

### Task 3: 存档记录

**Files:**
- Create: `desktop/host/plugin-set.ts`、`tests/host/plugin-set.test.ts`
- Modify: `desktop/host/world-runtime.ts`

**Interfaces:**
- Produces:

```ts
export interface PluginSetRecord { readonly seams: Readonly<Record<string, readonly { id: string; version: string }[]>> }
export function pluginSetChanges(previous: PluginSetRecord | undefined, current: PluginSetRecord): string[]  // “记忆：Core → my-memory”
```

`plugin-set.json` 写在实例目录（`logicalDirectory ?? dataDirectory`），用临时文件加改名写入。候选世界不读不写。

- [ ] **Step 1: 写失败测试**

```ts
it('records the modules in force when a world opens', ...)
it('tells the player which module changed, and opens the world anyway', ...)   // notice 包含变化，世界事实不变
it('says nothing the first time, or when nothing changed', ...)
it('treats a corrupt record as no record', ...)
it('leaves the record alone for a regeneration candidate', ...)
it('reopens a save after its plugin was removed', ...)                         // 卸载插件后存档可开，这是设计的完成标准
```

Run: `node node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/host/plugin-set.test.ts`
Expected: FAIL。

- [ ] **Step 2: 实现并验证**

Run: 相关测试；基线探针。
Expected: 全部通过；请求逐字相同。

- [ ] **Step 3: 全量检查通过后提交**

```bash
corepack pnpm@11.7.0 check && corepack pnpm@11.7.0 launcher:check && git add -A desktop tests && git commit -m "feat: tell the player when a save's modules changed"
```

### Task 4: 打包验证、SDK 文档与验收

**Files:**
- Create: `docs/current/guides/plugin-seams.md`、`docs/current/studies/2026-11-plugin-first-phase-5.md`
- Modify: `docs/current/host-plugins.md`、`docs/current/guides/host-plugin-authoring.md`、`docs/current/architecture/modules.md`、`docs/current/architecture/creator-runtime.md`、世界包格式说明、设计文档第 6.6、6.7 节

**Interfaces:** 无。

- [ ] **Step 1: 打包后的后端**

`corepack pnpm@11.7.0 desktop:build`，然后用构建产物加载放在仓库外的 `simple-llm` 和 `locked-room`（设计第 8 节要求，阶段 1 之后没再验证）。确认插件和宿主用的是同一份 Cordis，真实模型下短局正常。

- [ ] **Step 2: Launcher 真实流程**

按“添加插件 → 看到清单和模块 → 启动 → 世界包缺插件时被拒 → 补上后进入”走一遍。能在桌面版跑就跑桌面版；只能走开发页面和 `launcher-core` 的话，如实记录。

- [ ] **Step 3: 写文档**

`plugin-seams.md` 是给插件作者的总入口：先给例子，再列五个接缝和其他服务各自的用途、需要的 `hostApi`、官方实现、出错时的结果，以及“哪些不能替换”。

Run: `node scripts/docs/check-links.mjs`
Expected: 断链不超过 102，新增文件无断链。

- [ ] **Step 4: 全量检查通过后提交**

```bash
corepack pnpm@11.7.0 check && corepack pnpm@11.7.0 launcher:check && git add -A docs && git commit -m "docs: record plugin-first phase 5 results"
```

这是设计里的最后一个阶段。完成后请用户决定：合并、发行包重建，以及开源前还要做什么。
