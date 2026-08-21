# Harness / Cordis World 工程规则

默认使用中文沟通。修改代码前先读 `docs/spec/implementation-v0.2.md` 和相关 ADR；Accepted ADR 不原地改向，方向变化必须新增 superseding ADR。

## 权威边界

- `../deepseek-harness-dsh-v0.1.1-rc.1` 是只读调研源码，不得从本仓库修改、复制内部实现或依赖其未发布路径。
- Phase 0 只允许 `@deepseek-ai/cordis@4.0.1` 作为上游运行时依赖；Harness 接入必须通过后续 Bridge 包。
- World Event Log 是世界事实权威；Session、Projection、Memory 和 Telemetry 都不能反写或替代世界事实。

## 实现约束

- ESM、TypeScript strict、显式 `.ts` 本地导入、品牌 ID 和完整 `WorldAddress`。
- Cordis 注册必须由所属 Fiber 的 effect/listener 生命周期清理；Branch Service isolate 之外还要保留显式事件过滤。
- SQLite 使用 `node:sqlite`、WAL、`synchronous=FULL`、短 `BEGIN IMMEDIATE` 事务；不得用内存去重替代耐久幂等。
- 模型输出只能成为提案；任何模型可见输入必须能由耐久记录重建。
- Canonical JSON、Hash、as-of、事务原子性和 fail-closed 完整性规则不得为了测试或演示放宽。

## 验证

修改生产代码必须同时更新测试。交付前运行：

```powershell
corepack pnpm@11.7.0 check
```

生产包 `src` 保持逐文件 100% statements、branches、functions 和 lines 覆盖率。高风险提交窗口必须保留子进程硬终止测试，普通异常测试不能替代。
