# Phase 7 创作者运行手册

本手册面向只编辑内容文件、不修改 Kernel 的本机创作者。Phase 7 能制作开放式社交或简单探索世界；悬疑调查规则不是必需组件。

## 1. 准备环境

需要 Node 22.19.x 或 24+、Corepack，以及本仓库源码。先在仓库根目录安装并验证：

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check
```

所有入口只使用本机文件和 stdio，不开启网络监听。Harness、TencentDB 和真实模型默认禁用。

## 2. 创建来源目录

最小模板只有一个玩家角色；社交模板包含玩家、Alice、Bob、秘密、错误认知、传闻、物品和 Scene 离场验收：

```powershell
corepack pnpm@11.7.0 worldpack init --profile minimal D:\worlds\my-world
corepack pnpm@11.7.0 worldpack init --profile social D:\worlds\my-tavern
```

目标目录必须不存在，命令不会覆盖已有内容。来源根清单 `worldpack.source.json` 显式列出全部 JSON、Markdown 和素材文件；没有 glob 或隐式目录扫描。

Phase 7 可编辑内容包括：

- 世界标题和描述；
- 角色名称、初始位置、生命周期、公开刻画文本；
- 每个角色独立的初始 Observation、Claim 和 Goal；
- 带 `initialAudience` 的秘密；
- 地点、通用物品、单一 active Scene 和玩家绑定；
- 纯文本 Presentation 与 Testkit acceptance assertions。

Phase 7 不接受动态 Affect/InnerTension、Scene v2、任意规则脚本、自定义 Event、网络端点、API key 或系统提示。需要新硬语义时应等待受信任插件阶段，不能把自由文本当作权限或规则。

## 3. 校验、测试和编译

```powershell
corepack pnpm@11.7.0 worldpack validate D:\worlds\my-tavern
corepack pnpm@11.7.0 worldpack test D:\worlds\my-tavern
corepack pnpm@11.7.0 worldpack compile D:\worlds\my-tavern --out D:\worlds\my-tavern.worldpack.json
corepack pnpm@11.7.0 worldpack inspect D:\worlds\my-tavern.worldpack.json
```

`validate` 检查严格 JSON、Unicode、路径、大小限制、重复 ID、引用和 allowlist。`test` 执行确定性编译/WorldSpec 适配，并固定 acceptance plan 的 ID 与 Hash；仓库参考酒馆的多轮运行断言由 `pnpm check` 中的正式 Testkit E2E 执行。`compile` 生成 Canonical、内容寻址的不可变 `worldpack/v1` 制品；`inspect` 只读取制品，不回看来源目录。

同一个 `packId + packVersion` 修改内容后会得到不同 `packHash`。创作者应同时提升自己的 `packVersion`，不要覆盖已经用于激活世界的制品。

## 4. 激活并连续交互

```powershell
corepack pnpm@11.7.0 worldpack activate D:\worlds\my-tavern.worldpack.json --data-dir D:\worlds\my-tavern-data
corepack pnpm@11.7.0 worldappctl chat --data-dir D:\worlds\my-tavern-data
```

激活会在 `<data-dir>\data` 创建 World、Session 和 Memory 三个 SQLite 数据库。再次用相同制品和目录激活返回 `already_active`，不会重建 Genesis。

持续交互中：

- 普通非空文本是玩家公开 `speak`；
- `/move <locationId>` 移动；
- `/take <entityId>` 拿取通用物品；
- `.view` 查看绑定玩家角色视图；
- `.health` 查看健康状态；
- `.pause`、`.resume`、`.exit` 控制本机 shell。

未知命令、缺参或歧义返回 clarification，不建立 Round、不推进 Tick。玩家输入、NPC 提案、规则裁定、Event、Session 投递和 Memory 都走正式 Application 路径。

## 5. 认知与隐私规则

- 秘密只展开给 `initialAudience` 中的角色；没有 Claim 表示不知道。
- 错误认知仍是角色自己的 Claim，不会变成作者真相。
- “Bob 说过 P”形成带来源的 Observation/Memory，不自动证明 P 为真。
- 每个角色的 CharacterView 和 Memory namespace 独立；跨角色、跨 Branch、未来 as-of 来源 fail-closed。
- Pack 中的 `acceptanceAssertions` 只供 Testkit 使用，不进入世界、Context 或角色视图。

如要检查隐私，请以玩家 `.view` 或正式测试断言为准，不要直接读取 SQLite 或用作者全知快照代替玩家视角。

## 6. 诊断与恢复

来源错误会返回 `PACK_SOURCE_INVALID`、`PACK_REFERENCE_INVALID`、`PACK_DUPLICATE_ID`、`PACK_LIMIT_EXCEEDED` 等确定性诊断。不要通过删除 Hash、放宽 Schema 或手改数据库绕过错误。

运行时若出现 `BUNDLE_HASH_MISMATCH`、`SESSION_DELIVERY_DIVERGED` 或 quarantine，应停止写入并按[V0 本机运行与恢复手册](V0-LOCAL-RUNBOOK.md)处理。编辑来源后应编译新制品并激活到新的数据目录；Phase 7 不支持运行中替换 Pack。

## 7. 当前边界

`0.2.0` 仍是私有源码本地候选，不是 npm 包或远程服务。当前创作者入口不提供 GUI、World Pack 继承、热更新、第三方脚本、多个 active Scene、Agent 接管玩家或真实模型。它只证明一件事：不修改 Kernel，也能创建一个可连续运行且角色认知互相隔离的非悬疑世界。
