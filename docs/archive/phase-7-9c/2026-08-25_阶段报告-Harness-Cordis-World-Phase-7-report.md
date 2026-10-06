# Harness / Cordis World Phase 7：最小通用内容闭环报告

- 日期：2026-08-25
- 项目候选：`0.2.0`
- Compiler 实现：`0.1.0`
- 源码形态：私有、未发布 npm
- 本机环境：Windows，Node 24.14.1，pnpm 11.7.0
- 协议：stdio only
- 可选集成：Harness/TencentDB 禁用
- 判定：**本地门槛与 GitHub 四格 CI 通过；annotated Tag `v0.2.0` 已创建**

## 结论

Phase 7 回答的问题已经在正式运行路径上得到肯定答案：创作者只修改内容目录，不改 Kernel、Store 或 Application，就能制作一个可持续对话、可移动和拿取物品、且不同角色拥有独立认知与 Memory 的非悬疑世界。

酒馆社交 Pack 没有注册 `inspect/ask/present/accuse`，只使用 Core `speak/move/take`、现有 Scene 决断、Local Memory 和通用文本入口。悬疑仍作为旧 Golden 回归试金石，不再决定新内容产品方向。

## 已交付

1. `worldpack-source/v1` 严格来源目录：显式文件清单、安全相对路径、严格 World JSON、UTF-8、大小限制、唯一 ID、引用图和插件 allowlist。
2. 确定性 `worldpack/v1` envelope：默认值物化、稳定排序、独立 Compiler 版本、Canonical bytes 和内容身份 `packHash`。
3. 正式 Genesis 接入：角色初始 Observation/Claim/Goal、秘密受众、通用实体、Pack provenance 和 Memory cognitive job 均由既有 WorldSpec/Authority 路径产生。
4. NPC 可调度性：Pack 配置的 NPC 初始 Runtime Availability 为 `ready`，但仍只调度 Scene/参与策略明确选中的角色。
5. 通用持续交互：`worldappctl chat --data-dir` 在同一持久 World 上接受普通对白、`move/take` 和查询控制命令。
6. 酒馆社交参考 Pack：Bob 的秘密不泄漏给 Alice/玩家，Alice 的错误 Claim 不成为真相，公开传闻只形成来源化记忆；离场角色停止调度。
7. 创作者工作流：`worldpack init/validate/compile/inspect/test/activate` 可从空目录走到幂等激活。

## Requirement → Test evidence

| Phase 7 要求 | 主要证据 |
|---|---|
| 来源不可信、严格校验、无目录逃逸 | `packages/world-pack/src/schema.test.ts`、`compiler.test.ts` |
| 稳定排序、CRLF/LF 与内容 Hash | `packages/world-pack/src/compiler.test.ts` 的 canonical bytes/packHash Golden |
| Pack 来源绑定 Manifest/Genesis | `compiler.test.ts` 的 Manifest、Genesis、重启和 fork 测试 |
| 通用实体进入 Core take | `compiler.test.ts` 与 `packages/simulation/src/tavern-social-pack.test.ts` |
| 角色初始认知进入 View/Memory | `compiler.test.ts` 的 Pack cognition、restart、fork future canary |
| NPC 不是全员调用且已配置者可参与 | `compiler.test.ts` 的 explicit participant 测试与酒馆 providerCalls 断言 |
| 非悬疑多轮社交与认知隔离 | `packages/simulation/src/tavern-social-pack.test.ts` 的十轮 E2E |
| 公开对白不自动成为真值 Claim | 酒馆 E2E 的 Alice/Bob View、Memory 与 Claim 分离断言 |
| 连续持久交互与玩家权限 | `packages/operations/src/chat.test.ts` |
| 六条创作者命令和真实进程入口 | `packages/world-pack/src/creator-cli.test.ts`、`tests/process-entry.test.ts` |
| V0/悬疑/崩溃行为不回归 | 统一 `pnpm check` 的 P0～P6、v3/v4 Golden 与 hard-crash matrix |

## 本机验收证据

最终命令：

```powershell
corepack pnpm@11.7.0 check
```

结果：

| 门槛 | 结果 |
|---|---|
| TypeScript strict typecheck | 通过 |
| Oxlint | 通过 |
| 覆盖测试 | 50 files，430 tests 通过 |
| statements / branches / functions / lines | 100% / 100% / 100% / 100% |
| P0～P6 integration | 全部通过 |
| hard crash matrix | 18 tests 通过 |
| World Pack creator/process smoke | 通过 |

## 兼容表

| 版本轴 | Phase 7 值 | 兼容策略 |
|---|---|---|
| 项目源码 | `0.2.0` candidate | `v0.1.0` Tag 不移动；远端候选尚未 Tag |
| Pack source | `worldpack-source/v1` | 严格数据目录，不接受脚本或未知字段 |
| compiled envelope | `worldpack/v1` | 激活后只读制品，不回读 source |
| Compiler 实现 | `0.1.0` | 与项目、Pack 作者版本独立 |
| Pack 作者版本 | 自行维护 SemVer | 同 id/version 异 hash fail-closed |
| Pack Manifest | schema v3 + content provenance | 旧 Manifest 原字节/Hash 不变 |
| Core Rulebook | `builtin:speak-move@2` | 悬疑 v3/v4 仍只由 Demo 显式注册 |
| World JSON | `world-json/v1` | Canonical bytes/hash Golden 不变 |
| World SQLite | schema v14 | 不因 Pack 功能重写历史 Event |

## 关键提交

| 提交 | 内容 |
|---|---|
| `a2c83bc` | 最小 World Pack 来源与 compiled contracts |
| `ac05128` | 确定性 Pack 编译与 immutable envelope |
| `4fa4ce9` | Pack 初始认知通过 Genesis/Memory 激活 |
| `6c53a3e` | 通用持久连续交互 shell |
| `001d163` | Pack NPC 正确进入可调度状态 |
| `ffa41ab` | 通用实体来源进入编译与 Core 行为 |
| `d66e057` | 无调查依赖的酒馆社交参考 Pack |
| `7d760a5` | 本机创作者 CLI、Inspector 与 Test Runner |
| `9ea52a0` | 全部私有 workspace 统一为 `0.2.0` 候选 |

独立审查后的契约收口、能力解耦和诊断加固见 [Phase 7 独立审查修复报告](2026-08-25_Phase-7独立审查修复报告.md) 与 [ADR-0063](../../adr/ADR-0063-pack-runtime-capability-and-v1-closure.md)。

## CI 证据与发布边界

提交 `8bcc6c1` 已推送至 `main`。GitHub Actions `V0 gates` Run `#6` 于 2026-08-25 通过，总耗时 3 分 55 秒，四组 clean-install + `pnpm check` 均成功：

- Windows latest × Node 22.19.0；
- Windows latest × Node 24.x；
- Ubuntu latest × Node 22.19.0；
- Ubuntu latest × Node 24.x。

证据由仓库 Actions 页面和用户提供的成功截图确认。用户授权后，annotated Tag `v0.2.0` 已于 2026-08-25 创建并指向提交 `08c9a5f`；该 Tag 不再移动。

Phase 7 没有实现 Scene v2、动态 Affect/InnerTension、创作者插件、Runtime Author、Agent 接管玩家、Observer 或真实 Harness Provider。这些继续按总纲进入 Phase 8～11，不能用空接口提前声称完成。
