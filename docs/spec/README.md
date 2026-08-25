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

## Phase 7 规格

[Phase 7 实施规格：通用内容与真实运行验证](phase-7-implementation-v0.1.md)是 `v0.1.0` 之后的 Accepted design target，目标候选版本为 `0.2.0`。它扩展但不改写上述 V0.2 冻结规格；冲突由 ADR-0054～0059 的 supersedes/extends 关系处理。

Phase 7 尚未完成，不能因规格已冻结而宣称 `0.2.0` 已发布。
