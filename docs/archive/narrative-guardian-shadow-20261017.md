# Narrative Guardian 影子实验归档

2026-10-17 按用户要求归档。该实验曾在提交后独立审查自由叙事与保管、位置等已提交事实的冲突，只记录诊断，不改文本或反馈角色。影子模式保留原叙事，因此没有解决违规叙事进入观察和记忆的问题；不把它作为现行一致性保证。

当前网页入口和试玩宿主均不再保留 Guardian 接入、环境变量开关或日志写入。已保留的[物品 Context 边界提示](../current/architecture/interaction.md#物品-context-边界提示)独立于该实验；通用叙事边界预设未纳入此次交付。

## 本地恢复资料

- 归档标签：`codex/archive-narrative-guardian-shadow-20261017`，指向原有 stash 快照 `36c23bf6b540e945a83c83ae0d6b348e5d9800d7`。标签保留原始快照，未删除现有 stash；它是本地恢复资料，不代表远端已保存。
- 压缩备份：仓库内 `.tmp/narrative-guardian-archive-20261017/narrative-guardian-shadow.zip`，包含 31 个实验源码、测试、预设、研究与结果文件，以及清理前完整的已跟踪差异。备份仅保存在本地，未作为发行内容提交。
- 原实验基线：`19f72de`；定向发言送达修复已单独进入 `main` 的 `25b3c01`，不属于本次归档撤回范围。

例如可用下列只读命令取回原实现或研究记录；原文件描述的是实验当时的行为，不是当前运行时：

```powershell
git show 'codex/archive-narrative-guardian-shadow-20261017^3:packages/application/src/narrative-guardian.ts'
git show 'codex/archive-narrative-guardian-shadow-20261017^3:docs/current/studies/narrative-guardian-20261015.md'
```

本次只验证归档完整性与现行物品提示的相关自动回归；未重新评估审查模型的检出率、误报率或长期角色体验。
