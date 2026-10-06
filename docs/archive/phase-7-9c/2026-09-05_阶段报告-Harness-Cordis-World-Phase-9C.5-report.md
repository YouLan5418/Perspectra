# Phase 9C.5 阶段报告：五库备份与真实迁移

> **结论：** P9C.5 已建立离线五库部署备份、校验和恢复闭环，并用 `c2b3141` 旧二进制真实生成的部署证明 World v15→v16、Context v4→v5 不改写既有事实。完整 `pnpm check` 已通过，可以进入 P9C.6。

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-09-05 |
| 实施分支 | `qwen` |
| 决策依据 | [ADR-0081](../../adr/ADR-0081-deployment-backup-restore-set.md) |
| 旧部署来源 | `c2b314188d391e676497c58a25db3fc824568702` |
| 制品格式 | `world-deployment-backup/v1` |
| 数据库 | World、Operational Audit、Session、Memory、Context |

## 1. 操作者如何使用

`worlddeploy` 是离线维护命令。创建备份前必须停止 `worldhost`；它会取得同一 `instance.lock`，并拒绝有效 Writer Lease、未完成 Round/Cycle/Job、关键未投递 Outbox 或 quarantined Branch。

```powershell
corepack pnpm@11.7.0 worlddeploy create D:\Backups\world-2026-09-05 --data-dir D:\WorldHost
corepack pnpm@11.7.0 worlddeploy validate D:\Backups\world-2026-09-05 --data-dir D:\WorldHost
corepack pnpm@11.7.0 worlddeploy restore D:\Backups\world-2026-09-05 D:\Restored\world-2026-09-05 --data-dir D:\WorldHost
```

恢复只写入全新目录，不覆盖现用部署，也不自动切换 Host 配置。操作者必须先验证恢复目录，再显式改配置。备份包含角色记忆、上下文和会话记录，应按敏感数据保存。

一个 ready 制品包含：

| 文件 | 含义 |
| --- | --- |
| `world.sqlite` | World 权威事件、Round、Outbox、Reaction Cycle |
| `world.sqlite.audit.sqlite` | 操作审计 Hash 链 |
| `session.sqlite` | Session 投递 Inbox、Cursor 与可见事件 |
| `memory.sqlite` | 角色隔离的认知记忆与水位 |
| `context.sqlite` | Context Receipt、ProviderCall 与 Checkpoint |
| `manifest.json` | 文件 Hash、SQLite 身份、Schema 与跨库水位 |
| `ready` | 最后写入的完整制品标记 |

进程若在最终发布前被强杀，只会留下没有 `ready` 的半成品。它不能通过 `validate`，也不会被当成可恢复备份；操作者可删除该目录后重试。

## 2. 已实现的正确性边界

- 五个 SQLite 文件按 World → Audit → Session → Memory → Context 固定顺序，通过 SQLite Backup API 或排他复制写入新目录。
- 深层验证在临时副本上进行，避免验证器打开 SQLite 时改变待签名文件的物理字节。
- `manifest.json` 保存每个文件的 byte length、SHA-256、`application_id`、`user_version`、`quick_check`，`ready` 保存 Manifest Hash。
- World Event/Head/Round/Reaction、Session、ProviderCall、Context Receipt 与 Audit Hash 链全部 fail-closed 校验。
- World delivered Outbox 与 Session Inbox 做双向逐条对账；Memory/Context 水位不得超过对应 Branch Head；已完成 Cognitive Job 必须有足够的 Memory capture 水位。
- 恢复不重编号 Session delivery，不重置 receipt/counter，也不改写 Memory、Context 或 Outbox 状态。
- `restore-provenance.json` 记录来源 Manifest Hash、恢复时间、文件 Hash 和已执行检查，其自身也有确定性 Hash。

## 3. 真实旧部署演练

复现命令：

```powershell
node --import tsx tools/verify-v15-deployment-migration.ts `
  .tmp/v15-baseline/fixture-data `
  .tmp/p9c5-v15-migration-20260905-0632
```

脚本只复制旧制品到新演练目录，绝不原地改写 `.tmp/v15-baseline/fixture-data`。随后依次执行当前迁移、Branch integrity、Projection rebuild、Logical v6 导出/导入、五库备份、恢复和再校验。

| 断言 | 实测结果 |
| --- | --- |
| World Schema | v15 → v16 |
| Context Schema | v4 / application_id 0 → v5 / 当前归属标识 |
| 既有 World 表快照 Hash | 迁移前后均为 `sha256:78115d82df438ba82d71629a02b69187974c44dd25c1b074d4812c1a30447d53` |
| 既有 Context 行快照 Hash | 迁移前后均为 `sha256:3bb33e1e9ee63c0fa654866fafe8b0eedc25ddc51a7a5ec994a83e9d181f64cc` |
| 旧世界 Reaction 策略 | 两个 Branch 均为 `disabled`，Reaction 表为空 |
| Logical v6 authority Hash | `sha256:a01c3c006a1587e0ced913ca5f500d3766a68c2fde9d393e55c49f77dddd44cd` |
| 五库 Manifest Hash | `sha256:b5159b4bd3a4ce3b94bb247c59d187a27c8b81ddc543323cd91b950fb7dc7c6e` |
| Restore provenance Hash | `sha256:c3aab6c74c93d3138a0933d883071e6467190f8df77db8a718413b7d0317eac9` |
| 恢复目录 | `ready=true`，再次完整校验通过 |

Branch 级结果：

| Branch | Head / Tick | Event Hash | Projection Hash |
| --- | --- | --- | --- |
| `branch:main` | 28 / 2 | `sha256:038d5039535ad6b18884f76aed582875910eb93c47e77c893682e82a6d698f13` | `sha256:8dc43abc51b4d84260ac43ebcd03f99fb2ccd5bca4e2395bc1dc39c11cd20dd0` |
| `branch:child` | 38 / 3 | `sha256:bbacd59d2994b391216630156ecb734aaa75d94e29db3eef253c09c2b7b588f9` | `sha256:9b197acbc0c91ca3678a0a99c90f483d564966c17ff29d3243585a2ff9130cb9` |

## 4. 自动化与崩溃证据

| 证据 | 覆盖内容 | 结果 |
| --- | --- | --- |
| `packages/operations/src/deployment-backup.test.ts` | 五库 happy path、错误目录、身份/Hash/水位分歧、Context Receipt、完整等价 v15 迁移 | 18 项通过；生产文件四项覆盖率 100% |
| `tests/process-entry.test.ts` | `worlddeploy create/validate/restore` 真实子进程入口 | 4 项通过 |
| `tests/crash.test.ts` | backup/restore 在 `before-ready` 处 IPC 定点后由父进程 `SIGKILL` | 半成品无 `ready`、源制品仍有效、陈旧锁可恢复 |
| `tools/verify-v15-deployment-migration.ts` | 真实旧二进制制品迁移与完整恢复 | 通过 |

完整门槛结果：78 个 coverage 测试文件、853 项测试通过，statements 9506/9506、branches 6171/6171、functions 1884/1884、lines 8172/8172；P0～P6、P8 性能测试和 33 项硬崩溃测试全部通过。

CI 等价门槛不是只造三张简化表：测试先建立含事件、Round、Outbox 与 Session Receipt 的完整部署，移除 v16 Reaction 结构并固定 `user_version=15`，再由正式打开路径迁移；随后逐值比较既有权威行并执行备份/恢复。

## 5. Evidence → Finding → Path

### Evidence

- **E-001**：`c2b3141` 旧代码生成的原始 World 为 v15、Context 为 v4，两个 Branch 共 38 个 Event；来源与文件 SHA-256 见[旧库基线](2026-09-02_Phase-9C-v15旧库与Golden基线.md)。
- **E-002**：本报告第 3 节命令返回退出码 0，World/Context 迁移前后既有行快照 Hash 分别全等。
- **E-003**：同次演练的 Branch Event/Projection Hash 在迁移、Logical import 和五库 restore 后保持一致。
- **E-004**：真实子进程在 backup/restore 的发布窗口被强杀，目标目录均缺少 `ready`，校验器拒绝使用。
- **E-005**：`deployment-backup.ts` 的定向 V8 coverage 为 statements 239/239、branches 60/60、functions 37/37、lines 227/227。

### Finding

- **F-001（validated/high）**：v15→v16 与 Context v4→v5 是只增结构/归属的前向迁移，未改写旧世界事实和旧 Context 行（E-001、E-002）。
- **F-002（validated/high）**：五个数据库的恢复一致性可以被机械验证，恢复后不需要清空 Session/Memory 来“制造一致”（E-003）。
- **F-003（validated/high）**：`ready` 最后写入能把强崩溃半成品与可用制品可靠区分，且不会伤害源备份（E-004）。
- **F-004（validated/medium）**：原基线文档把当前 Context v5 误写成旧制品状态；真盘演练发现并修正文档，而不是放宽校验器接受未知状态（E-001、E-002）。

### Path

1. 停止 Host 并取得部署锁 → 检查 quiet barrier（E-005）。
2. 固定顺序复制五库 → 在临时副本执行深层验证 → 对原文件生成 SHA-256 和跨库水位（E-003）。
3. 写 canonical Manifest → 最后写 `ready`；若进程中止则制品不可用（E-004、F-003）。
4. 恢复到新目录 → 重新验证全部文件和水位 → 写 provenance → 最后写恢复目录 `ready`（E-003）。
5. 操作者显式切换配置；旧目录保留作为回退点，不做原地覆盖。

## 6. 下一步

P9C.6 进入长历史、并发与故障矩阵：10,000 Event / 32 Branch / 256 pending Job 的 CI 档，以及跨 Branch 公平性、背压、混合 Root/Reaction 负载和新增恢复窗口。P9C.7 才处理 0.4.0 候选、四格 CI 与 Release Closure。
