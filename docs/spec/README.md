# 冻结规格来源

`implementation-v0.2.md` 是父目录 `2026-08-21_实施规格-Harness-Cordis-World-V0.2-report.md` 的逐字节副本。

| 属性 | 值 |
|---|---|
| 冻结日期 | 2026-08-22 |
| SHA-256 | `8e0c8fa13e6279e266ab18010ef50976d6277839c67ee57fd7682bd787afe4eb` |
| 用途 | Phase 0 实现和 ADR 的上位契约 |

验证命令：

```powershell
Get-FileHash -Algorithm SHA256 docs/spec/implementation-v0.2.md
```

## 通用内容路线

[通用内容与真实运行架构总纲](general-content-architecture-v0.1.md)冻结 Phase 7～11 的长期方向；[Phase 7 实施规格：最小通用内容闭环](phase-7-implementation-v0.2.md)只交付最小 Pack、酒馆社交、通用交互和角色 Memory 隔离，目标候选版本为 `0.2.0`。

两份文档均扩展但不改写上述 V0.2 冻结规格；冲突由 ADR-0054～0059 的 supersedes/extends 关系处理。Phase 7 已形成 `0.2.0` 本地候选，但 GitHub 四格 CI 与 Tag 尚未完成，因此不能宣称 `0.2.0` 已发布。
